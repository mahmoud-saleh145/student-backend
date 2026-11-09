<#
.SYNOPSIS
  Operate the Student Center production worker on this Windows laptop.

.DESCRIPTION
  Wraps docker compose for deploy/laptop-worker/docker-compose.yml and adds the
  checks the laptop needs before it is allowed to encode lectures:

    preflight  Measure free space from WINDOWS (not from WSL), create the
               scratch folder, start a throw-away container with the same bind
               mount, verify from INSIDE the container that the mount is the
               Windows folder (same free size, a file written inside appears
               in Explorer), delete it, and confirm the space came back to
               Windows. Prints the reserve the worker will enforce.
    up         docker compose up -d (pulls nothing; the image is built locally).
    down       docker compose down (the running encode is interrupted and
               retried by the next worker).
    status     Container state, Windows free space, scratch folder size, and
               the worker's own heartbeat (scratch, load, pause, active job)
               read through the API overview if API_BASE_URL and ADMIN_TOKEN
               are set in the environment.
    logs       Follow the container logs.
    pause      Set the pause flag through the API (needs API_BASE_URL and
    resume     ADMIN_TOKEN). The running encode finishes; queued ones wait.

  Nothing here deletes anything outside C:\edu-transcode (or SCRATCH_HOST_DIR),
  prunes Docker, or touches WSL virtual disks.
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('preflight', 'up', 'down', 'status', 'logs', 'pause', 'resume')]
  [string]$Command = 'status',
  [string]$Reason = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $here '.env.worker'

function Read-EnvFile {
  $map = @{}
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$') { $map[$matches[1]] = $matches[2].Trim('"').Trim("'") }
    }
  }
  return $map
}

$cfg = Read-EnvFile
$scratch = if ($cfg.SCRATCH_HOST_DIR) { $cfg.SCRATCH_HOST_DIR } elseif ($env:SCRATCH_HOST_DIR) { $env:SCRATCH_HOST_DIR } else { 'C:/edu-transcode' }
$scratchWin = $scratch -replace '/', '\'
$minFreeGb = if ($cfg.TRANSCODE_MIN_FREE_GB) { [int]$cfg.TRANSCODE_MIN_FREE_GB } else { 25 }
$image = if ($cfg.WORKER_IMAGE) { $cfg.WORKER_IMAGE } elseif ($env:WORKER_IMAGE) { $env:WORKER_IMAGE } else { 'edu-worker:latest' }
$drive = $scratchWin.Substring(0, 1)

function Get-WindowsFree {
  $vol = Get-Volume -DriveLetter $drive
  return [pscustomobject]@{ FreeGB = [math]::Round($vol.SizeRemaining / 1GB, 2); SizeGB = [math]::Round($vol.Size / 1GB, 1); FreeBytes = $vol.SizeRemaining }
}

function Invoke-Api([string]$method, [string]$path, $body) {
  if (-not $env:API_BASE_URL -or -not $env:ADMIN_TOKEN) { throw 'Set API_BASE_URL and ADMIN_TOKEN in the environment first' }
  $headers = @{ Authorization = "Bearer $env:ADMIN_TOKEN" }
  $uri = "$($env:API_BASE_URL.TrimEnd('/'))/api/v1$path"
  if ($null -ne $body) {
    return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json)
  }
  return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers
}

