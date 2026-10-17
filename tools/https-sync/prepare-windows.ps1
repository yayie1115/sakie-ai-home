param([Parameter(Mandatory=$true)][string]$RunDirectory,[Parameter(Mandatory=$true)][string]$Template)
$ErrorActionPreference='Stop'
# This tool does not create directories or change ACLs. Approval of the new private scope is separate.
& powershell.exe -NoProfile -NonInteractive -File "$PSScriptRoot\check-private.ps1" -Path $RunDirectory
if($LASTEXITCODE -ne 0){throw 'Private scope required'}
if(@(Get-ChildItem -LiteralPath $RunDirectory -Force).Count -ne 0){throw 'Fresh empty private directory required'}
$templateObject=Get-Content -LiteralPath $Template -Raw | ConvertFrom-Json
if($templateObject.environment -ne 'production' -or $templateObject.origin -cne 'https://sync-check.sakiehome.icu' -or $templateObject.runId -notmatch '^[a-f0-9-]{36}$'){throw 'Unexpected acceptance template'}
$run=(Resolve-Path -LiteralPath $RunDirectory).Path
$project=(Resolve-Path -LiteralPath "$PSScriptRoot\..\..").Path
if($run -eq $project -or $run.StartsWith($project+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Run directory must be outside source'}
$utf8=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $run 'run.json'),($templateObject | ConvertTo-Json),$utf8)
$policy=@{version=1;environment='production';allowedOrigins=@($templateObject.origin)} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $run 'sync-policy.local.json'),$policy,$utf8)
Write-Output 'Private run files prepared. Next run the existing agent approve-production command interactively; no network requests made.'
Write-Output "node local-agent/dist/cli.js approve-production --cloud https://sync-check.sakiehome.icu --database `"$run\archive.db`" --credentials `"$run\agent-credentials-acceptance.json`" --policy `"$run\sync-policy.local.json`" --approval `"$run\sync-production-approval.json`""
