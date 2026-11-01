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
