# Issue 371: Windows cold resume recovery delay

Originally investigated and partially fixed on Windows, 2026-10-29, after
`8910fcce` (then v0.7.97-alpha.10). The 2026-10-31 recurrence fix is on local
Root main at `16973a93`; the package version remains alpha.11 and this follow-up
has not been pushed or published.

## Contract and scope

Resuming must not start a termination helper for each registered Windows tree
whose complete PID/start-identity capture is already proven absent by the
current shared process snapshot. Reclaim those records within one sweep using
that snapshot. A reused PID with a different known start identity is not the
captured process. Unknown identities, incomplete trees, unavailable snapshots,
live descendants, active/unknown owners and required Run cleanup must retain
their existing fences. Never treat a missing root alone as proof of tree exit.

Two concurrent clients must share one normal Host, read the saved Session and
newest history page promptly, and preserve the persisted conversation. No user
registry reset, forced Host replacement, skipped recovery, extra permission or
startup-timeout increase is an acceptable performance fix.

The isolated Windows fixture uses 220 verifiably absent child PIDs and an absent
owner PID, with complete retained creation identities, plus one incomplete
Run-owned record whose unresolved evidence must be preserved. It seeds 400 messages,
starts two public SDK clients, requires readiness below 10 seconds and first
concurrent Session/history reads below 2 seconds, verifies all 220 complete
exited-tree records are reclaimed and checks saved messages remain unchanged.
It then verifies the exact Host/Windows Job shutdown, starts a new Host generation and resumes the
same history with the unresolved record byte-for-byte unchanged. The fixture
HOME is deleted only after the final verified shutdown. It invokes no model,
shell command or user Session. The Host and HOME belong only to this fixture.

## Reproduction and diagnosis

The original 2026-10-28 report recorded Host birth-to-ready at approximately
49.2 seconds and a later first selected-Session read at 16,011 ms. Those two
observations alone did not identify a common cause.

On 2026-10-29 the actual default-home cold startup reproduced 23,360 ms:
recovery appeared at 1,350 ms and MCP initialization at 23,066 ms. The sweep
retired 160 of 1,352 records. A second, still-unfixed cold startup took 1,904 ms
after those records had been reclaimed: instrumented registered-child recovery
was 366 ms and persisted-Run recovery was 24 ms for 87 statuses. The remaining
1,192 records all had incomplete captures and Run references. The removed 160
records' individual contents were not captured; do not assert their exact
shapes from this count alone.

The earlier 1,191-record copy probe deliberately used a live owner of unknown
identity, bypassing the stale-tree branch. Its fast result did not clear that
branch. An isolated complete-exited-tree reproducer then exceeded the SDK's
60-second startup deadline with 220 records. This exercised real registry
recovery, not a mocked stopwatch. It verified every synthetic child PID absent
and used an ancient creation identity that cannot match a current process.

The Windows unit regression also went RED: repeated complete dead captures
returned `terminated` and spawned helpers instead of using the snapshot proof.
The minimal fix checks the existing `capturedWindowsProcessesGone` result
before termination and passes the already acquired snapshot to it. This avoids
per-record termination and invalidation without changing incomplete/live paths.

## Automated acceptance

From the repository, build the workspace packages and bundled CLI/SDK, then run:

```powershell
npm run build:packages
npm run build:bundle
npx vitest run packages/agent/src/runtime/process-tree.windows.test.ts packages/agent/src/runtime/process-tree.test.ts packages/agent/src/runtime/process-tree.identity-batch.test.ts packages/agent/src/runtime/managed-child-processes.test.ts packages/agent/src/runtime/managed-child-processes.scope.test.ts packages/agent/src/runtime/managed-child-processes.run.test.ts packages/agent/src/runtime/managed-child-processes.cache.test.ts
node --test tests/bundled-shared-host-recovery.test.mjs
node --test --test-concurrency=1 tests/bundled-startup-recovery.test.mjs tests/bundled-shared-profile-recovery.test.mjs
```

The bundled startup regression is included in `npm run test:bundle`; it skips
outside Windows. Two deterministic unit cases check 100 complete dead captures
with absent and reused PIDs: one snapshot probe, zero termination helpers.
Existing cases cover live descendants, unknown identities, missing snapshots,
incomplete captures and cache invalidation following a real termination.

Observed after the fix:

- Isolated 220-record reproducer: 1,952 ms, zero remaining records.
- Two-client bundled acceptance: 2,282 ms ready, 47 ms first concurrent reads;
  combined lifecycle run: 2,457 ms / 46 ms. All 400 messages were preserved.
- Actual default-home Host: 1,896 ms ready; reported Sessions
  `20261026_200011_47f836372c903b` and `20261008_104354_7r848c8cf21187`
  read in 23 ms and 8 ms, with 109 and 410 messages respectively.
- Packaged bin/PTY acceptance: two `kodax -r <sessionId>` terminals in different
  directories shared an isolated HOME with 220 exited records. Both emitted
  the restored final history message and normal input prompt in 3,161 ms and
  3,497 ms; no fixture records remained. Both exited through `/exit`. An earlier
  diagnostic harness incorrectly passed the unsupported CLI `--home` option;
  the passing run used the normal `KODAX_HOME`/profile environment and packaged
  bin. Its raw terminal output establishes delivery, not a screenshot audit.
- Process-tree/registry suite: 131 passed, 2 platform skips; startup/transport/
  progress suite: 48 passed; SDK history/exit/owner suites: 36 passed, 1 skip.
  Production/test TypeScript checks and all 14 SDK type bundles passed.

Real-home acceptance happened after the slow baseline had retired 160 records;
it is not a same-input comparison proving the speedup. The isolated fixture is
the causal before/after evidence. The 1,192 unresolved real records were not
deleted, altered to authorize cleanup, or declared successfully terminated.
Graceful lifecycle exit was used only when the real Host accepted an exit;
there was no force kill. These probes ran in the coding tool's filesystem
context, not a claim to reproduce the console-specific view in Issue 372.

## Regression review after `a8f992ff` (2026-10-29)

Independent Standards and Spec reviews found no actionable regression in the
runtime patch. The audit followed every changed cleanup result into its callers:
Run recovery, Bash, worktree, MCP, LSP, sandbox and daemon teardown distinguish
`unknown` from proven success and already accept `already-exited`. The public
capture signature and POSIX implementation are unchanged. Ordinary startup reads
the retained registry identities before its shared snapshot; PID reuse cannot
revive an identity already proven absent. Concurrent unrelated cleanup scopes
supplying newer captures were not stress-tested; do not claim exhaustive race
or non-Windows live-process validation from these checks.

The review strengthened the bundled regression rather than changing runtime
logic. One incomplete Run record is now mixed with the 220 complete exited
records and must remain byte-for-byte unchanged through two Host generations.
The test verifies exact process/Windows Job shutdown with
`waitForRuntimeDaemonShutdown`, not merely shutdown request acceptance, before
starting a replacement or deleting the isolated HOME. After restart it rechecks
all 400 persisted messages and the newest history page. Latest acceptance:
2,547 ms cold readiness, 53 ms concurrent first reads, 1,535 ms resume after
verified shutdown. Both Host shutdowns were verified.

The expanded regression checks completed with 485 distinct Vitest cases passed
and 2 platform skips, plus 7 bundled cases passed:

| Scope | Passed | Skipped |
| --- | ---: | ---: |
| Process-tree/registry, interrupted/generation and SDK shell recovery | 156 | 2 |
| SDK startup/interrupted/exit recovery, daemon startup and cleanup callers | 112 | 0 |
| Real Windows process cleanup, MCP transport, LSP and Bash | 109 | 0 |
| Saved-history wheel/navigation and sandbox startup/boot diagnostics | 108 | 0 |
| Bundled concurrent startup, shared Host refresh/idle exit, CLI generation recovery and Product quit | 7 | 0 |

The bundled CLI recovery cases exercise print and scoped SDK paths with local
scripted model responses; they do not repeat all Ink/classic PTY variants.
Real Windows cleanup verifies that live descendants are still terminated and
incomplete historical Run evidence survives repeated sweeps.

The first broad invocation encountered a missing `packages/coding/dist` during
module resolution: one suite could not collect and one subprocess could not
start. After the package build, both affected suites passed serially (10 cases),
with no runtime source change. Those initial failures are not counted as passes;
the table deduplicates cases whose reruns passed. The strengthened bundled case
also passed separately after its final cleanup changes.

## 2026-10-31 recurrence coverage

The original alpha.10 investigation above remains historical. The locally
rebuilt alpha.11 recurrence is a second initial-recovery branch, not removal
of the complete-exited-tree optimization. Both failed real bootstrap attempts
stopped before runtime readiness; the real registry held 3,264 records, 2,103
without root start identity. Do not clear this registry to make startup fast.

Run the new deterministic cases through the public cleanup API:

```powershell
npx vitest run packages/agent/src/runtime/managed-child-processes.cache.test.ts
```

They failed before their respective fixes with eight OS lookups per eight
records. Missing root identities now require zero OS queries and preserve each
original file byte-for-byte. Known reused identities require one shared snapshot
and zero per-record command-line queries; their original bytes survive in the
existing `.unresolved` quarantine. All process signals in these fixtures must be
existence checks only. Matching identities and unknown snapshot results retain
the original confirmation path and exact termination fences.

The native isolated public-SDK comparison measured 7,286 ms / eight queries
before and 3 ms / zero queries after for eight missing-identity records. A
3,264-record patched sweep took 146 ms. No native probe touched the real home.

```powershell
node --test tests/bundled-startup-recovery.test.mjs
```

