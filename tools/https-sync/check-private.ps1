param([Parameter(Mandatory=$true)][string]$Path,[ValidateSet('Modify','ReadOnly')][string]$AccessMode='Modify')
$ErrorActionPreference='Stop'
try {
  $item=Get-Item -LiteralPath $Path -Force
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Not a plain directory'}
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed=@($sid,'S-1-5-18','S-1-5-32-544')
  $members=@($sid,'S-1-1-0','S-1-5-11')+@([Security.Principal.WindowsIdentity]::GetCurrent().Groups | ForEach-Object {$_.Value})
  $rootAcl=Get-Acl -LiteralPath $Path
  if(-not $rootAcl.AreAccessRulesProtected){throw 'Private scope must block broad parent inheritance'}
  $modify=if($AccessMode -eq 'ReadOnly'){[Security.AccessControl.FileSystemRights]::ReadAndExecute}else{[Security.AccessControl.FileSystemRights]::Modify}
  $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $future=@($rootAcl.Access | Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $modify) -eq $modify -and ($_.InheritanceFlags -band $inherit) -eq $inherit -and $_.PropagationFlags -eq 'None'})
  if(-not $future.Count){throw 'Future files lack private inheritable runtime Modify grant'}
  $objects=@($item)+@(Get-ChildItem -LiteralPath $Path -Force)
  foreach($object in $objects){
    if($object.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse point'}
    $acl=Get-Acl -LiteralPath $object.FullName
    $owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
    if($owner -notin $allowed){throw 'Untrusted owner'}
    if($AccessMode -eq 'ReadOnly' -and $owner -eq $sid){throw 'Read-only identity requires maintenance ownership'}
    foreach($ace in $acl.Access){
      $principal=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if($ace.AccessControlType -eq 'Deny' -and $principal -in $members -and ($ace.FileSystemRights -band $modify)){throw 'Runtime permission denied'}
      if($AccessMode -eq 'ReadOnly' -and $ace.AccessControlType -eq 'Allow' -and $principal -eq $sid -and ($ace.FileSystemRights -band [Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership')){throw 'Runtime write grant in read-only identity scope'}
      if($ace.AccessControlType -eq 'Allow' -and $principal -notin $allowed){throw 'Broad allow'}
    }
  }
  Write-Output 'PRIVATE_SCOPE_PASS'
} catch {Write-Error 'Private isolated run directory check failed; no permissions changed.';exit 1}
