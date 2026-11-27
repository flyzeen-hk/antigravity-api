param(
  [switch]$PrintPath,
  [switch]$CheckOnly,
  [string]$ResultFile = ''
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$LocalNode = Join-Path $RootDir 'runtime\node\node.exe'

function Get-NodeMajor([string]$ExePath) {
  if (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) { return 0 }
  try {
    $ver = & $ExePath -e "process.stdout.write(String(process.versions.node || ''))" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $ver) { return 0 }
    $parts = $ver.Trim().Split('.')
    $major = 0
    if ([int]::TryParse($parts[0], [ref]$major)) { return $major }
  } catch {}
  return 0
}

function Find-WorkingNode {
  if ((Get-NodeMajor $LocalNode) -ge 18) { return $LocalNode }
  $cmd = Get-Command 'node' -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and ((Get-NodeMajor $cmd.Source) -ge 18)) { return $cmd.Source }
  foreach ($cand in @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )) {
    if ($cand -and ((Get-NodeMajor $cand) -ge 18)) { return $cand }
  }
  return $null
}

function Return-Node([string]$PathToNode) {
  if ($ResultFile) {
    [System.IO.File]::WriteAllText($ResultFile, $PathToNode, [System.Text.Encoding]::UTF8)
  }
  if ($PrintPath) {
    Write-Output $PathToNode
  }
  exit 0
}

function Install-PortableNode {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $baseUrl = 'https://nodejs.org/dist/latest-v22.x/'
  Write-Host "Fetching Node.js v22 LTS checksums from $baseUrl ..." -ForegroundColor Cyan
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + 'SHASUMS256.txt') -TimeoutSec 30).Content
  $pattern = "(?m)^([0-9a-f]{64})\s+(node-v22\.[0-9.]+-win-$arch\.zip)\s*$"
  $m = [regex]::Match($sums, $pattern)
  if (-not $m.Success) {
    throw "Could not locate Node.js win-$arch zip in SHASUMS256.txt"
  }
  $expectedSha = $m.Groups[1].Value.ToLowerInvariant()
  $fileName = $m.Groups[2].Value
  $zipUrl = $baseUrl + $fileName

  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ag-node-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $zipPath = Join-Path $tmpDir $fileName
  $extractDir = Join-Path $tmpDir 'extracted'

  try {
    Write-Host "Downloading $fileName ..." -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $zipPath -TimeoutSec 180

    Write-Host 'Verifying SHA-256 checksum ...' -ForegroundColor Cyan
    $actualSha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha -ne $expectedSha) {
      throw "SHA-256 mismatch! Expected $expectedSha, got $actualSha"
    }

    Write-Host "Extracting into .\runtime\node\ ..." -ForegroundColor Cyan
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
    $innerNode = Get-ChildItem -LiteralPath $extractDir -Filter 'node.exe' -Recurse | Select-Object -First 1
    if (-not $innerNode) { throw 'node.exe not found inside extracted archive.' }

    $targetDir = Split-Path -Parent $LocalNode
    if (Test-Path -LiteralPath $targetDir) {
      Remove-Item -LiteralPath $targetDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetDir) | Out-Null
    Move-Item -LiteralPath $innerNode.Directory.FullName -Destination $targetDir -Force

    if ((Get-NodeMajor $LocalNode) -lt 18) {
      throw 'Downloaded runtime failed verification.'
    }
    Write-Host "Portable Node.js ready at $LocalNode" -ForegroundColor Green
    return $LocalNode
  } finally {
    if (Test-Path -LiteralPath $tmpDir) {
      Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Install-WingetNode {
  $wg = Get-Command 'winget' -ErrorAction SilentlyContinue
  if (-not $wg) {
    throw 'winget is not available on this system.'
  }
  Write-Host 'Running winget install --id OpenJS.NodeJS.LTS -e ...' -ForegroundColor Cyan
  & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  $found = Find-WorkingNode
  if (-not $found) {
    throw 'Node.js >= 18 was installed via winget, please open a new terminal and run again.'
  }
  return $found
}

$existing = Find-WorkingNode
if ($existing) {
  Return-Node $existing
}

if ($CheckOnly) {
  exit 1
}

Write-Host ''
Write-Host '==========================================================' -ForegroundColor Yellow
Write-Host '  Node.js 18+ was not found (local runtime or system PATH)' -ForegroundColor Yellow
Write-Host '==========================================================' -ForegroundColor Yellow
Write-Host ''
Write-Host '  Antigravity API requires Node.js 18+ (zero Python required).'
Write-Host '  Choose how to proceed (nothing is downloaded automatically):'
Write-Host ''
Write-Host '  [1] Download portable Node.js v22 LTS into .\runtime\node\'
Write-Host '      (official nodejs.org archive, SHA-256 verified, autonomous)'
Write-Host '  [2] Install/Update system Node.js LTS via winget'
Write-Host '  [3] Cancel and exit'
Write-Host ''

$choice = (Read-Host 'Enter choice [1/2/3]').Trim()
switch ($choice) {
  '1' {
    $p = Install-PortableNode
    Return-Node $p
  }
  '2' {
    $p = Install-WingetNode
    Return-Node $p
  }
  default {
    Write-Host 'Cancelled by user. Nothing was downloaded.' -ForegroundColor Gray
    exit 1
  }
}
