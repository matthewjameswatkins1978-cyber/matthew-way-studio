<#
.SYNOPSIS
  Install the Watchtower scheduled task (DISABLED by default; Matthew enables it).

.DESCRIPTION
  Registers a Windows scheduled task that runs watchtower-check.ps1 every
  IntervalMinutes minutes. The task is created DISABLED: enable it in Task
  Scheduler (or Enable-ScheduledTask) only after reviewing the config.
  The check itself is model-free; a model turn spawns only when a new
  addressed handoff is found, bounded by PiTimeoutSec.

.PARAMETER TaskName
  Scheduled task name (default Watchtower-BoardCheck).

.PARAMETER IntervalMinutes
  Poll cadence in minutes, 5..60 (default 10).

.PARAMETER Repository
  owner/repository of the inbox issue.

.PARAMETER Issue
  Inbox issue number.

.PARAMETER StateDir
  Cursor/log directory (created if missing).

.PARAMETER Config
  Path to watchtower.json seat mapping (required for dispatch).

.PARAMETER PiTimeoutSec
  Per-slice cap for launched pi runs (default 600).
#>
[CmdletBinding()]
param(
  [string]$TaskName = "Watchtower-BoardCheck",
  [ValidateRange(5, 60)][int]$IntervalMinutes = 10,
  [string]$Repository = "matthewjameswatkins1978-cyber/pepin",
  [int]$Issue = 16,
  [string]$StateDir = "D:\\Projects\\_watchtower",
  [string]$Config = "",
  [int]$PiTimeoutSec = 600
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Config) -or -not (Test-Path $Config)) { throw "Config watchtower.json is required (seat mapping for dispatch)." }
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$script = Join-Path $PSScriptRoot "watchtower-check.ps1"
$actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Repository $Repository -Issue $Issue -StateDir `"$StateDir`" -Config `"$Config`" -Dispatch -PiTimeoutSec $PiTimeoutSec"
$action = New-ScheduledTaskAction -Execute "pwsh.exe" -Argument $actionArgs -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($IntervalMinutes) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
Disable-ScheduledTask -TaskName $TaskName | Out-Null
"Installed (DISABLED): $TaskName every ${IntervalMinutes}m. Review $Config, then Enable-ScheduledTask -TaskName $TaskName."
