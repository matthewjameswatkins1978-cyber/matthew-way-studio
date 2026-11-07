<#
.SYNOPSIS
  Watchtower board check (model-free, read-only by default) for the Studio/Intercom workshop.

.DESCRIPTION
  Polls one GitHub issue inbox for WORKSHOP-HANDOFF envelopes newer than the
  persisted cursor and prints a machine-readable JSON verdict. With -Dispatch,
  launches exactly one bounded `pi --print` slice per newly addressed handoff
  (seat matched from a config file) and advances the cursor past dispatched
  ids only. No model inference happens in this script itself.

.PARAMETER Repository
  owner/repository of the inbox issue (validated format).

.PARAMETER Issue
  Issue number carrying handoff envelopes.

.PARAMETER StateDir
  Directory holding the cursor file (<slug>-<issue>.cursor). Created if missing.

.PARAMETER Config
  Path to watchtower.json: { seats: [{ seat, sessionId, cwd, runs: [], roles: [] }] }.
  Required only for -Dispatch.

.PARAMETER Dispatch
  Switch: after a read-only check, launch one bounded pi slice per new handoff.

.PARAMETER PiTimeoutSec
  Per-slice cap for the launched pi process (default 600).

.PARAMETER StopFile
  Path to a STOP flag file. When present, the script NEVER dispatches:
  it runs the read-only check and reports stopped:true. This is the manual
  override - "stop all agents" means creating this file (plus disabling
  the scheduled task); no model, timer or slice can act past it.

.PARAMETER SelfTest
  Switch: run the offline parser/id-compare self-test on canned fixtures, no network.

.EXIT CODES
  0 verdict ok (JSON on stdout) · 1 usage/config error · 2 fetch failed (retryable).
#>
[CmdletBinding()]
param(
  [string]$Repository = "",
  [int]$Issue = 0,
  [string]$StateDir = "",
  [string]$Config = "",
  [switch]$Dispatch,
  [int]$PiTimeoutSec = 600,
  [string]$StopFile = "",
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

$stopped = $false
if (-not [string]::IsNullOrWhiteSpace($StopFile) -and (Test-Path $StopFile)) { $stopped = $true }

function Compare-DecimalId([string]$a, [string]$b) {
  if ($a.Length -ne $b.Length) { return ($a.Length -lt $b.Length) ? -1 : 1 }
  if ($a -eq $b) { return 0 }
  return ($a -lt $b) ? -1 : 1
}

$Envelope = 'WORKSHOP-HANDOFF\s+run=([A-Za-z0-9_.-]+)\s+to=([A-Za-z0-9_.-]+)\s+type=([A-Za-z0-9_.-]+)\s+from=([A-Za-z0-9_.-]+)(?:\s+sha=([0-9a-fA-F]{40}))?'

function ConvertTo-Handoff([object]$c, [string]$repo) {
  if ($null -eq $c.id -or $null -eq $c.body) { return $null }
  $m = [regex]::Match([string]$c.body, $Envelope)
  if (-not $m.Success) { return $null }
  return [ordered]@{
    id         = [string]$c.id
    run_id     = $m.Groups[1].Value
    to         = $m.Groups[2].Value
    type       = $m.Groups[3].Value
    from       = $m.Groups[4].Value
    sha        = $m.Groups[5].Value
    created_at = [string]$c.created_at
    snippet    = ([string]$c.body).Substring(0, [Math]::Min(200, ([string]$c.body).Length))
  }
}

if ($SelfTest) {
  $fails = 0
  $c1 = @{ id = 6703362664; body = "WORKSHOP-HANDOFF run=run-1 to=A2 type=handoff from=A1`nping"; created_at = "2026-11-07T06:30:00Z" }
  $h = ConvertTo-Handoff $c1 "o/r"
  if ($null -eq $h -or $h.run_id -ne "run-1" -or $h.to -ne "A2") { "SELFTEST parse-envelope FAIL"; $fails++ }
  $c2 = @{ id = 7; body = "just chatter"; created_at = "2026-11-07T06:30:00Z" }
  if ($null -ne (ConvertTo-Handoff $c2 "o/r")) { "SELFTEST chatter-skip FAIL"; $fails++ }
  if ((Compare-DecimalId "9" "10") -ne -1) { "SELFTEST id-compare-length FAIL"; $fails++ }
  if ((Compare-DecimalId "6703362664" "6703362664") -ne 0) { "SELFTEST id-compare-equal FAIL"; $fails++ }
  if ((Compare-DecimalId "6698051352" "6698000000") -ne 1) { "SELFTEST id-compare-greater FAIL"; $fails++ }
  if ($fails -eq 0) { "SELFTEST PASS (5/5)" } else { "SELFTEST FAIL ($fails)" }
  exit ($fails -eq 0 ? 0 : 1)
}

if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { Write-Error "Repository must be owner/repository."; exit 1 }
if ($Issue -lt 1) { Write-Error "Issue must be a positive integer."; exit 1 }
if ([string]::IsNullOrWhiteSpace($StateDir)) { Write-Error "StateDir is required."; exit 1 }
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$slug = $Repository -replace '[^A-Za-z0-9]+', '-'
$cursorFile = Join-Path $StateDir "$slug-$Issue.cursor"
$cursor = ""
if (Test-Path $cursorFile) { $cursor = (Get-Content $cursorFile -Raw).Trim() }
$sinceFile = Join-Path $StateDir "$slug-$Issue.since"
$sinceArgs = @()
if (Test-Path $sinceFile) {
  # Fetch optimisation only: subtract a 1h margin so clock skew or late
  # edits cannot hide a comment the id cursor has not scanned yet.
  $sinceStored = [datetime](Get-Content $sinceFile -Raw).Trim()
  $sinceArgs = @("-F", ("since=" + $sinceStored.AddHours(-1).ToUniversalTime().ToString("o")))
}

try {
  $apiArgs = @("repos/$Repository/issues/$Issue/comments", "--paginate", "--method", "GET", "-F", "per_page=100") + $sinceArgs
  $raw = gh api @apiArgs 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "gh exit $LASTEXITCODE" }
  $pages = $raw | ConvertFrom-Json
} catch {
  Write-Error "fetch failed: $_"
  exit 2
}
$comments = @()
foreach ($page in @($pages)) { foreach ($entry in @($page)) { $comments += $entry } }
if ($comments.Count -gt 2000) { $comments = $comments | Select-Object -Last 2000 }