This additionally starts the real bundled Host with 512 records covering missing
identities, known PID reuse, and incomplete trees with extinct/reused roots.
The live reused PID is the unrelated test process; absent PIDs are checked before
fixture construction. The two identity shortcuts alone still timed out against
the real default home: incomplete non-Run trees were also paying for a termination
helper per record without gaining cleanup proof. The strengthened bundled case
reproduced that same daemon-startup error in 12,485 ms before the third fix.
Non-Run recovery now reuses the existing incomplete-tree check; known live
retained descendants still require exact cleanup, guarded by a separate test.
Non-Run unknown snapshot evidence alone must not bypass cleanup: the additional
unavailable-snapshot/CIM-confirmed-live-root case failed during review and passed
after restricting the shortcut to known absence or identity mismatch.
It requires readiness below 10 seconds, reads saved history, verifies exact
Host/Job shutdown and repeats recovery in a new generation. All evidence bytes
and saved messages must survive both generations. Observed cold/restart times
were 2,205 / 1,570 ms. The original 220-tree case remained green at 2,597 ms,
with 48-ms first concurrent history reads and 1,509-ms restart. Timings are local
isolated observations, not an SLA or real-home before/after comparison.

The final isolated build also resumed the actual default home in 3,197 ms and
read the reported Session/history in 58 ms. Every one of the 2,908 registry files
present before that attempt survived with unchanged bytes in the registry or
quarantine; auth/config bytes were unchanged. Earlier failed normal recovery
had already quarantined part of the original 3,264 records. This is real-home
acceptance, not an identical-input performance comparison or a registry reset.

The representative standalone LSP suite left six registry files in an isolated
substitute user profile before test-home isolation and zero there afterwards.
`tests/test-home-isolation.test.ts` guards the private fallback and restoration
after environment stubs. Explicit default-path tests must unset `KODAX_HOME`;
ordinary tests must not use a developer's actual home. Nonempty temporary homes
are retained as evidence, not recursively deleted while cleanup is uncertain.
The legacy MCP OAuth test also binds token reads and cleanup to its own temporary
fixture. A sentinel under a substitute profile's token directory must survive
that suite; before the correction it was deleted. The interrupted first broad
run is not counted as regression acceptance. The second broad run was also
interrupted when the third runtime branch was identified; it is not counted.

## Final recurrence acceptance (2026-10-31)

Runtime source was frozen at `16973a93`. Follow-ups `4d087b03` and `e4cad09c`
only correct test fixtures. The actual Main checkout was fast-forwarded with a
clean-tree/expected-HEAD guard and rebuilt; another workspace's changes were
not overwritten. The linked Main CLI restored the reported Session and reached
its input prompt in 3,470 ms, exited normally with code 0, and retained the
exact auth/config bytes. No user prompt or model request was submitted.

The worktree-origin acceptance Host was retired through its normal shutdown
API only after matching its exact runtime ID/PID and confirming it was idle
with no peer client. Its Host/Windows Job exit was verified before testing the
Main installation. A different-installation rejection during this handoff was
the existing ownership fence, not a reason to force-replace a user Host.

| Verification | Result |
| --- | --- |
| Final broad source invocation, isolated worktree, two workers, no retries | 18,733 passed, 48 failed, 100 skipped, 19 todo; 1,369 files; 2,125.83 s |
| Final Main complete-file reruns, eight files, two workers, no retries | 1,547 passed, 0 failed, 41 skipped; 96.98 s |
| Source acceptance after replacing each rerun file's whole result, without counting duplicates | 18,783 passed, 98 skipped, 19 todo; no unresolved failed case |
| Main's 21 built acceptance files | 81 unique cases accepted after the Skill-file rerun described below |
| Final Main `e4cad09c`: historical owner/tarball cutover and integrity-pinned alpha.11 Host upgrade | 4 passed; 48.288 s; actual tarball SHA-256 `2b211734e693cd36be320faa30b14bf598288c958e364f7a9366f22efeb02873` |
| Registry/Run/scope/process-tree Windows regressions before the final boundary case | 139 passed, 2 skipped |
| Final registry/caller coverage invocation, including all final boundary cases | 93 passed |
| Legacy home fixtures and default-directory follow-ups | 165 + 23 passed |
| Main package/native/bundle/declaration build; source/test type checks; CLI budget | Passed |

The 48 broad-run failures were not silently retried or counted as passes:

- Twenty-five were old fixture/expectation assumptions exposed by private
  `KODAX_HOME`: Session public API (23), core export (1), and the default agents
  directory (1). Bind HOME-only fixtures explicitly to their own config home;
  test the homedir fallback with the override unset. The final Main rerun uses
  the corrected cases. Dual-writer and extension-store fixtures were also bound
  explicitly so their temporary cleanup covers their own writes.
- Twenty-two were caused by the broad invocation substituting a USERPROFILE
  inside system temp: NUL setup read-root expectations (1), Auto permission
  classification (18), and protected-path classification (3). The corresponding
  complete files passed with the ordinary user profile and private test config
  homes. No production permission rule was changed to fit that artificial profile.
- One isolated npm consumer install used a different registry from the project's
  local `.npmrc` and reported ETARGET with `--prefer-offline`. Fresh metadata
  checks resolved the reported versions; the final consumer test inherited the
  project's `npm_config_registry=https://registry.npmmirror.com` and passed.
  Dependency versions were not changed. Record the registry when reproducing it.

The final Main rerun additionally executes the read-only real-session parser
file. Its two corpus checks were skipped under the substitute profile and both
passed against the actual existing corpus; this explains the 100-to-98 skipped
count. No transcript, credential or account was changed for these checks.

One initial built Skill catalog `ama/default` Run returned phase `failed`.
Its isolated case then passed, and the complete six-case Skill file passed.
The initial cause was not captured or attributed; these reruns are acceptance
evidence, not a claim that this patch fixed a Skill/model failure. The initial
historical-Host command also omitted its required pinned tarball environment;
the correctly configured alpha.11 test passed afterwards. Neither initial
failure is reported as a clean first invocation.

The changed runtime statements have 13/13 coverage (100%); changed branch paths
have 14/16 coverage (87.5%). The 93-case coverage subset reports 74.01% for the
whole existing registry module; it is not a repository-wide coverage result.
This work invokes no paid provider or live LLM evaluation.

The Main build's 262-file manifest was unchanged through the built acceptance,
PTY and test-only follow-ups (aggregate SHA-256
`d0e49fac03b00ad0142e72df81d03cd58e20c53f91adc2406bea1c814810bf7c`).
The full source suite ran in the isolated worktree; built acceptance and PTY
ran in the actual Main checkout. Their tracked source differs only in checkout
line endings before the identical test-only follow-ups; this is not a claim
that the worktree and Main's separately built assets have identical bytes.
Main's native artifacts match its earlier successful full-regression baseline.
No push, release, design-subrepository or Space product change is part of this fix.

## Standards

Independent read-only review: zero unresolved findings. Test fixture scoping,
cleanup containment, error propagation and the minimal runtime changes conform
to AGENTS.md. The first and subsequent runtime/test deltas were reviewed separately.

## Spec

Independent read-only review: zero unresolved findings. Review findings about
the legacy OAuth test's real-home cleanup and the unavailable-snapshot/CIM-matched
live root were fixed with failing-then-passing regressions. Unknown evidence,
owner fencing, Run references, complete-tree proof and exact cleanup authority
remain covered. Passing review does not turn skipped/todo cases or the historical
first-read observation into completed acceptance.


## Skip/TODO coverage audit (2026-10-31)

This inventory is pinned to Root `5e1c6e4d` and the preceding file-level
acceptance merge: exactly 98 skipped and 19 todo cases. A skip is not a pass;
a TODO is not proof that the underlying function is missing. This audit compares
test registration guards, current call sites, replacement tests and declared
platform/release gates. It does not certify an unexecuted CI job or remote account.

### The 98 skipped cases

| Category | Cases | Reason and required follow-up |
| --- | ---: | --- |
| POSIX/Linux platform gates | 41 | 24 non-Windows cases inside the legacy-named ASRT Skill group, 3 portable ASRT cases, and 14 other POSIX/Linux cases. Includes Linux zombie-owner recovery, POSIX PID identity fences, private config permissions and native-state/alias boundaries. Run on actual Linux/macOS; the Linux-only zombie test also requires python3. Four real-POSIX shell-policy cases additionally require KODAX_REAL_POSIX_SANDBOX=1. |
| Real Windows v2 policy gate | 25 | Requires win32 and KODAX_REAL_WINDOWS_SANDBOX_V2=1, a provisioned native sandbox/account and system policy support. Includes Job drain after cancellation/host loss, controller repair and concurrent roots. Use an isolated Windows runner; this local broad run did not execute these cases. |
| Unreachable legacy Windows ASRT cases | 10 | Outer describe.skipIf(win32) and inner it.runIf(win32) cannot both admit execution on any platform. Review retirement against the current Windows v2 contract; migrate still-required assertions instead of enabling an obsolete backend. |
| Unconditionally skipped Git relationship cases | 3 | Linked worktree main .git read/deny-write, bounded relationship metadata and nested-submodule backlink validation. Current SDK worktree discovery/registration tests do not replace the exact sandbox-policy assertions. Port these obligations to the current Windows v2 path. |
| Artifact browser/render gates | 12 | KODAX_ARTIFACT_TEST_BROWSER is absent. Browser, PDF, DOCX, HTML/SVG and PPTX pixel evidence; separate from the credential/recovery acceptance scope. |
| Manual experiment/capture gates | 7 | One complex compaction live evaluation, four factorial live arms, one original-version Runtime smoke, and one explicitly gated offline paired capture. Follow EVAL_GUIDELINES; the offline probe is not a paid model test. |

Linux/POSIX and real Windows v2 jobs are configured in
[ci.yml](../../.github/workflows/ci.yml) and
[release.yml](../../.github/workflows/release.yml). Configuration is evidence of
a gate, not evidence that these unpublished local commits passed it. In particular,
the 41 platform cases must not be reported as verified by this Windows run.

### What the 19 TODOs actually mean

