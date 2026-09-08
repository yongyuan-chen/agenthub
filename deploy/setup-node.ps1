# Enroll an ADDITIONAL Windows server as an AgentHub executor node.
# Run ON the new server, from a checkout of this repo (or via install.ps1):
#   $env:APP_URL='https://agenthub.win'; $env:USER_TOKEN='xxx'
#   powershell -ExecutionPolicy Bypass -File deploy\setup-node.ps1 [node-id]
# No LLM relay credentials needed here — the owning user's Settings-page
# config is pushed to this node automatically the moment it connects.
param([string]$NodeIdArg)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path "$PSScriptRoot\..").Path

if (-not $env:APP_URL) { throw 'set APP_URL (e.g. https://agenthub.win)' }
if (-not $env:USER_TOKEN) { throw 'set USER_TOKEN (your account session token)' }
$AppUrl = $env:APP_URL
$UserToken = $env:USER_TOKEN
$TeamId = $env:TEAM_ID  # optional — binds this node to a team at enrollment

# Includes the OS username, not just the hostname — same reasoning as
# setup-node.sh's default: node ids are global (unique across every AgentHub
# account), and two different people each enrolling from their own account
# on one shared server used to collide on the bare hostname with no
# indication why. Different accounts on a shared box almost always mean
# different Windows users too, so folding $env:USERNAME in avoids the
# collision by default without anyone having to think about it.
# $AutoName tells the server this id was derived rather than chosen, so a
# collision should step to a free suffix instead of taking over whichever
# machine already holds it. An explicit id means "this exact node" (the repair
# one-liner) and keeps the take-over-and-rotate behaviour.
$AutoName = -not $NodeIdArg
$NodeId = if ($NodeIdArg) { $NodeIdArg } else { ("$env:COMPUTERNAME-$env:USERNAME".ToLower() -replace '[^a-z0-9-]', '-') -replace '-+$', '' -replace '^-+', '' }

# Same one-liners setup-node.sh uses (node's own crypto, not a separate
# reimplementation) — just passed via argv instead of stdin to sidestep
# PowerShell/cmd stdin-piping newline quirks.
$NodeToken = (& node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))").Trim()
$TokenHash = (& node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" $NodeToken).Trim()

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Warning "'claude' CLI not found on PATH; install it first (npm i -g @anthropic-ai/claude-code)"
}

Write-Host "[node] enrolling $NodeId at $AppUrl$(if ($TeamId) { " (team $TeamId)" })"
$body = @{ id = $NodeId; tokenHash = $TokenHash; labels = @('windows'); autoName = $AutoName } | ConvertTo-Json -Compress
$Headers = @{ Authorization = "Bearer $UserToken" }
if ($TeamId) { $Headers['x-team-id'] = $TeamId }
$Enrolled = Invoke-RestMethod -Method Post -Uri "$AppUrl/api/nodes" `
  -Headers $Headers -ContentType 'application/json' -Body $body
# Under $AutoName the server may hand back a different id than we asked for
# (it stepped past a collision); the config below has to use the id actually
# registered or this box would authenticate as nobody.
if ($Enrolled.id -and $Enrolled.id -ne $NodeId) {
  Write-Host "[node] '$NodeId' was already in use; this machine was registered as '$($Enrolled.id)'"
  $NodeId = $Enrolled.id
}

$ConfigDir = "$env:USERPROFILE\.agenthub"
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$WorkRoot = "$env:USERPROFILE\agenthub"
$CloudUrl = $AppUrl -replace '^https:', 'wss:' -replace '^http:', 'ws:'
$ClaudeCommand = Get-Command claude.exe, claude.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$CodexCommand = Get-Command codex.exe, codex.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $ClaudeCommand -and -not $CodexCommand) { throw "neither claude nor codex CLI was found after dependency bootstrap" }
$ClaudeBin = if ($ClaudeCommand) { $ClaudeCommand.Source } else { 'claude' }
$CodexBin = if ($CodexCommand) { $CodexCommand.Source } else { 'codex' }
$Config = @{
  cloudUrl    = $CloudUrl
  nodeId      = $NodeId
  nodeToken   = $NodeToken
  provider    = @{ baseUrl = ''; apiKey = ''; model = '' }
  claudeBin   = $ClaudeBin
  codexBin    = $CodexBin
  maxParallel = 3
  workRoot    = $WorkRoot
} | ConvertTo-Json -Depth 5
# Windows PowerShell 5.1's `-Encoding UTF8` prepends a BOM (verified
# directly — this crash-looped the executor with "Unexpected token '﻿'"
# on every single start, since Node's JSON.parse doesn't skip a BOM). Write
# real BOM-less UTF-8 via .NET directly instead.
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText("$ConfigDir\executor.config.json", $Config, $Utf8NoBom)

New-Item -ItemType Directory -Force -Path "$WorkRoot\logs" | Out-Null
$NodeBin = (Get-Command node.exe -CommandType Application).Source
$GitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $GitCommand) { throw "git not found after dependency bootstrap" }
$RuntimePath = @(
  (Split-Path $NodeBin -Parent)
  (Split-Path $GitCommand.Source -Parent)
  $(if ($ClaudeCommand) { Split-Path $ClaudeCommand.Source -Parent })
  $(if ($CodexCommand) { Split-Path $CodexCommand.Source -Parent })
) | Where-Object { $_ } | Select-Object -Unique
$WrapperPath = "$ConfigDir\agenthub-executor-loop.bat"
$LogPath = "$WorkRoot\logs\executor.log"
(Get-Content "$Root\deploy\agenthub-executor-loop.bat.template") `
  -replace '__NODE__', $NodeBin `
  -replace '__SCRIPT__', "$Root\packages\executor\src\index.mjs" `
  -replace '__LOG__', $LogPath `
  -replace '__RUNTIME_PATH__', ($RuntimePath -join ';') `
  | Set-Content -Path $WrapperPath -Encoding ASCII

# /f overwrites an existing task definition so re-running this script on an
# already-installed node picks up freshly-downloaded code, same reason
# setup-node.sh uses 'restart' rather than 'start' for systemd. Stop any
# already-running loop first, or the old process would just keep going
# alongside a newly /run one. This fails (and must be allowed to) on a
# fresh install where the task doesn't exist yet — with
# $ErrorActionPreference = 'Stop', a plain `2>$null` redirect on a native
# command isn't enough to swallow that, it still surfaces as a terminating
# NativeCommandError (verified directly), so this needs a real try/catch.
try { schtasks /end /tn AgentHubExecutor 2>$null | Out-Null } catch { }
# schtasks.exe's /create CLI has no flag for ExecutionTimeLimit, so a
# task made that way silently inherits Task Scheduler's built-in default of
# 72 hours — verified directly: this killed a real node's executor exactly
# 72h after its one and only logon-triggered start, and since the only
# trigger is AtLogOn, it just stayed dead until the next login. Using the
# ScheduledTasks module instead so ExecutionTimeLimit can be set to 0
# (no limit), letting the loop run indefinitely between logons.
$Action = New-ScheduledTaskAction -Execute $WrapperPath
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName AgentHubExecutor -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
schtasks /run /tn AgentHubExecutor | Out-Null

Write-Host "[node] done. node '$NodeId' should appear online on the board shortly."
Write-Host "[node] note: the scheduled task starts at your next Windows logon;" `
  "it was also started immediately just now via 'schtasks /run'."
