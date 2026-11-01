# Issue 376 — Windows gates and recovery, credential, permission boundaries

## Accepted scope

2026-11-01. The user approved implementing the first batch of the audit follow-up in the independent `codex/llm-provider-parity` worktree, starting from `4606eda91723e7c3ddee1b97bf26104fdb41fee0`. The source audit used `866d1bdb8`; its original untracked reports belong to another thread and remain untouched. No Main merge, push or release is included in this batch.

The first batch covers Windows platform selection (F02/F03), config/owner publication and migration cleanup (F05/F06/F07), non-authoritative execution statistics (F08), confirmed file/queue corruption boundaries (parts of F09), provider-local bootstrap and native credentials (F10/F11), native Anthropic OAuth signature handling (F12.3), the wrong plan recovery tool name (F17), and SDK shell/Memory permissions (F22/F23). Model catalog/pricing, learned Skill integration, cache layout and broad dead-code cleanup remain separate work.

## Regression seams

- Windows source selection discovers platform-dependent test files, including early-return branches, instead of relying on a manually maintained workflow file list. Portable and system lanes are disjoint; heavy process tests stay serial. Existing opt-in native, Electron and paid-provider boundaries remain explicit. Release publication still requires CI.
- Config saves preserve all existing fields, legacy credentials and explicit selections. Publication failure leaves original bytes intact; stale unknown locks do not authorize writes. Core and integration lock pathnames remain compatible with existing cooperating writers.
- An unreadable config cannot be safely merged or used as default account selection, so CLI/SDK execution and config patches reject and preserve its raw bytes. Only an actually missing entry permits first-use defaults. Normal file symlinks retain their target; dangling links remain intact and fail closed. A live Host can still report `persistedConfig.state: invalid`, then reread the original provider after repair; cold Host initialization is retryable too. Normal valid legacy config/env entry points remain supported.
- Static Windows provisioning programs moved to a packaged data resource to recover CLI budget headroom without changing their runtime bytes. Both source regression hashes and the lazy production loader validate the audited SHA-256; missing/changed data fails explicitly before PowerShell execution. Real tar/zip archive tests require all five runtime JSON resources and caught older omissions of both `static-text.json` and `generated-config-templates.json` from standalone archives.
- Owner files are completely written and synced before exclusive publication. Write/fsync/publication failures must not strand an empty authoritative lock. Dead-owner reclamation uses one non-transferable deletion claim per generation. A delayed reclaimer cannot delete a replacement owner. A crashed reclaimer or unidentifiable old lock is diagnosed and stays fail-closed; it is never reclaimed on TTL alone.
- Completed Session migration can retry journal/lock cleanup. Live or unknown migration owners stay protected even when a heartbeat is old. Stable read APIs remain read-only; startup migration performs the repair. No Session message, branch, sidecar or tool original may be replaced with empty data after a failed read.
- Statistics storage is a projection, not execution or replay authority. Its corruption must not prevent a healthy provider operation or replace that operation's outcome. Original unreadable/future-version bytes stay intact, coverage is partial and gaps are visible. Unknown execution must never become permission to replay a side effect.
- One corrupt pending-input file blocks only its Session's work admission; other Sessions recover. Unknown queued intent/principal remains on disk and cannot be silently treated as an empty queue. Repair requires reconnecting to the Host so the original inputs are restored and rebound by their principal.
- Extension persistence never writes from a corrupt/partial/empty fallback baseline. Unreadable durable agent event ledgers fence only their tasks, retain raw/snapshot state, and do not prevent healthy task recovery or dispatch new remote effects for the unknown task.
- Missing/revoked/wrong-profile OAuth registrations do not fall back to API keys or another account. A healthy credential source remains usable. Initialization is single-flight and retryable after failure, and source invalidation still fences every active lease. Saved keys, supported environment keys and proxy endpoints preserve their established precedence and approved connection binding.
- Native Anthropic API-key clients do not inherit an unrelated ambient Bearer token. Native Anthropic OAuth never fabricates empty thinking signatures; readable foreign reasoning, valid same-account signatures, tools and cross-model history remain usable. Third-party compatibility routes keep their own signing semantics.
- Without a prefix extractor, only unambiguous single-command literal token prefixes can auto-authorize. Compound, redirected, substituted and cross-shell ambiguous commands use the existing confirmation path. Bare explicit `Bash` remains an explicit all-shell grant. No extra model request is added.
- Governed Memory stays readable, and legitimate Control Plane writes still work. OS sandbox policy denies writes to scoped and concrete legacy Memory roots. Host execution checks obvious direct Memory mutation targets at direct-host and sandbox-fallback boundaries. Full Access remains arbitrary trusted Host execution: indirect opaque programs are not represented as OS-isolated or as having F228 apply authority. See ADR-069 and `features/v0.7.68.md:221-229,1382-1387`.

## Baselines and validation record

Baseline built-artifact Windows recovery, before production edits:

| Fixture | Ready / read latency |
| --- | --- |
| 512 missing-identity/reused-PID/incomplete records | generation 1: 2,043 ms; generation 2: 1,398 ms |
| 220 exited trees with concurrent resume clients | cold: 2,447 ms; first history reads: 44 ms; restart: 1,491 ms |

