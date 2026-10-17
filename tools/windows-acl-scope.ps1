# Read-only experimental scope analysis. No Plan, Apply, Restore or ACL setters.
Set-StrictMode -Version Latest
function Get-SakieScopeItem([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':')) { throw 'SCOPE_LOCAL_ABSOLUTE_REQUIRED' }
  $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full.Length -le 3) { throw 'SCOPE_VOLUME_ROOT_FORBIDDEN' }
  $current=$full
  while ($current) {
    $i=Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($i.PSObject.Properties['LinkType'] -and $i.LinkType -eq 'HardLink')) { throw 'SCOPE_LINK_FORBIDDEN' }
    $parent=[IO.Directory]::GetParent($current)
    $current=if($parent){$parent.FullName}else{$null}
  }
  Get-Item -LiteralPath $full -Force
}
function Test-SakieWithin([string]$Path,[string]$Root) {
  return $Path.Equals($Root,[StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)
}
function Get-SakieAclScope {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string[]]$DirectTargets,[Parameter(Mandatory=$true)][string[]]$ForbiddenTargets)
  if ($DirectTargets.Count -eq 0 -or $ForbiddenTargets.Count -eq 0) { throw 'SCOPE_EXPLICIT_BOUNDARIES_REQUIRED' }
  $direct=@($DirectTargets | ForEach-Object {(Get-SakieScopeItem $_).FullName} | Sort-Object -Unique)
  $forbidden=@($ForbiddenTargets | ForEach-Object {(Get-SakieScopeItem $_).FullName} | Sort-Object -Unique)
  $inventory=[Collections.Generic.SortedDictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($root in @($direct+$forbidden | Sort-Object -Unique)) {
    $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($root)
    while($stack.Count){$i=Get-SakieScopeItem $stack.Pop();if($inventory.ContainsKey($i.FullName)){continue};$inventory.Add($i.FullName,$i)
      if($i.PSIsContainer){foreach($child in @(Get-ChildItem -LiteralPath $i.FullName -Force -ErrorAction Stop)){$stack.Push($child.FullName)}}
    }
  }
  # Observe forbidden branches too; do not silently omit assets outside the change tree.
  foreach($root in $forbidden){if(-not $inventory.ContainsKey($root)){$inventory.Add($root,(Get-SakieScopeItem $root))}}
  $rows=@(foreach($i in $inventory.Values){
    $a=Get-Acl -LiteralPath $i.FullName -ErrorAction Stop
    $isDirect=$direct -contains $i.FullName
    $mayInherit=$false
    foreach($root in $direct){
      if($i.FullName -ieq $root -or -not (Test-SakieWithin $i.FullName $root)){continue}
      $cursor=$i.FullName;$blocked=$false
      while($cursor -ine $root){if((Get-Acl -LiteralPath $cursor -ErrorAction Stop).AreAccessRulesProtected){$blocked=$true;break};$cursor=[IO.Directory]::GetParent($cursor).FullName}
      if(-not $blocked){$mayInherit=$true}
    }
    $isForbidden=@($forbidden|Where-Object {Test-SakieWithin $i.FullName $_}).Count -gt 0
    $class=if($isDirect){'direct'}elseif($mayInherit){'potential-inherited'}else{'outside-propagation'}
    [pscustomobject]@{Path=$i.FullName;Class=$class;Forbidden=$isForbidden;Protected=$a.AreAccessRulesProtected;OwnerSid=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;AccessSddl=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);Aces=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {[pscustomobject]@{Sid=$_.IdentityReference.Value;Type=$_.AccessControlType.ToString();Rights=[int64]$_.FileSystemRights;Inherited=$_.IsInherited;Inheritance=$_.InheritanceFlags.ToString();Propagation=$_.PropagationFlags.ToString()}})}
  })
  $conflicts=@($rows|Where-Object {$_.Forbidden -and $_.Class -ne 'outside-propagation'})
  [pscustomobject]@{Version=1;ReadOnly=$true;Executable=$false;DirectTargets=$direct;ForbiddenTargets=$forbidden;Rows=$rows;Conflicts=@($conflicts | ForEach-Object {$_.Path});CanProceedToDesignReview=($conflicts.Count -eq 0);Prediction='conservative-existing-descendants-not-an-exact-ACL-simulator'}
}

# Snapshot includes forbidden descendants even when they are outside the direct tree.
function Get-SakieAclSnapshot($Scope) {
  $fresh=Get-SakieAclScope -DirectTargets $Scope.DirectTargets -ForbiddenTargets $Scope.ForbiddenTargets
  $entries=@(foreach($row in $fresh.Rows){
    $i=Get-SakieScopeItem $row.Path
    [pscustomobject]@{Path=$row.Path;Class=$row.Class;Forbidden=$row.Forbidden;Directory=[bool]$i.PSIsContainer;OwnerSid=$row.OwnerSid;AccessSddl=$row.AccessSddl;CreatedTicks=$i.CreationTimeUtc.Ticks.ToString();Length=$(if($i.PSIsContainer){0}else{$i.Length});WriteTicks=$(if($i.PSIsContainer){'0'}else{$i.LastWriteTimeUtc.Ticks.ToString()});ContentHash=$(if($i.PSIsContainer){$null}else{(Get-FileHash -LiteralPath $i.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()})}
  })
  $body=[pscustomobject]@{Version=1;DirectTargets=$fresh.DirectTargets;ForbiddenTargets=$fresh.ForbiddenTargets;Entries=$entries}
  $json=$body | ConvertTo-Json -Depth 20 -Compress
  $h=[Security.Cryptography.SHA256]::Create()
  try{$hash=([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
  [pscustomobject]@{Hash=$hash;Body=$body;ReadOnly=$true;Executable=$false}
}
function Test-SakieAclSnapshot($Scope,$Expected) {
  (Get-SakieAclSnapshot $Scope).Hash -ceq $Expected.Hash
}
function Get-SakieAclWriteDacPreflight($Scope) {
  if(-not ('SakieScope.Probe' -as [type])){
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace SakieScope { public static class Probe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string n,uint a,uint s,IntPtr p,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static int Check(string name) {IntPtr h=CreateFileW(name,0x40000u,7,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);if(h==new IntPtr(-1))return Marshal.GetLastWin32Error();CloseHandle(h);return 0;}
} }
"@
  }
  # Refresh to prevent a stale report hiding a new conflict or descendant.
  $fresh=Get-SakieAclScope -DirectTargets $Scope.DirectTargets -ForbiddenTargets $Scope.ForbiddenTargets
  $rows=@(foreach($row in $fresh.Rows | Where-Object {$_.Class -ne 'outside-propagation'}){
    $null=Get-SakieScopeItem $row.Path
    [pscustomobject]@{Path=$row.Path;Class=$row.Class;Win32=[SakieScope.Probe]::Check($row.Path)}
  })
  [pscustomobject]@{ReadOnly=$true;Executable=$false;Checked=$rows.Count;Rows=$rows;Conflicts=$fresh.Conflicts;Passed=($fresh.CanProceedToDesignReview -and @($rows | Where-Object Win32 -ne 0).Count -eq 0)}
}
