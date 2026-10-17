[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
  [ValidateSet('Check','Plan','Apply','Verify','Restore')][string]$Mode='Check',
  [string[]]$Targets,
  [string]$PlanPath,
  [string]$ExpectedPlanHash,
  [string]$UserSid
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$accessSection=[System.Security.AccessControl.AccessControlSections]::Access
if (-not $UserSid) { $UserSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
$null=[System.Security.Principal.SecurityIdentifier]::new($UserSid)
if ($UserSid -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'ACL_CURRENT_USER_REQUIRED' }
$trusted=@($UserSid,'S-1-5-18','S-1-5-32-544')
$fileRights=[System.Security.AccessControl.FileSystemRights]::Read -bor [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::Synchronize
$directoryRights=[System.Security.AccessControl.FileSystemRights]::Modify -bor [System.Security.AccessControl.FileSystemRights]::Synchronize
function Canonical([string]$Value) {
  if (-not $Value -or $Value.Length -lt 3 -or $Value.Substring(0,1) -notmatch '^[A-Za-z]$' -or $Value.Substring(1,1) -ne ':' -or ([int][char]$Value[2]) -notin @(47,92)) { throw 'ACL_ABSOLUTE_LOCAL_PATH_REQUIRED' }
  $full=[System.IO.Path]::GetFullPath($Value).TrimEnd('\')
  if ($full.Length -le 3 -or $full.Substring(2).Contains(':')) { throw 'ACL_ROOT_OR_STREAM_FORBIDDEN' }
  return $full
}
function SafeItem([string]$Value) {
  $full=Canonical $Value
  $current=$full
  while ($current) {
    $item=Get-Item -LiteralPath $current -Force
    if ($item.PSObject.Properties['LinkType'] -and $item.LinkType -eq 'HardLink') { throw 'ACL_HARDLINK_FORBIDDEN' }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ACL_REPARSE_POINT_FORBIDDEN' }
    $parent=[System.IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $current=$parent.FullName
  }
  return Get-Item -LiteralPath $full -Force
}
function Excluded([string]$Value) {
  if (-not $PlanPath) { return $false }
  return @($PlanPath,($PlanPath+'.apply.json'),($PlanPath+'.restore.json')) -contains $Value
}
function Inventory([string[]]$Roots) {
  $items=[System.Collections.Generic.SortedDictionary[string,object]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $stack=[System.Collections.Generic.Stack[string]]::new()
  foreach ($root in $Roots) { $stack.Push((Canonical $root)) }
  while ($stack.Count -gt 0) {
    $name=$stack.Pop()
    if (Excluded $name) { continue }
    $item=SafeItem $name
    if ($items.ContainsKey($item.FullName)) { continue }
    $items.Add($item.FullName,$item)
    if ($item.PSIsContainer) { foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) { $stack.Push($child.FullName) } }
  }
  return @($items.Values)
}
function Describe($Item) {
  $acl=Get-Acl -LiteralPath $Item.FullName
  $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [pscustomobject]@{Sid=$_.IdentityReference.Value;Rights=[int64]$_.FileSystemRights;Type=$_.AccessControlType.ToString();InheritOnly=(($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)}
  })
  $private=$trusted -contains $owner
  $effective=@{}
  foreach ($rule in $rules) {
    if ($rule.Type -ne 'Allow' -or $trusted -notcontains $rule.Sid) { $private=$false }
    if ($rule.Sid -eq $UserSid) {
      $allowed=if($Item.PSIsContainer){[int64]$directoryRights}else{[int64]$fileRights}
      if (($rule.Rights -band (-bnot $allowed)) -ne 0) { $private=$false }
    }
    if (-not $rule.InheritOnly) {
      if (-not $effective.ContainsKey($rule.Sid)) { $effective[$rule.Sid]=[int64]0 }
      $effective[$rule.Sid]=$effective[$rule.Sid] -bor $rule.Rights
    }
  }
  foreach ($sid in $trusted) {
    $required=if($sid -eq $UserSid){if($Item.PSIsContainer){[int64]$directoryRights}else{[int64]$fileRights}}else{[int64][System.Security.AccessControl.FileSystemRights]::FullControl}
    if (-not $effective.ContainsKey($sid) -or ($effective[$sid] -band $required) -ne $required) { $private=$false }
  }
  return [pscustomobject]@{Path=$Item.FullName;Directory=[bool]$Item.PSIsContainer;Length=$(if($Item.PSIsContainer){0}else{$Item.Length});WriteTicks=$(if($Item.PSIsContainer){'0'}else{$Item.LastWriteTimeUtc.Ticks.ToString()});OwnerSid=$owner;AccessSddl=$acl.GetSecurityDescriptorSddlForm($accessSection);Protected=$acl.AreAccessRulesProtected;Private=$private;Rules=$rules}
}
# Only Allow-only ACLs are order-independent. Mixed Allow/Deny ordering can change access.
function EquivalentDacl([string]$Left,[string]$Right) {
  $a=[System.Security.AccessControl.RawSecurityDescriptor]::new($Left)
  $b=[System.Security.AccessControl.RawSecurityDescriptor]::new($Right)
  if ($a.ControlFlags -ne $b.ControlFlags -or $null -eq $a.DiscretionaryAcl -or $null -eq $b.DiscretionaryAcl) { return $Left -ceq $Right }
  if ($a.DiscretionaryAcl.Revision -ne $b.DiscretionaryAcl.Revision) { return $false }
  $allowOnly=$true
  $keys=@(foreach ($d in @($a,$b)) {
    $parts=@(foreach ($ace in $d.DiscretionaryAcl) {
      if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessAllowed) { $allowOnly=$false }
      $bytes=New-Object byte[] $ace.BinaryLength
      $ace.GetBinaryForm($bytes,0)
      [Convert]::ToBase64String($bytes)
    })
    ,$parts
  })
  if ($allowOnly) { return (($keys[0] | Sort-Object) -join '|') -ceq (($keys[1] | Sort-Object) -join '|') }
  return ($keys[0] -join '|') -ceq ($keys[1] -join '|')
}
function HashFile([string]$Name) { return (Get-FileHash -LiteralPath $Name -Algorithm SHA256).Hash.ToLowerInvariant() }
# Set only DACL information. Never request ownership or SACL/SeSecurityPrivilege.
if (-not ('SakieAcl.NativeDacl' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
namespace SakieAcl {
 public static class NativeDacl {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool CloseHandle(IntPtr handle);
  // Real kernel access check against the current token, not an inference from group names.
  // OPEN_EXISTING + WRITE_DAC requests no content access and performs no write.
  public static int ProbeWriteDac(string name) {
   IntPtr h=CreateFileW(name,0x00040000u,7u,IntPtr.Zero,3u,0x02200000u,IntPtr.Zero);
   if(h==new IntPtr(-1))return Marshal.GetLastWin32Error();
   CloseHandle(h);return 0;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern uint SetNamedSecurityInfoW(string name, int type, uint flags, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  public static void Set(string name, byte[] bytes, bool protect) {
   IntPtr ptr=Marshal.AllocHGlobal(bytes.Length);
   try { Marshal.Copy(bytes,0,ptr,bytes.Length); uint error=SetNamedSecurityInfoW(name,1,4u|(protect?0x80000000u:0x20000000u),IntPtr.Zero,IntPtr.Zero,ptr,IntPtr.Zero); if(error!=0)throw new Win32Exception((int)error); }
   finally { Marshal.FreeHGlobal(ptr); }
  }
 }
}
"@
}
function PersistDacl([string]$Name,$Raw,[bool]$Protected) {
  if ($null -eq $Raw.DiscretionaryAcl -or $Raw.DiscretionaryAcl.Count -eq 0) { throw 'ACL_EMPTY_DACL_FORBIDDEN' }
  $bytes=New-Object byte[] $Raw.DiscretionaryAcl.BinaryLength
  $Raw.DiscretionaryAcl.GetBinaryForm($bytes,0)
  [SakieAcl.NativeDacl]::Set($Name,$bytes,$Protected)
}
function PrivateAcl([string]$Name) {
  $item=SafeItem $Name
  $acl=Get-Acl -LiteralPath $Name
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($rule in @($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))) { $null=$acl.RemoveAccessRuleSpecific($rule) }
  $allow=[System.Security.AccessControl.AccessControlType]::Allow
  $none=[System.Security.AccessControl.InheritanceFlags]::None
  $prop=[System.Security.AccessControl.PropagationFlags]::None
  foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
    $inherit=if($item.PSIsContainer){[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit}else{$none}
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),'FullControl',$inherit,$prop,$allow))
  }
  $user=[System.Security.Principal.SecurityIdentifier]::new($UserSid)
  if ($item.PSIsContainer) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user,$directoryRights,[System.Security.AccessControl.InheritanceFlags]::ContainerInherit,$prop,$allow))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user,$fileRights,[System.Security.AccessControl.InheritanceFlags]::ObjectInherit,[System.Security.AccessControl.PropagationFlags]::InheritOnly,$allow))
  } else { $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user,$fileRights,$none,$prop,$allow)) }
  $raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
  PersistDacl $Name $raw $true
}
function RestoreEntry($Entry) {
  $null=SafeItem $Entry.Path
  $raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($Entry.AccessSddl)
  $protected=($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0
  PersistDacl $Entry.Path $raw $protected
}
function SaveJson([string]$Name,$Value) {
  if (Test-Path -LiteralPath $Name) { throw 'ACL_REPORT_FILE_EXISTS' }
  $null=SafeItem ([System.IO.Path]::GetDirectoryName($Name))
  $bytes=[System.Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20))
  $stream=[System.IO.FileStream]::new($Name,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
  PrivateAcl $Name
}
try {
  if ($PlanPath) { $PlanPath=Canonical $PlanPath }
  if ($Mode -in @('Apply','Restore')) {
    if (-not $PlanPath -or -not $ExpectedPlanHash) { throw 'ACL_REVIEWED_PLAN_HASH_REQUIRED' }
    $null=SafeItem $PlanPath
    $planBytes=[System.IO.File]::ReadAllBytes($PlanPath)
    $hasher=[System.Security.Cryptography.SHA256]::Create()
    try { $actualHash=([System.BitConverter]::ToString($hasher.ComputeHash($planBytes))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
    if ($actualHash -ne $ExpectedPlanHash.ToLowerInvariant()) { throw 'ACL_REVIEWED_PLAN_HASH_REQUIRED' }
    $plan=[System.Text.Encoding]::UTF8.GetString($planBytes) | ConvertFrom-Json
    if ($plan.Version -ne 1 -or $plan.UserSid -ne $UserSid -or $plan.Policy -ne 'private-rwd-v1') { throw 'ACL_PLAN_POLICY_MISMATCH' }
    $Targets=@($plan.Targets)
    $current=@(Inventory $Targets)
    $entries=@($plan.Entries)
    if (($current.FullName -join [char]10) -ne ($entries.Path -join [char]10)) { throw 'ACL_INVENTORY_CHANGED' }
    foreach ($entry in $entries) {
      $now=Describe (SafeItem $entry.Path)
      if ($now.Directory -ne $entry.Directory -or $now.OwnerSid -ne $entry.OwnerSid) { throw 'ACL_OBJECT_CHANGED' }
      $saved=[System.Security.AccessControl.RawSecurityDescriptor]::new($entry.AccessSddl)
      if ($null -eq $saved.DiscretionaryAcl -or $saved.DiscretionaryAcl.Count -eq 0) { throw 'ACL_EMPTY_DACL_FORBIDDEN' }
      foreach ($ace in $saved.DiscretionaryAcl) { if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback) { throw 'ACL_UNSUPPORTED_RESTORE_ACE' } }
      if ($trusted -notcontains $now.OwnerSid) { throw 'ACL_UNTRUSTED_OWNER' }
      if (-not $now.Directory -and ($now.Length -ne $entry.Length -or $now.WriteTicks -ne $entry.WriteTicks)) { throw 'ACL_CONTENT_CHANGED_STOP_WRITERS' }
      if ($Mode -eq 'Apply' -and -not (EquivalentDacl $now.AccessSddl $entry.AccessSddl)) { throw 'ACL_DACL_CHANGED_SINCE_PLAN' }
      if ($Mode -eq 'Restore' -and -not $now.Private) { throw 'ACL_RESTORE_CURRENT_POLICY_CHANGED' }
    }
    # Inspect EVERY target before ShouldProcess or any DACL/journal mutation.
    $denied=@(foreach ($entry in $entries) {
      $null=SafeItem $entry.Path
      $errorCode=[SakieAcl.NativeDacl]::ProbeWriteDac($entry.Path)
      if ($errorCode -ne 0) { $entry.Path+' (Win32='+$errorCode+')' }
    })
    if ($denied.Count -gt 0) { throw ('ACL_WRITE_DAC_PREFLIGHT_FAILED_ZERO_CHANGES: '+($denied -join '; ')) }
    if (-not $PSCmdlet.ShouldProcess(($Targets -join ', '),($Mode+' reviewed private ACL plan for '+$entries.Count+' objects'))) {
      [pscustomobject]@{Mode=$Mode;Executed=$false;Objects=$entries.Count} | ConvertTo-Json -Compress
      exit 0
    }
    $journal=$PlanPath+$(if($Mode -eq 'Apply'){'.apply.json'}else{'.restore.json'})
    if (Test-Path -LiteralPath $journal) { throw 'ACL_EXECUTION_JOURNAL_EXISTS' }
    $touched=[System.Collections.Generic.List[object]]::new()
    try {
      foreach ($entry in ($entries | Sort-Object @{Expression={$_.Path.Length};Descending=$true})) {
        $touched.Add((Describe (SafeItem $entry.Path)))
        if ($Mode -eq 'Apply') { PrivateAcl $entry.Path } else { RestoreEntry $entry }
      }
      $verified=@(Inventory $Targets | ForEach-Object { Describe $_ })
      if ($Mode -eq 'Apply' -and @($verified | Where-Object { -not $_.Private }).Count -gt 0) { throw 'ACL_POST_VERIFY_FAILED' }
      if ($Mode -eq 'Restore') {
        foreach ($entry in $entries) { if (-not (EquivalentDacl (Describe (SafeItem $entry.Path)).AccessSddl $entry.AccessSddl)) { throw 'ACL_RESTORE_VERIFY_FAILED' } }
      }
      SaveJson $journal ([pscustomobject]@{Mode=$Mode;PlanHash=$ExpectedPlanHash;CompletedAt=(Get-Date).ToUniversalTime().ToString('o');Paths=@($touched.Path);Verified=$true})
      [pscustomobject]@{Mode=$Mode;Executed=$true;Verified=$true;Objects=$verified.Count;Journal=$journal} | ConvertTo-Json -Compress
    } catch {
      $failure=$_.Exception.Message
      $rollbackErrors=[System.Collections.Generic.List[string]]::new()
      foreach ($entry in @($touched | Sort-Object @{Expression={$_.Path.Length};Descending=$true})) { try { RestoreEntry $entry } catch { $rollbackErrors.Add(($entry.Path+' ('+$_.Exception.Message+')')) } }
      if ($rollbackErrors.Count) { throw ('ACL_ROLLBACK_INCOMPLETE: initial='+$failure+'; '+($rollbackErrors -join ', ')) }
      throw ('ACL_EXECUTION_FAILED_ROLLED_BACK: '+$failure)
    }
  } else {
    if (-not $Targets -or $Targets.Count -eq 0) { throw 'ACL_EXPLICIT_TARGETS_REQUIRED' }
    $Targets=@($Targets | ForEach-Object { Canonical $_ } | Sort-Object -Unique)
    $entries=@(Inventory $Targets | ForEach-Object { Describe $_ })
    if ($Mode -eq 'Plan') {
      if (-not $PlanPath) { throw 'ACL_PLAN_PATH_REQUIRED' }
      $plan=[pscustomobject]@{Version=1;Policy='private-rwd-v1';UserSid=$UserSid;CreatedAt=(Get-Date).ToUniversalTime().ToString('o');Targets=$Targets;Entries=$entries}
      SaveJson $PlanPath $plan
      [pscustomobject]@{Mode=$Mode;Objects=$entries.Count;PlanPath=$PlanPath;PlanHash=(HashFile $PlanPath);UntrustedOwners=@($entries | Where-Object { $trusted -notcontains $_.OwnerSid }).Count;Executed=$false} | ConvertTo-Json -Compress
    } else {
      $unsafe=@($entries | Where-Object { -not $_.Private })
      [pscustomobject]@{Mode=$Mode;Passed=($unsafe.Count -eq 0);Objects=$entries.Count;Unsafe=@($unsafe | Select-Object Path,OwnerSid,Protected,Rules);Executed=$false} | ConvertTo-Json -Depth 12 -Compress
      if ($Mode -eq 'Verify' -and $unsafe.Count -gt 0) { exit 2 }
    }
  }
} catch { Write-Error $_.Exception.Message; exit 1 }
