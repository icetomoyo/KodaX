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
| CLI build budget | **5,173,836 bytes**, limit 5,264,384; 90,548 bytes headroom, no limit increase |

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

## Subsequent Main audit repairs — 2026-11-01

Source baseline: `68a02521c`; direct `KodaX` work was authorized by the user.
The original untracked audit reports remain author-owned and unchanged.

### Repaired seams and intentional limits

- F13–16/F20: verified model context/output ceilings and rates, exact default
  Codex ID, current generic Skill aliases, DeepSeek Pro text-only vs Flash image
  input. Default output budgets, account/route selection and fixed IDs remain.
  Model-level modality affects actual requests and prompt-cache hashes together,
  preserving canonical history. Nullable pricing bands and measured Kimi cache
  write partitions are covered; unknown GLM price and unknown TTL stay unknown.
- F21a/F41: SDK/Product explicit Skill activation uses existing policy/hooks;
  history restore and extension hydration must precede executable hooks. AMA Root
  learned Skills gain admission/catalog/outcome/release parity with SA. Failed or
  cancelled work is inconclusive; release belongs to Host-awaited Memory work and
  precedes completion. Both currentAgentId and parentAgentId exclude child work.
  Empty stores avoid foreground initialization; full formal-name protection is
  discovered when a review actually commits a learned Skill. No extra model calls.
- F24–26/F29/F32–33: one producer capability-facts module with independent client
  minimums; SDK entry inventory comes from package exports and validates built
  JS/types, including the independent Artifacts subtree. Node-free Client and
  public examples compile. Storage/transport design indices and Root/Space
  handoff reflect actual contracts; historical ADRs are not rewritten as releases.
- F44/F45: move retention and custom root help behind information-command handling;
  bad JSON no longer blocks help/version/doctor. Actual CLI tests cover empty,
  truncated and trailing-comma config, and ensure execution still rejects without
  changing retained files. Doctor reports syntax offset without parser snippets,
  inventory only at known default locations, stops at ancestor aliases, and
  never opens credential payloads or reclaims unknown locks. Core/integration
  conflicts name the exact retained lock. See offline recovery below.
- F40: offline snapshots reproduced overwriting the pinned root birth identity
  before Node receives exit. Fix pins the initial identity, merges same-generation
  exact descendants/uncertain fences, and preserves incomplete-tree unknown.
  Cases cover PID reuse, exited intermediates, unknown identities, snapshot
  failure and existing final-snapshot performance. This does not introduce Agent
  dependencies into the standalone LLM package or claim a new per-command Job.
- F21: additive explicit `inspectToolOutputStorage` and per-root GC cooldown make
  maintenance inspectable. It is not global automatic GC. Cleanup requires all
  shared writers stopped and the complete reference closure, including SDK roots,
  manifests and streams. Unknown scope must retain output; startup TTL deletion
  and foreground global history scans remain removed.

### Safe offline repair for retained historical locks

Run `kodax doctor --json` even if core JSON is invalid. Repair invalid syntax in
the original file, retaining every provider/account field; never substitute an
empty default. The syntax probe is not full configuration-schema acceptance.
Retained lock presence does not establish abandonment, and process age/PID alone
does not authorize reclamation. For unknown/empty locks or interrupted reclaim
claims: stop **all** CLI, Host, external SDK and older-version writers sharing the
storage; back up that storage; quarantine only the exact diagnosed lock and its
matching reclamation claims, retaining their original bytes for inspection.
Do not remove config, auth, sessions, migration journals, task/event logs or
provider registrations. Reopen after repair and verify the same selected account.
Custom SDK `sessionsDir`/credential backends are outside doctor's default inventory
and require the same separate offline inspection. A live task is not eligible.

### Performance evidence and remaining acceptance

The fake-provider managed-entry benchmark asserts exactly 14 provider callbacks
for 2 warmups + 12 measured turns and makes no network/model requests. Initial
eager learned-store setup added avoidable foreground work; the lazy empty-store
path removed it. Paired runs vary substantially with Windows/Git process startup:
the instrumented candidate median was 258.97 ms, prior built baseline 292.69 ms;
other pairs ranged baseline 257.12–345.53 ms and candidate 303.48–394.69 ms before
the final child guard. These are mechanism/variance observations, not statistical
proof of no overhead. The confirmed extra child Git remote probe is now excluded
by both child identity forms. Formal protection remains at actual commit.

The historical source build gate at `68a02521c` was 5,264,384 bytes, but the
published manual/budget suite retains the stricter `5 MiB - 64 KiB = 5,177,344`
limit. The first follow-up guide listed only the build gate and missed this
stricter reserve; the first bundled follow-up exposed the mismatch. Both gates
now enforce the stricter 5,177,344-byte limit. No budget was raised or test loosened.
The existing shared ASRT broker template moves into the already-packaged audited
program resource, with eight literal substitutions and lazy one-time assembly.
The static template hash is `b0ef25b6284fc6a7fcc57a6fea215e48e2554b6ba8e07c058f7d544224fe4d18`;
an emitted-program fixture matches the original `68a02521c` bytes and verifies
literal `$&` handling and one cached load. Existing archive names remain.

The earlier intermittent Shell cleanup assertion remains unexplained. Sixty
isolated current-distribution replays at concurrency four passed; they do not
prove a root cause or authorize weakening cleanup assertions. Native Memory
verify-only acceptance still fails its shared-environment filesystem-capability
prerequisite (`windows_v2_setup_required`); no shared setup/ACL/account was changed.

F08 full execution-fact JSON growth is a real scaling debt; existing paired
measurements did not show a newly introduced severe regression. Append/checkpoint
storage needs its own durable compatibility and crash/latency design, not a
blind persistence rewrite. F09 retained corrupt logs remain fenced and must be
repaired offline; a trailing malformed line is not permission to replay unknown
effects. F18 actual cache benefit, live OAuth/cloud accounts and full Claude 5.5
preserved-prefix protocol remain unverified/unfinished, not claims of this batch.
Broad public SDK/dead-code deletion proposals are not treated as confirmed runtime
bugs. The production-byte F46 next-action eval is separate from mechanical tests;
no model-quality equivalence is implied by the offline suite.