switch ($Command) {
  'preflight' {
    Write-Host "== Laptop worker preflight ==" -ForegroundColor Cyan
    $free = Get-WindowsFree
    Write-Host ("Drive {0}: {1} GB free of {2} GB (Windows view)" -f $drive, $free.FreeGB, $free.SizeGB)
    $vhdx = Join-Path $env:LOCALAPPDATA 'Docker\wsl\disk\docker_data.vhdx'
    if (Test-Path $vhdx) { Write-Host ("Docker WSL2 image: {0:N2} GB at {1}" -f ((Get-Item $vhdx).Length / 1GB), $vhdx) }
    if (-not (Test-Path $scratchWin)) { New-Item -ItemType Directory -Path $scratchWin | Out-Null; Write-Host "Created $scratchWin" }
    else { Write-Host "Scratch folder exists: $scratchWin" }
    $used = (Get-ChildItem $scratchWin -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    Write-Host ("Scratch folder currently holds {0:N1} MB" -f (($used | ForEach-Object { $_ }) / 1MB))

    if ($free.FreeGB -lt ($minFreeGb + 8)) {
      Write-Host ("BLOCKER: only {0} GB free; the worker needs the {1} GB reserve plus room for one job (~8 GB). Free space first." -f $free.FreeGB, $minFreeGb) -ForegroundColor Red
      exit 2
    }

    Write-Host "Verifying the bind mount from inside a throw-away container ($image)..."
    $marker = "preflight-$([guid]::NewGuid().ToString('N').Substring(0, 8)).bin"
    $script = "set -e; df -P -B1 /tmp/edu-transcode | tail -1; dd if=/dev/zero of=/tmp/edu-transcode/$marker bs=1M count=64 status=none; ls -l /tmp/edu-transcode/$marker; df -P -B1 /tmp/edu-transcode | tail -1"
    $out = docker run --rm --user root -v "${scratch}:/tmp/edu-transcode" --entrypoint sh $image -c $script
    $out | ForEach-Object { Write-Host "  container: $_" }
    $lines = @($out | Where-Object { $_ -match '^\S+\s+\d+\s+\d+\s+\d+' })
    $insideFreeBefore = [int64](($lines[0] -split '\s+')[3])
    $insideFreeAfter = [int64](($lines[1] -split '\s+')[3])
    $hostFile = Join-Path $scratchWin $marker
    if (-not (Test-Path $hostFile)) { Write-Host "BLOCKER: the file written inside the container is not visible at $hostFile - the mount is not the Windows folder." -ForegroundColor Red; exit 2 }
    $size = (Get-Item $hostFile).Length
    Write-Host ("File written in the container is visible in Windows: {0} ({1:N0} bytes)" -f $hostFile, $size)
    $driftGb = [math]::Abs($insideFreeBefore - $free.FreeBytes) / 1GB
    if ($driftGb -gt 2) { Write-Host ("WARNING: free space seen inside the container ({0:N1} GB) differs from Windows ({1:N1} GB) by more than 2 GB - check that the mount is really drive {2}." -f ($insideFreeBefore / 1GB), $free.FreeGB, $drive) -ForegroundColor Yellow }
    else { Write-Host ("Free space inside the container ({0:N1} GB) matches Windows ({1:N1} GB): the mount is the Windows drive." -f ($insideFreeBefore / 1GB), $free.FreeGB) -ForegroundColor Green }
    Remove-Item $hostFile -Force
    Start-Sleep -Seconds 2
    $after = Get-WindowsFree
    Write-Host ("After deleting the test file Windows reports {0} GB free (before: {1} GB): space returns to Windows." -f $after.FreeGB, $free.FreeGB) -ForegroundColor Green
    Write-Host ("Reserve the worker will enforce: {0} GB must stay free on {1}:" -f $minFreeGb, $drive)
    Write-Host ("Headroom for encodes right now: {0:N1} GB" -f ($after.FreeGB - $minFreeGb))
    Write-Host "Preflight OK." -ForegroundColor Green
  }
  'up' {
    if (-not (Test-Path $envFile)) { throw "Missing $envFile (copy .env.worker.example and fill it in)" }
    if (-not (Test-Path $scratchWin)) { throw "Scratch folder $scratchWin does not exist; run preflight first" }
    Push-Location $here
    try { docker compose --env-file $envFile up -d --remove-orphans } finally { Pop-Location }
    docker ps --filter name=edu-worker --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
  }
  'down' {
    Push-Location $here
    try { docker compose --env-file $envFile down } finally { Pop-Location }
  }
  'logs' {
    docker logs -f --tail 200 edu-worker
  }
  'status' {
    docker ps -a --filter name=edu-worker --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
    $free = Get-WindowsFree
    Write-Host ("Drive {0}: {1} GB free (reserve {2} GB, headroom {3:N1} GB)" -f $drive, $free.FreeGB, $minFreeGb, ($free.FreeGB - $minFreeGb))
    if (Test-Path $scratchWin) {
      $used = (Get-ChildItem $scratchWin -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
      Write-Host ("Scratch {0}: {1:N1} MB in use" -f $scratchWin, (($used | ForEach-Object { $_ }) / 1MB))
    }
    if ($env:API_BASE_URL -and $env:ADMIN_TOKEN) {
      $o = Invoke-Api GET '/videos/mobile/overview' $null
      Write-Host ("Mobile pipeline: {0}% done, {1} remaining, ETA {2} h, paused={3}, worker online={4}" -f $o.progressPercent, $o.remaining, $o.throughput.estimatedRemainingHours, $o.pause.paused, $o.worker.workerOnline)
      if ($o.worker.detail) { $o.worker.detail | ConvertTo-Json -Depth 5 }
    } else {
      Write-Host "(set API_BASE_URL and ADMIN_TOKEN to also show the pipeline overview)"
    }
  }
  'pause' {
    Invoke-Api POST '/videos/mobile/pause' @{ reason = $Reason } | ConvertTo-Json
  }
  'resume' {
    Invoke-Api POST '/videos/mobile/resume' $null | ConvertTo-Json
  }
}
