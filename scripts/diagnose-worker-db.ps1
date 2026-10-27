<#
  Read-only connectivity check for the PC-hosted video worker (edu-worker) and Neon.

  Run from the backend folder:
    powershell -ExecutionPolicy Bypass -File scripts\diagnose-worker-db.ps1

  It never prints a password or a full connection string. It only reads: DNS,
  a TCP connect, `SELECT 1`, the container's environment (host/port/params only)
  and recent worker log lines that mention the database or the two videos.
  Paste the output back to Claude.
#>
param(
  [string]$Container = 'edu-worker',
  [string]$EnvFile = '.env',
  [string[]]$VideoIds = @('cmvpsko6v0216dg014ut9lw0v', 'cmv09znia000thl01wixuismf')
)

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

function Describe-Url([string]$url) {
  if (-not $url) { return $null }
  $u = [System.Uri]$url
  [pscustomobject]@{
    Host     = $u.Host
    Port     = $(if ($u.Port -gt 0) { $u.Port } else { 5432 })
    Database = $u.AbsolutePath.TrimStart('/')
    Pooled   = $u.Host -like '*-pooler.*'
    Params   = ($u.Query.TrimStart('?') -split '&' | Where-Object { $_ } | ForEach-Object { ($_ -split '=')[0] }) -join ','
  }
}

Section 'DATABASE_URL in .env (host only)'
$line = Get-Content $EnvFile | Where-Object { $_ -match '^\s*DATABASE_URL=' } | Select-Object -First 1
$hostUrl = Describe-Url ($line -replace '^\s*DATABASE_URL=', '')
$hostUrl | Format-List

Section 'DNS from this PC'
try { Resolve-DnsName $hostUrl.Host -ErrorAction Stop | Select-Object Name, Type, IPAddress | Format-Table -AutoSize }
catch { Write-Host "DNS FAILED: $($_.Exception.Message)" -ForegroundColor Red }

Section 'TCP 5432 from this PC'
Test-NetConnection $hostUrl.Host -Port $hostUrl.Port -WarningAction SilentlyContinue |
  Select-Object ComputerName, RemoteAddress, TcpTestSucceeded | Format-List

Section "Container $Container"
docker ps -a --filter "name=$Container" --format "{{.Names}}  {{.Status}}  image={{.Image}}  created={{.CreatedAt}}"
$img = docker inspect $Container --format '{{.Image}}' 2>$null
if ($img) { docker image inspect $img --format 'image built: {{.Created}}' }
docker exec $Container node -e "console.log('BUILD_COMMIT=' + (process.env.BUILD_COMMIT || '(unset)'))"

Section 'DATABASE_URL inside the container (host only)'
$js = @'
const raw = process.env.DATABASE_URL || '';
if (!raw) { console.log('DATABASE_URL is NOT set in the container'); process.exit(0); }
const u = new URL(raw);
console.log(JSON.stringify({ host: u.hostname, port: u.port || '5432', db: u.pathname.slice(1),
  pooled: /-pooler\./.test(u.hostname), params: [...u.searchParams.keys()],
  hasUser: !!u.username, hasPassword: !!u.password }));
'@
docker exec $Container node -e $js

Section 'DNS + TCP + SELECT 1 from inside the container'
$probe = @'
const dns = require('dns').promises, net = require('net');
const u = new URL(process.env.DATABASE_URL);
(async () => {
  try { console.log('dns:', JSON.stringify(await dns.lookup(u.hostname, { all: true }))); }
  catch (e) { console.log('dns FAILED:', e.code || e.message); }
  await new Promise((res) => {
    const t0 = Date.now(), s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    s.setTimeout(10000);
    s.on('connect', () => { console.log('tcp: OK in ' + (Date.now() - t0) + ' ms'); s.destroy(); res(); });
    s.on('timeout', () => { console.log('tcp: TIMEOUT after 10 s'); s.destroy(); res(); });
    s.on('error', (e) => { console.log('tcp FAILED:', e.code || e.message); res(); });
  });
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    try { await p.$queryRawUnsafe('SELECT 1'); console.log(`select1 #${i}: OK in ${Date.now() - t0} ms`); }
    catch (e) { console.log(`select1 #${i}: FAILED ${e.code || e.errorCode || ''} after ${Date.now() - t0} ms`); }
  }
  await p.$disconnect();
})();
'@
docker exec $Container node -e $probe

Section 'Recent worker log lines about the database or these videos'
$pattern = "Can't reach|P10\d\d|P2024|Database connected|ORPHANED_GUMLET_ASSET|" + ($VideoIds -join '|')
docker logs --since 72h $Container 2>&1 | Select-String -Pattern $pattern | Select-Object -Last 60 |
  ForEach-Object { $_.Line -replace 'postgres(ql)?://[^\s`"]+', 'postgresql://***' }
