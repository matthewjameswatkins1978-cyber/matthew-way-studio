# Matthew Way Studio — repository instructions

Pi package that turns an ordinary pasted packet into a durable, autonomously
continued, evidence-checked mission.

## Read first

1. `README.md` — product contract, install, dogfood steps.
2. `extensions/index.ts` — the only Pi-facing file.
3. `src/` — deterministic core. Each module is pure and independently testable.

## Invariants for anyone (human or agent) working here

- **No orchestration vocabulary.** Never add a mandatory slash command, DSL,
  dashboard, or second agent harness. Matthew pastes a packet; Pi owns
  procedure.
- **Deterministic spine.** Policy that can be computed must not be delegated to
  a model. State transitions, progress detection, stop-loss, packet
  classification, Git verification and receipt rendering stay in `src/*.ts`.
- **`extensions/index.ts` contains no policy.** It wires Pi events and tools to
  pure functions. If a rule appears there, move it into `src/` and test it.
- **Evidence outranks narration.** `studio_complete` must stay refused without
  machine evidence, a revision, and a verified remote SHA. Do not weaken the
  gate to make a demonstration pass.
- **Authority, attention, acceptance stay separate.** `NEEDS_HUMAN` is only for
  a genuinely human-only dependency, never for inconvenience.
- **Pi API surface goes through `src/pi-shim.ts`.** The core must not import Pi
  types, so a Pi upgrade can break at most that file.
- **Do not commit operational state.** The ledger lives in the Git common
  directory by design.
- **Lantern is contextual memory.** Never treat the `lantern-git` mirror as
  current repository truth, and do not couple Studio internals to Lantern's
  storage shape.
- **CI spend is a budgeted resource.** CI proves what the project currently
  ships, not hypothetical future platforms. On private repositories, default to
  the smallest useful Linux CI. Do not add macOS or Windows hosted runners,
  cross-platform matrices, packaging, release builds, scheduled/nightly jobs,
  or other expensive hosted work unless the current mission explicitly requires
  that platform or release path.
- **Do not pay twice for one change.** Feature branches should normally be
  validated by PR CI, with push CI reserved for the integration branch. Use
  workflow concurrency with cancellation where newer commits supersede older
  checks. Batch coherent work before pushing rather than using remote CI as an
  edit/test loop.
- **Prefer local platform evidence.** When Matthew's Windows machine can verify
  Windows/desktop behaviour, use that local evidence during development. Hosted
  platform packaging and release verification should be deliberate/manual until
  the platform is an actual release target.

## Working rules

- Reuse maintained tooling and existing project patterns before adding
  machinery. Check `D:\Projects\PiToRuleThemAll` for the workshop's established
  Pi package conventions before inventing a new one.
- Keep the agent count at one unless independence or parallelism is genuinely
  demonstrated.
- Change nothing in Pi core. Supported extension APIs only.
- Preserve unrelated work in any repository this runtime operates on.

## Verification

```powershell
npm install
npm test              # typecheck + build + deterministic suite + git-backed tests
npm run check:load    # real jiti load + tool registration, no inference
```

`npm test` needs `git` on PATH. Git-backed tests create disposable repositories
with bare remotes in `%TEMP%`; they never touch a real remote.

Before finishing any change here: run the suite, then
`studio_ship`/`git push` and verify the remote SHA. Report tests actually run.
