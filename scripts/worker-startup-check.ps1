<#
  READ-ONLY post-logon check for the laptop video worker.

  Run it after signing in (or let it run from a Task Scheduler "At log on"
  trigger if the owner chooses to register one - this script does not register
  anything). It never starts, stops or restarts a container, never touches a
  queue or the database, and never prints environment values.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\worker-startup-check.ps1

  Exit code: 0 = worker up and recovery seen (or not yet due); 1 = needs a look.
#>
param(
  [string]$Container = 'edu-worker',
  [int]$WaitForDockerSeconds = 300
)

# Continue: docker writes ordinary log lines to stderr, which 'Stop' would turn
# into terminating errors in Windows PowerShell 5.1.
$ErrorActionPreference = 'Continue'
$problems = @()

function Write-Line([string]$label, [string]$value) { Write-Output ('{0,-22} {1}' -f $label, $value) }

# 1. Docker Desktop starts from the per-user Run key at logon; the engine takes
#    a minute or two. Wait for it instead of failing straight away.
$deadline = (Get-Date).AddSeconds($WaitForDockerSeconds)
$engineUp = $false
while ((Get-Date) -lt $deadline) {
  docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -eq 0) { $engineUp = $true; break }
  Start-Sleep -Seconds 10
}
Write-Line 'docker engine' ($(if ($engineUp) { 'up' } else { "NOT up after $WaitForDockerSeconds s" }))
if (-not $engineUp) {
  Write-Output 'Docker Desktop is not running. Start it from the Start menu; the worker container restarts by itself (restart=unless-stopped).'
  exit 1
}

# 2. The worker container: running, healthy, restart policy.
$state = docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.StartedAt}}|{{.Config.Image}}' $Container 2>$null
if ($LASTEXITCODE -ne 0 -or -not $state) {
  Write-Line 'worker container' "$Container NOT FOUND"
  exit 1
}
$status, $health, $restart, $started, $image = $state.Split('|')
Write-Line 'worker container' "$status / health=$health"
Write-Line 'image' $image
Write-Line 'started at (UTC)' $started
Write-Line 'restart policy' $restart
if ($status -ne 'running') { $problems += "container is $status" }
if ($health -eq 'unhealthy') { $problems += 'container reports unhealthy' }
if ($restart -notin @('unless-stopped', 'always')) { $problems += "restart policy is '$restart' (the container will not come back by itself)" }

# 3. What the worker did since it started (log markers only).
$logs = docker logs --since $started $Container 2>&1 | Out-String
$markers = [ordered]@{
  'boot recovery'     = 'BOOT_RECOVERY (done|skipped|postponed|gave up)'
  'gumlet monitor'    = 'Gumlet status monitor (ON|OFF)'
  'gumlet ready'      = 'GUMLET_MONITOR_READY'
  'rungs reused'      = 'HLS_RUNG_REUSED'
  'deferrals'         = 'TRANSIENT_DEFERRAL'
  'db unreachable'    = 'database unreachable'
}
foreach ($k in $markers.Keys) {
  $n = ([regex]::Matches($logs, $markers[$k])).Count
  Write-Line $k "$n line(s)"
}
$last = ([regex]::Matches($logs, 'BOOT_RECOVERY[^\r\n]*') | Select-Object -Last 1).Value
if ($last) { Write-Line 'last boot recovery' $last }
else {
  # Docker prints 9 fractional digits; .NET parses at most 7.
  $startedUtc = [datetime]::Parse(($started -replace '(\.\d{7})\d+', '$1')).ToUniversalTime()
  $age = (Get-Date).ToUniversalTime() - $startedUtc
  if ($logs -notmatch 'Gumlet status monitor (ON|OFF)') {
    Write-Line 'last boot recovery' 'n/a: this image predates boot recovery (scheduled 30-minute sweep only)'
  }
  elseif ($age.TotalMinutes -gt 15) { $problems += 'no BOOT_RECOVERY line 15 minutes after start' }
  else { Write-Line 'last boot recovery' 'not yet due (runs ~90 s after start, retried while the network comes up)' }
}

if ($problems.Count) {
  Write-Output ''
  Write-Output 'NEEDS A LOOK:'
  $problems | ForEach-Object { Write-Output "  - $_" }
  exit 1
}
Write-Output ''
Write-Output 'OK: worker is up; interrupted work resumes on its own.'
exit 0
