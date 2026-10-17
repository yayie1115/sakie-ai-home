param([Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$root=[IO.Path]::GetFullPath($FixtureRoot)
$prefix=Join-Path $project '.phase1-work\encrypted-backup-lab-'
if(-not $root.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint -or -not(Test-Path -LiteralPath (Join-Path $root '.synthetic-owned'))){throw 'New synthetic fixture only'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation=[Security.AccessControl.PropagationFlags]::None
foreach($entry in @(@($sid,'Modify'),@([Security.Principal.SecurityIdentifier]'S-1-5-18','FullControl'),@([Security.Principal.SecurityIdentifier]'S-1-5-32-544','FullControl'))){$rule=[Security.AccessControl.FileSystemAccessRule]::new($entry[0],[Security.AccessControl.FileSystemRights]$entry[1],$inherit,$propagation,[Security.AccessControl.AccessControlType]::Allow);$null=$acl.AddAccessRule($rule)}
Set-Acl -LiteralPath $root -AclObject $acl
foreach($name in @('cli-work','cli-output','cli-restores')){$path=Join-Path $root $name;if(Test-Path -LiteralPath $path){throw 'New scope only'};New-Item -ItemType Directory -Path $path | Out-Null;Set-Acl -LiteralPath $path -AclObject $acl}