Baseline source execution-facts write cost, same machine and temporary local storage:

| Requests | Events | Elapsed |
| --- | --- | --- |
| 50 | 100 | 510 ms |
| 250 | 500 | 2,672 ms |
| 1,000 | 2,000 | 12,554 ms |

These are observations, not universal SLAs. Compare equivalent fixtures after the changes; use deterministic query-count assertions to distinguish startup algorithm regressions from machine contention. Do not increase production timeouts to hide a regression.

Candidate built-artifact recovery (same fixtures, no concurrent build/test load): 512 records generation 1/2 ready in 2,107/1,547 ms; 220 trees ready in 2,495 ms, concurrent history reads 45 ms, restart 1,489 ms. No per-record helper startup or production timeout increase was introduced.

An idle paired source comparison re-read the exact baseline `4606eda9` projection implementation (only its unchanged liveness import relocated to the source tree): 50/250/1,000 requests took 497/2,825/13,718 ms. The final candidate took 510/2,925/13,627 ms. Required data checks remain; replacing per-row temporary key arrays/closures with direct checks removed the first candidate's visible large-history overhead. These single-machine samples do not establish zero overhead or model intelligence quality.

Windows discovery and the actual Vitest lane lists agree on 149 files: 133 portable, 16 system, union complete and overlap zero. Node discovery/archive tests pass. The first development full run was not acceptance: parallel edits/builds produced stale module/build failures, and it also exposed a stale mock, two outdated assertions, an npm mirror miss and cold semantic-budget contention. A frozen run at tree `fadf1bdd6e79536b8c9f16298039572cea39ac6e` then passed all 1,378 files: **19,006 passed, 87 skipped, 0 TODO**. Subsequent scanning added core-config CLI/SDK rejection, migration double-fault propagation, Windows Home-alias direct-target checks and the template archive regression; final full acceptance for that delta is pending below.

Other completed checks: build/typecheck and standalone SDK declarations; historical owner cutover 3/3; real integrity-pinned alpha.11 busy Host upgrade 1/1; Rust parent suites 122 passed, 3 helper entries ignored (invoked by parent tests), plus binding/manifest smoke. Final bundled, coverage and review results are recorded below; earlier counts are historical observations, not substitutes for the final result.

Explicit boundaries: local real Windows Memory acceptance was attempted but stopped at verify-only `doctor.ready === false` because the shared `.claude.json` setup capability is missing/unsafe. No shared setup, account/ACL reset, marker rewrite or user Host shutdown was performed. The dedicated CI native step runs after its isolated runner setup. The regular suite skips that opt-in, platform/backend and paid/live probes; no live provider/OAuth account acceptance is claimed. File-symlink creation is skipped locally when Windows privilege is absent. OS masks cover scoped Memory and concrete legacy roots present at admission; future legacy roots created inside opaque programs are not a claim of perfect path isolation. Arbitrary trusted Full Access code remains outside OS isolation.

## Final offline acceptance — 2026-11-01

Final production/test review tree: `9a2370605fedab491f940c0b42f5f95dc9a1c96c`, against base `4606eda91723e7c3ddee1b97bf26104fdb41fee0`. Only acceptance documentation changed after this tree; no code/build changes ran during the final full suite. The independent branch remains `codex/llm-provider-parity`; Main stayed at the base and the peer's three untracked files were untouched. No merge, push, version bump, Space change or publication was performed.

| Check | Final result |
| --- | --- |
| Full source, default Vitest configuration on Windows | 1,378 files; **19,012 passed, 0 failed, 87 skipped, 0 TODO** (19,099 cases) |
| `npm run test:bundle` | **92 passed**, 0 failed/skipped/TODO |
| Build / typecheck / SDK declaration consumers | Passed |
| Windows discovery + real tar/zip inventory | Passed; 149 lane files, all five JSON resources present |
| Historical cutover / actual alpha.11 busy upgrade | 3/3 and 1/1 passed, respectively |
| Rust native + binding/manifest checks | Passed as recorded above; native Memory prerequisite remains blocked |
| Scoped lock/CLI-credential/statistics coverage | Statements **89.94%**, lines **94.71%**, functions **92.95%**, branches **76.66%**; not whole-repository coverage |
| CLI strict budget | **5,173,836 bytes**, limit 5,177,344; 3,508 bytes headroom, no limit increase |

The accepted CLI SHA-256 is `62371f49e7c9b1460498f9f62f4b5aa4b90a06efc00b4cb0cdc31373f92aa935`.
The full suite used the official npm registry only through its child-process environment after the configured mirror lacked an available transitive package; no user npm configuration or dependency version was changed. Layer-1/fake-fetch tests are not live provider or model-quality evaluations.

The post-implementation scan found and closed the migration double-fault swallowing, CLI/SDK invalid-config default selection/overwrite, direct Windows Home-alias Memory targets, and missing template sidecar. Cold Host retry, live Host diagnosis and repair, zero provider dispatch on invalid configuration, retained bytes, healthy Session/task recovery and unchanged read/copy behavior have executable regressions.

