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
$root=Join-Path $FixtureRoot 'root';$null=New-Item -ItemType Directory -Path $root
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
function Assert($condition,[string]$message){if(-not $condition){throw $message}}
function PutAcl($path,$acl){Assert ($path.StartsWith($FixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)) 'LAB_OUT_OF_SCOPE';$null=Get-SakieScopeItem $path;$raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);$bytes=New-Object byte[] $raw.DiscretionaryAcl.BinaryLength;$raw.DiscretionaryAcl.GetBinaryForm($bytes,0);[SakieAcl.NativeDacl]::Set($path,$bytes,$acl.AreAccessRulesProtected)}
function Sddl($path){(Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)}
$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetAccessRuleProtection($true,$false)
$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow'))
$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute',$inherit,'None','Allow'))
PutAcl $root $a
$ordinary=Join-Path $root 'ordinary';$null=New-Item -ItemType Directory -Path $ordinary
$file=Join-Path $ordinary 'history.txt';[IO.File]::WriteAllText($file,'SYNTHETIC_ONLY')
$keep=Join-Path $root 'preserved';$null=New-Item -ItemType Directory -Path $keep
$denied=Join-Path $keep 'z-denied.txt';[IO.File]::WriteAllText($denied,'SYNTHETIC_DENIED')
$d=Get-Acl -LiteralPath $denied;$d.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-4'),'ChangePermissions','Deny'));PutAcl $denied $d