### F46 controlled wording pilot and semantic reading

`tests/issue-376-plan-exit.eval.ts` captures the full production base system and
tool definitions, projecting the actual managed tool wording where applicable.
Pinned pre-change descriptions/denial text come from `2ee4a782d^`. This is a
next-action probe, with no execution of model tool calls or free-running Agent;
it is not an entire AMA prompt/lifecycle acceptance.

The initial pilot completed 8 top-level cells: `zhipu/glm52` and `ark/v4flash`,
ready/denied-write cases, baseline/candidate once each. All raw inputs/outputs
remain in OS temp `kodax-plan-exit-eval-gWsnMU`. Observed usage totals were
153,065 tokens (152,431 input, 634 output), with 41,984 cache-read tokens.
The conservative no-cache nominal estimate is about USD 0.0042, not a subscription
bill or a verified external spend. This historical runner did not record physical
retry counts; eight completed cells do not prove an eight-physical-request limit.

Primary and independent Spec review read all eight outputs. Ready cases submit
`exit_plan_mode` in all four observations, with equivalent plans and no write
calls. Denied-write cases all choose `read`; missing file facts make that sensible,
so the recovery dimension is **inconclusive / no discrimination**, not a failure
or a passed approval-recovery chain. One observation per cell and non-blind review
do not establish intelligence equivalence. Candidate always ran second and had
more cache hits; duration/token differences are not a performance comparison.
Narrow recommendation: retain the canonical tool-name correction and actual Host
approval fence, without claiming global quality improvement.

Review then hardened the rerunnable driver: `singleAttempt`, per-cell one and
total eight physical fetch gates, one round, 2,048 output tokens/call, 200,000
total observed tokens and USD 1 estimated spend, 45-second last-resort timeout.
Unknown usage/rate or reached limits stop further dispatch; all dispatched work
settles and raw completion/failure evidence is retained. The strengthened runner
was reviewed and loaded with opt-in off; it was not paid-rerun to chase parity.
If revisiting recovery, make a separate revision with already-read file facts and
test only that dimension rather than extending this pilot until it turns green.

### Regression findings closed before final acceptance

The first frozen full follow-up run was **not acceptance**: 19,034 passed,
26 failed, 87 skipped. Twenty-one failures were a complete CLI mock missing newly
consumed classifier constants; two were old catalog/manual default assertions.
The other three exposed a real regression: adding AMA learned binding replaced
a trusted SDK host's custom Skill catalog. The shared helper now retains the host
catalog and appends only learned entries, while formal-name protection remains
complete and independent. The expanded public SA/AMA fixture verifies ten
success/failure/cancellation and custom/empty/whitespace cases against a real
formal+learned store. Four empty/whitespace cases first failed and then passed;
compaction's original context-count and durable-history assertions stay intact.

Additional scanning found parser-excerpt digits misclassified as a JSON offset;
an anchored official suffix and RED→GREEN regression now prevent this. Twenty
changed test sources were typechecked separately, exposing incomplete fixtures;
eighteen formerly uncovered paths now enter the permanent root type gate.
Legacy AMAW request probes remain through structural payload variables, without
adding retired fields back to public interfaces or weakening production types.

The first bundled follow-up was 93/94; its only failure was the stricter CLI size
reserve described above, not the earlier intermittent Shell assertion. The
unchanged budget test remains, and audited ASRT program extraction closes that
failure. Do not use either first-run count as a final passing result.

### Subsequent Main acceptance record

Committed code/test revision: local `KodaX`
`a31f86206e413e89b5a97acad3b7090473cf474e`. The separate handoff pin is
documentation-only; design gitlink and Space source were not changed.

Frozen code/test/config patch against `68a02521c` (documentation excluded):
SHA-256 `0245E133A86CD770211B1B8A8577C83FE66CC5BFD47813B566E70AB9E51968A6`.
No source or build mutations run during the final source suite. Documentation
records both failed attempts and the final rebuilt-artifact acceptance separately.

| Check | Result |
| --- | --- |
| Complete build, 14 SDK declaration entries, Node-free Client and published examples | Passed |
| Production + permanent test typecheck (18 additional package/eval paths) | Passed |
| Windows selection / SDK manifest Node checks | 4 passed |
| Corrected Skill/compaction/CLI/manual/catalog regressions | 223 passed; later empty-catalog and program cases also passed |
| Native-artifact/sandbox/Skill/compaction slice | 135 passed, 29 intentional platform/backend skips |
| Final complete-artifact packaged behavior replay | 94 passed, 0 failed/skipped/TODO |
| Historical owner cutover and actual packed consumer | 3 passed after complete JS/types rebuild |
| Integrity-pinned real alpha.11 busy Host upgrade | 1 passed; busy work and original Session retained |
| Scoped V8 coverage (doctor storage, learned binding, cache usage, cost rates) | Statements 84.70%, lines 90.20%, functions 80.88%, branches 71.29%; not whole-repository coverage |
| Final full source suite | 1,377 passed files, 7 conditionally skipped files; 19,066 passed cases, 87 skipped, 0 failed/TODO; 1,232.36 s |
| Final CLI size / stricter budget | 5,171,458 / 5,177,344 bytes; 5,886 bytes remain below that reserve |

The final bounded offline benchmark pair made exactly 14 fake Provider calls on
each side: baseline median/p95 **307.27/578.07 ms**, candidate **307.59/564.26 ms**.
The candidate's empty learned-store preparation was about 0.25–1.82 ms; child
contexts remain excluded by direct query-count regressions. Retain the earlier
variance observations above: these samples do not prove a universal speedup,
zero overhead or model-quality equivalence. No network/model requests occur in
this benchmark. Raw data and all acceptance logs remain in OS temp under
`kodax-followup-*`, `kodax-entry-perf-final-{baseline,candidate}.log`.

An intermediate JS-only rebundle removed old declaration files; its packed
consumer check was rejected, not weakened. A complete build restored and validated
every published JS/type target before the successful three-case cutover replay.
This intermediate tarball is not acceptance evidence. Native Memory prerequisites
and live-service boundaries remain as stated above; no shared setup, user Host
shutdown, credential replacement, push or publication was performed.

