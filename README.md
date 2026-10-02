# Matthew Way Studio — Autonomous Packet Runtime

Pi behaves as Matthew's ordinary autonomous software workshop.

```text
folder + repo + packet  ->  Pi  ->  finished pushed work
```

Matthew owns intent, genuinely human-only capabilities and final acceptance.
Pi owns procedure. There is no orchestration vocabulary to learn: no `/goal`,
`/resume`, `/worker`, `/plan`, `/milestone` or `/audit`.

## Install

```powershell
cd D:\Projects\matthew-way-studio
npm install
pi install ./
```

`pi install ./` records the package in `~\.pi\agent\settings.json`. Undo with
`pi remove ./`. To trial it in a single session without touching settings:

```powershell
pi --extension .\extensions\index.ts
```

## What changes in ordinary use

| Moment | Behaviour |
|---|---|
| Substantive packet, no active mission | Compiles OBJECTIVE / SCOPE / AUTHORITY / CONSTRAINTS / ACCEPTANCE / ATTENTION, writes durable state, stores the packet verbatim, starts working without asking for plan approval |
| Small request | Stays ordinary work. No project is manufactured |
| End of a turn while `WORKING` | Checkpoints, decides the next action, requests the next turn automatically |
| Genuinely human-only dependency | `NEEDS_HUMAN`: what is needed, why, what is already complete, repo/branch/SHA, next action |
| Ordinary reply to a blocker | Rechecks the real capability instead of trusting the wording, then resumes |
| Completion | `COMPLETE` is refused without machine evidence, a revision and a verified remote SHA; emits the concise receipt |

One footer status line and one notification per mission event. Nothing else.

## Durable state

In the Git common directory, so linked worktrees share one ledger and none of
it is ever committed:

```text
<git-common-dir>/matthew-way-studio/
    active-job.json           # mission snapshot: the reload path
    events.jsonl              # append-only audit trail
    jobs/<job-id>/packet.md   # the original packet, outside the conversation
    config.json               # optional overrides
```

Non-git folders fall back to `<cwd>/.pi/matthew-way-studio/`.

A mission survives context compaction, Pi restart, session restart, model
replacement and child-agent replacement, because none of those hold the truth.

## Model-callable tools

Registered on Pi's ordinary tool surface. Matthew never names them.

- `studio_checkpoint` — milestone, next action, checks, commits, pushed SHAs,
  Lantern usage. Also the sanctioned `NEEDS_HUMAN -> WORKING` edge.
- `studio_blocked` — enter `NEEDS_HUMAN` with one concrete human need.
- `studio_ship` — commit (opt-in), push, verify the remote SHA. Never
  force-pushes, never merges review branches on Matthew or Lucy's behalf.
- `studio_complete` — evidence-gated `COMPLETE | PARTIAL | FAILED` + receipt.
- `studio_status` — read the durable mission after compaction or restart.
- `studio_context` — narrow Lantern retrieval with honest degradation.

## Bounded autonomy

```json
{
  "maxTurns": 60,
  "maxUnchangedTurns": 3,
  "maxErrorStreak": 3,
  "minPacketChars": 320,
  "autoContinue": true,
  "requireProjectTrust": true,
  "lanternMirror": { "mirrorPath": "D:/Projects/lantern-git/mirror", "maxAgeMinutes": 1440 }
}
```

Put overrides in `<git-common-dir>/matthew-way-studio/config.json`.

- The same material failure never repeats blindly: three quiet turns or three
  errors trip a stop-loss that converts the stall into a resumable `NEEDS_HUMAN`.
- A new message from Matthew is external steering, not spinning, so it clears
  the no-progress and error streaks without resetting the run allowance.
- "stop the mission" and "resume the mission" are ordinary sentences.
- Projects that are not trusted stay idle; nothing is written before trust.

## Layout

```text
extensions/index.ts   Pi wiring: lifecycle events + tool registration only
src/schema.ts         job state, status machine, version handling (pure)
src/ledger.ts         atomic snapshot, events, packet store
src/paths.ts          git common dir resolution, command runner
src/git.ts            repo facts, remote SHA verification, push, commit
src/packet.ts         packet classification and contract compilation (pure)
src/mission.ts        every legal transition, completion gate (pure)
src/continuation.ts   stop-loss and run allowance decision (pure)
src/receipt.ts        NEEDS_HUMAN block, completion receipt, mission brief
src/lantern.ts        narrow retrieval adapter with staleness guard
src/config.ts         defaults plus project overrides
src/pi-shim.ts        structural Pi surface (adapter boundary)
```

Rule: `extensions/index.ts` contains no policy. Deterministic modules decide
what is true; the model decides what to do.

## Verification

```powershell
npm test              # typecheck + build + 77 deterministic tests
npm run check:load    # real jiti module load + registration, no inference
```

`npm test` builds disposable Git repositories (including a linked worktree and
a bare remote) to prove `repoFacts`, `verifyRemoteSha`, `pushAndVerify` and
shared-ledger behaviour against real Git. The integration smoke test drives the
actual extension through a stub Pi harness for the four behaviours that matter.

No GUI automation: real dogfood is Matthew's job.

## Relationship to Pi Studio's saved plans

Pi Studio already persists `StudioRun` records (milestones, worker threads,
GitHub checkpoints) through `list_studio_runs` / `save_studio_run`. That is a
different authority: a saved plan for orchestrated, milestone-shaped work.
This runtime does not read or duplicate it. The job ledger is the live mission
state for whatever Matthew just pasted, including work that never becomes a
plan. One is not a copy of the other, and neither invents a second harness.

## Prior art and provenance

- Concepts adapted from [`pi-goal-x`](https://github.com/tmonk/pi-goal-x)
  (MIT, © tmonk): durable goal state, automatic continuation, run allowance, a
  resumable blocked state, and deciding the next turn at the settled boundary
  rather than `agent_end`. No code was copied. Its command surface, scheduler
  phases, token budgets, dashboards and auditor machinery were deliberately not
  reproduced: this product forbids mandatory `/goal` rituals.
- The structural Pi adapter boundary follows the pattern in Matthew's own
  `D:\Projects\PiToRuleThemAll` workshop package.
- Lifecycle vocabulary (`WORKING`, `NEEDS_HUMAN`, `COMPLETE`, `PARTIAL`,
  `FAILED`) follows the MCP Tasks pattern, renamed for humans.

## Human dogfood

1. Open Pi in a project folder that has a GitHub repository.
2. Paste one real software packet into the ordinary composer. No command.
3. Confirm one `studio: mission … started` notification and a footer status
   line, then let it work without typing "continue".
4. Say "stop the mission" mid-run, then "resume the mission".
5. Let it finish and check the receipt reports a verified pushed SHA.
6. Report whether it felt like an ordinary workshop run rather than a new
   orchestration system.
