param([Parameter(Mandatory=$true)][string]$FixtureRoot,[string]$Case)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'LAB_REQUIRES_ORDINARY_TOKEN'}
# Test harness only: every ACL setter must stay in this newly created fixture.
if(Test-Path -LiteralPath $FixtureRoot){throw 'LAB_REQUIRES_NEW_DIRECTORY'}
$null=New-Item -ItemType Directory -Path $FixtureRoot
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
. (Join-Path $repo 'tools/windows-acl-scope.ps1')
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools/windows-acl.ps1'),[ref]$null,[ref]$null)
$add=$ast.Find({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type'},$true)
. ([scriptblock]::Create($add.Extent.Text))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$script:RecordTargetCalls=$false;$script:NativeCalls=[Collections.Generic.List[object]]::new();$script:Phase='setup'
function Assert($c,[string]$message){if(-not $c){throw $message}}
function PutAcl([string]$path,$acl){
 Assert ($path.StartsWith($FixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)) 'DIR_LAB_OUTSIDE_FIXTURE'
 $null=Get-SakieScopeItem $path
 if($script:RecordTargetCalls -and (Test-SakieWithin $path $target)){$script:NativeCalls.Add([pscustomobject]@{Path=$path;Phase=$script:Phase})}
 $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
 $bytes=New-Object byte[] $raw.DiscretionaryAcl.BinaryLength;$raw.DiscretionaryAcl.GetBinaryForm($bytes,0)
 [SakieAcl.NativeDacl]::Set($path,$bytes,$acl.AreAccessRulesProtected)
}
function SetSddl([string]$path,[string]$sddl){
 $a=if((Get-Item -LiteralPath $path).PSIsContainer){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
 $a.SetSecurityDescriptorSddlForm($sddl,[Security.AccessControl.AccessControlSections]::Access);PutAcl $path $a
}

$eqAst=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'EquivalentDacl'},$true)
. ([scriptblock]::Create($eqAst.Extent.Text))
function Policy([bool]$directory){
 $a=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
 $a.SetAccessRuleProtection($true,$false)
 if($directory){
  $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit','None','Allow'))
  $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read,Write,Delete,Synchronize','ObjectInherit','InheritOnly','Allow'))
  $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Delete',$inherit,'None','Deny'))
 }else{$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read,Write,Delete,Synchronize','Allow'))}
 foreach($id in @('S-1-5-18','S-1-5-32-544')){
  if($directory){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl',$inherit,'None','Allow'))}
  else{$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl','Allow'))}
 }
 return $a
}
function MakeTree([string]$name){
 $r=Join-Path $FixtureRoot $name;$null=New-Item -ItemType Directory -Path $r
 $a=[Security.AccessControl.DirectorySecurity]::new();$a.SetAccessRuleProtection($true,$false)
 $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow'))
 $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute',$inherit,'None','Allow'));PutAcl $r $a
 foreach($d in @('ordinary','ordinary\deep','preserved')){$null=New-Item -ItemType Directory -Path (Join-Path $r $d)}
 foreach($f in @('ordinary\first.txt','ordinary\explicit.txt','ordinary\deep\raw.txt','preserved\z-denied.txt')){[IO.File]::WriteAllText((Join-Path $r $f),'SYNTHETIC:'+ $f)}
 $p=Join-Path $r 'preserved';$k=Get-Acl -LiteralPath $p;$k.SetAccessRuleProtection($true,$true);PutAcl $p $k
 $z=Join-Path $p 'z-denied.txt';$k=Get-Acl -LiteralPath $z;$k.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-4'),'ChangePermissions','Deny'));PutAcl $z $k
 $e=Join-Path $r 'ordinary\explicit.txt';$k=Get-Acl -LiteralPath $e
 $k.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Read','Allow'))
 $k.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'WriteData','Deny'));PutAcl $e $k
 return $r
}
$ops=@('','ordinary','ordinary\first.txt')
function Scope([string]$r){Get-SakieAclScope -DirectTargets @($r,(Join-Path $r $ops[1]),(Join-Path $r $ops[2])) -ForbiddenTargets @((Join-Path $r 'preserved'))}
function ModelKey([string]$rel){if($rel -eq ''){return '@ROOT'};return $rel}
function Map([string]$r){$m=@{};foreach($row in (Scope $r).Rows){$m[(ModelKey $row.Path.Substring($r.Length))]=$row.AccessSddl};return $m}
function Step([string]$r,[int]$i){$p=if($ops[$i]){Join-Path $r $ops[$i]}else{$r};PutAcl $p (Policy ($i -lt 2))}
$target=MakeTree 'target';$scope=Scope $target;$original=Get-SakieAclSnapshot $scope
$oracle=MakeTree 'oracle';$models=@((Map $oracle))
for($i=0;$i -lt $ops.Count;$i++){Step $oracle $i;$models+=,(Map $oracle)}
# Precompute recovery transitions BEFORE touching the target. Each independent
# oracle starts at the same recipe and executes the same write prefix.
$restorePaths=@($original.Body.Entries|Where-Object {-not $_.Forbidden}|Sort-Object @{Expression={$_.Path.Length}},Path|ForEach-Object {$_.Path.Substring($target.Length)})
$recoveryModels=@{}
$rehearsalStages=if($Case -like 'interrupt-*'){@([int]$Case.Substring(10))}elseif($Case -in @('recovery-fails-again','recovery-concurrent')){@(2)}elseif($Case -in @('propagation','process-kill-window')){@()}else{@(1)}
foreach($stage in $rehearsalStages){
 $r=MakeTree ('recovery-oracle-'+$stage);for($j=0;$j -lt $stage;$j++){Step $r $j}
 $states=@((Map $r))
 foreach($rel in $restorePaths){$key=$target+$rel;$entry=@($original.Body.Entries|Where-Object Path -eq $key)[0];SetSddl ($r+$rel) $entry.AccessSddl;$states+=,(Map $r)}
 foreach($rel in $models[0].Keys){Assert (EquivalentDacl $states[-1][$rel] $models[0][$rel]) 'DIR_ORACLE_RECOVERY_NOT_ORIGINAL'}
 $recoveryModels[$stage.ToString()]=$states
}
function CheckState($model){
 $now=Get-SakieAclSnapshot $scope
 Assert ($now.Body.Entries.Count -eq $original.Body.Entries.Count) 'DIR_INVENTORY_CHANGED'
 foreach($old in $original.Body.Entries){
  $current=@($now.Body.Entries|Where-Object Path -eq $old.Path);Assert ($current.Count -eq 1) 'DIR_PATH_CHANGED'
  foreach($field in @('Directory','OwnerSid','CreatedTicks','Length','WriteTicks','ContentHash')){Assert ($old.$field -ceq $current[0].$field) ('DIR_EXTERNAL_'+$field)}
  $rel=$old.Path.Substring($target.Length);Assert (EquivalentDacl $current[0].AccessSddl $model[(ModelKey $rel)]) ('DIR_UNEXPECTED_DACL '+$rel)
  if($old.Forbidden){Assert ($current[0].AccessSddl -ceq $old.AccessSddl) 'DIR_FORBIDDEN_ACL_CHANGED'}
 }
 return $now
}
$journal=Join-Path $FixtureRoot 'directory-audit.jsonl';$script:seq=0;$script:prev='';$script:AuditUnavailable=$false
function Hash([string]$v){$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($v)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Audit([string]$kind,$data){
 if($script:AuditUnavailable){throw 'DIR_AUDIT_UNAVAILABLE'}
 $payload=[pscustomobject]@{Kind=$kind;Data=$data}|ConvertTo-Json -Depth 40 -Compress
 $n=$script:seq+1;$hash=Hash ($n.ToString()+'|'+$script:prev+'|'+$payload)
 $line=([pscustomobject]@{Seq=$n;Prev=$script:prev;Payload=$payload;Hash=$hash}|ConvertTo-Json -Compress)+[Environment]::NewLine
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes($line);$f=[IO.FileStream]::new($journal,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()};$script:seq=$n;$script:prev=$hash
}
function ReadAudit {
 $n=0;$prev='';foreach($line in [IO.File]::ReadAllLines($journal)){$n++;$r=$line|ConvertFrom-Json
  Assert ($r.Seq -eq $n -and $r.Prev -ceq $prev -and $r.Hash -ceq (Hash ($n.ToString()+'|'+$prev+'|'+$r.Payload))) 'DIR_AUDIT_CORRUPT'
  $prev=$r.Hash;$r.Payload|ConvertFrom-Json
 };Assert ($n -eq $script:seq -and $prev -ceq $script:prev) 'DIR_AUDIT_TAIL_CHANGED'
}
function Evidence([string]$status,[string]$errorText){
 $observed=$null;try{$observed=Get-SakieAclSnapshot $scope}catch{}
 $diffs=@();if($observed){foreach($e in $original.Body.Entries){$n=@($observed.Body.Entries|Where-Object Path -eq $e.Path);if($n.Count -eq 1 -and -not (EquivalentDacl $e.AccessSddl $n[0].AccessSddl)){$direct=@($script:NativeCalls|Where-Object Path -eq $e.Path).Count -gt 0;$diffs+=,[pscustomobject]@{Path=$e.Path;Kind=$(if($direct){'direct-call-observed'}else{'propagation-or-external-not-proven'});Forbidden=$e.Forbidden}}}}
 $report=[pscustomobject]@{NativeCalls=@($script:NativeCalls);AclDifferences=$diffs;AdditionalObservedObjects=@($(if($observed){$observed.Body.Entries|Where-Object {$_.Path -notin @($original.Body.Entries.Path)}}));Case=$Case;Status=$status;Error=$errorText;Stage=$script:stage;RecoveryIndex=$script:recoveryIndex;Original=$original;Observed=$observed;Scope=$scope;CannotProve=@('atomic-enumeration','hostile-path-race','hardware-power-loss','unknown-intent-after-kill','cross-machine-SID','production-root-ownership')}
 [IO.File]::WriteAllText((Join-Path $FixtureRoot 'directory-result.json'),($report|ConvertTo-Json -Depth 40))
}
$script:RecordTargetCalls=$true;$script:Phase='write'
$script:stage=0;$script:recoveryIndex=0;$script:recoveryStopped=$false
function RestoreDirectory {
 $script:Phase='recovery'
 $stage=$script:stage;$states=$recoveryModels[$stage.ToString()]
 # Known model, never an observed post-write snapshot, is the recovery baseline.
 $null=CheckState $states[$script:recoveryIndex]
 Assert (Get-SakieAclWriteDacPreflight $scope).Passed 'DIR_RECOVERY_WRITE_DAC_DENIED'
 for($i=$script:recoveryIndex;$i -lt $restorePaths.Count;$i++){
  $null=CheckState $states[$i];ReadAudit|Out-Null
  Assert (Get-SakieAclWriteDacPreflight $scope).Passed 'DIR_RECOVERY_WRITE_DAC_LOST'
  Audit 'restore-intent' @{Stage=$stage;Index=$i;Path=$target+$restorePaths[$i]}
  if($Case -eq 'recovery-fails-again' -and $i -eq 1 -and -not $script:recoveryStopped){$script:recoveryStopped=$true;throw 'DIR_INJECTED_RECOVERY_FAILURE'}
  $entry=@($original.Body.Entries|Where-Object Path -eq ($target+$restorePaths[$i]))[0]
  SetSddl $entry.Path $entry.AccessSddl
  # Verify the independently rehearsed propagation for this restore step.
  $null=CheckState $states[$i+1];$script:recoveryIndex=$i+1
  Audit 'restore-complete' @{Stage=$stage;Index=$script:recoveryIndex}
  if($Case -eq 'recovery-concurrent' -and $i -eq 0){[IO.File]::WriteAllText((Join-Path $target 'ordinary\deep\raw.txt'),'EXTERNAL_RECOVERY_CONTENT')}
 }
 $null=CheckState $models[0];Audit 'recovered' @{OriginalHash=$original.Hash}
}
$lock=$null
if($Case -eq 'audit-locked'){$lock=[IO.File]::Open($journal,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
$status='not-started';$failure=''
try{
 Assert $scope.CanProceedToDesignReview 'DIR_SCOPE_CONFLICT';$null=CheckState $models[0]
 $probe=Get-SakieAclWriteDacPreflight $scope;Assert $probe.Passed 'DIR_INITIAL_WRITE_DAC_DENIED'
 Audit 'prepared' @{Original=$original;Preflight=$probe;IndependentModels=$models;RecoveryModels=$recoveryModels;RecoveryOrder=$restorePaths}
 for($i=0;$i -lt 3;$i++){
  $null=CheckState $models[$i];ReadAudit|Out-Null
  Assert (Get-SakieAclWriteDacPreflight $scope).Passed 'DIR_WRITE_DAC_LOST'
  Audit 'write-intent' @{Index=$i;Path=$(if($ops[$i]){Join-Path $target $ops[$i]}else{$target})}
  Step $target $i
  if($Case -eq 'process-kill-window' -and $i -eq 0){[Environment]::Exit(83)}
  if($Case -eq 'untrusted-postwrite' -and $i -eq 0){$p=Join-Path $target 'ordinary\deep\raw.txt';$a=Get-Acl -LiteralPath $p;$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),'Read','Allow'));$script:Phase='fault-injection';PutAcl $p $a;$script:Phase='write'}
  $null=CheckState $models[$i+1];$script:stage=$i+1
  Audit 'write-complete' @{Stage=$script:stage}
  if($Case -eq 'loss-write-dac' -and $i -eq 0){$p=Join-Path $target 'ordinary\deep\raw.txt';$a=Get-Acl -LiteralPath $p;$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-4'),'ChangePermissions','Deny'));$script:Phase='fault-injection';PutAcl $p $a;$script:Phase='write';Assert (-not (Get-SakieAclWriteDacPreflight $scope).Passed) 'LOSS_NOT_DETECTED'}
  if($Case -eq 'concurrent-inventory' -and $i -eq 0){$null=New-Item -ItemType Directory -Path (Join-Path $target 'external-new')}
  if($Case -eq 'forbidden-change' -and $i -eq 0){[IO.File]::WriteAllText((Join-Path $target 'preserved\z-denied.txt'),'EXTERNAL_FORBIDDEN')}
  if($Case -eq 'audit-unavailable-after' -and $i -eq 0){$script:AuditUnavailable=$true}
  if($Case -eq 'audit-corrupt' -and $i -eq 0){$lines=[IO.File]::ReadAllLines($journal);$lines[0]=$lines[0].Replace('prepared','tampered');[IO.File]::WriteAllLines($journal,$lines)}
  if($Case -eq ('interrupt-'+($i+1)) -or ($Case -in @('recovery-fails-again','recovery-concurrent') -and $i -eq 1)){throw 'DIR_INJECTED_OBJECT_INTERRUPT'}
 }
 Audit 'completed' @{Stage=$script:stage};$status='completed'
}catch{
 $failure=$_.Exception.Message+' at '+$_.ScriptStackTrace;$status='stopped-evidence-required'
 try{
  ReadAudit|Out-Null;Audit 'failure' @{Error=$failure;Stage=$script:stage}
  if($script:stage -gt 0){RestoreDirectory;$status='recovered'}
 }catch{try{Audit 'recovery-stopped' @{Error=$_.Exception.Message;Stage=$script:stage;RecoveryIndex=$script:recoveryIndex}}catch{}}
}finally{if($lock){$lock.Dispose()}}
if($Case -eq 'recovery-fails-again'){
 Assert ($status -eq 'stopped-evidence-required' -and $script:recoveryIndex -eq 1) 'SECOND_FAILURE_NOT_STOPPED'
 # Explicit same-process synthetic resumption after audited stop; not a production retry.
 ReadAudit|Out-Null;RestoreDirectory;$status='recovered-after-reviewed-lab-resume'
}
if($Case -eq 'propagation'){
 Assert ($status -eq 'completed') ('PROPAGATION_FAILED '+$failure)
 $explicit=@((Get-Acl -LiteralPath (Join-Path $target 'ordinary\explicit.txt')).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 Assert (@($explicit|Where-Object {$_.IdentityReference.Value -eq 'S-1-5-32-545' -and -not $_.IsInherited -and $_.AccessControlType -eq 'Allow'}).Count -gt 0) 'EXPLICIT_ALLOW_LOST'
 Assert (@($explicit|Where-Object {$_.IdentityReference.Value -eq 'S-1-1-0' -and -not $_.IsInherited -and $_.AccessControlType -eq 'Deny'}).Count -gt 0) 'EXPLICIT_DENY_LOST'
 Assert (@($explicit|Where-Object {$_.IdentityReference.Value -eq 'S-1-1-0' -and $_.IsInherited -and $_.AccessControlType -eq 'Deny'}).Count -gt 0) 'INHERITED_DENY_MISSING'
 $futureDir=Join-Path $target 'ordinary\future';$null=New-Item -ItemType Directory -Path $futureDir
 $f=Join-Path $futureDir 'new.db-wal';[IO.File]::WriteAllText($f,'SYNTHETIC_FUTURE')
 $rules=@((Get-Acl -LiteralPath $f).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 Assert (@($rules|Where-Object {$_.IdentityReference.Value -in @('S-1-5-32-545','S-1-5-11')}).Count -eq 0) 'FUTURE_BROAD_READ'
 Assert (@($rules|Where-Object {$_.IdentityReference.Value -eq $sid.Value -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ExecuteFile) -ne 0}).Count -eq 0) 'FUTURE_EXECUTE'
 # Future objects intentionally make the original inventory inapplicable: no recovery attempt.
 Audit 'future-observed' @{Path=$f;Sddl=(Get-Acl -LiteralPath $f).Sddl;RecoveryAgainstOldInventoryAllowed=$false}
}else{
 if($Case -like 'interrupt-*'){Assert ($status -eq 'recovered') ('INTERRUPT_NOT_RECOVERED '+$failure);$null=CheckState $models[0]}
 elseif($Case -eq 'recovery-fails-again'){Assert ($status -eq 'recovered-after-reviewed-lab-resume') 'RESUME_FAILED';$null=CheckState $models[0]}
 else{Assert ($status -eq 'stopped-evidence-required') ('EXPECTED_STOP '+$status)
  if($Case -eq 'audit-locked'){Assert ($script:stage -eq 0 -and $script:NativeCalls.Count -eq 0) 'AUDIT_LOCK_NOT_ZERO'}
  elseif($Case -eq 'untrusted-postwrite'){Assert ($script:stage -eq 0 -and $script:NativeCalls.Count -ge 2) 'POSTWRITE_INJECTION_NOT_REACHED'}
  else{Assert ($script:stage -ge 1) ('INJECTION_NOT_REACHED '+$failure)}
 }
 if($Case -eq 'concurrent-inventory'){Assert (Test-Path -LiteralPath (Join-Path $target 'external-new')) 'EXTERNAL_DIRECTORY_REMOVED'}
 if($Case -eq 'forbidden-change'){Assert ([IO.File]::ReadAllText((Join-Path $target 'preserved\z-denied.txt')) -eq 'EXTERNAL_FORBIDDEN') 'FORBIDDEN_OVERWRITTEN'}
 if($Case -eq 'recovery-concurrent'){Assert ([IO.File]::ReadAllText((Join-Path $target 'ordinary\deep\raw.txt')) -eq 'EXTERNAL_RECOVERY_CONTENT') 'RECOVERY_CONTENT_OVERWRITTEN'}
}
Evidence $status $failure
Write-Output ('DIR_LAB_OK '+$Case+' status='+$status)