#### Standards

Final independent incremental review: **0 findings**. The budget and explicit
empty-catalog findings were fixed and rechecked, without loosening production
types, output permissions or emitted broker behavior.

#### Spec

Final independent incremental review: **0 findings** in the repaired scope.
Read-only diagnosis, preserved host Skill scope and source/account constraints
remain intact. The F46 recovery dimension is inconclusive, and the separate
unfinished/new-protocol and external acceptance scopes remain explicit.

After the frozen full run, one **test-only** portability adjustment accepts either
no parser offset or the true syntax position 8 for the excerpt fixture, rather
than forbidding older Node's valid formal-position report. It still rejects
excerpt-derived digits. All five doctor tests and the permanent typecheck passed
again; both review axes remain at zero. No production or build change followed
the frozen source run. Hashes of CLI JS, Runtime JS/types, root types and the
audited program resource were unchanged across the full run and final package
replay. Native/live exclusions are retained rather than relabelled as passes.

## Claude follow-up disposition — 2026-11-01

Review baseline: `f196fcbd4` (production repairs `a31f86206`). The author's
untracked list compares only through `68a02521c`; it is retained unchanged.
This section records current facts rather than treating every historical status
as a new regression.

| Report | Current disposition and remaining boundary |
| --- | --- |
| F03 | A real PTY driver and npm entry already exist. Its missing CI execution is real: add the Windows portable-tier streaming/saved-history test, with pinned native drivers in runner temp and failed terminal evidence retained. This is a scoped key-to-screen gate, not the entire interactive matrix. |
| F08 | Provider requests already continue after execution-fact projection failures. Whole-file load/validate/replace remains a scaling debt (~13.6 seconds for the recorded 1,000-request fixture). No append/checkpoint format migration or speedup is claimed. |
| F09 | Real temporary-store reproduction confirms a torn Runtime agent ledger fences that task as unknown while a healthy task can finish; original ledger and snapshot remain intact. Extension writes a whole KV snapshot by rename and normally omits the final LF; A2A writes a complete JSON array by rename. Neither permits dropping a last line or loading empty defaults. Explicit diagnostic/repair APIs with original-byte checks and writer exclusion remain unfinished. |
| F12 | Both thrown and returned quota/terminal failures can wrongly enter child fallback. Regressions first reproduced both routes; the fix respects quota codes, non-retryable classification, request-build failures and authentication HTTP status while retaining configured transient fallback. Other credential subitems are separated below. |
| F44 | Fixed in `a31f86206`, with built CLI cases for empty, truncated and trailing-comma config. Help/version/doctor remain available; execution and writes still fail closed. JSON offsets exclude parser excerpts. |
| F45 | Default lock inventory and offline instructions exist in `a31f86206`, but missed `sessions/.write-locks` and did not distinguish empty/malformed/missing records. Add that inventory and bounded record-syntax/claim diagnosis in JSON and text. Every ownership result remains unverified; no live-owner proof, automatic deletion or interrupted-claim recovery is implied. |
| F46 | An eight-cell plan-exit pilot and its limits are already recorded above. Ready-plan tool use was observed; the denied-write recovery comparison remains inconclusive. No new model-facing wording or paid eval is introduced in this follow-up. |

Migration and sealed-OAuth directory locks still have a process-crash window
between directory creation and owner-record publication. This was confirmed by
source inspection, not a kill-process experiment in this follow-up. The resulting
missing-owner directory remains retained and unverified. Atomic file-lock
publication and in-process cleanup do not prove this directory window is closed.

### Credential distinctions that constrain the remaining work

- Endpoint fingerprint mismatch under CLI/Host environment drift is intentional
  authorization fencing, not grounds to approve a new destination. Improving
  availability requires an explicitly authorized, trusted connection snapshot.
- Current `auth.json` v1 reading, native protocols and current/tombstone precedence
  over sealed imports are covered. Old alpha.11 binary limitations cannot be
  attributed to the current source. An obsolete sealed backup must never replace
  a current or revoked registration (`src/provider-oauth-store.test.ts`).
- `openOAuthSession` currently exposes acquisition but no rejected-generation
  refresh operation. A future 401 path must compare the rejected credential
  generation, retain the same registration/account, respect revocation, and
  refresh only subsequent requests; it must not blindly replay a possibly
  non-idempotent POST. Copilot resource-token renewal differs from grant refresh.
- Rotating cloud/OAuth tokens conservatively invalidate native replay identity.
  The present string-only broker does not attest a stable principal. Removing
  its token hash or replacing it with a provider/profile name could reuse signed
  history across accounts. Stable reuse requires trusted account/registration and
  connection epochs, with unknown cloud identity remaining conservatively isolated.
- A server-consumed refresh token lost before durable publication cannot always
  be recovered locally. Explicit reauthorization can remain necessary; never
  substitute another account or resurrect a stale backup to hide this outcome.

These conclusions follow the actual seams in `src/provider-credential-authorizer.ts`,
`src/provider-oauth-store.ts`, `packages/llm/src/oauth/session.ts`,
`packages/llm/src/credential-fingerprint.ts`, `packages/coding/src/child-fallback.ts`,
`src/runtime-agent-store.ts`, `packages/agent/src/external-agents/executor-plane.ts`,
`packages/agent/src/session-lineage/persistence.ts` and `src/a2a/task-store.ts`.
Offline probes used OS temp fixtures only; no user credentials or real accounts
were read, repaired, revoked or switched.

### Follow-up validation

The final source/type checks and complete build passed. The 16-file targeted
regression passed **341 tests**, with **one file-symlink privilege skip**; a
verbose replay identified `File symlink privilege is unavailable` rather than
counting it as a pass. The final built bundle suite passed **94/94**, the real
Windows Ink streaming/saved-history PTY passed **3/3**, and the historical-owner
and installed-consumer cutover gate passed **3/3**. Exit codes were zero.
Workflow YAML parses; the added CI step itself awaits remote execution because
this local work is not pushed.

