param([Parameter(Mandatory=$true)][string]$FixtureRoot,[Parameter(Mandatory=$true)][string]$Case)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
. (Join-Path $repo 'tools/windows-acl-executor-lab.ps1')
function Check($condition,[string]$message){if(-not $condition){throw $message}}
$session=New-SakieAclSyntheticSession $FixtureRoot
$assets=Join-Path $session.FixtureRoot 'assets'
$data=New-SakieAclSyntheticAsset $session 'data' -Directory
$auth=New-SakieAclSyntheticAsset $session 'data\auth' -Directory
$envFile=New-SakieAclSyntheticAsset $session '.env'
$owner=New-SakieAclSyntheticAsset $session 'data\auth\owner.json'
$db=New-SakieAclSyntheticAsset $session 'data\sakie.db'
$wal=New-SakieAclSyntheticAsset $session 'data\sakie.db-wal'
$keep=New-SakieAclSyntheticAsset $session 'data\preserved' -Directory
$denied=New-SakieAclSyntheticAsset $session 'data\preserved\z-denied.txt'
function Bootstrap([string]$path,[scriptblock]$edit){$acl=Get-Acl -LiteralPath $path;& $edit $acl;Set-SakieAclSyntheticBootstrap $session $path $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)}
Bootstrap $denied {param($a)$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-4'),'ChangePermissions','Deny'))}
# Actual inherited children force the new deepest-first isolation logic to run.
foreach($p in @($db,$wal)){Bootstrap $p {param($a)$a.SetAccessRuleProtection($false,$true)}}
$assignments=@([pscustomobject]@{Path=$envFile;Profile='FileRead'},[pscustomobject]@{Path=$owner;Profile='FileRead'},[pscustomobject]@{Path=$db;Profile='FileRwd'},[pscustomobject]@{Path=$wal;Profile='FileRwd'},[pscustomobject]@{Path=$data;Profile='DirectoryRwd'})
function Snapshot {Get-SakieAclSnapshot (Get-SakieAclScope -DirectTargets @($assets) -ForbiddenTargets @($keep))}
function ExpectReviewReject([string]$pattern){$before=Snapshot;$blocked=$false;try{New-SakieAclLabReview $session $assignments @($keep)|Out-Null}catch{Check ($_.Exception.Message -match $pattern) ('WRONG_REVIEW_ERROR '+$_.Exception.Message);$blocked=$true};Check $blocked 'REVIEW_NOT_REJECTED';Check ((Snapshot).Hash -ceq $before.Hash) 'REVIEW_CHANGED_ASSETS'}
if($Case -eq 'existing-session-root'){
 $before=Snapshot;$blocked=$false;try{New-SakieAclSyntheticSession $FixtureRoot|Out-Null}catch{$blocked=$_.Exception.Message -match 'REQUIRES_NEW_ROOT'};Check $blocked 'EXISTING_ROOT_ACCEPTED';Check ((Snapshot).Hash -ceq $before.Hash) 'EXISTING_ROOT_CHANGED';Write-Output 'EXECUTOR_OK existing-session-root';exit 0
}
if($Case -eq 'outside-path'){
 $blocked=$false;try{New-SakieAclSyntheticAsset $session '..\outside.txt'|Out-Null}catch{$blocked=$_.Exception.Message -match 'RELATIVE_ASSET_REQUIRED'};Check $blocked 'OUTSIDE_PATH_ACCEPTED';Write-Output 'EXECUTOR_OK outside-path';exit 0
}
if($Case -eq 'closed-inheritance'){$assignments=@($assignments|Where-Object Path -ne $wal);ExpectReviewReject 'INHERITED_OBJECT_NOT_CLOSED';Write-Output 'EXECUTOR_OK closed-inheritance';exit 0}
if($Case -eq 'forbidden-conflict'){Bootstrap $keep {param($a)$a.SetAccessRuleProtection($false,$true)};ExpectReviewReject 'FORBIDDEN_IMPACT';Write-Output 'EXECUTOR_OK forbidden-conflict';exit 0}
if($Case -eq 'unregistered-same-count'){
 $seed=New-SakieAclSyntheticAsset $session 'new-synthetic-seed.txt'
 Rename-Item -LiteralPath $seed -NewName 'new-synthetic-unregistered.txt'
 ExpectReviewReject 'UNREGISTERED_OBJECT';Write-Output 'EXECUTOR_OK unregistered-same-count';exit 0
}
if($Case -eq 'duplicate'){$assignments+=@($assignments[0]);ExpectReviewReject 'TARGET_UNKNOWN_OR_DUPLICATE';Write-Output 'EXECUTOR_OK duplicate';exit 0}
if($Case -eq 'profile-type'){$assignments[0].Profile='DirectoryRwd';ExpectReviewReject 'PROFILE_TYPE_MISMATCH';Write-Output 'EXECUTOR_OK profile-type';exit 0}
if($Case -eq 'preflight-denied'){Bootstrap $envFile {param($a)$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-4'),'ChangePermissions','Deny'))}}
$before=Snapshot;$review=New-SakieAclLabReview $session $assignments @($keep)
Check ($review.Targets.Count -eq 5) 'MISSING_PROFILE_PREVIEW'
Check ((Get-FileHash -LiteralPath $review.Path).Hash.ToLowerInvariant() -ceq $review.Hash) 'REVIEW_FILE_HASH_MISMATCH'
$forbiddenBefore=(Get-Acl -LiteralPath $denied).Sddl+'|'+(Get-FileHash -LiteralPath $denied).Hash
if($Case -eq 'review-tampered'){[IO.File]::AppendAllText($review.Path,' ')}
$fault=if($Case -in @('success','review-tampered','preflight-denied','one-shot')){'none'}else{$Case}
$result=Invoke-SakieAclLabExecution -Session $session -ExpectedReviewHash $review.Hash -SyntheticFault $fault
$evidence=Join-Path $FixtureRoot 'evidence'
if($Case -in @('success','one-shot')){
 Check ($result.Status -eq 'completed') ('EXECUTION_FAILED '+$result.Error)
 Check ($result.Preflight.Checked -eq 5 -and $result.Verified.Count -eq 5) 'NOT_ALL_CHECKED_OR_VERIFIED'
 $records=@(Get-Content -LiteralPath $result.Journal|ForEach-Object {($_|ConvertFrom-Json).Payload|ConvertFrom-Json})
 Check (@($records|Where-Object Kind -eq 'write-intent').Count -eq 5) 'MISSING_INTENTS'
 Check (@($records|Where-Object Kind -eq 'write-verified').Count -eq 5) 'MISSING_POSTCHECKS'
 Check ($records[-1].Kind -eq 'completed') 'MISSING_COMPLETE'
 foreach($p in @($envFile,$owner)){
  $opened=$false;try{$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$f.Dispose();$opened=$true}catch{}
  Check (-not $opened) 'READONLY_WRITE_ALLOWED'
 }
 $f=[IO.File]::Open($db,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite);$f.Dispose()
 Check ($forbiddenBefore -ceq ((Get-Acl -LiteralPath $denied).Sddl+'|'+(Get-FileHash -LiteralPath $denied).Hash)) 'FORBIDDEN_CHANGED'
 Check ([IO.File]::ReadAllText($envFile) -like 'SYNTHETIC_ONLY:*') 'CONTENT_REPLACED'
 if($Case -eq 'success'){
  $future=Join-Path $data 'future.db-shm';[IO.File]::WriteAllText($future,'SYNTHETIC_FUTURE')
  $rules=@((Get-Acl -LiteralPath $future).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  Check (@($rules|Where-Object {$_.IdentityReference.Value -in @('S-1-5-32-545','S-1-5-11')}).Count -eq 0) 'FUTURE_BROAD_READ'
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  Check (@($rules|Where-Object {$_.IdentityReference.Value -eq $sid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ExecuteFile) -ne 0}).Count -eq 0) 'FUTURE_EXECUTE'
 }
 if($Case -eq 'one-shot'){$blocked=$false;try{Invoke-SakieAclLabExecution $session $review.Hash|Out-Null}catch{$blocked=$_.Exception.Message -match 'SESSION_CONSUMED'};Check $blocked 'SESSION_REUSED'}
}else{
 Check ($result.Status -eq 'stopped') 'FAULT_DID_NOT_STOP'
 if($Case -eq 'review-tampered'){Check ($result.Error -match 'REVIEW_HASH_CHANGED' -and $result.Attempted.Count -eq 0) 'BAD_REVIEW_ACCEPTED';Check ((Snapshot).Hash -ceq $before.Hash) 'HASH_FAILURE_CHANGED_TARGETS'}
 elseif($Case -eq 'preflight-denied'){
  Check ($result.Error -match 'ALL_WRITE_DAC_REQUIRED' -and $result.Attempted.Count -eq 0) 'PREFLIGHT_MUTATED'
  Check ($result.Preflight.Checked -eq 5) 'PREFLIGHT_SHORT_CIRCUITED';Check ((Snapshot).Hash -ceq $before.Hash) 'PREFLIGHT_CHANGED_TARGETS'
 }
 elseif($Case -in @('inventory-before','audit-before')){Check ($result.Attempted.Count -eq 0) 'EARLY_FAILURE_WROTE';if($Case -eq 'audit-before'){Check ((Snapshot).Hash -ceq $before.Hash) 'NO_AUDIT_CHANGED_TARGETS'}}
 elseif($Case -eq 'audit-after-intent'){Check ($result.NativeCompleted.Count -eq 0 -and $result.Uncertain.Count -eq 1) 'INTENT_NOT_UNCERTAIN'}
 elseif($Case -in @('audit-after-native','unexpected-after-native')){Check ($result.NativeCompleted.Count -eq 1 -and $result.Verified.Count -eq 0 -and $result.Uncertain.Count -eq 1) 'NATIVE_WINDOW_MISREPORTED'}
 else{Check ($result.NativeCompleted.Count -eq 1 -and $result.Verified.Count -eq 1) ('FAULT_NOT_REACHED '+$result.Error)}
 if($Case -ne 'forbidden-after-first'){Check ($forbiddenBefore -ceq ((Get-Acl -LiteralPath $denied).Sddl+'|'+(Get-FileHash -LiteralPath $denied).Hash)) 'FORBIDDEN_CHANGED'}
 else{Check ([IO.File]::ReadAllText($denied) -eq 'SYNTHETIC_EXTERNAL_FORBIDDEN') 'EXTERNAL_FORBIDDEN_OVERWRITTEN'}
 Check (-not $result.AutomaticRecovery) 'AUTOMATIC_RECOVERY_ENABLED'
}
Write-Output ('EXECUTOR_OK '+$Case+' status='+$result.Status+' verified='+$result.Verified.Count+' uncertain='+$result.Uncertain.Count)