| Capability | Count | Current evidence and decision |
| --- | ---: | --- |
| CAP-001 repository intelligence | 3 | Current entry still invokes reasoning-plan-entry/repo-intelligence; deeper full-engine, low-confidence and injected-error obligations remain worth testing. Add focused offline public/call-site checks; no substrate migration is required to start. |
| CAP-013 error snapshot | 2 | CAP-082 already checks cleaned snapshot messages and consecutive error increments, and run-substrate calls runCatchCleanup. The TODO wording is stale; add/attribute a public crash -> persisted save -> cold resume combination rather than claiming these mechanisms are absent. |
| CAP-014 microcompaction | 2 | No production call to the legacy microcompact helper was found; the exported helper remains for compatibility and defaults disabled. The old per-turn ordering TODO must be reconciled with current compaction policy; explicit legacy multi-tool aging can be tested without restoring an obsolete runtime hook. |
| CAP-015 edit recovery | 2 | Candidate extraction is already exercised against a real temporary file in this same suite. The other TODO says a successful read clears a write block, but current source explicitly clears on successful edit/compatible anchor insertion, and CAP-026 asserts read leaves attempts alone. Rewrite the obsolete contract; do not weaken the overwrite protection to satisfy its text. |
| CAP-016 mutation reflection | 2 | The old SA/AMA Generator declaration assertions are outdated. Current tool-dispatch and Script pilot use mutationScopeReflection; test the current false gate and once-only behavior at that entry. |
| CAP-017 pre-answer judge | 2 | Old latch/call-site obligations have no current execution references beyond initialized compatibility fields. coding-preset still advertises a legacy declaration: reconcile the metadata/tests with the retired judging architecture, and guard against accidental extra model calls. |
| CAP-018 post-tool judge | 2 | Same stale declaration/latch problem; the Generator/Evaluator requirement is obsolete. Do not restore the retired workflow to turn the counter green. |
| CAP-020 extension queue | 2 | CAP-050 and agent.extension-runtime cover extension state/records and resume. Pending queuedMessages are not part of persisted extension snapshots and are initialized empty. Replace the blanket queue-roundtrip/old-microcompact ordering requirement with current settle/drain and non-replay contracts. |
| CAP-045 session loading | 1 | CAP-008 checks storage.load messages/title/errorMetadata/extension fields; agent.extension-runtime exercises a real run/resume. A consolidated public old-session/cold-Host metadata ordering test is still useful. |
| CAP-047 managed protocol | 1 | Merge helper tests exist; the full compatible return-payload matrix across completion, failure, interruption and limits is not pinned by this TODO. Add current public terminal-path coverage for supported legacy fields, without restoring V1 roles. |