Final CLI is **5,173,001 bytes**, below the unchanged **5,177,344-byte** budget.
Normal successful request handling gains no filesystem/process/model work:
fallback classification runs on the error path, and lock reads occur only in
explicit doctor diagnostics. No prompt, effort, history budget or timeout was
changed. No new latency benchmark or intelligence-equivalence claim is made;
F08's previously measured write scaling remains outstanding. This scoped
follow-up did **not** repeat the earlier 19,066-test whole-source run; that
separate frozen acceptance above remains historical evidence for `a31f86206`.

Logs and fake terminal evidence remain in OS temp:
`kodax-claude-followup-{typecheck,build,targeted,bundle,pty,cutover,lock-skip}.log`
and `kodax-repl-acceptance-V6aoos`. No production build mutation occurred during
the final packaged/PTY/cutover verification. The original reference reports,
Space branch, design submodule and user-owned untracked files are unchanged.

#### Standards

Final independent review: **0 remaining findings**. The initial overbroad
Responses stream-error guard was corrected and protected by a RED/GREEN test.

#### Spec

Final independent review: **0 remaining findings in this slice**. HTTP 408 and
legacy authentication classification findings were fixed with RED/GREEN tests.
F08, F09 explicit repair, F12 rejected-generation refresh/native replay identity,
F45 unknown-owner recovery and F46 recovery-eval limits remain as stated above.

## Remaining-seam implementation — 2026-11-01

Baseline `3cd3e5afe6d799cffcc6071cd5cc59b5e7d73c3c`, direct local `KodaX` work
authorized by the user. The original untracked audit reports remain untouched;
design submodule `8574086` and Space `da531f0a` remain separate and unchanged.
This section supersedes earlier *unfinished* labels for the specific seams below;
earlier counts and failures are historical evidence, not final acceptance.

### Contracts and executable coverage

- **F45 publication/recovery:** migration and sealed OAuth publish complete
  synced owner files, retaining legacy directory reads. Storage writers use the
  same complete-publication lease. Proven-dead claims are permanent per generation;
  age grants nothing. Trusted local repair checks exact inventory, aliases,
  ownership and original identity/hash, then quarantines unidentified historical
  locks with original bytes retained. Its claim generation matches each actual
  writer, including malformed UTF-8 replacement decoding. Session fair-queue
  and proper-lockfile protocols are refused by the generic repair engine.
- **F09 repair/lifecycle:** task ledgers validate on first read and append with
  a validated cursor. Valid no-newline tails remain readable; corrupt tasks are
  fenced. Shared Host owns the store lifetime lease; failed initialization and
  executor disposal retain ownership until cleanup completes. Extension RMW
  serializes; A2A owns its lifetime lease. Repair binds the original identity/hash
  and validated candidate, retains backup/receipt and publishes a fence before
  replacement. Only separately attested confirm clears the fence. Interrupted
  repair resumes exact receipts without overwriting a newer writer.
- **F12 credentials:** negotiated grants carry trusted stable account identity;
  exact/leased SDK scopes unwrap before HTTP. A rejected generation triggers
  scoped recovery without replaying the failed POST. Concurrent refresh, account
  switch/revoke, migration and cold Host restart preserve account/connection/CAS.
  Copilot exchanges its resource token. Anthropic clients sanitize ambient SDK
  auth headers; actual endpoint fingerprints and legacy bindings are unchanged.
  Explicit non-retryable facts survive returned failures while generic error
  classification cannot hide eligible transient HTTP fallback. Same-provider
  retry budgets/delays were not increased to repair that fallback.
- **F08 scaling:** observations use Session-root-scoped per-instance append
  lanes, maps and incremental validation. Exactly known own appends do not reread
  themselves. Legacy default v1 remains read-only; custom roots never import its
  unscoped facts. Torn lanes stay retained/partial without poisoning future
  collection. LRU bounds projections. Reconstructed-projection cursors return
  conflict rather than skip rows after concurrent-lane reorder. Statistics never
  authorize replay or fail a healthy provider operation.
- **Native Claude 5.5:** actual input/output fragments survive JSON restore and
  source/parent/canonical checks, preserving block order and signed empty thinking.
  Inline system/tool changes, removal/replacement, per-message effort, mode-change
  lineage reset and cached rejection healing retain provenance. Admitted images
  survive deletion of their original path. Cache projection leaves tool arguments
  and Schema business fields intact. Final payload gates sampling, prefill and
  effort hooks; non-effort format extensions remain usable. SSE captures citation,
  server-tool JSON deltas and start-only local arguments. SA, AMA adapter and
  generic Agent contracts forward metadata; guards drop it if committed content
  differs from the raw output. Actual protocol scope is in LLM_INTEGRATION.md.

Repair is a trusted Node/Main maintenance surface, not a Product Client or model
tool. `allWritersStopped` attests a prerequisite for old uncooperating writers;
it cannot prove they are offline. JSON validity does not verify external effects.
No automatic data reset, account reselection, lock TTL reclamation or global
tool-output deletion was added.

### F46 revised controlled pilot

Harness revision 2 addresses the previous recovery ceiling: real read receipts
and an actual denied write in a unique ignored repository fixture outside OS
Temp, using production descriptions and pinned pre-fix wording. Routes were
`zhipu/glm52` and `ark/v4flash`; two cases, two blinded arms, one sample per cell:
**8 physical requests**, no fallback. Before-call budgets: eight calls, 2,048
output tokens/call, 500,000 total tokens, reference USD 1, deadline 45 seconds.
Raw outputs, scope, reveal and Main's structured blinded semantic review remain
in `%TEMP%/kodax-plan-exit-eval-xPHirk`.

Both arms used the correct `exit_plan_mode` in **4/4** cells. Across **8/8** there
was no stale-tool use, repeat blocked write, redundant read or clarification.
This supports no observed regression on these cases, neither general intelligence
equivalence nor lift. Recommend the stale-guidance correction on static
correctness plus this limited no-harm evidence. Observed usage: 155,100 tokens;
reference coding-plan estimate USD 0.004226885 is not an invoice.