# No production command or input plan. This process created all writable paths above.
$k=Get-Acl -LiteralPath $keep;$k.SetAccessRuleProtection($true,$true);PutAcl $keep $k
$second=Join-Path $ordinary 'second.txt';[IO.File]::WriteAllText($second,'SYNTHETIC_SECOND')
$scope=Get-SakieAclScope -DirectTargets @($file,$second) -ForbiddenTargets @($keep)
$initial=Get-SakieAclSnapshot $scope
$journal=Join-Path $FixtureRoot 'lab-audit.jsonl'
$script:sequence=0;$script:previous='';$script:auditFail=$false;$script:recoverFail=$false;$script:recoverCount=0;$script:recoverPartial=$false
function HashText([string]$s){$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Audit([string]$kind,$data){
 if($script:auditFail){throw 'LAB_AUDIT_WRITE_FAILED'}
 $payload=[pscustomobject]@{Kind=$kind;Data=$data}|ConvertTo-Json -Depth 30 -Compress
 $seq=$script:sequence+1;$hash=HashText ($seq.ToString()+'|'+$script:previous+'|'+$payload)
 $line=([pscustomobject]@{Seq=$seq;Prev=$script:previous;Payload=$payload;Hash=$hash}|ConvertTo-Json -Compress)+[Environment]::NewLine
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes($line)
 $stream=[IO.FileStream]::new($journal,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 $script:sequence=$seq;$script:previous=$hash
}
function ReadAudit {
 $seq=0;$prev='';$records=@(foreach($line in [IO.File]::ReadAllLines($journal)){
  if(-not $line){throw 'LAB_AUDIT_EMPTY_RECORD'};$r=$line|ConvertFrom-Json;$seq++
  if($r.Seq -ne $seq -or $r.Prev -cne $prev -or $r.Hash -cne (HashText ($seq.ToString()+'|'+$prev+'|'+$r.Payload))){throw 'LAB_AUDIT_INVALID'}
  $prev=$r.Hash;$r.Payload|ConvertFrom-Json
 });return $records
}
function SetPrivateFile([string]$path){
 $a=[Security.AccessControl.FileSecurity]::new();$a.SetAccessRuleProtection($true,$false)
 $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read,Write,Delete,Synchronize','Allow'))
 foreach($id in @('S-1-5-18','S-1-5-32-544')){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl','Allow'))}
 PutAcl $path $a
}
function RecoverLab($state){
 Assert (Test-SakieAclSnapshot $scope $state.Expected) 'LAB_RECOVERY_STATE_CHANGED'
 $probe=Get-SakieAclWriteDacPreflight $scope;Assert $probe.Passed 'LAB_RECOVERY_WRITE_DAC_DENIED'
 foreach($path in @($state.Touched | Sort-Object -Descending)){
  Assert (Test-SakieAclSnapshot $scope $state.Expected) 'LAB_RECOVERY_CONCURRENT_CHANGE'
  Audit 'restore-intent' @{Path=$path}
  if($script:recoverFail -or ($script:recoverPartial -and $script:recoverCount -eq 1)){throw 'LAB_INJECTED_RECOVERY_FAILURE'}
  $entry=@($state.Initial.Body.Entries | Where-Object Path -eq $path)[0]
  $a=[Security.AccessControl.FileSecurity]::new();$a.SetSecurityDescriptorSddlForm($entry.AccessSddl,[Security.AccessControl.AccessControlSections]::Access);PutAcl $path $a
  $state.Expected=Get-SakieAclSnapshot $scope
  Audit 'restore-complete' @{Path=$path;Expected=$state.Expected};$script:recoverCount++
 }
 Assert (Test-SakieAclSnapshot $scope $state.Initial) 'LAB_RECOVERY_VERIFY_FAILED'
 Audit 'recovered' @{SnapshotHash=$state.Initial.Hash}
}
function RunLab([string]$fault){
 $state=[pscustomobject]@{Initial=$initial;Expected=$initial;Touched=@()}
 try{
  $report=Get-SakieAclScope -DirectTargets $scope.DirectTargets -ForbiddenTargets $scope.ForbiddenTargets
  Assert $report.CanProceedToDesignReview 'LAB_CONFLICT'
  Assert (Test-SakieAclSnapshot $scope $initial) 'LAB_SNAPSHOT_CHANGED'
  $probe=Get-SakieAclWriteDacPreflight $scope;Assert $probe.Passed 'LAB_WRITE_DAC_PREFLIGHT'
  Audit 'prepared' @{Snapshot=$initial;Preflight=$probe}
  $index=0
  foreach($path in $scope.DirectTargets){
   if($index -eq 1 -and $fault -eq 'concurrent'){[IO.File]::WriteAllText($second,'EXTERNAL_SYNTHETIC_CHANGE')}
   if($index -eq 1 -and $fault -eq 'acl-change'){$a=Get-Acl -LiteralPath $second;$a.SetAccessRuleProtection($true,$true);PutAcl $second $a}
   if($index -eq 1 -and $fault -eq 'inventory-change'){[IO.File]::WriteAllText((Join-Path $keep 'external-new.txt'),'EXTERNAL_NEW')}
   if($index -eq 1 -and $fault -eq 'forbidden-change'){[IO.File]::WriteAllText($denied,'EXTERNAL_DENIED_CHANGE')}
   Assert (Test-SakieAclSnapshot $scope $state.Expected) 'LAB_EXECUTION_STATE_CHANGED'
   Audit 'write-intent' @{Path=$path;Before=$state.Expected.Hash}
   $state.Touched+=@($path)
   SetPrivateFile $path
   if($index -eq 0 -and $fault -eq 'write-window-change'){[IO.File]::WriteAllText($second,'EXTERNAL_WRITE_WINDOW')}
   $candidate=Get-SakieAclSnapshot $scope
   Assert ($candidate.Body.Entries.Count -eq $state.Expected.Body.Entries.Count) 'LAB_WRITE_WINDOW_INVENTORY_CHANGED'
   foreach($old in $state.Expected.Body.Entries){
    $now=@($candidate.Body.Entries|Where-Object Path -eq $old.Path)
    Assert ($now.Count -eq 1) 'LAB_WRITE_WINDOW_PATH_CHANGED'
    foreach($field in @('Path','Class','Forbidden','Directory','OwnerSid','CreatedTicks','Length','WriteTicks','ContentHash')){Assert ($old.$field -ceq $now[0].$field) 'LAB_WRITE_WINDOW_METADATA_CHANGED'}
    if($old.Path -ine $path){Assert ($old.AccessSddl -ceq $now[0].AccessSddl) 'LAB_WRITE_WINDOW_ACL_CHANGED'}
   }
   $state.Expected=$candidate
   # No forbidden ACL/content, owner or object set may change as a result of our write.
   foreach($e in $initial.Body.Entries|Where-Object Forbidden){$n=@($state.Expected.Body.Entries|Where-Object Path -eq $e.Path)[0];Assert (($e|ConvertTo-Json -Compress) -ceq ($n|ConvertTo-Json -Compress)) 'LAB_FORBIDDEN_CHANGED'}
   Audit 'write-complete' @{Path=$path;Expected=$state.Expected}
   $index++
   if($index -eq 1 -and $fault -in @('failure','recovery-failure')){throw 'LAB_INJECTED_WRITE_FAILURE'}
   if($index -eq 2 -and $fault -eq 'recovery-partial'){throw 'LAB_INJECTED_SECOND_FAILURE'}
   if($index -eq 1 -and $fault -eq 'audit-failure-after'){$script:auditFail=$true}
  }
  Audit 'completed' @{Snapshot=$state.Expected}
  return [pscustomobject]@{Status='completed';State=$state}
 }catch{
  $errorText=$_.Exception.Message
  try{
   Audit 'failure' @{Error=$errorText;Touched=$state.Touched}
   # Never overwrite external changes just to make recovery verification pass.
   Assert (Test-SakieAclSnapshot $scope $state.Expected) 'LAB_RECOVERY_EXTERNAL_CHANGE'
   if($state.Touched.Count -gt 0){RecoverLab $state}
   return [pscustomobject]@{Status='recovered-or-zero';Error=$errorText;State=$state}
  }catch{
   $recoveryError=$_.Exception.Message
   try{Audit 'recovery-required' @{Error=$errorText;RecoveryError=$recoveryError;State=$state}}catch{}
   return [pscustomobject]@{Status='recovery-required';Error=$errorText;RecoveryError=$recoveryError;State=$state}
  }
 }
}
if($Case -eq 'snapshot'){
 $external=Join-Path $FixtureRoot 'external-forbidden';$null=New-Item -ItemType Directory -Path $external
 $nested=Join-Path $external 'evidence.txt';[IO.File]::WriteAllText($nested,'AAAA')
 $s=Get-SakieAclScope -DirectTargets @($file) -ForbiddenTargets @($external)
 Assert (@($s.Rows|Where-Object {$_.Path -eq $nested -and $_.Forbidden}).Count -eq 1) 'FORBIDDEN_DESCENDANT_OMITTED'
 $snap=Get-SakieAclSnapshot $s;$stamp=(Get-Item $nested).LastWriteTimeUtc
 [IO.File]::WriteAllText($nested,'BBBB');[IO.File]::SetLastWriteTimeUtc($nested,$stamp)
 Assert (-not (Test-SakieAclSnapshot $s $snap)) 'SAME_SIZE_MTIME_CONTENT_NOT_DETECTED'
 $stable=Get-SakieAclSnapshot $scope
 [IO.File]::WriteAllText((Join-Path $keep 'new.txt'),'NEW')
 Assert (-not (Test-SakieAclSnapshot $scope $stable)) 'INVENTORY_CHANGE_NOT_DETECTED'
 Write-Output 'LAB_OK snapshot';exit 0
}
if($Case -eq 'ace-output'){
 $r=Get-SakieAclScope -DirectTargets @($root) -ForbiddenTargets @($keep)
 $entry=@($r.Rows|Where-Object Path -eq $denied)[0]
 Assert (@($entry.Aces|Where-Object {$_.Type -eq 'Deny' -and -not $_.Inherited -and $_.Sid -eq 'S-1-3-4'}).Count -eq 1) 'EXPLICIT_DENY_MISSING'
 Assert (@($entry.Aces|Where-Object {$_.Type -eq 'Allow' -and $_.Inherited}).Count -gt 0) 'INHERITED_ALLOW_MISSING'
 Assert (-not $r.Executable) 'REPORT_EXECUTABLE'
 Write-Output 'LAB_OK ace-output';exit 0
}
if($Case -eq 'preflight'){
 $d=Get-Acl -LiteralPath $second;$d.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-4'),'ChangePermissions','Deny'));PutAcl $second $d
 $scope=Get-SakieAclScope -DirectTargets @($file,$second) -ForbiddenTargets @($keep);$initial=Get-SakieAclSnapshot $scope
 $p=Get-SakieAclWriteDacPreflight $scope;Assert ($p.Checked -eq 2) 'NOT_ALL_DIRECT_PROBED';Assert (-not $p.Passed) 'DENIED_PREFLIGHT_PASSED'
 $r=RunLab '';Assert ($r.State.Touched.Count -eq 0) 'PREFLIGHT_WROTE';Assert (Test-SakieAclSnapshot $scope $initial) 'PREFLIGHT_CHANGED_STATE'
 $rs=Get-SakieAclScope -DirectTargets @($root) -ForbiddenTargets @($keep);$rp=Get-SakieAclWriteDacPreflight $rs
 Assert (@($rp.Rows|Where-Object {$_.Path -eq $second -and $_.Class -eq 'potential-inherited' -and $_.Win32 -eq 5}).Count -eq 1) 'INDIRECT_NOT_PROBED'
 Assert (@($rp.Rows|Where-Object Path -eq $denied).Count -eq 0) 'FORBIDDEN_PROBED_AS_WRITABLE_TARGET'
 Write-Output 'LAB_OK preflight';exit 0
}
if($Case -eq 'hardlink'){
 $alias=Join-Path $FixtureRoot 'hard-alias';$null=New-Item -ItemType HardLink -Path $alias -Target $file
 $blocked=$false;try{Get-SakieAclScope -DirectTargets @($file) -ForbiddenTargets @($keep)|Out-Null}catch{$blocked=$_.Exception.Message -match 'LINK_FORBIDDEN'}
 Assert $blocked 'HARDLINK_ACCEPTED';Write-Output 'LAB_OK hardlink';exit 0
}
if($Case -eq 'symlink'){
 # Use unprivileged creation flag; no privilege request or elevation. If OS policy
 # disallows symlinks, report unavailable instead of counting it as a passing case.
 Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public static class LabLink { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] [return: MarshalAs(UnmanagedType.I1)] public static extern bool CreateSymbolicLinkW(string link,string target,uint flags); }
"@
 $alias=Join-Path $FixtureRoot 'symbolic-alias'
 if(-not [LabLink]::CreateSymbolicLinkW($alias,$file,2)){Write-Output ('LAB_UNAVAILABLE symlink Win32='+[Runtime.InteropServices.Marshal]::GetLastWin32Error());exit 0}
 $blocked=$false;try{Get-SakieAclScope -DirectTargets @($alias) -ForbiddenTargets @($keep)|Out-Null}catch{$blocked=$_.Exception.Message -match 'LINK_FORBIDDEN'}
 Assert $blocked 'SYMLINK_ACCEPTED';Write-Output 'LAB_OK symlink';exit 0
}
if($Case -eq 'before-change'){
 $d=Get-Acl -LiteralPath $second;$d.SetAccessRuleProtection($true,$true);PutAcl $second $d
 $r=RunLab '';Assert ($r.State.Touched.Count -eq 0) 'STALE_SNAPSHOT_WROTE';Assert ($r.Error -eq 'LAB_SNAPSHOT_CHANGED') 'STALE_ERROR'
 Write-Output 'LAB_OK before-change';exit 0
}
if($Case -eq 'audit-failure-before'){$script:auditFail=$true}
if($Case -eq 'recovery-failure'){$script:recoverFail=$true}
if($Case -eq 'recovery-partial'){$script:recoverPartial=$true}
$lock=$null
if($Case -eq 'audit-locked'){$lock=[IO.File]::Open($journal,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
try{$r=RunLab $Case}finally{if($lock){$lock.Dispose()}}
switch($Case){
 'success' {Assert ($r.Status -eq 'completed') 'SUCCESS_FAILED';Assert (@(ReadAudit|Where-Object Kind -eq 'completed').Count -eq 1) 'AUDIT_NO_COMPLETION'}
 'failure' {Assert ($r.Status -eq 'recovered-or-zero') 'RECOVERY_FAILED';Assert (Test-SakieAclSnapshot $scope $initial) 'RECOVERY_NOT_ORIGINAL';Assert (@(ReadAudit|Where-Object Kind -eq 'recovered').Count -eq 1) 'AUDIT_NO_RECOVERY'}
 'recovery-failure' {
  Assert ($r.Status -eq 'recovery-required') 'FAILURE_HIDDEN'
  # Explicit synthetic recovery from durable checkpoint, not from the returned state.
  $records=ReadAudit;$checkpoint=@($records|Where-Object Kind -eq 'recovery-required')[-1].Data.State
  $script:recoverFail=$false;RecoverLab $checkpoint
  Assert (Test-SakieAclSnapshot $scope $initial) 'CHECKPOINT_RECOVERY_FAILED'
 }
 'recovery-partial' {
  Assert ($r.Status -eq 'recovery-required') 'PARTIAL_FAILURE_HIDDEN'
  Assert ($script:recoverCount -eq 1) 'PARTIAL_NOT_EXERCISED'
  $records=ReadAudit;$checkpoint=@($records|Where-Object Kind -eq 'recovery-required')[-1].Data.State
  $script:recoverPartial=$false;RecoverLab $checkpoint
  Assert (Test-SakieAclSnapshot $scope $initial) 'PARTIAL_RECOVERY_FAILED'
 }
 'write-window-change' {Assert ($r.Status -eq 'recovery-required') 'WRITE_WINDOW_CHANGE_ACCEPTED';Assert ($r.State.Touched.Count -eq 1) 'WRITE_WINDOW_CONTINUED';Assert ([IO.File]::ReadAllText($second) -eq 'EXTERNAL_WRITE_WINDOW') 'WRITE_WINDOW_OVERWRITTEN'}
 'acl-change' {Assert ($r.Status -eq 'recovery-required') 'ACL_CHANGE_HIDDEN';Assert ((Get-Acl -LiteralPath $second).AreAccessRulesProtected) 'EXTERNAL_ACL_OVERWRITTEN'}
 'inventory-change' {Assert ($r.Status -eq 'recovery-required') 'INVENTORY_CHANGE_HIDDEN';Assert (Test-Path -LiteralPath (Join-Path $keep 'external-new.txt')) 'EXTERNAL_NEW_LOST'}
 'audit-locked' {Assert ($r.State.Touched.Count -eq 0) 'LOCKED_AUDIT_BUT_WROTE';Assert (Test-SakieAclSnapshot $scope $initial) 'LOCKED_AUDIT_CHANGED_STATE'}
 'truncated-audit' {
  $stream=[IO.File]::Open($journal,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.SetLength($stream.Length-8);$stream.Flush($true)}finally{$stream.Dispose()}
  $blocked=$false;try{ReadAudit|Out-Null}catch{$blocked=$true};Assert $blocked 'TRUNCATED_AUDIT_ACCEPTED'
 }
 'concurrent' {Assert ($r.Status -eq 'recovery-required') 'CONCURRENT_OVERWRITTEN';Assert ([IO.File]::ReadAllText($second) -eq 'EXTERNAL_SYNTHETIC_CHANGE') 'EXTERNAL_CONTENT_OVERWRITTEN'}
 'forbidden-change' {Assert ($r.Status -eq 'recovery-required') 'FORBIDDEN_CHANGE_HIDDEN';Assert ([IO.File]::ReadAllText($denied) -eq 'EXTERNAL_DENIED_CHANGE') 'FORBIDDEN_CONTENT_OVERWRITTEN'}
 'audit-failure-before' {Assert ($r.State.Touched.Count -eq 0) 'NO_AUDIT_BUT_WROTE';Assert (Test-SakieAclSnapshot $scope $initial) 'AUDIT_FAILURE_CHANGED_STATE'}
 'audit-failure-after' {Assert ($r.Status -eq 'recovery-required') 'AUDIT_FAILURE_HIDDEN';Assert ($r.State.Touched.Count -eq 1) 'WRITE_AFTER_AUDIT_FAILURE'}
 'tamper-audit' {
  $lines=[IO.File]::ReadAllLines($journal);$lines[0]=$lines[0].Replace('prepared','tampered');[IO.File]::WriteAllLines($journal,$lines)
  $blocked=$false;try{ReadAudit|Out-Null}catch{$blocked=$_.Exception.Message -match 'AUDIT_INVALID'};Assert $blocked 'TAMPERED_AUDIT_ACCEPTED'
 }
 default {throw 'LAB_UNKNOWN_CASE'}
}
Write-Output ('LAB_OK '+$Case+' status='+$r.Status)
