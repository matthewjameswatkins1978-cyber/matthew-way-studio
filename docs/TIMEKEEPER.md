# Timekeeper — workshop agent shift log

One deterministic projector over the Studio host event stream. No model
calls, no polling, no new service. The extension owns two extra events;
everything else is a pure fold of `events.jsonl`.

## What it records

- **Clock-in** — `mission-start` (accept), `renewed` (resume, session
  restart), `handoff-wake` / `timekeeper-wake` (wake, with trigger + waker).
- **Waiting / blocked** — `handoff-wait`, `review-wait` (state, shift stays
  open), `needs-human` / `stop-loss` (blocked with the recorded need).
- **Clock-out** — `complete`, `mission-parked` / `mission-switch` (park),
  `session-shutdown` (interruption, known).
- **Gaps** — `timekeeper-interruption` (turn error/abort), stale heartbeat
  (no contact past 15 min → UNKNOWN), crash (no close event → open shift
  goes stale, never billed).
- Retransmits and out-of-order delivery dedupe by stable event id; replay
  of the same stream always yields the same roster and totals.

States: `WORKING · WAITING · BLOCKED · CLOCKED_OUT · UNKNOWN`. A waiting
agent that retains job ownership is WAITING, never "available". Working
time is wall-clock time in the working state — never inference time,
never cost. Compute/cost ride in a separate slot that stays `unknown`
until TAXI (or a reported total with provenance) fills it.

Timestamps are stored UTC ISO (host clock) and displayed UK local
(`Europe/London`, DST-aware): `HH:mm:ss UK`, with date when the London
day differs.

## Commands (read-only)

- `/timekeeper status` — live roster; also refreshes
  `timekeeper.roster.json` / `.md` in the ledger directory.
- `/timekeeper today` — per-agent working/waiting/blocked totals for the
  current London day.
- `/timekeeper history` — recent shifts with intervals, flags and
  duplicate-suppression counts.

Disable without touching the ledger: `STUDIO_TIMEKEEPER_ENABLED=0`.

## Files (all inside the existing ledger directory)

- `events.jsonl` — shared host stream (two extra `timekeeper-*` types).
- `timekeeper.roster.json` / `.md` — bounded machine/human roster, same data.
- `timekeeper.snapshot.json` — last archive point: files, digests, open shifts.
- `timekeeper-archive/events-YYYY-Www.json.gz` (+ `.sha256`) — weekly
  archives of long-closed shifts only. Replay archived + active lines and
  the roster is identical. Open shifts, recent history and unattributed
  events are never archived.
- `timekeeper.pending.json` — queued publish payloads while offline.

## Publish (so Lucy can read it)

At a real checkpoint the owning agent posts the compact roster:

1. Refresh: run `/timekeeper status` (rewrites the roster files).
2. Post the one-paragraph summary + `as_of` + checksum to the agent's
   **own** Workshop Board outbox (`board_send`), or write the compact
   note via Basic Memory (`bm_write`). Never append transcripts; the
   roster files are the detail layer.
3. If the transport is unreachable, `queuePendingPublish` keeps the
   payload in `timekeeper.pending.json`; flush on the next checkpoint.
4. Verify by reading back (`bm_read` / board cursor): a receipt without
   a read-back is a claim, not a publication.

## Install / remove

Ships with the Studio extension — no package, no scheduler, no global
install. Remove by deleting the branch, or disable per session with the
env flag above. Archive files verify with
`sha256sum -c timekeeper-archive/*.sha256` and decompress with `gunzip`.

## Known limitations (honest, not roadmap promises)

- TAXI is not connected in this workshop: compute/cost display as
  `unknown` and are never inferred from shift time.
- Outgoing Intercom wakes are attributed from the receiver side only
  (sender display + cwd from the broker frame); the sender's session
  cannot observe its own tool calls deterministically.
- A crash with no shutdown event surfaces as UNKNOWN-after-stale, not a
  timed close: the gap is flagged, never billed, and the next resume
  opens a new shift for the same job.
- Intercom frame parsing matches the installed `pi-intercom` broker
  format (`**From <sender>** (<cwd>)`, customType `intercom_message`);
  an older broker that delivers differently records `unknown` source
  rather than a fake wake.
