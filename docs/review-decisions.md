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

The importing worker checks the comment author and source, matches the envelope to one durable waiting job, and rechecks the live open PR head. It stores one delivery per GitHub comment under the owning Pi session, so two different findings on the same commit never collapse into one receipt. Only that session can read and acknowledge its deliveries. Acknowledgement rechecks the live PR again. `hold` leaves the job paused; the other independent decisions resume the worker once. Re-imports of the same comment return the existing delivery.

If the worker is offline, import can still persist a delivery from another session; the owner discovers it after restart without anyone ferrying delivery IDs: session start announces the inbox, the WAITING_REVIEW prompt section lists it, `studio_status` reports it, and `studio_pending_reviews` enumerates it. Discovery never wakes a model turn. No polling loop or automatic merge is performed.

When no valid review can be delivered, Matthew — and only Matthew, in his own message — can release the wait by saying `cancel review wait` (resume as human-directed work) or `park the mission` (block for his direction). Recovery is recorded as a human override: never reviewer approval, never permission to merge, and never for another worker's job.

Legacy missions are never claimed automatically. A worker that finds only the old shared snapshot starts with no mission; Matthew names the exact legacy job id to the owning session, which adopts it once with `studio_adopt_legacy`. The legacy file is preserved verbatim.