A separate reviewer mistake invoked natural-language `help auth`, causing two
zhipu-coding attempts in an isolated Temp home. It was neither a help probe nor
controlled eval and is not in the eight-cell sample. The exact temporary Host
was verified to have exited; no user Host was stopped. Future help checks use
`--help`. Do not claim only eight calls occurred in the entire work session.

### Validation boundaries

Local fixtures do not prove real OAuth/cloud account validity, Claude 5.5
upstream signatures/cache benefit, regional pricing or entitlement. Default
cloud tokens without verified stable principal stay conservatively isolated.
Remote-consumed refresh tokens lost before local durable commit cannot recover
from stale backups; reauthentication may still be needed. Old alpha.11 readers
cannot understand later protocol identifiers; old unfenced writers must stop
and upgrade before sharing new stores.

Global automatic tool-output cleanup is a separate missing storage-management
capability. Root/Space branch/attachment/reference ownership is not closed here;
old originals remain and explicit diagnostics are not GC. Native Windows Memory
still requires the recorded external setup; shared accounts/ACLs and user
`.claude.json` were not changed to force a pass.

Final source-scan/replay, distribution, performance and review evidence follows
below. Interim scans run alongside RED/GREEN edits are diagnostic only; failed
frozen runs are retained separately rather than relabeled as clean acceptance.

### Repeated execution-fact performance comparison

Offline harness `benchmark/perf/execution-facts.bench.ts`, Node **22.23.1**,
Windows **10.0.26300**, three separate Temp roots per cell. Baseline is the exact
`3cd3e5af` source with only its unchanged liveness import relocated for loading.
Each request records started+succeeded, then a new store reconstructs statistics;
counts and usage are asserted. Values below are medians, not universal SLAs.

| Requests | Baseline write ms | Candidate write ms | Baseline bytes written | Candidate bytes written | Baseline / candidate reopen ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 50 | 357.4 | 33.9 | 1,143,201 | 129,278 | 4.3 / 9.2 |
| 250 | 2,377.4 | 162.1 | 27,922,451 | 649,074 | 5.3 / 6.9 |
| 1,000 | 13,486.9 | 528.6 | 446,344,205 | 2,604,582 | 7.7 / 9.6 |
| 5,000 | not repeated | 3,992.8 | not repeated | 13,092,586 | not repeated / 35.9 |

The first candidate still reread its own append and was slower at 50 requests.
A RED I/O-count regression demonstrated that overhead; exact own-head advancement
removed it, followed by the repeated final measurement above. The 1,000-request
write reduction is about **99.4%** and elapsed reduction about **96.1%** here.
Cold reconstruction reads the linear journal and is slightly slower than the
single final v1 snapshot; journal disk occupancy also retains both state changes,
not just the last projection. No checkpoint or automatic deletion was introduced
to hide that tradeoff. Small concurrent unit probes ran during measurement;
wall-time samples are local observations, while byte counts and I/O assertions
are deterministic. Raw final/baseline JSON stays in OS Temp as
`kodax-376-perf-{baseline,candidate-final}.json`.

Native history/credential fixes add no extra normal provider request or default
budget reduction. This does not establish global intelligence equivalence;
the controlled wording pilot and its sample limits are recorded separately.

### Final-scan findings and corrections

The first frozen whole-source tree `303d25b01beef8b4403ca028f473fd02ae8e3339`
finished with **19,178 passed, 1 failed, 87 skipped, 0 TODO**. The failure was the
Electron fixture's fake Shell waiting only for a future abort event; a cold
import can enter it after the deadline has already aborted. A deterministic
already-aborted case reproduced it. The fake tool now handles both timing
orders and still waits for held cleanup before publishing failure. Production
deadlines and cleanup assertions were not relaxed.

Post-scan review also reproduced acceptance of a replacement snapshot containing
`registration: {}`. Human effect verification cannot supply missing deterministic
structure: cancellation then threw. The explicit repair parser now validates
required registration/capability/effect/state fields, without changing the old
scan predicate or inventing missing authority. Five invalid-candidate cases
retain originals without backup/receipt/fence publication. A complete candidate
passes repair/confirm and a real executor-plane cancel returns unknown/unsupported.
The published maintenance E2E independently checks invalid and valid replacements.

The full PTY run exposed an obsolete fixture that expected a one-token probe,
fixed Worker medium and retired `deep`. It now identifies actual probe input,
requires Worker high before rejection and uses current auto mode. Its old global
catalog narrowing assumption was also wrong: native catalog discovery intentionally
has no acquired account identity. An attempted cached-probe filter was a mistaken
behavior change, not a proven product fix. The existing SDK contract and commands
require an explicit probe to issue real bounded requests again. That filter and
its three strategy tests were fully reverted; the SDK integration's fresh-wire
assertion was preserved. The terminal now checks scoped persistence, unscoped
catalog discovery, repeated real probes, explicit forget and normal-generation
high-to-medium recovery without overwriting defaults. Normal subsequent requests
still use scoped learning and do not repeat rejection notices. A runtime-registered
provider that reuses an instance is an unverified edge, not a validated bug or
justification to turn all probes into cached queries.

The old first-stage CLI loader also folded away Bun's literal-import route.
Actual standalone compilation reproduced a missing doctor report. A retained
runtime Bun guard fixes the two-stage build; standalone smoke now exercises
nested auth help and read-only storage maintenance as well as native/Script/
Skill/provider paths. The first tiny image E2E sample was undecodable; replacing
it with the existing valid PNG plus a first-dispatch byte assertion corrected
the fixture, without weakening restore/image equality assertions.

The final historical-upgrade invocation initially lacked its explicit pinned
tarball environment variable and failed before starting any Host. The existing
cached artifact was supplied, its fixed SHA-512 checked by the test, and the
busy-host upgrade passed. No production fix or timeout change was made for this
fixture-preparation error. Final acceptance below uses the corrected invocations.

The second whole-source run took **1,328.70 s**, with **19,184 passed, 2 failed,
87 skipped, 0 TODO**, across 1,391 files. One failure caught the mistaken cached
probe filter described above; restoring the original producer behavior preserved
the SDK fresh-wire assertion. The other was the loopback OAuth fixture's browser
launch timeout. Its original file passed alone; the original transient cause is
unconfirmed. The fixture now uses independent `node:http` browser connections,
consumes responses, awaits launch completion, and forbids provider `fetch` use.
It retains exact callback/404/200, cancellation and the original 10-second limit.
The complete auth, SDK capability and probe-helper files then passed **8/8**;
this is a whole-file replay, not a claim that the failed full run was green.