## Standards

Final independent review: **0 written-standard findings; 0 actionable smells**. Cleanup error/cause retention and final configuration/alias/archive delta were reviewed separately after the original findings were fixed. Static review does not certify the blocked native environment.

## Spec

Final independent review: **0 missing/partial requirements, 0 scope-creep findings, 0 incorrect-implementation findings** within the accepted batch. Valid legacy/env entry points, account/source binding and Host lifecycle remain covered; the native and future-legacy-root limits above remain explicit.

## Exact final skipped-file inventory

These are actual skips, not TODOs and not passes. Default Vitest also excludes paid provider integration files; those exclusions are not included in this count.

| File | Skips | Condition |
| --- | ---: | --- |
| `src/sandbox-runtime.posix-readiness.test.ts` | 1 | POSIX backend |
| `src/sandbox-runtime.test.ts` | 27 | Platform/backend matrix |
| `src/windows-native-artifacts.test.ts` | 2 | Unix state boundary |
| `src/windows-text-transaction.test.ts` | 1 | Other-platform native path |
| `tests/feature-295-posix-shell-policy.test.ts` | 4 | POSIX isolation |
| `tests/feature-295-windows-v2-policy.test.ts` | 25 | Explicit real Windows sandbox opt-in |
| `tests/windows-governed-memory.test.ts` | 1 | Explicit real Memory opt-in; local doctor prerequisite failed |
| `tests/first-turn-compact-complex-live.test.ts` | 1 | Authorized live experiment opt-in |
| `tests/late-reminder-factorial.test.ts` | 4 | Provider experiment opt-in |
| `tests/original-version-probe.test.ts` | 1 | Paired capture opt-in |
| `tests/original-version-smoke.test.ts` | 1 | Historical observation opt-in |
| `src/runtime-daemon/process.owner-exit.test.ts` | 1 | Linux zombie semantics |
| `packages/artifacts/src/browser-formats.test.ts` | 7 | Explicit browser executable |
| `packages/artifacts/src/pdf-render.test.ts` | 1 | Explicit browser executable |
| `packages/artifacts/src/render.test.ts` | 4 | Explicit browser executable |
| `packages/agent/src/learning/learned-skill-driver.test.ts` | 1 | POSIX behavior, not an unimplemented test |
| `packages/agent/src/runtime/process-tree.test.ts` | 2 | POSIX identity/signaling |
| `packages/repl/src/common/core-config-lock.test.ts` | 1 | Windows file-symlink privilege unavailable |
| `packages/repl/src/common/setup-config.test.ts` | 1 | POSIX modes |
| `packages/coding/src/permissions/permission.test.ts` | 1 | POSIX path behavior |
| **Total** | **87** | **0 TODO** |

Implementation and offline acceptance are complete for this batch. Native Memory OS acceptance and remote CI execution remain unverified; the shared environment was not changed to force them green. Keep those prerequisites visible when integrating or releasing.

## Main integration follow-up — 2026-11-01

The user authorized merging this batch and requested that subsequent fixes use
the `KodaX` branch directly in `C:/Works/GitProj/KodaX-AI/KodaX`, without another
feature worktree. Main fast-forwarded from `4606eda9` to `2ee4a782` without
conflicts; the reviewed production tree is unchanged. The three pre-existing
untracked audit/scratch files were preserved, and the design submodule remains
at `8574086208d6b5cc6ff6599c825fe88d986c4dd0` with no local changes.

Main's own dependency links, build and typecheck passed. Its rebuilt distribution
passed the three historical cutover cases and the integrity-pinned alpha.11 busy
Host upgrade. CLI size remains 5,173,836 bytes. The existing full source result
above applies to the identical production/test source; another full source run
was not substituted for validating the rebuilt Main distribution.

The first Main bundled run passed 91/92: `bundled-shell-cleanup.test.mjs` reported
a cleanup failure, but its wrapper hid the original assertion message. The fixture
was retained at `%TEMP%/kodax-bundle-cleanup-1gcO1c`. On inspection both recorded
PIDs were absent and its child registry was empty; that later observation alone
does not establish their state at the failing assertion. No processes were killed
based on those old PIDs. An isolated replay, eight concurrent isolated replays,
and a complete Main bundled replay all passed; the latter was **92/92**, with no
skips or TODOs. Failure wrapping now includes the original error message while
retaining its cause and fixture. Assertions and production cleanup code were not
weakened or changed. Root cause remains unconfirmed; do not describe it as a fixed
leak, proven PID reuse, or a proven timing-only failure.

Main logs are in OS temporary storage under `kodax-issue376-main-{build,typecheck,
bundle,bundle-diagnostic,cutover,upgrade}.log`; isolated stress records use
`kodax-issue376-cleanup-stress-0.log` through `-7.log`. No source/build mutation
ran during the bundled replays. No push, publication, shared sandbox setup,
credential replacement or user Host shutdown was performed. The native Memory
prerequisite remains unchanged and unverified as described above.
