# AgentHub node installer for Windows — piped in from the web UI's "添加节点" dialog.
# Usage (values filled in by the UI, then copy/paste in PowerShell):
#   $env:APP_URL='...'; $env:USER_TOKEN='...'; irm https://<your-domain>/install.ps1 | iex
# Missing Node.js, Git, and Claude Code are installed into the current user's
# profile automatically. Administrator privileges and a package manager are not
# required. Relay credentials still come from the owning user's AgentHub settings.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell 5.1 on older Windows images may otherwise negotiate TLS 1.0.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Log([string]$Message) {
  Write-Host "[install] $Message" -ForegroundColor Cyan
}

function Fail([string]$Message) {
  throw "[install] ERROR: $Message"
}

function Download-File([string]$Uri, [string]$OutFile, [int]$TimeoutSec = 180) {
  Log "downloading $Uri"
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile -TimeoutSec $TimeoutSec
  if (-not (Test-Path $OutFile) -or (Get-Item $OutFile).Length -eq 0) {
    Fail "download returned an empty file: $Uri"
  }
}

function Assert-Sha256([string]$Path, [string]$Expected) {
  $Actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected.ToLowerInvariant()) {
    Fail "SHA-256 verification failed for $Path"
  }
}

function Add-PathDirectory([string]$Directory) {
  if (-not $Directory) { return }
  $Directory = [System.IO.Path]::GetFullPath($Directory).TrimEnd('\')
  $CurrentParts = @($env:Path -split ';' | Where-Object { $_ })
  if (-not ($CurrentParts | Where-Object { $_.TrimEnd('\') -ieq $Directory })) {
    $env:Path = "$Directory;$env:Path"
  }

  try {
    if ($env:AGENTHUB_NO_PERSIST_PATH -eq '1') { return }
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $UserParts = @($UserPath -split ';' | Where-Object { $_ })
    if (-not ($UserParts | Where-Object { $_.TrimEnd('\') -ieq $Directory })) {
      $NewUserPath = if ($UserPath) { "$Directory;$UserPath" } else { $Directory }
      [Environment]::SetEnvironmentVariable('Path', $NewUserPath, 'User')
    }
  } catch {
    Write-Warning "Could not persist '$Directory' in the user PATH. AgentHub will still use it through its scheduled-task wrapper."
  }
}

function Find-Application([string[]]$Names) {
  foreach ($Name in $Names) {
    $Command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Command) { return $Command.Source }
  }
  return $null
}

function Get-WindowsArchitecture {
  $Architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($Architecture.ToUpperInvariant()) {
    'AMD64' { return 'x64' }
    'ARM64' { return 'arm64' }
    default { Fail "unsupported Windows architecture '$Architecture' (x64 or ARM64 required)" }
  }
}

function Test-NodeVersion([string]$NodePath) {
  if (-not $NodePath -or -not (Test-Path $NodePath)) { return $false }
  try {
    & $NodePath -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)" 2>$null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Install-PortableNode([string]$Architecture, [string]$NodeDirectory) {
  Log 'Node.js >= 22.5 not found; installing the official portable Node.js v22 runtime (no administrator privileges required)...'
  $ChecksumUri = 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt'
  $ChecksumText = (Invoke-WebRequest -UseBasicParsing -Uri $ChecksumUri).Content
  $AssetPattern = "^([a-f0-9]{64})\s+(node-v22\.[0-9.]+-win-$Architecture\.zip)\s*$"
  $AssetLine = @($ChecksumText -split "`n" | Where-Object { $_.Trim() -match $AssetPattern } | Select-Object -First 1)
  if (-not $AssetLine) { Fail "could not find a win-$Architecture Node.js v22 ZIP in $ChecksumUri" }
  $Match = [regex]::Match($AssetLine[0].Trim(), $AssetPattern)
  $ExpectedHash = $Match.Groups[1].Value
  $FileName = $Match.Groups[2].Value
  $ZipPath = Join-Path $env:TEMP "agenthub-$([guid]::NewGuid())-$FileName"
  $StagePath = Join-Path $env:TEMP "agenthub-node-$([guid]::NewGuid())"

  try {
    Download-File "https://nodejs.org/dist/latest-v22.x/$FileName" $ZipPath
    Assert-Sha256 $ZipPath $ExpectedHash
    New-Item -ItemType Directory -Force -Path $StagePath | Out-Null
    Expand-Archive -Path $ZipPath -DestinationPath $StagePath -Force
    $Extracted = Get-ChildItem -Path $StagePath -Directory | Select-Object -First 1
    if (-not $Extracted -or -not (Test-Path (Join-Path $Extracted.FullName 'node.exe'))) {
      Fail 'downloaded Node.js ZIP did not contain node.exe'
    }
    Remove-Item -Recurse -Force $NodeDirectory -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Split-Path $NodeDirectory -Parent) | Out-Null
    Move-Item -Path $Extracted.FullName -Destination $NodeDirectory
  } finally {
    Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $StagePath -ErrorAction SilentlyContinue
  }

  $InstalledNode = Join-Path $NodeDirectory 'node.exe'
  if (-not (Test-NodeVersion $InstalledNode)) { Fail 'portable Node.js installation did not produce Node.js >= 22.5' }
  Add-PathDirectory $NodeDirectory
  Log "installed Node.js $(& $InstalledNode --version) into $NodeDirectory"
  return $InstalledNode
}

function Install-PortableGit([string]$Architecture, [string]$GitDirectory) {
  Log 'Git not found; installing the official MinGit runtime (no administrator privileges required)...'
  $Headers = @{
    'User-Agent' = 'AgentHub-Installer/1.0'
    'Accept' = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  try {
    $Release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers $Headers
  } catch {
    Fail "could not query the latest Git for Windows release: $($_.Exception.Message)"
  }
  $Suffix = if ($Architecture -eq 'arm64') { '-arm64.zip' } else { '-64-bit.zip' }
  $Asset = $Release.assets | Where-Object {
    $_.name -like "MinGit-*$Suffix" -and $_.name -notlike '*-busybox-*'
  } | Select-Object -First 1
  if (-not $Asset) { Fail "latest Git for Windows release has no MinGit $Architecture ZIP" }
  if (-not $Asset.digest -or $Asset.digest -notmatch '^sha256:([a-f0-9]{64})$') {
    Fail "GitHub did not publish a SHA-256 digest for $($Asset.name)"
  }

  $ExpectedHash = $Matches[1]
  $ZipPath = Join-Path $env:TEMP "agenthub-$([guid]::NewGuid())-$($Asset.name)"
  $MirrorUri = "https://registry.npmmirror.com/-/binary/git-for-windows/$($Release.tag_name)/$($Asset.name)"
  try {
    try {
      Download-File $MirrorUri $ZipPath 180
      Assert-Sha256 $ZipPath $ExpectedHash
    } catch {
      Write-Warning "MinGit mirror download failed or did not match the official SHA-256; retrying from GitHub: $($_.Exception.Message)"
      Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue
      Download-File $Asset.browser_download_url $ZipPath 180
      Assert-Sha256 $ZipPath $ExpectedHash
    }
    Remove-Item -Recurse -Force $GitDirectory -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $GitDirectory | Out-Null
    Expand-Archive -Path $ZipPath -DestinationPath $GitDirectory -Force
  } finally {
    Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue
  }

  $InstalledGit = Join-Path $GitDirectory 'cmd\git.exe'
  if (-not (Test-Path $InstalledGit)) { Fail 'MinGit installation did not produce cmd\git.exe' }
  Add-PathDirectory (Split-Path $InstalledGit -Parent)
  Log "installed Git $(& $InstalledGit --version) into $GitDirectory"
  return $InstalledGit
}

function Install-ClaudeCode {
  Log 'Claude Code CLI not found; installing the official npm package into the current user profile...'
  $NpmBin = Find-Application @('npm.cmd')
  if (-not $NpmBin) { Fail 'npm.cmd was not found alongside Node.js' }
  $ClaudePrefix = Join-Path $env:USERPROFILE '.agenthub\runtime\claude'
  New-Item -ItemType Directory -Force -Path $ClaudePrefix | Out-Null
  $CommonArgs = @(
    'install', '-g', '@anthropic-ai/claude-code@latest',
    '--prefix', $ClaudePrefix,
    '--no-audit', '--no-fund',
    '--fetch-timeout=120000', '--fetch-retries=1',
    '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=5000'
  )

  Log 'downloading Claude Code from the npm official registry...'
  & $NpmBin @CommonArgs '--registry=https://registry.npmjs.org'
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "npm official registry install failed with code $LASTEXITCODE; retrying through npmmirror"
    Remove-Item -Recurse -Force (Join-Path $ClaudePrefix 'node_modules') -ErrorAction SilentlyContinue
    & $NpmBin @CommonArgs '--registry=https://registry.npmmirror.com'
    if ($LASTEXITCODE -ne 0) { Fail "Claude Code npm installation failed with code $LASTEXITCODE on both registries" }
  }

  Add-PathDirectory $ClaudePrefix
  $InstalledClaude = Join-Path $ClaudePrefix 'claude.cmd'
  if (-not (Test-Path $InstalledClaude)) { Fail 'Claude Code npm installation completed but claude.cmd was not created' }
  Log "installed Claude Code $(& $InstalledClaude --version)"
  return $InstalledClaude
}

Log 'AgentHub Windows node installer starting...'
if (-not $env:APP_URL) { Fail 'missing APP_URL' }
if (-not $env:USER_TOKEN) { Fail 'missing USER_TOKEN' }

$Architecture = Get-WindowsArchitecture
$RuntimeRoot = Join-Path $env:USERPROFILE '.agenthub\runtime'
$NodeDirectory = Join-Path $RuntimeRoot 'node'
$GitDirectory = Join-Path $RuntimeRoot 'git'

$NodeBin = Find-Application @('node.exe')
if (-not (Test-NodeVersion $NodeBin)) {
  $NodeBin = Install-PortableNode $Architecture $NodeDirectory
} else {
  Log "using existing Node.js $(& $NodeBin --version)"
}

$GitBin = Find-Application @('git.exe')
if (-not $GitBin) {
  $GitBin = Install-PortableGit $Architecture $GitDirectory
} else {
  Log "using existing $(& $GitBin --version)"
}

$ClaudeBin = Find-Application @('claude.exe', 'claude.cmd')
if (-not $ClaudeBin) {
  $ClaudeBin = Install-ClaudeCode
} else {
  Log "using existing Claude Code $(& $ClaudeBin --version)"
}

# Used only by automated cold-start verification. It deliberately returns after
# bootstrapping dependencies, before enrollment or scheduled-task changes.
if ($env:AGENTHUB_BOOTSTRAP_ONLY -eq '1') {
  Log 'dependency bootstrap completed successfully'
  return
}

$Dest = Join-Path $env:USERPROFILE 'agenthub-src'
$Tarball = Join-Path $env:TEMP "agenthub-node-$([guid]::NewGuid()).tar.gz"
Log "downloading AgentHub node package into $Dest ..."
try {
  Remove-Item -Recurse -Force $Dest -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Download-File "$env:APP_URL/agenthub-node.tar.gz" $Tarball
  $TarBin = Find-Application @('tar.exe')
  if (-not $TarBin) {
    $MinGitTar = Join-Path $GitDirectory 'usr\bin\tar.exe'
    if (Test-Path $MinGitTar) { $TarBin = $MinGitTar }
  }
  if (-not $TarBin) { Fail 'tar.exe is unavailable even after Git installation' }
  & $TarBin -xzf $Tarball -C $Dest
  if ($LASTEXITCODE -ne 0) { Fail "AgentHub package extraction failed with code $LASTEXITCODE" }
} finally {
  Remove-Item -Force $Tarball -ErrorAction SilentlyContinue
}

Log 'enrolling node and installing scheduled task...'
Set-Location $Dest
$WindowsPowerShell = Find-Application @('powershell.exe')
& $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File 'deploy\setup-node.ps1' $env:NODE_ID
if ($LASTEXITCODE -ne 0) { Fail "setup-node.ps1 exited with code $LASTEXITCODE" }
Log 'AgentHub node installation completed successfully.'
