param([Parameter(Mandatory=$true)][string]$FixtureRoot,[ValidateSet('blocked','protected','flags','links','exact')][string]$Case)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
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
function PutAcl($path,$acl){Assert ($path.StartsWith($FixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)) 'LAB_OUT_OF_SCOPE';$raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);$bytes=New-Object byte[] $raw.DiscretionaryAcl.BinaryLength;$raw.DiscretionaryAcl.GetBinaryForm($bytes,0);[SakieAcl.NativeDacl]::Set($path,$bytes,$acl.AreAccessRulesProtected)}
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
if($Case -eq 'exact'){
 $beforeRoot=Sddl $root;$beforeKeep=Sddl $keep;$beforeDenied=Sddl $denied
 $r=Get-SakieAclScope -DirectTargets @($file) -ForbiddenTargets @($keep)
 Assert $r.CanProceedToDesignReview 'EXACT_FILE_BLOCKED'
 Assert (@($r.Rows|Where-Object Class -eq 'potential-inherited').Count -eq 0) 'FILE_PREDICTS_CHILDREN'
 $f=[Security.AccessControl.FileSecurity]::new();$f.SetAccessRuleProtection($true,$false)
 $f.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read,Write,Delete,Synchronize','Allow'))
 PutAcl $file $f
 Assert ((Sddl $root) -ceq $beforeRoot) 'EXACT_CHANGED_ROOT'
 Assert ((Sddl $keep) -ceq $beforeKeep) 'EXACT_CHANGED_SIBLING'
 Assert ((Sddl $denied) -ceq $beforeDenied) 'EXACT_CHANGED_DENIED'
 Assert ([IO.File]::ReadAllText($file) -eq 'SYNTHETIC_ONLY') 'EXACT_CHANGED_CONTENT'
 Write-Output 'LAB_OK exact';exit 0
}
if($Case -eq 'links'){
 $alias=Join-Path $FixtureRoot 'alias';$null=New-Item -ItemType Junction -Path $alias -Target $root
 $rejected=$false;try{Get-SakieAclScope -DirectTargets @($alias) -ForbiddenTargets @($denied)|Out-Null}catch{Assert ($_.Exception.Message -match 'LINK_FORBIDDEN') 'WRONG_LINK_ERROR';$rejected=$true}
 Assert $rejected 'LINK_ACCEPTED'
 # Keep all new fixtures and links; no removal of evidence.
 Write-Output 'LAB_OK links';exit 0
}
if($Case -eq 'blocked'){
 $before=Sddl $denied;$report=Get-SakieAclScope -DirectTargets @($root) -ForbiddenTargets @($denied)
 Assert (-not $report.CanProceedToDesignReview) 'MUST_BLOCK'
 Assert ($report.Conflicts -contains $denied) 'MISSING_FORBIDDEN_CONFLICT'
 Assert ((Sddl $denied) -ceq $before) 'READ_ONLY_CHANGED_ACL'
 $direct=Get-SakieAclScope -DirectTargets @($denied) -ForbiddenTargets @($keep)
 Assert (-not $direct.CanProceedToDesignReview) 'DIRECT_FORBIDDEN_ACCEPTED'
 Write-Output 'LAB_OK blocked';exit 0
}
# Protect a new synthetic boundary before any parent change; not an operation on old fixtures.
$k=Get-Acl -LiteralPath $keep;$k.SetAccessRuleProtection($true,$true);PutAcl $keep $k
$before=@{};$owners=@{};foreach($i in @(Get-Item $root)+@(Get-ChildItem $root -Recurse -Force)){$before[$i.FullName]=Sddl $i.FullName;$owners[$i.FullName]=(Get-Acl -LiteralPath $i.FullName).Owner}
$report=Get-SakieAclScope -DirectTargets @($root) -ForbiddenTargets @($keep)
Assert $report.CanProceedToDesignReview 'PROTECTED_BRANCH_BLOCKED'
Assert (@($report.Rows|Where-Object {$_.Path -eq $file -and $_.Class -eq 'potential-inherited'}).Count -eq 1) 'DESCENDANT_NOT_PREDICTED'
Assert (@($report.Rows|Where-Object {$_.Path -eq $denied -and $_.Forbidden -and $_.Class -eq 'outside-propagation'}).Count -eq 1) 'BOUNDARY_NOT_PREDICTED'
# Real Windows propagation only on the fresh lab root, never a production executor.
$new=[Security.AccessControl.DirectorySecurity]::new();$new.SetAccessRuleProtection($true,$false)
if($Case -eq 'protected'){
 $new.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit','None','Allow'))
 $rights=[Security.AccessControl.FileSystemRights]'Read,Write,Delete,Synchronize'
 $new.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,'ObjectInherit','InheritOnly','Allow'))
 foreach($id in @('S-1-5-18','S-1-5-32-544')){$new.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl',$inherit,'None','Allow'))}
}else{
 $new.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow'))
 $new.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Delete',$inherit,'NoPropagateInherit','Deny'))
 $new.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Read','ObjectInherit','InheritOnly','Allow'))
}
PutAcl $root $new
$changed=@();foreach($path in $before.Keys){if((Sddl $path) -cne $before[$path]){$changed+=$path};Assert ((Get-Acl -LiteralPath $path).Owner -eq $owners[$path]) 'OWNER_CHANGED'}
foreach($path in $changed){Assert (@($report.Rows|Where-Object {$_.Path -eq $path -and $_.Class -in @('direct','potential-inherited')}).Count -eq 1) 'UNPREDICTED_CHANGE'}
Assert ((Sddl $keep) -ceq $before[$keep]) 'FORBIDDEN_BOUNDARY_CHANGED'
Assert ((Sddl $denied) -ceq $before[$denied]) 'FORBIDDEN_DENY_CHANGED'
Assert ([IO.File]::ReadAllText($file) -eq 'SYNTHETIC_ONLY') 'CONTENT_CHANGED'
$futureDir=Join-Path $root 'future';$null=New-Item -ItemType Directory -Path $futureDir
$future=Join-Path $futureDir 'future.db-wal';[IO.File]::WriteAllText($future,'SYNTHETIC_WAL')
$rules=@((Get-Acl -LiteralPath $future).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if($Case -eq 'protected'){
 Assert (@($rules|Where-Object {$_.IdentityReference.Value -in @('S-1-5-32-545','S-1-5-11')}).Count -eq 0) 'FUTURE_WIDE_READ'
 Assert (@($rules|Where-Object {$_.IdentityReference.Value -eq $sid.Value -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ExecuteFile) -ne 0}).Count -eq 0) 'FUTURE_FILE_EXECUTE'
 Assert (@($rules|Where-Object {$_.IdentityReference.Value -eq $sid.Value -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::WriteData) -ne 0}).Count -gt 0) 'FUTURE_NO_WRITE'
}else{
 Assert (@($rules|Where-Object {$_.AccessControlType -eq 'Deny'}).Count -eq 0) 'NO_PROPAGATE_REACHED_GRANDCHILD'
 $childRules=@((Get-Acl -LiteralPath $ordinary).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 Assert (@($childRules|Where-Object {$_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Value -eq 'S-1-1-0'}).Count -gt 0) 'DENY_NOT_INHERITED_BY_CHILD'
 Assert (@($rules|Where-Object {$_.IdentityReference.Value -eq 'S-1-5-32-545' -and $_.AccessControlType -eq 'Allow'}).Count -gt 0) 'OI_ALLOW_NOT_INHERITED'
}
Write-Output ('LAB_OK '+$Case+' predicted='+@($report.Rows|Where-Object Class -eq 'potential-inherited').Count+' changed='+$changed.Count)
