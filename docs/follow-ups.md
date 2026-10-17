# Follow-ups

Tracked gaps that are deliberately not fixed in the current revision. Each entry
names the observed behaviour, the intended direction, and the constraint that
kept it out of the shipped change.

## 2026-10-17 — Concurrent stale-lock takeover (claim lock)

Location: `src/ledger.ts`, `withClaimLock` (claim-lock steal path).

When a claim lock's holder is provably dead, every waiting process may decide
to steal it at the same moment: each calls `fs.rmSync(lock, { force: true })`
and then retries the acquire. The loser's `rmSync` can delete the winner's
*freshly created* lock, which silently breaks mutual exclusion and can split
ownership of a claim acquisition.

Intended direction: make the steal atomic — e.g. `renameSync(lock,
lock + "." + randomToken)` and only the rename winner deletes the renamed file;
losers observe the rename failure and retry the acquire. Alternatively, re-check
the holder under a second exclusive create before deleting.

Constraint: this was left unfixed because validating competing stale-lock
recovery requires a multi-process race against real lock files, and the
controlled dogfood explicitly forbids testing competing stale-lock recovery
against live data. Covered indirectly today by: dead-holder steals succeed,
live holders are never stolen, unprovable holders fail closed with a recovery
diagnostic, and all lock retries are deadline-bounded.
