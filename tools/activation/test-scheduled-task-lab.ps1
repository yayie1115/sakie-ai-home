param([Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($FixtureRoot)
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$allowed=Join-Path $project '.phase1-work\'
if(-not $root.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root)){throw 'New isolated FixtureRoot required'}
New-Item -ItemType Directory -Path $root | Out-Null
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$admin=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if($admin){throw 'Lab must run with ordinary token'}
$node=(Get-Command node.exe).Source
$name='SakieHome-Lab-'+[guid]::NewGuid().ToString('N')
$runner=Join-Path $root 'runner.mjs'
$module=([uri](Join-Path $project 'tools\activation\supervision.mjs')).AbsoluteUri
$fixtureJson=ConvertTo-Json $root -Compress
$body=@"
import{writeFileSync,existsSync,readFileSync}from'node:fs';import{join}from'node:path';import{superviseProcess}from'$module';
const root=$fixtureJson;writeFileSync(join(root,'host-pid.json'),JSON.stringify(process.pid));
const childCode="import{writeFileSync,existsSync,readFileSync}from'node:fs';const root="+JSON.stringify(root)+";const file=root+'/counter.json';const n=existsSync(file)?Number(readFileSync(file)):0;writeFileSync(file,String(n+1));writeFileSync(root+'/child-pid.json',JSON.stringify(process.pid));if(n===0)process.exit(9);setInterval(()=>{},1000);";
await superviseProcess({command:process.execPath,args:['--input-type=module','-e',childCode],cwd:root,readState:()=>({retry:{phase:'offline'}}),status:state=>writeFileSync(join(root,'state.json'),JSON.stringify(state)),restartDelayMs:30});
"@
[IO.File]::WriteAllText($runner,$body,[Text.UTF8Encoding]::new($false))
# Generate the production principal/settings, then replace only the isolated Exec action.
$render=Join-Path $project 'tools\activation\render.mjs'
$renderUri=([uri]$render).AbsoluteUri
$js="import{render}from '$renderUri';console.log(render('https://activation.example.invalid',process.execPath,process.argv[1]).task)"
[xml]$xml=& $node --input-type=module -e $js $identity.User.Value
$ns=[Xml.XmlNamespaceManager]::new($xml.NameTable);$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
$exec=$xml.SelectSingleNode('//t:Exec',$ns)
$exec.Command=$node;$exec.Arguments='"'+$runner+'"';$exec.WorkingDirectory=$root
$xml.Save((Join-Path $root 'task.xml'))
$result=[ordered]@{ordinaryToken=(-not $admin);validateOnly=$false;registered=$false;logonTriggerConfigured=$false;actualLogonTransitionTested=$false;leastPrivilege=$false;crashRestart=$false;taskStopNoOrphans=$false;removed=$false;error=$null}
$service=New-Object -ComObject Schedule.Service;$service.Connect();$folder=$service.GetFolder('\')
$task=$null;$hostPidValue=$null;$childPidValue=$null
try {
 $null=$folder.RegisterTask($name,$xml.OuterXml,1,$identity.User.Value,$null,3)
 $result.validateOnly=$true
 $task=$folder.RegisterTask($name,$xml.OuterXml,2,$identity.User.Value,$null,3)
 $result.registered=$true
 $definition=$task.Definition
 $result.logonTriggerConfigured=($definition.Triggers.Item(1).Type -eq 9 -and $definition.Triggers.Item(1).Enabled)
 $result.leastPrivilege=($definition.Principal.RunLevel -eq 0 -and $definition.Principal.LogonType -eq 3)
 $null=$task.Run($null)
 $deadline=[DateTime]::UtcNow.AddSeconds(20)
 $counter=Join-Path $root 'counter.json'
 while([DateTime]::UtcNow -lt $deadline){if((Test-Path -LiteralPath $counter) -and [int]([IO.File]::ReadAllText($counter)) -ge 2){break};Start-Sleep -Milliseconds 100}
 if(-not(Test-Path -LiteralPath $counter)){throw 'Task action did not start'}
 $result.crashRestart=([int]([IO.File]::ReadAllText($counter)) -eq 2)
 $hostPidValue=[int]([IO.File]::ReadAllText((Join-Path $root 'host-pid.json')))
 $childPidValue=[int]([IO.File]::ReadAllText((Join-Path $root 'child-pid.json')))
 $task.Stop(0)
 $deadline=[DateTime]::UtcNow.AddSeconds(5)
 do{Start-Sleep -Milliseconds 100;$remaining=@(Get-Process -Id $hostPidValue,$childPidValue -ErrorAction SilentlyContinue)}while($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
 $result.taskStopNoOrphans=($remaining.Count -eq 0)
 if(-not $result.taskStopNoOrphans){throw 'Task stop left lab process; preserve evidence and stop this lab process only'}
} catch { $result.error=$_.Exception.GetType().Name+': '+$_.Exception.Message }
finally {
 if($null -ne $task){$task.Stop(0);$folder.DeleteTask($name,0);$result.removed=$true}
 foreach($labPid in @($hostPidValue,$childPidValue)) {if($labPid){$p=Get-CimInstance Win32_Process -Filter "ProcessId=$labPid" -ErrorAction SilentlyContinue;if($p -and $p.CommandLine.Contains($root)){Stop-Process -Id $labPid -ErrorAction SilentlyContinue}}}
 $result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding UTF8
 $result|ConvertTo-Json
}
if($result.error){exit 1}
