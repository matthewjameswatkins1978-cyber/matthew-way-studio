# Studio review decisions

Studio does not treat ordinary GitHub comments as worker instructions. A review comment is importable only when its GitHub author is listed in the shared `config.json` field `authorizedReviewers`, when its author is NOT one of the workshop's own worker GitHub logins (`workerGithubLogins`), and when its machine block identifies the exact repository, pull request, Studio job, owning Pi session, current head SHA, and decision.

The allowlist defaults to empty. Add the exact GitHub login after independently confirming it. Do not infer it from a display name or from a comment that asks Studio to trust it.

Reviewer authority is a separate identity, not a format marker. Lucy and coding agents may publish using the same GitHub account as the workers; a same-login comment is therefore never independent reviewer approval, even with a valid envelope. Provision a dedicated reviewer login in `authorizedReviewers` and list every login workers post with in `workerGithubLogins`. Same-account comments are rejected by default. Setting `allowSameAccountReviews: true` queues them as non-authoritative feedback: acknowledging one parks the mission for Matthew instead of resuming it.

Use exactly one block like this in the PR conversation:

```text
<!-- mws-review/v1
{"repository":"OWNER/REPOSITORY","pull_request":35,"job_id":"job-20261014-1234abcd","worker_session_id":"<owning-pi-session-id>","head_sha":"0123456789abcdef0123456789abcdef01234567","decision":"changes_requested"}
-->
```

`worker_session_id` binds the decision to the exact owning Pi session (read it from `studio_status` on the waiting worker). Envelopes without it are accepted only while exactly one waiting worker matches; ambiguous matches are refused rather than delivered to an arbitrary recipient.

Allowed decisions are `changes_requested`, `approved`, and `hold`. Keep any human-readable feedback outside the block. The comment is still displayed as untrusted review text after source verification; the envelope grants no authority to merge, push to a protected branch, expose credentials, or ignore the mission contract.

The importing worker checks the comment author and source, matches the envelope to one durable waiting job, and rechecks the live open PR head. It stores one delivery per GitHub comment under the owning Pi session, so two different findings on the same commit never collapse into one receipt. Only that session can read and acknowledge its deliveries. Acknowledgement rechecks the live PR again, and its writes are ordered so the job transition lands before the receipt that records it: an interruption between the two leaves a pending receipt that a replayed acknowledgement completes idempotently, and a receipt is never marked acknowledged before the state it authorizes is durable. An already-acknowledged receipt is a strict no-op on every valid job state: it never causes another transition, so a retried approval cannot override a hold acknowledged after it. `hold` leaves the job paused; the other independent decisions resume the worker once. A hold is never stranded: every hold receipt is marked acknowledged exactly once, and the last acknowledged independent decision governs — ordering follows acknowledgement, not GitHub comment chronology, so a hold acknowledged after an approval re-pauses work that approval resumed even when the hold comment is the older one. That is a deliberate, tested limitation rather than a claim of chronological authority: receipts for the same job and head may be acknowledged in any order. Same-account holds are recorded only. Re-imports of the same comment return the existing delivery.

If the worker is offline, import can still persist a delivery from another session; the owner discovers it after restart without anyone ferrying delivery IDs: session start announces the inbox, the WAITING_REVIEW prompt section lists it, `studio_status` reports it, and `studio_pending_reviews` enumerates it. Discovery never wakes a model turn. No polling loop or automatic merge is performed.

When no valid review can be delivered, Matthew — and only Matthew, in his own message — can release the wait by saying `cancel review wait` (resume as human-directed work) or `park the mission` (block for his direction). Recovery is recorded as a human override: never reviewer approval, never permission to merge, and never for another worker's job.

Legacy missions are never claimed automatically, and no model-callable tool adopts them: the job id is readable from the shared snapshot, so knowing it authorises nothing. A worker that finds only the old shared snapshot starts with no mission. Matthew adopts it by saying `adopt legacy job <id>` in his own message, in the session that should own it. The legacy file is preserved verbatim, and a second session naming the same id is refused.