$maxId = ""
$maxCreated = ""
$handoffs = @()
foreach ($c in ($comments | Sort-Object { [int64]$_.id })) {
  $idStr = [string]$c.id
  if ($maxId -eq "" -or (Compare-DecimalId $idStr $maxId) -gt 0) { $maxId = $idStr }
  if ([string]$c.created_at -gt $maxCreated) { $maxCreated = [string]$c.created_at }
  if ($cursor -ne "" -and (Compare-DecimalId $idStr $cursor) -le 0) { continue }
  $h = ConvertTo-Handoff $c $Repository
  if ($null -ne $h) { $handoffs += $h }
}

if ($maxCreated -ne "") { Set-Content -Path $sinceFile -Value $maxCreated -NoNewline }

$dispatched = @()
if ($Dispatch -and -not $stopped) {
  if ([string]::IsNullOrWhiteSpace($Config) -or -not (Test-Path $Config)) { Write-Error "Dispatch needs -Config watchtower.json."; exit 1 }
  $cfg = Get-Content $Config -Raw | ConvertFrom-Json
  foreach ($h in $handoffs) {
    $seat = $cfg.seats | Where-Object { $_.roles -contains $h.to -and ($null -eq $_.runs -or $_.runs.Count -eq 0 -or $_.runs -contains $h.run_id) } | Select-Object -First 1
    if ($null -eq $seat) { continue }
    $packet = "WORKSHOP WAKE $($h.to): $($h.from) ($($h.type)) comment #$($h.id). Verify the pinned receipt and continue. Envelope sha: $($h.sha)."
    $log = Join-Path $StateDir "dispatch-$($h.id).log"
    try {
      $p = Start-Process -FilePath "pi" -ArgumentList "--print", "--session-id", $seat.sessionId, $packet -WorkingDirectory $seat.cwd -RedirectStandardOutput $log -Wait -PassThru
      $code = $p.ExitCode
    } catch { $code = -1 }
    # Bound: stop after the first successful slice; the rest wait for the next tick.
    $dispatched += [ordered]@{ id = $h.id; seat = $seat.seat; exit = $code }
    if ($code -eq 0) { break }
  }
  if ($dispatched.Count -gt 0) {
    $lastOk = ($dispatched | Where-Object { $_.exit -eq 0 } | Select-Object -Last 1)
    $commitTo = if ($lastOk) { $lastOk.id } else { $cursor }
    if ($commitTo -ne "") { Set-Content -Path $cursorFile -Value $commitTo -NoNewline }
  }
}

[ordered]@{
  checked_at = (Get-Date).ToUniversalTime().ToString("o")
  repository = $Repository
  issue      = $Issue
  cursor     = $cursor
  max_id     = $maxId
  handoffs   = $handoffs
  dispatched = $dispatched
  stopped    = $stopped
} | ConvertTo-Json -Depth 5 -Compress
exit 0
