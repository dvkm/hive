$ErrorActionPreference = "Stop"

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Resolve-Bun {
  $command = Get-Command bun.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $fallback = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
  if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
  throw "Bun was not found. Install Bun or add bun.exe to PATH."
}

function Get-HiveListenerPid {
  $line = netstat -ano -p TCP |
    Select-String -Pattern '^\s*TCP\s+127\.0\.0\.1:4700\s+\S+\s+LISTENING\s+(\d+)\s*$' |
    Select-Object -First 1
  if (-not $line) { return $null }
  return [int]$line.Matches[0].Groups[1].Value
}

function Test-HiveHealth {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4700/api/health" -TimeoutSec 2
    return $health.ok -eq $true
  } catch {
    return $false
  }
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$live = if ($env:HIVE_LIVE_DIR) {
  (Resolve-Path $env:HIVE_LIVE_DIR).Path
} else {
  $repo
}
$bun = Resolve-Bun
$stateDir = Join-Path $env:LOCALAPPDATA "Hive"
$logDir = Join-Path $stateDir "logs"
$marker = Join-Path $stateDir "last-deployed-commit"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Push-Location $repo
try {
  Invoke-Git fetch origin main --quiet
  $mainBefore = (& git rev-parse refs/heads/main).Trim()
  $originMain = (& git rev-parse refs/remotes/origin/main).Trim()
  $ahead = [int]((& git rev-list --count "$originMain..$mainBefore").Trim())
  $behind = [int]((& git rev-list --count "$mainBefore..$originMain").Trim())

  if ($ahead -gt 0 -and $behind -gt 0) {
    throw "Local main and origin/main have diverged (local +$ahead / origin +$behind). Reconcile them manually."
  }
  if ($behind -gt 0) {
    if ((& git branch --show-current).Trim() -ne "main") {
      throw "Local main is behind origin/main, but the checkout is not on main."
    }
    Invoke-Git merge --ff-only $originMain --quiet
  }
  if ($ahead -gt 0) {
    Invoke-Git push origin main --quiet
  }
} finally {
  Pop-Location
}

if ($live -ne $repo) {
  Push-Location $live
  try {
    Invoke-Git fetch $repo main --quiet
    $liveHead = (& git rev-parse HEAD).Trim()
    $sourceHead = (& git rev-parse FETCH_HEAD).Trim()
    if ($liveHead -ne $sourceHead) {
      Invoke-Git merge --ff-only FETCH_HEAD --quiet
    }
  } finally {
    Pop-Location
  }
}

Push-Location $live
try {
  $commit = (& git rev-parse HEAD).Trim()
  $deployed = if (Test-Path -LiteralPath $marker) {
    (Get-Content -LiteralPath $marker -Raw).Trim()
  } else {
    ""
  }

  if ($deployed -ne $commit) {
    & $bun install --silent
    if ($LASTEXITCODE -ne 0) { throw "bun install failed" }

    Push-Location (Join-Path $live "web")
    try {
      & $bun install --silent
      if ($LASTEXITCODE -ne 0) { throw "web bun install failed" }
      & $bun run build
      if ($LASTEXITCODE -ne 0) { throw "web build failed" }
    } finally {
      Pop-Location
    }

    $desktopWasOpen = @(Get-Process -Name "hive" -ErrorAction SilentlyContinue).Count -gt 0
    if ($desktopWasOpen) {
      Get-Process -Name "hive" -ErrorAction SilentlyContinue | Stop-Process -Force
    }

    Push-Location (Join-Path $live "electron")
    try {
      & $bun install --silent
      if ($LASTEXITCODE -ne 0) { throw "Electron bun install failed" }
      & $bun run install-app
      if ($LASTEXITCODE -ne 0) { throw "Electron install failed" }
    } finally {
      Pop-Location
    }

    if (Test-HiveHealth) {
      $listenerPid = Get-HiveListenerPid
      if ($listenerPid) {
        Stop-Process -Id $listenerPid -Force
        for ($i = 0; $i -lt 50 -and (Get-Process -Id $listenerPid -ErrorAction SilentlyContinue); $i++) {
          Start-Sleep -Milliseconds 100
        }
      }
    }

    $stdout = Join-Path $logDir "server.stdout.log"
    $stderr = Join-Path $logDir "server.stderr.log"
    Start-Process -FilePath $bun -ArgumentList @("run", "server") -WorkingDirectory $live `
      -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null

    $healthy = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-HiveHealth) {
        $healthy = $true
        break
      }
    }
    if (-not $healthy) {
      throw "Hive did not become healthy after restart. See $stderr"
    }

    Set-Content -LiteralPath $marker -Value $commit -NoNewline

    if ($desktopWasOpen) {
      $installedApp = Join-Path $env:LOCALAPPDATA "Programs\hive\hive.exe"
      if (Test-Path -LiteralPath $installedApp) {
        Start-Process -FilePath $installedApp -WindowStyle Hidden
      }
    }
  }

  if ((& git rev-parse HEAD).Trim() -ne $commit) {
    throw "The live checkout changed during deployment."
  }
  if (-not (Test-HiveHealth)) {
    throw "Hive health check failed."
  }
  Write-Host "Hive live checkout is $commit and health is ok."
} finally {
  Pop-Location
}