Two subsequent complete bundled runs each passed **97/98** and exposed overly
narrow assertions in the same Product quit fixture. A fresh pending query checks
all historical generations, including an already-exited replacement; Windows Job
containment can also be temporarily unconfirmed after daemon exit. The fixture
now matches only its actually verified historical receipts, checks exact request/
client/runtime/owner/cleanup, allows `containment_active` only for a recorded
`windows-job` owner, and still requires blocked/retry followed by an empty list.
Old request replay must leave the new Host usable and original receipt unchanged.
Neither production verification nor deadlines changed. Deterministic two-generation
tests cover ready → unverified → ready for both daemon and containment checks,
with no stop call or file rewrite. Do not classify these fixture corrections as
a new product shutdown fix, or claim the underlying OS probe transient was traced.

### Final local acceptance for the remaining seams

Accepted local code commit: `eb7d1a3bcb1426c8971437077201dc97b0ee7c95`
on `KodaX`. The following documentation-only handoff update does not change
the accepted executable bytes. No push, release, design or Space code change.

Code/test/config patch against `3cd3e5af`, excluding documentation:
SHA-256 `28a182f1a648cdcc2fb15d1d0c735cddb0c670c27e70acc4f6b9423b068ba848`
(404,431 bytes). No production changes followed the restored probe contract.
The last changes were the described callback/terminal/exit fixtures and their
contract regressions. Neither repair nor acceptance manipulates user credentials,
live Hosts, shared ACLs or the user's `.claude.json`.

| Check | Final evidence |
| --- | --- |
| Full build + root/test typecheck | Passed; 14 standalone SDK declarations and Node-free Product Client checks retained |
| Whole-source scan and complete-file completion | Second scan: 19,184 passed, 2 failed, 87 conditionally skipped; auth/capability/probe files then 8/8 passed; final lifecycle/Client exit files 26/26 passed, including two added generation cases |
| Deduplicated current source corpus | 1,391 files; 19,188 passed cases plus 87 conditional skips, 0 TODO after whole-file replacements and the two new cases. This is aggregated completion, **not one clean frozen whole-suite run** |
| Complete rebuilt distribution E2E | **98 passed, 0 failed/skipped/TODO**, 96.23 s; includes broker refresh/account/revoke/restore, native history, repair and Host recovery |
| Actual terminal interaction | Ink 30 + Classic 20 + streaming saved-history 3 passed, with repeated real probe and scoped-generation recovery assertions |
| Exit generation regression | 26 source cases and 2 isolated packaged cases passed; final complete bundled run includes those packaged cases |
| Actual Windows standalone binary | Bun 1.4.4 compilation and auth help, doctor/maintenance, A2A, native text, Script child, Skill, YAML/fflate, Anthropic/OpenAI SDK smokes passed |
| Actual npm archive | Four private CLI modules present and nonempty; full runtime audit passed for 143 JavaScript bundle entries; no new public subpath |
| Historical owner cutover | 3 passed on the final rebuilt JavaScript/types; profile and storage-owner rollback fences preserved |
| Integrity-pinned actual alpha.11 busy Host upgrade | 1 passed on the final build; active work and original Session preserved, no synthetic old-version substitute |
| Packed Artifact SDK consumer | 1 passed; real package installation, resources, consumer types and rendered pixels verified |
| Windows discovery, SDK manifest and archive inventory | 6 passed |
| Scoped V8 coverage | 14 files / 132 tests passed, eight measured source files: statements 85.72%, lines 92.52%, functions 94.07%, branches 78.11%; **not whole-repository coverage** |
| Independent final Spec / Standards review | No open findings; mistaken probe change withdrawn, fixture assumptions corrected without relaxing production fences or deadlines |
| CLI budget | **5,171,193 / 5,177,344 bytes**; reserve unchanged, 6,151 bytes below it |

Accepted CLI SHA-256:
`14a2426f912f2b8ace1baa3fb2a3e8f19fcdf830f9bbdb20539026f64a256acd`.
The source aggregate is `19,184 - 2 + (3 auth + 1 SDK) + 2 new generation cases
= 19,188`: remove the two already-passed cases in the failed auth file, replace
both failed files in full, and add the two new cases. Other replayed cases are
already counted; the withdrawn three probe-strategy cases are not in this corpus.
Final evidence is retained under OS Temp `kodax-376-accepted-*`, with source
scan/replays in `kodax-376-final-source.log`, `kodax-376-final-files-replay.log`
and `kodax-376-exit-generations-source-final.log`. The earlier 97/98 reports
remain available; they are not replaced by claims that every attempt passed.

Three additional idle runs of the unchanged packaged startup regression passed
all recovery/deadline/identity/query-count assertions. Median observations:

| Synthetic recovery load | Median |
| --- | ---: |
| 512 missing-identity / reused-PID / incomplete records, first ready | 2,325 ms |
| Same records, second generation ready | 1,616 ms |
| 220 exited trees with concurrent resume, first ready | 2,619 ms |
| First concurrent history reads | 53 ms |
| Same exited-tree fixture, restart ready | 1,534 ms |

All first-ready observations were 2.29–2.90 s, with no per-record helper startup;
the prior 30–43-second recurrence did not reproduce. The earlier dated samples
(2,043/1,398 ms and 2,447/44/1,491 ms) were not a matched repeated A/B experiment.
These current runs do not establish zero overhead or attribute their modest
timing differences to a code regression. The repeated execution-fact A/B above
provides the measured performance comparison for the changed storage path.
Default model, reasoning and output budgets were not reduced. The eight-call
wording eval is limited no-harm evidence, not a global intelligence guarantee.

This closes the confirmed local code seams in this batch. It does not close
real provider/cloud-account acceptance, native Windows Memory setup, historical
unattributed first-read observations, or reference-safe global tool-output GC.
Those boundaries remain visible in `KNOWN_ISSUES.md` and the Space handoff.