Replacement evidence inspected: [CAP-008](../../packages/coding/src/agent-runtime/__contract-tests__/cap-008-session-resume.contract.test.ts),
[CAP-082](../../packages/coding/src/agent-runtime/__contract-tests__/cap-082-catch-cleanup.contract.test.ts),
[CAP-050](../../packages/coding/src/agent-runtime/__contract-tests__/cap-050-runtime-session-state.contract.test.ts),
[CAP-026](../../packages/coding/src/agent-runtime/__contract-tests__/cap-026-tool-outcome-tracking.contract.test.ts),
[extension resume](../../packages/coding/src/agent.extension-runtime.test.ts), and
[current error finalization](../../packages/coding/src/agent-runtime/run-substrate.ts#L1563).
Source comments that still mention agent.ts/P3 or Generator are historical, not
an accepted instruction to reintroduce removed behavior.

### Recovery, credentials and upgrade priorities

1. **P1, offline composed recovery:** pin public execution through crash,
   cleaned snapshot persistence, cold Host recreation and old-session load.
   Assert title/error counters/extension records, complete tool-call history,
   no duplicate effects and fresh authorization before new work. Existing unit
   and real-Host tests cover important parts; this is a request to combine the
   failure boundaries, not evidence that all these behaviors are missing.
2. **P1, composed credential migration/recovery:** extend a real process fixture
   to combine an owned legacy credential-format fixture, migration interruption,
   account A/B selection, delayed refresh/revocation and Host restart. Require
   original-account retention, durable commit before token use, no legacy grant
   resurrection and no ambient-key fallback after rejection. The pinned alpha.11
   Host-upgrade fixture uses an API-key environment source, so its success does
   not certify this OAuth migration combination.
   Only an explicit account choice may change identity; an ambiguous migration
   source must remain actionable rather than automatically selecting A or B.
   The existing FEATURE_302 T12-H boundary also excludes arbitrary downgrade or
   concurrent old/new refresh owners for the same grant: old binaries do not
   understand new selections/tombstones. Verify rejection and recovery guidance
   at that boundary; retained backups are recovery material, not a second active
   credential authority. This is a known compatibility limit, not a newly proved bug.
3. **P1 release evidence:** run the Linux/macOS platform slices and the 25 real
   Windows v2 cases on their proper runners; port the three disabled Git policy
   obligations. Preserve exact revision/OS/native build and failing evidence.
   macOS/Linux legacy-vault import still needs corresponding machine evidence.
4. **P1 before paired production release:** Space's production installer,
   existing user data and locked published SDK must be accepted together by its
   owner. Root source tests/dev SDK links do not certify that installer upgrade.
5. **P2 inventory cleanup:** replace duplicate TODOs with explicit references or
   active current-entry contracts, retire the ten impossible Windows ASRT tests,
   and reconcile old judge metadata. A lower skipped/TODO count alone is not acceptance.
6. **External-account acceptance:** real Codex/OpenAI/Copilot login/refresh,
   subscription identity, remote revocation and native cloud credential chains
   need permitted test registrations/accounts. They remain offline contract
   evidence here. MiMo Coding/MiniMax Coding model entries retain the agreed
   source-based alignment where keys are unavailable; that is not live inference.

There is **no OAuth/credential-migration-named skip or TODO in these 117 rows**.
That does not establish complete remote authentication coverage: six real-provider
integration files are excluded by DEFAULT_TEST_FILES/INTEGRATION_TEST_FILES in
[tests/config/vitest.test-tiers.ts](../../tests/config/vitest.test-tiers.ts), so they do not contribute to
the 98 skipped count. They are kimi-wire, glm-history-400, image-compatibility-audit,
empty-content-wire-compat, ark-coding-image-routes, and verify-credential-integration.
The manual live probes in this inventory are also not a substitute for the
OAuth/account and cloud acceptance matrix.

Existing credential coverage includes real current-user Windows DPAPI migration,
private current-user/SYSTEM auth-file ACLs, independent-process whole-document
serialization, corruption/stale-revision rejection, tombstones, delayed refresh
fencing, refresh rotation durable commit, profile/issuer/connection proof and
Host epoch rebinding. Relevant tests are
[provider OAuth migration](../../src/provider-oauth-store.test.ts),
[auth file](../../packages/llm/src/auth-file.test.ts),
[OAuth sessions](../../packages/llm/src/oauth/session.test.ts),
[authorizer](../../src/provider-credential-authorizer.test.ts), and
[OAuth broker binding](../../src/oauth-credential-binding.test.ts).
The [FEATURE_302 ledger](FEATURE_302_v0.7.99_TEST_GUIDE.md#final-verification-ledger)
already marks the live-service, non-Windows vault and installer limits explicitly.

This audit reran 12 selected replacement/recovery/credential suites at the same
runtime revision: **96 passed, 0 failed, 2 existing TODOs** (the two CAP-015 labels
discussed above). Fixtures use temporary private homes; real service accounts,
system sandbox activation and paid LLM probes were not part of this audit.

### Complete skipped inventory

Each row is one case from the accepted result set, including parameter expansions.
The source location and guard are listed so the original 98 can be reproduced.

| ID | Category | Exact case | Source / registration guard |
| --- | --- | --- | --- |
| S001 | POSIX/Linux 平台门禁 | POSIX interpreter readiness does not gate ordinary Linux shell preparation on doctor readiness | [sandbox-runtime.posix-readiness.test.ts:63](../../src/sandbox-runtime.posix-readiness.test.ts#L63); describe -> it.runIf(platform.value === 'linux') |
| S002 | POSIX/Linux 平台门禁 | portable ASRT shell adapter prepares independent per-command brokers without a workspace-session owner | [sandbox-runtime.test.ts:1633](../../src/sandbox-runtime.test.ts#L1633); describe.skipIf(process.platform === 'win32') -> it |
| S003 | POSIX/Linux 平台门禁 | portable ASRT shell adapter leaves a non-admitted call on the normal permission path | [sandbox-runtime.test.ts:1674](../../src/sandbox-runtime.test.ts#L1674); describe.skipIf(process.platform === 'win32') -> it |
| S004 | POSIX/Linux 平台门禁 | portable ASRT shell adapter rejects model Bash read carve-backs into trusted text native state | [sandbox-runtime.test.ts:1690](../../src/sandbox-runtime.test.ts#L1690); describe.skipIf(process.platform === 'win32') -> it |
| S005 | Git 关系验证长期禁用 | Windows git safe.directory argv takeover grants a linked worktree read access to the main .git and denies gitfile edits | [sandbox-runtime.test.ts:1936](../../src/sandbox-runtime.test.ts#L1936); describe -> it.skip |
| S006 | Git 关系验证长期禁用 | Windows git safe.directory argv takeover bounds linked-worktree relationship metadata before granting main .git access | [sandbox-runtime.test.ts:2053](../../src/sandbox-runtime.test.ts#L2053); describe -> it.skip |
| S007 | Git 关系验证长期禁用 | Windows git safe.directory argv takeover binds nested submodule metadata through its core.worktree backlink | [sandbox-runtime.test.ts:2081](../../src/sandbox-runtime.test.ts#L2081); describe -> it.skip |
| S008 | 旧 Windows ASRT 双重门禁 | legacy ASRT Skill-script adapter stages a user-installed Windows runner in a protected KodaX directory | [sandbox-runtime.test.ts:4975](../../src/sandbox-runtime.test.ts#L4975); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform === 'win32') |
| S009 | 旧 Windows ASRT 双重门禁 | legacy ASRT Skill-script adapter uses the staged runner instead of ASRT packaged-binary dependency probes | [sandbox-runtime.test.ts:5018](../../src/sandbox-runtime.test.ts#L5018); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform === 'win32') |
| S010 | 旧 Windows ASRT 双重门禁 | legacy ASRT Skill-script adapter does not make obsolete persistent read guards a doctor prerequisite | [sandbox-runtime.test.ts:5043](../../src/sandbox-runtime.test.ts#L5043); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform === 'win32') |
| S011 | 旧 Windows ASRT 双重门禁 | legacy ASRT Skill-script adapter does not probe obsolete persistent read guards during doctor | [sandbox-runtime.test.ts:5060](../../src/sandbox-runtime.test.ts#L5060); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform === 'win32') |
| S012 | 旧 Windows ASRT 双重门禁 | legacy ASRT Skill-script adapter reports an incomplete Windows account before attempting the WFP runner | [sandbox-runtime.test.ts:5074](../../src/sandbox-runtime.test.ts#L5074); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform === 'win32') |
| S013 | 旧 Windows ASRT 双重门禁 | legacy ASRT Skill-script adapter distinguishes a Windows runner access failure from account and WFP policy failures | [sandbox-runtime.test.ts:5093](../../src/sandbox-runtime.test.ts#L5093); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform === 'win32') |
| S014 | 旧 Windows ASRT 双重门禁 | legacy ASRT Skill-script adapter reports a bounded Windows WFP verification timeout distinctly | [sandbox-runtime.test.ts:5113](../../src/sandbox-runtime.test.ts#L5113); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform === 'win32') |
| S015 | 旧 Windows ASRT 双重门禁 | legacy ASRT Skill-script adapter revokes a partial Windows runner ACL grant before a bounded retry | [sandbox-runtime.test.ts:5128](../../src/sandbox-runtime.test.ts#L5128); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform === 'win32') |
| S016 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter checks the exact installed version and required JavaScript interpreter | [sandbox-runtime.test.ts:5154](../../src/sandbox-runtime.test.ts#L5154); describe.skipIf(process.platform === 'win32') -> it |
| S017 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter fails closed when configuration admits a script absent from the pinned Skill snapshot | [sandbox-runtime.test.ts:5162](../../src/sandbox-runtime.test.ts#L5162); describe.skipIf(process.platform === 'win32') -> it |
| S018 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter rejects call-time scripts outside the exact prepared admission | [sandbox-runtime.test.ts:5176](../../src/sandbox-runtime.test.ts#L5176); describe.skipIf(process.platform === 'win32') -> it |
| S019 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter runs one exact admission with a clean broker contract and promotes declared output | [sandbox-runtime.test.ts:5197](../../src/sandbox-runtime.test.ts#L5197); describe.skipIf(process.platform === 'win32') -> it |
| S020 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter enforces argument, mapping, cancellation, and workspace-access bounds before execution | [sandbox-runtime.test.ts:5245](../../src/sandbox-runtime.test.ts#L5245); describe.skipIf(process.platform === 'win32') -> it |
| S021 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter rejects sensitive, escaping, existing, and over-quota workspace outputs | [sandbox-runtime.test.ts:5276](../../src/sandbox-runtime.test.ts#L5276); describe.skipIf(process.platform === 'win32') -> it |
| S022 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter rejects unsafe admission paths and unsupported script types | [sandbox-runtime.test.ts:5308](../../src/sandbox-runtime.test.ts#L5308); describe.skipIf(process.platform === 'win32') -> it |
| S023 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter runs the standalone broker entry with the same pinned request shape | [sandbox-runtime.test.ts:5334](../../src/sandbox-runtime.test.ts#L5334); describe.skipIf(process.platform === 'win32') -> it |
| S024 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter reports pre-start unavailability without directly replaying on the host | [sandbox-runtime.test.ts:5379](../../src/sandbox-runtime.test.ts#L5379); describe.skipIf(process.platform === 'win32') -> it |
| S025 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter does not replay when a spawned wrapper exits without target attestation | [sandbox-runtime.test.ts:5413](../../src/sandbox-runtime.test.ts#L5413); describe.skipIf(process.platform === 'win32') -> it |
| S026 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter reports wrapper pre-start failure without directly replaying on the host | [sandbox-runtime.test.ts:5446](../../src/sandbox-runtime.test.ts#L5446); describe.skipIf(process.platform === 'win32') -> it |
| S027 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter drains target attestation before deciding whether fallback is safe | [sandbox-runtime.test.ts:5479](../../src/sandbox-runtime.test.ts#L5479); describe.skipIf(process.platform === 'win32') -> it |
| S028 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter does not re-inject host secrets into a POSIX broker child environment | [sandbox-runtime.test.ts:5511](../../src/sandbox-runtime.test.ts#L5511); describe.skipIf(process.platform === 'win32') -> it |
| S029 | 旧 Windows ASRT 双重门禁 | legacy ASRT Skill-script adapter keeps Windows command arguments exact behind an encoded argv bootstrap | [sandbox-runtime.test.ts:5546](../../src/sandbox-runtime.test.ts#L5546); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform === 'win32') |
| S030 | 旧 Windows ASRT 双重门禁 | legacy ASRT Skill-script adapter rejects case-ambiguous Windows child environment names before spawn | [sandbox-runtime.test.ts:5601](../../src/sandbox-runtime.test.ts#L5601); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform === 'win32') |
| S031 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter force-terminates a broker that ignores SIGTERM after 'timeout' | [sandbox-runtime.test.ts:5629](../../src/sandbox-runtime.test.ts#L5629); describe.skipIf(process.platform === 'win32') -> it.each([ { name: 'timeout', mode: 'silent' as const, options: { timeoutMs: 10 }, expected: /exceeded its 10 ms timeout/i, }, { name: 'output overflow', mode: 'overflow' as const... |
| S032 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter force-terminates a broker that ignores SIGTERM after 'output overflow' | [sandbox-runtime.test.ts:5629](../../src/sandbox-runtime.test.ts#L5629); describe.skipIf(process.platform === 'win32') -> it.each([ { name: 'timeout', mode: 'silent' as const, options: { timeoutMs: 10 }, expected: /exceeded its 10 ms timeout/i, }, { name: 'output overflow', mode: 'overflow' as const... |
| S033 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter rejects POSIX shell write roots that overlap trusted text native state before spawn | [sandbox-runtime.test.ts:5658](../../src/sandbox-runtime.test.ts#L5658); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform !== 'win32') |
| S034 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter rejects POSIX shell read carve-back through the exact protected root | [sandbox-runtime.test.ts:5675](../../src/sandbox-runtime.test.ts#L5675); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform !== 'win32').each([ ['the exact protected root', (protectedRoot: string) => protectedRoot], ['a broad filesystem ancestor', (protectedRoot: string) => p... |
| S035 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter rejects POSIX shell read carve-back through a broad filesystem ancestor | [sandbox-runtime.test.ts:5675](../../src/sandbox-runtime.test.ts#L5675); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform !== 'win32').each([ ['the exact protected root', (protectedRoot: string) => protectedRoot], ['a broad filesystem ancestor', (protectedRoot: string) => p... |
| S036 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter canonicalizes a POSIX symlink ancestor before checking a missing write leaf | [sandbox-runtime.test.ts:5695](../../src/sandbox-runtime.test.ts#L5695); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform !== 'win32') |
| S037 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter forces trusted text native state into POSIX shell read and write denies | [sandbox-runtime.test.ts:5717](../../src/sandbox-runtime.test.ts#L5717); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform !== 'win32') |
| S038 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter reports a proven pre-target POSIX backend failure as unavailable | [sandbox-runtime.test.ts:5742](../../src/sandbox-runtime.test.ts#L5742); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform !== 'win32') |
| S039 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter never accepts an ordinary-permission fallback as a sandboxed SDK completion | [sandbox-runtime.test.ts:5763](../../src/sandbox-runtime.test.ts#L5763); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform !== 'win32') |
| S040 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter reports missing or mismatched broker control as execution-uncertain | [sandbox-runtime.test.ts:5782](../../src/sandbox-runtime.test.ts#L5782); describe.skipIf(process.platform === 'win32') -> it.runIf(process.platform !== 'win32') |
| S041 | POSIX/Linux 平台门禁 | legacy ASRT Skill-script adapter force-terminates a broker that ignores cancellation | [sandbox-runtime.test.ts:5809](../../src/sandbox-runtime.test.ts#L5809); describe.skipIf(process.platform === 'win32') -> it |
| S042 | POSIX/Linux 平台门禁 | Unix native text state boundary rejects a symlinked KODAX_HOME before provisioning protected state | [windows-native-artifacts.test.ts:893](../../src/windows-native-artifacts.test.ts#L893); describe.skipIf(process.platform === 'win32') -> it |
| S043 | POSIX/Linux 平台门禁 | Unix native text state boundary uses one UID-scoped coordination root across different KODAX_HOME values | [windows-native-artifacts.test.ts:908](../../src/windows-native-artifacts.test.ts#L908); describe.skipIf(process.platform === 'win32') -> it |
| S044 | POSIX/Linux 平台门禁 | Windows trusted text transaction integration reauthorizes a canonical receipt path below an aliased write root | [windows-text-transaction.test.ts:461](../../src/windows-text-transaction.test.ts#L461); describe -> posixIt |
| S045 | POSIX/Linux 平台门禁 | FEATURE_295 real POSIX shell sandbox runs independent policies concurrently and enforces each write root | [feature-295-posix-shell-policy.test.ts:88](../../tests/feature-295-posix-shell-policy.test.ts#L88); describe.runIf(realPosixGate) -> it |
| S046 | POSIX/Linux 平台门禁 | FEATURE_295 real POSIX shell sandbox keeps trusted text writes independent from a live shell sandbox | [feature-295-posix-shell-policy.test.ts:188](../../tests/feature-295-posix-shell-policy.test.ts#L188); describe.runIf(realPosixGate) -> it |
| S047 | POSIX/Linux 平台门禁 | FEATURE_295 real POSIX shell sandbox does not let the sandbox target forge broker control authority | [feature-295-posix-shell-policy.test.ts:258](../../tests/feature-295-posix-shell-policy.test.ts#L258); describe.runIf(realPosixGate) -> it |
| S048 | POSIX/Linux 平台门禁 | FEATURE_295 real POSIX shell sandbox rejects protected-state allow carve-backs before POSIX sandbox launch | [feature-295-posix-shell-policy.test.ts:280](../../tests/feature-295-posix-shell-policy.test.ts#L280); describe.runIf(realPosixGate) -> it |
| S049 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation starts an inbox Windows command under the restricted target token | [feature-295-windows-v2-policy.test.ts:731](../../tests/feature-295-windows-v2-policy.test.ts#L731); describe.runIf(realWindowsV2) -> it |
| S050 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation lets every trusted text tool replace a file created by the sandbox account | [feature-295-windows-v2-policy.test.ts:754](../../tests/feature-295-windows-v2-policy.test.ts#L754); describe.runIf(realWindowsV2) -> it |
| S051 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation self-heals a sandbox-owned file with stale inherited ACLs without disabling inheritance | [feature-295-windows-v2-policy.test.ts:800](../../tests/feature-295-windows-v2-policy.test.ts#L800); describe.runIf(realWindowsV2) -> it |
| S052 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation reaches private read/write roots without exposing their parent or siblings | [feature-295-windows-v2-policy.test.ts:842](../../tests/feature-295-windows-v2-policy.test.ts#L842); describe.runIf(realWindowsV2) -> it |
| S053 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation fails closed on unsupported denyRead before target start or DACL mutation | [feature-295-windows-v2-policy.test.ts:897](../../tests/feature-295-windows-v2-policy.test.ts#L897); describe.runIf(realWindowsV2) -> it |
| S054 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation keeps the shared controller pipe host-only under restricted connection pressure | [feature-295-windows-v2-policy.test.ts:938](../../tests/feature-295-windows-v2-policy.test.ts#L938); describe.runIf(realWindowsV2) -> it |
| S055 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation keeps control state host-only and native host rejects a forged overlapping grant | [feature-295-windows-v2-policy.test.ts:998](../../tests/feature-295-windows-v2-policy.test.ts#L998); describe.runIf(realWindowsV2) -> it |
| S056 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation keeps doctor verify-only and setup retires dead request/staging creators before control repair | [feature-295-windows-v2-policy.test.ts:1137](../../tests/feature-295-windows-v2-policy.test.ts#L1137); describe.runIf(realWindowsV2) -> it |
| S057 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation returns the original timeout only after the native Job and descendants drain | [feature-295-windows-v2-policy.test.ts:1240](../../tests/feature-295-windows-v2-policy.test.ts#L1240); describe.runIf(realWindowsV2) -> it |
| S058 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation returns the original cancellation only after the native Job and descendants drain | [feature-295-windows-v2-policy.test.ts:1300](../../tests/feature-295-windows-v2-policy.test.ts#L1300); describe.runIf(realWindowsV2) -> it |
| S059 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation allows policy A in A but denies policy B from writing A | [feature-295-windows-v2-policy.test.ts:1350](../../tests/feature-295-windows-v2-policy.test.ts#L1350); describe.runIf(realWindowsV2) -> it |
| S060 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation starts two cold Runtime processes with the exact same write root and keeps the first active | [feature-295-windows-v2-policy.test.ts:1416](../../tests/feature-295-windows-v2-policy.test.ts#L1416); describe.runIf(realWindowsV2) -> it.each([ ['the exact same write root', 'same-root'], ['an ancestor read plus a child write root', 'ancestor-read-child-write'], ] as const) |
| S061 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation starts two cold Runtime processes with an ancestor read plus a child write root and keeps the first active | [feature-295-windows-v2-policy.test.ts:1416](../../tests/feature-295-windows-v2-policy.test.ts#L1416); describe.runIf(realWindowsV2) -> it.each([ ['the exact same write root', 'same-root'], ['an ancestor read plus a child write root', 'ancestor-read-child-write'], ] as const) |
| S062 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation starts two truly cold Runtime processes against a 24k-entry tree with the exact same write root | [feature-295-windows-v2-policy.test.ts:1602](../../tests/feature-295-windows-v2-policy.test.ts#L1602); describe.runIf(realWindowsV2) -> it.each([ ['the exact same write root', 'same-root'], ['an ancestor read plus child write roots', 'ancestor-read-child-write'], ] as const) |
| S063 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation starts two truly cold Runtime processes against a 24k-entry tree with an ancestor read plus child write roots | [feature-295-windows-v2-policy.test.ts:1602](../../tests/feature-295-windows-v2-policy.test.ts#L1602); describe.runIf(realWindowsV2) -> it.each([ ['the exact same write root', 'same-root'], ['an ancestor read plus child write roots', 'ancestor-read-child-write'], ] as const) |
| S064 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation keeps real background Bash, a second Runtime Bash, and trusted text writes concurrent | [feature-295-windows-v2-policy.test.ts:1773](../../tests/feature-295-windows-v2-policy.test.ts#L1773); describe.runIf(realWindowsV2) -> it |
| S065 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation shares one same-policy proxy when fixed Windows proxy ports are under pressure | [feature-295-windows-v2-policy.test.ts:1903](../../tests/feature-295-windows-v2-policy.test.ts#L1903); describe.runIf(realWindowsV2) -> it |
| S066 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation fails concurrent denyRead policies closed without starting targets or writing receipts | [feature-295-windows-v2-policy.test.ts:1946](../../tests/feature-295-windows-v2-policy.test.ts#L1946); describe.runIf(realWindowsV2) -> it |
| S067 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation keeps every trusted text tool available while a different-file shell stays alive | [feature-295-windows-v2-policy.test.ts:2000](../../tests/feature-295-windows-v2-policy.test.ts#L2000); describe.runIf(realWindowsV2) -> it |
| S068 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation drains the real sandbox Job after terminating its target and keeps trusted Write available | [feature-295-windows-v2-policy.test.ts:2083](../../tests/feature-295-windows-v2-policy.test.ts#L2083); describe.runIf(realWindowsV2) -> it.each(['target', 'runner', 'host'] as const) |
| S069 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation drains the real sandbox Job after terminating its runner and keeps trusted Write available | [feature-295-windows-v2-policy.test.ts:2083](../../tests/feature-295-windows-v2-policy.test.ts#L2083); describe.runIf(realWindowsV2) -> it.each(['target', 'runner', 'host'] as const) |
| S070 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation drains the real sandbox Job after terminating its host and keeps trusted Write available | [feature-295-windows-v2-policy.test.ts:2083](../../tests/feature-295-windows-v2-policy.test.ts#L2083); describe.runIf(realWindowsV2) -> it.each(['target', 'runner', 'host'] as const) |
| S071 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation fails closed on controller loss, drains the active Job, and recreates a broker | [feature-295-windows-v2-policy.test.ts:2192](../../tests/feature-295-windows-v2-policy.test.ts#L2192); describe.runIf(realWindowsV2) -> it |
| S072 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation does not let a restricted shell open host text or ACL namespaces | [feature-295-windows-v2-policy.test.ts:2272](../../tests/feature-295-windows-v2-policy.test.ts#L2272); describe.runIf(realWindowsV2) -> it |
| S073 | Windows 真机门禁 | FEATURE_295 real Windows policy isolation does not let one policy open another policy private desktop | [feature-295-windows-v2-policy.test.ts:2338](../../tests/feature-295-windows-v2-policy.test.ts#L2338); describe.runIf(realWindowsV2) -> it |
| S074 | 手工实验/捕获门禁 | manual frozen compact-contract complex evaluation | [first-turn-compact-complex-live.test.ts:7](../../tests/first-turn-compact-complex-live.test.ts#L7); it.skipIf(process.env.KODAX_CONTRACT_COMPLEX_LIVE !== 'authorized') |
| S075 | 手工实验/捕获门禁 | factorial 1 old-old | [late-reminder-factorial.test.ts:95](../../tests/late-reminder-factorial.test.ts#L95); it.skipIf(!provider) |
| S076 | 手工实验/捕获门禁 | factorial 1 new-old | [late-reminder-factorial.test.ts:95](../../tests/late-reminder-factorial.test.ts#L95); it.skipIf(!provider) |
| S077 | 手工实验/捕获门禁 | factorial 1 old-new | [late-reminder-factorial.test.ts:95](../../tests/late-reminder-factorial.test.ts#L95); it.skipIf(!provider) |
| S078 | 手工实验/捕获门禁 | factorial 1 new-new | [late-reminder-factorial.test.ts:95](../../tests/late-reminder-factorial.test.ts#L95); it.skipIf(!provider) |
| S079 | 手工实验/捕获门禁 | serializes the same frozen first/second-turn histories with the actual SDK without network | [original-version-probe.test.ts:29](../../tests/original-version-probe.test.ts#L29); it.skipIf(!process.env.KODAX_ORIGINAL_PAIRED_CAPTURE) |
| S080 | 手工实验/捕获门禁 | records one bounded original/current complete Runtime observation | [original-version-smoke.test.ts:24](../../tests/original-version-smoke.test.ts#L24); it.skipIf(!process.env.KODAX_ORIGINAL_SMOKE_ARM) |
| S081 | POSIX/Linux 平台门禁 | Host launcher waits for the original process recovers shared storage and confirms exit while the original PID is an unreaped zombie | [process.owner-exit.test.ts:22](../../src/runtime-daemon/process.owner-exit.test.ts#L22); describe -> it.skipIf(process.platform !== 'linux') |
| S082 | 浏览器渲染门禁 | prepares an actual browser and rejects an existing non-browser executable | [browser-formats.test.ts:10](../../packages/artifacts/src/browser-formats.test.ts#L10); it.skipIf(!browserExecutable) |
| S083 | 浏览器渲染门禁 | captures complete mixed PDF geometry, including the formerly cropped second page | [browser-formats.test.ts:20](../../packages/artifacts/src/browser-formats.test.ts#L20); it.skipIf(!browserExecutable) |
| S084 | 浏览器渲染门禁 | lays out minimal DOCX without settings, preserving original bytes and genuine pagination | [browser-formats.test.ts:34](../../packages/artifacts/src/browser-formats.test.ts#L34); it.skipIf(!browserExecutable) |
| S085 | 浏览器渲染门禁 | binds HTML loaded viewport and observed local dependencies, rejecting fake states | [browser-formats.test.ts:48](../../packages/artifacts/src/browser-formats.test.ts#L48); it.skipIf(!browserExecutable) |
| S086 | 浏览器渲染门禁 | samples actual SVG SMIL time and does not call animated source static or continuous | [browser-formats.test.ts:60](../../packages/artifacts/src/browser-formats.test.ts#L60); it.skipIf(!browserExecutable) |
| S087 | 浏览器渲染门禁 | retains observed HTML pixels with blocking diagnostics when image resources are missing | [browser-formats.test.ts:67](../../packages/artifacts/src/browser-formats.test.ts#L67); it.skipIf(!browserExecutable) |
| S088 | 浏览器渲染门禁 | decodes JPEG/WebP sources into readable PNG evidence and rejects corrupt JPEG | [browser-formats.test.ts:73](../../packages/artifacts/src/browser-formats.test.ts#L73); it.skipIf(!browserExecutable) |
| S089 | 浏览器渲染门禁 | renders converted PDF pixels with page binding (not a live LibreOffice test) | [pdf-render.test.ts:21](../../packages/artifacts/src/pdf-render.test.ts#L21); it.skipIf(!process.env.KODAX_ARTIFACT_TEST_BROWSER) |
| S090 | 浏览器渲染门禁 | real lightweight renderer reopens the final PPTX and returns decoded pixels bound to every requested page | [render.test.ts:10](../../packages/artifacts/src/render.test.ts#L10); describe.skipIf(!process.env.KODAX_ARTIFACT_TEST_BROWSER) -> it |
| S091 | 浏览器渲染门禁 | real lightweight renderer renders Chinese text, shapes, image, table and 2D chart from the actual PPTX | [render.test.ts:21](../../packages/artifacts/src/render.test.ts#L21); describe.skipIf(!process.env.KODAX_ARTIFACT_TEST_BROWSER) -> it |
| S092 | 浏览器渲染门禁 | real lightweight renderer reports missing fonts and corrupt image media while still exposing diagnostic pixels | [render.test.ts:36](../../packages/artifacts/src/render.test.ts#L36); describe.skipIf(!process.env.KODAX_ARTIFACT_TEST_BROWSER) -> it |
| S093 | 浏览器渲染门禁 | real lightweight renderer binds independent concurrent renders and rejects invalid/big page batches | [render.test.ts:50](../../packages/artifacts/src/render.test.ts#L50); describe.skipIf(!process.env.KODAX_ARTIFACT_TEST_BROWSER) -> it |
| S094 | POSIX/Linux 平台门禁 | FEATURE_263 learned Skill action driver refuses an existing formal Skill target that is a symlink | [learned-skill-driver.test.ts:378](../../packages/agent/src/learning/learned-skill-driver.test.ts#L378); describe -> it.skipIf(process.platform === 'win32') |
| S095 | POSIX/Linux 平台门禁 | process tree cleanup does not signal a reused POSIX pid | [process-tree.test.ts:155](../../packages/agent/src/runtime/process-tree.test.ts#L155); describe -> it.skipIf(process.platform === 'win32') |
| S096 | POSIX/Linux 平台门禁 | process tree cleanup fails closed for a matching POSIX identity | [process-tree.test.ts:176](../../packages/agent/src/runtime/process-tree.test.ts#L176); describe -> it.skipIf(process.platform === 'win32') |
| S097 | POSIX/Linux 平台门禁 | initializeSetupConfiguration creates private config directories and files on POSIX | [setup-config.test.ts:152](../../packages/repl/src/common/setup-config.test.ts#L152); describe -> it.skipIf(process.platform === 'win32') |
| S098 | POSIX/Linux 平台门禁 | FEATURE_158 — Issue 131 Windows-flag false-positive regression POSIX behavior unchanged: `/R` still treated as path on Linux/macOS | [permission.test.ts:1412](../../packages/coding/src/permissions/permission.test.ts#L1412); describe -> it.runIf(process.platform !== 'win32') |

### Complete TODO inventory

| ID | Exact deferred obligation | Source |
| --- | --- | --- |
| T001 | CAP-001: repoIntelligenceContext injection contract CAP-REPO-INTEL-002: full autoRepoMode + active-module conditions invoke getRepoPreturnBundle and prepend repoContext (integration — repo-intel runtime mocks deferred to P3 substrate test layer) | [cap-001-repo-intelligence.contract.test.ts:187](../../packages/coding/src/agent-runtime/__contract-tests__/cap-001-repo-intelligence.contract.test.ts#L187) |
| T002 | CAP-001: repoIntelligenceContext injection contract CAP-REPO-INTEL-003: module/impact confidence < 0.72 triggers fallbackGuidance with the four canonical lines (integration — getModuleContext / getImpactEstimate mocks deferred) | [cap-001-repo-intelligence.contract.test.ts:188](../../packages/coding/src/agent-runtime/__contract-tests__/cap-001-repo-intelligence.contract.test.ts#L188) |
| T003 | CAP-001: repoIntelligenceContext injection contract CAP-REPO-INTEL-004: best-effort — when underlying repo-intel APIs throw, returns options.context.repoIntelligenceContext passthrough (integration — fault-injection test deferred) | [cap-001-repo-intelligence.contract.test.ts:189](../../packages/coding/src/agent-runtime/__contract-tests__/cap-001-repo-intelligence.contract.test.ts#L189) |
| T004 | CAP-013: error snapshot persistence contract CAP-013-002: persisted messages on error path are cleaned (CAP-002) — contract is at agent.ts catch-branch call site, not at this function. Breadcrumb added there. Integration test deferred. | [cap-013-error-snapshot.contract.test.ts:87](../../packages/coding/src/agent-runtime/__contract-tests__/cap-013-error-snapshot.contract.test.ts#L87) |
| T005 | CAP-013: error snapshot persistence contract CAP-013-004: consecutiveErrors counter increments across runs (loaded from prior errorMetadata, +1 each crash) — integration test territory. | [cap-013-error-snapshot.contract.test.ts:128](../../packages/coding/src/agent-runtime/__contract-tests__/cap-013-error-snapshot.contract.test.ts#L128) |
| T006 | CAP-014: microcompact per-turn cleanup contract CAP-MICROCOMPACT-002: microcompact runs in per-turn epilogue, not pre-stream — INTEGRATION-LEVEL ordering invariant inside runKodaX, deferred to substrate-executor migration. | [cap-014-microcompact.contract.test.ts:163](../../packages/coding/src/agent-runtime/__contract-tests__/cap-014-microcompact.contract.test.ts#L163) |
| T007 | CAP-014: microcompact per-turn cleanup contract CAP-MICROCOMPACT-003: redundant tool-result echoes pruned across 5+ turn sessions — single-tool-result aging is covered by 001a; multi-tool-result pruning across multiple turns is integration-level. | [cap-014-microcompact.contract.test.ts:167](../../packages/coding/src/agent-runtime/__contract-tests__/cap-014-microcompact.contract.test.ts#L167) |
| T008 | CAP-015: edit anchor recovery + write-block contract CAP-EDIT-RECOVERY-001-CANDIDATES: ≤ 2-attempts branch reads file from disk via inspectEditFailure and includes candidate anchor windows (integration — fs-mock deferred) | [cap-015-edit-recovery.contract.test.ts:271](../../packages/coding/src/agent-runtime/__contract-tests__/cap-015-edit-recovery.contract.test.ts#L271) |
| T009 | CAP-015: edit anchor recovery + write-block contract CAP-EDIT-RECOVERY-003: write-block cleared on successful re-read tool against same path (integration with updateToolOutcomeTracking — agent.ts call site) | [cap-015-edit-recovery.contract.test.ts:272](../../packages/coding/src/agent-runtime/__contract-tests__/cap-015-edit-recovery.contract.test.ts#L272) |
| T010 | CAP-016: mutation scope reflection contract CAP-MUTATION-REFLECT-003: agent declaration with middleware.mutationScopeReflection: false → no reflection appended even on significant mutation (gate lives at call site / P3 substrate executor) | [cap-016-mutation-reflection.contract.test.ts:120](../../packages/coding/src/agent-runtime/__contract-tests__/cap-016-mutation-reflection.contract.test.ts#L120) |
| T011 | CAP-016: mutation scope reflection contract CAP-MUTATION-REFLECT-004: AMA Generator agent (no mutationScopeReflection middleware) does not append reflection — Evaluator owns mutation feedback (Agent declaration territory, P3) | [cap-016-mutation-reflection.contract.test.ts:121](../../packages/coding/src/agent-runtime/__contract-tests__/cap-016-mutation-reflection.contract.test.ts#L121) |
| T012 | CAP-017: pre-answer judge contract CAP-PRE-ANSWER-JUDGE-002: preAnswerJudgeConsumed latch prevents second invocation in same turn (call-site / P3 substrate) | [cap-017-pre-answer-judge.contract.test.ts:129](../../packages/coding/src/agent-runtime/__contract-tests__/cap-017-pre-answer-judge.contract.test.ts#L129) |
| T013 | CAP-017: pre-answer judge contract CAP-PRE-ANSWER-JUDGE-003: non-auto reasoning mode → judge skipped (call-site / P3 substrate) | [cap-017-pre-answer-judge.contract.test.ts:130](../../packages/coding/src/agent-runtime/__contract-tests__/cap-017-pre-answer-judge.contract.test.ts#L130) |
| T014 | CAP-018: post-tool judge contract CAP-POST-TOOL-JUDGE-003: postToolJudgeConsumed latch prevents second invocation in same turn (call-site / P3 substrate) | [cap-018-post-tool-judge.contract.test.ts:97](../../packages/coding/src/agent-runtime/__contract-tests__/cap-018-post-tool-judge.contract.test.ts#L97) |
| T015 | CAP-018: post-tool judge contract CAP-POST-TOOL-JUDGE-004: generatorAgent has middleware.postToolJudge enabled (Agent declaration territory, P3) | [cap-018-post-tool-judge.contract.test.ts:98](../../packages/coding/src/agent-runtime/__contract-tests__/cap-018-post-tool-judge.contract.test.ts#L98) |
| T016 | CAP-020: createExtensionRuntimeSessionController — controller mutators CAP-EXT-QUEUE-003: session snapshot includes extension state; restore reproduces the same per-extension buckets and pending queue (covered by CAP-050 round-trip via createRuntimeExtensionState/snapshotRuntimeExtensionState) | [cap-020-extension-queue.contract.test.ts:285](../../packages/coding/src/agent-runtime/__contract-tests__/cap-020-extension-queue.contract.test.ts#L285) |
| T017 | CAP-020: createExtensionRuntimeSessionController — controller mutators CAP-EXT-QUEUE-004: settleExtensionTurn runs BEFORE microcompact (CAP-014) — call-site ordering invariant lives in agent.ts P2 / runner-frame in P3 | [cap-020-extension-queue.contract.test.ts:286](../../packages/coding/src/agent-runtime/__contract-tests__/cap-020-extension-queue.contract.test.ts#L286) |
| T018 | CAP-045: session loading + post-load message normalization contract CAP-SESSION-LOAD-001: clean session storage.load() yields expected messages, title, errorMetadata, and extension state — INTEGRATION-LEVEL, deferred until substrate-executor extracts the session-load step. | [cap-045-session-load.contract.test.ts:37](../../packages/coding/src/agent-runtime/__contract-tests__/cap-045-session-load.contract.test.ts#L37) |
| T019 | CAP-047: managed protocol payload merge lifecycle contract CAP-MANAGED-PROTO-002: every terminal return path of runKodaX includes the merged managedProtocolPayload in the result — INTEGRATION-LEVEL, deferred until substrate-executor migration extracts the per-step pipeline so terminals can be exercised in isolation. | [cap-047-managed-proto.contract.test.ts:80](../../packages/coding/src/agent-runtime/__contract-tests__/cap-047-managed-proto.contract.test.ts#L80) |

## Remaining un-attributed observation

The historical 16-second Session read remains un-attributed. A separate isolated
public-SDK probe ran 16 `whoami` tool Runs in full-access temporary Sessions:
all completed in 23,904 ms; 63 sampled Session reads peaked at 1,444 ms (first:
14 ms). This did not reproduce the 16-second observation and is not a passing
result for its exact cause. Issue 371 remains Open for that observation.

Bootstrap `[kodax-startup]` records now contain `time` in UTC, retaining the
existing startupId/PID/phase binding and display-only interpretation. If the
delay returns, retain those records with the affected read's start/end times
and concurrent Run IDs. Do not diagnose it by clearing the registry. Temporary
`DEBUG-371` boundaries were removed. No Sidecar Verifier, memory-finalization,
UI scroll or sandbox policy behavior changes are part of this fix.

## Skip/TODO remediation after a65249d8 (2026-10-31)

The preceding 98/19 inventory is historical evidence, not a current test count.
This follow-up addresses the offline cases listed below and removes misleading retired
contracts. It does not revive V1 Judge/Generator/Evaluator execution, automatic
microcompact, or persisted queued user prompts. A successful read still does
not authorize overwriting a file after an anchor-edit failure.

| Original obligation | Executable evidence / disposition |
| --- | --- |
| CAP-001 full preturn, confidence, best effort (3) | `middleware/repo-intelligence.test.ts`: full bundle, 0.71/0.72 threshold and all-source failure. Existing Agent short-circuit and 2-second hot-path budget tests remain active. |
| CAP-013 crash cleanup/counter (2), CAP-045 load (1) | `tests/bundled-session-crash-recovery.test.mjs`: published `runKodaX` and real `FileSessionStorage`, three independent Node processes, legacy orphan repair, two crashes, subsequent resume, title/history/extension state and records retained, no orphan tool execution. File storage deliberately resets the old error counter when it repairs orphan history; later clean crash snapshots increment normally. Persisted provider errors remain redacted. CAP-082 still pins catch cleanup and metadata. |
| CAP-014 (2) | Multi-result aging under explicit legacy opt-in now runs; the automatic per-turn ordering obligation is retired. Default evidence preservation remains tested. |
| CAP-015 (2) | Existing real-file candidate-anchor test plus CAP-026 edit-success/read-write outcome tests replace duplicate/stale TODOs. Re-read does not clear write protection. |
| CAP-016 (2) | CAP-078 now checks the explicit false reflection gate without consuming the latch; existing tests retain once-only behavior. The Generator/Evaluator-specific obligation is retired. |
| CAP-017/018 (4) | V1 Judge invocation obligations are retired. `coding-preset.test.ts` first failed on active metadata; the minimal production fix marks both compatibility declaration names disabled. Exported predicates and persisted compatibility fields remain. No model request is added. |
| CAP-020 (2) | A real runtime-state snapshot/reconstruction test retains extension state and records but excludes the ephemeral queue. Existing settle -> drain test is the current ordering contract; automatic microcompact ordering is retired. |
| CAP-047 (1) | `agent.managed-protocol-terminals.test.ts`: public `runKodaX`, actual extension tool emissions, completion/error/abort/iteration-limit result matrix, merged payload retained. A limit remains `success:true, limitReached:true`, preserving the existing SDK contract. |

`tests/bundled-oauth-recovery.test.mjs` adds three offline composed fixtures for
OpenAI/ChatGPT, Codex and Copilot. Each uses an actual Windows DPAPI legacy
registration, the real shared auth file, a separate migration process terminated
after the target commit, atomic config account selection, the published Product
Client authorization callback and a separate Host with loopback HTTP. A delayed
refresh from account A is fenced before switching to B; B survives Host restart,
old lease IDs cannot become fresh authority, and revocation survives a third
Host plus an independent Main process. The legacy encrypted bytes and an
unrelated file key remain intact. Neither the file key nor a deliberately set
ambient key can replace the revoked selected account. These fixtures exercise
Main/store/broker/Host recovery; native subscription wire formats remain covered
by the existing OAuth route/Responses tests. They do not certify remote login,
service-side refresh/revocation, or browser consent.

Both new bundled files are mandatory entries in `npm run test:bundle`.

The added Product Client crash/restart fixture also exposed a real title
regression: canonical managed snapshots replaced an existing Session title with
the current prompt. A public snapshot regression first failed with
`Existing user title` becoming `test`; the fix preserves the title from the
already-loaded Host-owned Session, falling back to the prompt only for an empty
title. It adds no storage read or startup work. The Host fixture retains a
completed tool-call/result pair, rejects orphan replay and stale lease reuse,
and requires the Product authorization callback again after Host recreation.

The managed Runner error boundary also failed the new consecutive-crash case
(`1` instead of `3`): it hard-coded the error counter and fired its save without
awaiting it. It now retains metadata from the existing load, increments the
counter, cleans incomplete tool calls, and awaits best-effort error persistence
before exposing the original failure. Missing current recovery carriers use
the latest canonical snapshot, which can contain completed answers or queued
inputs absent from the original resume seed; a failed history load never
authorizes saving an empty replacement. Ordinary load order and read count stay
unchanged. `runner-driven-finalization.test.ts` exercises delayed writes, two
crashes, preserved title/completed tools, and load-failure non-overwrite.
Its replace-only custom storage also checks extension state/records; error
snapshots carry the current runtime state, falling back to the known loaded
extension data when failure precedes runtime-state construction.

The full-file regression caught and rejected an intermediate implementation
that reused the initial history when a queued turn's prompt/delivery save
failed. Both pre-existing queue tests failed again without coverage enabled.
The corrected path retains the existing authoritative-history fallback instead;
two additional snapshot tests require no write when that fallback read fails
(best-effort and required callers). Required callers receive the original read
failure; best-effort error cleanup emits a diagnostic without masking the
original Run failure. A saved empty fragment never replaces unreadable history.

The three Git relationship cases now execute against the current Windows V2
native request file: legitimate linked worktree access plus gitfile deny-write,
oversized metadata refusal without full reads, nested submodule backlink and
forged relationship refusal. Their fixture profile is isolated so an ambient
profile-wide AppData read grant cannot conceal whether a relationship was
authorized. These are policy-construction tests, not an OS enforcement claim.

The ten contradictory Windows V1 tests were removed from the POSIX-only group.
Eight concern the retired staged WFP runner/account path; active V2 setup,
verify-only doctor, cutover/repair and controller tests remain. The other two
assert old encoded-argv/environment plumbing; current exact argv and ambiguous
environment checks run in `windows-sandbox-v2.test.ts`. The 24 POSIX cases in
that group are retained. None of this enables an obsolete backend.

Targeted verification: typecheck and complete build (including native artifacts,
CLI size/input boundary and SDK declarations) passed. Windows sandbox source
files passed 113 tests with 27 platform skips. The six initial published cold
recovery tests passed; 512 mixed historical records were ready in 2,456 ms and
1,521 ms across two generations; the 220-tree/concurrent-history fixture took
2,543 ms to ready and 45 ms for first history reads. Those timings are isolated
fixture observations, not universal startup guarantees. Final full regression
and independent review results are recorded below when complete.

Remaining release evidence is explicit: Linux/macOS/POSIX runs, 25 real Windows
V2 policy cases on an isolated provisioned runner, artifact rendering, gated
experiments, real registered OAuth/cloud accounts, and Space's paired production
installer/SDK upgrade. WSL is unavailable on this machine. Unsupported
old/new concurrent rotating-grant writers and arbitrary downgrade
remain outside this acceptance; a new-only tombstone test does not verify an
old binary's rejection or recovery guidance. A crash before the new auth record
commits may also leave an ownership-unknown legacy lock directory. It must not
be stolen on a time heuristic: preserve the sealed registration and fail closed
until its owner/liveness can be established. This differs from the tested
post-commit interruption, which resumes from the authoritative current record.
If ownership cannot be established, an explicit same-account login can create
a new registration through the normal CLI auth flow; do not replace the chosen
account with a different saved or ambient credential. This is a documented
recovery boundary, not a tested old-binary coexistence guarantee.
The separately un-attributed historical 16-second Session read remains open; this change does
not claim its cause is fixed. Never clear user registry evidence or credential
backups to make these gates pass.

### Supplemental remediation verification

The rebuilt published graph passed all 86 bundled cases with file concurrency
limited to one. The mixed 512-record fixture reached ready in 3,060 ms and
1,991 ms across two generations; 220 historical trees took 3,424 ms, concurrent
history reads 61 ms, and restart 2,378 ms. No registry evidence was removed to
obtain these timings. The strengthened three-service OAuth file was also rerun
in full: an independent Main proves that account A's rotated credential remains
usable after switching to B and revoking B, while the configured selection still
resolves to revoked B and never falls back to A. Three cases passed.

The focused source regression passed 180 cases across seven whole files,
including both existing queued-turn durability regressions. V8 coverage over
the three touched production modules measured 80.38% lines; coverage of added
statement starts was 13/13 and added branch paths 22/27 (81.48%). This is focused
coverage, not a whole-repository coverage claim.

Chrome was available on this Windows machine. Running the three artifact
browser files with an explicit `KODAX_ARTIFACT_TEST_BROWSER` passed all 12
previously skipped cases, without using a user's browser profile. This covers
actual local browser pixels for the existing PDF/DOCX/PPTX/render fixtures; the
LibreOffice conversion fixture still uses its declared conversion stub.
Default-environment full runs retain these 12 skips, so supplementary browser
evidence must be accounted for separately or by whole-file replacement.

One additional stale contract, CAP-094, still asserted that every middleware
declaration was enabled. Its expectation now retains the four declaration names
and pins active routing/reflection to true and retired Judges to false. The
whole seven-case file passed after correction; production bytes did not change.
The final source inventory uses this explicit file-level rerun rather than
describing the earlier failed assertion as a clean first invocation.

## Final remediation acceptance (2026-10-31)

The frozen production implementation completed the full default source run:
1,370 files, 18,800 passed, one failed CAP-094 retired-metadata assertion,
85 skipped and zero TODOs (2,561.98 seconds, two workers, no retries). That
assertion was subsequently corrected and its whole seven-case file passed.
Replacing that file and the three explicitly enabled browser files gives the
final case-level inventory: **18,813 passed, zero failed, 73 skipped, zero
TODOs**, with no failed files. The replacement case sets were checked; only
CAP-094's descriptive title changed under its existing capability ID. This is
an explicit whole-file acceptance composite, not one clean initial invocation.

The 73 remaining default skips comprise 41 POSIX/Linux, 25 provisioned real
Windows V2 and seven manual experiment/capture cases. Six real-provider
integration files are separately excluded by the default tier and are not
included in these counts. Real OAuth/cloud identities, old-binary coexistence,
the ownership-unknown legacy lock boundary, Space's production installer and
the historical unattributed 16-second Session read retain the limitations above.

Source/test typechecks, the full native/bundle/declaration build and the strict
startup input/size guards passed. The isolated CLI is 5,176,750 bytes against
the unchanged 5,177,344-byte budget. The rebuilt SDK passed all 86 bundled
cases; its strengthened OAuth file passed all three independent-Main checks.
An earlier in-progress full run and intentional RED probes remain separate
evidence and are not substituted for this frozen implementation's acceptance.

## Standards

Independent v5 review of the fixed patch found no remaining hard requirement
violations or actionable smells. Drain budgets, fixture failure diagnostics,
owned-process cleanup and exact Host exit verification were corrected. The
two-field private recovery carrier preserves the original load order and adds
no public configuration or dependency between packages. Findings remaining: 0.

## Spec

Independent v5 review found no remaining actionable deviation from the accepted
offline recovery/credential requirements. Canonical queued history, title,
extension state, error counters and read-failure non-overwrite are covered;
retaining account A does not authorize fallback from revoked account B.
Unexecuted platform/service/installer and old-binary boundaries are explicit.
Findings remaining: 0. The acceptance numbers above were finalized after review.

## Main integration verification (2026-10-31)

Root's clean local `KodaX` branch fast-forwarded from `a65249d8` to functional
commit `27bb8536edf8ba149860e6d4c4562ecb0f8526fb`. No merge resolution or source
replacement was needed. The design repository remains clean at
`8574086208d6b5cc6ff6599c825fe88d986c4dd0`; Space remains separate at
`codex/provider-credentials-space`, `7b37e1c8ddf0d72d8674d521f1e8e0298d3341a2`.
No Space product source, remote push or release is part of this fix.

The actual Main checkout passed source/test typechecks and its complete build,
including native artifacts, startup input/size guards and SDK declarations.
Its CLI is also 5,176,750 bytes. Main's whole-file focused source verification
passed 300 cases with 27 POSIX skips; all 86 rebuilt bundle cases passed without
reruns, including the strengthened original-account rotation assertion. Four
historical-owner/real installed-tarball/real alpha.11 Host upgrade cases passed.
The alpha.11 fixture retained busy work and both Sessions during concurrent
startup; rollback/other-profile ownership fences remained effective.

On the actual Main SDK, 512 mixed historical records reached ready in 2,101 ms
and 1,358 ms across two generations. The 220-tree fixture reached ready in
2,275 ms, concurrent history reads took 50 ms, and restart took 1,375 ms.
All tests used their owned fixture homes; this acceptance did not restart a
user's default Host or clear user registry/configuration/credential files.

All 3,272 tracked non-Markdown source files match the independently tested
checkout after line-ending normalization. Twenty-eight initially unnormalized
Rust/TOML/JSONC/fixture text differences were line endings only. The two builds
are not byte-identical (45 of 262 files differ), so Main was validated through
its own generated artifacts rather than assigned the other checkout's binary
acceptance. The functional code stayed frozen during Main validation; the
following integration/handoff update is documentation only.

## 2026-11-02: early resume feedback, with the loading path preserved

The reported 2–3 second post-build pauses were not fully reproduced. Initial
actual-history picker timing was 522 ms, then 495–509 ms; isolated selection
reached startup feedback in 471 ms, then 327–333 ms. Node persistent compile
cache was disabled. These observations do not establish an antivirus/disk
cause or rule out every cold-start regression.

Read-only discovery opened 2,329 files and read 93,096,675 bytes for 96 visible
sessions because a complete project index was absent. Normal storage listing
can repair indexes; strict Host summary/history reads bypass legacy storage
load. Why the user's original manifest disappeared remains undetermined.

The final change only paints `Finding sessions` before importing/scanning and
clears it before the picker or empty-list notice. Existing selection feedback,
module-loading order, cancellation, read-only discovery, index maintenance,
Host startup, credentials and SDK contracts remain unchanged. No additional
file reads, rebuilds, workers, configuration or CI jobs enter the loading path.
The existing unref'ed progress timer is stopped by the bootstrap finally block.

Experiments deliberately NOT retained after the user's performance priority:

- Immediate dynamic import while displaying the picker delayed fast-Enter
  feedback from about 5 ms to 331 ms; it moved work onto the input thread.
- File prefetch did not demonstrate a reliable improvement in total latency.
- Explicit-selection index rebuilding preserved 96 results in an isolated
  2,329-file fixture and reduced later listing from 264 ms to 33 ms, but added
  348 ms to the first selection. This mandatory extra startup work was removed.
- The experimental parallel index writer and its tests were removed with that
  optimization. The original serial publication and locking code is preserved.

This is a feedback fix, not a claim that 2–3 second cold loading is eliminated.
Further index optimization requires measuring the complete first/warm lifecycle
without adding synchronous maintenance to session selection or SDK reads.

Final minimal-candidate local validation (2026-11-02): source/test type checks,
full build and 63 focused checks passed. Real PTY discovery feedback appeared
at 73–84 ms; the actual 96-session list appeared at 525–542 ms (initial baseline
495–522 ms, separate non-controlled samples; no regression rate is inferred).
Search and selection feedback remained 4–7 ms. Isolated selection to startup
feedback was 480 ms first and 353–389 ms subsequently, versus the initial
471 / 327–333 ms observations. No speedup in total loading time is claimed.
The probe asserted selection did not create a missing resume-index manifest;
real-list cancellation exited successfully without starting a user Host.
Only the bootstrap/discovery feedback wiring changes in production (8 lines).
The final packaged suite passed all 102 cases (99 parallel plus 3 serial), with
zero failures or skips. The 220-tree recovery gate reached ready in 2,226 ms,
read concurrent history in 58 ms and restarted in 1,350 ms under unchanged
budgets. Standards and Spec reviews each reported zero remaining findings.
The existing release preparation edits were preserved; this change does not
alter CI, package versions, release tags, or publishing.
