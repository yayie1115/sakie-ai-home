# Synthetic-only execution entry. No production Plan/Apply/Restore interface.
Set-StrictMode -Version Latest
$script:LabExecutorSource=$PSCommandPath
$script:LabToolDirectory=$PSScriptRoot
$script:LabSessions=@{}
. (Join-Path $PSScriptRoot 'windows-acl-scope.ps1')
$script:LabNativeSource=Join-Path $PSScriptRoot 'windows-acl.ps1'
if(-not ('SakieAcl.NativeDacl' -as [type])){
 $ast=[Management.Automation.Language.Parser]::ParseFile($script:LabNativeSource,[ref]$null,[ref]$null)
 $add=$ast.Find({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type'},$true)
 . ([scriptblock]::Create($add.Extent.Text))
}
function Assert-Lab($Condition,[string]$Code){if(-not $Condition){throw $Code}}
function Get-LabHash([string]$Text){$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Get-LabContext($Session){
 Assert-Lab ($null -ne $Session -and $script:LabSessions.ContainsKey($Session.Id)) 'LAB_SESSION_UNKNOWN'
 $ctx=$script:LabSessions[$Session.Id]
 Assert-Lab ([object]::ReferenceEquals($ctx.Public,$Session)) 'LAB_SESSION_FORGED'
 Assert-Lab (([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -eq $ctx.Sid) 'LAB_SID_CHANGED'
 Assert-Lab (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'LAB_ORDINARY_TOKEN_REQUIRED'
 return $ctx
}
function Get-LabProfile([string]$Profile,[string]$Sid){
 Assert-Lab ($Profile -in @('DirectoryRwd','FileRead','FileRwd')) 'LAB_PROFILE_UNKNOWN'
 $dir=$Profile -eq 'DirectoryRwd'
 $acl=if($dir){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
 $acl.SetAccessRuleProtection($true,$false)
 $user=[Security.Principal.SecurityIdentifier]::new($Sid)
 if($dir){
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user,'Modify','ContainerInherit','None','Allow'))
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user,'Read,Write,Delete,Synchronize','ObjectInherit','InheritOnly','Allow'))
 }else{
  $rights=if($Profile -eq 'FileRead'){'Read,Synchronize'}else{'Read,Write,Delete,Synchronize'}
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user,$rights,'Allow'))
 }
 foreach($id in @('S-1-5-18','S-1-5-32-544')){
  $s=[Security.Principal.SecurityIdentifier]::new($id)
  if($dir){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  else{$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','Allow'))}
 }
 return $acl
}
function Set-LabNative($Ctx,[string]$Path,$Acl){
 Assert-Lab ($script:LabSessions.ContainsKey($Ctx.Public.Id) -and [object]::ReferenceEquals($script:LabSessions[$Ctx.Public.Id],$Ctx)) 'LAB_NATIVE_CONTEXT_REQUIRED'
 Assert-Lab (Test-SakieWithin $Path $Ctx.Root) 'LAB_WRITE_OUTSIDE_NEW_ROOT'
 $null=Get-SakieScopeItem $Path
 $raw=[Security.AccessControl.RawSecurityDescriptor]::new($Acl.GetSecurityDescriptorBinaryForm(),0)
 $bytes=New-Object byte[] $raw.DiscretionaryAcl.BinaryLength;$raw.DiscretionaryAcl.GetBinaryForm($bytes,0)
 [SakieAcl.NativeDacl]::Set($Path,$bytes,$Acl.AreAccessRulesProtected)
}
function New-SakieAclSyntheticSession([string]$FixtureRoot){
 Assert-Lab (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'LAB_ORDINARY_TOKEN_REQUIRED'
 Assert-Lab ($FixtureRoot -match '^[A-Za-z]:[\\/]' -and -not $FixtureRoot.Substring(2).Contains(':')) 'LAB_ABSOLUTE_ROOT_REQUIRED'
 $root=[IO.Path]::GetFullPath($FixtureRoot).TrimEnd('\')
 Assert-Lab ($root.Length -gt 3 -and -not (Test-Path -LiteralPath $root)) 'LAB_REQUIRES_NEW_ROOT'
 $null=Get-SakieScopeItem ([IO.Path]::GetDirectoryName($root))
 $null=New-Item -ItemType Directory -Path $root -ErrorAction Stop
 $id=[guid]::NewGuid().ToString('N');$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $public=[pscustomobject]@{Id=$id;FixtureRoot=$root;SyntheticOnly=$true}
 $ctx=@{Public=$public;Root=$root;Sid=$sid;Assets=(Join-Path $root 'assets');Evidence=(Join-Path $root 'evidence');Frozen=$false;Consumed=$false;Known=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);Review=$null;ReviewHash='';ReviewPath='';Journal='';Seq=0;Tail='';Verified=@();Attempted=@();NativeCompleted=@();IntentPaths=@();AuditFault=$false}
 $script:LabSessions[$id]=$ctx
 Set-LabNative $ctx $root (Get-LabProfile 'DirectoryRwd' $sid)
 foreach($p in @($ctx.Assets,$ctx.Evidence)){$null=New-Item -ItemType Directory -Path $p;Set-LabNative $ctx $p (Get-LabProfile 'DirectoryRwd' $sid)}
 $null=$ctx.Known.Add($ctx.Assets);$script:LabSessions[$id]=$ctx
 return $public
}
function New-SakieAclSyntheticAsset($Session,[string]$RelativePath,[switch]$Directory){
 $ctx=Get-LabContext $Session;Assert-Lab (-not $ctx.Frozen) 'LAB_ALREADY_FROZEN'
 Assert-Lab (-not [IO.Path]::IsPathRooted($RelativePath) -and $RelativePath -notmatch '(^|[\\/])\.\.([\\/]|$)|:') 'LAB_RELATIVE_ASSET_REQUIRED'
 $path=[IO.Path]::GetFullPath((Join-Path $ctx.Assets $RelativePath))
 Assert-Lab ($path.StartsWith($ctx.Assets+'\',[StringComparison]::OrdinalIgnoreCase)) 'LAB_ASSET_OUTSIDE'
 Assert-Lab (-not (Test-Path -LiteralPath $path)) 'LAB_ASSET_EXISTS'
 $parent=Get-SakieScopeItem ([IO.Path]::GetDirectoryName($path));Assert-Lab ($ctx.Known.Contains($parent.FullName)) 'LAB_PARENT_NOT_CREATED_BY_SESSION'
 if($Directory){$null=New-Item -ItemType Directory -Path $path}else{[IO.File]::WriteAllText($path,'SYNTHETIC_ONLY:'+ $RelativePath)}
 Set-LabNative $ctx $path (Get-LabProfile $(if($Directory){'DirectoryRwd'}else{'FileRwd'}) $ctx.Sid)
 $null=$ctx.Known.Add($path);return $path
}
# Fixture bootstrap only, never a way to supply old production objects.
function Set-SakieAclSyntheticBootstrap($Session,[string]$Path,[string]$AccessSddl){
 $ctx=Get-LabContext $Session;Assert-Lab (-not $ctx.Frozen -and $ctx.Known.Contains($Path)) 'LAB_BOOTSTRAP_NOT_ALLOWED'
 $i=Get-SakieScopeItem $Path;$a=if($i.PSIsContainer){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
 $a.SetSecurityDescriptorSddlForm($AccessSddl,[Security.AccessControl.AccessControlSections]::Access);Set-LabNative $ctx $Path $a
}
function Get-LabDependencies {
 @(foreach($p in @($script:LabExecutorSource,(Join-Path $script:LabToolDirectory 'windows-acl-scope.ps1'),$script:LabNativeSource)){[pscustomobject]@{Path=$p;Hash=(Get-FileHash -LiteralPath $p).Hash}})
}
function New-SakieAclLabReview($Session,[object[]]$Assignments,[string[]]$ForbiddenPaths){
 $ctx=Get-LabContext $Session;Assert-Lab (-not $ctx.Frozen) 'LAB_ALREADY_FROZEN'
 Assert-Lab ($Assignments.Count -gt 0 -and $ForbiddenPaths.Count -gt 0) 'LAB_EXPLICIT_REVIEW_REQUIRED'
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 $targets=@(@(foreach($a in $Assignments){
  Assert-Lab ($ctx.Known.Contains($a.Path) -and $seen.Add($a.Path)) 'LAB_TARGET_UNKNOWN_OR_DUPLICATE'
  $i=Get-SakieScopeItem $a.Path
  Assert-Lab (($i.PSIsContainer -and $a.Profile -eq 'DirectoryRwd') -or (-not $i.PSIsContainer -and $a.Profile -in @('FileRead','FileRwd'))) 'LAB_PROFILE_TYPE_MISMATCH'
  $profile=Get-LabProfile $a.Profile $ctx.Sid
  [pscustomobject]@{Path=$i.FullName;Profile=$a.Profile;TargetDacl=$profile.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);Protected=$true;TargetAces=@($profile.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{[pscustomobject]@{Sid=$_.IdentityReference.Value;Type=$_.AccessControlType.ToString();Rights=[int64]$_.FileSystemRights;Inheritance=$_.InheritanceFlags.ToString();Propagation=$_.PropagationFlags.ToString()}})}
 })|Sort-Object @{Expression={$_.Path.Length};Descending=$true},Path)
 foreach($p in $ForbiddenPaths){Assert-Lab ($ctx.Known.Contains($p)) 'LAB_FORBIDDEN_NOT_OWNED'}
 $all=Get-SakieAclScope -DirectTargets @($ctx.Assets) -ForbiddenTargets $ForbiddenPaths
 Assert-Lab ($all.Rows.Count -eq $ctx.Known.Count) 'LAB_UNREGISTERED_OBJECT'
 foreach($row in $all.Rows){Assert-Lab ($ctx.Known.Contains($row.Path)) 'LAB_UNREGISTERED_OBJECT'}
 $impact=@(foreach($t in $targets){
  $s=Get-SakieAclScope -DirectTargets @($t.Path) -ForbiddenTargets $ForbiddenPaths
  Assert-Lab $s.CanProceedToDesignReview 'LAB_FORBIDDEN_IMPACT'
  foreach($r in $s.Rows|Where-Object {$_.Class -ne 'outside-propagation'}){Assert-Lab ($seen.Contains($r.Path)) 'LAB_INHERITED_OBJECT_NOT_CLOSED'}
  [pscustomobject]@{Direct=$t.Path;Potential=@($s.Rows|Where-Object Class -eq 'potential-inherited'|ForEach-Object Path)}
 })
 $scope=Get-SakieAclScope -DirectTargets @($targets.Path) -ForbiddenTargets $ForbiddenPaths
 Assert-Lab $scope.CanProceedToDesignReview 'LAB_FORBIDDEN_IMPACT'
 $original=Get-SakieAclSnapshot $all
 foreach($e in $original.Body.Entries){$raw=[Security.AccessControl.RawSecurityDescriptor]::new($e.AccessSddl);Assert-Lab ($null -ne $raw.DiscretionaryAcl -and $raw.DiscretionaryAcl.Count -gt 0) 'LAB_EMPTY_DACL';foreach($ace in $raw.DiscretionaryAcl){Assert-Lab ($ace -is [Security.AccessControl.CommonAce] -and -not $ace.IsCallback) 'LAB_UNSUPPORTED_ACE'}}
 $body=[pscustomobject]@{Version=1;Purpose='synthetic-execution-review-only';SessionId=$Session.Id;Sid=$ctx.Sid;Root=$ctx.Root;Assets=$ctx.Assets;Dependencies=@(Get-LabDependencies);Original=$original;Targets=$targets;Forbidden=$ForbiddenPaths;Impact=$impact;Strategy='deepest-first-protected-children-no-implicit-propagation';AutomaticRecovery=$false}
 $json=$body|ConvertTo-Json -Depth 40 -Compress;$ctx.ReviewHash=Get-LabHash $json;$ctx.Review=$json;$ctx.ReviewPath=Join-Path $ctx.Evidence 'synthetic-review.json'
 [IO.File]::WriteAllText($ctx.ReviewPath,$json,[Text.UTF8Encoding]::new($false));$ctx.Frozen=$true
 return [pscustomobject]@{Path=$ctx.ReviewPath;Hash=$ctx.ReviewHash;Objects=$original.Body.Entries.Count;Targets=$targets;Impact=$impact;SyntheticOnly=$true}
}
function Test-LabTargetDacl([string]$Actual,[string]$Target){
 $a=[Security.AccessControl.RawSecurityDescriptor]::new($Actual);$b=[Security.AccessControl.RawSecurityDescriptor]::new($Target)
 # Only the Windows AutoInherited bookkeeping bit may differ. Protection and all
 # ACE bytes (SID, mask, flags, multiplicity) remain strictly reviewed.
 $ignore=[int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited
 if((([int]$a.ControlFlags -band (-bnot $ignore)) -ne ([int]$b.ControlFlags -band (-bnot $ignore))) -or $a.DiscretionaryAcl.Revision -ne $b.DiscretionaryAcl.Revision){return $false}
 $keys=@(foreach($d in @($a,$b)){,@(foreach($ace in $d.DiscretionaryAcl){if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -ne 'AccessAllowed'){return $false};$bytes=New-Object byte[] $ace.BinaryLength;$ace.GetBinaryForm($bytes,0);[Convert]::ToBase64String($bytes)})})
 return (($keys[0]|Sort-Object)-join '|') -ceq (($keys[1]|Sort-Object)-join '|')
}
function Assert-LabState($Ctx,$Review,[string[]]$Verified){
 $scope=Get-SakieAclScope -DirectTargets @($Ctx.Assets) -ForbiddenTargets $Review.Forbidden
 $now=Get-SakieAclSnapshot $scope
 Assert-Lab ($now.Body.Entries.Count -eq $Review.Original.Body.Entries.Count) 'LAB_CLOSED_INVENTORY_CHANGED'
 foreach($before in $Review.Original.Body.Entries){
  $after=@($now.Body.Entries|Where-Object Path -eq $before.Path);Assert-Lab ($after.Count -eq 1) 'LAB_CLOSED_PATH_CHANGED'
  foreach($f in @('Directory','OwnerSid','CreatedTicks','Length','WriteTicks','ContentHash')){Assert-Lab ($before.$f -ceq $after[0].$f) ('LAB_EXTERNAL_'+$f)}
  if($Verified -contains $before.Path){$t=@($Review.Targets|Where-Object Path -eq $before.Path)[0];Assert-Lab (Test-LabTargetDacl $after[0].AccessSddl $t.TargetDacl) 'LAB_TARGET_DACL_MISMATCH'}
  else{Assert-Lab ($after[0].AccessSddl -ceq $before.AccessSddl) 'LAB_UNAPPROVED_DACL_CHANGE'}
 }
 return $now
}
function Write-LabAudit($Ctx,[string]$Kind,$Data){
 Assert-Lab (-not $Ctx.AuditFault) 'LAB_AUDIT_UNAVAILABLE'
 $payload=[pscustomobject]@{Kind=$Kind;Data=$Data}|ConvertTo-Json -Depth 40 -Compress
 $seq=$Ctx.Seq+1;$hash=Get-LabHash ($seq.ToString()+'|'+$Ctx.Tail+'|'+$payload)
 $line=([pscustomobject]@{Seq=$seq;Previous=$Ctx.Tail;Payload=$payload;Hash=$hash}|ConvertTo-Json -Compress)+[Environment]::NewLine
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes($line)
 $stream=[IO.FileStream]::new($Ctx.Journal,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()};$Ctx.Seq=$seq;$Ctx.Tail=$hash
}
function Assert-LabAudit($Ctx){
 $seq=0;$tail=''
 foreach($line in [IO.File]::ReadAllLines($Ctx.Journal)){$r=$line|ConvertFrom-Json;$seq++;Assert-Lab ($r.Seq -eq $seq -and $r.Previous -ceq $tail -and $r.Hash -ceq (Get-LabHash ($seq.ToString()+'|'+$tail+'|'+$r.Payload))) 'LAB_AUDIT_CORRUPT';$tail=$r.Hash}
 Assert-Lab ($seq -eq $Ctx.Seq -and $tail -ceq $Ctx.Tail) 'LAB_AUDIT_TAIL_CHANGED'
}
function Invoke-SakieAclLabExecution {
 [CmdletBinding()]
 param($Session,[Parameter(Mandatory=$true)][string]$ExpectedReviewHash,[ValidateSet('none','after-first','inventory-before','inventory-after-first','content-after-first','forbidden-after-first','audit-before','audit-after-intent','audit-after-native','unexpected-after-native','lose-dac-after-first')][string]$SyntheticFault='none')
 $ctx=Get-LabContext $Session;Assert-Lab ($ctx.Frozen -and -not $ctx.Consumed) 'LAB_REVIEW_REQUIRED_OR_SESSION_CONSUMED';$ctx.Consumed=$true
 $status='stopped';$errorText='';$preflight=$null;$observed=$null
 try{
  Assert-Lab ($ExpectedReviewHash -ceq $ctx.ReviewHash -and (Get-FileHash -LiteralPath $ctx.ReviewPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ctx.ReviewHash) 'LAB_REVIEW_HASH_CHANGED'
  $r=$ctx.Review|ConvertFrom-Json
  Assert-Lab (($r.Dependencies|ConvertTo-Json -Compress) -ceq ((Get-LabDependencies)|ConvertTo-Json -Compress)) 'LAB_DEPENDENCY_CHANGED'
  if($SyntheticFault -eq 'inventory-before'){[IO.File]::WriteAllText((Join-Path $ctx.Assets 'external-new.txt'),'SYNTHETIC_EXTERNAL')}
  $null=Assert-LabState $ctx $r @()
  $scope=Get-SakieAclScope -DirectTargets @($r.Targets.Path) -ForbiddenTargets $r.Forbidden
  $preflight=Get-SakieAclWriteDacPreflight $scope;Assert-Lab $preflight.Passed 'LAB_ALL_WRITE_DAC_REQUIRED'
  $ctx.Journal=Join-Path $ctx.Evidence 'execution-audit.jsonl'
  Assert-Lab (-not (Test-Path -LiteralPath $ctx.Journal)) 'LAB_AUDIT_ALREADY_EXISTS'
  $f=[IO.File]::Open($ctx.Journal,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$f.Dispose()
  if($SyntheticFault -eq 'audit-before'){$ctx.AuditFault=$true}
  Write-LabAudit $ctx 'prepared' @{ReviewHash=$ctx.ReviewHash;OriginalHash=$r.Original.Hash;Preflight=$preflight;Sid=$ctx.Sid}
  foreach($t in $r.Targets){
   Assert-Lab ((Get-FileHash -LiteralPath $ctx.ReviewPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ctx.ReviewHash) 'LAB_REVIEW_HASH_CHANGED'
   Assert-Lab (($r.Dependencies|ConvertTo-Json -Compress) -ceq ((Get-LabDependencies)|ConvertTo-Json -Compress)) 'LAB_DEPENDENCY_CHANGED'
   $null=Assert-LabState $ctx $r $ctx.Verified;Assert-LabAudit $ctx
   Assert-Lab (Get-SakieAclWriteDacPreflight $scope).Passed 'LAB_WRITE_DAC_LOST'
   if($t.Profile -eq 'DirectoryRwd'){
    foreach($child in @(Get-ChildItem -LiteralPath $t.Path -Force)){Assert-Lab ((Get-Acl -LiteralPath $child.FullName).AreAccessRulesProtected) 'LAB_CHILD_NOT_ISOLATED'}
   }
   # Approved target is reconstructed; an observed post-write descriptor is never trusted.
   Write-LabAudit $ctx 'write-intent' @{Path=$t.Path;Profile=$t.Profile;TargetDacl=$t.TargetDacl;VerifiedBefore=$ctx.Verified;ReviewHash=$ctx.ReviewHash};$ctx.IntentPaths+=@($t.Path)
   if($SyntheticFault -eq 'audit-after-intent'){$ctx.AuditFault=$true;throw 'LAB_FAULT_AFTER_INTENT'}
   $ctx.Attempted+=@($t.Path)
   Set-LabNative $ctx $t.Path (Get-LabProfile $t.Profile $ctx.Sid);$ctx.NativeCompleted+=@($t.Path)
   if($SyntheticFault -eq 'audit-after-native'){$ctx.AuditFault=$true;throw 'LAB_FAULT_AFTER_NATIVE'}
   if($SyntheticFault -eq 'unexpected-after-native'){
    $a=Get-Acl -LiteralPath $t.Path;$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Read','Allow'));Set-LabNative $ctx $t.Path $a
   }
   $candidate=@($ctx.Verified)+@($t.Path);$observed=Assert-LabState $ctx $r $candidate
   Write-LabAudit $ctx 'write-verified' @{Path=$t.Path;ObservedHash=$observed.Hash};$ctx.Verified=$candidate
   if($ctx.Verified.Count -eq 1){
    switch($SyntheticFault){
     'after-first' {throw 'LAB_FAULT_AFTER_FIRST'}
     'inventory-after-first' {[IO.File]::WriteAllText((Join-Path $ctx.Assets 'external-new.txt'),'SYNTHETIC_EXTERNAL')}
     'content-after-first' {$next=@($r.Targets|Where-Object {$_.Profile -ne 'DirectoryRwd' -and $_.Path -notin $ctx.Verified})[0];[IO.File]::WriteAllText($next.Path,'SYNTHETIC_EXTERNAL_CONTENT')}
     'forbidden-after-first' {$path=@($r.Original.Body.Entries|Where-Object {$_.Forbidden -and -not $_.Directory})[0].Path;[IO.File]::WriteAllText($path,'SYNTHETIC_EXTERNAL_FORBIDDEN')}
     'lose-dac-after-first' {$next=@($r.Targets|Where-Object {$_.Profile -ne 'DirectoryRwd' -and $_.Path -notin $ctx.Verified})[0];$a=Get-Acl -LiteralPath $next.Path;$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-4'),'ChangePermissions','Deny'));Set-LabNative $ctx $next.Path $a;Assert-Lab (-not (Get-SakieAclWriteDacPreflight $scope).Passed) 'LAB_FAULT_DAC_NOT_REPRODUCED'}
    }
   }
  }
  $observed=Assert-LabState $ctx $r $ctx.Verified;Assert-LabAudit $ctx
  Write-LabAudit $ctx 'completed' @{ReviewHash=$ctx.ReviewHash;Verified=$ctx.Verified;ObservedHash=$observed.Hash};$status='completed'
 }catch{
  $errorText=$_.Exception.Message
  if($ctx.Journal -and (Test-Path -LiteralPath $ctx.Journal)){
   try{Assert-LabAudit $ctx;Write-LabAudit $ctx 'stopped' @{Error=$errorText;Attempted=$ctx.Attempted;NativeCompleted=$ctx.NativeCompleted;Verified=$ctx.Verified}}catch{}
  }
 }
 $result=[pscustomobject]@{SyntheticOnly=$true;InjectedFault=$SyntheticFault;Status=$status;Error=$errorText;ReviewHash=$ctx.ReviewHash;Preflight=$preflight;Attempted=$ctx.Attempted;NativeCompleted=$ctx.NativeCompleted;Verified=$ctx.Verified;Uncertain=@($ctx.IntentPaths|Where-Object {$_ -notin $ctx.Verified});Journal=$ctx.Journal;AuditRecords=$ctx.Seq;AuditTail=$ctx.Tail;AutomaticRecovery=$false}
 # Separate failure observation, never repair or overwrite the journal.
 try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($result|ConvertTo-Json -Depth 30));$out=[IO.File]::Open((Join-Path $ctx.Evidence 'execution-result.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$out.Write($bytes,0,$bytes.Length);$out.Flush($true)}finally{$out.Dispose()}}catch{}
 return $result
}