## Alpha.12 first remote CI follow-up

The first tag run [41314703124](https://github.com/icetomoyo/KodaX/actions/runs/41314703124)
tested `220df4e9d` and failed. Windows portable reported 14 failures, system
reported 65; the real v2 background-concurrency case failed in both Windows
release gates. macOS fixture aliases and a Node 20 Linux null stdout also
failed. These are first remote acceptance results, not contradicted by the
earlier explicitly local acceptance. A newly exercised gate exposing a defect
does not establish when that defect was introduced.

GLM's `e9ad81b32` canonical temporary fixtures and `fef65651a` null stdout
handling are retained. The handoff contained four uncommitted files; those
were captured before takeover and completed without resetting the branch or
moving the failed alpha.12 tag.

- Protected-path regression: retain lexical `.kodax` protection and freshly
  resolved physical protection; failed resolution diagnoses and requires
  confirmation. The junction and access-denied cases failed before the fix.
  The original 8.3 fixture also had cmd argument quoting wrong; corrected
  `spawnSync` transport verifies a real existing short-name identity first.
- SSH read-root regression: absent private keys still resolve their existing
  directory prefix, so a short home does not grant its `.keys` directory.
  The explicit short-home/nonexistent-key regression failed then passed.
- Native cache identity: normalize the existing anchor before constructing
  missing descendants, but reject Windows reparse ancestors first. The real
  short-name cache regression failed then passed; the sandbox unit file now
  exercises its own isolated cache through an actual short-name spelling.
- Credential staging: an explicit Administrators ACE survived incremental
  icacls updates and propagated to new staging files. An isolated fixture
  reproduced it. One exact, protected DACL replacement keeps current-user and
  SYSTEM entries only, without temporarily resetting to a broad parent ACL.
  Existing credential bytes survive reinitialization. The 13 file-store tests
  passed locally. PowerShell initialization/write cost is real; ordinary key
  reads do not invoke this path, and no model/retry/account selection changes.
- Undo: keep native short-name rejection, canonical backup identity and CAS
  unchanged. Mock snapshots claiming canonical paths now use canonical fixture
  roots. A new actual Host case rejects short-name input and successfully
  writes/undoes the corresponding canonical input. The first proposed success
  expectation for raw short input was withdrawn after it exposed the existing
  native path contract; it was not a product fix.
- V2: local isolated execution was blocked by the recorded setup-owned read
  capability prerequisite. It does not reproduce or explain CI's code 2.
  The CI-only fixture now retains bounded new background-bootstrap logs on
  failure, without changing assertions, deadlines, replay or fallback policy.
  Do not attribute the failure to broker-program extraction without evidence.

### Second candidate checkpoint (2026-11-02)

Manual Release run [41322473294](https://github.com/icetomoyo/KodaX/actions/runs/41322473294)
tested Main `ac18c1026`: nine jobs passed, six failed and two were skipped.
Both macOS builds passed, and Windows real v2 passed all 30 cases, including
background concurrency. This single passing run does not establish the original
intermittent code 2 root cause. The subsequently reached real Memory OS gate
failed; its Host fallback remains forbidden and now includes preparation
observations. Neither publishing nor the universal package gate ran.

Follow-up repairs retain all OS isolation assertions and the 32-request offline
release budget:

- Canonicalize Windows grant/deny identities before bounding write masks, and
  canonicalize Agent Home before finding concrete legacy Memory roots. Actual
  short-name preparation reproduced missing masks. Scoped and legacy Memory
  deny ancestors also must survive grants to their children; those two cases
  independently failed then passed. No blanket deny of all legacy projects is
  added, and Memory stays readable.
- Ordinary SDK/backend test fixtures use physical paths, including private Temp
  assertions. Explicit real 8.3 cases remain, with physical-identity checks.
  SDK sandbox selection is tested independently of machine setup in three
  exact outcomes: prepared, not selected (caller compatibility), and failed
  selected backend (propagate failure, never invoke caller). Actual Native
  admission and missing-cutover rejection remain in backend/OS gates.
- REPL redirect evidence now reuses the existing coding boundary policy. Both
  directions of temp long/short spelling are tested together against one
  physical root; the reverse direction failed before this repair. No separate
  path cache or alias parser is introduced.
- Downloaded failing Windows release evidence showed the extra request was an
  owned Memory review. Missing-worker preflight now checks that no **primary**
  generation starts, while all primary and auxiliary requests still count
  toward the same total budget. The actual Windows archive gate passed locally
  after this test correction (11 primary, 7 auxiliary, 0 external calls).
- Node 22's cancelled-compaction cleanup test used Vitest's default one-second
  poll while production settlement has bounded asynchronous phases. Only that
  test observation window is explicitly ten seconds; production budgets and
  required idle/run outcomes are unchanged.

Local boundaries remain explicit: the interactive PTY fixture entered normal
automatic sandbox preparation, then exceeded its 45-second startup allowance
before any model request. The machine's cutover marker was left at `installing`;
it has not been forged, reset or marked current by hand. A separate forced-temp
probe also failed in PowerShell artifact `File.Move` with DirectoryNotFound;
its longer path is a suspect, not an isolated cause or acceptance evidence. Use the ordinary physical
temp root and its verified existing 8.3 alias for the repeatable CI comparison.
Do not claim a successful local interactive PTY or real Memory OS test from
these attempts, and do not rotate the shared sandbox account to green a unit
suite.

The next exact Main SHA still requires a fresh full manual Release run: CI,
five platform builds and the universal package gate, with publishing skipped.
The repair task must not move the failed alpha.12 tag, create a Release or
publish npm. The final tested SHA/run and observed result belong in the release
handoff; this checkpoint makes no all-green claim.

### Third candidate follow-up (2026-11-02)

Run [41327225086](https://github.com/icetomoyo/KodaX/actions/runs/41327225086)
tested Main `430692f0c`: 11 jobs passed, four failed, two were skipped. All
POSIX builds/native gates and Linux full/system suites passed. Windows v2 again
passed all 30 real cases in the release build. Remaining failures were:

- Electron's parallel bundle group passed 97/98; mixed historical recovery took
  11,442 ms against the unchanged 10,000 ms budget. The same SHA's Windows build
  passed 98/98. Its 220-tree recovery and several other Host cases also slowed
  under the competing functional workload. Local independent recovery was
  1.3–2.3 seconds; this does not prove the remote production path has no cost.
  `test:bundle` now runs 96 functional cases in parallel, then both startup
  performance cases separately, with every budget, identity/history and cleanup
  assertion retained. Local acceptance was 86.88 seconds plus 10.39 seconds
  (512-record generations 2.18/2.10 seconds; 220 trees 2.46 seconds). The extra
  Node invocation has real cost; no new CI job, install or rebuild is added.
  Startup diagnostics now emit bounded stage timings before the budget check.
- The actual packaged Electron test reached shutdown after the first 20
  sandboxed queries, then called the retired public `enableKodaXDaemonOwner`.
  The gate now captures the public owner identity before shutdown and verifies
  that exact Host and Job through `waitForRuntimeDaemonShutdown`, followed by
  read-only unowned/daemon policy assertions. The original 300-second release
  allowance remains; no retired public mutator is restored. Five helper cases
  reject unverified, replacement, failed and inline outcomes; 21 fixture cases
  passed locally. Full packaged execution still requires remote acceptance.
- Windows system passed 868 cases but failed eight. One Temp fault-injection
  case reproduced a physical grant/lexical cleanup mismatch. Canonicalizing
  the Windows private Temp root keeps the environment, grants and cleanup on
  one identity; a verified short-temp fixture failed then passed. Six bootstrap
  failures and the pre-start test exposed a mock pipe with no reader. A bounded
  18 KiB environment reproduced the exact bootstrap-delivery timeout locally;
  making the fake native controller consume stdin fixed it. The original
  10-second unit allowance and virtual attestation deadlines remain unchanged.
  Deliberate bootstrap-write-pending simulation is retained separately.
- Windows portable passed 2,987 cases but failed three. Two path fixtures used
  unquoted Windows backslashes as Bash syntax, which Bash correctly unescapes;
  quoted forward-slash paths make the intended temp identity unambiguous.
  Extension `exec('echo hello')` also exceeded its 30-second command/test
  allowance. PowerShell now starts with `-NoProfile -NonInteractive -NoLogo`,
  avoiding ambient profile execution and interactive prompts. The exact cause
  of the remote first-launch delay is not isolated; command budgets, explicit
  Bash behavior and the secret-free environment whitelist are retained. Two
  argument/environment cases and all seven real helper cases passed locally.

Isolated native-cache fixture names are short so an additional real 8.3 Temp
alias does not manufacture a long-path provisioning failure unrelated to the
policy under test. Real alias identities, cache ACL/reparse checks and the
SID-unavailable repair rejection remain asserted. No shared sandbox setup or
account rotation is used to repair a test fixture. The final candidate still
needs all remote gates, including real Memory and universal npm packaging.

Final local checkpoint: complete build and production/test typechecking passed;
seven SDK/extension/Electron-fixture/permission files passed 404 cases. The
verified short-Temp sandbox file passed 104 cases with 27 platform exclusions.
The rebuilt bundle passed 96 functional and two independent startup cases
(86.34 + 9.37 seconds; recovery 2.05/1.36 seconds, 220 trees 2.45 seconds,
history 47 ms, restart 1.50 seconds). Standards and Spec reviews have no open
findings; the PowerShell profile compatibility boundary is recorded in
`SDK_MIGRATION.md`. These local results do not replace the next exact-SHA
manual Release run.

The next manual run [41330695832](https://github.com/icetomoyo/KodaX/actions/runs/41330695832),
on `aedc6c7d4`, exposed a separate help fixture limit: Electron's functional
bundle group passed 95/96, but creating the existing Host hit its explicit
15-second startup allowance before any help invocation. The same SHA's Windows
release build had already passed that bundle step. The cause of the delayed
remote startup is not isolated; the old run did not retain the bootstrap file.
Only this functional fixture now allows 30 seconds for Host creation, with
bounded stage timing on failure. Its whole-test 60-second and each CLI's
10-second limits, ownership/credential hashes, exact shutdown checks, and the
separate 10-second startup performance gate remain. The three help cases
passed independently locally. This is a fixture allowance adjustment, not a
production startup performance fix; the final SHA still requires full CI.
After the fixture adjustment, local bundle acceptance passed 96 + 2 cases
(84.87 + 9.00 seconds). The unchanged startup gate measured 1.94/1.56-second
historical recovery, 2.19-second concurrent recovery, 51 ms history reads and
1.36-second restart. Both review axes have no open findings. No production
source or public contract changes are part of this follow-up.

Run [41332132335](https://github.com/icetomoyo/KodaX/actions/runs/41332132335)
on `4b77145d4` passed the adjusted help fixture, all five platform builds,
universal npm packaging, Linux suites and Windows system contracts. The
Electron job also passed historical migration, alpha.11 upgrade, CPU-contention
attachment, startup/cancellation, native transactions and all 30 real v2 cases,
then failed the real Memory gate. The old rejection callback omitted the
authorization request's diagnostic, so an empty observation list alone cannot
identify the preparation failure. Windows portable was still running at this
checkpoint and is not counted as passed here.

The direct Memory tool fixture had skipped a real Host invariant:
`createCliProviderCredentials` initializes the private credential store before
shell admission. Windows native policy validates every denyWrite target through
an existing ACL handle; the isolated fixture had Memory files but no `auth.json`.
It now initializes its own empty protected store and staging targets using the
public file-store API, then executes the same shell/OS assertions. The fallback
rejection now includes only reason, diagnostic and bounded observations. This
does not initialize or migrate a real user's credentials, repair the shared
sandbox or allow Host fallback. The 13 credential-file regressions and test
typecheck passed locally; actual OS acceptance still needs the next exact SHA.
That run subsequently completed with 15 successful jobs, only the Memory job
failed, and publishing skipped. Windows portable passed, including the corrected
Temp Bash syntax and extension execution cases; no newer candidate was dispatched
until these remaining results were available.
