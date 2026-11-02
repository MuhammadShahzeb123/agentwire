# AgentWire Windows installer: irm https://raw.githubusercontent.com/MuhammadShahzeb123/agentwire/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Dir = if ($env:AGENTWIRE_HOME) { $env:AGENTWIRE_HOME } else { Join-Path $HOME '.agentwire' }
$Port = if ($env:PORT) { $env:PORT } else { '7777' }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$TokFile = Join-Path $Dir 'token'
if (Test-Path $TokFile) { $Token = (Get-Content $TokFile).Trim() } else { $Token = -join ((1..48) | % { '{0:x}' -f (Get-Random -Max 16) }); Set-Content $TokFile $Token }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { winget install -e --id OpenJS.NodeJS --accept-source-agreements --accept-package-agreements; $env:Path += ";$env:ProgramFiles\nodejs" }
$App = Join-Path $Dir 'app'
if (Test-Path $App) { Remove-Item -Recurse -Force $App }
$Zip = Join-Path $env:TEMP 'agentwire.zip'
Invoke-WebRequest 'https://github.com/MuhammadShahzeb123/agentwire/archive/refs/heads/main.zip' -OutFile $Zip
Expand-Archive $Zip $Dir -Force; Rename-Item (Join-Path $Dir 'agentwire-main') $App
$Node = (Get-Command node).Source
$Cmd = "`$env:PORT='$Port'; `$env:AGENTWIRE_TOKEN='$Token'; `$env:AGENTWIRE_DB='$Dir\agentwire.db'; & '$Node' '$App\src\cli.js' serve"
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-WindowStyle Hidden -NoProfile -Command $Cmd"
Register-ScheduledTask -TaskName 'AgentWire' -Action $Action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force | Out-Null
Start-ScheduledTask -TaskName 'AgentWire'
Write-Host "`nAgentWire hub is running on port $Port"
Write-Host "Admin token saved in $TokFile (keep it private)."
Write-Host "Create a key per agent: node $App\src\cli.js invite <agent-id>"
