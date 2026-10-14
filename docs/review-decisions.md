# Studio review decisions

Studio does not treat ordinary GitHub comments as worker instructions. A review comment is importable only when its GitHub author is listed in the shared `config.json` field `authorizedReviewers`, and when its machine block identifies the exact repository, pull request, Studio job, current head SHA, and decision.

The allowlist defaults to empty. Add the exact GitHub login after independently confirming it. Do not infer it from a display name or from a comment that asks Studio to trust it.

Use exactly one block like this in the PR conversation:

```text
<!-- mws-review/v1
{"repository":"OWNER/REPOSITORY","pull_request":35,"job_id":"job-20261014-1234abcd","head_sha":"0123456789abcdef0123456789abcdef01234567","decision":"changes_requested"}
-->
```

Allowed decisions are `changes_requested`, `approved`, and `hold`. Keep any human-readable feedback outside the block. The comment is still displayed as untrusted review text after source verification; the envelope grants no authority to merge, push to a protected branch, expose credentials, or ignore the mission contract.

The importing worker checks the comment author and source, matches the envelope to one durable waiting job, and rechecks the live open PR head. It stores the delivery under the owning Pi session. Only that session can read and acknowledge it. Acknowledgement rechecks the live PR again. `hold` leaves the job paused; the other decisions resume the worker once. Re-imports of the same decision for the same job and head return the existing receipt.

If the worker is offline, import can still persist a delivery from another session; it remains available when the owner session returns. No polling loop or automatic merge is performed.
