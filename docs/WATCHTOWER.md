# Watchtower: wake-up timer for the agent workshop

Three layers, nothing invented. Fast path while alive, durable mailbox when
dead, scheduled check that needs no live process at all.

## 1. Stable seat identities (mailbox continuity)

The intercom broker routes queued mail to a relaunched session by
**explicit name + cwd** (`pi-intercom` broker: `findLiveSessionsSharingMailboxIdentity`).
Runtime-generated names (`subagent-chat-*`) break continuity: a restarted seat
looks like a stranger and its mail stays queued.

Launch every workshop seat with a stable identity:

```powershell
$env:PI_INTERCOM_STABLE_ID = "a1-pepin"   # A1 | a2-pepin | a3-verify | a4-sleepwake
pi --name "a1-pepin"                        # human-readable presence name
```

`PI_INTERCOM_STABLE_ID` is the mailbox identity (survives restarts);
`--name` is the presence label. Both are read from the existing
`pi-intercom` client (`STABLE_INTERCOM_SESSION_ID_ENV`, `getSessionName`);
no Studio code depends on them.

## 2. Model-free board check (`scripts/watchtower-check.ps1`)

Read-only by default. Fetches the inbox issue via `gh`, parses
`WORKSHOP-HANDOFF` envelopes (same grammar as `src/inbox.ts`), compares
decimal comment ids against a local cursor file, prints a JSON verdict.
No model inference, ever, in this script.

```powershell
pwsh -File scripts/watchtower-check.ps1 -Repository owner/repo -Issue 16 `
  -StateDir D:\Projects\_watchtower
```

`-SelfTest` runs the offline parser/id-compare checks (5/5, no network).
`-Dispatch -Config watchtower.json` launches exactly one bounded
`pi --print --session-id <seat>` slice per newly addressed handoff
(first success wins; cursor advances past dispatched ids only).

## 3. Scheduled task (`scripts/Install-WatchtowerTask.ps1`)

Registers the check every 10 minutes (5–60 configurable). **Created
DISABLED** — enable only after reviewing `watchtower.json`:

```powershell
pwsh -File scripts/Install-WatchtowerTask.ps1 -Config .\watchtower.json
Enable-ScheduledTask -TaskName Watchtower-BoardCheck   # Matthew only
```

Kill switch (either works; both is safest): `Disable-ScheduledTask -TaskName Watchtower-BoardCheck`, and/or create the STOP flag file passed via -StopFile (the check then runs read-only and reports stopped:true — no dispatch, no model turn, exit 0).
Cost control: the timer itself is free (`gh` API only); a model turn
spawns solely for addressed work, one slice, capped by `-PiTimeoutSec`.

## 4b. Repeat-reliability contract (park → wake → work → wake again)

Listening is persistent, not a one-shot: entering `WAITING_HANDOFF`
retains the handoff target, and a wake keeps it (`applyWake` preserves
`handoff_wait`). The inbox timer stays armed while the job is waiting
or working with a retained target, and stands down only on terminal
states, an explicit stop, or process shutdown. A woken seat therefore
does NOT need to remember to re-park — the next handoff wakes it again
(`shouldKeepWatching` in `src/watch.ts`, unit-tested). Finishing or
stopping the mission ends the watch.

Zero-empty-turns rule: timer ticks perform only `gh` fetches and file
heartbeats — no model calls, ever. Only a matched, verified handoff
fires `sendWake` (one turn), or a dispatch slice (one `pi --print`).
Measurement protocol for the joint test: during an agreed quiet window
(>=15 min, no handoffs posted), the seat records heartbeat tick count
from its run record versus session turn count. Acceptance: ticks > 0,
turns == 0. Any model turn with no matching handoff in the verdict log
is a FAIL.

## 4. Three-agent acceptance test (A4 + two peers)

Preconditions: branch under test pushed; peers launched with stable names;
task still DISABLED (manual ticks first).

1. **Quiet tick:** run the check with no new handoffs → verdict has empty
   `handoffs`, nothing dispatched, cursor unchanged. PASS = silence.
2. **Addressed wake:** post one envelope to the scratch/run issue
   (`to=<seat>`, fresh run id). Next tick → exactly one `pi --print` slice
   for that seat, receipt published, cursor advances. Others get nothing.
3. **Wrong recipient / stale / duplicate:** addressed elsewhere, older than
   the seat cursor, or already dispatched → no launch. (Covered by unit
   tests; spot-check on the live board.)
4. **Death:** kill the seat process mid-wait → no wake is faked; roster
   shows stale; mail queues. Relaunch same name+cwd → mailbox flushes,
   session_start re-arms, missed handoff is caught up.
5. **Second wake:** re-park, second handoff → wakes again (the regression
   the repair is named for).

Independent verifier repeats 1–5 from its own seat and posts PASS/FAIL per
step. BUILDER-TESTED until then.
