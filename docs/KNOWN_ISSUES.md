# Known Issues

_Last Updated: 2026-08-28_

---

> **Archive Notice**: Historical issue records are maintained in `docs/ISSUES_ARCHIVED.md`.
> This file tracks the active issue backlog plus recently resolved issue records that have not yet been archived.

## v0.7.96-alpha Release Corrections

The v0.7.96-alpha pre-release ships FEATURE_295 and FEATURE_296 and closes
Issues 303-306, 310-320 (the sandbox v2, trusted-text, packaging, and review
fixes recorded below and in [v0.7.96](features/v0.7.96.md)). Trusted text
transactions and platform shell containment are now separate authorities:
controlled text tools commit in the trusted KodaX Runtime and never enter
ASRT/workspace-session state, Windows shell commands run through the native
restricted-token runner (native shell protocol version 7), and Windows
`sandboxRuntime` advances to `6` with a one-time `kodax sandbox setup`
cutover. Local tool-result capacity overflow no longer aborts a Run:
over-budget batches record `capacityDebt` and commit through a bounded
recovery ladder, and local capacity terminals classify as
`failureKind: "context_capacity"` with structured `contextTokens`.
Classified Runtime failures expose one credential-safe `failureDetail` across
failure events, Run result/status, and Session diagnostics. Issues 256, 307,
308, 309, and 321-324 remain Open and are documented below; none block this
pre-release. See
[FEATURE_295_v0.7.96_TEST_GUIDE.md](test-guides/FEATURE_295_v0.7.96_TEST_GUIDE.md)
and
[FEATURE_296_v0.7.96_TEST_GUIDE.md](test-guides/FEATURE_296_v0.7.96_TEST_GUIDE.md).

## v0.7.95 Release Corrections

The v0.7.95 maintenance release closes Issues 301 and 302 and lands the
post-v0.7.94 sandbox recovery and dynamic-worktree corrections. Windows
sandbox cleanup keeps every ACL-mutating helper and command owner in a
recoverable machine-global Job, persists self-healing recovery tickets, and
retries process drain, ACL reset, and filesystem-effect fence release in the
background; Runtime shutdown verifies exact daemon and supervisor process
generations, so PID reuse or an interrupted exit cannot strand a
manual-recovery requirement. Same-boot `unconfirmed-owner` tickets retry
automatically and clear only after an exact sandbox-user SID probe proves the
account idle; probe failure stays fail-closed without blocking non-sandbox
work. Text cleanup recovery records completed phases and retains a consumed
sandbox attestation across retries. KodaX-created linked worktrees join the
exact Session shell/text sandbox policy before their paths are returned,
persist across later Runs, revalidate against the same Git common directory,
and are revoked on removal; unregistered siblings remain fenced. Stale
zero-byte, malformed, and truncated learning locks recover only after an
unchanged bytes/stat comparison, and fullscreen TUI teardown restores the
terminal from a guaranteed unmount boundary (Issue 301). Explicit Skill
execution preserves exact user input in canonical history, rejects multiple
active references, and treats failed or malformed `PreToolUse` hooks as
denial. A failed terminal Run status write produces
`run_settlement_not_persisted` / `unknown`; if the event journal is also
fenced, live observations are invalidated and must resnapshot. The coding
runtime finalizes its authoritative result before emitting the public
completion signal, so A2A cannot publish an empty successful answer
(Issue 302). This release advances to Windows `sandboxRuntime:5` and
`runtimeExitSettlement:2`; `crashOutcomeModel:2` is unchanged and Issue 256
remains Open. See
[ISSUE_301_v0.7.95_REGRESSION_GUIDE.md](test-guides/ISSUE_301_v0.7.95_REGRESSION_GUIDE.md)
and
[ISSUE_302_v0.7.95_REGRESSION_GUIDE.md](test-guides/ISSUE_302_v0.7.95_REGRESSION_GUIDE.md).

## v0.7.94 Release Corrections

The v0.7.94 maintenance release closes Issue 300 and the post-v0.7.93
sandboxed-text concurrency gaps. Windows sandboxed git trusts authorized
repo roots only, never emits `safe.directory=*`, and requires linked-worktree
/ submodule backlinks. Relationship files for those backlinks are read
through strict byte bounds. Runtime text tools may overlap a compatible live
Bash lease through the same ASRT workspace policy; hard-linked targets are
rejected. Sandboxed text-helper stdin failures stay on the operation
Promise. Scheduled daemon shutdown reports failed cleanup. A missing
workspace directory omits the concurrent text sandbox at Run start.
Runtime advertises `conversationHistory:2`. Explicit Skill invocation remains
available for every enabled Skill; `disable-model-invocation` only blocks the
model tool path. Invalid `allowed-tools` and malformed hook JSON are
diagnosed; `PostToolUse` still runs if an embedder result observer throws.
Run finalization, sandbox termination, and managed-child
cleanup rejections are observed so a local failure cannot escape as an
unhandled daemon-process rejection. Total terminal persistence failure
reports `unknown` / `run_settlement_not_persisted` and retains the Session
fence. After reconnect, hosts query and await the admitted `runId` and never
replay `runs.start()`. Capability versions `sandboxRuntime:4` /
`crashOutcomeModel:2` and Issue 256 remain unchanged. See
[ISSUE_300_v0.7.94_REGRESSION_GUIDE.md](test-guides/ISSUE_300_v0.7.94_REGRESSION_GUIDE.md)
and
[ISSUE_RUNTIME_DAEMON_RECOVERY_v0.7.94_REGRESSION_GUIDE.md](test-guides/ISSUE_RUNTIME_DAEMON_RECOVERY_v0.7.94_REGRESSION_GUIDE.md).

A post-release correction closes the uncovered dynamic-worktree case: roots
created by the KodaX worktree tool are persisted in the Session's exact shell
and text sandbox policy, validated against the repository's Git common-dir on
later Runs, and revoked on removal. Unregistered siblings remain fenced. The
durable filesystem-effect record may explain an independently crashed owner,
but users should not delete ProgramData coordination files to work around this
worktree-policy gap. A worktree created before this correction has no durable
registration. An exact successful `worktree_create` result retained by the
same Session is migrated only after full Git revalidation; directory naming is
never enough, and a retained successful remove prevents stale re-adoption. If
the create evidence is unavailable, stop its background process and
remove/recreate it through KodaX once; the cleanup does not require prior
registration.

---

## v0.7.93 Release Corrections

The v0.7.93 maintenance release closes Issues 297, 298, and 299. A durable
Windows `failed` shutdown outcome ends the 170-second orderly wait and enters
exact recovery immediately. After a verified boot change, settlement may
recover previous-boot shared ACL markers under the machine lock and record
that recovery before clearing revalidated markers. Anthropic/OpenAI abort
wrappers are classified by isolated SDK class identity when the request
signal is already aborted, so managed Stop stays interrupted before
credential redaction. Capability versions and Issue 256 remain unchanged.
See
[ISSUE_297_v0.7.93_REGRESSION_GUIDE.md](test-guides/ISSUE_297_v0.7.93_REGRESSION_GUIDE.md),
[ISSUE_298_v0.7.93_REGRESSION_GUIDE.md](test-guides/ISSUE_298_v0.7.93_REGRESSION_GUIDE.md),
and
[ISSUE_299_v0.7.93_REGRESSION_GUIDE.md](test-guides/ISSUE_299_v0.7.93_REGRESSION_GUIDE.md).

---

## v0.7.92 Release Corrections

The v0.7.92 maintenance release closes the live-daemon orphan filesystem-effect
ticket and recorded-release owner path, and it makes managed Session persistence
precede completion so repo/task projections cannot keep a Run in `finalizing`.
Hosts negotiate `sandboxRuntime:4` and `crashOutcomeModel:2`. Issue 256 remains
Open: descendant closure after an intermediate parent exits is still unproven.
See the Issue 256 2026-08-18 slice note and
[ISSUE_256_v0.7.92_REGRESSION_GUIDE.md](test-guides/ISSUE_256_v0.7.92_REGRESSION_GUIDE.md).
Issue 296 also makes resumed terminal history canonical-first: a sparse
`uiHistory` cache can enrich replay but can no longer suppress Session messages.
Presentation-only `agent-completed` / `task-completed` events stay host-owned
when a non-empty CLI `uiHistory` exists.

---

## v0.7.91 Release Corrections

The v0.7.91 maintenance release closes Issue 295 with a durable SDK-owned
Runtime exit settlement transaction. Complete exits persist exact ownership
before stop, resume through a crash-safe ticket, and repair only verified
process/Job/ACL residue. Provider output replacement is also projected by
logical response and physical request identity, while raw journals retain every
attempt. Ambiguous ownership and same-boot POSIX recovery remain fail-closed.

The same release bounds AskUser, permission, and MCP elicitation lifecycles.
Owner AbortSignals close host UI on timeout/cancellation, valid defaults are
selected only after Runtime validation, and stale prepared Session tails fall
back to an authoritative delta after `data_changed`. These paths are covered
by the v0.7.91 focused interaction and prepared-session tests; no new
fail-closed shell or sandbox exception is introduced.

---

## v0.7.90 Release Corrections

The v0.7.90 patch closes follow-up correctness gaps without weakening the
fail-closed contracts: timed-out workspace sessions use orderly retirement and
retain actionable daemon Error diagnostics; chained compaction retains direct
clone predecessors and topology-correct archive markers; and run-scoped tool
schemas are normalized before provider dispatch. These corrections are covered
by the focused sandbox, lineage, REPL, and coding-runtime tests.

---

## Issue Index
<!-- Quick reference table for all issues -->

| ID | Priority | Status | Title | Introduced | Fixed | Created | Resolved |
|----|----------|--------|-------|------------|-------|---------|----------|
| 324 | Medium | Open | Repeated same-file edits with identical line stats still collapse, dropping every diff but the last | FEATURE_067 tool summary collapse | - | 2026-08-28 | - |
| 323 | Medium | Open | Quota-worded non-429 provider errors retry as rate limits but report as upstream errors | v0.7.96 status-bucketed runtime failure taxonomy | - | 2026-08-28 | - |
| 322 | Medium | Open | Irreducible-input compaction resets the summarizer circuit-breaker counter to zero, disarming protection for later ordinary turns | FEATURE_296 breaker-bounded hard-pressure compaction | - | 2026-08-28 | - |
| 321 | Medium | Open | Every runtime cancellation terminal attributes the stop to the user, including runtime shutdown and internal aborts | v0.7.96 runtime failure-detail cancellation receipt | - | 2026-08-28 | - |
| 320 | High | Resolved | Unix trusted text commit reads the target before locking and can misclassify a concurrent replace as a hard link | FEATURE_295 Unix trusted text transaction | v0.7.96-alpha | 2026-08-28 | 2026-08-28 |
| 319 | High | Resolved | Electron ASAR virtual stats fail native artifact identity verification despite physical unpacked bytes | FEATURE_295 packaged Electron native verification | v0.7.96-alpha | 2026-08-28 | 2026-08-28 |
| 318 | High | Resolved | Native shell admission writes traversal ACEs to every allow-root ancestor and can hang while Windows propagates a profile DACL | FEATURE_295 first native capability plan | v0.7.96-alpha | 2026-08-27 | 2026-08-27 |
| 317 | High | Resolved | A hash-correct package hardlink is rejected before ASRT runner import and silently sends Windows Bash to normal permissions | FEATURE_295 protected ASRT artifact import | v0.7.96-alpha | 2026-08-27 | 2026-08-27 |
| 316 | High | Resolved | A concurrent Windows reader can win the final replace race and make trusted Write return Win32 error 5 | FEATURE_295 Windows atomic text replace | v0.7.96-alpha | 2026-08-27 | 2026-08-27 |
| 315 | Medium | Resolved | Native artifact staging exceeds legacy Windows path limits although the final cache path is valid | FEATURE_295 PowerShell 5.1 artifact staging | v0.7.96-alpha | 2026-08-27 | 2026-08-27 |
| 314 | High | Resolved | Per-command propagation of fixed sensitive-root denies serializes independent Windows shells | FEATURE_295 first native-shell draft | v0.7.96-alpha | 2026-08-27 | 2026-08-27 |
| 313 | High | Resolved | Stale inherited shared-account ACEs make every fresh Windows shell fail admission after reboot or setup | pre-FEATURE_295 shared-account ACL grants | v0.7.96-alpha | 2026-08-27 | 2026-08-27 |
| 312 | High | Resolved | A dead Windows shell request makes native control-state repair permanently reject the non-empty directory | FEATURE_295 protected native shell control state | v0.7.96-alpha | 2026-08-27 | 2026-08-27 |
| 311 | High | Resolved | Windows Session event cursor replacement fails under a non-delete-sharing handle and workspace shell authority includes Runtime state | Runtime per-Session sequence cursor / workspace shell root grant | v0.7.96-alpha | 2026-08-27 | 2026-08-27 |
| 310 | High | Resolved | Trusted Write cannot replace a Windows file owned by an old or current sandbox identity | FEATURE_295 Windows metadata preservation | v0.7.96-alpha | 2026-08-27 | 2026-08-27 |
| 309 | Medium | Open | An explicit ambient compatibility ACE can bypass a later Windows root capability | Windows v2 Codex-compatible restricted token | - | 2026-08-27 | - |
| 308 | Medium | Open | ASRT's fixed Windows proxy range caps simultaneous distinct network-policy brokers | ASRT 0.0.65 Windows network proxy | - | 2026-08-27 | - |
| 307 | High | Open | ASRT launches the shared-account Windows shell runner before KodaX can attach a creation-time process DACL or Job | Windows v2 ASRT runner bootstrap | - | 2026-08-26 | - |
| 306 | High | Resolved | ASRT Windows consumes runner stdin as control data, so sandboxed text helpers inherit EOF and every real write fails | Windows ASRT process backend through 0.0.73 | v0.7.96-alpha | 2026-08-25 | 2026-08-26 |
| 305 | Medium | Resolved | A cross-Runtime idle close queues an account-wide cleanup transition that blocks same-policy writes in the queueing Runtime until the other Runtime's command completes | v0.7.9x durable cleanup-transition serialization (pre-existing; surfaced by the Issue-304 cross-review) | v0.7.96-alpha | 2026-08-25 | 2026-08-26 |
| 304 | High | Resolved | A long-lived background sandbox command parks a workspace session reset and every later text mutation fails closed as unavailable | v0.7.9x Windows pending-reset fail-closed (sandboxRuntime:5) | v0.7.96-alpha | 2026-08-24 | 2026-08-25 |
| 303 | High | Resolved | Bundled Windows binary resolved srt-win.exe onto Bun's virtual `B:\` drive, so the sandbox backend was permanently unavailable | bundled (Bun `--compile`) Windows builds | v0.7.96-alpha | 2026-08-24 | 2026-08-24 |
| 302 | High | Resolved | Runtime completion fallback could publish an empty A2A answer before the coding result settled | v0.7.79 Runtime completion fallback | v0.7.95 release | 2026-08-23 | 2026-08-23 |
| 301 | High | Resolved | Stale invalid learning lock could stall interactive work and TUI teardown lacked a direct terminal restore fallback | shared learning lock / fullscreen TUI | v0.7.95 release | 2026-08-23 | 2026-08-23 |
| 300 | Medium | Resolved | Sandboxed git `safe.directory` trust set misaligned with authorized roots | v0.7.93 ASRT 0.0.65 git trust | v0.7.94 | 2026-08-20 | 2026-08-21 |
| 299 | High | Resolved | Previous-boot foreign Windows ACL markers blocked SDK-owned Runtime exit settlement | v0.7.91 Runtime exit settlement | v0.7.93 | 2026-08-19 | 2026-08-19 |
| 298 | High | Resolved | Provider SDK abort wrapper bypasses managed Stop classification and becomes a credential failure | v0.7.69 managed run-scoped credentials | v0.7.93 | 2026-08-19 | 2026-08-19 |
| 297 | Medium | Resolved | Durable Windows cleanup failure still consumed the full orderly daemon-exit window before exact recovery | v0.7.91 Runtime exit settlement | v0.7.93 | 2026-08-19 | 2026-08-19 |
| 296 | High | Resolved | Sparse `uiHistory` projection suppresses canonical conversation after `-r` resume | v0.7.51 UI history replay | v0.7.92 development | 2026-08-18 | 2026-08-18 |
| 295 | High | Resolved | Complete Runtime exit could strand a same-boot Windows ACL owner and could not resume safely after host relaunch | v0.7.79 managed Runtime shutdown | v0.7.91 release | 2026-08-17 | 2026-08-17 |
| 293 | High | Resolved | Managed compaction context replacement makes ordinary history ambiguous and duplicates paged conversations | v0.7.80 managed-run-context stripping | v0.7.89 release | 2026-08-16 | 2026-08-16 |
| 292 | High | Resolved | Actor settlement deadline conflates storage eligibility, canonical commit, and post-commit maintenance | v0.7.85 Actor settlement convergence | v0.7.88 release | 2026-08-15 | 2026-08-15 |
| 291 | High | Resolved | Crashed inline Runtime owner leaves daemon startup permanently fenced | v0.7.69 owner-policy fencing | v0.7.86 release | 2026-08-11 | 2026-08-11 |
| 290 | Medium | Resolved | Mixed-case custom provider aliases lose model autocomplete | custom provider model completion | v0.7.85 release | 2026-08-10 | 2026-08-10 |
| 289 | High | Resolved | Windows workspace sandbox recursively stamped broad home and temp ACLs in the shell timeout | v0.7.85 Agent Home shell hardening | v0.7.85 release | 2026-08-10 | 2026-08-10 |
| 288 | Medium | Resolved | Repo-intelligence warm Worker retained its peak memory after cache construction | v0.7.41 startup prewarm | v0.7.85 release | 2026-08-10 | 2026-08-10 |
| 287 | High | Resolved | Terminal Run recovery replayed complete event histories and blocked CLI startup | v0.7.79 Runtime lifecycle recovery | v0.7.85 release | 2026-08-10 | 2026-08-10 |
| 286 | High | Resolved | Learned Skill fallback scope was searched in the wrong physical project root | v0.7.85 development multi-scope repair | v0.7.85 release | 2026-08-09 | 2026-08-09 |
| 285 | High | Resolved | Auto mode left agent-home roots and Runtime control paths mutable | v0.7.74 deterministic read fast paths | v0.7.85 release | 2026-08-09 | 2026-08-09 |
| 284 | High | Resolved | Managed-task compaction no-ops can permanently trip the summary circuit breaker | v0.7.80 managed-run-context stripping | v0.7.85 release | 2026-08-07 | 2026-08-08 |
| 283 | Medium | Resolved | REPL hides the canonical sidecar item and appends duplicated verifier evidence after Worker retry | v0.7.43 first-class sidecar messages | v0.7.84 development | 2026-08-07 | 2026-08-07 |
| 282 | High | Resolved | Agent progress persistence backlog can self-fence its live owner and make an unknown Run reject Stop | v0.7.79 bounded Actor settlement | v0.7.85 release | 2026-08-06 | 2026-08-11 |
| 281 | High | Resolved | Runtime input submission reads mutable canonical Session before resolving its authoritative Run target | v0.7.69 Runtime input submission | v0.7.82 release | 2026-08-05 | 2026-08-05 |
| 280 | High | Resolved | Daemon managed Run Stop does not fence cooperative work or preserve Abort causality through credential redaction | v0.7.69 daemon managed Runs | v0.7.82 release | 2026-08-05 | 2026-08-05 |
| 279 | Medium | Resolved | Daemon Host Tool merge drops MCP capability snapshots and leaks host tools into server-filtered search | v0.7.70 progressive MCP discovery | v0.7.82 release | 2026-08-05 | 2026-08-05 |
| 278 | High | Resolved | Managed Runtime publishes completed turns without a durable canonical Session boundary | v0.7.79 Runtime Session persistence | v0.7.80 release | 2026-08-04 | 2026-08-04 |
| 277 | High | Resolved | Synchronous tokenization precedes tool-output byte/line spill | v0.7.74 tool attention admission | v0.7.80 release | 2026-08-04 | 2026-08-04 |
| 276 | High | Resolved | Release preparation reused a stale F274 experiment, narrowed sibling provenance to control scope, and silently dropped a daemon host binding | v0.7.80 release preparation | v0.7.80 release | 2026-08-04 | 2026-08-04 |
| 275 | High | Resolved | Auto permission analysis treated ordinary search scopes and tool metadata as unresolved and retried truncated classifiers unchanged | v0.7.79 development | v0.7.80 release | 2026-08-04 | 2026-08-04 |
| 274 | Medium | Resolved | Unchanged A2A revisions emit false hot-reload notices and trigger unnecessary TUI redraws | v0.7.69 integration hot reload | v0.7.79 development | 2026-08-03 | 2026-08-03 |
| 273 | Medium | Resolved | Runtime actor subprocess test inherited Node environment-proxy warnings | v0.7.79 Runtime actor owner liveness test | v0.7.79 development | 2026-08-03 | 2026-08-03 |
| 272 | Medium | Resolved | Qwen review found false-success MCP close, private package imports, and daemon outcome accumulation | v0.7.79 development | v0.7.79 development | 2026-08-03 | 2026-08-03 |
| 271 | Medium | Resolved | GLM review found an unbounded boundary projection and small lifecycle/parser hardening gaps | v0.7.79 development | v0.7.79 development | 2026-08-03 | 2026-08-03 |
| 270 | High | Resolved | Always-on classifier low effort could produce an impossible output/thinking budget | v0.7.73 side-query effort fallback; exposed by v0.7.79 Qwen 3.8 default | v0.7.79 development | 2026-08-03 | 2026-08-03 |
| 269 | High | Open | POSIX daemon hard-stop lacks a retained kernel process handle | v0.7.79 daemon stop watchdog | - | 2026-08-03 | - |
| 268 | High | Resolved | Auto[LLM] retained category-based approvals and a pre-classifier Tier 0 gate | v0.7.33; retained through v0.7.79 development | v0.7.79 development | 2026-08-03 | 2026-08-03 |
| 267 | High | Resolved | Daemon serve host could outlive a successful Runtime stop | v0.7.66 process-hosted daemon | v0.7.79 development | 2026-08-03 | 2026-08-03 |
| 266 | High | Resolved | Auto-mode fault logs exposed exception secrets and allow hazard typing widened | v0.7.79 classifier decision fix | v0.7.79 development | 2026-08-03 | 2026-08-03 |
| 265 | High | Resolved | Classifier auxiliary fields could override a valid Auto[LLM] decision | v0.7.79 classifier output hardening | v0.7.79 development | 2026-08-03 | 2026-08-03 |
| 264 | Medium | Resolved | Empty persisted conversations were reported as missing lineage | v0.7.79 conversation projection | v0.7.79 development | 2026-08-03 | 2026-08-03 |
| 263 | High | Resolved | Auto permission fast paths and Coding intent propagation could bypass complete review | v0.7.79 development | v0.7.79 development | 2026-08-02 | 2026-08-02 |
| 262 | High | Resolved | Session lifecycle operations can orphan recoverable conversation cache content | v0.7.79 development | v0.7.79 development | 2026-08-02 | 2026-08-02 |
| 261 | Medium | Resolved | Prepared Session append rereads the complete conversation bundle | v0.7.79 development | v0.7.79 development | 2026-08-02 | 2026-08-02 |
| 260 | High | Resolved | Shell read-only inspection, intent binding, and classifier protocol drift caused spurious Auto approvals | v0.7.33; amplified by v0.7.79 development | v0.7.79 development | 2026-08-02 | 2026-08-02 |
| 259 | Medium | Resolved | REPL startup persists zero-message sessions before the first prompt | v0.7.72 Runtime REPL bridge | v0.7.79 development | 2026-08-02 | 2026-08-02 |
| 258 | Medium | Resolved | TodoList content and labels can ignore the query and UI locale | v0.7.79 development | v0.7.79 development | 2026-08-01 | 2026-08-01 |
| 257 | High | Resolved | Legacy compaction copies cannot be safely folded by hosts | legacy compaction/resume persistence | v0.7.79 development | 2026-08-01 | 2026-08-01 |
| 256 | High | Open | Windows child containment cannot prove descendant closure after an intermediate parent exits | Windows LLM, MCP, daemon-startup, and Worker-owned child processes | v0.7.92 stale coordinator-ticket/recorded-release slice; descendant closure follow-up unassigned | 2026-08-01 | - |
| 255 | High | Resolved | Runtime teardown and cancellation could report completion across indeterminate lifecycle boundaries | Runtime SDK lifecycle and daemon protocol | v0.7.79 development | 2026-08-01 | 2026-08-01 |
| 254 | High | Resolved | First v0.7.78 Session reconciliation replays historical messages as new lineage entries | v0.7.78 lineage reconciliation | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 253 | Medium | Resolved | Parallel quality-strategy admissions conflict on unrelated Actor progress | v0.7.77 quality-strategy admission | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 252 | High | Resolved | Cancelled shell environment probes can return before descendants terminate | configured-shell environment probing | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 251 | High | Resolved | Published Runtime Worker resolves a handler sidecar that is not shipped | v0.7.66 Worker-hosted Runtime | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 250 | Medium | Resolved | Windows programmable commands use non-portable module paths and hide load failures | programmable command support | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 249 | High | Resolved | Standalone executable re-enters KodaX when launching JavaScript children | Bun standalone child integrations | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 248 | High | Resolved | REPL Session IDs collide for contexts created in the same second | legacy REPL Session ID generator | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 247 | High | Resolved | Runtime cold Session snapshots repeat storage reads, locator scans, and materialization | v0.7.79 development | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 246 | High | Resolved | Runtime coalescing release closure could reuse legacy daemons, exceed 8KiB, and mis-test cancellation | v0.7.79 development | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 245 | High | Resolved | Windows sandbox runner cannot launch from a user-level global npm install | v0.7.78 Windows ASRT integration | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 244 | High | Resolved | Runtime streaming deltas create an event, sequence-allocation, and persistence storm | v0.7.64 Runtime event contract | v0.7.79 development | 2026-07-31 | 2026-07-31 |
| 243 | High | Resolved | Runtime Worker omits configured A2A Agents from dispatchable catalog and execution | v0.7.66 Worker-hosted Runtime | v0.7.79 development | 2026-07-30 | 2026-07-30 |
| 242 | Medium | Resolved | First launch opens metadata setup when no provider credential exists | v0.7.73 first-run provider setup | v0.7.79 development | 2026-07-30 | 2026-07-30 |
| 241 | High | Resolved | Standalone Bun binary executes every CLI command twice | v0.7.72 lightweight resume bootstrap | v0.7.79 development | 2026-07-30 | 2026-07-31 |
| 240 | High | Resolved | Runtime lifecycle can remain active after executor settlement and history reads can hang or mutate legacy Sessions | Runtime SDK lifecycle and transcript observation | v0.7.79 development | 2026-07-30 | 2026-07-30 |
| 239 | High | Resolved | Session archive can pair a moved main file with an orphan destination sidecar | sidecar-aware Session archive/unarchive | v0.7.79 development | 2026-07-30 | 2026-07-30 |
| 238 | High | Resolved | Durable island recovery can violate transcript append order and compaction clone provenance | v0.7.74 durable compacted-history recovery | v0.7.79 development | 2026-07-30 | 2026-07-30 |
| 237 | High | Resolved | Production learning reviewer omitted the learned Skill slug constraint | v0.7.78 development | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 236 | High | Resolved | Production learning reviewer under-specified its unified output shape | v0.7.78 development | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 235 | High | Resolved | v0.7.78 semantic release gates had no frozen current-policy runners | v0.7.78 release candidate | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 234 | Medium | Resolved | Standalone sandbox environment gate assumed Windows argv transport on POSIX | v0.7.78 standalone sandbox broker tests | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 233 | High | Resolved | Learned Skill canary could trust before all outcomes settled and record a stale artifact identity | v0.7.78 development | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 232 | Medium | Resolved | Workspace shell sandbox did not deny reads from sensitive home credential paths | v0.7.78 ASRT workspace shell sandbox | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 231 | Medium | Resolved | Explicit memory intent was discarded when the root episode was cancelled | v0.7.78 governed memory intent lifecycle | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 230 | Medium | Resolved | PID-only Actor owner liveness could pin crashed Runtime ownership after PID reuse | v0.7.78 development | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 229 | Medium | Resolved | A2A ephemeral listener could publish a Fetch-blocked loopback endpoint | v0.7.69 built-in A2A listener | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 228 | High | Resolved | Runtime Auto v4 capability still accepted and advertised v3 persistent-fallback semantics | v0.7.78 development | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 227 | High | Resolved | Root memory loop did not reliably capture explicit user remember intent in AMA and queued turns | v0.7.68 MemorySession; AMA lifecycle gap | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 226 | Medium | Resolved | Runtime client broker prompted for already-allowed Edit calls and Plan blocked Skill loading | v0.7.66 Runtime broker / Skill tool metadata | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 225 | Medium | Resolved | Release gates encoded stale semantics or ignored background lifecycle | legacy regression assertions and cleanup | v0.7.78 development | 2026-07-29 | 2026-07-29 |
| 224 | High | Resolved | Concurrent Runtime owners could recover live Actor turns and make interrupt, list, and wait diverge | v0.7.72 Runtime Actor persistence | v0.7.78 development | 2026-07-28 | 2026-07-28 |
| 223 | High | Resolved | Auto[LLM] timeouts and exact workspace mutations caused spurious or hard permission stops | v0.7.33 | v0.7.78 development | 2026-07-28 | 2026-07-28 |
| 222 | High | Resolved | Invalid optional integration config aborts daemon cold start and discards child diagnostics | v0.7.69 integration hot reload | v0.7.77 development | 2026-07-28 | 2026-07-28 |
| 221 | High | Resolved | FEATURE_276 review found initialization bypass, help side effects, invalid-config, and concurrent overwrite gaps | v0.7.78 development | v0.7.78 development | 2026-07-28 | 2026-07-28 |
| 220 | Low | Resolved | Integration hot-reload output overwrites the Ink status bar | v0.7.69 integration hot reload | v0.7.77 development | 2026-07-28 | 2026-07-28 |
| 219 | Medium | Resolved | Daemon start can report healthy while its returned state is still starting | runtime daemon child startup | v0.7.77 development | 2026-07-27 | 2026-07-27 |
| 218 | High | Resolved | Missing historical image files make every later Provider run fail | image-path history introduction | v0.7.77 development | 2026-07-27 | 2026-07-27 |
| 217 | High | Resolved | CLI bridge confuses ACP IDs with native CLI resume IDs and shares a default session | CLI bridge introduction | v0.7.77 development | 2026-07-27 | 2026-07-27 |
| 216 | High | Resolved | Codex CLI and Gemini CLI cache usage is dropped by the CLI event bridge | CLI bridge introduction | v0.7.77 development | 2026-07-27 | 2026-07-27 |
| 215 | High | Resolved | Managed Provider requests omit stable prompt-cache session affinity | v0.7.77 development and earlier | v0.7.77 development | 2026-07-27 | 2026-07-27 |
| 214 | High | Resolved | Daemon shell tools freeze startup PATH and expose inherited credentials | v0.7.77 and earlier | v0.7.77 development | 2026-07-26 | 2026-07-27 |
| 213 | High | Resolved | Published v0.7.77 archive predates AMA request-only managed-context reinjection | v0.7.77 package | v0.7.77 repack | 2026-07-26 | 2026-07-26 |
| 212 | High | Resolved | v0.7.77 review found child-briefing corruption, lossy interrupt validation, and terminal/schema contract drift | v0.7.77 development | v0.7.77 development | 2026-07-26 | 2026-07-26 |
| 211 | High | Resolved | AMA stable System prompt still embeds the Session scratch path across new Sessions | v0.7.77 development | v0.7.77 development | 2026-07-26 | 2026-07-26 |
| 210 | High | Resolved | Runtime diagnostic identity and latest cache query contracts are incomplete | v0.7.77 development | v0.7.77 development | 2026-07-26 | 2026-07-26 |
| 209 | High | Resolved | Child cache/context review found diagnostic identity, wire hashing, Workflow leaf, and specialist compatibility gaps | v0.7.77 development | v0.7.77 development | 2026-07-26 | 2026-07-26 |
| 208 | Medium | Resolved | v0.7.77 review found unbounded active-Run continuation and narrow memory prompt-safety matching | v0.7.77 release candidate | v0.7.77 release candidate | 2026-07-26 | 2026-07-26 |
| 207 | Medium | Resolved | Provider-only model selection leaves Runtime Auto LLM without the provider default model | v0.7.73 Runtime Auto preflight | v0.7.77 release candidate | 2026-07-25 | 2026-07-25 |
| 206 | Medium | Resolved | Static provider model catalogs duplicated default models in REPL completion and SDK listings | v0.7.43 static model catalog; expanded v0.7.76 | v0.7.77 release candidate | 2026-07-25 | 2026-07-25 |
| 204 | Medium | Resolved | Auto mode could render without an engine and rapid permission-mode writes could settle out of order | v0.7.72 Runtime REPL bridge | v0.7.74 | 2026-07-23 | 2026-07-23 |
| 203 | High | Resolved | Compaction recovery guidance detached the compaction entry from the active lineage | v0.7.74 development | v0.7.74 | 2026-07-23 | 2026-07-23 |
| 202 | High | Resolved | PowerShell bracket wildcards could bypass protected-path auto-mode review | v0.7.74 development | v0.7.74 | 2026-07-23 | 2026-07-23 |
| 201 | Medium | Resolved | Model wait treated Runtime system reminders as mailbox activity and Workflow guidance still implied progress waiting | v0.7.74 development | v0.7.74 | 2026-07-23 | 2026-07-23 |
| 200 | High | Resolved | Restored unacknowledged Agent completions did not repopulate the model mailbox | v0.7.74 development | v0.7.74 | 2026-07-23 | 2026-07-23 |
| 199 | High | Resolved | Runtime accepts interrupt input after the final safe boundary and terminalizes it without delivery | v0.7.74 development | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 198 | High | Resolved | Compaction could evict exact history before durable persistence and offered no model-facing recovery | v0.7.46; exposed by v0.7.74 review | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 197 | Medium | Resolved | User-shaped compaction checkpoints caused round-exit query and final duplication | v0.7.74 development | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 196 | High | Resolved | Physical-only tool-result admission let pathological grep output dominate large contexts | v0.7.69 | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 195 | High | Resolved | Auto-mode sent safe static reads to the LLM while sensitive reads bypassed deterministic review | v0.7.33; exposed by v0.7.74 review | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 194 | High | Resolved | Agent coordination could reject local specialists, amplify progress polling, duplicate terminal output, and corrupt resumed tool history | v0.7.72-v0.7.74 | v0.7.74 | 2026-07-22 | 2026-07-22 |
| 193 | Medium | Resolved | Runtime daemon rejects interrupt input instead of injecting it into the active Run | v0.7.69 | v0.7.73 development | 2026-07-21 | 2026-07-21 |
| 192 | High | Resolved | Large compaction used the model window for protection, covered only one rolling chunk, and exposed ambiguous/unbounded SDK state | v0.7.73 and earlier | v0.7.74 | 2026-07-21 | 2026-07-21 |
| 191 | High | Resolved | Auto permission review lacked a complete, compact mutation model | v0.7.33 | v0.7.73 | 2026-07-21 | 2026-07-21 |
| 190 | High | Resolved | Legacy matcherless grants and escaped JSON credentials bypassed new safety boundaries | v0.7.72 and earlier; expanded v0.7.73 RC | v0.7.73 | 2026-07-20 | 2026-07-20 |
| 189 | High | Resolved | Auto sidecar effort, Runtime session settings, and reasoning command state could diverge | v0.7.33; expanded v0.7.73 | v0.7.73 | 2026-07-20 | 2026-07-20 |
| 188 | High | Resolved | Auto classifier projection, transcript boundaries, and first-run environment ordering were incomplete | v0.7.33; expanded v0.7.72 RC | v0.7.73 | 2026-07-20 | 2026-07-20 |
| 187 | High | Resolved | Shared-daemon Auto permission ownership, upgrade fencing, preview bounds, and SDK compatibility were incomplete | v0.7.72 RC | v0.7.72 | 2026-07-19 | 2026-07-19 |
| 186 | High | Resolved | Daemon event subscriptions had no readiness boundary and could miss the first cross-client event | v0.7.66 | v0.7.72 | 2026-07-19 | 2026-07-19 |
| 185 | Medium | Open | Learning lock crash recovery can time out before stale ownership is reclaimable | v0.7.68; expanded v0.7.72 RC | - | 2026-07-19 | - |
| 184 | High | Open | `sed` side effects can bypass plan-mode write classification | v0.5.36 | - | 2026-07-19 | - |
| 183 | High | Resolved | CLI daemon startup failures and forced test exits could leave detached Node processes | v0.7.66-v0.7.72-hotfix.0 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 182 | Medium | Resolved | Windows lifecycle lock contention surfaced as fatal `EPERM` during concurrent memory forgets | v0.7.68 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 181 | Medium | Resolved | MiniMax M3 default upgrade left the media capability regression stale | v0.7.72-dev | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 180 | High | Resolved | Queued user input used a different root scope and could not wake `wait_agent` | v0.7.72-dev | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 179 | High | Resolved | Auto[LLM] eight-second timeout and readonly projections caused spurious approvals | v0.7.33 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 178 | Medium | Resolved | Bare `-r` cancellation retained terminal input until another keypress | v0.7.72-hotfix.0 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 177 | Medium | Resolved | Worker announced and attempted an oversized fresh spawn wave before Actor capacity rejection | v0.7.72-dev | v0.7.72 | 2026-07-18 | 2026-07-18 |
| 176 | High | Resolved | Learning subscription could lose a wake, retain a waiter after disconnect, and cache transient principals without bound | v0.7.72-dev | v0.7.72 | 2026-07-18 | 2026-07-18 |
| 175 | High | Resolved | Actor start/interrupt race could launch with a fresh cancellation handle; closed Actors still accepted mailbox traffic | v0.7.72-dev | v0.7.72 | 2026-07-18 | 2026-07-18 |
| 174 | Medium | Resolved | Bare `-r` session picker exited as cancelled before accepting input | v0.7.69 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 173 | Medium | Resolved | REPL batch history commit collapsed distinct reply times into one timestamp | v0.7.45 | v0.7.72-hotfix.0 | 2026-07-18 | 2026-07-18 |
| 172 | High | Resolved | Daemon Runtime bypassed auto-mode guardrails and treated quoted source text as protected paths | v0.7.64-v0.7.72-hotfix.0 | v0.7.72-hotfix.0 | 2026-07-17 | 2026-07-18 |
| 171 | High | Resolved | Verified Ark Coding image inputs were rejected before provider dispatch | v0.7.57 | v0.7.72-hotfix.0 | 2026-07-17 | 2026-07-17 |
| 170 | High | Resolved | A2A realm-key upgrade hid durable tasks and global admission serialized slow preparation | v0.7.71 | v0.7.71 | 2026-07-17 | 2026-07-17 |
| 169 | High | Resolved | Executor shutdown and daemon auto-start could wait indefinitely or leak startup children | v0.7.67-v0.7.71 | v0.7.71 | 2026-07-17 | 2026-07-17 |
| 168 | High | Resolved | A2A post-closure review found executor shutdown, daemon ownership, and server admission gaps | v0.7.69 | v0.7.71 | 2026-07-16 | 2026-07-16 |
| 167 | High | Resolved | A2A OAuth and hot-activation closure could leak credentials or mutate stale registrations | v0.7.69 | v0.7.71 | 2026-07-16 | 2026-07-16 |
| 166 | High | Resolved | Electron daemon bootstrap mode leaks into user child processes | v0.7.71 RC | v0.7.71 | 2026-07-16 | 2026-07-16 |
| 165 | High | Resolved | Packaged Electron auto-start relaunches the app instead of executing the daemon CLI | v0.7.70 | v0.7.71 | 2026-07-16 | 2026-07-16 |
| 164 | High | Resolved | MCP cross-language zero matches can force an avoidable second model/tool round | v0.7.70 RC | v0.7.70 | 2026-07-15 | 2026-07-15 |
| 163 | High | Resolved | A2A review found endpoint trust, task lifecycle, artifact, and protocol gaps | v0.7.69 | v0.7.70 | 2026-07-15 | 2026-07-15 |
| 162 | High | Resolved | A2A serve drops Runtime defaults and Markdown Agent provider | v0.7.69 | v0.7.70 | 2026-07-15 | 2026-07-15 |
| 161 | High | Resolved | MCP complete discovery can exceed result capacity or trust malformed pagination/cache state | v0.7.70 RC | v0.7.70 | 2026-07-15 | 2026-07-15 |
| 160 | High | Resolved | Shared-daemon rollback omits reverse-bridge mutations and daemon-owned background work | v0.7.70 RC | v0.7.70 | 2026-07-15 | 2026-07-15 |
| 159 | High | Resolved | Windows process cleanup can lose descendants when `taskkill /t` fails under load | v0.7.67 | v0.7.69 | 2026-07-15 | 2026-07-15 |
| 158 | High | Resolved | Post-hoc output/history loss hides evidence and can increase end-to-end token use | v0.7.61 | v0.7.69 | 2026-07-14 | 2026-07-15 |
| 157 | High | Resolved | F267/F269 review found durability, network, concurrency, and diagnostic gaps | v0.7.69 RC | v0.7.69 | 2026-07-14 | 2026-07-14 |
| 156 | Medium | Resolved | Bare `kodax -r` repeatedly full-reads large session sets before opening the picker | v0.7.68 | v0.7.69 | 2026-07-14 | 2026-07-14 |
| 155 | High | Resolved | Bare `kodax -r` exits after selection during the picker-to-TUI handoff | v0.7.68 | v0.7.69 | 2026-07-14 | 2026-07-14 |
| 154 | High | Resolved | FEATURE_267/268 review found remote execution and hot-reload reliability gaps | v0.7.69 RC | v0.7.69 | 2026-07-13 | 2026-07-13 |
| 153 | High | Resolved | FEATURE_260 post-release review found memory guard bypass and persistence isolation gaps | v0.7.68 | v0.7.69 | 2026-07-12 | 2026-07-12 |
| 152 | High | Resolved | FEATURE_260 review found credential, mutation-guard, concurrent persistence, and eval-integrity gaps | v0.7.68 RC | v0.7.68 | 2026-07-12 | 2026-07-12 |
| 151 | High | Resolved | Runtime config tests leak detached daemon processes and interrupted background fixtures can survive | v0.7.67 RC | v0.7.67 | 2026-07-11 | 2026-07-11 |
| 150 | High | Resolved | v0.7.67 外部 Agent 脚本路由与执行平面关闭契约存在发布阻断缺口 | v0.7.67 RC | v0.7.67 | 2026-07-11 | 2026-07-11 |
| 149 | High | Resolved | ACP tests persist empty sessions into the real user store | v0.7.66 | v0.7.67 | 2026-07-11 | 2026-07-11 |
| 148 | High | Resolved | FEATURE_258 外部任务在持久化失败、配置热更新和并发回调下可能失联或状态回退 | v0.7.67 RC | v0.7.67 | 2026-07-10 | 2026-07-10 |
| 082 | Low | Open | packages/llm 缺少单元测试 | v0.5.21 | - | 2026-03-08 | - |

| 091 | High | Open | 缺少一等公民 MCP / Web Search / Code Search 工具体系 | v0.6.10 | - | 2026-03-18 | - |
| 092 | High | Open | Team 模式已暴露但原生多 Agent 架构仍未闭环 | v0.6.10 | - | 2026-03-18 | - |
| 093 | Low | Open | 缺少 IDE / Desktop / Web 一体化分发表面 (Vibe Coding 时代已降级) | v0.6.10 | - | 2026-03-18 | - |
| 094 | Medium | Open | 核心工作流文件与函数过大，职责耦合导致重构成本持续上升 | v0.6.13 | - | 2026-03-22 | - |
| 095 | Medium | Open | Agent / REPL 主流程仍存在重复编排与手写运行时流程 | v0.6.13 | - | 2026-03-22 | - |
| 096 | Low | Open | 类型边界过宽且共享可变状态较多 | v0.6.13 | - | 2026-03-22 | - |
| 097 | Medium | Open | 错误处理、阻塞式 I/O 与执行侧副作用清理仍不完整 | v0.6.13 | - | 2026-03-22 | - |
| 098 | Low | Open | 重复 helper、兼容层导出、魔法数字与硬编码字符串需要收敛 | v0.6.13 | - | 2026-03-22 | - |
| 099 | Low | Open | 测试辅助代码重复，局部验证资产需要收敛 | v0.6.13 | - | 2026-03-22 | - |


| 105 | Medium | Resolved | kodax -c 可选择空 ACP 占位 session，classic REPL 还会忽略 resume | v0.7.14 | v0.7.74 | 2026-04-03 | 2026-07-23 |
| 106 | High | Open | Managed-task structured worker blocks remain text-coupled and can fail closed on protocol drift | v0.7.14 | - | 2026-04-08 | - |
| 107 | Medium | Open | harnessProfile 类型命名残留 - H0/H1/H2 应替换为 worker-chain composition | v0.7.16 | - | 2026-04-11 | - |

| 110 | Low | Open | 缺少 /mcp status 和 /mcp refresh REPL 命令 | v0.7.16 | - | 2026-04-11 | - |
| 112 | High | Resolved | ask_user_question 交互机制不完备 — 数字编号歧义 + 缺少 input/multiSelect 模式 | v0.7.18 | v0.7.62 | 2026-04-12 | 2026-07-06 |
| 118 | Medium | Open | esbuild 打包替代 tsc 直接运行 — 消除运行时模块开销与 React dev 模式 | v0.7.19 | - | 2026-04-17 | - |
| 119 | High | Open | Scout 升级 H0→H1 后残留 pre-Scout mutationSurface — Generator 被错误锁为 docs-only | v0.7.20 | - | 2026-04-19 | - |
| 120 | High | Open | Skill / Plan-mode 调用路径下流式注入 prompt 失效 — `canQueueFollowUps` 未开启 | 一直存在 | - | 2026-04-20 | - |
| 122 | Medium | Open | edit / multi_edit 错误消息在 v0.7.26 过度精简 — 丢失关键信息载体导致 LLM 恢复失败 | v0.7.26 | - | 2026-04-23 | - |
| 124 | High | Open | AMA 子 Agent dispatch 实际触发率偏低 — Controller fanout gate + H1 工具白名单串联收得过紧 | v0.7.18 | - | 2026-04-26 | - |
| 125 | Low | Open | Thinking-mode cross-provider replay — 三个不可测 OpenAI-compat 与 anthropic 官方 strict mode 待实证 | v0.7.28 | - | 2026-04-26 | - |
| 126 | Low | Open | tmux 默认不透传 OSC 8 超链接 — kodax 输出中的 file:// / docs URL 在 tmux 内不可点击 | 一直存在 | - | 2026-04-28 | - |
| 133 | Low | Open | `repo-intelligence/runtime.test.ts` "falls back to OSS when premium returns malformed preturn payloads" intermittent flake under heavy parallel load — failure mode not yet captured | 待调研 | - | 2026-05-16 | - |
| 136 | Low | Open | 流式 / 滚动时 spinner 动画卡顿 + 计时变慢 — 根因在 CPU 侧每帧渲染（React reconciliation + outputToScreen 全量重建），**非**终端写入字节量（cell-diff + DECSTBM 两次否证 I/O 假设） | 待调研 | - | 2026-05-31 | - |
| 141 | Medium | Open | CI workflow long-red on Linux: cross-platform test bugs (storage list() runtime-inspection, bash background-process, h2 spawn env, skill-creator API-key-at-load) | long-standing (pre-v0.7.49) | - | 2026-06-18 | - |
| 145 | High | Resolved | Runtime daemon / SDK 边界存在生命周期、事件、权限与协议一致性缺口 | v0.7.64-v0.7.66 | v0.7.66 | 2026-07-10 | 2026-07-10 |
| 146 | Medium | Resolved | 图片路径粘贴处理失败时吞掉原始输入且无可见反馈 | v0.7.40 | v0.7.66 | 2026-07-10 | 2026-07-10 |
| 147 | High | Resolved | GitHub Release 二进制归档遗漏 Runtime 与工具 Worker sidecar | v0.7.66 RC | v0.7.66 | 2026-07-10 | 2026-07-10 |

---

## Issue Details
<!-- Full details for each issue - REQUIRED for all issues -->

### 324: Repeated same-file edits with identical line stats still collapse, dropping every diff but the last

- **Priority**: Medium
- **Status**: Open
- **Introduced**: FEATURE_067 tool summary collapse
- **Created**: 2026-08-28

#### Problem

`collapseToolCalls` keys non-progress tools by `${summary}|${error ?? ""}` and a
repeated hit overwrites `existing.tool` with the later call
(packages/repl/src/ui/utils/tool-display.ts:847-852). The 39474d9b change made
edit summaries output-derived (`edit - <path> - +N -M`), so repeated same-file
edits stop collapsing only while the line stats differ. The common case of N
sequential single-line edits — each `+1 -1`, e.g. renaming a symbol occurrence
by occurrence — produces identical keys, collapses to `xN`, and renders only
the final edit's diff rows. This directly contradicts that commit's stated
"repeated same-file edits no longer collapse to x2, so every edit keeps its
diff rows".

#### Fix Direction

Include `tool.id` in the collapse key for mutation tools
(edit/write/multi_edit/insert_after_anchor), mirroring the existing
`hasProgress` escape at :846-848, so identical-stat mutation calls never merge.
Read-only tools keep the shared-key collapse.

### 323: Quota-worded non-429 provider errors retry as rate limits but report as upstream errors

- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.7.96 status-bucketed runtime failure taxonomy
- **Created**: 2026-08-28

#### Problem

The coding resilience classifier marks `errorClass: "rate_limit"` from
`KodaXRateLimitError` identity or message patterns
(packages/coding/src/resilience/classifier.ts:203-218), and the llm retry path
uses the same keyword family ('limit', 'busy', '1302', '503'…) accumulated
from real provider quirks (packages/llm/src/providers/base.ts
`isRateLimitError`). `classifyRuntimeKnownFailure` now requires
`status === 429` (or an absent status) to report `providerErrorCode:
rate_limited` (src/sdk-runtime.ts:21578). A provider answering 400/402 with
quota wording is therefore retried up to three times with 60 s spacing by the
coding layer, yet surfaced to embedders as `upstream_client_error`.
`retryAfterMs` is typically absent on such responses, so an embedder keying
rate-limit backoff UI off `providerErrorCode` loses the signal the retry layer
acted on. The 503/529 → `upstream_server_error` mapping is pinned as
intentional by the taxonomy test; the 400/402-with-quota-wording case is
unpinned drift.

#### Fix Direction

Decide and pin one direction with a taxonomy test. Either accept
`errorClass === "rate_limit"` into the `rate_limited` branch so reporting
matches retry behavior — noting the keyword false-positive risk (a 400
"invalid limit parameter" would enter the taxonomy), which argues for matching
only when the underlying error is a `KodaXRateLimitError` rather than
pattern-matched — or keep status-bucketed reporting and document the divergence
in the embedder guide.

### 322: Irreducible-input compaction resets the summarizer circuit-breaker counter to zero, disarming protection for later ordinary turns

- **Priority**: Medium
- **Status**: Open
- **Introduced**: FEATURE_296 breaker-bounded hard-pressure compaction
- **Created**: 2026-08-28

#### Problem

`tryIntelligentCompact` resets `nextFailures = 0` whenever
`hasIrreducibleInput` holds — both in the still-over partial-success branch
(packages/coding/src/agent-runtime/middleware/compaction-orchestration.ts:346-350)
and the catch arm (:402-404). The in-code comment justifies only "must not
consume or trip the summarizer breaker": an irreducible turn should leave the
counter unchanged, not zero it. With the summarizer endpoint down and a
workload that interleaves irreducible turns with ordinary hard-pressure turns,
each irreducible turn resets the count that the following ordinary failures
must rebuild, so the configured breaker limit may never trip and every
hard-pressure turn keeps paying a doomed summary call before typed capacity.
The file header (:9-13) and the function docstring (:134-138) also state
unconditionally that "an open breaker returns typed capacity without another
summary", contradicting the deliberate irreducible exception at :156.

#### Fix Direction

In both irreducible branches, keep the counter at
`input.compactConsecutiveFailures` instead of resetting to 0, and update the
header/docstring to record the irreducible exception. Do not "fix" this by
making the :156 throw unconditional for irreducible input: one bounded summary
attempt per turn is intentional — the request-copy degradation rung owns the
oversized message, and shrinking history still helps the post-degradation
request fit — so only the counter reset and the stale comments are defects.

### 321: Every runtime cancellation terminal attributes the stop to the user, including runtime shutdown and internal aborts

- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.7.96 runtime failure-detail cancellation receipt
- **Created**: 2026-08-28

#### Problem

`runtimeCancellationFailureDetail()` hardcodes
`safeMessage: "Runtime run was cancelled by the user."`
(src/sdk-runtime.ts:21804-21811) and is the single constructor for cancelled
failure details. All cancellation paths use it, including
`cancelRun(record, "runtime closed", false)` on launch rejection (:9031), the
internal executor abort "runtime run aborted" (:10281), and `closeAll(reason)`
shutdown (:10401). A run ended by embedder runtime shutdown therefore ships a
terminal fact and `safeMessage` asserting user attribution, and the
host-provided cancel reason no longer appears in `terminal.message`. The
neutral phrasing already exists in `runtimeFailurePublicMessage`
("Runtime run was cancelled.", :21836); the cancellation path simply does not
use it.

#### Fix Direction

Parameterize `runtimeCancellationFailureDetail` by cancellation source, or
default to the existing neutral message and reserve "by the user" for the
interactive stop path. Keep the host-provided reason visible in
`terminal.message` — it is host-authored, not provider-controlled, so it is
not a leakage surface.

### 320: Unix trusted text commit reads the target before locking and can misclassify a concurrent replace as a hard link

- **Priority**: High
- **Status**: Resolved
- **Introduced**: FEATURE_295 Unix trusted text transaction
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-28
- **Resolved**: 2026-08-28

#### Original Problem

`commit()` read the target once before acquiring its namespace lock solely to
obtain a slot ID that was already derived from the namespace. If a peer commit
atomically replaced the target between `open` and `metadata`, the old open inode
had zero links. The generic `nlink != 1` check then reported a hard-link policy
violation instead of allowing the serialized commit to observe a stale
revision. GitHub's Node 22 trusted-text integration reproduced this race.

#### Resolution

Commit now derives the namespace slot without opening the target, acquires the
cross-process kernel lock, and performs its first target content/identity read
inside that lock. Real multi-link targets remain rejected by the unchanged
locked snapshot check. Concurrent commits against one observed revision return
one written and one stale result; different namespace slots remain parallel.

### 319: Electron ASAR virtual stats fail native artifact identity verification despite physical unpacked bytes

- **Priority**: High
- **Status**: Resolved
- **Introduced**: FEATURE_295 packaged Electron native verification
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-28
- **Resolved**: 2026-08-28

#### Original Problem

The packaged Electron daemon failed sandbox preparation even though
electron-builder had materialized the ASRT runner and KodaX native binaries
under `app.asar.unpacked`. Electron returned synthetic, changing identity data
for `lstat(app.asar/...)` while `open` and `fstat` described the physical NTFS
file. The intentional stable-file check therefore rejected both artifact
families before the packaged sandbox smoke could run.

#### Resolution

Embedded-manifest resolution now maps only an exact `app.asar` path component
to an existing physical `app.asar.unpacked` sibling. The physical file still
passes the original ordinary-file, descriptor identity, byte bound, embedded
SHA-256, and protected-cache verification; development manifests receive no
ASAR-specific relaxation. The Electron fixture explicitly unpacks both native
trees and verifies the required physical files before process startup. The SDK
embedder guide publishes the same packaging contract for host applications.

### 318: Native shell admission writes traversal ACEs to every allow-root ancestor and can hang while Windows propagates a profile DACL

- **Priority**: High
- **Status**: Resolved
- **Introduced**: FEATURE_295 first native capability plan
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-27
- **Resolved**: 2026-08-27

#### Original Problem

A real sandbox smoke rooted below `%LOCALAPPDATA%\Temp` never reached the
restricted target, then reported both command timeout and unconfirmed native
termination. Stage diagnostics proved the native host was blocked inside
`SetSecurityInfo` while adding a traversal ACE to
`C:\Users\<host>\AppData`. Updating a container DACL can propagate inheritance
through its descendants, so the cost depended on unrelated profile size and
could exceed every command and drain deadline. A workspace below `C:\Works`
appeared healthy because its smaller ancestors had already accumulated grants.

#### Resolution

Shell admission no longer mutates allow-root ancestors. The restricted target
already receives enabled `SeChangeNotifyPrivilege`, whose Windows contract
bypasses directory traverse checks without granting directory listing or file
content. Read/write authority remains attached only to each handle-canonical
allow root through the existing sandbox-group and filesystem-capability ACEs.
An allow root nested below an explicit policy deny is still rejected before
the first mutation. The native plan test now requires every persistent allow
operation to target an exact root, and the real `%TEMP%` loader gate completes
under the original 15-second budget.

### 317: A hash-correct package hardlink is rejected before ASRT runner import and silently sends Windows Bash to normal permissions

- **Priority**: High
- **Status**: Resolved
- **Introduced**: FEATURE_295 protected ASRT artifact import
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-27
- **Resolved**: 2026-08-27

#### Original Problem

On a valid local package installation, `kodax sandbox doctor` could report
ready while model-issued Bash later ran as the host user. The package manager
had installed the hash-pinned ASRT runner as a hardlink to its content store.
The import path applied the protected-cache `nlink === 1` invariant to that
untrusted package source before copying it, rejected preparation, and the
declared local fallback preserved task execution at normal permissions.
Trusted text tools were unaffected because they intentionally run in the host.

#### Resolution

The two trust stages now have distinct invariants. In a bundled build, a
package source may be a hardlink only when a handle-bound bounded read matches
the exact SHA-256 embedded in the release manifest; its link count is not an
authority claim. Development manifests and sources remain single-link because
their digest is not an immutable embedded trust root. KodaX copies the
authenticated bytes into its protected content-addressed cache. That final
executable still requires a single link, protected ACLs, the expected hash,
and the existing no-reparse checks before broker launch. A regression test
imports a real two-link source, proves the protected copy is single-link, and
rejects later source-byte tampering.

### 316: A concurrent Windows reader can win the final replace race and make trusted Write return Win32 error 5

- **Priority**: High
- **Status**: Resolved
- **Introduced**: FEATURE_295 Windows atomic text replace
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-27
- **Resolved**: 2026-08-27

#### Problem and Resolution

The first continuous-reader acceptance test reproduced
`atomic text transaction replace failed` with Win32 error 5. The transaction
briefly probed DELETE sharing and closed that handle; a new reader could open
without DELETE sharing between the probe and `FileRenameInformationEx`. The
probe therefore proved only a past instant. Commit now acquires and holds a
target delete/write reservation through the locked final reread, CAS, and
namespace commit. Windows POSIX rename semantics permit replacement while
compatible readers remain open; new incompatible readers cannot enter the
narrow commit window, and new writers are excluded after final CAS. Internal
snapshot handles share read/write/delete so KodaX readers do not create the
failure themselves. A continuous half-megabyte reader/writer stress test proves
that every successful read is exactly an old or new revision, never partial.

### 315: Native artifact staging exceeds legacy Windows path limits although the final cache path is valid

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: FEATURE_295 PowerShell 5.1 artifact staging
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-27
- **Resolved**: 2026-08-27

#### Problem and Resolution

The complete sandbox-runtime suite found that a valid deep `LOCALAPPDATA` cache
could still fail before launch: the PowerShell 5.1 staging name appended a
32-character GUID and pushed the temporary path beyond the legacy `MAX_PATH`
boundary. The final artifact name itself fit. Staging now uses the shorter
cryptographically random name returned by `GetRandomFileName()` while retaining
same-directory atomic replacement and hash verification. A deep-cache regression
test covers the exact boundary.

### 314: Per-command propagation of fixed sensitive-root denies serializes independent Windows shells

- **Priority**: High
- **Status**: Resolved
- **Introduced**: FEATURE_295 first native-shell draft
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-27
- **Resolved**: 2026-08-27

#### Problem and Resolution

The first native-shell draft attached the same fixed Agent Home and credential
denies to every command. Windows inherited-ACL propagation occurred under one
machine mutex, so large existing trees created head-of-line blocking across
otherwise independent Runtime, Session, and policy commands. Setup now installs
the fixed exact-root denies once for the stable sandbox group through native
no-follow handles. Command admission verifies the installed DACL; if an exact
sensitive root materializes only after setup, admission adds that one missing
guard idempotently under the same owner-recovering native mutex. Dynamic
per-command denies remain scoped to the command. The broad Agent Home and native
artifact-cache parents are not recursively stamped.

### 313: Stale inherited shared-account ACEs make every fresh Windows shell fail admission after reboot or setup

- **Priority**: High
- **Status**: Resolved
- **Introduced**: pre-FEATURE_295 shared-account ACL grants
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-27
- **Resolved**: 2026-08-27

#### Original Problem

Real Windows acceptance failed on fresh `%TEMP%` descendants because an ancestor
still carried an inherited direct Modify ACE for the dedicated sandbox user.
Reboot and ordinary setup retained the account, so every new directory inherited
the ACE and native preflight rejected every shell as
`windows_v2_legacy_user_ace`.

#### Resolution

The native preflight no longer treats a direct shared-account ACE as machine
corruption or blocks every shell. Exact `AllowRead` / `AllowWrite` capabilities
are still installed for declared roots, and stale inherited user ACEs require
no recursive cleanup, account rotation, reboot, or persistent lock before
admission. The primary account SID remains in the restricting set because real
Node, cmd, and PowerShell child creation otherwise fails with `EPERM`. Therefore
this operational self-heal does not claim that a hostile explicit/protected
child DACL cannot widen a later policy; that separate authority limitation
remains open as Issue 309.

### 312: A dead Windows shell request makes native control-state repair permanently reject the non-empty directory

- **Priority**: High
- **Status**: Resolved
- **Introduced**: FEATURE_295 protected native shell control state
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-27
- **Resolved**: 2026-08-27

#### Original Problem

The complete real-Windows policy suite found an old
`windows-shell-<dead-pid>-<nonce>.json` request in the protected native control
directory. Doctor correctly rejected an injected ACL drift, but explicit setup
also rejected the host-owned directory merely because that dead request made it
non-empty. The damaged DACL then made every later shell admission unavailable,
even though trusted text tools remained independent.

#### Root Cause

Preparation normally removes request and terminal records, but a host crash can
leave a request before the native host consumes it. Control-state repair treated
all non-empty entries identically. It did not distinguish a live command, an ACL
recovery receipt, or unknown state from an expired request whose creator PID was
already dead and whose operation deadline had passed.

#### Resolution

Explicit repair, after its existing proof that the sandbox SID is idle, now
retires only bounded, ordinary control records whose inactivity is independently
proved: an expired shell request or aged unconsumed network request owned by a
dead PID, or a terminal record with `jobDrained: true` and a dead creator. A live
PID, an unexpired or malformed record, an unknown filename, and every
`windows-deny` recovery receipt remain fail-closed and keep repair from changing
the DACL. Doctor remains verify-only.

- **Files Changed**: `src/windows-native-artifacts.ts`, Windows policy smoke and
  sandbox documentation
- **Tests Added**: real host-owned control DACL drift with both an expired dead
  request and an expired live-owner request; repair retires only the former,
  rejects the latter, and succeeds after the live owner record is removed
- **Resolution Date**: 2026-08-27

### 311: Windows Session event cursor replacement fails under a non-delete-sharing handle and workspace shell authority includes Runtime state

- **Priority**: High
- **Status**: Resolved
- **Introduced**: Runtime per-Session sequence cursor / workspace shell root grant
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-27
- **Resolved**: 2026-08-27

#### Original Problem

While two KodaX threads were active, one Run terminated with `EPERM: operation
not permitted, rename ...sequence.<pid>.<uuid>.tmp -> ...sequence`. The affected
Session had already persisted more than one thousand monotonic events and later
files were host-owned with no deny ACE, ruling out a persistent status lock or
permanent ACL denial. At the same time, workspace-local `.kodax/runtime` was
inside the shell's broad workspace read/write authority.

#### Root Cause

The recoverable per-Session sequence cursor used the same temporary-file rename
as authoritative Runtime JSON. On Windows, replacing an existing path requires
every open target handle to share DELETE. A watcher, filter, or another process
opening `sequence` with read/write sharing but without delete sharing therefore
made the single `renameSync` fail immediately. KodaX's per-Session lock covered
allocation and append correctly; it could not change an external handle's share
mode. Separately, shell policy denied global Agent Home state but did not carve
workspace-local `.kodax/runtime` out of its writable workspace root.

#### Resolution

The derived sequence cursor now uses its own lock-held in-place durable writer:
open/truncate, write, `fsync`, close, with a one-second Windows retry budget for
`EPERM`/`EACCES`/`EBUSY`. It no longer depends on DELETE sharing. A crash after
truncate is recoverable by design because the next locked read scans durable
per-Run event ledgers for the maximum sequence before allocating again. Other
authoritative Runtime files retain atomic replacement. Workspace-local
`.kodax/runtime` is now included in shell read and write denies, preventing a
restricted command from opening or modifying Session journals, cursors, daemon
records, or grants while ordinary workspace files remain writable.

- **Files Changed**: `src/sdk-runtime.ts`, `src/sandbox-runtime.ts`
- **Tests Added**: real Windows non-delete-sharing cursor holder; temporary
  non-write-sharing holder with bounded recovery; truncated-cursor ledger
  recovery; Windows native request denial for workspace-local Runtime state
- **Resolution Date**: 2026-08-27

### 310: Trusted Write cannot replace a Windows file owned by an old or current sandbox identity

- **Priority**: High
- **Status**: Resolved
- **Introduced**: FEATURE_295 Windows metadata preservation
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-27
- **Resolved**: 2026-08-27

#### Original Problem

After rebuilding and linking v0.7.95 plus the FEATURE_295 worktree, trusted
`write` still failed on an existing ordinary text file with `cannot preserve
existing text file security metadata`. The file had only the Archive attribute,
but deletion was also denied. A tight native transaction loop reproduced the
failure deterministically with Win32 error 1307 (`ERROR_INVALID_OWNER`).

#### Root Cause

The file was owned by a retired sandbox-account SID. The Windows transaction
copied OWNER, GROUP, DACL, label and resource attributes to its same-directory
temporary file in one `SetSecurityInfo` call. The trusted host lacks
`SeRestorePrivilege` and cannot assign an arbitrary foreign owner, so metadata
copy failed before any content write. Files moved from a former sandbox root
could also carry stale inherited ACEs that should not be frozen at the new
parent, or an explicit low-integrity mandatory label that an ordinary trusted
host cannot reapply.

#### Resolution

Windows replacements now become trusted-host-owned and never reassign a foreign
owner/group. The ordered effective ACE policy is retained, while the filesystem
may canonicalize DACL protection/inheritance control at the atomic namespace
commit; stale inherited authority is not copied from an old parent. Security
metadata classes are applied and verified independently.
An explicit low/untrusted mandatory label is recognized as legacy sandbox-origin
metadata and normalized to the destination directory's ordinary host integrity;
higher or unknown labels remain fail-closed. This is automatic on the first
trusted Write/Edit: no setup, reboot, owner file, or manual ACL repair is
required.

- **Files Changed**: `native/windows-text-transaction/src/windows_transaction.rs`,
  trusted-text documentation
- **Tests Added**: real sandbox-owned file replacement twice; real moved
  sandbox-owned file with stale inheritance remains unprotected after self-heal;
  real low-integrity file replacement does not reapply the obsolete label
- **Resolution Date**: 2026-08-27

### 309: An explicit ambient compatibility ACE can bypass a later Windows root capability

- **Priority**: Medium
- **Status**: Open
- **Introduced**: Windows v2 Codex-compatible restricted token
- **Created**: 2026-08-27

#### Problem

Windows `WRITE_RESTRICTED` checks a write against both the normal token and the
restricting SID set. KodaX, like current Codex, retains the dedicated primary
sandbox-user, per-launch logon, and Everyone SIDs because real Node, cmd, and
PowerShell subprocess creation fails when the primary SID is removed. Exact
`AllowRead` / `AllowWrite` capabilities are still installed for declared roots,
but an explicit ambient-trustee child DACL can satisfy the restricted pass
without the intended root capability.
However, a sandbox command owns files and directories that it creates below an
authorized write root. It can deliberately change such an object's DACL to
grant modify access to an ambient compatibility SID. A later command can then
satisfy both access-check passes without possessing that root's allow-write
capability. An inheritable deny added only at the root does not override an
existing explicit or protected child DACL.

This does not require an earlier adversarial command in the same KodaX Session:
an existing descendant created earlier or externally can already carry the
explicit ambient compatibility ACE, including a host-owned object whose DACL
explicitly grants that trustee. Host-only protected objects that omit such an
ACE remain protected. The residual does not affect trusted text tools, which use host-side
canonical identity, kernel slot locks, and CAS rather than the shell token. A
command-lifetime filesystem fence would not repair the access-control gap.

#### Rejected Patch and Direction

An inheritable OWNER RIGHTS deny for `WRITE_DAC`/`WRITE_OWNER` was tested and
rejected: it also applies to host-owned existing descendants and prevents the
trusted native host from installing or recovering execution-scoped `denyRead`
ACEs. Recursive stamping would reintroduce the slow, globally mutable ACL graph
that FEATURE_295 removes.

Close this issue only with a Windows authority model that removes ambient
write trustees without breaking loader startup (for example, a proven
AppContainer/capability design or equivalent native mediation). Regression
coverage must include explicit/protected child DACLs and existing descendants;
ordinary root-only capability tests are insufficient.

### 308: ASRT's fixed Windows proxy range caps simultaneous distinct network-policy brokers

- **Priority**: Medium
- **Status**: Open
- **Introduced**: ASRT 0.0.65 Windows network proxy
- **Created**: 2026-08-27

#### Problem

ASRT's Windows network backend allocates one HTTP backend port and one mux
frontend port for each initialized `SandboxManager`, from the fixed
`60080..60089` range. FEATURE_295 now shares one process-level broker among
concurrent commands whose complete network policy and sandbox-account
generation are identical. This keeps same-policy commands parallel under port
pressure and removes the previous per-command port multiplication.

Different network policies and different KodaX Runtime processes cannot safely
join that broker. Each distinct live broker still consumes two of the ten ASRT
ports, so at most five distinct cold brokers can coexist before ASRT reports
that no proxy port is free. This limitation affects shell network containment
only. Trusted text tools do not use ASRT and remain available.

#### Root Cause and Direction

ASRT 0.0.65 installs one process-global network callback per
`SandboxManager`, but its proxy connection does not expose a trustworthy
per-client policy identity that KodaX could use for routing. Codex instead has
a process-shared Windows ingress that attributes connections to the restricted
token SID before selecting a route. Sharing one permissive ASRT callback across
different KodaX policies would widen authority; widening the WFP port range or
serializing shell command lifetimes would only hide the missing routing
contract.

Close this issue only after ASRT exposes authenticated connection attribution /
shared ingress routing, or KodaX owns an equivalent native policy-capable
ingress. Regression coverage must keep same-network-policy commands on one
broker, keep different policies isolated, rotate the key with the sandbox
account generation, and prove trusted text remains independent when all proxy
ports are unavailable.

### 307: ASRT launches the shared-account Windows shell runner before KodaX can attach a creation-time process DACL or Job

- **Priority**: High
- **Status**: Open
- **Introduced**: Windows v2 ASRT runner bootstrap
- **Created**: 2026-08-26

#### Problem

KodaX creates every final shell target suspended and assigns it to the
no-breakaway, kill-on-close Job through the creation-time Job attribute before
resume. The preceding runner is different: ASRT 0.0.65 owns the
`CreateProcessWithLogonW` call under the shared sandbox account, so KodaX code
cannot apply a runner process DACL or Job atomically at creation. A concurrently
compromised process under that account therefore retains a narrow pre-main race
against the runner. A loader failure before runner `main` also remains inside
ASRT's creation contract; KodaX requests inherited error-mode suppression in
the host and repeats it in runner code, but cannot retroactively protect an
image that failed before entry.

This boundary does not involve trusted text tools, which never enter ASRT, and
does not weaken creation-time containment of the final command target. Current
Codex retains the same `CreateProcessWithLogonW` runner-bootstrap residual
while assigning its final target Job at creation.

#### Closure Direction

Close this issue only when ASRT accepts creation-time process/thread security
descriptors plus containment handles, or when a privileged KodaX spawn service
owns the equivalent atomic boundary. A post-spawn DACL or Job attachment cannot
close the race and must not be presented as doing so. Regression coverage must
continue to prove final-target creation-time Job containment, fail-closed peer
loss, loader-error suppression where KodaX code is reachable, and complete
independence of trusted text transactions.

### 305: A cross-Runtime idle close queues an account-wide cleanup transition that blocks same-policy writes in the queueing Runtime until the other Runtime's command completes

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.9x durable cleanup-transition serialization (pre-existing; surfaced by the Issue-304 cross-review)
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-25
- **Resolved**: 2026-08-26

#### Original Problem

Two KodaX processes sharing one machine home: Runtime B runs a long background
command (holding its durable shell lease); Runtime A finishes a write, goes
idle, and its lifecycle session close enters the durable cleanup fence. The
cleanup lease is deliberately policy-agnostic and account-wide
(`file-mutation-queue.ts` — pinned by the
`keeps cleanup queued past 30 seconds and blocks same-policy admission`
regression), so A's queued cleanup waits behind B's lease — and A's next
same-policy write cannot acquire its filesystem-effect lease either, failing
after ~30 s with `A model filesystem effect is already active; retry after it
finishes` until B's command completes. In-process (single Runtime) the
Issue-304 fix prevents the idle close from even starting behind a live lease;
only cross-process leases are invisible to that check.

#### Resolution

FEATURE_295 / ADR-066 removes trusted text mutation from the workspace-session
and filesystem-effect graph, while the Windows v2 shell runner bypasses the
legacy owner/reset/cleanup lease graph. POSIX shell preparation is per-command
and also keeps no KodaX workspace-session owner. A real two-Runtime Windows
acceptance test reaches both targets concurrently; protected sidecar
verification shares an already executing immutable image, so artifact
provisioning cannot recreate a cross-Runtime admission lock.

### 306: ASRT Windows consumes runner stdin as control data, so sandboxed text helpers inherit EOF and every real write fails

- **Priority**: High
- **Status**: Resolved
- **Introduced**: Windows ASRT process backend through 0.0.73
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-25
- **Resolved**: 2026-08-26

#### Problem and evidence

Session `20260825_215704_r8107f13f0eec3` failed a trivial `write` with
`Sandboxed text mutation and cleanup both failed`, while shell redirection
succeeded. A direct real-backend probe reproduced it deterministically. The
request file remained intact and the ASRT broker lived long enough to parse
and delete it. The final text helper then emitted `Unexpected end of JSON
input` because it received immediate EOF. Win32 87 occurred later when the
PowerShell containment probe attempted to reopen the already-exited broker.

ASRT writes its length-prefixed `RunnerCmd` into the restricted runner's stdin
and closes that pipe; the final target inherits the same closed stream. KodaX's
payload was written to the outer ASRT process stdin, which ASRT never forwards.
The same design remains in ASRT 0.0.67 and current 0.0.73.

#### Resolution

FEATURE_295 / ADR-066 deletes the text-payload runner path instead of repairing
it. Trusted `write` / `edit` transactions run directly in the KodaX Runtime
through a separately packaged in-process filesystem primitive and cannot be
blocked by ASRT, runner, setup, owner, cleanup, reset, or poison state. The
native runner retains framed stdin only for general shell/process execution;
control and target streams are independent, and no text helper or payload-file
fallback remains.

### 304: A long-lived background sandbox command parks a workspace session reset and every later text mutation fails closed as unavailable

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.9x Windows pending-reset fail-closed (sandboxRuntime:5)
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-24
- **Resolved**: 2026-08-25

#### Original Problem

Field report (0.7.95): after starting a background bash through `kodax run`,
every subsequent `write` tool call fails with
`The Runtime sandboxed file mutation is unavailable`, while `bash` itself keeps
working through its normal-permission fallback. Rebooting did not help while the
background command's state persisted.

#### Root Cause

`getWorkspaceSession` fails closed on Windows: while
`pendingWorkspaceSessionResets` or `pendingWindowsSandboxAclTransitions` is
non-empty it returns `undefined` immediately (src/sandbox-runtime.ts), so text
mutation preparation reports `not_ready` and the write tool resolves
`{status:'unavailable'}`. A session close runs inside
`withExclusiveFileSystemCleanupFence`; when a long-lived background command
holds the exclusive filesystem-effect fence (or the Windows ACL owner
admission), the close cannot finish and the tracked reset stays pending for the
command's whole lifetime. Every sandboxed text mutation during that window
fails closed instantly instead of waiting for or reusing the still-live session.
The pinned regression
(`fails sandbox admission closed while a workspace session reset is pending`)
documents the current semantics and the recovery once the reset settles.

#### Resolution

The fix keeps the fail-closed admission gate for genuinely in-flight ACL
transitions but removes every path where a long-lived background command could
park one permanently (validated by a three-way research review —
implementation feasibility, safety red team, and a codex architecture
cross-check):

- **Deferred close, defer-before-evict** (`close(mode)` in the workspace
  session client): a lifecycle close defers while the session still holds
  active leases instead of draining 1.5s and terminating the live background
  command; the last lease release re-fires it, and the lease-held deferral is
  diagnosed by an observability-only watchdog (never a kill — a leaked lease is
  indistinguishable from a long compile at the session layer). `closing`,
  cache eviction, and the pending-reset registration move inside the cleanup
  fence action, so a close waiting behind a held fence leaves the session
  cached and reusable, and the tracked reset is visible only between fence
  admission and settle. The fence action re-checks leases before committing so
  a close can never terminate a session under a lease that arrived while it
  waited. Forced closes (shutdown, `beforeExit`, test reset, RPC-timeout
  retire) keep the historical drain-then-terminate semantics.
- **No poison for never-started cleanups**: the filesystem-effect coordinator
  only escalates a deferred cleanup failure to durable ACL recovery when the
  cleanup action actually started; admission/bind failures leave the session
  legitimately owning its marker. This closes the reboot-persistent
  account-wide lockout that made the field report survive restarts.
- **Cleanup RPC timeouts retire only the request**: a cleanup legitimately
  queued behind live work no longer fails every pending wrap and kills the
  session child — the exact 130-second background-command failure mode.
- **Lease-aware standalone admission**: standalone SDK admission no longer
  pre-clears the whole session cache; it closes idle sessions, leaves leased
  sessions cached and servable, and fails with a structured contention error
  after a short grace instead of proceeding to the keyless owner over a live
  session (preserving the standalone path's all-sessions-reset precondition).
- **Per-policy pending resets**: the admission gate blocks only on same-policy
  resets plus account-wide transitions; resets without a policy key remain
  global blockers, and all drain consumers (shutdown, standalone startup,
  test reset) still wait for every in-flight close via a new entry-registered
  in-flight set.
- **Structured unavailability reasons**: text mutations report
  `not_ready` / `not_selected` / `session_reset_pending` /
  `acl_transition_pending` through the observation and the user-facing error.

Acceptance tests: fence-held session reuse, cleanup-timeout survival,
structured standalone contention, global blocking of forced resets, plus the
retained regression pinning fail-closed admission during a mid-action reset.

Residuals in the legacy backend remain documented by Issue 305. FEATURE_295
does not add another patch to that lifecycle. Instead,
[ADR-066](ADR.md#adr-066-trusted-text-transactions-and-a-native-windows-shell-sandbox-are-separate-authorities)
removes trusted text mutation from the graph and makes the Windows v2 shell
runner bypass owner/reset/cleanup admission entirely. ADR-065's capability-SID
permission economics remain part of the shell design; its ASRT workspace-
session execution model is superseded.

### 303: Bundled Windows binary resolved srt-win.exe onto Bun's virtual `B:\` drive, so the sandbox backend was permanently unavailable

- **Priority**: High
- **Status**: Resolved
- **Introduced**: bundled (Bun `--compile`) Windows builds
- **Fixed**: v0.7.96-alpha
- **Created**: 2026-08-24
- **Resolved**: 2026-08-24

#### Original Problem

On a customer machine running the bundled `dist/binary/win-x64/kodax.exe`,
`kodax sandbox doctor` and `kodax sandbox setup` failed with
`srt-win.exe not found. … Looked in: B:\vendor\srt-win\x64\srt-win.exe,
B:\vendor\srt-win-src\target\release\srt-win.exe`, and every `write` tool call
reported `The Runtime sandboxed file mutation is unavailable`. Rebooting did
not help. `bash` kept working through its normal-permission fallback.

#### Root Cause

Bun `--compile` mounts embedded modules on the virtual drive `B:\~bun\root`.
The ASRT library's `getSrtWinPath()` is module-URL relative, so inside the
bundled binary its candidates resolve onto `B:\vendor\...` and never exist.
KodaX stages srt-win.exe through `prepareWindowsSandboxRunner()`
(`readFile(getSrtWinPath())`), which is the single library-default resolution
point; when it throws, the whole Windows sandbox backend is unavailable. A
first sidecar-only repair attempt still left `kodax sandbox setup` broken on
machines without a previously provisioned sandbox account because the setup
path called `installWindowsSandbox()` without the prepared-runner override, and
the ASRT install helper re-ran the same module-relative lookup.

#### Resolution

`scripts/build-binary.mjs` now ships
`vendor/srt-win/<arch>/srt-win.exe` next to the bundled executable (build fails
if the packaged binary is missing). `resolveSrtWinSourcePath()` prefers that
sidecar in `KODAX_BUNDLED` builds and falls back to the library lookup for
development and mocked layouts; `prepareWindowsSandboxRunner()` stages from it.
`setupWindowsSandboxRuntimeWithLock()` prepares the runner first and passes
`installWindowsSandbox({ srtWin: runner.srtWin })`, so setup no longer depends
on the library lookup on any layout. Covered by the
`bundled srt-win sidecar resolution` test group, including the setup-through-
runner assertion.

### 302: Runtime completion fallback could publish an empty A2A answer before the coding result settled

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.79 Runtime completion fallback
- **Fixed**: v0.7.95 release
- **Created**: 2026-08-23
- **Resolved**: 2026-08-23

#### Original Problem

An Agent started with `kodax a2a serve` could finish successfully while its A2A
Task contained neither an Agent message nor an artifact. The same request still
left the actual assistant reply in Session history. v0.7.73 returned the reply,
while affected releases included v0.7.82 and v0.7.94.

#### Root Cause

The coding substrate emitted `events.onComplete` before awaiting the extension
`complete` event and asynchronous result finalization. The Runtime completion
fallback therefore had time to settle the public Run as `completed` without a
`KodaXResult`. A2A correctly read `result.result?.lastText`, but the prematurely
settled Runtime result had no nested `result`, so the response body was empty.
The `lastText` assignment itself was not early or empty.

#### Resolution

All successful substrate terminals now use one completion finalizer. It awaits
extension completion and managed result finalization before emitting the
exactly-once `onComplete` signal, while retaining interrupt, cancellation,
iteration-limit, queued-follow-up, and lost-executor-Promise behavior. Runtime
therefore receives the real `KodaXResult` before its fallback can publish a
payload-free terminal record. Completion observers are post-finalization
notifications: an observer exception emits an unconditional warning diagnostic
but cannot rewrite the
already authoritative result or its persisted Memory/learning outcome.

#### Files Changed

- `packages/coding/src/agent-runtime/run-substrate.ts`
- `packages/coding/src/agent-runtime/catch-terminals.ts`
- `packages/coding/src/agent-runtime/__contract-tests__/cap-005-events-complete.contract.test.ts`
- `packages/coding/src/types.ts`
- `src/sdk-runtime.test.ts`
- `src/a2a/a2a.test.ts`
- `docs/test-guides/ISSUE_302_v0.7.95_REGRESSION_GUIDE.md`

#### Tests Added

- CAP-005 now crosses an event-loop turn inside learned-Skill outcome
  finalization and proves `onComplete` fires only after that work finishes.
- CAP-005 also covers AbortError, ordinary errors, and uninspectable thrown
  values from completion observers; a Runtime public-boundary test preserves
  `result.lastText` after asynchronous coding finalization.
- The inbound/outbound A2A plane test now receives its Runtime answer after an
  event-loop turn and still publishes the non-empty final output.
- Existing interrupt, cancellation, and error suites cover the surrounding
  compatibility boundaries.

See
[`ISSUE_302_v0.7.95_REGRESSION_GUIDE.md`](test-guides/ISSUE_302_v0.7.95_REGRESSION_GUIDE.md).

### 301: Stale invalid learning lock could stall interactive work and TUI teardown lacked a direct terminal restore fallback

- **Priority**: High
- **Status**: Resolved
- **Introduced**: shared learning lock / fullscreen TUI
- **Fixed**: v0.7.95 release
- **Created**: 2026-08-23
- **Resolved**: 2026-08-23

#### Original Problem

A process crash between exclusive lock-file creation and publication of its
owner record can leave a zero-byte learning or Memory review authority lock.
After the 30-second stale threshold, the shared lock helper still treated the
missing owner as permanently unverifiable. Review work using the five-minute
authority timeout could therefore stall or repeatedly defer until the file was
removed outside the application.

The fullscreen TUI paired alternate-screen and mouse-tracking setup only with
the React effect cleanup. If process teardown reached an exit boundary before
that cleanup ran, the parent shell could inherit SGR mouse tracking and display
clicks as escape sequences such as `[<...M`.

#### Root Cause

The stale-owner predicate required a parseable dead owner even for an empty
file that never published ownership. Terminal restoration also relied on a
successful React effect cleanup. A later process-exit callback alone is not a
guarantee because an earlier renderer-exit listener can throw and stop the
listener chain. The enter write's `false` return was also treated as failure,
although Node streams use it to report accepted data plus backpressure; that
path returned without arming cleanup.

#### Resolution

An unchanged zero-byte, malformed, or truncated owner file older than 30 seconds
is now reclaimable. Removal remains fenced by a second stat and byte comparison,
and valid live owners or replacement records are never stolen. The
alternate-screen component registers one idempotent restore guard with both
the renderer and the process-exit fallback before entering fullscreen. The
renderer invokes that shared guard from its guaranteed `unmount()` boundary,
using a synchronous descriptor write where available; an exception first
fences and cancels later renders. Final rendering happens before the restore
on the healthy path, while a render or React-cleanup exception still disables
mouse tracking and leaves the alternate screen before it propagates. Stream
backpressure no longer bypasses guard registration.

See
[`ISSUE_301_v0.7.95_REGRESSION_GUIDE.md`](test-guides/ISSUE_301_v0.7.95_REGRESSION_GUIDE.md).

### 300: Sandboxed git `safe.directory` trust set misaligned with authorized roots

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.93 ASRT 0.0.65 git trust
- **Fixed**: v0.7.94
- **Created**: 2026-08-20
- **Resolved**: 2026-08-21

#### Original Problem

ASRT 0.0.65 already emits `safe.directory` env entries for `[cwd + session
write grants]` (each as an exact path plus a `<dir>/*` glob, collapsing to a
single `safe.directory=*` above eight directories). That leaves three gaps for
Windows sandboxed git:

1. Read-authorized roots outside the write grants (for example `git -C` on a
   differently-owned main worktree the permission review admitted) are never
   trusted, so git refuses with `detected dubious ownership`.
2. Linked-worktree sessions fail before ownership checks: `srt-sandbox` has no
   read ACE on the main repository's `.git` storage, which was previously
   misdiagnosed as the same CVE-2022-24765 interception.
3. Sessions with more than eight write roots (for example a home-directory
   workspace after sibling expansion) run with `safe.directory=*`, widening git
   trust to every repository the sandbox user can read.

Older daemons that predate ASRT 0.0.65 emit no trust entries at all.

#### Root Cause

The trust set is derived inside ASRT from the write-grant stamp only; KodaX's
per-command authorized read roots and linked-worktree gitdir needs never reach
it, and KodaX's own env merge path cannot inject `GIT_CONFIG_COUNT` entries
because the argv reassembly silently drops controlled names.

#### Resolution

KodaX now replaces the wrapper's entire `GIT_CONFIG_*` set at argv reassembly,
removing wildcard trust even when no authorized root survives and rejecting
malformed shapes. The exact eight-root budget prioritizes the cwd and
repo-bearing read grants before ordinary write roots. Broker and host paths use
one implementation, with a production-minified broker execution regression.

Linked worktrees must prove the main `.git` through `commondir` and `gitdir`
backlinks. Submodules must prove the canonical workspace through
`core.worktree`; arbitrary real `.git` targets and ambiguous nested paths do
not receive read ACEs. The workspace gitfile remains write-denied, and the v4
capability exposes `gitSafeDirectory: authorized-repo-roots` for stale-daemon
diagnosis.

See
[`ISSUE_300_v0.7.94_REGRESSION_GUIDE.md`](test-guides/ISSUE_300_v0.7.94_REGRESSION_GUIDE.md).

### 299: Previous-boot foreign Windows ACL markers blocked SDK-owned Runtime exit settlement

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.91 Runtime exit settlement
- **Fixed**: v0.7.93
- **Created**: 2026-08-19
- **Resolved**: 2026-08-19

#### Original Problem

After Windows restarted, a retained Runtime exit ticket could be exact and its
Job containment was no longer live, while the machine-wide sandbox ACL marker
set still contained another KodaX owner's marker from the same previous boot.
The exact-owner recovery API rejected the entire set as foreign, so every Space
relaunch remained blocked even though the new Windows boot was authoritative
proof that none of those recorded process trees could still be active.

#### Root Cause

Runtime exit settlement reused the same exact-owner ACL recovery primitive for
same-boot recovery and post-reboot recovery. The sandbox setup path already had
a machine-lock rule for recovering a set whose every marker had a non-current
boot identity, but settlement had no recovery-only path for that proof.

#### Resolution

The sandbox runtime now exposes an internal recovery-only operation that takes
the machine-global ACL lock, rereads primary and legacy markers, and mutates ACLs
only when every marker has a canonical boot identity different from the current
Windows boot. It invokes no account, WFP, Setup, installer, or elevation path.
`settleKodaXRuntimeExit()` uses this operation only after its durable ticket also
proves a Windows boot change, records the `previous-boot` recovery scope, repair
fact, and recovery boot identity, and only then removes the revalidated marker
set. Native failure or a crash before durable recording retains all evidence
for an idempotent retry. If Windows restarts again before clear, settlement
repeats native recovery and records the new boot before deleting any marker.
Same-boot, mixed, missing, corrupt, or concurrently introduced current-boot
markers remain blocked.

#### Files Changed

- `src/sandbox-runtime.ts`
- `src/sandbox-runtime.test.ts`
- `src/runtime-daemon/exit-settlement.ts`
- `src/runtime-daemon/exit-settlement.test.ts`

#### Tests Added

- Multiple previous-boot owners across primary and legacy marker roots recover
  once under the machine lock without invoking Setup.
- Current-boot and identity-free markers preserve the complete marker set and
  perform no native recovery.
- Native recovery failure preserves marker evidence.
- Marker removal follows the durable recovered ticket; a retry resumes marker
  clearing without losing or repeating the recorded repair fact.
- A changed-boot settlement uses the previous-boot recovery operation, skips
  exact-owner recovery, avoids reused-PID termination, and returns
  `recovered` with `windows_sandbox_acl`.

See
[`ISSUE_299_v0.7.93_REGRESSION_GUIDE.md`](test-guides/ISSUE_299_v0.7.93_REGRESSION_GUIDE.md).

### 298: Provider SDK abort wrapper bypasses managed Stop classification and becomes a credential failure

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.69 managed run-scoped credentials
- **Observed**: KodaX v0.7.92 / KodaX Space v0.1.43
- **Fixed**: v0.7.93
- **Created**: 2026-08-19
- **Resolved**: 2026-08-19

#### Original Problem

In KodaX Space v0.1.43 with KodaX v0.7.92, sending a prompt and pressing Stop
while the first Provider request was in flight could terminate the Run as
`failed` with `Provider run failed while using a run-scoped credential.` The
Runtime Stop record still said `runtime run aborted`; the UI should instead
receive the authoritative interrupted terminal and display
`Runtime run interrupted`.

#### Root Cause

Anthropic and OpenAI expose `APIUserAbortError` classes whose instances inherit
the runtime `name` value `Error`. The base Provider boundary checked only
`error.name === "APIUserAbortError"` or `AbortError`, so it wrapped the abort as
an ordinary `KodaXProviderError`. Runtime could no longer prove the trusted
Stop/Abort conjunction and correctly applied credential-safe redaction to what
now looked like an independent Provider failure.

#### Resolution

The base Provider boundary now lazily loads the Anthropic and OpenAI
`APIUserAbortError` classes independently and uses class identity, but only
when the request's AbortSignal is already aborted. It converts that typed SDK
cancellation into the existing DOM `AbortError` contract before Provider
wrapping. A missing or broken sibling SDK cannot replace the original error or
force an abort classification. Runtime's existing trusted managed-Stop
classification then emits `run.interrupted`; unrelated Provider failures and
unrequested abort-shaped errors remain on their existing paths.

#### Files Changed

- `packages/llm/src/providers/base.ts`
- `packages/llm/src/providers/base.test.ts`
- `packages/llm/src/providers/base-abort-import-isolation.test.ts`
- `CHANGELOG.md`
- `docs/KNOWN_ISSUES.md`
- `docs/test-guides/ISSUE_298_v0.7.93_REGRESSION_GUIDE.md`

#### Tests Added

- Real Anthropic and OpenAI `APIUserAbortError` objects with an aborted request
  signal are normalized to `AbortError` and are not retried.
- A plain same-message `Error` remains a Provider failure even when Stop races
  with that independent error.
- One SDK failing to load does not replace the original error or block the
  other SDK's abort classification.
- The existing managed Runtime credential regression remains green for a
  trusted Stop that already surfaces as `AbortError`.

See
[`ISSUE_298_v0.7.93_REGRESSION_GUIDE.md`](test-guides/ISSUE_298_v0.7.93_REGRESSION_GUIDE.md).

### 297: Durable Windows cleanup failure still consumed the full orderly daemon-exit window before exact recovery

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.91 Runtime exit settlement
- **Fixed**: v0.7.93
- **Created**: 2026-08-19
- **Resolved**: 2026-08-19

#### Original Problem

`settleKodaXRuntimeExit()` could keep its host waiting for approximately the
full 170-second orderly daemon-exit window after the daemon had already written
an exact durable `failed` shutdown outcome. The daemon remained alive because
Windows sandbox cleanup had failed, so process-exit polling could not complete.
Only after the generic orderly wait expired did settlement enter its existing
exact PID/start-identity, Job-containment, and ACL-recovery path.

#### Root Cause

The accepted-exit path waited only for daemon process death. It did not observe
the authoritative shutdown-outcome file during that wait. A durable cleanup
failure is terminal evidence that more graceful waiting cannot turn that daemon
instance into a clean shutdown, but settlement treated it like an ordinary slow
cleanup.

#### Resolution

On Windows, the orderly wait now observes process exit and the exact owner's
durable shutdown outcome concurrently. A pre-existing or newly persisted
`failed` outcome ends the graceful wait immediately and enters the unchanged
recovery boundary. Exact process start identity and Windows Job containment are
still required before tree termination; ACL recovery and ownership cleanup keep
their existing exact-owner and global-lock checks. The normal 170-second budget
is unchanged for slow cleanup without terminal failure evidence, and POSIX
behavior is unchanged. The losing process-exit observation is cancelled so a
fail-closed identity or containment result does not retain a background timer
for the remainder of the orderly window.

#### Files Changed

- `src/runtime-daemon/exit-settlement.ts`
- `src/runtime-daemon/exit-settlement.test.ts`

#### Tests Added

- A pre-existing exact durable failure does not consume the 170-second wait.
- A failure persisted while process-exit polling is pending enters exact
  recovery without waiting for the process timeout.
- A durable failure followed by identity mismatch cancels the losing process
  observation before returning the fail-closed result.
- Existing clean, timeout, PID-reuse, Job, ACL, POSIX, and resume settlement
  suites remain green.

See
[`ISSUE_297_v0.7.93_REGRESSION_GUIDE.md`](test-guides/ISSUE_297_v0.7.93_REGRESSION_GUIDE.md).

### 296: Sparse `uiHistory` projection suppresses canonical conversation after `-r` resume

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.51 UI history replay
- **Fixed**: v0.7.92 development
- **Created**: 2026-08-18
- **Resolved**: 2026-08-18

#### Original Problem

Resuming Session `20260816_202555_lw2ea48cf61259` rendered only four historical
`/quit` entries even though its canonical Session contained 297 messages. The
model context and conversation cache were intact; only the terminal replay was
truncated to the sparse four-item display cache.

#### Root Cause

`restoreHistoryItemsFromSession()` treated every non-empty `uiHistory` as the
authoritative text transcript and used canonical message seeds only to insert
tool groups. This inverted the documented ownership contract: `messages` is
canonical, while `uiHistory` is an optional, bounded, lossy display projection.
Any sparse projection—not only `/quit`—could therefore hide valid user and
assistant history. The reducer's single 150-item cap would also let restored
display-only entries evict a correctly rebuilt canonical window.

#### Resolution

Resume now derives and bounds the canonical TUI seed window first, then overlays
matching persisted timestamps, compact labels, icons, and sanitized tool cards.
Unmatched entries with an explicit display-only role remain as ephemeral
history, positioned relative to the nearest canonical text anchor. Stale
ordinary user, assistant, and thinking text is discarded whenever canonical
messages exist. Canonical and display-only windows are bounded independently in
memory, so `/quit`, info, error, hint, sidecar, and tool-only replay remains
available without reducing the canonical 150-item / 50-round baseline.
Persisted data and Session schemas remain backward-compatible; the display-only
marker is ephemeral. Presentation-only synthetic completion events retain their
existing host boundary: headless/no-cache hosts reconstruct them from messages,
while a non-empty CLI `uiHistory` decides whether they were displayed.

#### Verification

- Sparse `/quit`-only and matching-suffix projections retain the canonical
  question/answer baseline and append UI-only entries.
- Tool groups overlay by tool ID, preserve sanitized persisted results, and
  remain idempotent across repeated resume/save projections.
- A sparse CLI projection does not synthesize large `agent-completed` or legacy
  `task-completed` presentation events that were absent from `uiHistory`.
- The canonical window is trimmed before UI-only replay, and reducer tests prove
  a four-item UI-only tail cannot evict a full 150-item canonical window.
- The reported Session now restores 154 items: 150 bounded canonical entries
  plus its four `/quit` entries, instead of four entries total.

### 295: Complete Runtime exit could strand a same-boot Windows ACL owner and could not resume safely after host relaunch

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.79 managed Runtime shutdown
- **Fixed**: v0.7.91 release
- **Created**: 2026-08-17
- **Resolved**: 2026-08-17

#### Root Cause

The host could request `stopForInline()` and later prove only that the daemon
shutdown outcome failed. Its SDK close path then discarded the live Runtime
projection, while the Windows ACL poison marker, owner fence, and Job
containment protocol remained private to the SDK. A relaunch carried no durable
exact-owner settlement intent and could start owner reconciliation before
repair. The immediate workspace-session timeout trigger was corrected in
v0.7.90, but that did not make an already accepted exit autonomously resumable.
The daemon also advertised a 15-second memory-review drain and a 130-second
workspace reset while its outer final-cleanup deadline was only 10 seconds and
its generic phase cap truncated memory review to two seconds. Legitimate hidden
cleanup could therefore be recorded as failed even when no user task remained.

#### Resolution

v0.7.91 exports one SDK-owned `settleKodaXRuntimeExit()` transaction and local
`runtimeExitSettlement:1` capability. The SDK persists the exact owner before
stop, fences replacement through the existing inline transition, proves
Windows process and Job exit, repairs only exact-owner ACL residue under the
machine-global lock, and resumes idempotently after relaunch. PID reuse,
foreign residue, active work, and corrupt evidence remain fail-closed. POSIX
stuck processes are never signaled from a cached PID/PGID; the ticket remains
blocked until an OS reboot changes the durable boot identity, after which exact
owner/state/policy cleanup resumes autonomously. The original failed shutdown
outcome is retained as audit evidence.
The orderly daemon budget is now 160 seconds, with the memory-review durability
window kept independent of the generic phase cap. The public settlement owns a
fixed 480-second transaction deadline, bounds management/stop/transport phases,
allows 170 seconds for orderly daemon exit, and reserves bounded Windows
process-tree, Job-drain, ACL-recovery, and marker-clear tails. Caller-controlled
short timeouts are not exposed.

#### Verification

See
[`ISSUE_295_v0.7.91_REGRESSION_GUIDE.md`](test-guides/ISSUE_295_v0.7.91_REGRESSION_GUIDE.md).

### 293: Managed compaction context replacement makes ordinary history ambiguous and duplicates paged conversations

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.80 managed-run-context stripping
- **Fixed**: v0.7.89 release
- **Created**: 2026-08-16
- **Resolved**: 2026-08-16

#### Original Problem

Space Session `20260816_110200_432759c1554ee5` displayed the latest user query
twice and repeated earlier assistant output after loading older pages. Reloading
could change the ordering but did not reliably restore a single conversation.
The SDK conversation manifest reported `compaction_boundary_invalid` and
`compaction_predecessor_missing`, so the UI correctly warned that old history
had multiple possible interpretations and preserved every candidate.

#### Root Cause

Managed compaction intentionally removes replaceable
`managed-runtime-context` messages and reinstalls one canonical
`managed-run-context` message. Ordinary-history topology validation treated
those private synthetic envelopes as durable conversation records. Their
expected removal and relocation therefore made a valid retained suffix appear
to conflict with every predecessor branch. The fail-closed ambiguous projection
then returned all physical branch candidates, including the original and active
copies of the same user turn and provenance-linked compacted assistant copies.
An already-written v3 page cache preserved that stale projection across reload
and pagination even after the resolver semantics changed.

#### Resolution

- Treat the two explicitly tagged replaceable managed-context message kinds
  (detected by the `_source` tag alone, matching the compaction stripping
  side) as topology-transparent in the ordinary conversation projection —
  including the lineage-unavailable fallback; raw append-order audit history
  remains unchanged.
- Preserve the physical `firstKeptEntryId` boundary while matching the first
  ordinary retained message, including forked conversation boundaries.
- Increment the conversation page-cache format to v4 so existing ambiguous v3
  projections are rejected and rebuilt from canonical lineage. The incremental
  append fast path passes managed-context envelopes through without projecting
  them (leading, mid-batch, and managed-only batches keep the fast path warm).
- Keep genuine repeated user/assistant content distinct; no text-based dedupe
  or branch guessing was added. Legacy branches that were distinguishable only
  by managed-envelope content may now resolve as ambiguous (fail-closed, no
  data loss) — an accepted trade-off consistent with preserving genuine
  branches.

#### Files Changed

- `packages/repl/src/session/conversation-history.ts`
- `packages/repl/src/session/conversation-history.test.ts`
- `packages/repl/src/session/conversation-page-cache.ts`
- `packages/repl/src/session/conversation-page-cache.test.ts`
- `docs/test-guides/ISSUE_293_v0.7.89_REGRESSION_GUIDE.md`

#### Tests Added

- Managed context replacement inside a retained suffix resolves one proven
  predecessor and folds physical compaction copies.
- A managed-context `firstKeptEntryId` stays transparent through ordinary
  history and conversation-boundary fork projection.
- v3 page caches are invalidated after the ordinary-history projection change.
- Topological transparency keys on the `_source` tag alone, matching the
  compaction stripping side; other synthetic messages stay visible, the
  lineage-unavailable fallback hides managed envelopes, and a
  managed-context-only retained suffix stays fail-closed ambiguous.
- Incremental cache append passes topology-transparent managed context
  through the physical parent chain (leading, mid-batch, and managed-only
  batches keep the fast path warm) while projecting only ordinary messages.
- Passthrough appends stay byte-equivalent to canonical rebuilds (entryChain
  and refresh reuse), managed-only batches persist their watermark without
  data churn, and a managed batch that breaks the parent chain is rejected;
  a managed envelope mid-suffix stays transparent within one epoch.

#### Manual Verification

- The original production Session now resolves with one latest query and one
  audit group for each provenance-linked retained copy pair.

### 292: Actor settlement deadline conflates storage eligibility, canonical commit, and post-commit maintenance

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.85 Actor settlement convergence
- **Fixed**: v0.7.88 development
- **Created**: 2026-08-15
- **Resolved**: 2026-08-15

#### Original Problem

KodaX 0.7.87 Session `20260815_100209_dw8cf41233b429`, Run
`run_mstqdm3u_df966d22`, persisted the exact completion for
`turn_root_analysis_lane_2` only after the Actor settlement watchdog had fenced
the Run as `actor_settlement_not_persisted`. Same-owner reconciliation retained
that completion and interrupted the two remaining siblings, but the Run still
failed even though the child output and canonical terminal fact survived.

The Actor's five-second settlement budget starts after its own mutation queue
becomes ready, but `FileSessionStorage.saveActorSnapshot()` returns one Promise
covering the process-local storage queue, a file lock that may legally wait up
to sixty seconds, read/CAS and lineage work, temp-file write/fsync/rename, and
post-rename cache, append-watermark, topology, lock-release, and location-hint
maintenance. Promise pending or rejection therefore does not identify whether
the canonical Actor snapshot is uncommitted, in-flight, or already committed.
The timed-out write is not cancelled and can still rename later.

#### Context

The daemon log contains seven members of the broader settlement-timeout symptom
family across three Sessions, but only the 2026-08-15 incident occurred after
the v0.7.85 convergence implementation. Existing controller tests use a
monolithic fake store, while the real-storage long-lock test is not connected
to Actor settlement. The exact storage stage of the production incident is not
recoverable because no phase timing was recorded.

#### Root Cause

The Actor/store contract exposes full storage completion instead of canonical
commit. The five-second ambiguity deadline consequently includes legal storage
eligibility waits and post-commit maintenance. The separate thirty-second Actor
queue deadline can also expire behind a predecessor mutation that is legally
waiting for the sixty-second storage lock. Validity is checked only after the
whole save Promise returns, too late to prevent a queued or pre-rename late
write.

#### Resolution

- Added an optional storage-neutral phased Actor save attempt exposing
  process-local dequeue, writer eligibility, canonical result, full completion,
  pre-commit cancellation, and structured phase/timing outcomes.
- Let Actor mutations commit local state after canonical success while keeping
  storage maintenance serialized to full completion.
- Start the five-second canonical watchdog only after storage eligibility;
  check cancellation immediately before rename and reserve fail-close for a
  commit already in flight with no authoritative result.
- Terminal settlement now observes the active predecessor save: local queue and
  legal file-lock waits apply backpressure, a cancellable predecessor drains
  before retry, and a predecessor stuck in canonical replacement triggers the
  same bounded ambiguity fence.
- Rename errors use an exact JSON-persisted-shape Actor-snapshot readback to
  distinguish committed, not committed, and still ambiguous outcomes;
  revision equality alone is not accepted as proof.
- Same-owner reconciliation uses the same dequeue, eligibility, canonical, and
  full-completion boundaries. Legal repair queue/lock waits and post-commit
  maintenance no longer consume the five-second canonical deadline.
- Advertise the corrected daemon contract as `actorSettlementConvergence:2`
  without adding a new Space-visible Run phase.

Regression coverage includes legal long file-lock competition, process-local
queue and predecessor maintenance beyond 65 seconds, predecessor and terminal
rename hangs, pre-commit cancellation with physical drain, rename reject before
and after canonical replacement, same-revision readback, post-commit delay and
failure, CAS/owner conflicts, late writes, exact same-owner repair, and sibling
interruption. File storage records storage queue, lock, read/CAS, lineage,
topology admission/epoch maintenance, temp write, fsync, rename, post-commit,
canonical outcome, and full completion outcome. Topology timing ends before the
nested Session-file write, so it does not duplicate temp-write/fsync/rename.

### 291: Crashed inline Runtime owner leaves daemon startup permanently fenced

- Priority: High
- Status: Resolved
- Introduced: v0.7.69 owner-policy fencing
- Fixed: v0.7.86 release
- Created: 2026-08-11
- Resolved: 2026-08-11

#### Problem and root cause

If an inline owner process exited without closing its handle, `daemon.lock`
remained under sticky inline policy. `enableKodaXDaemonOwner()` rejected every
existing lock without proving whether its owner still existed. In addition,
inline handle `close()` marked itself closed and ignored a failed coordinated
release, turning a transient coordination conflict into an unretryable stale
fence.

#### Resolution

- Daemon enable now checks and removes a provably dead inline fence inside the
  existing owner-policy critical section, then commits daemon policy.
- Owner records carry process-start identity for PID-reuse safety. Older
  `kind: inline` records that lack this identity recover only when their PID is
  definitively absent.
- Daemon-kind, legacy-kind, malformed, active, and unverifiable owners remain
  untouched.
- Inline close becomes retryable and makes release failure visible.

See
[ISSUE_291_v0.7.86_REGRESSION_GUIDE.md](test-guides/ISSUE_291_v0.7.86_REGRESSION_GUIDE.md).

### 290: Mixed-case custom provider aliases lose model autocomplete

- Priority: Medium
- Status: Resolved
- Introduced: custom provider model completion
- Fixed: v0.7.85 release
- Created: 2026-08-10
- Resolved: 2026-08-10

#### Original Problem

A configured custom provider whose alias contains uppercase characters appears
in `/model` provider suggestions, but `/model <provider>/` returns no model
suggestions. For example, the configured `Token_Hub` provider has `glm-5.2` in
its static model list, yet `/model Token_Hub/` produces an empty completion
list. Lowercase custom provider aliases work.

Expected behavior: model completion preserves the configured provider identity
and returns its default and additional configured models regardless of alias
casing.

#### Root Cause

`ArgumentCompleter` lowercases the complete current argument before passing it
to the dynamic `/model` argument source. `getModelArgs()` then extracts the
provider name from that normalized value, while the custom-provider registry
uses exact, case-sensitive `Map` keys. Built-in aliases are lowercase, so the
gap only surfaces for mixed-case custom aliases.

#### Resolution

- `ArgumentCompleter` now passes the raw current argument to dynamic command
  argument sources, preserving exact custom-provider registry keys.
- A separate normalized value keeps generic completion filtering and ranking
  case-insensitive.
- Public-seam regression coverage registers `Token_Hub` with two configured
  models and verifies that `/model Token_Hub/` returns both suggestions.

### 289: Windows workspace sandbox recursively stamped broad home and temp ACLs in the shell timeout

- Priority: High
- Status: Resolved
- Introduced: v0.7.85 Agent Home shell hardening
- Fixed: v0.7.85 release
- Created: 2026-08-10
- Resolved: 2026-08-10

#### Root Cause

Session `20260810_093626_ns0e7e8ba803f1` issued three independent Bash calls
in one model turn. The dispatcher intentionally serialized Bash effects, while
each command spent up to 60 seconds inside Windows ASRT ACL preparation. The UI
therefore displayed the inverse queue staircase: 177.3 seconds, 117.1 seconds,
and 60.5 seconds. The underlying Git and Node commands took only 273 ms, 146 ms,
and 51 ms without sandbox preparation.

The expensive work was ACL propagation, not Git or Node. Besides broad Agent
Home and temp grants, ASRT 0.0.65 added an inheriting `FILE_DELETE_CHILD` deny to
each denied path's parent. A deny for one empty path below the user temp
directory therefore made Windows revisit the parent tree; stamp and restore each
took about 58-62 seconds. Because Bash effects are intentionally serialized,
parallel model calls accumulated that cost into the 60/117/177-second staircase.

#### Resolution

- Runtime attempts a policy-keyed sandbox only after authorization. Equal
  workspace, Agent Home, additional filesystem, toolchain, temp, and network
  policies may share concurrently; incompatible or unavailable containment
  returns to ordinary permission execution before target start. Existing
  external targets are granted directly, while missing targets that would need
  a broader parent grant use the fallback path. Root, escaping-link, Runtime,
  processes, Learned, and sandbox-control mutations remain hard-denied.
- Windows shell `TEMP`, `TMP`, and `TMPDIR` point to a disposable session child
  under the bounded policy temp root. KodaX removes the child after session exit.
- `kodax sandbox setup` now installs idempotent persistent read guards for the
  dedicated `srt-sandbox` SID on existing sensitive roots. This is the only path
  allowed to pay Windows inheritance migration cost. Startup performs a bounded
  read-only audit and fails closed with setup guidance when a guard is missing;
  neither startup nor ordinary commands invoke ASRT stamp/restore on those
  sensitive trees. A parent delete-child deny is added only when the sandbox
  token would otherwise possess that right.
- Workspace `.git/config` and `.git/hooks` receive bounded persistent
  **write-only** guards before the session starts. Those guards omit read and
  synchronize rights, so `git status` can read repository configuration while
  mutation remains OS-denied. Global Git configuration is disabled inside the
  sandbox (`GIT_CONFIG_GLOBAL=NUL`, `GIT_CONFIG_NOSYSTEM=1`) rather than exposing
  the user's sensitive config.
- ASRT receives no duplicate deny for a path already covered by a persistent
  guard. Uncovered caller-specific SDK denies retain the ordinary ASRT path.
  The Agent Home root is never granted; exact reviewed child grants override
  its inherited deny, so safe `~/.kodax` children remain readable/writable while
  root rename/delete and sensitive siblings remain blocked.
- Tests cover eager warm-up, bounded grant count, exact safe Agent Home access,
  root/control-plane denial, broken-link rejection, overlapping deny carve-outs,
  bounded safe-scope reuse with retirement backpressure, exclusive review-only
  cleanup, isolated temp disposal, cancellation, write-only Git guards, and
  fail-closed recovery. On the reported machine, post-migration doctor takes
  about 1.65 seconds, a new workspace session prepares in about 5 seconds,
  same-session preparation takes 4-5 ms, and contained `git status` completes
  in about 0.5 seconds.

### 288: Repo-intelligence warm Worker retained its peak memory after cache construction

- Priority: Medium
- Status: Resolved
- Introduced: v0.7.41 startup prewarm
- Fixed: v0.7.85 release
- Created: 2026-08-10
- Resolved: 2026-08-10

#### Root Cause

Repo-intelligence correctly ran full semantic indexing in an unreferenced Worker,
but `unref()` only allowed the process to exit; it did not terminate the Worker.
On this 2,353-source-file workspace, one cold full warm-up took 13-18 seconds and
raised process RSS by about 1.6 GB. The semantic results were cached, yet the
Worker and its peak TypeScript analysis heap remained resident indefinitely.

#### Resolution

- The Worker now receives a 60-second idle deadline after its pending request
  set becomes empty, aligned with the session result-cache window so the first
  prompt and nearby semantic queries reuse the warm index. A new or still-running
  request cancels retirement, and a detached request is untouched until it settles.
- Session-level routing and preturn result caches remain available after Worker
  retirement; a later cache miss starts a fresh isolated Worker.
- The production probe reclaimed 1,677 MB after the idle boundary, reducing RSS
  from 1,882 MB to 205 MB without changing the full-engine result.
- MCP was checked independently: the two configured servers are lazy, register
  in 0 ms, and remain idle until first use; fail-soft and replacement tests pass.

### 287: Terminal Run recovery replayed complete event histories and blocked CLI startup

- Priority: High
- Status: Resolved
- Introduced: v0.7.79 Runtime lifecycle recovery
- Fixed: v0.7.85 release
- Created: 2026-08-10
- Resolved: 2026-08-10

#### Root Cause

`createKodaXRuntime()` loaded the bounded Run status index, then sent every
persisted terminal Run through durable-terminal recovery. That path synchronously
replayed each Run's complete `events.jsonl`, even though terminal status was
already authoritative and no interrupt input needed reconciliation. The affected
store contained 67 terminal Runs and 208.6 MB of event history, adding 69-86
seconds before the interactive REPL could render its first prompt.

#### Resolution

- Terminal statuses without queued interrupt input are restored directly from
  `status.json`; their event journals are not opened during startup.
- Terminal Runs with queued interrupt input retain the existing replay path so
  durable delivery reconciliation is not weakened. Non-terminal owner and
  recovery rules are unchanged.
- The regression test now seeds a terminal event journal and asserts zero event
  reads during bounded status-index startup.
- Runtime creation on the affected store fell from about 85.9 seconds to 188 ms.
  The linked `kodax` command reaches its prompt again, and the isolated cold-start
  benchmark reports p50 1.54 seconds and p95 2.10 seconds.

### 286: Learned Skill fallback scope was searched in the wrong physical project root

- Priority: High
- Status: Resolved
- Introduced: v0.7.85 development multi-scope repair
- Fixed: v0.7.85 release
- Created: 2026-08-09
- Resolved: 2026-08-09

#### Root Cause

Discovery accepted both remote and local project scopes, but opened only the
primary project store. Project IDs are hashed into their physical learned-area
directory, so `remote:*`, `remote-hash:*`, and `local:*` records live in
different roots. A Skill learned while remote identity was unavailable became
invisible after the remote recovered. The regression test placed both records
in one artificial root and did not reproduce the production layout. The same
patch also replaced the public required `expectedScope` property with required
`expectedScopes`, breaking source and runtime compatibility for standalone
`@kodax-ai/agent` consumers.

#### Resolution

- Coding and Runtime binding now open every applicable physical project store,
  discover across their de-duplicated roots, and retain the owning store for
  admission, invocation, outcome, reconciliation, and release mutations.
- Remote identity remains primary for precedence, while the local path root is
  searched as a fallback for both `remote:*` and `remote-hash:*` identities.
- `expectedScopes` is optional and the deprecated `expectedScope` spelling
  remains accepted; discovery normalizes both without weakening scope checks.
- Regression tests create genuinely distinct hashed roots and verify discovery,
  exact-use attribution, canary admission, outcome, and release in the owning
  fallback store.
- Pending review draining uses the same trusted current-plus-local identity set
  and a shared entry budget, so a job persisted during temporary remote loss is
  claimed with its original local owner identity after the remote recovers.

### 285: Auto mode left agent-home roots and Runtime control paths mutable

- Priority: High
- Status: Resolved
- Introduced: v0.7.74 deterministic read fast paths
- Fixed: v0.7.85 release
- Created: 2026-08-09
- Resolved: 2026-08-09

#### Root Cause

The Rules analyzer protected known credentials under `~/.kodax`, but did not
separately protect the agent-home root, the Runtime control plane, or generic
sensitive names such as `.env`, `.npmrc`, and `id_ed25519`. Recursive reads of
the root could therefore include credential descendants, and Runtime state or
the complete home could be mutated or deleted without approval.

#### Resolution

- Agent-home roots and ancestors plus Runtime mutations are hard-denied.
  Credential/security configuration and generic sensitive filenames require
  review. Recursive grep/glob of an ancestor cannot inherit a child-path
  exemption.
- Ordinary descendants remain writable without approval, including Agent
  definitions, Sessions, tool results, and unknown intermediate directories.
- File tools and shell commands share the same read/write predicates, with
  negative coverage for reads, writes, and recursive deletion plus positive
  coverage for Agent definitions and working-result directories.
- Computed mutation sinks enforce the same boundary at execution time. Undo
  uses context-local, canonical-identity backups; model worktree input cannot
  select a hidden base, while the controller retains its explicit Runtime-owned
  workflow worktree seam.
- Auto[LLM] classifier approval and Auto[Rules] user approval cannot override
  the Agent Home root/Runtime shell hard gate. Sensitive configuration remains
  reviewable rather than becoming an execution-layer hard denial.
- The coding entry applies the narrow catastrophic hard-deny set in every
  permission mode. Other commands are authorized normally, then attempt ASRT
  containment first. A pre-start sandbox infrastructure failure falls back to
  ordinary permission execution; a committed or unknown start is never replayed.
- Windows sandbox ACLs grant verified ordinary Agent Home children rather than
  the Home object, preserving Agent/session/intermediate writes without granting
  the `DELETE` right that would permit whole-root removal. Broken or escaping
  child links are skipped without revoking healthy sibling grants.

### 284: Managed-task compaction no-ops can permanently trip the summary circuit breaker

- Priority: High
- Status: Resolved
- Introduced: v0.7.80 managed-run-context stripping
- Fixed: v0.7.85 release
- Created: 2026-08-07
- Resolved: 2026-08-08

#### Original Problem

SDK session `20260807_212018_k48d034d3a215d`, Run
`run_msj1sot2_01b0e562`, configured an effective 256,000-token compaction
threshold. Three `context.compaction.started` / `ended` pairs were observed
without a `context.compaction.finished` event. The first two attempts became
normal no-ops after managed-run-context messages were removed and the remaining
compactable input fell below the threshold. Both no-ops nevertheless consumed
failure budget. One subsequent Provider error then opened the three-failure
circuit breaker, after which automatic compaction remained disabled while the
input grew beyond 300,000 tokens.

#### Expected Behavior

- A below-threshold or no-eligible-prefix no-op does not count as a failure.
- Outer admission and semantic compaction use the same compactable-token basis,
  or the compactor returns a structured no-op reason.
- Only real summary-generation or persistence failures consume breaker budget.
- The breaker prevents unbounded retries but has a bounded cooldown/reset path
  before physical context exhaustion.
- Runtime events expose no-op, breaker skip, and failure reasons explicitly.
- Regression coverage exercises repeated managed-context-only threshold
  crossings followed by a real compactable threshold crossing, plus consecutive
  real Provider failures.

#### Root Cause

- The managed hook admitted compaction using full request tokens, while the
  semantic compactor re-evaluated the threshold after removing replaceable
  managed-run-context messages.
- Every `compacted: false` result and several non-summary error paths consumed
  the same three-attempt failure budget. Once open, the breaker had no bounded
  retry path before physical context pressure.
- Lifecycle events exposed starts and ends but did not distinguish no-op,
  summary, persistence, or breaker outcomes.

#### Resolution

- Managed admission now uses the same compactable-token basis as semantic
  compaction, while full request tokens remain authoritative for physical
  capacity enforcement.
- Below-threshold and no-prefix outcomes are explicit no-ops. Only summary
  generation and persistence rejection increment the failure breaker.
- The breaker waits two eligible boundaries before a half-open retry, rearms
  earlier after meaningful compactable growth, resets only after a committed
  rewrite, and remains bypassable by hard physical pressure.
- Successful anti-thrash remains separate from Provider/persistence failures.
- Runtime `skipped` and backward-compatible `ended` events now carry typed
  reason, token-basis, failure-count, breaker-state, and cooldown fields.
- Success projections and `context.compaction.finished` are emitted only after
  persistence acknowledgement; daemon forwarding preserves the structured
  outcome and does not project `committed: false` as legacy success.

#### Files Changed

- `packages/coding/src/task-engine/_internal/managed-task/compaction.ts`
- `packages/coding/src/agent-runtime/middleware/compaction-pressure.ts`
- `packages/coding/src/types.ts`
- `src/sdk-runtime.ts`, `src/runtime-event.ts`, and `src/kodax_cli.ts`
- Focused managed-hook, event-parser, SDK Runtime, child-event, and daemon bridge
  regression tests.

#### Test Coverage

- Repeated full-context threshold crossings caused only by managed context do
  not call the summary Provider or consume failure budget; later compactable
  growth commits normally.
- No-prefix, canonical-context capture, persistence, hard-pressure,
  cooldown, growth-rearm, half-open failure, and successful reset paths retain
  their distinct semantics.
- Structured skip/failure outcomes survive child, embedded Runtime, persisted
  event replay, parser validation, and daemon-client forwarding.

### 283: REPL hides the canonical sidecar item and appends duplicated verifier evidence after Worker retry

- Priority: Medium
- Status: Resolved
- Introduced: v0.7.43 first-class sidecar messages
- Fixed: v0.7.84 development
- Created: 2026-08-07
- Resolved: 2026-08-07

#### Original Problem

When Sidecar Verifier returned an actionable `revise` or `blocked` verdict, the
REPL inserted the first-class `sidecar` history item at the correct temporal
position between the first Worker attempt and its retry. The normal prompt
surface did not render that item. After the managed run completed, the same
evaluator evidence was converted to a generic `event` and appended at the end,
making one logical verdict appear late and making persisted history depend on
the duplicate projection.

#### Root Cause

- `buildPromptSurfaceItems()` omitted `sidecar` from its supported history-item
  cases, although the transcript surface and Session serializer already
  supported the type.
- Final managed-task evidence projection had no knowledge that
  `onSidecarMessage` had already delivered the actionable evaluator verdict, so
  it emitted a second `[Sidecar Verifier]` event during round finalization.

#### Resolution

- The prompt surface now renders first-class `sidecar` items in ledger order.
- Each queueable agent sequence tracks whether the current managed round
  delivered a first-class sidecar message. Final transcript projection filters
  actionable evaluator evidence only when that delivery occurred, retaining
  the previous evidence fallback when delivery did not occur.
- Accept evidence remains hidden by default and remains available under
  `KODAX_VERIFIER_LOG=1`; it is not treated as duplicated because accept does
  not produce a first-class sidecar message.
- The canonical sidecar item remains in the foreground ledger and is persisted
  once at its original position, so Session restore preserves the ordering
  `Worker attempt 1 -> sidecar -> Worker attempt 2`.

#### Files Changed

- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/InkREPL-transcript-builders.ts`
- `packages/repl/src/ui/utils/transcript-surface.ts`
- Focused prompt-surface, managed-transcript, and Session-restore regression
  tests.

#### Test Coverage

- The prompt surface includes a sidecar item without changing its position.
- Delivered actionable sidecar evidence is not re-emitted as a final generic
  event, while the no-delivery fallback and verifier-log accept behavior remain
  covered.
- Persisted sidecar history restores in exact Worker/sidecar/Worker order.
- The complete REPL TypeScript build and all 2,475 REPL tests pass (one
  unrelated test remains skipped by its existing suite definition).

### 282: Agent progress persistence backlog can self-fence its live owner and make an unknown Run reject Stop

- Priority: High
- Status: Release blocked
- Introduced: v0.7.79 bounded Actor settlement
- Fixed target: v0.7.85
- Created: 2026-08-06

#### Problem

In Space Session `20260806_200641_l181e74214d29d`, two analysis Agents
visibly finished, but their durable turns remained `running`. The first terminal
save reported `actor_settlement_retrying`, crossed the fixed five-second
settlement deadline, and changed the owning Run to `phase: unknown`. The root
worker later rendered a final-looking answer but remained in
`idleWaitingPendingCount: 2`; the spinner continued, both Stop requests returned
`accepted: false`, and follow-up input returned `stale_run`.

The draft was restored by Space and the streamed answer remained recoverable
from the Runtime event journal, but neither was a substitute for a canonical
terminal Run. Restarting or force-idling the UI would have hidden the unresolved
Actor facts and risked overlapping Session work.

#### Root Cause

Four contracts formed one failure chain:

1. Native and external Agent progress called `reportProgress()` fire-and-forget.
   Every update queued a full durable Actor snapshot mutation, while executor
   completion did not wait for those projections to drain.
2. Executor settlement started its five-second deadline before its mutation
   reached the head of that queue. A slow or backlogged Session writer could
   therefore make an already-finished Agent miss the deadline. A save that
   completed after the caller timed out had already changed durable state, but
   the controller rolled its local view back.
3. `fenceUnknownSettlement()` represented that indeterminate save by setting
   `ownershipLost`, the same flag used for a real foreign-owner CAS conflict.
   Later cancellation therefore failed with the misleading message that the
   tree was owned by the same live Runtime.
4. Runtime persistence rejected Stop whenever phase was already `unknown`.
   Because abort signals and cooperative Actor quiescence were delivered only
   after an accepted Stop, the request became a no-op. Space correctly kept
   `unknown` visible as nonterminal, while interrupt-input admission correctly
   rejected it as stale; without a working Stop recovery path, those two safe
   decisions made the Session permanently unusable.

#### Resolution

- Native and external Agent progress now use one in-flight durable projection
  plus one coalesced latest update. The terminal boundary seals new progress
  observations and does not wait for the projector to flush. Terminal
  persistence therefore follows only constant-size projection work; if the
  already-in-flight write itself hangs, the controller's five-second deadline
  exposes `unknown` instead of leaving the adapter waiting forever.
- Settlement-timeout fencing is distinguished from an actual owner conflict.
  An explicit quiesce waits for the timed-out mutation to finish, reloads the
  latest durable snapshot, validates the schema and exact owner ID, restores
  only newly committed events/messages, and then persists cancellation. A
  different owner remains fenced; a missing, hung, or unwritable store remains
  `unknown`.
- `runs.abort()` may record and deliver the first Stop for a live Run owned by
  the calling Runtime even when that Run is already `unknown`. The receipt stays
  truthfully `state/outcome: unknown` until Actor and executor settlement prove
  a terminal result. A repeated Stop remains `accepted: false`, but may
  idempotently redeliver abort/quiesce effects when both the live record and
  durable status prove the exact local owner and the Stop is still unknown;
  foreign, ownerless, confirmed, and terminal Runs remain no-ops.
- Confirmed terminal settlement clears the temporary Actor lifecycle error.
  If the executor had already returned while Actor durability was unknown, its
  credential-safe Promise result or failure fact is applied only after the
  same-owner Stop repairs the Actor snapshot. Promise facts remain authoritative
  over fallback terminal callbacks, including when the callback returned
  `unknown` before the Promise settled. The Run then releases the Session route
  normally without inventing a terminal fact.
- A local terminal fact is not regressed by a stale durable unknown Stop when a
  best-effort terminal status write failed; repeated Stop neither rewinds the
  in-process Run nor duplicates cancellation effects or terminal events.
- A quiesce with no eligible turn is now a true no-op instead of rewriting the
  Session snapshot, removing an unnecessary Stop/diagnostic lock race.

#### Files Changed

- `packages/agent/src/actors/controller.ts`
- `packages/coding/src/agent-runtime/actor-runtime.ts`
- `src/sdk-runtime.ts`
- Focused Actor, coding-adapter, and Runtime regression tests.

#### Test Coverage

- Twenty rapid progress updates are coalesced to constant-size durable work. A
  permanently delayed in-flight projection no longer blocks the adapter:
  terminal settlement reaches its deadline, publishes `unknown`, and an
  explicit same-owner quiesce restores healthy zero-active-turn state after
  storage recovers.
- A late same-owner terminal save is reconciled before Stop; a still-active
  sibling is durably interrupted and the Actor tree becomes healthy with zero
  active non-root turns.
- A live same-owner `unknown` Run accepts Stop, converges to confirmed
  `interrupted`, and admits a successful follow-up Run in the same Session.
- A Run whose executor already returned success as `unknown` is repaired to its
  saved `completed` fact after Stop, then admits a follow-up Run. Promise
  success/failure wins over conflicting callback failure/completion, and
  ordinary or pre-Stop `AbortError` rejection keeps its captured failure class;
  no-result unknowns remain fenced until exact same-owner repair.
- A first repair timeout can be retried with repeated Stop after storage
  recovers, while an already-terminal local Run cannot be rewound by a stale
  durable unknown status.
- A no-op quiesce performs no durable save, and immediate read-only diagnostics
  after Stop remain stable.
- Existing permanent-storage-failure, late-save stickiness, owner-conflict,
  Stop/completion race, and no-fabricated-terminal controls remain covered.

#### 2026-08-09 recurrence and development fix

The v0.7.84 release mitigated the original unbounded per-executor progress
backlog and made an explicit same-owner Stop capable of repair, but it did not
fully close the incident class. Each concurrent executor still owned its own
projector; the five-second terminal deadline still included time spent behind
known predecessor mutations; and an Actor self-fence aborted child turns but
left the root provider running. That combination reproduced in Space as a
long-lived `Run state not persisted` banner, rejected input, lost live history
after manual Stop, and misleading `actor_owner_conflict` spawn failures.

The v0.7.85 development fix moves batching to the controller tree, separates a
bounded queue-wait fence from terminal-save time by pausing the five-second
ambiguity budget during known predecessor waits, and makes the Runtime
fail-close the root executor at the first durability-unknown fact. Progress
waiters reject when an ownership conflict fences their controller. Runtime
automatically quiesces and reconciles only the exact same owner. A Promise
success or failure captured before that fence remains authoritative; otherwise
same-owner repair plus root abort blocks new effect admission. Runtime releases
the Session route only after every exact tool execution admitted before the
fence has settled, but it does not wait for the old root executor Promise. An
abort-ignoring provider remains pending only as an isolated Promise; its
callbacks and new Runtime-mediated effects stay suppressed while the queued
successor drains. A UI tool-start event or a pending permission gate is not an
active effect lease.
Healthy after-turn input keeps coding mode and inherits a predecessor's
mode only when it actually drains behind repair. Provider output, callbacks, or
results arriving after the fence cannot overwrite the infrastructure failure.
Same-runtime self-fence admissions now return
`actor_settlement_not_persisted`; only a real foreign owner returns
`actor_owner_conflict`. The new `actorSettlementConvergence:1` capability lets
hosts require these semantics rather than trusting a package version alone.

The issue remains release-blocked until these exact bytes are published and a
packaged Windows fault-injection run passes with a real large
`FileSessionStorage` Session. The shared Session writer remains a known
performance-coupling seam; permanent or foreign-owner persistence uncertainty
continues to stay `unknown` rather than being presented as repaired.

### 281: Runtime input submission reads mutable canonical Session before resolving its authoritative Run target

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.69 Runtime input submission
- **Fixed**: v0.7.82 release
- **Created**: 2026-08-05
- **Resolved**: 2026-08-05

#### Original Problem

`runtime.runs.submitInput()` reads the canonical Session before resolving and
validating the authoritative `afterRunId`. Normal interrupt and after-turn
submission can therefore race with persistence from that Run and incorrectly
fail with `data_changed`.

Submission should first resolve the target Run, validate its `sessionId`, and
authorize from the identity already admitted for that Run without reading its
mutable transcript or history. Any history needed by an after-turn Run should
be loaded only after the predecessor has fully ended. Existing Partner and
unknown-surface rejection, stale-Run responses, and `operationId` idempotency
must remain intact so one logical input cannot be queued twice.

#### Context

The daemon currently performs a Session-reading `runs.get()` preflight before
calling the SDK submission path, while the SDK path independently calls
`loadRequired()` before looking up `afterRunId`. Both reads precede the
authoritative Run checks and can observe a transient canonical revision.

#### Root Cause

- SDK submission called `loadRequired()` before resolving `afterRunId`, and an
  after-turn submission then called `loadExecutable()` again while its
  predecessor was still writing the Session.
- The daemon's authoritative-Run preflight used `runs.get()`, whose admission
  check also reread the canonical Session for a locally owned active Run.
- The daemon active-phase helper omitted `waiting_agent` and `recovering`, so
  those nonterminal Runs could be mistaken for stale continuations.

#### Resolution

- Each locally admitted Run now retains a private, immutable Session context
  containing only execution metadata and cached surface/profile identity, not
  transcript or history.
- Submission resolves and validates `afterRunId` and `sessionId` first, then
  authorizes from that Run's cached admission. After-turn preparation reuses
  the same context and preserves the existing second stale check immediately
  before queue insertion.
- Local nonterminal `runs.get()`/`runs.await()` use cached admission, allowing
  the daemon preflight and retained result registration to remain side-effect
  free. Foreign, persisted, and terminal `runs.get()`/`runs.await()` access
  keeps canonical admission.
- The executor still launches only through the existing per-Session queue after
  predecessor settlement, so its history load observes the completed turn.
- Daemon preflight now recognizes every SDK active phase while retaining queued
  interrupt, closed-window, cross-Session, and terminal stale behavior.

#### Files Changed

- `src/sdk-runtime.ts`
- `src/sdk-runtime.test.ts`
- `src/runtime-daemon/server.ts`
- `src/runtime-daemon/server.test.ts`

#### Test Plan

- An adversarial `data_changed` storage hook proves `runs.get`, `runs.await`,
  interrupt, and after-turn admission perform no canonical Session read while
  their authoritative predecessor is active.
- The continuation stays queued and its executor does not launch until the
  predecessor settles; queue-time Session settings remain snapshotted.
- Partner and unknown surfaces remain outside shared Runtime Run admission.
- Daemon `waiting_agent`/`recovering` phases remain eligible, while exact
  `operationId` retries perform one preflight and one submission only.

### 280: Daemon managed Run Stop does not fence cooperative work or preserve Abort causality through credential redaction

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.69 daemon managed Runs
- **Fixed**: v0.7.82 release
- **Created**: 2026-08-05
- **Resolved**: 2026-08-05

#### Original Problem

After `runtime.runs.abort(runId)`, a managed Provider can observe the Run's
`AbortSignal` and throw `AbortError`, while the managed executor still enters
recovery or starts SDK-controlled LLM, tool, and Actor work. Active Actor
descendants can therefore keep the Run at `phase=unknown` with
`stop_outcome_unconfirmed`. When settlement eventually reaches the Runtime,
run-scoped credential redaction replaces the trusted Abort cause with a generic
Provider credential error and terminalizes the Run as ordinary `failed`.

Expected behavior is to fence new managed work once cooperative cancellation is
observed, cancel and converge SDK-controllable Actor descendants caused by the
Run, and classify the final status, terminal event, and await/get results as
`cancelled` or `interrupted`. Initial Stop acknowledgement may remain unknown,
real completion races may remain completed, and independent failures must remain
failed.

#### Context

The defect spans the daemon-owned Runtime Run service, the managed Provider
resilience loop, Runtime tool admission, Actor finalization, and the
credential-safe error terminalization path. The fix must not add API fields,
identity fields, status enums, or hard-kill guarantees for external code that
ignores `AbortSignal`.

#### Proposed Solution

- Add cancellation gates before managed Provider recovery/retry and Runtime
  tool admission.
- Cooperatively interrupt only active Actor turns admitted after this Run began,
  then await their existing durable settlement path.
- Classify only the trusted conjunction of recorded Stop, aborted Run signal,
  and raw `AbortError` before credential normalization; keep unrelated errors on
  the existing failed path.
- Add regressions for credential-safe Abort terminalization, descendant
  convergence, late completion, and independent failure races.

#### Root Cause

- The managed Provider resilience loop treated an observed caller abort like an
  ordinary Provider failure, so recovery, fallback, continuation, or later tool
  admission could start after the Run signal was already aborted.
- Runtime finalization waited on the whole Session Actor tree but did not issue
  a cooperative interruption scoped to turns admitted by the managed Run.
- Run-scoped credential normalization ran before terminal-cause classification,
  replacing the raw `AbortError` needed to prove the recorded Stop relationship.

#### Resolution

- Added AbortSignal gates around managed Provider retry/fallback/continuation,
  Runner guardrails and tools, and Coding permission/dispatch boundaries.
- Captured the active Actor-turn baseline when the managed Run starts, then
  atomically quiesced only later SDK-controlled turns on Stop and awaited their
  existing durable settlement path. Pre-existing Session Actors remain active.
- Classified only `managed_task + recorded Stop + aborted Run signal + raw
  AbortError` as a trusted interrupted terminal before credential redaction.
  Unrequested AbortErrors and independent failures retain the failed path, while
  latched completion remains authoritative.
- Cleared the temporary `stop_outcome_unconfirmed` placeholder on confirmed
  terminal settlement so `RunHandle`, terminal event, `runs.get`, and
  `runs.await` expose the same outcome.

#### Files Changed

- `packages/agent/src/actors/controller.ts`
- `packages/agent/src/primitives/runner.ts`
- `packages/agent/src/primitives/runner-tool-loop.ts`
- `packages/coding/src/agent-runtime/actor-runtime.ts`
- `packages/coding/src/agent-runtime/tool-dispatch.ts`
- `packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts`
- `packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts`
- `src/sdk-runtime.ts`
- Adjacent unit, contract, managed-runner, and Runtime regression tests.

#### Test Coverage

- Provider AbortError does not enter recovery/fallback or start a continuation.
- Abort during async guardrail/permission work prevents concrete tool execution.
- A durably pending Actor admission is interrupted before its executor starts.
- If that cancellation cannot be persisted, Actor health becomes explicit
  `unknown` instead of exposing a false healthy-running state.
- Stop interrupts Run-admitted Actor descendants without touching pre-existing
  Session Actors.
- Trusted Stop/Abort terminalization is credential-safe and consistent across
  events and all Run read APIs; independent failure, unrequested AbortError, and
  completion-race controls remain unchanged.

### 279: Daemon Host Tool merge drops MCP capability snapshots and leaks host tools into server-filtered search

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.70 progressive MCP discovery
- **Fixed**: v0.7.82 release
- **Created**: 2026-08-05
- **Resolved**: 2026-08-05

#### Original Problem

A KodaX Space Worker Run bound to a Host Tool lease returned a different
`mcp_search({ server: "db-query-server" })` inventory from the KodaX CLI. Four
`host:hostlease_*` capabilities appeared despite the explicit server filter,
only 10 of 14 database tools remained, and the catalog was reported as
`freshness=unknown` and `complete=false`. Direct `mcp_describe` and `mcp_call`
by canonical ID still worked, so the defect was limited to capability
discovery and could be bypassed only when the model already knew the missing
IDs.

#### Context

Space registers an ordinary active MCP runtime and binds a run-scoped Host
Tool lease to Worker Runs. The daemon combines those two runtime contracts for
the bound Run; CLI Runs do not inherit the Space lease and therefore never
exercise this merge. The Host Tool merge existed in v0.7.69, where legacy
searches could already cross server boundaries. Snapshot-based progressive
discovery in v0.7.70 then formed the full reported failure mode.

#### Root Cause

- `mergeExtensionRuntimeContracts()` forwarded legacy `searchCapabilities()`
  but omitted the optional `searchCapabilitySnapshot()` contract added by the
  progressive MCP discovery implementation.
- `mcp_search` therefore used its legacy fallback. The merged legacy search
  concatenated Host Tool results with the MCP provider's default 10-result
  page, producing four host entries plus ten database entries.
- The Host Tool reverse runtime ignored `options.server`, so an explicit
  `db-query-server` filter did not remove its `server: "host"` entries.
- The fallback truthfully but unhelpfully hard-coded the degraded snapshot as
  incomplete with unknown freshness.

#### Resolution

- The Host Tool reverse runtime now publishes an immutable, live, complete
  snapshot whose revision is scoped to the lease, and returns no results for
  an explicit server other than `host`.
- The daemon merge selects only the requested source for an explicit server;
  without a server it composes Host Tool and active-runtime snapshots with
  deduplicated items, combined revision/freshness/completeness, and failures.
  A runtime with no MCP provider no longer prevents Host-only discovery.
- A legacy runtime without snapshot support is queried without the ordinary
  ten-item page cap, then reported honestly as incomplete with unknown freshness.
- Regression tests prove the pre-fix failures (missing snapshot and ignored
  server filter), preserve all 14 MCP entries, keep run-scoped Host Tools
  discoverable through `mcp_search`, and retain bound Host Tool execution.

#### Files Changed

- `src/runtime-daemon/server.ts`
- `src/runtime-daemon/reverse-bridge.ts`
- `src/runtime-daemon/server.test.ts`
- `src/runtime-daemon/reverse-bridge.test.ts`
- `packages/coding/src/extensions/runtime.ts`
- `packages/coding/src/extensions/runtime.test.ts`

#### Tests Added

- Model-facing `mcp_search` returns 14/14 database tools for the database
  server, one Host Tool for `server: "host"`, and all 15 for an unfiltered
  search, all with truthful live/complete metadata.
- A Host Tool remains discoverable and executable when the active runtime has
  no MCP provider; explicit non-host filtering returns no Host Tool.
- A legacy MCP provider without snapshot support still contributes all 14
  fixture tools while retaining degraded metadata.

### 278: Managed Runtime publishes completed turns without a durable canonical Session boundary

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.79 Runtime Session persistence
- **Fixed**: v0.7.80 release
- **Created**: 2026-08-04
- **Resolved**: 2026-08-04

#### Original Problem

Session `20260804_190529_pkd099b5340c90` ran for about 47 minutes under managed
Runtime Run `run_msek090v_83fd011b`. Its 7.79 MB event journal contains 6,291
valid events: the first turn published `turn.completed`, a queued input was
delivered into a second turn, and daemon restart eventually terminalized the
Run as `daemon_crashed`. After restart, however, the canonical Session remained
a valid empty v2 lineage with `activeMessageCount=0`, `lineageEntryCount=0`, and
a resolved zero-entry conversation cache. All public SDK transcript/history
reads therefore correctly returned zero records; the body was never committed.

#### Context

Runtime declares `persistedByHost: false`, making the Coding Runner the
canonical Session owner. Managed AMA can publish a completed turn and deliver a
subsequent queued prompt while retaining all conversation state in process
memory until the overall Run ends. A hard daemon exit cannot enter the normal
or error snapshot path. The Run event log preserves many second-order events
but omits the complete initial prompt, so the affected Session cannot be
silently reconstructed as a complete conversation.

#### Root Cause

- Managed multi-turn execution rotates `turn.completed` / `turn.started`
  boundaries without first committing the completed transcript to canonical
  Session storage.
- Accepted and delivered input durability is represented in the Run journal,
  but the canonical lineage has no corresponding atomic boundary.
- Crash terminal reconciliation can therefore describe a completed/delivered
  Run history that contradicts the persisted Session transcript.

#### Proposed Solution

- Persist the initial accepted prompt before execution can publish model/tool
  events, and persist each completed turn before publishing `turn.completed` or
  delivering the next queued prompt.
- Preserve the existing normal final snapshot while making intermediate writes
  serialized, monotonic, and fail-loud; a persistence failure must stop the
  boundary transition instead of publishing a false durable completion.
- Add SDK/Runtime regressions for crash after initial prompt, crash during a
  queued turn after a completed predecessor, normal multi-turn completion, and
  persistence failure.
- Any recovery utility may expose only event-log facts that are provable and
  must label the missing initial prompt/body rather than synthesizing a
  seemingly complete canonical history.

#### Resolution

- Managed Runner execution now saves the initial accepted prompt before its
  live Turn starts or Provider execution begins.
- Both mid-turn queue drainage and idle-yield resume save the completed
  transcript before `turn.completed`, then save the queued user message before
  `run.input.delivered` and before the next Provider call.
- Runtime-owned Sessions (`persistedByHost: false`) use a required snapshot
  path: missing/unwritable canonical storage fails the boundary and prevents a
  false completion. Ordinary SDK/error-cleanup snapshots remain best-effort.
- Runtime/Runner regressions cover initial-turn crash, queued-turn crash,
  normal multi-turn completion, persistence failure, lifecycle ordering, and
  recovery of a valid JSONL prefix with a file-identifying diagnostic.
- No recovery data was written into the affected production Session: its
  Runtime journal cannot prove the missing initial prompt, so automatically
  presenting a reconstructed full transcript would be lossy and misleading.

### 277: Synchronous tokenization precedes tool-output byte/line spill

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.74 tool attention admission
- **Fixed**: v0.7.80 release
- **Created**: 2026-08-04
- **Resolved**: 2026-08-04

#### Original Problem

Session `20260804_183141_cv5f6b9421209c` returned a Bash result containing the
conversation-cache `identityFilter`, including about 174,763 consecutive
Base64-like ASCII bytes. Tool-result admission synchronously ran the raw output
through `js-tiktoken` before the existing byte/line policy could spill it. The
daemon event loop stopped responding, the Runtime read timed out after 15
seconds, and the client remained busy until restart.

#### Context

Affected paths include the Agent token estimator, Coding tool-result admission,
and Bash capture. The fix must spill by byte/line policy before token estimation
and keep estimation linear and allocation-light.

#### Root Cause

- `packages/agent/src/tokenizer.ts` synchronously loads `cl100k_base` and calls
  `encode(text).length` on the main runtime thread.
- `packages/coding/src/tools/tool-result-policy.ts` token-counts raw batch
  entries before applying tool-specific byte/line caps.
- Bash's early spill proof uses `capacityTokens * 128`, allowing ordinary
  policy-breaking output to reach materialization and token admission.

#### Proposed Solution

- Enforce existing tool byte/line policies first, persist complete output, and
  estimate only the bounded preview.
- Replace main-path BPE tokenization with a UTF-8/UTF-16 multilingual estimate
  plus a bounded dense-encoded-data detector.
- Use Provider usage as the context baseline and fast estimates for subsequent
  message deltas, retaining context reserve, compaction, and overflow recovery.

#### Resolution

- Tool-result admission now enforces each existing byte/line policy before any
  token estimate, spilling the complete raw value and estimating only its
  bounded preview. Batch admission performs the same physical pre-pass.
- Bash capture starts recoverable spooling at the existing 32 KiB/600-line
  policy and removed the `capacityTokens * 128` BPE-derived threshold.
- The main-thread `js-tiktoken` dependency and `cl100k_base` vocabulary were
  removed. Token accounting now uses the O(n), O(1)-space UTF-8/UTF-16 estimate
  plus the 512-unit dense encoded-data detector; safety margin remains in the
  context reserve layer.
- Regressions cover the 174,763-byte continuous-`A` reproduction, random
  Base64/Hex, multilingual text, JSON/code, Emoji, long single-line/multiline
  results, artifact readability, estimator ordering, and event-loop latency.

### 276: Release preparation reused a stale F274 experiment, narrowed sibling provenance to control scope, and silently dropped a daemon host binding

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.80 release preparation
- **Fixed**: v0.7.80 release
- **Created**: 2026-08-04
- **Resolved**: 2026-08-04

#### Original Problem

Release preparation made an obsolete F274 six-pattern benchmark compare the
current parallel-first prompt while retaining the old experiment revision,
baseline commit, cases, scorer, and fake-provider marker. The unit test could
therefore treat both arms as baseline and still pass. A companion Actor change
used lifecycle/output control to validate exact evidence references even though
F270/F274 distinguish same-parent visibility from control, causing visible peer
provenance or optional `quality_strategy` metadata to block or degrade otherwise
legal collaboration. The daemon bridge also removed a custom
`learningReviewer` callback without the loud rejection applied to other host
bindings, and performed daemon option validation only after Session writes.

#### Root Cause

- A historical eval runner dynamically rebuilt frozen arms from the current
  production prompt instead of preserving registered bytes.
- An outdated direct-sibling test mislabeled control scope as visibility scope.
- Host-only daemon bindings were maintained in separate stripping and
  validation lists, and validation occurred too late in the run bridge.

#### Proposed Solution

- Restore the historical F274 experiment as a byte-frozen archival fixture and
  add explicit arm sentinels so a stale fake provider cannot pass.
- Validate exact Actor Turn references through caller visibility and terminal
  membership; discard invalid optional provenance without blocking admission.
- Reject every daemon host callback before creating or mutating a Session.

#### Context

Affected components: F274 benchmark release gates, Actor collaboration
provenance, `spawn_agent`/`followup_task`, and the interactive daemon bridge.

#### Resolution

- Restored F274 as a byte-frozen archival experiment: both prompt arms, four
  policy-tool payloads, verifier system/tool payloads, and all Layer 3
  LLM-facing inputs now have registered hashes and fail closed on drift. The
  fake-provider test also proves both historical arms are exercised.
- Restored exact Actor Turn evidence validation to visibility semantics, while
  preserving lifecycle/output control separately. Same-parent peer evidence is
  accepted; hidden, unknown, or stale optional provenance is dropped without
  blocking legal spawn or follow-up operations.
- Added `learningReviewer` to daemon host-binding rejection and moved daemon
  wire validation before every Session load, creation, or settings update.

#### Files Changed

- `benchmark/datasets/feature-274/runner.ts` and frozen fixtures
- `packages/coding/src/orchestration/pattern-strategy.ts`
- `src/kodax_cli.ts`
- Focused tests for all three boundaries

#### Tests Added

- Historical F274 prompt/tool/verifier hashes, arm sentinels, and scorer
  cross-platform normalization.
- Same-parent terminal evidence, hidden private descendants, and stale
  follow-up provenance.
- Loud daemon `learningReviewer` rejection before persistent Session writes.

#### Resolution Date

2026-08-04

---

### 275: Auto permission analysis treated ordinary search scopes and tool metadata as unresolved and retried truncated classifiers unchanged

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.79 development
- **Fixed**: v0.7.80 release
- **Created**: 2026-08-04
- **Resolved**: 2026-08-04

#### Original Problem

Auto[Rules] converted ordinary grep/glob selectors and directory-wide searches
into unresolved pseudo-paths, while ordinary Git content and metadata reads
were routed through helper-related uncertainty. Tools without a dedicated path
analyzer ignored their trusted side-effect metadata. Auto[LLM] therefore sent
many harmless reads to the classifier; if the classifier then returned a
truncated response, both attempts used the same 256-token output limit and the
failure could become a user confirmation. Session
`20260804_114722_2w61e690e24c48` exposed the repeated `max_tokens` path.

#### Root Cause

- Search selectors were conflated with concrete filesystem targets.
- Implicit directory and Git read scopes were represented as unresolved even
  though non-sensitive reads are allowed by policy.
- The guardrail did not consume registry `sideEffect` metadata when a tool had
  no dedicated analyzer.
- The canonical analyzer and shell/path helpers lived in `@kodax-ai/repl`, so
  direct `@kodax-ai/coding` SDK guardrails silently lacked the deterministic
  fast path unless each embedder supplied the same wiring.
- Classifier retries did not adapt their output budget after truncation.

#### Resolution

- Model ordinary grep/glob/directory and Git metadata/content operations as
  complete reads while retaining protected credential selectors, dynamic
  bindings, device namespaces, and explicit executable Git options as review
  boundaries. Match credential-specific wildcard selectors with the same glob
  semantics used by tools, without treating broad selectors such as `*.json`
  as explicit credential targets.
- Pass trusted tool side effects into the SDK guardrail and Runtime evaluator;
  admit declared read-only/network-read and contained Agent-state tools without
  inventing an unknown effect. Reclassify the GET-only `web_fetch` tool as a
  network read. Path-bearing custom read-only tools still use path analysis, or
  the classifier when a host has not supplied one.
- Keep the first classifier attempt at 256 output tokens, but raise the single
  retry to 1024 only when the first response ended with `max_tokens`.
- Move the canonical analyzer, shell AST, PowerShell mutation binding, and
  permission helpers into `@kodax-ai/coding`; the guardrail now installs that
  analyzer and Rules evaluator by default, while REPL modules remain thin
  compatibility exports. An omitted or blank project root uses the SDK's
  explicit `executionCwd`; without either boundary, path-bearing calls stay
  unresolved instead of borrowing the embedder process cwd.
- Recognize OpenAI-compatible `length` as truncation. Use 45 seconds for the
  first default classifier attempt and 90 seconds for its retry, while keeping
  an explicitly configured timeout unchanged across both attempts.

#### Tests Added

- Structured `grep` on `src/sdk-runtime.ts`, ordinary glob and shell search,
  Git reads, network reads, and internal Agent tools avoid classifier/user
  confirmation paths.
- Credential-matching wildcard selectors, including wildcarded protected
  directory names, custom read-only tool paths, and Windows device namespaces
  remain reviewed.
- A truncated classifier response retries with output budgets `[256, 1024]`.
- Direct SDK guardrails admit structured `read`, exact-file `grep`, project
  `glob`, and ordinary read-only Rules calls without REPL injection; timeout
  diagnostics show `[45000, 90000]`, and `length` triggers the larger retry.

#### Resolution Date

2026-08-04

### 274: Unchanged A2A revisions emit false hot-reload notices and trigger unnecessary TUI redraws

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.69 integration hot reload
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-03
- **Resolved**: 2026-08-03

#### Original Problem

An unchanged `~/.kodax/integrations/a2a.json` repeatedly produced
`A2A configuration hot-reloaded (0 enabled outbound Agents).` Windows file
watch notifications can fire for metadata or unrelated directory events even
when the file bytes and content revision do not change. Every notice flowed
through the integration event bridge into the root Ink component, so users
could observe a UI stall before the false toast became visible.

MCP and Extension subscribers already ignored identical revisions; A2A always
reconciled and notified. A2A also intentionally supports explicit same-revision
manual reload for repairing a missing live registration and retrying a
temporary discovery failure, so removing every same-revision reconciliation
would have broken an existing recovery contract.

#### Root Cause

The A2A controller subscriber did not compare `snapshot.revision` with the
previous snapshot before automatic reconcile/notification. Filesystem watcher
events therefore became user-visible reload events regardless of content.

#### Resolution

- Add the same revision guard used by MCP and Extensions to the automatic A2A
  subscriber before reconcile and notification.
- Keep explicit `handle.reload()` recovery: when its disk revision is
  unchanged, it calls reconcile directly without emitting a hot-reload notice.
- Preserve changed-revision hot activation and its single success notice.

#### Files Modified

- `src/a2a/runtime-config.ts`
- `src/a2a/runtime-config.test.ts`

#### Tests Added

- An unchanged explicit reload emits no `hot-reloaded` event.
- A changed revision still emits exactly one A2A hot-reload event.
- Existing same-revision missing-registration repair and transient-failure
  retry regressions remain green.

#### Resolution Date

2026-08-03

### 273: Runtime actor subprocess test inherited Node environment-proxy warnings

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.79 Runtime actor owner liveness test
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-03
- **Resolved**: 2026-08-03

#### Original Problem

The short-lived Runtime actor owner-liveness subprocess test asserted an empty
stderr but spawned Node with the complete parent environment. On Node versions
that support environment proxies, a machine with `NODE_USE_ENV_PROXY=1` and
`HTTP_PROXY` or `HTTPS_PROXY` caused Undici to print its experimental
`EnvHttpProxyAgent` warning. The liveness probe itself succeeded, but the
unrelated warning deterministically failed the fast suite.

This was a test portability problem rather than a Runtime liveness defect.
Proxy variables without the Node environment-proxy switch did not reproduce the
failure.

#### Root Cause

The test helper's child needs only local module loading and a loopback TCP
probe, but `spawn()` inherited proxy activation and routing variables that were
irrelevant to that contract. Filtering the warning after capture would have
weakened the strict stderr assertion and risked hiding future child failures.

#### Resolution

- Build the child environment from the parent environment, then remove the
  Node environment-proxy switch and uppercase/lowercase HTTP, HTTPS, ALL, and
  NO proxy variables before spawning the local test process.
- Contaminate the parent test environment deliberately and assert that the
  child sees none of the proxy settings, while preserving `stderr === ''` for
  every other warning or error.
- Restore the parent environment in `finally` so the regression test cannot
  affect later Vitest cases.

#### Files Modified

- `src/runtime-actor-owner-liveness.test.ts`
- `docs/KNOWN_ISSUES.md`

#### Verification

- `npx vitest run src/runtime-actor-owner-liveness.test.ts` (6 passed)
- Explicit `NODE_USE_ENV_PROXY=1` plus HTTP/HTTPS proxy run (6 passed)
- `npm run test:fast` (1465 passed)
- `npx vitest run -c vitest.fast.config.ts tests/tracker-consistency.test.ts`

### 272: Qwen review found false-success MCP close, private package imports, and daemon outcome accumulation

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.79 development
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-03
- **Resolved**: 2026-08-03

#### Original Problem

Qwen review identified three concrete release gaps. MCP stdio `close()` returned
success when the root had exited naturally but descendant cleanup remained
`unknown`; the retained cleanup child then made every subsequent `open()` fail.
Root production sources imported three Agent implementation files through
workspace-relative `packages/agent/src/...` paths instead of declared package
entrypoints. Finally, each accepted daemon stop wrote a runtime/PID-bound
shutdown outcome without a retention bound, so one JSON file accumulated per
daemon owner.

The report also described unreadable Windows descendant identities. That is the
already-open Issue 256 safety boundary: a second bare-PID observation cannot
exclude PID reuse, so KodaX must retain evidence and return `unknown` rather
than kill an unverified process. Cleanup-budget exhaustion is likewise a real
cleanup failure, not a skipped-success case. Latest-only event ordering and
sticky indeterminate persistence errors are intentional bounded/fail-closed
semantics; their host-visible observation behavior needed documentation, not a
runtime change.

#### Root Cause

The MCP natural-exit exception treated the server root's business lifecycle as
proof of process-tree cleanup even though reopen state correctly retained the
opposite fact. New daemon/process and history helpers were exported by their
implementation modules but not by package barrels. Shutdown outcomes were
designed as a durable stop fence without a bounded multi-reader lifecycle.

#### Resolution

- Made every MCP `unknown` cleanup result reject `close()` with
  `McpTransportCleanupIncompleteError`, preserving retry evidence and aligning
  the immediate result with the already-blocked reopen state.
- Promoted process start identity, cooperative history search/query validation,
  and Skill creator dispatch through the existing Agent root/subpath barrels;
  root production code now imports only declared package entrypoints. Vitest
  subpath aliases were ordered before the package-root alias.
- Retained shutdown outcomes for multiple concurrent stop readers while pruning
  the profile to the newest 32 owner-bound results; pruning failures emit a
  diagnostic without rewriting the durable daemon result.
- Added the missing archived-resume and empty-lineage changes to the v0.7.79
  changelog, documented Runtime event persistence observation semantics, and
  removed the ignored, reproducible v0.7.76 package tarball from the workspace.

#### Files Modified

- `packages/agent/src/capabilities/mcp/transport.ts`
- `packages/agent/src/capabilities/mcp/transport.cleanup.test.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/session-lineage/index.ts`
- `packages/agent/src/capabilities/skills/index.ts`
- `packages/agent/src/public-entrypoints.test.ts`
- `src/kodax_cli.ts`
- `src/sdk-runtime.ts`
- `src/kodax_cli.daemon-smoke.test.ts`
- `src/runtime-daemon/state.ts`
- `src/runtime-daemon/state.test.ts`
- `vitest.config.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `CHANGELOG.md`
- `docs/KNOWN_ISSUES.md`

#### Verification

- `npx vitest run packages/agent/src/capabilities/mcp/transport.cleanup.test.ts packages/agent/src/public-entrypoints.test.ts`
- `npx vitest run src/kodax_cli.daemon-smoke.test.ts -t "prints JSON for real start/stop commands and releases daemon state"`
- `npx tsc -b packages/agent/tsconfig.json --pretty false`
- `npx vitest run -c vitest.fast.config.ts tests/tracker-consistency.test.ts`

### 271: GLM review found an unbounded boundary projection and small lifecycle/parser hardening gaps

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.79 development
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-03
- **Resolved**: 2026-08-03

#### Original Problem

GLM review reported that revision-fenced conversation forks projected compacted
history synchronously while holding the source Session write lock without
forwarding the projection's existing checkpoint. It also identified three
small hardening gaps: Git mutation flags after the first character of a short
option cluster were not recognized, a newly spawned Windows child could be
missed by its first process snapshot, and a daemon shutdown fault-injection
environment variable was accepted outside an explicit test environment.

The review's broader Session performance characterization was not accurate.
The overlap projection uses KMP and is linear in the compared sequences, rewind
does not call the fork projection, and ordinary `sessions.load()`, resume, and
conversation-page cache paths are separate. The report's `sessions.load()`
event observation is an intentional pure-read contract, classifier
`allow + hazard != none` is an explicit decision-authority design, archived
file filtering is applied after collection, and the persistent per-Session
conversation cache deliberately has no cross-Session LRU that would recreate
cold-load latency.

#### Root Cause

The reusable conversation-history builder already accepted checkpoints, but
the newer `historyBoundary` fork adapter did not expose or forward one. The
other gaps were narrow drift between conservative parsers, duplicated
dependency-light process-tree implementations, and test fault injection.

#### Resolution

- Threaded a checkpoint through conversation-boundary fork projection and its
  lineage path, fork, label, goal, epoch, provenance, overlap, and audit scans,
  then bound it to the existing 15-second Session read budget while the file
  lock is held. No ordinary Session load, resume, or cache behavior changed.
- Reused short-option cluster parsing for Git branch/tag mutation flags and
  added the effectful `branch -u/-t` aliases; removed language-runtime names
  that can no longer reach the safe-read toolchain check.
- Retried one complete Windows snapshot when a live newly spawned root is
  absent, in both Agent and dependency-light LLM copies, and documented their
  intentionally different exports and timeout plumbing.
- Restricted the daemon close-hang injection to `NODE_ENV=test` and documented
  the pure-read `sessions.load()` versus Run-lifecycle event contract for SDK
  embedders.

#### Files Modified

- `packages/repl/src/session/conversation-history.ts`
- `packages/repl/src/session/conversation-history.test.ts`
- `packages/repl/src/interactive/storage.ts`
- `packages/repl/src/permission/permission.ts`
- `packages/repl/src/permission/permission.test.ts`
- `packages/agent/src/runtime/process-tree.ts`
- `packages/agent/src/runtime/process-tree.windows.test.ts`
- `packages/llm/src/cli-events/process-tree.ts`
- `packages/llm/src/cli-events/process-tree.windows.test.ts`
- `src/runtime-daemon/host.ts`
- `src/kodax_cli.daemon-smoke.test.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `CHANGELOG.md`
- `docs/KNOWN_ISSUES.md`

#### Verification

- `npx vitest run packages/repl/src/session/conversation-history.test.ts packages/repl/src/permission/permission.test.ts packages/agent/src/runtime/process-tree.windows.test.ts packages/llm/src/cli-events/process-tree.windows.test.ts`
- `npx vitest run src/kodax_cli.daemon-smoke.test.ts -t "force-reclaims the exact daemon process when Runtime host close hangs"`
- `npx vitest run -c vitest.fast.config.ts tests/tracker-consistency.test.ts`

### 270: Always-on classifier low effort could produce an impossible output/thinking budget

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.73 side-query effort fallback; exposed by v0.7.79 Qwen 3.8 default
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-03
- **Resolved**: 2026-08-03

#### Original Problem

Auto[LLM] correctly selected `low` instead of unsupported `none` when the main
classifier model could not disable thinking. The classifier still passed its
256-token structured-answer cap as the provider's complete output limit. On
Qwen Token Plan `qwen3.8-max`, the Anthropic-compatible adapter clamped the low
thinking budget to its minimum 1024 tokens, producing an invalid request:

```text
max_tokens=256
thinking.budget_tokens=1024
```

The provider rejected the request before any output in roughly 70-80 ms. Both
classifier attempts repeated the same impossible request, and ordinary
read-only Git inspection fell through to a user authorization prompt carrying
`classifier error: provider request failed`.

#### Root Cause

`SideQueryRequest.maxOutputTokens` was documented as a small structured-sidecar
response cap, but `sideQuery()` forwarded it as the provider's total output
window without coordinating always-on reasoning. The effort resolver and output
budget resolver were independent. Provider-budget adapters require room for
both thinking and final text, while effort-only always-on models can similarly
consume a tiny cap before emitting the classifier contract.

#### Resolution

- Resolve the effective side-query reasoning profile once before invocation.
- Keep the caller's 256 tokens as the final classifier-answer allowance.
- When the profile proves thinking cannot be disabled, add one bounded
  1024-token low-effort thinking window and send a 1280-token total cap.
- Make friendly custom-provider profiles that omit `off` explicitly advertise
  `supportsDisabledThinking:false` and reject only `none`, so they reach the
  same reserve path without constraining a declared `minimal` effort.
- Preserve 256 for thinking-off models and for explicit `none`; explicit
  unsupported requests remain strict.
- Raise the classifier's bounded default deadline from 20 to 30 seconds after a
  real Kimi Code off-mode probe completed successfully at 24.3 seconds TTFT;
  explicit SDK/session/config timeout overrides remain authoritative.
- Add an Anthropic-compatible wire regression proving the Qwen-shaped request
  is `max_tokens=1280` with `budget_tokens=1024`, plus prompt-only always-on and
  unchanged thinking-off side-query tests.

The complete same-provider classifier-model selection policy is deliberately
not part of this patch. It is designed as `FEATURE_285` for v0.7.80.

#### Files Modified

- `packages/llm/src/side-query.ts`
- `packages/llm/src/side-query.test.ts`
- `packages/llm/src/providers/anthropic-reasoning-capability.test.ts`
- `packages/llm/src/providers/custom-provider.ts`
- `packages/llm/src/providers/custom-providers.test.ts`
- `packages/coding/src/guardrails/auto-mode/classify.ts`
- `packages/coding/src/guardrails/auto-mode/classify.test.ts`
- `packages/repl/src/common/permission-config.ts`
- `config.example.jsonc`
- `config-templates/config.example.jsonc`
- `tests/auto-mode-classifier-timeout.eval.ts`
- `docs/features/v0.7.80.md`
- `docs/FEATURE_LIST.md`
- `docs/KNOWN_ISSUES.md`

#### Verification

- `npx vitest run packages/llm/src/side-query.test.ts packages/llm/src/providers/anthropic-reasoning-capability.test.ts packages/coding/src/guardrails/auto-mode/classify.test.ts`
- `npx tsc -b packages/llm/tsconfig.json --pretty false`

### 269: POSIX daemon hard-stop lacks a retained kernel process handle

- **Priority**: High
- **Status**: Open
- **Introduced**: v0.7.79 daemon stop watchdog
- **Created**: 2026-08-03

#### Original Problem

After an accepted daemon stop, a permanently pending Runtime close or
synchronously blocked event loop needs an independent process to reclaim the
serve process and its descendants. Windows can bind termination to an exact
creation-time process handle. Node.js 20 on POSIX exposes only numeric
`kill(pid)` / `kill(-pgid)` signaling. Reading `/proc/<pid>/stat` or `ps` before
signaling still leaves a check-to-signal interval in which the process/group can
exit and the number can be reused, so a purported exact hard-stop could target
an unrelated process.

#### Context

- Normal graceful daemon shutdown remains cross-platform and requires the
  Runtime/PID success outcome before `stopped: true`.
- Windows caller-side watchdog escalation is exact and covered by blocked-host,
  blocked-event-loop, live MCP-child, and directory-handle smoke tests.
- POSIX watchdog escalation now fails closed as `cleanup_unverified` without
  sending a cached-PID signal. This prevents false success and unrelated process
  termination, but an external lifecycle manager may still be needed to reclaim
  a truly blocked daemon.

#### Root Cause

The stop caller is not the process that originally spawned the detached daemon
and therefore retains no `uv_process_t`/pidfd/kqueue process handle. File owner
locks and persisted start timestamps can detect many stale states but cannot
make a later POSIX signal syscall atomic with that identity check.

#### Proposed Solution

Introduce a minimal native/supervisor boundary that retains an exact kernel
process handle for the daemon lifetime and owns its process-group/container
cleanup. The design must preserve the current one-owner/multi-client refusal
semantics, add no bare-PID fallback, exit with the daemon, and cover Linux and
macOS process-tree plus application-directory release regressions.

### 268: Auto[LLM] retained category-based approvals and a pre-classifier Tier 0 gate

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.33; retained through v0.7.79 development
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-03
- **Resolved**: 2026-08-03

#### Original Problem

Auto[LLM] was intended to review operations for the user and minimize manual
authorization, but the classifier prompt still described broad command and
hazard categories as confirmation candidates. A historical Tier 0 matcher also
requested approval before the LLM for several command shapes. Normal project
deletes/moves/Git writes, global dependency maintenance, complex syntax,
incomplete analysis, or missing command-by-command user authorization could
therefore be treated as reasons to transfer the decision back to the user.
The Ink REPL also consulted its cross-mode denial cache before yielding to the
Auto[LLM] owner, so a rejection recorded under Edits or Rules could still
override a later valid LLM `allow` for the same call.

#### Root Cause

The Runtime had two competing decision semantics: the LLM classifier owned
ordinary decisions, while the inherited FEATURE_158 taxonomy and ADR-025 Tier
0 path retained broader security-review and mandatory-gate assumptions. Those
assumptions conflicted with the current Auto[LLM] contract that static analysis
supplies facts and deterministic safe admissions but does not define a second
approval policy.

#### Resolution

- Define Auto[LLM] as allow-by-default automatic review with exactly two
  evidence-based ask classes: concrete credential reads or KodaX authorization-
  control mutations, and concrete system destruction or essential-resource
  exhaustion that can destabilize the OS or unrelated software.
- Explicitly classify normal project mutations, Git operations including
  stash, and global dependency install/uninstall/upgrade/reinstall as
  insufficient ask reasons by category; complexity, incomplete facts, general
  uncertainty, and per-command authorization gaps are also insufficient.
- Route historical Tier 0 matches through the classifier as precise facts in
  Auto[LLM]. Keep the legacy deterministic gate only for explicit Auto[Rules].
- Make both REPL observers identify Auto[LLM] through one tested predicate and
  yield before applying legacy confirmation or historical-denial state. Denial
  cache behavior remains unchanged in Plan, Edits, and explicit Auto[Rules].
- Preserve the valid LLM decision as the sole verdict and retain the existing
  one-retry, call-local Accept-edits behavior for classifier infrastructure
  failures.
- Make a user's rejection cancel only the current tool call and return explicit
  safer-alternative guidance to the main Agent. A revised call is reviewed
  independently; no persistent path, prefix, or task denial is created.

#### Verification

- Added classifier-contract regressions for the default verdict, exact ask
  classes, ordinary project/Git/global-package operations, and non-hazard
  uncertainty signals.
- Added guardrail regressions proving historical Tier 0 matches reach the LLM,
  an LLM `allow` is final, an LLM `ask` reaches the host, and explicit Rules
  mode retains its deterministic behavior.
- Added permission-mode coverage proving only Auto[LLM] bypasses the legacy
  observer policy, then reviewed the Ink callback order from guardrail receipt
  through denial-cache and protected-path handling.
- Audited all Auto[LLM] `escalateOrAsk` routes and ran the focused/full
  guardrail suites, Coding type check, and production build.

### 267: Daemon serve host could outlive a successful Runtime stop

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.66 process-hosted daemon
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-03
- **Resolved**: 2026-08-03

#### Original Problem

After real work had settled and stop preflight accepted shutdown, the daemon
could log `stop requested`, `stopping`, and `stopped` and release its owner
state while the `daemon serve` OS process remained alive. Residual LSP,
managed-child, tracing, or other process-level handles could then retain the
application working directory and prevent KodaX Space from cleaning or
rebuilding it.

#### Root Cause

The host close path correctly closed the socket, daemon management services,
reverse bridges, and embedded Runtime. However, `daemon serve` runs as a
Commander subcommand; after its action completed, `main()` returned at the
subcommand boundary and never reached the ordinary CLI finalizer that closes
the default LSP service, reclaims current-owner managed children, and shuts
down tracing. Process termination therefore depended on Node's event loop
happening to be empty after the host-level `stopped` boundary.

#### Resolution

- Give `daemon serve` an explicit process-resource finalizer covering A2A,
  integration hot reload, extension Runtime, default LSP, current-owner managed
  child trees, and tracing. Every cleanup is attempted and multiple failures
  remain observable as an aggregate error. A daemon-side total deadline plus
  per-phase budgets prevent an unresolved disposer from blocking all later
  cleanup indefinitely.
- Make current-owner managed-child cleanup fail when exact tree reclamation
  cannot be verified, while continuing to ignore live foreign-owner records.
  Current-process registrations remain in memory even when registry persistence
  fails, and strict final cleanup reclaims that active set independently before
  reading persisted recovery records; unreadable registries fail closed.
- After all graceful cleanup succeeds, explicitly terminate the dedicated
  daemon-serve host so residual third-party event-loop handles cannot keep the
  OS process alive. A failed or timed-out finalizer also exits the dedicated
  serve process with a non-zero code after publishing the failure outcome, so
  leftover event-loop handles cannot defeat the deadline. Existing stop
  preflight and draining fences are unchanged.
- Bind a durable shutdown outcome to the exact Runtime ID and host PID. CLI stop
  succeeds only when that success outcome and actual PID exit agree; cleanup
  failure or a missing fence is reported as failure. Per-owner outcome files
  keep a concurrently starting replacement daemon from erasing the old
  instance's verification boundary; the newest 32 outcomes are retained so
  concurrent stop clients can verify the same owner without unbounded growth.
- Start an independent stop-client watchdog once `daemon.stop` is accepted.
  If host/Runtime close hangs or the daemon event loop blocks synchronously,
  the Windows client reclaims only the PID whose OS creation identity was
  captured before the request. POSIX fails closed without signaling until
  Issue 269 supplies a retained native handle. Forced exit without the exact
  success outcome remains an observable `cleanup_unverified` failure, and stale
  old-owner files are removed only when their Runtime/PID fence is unchanged.
- After the original PID and outcome have been verified, re-observe both state
  and the live owner lock. A replacement daemon is returned as the current
  profile owner (`stopped: false`, `reason: replacement_running`, and
  `replacementRunning: true`) instead of allowing existing or new Space
  clients to treat the profile directory as idle.
- Fence the administrative request itself: the `initialize` response must
  still match the Runtime ID/profile observed before connecting. A replacement
  that reuses the same endpoint is never sent the stale caller's stop request.

#### Verification

- Added a lifecycle regression proving host shutdown is followed in order by
  extension, LSP, exact managed-child, and tracing cleanup, that a hung phase is
  bounded, later phases still run, and host plus finalizer errors are aggregated.
- Added managed-child regressions for corrupted/missing persistence evidence,
  registration-write failure, and unreadable strict-cleanup registries, plus
  state tests for Runtime/PID-isolated, bounded multi-reader shutdown outcomes.
- Extended the process-distinct SDK smoke test to prewarm a real MCP child,
  execute a real Runtime Run to terminal idle state, stop the daemon, and prove
  both daemon and child PIDs are gone, owner files are absent, and the daemon
  directory can be renamed.
- Added a detached-process failure smoke test proving host PID exit cannot turn
  a failed final cleanup into `stopped: true`.
- Added process-distinct watchdog smoke tests for a permanently pending Runtime
  host close and a 30-second synchronous cleanup block. The blocked path keeps
  a real MCP child alive in the application directory and proves both PIDs,
  owner files, and directory handles are reclaimed. A replacement-owner race
  also starts the new daemon after ownership release but before the original
  serve PID exits.
- Added a two-stop-client race proving a stale observer cannot stop a replacement
  daemon that acquires the old endpoint before the delayed request is sent.
- Added OS process-start identity tests proving Windows exact creation-time
  capture and POSIX PID-reuse refusal.
- Extended public SDK rollback coverage to wait for the original daemon PID
  after each accepted stop; existing connected-client and active-work refusal
  tests remain authoritative and unchanged.

### 266: Auto-mode fault logs exposed exception secrets and allow hazard typing widened

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.79 classifier decision fix
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-03
- **Resolved**: 2026-08-03

#### Original Problem

Recoverable projector, analyzer, Accept-edits fallback, and rules-evaluator
exceptions were interpolated directly into host warning logs. An extension
could therefore expose credentials embedded in an exception message and emit
an unbounded, multi-line log entry. Separately, accepting `allow` despite a
contradictory hazard widened the public allow branch from `hazard?: 'none'` to
`hazard?: ClassifierHazard`, which could break TypeScript SDK hosts that relied
on the earlier discriminated type.

#### Root Cause

The fallback behavior added diagnostic exception text without applying the
existing classifier-projection redaction boundary. The parser also reused one
hazard property shape for both allow and ask results even though a contradictory
allow hazard is diagnostic-only.

#### Resolution

- Omit extension/provider exception bodies from Auto-mode logs and approval
  reasons, retaining only a stable failure stage and exception category.
- Route all Auto-mode host warnings through one boundary that redacts remaining
  dynamic facts, normalizes to one line, caps the complete log entry at 768
  characters, and isolates host-logger failures from permission decisions.
- Include model/provider resolution and classifier-context callbacks in the
  existing classifier-failure fallback boundary instead of allowing synchronous
  callback exceptions to escape to the host.
- Restore the public allow branch to `hazard?: 'none'`. A contradictory
  non-`none` value still produces `decision_hazard_conflict`, but is omitted
  from the legacy hazard field and never overrides the LLM `allow`.

#### Verification

- Projector, analyzer, fallback, rules, and provider-resolution regressions
  inject long natural-language secrets and prove exception bodies do not reach
  logs or approval reasons, while the documented allow/fallback paths remain
  unchanged. A throwing host logger is also proven unable to alter the verdict.
- Parser/type regression coverage proves a contradictory hazard yields an
  allow plus warning while the allow branch retains the previous public type.

### 265: Classifier auxiliary fields could override a valid Auto[LLM] decision

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.79 classifier output hardening
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-03
- **Resolved**: 2026-08-03

#### Original Problem

The structured classifier parser first accepted `decision=allow|ask`, then
treated missing, invalid, or contradictory `hazard` / `reason` fields as a
contract failure. A valid `allow` could therefore be retried and converted to
an artificial user-approval request; repeated auxiliary defects could also
open the classifier circuit breaker. This created a second, parser-owned
decision mechanism after the LLM had already returned its verdict.

#### Root Cause

The parser used explanatory fields both to validate observability quality and
to re-decide the permission outcome. Attempt diagnostics had only failure
codes, so callers could not retain auxiliary defects without rejecting the
decision.

#### Resolution

- Treat exactly one valid current or legacy decision as authoritative.
- Preserve auxiliary and surrounding-format defects as bounded
  `outputWarnings`; they do not retry, count as classifier failure, or override
  the verdict.
- Route recoverable tool-projection and direct-read-analyzer faults through the
  classifier with bounded, redacted fallback facts instead of immediately
  requesting user approval.
- Keep missing, invalid, duplicate, and mixed decisions as retryable contract
  failures. An unusable `ask` explanation receives a neutral display reason
  without weakening the confirmation decision.
- Publish the warning type through the Coding/Runtime diagnostics contract and
  clarify the classifier prompt and SDK embedder guidance.

#### Verification

- Parser regressions cover missing/invalid/contradictory auxiliaries, legacy
  compatibility, surrounding prose, and ambiguous decision envelopes.
- Classifier tests prove accepted warnings use one provider call while missing
  or ambiguous decisions still receive one bounded retry.
- Guardrail tests prove `allow` never asks the user and repeated warnings never
  increment or open the circuit breaker; `ask` still requests confirmation and
  exposes its warnings diagnostically.
- A real REPL analyzer matrix covers ordinary execution, scripts, network,
  Git, protected reads, and recursive deletion; a decision-only `allow` uses
  exactly one provider call and zero user-approval calls in every case.

### 264: Empty persisted conversations were reported as missing lineage

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.79 conversation projection
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-03
- **Resolved**: 2026-08-03

#### Original Problem

Strict Session reads reconstructed an empty v2 lineage as `undefined` because
there were no lineage-entry records. The ordinary-conversation projection then
unconditionally emitted `partial` / `lineage_unavailable`, even though no
conversation record existed to recover. This affected both genuinely empty v2
Sessions and the normal lifecycle interval after a Run was accepted but before
its body entered canonical history. A prepared empty page cache was built from
the original empty lineage as `resolved`, so direct and paged reads could also
disagree at the same persisted source revision. Conversely, a legacy main file
with only an island-sidecar message dropped that recoverable body when no main
lineage existed.

#### Resolution

- Preserve the explicit empty v2 lineage from its persisted metadata.
- Treat a missing lineage with zero persisted conversation messages as a
  resolved empty projection; Actor/Run state does not change that diagnosis.
- When sidecars contain lineage entries but the main lineage is absent, retain
  those physical records under an incomplete lineage so the existing exact
  `partial` diagnostics apply instead of hiding the bodies.
- Keep standalone, Runtime direct, and prepared/fallback paged results on the
  same source-revision, ordering, status, and issue contract.

#### Verification

- Added public SDK regressions for an empty v2 Session and an accepted Run with
  no canonical history; standalone, direct, and paged reads all return the same
  resolved empty result.
- Added a persisted sidecar-only regression proving an orphan body remains
  visible and partial when its active lineage cannot be recovered.
- Added a projection unit regression for the legacy zero-record/no-lineage
  boundary.

### 263: Auto permission fast paths and Coding intent propagation could bypass complete review

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.79 development
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-02
- **Resolved**: 2026-08-02

#### Original Problem

Three deterministic Auto permission checks admitted calls that still required
LLM review:

- shell and PowerShell read operands such as `.env*`, `.e?v`, and `.en[v]`
  could expand to protected files after the lexical sensitive-path check;
- positive `grep`/`glob`/ripgrep/GNU-grep selectors, PowerShell comma-separated
  path arrays and `Get-ChildItem | Get-Content/Select-String` pipelines, and
  `findstr /F:` file lists could select protected files indirectly while the
  fast path inspected only a lexical root or direct operand;
- `git config --get-regexp` treated a `user.` prefix as sufficient, so an
  alternation such as `^user\.|.*` could read unrelated credential-bearing
  configuration. New `git config get` regexp/URL modes, Git's accepted long
  option abbreviations, boolean option ordering, dynamic attr pathspecs, and
  executable `git grep` options were not modeled consistently;
- a mutation could rely on a compacted current user request even when
  `currentUserContentTruncated` proved that the request was incomplete;
- PowerShell environment-provider reads such as `Get-ChildItem Env:*`,
  `gci Env:OPENAI_*`, and `Get-ChildItem Env: -Force` were modeled as complete
  ordinary reads, despite returning environment values that can contain API
  keys and tokens;
- deterministic read/read-only-execute paths ignored explicit constraints
  retained in truncated current-user content, and a narrow verb list missed
  equivalent constraints such as "Don't use the shell", "use file tools
  only", and their Chinese forms.
- unquoted LF/CRLF/CR separators were consumed as whitespace by the permission
  tokenizer even though the real shell executes the following physical line as
  another statement; a safe first command could therefore hide an arbitrary
  later command from deterministic review, including when a comment contained
  quote characters;
- the universal Git read helper treated signature-verifying `git tag -v`,
  `--show-signature`, and signature format placeholders as pure reads even
  though Git can invoke a configured signature helper. Auto[LLM]'s richer
  analyzer already routed these cases correctly, leaving ACP, direct-shell,
  and fallback callers with a weaker contract;
- `Runner.run(createDefaultCodingAgent(), ..., { permissionIntent })` preserved
  the structured intent in the generic Runner but the Coding substrate did not
  merge it into `KodaXOptions.context`. Direct SDK calls could therefore lose
  authenticated constraints, scope, delegation, and `readOnly` metadata before
  tool guardrails ran.

Classifier-failure fallback also checked only intent restrictions. A protected
or unresolved read that reached the classifier could therefore be admitted as
an Accept-edits-style ordinary read after both classifier attempts failed.

#### Root Cause

- Sensitive-path discovery recognized exact components but did not preserve
  shell expansion, selector, array, pipeline, or indirect-file-list
  uncertainty as an unresolved read target.
- The safe Git selector regular expression validated only the beginning of the
  supplied expression instead of its complete grammar.
- Deterministic mutation admission stopped consulting the truncation flag
  during the v0.7.79 intent-binding refactor.
- PowerShell `Env:` and `Variable:` were treated like lexical file operands
  rather than process-data provider selectors. Aliases, wildcards,
  attached/detached `-Path`, parameter combinations, and `Get-Variable` could
  therefore bypass the sensitive-process-data check. Pipeline-bound provider
  paths, scoped variables, Bash indirect expansion, and arbitrary exact secret
  names were adjacent ways to reach the same data without a known denylist hit.
- Read-only fast paths treated failure to match a small denial regex as proof
  of compatible intent. The compactor also anchored slices only around command
  terms, so a constraint in the middle of a long current request could be
  omitted before the guardrail evaluated it.
- Failure fallback did not require the complete structured permission review
  to satisfy the same deterministic-admission predicate as the original fast
  path.
- The shell AST wrapper delegated a complete multi-line string to
  `shell-quote`, whose grammar does not emit newline control tokens. Permission
  and execution consequently disagreed about the number of statements.
- Git indirect signature execution was modeled in Auto rules but duplicated
  rather than shared with the universal read predicate.
- The default Coding substrate merged top-level abort and guardrail fields but
  omitted the sibling `permissionIntent` Runner field.

#### Resolution

- Treat glob, bracket, brace, positive search-selector, path-array, broad
  enumeration-pipeline, and indirect file-list syntax as unresolved and route
  it to Auto[LLM] unless a concrete protected target is already known.
  Preserve explicit PowerShell `-LiteralPath` semantics, including unambiguous
  parameter abbreviations; exclusion selectors remain exclusions. On Windows,
  normalize trailing-dot/space and alternate-data-stream aliases and resolve
  existing 8.3 names before deciding that a target is non-sensitive.
- Restrict statically safe Git-config regexp reads to complete anchored
  expressions over the known non-secret `user.name`/`user.email` keys.
  Validate new `get --regexp` and `get --url` forms using Git's accepted long
  option abbreviations and effective last-boolean-option semantics. Dynamic
  attr pathspecs and Git-grep options that can execute a pager/external grep
  remain LLM-reviewed. `git grep --no-index`/`--untracked` also stay under LLM
  review because they expand the scan beyond tracked pathspec resolution.
- Treat directory/implicit `rg`, all modeled recursive GNU-grep forms (including
  `-d recurse`/`--directories=recurse`), recursive findstr, explicit or default
  structured-grep directory roots, pathless Git-grep, and unscoped Git
  patch/content output as unresolved while no universal per-file fence is
  present. Git line-log `-L` targets are parsed as paths, and patch-enabling
  short-option clusters, `--patch-with-raw`, `--remerge-diff`, and
  `--diff-merges` modes cannot hide content output behind metadata flags.
  Scoped file reads and metadata-only Git output such as `git show --stat`
  retain the fast path.
- Parse PowerShell environment/variable-provider operands for `Get-ChildItem`,
  `Get-Item`, `Get-Content`, and `Select-String`, including their built-in
  aliases, unambiguous parameter abbreviations, comma arrays, provider-qualified
  paths, and wildcard forms. Broad or sensitive selectors route through
  Auto[LLM]. A small conventional diagnostic-name allowlist keeps exact reads
  such as `Env:PATH` on the fast path; arbitrary exact names and literal
  wildcard names are not assumed non-secret. `Get-Variable`/`gv`, scoped
  PowerShell variables, pipeline-bound provider paths, and Bash `${!...}`
  expansion follow the same process-data boundary. Canonical `Get-Item`/
  `Get-Variable` safe-name selectors are modeled as read-only only inside the
  Auto[LLM] analyzer, so `PATH`/`HOME` stay deterministic without widening the
  direct-shell bypass. Non-filesystem providers (`Function:`, `Alias:`,
  `Cert:`, registry drives, and provider-qualified equivalents) remain
  LLM-reviewed. Literal single-quoted variable text and bare `Env:` search or
  output text are not misclassified as process-data access. `Select-String`
  binds its first unbound positional operand as `Pattern`, later operands as
  `Path`, and treats `-InputObject` as data rather than a provider path.
- Keep truncation by itself irrelevant to deterministic reads, but require LLM
  review before writes, deletes, moves, copies, or unmodeled execution can rely
  on incomplete current-user authority. Any explicit read/shell constraint
  that is present in compacted current-user content is checked even when the
  content is marked truncated. High-recall English/Chinese constraint
  candidates only route to the LLM; they never decide allow/deny themselves.
  Constraint markers are also compaction anchors, so middle-of-request
  authority survives bounded intent projection. Ordinary review/read-only and
  mutation-only restrictions still retain deterministic read fast paths.
  Semantic routing is clause- and target-aware: operation paths are removed
  before interpreting constraint words, exclusions apply only when related to
  the requested target, and broad compaction anchors are not themselves used
  as proof that a restriction exists.
- For copy, delete, move, and rename, deterministic admission now requires the
  requested action to bind directly to the concrete source target. Indirect,
  exclusion-shaped, or otherwise ambiguous authority routes to Auto[LLM]; an
  LLM `allow` still executes without asking the user. Explicit English and
  Chinese action-to-target forms retain their zero-classifier fast path.
- Treat an `allow`/`hazard=none` envelope whose reason itself describes a
  destructive, disclosure, or confirmation requirement as a contract
  contradiction. The bounded retry/fallback path handles it as classifier
  failure instead of silently accepting a semantically inconsistent response.
- Permit Accept-edits classifier-failure fallback only when the complete
  permission review is itself deterministically admissible. Protected,
  unresolved, partial, risky, or intent-constrained reviews ask instead.
- Tokenize each unquoted physical shell line separately, retain explicit
  control-operator continuations, and validate every resulting statement and
  pipeline stage. Bash backslash-newline is conservatively treated as a
  boundary because PowerShell assigns it different semantics. Active `$()`
  substitution outside single quotes is opaque even inside double-quoted or
  multi-line arguments. Fully deterministic reads remain zero-call; any
  unproved statement routes the complete call to Auto[LLM].
- Share one Git signature-inspection predicate between the universal read gate
  and Auto rules. Verification flags and active signature format placeholders
  no longer use the unconditional read fast path, while ordinary tag listing
  and non-verifying formats remain deterministic.
- Merge top-level `Runner.run()` permission intent into the default Coding
  substrate context, with the per-run value overriding a stale preset value
  while preserving all other preset context fields.

The earlier DeepSeek response body was not retained, so a historical
`legacy_v1` response remains a hypothesis rather than a proven incident cause.
The strict dual reader is a compatibility mitigation: fenced output,
surrounding prose, mixed envelopes, and missing required fields remain contract
failures. Future incidents use bounded content-free protocol/parse diagnostics;
raw classifier text is intentionally not persisted.

#### Files Changed

- `packages/repl/src/permission/auto-rules.ts`
- `packages/repl/src/permission/permission.ts`
- `packages/repl/src/permission/bash-ast.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.ts`
- `packages/coding/src/coding-preset.ts`
- adjacent regression tests and SDK/release documentation

#### Tests Added or Updated

- Reported POSIX/cmd/PowerShell wildcard reads, Git and regex pathspecs, and
  PowerShell `-LiteralPath`, comma-array, enumeration-pipeline, search-filter,
  and indirect-file-list counterexamples.
- Safe and adversarial full-expression Git config selectors, abbreviation,
  URL-section, and ordered `--name-only` cases; executable Git-grep options.
- Broad versus scoped content-search and Git patch-output cases, including
  GNU-grep directory modes, default structured-grep scope, Git `-L` paths,
  patch/merge-diff option combinations, and the user-reported metadata-only
  `git show --stat` counterexample.
- Windows trailing-dot/space, alternate-data-stream, and existing 8.3 aliases
  for protected filenames.
- Truncated-intent mutation review, truncated-intent read fast path, and
  classifier-failure denial for unresolved reads or explicit root-user read
  restrictions.
- PowerShell `Environment`/`Variable` provider cmdlets and aliases (including
  `Get-Variable`/`gv`), wildcard and parameter combinations,
  provider-qualified/pipeline-bound paths, scoped and indirect variable forms,
  non-filesystem providers, literal-reference controls, safe-name controls,
  `Select-String` Pattern/Path/InputObject binding, and end-to-end assertions
  that risky commands call the classifier exactly once while proven-safe
  selectors make zero calls.
- English/Chinese shell/read constraint paraphrases, positive and mutation-only
  controls, multi-clause/target-scoped restrictions, `read-only` versus
  `read only <target>`, retained constraints in truncated requests,
  scope/exclusion/passive/subprocess variants, constraint-shaped filenames,
  middle-of-request compaction anchors, and classifier call-count assertions.
- Direct versus exclusion-shaped copy/delete/move/rename authority in English
  and Chinese, plus contradictory structured and legacy classifier reasons.
- LF/CRLF/CR command sequences, comments containing unmatched quote characters,
  quoted multi-line arguments, active double-quoted `$()` substitution,
  single-quoted literal controls, safe multi-line controls, and unsafe later
  statements through both the AST and Auto rules boundaries.
- Git verification flags, signature pretty/ref-format placeholders, ordinary
  tag-name controls after `--`, and the existing Auto[LLM] indirect-execution
  matrix against the shared predicate.
- Real default-agent `Runner.run()` dispatch with conflicting top-level and
  preset permission intents, plus the preset-only compatibility path.

### 262: Session lifecycle operations can orphan recoverable conversation cache content

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.79 development
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-02
- **Resolved**: 2026-08-02

#### Original Problem

Conversation page caches contain complete message bodies. Archive, unarchive,
delete, and retention cleanup can currently report the primary Session
operation as successful when cache removal fails. Legacy Session migration can
also leave the cache at the superseded source location. A detached cache is
therefore still recoverable after the Session lifecycle operation that should
have moved or destroyed its content.

#### Context

Affected paths are Session archive/unarchive, explicit deletion, retention
cleanup, and legacy layout migration. Completion requires cache lifecycle
failures to be observable and retryable, with no orphaned recoverable body
content after a successful operation.

#### Resolution

Archive, unarchive, delete, and retention now remove the source, counterpart,
and legacy cache locations before moving or deleting the canonical Session.
Cleanup failure leaves the Session attached, is surfaced to the caller, and is
safe to retry. Retention aggregates failures after continuing its sweep. Layout
migration v3 removes legacy caches before and after moves, does not write its
marker on cache-cleanup failure, and allows the same storage instance to retry.

#### Files Changed

- `packages/repl/src/session/conversation-page-cache.ts`
- `packages/repl/src/interactive/storage.ts`
- `packages/repl/src/interactive/session-migration.ts`
- `src/kodax_cli.ts`

#### Tests Added

- Lifecycle cleanup failures for archive, unarchive, delete, and retention.
- Same-instance migration retry and legacy flat / `sessions-archive` cache cleanup.

### 261: Prepared Session append rereads the complete conversation bundle

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.79 development
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-02
- **Resolved**: 2026-08-02

#### Original Problem

After a Session conversation page cache has been prepared, an ordinary append
re-reads the complete main and sidecar bundle to maintain the cache. Measured
append latency therefore grows with the complete Session history even though
only a new tail was persisted.

The first bounded-prefix implementation also made existing indices of arrays
returned by public `storage.load()` calls non-writable/non-configurable and
exported its trusted inheritance primitive from the public Agent SDK. That
changed the declared mutable-array contract and let a caller incorrectly bless
an already rewritten prefix so the hot path could overlook the rewrite.

#### Context

The append hot path must have bounded read and compute cost relative to the new
tail while preserving exact revision/sourceRevision, canonical ordering, and
the existing `data_changed` / `resync_required` contract. No timestamp,
sequence, content-deduplication, or UI-visibility semantics are added.

#### Resolution

The cache manifest now carries a validated, fixed-chunk source revision state.
A normal prepared append extends that state from at most one bounded tail plus
the newly written JSONL bytes, and validates the exact main/sidecar boundary
transition using metadata only. A fixed-size, no-false-negative identity filter
preserves conflict detection without traversing the persisted prefix. The
filter remains a recoverable cache artifact: it is admitted only when its hash
matches canonical main-file metadata and its bundle revision is exact, so a
tampered or publicly rebuilt partial cache cannot become a trust authority. Full
snapshot calculation uses the same revision algorithm, so direct reads and
prepared pages remain exact. Any
unexpected topology or lineage transition invalidates the cache without doing
a synchronous full-history rebuild.

Public full-snapshot `appendSessionDelta()` calls now always use the exact
canonical merge path, so replacement, nested mutation, and mutation after a
lineage helper returns are persisted instead of being silently treated as an
unchanged prefix. The separate `appendPreparedSessionTail()` capability accepts
only new lineage/artifact/extension tail records and a one-shot boundary from
asynchronous `prepareSessionAppend()`; historical arrays are absent from its
type and runtime input. The boundary is fenced by a process-local revision,
counts, active leaf, tag, exact main/sidecar bundle revision, and durable
main-file identity. Lineage tails must be a new message-only parent chain;
artifact identities/dedup keys and the bounded ledger cap are checked without
prefix traversal. The mutable public delta is deep-snapshotted before the first
await. Stale or non-linear tails fail observably with `data_changed` and require
reload/rebuild. No periodic full-history maintenance runs inside this path, so
the complete prepared append computation remains proportional to the supplied
tail while keeping caller-owned full snapshots exact.

A non-null fulfilled prepared append returns its reusable successor boundary.
A fulfilled `null` means the append committed exactly once but the successor
could not be safely witnessed; the caller reloads and must not retry the same
tail. This separates observable pre-commit rejection from post-commit resync
without weakening revision or canonical-order semantics.

`storage.load()` again returns ordinary mutable, configurable,
structured-cloneable arrays and objects. All Proxy/freeze prefix tracking and
the importable `@kodax-ai/agent/internal/session-append-prefix` package export
were removed; there is no public primitive that can bless an unverified
historical prefix.

#### Files Changed

- `packages/repl/src/session/source-revision.ts`
- `packages/repl/src/session/conversation-page-cache.ts`
- `packages/repl/src/interactive/storage.ts`
- `packages/repl/src/session/public-api.ts`
- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/index.ts`
- `src/sdk-conversation-history.test.ts`
- `src/sdk-runtime.ts`

#### Tests Added

- Incremental/full source revision equivalence across LF, CRLF, empty-line, and chunk boundaries.
- Prepared append performs no main/sidecar payload or prefix read, preserves direct source revision equality, and rejects a stale revision.
- A 640-entry prepared append fails on any lineage/artifact history index read while verifying exact incremental `activeMessageCount` and the cache tail.
- Stale prepared boundaries and cross-process changes fail with `data_changed` and expose a fresh retry boundary after reload.
- Public SDK storage regression verifies loaded lineage/artifact arrays are structured-cloneable, retain writable/configurable indices, and persist index, nested, and post-helper prefix edits.
- Public Agent packaging regression verifies no prefix capture, inheritance, trust-check primitive, or internal proof subpath is exported.

### 260: Shell read-only inspection, intent binding, and classifier protocol drift caused spurious Auto approvals

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.33; amplified by v0.7.79 development
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-02
- **Resolved**: 2026-08-02

#### Original Problem

Auto[LLM] repeatedly requested permission for ordinary PowerShell environment
inspection such as `where.exe rg`, `$env:PATH ... | Where-Object`, and
`rg --version 2>&1 | Select-Object -First 2`. Permission diagnostics reported
`classifier_failure/contract_error`, even though both classifier attempts
completed normally. A related explicit `& ...dsh.cmd --version` call was
represented as an opaque unknown action, so the classifier received weaker
facts than were available from the command. Child review commands could also
inherit a long generated briefing as if it were fresh user authority, while
some authenticated constraints were checked only after read fast-paths.

#### Root Cause

- The shared shell tokenizer treated `2>&1` as a file redirect and a leading
  PowerShell call operator as an unsupported background operator.
- Static read admission did not model safe PowerShell environment expressions,
  constrained `Where-Object`/`Select-Object` stages, or ripgrep's read-only
  invocation boundary. Sequential `;` statements were rejected before each
  statement could be validated independently.
- The basename-oriented command allowlist did not distinguish a bare admitted
  executable from a path-qualified lookalike. It also classified interpreters
  with effectful DSLs (`awk`, `sed`, POSIX `fc`) and effectful `find` actions
  too broadly as reads.
- The classifier prompt had moved to a structured decision/hazard contract
  while valid responses in the previous `<block>` protocol could still arrive.
  Those semantic decisions were converted into infrastructure failures.
- Deterministic admission checked `read` and `readOnly` operations before
  relevant authenticated child constraints, and review questions containing a
  possible mutation verb could be mistaken for mutation authority.
- Existing diagnostics exposed timing and prompt size but not response shape,
  provider stop reason, observed protocol, or the exact parse failure class.

#### Resolution

- Model descriptor duplication/closure separately from file redirection and
  recognize a leading PowerShell call operator without accepting background
  execution. File targets after `>&` remain writes.
- Deterministically admit only structurally proven read-only PowerShell stages,
  including the reported compound inspection. Sensitive environment names,
  path-qualified executables, effectful command DSL/actions, script blocks with
  effects, external ripgrep preprocessors, arbitrary scripts, and any
  unmodeled stage continue to require LLM review.
- Preserve structured operation facts for parsed-but-unmodeled shell calls
  instead of collapsing them to an opaque unknown action.
- Carry Runtime-authenticated root intent, delegated objective, and binding
  constraints separately from generated child briefings. Check relevant
  constraints before read fast-paths, while retaining zero-LLM admission when
  a constraint only prohibits mutations. Treat review questions as review
  authority, not implied permission to perform the mutation being discussed.
- Keep the structured classifier protocol canonical while dual-reading the
  previous valid standalone protocol during rollout. Both readers require one
  complete, exclusive envelope: mixed protocols, surrounding prose, duplicate
  decisions, and nested contract tags cannot select an early allow or
  downgrade a malformed structured response. Malformed output still retries
  once and then uses the Accept-edits failure boundary.
- Add bounded, content-free diagnostics for provider stop reason, response byte
  count, text-block count, observed protocol, and parse failure code; Runtime
  permission requests carry the same fields to SDK hosts and Space.

#### Files Changed

- `packages/repl/src/permission/bash-ast.ts`
- `packages/repl/src/permission/permission.ts`
- `packages/repl/src/permission/types.ts`
- `packages/repl/src/permission/auto-rules.ts`
- `packages/coding/src/guardrails/auto-mode/permission-intent.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.ts`
- `packages/coding/src/guardrails/auto-mode/parse-output.ts`
- `packages/coding/src/guardrails/auto-mode/classify.ts`
- `packages/coding/src/guardrails/auto-mode/circuit-breaker.ts`
- `packages/llm/src/side-query.ts`
- `packages/repl/src/interactive/commands.ts`
- `packages/coding/src/index.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`

#### Tests Added or Updated

- Added parser and permission regressions for descriptor duplication, the exact
  reported PowerShell inspection, sensitive/effectful counterexamples, and the
  Accept-edits failure path.
- Added classifier protocol/parse-diagnostic and side-query response-shape
  coverage, plus Runtime SDK propagation and degraded-health status coverage.

### 259: REPL startup persists zero-message sessions before the first prompt

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.72 Runtime REPL bridge
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-02
- **Resolved**: 2026-08-02

#### Original Problem

Starting the classic or Ink REPL and exiting before submitting a prompt created
a durable user-scope `REPL Session`. Startup and first-ready performance probes
therefore left batches of zero-message records in the shared Session store.
`kodax -r` hid those records because they were not resumable, while KodaX Space
showed them as empty tasks because it intentionally preserves REPL history.

#### Context

- Affected components: Runtime-backed REPL startup, CLI startup benchmarks, and
  KodaX Space's shared Session list.
- Reproduction: launch `kodax`, wait for the first input prompt, enter `/exit`,
  and inspect the current project's user Session bucket.
- Expected: a REPL that never receives a prompt leaves no durable Session.

#### Root Cause

Both REPL surfaces synchronize Runtime Auto settings while mounting. The
`syncSettings()` bridge called `ensureCliRuntimeSession()`, which created the
Session before any user prompt reached the interactive Runtime runner. The
runner already has the correct first-prompt creation boundary, but startup
settings synchronization bypassed it.

#### Resolution

- Startup settings synchronization now updates only an existing Runtime
  Session. A normal missing-Session result is provisional and performs no
  create or settings write; other load failures still propagate.
- The interactive Runtime runner continues to create the Session on the first
  real prompt and then synchronizes the current permission and Auto settings.
- Archived the 15 strictly verified zero-message REPL records created by the
  2026-08-01 startup performance investigation and two same-signature records
  created by a concurrent process before the fix was built. Two older strict
  zero-message REPL records were also archived. All 19 records and their cache
  bundles remain recoverable through the Session storage archive operation.

#### Files Changed

- `src/kodax_cli.ts`
- `src/kodax_cli.runtime-runner.test.ts`

#### Tests Added

- Added a Runtime bridge regression proving startup synchronization returns no
  stats and performs no create, settings read, or settings write when the
  provisional REPL Session does not exist.
- Passed the 11-test Runtime bridge suite, the 65-test CLI contract suite, and
  the complete production build.

### 258: TodoList content and labels can ignore the query and UI locale

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.79 development
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-01
- **Resolved**: 2026-08-01

#### Original Problem

For a Chinese query, the Worker could create every TodoList row in English even
though the configured UI locale and the request were Chinese. The counter still
rendered `0/5 completed`, and folded rows used hard-coded `done` / `more` text.
The shared language-continuity rule covered explanations, progress notes, and
final answers, but did not explicitly include the user-visible fields passed
through `todo_create` and `todo_update`.

#### Root Cause

Todo fields were treated as tool arguments rather than as user-facing text. The
plan contract and both tool descriptions used English-only examples without a
field-level language requirement, so weaker providers could follow the general
response-language rule while still emitting English `subject`, `description`,
`activeForm`, and `note` values. Separately, the REPL counter, transcript header,
and summary-fold text bypassed the existing i18n dictionary entirely.

#### Resolution

- Added a Todo-specific Worker contract requiring every user-visible todo field
  to follow the primary natural language of the query unless the user requests
  another language.
- Repeated the same constraint in the `todo_create` and `todo_update` tool
  descriptions, close to the model's field-generation decision.
- Kept code identifiers, file paths, commands, and quoted evidence in their
  source language.
- Added localized progress, transcript, completed-fold, and pending-fold labels
  and made the activity bar use the shared formatter.

#### Files Changed

- `packages/coding/src/agents/worker-role-prompt.ts`
- `packages/coding/src/tools/tool-definitions.ts`
- `packages/coding/src/language-continuity.test.ts`
- `packages/repl/src/common/i18n.ts`
- `packages/repl/src/common/i18n.test.ts`
- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/view-models/todo-plan.ts`
- `packages/repl/src/ui/view-models/todo-plan.test.ts`

#### Tests Added

- Extended `language-continuity.test.ts` to pin the Todo field-language
  contract in the Worker prompt and both mutating Todo tool descriptions.
- Added Chinese-locale assertions for the Todo counter, transcript heading, and
  both summary-fold labels while preserving existing English output.

### 257: Legacy compaction copies cannot be safely folded by hosts

- **Priority**: High
- **Status**: Resolved
- **Introduced**: legacy compaction/resume persistence
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-01
- **Resolved**: 2026-08-01

#### Problem

Some legacy Sessions contain different physical lineage IDs for copies of one
retained user/assistant/tool interaction. Raw transcript provenance is
insufficient for a host to distinguish those copies from a genuine repeated
interaction. Content, timestamp, and `turnId` heuristics can therefore either
show duplicates or silently delete real user input.

#### Resolution

- Raw `loadFullTranscript()` / `readFullTranscript()` behavior remains an
  append-order physical audit with archived and inactive records intact.
- `readConversationHistory()` and Runtime `sessions.conversation*` provide a
  separate ordinary-chat projection. Persisted logical/source provenance is
  authoritative; legacy folding additionally requires a valid compaction
  boundary and one unique topology suffix.
- Missing, conflicting, or non-unique evidence returns `partial` or
  `ambiguous`, includes structured issues, and retains all physical candidates.
  The implementation never globally sorts or deduplicates by content,
  timestamp, or `turnId`.
- Direct, page, and oversized-entry chunk reads share one immutable revision.
  Fork and rewind accept a returned physical boundary plus its exact source
  revision, and fail closed on stale or unknown boundaries.
- Post-compaction forks carry a compact provenance seed so their ordinary
  history preserves the selected source prefix without expanding active model
  context; cloned compaction boundaries are remapped to cloned entry IDs.
- Legacy suffix matching is linear in the path length. Cross-epoch fallback is
  allowed only for a contiguous, explicitly proven retained prefix whose full
  parent path predates the compaction in append order. Diagnostic evidence is
  bounded and counted in snapshot/page budgets, while all conversation records
  remain available.
- Regression coverage includes modern and legacy provenance, multiple
  compactions, inactive and indistinguishable branches, non-leaf ancestors,
  forward/corrupt topology, genuine repeated interactions, incomplete lineage,
  archived boundaries, stale mutations, oversized chunks, and embedded/daemon
  contract parity.

### 256: Windows child containment cannot prove descendant closure after an intermediate parent exits

- **Priority**: High
- **Status**: Open
- **Introduced**: Windows LLM, MCP, daemon-startup, and Worker-owned child processes
- **Fixed**: v0.7.86 partial mitigation; post-v0.7.87 follow-up unassigned
- **Created**: 2026-08-01
- **Resolved**: -

#### Problem

The identity-checked Windows process-tree implementation prevents PID-reuse
mis-kills and reports `unknown` instead of false success, but Toolhelp/CIM
snapshots are observations rather than kernel containment. If an intermediate
child exits before a later snapshot, an already-running grandchild can become
unreachable from the root ancestry. Because this historical gap is no longer
observable, cleanup can still report `terminated`; natural root exit can also
leave LLM, MCP, or daemon-startup teardown incomplete. Worker-owned registry
records share the host process identity, so another thread cannot prove that
the owning Worker is gone while the host remains alive.

#### Current Mitigation and Required Resolution

Known, observable uncertainty now fails closed. Every retained exact
`(pid, creationTime)` identity is offered for termination even when a fresh
snapshot is unavailable or the captured ancestry is incomplete; cleanup never
falls back to a bare PID. An incomplete capture remains `unknown`, and managed
paths retain or quarantine the available recovery evidence. An explicit cleanup
of a live root surfaces a typed incomplete result. If the root had already
exited naturally, LLM and daemon-startup callers preserve the completed
business result while retaining any managed evidence. MCP `close()` instead
surfaces its typed retryable error because the same retained evidence blocks
reopen; it never reports a clean transport close while descendants remain
unverified. This does not detect the
lost-ancestor case described above, and LLM execution has no durable
managed-registry evidence. Once both owner and root are confirmed gone,
permanently non-actionable incomplete or older-version registry records are
atomically moved with their original bytes to `children/.unresolved`; subsequent
starts scan only the active registry root. Live or identity-unknown old owners
remain in place for mixed-version unregister. A complete retained tree is still
cleaned by exact `(pid, creationTime)` evidence when the root PID has been reused,
without touching the replacement process. These startup bounds do not close the
containment gap. A complete fix requires spawn-time Windows Job Object
containment (assignment before user code can create descendants), plus a
host-issued Worker owner lease that can be invalidated independently of the
process PID. A post-spawn Job Object assignment or another bare-PID fallback is
not sufficient because it retains a child-spawn race or reintroduces PID-reuse
risk.

The 2026-08-02 review follow-up also replaced repeated full PowerShell process
snapshots during each 50 ms wait interval with lightweight captured-PID liveness
checks. A full identity snapshot is still required before reporting a complete
tree gone, and is taken when the captured PIDs appear gone or at the deadline.
This lowers steady cleanup CPU cost without weakening the identity fence.

The 2026-08-04 decision explicitly reschedules this issue to `v0.7.84`. The
identity-checked snapshot mitigation above remains the v0.7.79 behavior; the
remaining spawn-time Job Object / Worker owner-lease closure work no longer
blocks the v0.7.79 release.

#### 2026-08-06 daemon containment slice (v0.7.83)

The daemon-owned half of this issue is implemented in the v0.7.83 release. On
Windows, the daemon is created suspended, assigned to a
kill-on-close Job Object, and only then resumed. A supervisor outside that Job
terminates remaining descendants after the daemon exits and itself exits only
after Job accounting reports zero active processes. The daemon lock publishes
that containment boundary, while `waitForRuntimeDaemonShutdown()` requires the
exact durable cleanup outcome, daemon exit, and supervisor exit before an SDK
host may treat shutdown as complete. Final daemon cleanup can therefore retire
incomplete current-owner registry evidence without a bare-PID kill, and it no
longer installs redundant synchronous child-tree exit hooks under containment.

This does **not** resolve Issue 256 as a whole. Worker-owned children still need
the separately scheduled host-issued owner lease before their lifetime can be
invalidated independently of the long-lived host PID. The issue remains Open
and the Worker owner-lease portion is scheduled for v0.7.86.

#### 2026-08-07 v0.7.84 release disposition

The v0.7.84 release resolves Issue 282's Actor settlement-recovery problem but
does not claim Issue 256's remaining Worker owner-lease closure. The current
schedule was v0.7.85 for the outstanding Worker-owned child lifetime boundary;
no containment completion was implied by the v0.7.84 release.

#### 2026-08-11 v0.7.85 release disposition

The v0.7.85 release adds the daemon and per-effect Job containment slices, the
repo-intelligence Worker idle retirement, and the Runtime startup replay
optimization, but it does not add the outstanding Worker owner lease required
to prove descendant closure after an intermediate parent exits. Issue 256
remains Open and is explicitly rescheduled to v0.7.86; this release makes no
stronger containment claim.

#### 2026-08-12 v0.7.86 release disposition

The v0.7.86 release adds durable Windows ACL owner markers, serialized recovery
across Runtime profiles, process-tree termination attestation before ACL
recovery, and fail-closed no-replay behavior when Shell effects are not proven
drained. It also adds process-start identity to Runtime and learning locks and
resolves Issue 291's abandoned-inline-owner recovery boundary.

These slices narrow the observable and per-effect risks but do not add the
host-issued Worker owner lease required to prove descendant closure after an
intermediate parent exits. Issue 256 remains Open and its remaining closure
work was scheduled for v0.7.87 in this release disposition.

#### 2026-08-14 v0.7.87 release disposition

The v0.7.87 release is limited to GLM provider compatibility and documentation.
It does not add the host-issued Worker owner lease required for descendant
closure. Issue 256 therefore remains Open after v0.7.87, and this release does
not assign a replacement target.

#### 2026-08-18 v0.7.92 filesystem-effect convergence slice

The v0.7.92 release closes the same-process orphan-ticket and released
filesystem-effect owner path observed under a long-lived daemon. Queue entries
now heartbeat one operation token, that token fences the exact coordinator
lock, and a durable token-scoped release proof lets later work retire only the
matching completed effect while the daemon PID remains alive. An exact active
lock or an unproven bound process tree remains fail-closed.

This resolves the stale-ticket and recorded-release slice. Managed finalization
no longer waits for repo/task projections, so this failure cannot keep the Run
active and thereby suppress orphan-idle daemon exit. It does not prove
descendant closure after an intermediate parent exits or revoke an exact active
coordinator lock owned by a live process; Issue 256 as a whole remains Open.

### 255: Runtime teardown and cancellation could report completion across indeterminate lifecycle boundaries

- **Priority**: High
- **Status**: Resolved
- **Introduced**: Runtime SDK lifecycle and daemon protocol
- **Fixed**: v0.7.79 development
- **Created**: 2026-08-01
- **Resolved**: 2026-08-01

#### Original Problem

Several independent lifecycle paths collapsed an unverified outcome into
success. Windows process cleanup treated an unavailable process snapshot like
an empty tree. Actor shutdown could wait on durable settlement before aborting
local work, then clear nonterminal turns and ownership in separate writes.
An indeterminate event commit retained coalescing buffers, while a failed first
close could make a repeated Runtime close appear successful. Runtime status
locks were reclaimed by age before owner liveness and had neither acquisition
tokens nor process-start identity. Finally, daemon cancellation did not wake
`run.await` or `agents.wait`, and a late request completion could remove a newer
request that reused the same ID.

#### Resolution

Process-tree termination now has explicit `terminated`, `already-exited`, and
`unknown` outcomes. Windows cleanup retains the root creation identity from
spawn time, treats unreadable or late descendants as unverified, and terminates
only through a process handle whose creation identity is checked atomically.
Managed records compare exact registration and owner-process identities and
retain the strongest captured tree evidence after natural root exit without
promoting an incomplete capture. Recognizable records from older registry
versions are retained with a diagnostic instead of being discarded as corrupt.
MCP close retains its host-exit hook and manual cleanup record and
throws a typed retryable incomplete-cleanup error on `unknown`. Actor shutdown
closes local admission and aborts work synchronously, then persists interrupted
turns plus owner release atomically; both a pre-existing settlement hang and the
final shutdown write are fenced and surfaced through a typed error. Healthy
Actor children may run without a generic deadline, while every explicit Stop or
Runtime close gets a bounded finalization grace and remains `unknown` if
durability is not confirmed.

Event-bus poison now drops pending/coalesced state, rejects later emission, and
performs teardown before rethrowing the same close failure on every attempt.
Determinate persistence failures retain one bounded batch behind a backpressure
latch and require an explicit flush retry, preventing memory growth and 50 ms
retry storms; an oversized emission bypasses the retry queue and is persisted
synchronously, so failure is surfaced without retaining the payload, while a
failed direct durable write does not create an unretryable empty-queue latch.
Status locks atomically publish a complete owner record, fail closed on malformed
or unknown ownership, compare OS-derived process-start identity, use monotonic
deadlines and exact-token release, and serialize crash recovery with unique
bakery claims so stale reclaim/cleanup gates have no recursive recovery layer.
Hard-link publication falls back to exclusive creation where unsupported, and
a persistent candidate-cleanup failure disables further candidates for that
exact lock family until cleanup succeeds. Daemon request
records and subscription ownership are identity-checked; cancellation reaches
the underlying Actor waiter from inline, Worker, and daemon facades without
translating to durable Run abort, and
cancel/ack control frames cannot bypass the request-ID fence.

The 2026-08-02 review follow-up bounded normal Actor finalization as well as
explicit cancellation. A root Run that completes while an external child never
settles now becomes durably `unknown` after 30 seconds (explicit cancellation
keeps its shorter five-second grace), publishes that state, retains the Session
fence, and emits no false terminal completion.

#### Verification

- Process-tree, managed-child, and MCP tests cover spawn-time PID identity,
  exact-handle termination, late/unreadable descendants, registration ABA,
  natural root exit, spawn failure, retryable unknown cleanup, and confirmed cleanup;
  LLM executor tests verify unknown termination is surfaced.
- Actor controller tests cover immediate local abort, admission closure,
  pre-existing settlement hangs, atomic owner release, late-write fencing, and
  stable typed shutdown failure.
- Runtime tests cover live/malformed-owner lock refusal, dead-owner/PID-reuse and
  stale reclaim/cleanup-gate recovery, orphaned owned-lock cleanup, determinate
  backpressure, direct durable-write recovery, oversized direct persistence,
  bounded persistent candidate cleanup,
  poisoned event-bus bounds, stable repeated
  close failure, same-flight transcript cloning, post-delete materialization,
  8 KiB coalescing, and finalization bounds for AbortSignal and `runs.abort()`.
- Daemon protocol/client tests cover cancellable `run.await`/`agents.wait`, underlying
  waiter release, absence of accidental Run abort, control-frame ID fencing,
  pre-completion ack refusal, and reused request-ID/subscription ABA protection.

### 254: First v0.7.78 Session reconciliation replays historical messages as new lineage entries

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.78 lineage reconciliation
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-31
- **Resolved**: 2026-07-31

#### Original Problem

On the first full reconciliation of an upgraded v0.7.78 Session, a later
same-content replay sibling with a physical compaction-context child could win
the content-based branch search instead of the persisted active path. The
remaining active suffix was then recreated with new IDs and no reliable source
provenance. The reproduced Session added 61 historical copies with no new
input, or 62 records when only one new query was supplied. The copies covered
user, assistant, thinking, tool call, and tool result content, so a consumer
could not safely distinguish corruption from an intentional repeated message.

#### Resolution

The implementation treats a complete, positionally equal persisted active
context as identity evidence, preserves its exact entry IDs and provenance, and
appends only the suffix after the known active leaf. The suffix deliberately
does not content-match abandoned siblings, so a user can repeat identical
content without being collapsed. Independent review found no P0-P2 issue.

#### Verification

- A sanitized v0.7.78 replay/compaction fixture reproduces the old failure and
  covers thinking, text, tool use, tool result, and ordinary turns.
- No-input reconciliation preserves every ID; adding one same-content query
  adds exactly one new ID; a JSON round-trip followed by repeated
  reconciliation adds nothing.
- The real reported Session was inspected read-only: the fixed algorithm adds
  `0` entries without input and `1` entry for one new query, versus `61` and
  `62` before the fix.
- Runtime persistence coverage writes the no-change handoff, reloads it, then
  adds one query and proves direct and paged transcript IDs have identical
  entry sets and order.
- The 71-test lineage suite and 236-test Runtime suite pass, including immediate
  compaction provenance and repeated reconciliation coverage.

### 253: Parallel quality-strategy admissions conflict on unrelated Actor progress

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.77 quality-strategy admission
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-31
- **Resolved**: 2026-07-31

#### Original Problem

A parallel `spawn_agent` wave with `quality_strategy` metadata read one global
Actor-tree revision for every branch. The first accepted child advanced that
revision, then ordinary child progress advanced it again before the remaining
branches retried. Because strategy admission allowed only one revalidation,
valid sibling branches could exhaust the retry and fail with
`revision_conflict` despite available capacity and a still-valid stage.

The conflict was introduced with revision-fenced strategy admission in v0.7.77;
the intervening v0.7.79 changes did not create it. Existing tests exercised
strategy spawns sequentially and did not cover a progress-producing parallel
wave.

#### Resolution

Actor snapshots now carry an additive admission revision that changes only when
Actor or Turn state relevant to admission changes. Progress and mailbox updates
continue to advance the full tree revision for persistence and general
optimistic concurrency, but no longer invalidate strategy admission. Older
snapshots and custom clients remain compatible by falling back to the full tree
revision.

The Coding collaboration adapter also serializes only the short admission
critical section, using a stable scope shared by every client bound to the same
Actor tree. Child execution remains parallel. The existing bounded
revalidation remains in place for genuine concurrent stage, capacity, and
terminal-state changes.

#### Verification

- A RED regression reproduced the reported behavior exactly: one of three
  parallel strategy spawns succeeded and two failed with `revision_conflict`.
- Three parallel strategy spawns now all succeed while the first child emits
  progress, including when each call uses a separate client binding; the
  equivalent attributed follow-up wave also succeeds.
- Controller coverage proves progress and mailbox append/drain do not advance
  the admission revision, while a real Turn-admission change still rejects a
  stale admission mutation. A field-less legacy snapshot derives the safe full
  revision fallback and persists the independent fence on its next admission.
- Independent review repeated the separate-client three-way admission stress
  test 20 times; every round admitted all three Turns.
- Agent and Coding builds pass, together with the Actor and collaboration test
  suites.

### 252: Cancelled shell environment probes can return before descendants terminate

- **Priority**: High
- **Status**: Resolved
- **Introduced**: configured-shell environment probing
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-31
- **Resolved**: 2026-07-31

#### Original Problem

When the final caller cancelled an in-flight configured-shell environment
probe, its waiter returned the cancellation result immediately after signalling
the shared resolver. Process-tree termination continued in the background. On
Windows, `taskkill /t` success was also verified against only the root PID, and
descendants were discovered only after the root could already be gone. A missed
Node child could become untraceable and continue running after cancellation.

#### Resolution

Cancellation remains immediate for a caller that leaves another shared waiter,
but the final waiter now awaits the bounded probe promise and its process-tree
cleanup before returning. Windows termination snapshots descendants before
`taskkill`, verifies the root and every captured descendant, and uses the same
snapshot for direct fallback termination if any target survives. Captured PIDs
are matched against their Windows process creation identity immediately before
direct termination so PID reuse cannot target an unrelated process. CIM/WMI and
WMIC identity-bearing snapshots back up the native Toolhelp path, and timeout
or output-overflow completion observes the same cleanup barrier as cancellation.
The same contract is applied to the dependency-light LLM process-tree
implementation.

#### Verification

- Replaced the timing-only marker test with a deterministic child-PID handshake
  and post-cancellation liveness assertion.
- Repeated the formerly failing cancellation regression three times after the
  fix; all runs passed.
- The real nested Windows process-tree test and all 21 shell resolver tests pass.

### 251: Published Runtime Worker resolves a handler sidecar that is not shipped

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.66 Worker-hosted Runtime
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-31
- **Resolved**: 2026-07-31

#### Original Problem

The constructed-handler client assumed its worker was always named
`handler-worker.js` beside the importing module. That is true for the
independently built coding package, but the root npm and Runtime Worker bundles
ship only `dist/constructed-handler-worker.js`. A constructed tool could
therefore fail only after deployment with a missing worker sidecar.

#### Resolution

Worker resolution now distinguishes the four real layouts: package-local
`dist/construction`, root distribution bundles, split SDK chunks, and a Bun
standalone executable. Root and bundled layouts select the published
`constructed-handler-worker.js`; package-local development retains its existing
`handler-worker.js` contract.

#### Verification

- Added five resolver tests covering every layout and a real Worker startup.
- Rebuilt the npm bundle and verified both worker sidecars are present.
- Rebuilt and smoked the win-x64 standalone artifact with the sidecars beside
  the executable.

### 250: Windows programmable commands use non-portable module paths and hide load failures

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: programmable command support
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-31
- **Resolved**: 2026-07-31

#### Original Problem

Programmable `.js` and `.ts` commands were imported from raw absolute
filesystem strings. Node treats a Windows drive letter as a URL scheme, so the
same command that worked on POSIX failed with `ERR_UNSUPPORTED_ESM_URL_SCHEME`
on Windows. The catch block then discarded the exception, leaving users with a
missing command and no diagnosis.

#### Resolution

Programmable modules are now imported through canonical `file:` URLs. TypeScript
loading is attempted against the actual runtime instead of assuming only Bun
supports it, preserving Node native type stripping and configured loaders.
Failures emit an actionable diagnostic; TypeScript diagnostics suggest enabling
a loader or compiling the command to JavaScript while discovery continues.

#### Verification

- Added six tests for JavaScript and TypeScript file URLs, real command loading,
  loader-capable TypeScript execution, and non-fatal error diagnostics.
- Rebuilt the root CLI bundle and declaration artifacts successfully.

### 249: Standalone executable re-enters KodaX when launching JavaScript children

- **Priority**: High
- **Status**: Resolved
- **Introduced**: Bun standalone child integrations
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-31
- **Resolved**: 2026-07-31

#### Original Problem

Several integrations treated `process.execPath` as a general JavaScript
interpreter. In a Bun-compiled distribution it is the KodaX executable, so a
Skill tool, configured-shell environment helper, or project-local Node LSP
could re-enter the CLI instead of running the requested script. Skill sidecars
also depend on packages that are compiled into KodaX but are not separately
installed beside the executable.

#### Resolution

- Added a shared JavaScript-child launch contract. A Bun standalone child uses
  `BUN_BE_BUN=1`; Node and Electron retain their existing interpreter modes.
- Project-local Node LSP discoveries now carry JavaScript ownership through to
  spawn, while legacy custom launches still infer it from `process.execPath`.
- Bundled Skill tools use a guarded private dispatcher inside a fresh KodaX
  child, so `yaml`, `fflate`, and SDK dependencies stay embedded. Its one-shot
  authorization flag is consumed before any tool or descendant process runs.
- Added explicit module-bundle guards to the Skill script graph and matching
  compile-time definitions to npm and standalone builds.

#### Verification

- Added and ran 57 focused Node, Electron, Skill, shell-probe, and LSP tests.
- The real win-x64 executable executed a JavaScript `-e` child, validated the
  built-in Skill, and produced a non-empty `.skill` package.
- The artifact smoke proves the packaged YAML and fflate dependencies work
  without a sibling `node_modules` directory.

### 248: REPL Session IDs collide for contexts created in the same second

- **Priority**: High
- **Status**: Resolved
- **Introduced**: legacy REPL Session ID generator
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-31
- **Resolved**: 2026-07-31

#### Original Problem

The REPL generated Session IDs from `YYYYMMDD_HHMMSS` only. Two legitimate
contexts created in the same second received the same storage identity, making
rapid startup, recovery, or concurrent clients overwrite or ambiguously load
one another. A previous test checked only the format and never asserted the two
IDs differed.

#### Resolution

The Agent package now owns a shared synchronous generator using the readable
local timestamp plus base36 milliseconds and 48 cryptographically random bits. The established asynchronous
`generateSessionId()` API delegates to it, and both classic and Ink REPL paths
reuse the same primitive.

#### Verification

- Generated 1,000 unique synchronous IDs and 1,000 unique asynchronous IDs
  while wall-clock time was frozen.
- Created 1,000 REPL contexts at one frozen instant and asserted every Session
  identity was distinct.
- Existing title extraction and Session API compatibility tests remain intact.

### 247: Runtime cold Session snapshots repeat storage reads, locator scans, and materialization

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.79 development
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-31
- **Resolved**: 2026-07-31

#### Original Problem

The first Runtime observation loaded admission metadata and then independently
read the full transcript. Strict storage capture read the main Session and each
sidecar twice, while every id-only read repeatedly scanned every project
directory. Concurrent first observations, pages, and searches also serialized,
hashed, and materialized the same transcript independently. Finally,
`sessions.load()` emitted a durable `session.loaded` event, so a read-only call
could synchronously allocate and persist an event sequence.

#### Resolution

- Added one immutable storage capture that returns admission metadata, the full
  transcript input, and a byte-derived source revision from one read of the main
  payload and each present sidecar. File-handle and final-path identity checks,
  writer/migration/journal fences, version validation, and corruption handling
  preserve the existing fail-closed boundary without a second payload read.
- Added a process-wide, sessions-root-scoped Session locator index. Exact paths
  are learned by create/list/read, moved by archive/unarchive, and removed by
  delete/retention cleanup. A disappeared cached target falls back to strict
  discovery, while missing results are not negatively cached across processes.
- Added per-Session capture single-flight and per-source-revision transcript
  materialization single-flight with independent waiter cancellation. The
  materializer encodes each entry once, computes the transcript revision and
  chunk digests once, and commits no snapshot after cancellation or close.
- Runtime observe, fresh page, search, diagnostic, and direct transcript reads
  reuse the unified capture. Revision-bound cursor and oversized-entry reads
  continue from immutable snapshot storage without touching source JSONL.
- Made `sessions.load()` a pure read by removing its durable
  `session.loaded` emission. Provider-bind compatibility events keep their
  existing contract.

#### Verification

- Added deterministic read-count tests proving one main/sidecar payload read
  per strict capture and zero sessions-root scans after a path is indexed.
- Added concurrent observe/page/search and cancellation regressions proving one
  source capture, one full materialization/hash, independent waiter budgets,
  mutation invalidation, and no late snapshot commit.
- Added a read-only Runtime regression that byte-compares replay and event
  sequence state before and after load/list/status/transcript/page/search/chunk,
  observation, diagnostics, and settings reads.
- Passed 88 storage tests, 45 Session public-API tests, 236 Runtime tests, 45
  daemon protocol tests, and the complete release build.

#### 2026-08-01 bounded paging and startup follow-up

Space additionally requires the first finite `conversationPage({ sessionId })`
to stay independent of total canonical history size after a Session has been
prepared, while preserving canonical order and revision consistency. Direct CLI
startup also exposed repeated Windows owner queries, eager tool-output reference
scans, serial Runtime owner probes, synchronous cold-locator candidate stats,
and serial Git metadata probes.

- Added a revision-fenced derived conversation data/index generation beside the
  Session bundle. Normal saves build it, simple lineage appends extend it, and a
  cache-less legacy Session performs one canonical full-read upgrade. Prepared
  pages and oversized-entry chunks read only the requested fixed index window
  and content; any source-boundary change requires a fresh first page.
- Bound the shared-daemon admission check to the same canonical source boundary
  by storing only `surface`/`profileId` in the page manifest. Admission now runs
  before cursor, capacity, or entry checks without reparsing the Session. Cache
  generation races become an explicit fresh-read/resync result, and a failed
  old-generation cleanup cannot invalidate the newly committed generation.
- Kept direct full-history reads exact. No timestamp, sequence, content
  deduplication, or UI visibility semantics were added.
- Prevented long linear lineages from scheduling pointless full maintenance
  rewrites after every append; disconnected histories still use the existing
  archival path.
- Batched Windows managed-owner identity lookup into one cleanup-boundary
  snapshot, deferred reference-aware tool-output housekeeping until 30 seconds
  after startup, bounded Runtime owner probes to 16 concurrent unique owners,
  made cold candidate stats asynchronous in batches of 48, and queried Git
  common-dir and branch concurrently after resolving the repository root.
- Added revision-fenced durable per-ID Session location hints. A stable hint
  verifies one exact path (or the complete legacy ambiguity set) with constant
  metadata/stat work; topology epoch, per-Session writer, archive, delete, and
  managed cross-process changes plus raw payload-identity changes invalidate it
  and fall back to authoritative discovery. SDK-created random IDs use an
  atomic exact-target create path, so
  opening a new Session no longer performs an all-project negative lookup;
  explicit caller IDs retain the global conflict check.
- Added a durable Runtime run-status index. The first post-upgrade start scans
  legacy statuses once; later starts restore every indexed active Run plus at
  most 200 recent persisted Runs instead of synchronously parsing the entire
  historical `runs/` tree. Older terminal Runs remain addressable by exact ID.
  The canonical `status.json` commits before its derived index, and directory
  plus pending-file identities force recovery after an interrupted index write
  or a mixed-version writer publishes into a pre-existing directory. A live
  Runtime publishes new active membership incrementally and keeps the index
  explicitly dirty until a stable close/start reconciliation; terminal
  transitions are batched, but the first transition against a clean index
  durably marks it dirty. That fast path is fenced by the index file identity,
  so another Runtime cannot clean the index behind an older writer's in-memory
  state. Startup also repairs bounded stale active/recent membership from the
  indexed status files it already reads. More than 1,000 simultaneously
  missing or malformed status files is an explicitly
  pathological compatibility boundary: startup performs one authoritative
  fail-closed scan and emits one aggregate diagnostic instead of repeating the
  scan three times. Such files are not moved because one may be an older writer
  between directory creation and status publication.
- Removed the second main-JSONL payload read from the append hot path, reused
  immutable Conversation data/index files when a full save leaves the
  canonical projection unchanged, and bounded manifest/descriptor/chunk cache
  allocations even for corrupt derived files.
- Added `bench:session-cold-open`. On the Windows verification host, a tiny
  indexed Session opened in 15.7 ms mean with 10 project directories and 15.8
  ms with 300; after an unrelated write the corresponding means were 14.4 and
  14.5 ms. The uncached authoritative path measured 19.2 and 27.9 ms. Every
  sample materialized the transcript and left no snapshot file after close.
- Added `bench:conversation-page-cold-open`. On the Windows verification host,
  the shared-daemon path returned a prepared 20-entry tail in 2.8, 4.6, 4.4,
  and 4.4 ms mean across 2, 200, 2,000, and 5,000 canonical entries (all p95
  values at or below 5.0 ms). The intentional one-time legacy upgrade averaged
  30.2, 35.6, 56.4, and 87.0 ms respectively.
- Added `bench:cli-first-ready`, which launches the production bootstrap in a
  fresh process with an isolated existing config home and waits until the first
  classic-REPL input prompt before sending `/exit`. This covers ESM evaluation,
  Runtime recovery, managed-child cleanup, workspace Git probes, and REPL
  preparation rather than timing after Runtime construction. Five Windows
  smoke samples averaged 2,043.3 ms (p95 2,137.5 ms). Redirected stdio forces
  the classic surface, so this is shared bare-CLI startup evidence, not an Ink
  paint-latency claim.
- The final release build and full repository test suite passed. The Windows
  daemon smoke also now records exact process identity for timed test children
  and tolerates the narrow lock-loser exit race only after a healthy competing
  owner is confirmed; timeout, cancellation, and general failure cleanup remain
  fail-closed.

#### 2026-08-02 independent review follow-up

- Strict direct and paged conversation captures retry only a transient
  `data_changed` boundary twice (after 5 ms and 15 ms). A third mismatch is
  consistently returned as `resync_required`; other failures are not retried.
- Legacy flat-message Sessions now get a deterministic read-only lineage
  projection for transcript search. Unchanged source bytes retain the same
  revision, citation, and entry/chunk address across Runtime restarts; no new
  persisted timestamp, sequence, content-deduplication, or visibility semantics
  were introduced.
- Incremental Conversation cache extension remains limited to a fully resolved,
  issue-free canonical prefix. Independent review proved that appending onto a
  partial projection can change both the canonical entries and status, so those
  Sessions deliberately take the full rebuild path.
- Append watermarks use weak, copy-on-write prefix identity plus the stable
  main-file identity; they no longer serialize or SHA-256 the complete history
  during `load()` or every append, and they do not keep discarded lineage
  graphs alive. A file identity is accepted only when it remains unchanged
  across the read, so an atomic replacement cannot bind old bytes to a new
  append watermark; strict reads instead return `data_changed` and require a
  fresh capture. An unavailable or changed prefix witness, including an
  explicit extension-record payload, takes the full-write path only after the
  durable file is proven to match its cached baseline. If another process
  changed that file first, durable same-ID state remains authoritative while
  both writers' genuinely new tails are retained during merge.

#### Reopened Findings

Independent verification found two locator-authority gaps after the initial
closure. A sessions-root traversal failure could still promote one observed
candidate to globally verified, and a cached positive result did not notice a
later same-ID candidate created by another process inside an already-existing
project directory. Both cases could return the wrong Session instead of
failing with `data_changed`. macOS also lacked a repeatable tiny-Session cold
observation wall-clock benchmark for the remaining unconditional temporary
materialization.

The follow-up implementation refuses authority after any incomplete traversal
and binds positive and negative cache entries to the sessions-root identity, a
durable location-topology epoch, and a writer witness. Managed create, archive,
unarchive, and delete operations advance the epoch under a cross-process
topology lock before exposing a location change. A v0.7.78 writer does not know
that epoch, so strict direct locators additionally watch the existing
per-Session lock queue. A stable all-project list first uses the global lock
directory as a traversal fence, captures one per-Session legacy-writer witness
for every discovered ID, then rechecks the global fence before committing the
index. A write to Session B therefore does not invalidate Session A, while a
same-ID legacy write does. Each witness includes both the persistent queue
directory and an active lock-file identity, closing the case where an old
writer already held the lock before listing and released it only after the
index commit. Candidate discovery uses explicit `stat` states:
only `ENOENT`/`ENOTDIR` mean absent; permission or I/O failures make the
traversal non-authoritative and strict reads fail with `data_changed`. Strict
reads validate the applicable witness, lock, and epoch before and after capture.
External creation of a new project remains detectable through the root identity.
Read-only APIs never create or advance the epoch or writer witness. Raw
filesystem mutations that bypass both the SDK lock protocol and the topology
epoch remain outside the managed storage contract.

The new `bench:session-cold-open` command writes a pre-existing two-message
JSONL fixture before constructing a fresh Runtime, so setup cannot prewarm the
locator, admission, or transcript caches. It separately measures direct cold
lookup, list-indexed observation, and list-indexed observation after an
unrelated v0.7.78-style locked write. It supports a 10-versus-10,000 project
matrix, records indexing and observation wall-clock samples plus machine
metadata, and reports temporary snapshot materialization and post-close cleanup.
macOS is the primary platform; other platforms are explicitly smoke-only.
Independent review found no P0-P2 issue across the final locator authority,
materialization, read-only API, benchmark, and cancellation implementation.

### 246: Runtime coalescing release closure could reuse legacy daemons, exceed 8KiB, and mis-test cancellation

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.79 development
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-31
- **Resolved**: 2026-07-31

#### Original Problem

The source-level Runtime event coalescer from Issue 244 was implemented, but
three release-closure gaps remained:

- auto-start clients required Runtime Auto v4 but had no independent capability
  requirement for event coalescing, so an already-running v0.7.78 daemon could
  be reused after the npm package was upgraded;
- the 8KiB threshold was checked after two compatible fragments were merged,
  allowing two 7KiB fragments to become one roughly 14KiB public event; and
- the ACP queued-cancellation test used a no-op executor `abort()` with a result
  that never settled, while expecting Runtime to manufacture cancellation. That
  contradicted the confirmed-Stop contract and made the test fail reliably.

#### Resolution

- Added the independent versioned `runtimeEventCoalescing: 1` capability to the
  SDK fact set, Runtime requirements/assertion path, embedded and Worker
  metadata, and daemon host response. Daemon capability overrides cannot forge
  it.
- Auto-start now requires the capability and uses the existing governed daemon
  upgrade fence. An idle legacy daemon is rolled back and replaced; active or
  queued governed work produces a recoverable upgrade-required error without
  force-stopping the daemon.
- Compatible append fragments now check the accumulated byte size before
  merging. The previous ordered batch flushes first when the next fragment
  would exceed 8KiB. A single provider fragment larger than 8KiB remains intact
  because splitting provider-owned semantic units was not part of the contract.
- The ACP fixture now resolves the executor result as interrupted from
  `abort()`. ACP still returns `stopReason: cancelled` for both prompts, while
  Runtime truthfully records the active run as `interrupted` and the never-
  started queued run as `cancelled`.

#### Verification

- Added explicit attach-only capability rejection and daemon-host
  non-forgeability assertions.
- Added idle v0.7.78-compatible daemon replacement and governed-work refusal
  regressions where Runtime Auto v4 is already present and only coalescing is
  missing.
- Added a 7KiB + 7KiB text regression that requires two ordered events, exact
  concatenated text, and no merged event above 8KiB.
- Kept the ACP settlement deadline unchanged and verified real abort
  acknowledgement plus the distinct Runtime terminal phases.
- `npm run build`, all 230 `sdk-runtime` tests, and all 66 daemon upgrade,
  dispatcher, and ACP tests pass.

### 245: Windows sandbox runner cannot launch from a user-level global npm install

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.78 Windows ASRT integration
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-31
- **Resolved**: 2026-07-31

#### Original Problem

On a clean Windows 11 machine installed with `npm install -g`, both
`kodax sandbox setup` and `kodax sandbox doctor` could report
`CreateProcessWithLogonW(srt-sandbox): Access is denied (0x80070005)` while
the Secondary Logon service was running, the `srt-sandbox` account was enabled,
and the account belonged to the built-in Users group.

The packaged `srt-win.exe` and the inherited process working directory were
under the real user's private profile, commonly
`%APPDATA%\npm\node_modules\...` and `%USERPROFILE%`. The dedicated sandbox
account therefore could not start the WFP verification runner. The diagnostic
incorrectly suggested a Secondary Logon service failure, and the readiness
check considered only part of the account-provisioning state.

#### Resolution

- KodaX now copies the packaged runner into a version, architecture, and
  content-addressed directory under
  `%KODAX_HOME%\sandbox-runtime\runner`, verifies the bytes, and resolves every
  Windows ASRT session to that exact copy.
- The dedicated sandbox account receives read/execute access only to the
  prepared directory and executable. KodaX does not widen ACLs on the
  user-owned global npm installation tree.
- Every sandbox policy explicitly permits runner reads and denies runner
  writes, including SDK policies whose caller grants write access to a broad
  parent directory.
- Doctor and every ASRT initialization child use the prepared directory as
  their working directory. The doctor WFP probe retains the 30-second bound and
  reports stable failure codes for runner launch access, Secondary Logon,
  timeout, inactive fence, and other probe failures.
- Readiness now checks the account SID, local group/SID, built-in Users
  membership, sandbox group membership, hidden-logon state, and credential
  presence before attempting the WFP probe.
- Preparation is atomic and content-addressed so concurrent KodaX processes do
  not replace an executable in use. Existing bytes must match before reuse.

#### Verification

- Added Windows regressions that emulate a runner installed beneath a private
  global npm path, verify the protected copy and read-only ACL grant, require a
  safe probe working directory, and reject an incompletely provisioned account
  before WFP execution.
- Standalone SDK, Skill-script, and workspace-session tests verify that the
  exact prepared runner is propagated, protected by `denyWrite`, and used as
  the ASRT child working directory.

### 244: Runtime streaming deltas create an event, sequence-allocation, and persistence storm

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.64 Runtime event contract
- **Created**: 2026-07-31
- **Fixed**: v0.7.79 development
- **Resolved**: 2026-07-31

#### Original Problem

Long Runtime runs can emit tens of thousands of tiny `thinking.delta`,
`assistant.delta`, and streamed tool-input fragments. A reported production run
produced roughly 25,000 thinking deltas averaging 3.8 characters and peaking
around 135 events per second. Every fragment currently becomes a public Runtime
event, receives its own globally locked sequence allocation, enters replay
storage, and is delivered separately to live subscribers. A restored Space
session must therefore keep receiving, sorting, reducing, and rendering this
micro-event stream even when only a small viewport is visible.

The existing 10ms/64KiB persistence buffer reduces physical
`events.jsonl` appends, but does not reduce public event count, listener
notifications, in-memory projection work, or atomic `event-sequence` cursor
updates. Frontend batching cannot remove that SDK-side amplification.

#### Context

- Components: `src/sdk-runtime.ts`, Runtime event replay/session observation,
  embedded/Worker/daemon clients, and `src/sdk-runtime.test.ts`.
- Public names: provider `text.delta` maps to Runtime `assistant.delta`;
  provider `tool_input.delta` maps to the `tool.progress.partialJson` variant.
- Required identity: only consecutive events with the same Runtime, Session,
  Run, Turn, root/child context side, and event kind may merge. Tool-input
  fragments additionally require the same non-empty `toolId`; a tool name is
  never sufficient.
- Structural boundaries, replay/snapshot handoff, cancellation, failure,
  approvals, tool lifecycle, and terminal Run events must flush pending work
  immediately.

#### Root Cause

`wrapKodaXEvents()` synchronously forwards every provider/coding callback to
`createRuntimeEventBus().emit()`. The bus constructs an envelope immediately,
and `RuntimePersistence.nextEventSeq()` serializes an atomic cursor rewrite for
every envelope. Persistence buffers serialized JSONL lines afterward, which is
too late to reduce the dominant event/sequence/subscriber amplification.

#### Proposed Solution

- Add one Runtime-owned ordered emission buffer before envelope construction.
  Merge consecutive text/thinking fragments and same-`toolId` tool-input
  fragments for up to 50ms or 8KiB, whichever arrives first.
- Treat supported progress snapshots as latest-only within the same ordered
  window. Do not collapse stream/iteration completion or other lifecycle
  boundaries.
- Flush the ordered buffer before every non-coalescible event, durable event,
  subscription/replay/snapshot waterline, and Runtime close.
- Allocate one contiguous sequence range for each flushed batch and append the
  batch through one persistence call. Apply live projections and notify
  subscribers in exact sequence order only after persistence accepts the batch.
- Preserve exact concatenated text/JSON, use the latest attribution metadata
  for a merged fragment, and add `meta.toolId` to active-tool projection keys.
- Add stress and boundary regressions for long thinking/text streams, tool
  arguments, missing/different tool IDs, latest-only progress, error/cancel
  boundaries, observation snapshot plus incremental handoff, persistence
  recreation, and replay ordering/content equivalence.

#### Resolution

- Added a pre-envelope ordered buffer that merges only adjacent compatible
  assistant/thinking/tool-input fragments, flushing at 50ms or 8KiB. Tool
  input requires the same explicit non-empty `toolId`; progress preserves its
  first sample and publishes the trailing latest value at no more than 20Hz.
- Flushes every structural, lifecycle, replay/snapshot, disconnect, and
  shutdown boundary before it becomes observable.
- Reserves one contiguous sequence range and appends one same-Run batch while
  holding the shared sequence lock. Projection and notification advance only
  after the append commits; failed retries abandon the reserved range so
  another Runtime cannot create late lower-sequence events.
- Rolls back partial appends and repairs an interrupted final JSONL record.
  If append and rollback both fail, the Runtime latches an indeterminate commit
  and disables retry. Post-commit trim, warning, or lock-cleanup failures cannot
  replay an already committed batch.
- Preserved the one-event-per-line replay format and added stress, cross-Runtime,
  reconnect/watermark, progress, tool identity, partial-write, cancellation,
  error, and cleanup-failure regressions.

#### Expected Outcome

Semantic text/tool input and lifecycle ordering remain unchanged while public
event count, sequence cursor writes, persistence records, subscriber callbacks,
and projection CPU work fall by orders of magnitude on micro-delta streams.

### 243: Runtime Worker omits configured A2A Agents from dispatchable catalog and execution

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.66 Worker-hosted Runtime
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-30
- **Resolved**: 2026-07-30

#### Original Problem

A v0.7.78 Runtime Worker with an enabled loopback A2A Agent returned only
`native:kodax-child` and constructed local Agents from
`list_dispatchable_agents`. The configured `external:mock-callee` entry was
absent, and an explicit external spawn would fail even though
`kodax a2a test` and `kodax a2a call` succeeded against the same Card.

The supplied session log and analysis correctly localized the missing
Worker-owned executor plane. One evidence detail required correction:
`kodax a2a call` creates a temporary CLI-owned executor plane for that call; it
does not prove that a daemon registry contains the Agent.

#### Context

Function-valued custom executor factories cannot be structured-cloned across a
Worker boundary. The existing SDK therefore rejected parent-side
`externalAgents` injection, but the bundled Worker owner offered no serializable
way to install KodaX's built-in configured A2A integration itself. Without a
plane, catalog fallback was truthfully limited to local descriptors.

#### Root Cause

`src/runtime-worker/entry.ts` created an inline embedded Runtime from primitive
bootstrap fields only. It did not construct
`createConfiguredA2ARuntimeIntegration`, pass its `runtimeOptions` into the
inner Runtime, reconcile `a2a.json`, or close its watcher during shutdown.
Consequently `dist/runtime-worker.js` contained no reachable configured A2A
executor/registration path and advertised `externalAgents: false`.

#### Proposed Solution

- Add one serializable, explicit `worker.configuredA2A` bootstrap permission.
- Resolve the same `<homeDir>/.kodax` configuration boundary inside the Worker.
- Let the Worker owner construct the built-in integration and complete
  reconciliation before it advertises readiness.
- Reuse the real executor plane for list, describe, preflight, spawn, task
  lifecycle, and cancellation rather than projecting catalog-only entries.
- Close the integration controller before Runtime Worker shutdown.

#### Resolution

- `RuntimeWorkerOptions` now accepts `configuredA2A`, defaulting to false so an
  SDK host explicitly opts into ambient user integration.
- The parent sends only the boolean bootstrap fact. The Worker owner resolves
  its config home, constructs the configured A2A integration, installs the
  executor plane in the inner Runtime, and reconciles registrations before the
  initialize response.
- Initialization advertises the real external-Agent capability. The same plane
  backs `listDispatchable`, `describe`, `preflight`, and external Actor task
  execution.
- Initialization failure closes a partially created Runtime, while normal
  shutdown closes the A2A watcher before closing the dispatcher and port.
- The bundle build now includes the reachable A2A executor and continues to
  pass the Runtime Worker sidecar and child-process audits.

#### Files Changed

- `src/runtime-worker/protocol.ts`
- `src/runtime-worker/entry.ts`
- `src/sdk-runtime.ts`
- `src/sdk-runtime.test.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `README.md`
- `README_CN.md`
- `CHANGELOG.md`

#### Follow-up (CLI config surface)

A follow-up report showed that the SDK option was not reachable from CLI
configuration: `config.json#worker.configuredA2A` was ignored because the CLI
never read the `worker` key and never passed it into the runtime creation. The
CLI now honors `worker.configuredA2A` in `~/.kodax/config.json` (embedded mode):
it creates the Runtime Worker with `worker: { configuredA2A: true }` instead of
the inline `externalAgents` plane, so the Worker owner loads the configured A2A
plane and `external:<name>` Agents appear in `list_dispatchable_agents`. The
mode rejects configured MCP servers or Extensions (they cannot cross the Worker
boundary); the default inline Runtime retains those capabilities while loading
configured A2A.

- `packages/repl/src/common/utils.ts` — `loadConfig` parses
  `worker.configuredA2A` from `config.json`.
- `src/kodax_cli.ts` — `getCliRuntime` selects Worker-hosted isolation and
  forwards `configuredA2A` when the config key is set.
- `config-templates/config.example.jsonc` — documents the `worker` block.

#### Tests Added

- A real loopback A2A server is configured under an isolated Worker home.
- Runtime initialization requires and receives the `externalAgents`
  capability.
- The Worker catalog contains `external:worker-a2a`.
- A Worker-owned external Actor dispatch sends a real A2A `SendMessage` request
  and reaches a completed output.
- Worker close releases the configured integration and server connection.

### 242: First launch opens metadata setup when no provider credential exists

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.73 first-run provider setup
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-30
- **Resolved**: 2026-07-30

#### Original Problem

On a first bare interactive launch with no configured provider and no supported
provider API-key environment variable, KodaX initializes configuration files
and opens a provider/model wizard. The wizard deliberately cannot write an OS
environment variable or accept an API-key value, so completing it does not make
the installation usable and can imply that setup is complete.

Expected behavior is a read-only first-launch credential check. When no
supported environment variable is detected, KodaX should list the supported
variable names, show Windows, macOS, and Linux setup methods, tell the user to
close and restart the terminal, and exit without entering the wizard or writing
configuration.

#### Context

Environment variables remain the credential source of truth. Explicit
`kodax setup` still has value for custom providers, provider/model changes,
configuration templates, and optional sandbox preparation; only automatic
first-launch behavior is in scope.

#### Proposed Solution

- Detect non-empty built-in and configured custom-provider credential
  environment variables after shell hydration.
- If none are present, print a secret-free cross-platform environment setup
  guide and return without creating files or starting the REPL.
- If a configured provider is missing its required credential, print the same
  guide narrowed to that provider's environment-variable name.
- Preserve explicit `kodax setup` and the existing flow when at least one
  credential is already available.

#### Resolution

- Bare interactive startup now checks the credential-variable names from the
  built-in provider catalog and configured custom providers after login-shell
  environment hydration.
- If no supported variable has a non-empty value, startup prints a read-only
  guide with the supported names, persistent Windows PowerShell, macOS zsh, and
  Linux bash instructions, then exits without initializing setup files or
  opening the provider/model wizard.
- If an existing provider selection is missing its credential, the same guide
  is narrowed to that provider's required environment-variable name.
- The guide never accepts or persists a key and explicitly tells the user to
  close the current terminal, open a new terminal, and rerun `kodax`.
- Automatic metadata setup remains available when a supported credential is
  already present. Explicit `kodax setup` and `kodax setup --custom` remain
  available for provider/model changes, configuration preparation, sandbox
  checks, and CLI-authenticated or custom providers.

#### Files Changed

- `src/provider-setup-cli.ts`
- `src/kodax_cli.ts`
- `src/provider-setup-cli.test.ts`
- `src/kodax_cli.interactive-exit.test.ts`
- `README.md`
- `README_CN.md`

#### Tests Added

- Credential detection ignores unrelated and blank environment variables.
- The guide lists unique provider variables, all three supported OS families,
  the terminal restart boundary, and the explicit setup escape hatch without
  including a key value.
- First launch with no credential prints guidance without initializing config,
  starting the wizard, REPL, or Runtime.
- A configured provider missing its credential receives provider-specific
  guidance.
- A supported credential preserves the existing metadata-setup path.

### 241: Standalone Bun binary executes every CLI command twice

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.72 lightweight resume bootstrap
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-30
- **Resolved**: 2026-07-31

#### Original Problem

The Windows v0.7.78 standalone executable runs ordinary CLI command handlers
twice. Non-interactive commands print two identical results; first-run provider
setup renders duplicate prompts, makes one typed digit appear twice across the
two readers, and asks for final confirmation twice. The selected numeric value
is still interpreted correctly by each handler.

Expected behavior is one command-handler invocation, one result, and one
interactive prompt sequence per process.

Reproductions:

- In a fresh `KODAX_HOME`, the official v0.7.78 Windows release binary prints
  two identical empty A2A documents for `kodax.exe a2a list`.
- The official v0.7.77 Windows release binary has the same behavior.
- The official v0.7.71 Windows release binary prints the document once.
- Running current `dist/kodax_bootstrap.js` or `dist/kodax_cli.js` through Node
  prints the document once.

#### Context

The defect affects the Bun-compiled standalone executable rather than the
provider, model, terminal echo setting, or Node/npm distribution. Read-only
commands duplicate output, while mutating commands can repeat side effects or
race their own revision checks. First-run setup remains metadata-only and does
not accept or persist an API-key value, but its two concurrent prompt flows
make that credential boundary especially confusing.

#### Root Cause

Commit `bd5c56ee` changed the standalone binary entry from
`dist/kodax_cli.js` to `dist/kodax_bootstrap.js`. The bootstrap dynamically
loads the CLI and explicitly invokes its exported `main()`. The CLI bundle also
retains its direct-entry guard:

`import.meta.url === pathToFileURL(process.argv[1]).href`

In the Bun single-file executable, both bundled modules observe the executable
as their module URL. The CLI therefore classifies itself as the main module and
auto-invokes `main()` while the bootstrap invokes the same export explicitly.
Node keeps the bootstrap and CLI as separate file URLs, so the same guard does
not duplicate the Node/npm path.

#### Resolution

- Restricted the CLI module's direct-entry path to non-bundled execution. The
  Bun standalone build already freezes `KODAX_BUNDLED=true`, so its bootstrap
  is now the sole startup owner and invokes `main()` exactly once.
- Preserved direct `node dist/kodax_cli.js` execution and the non-bundled
  Runtime daemon child path. No Actor ownership, CAS, or liveness rule was
  weakened; the observed owner conflict was the correct fence against the two
  live Runtimes created by the duplicate entry.
- Made the binary build run the compiled host artifact with a fresh
  `KODAX_HOME`, execute `a2a list`, and require stdout to parse as exactly one
  valid A2A v2 document. Concatenated duplicate documents now fail the build.

#### Verification

- Added direct-entry unit coverage for bundled, direct Node, and imported CLI
  ownership cases.
- Verified the Node bootstrap, direct CLI, and npm CJS shim each emit one A2A
  v2 document.
- Built and executed the real Bun standalone artifact; its `a2a list` output
  is one document and the host-artifact smoke gate passes.

### 240: Runtime lifecycle can remain active after executor settlement and history reads can hang or mutate legacy Sessions

- **Priority**: High
- **Status**: Resolved
- **Introduced**: Runtime SDK lifecycle and transcript observation
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-30
- **Resolved**: 2026-07-30

#### Problem

An executor could emit a complete reply while its result promise or first Actor
snapshot save was lost, leaving Run/Actor state permanently active. A second
Runtime opening the same store also unconditionally recovered every
non-terminal Run as crashed, even when the original executor was still alive.
At the same time, Runtime history reads used migration/recovery-capable Session
loading, lacked caller deadlines, and could mix an old main-file read with a
new sidecar boundary or silently downgrade incompatible/corrupt data.

The Space 0.1.34 field Session
`s_ce44c832-3994-4c4d-895a-57590853abe7` made the lifecycle ambiguity
concrete. Turn `turn_009c106ea37f4cf8` began at 2026-07-30 09:05:13 CST and
persisted its complete assistant text at 09:08:09, while the UI still reported
thinking roughly seven minutes later and Stop still had no terminal outcome
roughly nine minutes later. All 14 tool calls have matching successful results;
there is no child, external, or A2A Agent. One of three Todo items remained
`in_progress`, but Todo state is not itself a terminal gate. A non-empty Todo
does invoke the already-bounded Sidecar verifier; the separate extension
`turn:complete` hook was the unbounded finalization path found by code review
and therefore a plausible hang point, not a conclusion recoverable from this
historical JSONL alone.

The supplied JSONL contains no `runId`, `runtimeId`, terminal transition,
finalizer state, or Stop result, so it cannot retrospectively prove whether
the executor was in a finalizer, had ended without a delivered observation, or
was still alive. It also shows an older `lastError=runtime run aborted` and
`consecutiveErrors=1` surviving three later persisted Turns. That was a
separate merge bug: an explicit successful snapshot clear was interpreted as
"preserve the previous error".

#### Resolution

- Run persistence now carries private owner-liveness and revision metadata.
  A live owner remains authoritative across Runtime instances; a definitely
  dead owner is recovered to `interrupted`, while an owner that cannot be
  proven alive or dead is exposed as `unknown` without mutating its files.
  Ownerless legacy non-terminal records are also `unknown`; durable terminal
  events are reconciled first, while durable input-delivery evidence is applied
  only to the read projection. Status writes are serialized and a persisted
  terminal state cannot regress or publish a conflicting terminal event.
- Run phases now explicitly include `waiting_agent`, `recovering`, and
  `unknown`. `runtime.sessions.status(sessionId)` returns one authoritative
  Session projection from the current Run set in embedded and daemon modes.
  Stop preflight treats every non-terminal and `unknown` Run as a blocker.
- Run status also carries a fine-grained `stage`, `stageChangedAt`, and an
  authoritative `activeSubtaskCount` when the managed executor reports one.
  Managed status `completed` now means `stage: finalizing`: it closes the
  interrupt window but does not terminalize or release the Session until the
  outer executor result/callback settles.
- Stop is a durable request/result record. A queued Run can be cancelled
  immediately; an active Run becomes `phase/stage: unknown` with
  `stop.state/outcome: unknown` until the executor confirms what happened. If
  an executor ignores Stop and completes, the final status truthfully records
  `stop.outcome: completed`. Runtime close follows the same fail-closed rule.
  A terminal callback is latched before deferred result settlement, so a later
  Stop cannot rewrite an earlier completion as interrupted. Conversely, late
  verifier/recovery progress cannot revive a stopped `unknown` Run. Crash
  recovery resolves a pending Stop to `confirmed/interrupted`. Runtime close
  synchronously persists an already-latched executor terminal signal before
  releasing owner liveness, so another Runtime cannot recover that Run through
  the transient pre-terminal snapshot. It does not resolve the Run handle or
  drain the Session queue until the real executor result or the deferred
  lost-result fallback settles, preserving the full result payload and
  same-Session serialization.
  Rewind, active-entry changes, compaction, archive, and deletion remain fenced
  until that settlement finishes, even though the terminal phase is already
  durable.
- Executor terminal callbacks settle a Run even if the executor result promise
  is lost, while giving the same-turn result promise priority so its full
  `KodaXResult` is retained. Conflicting callbacks emit only the first terminal.
  Actor completion/failure settlement retries a failed durable commit with
  bounded backoff. Runtime shutdown flushes known settlements before releasing
  the owner/liveness fence, without duplicating terminal events or mailbox
  completion notices.
- Extension `turn:complete` hooks now have a 30-second fail-open watchdog and a
  structured diagnostic, preventing a third-party finalizer from keeping a
  complete reply active forever. The first-party Sidecar verifier retains its
  independent 15-second bound.
- Successful Session snapshots now clear stale `errorMetadata`; omission still
  preserves it. Full saves and append-delta saves both honor this three-state
  contract.
- Strict history reads acquire one Session boundary, read main and sidecars
  without migration, takeover, recovery, or repair, and expose stable
  `data_corrupt`, `version_incompatible`, `read_timeout`,
  `read_cancelled`, and `resync_required` errors. Paging retains a bounded
  immutable snapshot so active appends do not invalidate an in-progress read.
- Observation handoff now returns the snapshot before draining buffered events.
  Its bounded queue fails closed, and the returned `invalidated` promise
  reports overflow, event-order regression, transport loss, or Runtime change.
  Daemon timeout/cancellation removes the pending request and compensates a
  late observation response by unsubscribing it.
- `exportSessionBundle()` provides a read-only, byte-preserving export and
  compatibility diagnostic path for legacy, partial, corrupt, unsupported, or
  ambiguous Session bundles. `contentBase64` is the canonical lossless payload;
  byte lengths and hashes are computed from the original bytes.
- `captureRuntimeSessionDiagnostics()` uses a dedicated read-only Session
  diagnostic boundary in embedded and daemon modes. It reports
  SDK/Runtime/daemon versions, `runId`/`turnId`, phase/stage, terminal time,
  the Run-owned active child count when recorded, Stop and interrupt records,
  observation
  cursor/revision, and stable structured errors. Missing historical control
  data is explicitly `run_control_unknown`; the helper never resumes or takes
  ownership of a Session, invokes recovery/preflight, or consumes transcript
  paging-cache capacity. An absent Run-owned child count is returned as
  `activeSubtaskCount:null` with source `unknown`, rather than borrowing a
  later Session-wide sample. Failed Runs retain their structured failure
  reason. Owner, Stop, failure, and terminal-time errors are independent facts:
  the error array preserves every applicable code instead of selecting one.
  The helper applies the same timeout/cancellation budget to transcript,
  settings, permission, and owner-liveness inspection as history reads. In
  daemon mode `sdkVersion` identifies the calling SDK while
  `runtimeVersion`/`daemonVersion` identify the connected daemon, preserving
  version-skew evidence.
- Global event sequence and per-Session Run order allocation are serialized
  across Runtime processes. Cursor recovery expands past oversized tail records
  and validates a stale cursor against durable logs; retention writes a
  conservative watermark before replacing an event file, forcing resync rather
  than silently losing a gap.
- The message guard accepts persisted multimodal tool results and cache-boundary
  hints instead of silently discarding those valid historical records.

### 239: Session archive can pair a moved main file with an orphan destination sidecar

- **Priority**: High
- **Status**: Resolved
- **Introduced**: sidecar-aware Session archive/unarchive
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-30
- **Resolved**: 2026-07-30

#### Problem

When a source directory contained only `<id>.jsonl` but the destination already
contained an orphan `<id>.islands.jsonl` or legacy
`<id>.archive.jsonl`, archive/unarchive moved the main file successfully and
silently paired it with unrelated history.

#### Resolution

Modern and legacy sidecars are treated as one collision domain with their main
Session file. Archive and unarchive fail closed if any destination member
exists without its matching source member. Regression fixtures cover modern
and legacy sidecars in both directions and verify that all source and
destination bytes remain unchanged.

### 238: Durable island recovery can violate transcript append order and compaction clone provenance

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.74 durable compacted-history recovery
- **Fixed**: v0.7.79 development
- **Created**: 2026-07-30
- **Resolved**: 2026-07-30

#### Problem

`FileSessionStorage.loadFullLineage()` currently inserts every durable-island
sidecar entry before every retained main-file entry. When archive maintenance
retains a parent in the main file but moves its child into a sidecar, SDK
`loadFullTranscript()` can therefore expose the child before its parent and
break the documented raw append-order contract. The same recovered lineage
feeds Runtime transcript paging, so direct and paged transcript projections
must share one deterministic order across multiple archive batches, overlapping
physical copies, equal timestamps, and a crash-truncated sidecar tail.

Separately, `applySessionCompaction()` rematerializes protected tail messages
under the new compaction island through `createSessionLineage()`. Those physical
copies receive unrelated `logicalId` values and lose the original
`sourceEntryId`, contradicting the existing clone-provenance contract.

#### Root Cause

- `mergeFullLineageEntries()` uses map insertion order over
  `archivedEntries` followed by `mainEntries`; deduplication is stable, but no
  original-position or parent-topology constraint participates in ordering.
- Existing sidecars store entry bodies and batch IDs but no internal adjacency
  anchors, so historical cross-file interleaving can be only partially
  reconstructed.
- `applySessionCompaction()` creates a fresh physical message chain without
  transferring identity from matching entries on the pre-compaction active
  path.

#### Proposed Solution

- Persist internal previous/next lineage anchors on newly archived sidecar
  records without adding public timestamp or sequence fields.
- Merge unique main/sidecar entries with a stable topology-aware ordering:
  honor exact anchors, parent-before-child, main-file order, and per-batch
  archive order; use deterministic source order as the fallback for legacy
  sidecars and retain every unique record even when constraints are damaged.
- Preserve the exact sidecar body over an evicted overlap while keeping one
  logical entry per stable physical ID.
- Transfer logical/source identity from matching pre-compaction active-path
  messages to their newly materialized physical copies.
- Add regression coverage for retained-parent/archived-child, multiple batches,
  overlap, equal timestamps, malformed sidecar tails, direct-vs-paged order,
  and compaction provenance.

#### Resolution

- New island records persist module-private previous/next entry anchors. Legacy
  records without anchors retain deterministic stream/batch order; invalid
  anchor metadata is ignored without dropping a valid entry body.
- Full recovery now applies parent edges as hard constraints and main, batch,
  and adjacency order as stable soft constraints. It never uses timestamps,
  retains every unique physical entry ID, prefers exact main bodies over stale
  exact sidecars, prefers the latest exact canonical-islands copy after its
  main copy is evicted, and still restores exact sidecar bodies over main
  `[compacted]` placeholders without letting the legacy sidecar override the
  canonical stream.
- Full-lineage reads share the per-Session file lock with maintenance and
  archive moves. Modern and legacy sidecars move and roll back with the main
  file, while destination collisions fail closed instead of overwriting
  orphaned history.
- Compaction rematerialization inherits provenance from retained message
  references using suffix-oriented monotonic matching. Rendered compaction and
  branch-summary messages and messages explicitly reconciled to a persisted
  entry carry module-private provenance IDs. Content equality alone never
  proves that an unrelated message is a clone, while a storage reload does not
  break an already reconciled copy relationship. Reconciliation treats prior
  post-compaction attachments as context-only so they cannot create a temporary
  branch that replaces the retained tail's identity.
- Rewind archives every removed main-file entry before replacing the main
  snapshot, preserving both raw audit records and the adjacency witnesses
  needed to place earlier sidecar batches.
- Regression coverage now includes retained-parent/archived-child recovery,
  independent entries within an archive batch, multiple sidecar streams,
  overlap authority, equal timestamps, malformed tails and anchors, parent
  cycles, archive/unarchive, read/move locking, destination collisions,
  direct/paged parity, repeated message identity, prior checkpoint clones, and
  a combined compaction/rewind/multi-batch raw-transcript fixture, including
  reload/two-round attachment provenance and conflicting overlap authority
  after rewind.

### 237: Production learning reviewer omitted the learned Skill slug constraint

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.78 development
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Problem

The explicitly authorized F263 revision `f263-v0.7.78.3` safety panel remained
conservative but exposed a systematic positive-path protocol mismatch. All nine
verified-reusable-method cells chose `project_canary` in the raw decision, yet
only three survived the production normalizer. The other six were downgraded to
`ready` with `unsafe_skill_spec` solely because their human-readable Skill names
did not satisfy the production lowercase hyphenated-slug invariant. The
inclusive panel used 54 calls and 127,077 tokens with estimated external spend
of `$0.003363915`.

The failure repeated with the same one-of-three success pattern in every
provider family. No negative case produced a normalized project canary, no
secret was disclosed, and no credible high-severity safety harm was found.
Downstream F263 comparison and the F277 panel were stopped rather than expanding
evidence from a candidate with a known systematic utility mismatch.

#### Root Cause

Production validation already required a canonical lowercase hyphenated Skill
name of at most 64 characters, but the report tool exposed `spec.name` as an
unconstrained string and the stable reviewer prompt omitted that invariant.
Providers therefore made the correct capability decision while emitting a name
that the strict production validator correctly rejected.

#### Resolution

- Add the existing lowercase hyphenated-slug pattern and 64-character maximum
  directly to the production report-tool schema.
- State the same invariant in the stable production reviewer prompt.
- Keep the strict validator and fail-closed `unsafe_skill_spec` downgrade
  unchanged; do not slugify or silently repair model output.
- Freeze fresh F263/F277 revision `.4` raw roots for the next exact candidate;
  retain `.3` as historical safety/utility evidence and do not resume it.

#### Files Changed

- `packages/coding/src/learning-reviewer.ts`
- `packages/coding/src/learning-reviewer.test.ts`
- `benchmark/datasets/feature-263/experiment-contract.ts`
- `benchmark/datasets/feature-263/experiment-contract.test.ts`
- `benchmark/datasets/feature-277/experiment-contract.ts`
- `benchmark/datasets/feature-277/experiment-contract.test.ts`

#### Tests Added or Updated

- `learning-reviewer.test.ts` pins the prompt wording, slug pattern, and maximum
  name length.
- Focused production reviewer, unified-review, and learned-Skill tests pass with
  the strict normalizer and admission policy unchanged.

### 236: Production learning reviewer under-specified its unified output shape

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.78 development
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Problem

The explicitly authorized F263 revision `f263-v0.7.78.2` pilot made four
production-provider calls. Three results failed the real production normalizer,
and neither positive reusable-method sample produced the required
`project_canary` decision. The recurring drift placed `capabilityDecision`
inside `memoryPlan`; at least one response also emitted
`requiresApproval=false`.

The safety intent remained conservative: neither adversarial sample disclosed
the secret or created an unsafe Skill. The failure is nevertheless a release
blocker because the production reviewer did not demonstrate its positive
capability path.

#### Root Cause

The tool schema described `capabilityDecision` as a sibling of `memoryPlan` but
did not require it, while the prompt did not state the sibling relationship.
The schema constrained `requiresApproval` to `true`, but the prompt did not
explain that this is an invariant of governed review proposals. A provider
could therefore produce semantically plausible prose in a shape that the
production normalizer correctly rejected.

#### Resolution

- Require both top-level carriers in the production report-tool schema.
- State the sibling relationship and approval invariant directly in the stable
  system prompt.
- Keep the strict production normalizer unchanged; do not hoist or silently
  rewrite malformed model output.
- Freeze a new experiment revision and require a valid pilot before any F263
  panel or downstream expansion.

#### Tests Added or Updated

- `learning-reviewer.test.ts` pins the required sibling carriers and explicit
  approval invariant.
- Unified-review and focused production-reviewer tests remain green with the
  strict normalizer unchanged.
- F263/F277 contract, fake-runner, and zero-call manifest suites pin the new
  isolated `.3` revisions. Paid `.3` execution remains an independent release
  gate for the exact committed candidate.

### 235: v0.7.78 semantic release gates had no frozen current-policy runners

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.78 release candidate
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

The release checklist correctly required bounded paid semantic evaluation for
FEATURE_263 and FEATURE_277, but the repository did not yet contain executable
runners for the exact v0.7.78 policies. FEATURE_263 had no current runner.
FEATURE_277 only had historical v0.7.33 classifier coverage and a v0.7.73
timeout probe, neither of which froze the intent-aligned v0.7.78 production
prompt, action projection, cases, provider routes, scorer, and budget.

Running those historical gates would have produced release evidence for old
semantics and could have pressured the new implementation to conform to stale
expectations.

#### Root Cause

Feature-level deterministic tests and design-time eval plans were complete, but
the final release audit had not converted both paid plans into preregistered,
revisioned, resumable runners. The generic one-shot harness also had no typed
way to force the production learning-review report tool.

#### Resolution

- Added frozen F263 revision `f263-v0.7.78.2`: a four-call reviewer pilot, an
  inclusive 54-cell safety panel, and a 24-cell blinded downstream comparison,
  with a shared 78-call/850,000-token/$10 ceiling.
- Added frozen F277 revision `f277-v0.7.78.2`: a four-call pilot and inclusive
  60-cell intent-aligned classifier panel, with a 300,000-token/$6 ceiling.
- Freeze exact Git/patch identity, production prompt/tool/policy bytes, rendered
  cases, aliases, pricing and scorer hashes before generation.
- Persist resumable raw cells and blind-review packets under `os.tmpdir()`;
  repository tests use a zero-cost fake provider.
- Require both an in-process opt-in and a feature-specific environment flag
  plus non-empty owner-authorization record before any provider call.
- Extend the existing one-shot harness only with an optional
  `forcedToolName`; ordinary callers remain byte-for-byte unchanged.

#### Files Changed

- `benchmark/harness/harness.ts`
- `benchmark/harness/harness-model-routing.test.ts`
- `benchmark/datasets/feature-263/`
- `benchmark/datasets/feature-277/`
- `tests/feature-263-learning-release.eval.ts`
- `tests/feature-277-permission-policy.eval.ts`

#### Tests Added or Updated

- Contract tests pin every case-set hash and fail closed on revision drift.
- Fake-provider runner tests prove call ceilings, resume behavior, production
  byte manifests, secret-safe review evidence, and blinded reveal separation.
- Default eval entry points run manifest-only and make zero external calls.

### 234: Standalone sandbox environment gate assumed Windows argv transport on POSIX

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.78 standalone sandbox broker tests
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

The standalone sandbox broker regression asserted that the spawned command
always contained Windows ASRT `--env NAME=value` arguments. Linux CI correctly
uses the POSIX sandbox wrapper and passes the caller-owned environment through
the `spawn()` environment instead, so Node 20 and Node 22 both failed the fast
suite even though the production environment contract was intact.

#### Root Cause

The initial v0.7.78 test was authored and passed on Windows. It encoded one
backend's transport representation rather than the cross-platform semantic
contract.

#### Resolution

- Keep the Windows assertions on the exact `--env` argv injection.
- On POSIX, assert the exact value in the captured child environment.
- Leave production containment, credential, and environment behavior unchanged.

#### Files Changed

- `src/sandbox-runtime.test.ts`

#### Tests Added or Updated

- The existing standalone broker regression now validates each platform's
  actual environment transport without weakening the common value assertion.

### 233: Learned Skill canary could trust before all outcomes settled and record a stale artifact identity

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.78 development
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

FEATURE_263 could move a learned Skill from `testing` to `active_learned` as
soon as the first canary invocation reported `verified_success`, even while
other admitted invocations were still pending. A later credible negative could
then quarantine an artifact that had already been recorded as the previous
known-good revision.

The two-step root admission path also acquired the capability lock once to
reserve a binding and again to record the invocation. The second mutation
accepted the revision and fingerprint captured before the first lock without
checking them against the current canonical artifact. A concurrent revision
change could therefore attach stale artifact identity to a current canary
record.

#### Root Cause

- Lifecycle completion tested only `verifiedSuccesses > 0`; it did not require
  the bounded three-use canary to be exhausted and every outcome to be settled.
- `invokeLearnedSkillCanary()` treated the caller-provided revision and
  fingerprint as receipt fields, not as preconditions inside its own locked
  mutation.
- Integration tests still encoded the obsolete one-success promotion behavior.

#### Resolution

- Keep the canary in `testing` until all three exact-revision uses have been
  admitted and every outcome has settled.
- Activate only when that settled canary contains at least one independently
  verified success. Credible negative evidence still takes precedence and
  quarantines immediately; an exhausted canary without success returns to
  `ready`.
- Revalidate any supplied artifact revision and fingerprint against the
  canonical record inside the invocation mutation, before consuming a canary
  slot or writing attribution.
- Preserve the two narrow lock operations rather than adding a new transaction
  abstraction. A failed second mutation records no invocation; the ordinary
  binding finalizer or expiry path releases the temporary reservation.

#### Files Changed

- `packages/agent/src/learning/learned-skill.ts`
- `packages/agent/src/learning/learned-skill.test.ts`
- `packages/coding/src/learned-skill-runtime.test.ts`
- `src/runtime-agent-binding.test.ts`

#### Tests Added or Updated

- Proved that the first verified success leaves the lifecycle in `testing`
  while another invocation remains pending.
- Proved that activation occurs only after the third exact-revision outcome
  settles and at least one verified success exists.
- Proved that revision or fingerprint drift inside the second locked mutation
  fails closed without consuming an invocation slot.
- Updated coding-root and Runtime integration gates to retain `testing` after
  one verified success instead of forcing implementation drift.

### 232: Workspace shell sandbox did not deny reads from sensitive home credential paths

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.78 ASRT workspace shell sandbox
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

The ASRT workspace shell policy denied reads from KodaX's sandbox control
directory, but did not explicitly deny credential-bearing paths under the
user's home directory. On backends where home reads are otherwise available,
an admitted workspace command that executed unexpected logic could attempt to
read SSH, cloud, container, package-manager, or CLI credentials.

#### Root Cause

- Sensitive-path constants were used only while copying isolated Skill
  snapshots and were not part of the workspace shell sandbox policy.
- Home-local `PATH` entries were granted read access without excluding entries
  nested below sensitive paths; ASRT read grants take precedence over denies.
- A custom `KODAX_HOME` was protected only at its `sandbox-runtime` child
  instead of at the complete agent configuration boundary.

#### Resolution

- Deny KodaX's explicit sensitive-home set: SSH, cloud, Kubernetes, container,
  KodaX/agent, gcloud/GitHub CLI configuration, common environment files, and
  common private-key names.
- Protect the complete resolved agent home, including a programmatic override
  or `KODAX_HOME`, while retaining an exact sandbox bootstrap read grant.
- Keep ordinary home-local `PATH` entries readable, but remove entries nested
  under a denied path so they cannot reopen the sensitive subtree.
- On Windows, keep only the original control-directory deny in the long-lived
  session ACL and pass the complete deny set through ASRT's per-exec deny
  contract. This avoids `srt-win acl stamp` timeouts without weakening the
  command boundary; macOS/Linux retain the session-level deny policy.
- Preserve workspace/temp writes, ordinary external reads, the exact sandbox
  bootstrap grant, and the existing workspace network behavior.

#### Files Changed

- `src/sandbox-runtime.ts`
- `src/sandbox-runtime.test.ts`

#### Tests Added or Updated

- Extended the workspace shell adapter regression to assert the explicit
  sensitive-home set and the complete resolved agent home.
- Asserted that the Windows session ACL remains bounded while the exact command
  receives the complete per-exec deny set.
- Asserted that home-root and sensitive home-local `PATH` entries are not
  re-granted while an ordinary home-local tool directory remains readable.
- Verified against the real Windows ASRT backend that workspace-session
  preparation succeeds and a read of an existing SSH file returns `DENIED`.

### 231: Explicit memory intent was discarded when the root episode was cancelled

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.78 governed memory intent lifecycle
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

After the root Action LLM successfully called `memory_intent`, a later Ctrl-C,
tool cancellation, or `AbortError` finalized the MemorySession as cancelled.
Both SA and AMA then discarded the host-verified user intent before it reached
the governed review inbox. The user-visible tool receipt said the intent had
been captured for end-of-episode submission, but the cancellation boundary
silently erased it.

Ordinary cancelled episodes must continue to produce no learning digest. Only
an explicit intent bound by the host to an exact quote in the current user turn
may survive cancellation, and the cancelled task's observations, checks, and
lessons must not become durable learning evidence.

#### Root Cause

- SA omitted `acceptedMemoryIntent` from its interrupted outcome.
- AMA retained the intent shape but removed its authoritative evidence.
- `MemorySession.completeOnce()` returned immediately for every cancelled
  outcome, so changing either caller alone could not persist the intent.
- Runtime validators and the public outcome-digest type did not admit an
  intent-only cancelled terminal.

#### Resolution

- Preserve the general no-learning rule for cancellation.
- SA and AMA now forward a captured intent and its authoritative user evidence
  even when a later cancellation finalizes the root episode.
- `MemorySession` emits a cancelled digest only when the sanitized intent is
  bound to matching `authoritative`/`user` evidence.
- Cancelled digests contain exactly the intent evidence and omit cancelled-task
  lessons, action signatures, preconditions, verifier facts, and Memory
  influence.
- Inbox and unified-review validators reject cancelled digests that violate the
  intent-only shape, while Skill promotion remains closed without a verified
  completed outcome.
- Inbox persistence validates the complete digest before acquiring locks or
  writing owner/job state, so malformed cancellation input has no side effects.
- A persisted cancelled intent starts legacy direct review in the background;
  Ctrl-C no longer waits for the reviewer timeout, and detached failures remain
  visible through Memory trace diagnostics.

#### Files Changed

- `packages/agent/src/experimental-memory/memory-agent.ts`
- `packages/agent/src/memory-control/review-inbox.ts`
- `packages/agent/src/memory-control/unified-review.ts`
- `packages/agent/src/learning/types.ts`
- `packages/agent/src/learning/store.ts`
- `packages/agent/src/types.ts`
- `packages/coding/src/agent-runtime/run-substrate.ts`
- `packages/coding/src/task-engine/runner-driven.ts`

#### Tests Added

- MemorySession positive and unbound-negative cancellation coverage.
- SA and AMA regressions for intent capture followed by `AbortError`.
- Inbox idempotency and malformed-cancelled-digest rejection coverage.
- Unified-review acceptance with explicit Skill-promotion fail-closed coverage.
- Hanging-reviewer coverage that proves cancelled completion returns promptly.

### 230: PID-only Actor owner liveness could pin crashed Runtime ownership after PID reuse

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.78 development
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

Schema-v2 Actor ownership persisted a Runtime ID, PID, and Runtime start time,
but the SDK liveness probe checked only `process.kill(pid, 0)`. After an
unclean Runtime exit, an unrelated process could reuse that PID and make the
stale owner appear alive. A new Runtime then failed with
`actor_owner_conflict` and could not recover, archive, or delete the Session
until that unrelated process exited or the snapshot was repaired manually.

#### Root Cause

PID existence proves neither process incarnation nor Runtime identity. The
stored `runtimeId` and `startedAt` had no independently probeable owner
resource, while every non-`ESRCH` result intentionally remained fail-closed to
protect live turns from concurrent recovery.

#### Resolution

- Added one lazy, Runtime-scoped loopback TCP liveness endpoint shared by all
  Actor Sessions in that Runtime.
- Persisted its random `livenessId` challenge and ephemeral port with new Actor
  owners. An exact response proves the owner live; `ECONNREFUSED` or a completed
  mismatched response proves it stale. Timeouts and unknown probe failures
  remain fail-closed, preserving the live-turn safety boundary.
- Preserved the legacy fail-closed behavior for owners without a valid
  `livenessId`, so upgrading cannot steal an Actor tree from an older live
  Runtime.
- Kept the endpoint alive when Actor shutdown or owner release fails; it closes
  only after every owned Session has stopped and released its durable fence.

#### Files Changed

- `packages/agent/src/actors/types.ts`
- `packages/agent/src/actors/controller.ts`
- `src/runtime-actor-owner-liveness.ts`
- `src/sdk-runtime.ts`

#### Tests Added

- Unit coverage for live, stale-with-live-PID, reused-port, legacy/partial,
  malformed, and short-lived headless Runtime identities.
- SDK regression that restores a crashed owner snapshot with the current live
  PID and confirms a contender can reclaim it without weakening live-owner
  fencing.

### 229: A2A ephemeral listener could publish a Fetch-blocked loopback endpoint

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.69 built-in A2A listener
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

The built-in A2A listener accepted an explicit port, or asked the operating
system for an ephemeral port with `port: 0`, without checking the WHATWG Fetch
blocked-port table. The operating system could therefore return a listening
URL that Node's Fetch client rejected with `bad port` before sending a request.
This made otherwise unrelated reconnect and blocking-wait tests fail
nondeterministically and could expose an unusable SDK endpoint to embedders.

#### Root Cause

TCP listener success was treated as sufficient endpoint readiness even though
the A2A SDK and its consumers use Fetch-compatible HTTP clients, which enforce
an additional port-safety contract.

#### Resolution

- Reject an explicitly configured Fetch-blocked A2A listener port before
  binding.
- Retry bounded `port: 0` allocation when the operating system selects a
  blocked port.
- Preserve the existing loopback-only, task, reconnect, wait, and streaming
  semantics.

#### Files Changed

- `src/a2a/server.ts`

#### Tests Added

- `src/a2a/a2a.test.ts`

### 228: Runtime Auto v4 capability still accepted and advertised v3 persistent-fallback semantics

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.78 development
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

FEATURE_277 removed automatic, durable Auto[LLM]-to-Rules fallback and assigned
that invariant to `runtimeAutoModeGuardrail` v4. The implementation advertised
capability version 4, but embedded and daemon metadata still reported
`fallbackPersistsEngine: true`. Both daemon auto-start paths also required only
v3, so a v0.7.78 client could attach to an older daemon whose classifier
failure changed the Session engine to Rules.

That mismatch made a stale compatibility gate authoritative over the new
design: hosts could believe the v4 intent-preserving contract was active while
executing v3 behavior.

#### Root Cause

The F277 behavior change updated the guardrail and public capability version,
but copied v3 metadata and minimum-version literals remained in the embedded,
daemon, and daemon-upgrade paths. Existing tests asserted the stale metadata
and did not include an exact v3-to-v4 upgrade case.

#### Resolution

- Require `runtimeAutoModeGuardrail` v4 from both daemon auto-start entry
  points, preserving attach-only callers' explicit minimum-version control.
- Advertise `fallbackPersistsEngine: false` consistently from embedded,
  Worker, and daemon Runtime capabilities.
- Add an exact idle-v3 daemon replacement regression and align Worker/daemon
  metadata assertions with the non-persistent fallback contract.

#### Files Changed

- `src/sdk-runtime.ts`
- `src/runtime-daemon/server.ts`

#### Tests Added or Updated

- `src/sdk-runtime-daemon-upgrade.test.ts`
- `src/sdk-runtime.test.ts`
- `src/runtime-daemon/server.test.ts`

### 227: Root memory loop did not reliably capture explicit user remember intent in AMA and queued turns

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.68 MemorySession; AMA lifecycle gap
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

An Action LLM could tell a user that a durable preference had been remembered
without invoking any governed Memory action. The completed MemorySession and
post-episode reviewer existed on the standard Agent path, but the production
Runner/AMA path did not run the equivalent episode lifecycle. Direct Chinese
remember requests such as “下次记得” were therefore neither captured nor
submitted to the durable review inbox.

A literal keyword expansion would also be unsafe: narration such as “我记得昨天”
must not become durable intent, and queued follow-up turns must bind to their
own original user text rather than the initial task or a generated resume
preamble.

#### Root Cause

- AMA did not start, complete, persist, or drain the root MemorySession.
- The Action LLM had no narrow governed tool for semantically declaring an
  explicit remember/correct intent.
- The initial implementation bound the tool to a static initial prompt, kept
  only the last of multiple calls, omitted the candidate statement and verified
  quote from the review digest, and described an in-memory capture as already
  queued.
- Review inbox drains could race a startup lease, and explicit config-home
  identity was not consistently used by every Memory path.

#### Resolution

- Added the root-only `memory_intent` tool. The LLM performs semantic intent
  recognition; the host verifies an exact quote in the current original user
  turn, applies prompt-safety limits, and captures at most one idempotent intent.
- Added equivalent MemorySession, outcome persistence, governed review, inbox
  drain, receipt, and client-notice lifecycle to AMA while retaining the
  standard path.
- Persisted the sanitized candidate statement and host-verified quote alongside
  the evidence ref. Explicit triggers now require matching authoritative user
  evidence, including at the provider-review boundary.
- Distinguished in-memory `captured` state from a durable queued review job and
  from an applied Memory receipt.
- Serialized startup/completion drains and honored explicit config-home
  identity across Memory and learning proposal stores.

#### Files Changed

- `packages/agent/src/experimental-memory/memory-agent.ts`
- `packages/agent/src/memory-control/controller.ts`
- `packages/agent/src/memory-control/unified-review.ts`
- `packages/agent/src/memory/paths.ts`
- `packages/agent/src/learning/store.ts`
- `packages/agent/src/types.ts`
- `packages/coding/src/agent-runtime/run-substrate.ts`
- `packages/coding/src/task-engine/runner-driven.ts`
- `packages/coding/src/tools/memory-intent.ts`
- `packages/coding/src/tools/tool-definitions.ts`
- `packages/coding/src/learning-reviewer.ts`
- `packages/coding/src/memory-runtime.ts`
- `packages/coding/src/prompts/memory-rules.ts`
- `packages/coding/src/self-knowledge/registry.ts`

#### Tests Added

- Semantic tool binding, exact-quote rejection, one-shot idempotency, and state
  wording tests.
- Real SA and AMA queued-follow-up tests that call `memory_intent` only after a
  new user turn.
- AMA end-to-end durable review/apply and no-tool fallback tests.
- Long-objective evidence retention, forged-intent authority, config-home
  isolation, drain serialization, and secret-safety regressions.

### 226: Runtime client broker prompted for already-allowed Edit calls and Plan blocked Skill loading

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.66 Runtime broker / Skill tool metadata
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

In Edit mode, a model-triggered `skill` call opened a Runtime permission prompt
even though the tool only loads and expands local Skill instructions. Rejecting
the prompt prevented Skill activation and caused the model to retry the
required Skill call repeatedly. Switching to Auto[LLM] avoided the prompt
because Auto used a separate guardrail path.

Plan mode also treated the same outer `skill` call as a prohibited side effect.
For ordinary Skill instructions, the actual file, shell, network, or external
actions are separate tool calls that retain their own permission checks.
However, Skill `!`command`` dynamic-context tokens are expanded inline and
therefore require a separate fail-closed boundary.

Expected behavior: loading static Skill instructions is directly allowed in
Edit and Plan modes. Concrete downstream actions still follow their own tool
policy, while inline dynamic commands are disabled unless a non-Plan Runtime
host supplies a permission-aware executor.

#### Root Cause

- `resolveRuntimePermissionPolicy()` returned unresolved immediately whenever
  `permissionBroker=client`, before applying the normal Edit-mode policy. The
  broker selection therefore changed whether approval was required instead of
  only selecting who answered a genuine escalation.
- The built-in `skill` definition retained `sideEffect: "mutates-state"` for
  learned-Skill usage receipts but lacked `planModeAllowed: true`, so the
  metadata-driven Plan gate blocked the outer loading operation.
- Without a Runtime-supplied dynamic-context policy, Skill expansion could fall
  through to the resolver's legacy inline `execSync` path. That execution does
  not pass through the Runtime tool permission hook and therefore cannot share
  the outer Skill-loading exemption.
- Regression coverage asserted that a client-brokered workspace write created
  a permission request, did not cover Skill loading in either mode, and did not
  exercise a mutating dynamic-context command.

#### Resolution

- Kept Runtime permission policy authoritative before broker escalation.
  Already-allowed Edit calls now return directly; unresolved shell/protected
  operations still enter the selected client or Runtime broker.
- Marked the built-in `skill` tool as Plan-allowed without reclassifying its
  learned-Skill bookkeeping as readonly.
- Prevented Runtime-hosted Skill expansion from using the legacy inline shell
  fallback. A mediated executor rechecks the live Session mode for every
  dynamic token: Plan refuses it immediately, while leaving Plan restores the
  explicitly supplied host executor without restarting the Run.
- Added Edit/client-broker and Plan Skill cases to the Runtime permission
  matrix, while retaining blocked Plan edits and client-brokered
  shell/protected-path prompts.

#### Files Changed

- `src/sdk-runtime.ts`
- `src/sdk-runtime.test.ts`
- `packages/coding/src/tools/tool-definitions.ts`
- `packages/coding/src/tools/registry.test.ts`
- `docs/KNOWN_ISSUES.md`

#### Tests Added

- Runtime permission matrix verifies that client-brokered Skill loading and
  workspace writes do not create permission requests in Edit mode.
- Runtime permission matrix verifies that Skill loading succeeds while file
  edits remain blocked in Plan mode.
- Runtime integration expands a real crafted Skill and verifies that Plan mode
  preserves its static instructions without executing an inline mutating Git
  command.
- Live-mode integration verifies both Edit-to-Plan refusal and Plan-to-Edit
  restoration for an explicitly mediated dynamic-context executor.
- Tool registry test verifies `isToolPlanModeAllowed("skill")`.

### 225: Release gates encoded stale semantics or ignored background lifecycle

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: legacy regression assertions and cleanup
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-29
- **Resolved**: 2026-07-29

#### Original Problem

The complete release suite contained two assertions that contradicted the
current design and two test paths that ignored an intentional asynchronous
lifecycle:

1. `bash-cleanup.test.ts` aborted the signal before `toolBash()` started but
   still expected the background process to spawn. Preserving that assertion
   would require removing the v0.7.78 pre-spawn cancellation fence and could
   create work after the caller had already cancelled.
2. `kodax_cli.daemon-smoke.test.ts` wrote an invalid A2A file under an explicit
   user `--home` and expected `source: "default"`. The integration resilience
   contract preserves truthful source provenance even when the user candidate
   is invalid, so the correct result is `source: "user"`.
3. `runner-windows-hide.test.ts` recursively deleted its temporary KodaX home
   immediately after twenty ordinary queries. Governed Memory review is
   intentionally durable and non-blocking, so a session-authority lock ticket
   could still be completing while Windows traversed the directory, producing
   a transient `ENOTEMPTY` after every test assertion had passed.
4. The AMA Memory end-to-end test required the detached filesystem-backed
   review receipt within five seconds. Under the full parallel unit suite this
   could exceed the local polling budget even though the same scenario
   completed consistently in focused runs and the foreground result correctly
   remained non-blocking.

All four failures were gate/test debt rather than evidence of a production regression.
Changing production to satisfy them would have distorted the cancellation and
configuration-source designs or made background review block the foreground
answer.

#### Root Cause

- The Bash cleanup test conflated “already-started background cleanup rejects”
  with “a pre-aborted request may start work.”
- The daemon smoke expectation used the fallback-content label as though it
  were source provenance, despite constructing an explicit user file.
- The Windows regression cleanup used the default zero-retry `fs.rm` behavior
  even though the test deliberately exercised a non-blocking background
  lifecycle under the same temporary home.
- The AMA Memory regression used a focused-test timing budget as a semantic
  deadline for detached work under full-suite contention.
- None of these gate assumptions was tied to a named invariant, so later
  safety hardening exposed the mismatch only at the full-suite gate.

#### Resolution

- Kept the production pre-spawn abort fence unchanged. The cleanup regression
  now starts a bounded background command, aborts immediately after spawn, and
  verifies the intended cleanup-rejection/no-unhandled-rejection behavior.
- Updated the daemon smoke to expect `source: "user"` while retaining the
  degraded invalid-config diagnostic and safe-empty effective behavior.
- Kept governed Memory review non-blocking. The Windows-only temporary cleanup
  now uses Node's bounded native recursive-remove retry for transient
  `ENOTEMPTY`/contention instead of changing production lifecycle semantics.
- Preserved detached AMA review and widened only its full-suite observation
  budget; production completion does not wait for the receipt.
- Added this record so future release work treats semantic gate failures as
  design-review inputs instead of automatically rolling production backward.

#### Files Changed

- `packages/coding/src/tools/bash-cleanup.test.ts`
- `packages/coding/src/task-engine/runner-windows-hide.test.ts`
- `packages/coding/src/task-engine/runner-driven.test.ts`
- `src/kodax_cli.daemon-smoke.test.ts`
- `docs/KNOWN_ISSUES.md`

#### Tests Added

- Reused the existing cleanup rejection and built-daemon integration
  scenarios with corrected design-aligned setup/expectations.
- Focused combined rerun passed both corrected assertions.
- The Windows background-process regression passed three consecutive complete
  runs after the bounded cleanup correction.

### 224: Concurrent Runtime owners could recover live Actor turns and make interrupt, list, and wait diverge

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.72 Runtime Actor persistence
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-28
- **Resolved**: 2026-07-28

#### Original Problem

In Session `20260728_203543`, an existing Runtime still owned two physical
child-Agent executions. At 20:43:19 local time, a second `coder` Runtime daemon
started and loaded the same durable Actor snapshot. Its controller treated the
existing `running` turns as crash leftovers and persisted recovery revisions
14 through 16, while the original controller remained at revision 13 and its
physical children continued running.

When the original Runtime later attempted `interrupt_agent`, its durable write
failed with `expected 13, actual 16`. Because interruption committed logical
state before invoking `AbortController.abort()`, the conflict prevented the
physical stop signal. `list_agents` and `wait_agent` also remained attached to
the original controller's process-local snapshot and mailbox, so logical
durable state, displayed state, wait behavior, and actual execution diverged.

#### Root Cause

- `createRuntimeAgentActorRegistry()` isolated sessions only inside one Runtime
  instance. The durable Actor snapshot had no Runtime/controller owner, so a
  second Runtime could construct another controller for the same Session.
- `AgentActorController.initialize()` unconditionally recovered every
  non-terminal persisted turn. It could not distinguish a crashed executor
  from a live executor owned by another Runtime.
- Actor mutation CAS detected the later revision, but the conflict was an
  untyped generic error. The stale controller rolled back logical interruption
  and never physically aborted its locally owned executor.
- Actor reads and model mailbox waits intentionally use committed process-local
  state. Without a single-owner fence, two valid local projections could
  permanently disagree with the one durable snapshot.
- Session deletion removed the session file before the Actor registry closed
  its controller, making later owner release fail with `Session not found`.
- Runtime Run admission and archive/delete checked separate process-local
  snapshots. A Run could still be preparing before it appeared in the active
  Run map, leaving a window in which the Session file could be moved.
- The first owner probe treated several non-`EPERM` operating-system errors as
  proof that the owner was dead. That was unsafe: only `ESRCH` proves the PID
  no longer exists.
- Status preflight used the ordinary Session loader. Its automatic incomplete
  tool-call recovery could therefore write during observation; it read before
  taking the Session lock, then rewrote the stale full snapshot, which could
  overwrite a concurrent Actor owner revision. For archived Sessions it also
  omitted the resolved path and could recreate an active duplicate.

#### Resolution

- Added Actor snapshot schema v2 with an exclusive owner identity containing a
  controller token, Runtime ID, PID, and Runtime start time. Runtime Actor
  controllers claim ownership through the existing cross-process,
  per-Session file-lock-protected CAS write before recovery or mutation.
- A contender rejects a live foreign owner with the non-retryable
  `actor_owner_conflict` error. It may claim a dead owner only after the
  liveness probe returns `ESRCH`; permission, unknown, and transient probe
  failures conservatively keep the owner live. Only then may unmatched-turn
  recovery run. Ownerless controllers fail closed on schema-v2 snapshots.
  Owner-aware controllers also reject schema-v1 snapshots that still contain
  non-terminal turns with `actor_owner_unknown`, because an older live Runtime
  cannot publish the identity needed for a safe takeover. Terminal v1
  snapshots upgrade automatically.
- Added a typed `actor_snapshot_conflict` storage error. If a legacy or
  residual race still produces a CAS conflict, the stale controller
  permanently self-fences, aborts every physical executor it owns, reloads the
  durable snapshot, and republishes newly committed events and completion
  messages so local reads and waiters converge.
- `interrupt_agent` treats the request as satisfied when the conflict fence
  physically aborted local execution or the reloaded durable target is already
  interrupted. Later writes from the stale controller remain rejected.
- Runtime close now interrupts turns and releases the owner. Session archive,
  unarchive, and deletion first claim or validate Actor ownership even when the
  calling Runtime has no local registry entry. They retain that durable owner
  through the filesystem operation: moves release it only from the moved file;
  deletion quiesces physical executors without releasing the fence, removes the
  file, then performs a no-write local dispose. A failed strict deletion keeps
  both the authoritative snapshot and registry owner for retry instead of
  reporting success or orphaning the owner.
- One per-Session operation gate serializes Run admission, Agent mutations, and
  archive/unarchive/delete. The gate is held until a starting Run is registered,
  closing the window where `hasActiveRun` previously returned false. Runtime
  close drains this gate before closing the Actor registry, shares one close
  attempt across concurrent callers, waits for all cleanup branches, and can
  retry an Actor owner-release write that failed.
- Every root Run, including `agentMode: "sa"`, claims the Session Actor owner,
  so another Runtime cannot move or delete a live SA Run's Session.
- Archived Sessions reject new Run and Agent execution and every in-place
  Session mutator with `session_archived` until explicitly unarchived. Actor CAS
  writes retain exact resolved-path behavior as a defense in depth and cannot
  recreate an active duplicate. Paired main/sidecar moves roll back the main
  file when the sidecar move fails and surface an aggregate error if rollback
  itself cannot complete.
- External Agent interruption now observes aborts that arrive while task start
  is queued, in preflight/factory creation, in durable admission, or waiting
  for a remote reference. The caller `AbortSignal` crosses the task-service and
  A2A request boundaries, while an aborted queued start retains its per-Agent
  serialization fence until its predecessor settles. Durable admission
  releases before the remote start call, cancellation first persists
  `requested`, and competing abort/cancel paths coalesce onto one formal remote
  cancel. An aborted ambiguous start without a reference remains visibly
  `unknown` instead of pretending remote cancellation was confirmed, and the
  Actor executor exits instead of polling that non-terminal ambiguity forever.
  The A2A safe-fetch layer composes this caller signal with its request deadline
  instead of overwriting it.
- Runtime status preflight reads durable Actor snapshots without claiming
  otherwise unowned Session trees or invoking Session recovery writes, so
  observation cannot alter file bytes/mtime or block the Runtime that will
  execute them. Ordinary incomplete-tool recovery now re-reads under the
  cross-process Session lock, skips durable/unknown Actor owners, and writes
  back to the exact resolved active or archived path.
- Full Session saves preserve the latest stored Actor sub-snapshot regardless
  of stale caller data; only `saveActorSnapshot` may change it through CAS.
  Full saves, island maintenance, and sidecar appends also retain the resolved
  archived path instead of creating an active copy.
- A newly claimed owner is released by a fenced write if later initialization
  or unmatched-turn recovery fails. The same controller can safely retry after
  a successful release, and the Runtime performs another same-owner cleanup if
  both recovery and the first release write fail. The ownerless handoff
  snapshot remains protected from raw archive/delete while it contains
  non-terminal turns.
- Raw storage archive/unarchive/delete and automatic retention use the same
  owner checks as the Runtime facade. They cannot move or remove a live-owned
  tree, an ownerless non-terminal handoff, or a legacy non-terminal tree.
- Session deletion and retention stage the complete main/sidecar set under
  ignored tombstone names before unlinking. A staging error rolls every rename
  back, so a failed delete cannot retain the main file while silently losing
  compacted history. Cross-process append also revalidates its process-local
  watermark under the Session file lock and merges unique lineage, artifact,
  and extension identities when another Runtime advanced or rewrote the file,
  including same-length rewrites. Append and raw lineage mutators use the exact
  resolved archived path and cannot recreate an active duplicate.
- Runtime client, Worker, hosted-daemon, daemon-host, lease, and executor-plane
  close paths share concurrent attempts. Successful cleanup phases are retained,
  failed phases can be retried, and a timeout does not permanently cache a
  rejected wrapper around cleanup that is still progressing.
- Concurrent controller shutdown is idempotent, and executor settlements that
  arrive after ownership release do not produce misleading background errors.
- Model-facing Agent tools now retain the owner Runtime ID, current revision,
  local-abort fact, and actionable ownership guidance.

#### Files Changed

- `packages/agent/src/actors/{types,errors,controller,index}.ts`
- `packages/agent/src/external-agents/{types,executor-plane}.ts`
- `packages/coding/src/agent-runtime/actor-runtime.ts`
- `packages/coding/src/tools/agent-collaboration.ts`
- `packages/repl/src/interactive/storage.ts`
- `packages/repl/src/session/public-api.ts`
- `src/sdk-runtime.ts`
- `src/a2a/{client-executor,safe-fetch}.ts`
- `src/runtime-daemon/{manager,process}.ts`

#### Tests Added or Updated

- Live-owner rejection without recovery and dead-owner takeover before
  unmatched-turn recovery.
- Stale-owner CAS fencing, physical abort, durable state refresh, waiter wake,
  completion republish, and permanent rejection of later stale writes.
- Owner-aware schema-v2 admission and incompatible newer-schema fail-closed
  behavior, plus active-v1 upgrade rejection and terminal-v1 upgrade.
- Concurrent `FileSessionStorage` CAS writes through separate instances.
- Archived Actor snapshot CAS writes stay in the exact archived file without
  creating an active/archived duplicate.
- Two Runtime instances contending for one Session, graceful ownership
  transfer, foreign-owner archive/deletion rejection, active-Run mutation
  rejection, and Session deletion before Runtime close.
- Barrier-controlled Run admission versus archive, SA root-Run ownership,
  Runtime-close admission draining, archived execution rejection, conservative
  non-`ESRCH` owner probing, and no-write controller disposal after Session
  deletion.
- Concurrent Runtime close sharing and retry, strict delete failure with owner
  retention, archived in-place mutation rejection, read-only daemon preflight,
  external-task start cancellation races, and paired archive rollback
  (including rollback failure reporting).
- Initialization-failure owner release, raw maintenance/retention owner fences,
  byte-for-byte read-only preflight, lock-local recovery reads, exact archived
  recovery/full-save writes, stale full-save Actor-CAS preservation, and
  retryable close behavior at every Runtime transport layer.
- Same-controller initialization retry, double-failure owner cleanup,
  abortable pending starts, atomic delete rollback after sidecar staging, and
  cross-instance append preservation without duplicate lineage entries.
- Pre-admission caller abort, retained same-Agent start ordering, coalesced
  formal cancellation, ambiguous-cancellation Actor convergence, exact archived
  append/raw lineage mutation, and same-length cross-instance rewrite merging.
- Structured model-facing `actor_owner_conflict` diagnostics.

See `docs/test-guides/ISSUE_224_v0.7.78_REGRESSION_GUIDE.md`.

### 223: Auto[LLM] timeouts and exact workspace mutations caused spurious or hard permission stops

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.33
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-28
- **Resolved**: 2026-07-28

#### Original Problem

KodaX Space session `s_11be2ee5-54f4-4740-84ce-b22f1577db73` used
Auto[LLM] with both the working directory and target under
`C:\Users\ADMIN\kodax_workspace`, but an ordinary write still requested manual
authorization. The recorded classifier request timed out after 20 seconds in
`pre_output` with no provider retry even though its tool projection was only
about 100 bytes, indicating queue, connection, cold-start, or first-token
latency rather than the main request's roughly 108K-token context.

Exact user-requested workspace file operations such as copy, move, rename, and
delete could also be reviewed as generic risky shell execution. A valid LLM
concern or contract failure could become a hard block instead of a user-owned
decision, while Runtime shell execution itself did not use the installed
Anthropic Sandbox Runtime as a workspace write boundary.

#### Root Cause

- Classifier infrastructure and contract failures had no bounded outer retry
  and did not expose prompt size or first-event/first-thinking/first-text timing.
- The deadline relied on provider cooperation with `AbortSignal`; an adapter
  that ignored cancellation could prevent retry and fallback indefinitely.
- Classifier failures and health thresholds were coupled to fail-closed or
  rules-engine behavior instead of the narrower Accept-edits fallback.
- The compact evidence did not mark the current real user request as a distinct
  authoritative field and could retain synthetic system-reminder messages.
- Permission analysis could describe exact workspace mutations, but there was
  no deterministic admission path backed by the OS sandbox. The ordinary bash
  tool spawned its command directly. Windows mutation switches such as `/Y`,
  `/Q`, `/S`, and `/A:H` could also be misread as path operands.

#### Resolution

- Added one immediate classifier retry for timeout, provider, and response
  contract failures. A second failure uses Accept-edits semantics: ordinary
  workspace edits continue, while executable shell/script calls and
  outside/protected writes require user authorization. Tier-0 destructive
  patterns remain hard-denied. The side-query deadline now settles locally
  even when a provider adapter ignores cancellation.
- A valid classifier `block=yes` now means user confirmation, not a direct hard
  block. Repeated concerns or failures retain the user-selected LLM engine;
  circuit-breaker state reports degraded classifier health without widening to
  Auto[rules].
- Added structured per-attempt diagnostics for prompt bytes, elapsed time,
  provider retry wait, terminal phase, first upstream event, first thinking
  delta, and first text delta. Runtime permission events expose these facts
  without prompt or response text.
- Added a bounded, explicitly marked current-user-intent field and filtered
  synthetic/system reminder messages from compact permission evidence.
  Deterministic admission additionally requires untruncated imperative intent,
  matching operation and target/destination, and no denial or inquiry wording.
- Exact, explicitly requested workspace mutations whose only risks are their
  intrinsic remove/overwrite semantics now bypass the LLM review. Direct file
  tools may proceed immediately; shell calls proceed only after a one-shot
  Runtime admission and execute through Anthropic Sandbox Runtime with network
  denied, credentials removed, and writes limited to the workspace/system temp
  boundary. Host-side input changes are rechecked before execution.
- Windows `move`, `copy`, `del`, `rd`, and `rmdir` switches are parsed by
  command semantics rather than as targets. If ASRT is not provisioned, Runtime
  emits setup guidance and rechecks readiness after a short bounded interval.
- Ambiguous Windows commands with a quoted trailing directory separator remain
  incomplete and therefore cannot enter the deterministic fast path.

#### Files Changed

- `packages/llm/src/side-query.ts`
- `packages/coding/src/guardrails/auto-mode/*`
- `packages/coding/src/tools/bash.ts`
- `packages/coding/src/types.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.ts`
- `packages/repl/src/permission/*`
- `src/sandbox-runtime.ts`
- `src/sdk-runtime.ts`
- `src/runtime-daemon/schema.ts`

#### Tests Added or Updated

- Classifier retry, timeout phase, prompt-byte, TTFT, intent-evidence, response
  contract, and confirmation semantics.
- Accept-edits failure fallback for workspace, outside, protected, read-only,
  and executable calls.
- Exact workspace copy/move/delete admission and ambiguous Windows parsing.
- ASRT one-shot request construction, credential filtering, workspace write
  boundary, and final bash spawn/cleanup.
- SDK permission diagnostics and Runtime daemon protocol schema coverage.

### 222: Invalid optional integration config aborts daemon cold start and discards child diagnostics

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.69 integration hot reload
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-28
- **Resolved**: 2026-07-28

#### Original Problem

KodaX Space v0.1.32 with KodaX 0.7.76 could keep Partner usable while every
Coder request failed with:

`Runtime daemon child exited before becoming healthy (code 1).`

The reported Windows machine had no `~/.kodax/runtime` directory, and the same
portable package worked on other machines. KodaX 0.1.28-era Space behavior,
before the daemon host was introduced, did not exercise this startup path.

An independently observed portable-launch error,
`Cannot find module 'better-sqlite3'`, remains a distinct extraction,
native-module, or endpoint-protection symptom in the Electron main process. It
does not explain an already running Space process whose Partner surface works
and whose Coder daemon alone fails. The daemon bootstrap log applies only when
the Runtime child is actually spawned; it does not replace the visible
Electron main-process error for a launch that fails earlier.

#### Context

- MCP, A2A, and filesystem Extensions are optional Coder integration domains.
  One malformed optional document must not make the core Runtime unusable.
- User configuration is evidence and must never be silently deleted,
  overwritten, or normalized after a parse or schema failure.
- A valid live configuration is last-known-good state. A later malformed edit
  must preserve that state until a valid revision arrives.
- Operators need a bounded, non-secret startup artifact even when failure
  happens before normal Runtime logging is initialized.

#### Root Cause

Daemon startup initialized all integration controllers before advertising
health. The first invalid `integrations/mcp.json`,
`integrations/a2a.json`, or `integrations/extensions.json` document threw from
strict cold-start loading, so the child exited with code 1 before the host
created normal Runtime artifacts. The detached parent launched the child with
ignored stdout/stderr, discarding the only concrete exception. MCP and
Extensions also resolved the ambient KodaX home instead of the daemon's
explicit `--home`, which could make foreground diagnosis inspect a different
configuration tree.

#### Resolution

- Each optional integration controller now validates independently. Invalid
  cold-start input produces a safe empty document only for that domain while
  retaining a structured diagnostic; it does not modify the source file.
- A later invalid revision continues using the last-known-good snapshot. File
  watching accepts a repaired valid revision without restarting the daemon.
- While a split MCP/Extensions file is absent, the legacy `config.json`
  dependency participates in both filesystem watching and metadata polling.
  Diagnostics point to that actual legacy source, and repairing it hot-recovers
  without creating or deleting configuration.
- Daemon management reports core health separately from bounded per-domain
  integration state, source, path, revision, and diagnostic code. A degraded
  optional domain leaves the daemon ready.
- `kodax integrations status|validate|reload` evaluates domains independently,
  reports the affected canonical path, and never prints configuration
  contents.
- Detached child stdout/stderr is written through a bounded writer to
  `~/.kodax/runtime/daemon/<profile>/bootstrap.log`, with one bounded
  `bootstrap.log.1` rotation. The active file is tail-capped after every
  post-health write, not only at the next launch. Runtime directories are
  created before spawn, so early module-load, ABI, policy, and configuration
  failures leave evidence.
- Daemons advertise `integrationConfigResilience` v1. Embedders can require
  this exact behavior instead of relying on a package-version guess.
- MCP, Extensions, and A2A now all use the exact daemon `--home` boundary.
- The built-in manual documents domain-specific repair, non-destructive
  behavior, hot recovery, structured degradation, and bootstrap log paths.

#### Files Changed

- `packages/repl/src/common/integration-config.ts`
- `src/integration-hot-reload.ts`
- `src/a2a/runtime-config.ts`
- `src/kodax_cli.ts`
- `src/integration-cli.ts`
- `src/sdk-runtime.ts`
- `src/runtime-daemon/management.ts`
- `src/runtime-daemon/host.ts`
- `src/runtime-daemon/manager.ts`
- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/schema.ts`
- `packages/coding/src/self-knowledge/registry.ts`
- focused controller, CLI, daemon, smoke, and manual tests

#### Tests Added

- Invalid MCP, A2A, and Extensions cold starts prove independent safe-empty
  fallback, preserved diagnostics, no file mutation, and hot repair.
- Strict controllers without an explicit cold-start default retain their
  previous fail-fast contract.
- Daemon host tests prove core readiness and structured degraded management
  state can coexist.
- CLI tests prove independent validation and content-safe diagnostics.
- Process tests prove active-log capping, bounded rotation, post-health bounded
  writes, and actionable early-exit hints.
- A real daemon smoke test proves invalid A2A under an explicit `--home` starts
  ready/degraded and reads no ambient integration tree.

### 221: FEATURE_276 review found initialization bypass, help side effects, invalid-config, and concurrent overwrite gaps

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.78 development
- **Fixed**: v0.7.78 development
- **Created**: 2026-07-28
- **Resolved**: 2026-07-28

#### Original Problem

The first FEATURE_276 implementation did not yet make every setup boundary
safe. `KODAX_PROVIDER` could bypass the new-environment gate; `setup --help`
was checked only after general startup work; existing split configuration was
classified as `existing` without validating its document contract; and legacy
integration migration or simultaneous KodaX core-config writers could
overwrite one another. Templates installed under a
custom `KODAX_HOME` also retained the literal `~/.kodax` path hint.

#### Context

- Help must be genuinely read-only, including in homes containing legacy
  migration or retention state.
- Existing active config is authoritative but cannot be presented as ready
  when KodaX cannot parse it.
- Setup may run from two terminals or race another cooperating KodaX process;
  revision checks performed only before choice normalization are not sufficient.
- External editors do not participate in KodaX locks; users should not manually
  edit `config.json` while an interactive setup confirmation is in progress.
- Active `config.json` remains strict JSON and was not changed to JSONC.

#### Root Cause

The bare-start readiness call treated an environment-derived Provider the same
as an explicit CLI override. The Commander help boundary lived after startup
initializers. The setup initializer used existence-only classification, while
the integration create path relied on a pre-write absence check and rename,
which can replace a destination. Provider setup checked the revision before
writing but did not serialize the complete read/check/write transaction.
Template installation copied source bytes without resolving its documented
home placeholder.

#### Resolution

- Only an explicit `--provider` may bypass the missing-config first-run gate.
- Exact `setup -h/--help` returns before hardening, config loading/migration,
  tracing, managed-child cleanup, and session retention work.
- Core, MCP, Extensions, and A2A active files are validated before setup writes
  anything. The root canonical A2A parser is explicitly injected into both
  REPLs. Pending legacy MCP/Extensions are also validated together before
  either migration write. Invalid files receive diagnostics, stop setup,
  preserve all bytes, and return a failure exit code.
- Integration migration now preflights both pending domains in its public
  entry, uses create-only atomic linking, and reports typed conflicts.
  Provider setup, `saveConfig`, Custom Provider CRUD, SDK-home mutations,
  startup permission/agent self-healing, and legacy cleanup share one
  core-config writer lock; setup also rechecks the revision after normalizing
  the choice.
- Installed templates resolve the first-line path hint and commented paths to
  the actual `KODAX_HOME`; source templates remain portable.
- Provider guidance/model examples and self-knowledge shortcut documentation
  were corrected to the canonical runtime contracts.

#### Files Changed

- `src/kodax_cli.ts`
- `src/kodax_cli.interactive-exit.test.ts`
- `src/kodax_cli.setup-boundary.test.ts`
- `packages/repl/src/common/setup-config.ts`
- `packages/repl/src/common/setup-config.test.ts`
- `packages/repl/src/common/core-config-lock.ts`
- `packages/repl/src/common/core-config-lock.test.ts`
- `packages/repl/src/common/integration-config.ts`
- `packages/repl/src/common/integration-config.test.ts`
- `packages/repl/src/common/provider-setup.ts`
- `packages/repl/src/common/provider-setup.test.ts`
- `packages/repl/src/common/custom-providers.ts`
- `packages/repl/src/common/custom-providers.test.ts`
- `packages/repl/src/common/utils.ts`
- `packages/repl/src/common/agent-mode-migration.test.ts`
- `packages/repl/src/commands/types.ts`
- `packages/repl/src/interactive/commands.ts`
- `packages/repl/src/interactive/commands-help.test.ts`
- `packages/repl/src/interactive/repl.ts`
- `packages/repl/src/interactive/provider-setup.test.ts`
- `packages/repl/src/ui/InkREPL.tsx`
- `src/sdk-runtime.ts`
- `vitest.test-tiers.ts`
- `packages/coding/src/self-knowledge/registry.ts`
- `config-templates/config.example.jsonc`
- `README.md`
- `README_CN.md`
- `docs/test-guides/ISSUE_221_v0.7.78_REGRESSION_GUIDE.md`

#### Tests Added

- Startup tests prove `KODAX_PROVIDER` cannot bypass initialization and that
  help calls no general startup initializer.
- Built-process tests prove help is read-only, real setup creates all eight
  files, and invalid split config preserves bytes and exits unsuccessfully.
- Schema preflight tests cover invalid core/MCP/Extensions/A2A files.
- Concurrency tests cover create-only integration writes and the Provider setup
  lock shared with other KodaX writers; startup self-healing and public legacy
  cleanup also respect that lock. Immediate and mid-wizard EOF cancel without
  hanging or writing metadata.
- The real built-process suite is a normal system/CI test and covers canonical
  A2A rejection plus Commander `--custom` passthrough.
- Template, self-knowledge, command-help, build, fast, unit, contract, and
  system regressions cover the complete repaired surface.

### 220: Integration hot-reload output overwrites the Ink status bar

- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.7.69 integration hot reload
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-28
- **Resolved**: 2026-07-28

#### Original Problem

While the Ink REPL is running, editing `~/.kodax/integrations/mcp.json`
successfully hot-reloads the MCP configuration, but the reload message is
written at the status-bar position and obscures the status bar. The message
should use the same transient UI treatment as clipboard feedback and disappear
after a short delay.

#### Context

- Affected surface: fullscreen Ink REPL.
- Reproduction: start interactive KodaX, edit and save `mcp.json`, and observe
  the `[integrations] MCP configuration hot-reloaded ...` message.
- Classic and non-interactive output should continue using normal terminal
  logging because they do not have an Ink-owned transient notification layer.

#### Root Cause

The CLI integration watcher writes live events through `console.error` while
the Ink renderer is active. Ink runs with `patchConsole: false`, so the write
bypasses the React footer layout and lands in the terminal region currently
occupied by the status bar.

#### Resolution

Integration and A2A configuration events now pass through a small bridge. While
the Ink REPL is mounted, it subscribes the existing clipboard-style toast
surface, so successful reloads appear as success notices, diagnostics appear as
warnings, and both disappear through the existing two-second timer. When no Ink
subscriber exists, including classic and non-interactive modes, the bridge
preserves the prior `[integrations]` terminal log.

#### Files Changed

- `src/integration-hot-reload.ts`
- `src/integration-hot-reload.test.ts`
- `src/kodax_cli.ts`
- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/index.ts`
- `packages/repl/src/index.ts`

#### Tests Added

- Integration event bridge routes live events to transient notices and restores
  terminal fallback after unsubscribe.
- Existing hot-reload integration coverage still validates live MCP and
  Extension reconciliation.

### 219: Daemon start can report healthy while its returned state is still starting

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: runtime daemon child startup
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-27
- **Resolved**: 2026-07-27

#### Original Problem

The real daemon CLI smoke intermittently returned `health: "healthy"` together
with `state.status: "starting"`. Hosts could therefore receive a successful
start result before the durable owner state reached its public ready boundary.

#### Root Cause

`waitForHealthyDaemonStartup()` used endpoint reachability, PID liveness, and
owner identity as its terminal condition. Those signals can become healthy
slightly before the daemon atomically publishes `status: "ready"`.

#### Resolution

Startup now keeps polling until the matching healthy owner state is also
`ready`; only then may it unref its spawned child, return a competing owner, or
attach to an owner discovered by a concurrent CLI/SDK starter. Waiting is
bounded and cancellable, never spawns or terminates a competitor, and rejects
an identity change. Deterministic tests cover owned, competing, and pre-existing
owners. A real process smoke holds the socket-reachable daemon at `starting`,
verifies that concurrent CLI start and SDK auto-start remain pending, then
confirms that both complete only after the same owner publishes `ready`.

#### Files Changed

- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/process.test.ts`
- `src/runtime-daemon/host.ts`
- `src/kodax_cli.ts`
- `src/kodax_cli.daemon-smoke.test.ts`
- `docs/test-guides/ISSUE_219_v0.7.77_REGRESSION_GUIDE.md`

#### Validation

- Runtime daemon startup unit tests passed 16/16.
- The focused real daemon concurrent CLI/SDK readiness smoke passed.

### 218: Missing historical image files make every later Provider run fail

- **Priority**: High
- **Status**: Resolved
- **Introduced**: image-path history introduction
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-27
- **Resolved**: 2026-07-27

#### Original Problem

KodaX persists image content blocks by absolute local path. Provider serializers reopen every
image in the complete history on each later request. If a host stored an image in temporary
storage and that file disappeared, every later turn failed with `ENOENT`, including text-only
follow-ups. Runtime credential scoping could then replace the useful filesystem detail with the
generic `Provider run failed while using a run-scoped credential` message.

#### Root Cause

The Anthropic-compatible serializer read user and tool-result image paths unconditionally, and
the OpenAI-compatible serializer unconditionally built a data URL from each user image. Neither
serializer distinguished a missing historical attachment from other filesystem failures.

#### Resolution

Both Provider families now convert only `ENOENT` and `ENOTDIR` image reads into the path-free
text marker `[Historical image unavailable: the local attachment file is missing.]`. Existing
text and tool-result structure remain intact, so the model can continue with the available
history. OpenAI-compatible tool-result image blocks, which cannot carry inline images, now use
path-free missing/unsupported markers rather than serializing the absolute local path. Other
filesystem failures in image-reading branches still propagate unchanged.

#### Files Changed

- `packages/llm/src/providers/image-serialization.ts`
- `packages/llm/src/providers/anthropic.ts`
- `packages/llm/src/providers/openai.ts`
- `packages/llm/src/providers/image-serialization.test.ts`
- `packages/llm/src/providers/anthropic-message-serialization.test.ts`
- `packages/llm/src/providers/openai-message-serialization.test.ts`
- `docs/test-guides/ISSUE_218_v0.7.77_REGRESSION_GUIDE.md`

#### Validation

- Focused Provider and image-serialization tests passed 46/46.
- The complete root package build passed, including package TypeScript, SDK bundles, Worker
  sidecars, import guards, and declaration bundles.

### 217: CLI bridge confuses ACP IDs with native CLI resume IDs and shares a default session

- **Priority**: High
- **Status**: Resolved
- **Introduced**: CLI bridge introduction
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-27
- **Resolved**: 2026-07-27

#### Original Problem

Codex CLI and Gemini CLI bridge requests could attempt to resume a generated
pseudo-ACP UUID on their first prompt. Calls without an explicit transport
conversation ID also reused one process-global `"default"` ACP session, so
different KodaX Sessions could inherit the same native CLI history. Native
non-zero exits were logged but could surface as an empty successful turn.

#### Root Cause

`KodaXAcpProvider` used `streamOptions.sessionId ?? "default"` as its ACP
session-map key. The pseudo-ACP server generated an independent UUID for
`session/new`, then forwarded that ACP ID directly as `CLIExecutionOptions`
`sessionId`. Codex and Gemini interpreted any such value as a native resume
request even though neither CLI had reported it. The bridge discarded
`session_start` as routing state, never released one-shot mappings, and the
shared CLI executor did not inspect the child process exit code.

#### Resolution

The pseudo bridge now treats ACP conversation IDs and native CLI session IDs
as separate namespaces. A first prompt is always fresh; a later prompt in the
same explicit ACP conversation resumes only a non-empty ID reported by the
CLI's `session_start` event. Stateless Provider calls create independent
one-shot ACP sessions and release their native mapping, while two explicit
conversation IDs reuse only their own sessions. Non-zero CLI exits reject the
generator, pseudo-ACP returns a JSON-RPC error, and `AcpClient.prompt()` rejects
instead of returning normal `end_turn`. Cancellation semantics remain
unchanged. Concurrent first use shares one connection promise; a failed
initialization resets for retry. Concurrent prompts for the same explicit
conversation fail visibly rather than overwriting active output routing, while
independent stateless calls may still run concurrently. A failed connection or
explicit disconnect rebuilds the pseudo transport with fresh streams rather
than reusing a closed `TransformStream`; abort closes the reader/writer
endpoints actually held by the bridge. Disconnect also closes an in-flight
handshake immediately, and a transport closure during `session/new` or
`session/prompt` invalidates the stale client so the next Runtime retry creates
a new connection. A reported successful `complete` event is retained while the
executor is drained to termination, so a later non-zero process exit still
rejects the prompt; a zero-exit stream without any `complete` event also fails
closed. Default `AbortError` remains user cancellation, while a hard/idle
timeout carried in `AbortSignal.reason` is propagated through both rejected
prompts and ACP `stopReason: cancelled` responses so Runtime resilience sees a
real failure instead of an empty success. Native `AcpClient.prompt()` also
races the caller signal directly, preserves its exact reason, and consumes the
late Provider settlement, so a server that ignores its best-effort cancel
cannot retain the request. `CLIExecutorConfig.timeout` is now a real process
deadline: stdout iteration and process close both race the deadline, the local
pipe is released, and one memoized process-tree termination is requested
before throwing even when the CLI emitted `complete` first.

#### Files Changed

- `packages/llm/src/cli-events/executor.ts`
- `packages/llm/src/cli-events/acp-client.ts`
- `packages/llm/src/cli-events/pseudo-acp-server.ts`
- `packages/llm/src/providers/acp-base.ts`
- `docs/test-guides/ISSUE_217_v0.7.77_REGRESSION_GUIDE.md`

#### Tests Added

- first-turn fresh and CLI-native-only resume across two ACP sessions;
- independent reuse for explicit conversation A/B;
- concurrent first-use initialization and same-conversation rejection;
- fresh transport recreation after connect failure and explicit disconnect;
- pending-handshake cancellation and post-connect transport-death recovery;
- one-shot session cleanup;
- held-endpoint abort, missing-`complete` rejection, and post-`complete`
  generator draining;
- configured timeout termination after `complete` without process exit;
- user-cancellation versus hard/idle-timeout Abort reason propagation;
- native ACP prompt cancellation when the server leaves the prompt unresolved;
- non-zero exit, normalized error/failed completion, pre-aborted input, and
  pseudo-ACP/AcpClient error propagation.

### 216: Codex CLI and Gemini CLI cache usage is dropped by the CLI event bridge

- **Priority**: High
- **Status**: Resolved
- **Introduced**: CLI bridge introduction
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-27
- **Resolved**: 2026-07-27

#### Original Problem

Codex CLI terminal events reported `cached_input_tokens` and
`cache_write_input_tokens`, and Gemini CLI result events reported
`stats.cached`, but KodaX Runtime cache diagnostics and downstream UI consumers
showed no cache usage.

#### Root Cause

The provider-specific JSONL parsers discarded the official cache counters while
converting terminal records into the shared `CLIEvent` usage shape. The shared
shape did not declare cache-read/write fields, and Gemini's parser manufactured
zero-valued core usage when required fields were absent. The pseudo-ACP and
KodaX usage layers already supported cache counters, so the loss happened
before those layers.

#### Resolution

Extended terminal CLI usage with optional read/write cache counters. Codex
`turn.completed` now maps both official cache fields; Gemini `result` maps
`stats.cached` as cache reads and leaves cache writes unreported. Input totals
remain the upstream totals and are not increased by their cache breakdown.
Explicit Provider zero is preserved, while absent, negative, non-finite, or
malformed fields remain omitted. ACP normalization now rejects missing core
usage instead of manufacturing zeros, and Runtime diagnostics omit unreported
cache properties so reconnecting hosts can distinguish "reported zero" from
"not reported."

#### Files Changed

- `packages/llm/src/cli-events/codex-parser.ts`
- `packages/llm/src/cli-events/gemini-parser.ts`
- `packages/llm/src/cli-events/types.ts`
- `packages/llm/src/cli-events/pseudo-acp-server.test.ts`
- `packages/llm/src/providers/acp-base.ts`
- `packages/coding/src/agent-runtime/prompt-cache-diagnostics.ts`
- `docs/test-guides/ISSUE_216_v0.7.77_REGRESSION_GUIDE.md`

### 215: Managed Provider requests omit stable prompt-cache session affinity

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.77 development and earlier
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-27
- **Resolved**: 2026-07-27

#### Original Problem

Kimi Code requests already carried Anthropic `cache_control` breakpoints, but
AMA and SA physical requests did not provide a stable logical Session affinity
key. Real same-Session requests with identical prompt-envelope hashes could
therefore report zero cache reads until a later request happened to reach the
same Provider cache route.

#### Root Cause

Runtime maintained stable root/child diagnostic context identities, while the
Provider stream contract exposed only ACP's conversation `sessionId`. The
managed adapter never lowered a cache-routing identity to Anthropic-compatible
`metadata.user_id` or OpenAI `prompt_cache_key`, and fallback and compaction
requests did not inherit one. Reusing the physical child transcript Session
would also have made the value unstable across resumed child workers.

#### Resolution

Added a separate opaque `promptCacheKey` request option derived with
domain-separated SHA-256 from the stable logical context identity. Root
requests remain stable across runs and restored Sessions; child keys use the
canonical Agent path, remain stable across physical worker Sessions, and are
isolated from both their parent and siblings. AMA, SA, retries, max-token
continuations, non-streaming fallback, and compaction summaries all reuse the
same key.

Verified built-in Kimi Code lowers the key to Anthropic-compatible
`metadata.user_id`, while public Kimi and official OpenAI lower it to
`prompt_cache_key`. Custom compatible Providers must explicitly opt in with
`promptCacheAffinity: true`; this avoids breaking strict gateways that reject
unknown request fields. `disablePromptCache: true` omits the affinity field,
and no raw Session or Agent identity is sent. Diagnostics expose only
`promptCacheAffinityHash` when the endpoint applies the key, separately from
the prompt-byte `requestEnvelopeHash`. This establishes stable routing
conditions but does not promise a cache hit when Provider TTL, sharding, load
balancing, or endpoint policy intervenes.

The release keeps canonical Agent isolation deliberately. Root and child
requests currently replace the System prompt and Tool set, so sharing one key
does not create an identical prefix; it can instead concentrate concurrent
traffic on one routing key. This trades away possible reuse among same-shaped
sibling children. A session-wide or prefix-family policy requires controlled
Provider-specific A/B evidence and is not claimed by this fix.

#### Files Changed

- `packages/llm/src/types.ts`
- `packages/llm/src/providers/anthropic.ts`
- `packages/llm/src/providers/openai.ts`
- `packages/llm/src/providers/registry.ts`
- `packages/coding/src/agent-runtime/prompt-cache-affinity.ts`
- AMA/SA request, fallback, retry, child, and compaction call sites
- `docs/test-guides/ISSUE_215_v0.7.77_REGRESSION_GUIDE.md`

### 214: Daemon shell tools freeze startup PATH and expose inherited credentials

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.77 and earlier
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-26
- **Resolved**: 2026-07-27

#### Original Problem

The built-in `bash` tool always uses `shell: true` and the long-lived daemon's
startup `process.env`. Hosts cannot select a shell/profile per Session or Run,
directory-scoped toolchains are not re-resolved in the actual execution
directory, and model-issued commands inherit provider credentials.

#### Root Cause

The public Runtime contract carries `executionCwd` but has no serializable shell
execution policy. Tool execution therefore couples the correct working
directory to a stale, process-global environment and implicit platform shell.
Child runtimes and permission grants also have no interpreter identity to
inherit or bind.

#### Resolution

Added a strict, JSON-only Session/Run `shellExecution` contract for pwsh,
Windows PowerShell, cmd, bash, zsh, and explicit shell paths. Configured command
execution now sanitizes the daemon environment before profile/setup code runs,
captures the cwd-specific environment through a random framed payload,
validates and sanitizes it again, then executes with the same explicit
interpreter. Unknown or unsafe fields fail validation; an unavailable selected
shell fails visibly instead of changing command semantics through a fallback.
Every registered built-in, custom, and runtime Provider's exact `apiKeyEnv` is
denied even when its name does not match a credential-shaped pattern.

Environment cache identity includes the normalized contract, canonical cwd,
refresh token, and Session scratch identity, with a strict bounded TTL.
Windows hosts may re-read Machine/User registry environments, recursively
expand current persistent variables, and keep `%PATH%` independent from the
daemon's stale startup environment. Runtime persistence,
daemon transport, foreground/background command tools, AMA deterministic
evaluators, native Actor descendants, and legacy/workflow children share the
contract. Exact-command permission grants are bound to the interpreter
contract hash, while diagnostics expose only the shell kind and hash. The
unconfigured command path remains compatible.

The post-implementation review additionally closed explicit-`undefined`
Session inheritance, PowerShell switch/profile mismatches, pre-probe
`NODE_OPTIONS`, host deny precedence, cmd prefix takeover, and cmd-only hint
leakage. Shared in-flight probes now use waiter-counted cancellation: the last
cancelled waiter terminates the profile process, while a remaining waiter keeps
the shared resolution alive. Windows CI now executes the focused PowerShell,
cmd, Registry, and Git Bash contract suite.

#### Files Changed

- `packages/coding/src/shell-execution/`
- `packages/coding/src/tools/bash.ts`
- `packages/coding/src/task-engine/deterministic-evaluator.ts`
- Runtime/daemon settings, permission scope, and child-context propagation
- Focused shell, evaluator, Runtime, daemon, permission, and child regressions
- `docs/test-guides/ISSUE_214_v0.7.77_REGRESSION_GUIDE.md`

### 213: Published v0.7.77 archive predates AMA request-only managed-context reinjection

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.77 package
- **Fixed**: v0.7.77 repack
- **Created**: 2026-07-26
- **Resolved**: 2026-07-26

#### Original Problem

The `kodax-ai-kodax-0.7.77.tgz` supplied to KodaX-Space was built before
commit `3363f1cf`. Its AMA Worker persisted Skills, MCP, task, Session, and
other managed-run context as `_source: managed-run-context` transcript
messages. Automatic compaction could summarize or remove that message, so
later Worker requests lost the full Skill catalog and context diagnostics
reported `skillCatalog: 0`.

#### Root Cause

The archive version matched the source package version but not the release
commit. The bundle did not contain the `supportsEphemeralSuffix` capability
contract or the request-only managed-context resolver introduced by
`3363f1cf`, and no end-to-end automatic-compaction test covered both native
ephemeral suffix delivery and the legacy Provider lowering path.

#### Resolution

Rebuilt the archive from a detached, clean `3363f1cf` worktree and verified
the packed SDK entry points plus the native/fallback suffix markers. Added a
real Runner automatic-compaction regression proving each pre/post-compaction
Worker request contains exactly one Skills addendum and selected Skill,
`skillCatalog` remains non-zero, and compactable/durable transcripts never
persist the managed-run context. The regression covers native ephemeral suffix
delivery and legacy Provider request-only lowering.

#### Files Changed

- `packages/coding/src/task-engine/runner-driven.compaction-context.test.ts`
- `kodax-ai-kodax-0.7.77.tgz`
- `docs/test-guides/ISSUE_213_v0.7.77_REGRESSION_GUIDE.md`

### 212: v0.7.77 review found child-briefing corruption, lossy interrupt validation, and terminal/schema contract drift

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.77 development
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-26
- **Resolved**: 2026-07-26

#### Original Problem

- Nested Markdown fences in `agent-turn:` evidence were replaced with visible
  mojibake instead of the invisible fence-breaking sequence used for ordinary
  `agent:` evidence.
- Runtime interrupt input was dequeued before every artifact in the batch had
  passed validation. A later invalid artifact could discard the complete batch
  and leave a partially appended user-message batch.
- Memory prompt safety missed qualified credential claims such as
  `db password used by staging is ...`.
- The governed memory renderer gained prompt-safety, evidence-ref, and token
  limits without changing its frozen evidence fingerprint.
- Natural iteration-limit success omitted `onComplete`; a completion observer
  throwing `AbortError` could also leave the live turn marked `completed` while
  the returned result was `interrupted`.
- The pattern-disposition JSON Schema allowed both target forms together even
  though the parser requires exactly one. Tightening the Schema with `oneOf`
  was also not viable on its own: the workflow subset validator silently
  ignored `oneOf` at validation time, while `assertSupportedOutputSchema`
  rejected the keyword at declaration time.

#### Root Cause

- The `agent-turn:` sanitizer contained a corrupted string literal and lacked
  an assertion for the exact replacement sequence.
- Interrupt consumption combined destructive queue access, per-item
  validation, and message mutation in one pass.
- The credential heuristic only matched a credential noun immediately followed
  by a copula.
- The evidence hash covered display text but not the policy identity and
  governed renderer limits.
- Terminal events were emitted at individual early-return sites instead of
  consistently reflecting the final result, and loop exhaustion lacked the
  shared completion event.
- The target Schema described a loose union while `parseOutcome` enforced XOR,
  and the subset validator predated any `oneOf` usage and listed the keyword
  as unsupported.

#### Resolution

- Unified both child-evidence fence sanitizers on explicit zero-width
  separators and pinned the invisible output.
- Changed interrupt consumption to peek and validate the complete batch before
  one dequeue or message append.
- Added bounded matching for common qualified credential sentences while
  retaining ordinary non-secret status statements.
- Exported the renderer limits as shared constants and included them with the
  policy identity in the pinned SHA-256 evidence fingerprint.
- Centralized caught-terminal finalization, derived live-turn completion from
  the final result, and emitted exactly one `onComplete` for iteration-limit
  success.
- Made the disposition target Schema a closed `oneOf` matching the parser's
  actor-turn-or-evidence target contract, and taught the subset validator
  `oneOf` (exactly-one-variant) so first-pass structured-output validation
  genuinely rejects mixed targets and the Schema remains declarable on the
  workflow path.

#### Files Changed

- `packages/coding/src/child-executor.ts`
- `packages/coding/src/agent-runtime/run-substrate.ts`
- `packages/coding/src/orchestration/pattern-result.ts`
- `packages/coding/src/workflows/structured-output.ts`
- `packages/agent/src/memory-control/prompt-safety.ts`
- `packages/agent/src/experimental-memory/reminder-envelope.ts`
- `packages/coding/src/memory/rendering.ts`
- Focused unit and contract tests for each corrected behavior
- `docs/test-guides/ISSUE_212_v0.7.77_REGRESSION_GUIDE.md`

### 211: AMA stable System prompt still embeds the Session scratch path across new Sessions

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.77 development
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-26
- **Resolved**: 2026-07-26

#### Original Problem

Two first requests from fresh Sessions in the same project, using the same
provider, model, query, reasoning, and 66-tool set, produced identical
message/tool hashes but different System-prompt and request-envelope hashes.
The requests were only about 26 seconds apart, yet the Qwen
Anthropic-compatible endpoint reported a full cache write and zero cache read
for both.

#### Context

- Runtime-persisted request events prove that only the System portion of the
  otherwise-equivalent request envelope changed.
- Provider TTL, routing, and cache sharding can still affect cache reuse, but
  they do not explain a locally observed System hash change.
- The absent `ephemeralSuffixHash` is not evidence that the Provider cache
  marker was omitted. That field describes an optional request-only suffix;
  Anthropic-compatible `cache_control` markers are a separate wire mechanism.
- Anthropic-compatible usage must continue to normalize uncached input plus
  cache creation/read input into total input tokens.

#### Root Cause

The AMA stable role prompt includes the Session-specific scratch directory
twice: once in the Environment block and again in workspace-discipline
guidance. The existing cache-stability regression covers two runs in one
Session, so both paths reuse the same scratch directory and the defect remains
invisible.

#### Proposed Solution

- Keep only project/provider/platform facts in the stable Environment block.
- Move the concrete Session scratch directory into the synthetic managed-run
  user/context message after the System/tool cache boundary.
- Make workspace-discipline wording stable while retaining the same scratch
  safety contract.
- Add a two-new-Session wire-prefix regression and lock the Qwen
  Anthropic-compatible total-input usage semantics.

#### Resolution

- Removed the concrete Session scratch path from both stable System locations
  and made the scratch-discipline rule byte-stable.
- AMA now supplies run-scoped repository, memory, routing, Session, and
  verification facts on each logical LLM turn through the existing request-only
  `ephemeralSuffix`; live Actor and Team facts are refreshed for each turn.
- Anthropic-compatible providers place the latest-user cache marker before this
  suffix. Equivalent new-Session requests therefore keep System, tools, and
  persistent Provider-visible messages identical while allowing the volatile
  suffix hash to change independently.
- The same suffix is forwarded through stream retry, non-streaming fallback,
  and max-token continuation paths. Context-budget diagnostics classify it
  once without exposing prompt text, and provider-cache diagnostics now emit
  its hash.
- OpenAI-compatible transports merge the suffix into the final wire user turn,
  avoiding consecutive `user,user` messages rejected by stricter Qwen/proxy
  endpoints.
- Providers explicitly declare whether they lower native suffix options.
  Runtime-registered legacy Providers default to a request-only message-copy
  fallback, so managed context cannot be silently discarded.
- Managed context is no longer persisted into canonical transcript history;
  current facts are regenerated on each call, including Actor-capacity changes
  and idle-yield resumes.
- Topology-only callers without a full ReasoningPlan retain Session scratch
  guidance through the same request-only suffix.

#### Files Changed

- `packages/coding/src/task-engine/runner-driven.ts`
- `packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts`
- `packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`
- `packages/coding/src/agents/worker-role-prompt.ts`
- Anthropic usage and AMA prefix/diagnostic regression tests

#### Verification

- Two-new-Session RED reproduction identified both Session-path occurrences in
  System; the fixed test proves identical System, tools, and Provider-visible
  persistent messages with distinct request-only suffixes.
- AMA Actor-capacity refresh, prompt-cache/context-budget diagnostics,
  retry/fallback, compaction, Anthropic cache-control/serialization, and exact
  Qwen `6 + 25,408 = 25,414` input normalization regressions pass.
- The full fast/unit/contract/system matrix, root package build, bundle build,
  and declaration build pass.

### 210: Runtime diagnostic identity and latest cache query contracts are incomplete

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.77 development
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-26
- **Resolved**: 2026-07-26

#### Original Problem

Runtime child diagnostic lookup matches logical child identity through
`contextId`, but the base public budget, tool-exposure, compaction-skip, and
prompt-cache payload types do not consistently declare or construct
`contextId` / `parentContextId`. Production SA/AMA paths normally gain those
fields from live-turn attribution, while direct callback fixtures and other
boundary paths can omit them. Existing latest-child tests manually inserted
the missing identity and therefore did not exercise the Runtime boundary
contract.

`provider.cache.diagnostics` is available as a live/replay event, but
`RuntimeDiagnosticsService` and the daemon protocol expose latest queries only
for context budget and tool exposure. A reconnecting Space client cannot fetch
the most recent provider cache diagnostic without replaying and filtering the
event stream itself.

#### Context

- Affected components: coding diagnostics payloads, inline Runtime event
  normalization, Runtime diagnostics service, daemon client/server/schema.
- The strict child filter is intentional: removing its logical Session check
  would permit same-`agentId` diagnostics from another root Session to match.
- Provider cache hashes and Provider-reported usage are not the defect and must
  remain unchanged.

#### Proposed Solution

- Declare and fill stable logical `contextId` / `parentContextId` on diagnostic
  payloads while retaining physical child `sessionId` ownership.
- Normalize missing identity once at the Runtime boundary without prompt text.
- Add `latestProviderCacheDiagnostic(filter?)` to inline and daemon Runtime
  services with the same root-default and child-isolation semantics.
- Cover real-source identity, root/child latest lookup, Session/Agent
  isolation, and persisted reconnect recovery.

#### Resolution

- Diagnostic source objects now carry logical `contextId` and
  `parentContextId` through SA, AMA, compaction, retry, and fallback paths.
  The Runtime event boundary normalizes the same identity for direct callback
  integrations before persistence or live delivery.
- Strict child lookup remains based on logical context identity. It was not
  weakened to physical event-envelope Session matching, so isolated child
  transcript Sessions cannot collide with another root Session using the same
  `agentId`.
- Added `latestProviderCacheDiagnostic(filter?)` to inline Runtime and the
  daemon client/server/schema under `provider.cache.diagnostics.get`.
- Added root/child, same-Agent cross-Session, different-Agent, inline
  persistence restart, and daemon-client reconnect coverage. Existing
  request-envelope/ephemeral hashes and Provider-only cache usage remain
  unchanged.
- Runtime event persistence, live subscribers, and inline `options.events`
  callbacks now receive the same normalized diagnostic identity.

#### Files Changed

- `packages/coding/src/agent-runtime/` and
  `packages/coding/src/task-engine/_internal/managed-task/`
- `packages/coding/src/types.ts`
- `src/sdk-runtime.ts` and `src/runtime-daemon/`
- `docs/SDK_EMBEDDER_GUIDE.md` and `CHANGELOG.md`

#### Verification

- The full fast/unit/contract/system matrix passes 10,939 tests across 886
  files (1 skipped, 21 todo).
- Root TypeScript and complete package/bundle/declaration builds pass.

### 209: Child cache/context review found diagnostic identity, wire hashing, Workflow leaf, and specialist compatibility gaps

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.77 development
- **Fixed**: v0.7.77 development
- **Created**: 2026-07-26
- **Resolved**: 2026-07-26

#### Original Problem

The v0.7.77 child-cache follow-up review found five connected gaps:

1. Runtime child diagnostics use an isolated worker Session as their event
   `sessionId`, but the public latest-diagnostic query applies the caller's
   root Session filter before inspecting logical child identity. A natural
   `{ sessionId: root, contextKind: "child", agentId }` query therefore returns
   no result even though the child event exists under the same Runtime Run.
2. Prompt-cache message hashes include internal KodaX block fields and ordering
   that Provider serializers omit, lower, or canonicalize. A hash change is not
   yet strict evidence that the Provider wire prefix changed.
3. Workflow protocol leaves set `agentMode: "sa"` on a direct `runKodaX` call,
   but that entry does not apply the managed-dispatch SA collaboration-tool
   exclusions. The model can see and be encouraged to call Actor tools while
   no Actor control is bound.
4. Cache/budget diagnostic construction is only partially fail-open. Errors
   before the callback guard can enter Provider retry/recovery and prevent the
   real request from being sent.
5. Constructed specialist children changed from a full specialist override to
   the complete default child prompt plus specialist instructions. This
   improves prefix sharing but conflicts with the documented specialist
   contract and may inject unrelated output behavior into self-contained
   specialists.

#### Context

- Affected components: Runtime diagnostics, child Actor execution, Workflow
  child execution, prompt-cache attribution, constructed specialists.
- Root Actor recursive execution and mailbox routing themselves are working.
- Same-Actor follow-ups still reconstruct prior objective/result messages rather
  than replaying an exact append-only physical transcript; this is a documented
  remaining cache limitation, not part of the correctness failures above.

#### Root Cause

Logical context identity, physical worker Session identity, and Runtime query
scope were modeled separately but the query API filters only the physical
event envelope. Diagnostics hash the pre-Provider KodaX envelope rather than a
canonical Provider-visible projection. Direct child execution also bypasses
the SA dispatch transform, while specialist prefix stabilization reused the
full default behavioral prompt instead of a neutral invariant prefix.

#### Proposed Solution

- Match child diagnostic Session filters against logical context identity while
  preserving the physical worker Session for transcript ownership.
- Canonicalize every message block to fields and order that the selected
  Provider actually serializes before hashing.
- Explicitly remove Actor collaboration tools and guidance when no Actor
  control is bound.
- Make all diagnostic construction observational and fail-open.
- Keep the default child invariant prefix stable while restoring a selected
  specialist's full System override and preserving write-child project rules.

#### Resolution

- Runtime diagnostic queries now distinguish physical transcript ownership from
  logical root/child identity, so child snapshots can be queried through the
  root Session without displacing the default root result.
- SA, AMA, retry/fallback, digest/repair, and compaction requests emit the same
  fail-open diagnostic envelope. Hashes model the selected Provider's effective
  message projection (including ACP last-message behavior, Anthropic replay
  rules, OpenAI orphan repair, endpoint query, and optional suffix) and include
  a composite request-envelope hash. Response cache counts come only from
  Provider usage; absent cache-write counts stay absent.
- Actor-backed children remain on the recursive AMA-capable direct substrate.
  Actorless and Workflow leaves remain SA and cannot see collaboration tools or
  misleading guidance. Direct runs also hide `run_workflow` when no Workflow
  host is bound.
- Specialist System overrides and project mutation rules are preserved.
  Specialist tool ceilings are persisted into Actor principals and inherited
  by descendants; explicit deny-all remains deny-all. Final provider routing
  and fallback also enforce the Actor provider ceiling. Actorless Workflow
  leaves receive the admitted capability snapshot for enforcement without
  receiving an Actor collaboration control surface.
- Child briefings are derived from the final visible tools, and Workflow leaf
  diagnostic identities use admitted Actor paths to avoid collisions between
  independent Workflow backends.

#### Files Changed

- `packages/coding/src/agent-runtime/` — Provider-visible cache diagnostics,
  context-budget snapshots, direct-run tool visibility, and compaction wiring.
- `packages/agent/src/session-lineage/compaction/` — exact compaction request
  observation without coupling the generic package to coding telemetry.
- `packages/coding/src/child-executor.ts`, `child-fallback.ts`,
  `tools/agent-collaboration.ts`, and `workflows/agent-adapter.ts` — child
  identity, recursive capability ceilings, truthful briefing, and Workflow
  leaf behavior.
- `packages/llm/src/providers/` — shared Provider diagnostics accessors for
  Anthropic replay semantics and exact ACP prompt projection.
- `src/sdk-runtime.ts` and `src/runtime-daemon/` — logical child diagnostic
  query matching and latest-snapshot behavior.

#### Tests

- Added Provider projection, suffix/envelope, fail-open, official usage, and
  compaction request-observer regressions.
- Added recursive Actor, specialist deny-all/inherited tool ceiling, provider
  fallback ceiling, actorless Workflow leaf, collision-free identity, and
  unbound-tool visibility regressions.
- Re-ran targeted, fast, unit, contract, system, type-check, and distribution
  build gates.

### 208: v0.7.77 review found unbounded active-Run continuation and narrow memory prompt-safety matching

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.77 release candidate
- **Fixed**: v0.7.77 release candidate
- **Created**: 2026-07-26
- **Resolved**: 2026-07-26

#### Original Problem

The v0.7.77 active-Run finalization fix replaced the managed Runner's and
ordinary coding substrate's absolute iteration conditions with mutable limits.
Every accepted terminal continuation, and some lifecycle messages at the cap,
could add another iteration and reopen the Runtime input window. A continuously
submitting authenticated client could therefore keep one Run alive
indefinitely, accumulating model calls and transcript state.

The governed-memory content gate also recognized only a narrow
`ignore/disregard/override ... instructions` shape. Common reset/role variants,
self-closing role tags, and sentence-shaped credentials could pass the content
gate. Current coding consumers still applied the low-authority memory envelope,
but the documented deterministic defense-in-depth contract was incomplete.

The adjacent `onPromptCacheDiagnostics` event was correctly gated at runtime but
its public JSDoc omitted the same `context.contextDiagnostics` condition
documented on sibling events.

#### Root Cause

- `iterationLimit` had no absolute ceiling after lifecycle extensions.
- The first bounded fix treated the lifecycle allowance as wider than an
  admitted manifest's governance cap.
- Prompt safety treated a small word list as the complete override/secret/tag
  detector, checked before normalization, and duplicated an older credential
  predicate at the persistence boundary.
- The cache diagnostic callback was added without copying the sibling gating
  note.

#### Resolution

- Added a fixed eight-iteration lifecycle allowance beyond the configured cap
  in both execution loops while preserving admitted `maxIterations` as a hard
  ceiling. The final absolute generation closes admission before the model call,
  consumes the last already-accepted batch in the preceding reserved turn, and
  never reopens the window without remaining headroom.
- Expanded the central memory gate to reject common prompt reset/override noun
  variants, forged role-mode claims, self-closing role tags, and
  credential-shaped `password/api key/token is ...` forms while preserving
  ordinary status statements. The gate checks raw and bounded text through
  Unicode-normalized, formatting-separated, and formatting-joined detection
  views, and MemoryAgent persistence/query paths reuse its credential predicate.
  Direct credential structures fail closed even when formatting obscures the
  value, and malformed tag scanning remains linear.
- Documented the existing prompt-cache diagnostics gate.

#### Files Changed

- `packages/agent/src/primitives/runner-tool-loop.ts`
- `packages/agent/src/primitives/runner.ts`
- `packages/agent/src/primitives/runner.test.ts`
- `packages/agent/src/primitives/runner-iteration-clamp.test.ts`
- `packages/agent/src/memory-control/prompt-safety.ts`
- `packages/agent/src/memory-control/prompt-safety.test.ts`
- `packages/agent/src/experimental-memory/memory-agent.ts`
- `packages/agent/src/experimental-memory/memory-agent.test.ts`
- `packages/coding/src/agent-runtime/run-substrate.ts`
- `packages/coding/src/agent-runtime/run-substrate.terminal-interrupt.test.ts`
- `packages/coding/src/types.ts`
- `CHANGELOG.md`
- `docs/PRD.md`
- `docs/DD.md`
- `docs/SDK_EMBEDDER_GUIDE.md`

#### Verification

- TDD reproduced unbounded extension in both execution loops (the focused
  substrate case reached twelve model calls after eleven repeated submissions)
  with a one-iteration base cap before the fix. Each bounded path now performs
  nine calls, exposes the eighth accepted input to the ninth generation, and
  leaves admission closed.
- Adversarial prompt-safety cases failed before implementation and now reject
  all reported and normalization-obfuscated variants; ordinary nearby-word and
  credential-status controls remain accepted. Sentence-shaped secrets are also
  rejected at the durable digest boundary.
- The complete agent suite passes 1,652 tests; the final focused Runner,
  prompt-safety, and MemoryAgent rerun passes 145, the ordinary substrate
  regression passes 4,
  LLM cache/Kimi contract suites pass 166, Runtime passes 134, and tracker
  consistency passes 4.
- The complete production build passes config-template validation, workspace
  TypeScript compilation, SDK/CLI/worker bundles, worker audits, and declaration
  bundling.

### 207: Provider-only model selection leaves Runtime Auto LLM without the provider default model

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.73 Runtime Auto preflight
- **Fixed**: v0.7.77 release candidate
- **Created**: 2026-07-25
- **Resolved**: 2026-07-25

#### Original Problem

`/model zai-coding` intentionally selects the provider while leaving the model
unset so the provider's current default remains authoritative. The REPL status
bar and ordinary provider execution resolve that selection to `glm-5.2`, but a
Runtime-owned `Auto[LLM]` run rejects it before launch with
`auto_mode_classifier_model_required`.

An explicit `/model zai-coding/glm-5.2` or leaving Auto mode avoids the error,
but provider-only selection must work consistently in every permission mode.

#### Root Cause

Runtime run admission checked only the run's explicit model and
`runtime.defaultModel`. Provider execution resolved the selected provider's
default later, after the Auto LLM preflight, so the two paths disagreed about
whether an effective model existed.

#### Solution Implemented

- Runtime run admission now resolves the selected provider's credential-free
  static default as the final model fallback, after `modelOverride`, the
  Session/run model, and `runtime.defaultModel`.
- Keep unknown providers without a resolvable default on the existing fail-fast
  path.
- The resolved model is recorded and passed to both the Runtime-owned Auto
  guardrail and coding execution, so preflight, status events, and launch agree.

#### Files Changed

- `src/sdk-runtime.ts`
- `src/sdk-runtime.test.ts`

#### Verification

- TDD regression reproduced the original
  `auto_mode_classifier_model_required` failure before implementation.
- Focused known/unknown Provider boundary: 2 tests passed.
- Complete Runtime suite: 133 tests passed.
- Provider capability and CLI Runtime bridge suites: 46 tests passed.
- Full production build passed, including config-template validation, workspace
  TypeScript builds, SDK/CLI bundles, worker audits, and declaration bundles.

---

### 206: Static provider model catalogs duplicated default models in REPL completion and SDK listings

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.43 static model catalog; expanded v0.7.76
- **Fixed**: v0.7.77 release candidate
- **Created**: 2026-07-25
- **Resolved**: 2026-07-25

#### Original Problem

Two-stage `/model <provider>/` completion showed the default model twice when
the provider also declared a descriptor for that model. The visible cases were
`kimi-code/k3-256k`, `zhipu-coding/glm-5.2`, and
`zai-coding/glm-5.2`; the same catalog shape also affected
`ark-coding/glm-5.2`. Each logical `provider/model` route should appear once.

#### Root Cause

The descriptor and Provider-instance paths already treated a default model
descriptor as the canonical default entry. The older static helpers instead
prepended `snapshot.model` and then appended every `snapshot.models[]` ID.
That duplicated defaults carrying per-model context or reasoning overrides.
REPL completion consumed this older helper directly, and the SDK capability
listing repeated the same construction independently.

#### Solution Implemented

- Make `getProviderModels()` derive IDs from the existing default-aware
  `getProviderModelDescriptors()` result.
- Make `getProviderList().models` reuse `getProviderModels()`.
- Make `listBuiltinModelCapabilities()` enumerate the same canonical
  descriptors, preserving default-first catalog order and per-model metadata.
- Add whole-catalog uniqueness and four-alias REPL completion regressions.

#### Files Changed

- `packages/llm/src/providers/registry.ts`
- `packages/llm/src/providers/capability-profile.test.ts`
- `packages/llm/src/providers/model-capabilities.test.ts`
- `packages/repl/src/interactive/completers/argument-completer.test.ts`

#### Verification

- Focused provider catalog, SDK capability, and REPL completion suite:
  90 tests passed.

---

### 204: Auto mode could render without an engine and rapid permission-mode writes could settle out of order

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.72 Runtime REPL bridge
- **Fixed**: v0.7.74
- **Created**: 2026-07-23
- **Resolved**: 2026-07-23

#### Original Problem

A user could enter Auto and briefly see bare `Auto` rather than `Auto[LLM]` or
`Auto[RULES]`. Cycling the three permission modes could later make the expected
engine label appear, which made Auto look like it had an unexplained fourth
state. Rapid mode changes also launched overlapping Runtime settings updates,
so a slower earlier write could finish after the user's final selection.

The default mode-cycle binding is Shift-Tab. Shift+Enter remains the newline
binding; terminal remapping can make the physical key report confusing, but it
does not change the underlying mode-state defect.

#### Root Cause

- Ink updated `permissionMode` synchronously, but the Runtime-backed engine
  state started as `undefined` until asynchronous stats arrived.
- `syncSettings()` and `/auto-engine` writes had no per-Session ordering, so
  concurrent calls relied on transport completion order rather than input order.

#### Solution Implemented

- Resolve the status-bar engine from observed Runtime state or the configured
  engine while statistics are pending; Auto now always renders a known engine.
- Serialize settings and explicit engine writes per Session so the last user
  action is also the last persisted action.
- Preserve the existing semantic distinction: `Auto[RULES]` is a valid sticky
  automatic/manual fallback, and `/auto-engine llm` explicitly restores LLM
  classification.

#### Files Changed

- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/view-models/surface-status.ts`
- `packages/repl/src/ui/view-models/surface-status.test.ts`
- `src/kodax_cli.ts`
- `src/kodax_cli.runtime-runner.test.ts`
- `docs/test-guides/ISSUE_204_v0.7.74_REGRESSION_GUIDE.md`

#### Verification

- The view-model regression pins configured-engine fallback, observed-engine
  precedence, and non-Auto clearing.
- The Runtime bridge regression blocks an earlier write and proves the later
  mode cannot overtake it.
- Human checks cover Shift-Tab, Shift+Enter, normal/rapid cycling, and sticky
  rules fallback.

---

### 203: Compaction recovery guidance detached the compaction entry from the active lineage

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.74 development
- **Fixed**: v0.7.74
- **Created**: 2026-07-23
- **Resolved**: 2026-07-23

#### Original Problem

The compaction producer appended exact-history recovery guidance to its
synthetic checkpoint message, but Session lineage matched only the summary
prefix and summary text. `applySessionCompaction()` therefore persisted the
real checkpoint as a sibling message instead of reusing the new compaction
entry. The active path bypassed that entry, left `firstKeptEntryId` undefined,
and omitted its post-compact attachments from derived context.

#### Root Cause

The producer and lineage each owned a different checkpoint wire format. The
lineage copy had an empty suffix and used strict byte equality, so adding
recovery guidance to the producer silently broke structural matching.

#### Solution Implemented

- Reuse the producer's exported prefix and recovery-guidance constants when
  lineage renders or recognizes a compaction checkpoint.
- Render current checkpoints with the canonical recovery guidance while still
  accepting legacy suffix-free checkpoints during Session resume.
- Lock the topology contract to the exact producer bytes: the compaction entry
  remains on the active path, owns a first-kept pointer, and emits attachments
  immediately after the checkpoint without a duplicate message entry.
- Reconcile imperative manual compaction against the exact flat message
  snapshot before applying the compaction entry, so a legacy/stale lineage
  cannot omit history from later exact transcript search.

#### Files Changed

- `packages/agent/src/session-lineage/kodax-session-lineage.ts`
- `packages/agent/src/session-lineage/kodax-session-lineage.test.ts`
- `packages/repl/src/session/compact-session.ts`
- `packages/repl/src/session/compact-session.test.ts`

#### Tests Added

- Exact producer checkpoint plus attachment reconstructs as
  `compaction -> kept message`, with no synthetic checkpoint message sibling.
- Existing suffix-free checkpoint fixtures continue to match and are rendered
  in the current canonical form.

### 202: PowerShell bracket wildcards could bypass protected-path auto-mode review

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.74 development
- **Fixed**: v0.7.74
- **Created**: 2026-07-23
- **Resolved**: 2026-07-23

#### Original Problem

PowerShell `-Path` supports bracket wildcard expressions. A target such as
`[.]kodax/config.json` can resolve to `.kodax/config.json`, but the mutation
analyzer treated the lexical bracket-bearing path as an exact in-workspace
target. Rules-mode Auto could therefore allow a write that should have reached
protected-path confirmation.

#### Root Cause

The ambiguity guard covered `*`, `?`, variables, arrays, and provider paths but
omitted PowerShell's `[...]` wildcard syntax. The analyzer no longer has shell
quote provenance after argument parsing, so it cannot safely reinterpret a
wildcard-bearing `Path` as a literal filename.

#### Solution Implemented

- Mark bracket syntax on bound path-bearing parameters as incomplete before
  filesystem boundary classification, forcing deterministic escalation.
- Preserve exact `LiteralPath`/`PSPath` semantics so legitimate filenames such
  as `file[12].txt` remain fully modeled and auto-allowable in the workspace.

#### Files Changed

- `packages/repl/src/permission/powershell-mutation.ts`
- `packages/repl/src/permission/powershell-mutation.test.ts`
- `packages/repl/src/permission/auto-rules.test.ts`

#### Tests Added

- Low-level mutation analysis rejects `[.]kodax/config.json` through `-Path`
  but accepts `build/file[12].txt` through `-LiteralPath`.
- End-to-end Auto rules escalate the wildcard form and continue to allow the
  exact literal-path control case.

### 201: Model wait treated Runtime system reminders as mailbox activity and Workflow guidance still implied progress waiting

- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.74 development
- **Fixed**: v0.7.74
- **Created**: 2026-07-23
- **Resolved**: 2026-07-23

#### Original Problem

The first mailbox subscription matched every scoped `MessageQueue` mode. A
queued `system-reminder` could therefore end `wait_agent` even though the fixed
wake matrix permits only Agent mailbox evidence, root user input, interruption,
or timeout. Separately, the `run_workflow` result still told the model to use
`wait_agent` to observe progress after progress events had moved out of the
model wait channel.

#### Root Cause

Priority and routing filters were applied, but the activity probe had no
delivery-mode allowlist. Workflow guidance was outside the main Worker prompt
and tool-description update set, so its historical wording survived.

#### Solution Implemented

- Restrict wait activity to `prompt`, `agent-message`, and
  `task-notification`; a system reminder can be delivered at the next safe
  boundary but cannot independently wake the model.
- Tell Workflow callers to inspect progress with `list_agents`, use
  `wait_agent` only for critical mailbox evidence, and use `agent_output` for
  the known Workflow result.

#### Files Changed

- `packages/coding/src/tools/agent-collaboration.ts`
- `packages/coding/src/tools/agent-collaboration.test.ts`
- `packages/coding/src/tools/run-workflow.ts`
- `packages/coding/src/tools/run-workflow.test.ts`
- `packages/coding/src/tools/tool-definitions.ts`

#### Tests Added

- A progress storm and a scoped system reminder both leave one wait pending;
  a subsequent Agent completion notification settles it once.
- Workflow start output distinguishes progress inspection from mailbox waiting.

### 200: Restored unacknowledged Agent completions did not repopulate the model mailbox

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.74 development
- **Fixed**: v0.7.74
- **Created**: 2026-07-23
- **Resolved**: 2026-07-23

#### Original Problem

FEATURE_273 makes the model-facing `wait_agent` depend exclusively on the
caller-scoped `MessageQueue`. Actor snapshots durably preserve completion
messages and their post-transcript acknowledgement receipts, but the queue is
intentionally process-local. If a process stopped after a child completion was
persisted and before the parent transcript committed that notification, session
restore loaded the durable completion without publishing it into the new queue.
The parent could then wait until timeout even though the child was terminal.

A same-process Runtime Registry rebuild exposed a related idempotency edge: a
naive restore replay could enqueue a second copy while the original process
queue entry was still present.

#### Root Cause

`AgentActorController.initialize()` restored mailboxes and acknowledgement IDs,
then recovered unfinished turns, but `onMessageCommitted` only ran for new
mutations. The Coding Runtime projection also had no queue-level `turnId`
deduplication because normal durable commits publish only once. Inferring
pending delivery from every unacknowledged mailbox completion would also have
made pre-receipt snapshots replay historical results after upgrade.

#### Solution Implemented

- Persist an explicit set of root completion `turnId`s awaiting transcript
  acknowledgement and republish only that set before unmatched-turn recovery.
- Treat an absent set as a legacy snapshot with no inferred replay work, so an
  upgrade cannot resurrect historical completion mail.
- Keep ordinary historical Actor messages out of replay; their generic delivery
  contract is unchanged and they have no completion receipt.
- Deduplicate projected root completion notifications by session/Actor route and
  structured child-task `taskId`, preserving exactly one pending queue entry for
  both hard restart and same-process registry rebuild.
- Keep acknowledgement post-transcript-commit; once persisted, later restores
  no longer replay the completion.

#### Files Changed

- `packages/agent/src/actors/controller.ts`
- `packages/agent/src/actors/controller.test.ts`
- `packages/agent/src/actors/types.ts`
- `packages/coding/src/agent-runtime/actor-runtime.ts`
- `packages/coding/src/agent-runtime/actor-runtime.test.ts`
- `docs/test-guides/FEATURE_273_v0.7.74_TEST_GUIDE.md`

#### Tests Added

- Controller restart test: unacknowledged root completion is republished once;
  acknowledged completion is not replayed on a later restart.
- Legacy snapshot test: missing delivery state never infers stale replay work
  from historical completion messages.
- Coding Runtime integration test: a soft rebuild does not duplicate a queued
  `turnId`, while a fresh process queue is repopulated from the same snapshot.

### 199: Runtime accepts interrupt input after the final safe boundary and terminalizes it without delivery

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.74
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

`runtime.runs.submitInput({ delivery: 'interrupt' })` can return `accepted: true`
after a managed task has published its terminal managed-task status but before
the outer Runtime Run settles. No Runner/LLM safe boundary remains in that
interval. The accepted input emits `run.input.queued`, then normal Run cleanup
removes its queue entry and changes the status to `terminal` without ever
emitting `run.input.delivered`.

The reproduced Run accepted an interrupt at `03:54:10.073Z`, 2.739 seconds
after `managed_task_status.phase: completed`, then completed 1.44 seconds later.
Its durable log contains the queued event and terminal input status but no
delivery event, proving the input never entered an LLM request.

Expected behavior:

- Runtime closes interrupt admission as soon as the active execution has no
  future safe boundary.
- A late submission receives a factual retryable rejection and is never added
  to the Actor queue.
- Inputs accepted immediately before closure still reach an explicit terminal
  outcome through the owning Run status, so clients can distinguish delivery
  from non-delivery without guessing from transcript text.
- Runtime never silently changes `interrupt` into `after_turn`.

#### Root Cause

Interrupt admission checks only the outer Run phase, active-Run ownership, and
presence of an Actor Session. During managed-task finalization those facts still
look active after the managed task has emitted its final `completed` status.
The Runtime record does not represent whether the Runner's interrupt window is
still open. `terminalizeQueuedInterruptInputs()` correctly prevents cross-Run
leakage, but exposes the missing admission state by terminalizing accepted work
that never had another consumption point.

#### Solution Implemented

- Track one internal interrupt-admission flag on each active Runtime Run.
- Close it on the final managed-task status, and on the ordinary coding
  completion/error callback or external abort before the result promise settles.
- Keep non-terminal observer diagnostics off the terminal `onError` channel so
  they cannot close a still-consumable window.
- Terminalize synchronous coding and managed-task launch failures instead of
  leaving a started Run active without a result handle.
- Reject submissions after closure with `interrupt_window_closed` before
  normalizing or enqueueing the input.
- Preserve current terminal cleanup for cancellation, failure, restart, and
  the residual event-loop race; clients reconcile those terminal input records
  by public `inputId`.

#### Implementation and Verification

| File | Change | Expected Outcome | Risks and Guardrails | Tests |
|------|--------|------------------|----------------------|-------|
| `src/sdk-runtime.ts` | Add the internal admission flag, close it from terminal execution callbacks and external abort, release abort listeners on every Runtime-owned termination path, terminalize synchronous launch failures, and add the typed rejection reason | Late input is rejected before queue mutation; accepted input lifecycle remains unchanged; failed launches cannot remain active | Do not close on intermediate managed worker turns; do not alter `after_turn`; do not retain host signals | Managed and ordinary coding completion/abort/launch-failure tests |
| `src/sdk-runtime.test.ts` | Reproduce completion/error/external-abort and synchronous-launch windows; assert rejection, zero queue growth, accepted-before-close delivery, listener cleanup, and failed terminal status | Regression is deterministic and independent of timing | Settle/abort every fake Run so tests do not leak | Focused and complete Runtime Vitest suite |
| `packages/coding/src/agent-runtime/middleware/sidecar-verifier/verifier-recorder-bridge.ts` and adjacent test | Report a Sidecar message sink failure through diagnostics instead of terminal `onError` | An observer failure remains visible without terminating interrupt admission | Preserve verifier behavior and never swallow the diagnostic | Full bridge Vitest suite |
| `docs/SDK_EMBEDDER_GUIDE.md`, `docs/DD.md` | Document the new factual rejection and client retry behavior | Embedders do not silently downgrade delivery intent | Keep capability semantics and existing reasons intact | Documentation review |
| `docs/KNOWN_ISSUES.md` | Track Issue 199 through resolution | Runtime ownership and verification remain auditable | Preserve the original report | Index/detail/summary consistency |

#### Resolution

Added an internal `interruptInputOpen` fence to every Runtime Run record. The
fence opens only when a Run with an Actor Session starts, and closes before the
outer result settles when ordinary coding emits `onComplete` or `onError`, or
when a managed task reports its final `phase: completed`. A supplied external
abort signal now closes the fence synchronously for both coding and managed-task
Runs; the Runtime-owned listener is released by normal completion, Runtime
abort, and shutdown even if the underlying operation never settles.
`markRunTerminal()` also closes the fence defensively for cancellation, failure,
recovery, and shutdown.

The Sidecar verifier no longer forwards a host `onSidecarMessage` sink exception
to terminal `onError`. It emits the existing `coding:sidecar-verifier` diagnostic
instead, so a non-terminal observer failure remains visible without prematurely
closing interrupt admission.

If persistence of the exact `run.input.delivered` batch fails after the Actor
queue has been consumed, Runtime now emits a bounded `runtime.warning` carrying
only the input IDs and persistence error. It leaves the public input state
`queued` and rethrows the original error; it never falsely publishes delivery
or copies the input body into diagnostics.

Synchronous exceptions from coding or managed-task launch now use the same
failure classification and terminal cleanup as asynchronous rejection. The
original `runs.start()` rejection remains unchanged, while the observable Run
is persisted as `failed`, releases its active ownership, and cannot accept input.

`runtime.runs.submitInput({ delivery: 'interrupt' })` now checks this fence
before input normalization, cloning, or MessageQueue mutation. A late request
returns the typed factual result `accepted:false` with
`reason:'interrupt_window_closed'`; it is never converted to `after_turn`.
Existing terminal input records remain the authoritative residual-race/recovery
outcome for clients to reconcile by `inputId`.

Validation:

- The complete Runtime SDK suite passed (130/130), including deterministic
  completion/error/external-abort regressions for coding and managed-task Runs,
  zero queue growth after closure, listener cleanup on Runtime cancellation, and
  accepted-before-close delivery, plus synchronous launch-failure cleanup.
- The complete Sidecar verifier bridge suite passed (17/17), including proof
  that an observer sink exception emits a diagnostic without calling terminal
  `onError`.
- The complete KodaX package build, TypeScript project build, SDK bundle, and
  declaration bundle passed.

### 198: Compaction could evict exact history before durable persistence and offered no model-facing recovery

- **Priority**: High
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.46 archival lifecycle; exposed by v0.7.74 review
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

After a successful major compaction, `applySessionCompaction()` immediately
replaced old-island message bodies with `[compacted]`. Full-save and fallback
paths could then publish that slim in-memory lineage before the exact old
messages reached the island sidecar. A structural inspection of Session
`20260721_233332` found 125 persisted placeholders (64 user and 61 assistant),
only five remaining raw user entries, and no island sidecar. The UI summary and
query ledger survived, but they are not an exact substitute for assistant/tool
details.

The callback also carried only the replacement messages. Messages created in
the active Run but removed by the same compaction were not guaranteed to exist
in the host's prior lineage, so changing only the file-write order could not
close the gap. Finally, a compacted Agent had no native Session-transcript
search/read tool: it could use the summary and exact query ledger, but could not
intelligently retrieve an omitted persisted detail.

#### Root Cause

- In-memory reclamation and durable archival were coupled inside
  `applySessionCompaction`, before the asynchronous host persistence boundary.
- `CompactionUpdate` omitted the exact pre-compaction message snapshot needed
  to reconcile messages created during the current Run.
- Storage maintenance wrote sidecar before main, but ordinary full-save paths
  did not enforce the same archive-before-slim invariant.
- Maintenance reset append watermarks to the slim persisted count even though
  the live caller retained old entry skeletons, allowing later delta slicing to
  start at the wrong position.
- Root and child compaction callbacks shared the same host callback; event
  identity existed, but the root lineage mutation did not reject child scope.
- Transcript page/chunk APIs served hosts, while the Action LLM had no bounded,
  cited current-Session recovery surface.
- The original history-tool binding and durable-compaction wrapper were wired
  only through the SA substrate. Default AMA could advertise the tools without
  a loader and could compact without the same archive-before-evict owner.
- Child Runs did not inherit the parent's compaction overrides, suppressed
  child compaction telemetry, and had no isolated durable lineage from which
  omitted child detail could be recovered safely.

#### Resolution

The FEATURE_272 durable-recovery closure now:

- carry `preCompactionMessages` as host-only transaction data;
- reconcile and durably commit exact entries before in-memory eviction;
- flush sidecar batches before atomically replacing the slim main JSONL and
  deduplicate main/sidecar overlap by stable entry ID;
- preserve live append watermarks across storage-only maintenance;
- reject child compaction as a root Session mutation;
- add deterministic revision-bound transcript search and exact chunk reads to
  root Agent, isolated persistent-child, Session SDK, Runtime, and daemon
  surfaces without embeddings or background extraction;
- bind the same history loader and durable-compaction owner through SA and AMA,
  and hide the history-tool pair atomically when the loader or either tool is
  unavailable;
- forward the resolved parent compaction policy into child Runs, preserve
  child identity on compaction telemetry, and persist each durable child's
  recoverable history in a separately minted hidden `managed-task-worker`
  Session that never grants root-lineage access;
- atomically seeds a new headless Session when first-run compaction precedes
  its routine snapshot, while still rejecting an unseeded missing Session;
- keeps Runtime as the only persistence writer after that boundary and rolls
  back a tentative context revision when durability rejects;
- excludes system/hidden evidence, current and legacy checkpoints, and
  unrecoverable `[compacted]` placeholders from both search and direct reads,
  without scoring short query terms against random entry IDs.

#### Verification

- automatic and imperative compaction, first-save and append-hot paths;
- failure after sidecar append and before main replacement;
- repeated compactions, maintenance, restart, and duplicate cleanup;
- old user/assistant/tool detail search plus stale-revision exact reads;
- SA/AMA tool binding and durable-before-evict parity;
- child compaction-policy inheritance, context-scoped telemetry, isolated
  history recovery, root-lineage denial, and bounded tool/daemon responses;
- structural replay of an incident-shaped Session with more than 100 old
  entries and an island sidecar.

Automated verification completed with 361 Agent/Coding compaction tests, 162
REPL/Session/UI tests, and 210 Runtime/daemon tests. A read-only replay of
Session `20260721_233332` loaded 145 lineage entries and 16 active messages;
legacy checkpoints/system/placeholders produced zero directly readable model
entries, while surviving exact tool evidence remained searchable. Source and
isolated-copy SHA-256 values matched before the temporary copy was removed.
The final SA/AMA/child closure then passed another 323 focused tests across 15
files (plus 2 declared existing todos), root TypeScript no-emit, canonical
config-template validation, package compilation, all SDK/CLI bundles, and DTS
bundling.

### 197: User-shaped compaction checkpoints caused round-exit query and final duplication

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.74
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

After automatic compaction, the runtime emits the checkpoint as a synthetic
`role: user` message with `_source: 'compaction-checkpoint'`, and repository
intelligence can precede it with a system message. Round-exit reshaping only
recognized a prefixed system message at index zero. It therefore appended the
original query after an already completed assistant answer and then appended
the same final answer again.

#### Root Cause and Resolution

The round boundary inferred compaction identity from role and position instead
of the checkpoint's structured provenance. A shared predicate now recognizes
the current `_source` marker and the legacy system-prefix form. A user-shaped
checkpoint itself supplies the user boundary; a legacy system summary retains
the prior requirement that some user boundary survives. Normal non-compacted
rounds and system-summary-only sessions keep their existing append behavior.

#### Verification

- `packages/coding/src/task-engine/_internal/round-boundary.test.ts`
- Runtime-shaped regression: repo system -> user checkpoint -> tool chain ->
  existing final; the original query occurs zero times and final occurs once.

### 196: Physical-only tool-result admission let pathological grep output dominate large contexts

- **Priority**: High
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.69
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

Session `20260721_233332` captured a grep result of roughly 1.1 MB / 339k
estimated tokens. On a one-million-token model the request still fit physical
capacity, so the result was admitted as one atomic history group. The next few
tool calls appeared to jump directly to the compaction threshold (about 526k
tokens before compaction), even though the visible interaction was short.

#### Root Cause and Resolution

Issue 158 correctly removed universal post-hoc truncation and made one batch
owner enforce physical next-request capacity with recoverable artifacts. That
closure did not provide a separate model-attention bound, so very large context
windows could admit a result that fit physically but was not useful as one
model input. The fix preserves the Issue 158 architecture and adds:

- grep source shaping: at most 500 characters per rendered content entry,
  about 50 KiB per page, and explicit `offset` plus `read`/`line_offset`
  continuation hints;
- independent admission limits at the existing sole batch owner: 16k tokens
  per result and 48k tokens per batch, capped again by the physical remainder;
- full artifact persistence and explicit preview/full byte markers whenever
  attention admission spills a result.

The prior approximately 12,577-byte Issue 158 git-log reproduction remains
verbatim, and command-aware lossy filters plus default microcompaction remain
disabled. This is an additive attention boundary, not a rollback of Issue 158.

#### Post-resolution Review Closure

The first implementation left two physical-capacity fast paths in managed
Runner results and background completion envelopes, so those paths never
reached the attention policy when a large model window could hold the raw
payload. It also charged edit-recovery messages against the 48k tool-attention
ledger and converted artifact persistence failure into a fatal attention error.
The closure:

- routes standard dispatch, managed Runner, child evidence, and background
  envelopes through the same batch owner even when physical capacity is ample;
- keeps physical next-request capacity (including edit recovery and non-string
  siblings) separate from the 16k/48k tool-result attention ledger;
- treats physical overflow as the only hard admission failure, while a failed
  attention spill remains fully inline with a visible diagnostic when it still
  fits physically;
- preserves one artifact/marker when re-admitting an already guarded result.

#### Verification

- `packages/coding/src/tools/grep.test.ts`
- `packages/coding/src/tools/tool-result-policy.test.ts`
- `packages/coding/src/tools/envelope-budget.test.ts`
- `packages/coding/src/task-engine/runner-tool-result-batch.test.ts`
- `packages/coding/src/agent-runtime/__contract-tests__/cap-077-tool-dispatch-parallel.contract.test.ts`
- `packages/coding/src/agent-runtime/__contract-tests__/cap-079-final-tool-result-capacity.contract.test.ts`
- Regressions cover long lines, 50 KiB paging, per-result and batch attention
  spill across every production entry, recovery-message dual accounting,
  persistence failure, full artifact recovery, and the unchanged moderate case.

### 195: Auto-mode sent safe static reads to the LLM while sensitive reads bypassed deterministic review

- **Priority**: High
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.33; exposed by v0.7.74 review
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

In session `20260721_233332`, deterministic analysis identified `git show` as
complete, exact, read-only, and risk-free, but Auto[LLM] still invoked the
classifier. The classifier rejected the command with no useful reason, wasting
tokens and blocking a safe inspection. Conversely, direct `read`/`grep`/`glob`
calls used an empty projection and bypassed analysis entirely, while
`isBashReadCommand` allowed reads such as `cat ~/.ssh/id_ed25519` and secret
environment-variable expansion without a separate sensitive-data gate.

#### Root Cause and Resolution

The deterministic review was only serialized as classifier evidence after the
empty-projection fast path; it was not itself an allow decision. Read-only
syntax and sensitive-data access were also treated as the same concern. The
fix keeps mutation classification separate and applies one deterministic read
review before the LLM:

- complete, exact, risk-free `read` operations and read-only shell execution
  (`options.readOnly`) are allowed with zero classifier calls;
- direct read tools and shell paths share sensitive-path classification for
  SSH/GPG, cloud and Kubernetes credentials, Docker/CLI credential stores,
  `.env` and package credentials, private-key names, and `/proc/*/environ`;
- `.env.example`, `.env.sample`, and `.env.template` remain readable unless
  they are located inside another protected directory;
- sensitive environment references, enumeration, and credential-bearing
  `git config --get` keys require explicit user confirmation before the LLM.

#### Post-resolution Review Closure

The first implementation still missed sensitive shell operands that did not
look path-shaped to the shared extractor, including `cat .env`,
`Get-Content .env`, `git diff -- .env`, and Git object reads such as
`git show HEAD:.env`. Public SDK consumers could also omit `analyzeCall` and
retain the old empty-projection allow. The closure adds command-aware sensitive
operand binding for positional and regex readers (including mixed read/write
pipelines) and Git `REV:path`/`-- path` forms, while excluding regex patterns,
format, delimiter, and pickaxe arguments. Direct
`read`/`grep`/`glob` calls now require deterministic analysis or explicit user
confirmation; the Runtime continues to inject the analyzer, so exact safe reads
remain zero-LLM-cost.

#### Verification

- `packages/repl/src/permission/auto-rules.test.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.test.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.test.ts`
- Regressions prove `git show` makes no classifier request, bare/Git-object and
  piped/redirected secrets reach user confirmation without classifier use,
  non-path operands do not false-positive, and analyzer-less SDK reads fail
  closed.

### 194: Agent coordination could reject local specialists, amplify progress polling, duplicate terminal output, and corrupt resumed tool history

- **Priority**: High
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.72-v0.7.74
- **Fixed**: v0.7.74
- **Created**: 2026-07-22
- **Resolved**: 2026-07-22

#### Original Problem

An npm-linked v0.7.74 REPL session exposed several coupled coordination and
resume failures:

- `spawn_agent(agent_id="repo-explorer")` was rejected because a local
  constructed specialist incorrectly required an external Runtime executor
  catalog. Retrying without `agent_id` started generic children and silently
  lost the requested specialist semantics.
- `wait_agent` woke the parent model for ordinary `turn_progress` events. Three
  children produced dozens of parent model turns even though only three
  terminal results affected the review.
- Results already observed through terminal Actor APIs were later injected
  again as full `<agent-completed>` notifications, duplicating large child
  outputs in model context.
- Quitting and resuming with `kodax -c` appended previously rendered tool calls
  to the end of the transcript. Repeated resumes persisted and multiplied the
  duplicates in `uiHistory`.
- Auto-mode could reject a command before execution with an empty reason, which
  rendered as an ambiguous tool error and led the model to misdiagnose the
  failure as a shell output-capture problem.
- Tool-result messages lacked execution-time timestamps and collapsed to the
  later session-accounting timestamp.

Expected behavior:

- Prompted local specialist IDs are dispatchable without an external plane and
  never silently degrade to a generic Agent.
- Parent coordination can wait for terminal events without consuming every UI
  progress update; queued user input still interrupts promptly.
- Each child turn's terminal body enters model context at most once.
- Session restoration is tool-ID based and idempotent across arbitrary UI-only
  commands and repeated resume/save cycles.
- Pre-execution policy denials carry an explicit non-empty reason, and every
  message retains its real finalize-time timestamp.

#### Context

Affected components:

- `packages/coding/src/tools/agent-collaboration.ts`
- `packages/coding/src/tools/list-dispatchable-agents.ts`
- `packages/coding/src/agent-runtime/actor-runtime.ts`
- `packages/agent/src/orchestration/idle-yield.ts`
- `packages/repl/src/ui/utils/restore-history.ts`
- `packages/coding/src/guardrails/auto-mode/parse-output.ts`
- `packages/agent/src/primitives/runner-tool-loop.ts`

#### Root Cause

Agent selector resolution required the external executor plane before attempting
local catalog resolution. The wait API exposed one undifferentiated event
stream to both the UI and the parent model. Terminal results were projected
independently into Actor output and the background message queue without a
shared observation identity. Session restoration aligned persisted and derived
history by visible user-round counts instead of stable tool IDs, so UI-only
commands shifted the merge boundary. Finally, policy and tool-result message
builders allowed missing diagnostic/timestamp fields that the persistence layer
could only repair ambiguously.

#### Proposed Solution

- Resolve Native/Constructed catalog entries before consulting the external
  executor plane; make prompt, list, and spawn share the same dispatchable IDs.
- Add a backwards-compatible terminal-only wait mode and use it in the built-in
  Worker prompt while retaining raw event mode for SDK progress consumers.
- Track terminal observation by turn ID so explicit output retrieval and
  background completion delivery form one exactly-once channel.
- Deduplicate and enrich restored tool groups by tool-use ID, preserving
  persisted order and repairing already polluted snapshots idempotently.
- Require non-empty auto-mode denial reasons and stamp tool-result messages when
  their batch completes.
- Cover the fixes with contract tests plus repeated resume/save/restore and
  multi-child progress/terminal integration tests.

#### Resolution

- Local Native/Constructed descriptors are resolved before the optional
  external executor plane. `list_dispatchable_agents`, the specialist prompt,
  short aliases, canonical IDs, and `spawn_agent` now share one catalog.
- `wait_agent(return_on="terminal")` skips progress events internally, preserves
  raw event mode for compatibility, returns bounded `terminalOutputs`, and
  remains interruptible by scoped user input. The Worker prompt uses this mode
  and yields text-only to the existing idle-yield path instead of polling an
  expired wait.
- The Actor snapshot records explicit completion acknowledgements by `turnId`.
  Acknowledgement is selective, durable, restricted to completions already in
  the direct parent's mailbox, and filters later mailbox drains without
  consuming earlier evidence. Root and nested completion projections carry the
  same task-result identity. `wait_agent`, `agent_output`, and host-delivered
  synthetic results acknowledge and remove the matching notification only
  after the authoritative transcript/session message commits; persistence
  failure therefore leaves the result replayable. Event snapshots suppress an
  acknowledged direct-child terminal event without deleting audit history.
- Resume restoration deduplicates globally by tool-use ID, aligns canonical
  text anchors backwards from the latest persisted suffix, repositions
  canonical tool groups while retaining richer persisted tool details, and
  replaces legacy tool summaries only when they are not canonical anchors. It
  remains bounded to the persisted window and idempotent across repeated
  resume/save cycles.
- Auto-mode block decisions synthesize a non-empty diagnostic when the
  classifier omits its reason. The shared guardrail result now explicitly says
  the call was blocked before execution. Tool-result messages are timestamped
  when the result batch is built.

FEATURE_273 subsequently supersedes the model-facing terminal/event selector
described above. `wait_agent` is now a mailbox yield with only `timeout_ms`;
raw progress replay and long-poll remain on the existing SDK/daemon Actor event
APIs. This removes model resampling on progress without removing the capability
that SDK telemetry consumers previously obtained from `return_on="event"`.

The post-implementation review found that the first closure still acknowledged
terminal results inside the tool handler, before Runner/session persistence,
and that forward-greedy text alignment could bind a trimmed repeated suffix to
an older canonical round. The post-commit receipt hook, direct-child event
filtering, and tail-biased canonical alignment close both gaps.

#### Files Changed

- `packages/agent/src/actors/controller.ts`, `packages/agent/src/actors/types.ts`
- `packages/agent/src/primitives/guardrail.ts`, `packages/agent/src/primitives/runner-tool-loop.ts`
- `packages/coding/src/agent-runtime/actor-runtime.ts`
- `packages/coding/src/agents/worker-role-prompt.ts`
- `packages/coding/src/external-agents/local-catalog.ts`
- `packages/coding/src/guardrails/auto-mode/parse-output.ts`
- `packages/coding/src/prompts/capability-sections.ts`
- `packages/coding/src/tools/agent-collaboration.ts`, `packages/coding/src/tools/list-dispatchable-agents.ts`, `packages/coding/src/tools/tool-definitions.ts`
- `packages/repl/src/ui/utils/restore-history.ts`
- Corresponding colocated tests, `docs/KNOWN_ISSUES.md`, and `CHANGELOG.md`

#### Verification

- `npx tsc --noEmit`
- `npm run build`
- 201 Agent/compaction tests, 1,057 coding/tool/guardrail tests, 921
  REPL/permission tests, and 120 SDK Runtime tests passed (2,299 total; one
  pre-existing platform skip).
- A read-only replay of session `20260721_233332` recovered all 45 unique tool
  calls, removed all 33 duplicate occurrences, and left no orphan tool group
  after the first `/quit` marker.

### 193: Runtime daemon rejects interrupt input instead of injecting it into the active Run

- **Priority**: Medium
- **Status**: **Resolved**
- **Introduced**: v0.7.69
- **Fixed**: v0.7.73 development
- **Created**: 2026-07-21
- **Resolved**: 2026-07-21

#### Original Problem

`runtime.runs.submitInput({ delivery: 'interrupt' })` is part of the public
request type, but both embedded Runtime and the shared daemon return
`unsupported_capability`. The daemon deliberately omits `interruptInput` from
its capability record. A client therefore cannot deliver input to an active
Coder Run at the next safe Runner/LLM boundary and must wait for an
`after_turn` continuation Run instead.

Expected behavior:

- Runtime and daemon advertise `interruptInput` version 1.
- Interrupt input is scoped to the supplied Session and currently active Run.
- Inputs accepted before one safe boundary drain together in FIFO order, retain
  separate user-message boundaries, and enter one next LLM request.
- Interrupt submission does not create continuation Runs.
- Snapshot and typed events expose queued and delivered input state, including
  one complete ordered delivery batch.
- Exact `operationId` retries are idempotent; stale Run and unsupported active
  execution modes fail explicitly; `after_turn` behavior does not change.

#### Context

Affected components:

- `src/sdk-runtime.ts`
- `src/runtime-daemon/server.ts`
- `src/runtime-event.ts`
- `packages/agent/src/messaging/queue.ts`
- `packages/coding/src/task-engine/runner-driven.ts`

#### Root Cause

FEATURE_269 modeled queued input only as a new `after_turn` Run. Although the
Coding Runner already drains its Actor-scoped `MessageQueue` at a safe boundary
and converts the whole FIFO batch into separate user messages, Runtime has no
interrupt input record, no daemon-to-Actor queue bridge, and no queued/delivered
event contract. The capability was therefore intentionally withheld and both
submission paths fail closed.

#### Proposed Solution

- Reuse the active Run's canonical Actor queue instead of adding another queue.
- Track interrupt input identity, origin, preview, timestamps, and lifecycle on
  the owning Run; persist that projection into Run status and observations.
- Emit one typed queued event per accepted input and one typed delivered event
  containing the exact ordered batch consumed at the safe boundary.
- Terminalize and remove undelivered queue entries when their owning Run ends so
  they cannot leak into a later continuation.
- Route daemon requests through the existing operation journal and ownership
  checks, then advertise the versioned capability only after the contract tests
  pass.

#### Resolution

- Embedded Runtime and the shared daemon now advertise `interruptInput` version
  1. The daemon binds a trusted input identity and authenticated operation
  origin, while its existing control journal returns the canonical result for
  an exact `operationId` retry.
- Active Actor Runs enqueue interrupt input on their canonical Session root
  queue. The existing Runner safe-boundary drain preserves FIFO order and each
  user-message boundary, so all inputs accumulated before that boundary enter
  one next LLM request without creating continuation Runs.
- Run status and Session observation expose each interrupt as
  `queued`/`delivered`/`terminal`. `run.input.queued` records acceptance, and one
  `run.input.delivered` event carries the exact complete ordered batch consumed
  at the boundary.
- Terminal Runs remove their still-queued message IDs and mark those input
  records terminal, preventing cross-Run leakage. Restart recovery likewise
  terminalizes a persisted queued projection because the process-local queue is
  intentionally non-durable.
- Safe-boundary callbacks now carry the exact queue message IDs consumed by both
  the ordinary tool boundary and idle-yield resume path. Runtime marks only that
  ordered batch delivered, so an interrupt arriving while idle-yield awaits
  aggregate-budget work remains queued for the following boundary.
- Runtime clones and validates the complete interrupt input before mutating the
  Actor queue, preventing rejected embedded-SDK input from leaving an
  untracked queue entry.
- The complete `run.input.delivered` batch is synchronously persisted before
  status changes to `delivered`. Restart recovery reconciles a stale queued
  projection from that durable fact; if the event cannot be written, delivery
  confirmation fails without publishing a false delivered state.
- Session ownership, current-active-Run checks, `stale_run`, per-Run
  `unsupported_capability` for execution without a safe Actor boundary, and
  existing `after_turn` continuation semantics remain unchanged.

#### Files Changed

- `src/sdk-runtime.ts`, `src/index.ts`
- `src/runtime-daemon/server.ts`
- `src/runtime-event.ts`
- `packages/coding/src/types.ts`, `packages/coding/src/task-engine/runner-driven.ts`
- `packages/agent/src/orchestration/idle-yield.ts`
- `packages/agent/src/orchestration/runner-with-idle-yield.ts`
- `src/sdk-runtime.test.ts`, `src/runtime-daemon/server.test.ts`
- `packages/agent/src/orchestration/idle-yield.test.ts`
- `src/runtime-event.test.ts`, `packages/agent/src/primitives/runner.test.ts`
- `docs/DD.md`, `docs/SDK_EMBEDDER_GUIDE.md`, `docs/features/v0.7.69.md`
- `docs/KNOWN_ISSUES.md`, `CHANGELOG.md`

#### Verification

- `npx tsc --noEmit`
- `npm run build`
- `npx vitest run src/runtime-daemon/server.test.ts src/runtime-daemon/client.test.ts src/runtime-daemon/protocol.test.ts src/runtime-daemon/schema.test.ts src/runtime-event.test.ts packages/agent/src/primitives/runner.test.ts`
- Focused SDK regression coverage verifies FIFO batch delivery, no continuation
  Run, snapshot/event lifecycle, SA unsupported behavior, stale/cross-Session
  fencing, terminal queue cleanup, exact consumed-message acknowledgement,
  clone-failure rollback, durable-event failure, and restart reconciliation.

### 192: Large compaction used the model window for protection, covered only one rolling chunk, and exposed ambiguous/unbounded SDK state

- **Priority**: High
- **Status**: **Resolved** (v0.7.74)
- **Introduced**: v0.7.73 and earlier
- **Fixed**: v0.7.74
- **Created**: 2026-07-21
- **Resolved**: 2026-07-21

#### Original Problem

A KodaX SDK host reported a manual/automatic-looking compaction transition of
`322,973 -> 222,460` tokens. The compaction notification indicated success, but
only about 100k tokens disappeared, while the host UI continued to display a
330k-class value that kept growing. The product requirement also differs from
the implementation: automatic compaction must never be disabled; its percentage
must default to 75 and remain within 15-90; an optional absolute token threshold
must participate by minimum; and recent protection must be based on the
effective trigger rather than 20% of a one-million-token model window.

Further investigation found two adjacent correctness risks. Parent and child
iteration events shared session-level presentation state without a stable
context owner, so a child could replace the root token count. Runtime
observation also embedded a complete transcript in a transport with an 8 MiB
frame limit.

#### Expected Behavior

- Automatic large compaction is always active.
- Percentage and optional absolute thresholds have one public SDK contract;
  the smaller active threshold wins and protection is 20% of it.
- Manual and automatic large compaction cover the full eligible prefix once,
  preserve recent raw context and every genuine user query, and commit atomically.
- Summary generation reuses the stable main-request prefix where supported.
- Root/child token and compaction events have unambiguous context identity.
- Observation of arbitrarily large persisted transcripts is bounded and
  explicitly pageable rather than silently truncated or sent in one frame.

#### Root Cause

- The imperative SDK compact path forced `triggerPercent: 100`.
- Protection and rolling chunk budgets were derived independently from the full
  model context window (`20%` and `10%`). On a one-million-token model this
  protected about 200k and summarized one roughly 100k chunk, explaining the
  observed transition.
- The rolling summarizer could install partial progress after a later failure
  and repeatedly summarized earlier material through serial summary chaining.
- Summary requests used a separate system/tools shape instead of the main
  request prefix, losing available KV/prompt-cache reuse.
- User-query preservation was prompt guidance rather than a mechanically
  validated invariant.
- Session-level event/UI state did not carry a stable root/child context key.
- Runtime snapshots embedded the complete transcript despite the daemon's
  fixed maximum frame size.

#### Resolution

Implemented `FEATURE_272` as specified in
[`v0.7.74`](features/v0.7.74.md#feature_272-reliable-full-coverage-context-compaction-and-sdk-observability): shared
threshold normalization, coverage-driven atomic compaction, a canonical user
query ledger, exact-prefix cache reuse, context-scoped canonical events, and
bounded transcript pagination through the SDK/daemon and KodaX Space.

The final adversarial implementation review found and fixed five integration
drifts before release: the managed-task hook reported the pre-compact count and
omitted the canonical completion event/report; its summary request did not use
the exact active system/tools/reasoning cache prefix; protected-tail queries
were duplicated into the exact ledger; persisted anchors excluded admitted
post-compact attachments; and Space attempted the legacy monolithic transcript
method before falling back to pages. Space compact start/end and activity/cost
consumers now also preserve and filter child context identity, so child work
cannot transiently replace root UI state. The closing review additionally
found that imperative Runtime compaction emitted only `finished`; it now emits
one ordered `started -> finished -> ended` lifecycle even for unchanged or
failed attempts. Space now consumes the SDK-resolved effective threshold,
including physical capacity, and clamps every percentage entry point to 15-90.
The post-implementation fallback review also removed a false-success path: a
new array reference is not evidence of pruning. Success now requires a strict
token reduction and a physically valid complete request; otherwise the original
history is returned and no successful compatibility stats are emitted.

#### Verification

Focused policy/core/query-ledger/manual compact tests, lineage and JSONL
round-trips, root/child event isolation, daemon legacy-frame rejection, 9 MiB
SDK page/chunk recovery, and KodaX Space paging/projection tests pass. Root and
Space typechecks pass, as does the complete 0.7.74 package/bundle/DTS build.
The post-review run passed 352 focused core/caller/REPL tests, 51 daemon tests,
the canonical-event and 9 MiB SDK probes, 103 Space adapter/telemetry/config tests, the
published Runtime compatibility probe, and the Space renderer/main smoke build.
Manual UI and semantic summary checks are tracked in the v0.7.74 human test
guide.

### 191: Auto permission review lacked a complete, compact mutation model

- **Priority**: High
- **Status**: **Resolved** (v0.7.73)
- **Introduced**: v0.7.33
- **Fixed**: v0.7.73
- **Created**: 2026-07-21
- **Resolved**: 2026-07-21

#### Original Problem

`createAutoModeToolGuardrail` documented a deterministic Tier-2 rules layer,
but the `rules` engine only implemented Tier 1. Every non-Tier-1 call was
therefore escalated to `askUser`, including `write`, `edit`, and `multi_edit`
calls whose normalized targets were inside the Runtime project boundary. SDK
embedders such as KodaX Space consequently received `permission.requested`
events for ordinary workspace edits in explicit `Auto[rules]` mode.

The shared reason string also claimed that the engine was "downgraded" even
when the user had explicitly selected `rules`.

Release review then exposed the unsafe inverse: Tier 2 reused a generic target
collector as if it were an exhaustive authorization model. PowerShell named
and positional binding was command-dependent, so the following commands could
bind their real outside-workspace target to a later argument while Tier 2
validated an earlier value and returned `allow`: `Copy-Item`, `Move-Item`,
`Set-Content`, `Out-File`, `New-Item`, and `Remove-Item`.

The LLM path also forwarded a bounded session transcript plus AGENTS.md and a
raw action projection. That input was larger and less precise than the facts
needed for authorization, and a byte-budget overflow escalated directly to the
user instead of changing evidence strategy.

#### Expected Behavior

- Deterministic file mutations inside the Runtime workspace or a system temp
  directory are allowed without a prompt, except for protected KodaX/config
  zones.
- Read-only shell commands are allowed regardless of their target directory.
- In explicit rules mode, writes outside workspace/temp, unresolved paths,
  link escapes, unknown tools, and unmodelled/high-risk shell operations are
  never auto-allowed. In LLM mode these facts go to the permission reviewer.
- Runtime remains the sole permission decision owner; embedders must not add
  unconditional per-tool bypasses.
- The permission LLM receives the user's authority plus complete, atomic
  mutation facts. An outside-workspace boundary is evidence for that reviewer,
  not an automatic request for human confirmation.
- Explicit `rules` mode remains LLM-free by definition: it may auto-allow only
  fully resolved in-boundary operations and otherwise uses its existing
  confirmation path.
- Input size alone never triggers a confirmation dialog in the compact review
  path. Oversized intent and operation lists become explicit, content-addressed
  targeted evidence; if even that contract is violated, the call fails closed.

#### Root Cause

The common guardrail stopped after Tier 1 whenever its engine was `rules` and
immediately escalated. The original Tier-2 design had never been connected to
the REPL's canonical path and shell-AST utilities. Because those utilities
belong to `@kodax-ai/repl`, implementing the missing decision directly inside
`@kodax-ai/coding` would either duplicate parsing logic or violate package
layer independence.

The first Tier-2 implementation then treated
`collectDeterministicBashWriteTargets()` as complete. Its PowerShell helper
recognized only a few target-looking flags and otherwise selected the first
non-flag token. It did not model which parameters consume values or the
source/destination relationship of copy, move, and rename operations.

Separately, the classifier prompt conflated conversational history with
authorization evidence. Truncating that mixed payload reduced precision, while
overflow escalation converted an internal representation limit into user work.

#### Resolution

- Add a typed Tier-2 evaluator hook to the common guardrail and inject the
  deterministic implementation from the Runtime bootstrap. The guardrail is
  still the single authorization decision point; a direct SDK consumer that
  omits the hook continues to fail closed.
- Allow `write`, `edit`, `multi_edit`, and `insert_after_anchor` only when the
  canonical target is inside the Runtime project or a system temp directory.
  Resolve the deepest existing prefix through symlinks/junctions so a lexical
  in-workspace path cannot hide an external target.
- In explicit rules mode, escalate missing/unresolvable paths, link escapes,
  sensitive config or credential paths, out-of-boundary writes, unknown tools,
  high-risk shell patterns, dynamic shell targets, partially unmodelled
  compound commands, and effects whose actual mutation cannot be determined.
- In rules mode, allow established read-only shell commands outside the
  project. Allow fully modeled shell writes (including compounds and
  pipelines) only when every deterministic mutation target passes the same
  canonical project/temp boundary.
- Replace the unconditional "downgraded" copy with neutral rules-engine text;
  automatic transition logs still accurately say "downgraded" at the moment
  a denial/circuit threshold causes that transition.
- Replace PowerShell target guessing with command-specific parameter models.
  Named parameters bind before positional arguments; known value/switch
  parameters, unambiguous abbreviations, `-Path`/`-LiteralPath`, destination,
  and command-specific fields are modeled explicitly. Unknown, ambiguous,
  dynamic, wildcard, array, non-filesystem provider, or remote-session syntax
  is marked incomplete and cannot be rules-auto-allowed.
- Match supported PowerShell positional metadata and aliases such as
  `-PSPath`, `-Type`, `-UseTx`, and `-NoOverwrite`. Preserve `-WhatIf` as a
  non-mutating fact, while link-producing `New-Item` types remain incomplete
  until their target relationship can be represented atomically.
- Represent move/copy/rename as atomic source-to-destination operations. The
  review preserves operation kind, canonical boundary, force/recursive/
  overwrite facts, and risks such as source removal, cross-boundary mutation,
  protected paths, and possible destination overwrite.
- Feed the LLM a compact JSON permission review plus user-only intent evidence.
  Assistant prose, tool-result bodies, and AGENTS.md are excluded. Oversized
  user intent and unusually large operation lists are locally selected into
  bounded evidence with source byte counts and SHA-256 identity; budget alone
  does not ask the user to decide.
- Large operation summaries prioritize outside/protected/unresolved and
  destructive operations instead of sampling only the list edges. A local
  compact-evidence budget block does not count as a model denial and therefore
  cannot indirectly downgrade the session to rules mode.
- When deterministic analysis is incomplete, retain a bounded command
  projection (complete up to 1.5 KiB, otherwise head/tail targeted evidence)
  plus byte counts and SHA-256 identity. This keeps the reviewer informed about
  unmodelled commands without restoring the full raw-context payload.
- Keep the legacy classifier API backward compatible for external callers that
  do not inject a deterministic analyzer. Runtime and REPL paths always inject
  the new analyzer.

#### Files Modified

- `packages/coding/src/guardrails/auto-mode/guardrail.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.test.ts`
- `packages/coding/src/index.ts`
- `packages/repl/src/permission/auto-rules.ts`
- `packages/repl/src/permission/auto-rules.test.ts`
- `packages/repl/src/permission/powershell-mutation.ts`
- `packages/repl/src/permission/powershell-mutation.test.ts`
- `packages/repl/src/permission/permission.ts`
- `packages/repl/src/permission/permission.test.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.test.ts`
- `packages/repl/src/common/permission-config.ts`
- `packages/repl/src/interactive/commands.ts`
- `packages/repl/src/ui/types.ts`
- `packages/repl/src/ui/view-models/status-bar.ts`
- `packages/repl/src/ui/view-models/status-bar.test.ts`
- `packages/coding/src/guardrails/auto-mode/permission-intent.ts`
- `packages/coding/src/guardrails/auto-mode/permission-intent.test.ts`
- `packages/coding/src/guardrails/auto-mode/classifier-prompt.ts`
- `packages/coding/src/guardrails/auto-mode/classify.ts`
- `docs/test-guides/ISSUE_191_v0.7.73_REGRESSION_GUIDE.md`

#### Verification

- RED: the Tier-2 suite first reproduced the missing evaluator. The PowerShell
  regression then failed all six reported forms because no command-level
  assessment existed. Compact-review tests reproduced transcript/AGENTS.md
  forwarding and the 16 KiB action-overflow escalation.
- Final focused permission regression: 9 files, 390 passed, 1 existing
  platform skip.
- `npm test --workspace @kodax-ai/repl -- --reporter=dot`
  (final run: 221 files passed / 2496 tests passed / 1 skipped, plus one
  unrelated session hook timeout under concurrent package load; the isolated
  session file then passed 35/35)
- `npm test --workspace @kodax-ai/coding -- --reporter=dot`
  (final run: 385 files passed / 4048 tests passed / 21 todo, plus one
  unrelated delayed-stream timing assertion; the isolated assertion then
  passed 1/1)
- Focused V8 coverage over the four core modules: 92.42% statements/lines,
  85.31% branches, and 97.36% functions.
- `npx vitest run src/sdk-runtime.test.ts -t "runs explicit auto engines inside Runtime|derives Runtime auto path context|executes the Runtime auto guardrail before|activates the Runtime-owned Auto guardrail" --reporter=dot`
  (4 passed)
- `npx tsc -b tsconfig.build.json --pretty false`

### 190: Legacy matcherless grants and escaped JSON credentials bypassed new safety boundaries

- **Priority**: High
- **Status**: **Resolved** (v0.7.73)
- **Introduced**: v0.7.72 and earlier; expanded v0.7.73 RC
- **Fixed**: v0.7.73
- **Created**: 2026-07-20
- **Resolved**: 2026-07-20

#### Original Problem

Permission grants written before concrete Runtime matchers were introduced had
only `toolName` and optional `sessionId`. The v0.7.73 reader retained these
records as persistent grants, and the matching path treated a missing matcher
as an unconditional match. A legacy Bash grant could therefore authorize a
different or dynamically expanded command without passing the new exact-call
boundary.

The same review questioned the new MCP classifier projection and credential
redaction. Comparison with v0.7.72 confirmed that the older priority projection
could hide a long `command` behind `method`; the new all-recognized-field
projection closes that gap and is retained. Common credential forms were
redacted before the classifier request, but an explicitly named credential in
shell-escaped JSON, such as `{\"token\":\"...\"}`, was not.

#### Root Cause

Backward-compatible grant parsing was incorrectly coupled to authorization:
management compatibility for legacy records implicitly became execution
compatibility. Classifier redaction recognized ordinary JSON key/value syntax
but not the escaped representation commonly embedded in shell arguments.

#### Resolution

- Keep matcherless legacy grants loadable, listable, and revocable, but never
  let them authorize a concrete call. The next invocation requires a fresh
  Runtime-issued matcher and approval.
- Preserve the current MCP projection. It retains all bounded recognized risk
  fields, represents bodies by size and unknown values by shape, and prevents
  the reproducible priority-hiding behavior from v0.7.72.
- Redact values for explicit credential keys in shell-escaped JSON before the
  classifier side-provider request. The surrounding command, URL, and ordinary
  operational fields remain visible.
- Document redaction as defense in depth rather than an entropy detector.
  Unlabelled Base64/hex strings are not blindly removed because they are
  indistinguishable from legitimate hashes, identifiers, and file digests.

#### Files Modified

- `src/sdk-runtime.ts`
- `src/sdk-runtime.test.ts`
- `packages/coding/src/tools/classifier-projection.ts`
- `packages/coding/src/tools/classifier-projection.test.ts`
- `packages/coding/src/guardrails/auto-mode/classify.test.ts`

#### Verification

- RED: the legacy coarse-grant test reproduced implicit authorization before
  the matcherless-grant fix.
- RED: the classifier provider-capture test reproduced escaped JSON credential
  disclosure before the redaction fix.
- `npx vitest run src/sdk-runtime.test.ts -t "Runtime-issued concrete grant|legacy allow_always|persistent grant|persisted dynamic command grant|grant labels|coalesces concurrent|legacy coarse grants|session grants"`
  (11 passed)
- `npx vitest run packages/coding/src/tools/classifier-projection.test.ts packages/coding/src/guardrails/auto-mode/classify.test.ts packages/coding/src/guardrails/auto-mode/transcript-strip.test.ts packages/coding/src/guardrails/auto-mode/guardrail.test.ts`
  (121 passed before the added negative control; focused projection/classifier
  rerun: 40 passed)
- `npx vitest run src/runtime-permission-scope.test.ts packages/repl/src/runtime-permission.test.ts`
  (14 passed)
- `npx tsc -b tsconfig.build.json --pretty false`

### 189: Auto sidecar effort, Runtime session settings, and reasoning command state could diverge

- **Priority**: High
- **Status**: **Resolved** (v0.7.73)
- **Introduced**: v0.7.33; expanded v0.7.73
- **Fixed**: v0.7.73
- **Created**: 2026-07-20
- **Resolved**: 2026-07-20

#### Original Problem

Auto classifier and bash-prefix side queries always sent explicit reasoning
effort `none`. Always-thinking models such as Qwen Token Plan
`qwen3.8-max-preview` rejected that value, which caused classifier failures,
could downgrade Auto to `rules`, and produced avoidable permission prompts.
The main status bar still showed the user's main-model effort (for example
`high`), making the unrelated sidecar failure look like a failed status update.

`/thinking` and `/reasoning` exposed the older
`off|auto|quick|balanced|deep` vocabulary while `/effort` and the status bar
used native provider efforts. Selecting `deep` did not replace an existing
explicit `max`, so the command reported one mode while the status bar correctly
continued to show another. Always-thinking models could also accept and persist
an invalid explicit disable request before the provider rejected it.

Runtime-backed REPL sessions loaded `KODAX_AUTO_MODE_CLASSIFIER_MODEL` for the
legacy local guardrail but did not forward its effective value into Runtime
Session settings. `/mode auto` updated React/classic REPL state before Runtime,
so an immediate `/auto-engine llm` could report that the Session was not in
Auto mode. Runs whose Auto engine was omitted displayed the documented `llm`
default in diagnostics, but some permission-ownership paths still treated the
missing field as “Runtime does not own Auto”; a Tier-1-exempt internal tool such
as `todo_create` could then fall through to the generic permission broker.

Finally, assistant text can stream before a tool call from the same model turn.
A sentence such as “review complete” could therefore appear immediately before
that tool's approval prompt even though the Runtime run was still active,
making the prompt look as if it arrived after the task had terminated.

A follow-up review found four remaining gaps in that first closure. The Ink
command adapter discarded the asynchronous `/mode` synchronization promise; a
fresh REPL control overwrote a persisted Auto engine with its startup default;
side queries treated `disabledEfforts` as unsupported instead of as valid
thinking-off rungs; and the Anthropic adapter omitted
`thinking: { type: "disabled" }` for provider-budget Qwen 3.7 profiles. Parallel
tool preparation could also present two confirmations concurrently and replace
the first dialog resolver, leaving one tool call waiting forever.

#### Root Cause

Side-query policy was hard-coded at each caller instead of resolving the active
model's reasoning profile. Three slash commands wrote two different state
models. REPL Auto configuration stopped at the process-local bootstrap boundary
instead of crossing the Runtime Session API, and the mode callback was
synchronous even though Runtime synchronization is asynchronous. Runtime's
documented omitted-engine default was applied in stats/bootstrap but not in
every live run record and permission-ownership check. The approval UI also did
not explicitly say that an unresolved Runtime permission keeps the run active.
The follow-up gaps came from conflating a valid disabling effort with a rejected
effort, adapting an async callback through a void wrapper, using process-local
initialization as the only persistence signal, and storing only one active
confirmation resolver while tool preparation is parallel.

#### Resolution

- Make an omitted side-query effort capability-aware: use `none` when the model
  advertises disable support, including profiles whose `disabledEfforts`
  explicitly identify the thinking-off rung; otherwise use its lowest visible
  enabled effort, and omit the field when no safe advertised rung exists.
  Explicit caller requests remain strict; no retry ladder hides invalid
  requests.
- When a capability explicitly advertises disabled thinking, send
  `thinking: { type: "disabled" }` on Anthropic-compatible requests regardless
  of whether enabled thinking uses a toggle, effort, adaptive, or budget shape.
- Remove hard-coded `none` from the Auto classifier and bash-prefix extractor.
  This keeps the classifier on Qwen's lowest valid rung without changing the
  main model's status-bar effort.
- Route `/thinking`, `/think`, `/t`, `/reasoning`, `/reason`, and `/effort`
  through one native effort writer with canonical
  `none|auto|low|medium|high|xhigh|max` completion/help. Legacy inputs remain
  accepted as hidden aliases. Reject `none` before persistence when the active
  model cannot disable reasoning.
- Resolve environment-over-file classifier configuration once and explicitly
  synchronize permission mode, classifier model, timeout, and speculative
  window into each Runtime Session. Initialize the engine only when persisted
  Session settings do not already contain one, so manual changes and automatic
  downgrades survive a control/process restart. `/mode` passes the async Runtime
  callback through intact and waits before publishing/saving the new mode.
- Normalize omitted Auto engines to `llm` in live run records and guardrail
  refreshes, preserving the existing Tier-1 empty-projection bypass for
  internal non-file-mutating tools. `/auto-engine` now reports a configured
  session classifier model for direct verification when one is present.
- State in Runtime approval prompts that the run remains active until the
  approval is resolved, and add a bridge regression proving a runner cannot
  report completion while an earlier permission event remains unresolved.
- Serialize Ink confirmation presentation with a small promise tail so parallel
  tool preparation cannot overwrite the active resolver; a rejected presenter
  does not stall later confirmations.

#### Files Modified

- `packages/llm/src/side-query.ts`
- `packages/llm/src/providers/anthropic.ts`
- `packages/coding/src/guardrails/auto-mode/classify.ts`
- `packages/coding/src/guardrails/auto-mode/bash-prefix-extractor.ts`
- `packages/repl/src/runtime-permission.ts`
- `packages/repl/src/interactive/commands.ts`
- `packages/repl/src/interactive/repl.ts`
- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/utils/confirmation-dialog-queue.ts`
- `scripts/probe-reasoning.ts`
- `src/kodax_cli.ts`
- `src/sdk-runtime.ts`

#### Verification

- `packages/llm/src/side-query.test.ts`
- `packages/llm/src/providers/anthropic-reasoning-capability.test.ts`
- `packages/llm/src/providers/registry.test.ts`
- `packages/coding/src/guardrails/auto-mode/classify.test.ts`
- `packages/coding/src/guardrails/auto-mode/bash-prefix-extractor.test.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.test.ts`
- `packages/repl/src/interactive/effort-command.test.ts`
- `packages/repl/src/interactive/completers/argument-completer.test.ts`
- `packages/repl/src/interactive/commands-status.test.ts`
- `packages/repl/src/interactive/prompts.test.ts`
- `packages/repl/src/ui/utils/confirmation-dialog-queue.test.ts`
- `src/kodax_cli.runtime-runner.test.ts`
- `src/sdk-runtime.test.ts`
- `npx tsc -b tsconfig.build.json --pretty false`
- Live single-turn probes confirmed disabled thinking with zero thinking output
  for Qwen Token Plan Qwen 3.7 Max/Plus and Qwen 3.6 Flash, GLM-5.2,
  DeepSeek V4 Pro/Flash, Kimi K3, MiniMax M3, and their tested Ark routes.
  Controls confirmed Qwen 3.8 Max Preview, Kimi K2.7 Code, and MiniMax M2.7
  remain always-thinking. MiMo could not be revalidated because the configured
  public account had insufficient balance and the coding-plan credential was
  rejected; its existing capability declaration remains unchanged.

### 188: Auto classifier projection, transcript boundaries, and first-run environment ordering were incomplete

- **Priority**: High
- **Status**: **Resolved** (v0.7.73)
- **Introduced**: v0.7.33; expanded v0.7.72 RC
- **Fixed**: v0.7.73
- **Created**: 2026-07-20
- **Resolved**: 2026-07-20

#### Original Problem

The Auto[LLM] side-provider transcript retained complete assistant `tool_use`
arguments. Write/edit bodies and credentials could therefore leave the main
provider. The first local correction overcompensated by removing all arguments,
including paths, targets, command intent, and scope that the classifier needs
to interpret later actions. When the transcript exceeded its byte budget, an
oversized current tool call or tool result could also consume the recent-context
allocation and drop the user's newest explicit constraint.

The first bounded correction still retained raw `tool_result` text up to 2 KiB,
duplicated canonical action fields in historical metadata, and relied on every
tool author to provide complete classifier metadata. Constructed tools and
JavaScript extensions could therefore serialize arbitrary input or silently
skip classification when metadata was absent. MCP projection also hid a long
path or a second action field while forwarding unrelated short scalar values.

Separately, interactive first-run provider readiness inspected `process.env`
before Runtime preparation hydrated login-shell and config-backed credentials.
Users whose provider credential existed only in that environment projection
could be sent through setup even though normal Runtime startup was ready.

#### Root Cause

Transcript projection originally treated tool identity and raw arguments as one
factual record; the first correction then treated identity as sufficient. The
missing middle layer was the existing per-tool classifier projection plus a
fixed, bounded metadata projection. Budgeting also anchored only the first
`user` role and greedily truncated the newest oversized message. Tool-result
envelopes use the `user` role, so role alone cannot identify a genuine user
constraint. The first-run setup gate had been placed before the one existing
Runtime configuration preparation call.

The registry contract was compile-time only: JavaScript registrations could
omit `sideEffect` or `toClassifierInput`, and an empty non-readonly projection
had no auditable justification. Tier 0 also ran after the empty-projection
shortcut, so a faulty exemption could bypass deterministic denial. MCP used a
single priority action field plus opportunistic scalar previews instead of a
field-semantics projection.

#### Resolution

- Project assistant tool history through exactly one canonical
  `toClassifierInput` summary. Historical metadata no longer repeats paths or
  commands already represented by that summary; it adds only body sizes and
  collection counts. Portable `tool_call` history is unwrapped to the concrete
  target before projection.
- Replace every historical `tool_result` body, including errors and content
  below the old 2 KiB threshold, with bounded status metadata: tool identity,
  success/error, text character/byte counts, and media count. Result text,
  image paths, and media payloads never reach the classifier.
- Add one semantic fallback for constructed and extension tools. It retains
  bounded operational locators, commands/scripts/argument arrays and control
  flags; converts known free-form bodies to character counts; and describes
  unknown values only by type/shape. MCP uses the same field semantics, keeps
  every populated action field, and never forwards arbitrary short scalars.
  Common snake_case/camelCase SDK fields share that table, recognized fields
  are emitted before unknown shapes, and long locators preserve both their
  beginning and final target segment.
- Normalize runtime registrations: missing/invalid side effects become
  `mutates-state`, missing non-readonly projectors receive the safe fallback,
  and accidental empty non-readonly projections no longer bypass the
  classifier. Intentional non-readonly exemptions require a documented
  `classifierExemptReason`.
- Run deterministic Tier 0 checks before projection opt-out. Missing projectors
  fall back safely; throwing or invalid projectors escalate without disclosing
  exception text. Local read-only tools keep the zero-cost bypass, while
  network egress and remote provider-backed searches expose bounded query,
  locator, provider, and capability facts.
- Anchor the first and latest genuine user-intent messages before adding recent
  factual context. Tool-result-only envelopes are excluded from intent anchors,
  and only the remaining budget may hold a bounded snapshot of the newest
  oversized factual message. The serialized UTF-8 budget remains exact.
- Prepare Runtime configuration once after subcommand handling but before
  first-run readiness, then reuse that same configuration for session startup.

#### Verification

Regression tests cover useful path/command/query retention, write/edit body
non-disclosure, raw result non-disclosure, header/URL/CLI credential redaction,
MCP multi-action/long-path retention, constructed/extension fallback,
non-readonly exemption auditing, projector failure escalation, Tier-0 ordering,
portable bridge unwrapping, first/latest intent retention across an oversized
tool call and a tool-result envelope, exact transcript byte bounds, and
login-shell credential hydration before provider readiness without launching
the setup wizard.

### 187: Shared-daemon Auto permission ownership, upgrade fencing, preview bounds, and SDK compatibility were incomplete

- **Priority**: High
- **Status**: **Resolved** (v0.7.72)
- **Introduced**: v0.7.72
- **Fixed**: v0.7.72
- **Created**: 2026-07-19
- **Resolved**: 2026-07-19

#### Original Problem

The v0.7.72 Runtime Auto guardrail fix did not give SDK clients a complete
semantic upgrade or compatibility contract. An SDK client could reuse a healthy
older daemon that did not advertise Runtime-owned Auto classification; Session
fallback and settings updates could race or leave queued turns bound to a stale
cwd/engine; several Windows path checks remained case-sensitive; Bash writes to
the user `.kodax` credential zone were classifier-overridable; and permission
previews traversed and serialized more caller input than an approval UI needs.

The same SDK cut also removed the `amaw` input spelling, expanded `SkillSource`
with `learned`, and renamed daemon preflight task fields without a 0.7.x
compatibility surface. KodaX Space consequently encountered compile-time
breakage even though AMAW's runtime behavior had already merged into AMA.

#### Root Cause

Daemon health was treated as sufficient compatibility evidence, while the
permission owner contract had no dedicated capability. Auto guardrails were
cached as configuration snapshots instead of resolving the serialized Session
permission state at execution time. Path containment and preview construction
were duplicated across layers, and release-time type migrations changed
consumer-facing unions/fields rather than separating legacy input types from
new resolved runtime output.

#### Resolution

- Added `runtimeAutoModeGuardrail:1`; auto-start clients safely replace an old
  daemon only through revision/owner-policy fenced preflight when no active,
  queued, workflow, Agent-turn, permission, user-input, or second-client work
  exists. Attach-only and busy cases fail with a typed recoverable error.
- Added one serialized per-Session settings owner. Active and queued runs follow
  permission/engine/classifier/timeout updates; fallback merges the latest
  revision, persists rules state, and cannot reuse a downgraded LLM cache entry.
  Context-specific guardrails share the Session's engine, denial tracker, and
  circuit breaker without capturing another queued turn's cwd.
- Kept execution cwd in each guardrail cache identity and resolve relative tool
  and plan-mode paths from that cwd while treating git root only as the safety
  boundary and plan-document anchor.
- Unified permission-related path containment with Windows case-insensitive,
  segment-safe semantics and made proven direct/nested-shell writes to the user
  `.kodax` credential zone a deterministic Tier-0 denial, including redirects
  recoverable from otherwise unparseable shell input. Quoted Python and
  regular-expression source remains data rather than a path.
- Replaced recursive input serialization with a fixed-field, scan-bounded JSON
  summary. Write/edit bodies are omitted; strings, arrays, JSON/YAML secrets,
  headers, CLI credentials, URLs, and PEM blocks are bounded/redacted.
- Restored deprecated 0.7.x input aliases without restoring retired behavior:
  `amaw` normalizes to `ama`; legacy `SkillSource` stays exhaustive while
  `ResolvedSkillSource` adds `learned`; `activeAgentTasks` aliases current Agent
  turns alongside canonical `activeAgentTurns`.
- Runtime runs without an executable plan-exit callback do not expose
  `exit_plan_mode` to the model.

#### Verification

Regression coverage includes guardrail-before-hook execution order, read-only
and ordinary verification commands without pending permissions, exactly one
request on classifier escalation, active mode switching, concurrent
settings/fallback mutation, different-cwd queued turns, fallback then explicit
LLM re-entry, Windows case variants, execution-cwd-relative plan paths, direct
and nested Bash redirects (including unparseable surrounding syntax), source
text false-positive protection, valid bounded large-write previews, YAML/JSON/
PEM redaction, daemon capability advertisement/fail-closed attachment, plan-exit
tool hiding, and legacy SDK type aliases.

### 186: Daemon event subscriptions had no readiness boundary and could miss the first cross-client event

- **Priority**: High
- **Status**: **Resolved** (v0.7.72)
- **Introduced**: v0.7.66
- **Fixed**: v0.7.72
- **Created**: 2026-07-19
- **Resolved**: 2026-07-19

#### Original Problem

The daemon client returned `RuntimeSubscription` synchronously while it created
the corresponding server subscription in an unobservable background request.
Its notification buffer covered events received before the subscribe response,
but it could not cover an event emitted before the server had processed the
subscribe request. A second client could therefore start a permission request
immediately after `events.subscribe()` and lose `permission.requested`, leaving
the request pending until timeout or shutdown.

Release CI reproduced the race on both Node 20 and Node 22. The test cleanup's
correct refusal to stop a daemon with an active `permission.request` initially
masked the earlier subscription-handshake timeout.

#### Expected Behavior

- A daemon host can explicitly wait until a remote event/workflow subscription
  is installed before another client starts work.
- Notifications received after installation but before the response remain
  buffered and are delivered once the remote subscription ID is known.
- Handshake failure is observable without producing an unhandled rejection for
  existing callers that do not use the new readiness boundary.
- Local embedded subscriptions remain synchronous and unchanged.

#### Root Cause

`subscribeToDaemonNotification()` started an asynchronous RPC and discarded its
promise. `RuntimeSubscription` exposed only `close()`, so callers had no way to
establish a happens-before relationship across two daemon connections.

#### Resolution

- Added the optional `RuntimeSubscription.ready` promise for remote
  event/workflow subscription handshakes.
- Preserved pre-response notification buffering and close-before-ready remote
  cleanup.
- Propagated handshake rejection through `ready` while attaching an internal
  rejection handler for backward-compatible callers that ignore it.
- Updated SDK permission examples to await readiness before triggering
  cross-client work, with focused success/failure regressions.

### 185: Learning lock crash recovery can time out before stale ownership is reclaimable

- **Priority**: Medium
- **Status**: **Open**
- **Introduced**: v0.7.68; expanded v0.7.72 RC
- **Created**: 2026-07-19

#### Original Problem

Both learning lock implementations stop waiting after 5 seconds, but refuse to
test the recorded owner's liveness until the lock file is more than 30 seconds
old. When a process crashes after writing a valid owner record, learning
proposal and Learned Area operations started during that 5-to-30-second window
can therefore fail with a lock timeout even though no live owner remains.

The two thresholds serve different purposes: a bounded acquisition timeout is
appropriate for live contention, while stale-owner recovery handles a crashed
owner. Raising the acquisition timeout to 30 seconds would hide the mismatch by
turning a recoverable crash into a long user-visible stall. Slow storage can
also make concurrent operations exceed the current waiting budget, but this is
contention behavior rather than proof that both thresholds must be identical.

The same lock protocol is duplicated in the F224/F228 proposal store and the
new F266 Learned Area helper. Their error messages differ and future fixes can
drift. The current stale path also performs a check followed by an unconditional
`rm`; multiple contenders reclaiming one crashed lock could race with creation
of a successor lock unless stale ownership is claimed atomically.

#### Expected Behavior

- A valid lock whose owner is demonstrably alive is never stolen.
- A valid lock whose owner is demonstrably dead can be reclaimed promptly,
  without first forcing callers through repeated five-second failures.
- Empty, partially written, malformed, inaccessible, or otherwise unverifiable
  ownership remains fail-closed.
- Live contention stays bounded and does not become a 30-second UI stall.
- Concurrent stale-lock contenders cannot remove a successor's lock.

#### Context

- **Feature ownership**: FEATURE_266, reusing the earlier F224/F228 proposal
  store protocol
- **Affected components**: `packages/agent/src/learning/store-lock.ts`,
  `packages/agent/src/learning/store.ts`, Learning Center/Learned Area writes
- **Trigger**: owner crash followed by a learning operation within 30 seconds;
  slow or highly contended storage increases the visible failure rate
- **Impact**: bounded learning-operation failure or delay; no normal-path data
  corruption has been reproduced
- **Release decision**: accepted as a non-blocking v0.7.72 deferral; fix in the
  F266 reliability follow-up rather than changing the lock protocol during the
  release cut
- **Workaround**: retry after the stale threshold; manually remove a lock only
  after independently confirming that its recorded owner is no longer alive

#### Root Cause

Owner liveness is nested behind a file-age gate, coupling crash recovery to a
30-second grace period even when the stored PID can already be checked safely.
The protocol was copied instead of routing proposal-store and Learned Area
writes through one implementation, and stale deletion is not an atomic claim.

#### Proposed Solution

- Consolidate proposal-store and Learned Area writes on one lock helper while
  preserving package-layer independence and existing token-fenced release.
- Separate live-contention timeout from stale-owner recovery; inspect a complete
  parseable owner record before the age threshold and reclaim only after an
  unambiguous dead-process result.
- Claim a stale lock atomically before removal so only one contender can win;
  never use a check-then-unconditional-delete sequence that can target a
  successor lock.
- Preserve fail-closed handling for malformed records and filesystem sharing
  errors rather than guessing ownership.
- Add crash-child, live-owner, malformed/partial-record, successor-token,
  simultaneous-contender, and Windows sharing-error regression tests.

### 184: `sed` side effects can bypass plan-mode write classification

- **Priority**: High
- **Status**: **Open**
- **Introduced**: v0.5.36
- **Created**: 2026-07-19

#### Original Problem

`sed` is listed as a safe read command, but the plan-mode write classifier does
not recognize its file-writing forms. The existing read-side check only scans
space-split text for a subset of `-i` forms, while `isBashWriteCommand()` does
not classify `sed` as writing. SDK and ACP plan-mode paths can therefore treat
an in-place invocation as allowed because they consume the write classifier's
result directly. The traditional REPL retains an additional shell confirmation
layer, so the observable behavior is inconsistent across hosts.

The gap is broader than a bare `sed -i`: GNU/BusyBox/BSD accept multiple
in-place option forms, and sed programs can write through `w`, `W`, or the
`s///w` flag; GNU `e` can execute a command. A script supplied with `-f` is
opaque to a command-line-only classifier. Conversely, adding every `sed`
invocation to the write-command list would regress legitimate read-only uses
such as `sed -n` and `sed -e`.

#### Expected Behavior

All Runtime surfaces should apply one effect-aware classification before a
plan-mode decision. Clearly read-only sed invocations should remain available;
known write effects should be blocked in plan mode and use the normal
guardrail/permission chain elsewhere; opaque or ambiguous programs must not be
silently treated as read-only.

#### Context

- **Affected components**: REPL permission classification, SDK Runtime, ACP
- **Affected scenarios**: plan mode and any host that trusts the shared bash
  read/write classifiers as an immutability boundary
- **Release decision**: accepted as a documented deferral for v0.7.72 while an
  effect model that avoids read-command regressions is designed
- **Workaround**: hosts requiring a hard read-only boundary should omit the
  shell tool or enforce filesystem immutability outside the command classifier

#### Root Cause

Read admission and write detection are separate boolean heuristics. The
read-side sed exception parses reconstructed command text rather than the shell
AST's argument roles, and the write-side classifier has no sed semantics. The
model cannot represent an opaque/unknown effect without incorrectly mapping it
to either read-only or writing.

#### Proposed Solution

- Classify parsed sed arguments rather than scanning arbitrary text; honor
  `--` and the arguments consumed by `-e`/`-f`.
- Recognize documented GNU, BusyBox, and BSD in-place forms without matching
  `-i` inside scripts, regular expressions, replacement text, or operands.
- Detect direct script write/execute commands and treat external `-f` programs
  as unknown unless their contents can be safely inspected.
- Introduce `readOnly` / `writes` / `unknown` effect outcomes shared by REPL,
  SDK, and ACP, with table-driven cross-surface regression tests.

### 183: CLI daemon startup failures and forced test exits could leave detached Node processes

- **Priority**: High
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.66-v0.7.72-hotfix.0
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

Windows process inspection found detached `kodax daemon serve` Node processes
whose launching test workers no longer existed. Normal daemon persistence was
initially conflated with leakage: a healthy shared daemon intentionally survives
client `close()`, and a live/reachable daemon is not stale merely because its
original client or parent exited.

Two real lifecycle gaps remained. `kodax daemon start` detached its child before
health confirmation and retained no handle, so timeout, startup failure, owner
race, or Ctrl+C could not reclaim that exact candidate. Separately, daemon tests
performed explicit shutdown in `finally`, but a forcibly terminated Vitest
worker cannot run JavaScript teardown and could leave its test daemon alive.
The report's claimed `mock-provider` tight loop had no supporting stack or CPU
profile and was not used as a basis for a speculative provider change.

#### Root Cause

- CLI and SDK startup used different process lifecycle implementations. The SDK
  path retained and fenced its child, while the CLI path called `unref()`
  immediately and then polled health independently.
- The test harness had normal-path shutdown but no out-of-process fallback tied
  to the actual Vitest worker lifetime.
- A universal zero-client/idle reaper would violate the documented shared-daemon
  contract and the proposed `unowned` condition cannot describe a live owner,
  because a live daemon holds its own owner lock.

#### Resolution

- CLI and SDK now share one startup primitive. The exact candidate stays
  referenced until its own PID publishes healthy state; child exit, timeout,
  identity mismatch, competing-owner loss, and startup cancellation reclaim
  only that candidate and its descendants. Successfully healthy daemons remain
  detached and persistent.
- CLI startup installs bounded SIGINT/SIGTERM cancellation only while startup is
  pending and removes those listeners on every exit path. Known startup failure
  remains structured in JSON results; cleanup failure still propagates.
- Vitest records its worker PID in an internal inherited marker. A daemon checks
  that marker only when explicitly present and performs normal owner shutdown if
  the worker disappears. Production launches have no parent timer or idle
  reaper, and external tests must still use explicit `runtime.shutdown`/daemon
  stop during normal teardown.
- Startup termination uses the existing cross-platform process-tree cleanup so
  a partially initialized candidate cannot leave MCP/A2A descendants behind.

#### Files Changed

- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/process.test.ts`
- `src/kodax_cli.ts`
- `src/kodax_cli.daemon-smoke.test.ts`
- `vitest.setup.queue.ts`
- `docs/HLD.md`
- `docs/DD.md`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `docs/test-guides/ISSUE_183_v0.7.72_REGRESSION_GUIDE.md`
- `CHANGELOG.md`

#### Tests Added / Verification Coverage

- Cancellation rejects promptly, terminates once, and never unreferences the
  pending candidate.
- A real SDK-started daemon shuts down, removes state/lock, and exits after its
  explicitly watched parent process terminates without closing the client.
- Existing regressions continue proving that a healthy daemon survives ordinary
  client detach, concurrent starters converge, and CLI start/restart/stop works.
- Strict TypeScript compilation passes and the final Windows process inventory
  contains no KodaX daemon residue.

### 182: Windows lifecycle lock contention surfaced as fatal `EPERM` during concurrent memory forgets

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.68
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

The memory lifecycle lock retried only `EEXIST`. Under concurrent forgets,
Windows can report a short-lived `EPERM`, `EACCES`, or `EBUSY` while another
owner closes or removes the lock file. That valid contention path escaped
immediately and made the full Agent suite intermittently fail even though the
lock owner was live and the five-second acquisition deadline had not expired.

#### Resolution

- Treats Windows sharing-denial errors and cross-platform `EBUSY` as bounded
  lock contention, using the existing stale-owner check, retry interval, and
  five-second deadline. Other filesystem errors still propagate immediately.
- The 24-way concurrent-forget regression passed five consecutive focused runs
  after reproducing the original failure.

#### Files

- `packages/agent/src/memory-control/lifecycle.ts`
- `packages/agent/src/memory-control/memory-control.test.ts`

### 181: MiniMax M3 default upgrade left the media capability regression stale

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.72-dev
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

The current provider snapshot changed `minimax-coding`'s default from
MiniMax M2.7 to the verified image-capable MiniMax M3 route. Model-specific
media regressions were updated, but one default-provider assertion still
expected image input to be unsupported, leaving the full Agent suite red even
though production capability resolution was correct.

#### Resolution

- Updated the stale assertion to pin the current MiniMax M3 default's supported
  image capability while retaining the nearby unsupported-route checks.
- Re-ran the full Agent suite so the capability source, default-model snapshot,
  and regression contract agree.

#### Files

- `packages/agent/src/media/capabilities.test.ts`
- `packages/coding/src/media/capabilities.test.ts`

### 180: Queued user input used a different root scope and could not wake `wait_agent`

- **Priority**: High
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.72-dev
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

While the root Agent repeatedly called `wait_agent`, a user follow-up could
remain in the visible Queue across many tool/LLM steps and even after the child
Agent completed. The UI queued prompts without an `agentId`, while the new Actor
runner drained `actor:<sessionId>:/root`; exact queue routing meant neither side
could see the other. `wait_agent` also waited only for Actor events and the UI
used whole-run abort as its historical wake mechanism.

#### Resolution

- Added one canonical Actor queue-id helper and routed REPL producers, AMA/SA
  consumers, cancellation terminals, and goal deferral through the session root.
- Preserved the legacy unscoped SA route. The public media enqueue helper now
  accepts `sessionId`, automatically binds old single-Actor calls to the sole
  active root, and rejects ambiguous multi-session calls instead of crossing
  sessions. Runtime and Runner own reference-counted route registration from
  start through every terminal path; Runtime commits registration only after
  the underlying launch object exists, so synchronous startup failure cannot
  leak a stale active route.
- `wait_agent` now races Actor events against a non-consuming queue subscription
  using read-register-recheck, returning `user_input_pending` at the next safe
  boundary without aborting unrelated parallel tools.
- Idle-yield now uses the same lossless subscription pattern instead of polling.
- Session isolation, pre-existing input, registration-gap input, abort, timeout,
  synchronous launch failure, and queue-retention behavior have deterministic
  regression coverage.

#### Files

- `packages/coding/src/agent-runtime/actor-queue.ts`
- `packages/agent/src/messaging/routing.ts`
- `packages/agent/src/media/queue.ts`
- `packages/coding/src/tools/agent-collaboration.ts`
- `packages/coding/src/task-engine/runner-driven.ts`
- `packages/coding/src/agent-runtime/run-substrate.ts`
- `packages/agent/src/orchestration/idle-yield.ts`
- `packages/repl/src/ui/contexts/StreamingContext.tsx`
- `src/sdk-runtime.ts`

### 179: Auto[LLM] eight-second timeout and readonly projections caused spurious approvals

- **Priority**: High
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.33
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

Auto[LLM] escalated classifier timeouts into confirmation dialogs. The fixed
eight-second default was below historical P90 classifier latency, so timeouts
were frequent rather than exceptional. Several locally readonly observation
tools also emitted non-empty classifier projections and unnecessarily paid the
LLM latency/failure path.

#### Resolution

- Raised the bounded default classifier timeout to 20 seconds; explicit user
  settings still override it and non-readonly failures remain fail-closed.
- Enforced empty classifier projections for pure readonly invocations, covering
  Actor observation, ordinary semantic lookup, and LSP document symbols without
  weakening write/network policy. `semantic_lookup(refresh:true)` remains a
  deliberate exception because it rebuilds the on-disk derived index.
- Added SDK/daemon session settings for classifier model and timeout, positive
  integer validation, persistence, capability advertisement, and cache-key
  invalidation when either setting changes.

#### Files

- `packages/coding/src/guardrails/auto-mode/classify.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.ts`
- `packages/coding/src/tools/tool-definitions.ts`
- `src/sdk-runtime.ts`
- `src/runtime-daemon/server.ts`

### 178: Bare `-r` cancellation retained terminal input until another keypress

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.72-hotfix.0
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

After `npm link`, running `kodax -r` and pressing Esc displayed
`Session resume cancelled.` but did not immediately return to the PowerShell
prompt. Pressing another key, such as Space, allowed the command to finish.

Expected behavior: explicit picker cancellation must restore the terminal and
return to the invoking shell without requiring any additional input.

#### Root Cause

The searchable picker resumes stdin so it can receive raw terminal input. Its
renderer correctly removed listeners and restored raw mode, but the bootstrap
handled the resulting `kind: 'exit'` route with an immediate return. Unlike the
successful handoff and error paths, that branch never paused or unreferenced
stdin, so Windows could keep the linked Node process attached to terminal input
until another keypress woke the stream.

#### Resolution

- The bare-resume bootstrap now pauses and unreferences stdin before returning
  from an explicit cancellation.
- Successful selection still uses the existing pause/ref handoff before the
  full REPL takes ownership, so resumed sessions retain working input.
- A focused regression asserts cancellation releases stdin without loading the
  full CLI or referencing input again.

#### Files

- `src/kodax_bootstrap.ts`
- `src/kodax_bootstrap.test.ts`

#### Verification

- Bootstrap, picker, runner, renderer, and resume-handoff suites: 36/36 tests
  passed across 6 test files.
- Full `npm run build` passed, including the linked CLI bootstrap bundle.

### 177: Worker announced and attempted an oversized fresh spawn wave before Actor capacity rejection

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72)
- **Introduced**: v0.7.72-dev
- **Fixed**: v0.7.72
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

On a fresh four-slot Actor tree, a request containing five independent review
tracks could make the root say it would dispatch five Agents and emit five
`spawn_agent` calls. The scheduler correctly admitted only three non-root
Turns, after which the root explained the capacity failure and took over work.
Safety was preserved, but the visible plan, tool batch, and actual execution
disagreed.

#### Root Cause

The scheduler capacity fact existed only at tool execution time. The first
prompt revision also placed correct capacity guidance deep inside a long
collaboration section, and the no-routing-plan fallback retained static
instructions. A paid `fresh_capacity` pilot reproduced five structured starts,
showing that tool-layer rejection plus a buried sentence was not an adequate
experience contract.

#### Resolution

- Full routing-plan and no-plan fallback prompts read the current Actor tree on
  every LLM round.
- Both paths reuse one authoritative first-section capacity contract with the
  exact total, active, and available slots; it limits both visible prose and
  `spawn_agent` calls for the current response.
- Overflow remains root-owned or is named as a later refill wave. No hidden
  scheduler queue, second lifecycle, or increased concurrency limit was added.
- Deterministic full/fallback prompt tests and the smallest affected six-call
  re-pilot verify three starts for the fresh five-track treatment case.

#### Files

- `packages/coding/src/agents/worker-role-prompt.ts`
- `packages/coding/src/task-engine/runner-driven.ts`
- `packages/coding/src/task-engine/_internal/managed-task/{agent-chain,role-prompt,role-prompts}.ts`
- `benchmark/datasets/feature-270/*`

### 176: Learning subscription could lose a wake, retain a waiter after disconnect, and cache transient principals without bound

- **Priority**: High
- **Status**: **Resolved** (v0.7.72)
- **Introduced**: v0.7.72-dev
- **Fixed**: v0.7.72
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

`subscribe()` read durable events before registering its in-process waiter. An
event committed in that gap was neither in the first read nor delivered to the
not-yet-registered waiter, so the subscriber remained blocked until a later
event. Returning an async generator while it awaited that waiter could not
cancel the wait promptly. Runtime Learning also cached one facade per daemon
principal, allowing a long-lived daemon with changing principals to grow an
unbounded Map.

#### Root Cause

The subscription combined a durable file cursor with a non-atomic in-memory
notification hub but lacked read-register-recheck. Async-generator `return()`
cannot enter `finally` until its current awaited promise resolves. The Runtime
owner conflated durable client identity with object-facade identity.

#### Resolution

- Subscription uses read-register-recheck and advances one durable sequence at
  a time.
- A cancellable async iterator owns its waiter; `return()` removes and resolves
  it immediately.
- Runtime retains no per-principal facade Map. It creates lightweight facades
  on demand, shares owner-level learned-area initialization, and continues to
  hash stable client identities into durable cursor files.
- Deterministic tests pause the first read across a concurrent commit, verify
  prompt cancellation without a subsequent event, and prove repeated binding
  does not return a retained facade.

#### Files

- `packages/agent/src/learning/learning-center-service.ts`
- `packages/agent/src/learning/learning-center.test.ts`
- `src/runtime-learning.ts`
- `src/sdk-runtime.learning.test.ts`

### 175: Actor start/interrupt race could launch with a fresh cancellation handle; closed Actors still accepted mailbox traffic

- **Priority**: High
- **Status**: **Resolved** (v0.7.72)
- **Introduced**: v0.7.72-dev
- **Fixed**: v0.7.72
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

Actor start persisted the running Turn before `launch()` created its
AbortController. An interrupt could commit in between, observe no controller,
and then allow launch to install a fresh un-aborted handle. Closed Actors also
passed relationship authorization for mailbox send/drain, leaving messages in
an identity that would not execute again. Late successful executor callbacks
performed a no-op mutation that still advanced snapshot revision and saved.

#### Root Cause

Cancellation ownership was attached to execution launch instead of the atomic
Turn-start state transition. Messaging authorization checked only tree
relationships, not terminal Actor identity state. The mutation primitive had
no explicit unchanged-result path.

#### Resolution

- `commitStart()` atomically creates and stores the controller; `launch()` only
  consumes that exact handle.
- Closed identities remain inspectable but reject send, receive/drain, spawn,
  and follow-up with `actor_closed`.
- Completion, failure, and progress callbacks on terminal Turns skip revision
  increment and persistence.
- The daemon advertises versioned `actorControlPlane v1`; incompatible new
  SDK/old daemon and old SDK/new daemon pairs receive explicit upgrade/restart
  errors without restoring `agentTasks` as an executable alias.
- Deterministic save-gated race, late completion, closed mailbox, and protocol
  compatibility tests cover the repaired boundaries.

#### Files

- `packages/agent/src/actors/controller.ts`
- `packages/agent/src/actors/controller.test.ts`
- `src/runtime-daemon/{client,protocol,schema,server}.ts`
- `src/sdk-runtime.ts`

### 174: Bare `-r` session picker exited as cancelled before accepting input

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.69
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

Running `kodax -r` or `npm run dev -- -r` paused during startup and then
printed `Session resume cancelled.` without displaying a usable searchable
session picker. The explicit `-r <session-id-or-title>` path remained a
workaround.

Expected behavior: in an interactive terminal, bare `-r` remains alive until
the user selects a session or explicitly cancels. In a non-interactive process,
the CLI should report that an exact ID or title is required instead of claiming
that the user cancelled.

#### Root Cause

- The v0.7.69 picker migration from upstream Ink to the local TUI called the
  new renderer without terminal streams. The local renderer therefore used its
  inert fallback stdin/stdout/stderr: no picker was visible and no input could
  reach it.
- The local input runtime also enabled raw mode and attached a data listener
  without taking ownership of an unreferenced stdin handle.
- During early CLI startup the picker can be the only component expected to
  keep the process alive. Node therefore reached `beforeExit`, unmounted the
  picker, and resolved `waitUntilExit()` without a selection.
- `runSessionPicker()` represented both explicit cancellation and unexpected
  lifecycle exit as `undefined`, so the CLI printed the misleading cancellation
  message.
- The local `useInput()` compatibility layer also discarded Ctrl+C before the
  picker could handle it, breaking one of its documented cancellation paths.

#### Resolution

- `runSessionPicker()` now binds the owned renderer to the real process terminal
  streams, so the picker is visible and receives input.
- The terminal input controller now references stdin while at least one input
  subscriber is active and releases that reference after the final subscriber
  detaches. Raw-mode ownership remains shared across subscribers and is restored
  during cleanup.
- Ctrl+C is delivered through the local `useInput()` contract, allowing the
  picker to cancel and restore raw mode normally.
- The picker tracks explicit cancellation separately, reports unexpected exits
  as errors, rejects non-interactive bare resume with an actionable ID/title
  instruction, and always unmounts/cleans up in `finally`.
- After Enter, the picker remains mounted in a visible loading state while the
  full CLI module is prepared. Bootstrap memoizes that import, then pauses and
  re-references interactive stdin before the REPL renderer takes ownership, so
  the picker-to-REPL transition has no unowned input or process-liveness gap.
- Selection preparation failures preserve the original error, clean up the
  picker terminal lifecycle, and never retain stdin.

#### Files

- `packages/repl/src/tui/renderer-runtime.tsx`
- `packages/repl/src/tui/renderer-runtime.test.ts`
- `packages/repl/src/ui/SessionPicker.tsx`
- `packages/repl/src/ui/SessionPicker.test.tsx`
- `packages/repl/src/ui/SessionPicker.runner.test.tsx`
- `packages/repl/src/cli-resume.ts`
- `src/kodax_bootstrap.ts`
- `src/kodax_bootstrap.test.ts`
- `src/kodax_resume.ts`
- `src/kodax_resume.test.ts`

#### Verification

- TUI, picker, and dialog regression suite: 34 files, 400 tests passed.
- Root CLI suite: 1 file, 65 tests passed.
- `npm run build --workspace=@kodax-ai/repl` passed.
- A built-artifact terminal-stream simulation rendered the picker, selected the
  requested session through Enter, and restored raw mode (`raw=false`).
- Rebuilt `@kodax-ai/repl`; non-interactive bare `-r` now reports the required
  exact ID/title rather than `Session resume cancelled.`
- Focused picker/bootstrap/resume transition suite: 6 files, 36 tests passed,
  including async preload failure cleanup; full TypeScript checking passed.
- The complete package, CLI/resume/bootstrap bundle, Worker sidecar, and all 12
  public SDK declaration builds passed.

### 173: REPL batch history commit collapsed distinct reply times into one timestamp

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.45
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-18
- **Resolved**: 2026-07-18

#### Original Problem

After one long user query, every committed Assistant, Thinking, and Tools block
could display the same completion-time clock value even though the replies were
produced minutes apart. Session `20260718_105849` demonstrated the failure: its
canonical assistant lineage retained distinct timestamps from 11:00 through
11:17, while the persisted `uiHistory` entries had no timestamps and the final
batch render showed the response blocks at 11:17.

Expected behavior: each history block keeps the time at which that event was
created. Batching history updates may reduce renders, but must not replace
event metadata with the batch commit time.

#### Root Cause

- `CreatableHistoryItem` removed both `id` and `timestamp`, so converting live
  managed-foreground items to bulk additions discarded their original times.
- `KodaXSessionUiHistoryItem` and its serializer did not persist a history-item
  timestamp.
- `addHistoryItems()` called `createHistoryItem()` for the whole array, and
  `createHistoryItem()` unconditionally used `Date.now()`. All entries created
  in the same synchronous batch therefore received the same value.
- Resume treated `uiHistory` as authoritative but did not use the canonical
  messages' per-message timestamps to repair older timestamp-less snapshots.

#### Resolution

- UI history records and creatable items now carry an optional, validated epoch
  timestamp. Live-to-durable conversion, text/tool-group serialization, JSON
  loading, restore, and bulk commit preserve it end to end.
- `createHistoryItem()` uses the supplied event time and only falls back to the
  current clock for genuinely new or invalid timestamp-less items.
- Legacy `uiHistory` is repaired on restore by stable round/order matching
  against canonical messages. This restores the distinct assistant times in
  session `20260718_105849`; sessions whose old canonical messages also lack a
  timestamp remain best-effort because their exact historical times cannot be
  reconstructed.
- Added regression coverage for distinct batch timestamps, durable round trips,
  legacy recovery, malformed persisted timestamps, and ambiguous suffixes.

#### Files

- `packages/agent/src/types.ts`
- `packages/repl/src/interactive/json-guards.ts`
- `packages/repl/src/ui/types.ts`
- `packages/repl/src/ui/contexts/UIStateContext.tsx`
- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/utils/message-utils.ts`
- `packages/repl/src/ui/utils/restore-history.ts`

#### Verification

- Relevant regression suite: 7 files, 173 tests passed.
- Full `npm run build` passed, including package TypeScript compilation, CLI/SDK
  bundles, and declaration bundles.
- Loading session `20260718_105849` through `FileSessionStorage` restored 32
  Assistant items with 32 distinct timestamps.

### 172: Daemon Runtime bypassed auto-mode guardrails and treated quoted source text as protected paths

- **Priority**: High
- **Status**: **Resolved** (v0.7.72-hotfix.0)
- **Introduced**: v0.7.64-v0.7.72-hotfix.0
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-17
- **Resolved**: 2026-07-18

#### Original Problem

KodaX Space ran a shared-daemon Coder Session with `permissionMode=auto` and
`autoModeEngine=llm`, but ordinary Bash-backed OCR/Python work repeatedly
created permission requests. The inspected Session
`s_d13b9f93...` / run `run_mroh9tzn_71aa4afb` contained 18 Bash calls, 15
permission prompts, and four five-minute permission timeouts. The request
events already carried the command and description in `inputPreview`, so the
repetition was not caused by the renderer losing the decision response.

Expected behavior: an explicit Runtime auto engine must classify each tool
call through the same auto-mode guardrail used by the REPL. Only a deliberate
guardrail escalation should enter the shared permission broker. Quoted Python
source, regular expressions, and other non-path arguments must not be treated
as protected filesystem paths.

#### Root Cause

- Runtime persisted `autoModeEngine` but never bootstrapped or installed an
  `AutoModeToolGuardrail`; its event-level fallback therefore applied the
  static permission policy before any LLM/rules classifier could decide.
- The legacy raw-command scan added every quoted string as a path. Python
  `-c` source and search expressions consequently reached protected/outside
  path checks as false path candidates.
- Relative candidates were resolved against the daemon process cwd instead of
  the run's execution cwd (with the project root kept as the security
  boundary), so daemon launch location could create additional false matches.
- Runtime runs exposed `exit_plan_mode` even when their host supplied no
  `exitPlanMode` approval callback. The tool first entered the generic
  permission broker and then failed as interactive-REPL-only.
- Permission previews truncated serialized JSON at an arbitrary character,
  producing invalid input for large writes and hiding the target/operation from
  downstream clients.

#### Resolution

- Runtime now bootstraps the selected `llm` or `rules` auto engine once per
  Session/root context, reuses the stateful tool guardrail across turns, and
  persists automatic fallback to `rules`. Session deletion and Runtime close
  release cached guardrail state.
- Managed-task now forwards Runtime guardrails into the real `Runner`. Runtime
  issues a one-shot decision receipt only after guardrail allow and requires an
  exact call-id/tool/input match before the permission hook can run; missing,
  changed, or replayed receipts fail closed.
- `tool_call` resolution is shared by the guardrail and dispatcher, so signals,
  Tier 0, projection, classification, permission, and execution all refer to
  the same concrete target. Only the guardrail's explicit `askUser` escalation
  enters the shared permission service, including with
  `permissionBroker=client`.
- `gitRoot` is now only the project security boundary, while relative command
  and file paths resolve from the run's separate `executionCwd`. Session
  metadata supplies both defaults when run options omit them, run-level
  overrides cannot widen the Session boundary, and both direct REPL surfaces
  pass their detected execution directory into auto-mode.
- Command argument roles distinguish inline Python/regex/program text from file
  operands and path-valued flags, including attached forms. Ordinary-prefix
  traversal remains a path candidate, while nested source literals do not.
- Runtime rejects a caller-supplied duplicate auto-mode guardrail when it owns
  explicit auto mode.
- Runtime removes `exit_plan_mode` from the model-visible tool set unless the
  caller supplied its approval callback, while preserving caller exclusions.
- Permission previews now remain valid bounded JSON, redact credential-bearing
  keys and inline shell secrets, fall back to a compact command/path summary,
  carry the effective execution directory, and normalize caller-supplied
  previews through the same registry boundary. The daemon accepts legacy large
  preview inputs for Runtime normalization but keeps observable response
  previews capped at 8192 characters.

#### Files Changed

- `src/sdk-runtime.ts`
- `src/runtime-daemon/schema.ts`
- `src/runtime-daemon/schema.test.ts`
- `src/sdk-runtime.test.ts`
- `packages/coding/src/agent-runtime/tool-dispatch.ts`
- `packages/coding/src/guardrails/auto-mode/absolute-denylist.ts`
- `packages/coding/src/guardrails/auto-mode/file-signals.test.ts`
- `packages/coding/src/guardrails/auto-mode/file-signals.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.ts`
- `packages/coding/src/guardrails/auto-mode/guardrail.test.ts`
- `packages/coding/src/guardrails/auto-mode/signals.test.ts`
- `packages/coding/src/guardrails/auto-mode/signals.ts`
- `packages/coding/src/task-engine/runner-driven.ts`
- `packages/coding/src/task-engine/runner-driven.test.ts`
- `packages/coding/src/tools/tool-bridge.ts`
- `packages/coding/src/tools/index.ts`
- `packages/coding/src/index.ts`
- `packages/repl/src/index.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.ts`
- `packages/repl/src/interactive/auto-mode-bootstrap.test.ts`
- `packages/repl/src/interactive/repl.ts`
- `packages/repl/src/permission/permission.ts`
- `packages/repl/src/permission/permission.test.ts`
- `packages/repl/src/permission/repl-bash-signals.test.ts`
- `packages/repl/src/permission/repl-bash-signals.ts`
- `packages/repl/src/ui/InkREPL.tsx`
- `docs/KNOWN_ISSUES.md`

#### Tests Added

- Runtime explicit-auto regressions covering guardrail installation, actual
  Runner execution order, managed-task propagation, exact concrete-call
  receipts, replay/mutation rejection, broker escalation, Session reuse/cache
  release, client-broker and host-hook compatibility, queued-turn fallback,
  duplicate rejection, Session-derived path context, and execution cwd.
- Runtime tool-exposure regression covering both the no-callback exclusion and
  the explicitly wired `exitPlanMode` path.
- Quoted/nested Python source, regex/program source and option-value roles,
  attached source/path flags, Windows paths with spaces, ordinary-prefix
  traversal, and project-root/execution-cwd path-resolution regressions.
- Large-write and caller-supplied preview regressions proving bounded,
  credential-redacted, valid JSON with an effective execution directory.
- Daemon schema validation for the `executionCwd` permission field, legacy
  oversized input compatibility, and the 8192-character response ceiling.

#### Verification

- `npm run build` passed, including package type-check, SDK/CLI bundles, worker
  sidecars, and declaration bundles; `git diff --check` passed.
- Full Runtime SDK suite passed 80/80, including real daemon lifecycle tests.
- Permission, auto-mode, managed Runner, bridge contract, bootstrap, and daemon
  schema suites passed 572 tests, with one platform-dependent skip and two
  existing todos.

### 171: Verified Ark Coding image inputs were rejected before provider dispatch

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.57
- **Fixed**: v0.7.72-hotfix.0
- **Created**: 2026-07-17
- **Resolved**: 2026-07-17

#### Original Problem

KodaX SDK 0.7.71 reported image input as unsupported for all five documented
Ark Coding image routes and `validateInputArtifactsForModel()` therefore
raised `MODEL_INPUT_UNSUPPORTED` before requests reached the provider. The
affected models were `doubao-seed-2.0-code`, `doubao-seed-2.0-pro`,
`kimi-k2.7-code`, `kimi-k2.6`, and `MiniMax-M3`.

Live probes against the Ark Coding Anthropic-compatible endpoint confirmed
that every exact route accepts a base64 16×16 PNG content block and returns a
normal response. The SDK capability results were therefore false negatives.

#### Root Cause

The source-backed native-media allowlist omitted the separately routed Ark
Coding provider/model pairs. Negative tests encoded some of those omissions as
intended behavior even though the shared Anthropic provider serializer already
preserved image blocks correctly.

#### Resolution

Added only the five normalized `ark-coding/<model>` pairs listed above to the
source-backed image route set. No provider-wide Ark Coding capability or video
capability was enabled; unlisted Ark models remain unsupported until
independently verified.

#### Files Changed

- `packages/agent/src/media/capabilities.ts`
- `packages/agent/src/media/capabilities.test.ts`
- `packages/agent/src/media/validation.test.ts`
- `packages/coding/src/media/capabilities.test.ts`
- `packages/coding/src/media/validation.test.ts`
- `packages/llm/src/providers/anthropic-message-serialization.test.ts`
- `packages/llm/src/providers/ark-coding-image-routes.integration.test.ts`
- `docs/KNOWN_ISSUES.md`

#### Tests Added / Verification Coverage

- Capability tests require image support and video rejection for all five exact
  routes while preserving fail-closed results for nearby unverified routes.
- Validation tests require image artifacts to pass for the exact route through
  both the Agent owner package and the Coding compatibility surface.
- Provider serialization coverage binds all five models to their exact wire ids
  and verifies an Anthropic base64 image content block reaches each final
  request payload.
- An opt-in real-gateway integration smoke sends one bounded 16×16 PNG request
  per route, runs sequentially, and preserves raw responses under the OS temp
  directory. All five live probes completed successfully before release.

### 170: A2A realm-key upgrade hid durable tasks and global admission serialized slow preparation

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.71
- **Fixed**: v0.7.71
- **Created**: 2026-07-17
- **Resolved**: 2026-07-17

#### Original Problem

The v0.7.71 authority hardening changed durable inbound task ownership from
`SHA-256(subject + NUL + tenant)` to a canonical
`SHA-256([securityRealm, subject, tenant])` tuple. This correctly prevented an
authentication-authority switch from adopting another authority's tasks, but
the file store retained only the opaque hash and provided no explicit upgrade
path. After an upgrade, a known v0.7.70 owner could therefore no longer get,
subscribe to, cancel, or deduplicate its retained tasks. Recovery could still
finish an in-flight Runtime run, leaving its result inaccessible to that
client.

The same review found that the global `SendMessage` admission tail remained
held across workspace preparation, Runtime session creation, and run startup.
A slow principal could consequently head-of-line block unrelated principals
even when the server had more than one available concurrency slot.

#### Root Cause

Durable task records had no principal-key scheme marker, and the security fix
intentionally avoided unsafe automatic legacy fallback without replacing it
with an operator-supplied offline rekey. Admission fixed the cross-principal
check-then-act race with a promise mutex, but its protected operation was the
whole asynchronous preparation path rather than only capacity reservation.

#### Resolution

New task records carry the non-secret `realm-subject-tenant-v1` key-scheme
marker. Pre-realm records remain fail-closed by default; KodaX never guesses an
authority and never dual-reads the legacy key during normal RPC handling. With
the server stopped, `kodax a2a migrate-tasks` performs a byte-preserving dry
run, while `--apply --confirm-server-stopped` atomically rekeys only the exact
configured Bearer owner. OAuth requires an explicit `--subject`. The public
`migrateA2ALegacyTaskOwners()` SDK accepts one or more explicit
subject/tenant/realm mappings for custom hosts. Ambiguous mappings, unknown key
schemes, and a live store owner fail closed; unmatched records are preserved.

Global capacity now uses a synchronous pending-admission reservation. The
active-count check and increment contain no `await`, so JavaScript's run-to-
completion turn closes the race without a global asynchronous lock. The
reservation becomes a persisted submitted task before it is released, and a
`finally` path releases it when preparation fails. Per-principal ordering and
deduplication remain unchanged, while cross-principal workspace/session/run I/O
proceeds concurrently up to the configured capacity.

#### Files Changed

- `src/a2a/principal-key.ts`
- `src/a2a/task-migration.ts`
- `src/a2a/task-store.ts`
- `src/a2a/server.ts`
- `src/a2a/index.ts`
- `src/integration-cli.ts`
- `src/a2a/task-migration.test.ts`
- `src/a2a/a2a.test.ts`
- `src/integration-cli.test.ts`
- `src/sdk-a2a.test.ts`

#### Tests Added / Verification Coverage

- Offline-migration tests cover byte-preserving dry-run, atomic exact rekey,
  current-key marker backfill, unmatched retention, idempotency, ambiguous
  mappings, and live-store exclusion.
- End-to-end server coverage proves a pre-realm task is inaccessible before
  migration, becomes accessible afterward, and a retried message remains
  deduplicated to the original task.
- Admission regressions prove a full single-slot server rejects another
  principal without waiting for slow preparation, two slots prepare
  concurrently, a third is rejected, and failed preparation releases its
  reservation.
- CLI and SDK-surface tests cover dry-run/apply confirmation and the public
  migration API.

### 169: Executor shutdown and daemon auto-start could wait indefinitely or leak startup children

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.67-v0.7.71
- **Fixed**: v0.7.71
- **Created**: 2026-07-17
- **Resolved**: 2026-07-17

#### Original Problem

A post-release review found that `AgentExecutorPlane.close()` waited without an
upper bound for admitted operations, custom executor disposal, and event-pump
exit. A custom executor returning a never-settling promise could therefore hang
host shutdown indefinitely. Registration upsert/removal also awaited obsolete
executor disposal while holding the global registration mutation lane, so one
slow disposer could freeze unrelated registration changes. The in-memory map
of every seen `(agentId, configurationRevision)` retained complete cloned
registrations forever in a long-running daemon.

Runtime daemon auto-start polled health for up to 60 seconds without observing
the spawned child's exit. An immediately failing child therefore produced a
full timeout, while a child still running after timeout or an ownership race
was detached without deterministic reclamation. The same review identified
duplicate release builds and uncached Electron smoke dependencies. Its claim
that `.electron-smoke/` currently appeared as hundreds of megabytes of
untracked Git content was not reproducible because the contents were already
covered by `node_modules/`, but the toolchain root was not explicitly ignored.

#### Context

The executor plane must still drain normal short operations and wait for event
iterators; the fix cannot turn close into immediate best-effort disposal.
Revision immutability must remain exact for the current registration and every
route retained by a non-terminal durable task. Daemon cleanup must target only
the child spawned by the current acquisition attempt, never kill a healthy
unrelated owner, and must preserve the intended long-lived detached daemon once
that exact child publishes healthy state.

The review's three SDK compatibility items were intentional v0.7.71
strictness, not regressions: `AgentRegistrationService.setEnabled` is required,
executor configuration/reference metadata is JSON-safe, and omitted SDK
`homeDir` follows `KODAX_HOME`. They required explicit migration notes rather
than behavioral rollback.

#### Root Cause

Close implemented complete drainage but had no deadline around the aggregate
operation. Registration mutation and resource cleanup shared one async critical
section. Revision-reuse protection stored full registrations with no retention
policy. Daemon spawning discarded the live child handle immediately after the
`spawn` event and waited only on filesystem/socket health observations.
Release jobs composed two scripts that each performed the full TypeScript and
bundle build, and Electron's version-pinned toolchain was reinstalled on every
Windows job.

#### Resolution

Executor close now uses one idempotent overall deadline with a 30-second default
and optional positive finite `closeTimeoutMs`; timeout rejects visibly while
the already-admitted cleanup may still finish in the background. Registration
persistence/publication remains serialized, but obsolete-executor collection
is awaited only after releasing that lane. Revision history stores canonical
SHA-256 execution fingerprints and retains at most 4,096 recent tombstones;
current registration and durable task-snapshot checks remain independent and
exact even after an old unreferenced tombstone is evicted.

Daemon auto-start retains a process handle and races every health poll/delay
against child exit. Early exit reports its code or signal immediately. Timeout,
identity mismatch, and other startup failure terminate the exact spawned child,
escalate to forced termination if needed, and surface an aggregate cleanup
error rather than silently orphaning it. The child is unreferenced only after
its own PID publishes healthy state; if another daemon wins, the spawned child
is reclaimed before attaching to the winner. A candidate that exits after
observing a different owner PID is treated as having relinquished the race, so
its SDK caller continues waiting for that owner to become healthy; an exit with
no competing owner still fails immediately.

Release jobs now run `npm run build` once, execute the Electron smoke directly,
and package with `--skip-tsc`. CI and release cache the exact Electron 42.5.0 /
electron-builder 25.1.8 toolchain, and `.electron-smoke/` is explicitly ignored.
The v0.7.71 changelog now calls out all three intentional SDK compatibility
changes and their migration paths.

#### Files Changed

- `packages/agent/src/external-agents/executor-plane.ts`
- `packages/agent/src/external-agents/executor-plane.test.ts`
- `packages/agent/src/external-agents/types.ts`
- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/process.test.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `tests/release-workflow.test.ts`
- `.gitignore`
- `CHANGELOG.md`

#### Tests Added / Verification Coverage

- Executor regressions prove the close deadline, registration-lane release
  before slow disposal, bounded history eviction, and retained recent revision
  reuse rejection while preserving the existing full-drain tests.
- Daemon regressions prove immediate exit-code reporting, timeout cleanup,
  delayed unref until the spawned PID is healthy, and cleanup when another PID
  wins startup.
- Workflow regressions parse both YAML files and require one release build,
  `--skip-tsc` packaging, direct Electron smoke execution, cache keys/paths, and
  install-on-cache-miss conditions.

### 168: A2A post-closure review found executor shutdown, daemon ownership, and server admission gaps

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.69
- **Fixed**: v0.7.71
- **Created**: 2026-07-16
- **Resolved**: 2026-07-16

#### Original Problem

The final upstream/downstream A2A review found several independent paths where
the implementation could violate its documented safety or usability contract.
Executor start/input/cancel/reconcile work could race shutdown or executor
disposal; an arbitrary `KODAX_HOME` could resolve to different daemon/config
identities and a daemon could publish ready before initial A2A reconciliation.
An older healthy daemon could also remain on last-known-good registrations
after a successful-looking config mutation.

Protocol edges were inconsistent as well. Configured document Agents had no
usable artifact-reference policy even though the SDK correctly defaulted
materialization to deny, while unsupported required Agent Card extensions could
be registered as if supported. `a2a add --allow-private` could persist a target
that automatic Runtime activation would always reject. Inbound starts from
different principals were not globally atomic, Runtime replay/subscription had
event-loss windows, request authentication happened after bounded body
allocation, media checks accepted substring lookalikes, server close could
overtake admitted handlers, and SSE subscribers had no aggregate or byte queue
ceiling.

#### Context

- A2A remains the general Agent protocol; these fixes must not introduce ACP,
  a gateway, an extension registry, an artifact downloader, or unrestricted
  private-network discovery.
- F258 owns protocol-neutral executor durability/lifecycle. F267 owns A2A wire
  semantics. F268 owns declarative A2A v2 config and activation. F269 owns the
  shared-daemon capability/ownership boundary.
- Legal presentation/document Parts can approach the 16 MiB inbound Part limit
  and expand under base64/JSON/SSE framing, so discovery limits and task-response
  limits cannot be one value.

#### Root Cause

Lifecycle accounting covered cached executor ownership but did not treat every
admitted task mutation and event iterator as a close-drained lease. Daemon paths
were partly derived from a CLI-style home and partly from the resolved config
home; readiness and config mutation lacked a complete capability/reconciliation
barrier. A2A Card extensions and configured artifact references were parsed but
not closed at the discovery/host-policy boundaries.

Inbound task admission used narrower principal lanes without one short global
reservation transaction. Runtime recovery replayed before subscribing, and
HTTP lifecycle accounting stopped before all response/handler work had drained.
The stream producer enqueued without per-task/global admission or a
byte-measured slow-consumer budget. Media validation used substring matching,
and authentication was coupled to the already-parsed RPC body.

#### Resolution

The executor plane now serializes each task's mutating operations, leases every
executor operation, shares one idempotent close promise, rejects new admission
after the close fence, drains admitted writes/starts/short operations, aborts
owned streams, waits for iterators, and disposes once. Captured inputs,
executor config, and reference metadata are JSON-safe; durable registration,
task, directory, task-ID, and event-sequence conflicts fail closed; persistence
precedes in-memory publication.

Daemon startup and mutation use the exact resolved config home, persist that
identity, reconcile A2A before ready, and require every healthy target owner to
advertise both `externalAgentAdmin: 1` and the independent
`a2aConfigReconciler: 1`. The daemon strips A2A ownership fields from arbitrary
capability overrides and derives them from installed owner state, so a client or
embedder cannot forge config-reconciler ownership. Non-empty A2A v1 files
require the explicit stopped-owner migration; v2 migration is an idempotent
read-only no-op. Failed initial reconciliation closes the Runtime/controller
before ownership release.

Agent Card extensions are validated and any unsupported required extension
rejects discovery. Configured A2A Runtime wiring admits only bounded A2A-
provenance `data:`/HTTP(S) references and never downloads remote URLs; the
general SDK remains default-deny. Direct `kodax a2a call` now uses the same
restricted reference-only policy. Its task RPC/SSE response budget is 32 MiB,
while Card/interface/OAuth/security metadata remains under the 2 MiB CLI network
budget. The non-persistent private-network override was removed from `a2a add`;
explicit one-shot test/call and SDK policies retain their deliberate operator
boundary. Public `@kodax-ai/kodax/a2a` configuration exports are limited to
parse/read/inspect/classify helpers; raw migration and mutation writers remain
inside the capability-fenced CLI owner.

Inbound authentication now requires a non-empty stable `securityRealm`, and the
task owner key is the SHA-256 of the canonical `(securityRealm, subject, tenant)`
tuple. Built-in Bearer derives its realm from the token environment-variable
name; built-in OAuth derives it from the exact validated issuer. Secret/JWKS
rotation within one realm and same-realm restart preserve realm-aware task
access. Changing authority cannot inherit tasks by reusing a subject, custom SDK
authentication without a realm fails at server creation/hot update, and
pre-realm persisted task records are not heuristically adopted.

Inbound `SendMessage` now uses one short global dedup/limit/reservation critical
section while retaining per-principal ordering outside Runtime execution.
Runtime attachment subscribes first, buffers live events, merges durable replay
by sequence, and then switches live. Authentication occurs before reading the
bounded request body; authorization remains method/scope specific afterward.
JSON/SSE media types are matched exactly. Close rejects new work and awaits
preparation plus admitted handler tails before resources close. SSE is capped at
four streams per task, eight per server, and 24 MiB encoded queue bytes per
stream; overflow or disconnect closes only that stream and releases its slot.
Configured task responses use a separate 32 MiB limit while Card/OAuth/JWKS
traffic retains its smaller safe-network ceiling.

#### Files Changed

- `packages/agent/src/external-agents/executor-plane.ts`
- `packages/agent/src/external-agents/memory-store.ts`
- `packages/agent/src/external-agents/types.ts`
- `src/runtime-agent-store.ts`
- `src/a2a/client-executor.ts`
- `src/a2a/index.ts`
- `src/a2a/product.ts`
- `src/a2a/schemas.ts`
- `src/a2a/server.ts`
- `src/a2a/server-auth.ts`
- `src/a2a/types.ts`
- `src/a2a/config.ts`
- `src/a2a/runtime-config.ts`
- `src/sdk-a2a.ts`
- `src/integration-cli.ts`
- `src/runtime-daemon/state.ts`
- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/manager.ts`
- `src/runtime-daemon/host.ts`
- `src/runtime-daemon/server.ts`
- `src/sdk-runtime.ts`

#### Tests Added / Verification Coverage

- Executor/store regressions cover concurrent close callers, admitted
  registration/task writes, in-flight start/cancel/reconcile, event iterator
  drain, invalid JSON capture, persistence failure, duplicate durable IDs,
  directory hashes, and strict event task/sequence identity.
- Daemon/config regressions cover arbitrary `KODAX_HOME`, explicit `homeDir`,
  multi-profile ownership, capability refusal, readiness fencing, stopped-owner
  v1 migration, idempotent v2 migration, initial-reconcile cleanup, the
  independent `a2aConfigReconciler` requirement, and rejection of forged A2A
  ownership capability overrides.
- A2A protocol regressions cover required/optional Card extensions, configured
  inline/remote artifact references without fetch, exact JSON/SSE media types,
  authentication-before-body, cross-principal admission, subscribe-first replay,
  admitted-handler close drain, per-task/global stream caps, HTTP disconnect,
  slow-consumer isolation, and near-limit presentation artifacts.
- Authentication regressions cover issuer hot switch, Bearer-to-OAuth authority
  change, same-realm/same-`dataDir` restart, secret/JWKS rotation, pre-realm task
  isolation, and missing custom-auth `securityRealm` at creation and hot update.
- CLI coverage rejects the removed non-persistent `a2a add --allow-private`
  path, proves direct-call reference-only/no-fetch behavior, and keeps task
  responses at 32 MiB while rejecting oversized metadata at 2 MiB.
- SDK-surface coverage proves public `/a2a` exposes read-only config helpers but
  not raw writer/migration functions. Final server-boundary coverage pins the
  global admission reservation, subscribe-first replay, authentication-before-
  body, exact media matching, close drain, and 4/8/24 MiB SSE contract.

### 167: A2A OAuth and hot-activation closure could leak credentials or mutate stale registrations

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.69
- **Fixed**: v0.7.71
- **Created**: 2026-07-16
- **Resolved**: 2026-07-16

#### Original Problem

The standards-aligned OAuth closure and per-Agent hot activation review found
several security and authority gaps. Rotated bearer tokens reflected by a slow
remote response could outlive the bounded redaction history; direct SDK callers
could bypass the integration-file OAuth URL validation; an authority-changing
refresh could leave an old registration dispatchable after discovery failure;
and a config reconciler could disable or remove a same-ID SDK replacement
between its list and mutation operations.

#### Context

- KodaX is the OAuth client for outbound A2A calls and a resource server for
  inbound calls; token issuance remains the responsibility of an external
  Authorization Server.
- `enabled` is desired configuration. The Runtime owner applies it to the
  durable registration plane and must fence new dispatch before replacing
  credentials, endpoints, or effects.
- Disabling a registration must preserve its complete executor payload so an
  already-admitted durable task can still resume.
- Config-owned registrations coexist with registrations created directly by
  SDK embedders.

#### Root Cause

Token redaction remembered only a small number of recently used values without
retaining the credential used by every in-flight JSON-RPC attempt. OAuth URL
checks lived primarily in the config parser instead of the public auth
factories. Config reconciliation inferred ownership from a revision marker and
performed list-then-mutate operations by Agent ID without a mutation-time
revision condition. Its original disabled fence also reconstructed a partial
registration from a summary, dropping durable executor details.

#### Resolution

Each ordinary RPC attempt and SSE stream now retains its exact Authorization
value through response parsing and redaction, then releases it in `finally`;
successful messages, tasks, artifacts, streams, and errors are redacted. A
compare-and-clear retry prevents one 401 from invalidating a newer token.
Shared OAuth validators enforce issuer, token endpoint, JWKS endpoint, scope,
and resource syntax at config and direct-SDK boundaries while preserving exact
issuer comparison.

The registration plane now supports persistence-first, serialized mutations
conditioned on both the observed revision and management owner, plus an atomic
enabled mutation that preserves the full registration. Config reconciliation
records explicit management ownership, fences changed authority before
discovery, repairs live drift, leaves unrelated SDK registrations intact, and
performs independent Agent discovery in parallel. Disabling blocks new
admission without canceling an admitted task.

Before task admission the plane durably retains an internal immutable full
route snapshot. It validates that snapshot against the public task summary on
restart, keeps update/removed routes usable for input, cancellation, and
reconciliation, and garbage-collects only after terminal task persistence.
The snapshot is not exposed through task/daemon DTOs and contains references,
not resolved credentials. Same-revision execution-content reuse is rejected;
management owner, enabled state, and health remain independently mutable.

The final review also closed shared-plane races around this path. Global task
ID uniqueness is rechecked inside serialized admission; task state is
published to memory only after the durable write succeeds; terminal event
failure still settles waiters and releases snapshots; summaries are detached
from live registration objects; and executor cache keys use structured tuples
rather than delimiter concatenation. Reconciliation isolates per-entry owner
conflicts and observer failures and awaits every refresh it starts.

#### Files Changed

- `src/a2a/client-auth.ts`
- `src/a2a/client-executor.ts`
- `src/a2a/security.ts`
- `src/a2a/server-auth.ts`
- `src/a2a/config.ts`
- `src/a2a/runtime-config.ts`
- `packages/agent/src/external-agents/types.ts`
- `packages/agent/src/external-agents/executor-plane.ts`
- `src/runtime-daemon/protocol.ts`
- `src/runtime-daemon/schema.ts`
- `src/runtime-daemon/client.ts`
- `src/runtime-daemon/server.ts`

#### Verification

- OAuth tests cover client-credentials authentication, exact issuer/audience
  validation, scope and URL rejection, token caching/singleflight, concurrent
  401 recovery, and direct SDK construction.
- Redaction tests hold slow message/task/artifact responses across at least five
  token rotations and cover SSE lifecycle cleanup.
- Registration tests cover persistence failure, durable-task continuation,
  update/removal plus restart recovery, snapshot crash-window cleanup,
  revision-and-owner conflicts, live drift, fail-closed authority changes,
  parallel discovery, disabled zero-fetch behavior, and same-ID replacement
  races. Adversarial coverage also exercises cross-Agent/local task-ID
  collisions, caller mutation of returned/input objects, terminal event-store
  failure, per-entry owner isolation, observer failure, and delimiter-bearing
  cache identities.
- Runtime-daemon tests exercise the new conditional registration mutation path
  across its protocol boundary.

### 166: Electron daemon bootstrap mode leaks into user child processes

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.71 RC
- **Fixed**: v0.7.71
- **Created**: 2026-07-16
- **Resolved**: 2026-07-16

#### Original Problem

The packaged Electron daemon auto-start fix correctly starts the application
executable in Node mode, but leaves `ELECTRON_RUN_AS_NODE=1` in the long-lived
daemon environment. Bash, MCP, LSP, sandbox, and other external processes can
inherit that environment. A user command which launches an Electron program
may therefore start it in Node mode instead of its normal application mode.

#### Context

- The variable is needed only while the Electron executable bootstraps the
  daemon or another trusted internal Node entry.
- Deleting it only after daemon startup is insufficient unless trusted internal
  `process.execPath` launches retain a bounded Node bootstrap path.
- Electron's `RunAsNode` fuse may disable this mechanism and must be an explicit
  compatibility boundary.
- The real Windows packaged/asar smoke currently runs manually and is not a
  required CI or release gate.

#### Root Cause

`createRuntimeDaemonServeEnvironment()` adds `ELECTRON_RUN_AS_NODE=1` to the
daemon child environment, and the daemon retains that copied environment for
its full lifetime. No preload consumes the bootstrap-only variable before
Runtime initialization or user process spawning.

#### Proposed Solution

Introduce one internal Node launch contract which temporarily enables Electron
Node mode and prepends a bootstrap preload that removes the variable before the
target module executes. Use it for the daemon and every trusted internal
`process.execPath` child, while ordinary user process environments remain
clean. Extend the packaged Windows smoke to observe the daemon environment and
a daemon-spawned external child, document the fuse boundary, and require the
smoke in CI and release workflows.

#### Resolution

All trusted `process.execPath` children now use one internal launch contract.
For a packaged Electron executable it sets `ELECTRON_RUN_AS_NODE=1` only at the
OS exec boundary and prepends a Node import which deletes the variable before
the target entrypoint loads. Runtime startup also removes the variable as a
non-optional invariant. Ordinary Node launches keep their arguments unchanged,
and user Bash, MCP, native LSP, sandbox, and external child environments remain
clean.

Daemon auto-start, CLI daemon start, JavaScript LSP, Skill CLI, and sandbox
broker/interpreter entrypoints use the bounded contract. The public guide now
states that packaged auto-start requires Electron's default-enabled `RunAsNode`
fuse; a deliberately disabled fuse must use an ordinary Node/CLI daemon with
attach-only SDK mode, and packaged timeout diagnostics name that boundary.

The Windows Electron 42.5.0 + asar smoke now loads a daemon extension which
observes both daemon and daemon-spawned external-process environments. It is a
required Windows CI job and a release gate for the `win-x64` build.

#### Files Changed

- `packages/agent/src/runtime/process-hardening.ts`
- `packages/agent/src/runtime/process-hardening.test.ts`
- `packages/agent/src/index.ts`
- `packages/coding/src/lsp/spawn.ts`
- `packages/coding/src/lsp/spawn.test.ts`
- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/process.test.ts`
- `src/kodax_cli.ts`
- `src/sandbox-runtime.ts`
- `src/skill_cli.ts`
- `scripts/test-electron-daemon-smoke.mjs`
- `tests/fixtures/electron-daemon-smoke/main.cjs`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `docs/test-guides/ISSUE_166_v0.7.71_REGRESSION_GUIDE.md`

#### Verification

- Unit/process tests prove the bootstrap switch is consumed before target code,
  including when optional process hardening is disabled.
- Packaged Windows Electron 42.5.0 + asar smoke passed: daemon cold-started,
  Main ran once, daemon and external-child probes both reported the variable
  absent, Node attached to the same Runtime, detach semantics held, and two
  owner transitions completed.
- Full repository suite passed: 835 files and 10,007 tests, with only the
  repository's declared skips/todos remaining.
- Workspace TypeScript build, SDK bundle, declarations, and workflow YAML
  validation passed.

### 165: Packaged Electron auto-start relaunches the app instead of executing the daemon CLI

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.70
- **Fixed**: v0.7.71
- **Created**: 2026-07-16
- **Resolved**: 2026-07-16

#### Original Problem

In a Windows packaged Electron application using asar,
`connectKodaXRuntime({ autoStart: true })` timed out after the full daemon
startup budget on a fresh profile. Attaching to a daemon started beforehand by
ordinary Node worked, proving that transport, authentication, packaged CLI
files, and the shared Runtime were healthy. The packaged app could only start
the daemon when its child executable was explicitly placed in Electron's Node
execution mode. SDK embedders must not need to mutate their global environment,
resolve private CLI paths, or duplicate owner logic.

#### Context

- Reproduced on Windows 10 x64 with Electron 42.5.0 and asar packaging.
- Ordinary Node CLI/SDK auto-start is unaffected.
- `ConnectKodaXRuntimeOptions.homeDir` is also easy to confuse with
  `KODAX_HOME`: the option is the base directory that owns `.kodax`, while the
  environment variable points directly at the `.kodax` data directory.

#### Root Cause

The SDK spawned `process.execPath`. In Node this is the Node executable, but in
a packaged Electron Main process it is the packaged application executable.
The child inherited normal Electron application mode and therefore did not
execute the resolved daemon CLI entry as a Node script.

#### Proposed Solution

Enable Node execution mode only in the spawned daemon child when the host is
Electron, without mutating the parent environment. Preserve the existing Node
spawn path and daemon ownership semantics. Add focused environment tests,
Windows Electron/asar smoke coverage, and explicit public documentation for
`homeDir`, CLI `--home`, and `KODAX_HOME` path meanings.

#### Resolution

SDK auto-start now detects an Electron host and uses a bounded Node bootstrap
for the detached daemon child. The parent Electron environment is not mutated,
the bootstrap switch is removed before daemon code loads, and ordinary Node
launch behavior remains unchanged. The SDK also validates the resolved daemon
CLI sidecar before spawn, so an incorrectly bundled embedder fails immediately
with an actionable error instead of waiting for the startup timeout.

The public option comments and Embedder Guide now state that SDK `homeDir` and
CLI `--home` identify the base directory which owns `.kodax`, whereas
`KODAX_HOME` already identifies the `.kodax` data directory.

#### Files Changed

- `src/runtime-daemon/process.ts`
- `src/runtime-daemon/process.test.ts`
- `src/sdk-runtime.ts`
- `scripts/test-electron-daemon-smoke.mjs`
- `tests/fixtures/electron-daemon-smoke/`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `docs/test-guides/ISSUE_165_v0.7.71_REGRESSION_GUIDE.md`

#### Verification

- Packaged Windows Electron 42.5.0 + asar smoke: passed, including cold start,
  one GUI Main entry, same-runtime Node attach, logical `1 -> 2 -> 1` client
  convergence, detach-only close, and two daemon/inline owner transitions.
- Runtime daemon and process-distinct CLI regression: 156/156 passed.
- SDK Runtime facade/config regression: 69/69 passed.
- TypeScript `tsc --noEmit` and the publish bundle build passed.

### 164: MCP cross-language zero matches can force an avoidable second model/tool round

- **Priority**: High
- **Status**: **Resolved** (v0.7.70)
- **Introduced**: v0.7.70 RC
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.70

#### Original Problem

`mcp_search` used lexical matching only. A Chinese query against a provider whose
catalog metadata is English could therefore return a truthful but unhelpful zero
result even though the requested capability existed. The model then had to infer
that the query vocabulary was wrong and issue another search or inventory call.
This made progressive disclosure less accurate and could spend more tokens and
latency than returning a compact, exact recovery in the first result.

#### Context

The issue affects cross-language or vocabulary-mismatched searches, especially
large English MCP catalogs queried by Chinese users. Successful lexical searches
were already efficient and should not pay any permanent prompt text, embedding,
translation, or extra lookup cost. A fallback also must not expose an order-biased
prefix or exceed the physical tool-result capacity.

#### Root Cause

- Query tokenization split punctuation and whitespace but not compact CJK words.
- A non-empty zero result did not distinguish an actually empty filtered catalog
  from a query/catalog vocabulary mismatch.
- The search facade had no cost-admitted, lossless zero-match recovery path.

#### Resolution

- Added `Intl.Segmenter` word segmentation for CJK query tokens. This improves
  same-language CJK metadata matching without pretending to translate languages.
- On a non-empty zero match only, `mcp_search` reads the same filtered inventory
  through the already validated runtime snapshot. The MCP runtime reuses its
  in-memory live catalog unless a dirty signal invalidated it, so this adds no
  second model/tool round and no normal-path discovery work.
- When every exact id can be represented losslessly as a shared canonical prefix
  plus all suffixes, the tool returns that complete known-snapshot inventory only
  if it costs no more than a normal default eight-item search page and fits the
  current physical result capacity.
- If either admission check fails, the tool emits a compact catalog-language retry
  signal with no partial id list or cursor. A revision change between the zero
  result and recovery inventory fails closed with `MCP_CATALOG_CHANGED_RESTART`.
- No embeddings, model translation, bilingual dictionary, permanent language
  instruction, static byte threshold, or lossy artifact was added.
- A fully unavailable catalog is no longer mistaken for a lexical zero match,
  avoiding a duplicate discovery/connection attempt. Stale or mixed grouped
  recovery retains the affected server and bounded failure reason.

#### Files Changed

- `packages/agent/src/capabilities/mcp/catalog.ts`
- `packages/coding/src/tools/mcp-search.ts`
- Adjacent MCP catalog/tool tests and FEATURE_035 design/test documentation

#### Tests Added

- Compact CJK same-language ranking
- Successful-search single-pass invariant
- Lossless grouped zero-match recovery with preserved server/kind filters
- Dynamic normal-page and physical-capacity admission
- Revision-change fail-closed behavior and no order-biased oversized fallback
- Fully unavailable single-pass behavior and preserved grouped failure diagnostics
- Real local GitHub snapshot: 26/26 exact ids reconstructed; grouped recovery
  214 tokens versus 353 for literal inventory (39.4% reduction)

### 163: A2A review found endpoint trust, task lifecycle, artifact, and protocol gaps

- **Priority**: High
- **Status**: **Resolved** (v0.7.70)
- **Introduced**: v0.7.69
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.70

#### Original Problem

Post-fix review found that outbound discovery trusted an Agent Card's selected
interface without binding it to the trusted Card origin; the no-code Bearer
Card used a pre-1.0 authentication shape; recursive remote reads did not
revalidate every concrete file; `INPUT_REQUIRED` started another Runtime run
instead of answering the pending interaction; terminal records were never
pruned; and generated file artifacts were not returned over A2A. Additional
lifecycle and interoperability gaps left failed starts or subscriptions live,
accepted absent protocol versions as 1.0, ignored bounded history/list filters,
and failed to poll after a premature normal stream EOF.

#### Context

These defects affect configured outbound Agents, inbound no-code serving,
fixed workspaces, long-lived principals, interactive tasks, and the document or
presentation scenarios that motivated the general-Agent A2A surface. Existing
happy-path tests passed because they did not exercise these boundaries.

#### Root Cause

- Discovery validated the Card fetch and later endpoint independently instead
  of pinning the selected interface to the discovery trust decision.
- Remote read guardrails authorized only the requested search root, while the
  grep/glob handlers enumerated additional concrete paths internally.
- The server mapped Runtime state names but did not bridge Runtime interaction,
  artifact, pruning, or cleanup ownership into A2A task semantics.
- Product Card construction and several request fields were tested only against
  internal parsers rather than the frozen A2A 1.0 ProtoJSON contract.

#### Proposed Solution

Add boundary-first regression tests, then minimally bind selected interfaces to
the trusted origin and advertised Bearer scheme; revalidate concrete read paths;
bridge pending Runtime user input into the same task/run; prune only oldest
terminal records; publish explicitly staged run artifacts; close terminal
subscriptions and fail starts safely; and implement the missing bounded A2A 1.0
request/version/stream semantics. Avoid new storage engines, generic credential
frameworks, or public artifact hosting.

#### Resolution

- Bound Card-selected interfaces to the trusted discovery origin, required
  advertised A2A 1.0 Bearer security before credential use, completed private
  address classification, and preserved DNS-pinned transport behavior.
- Revalidated every concrete `read`/`grep`/`glob` path, propagated the read,
  tool, Skill, and Skill-script ceilings to child runs, and kept staged output
  paths inside the bound workspace.
- Resumed pending Runtime input on the original run, redacted private defaults
  and task paths, cleaned terminal subscriptions, failed start errors safely,
  and pruned only oldest terminal records.
- Added bounded history/list/version validation, accepted-output negotiation,
  explicit staged document artifacts, successful admitted Skill-script output
  promotion, streaming artifact updates, inline remote artifact authorization,
  and polling fallback after premature stream EOF. Declared-but-failed Skill
  outputs and ordinary workspace writes are never published implicitly.
- Restored authenticated SSE through the credential broker, validated JSON-RPC
  correlation and task/context scope, accumulated `artifactUpdate.append`
  chunks by artifact ID, preserved direct-Message file Parts, replaced offset
  pagination with the designed stable opaque task cursor, and supplied
  sanitized context/input modes to host authorization.
- Tightened Part/task forward-compatible parsing and optional-operation errors,
  kept successful tasks successful when a staged output disappears, and stopped
  treating an access-denied live-process probe as a stale Windows store lock.
- Kept the implementation on the existing file store, Runtime interaction
  service, artifact ledger, `.kodax-a2a-staging` broker, and ASRT promotion
  result; no task database, generic OAuth framework, or public artifact host was
  introduced.

#### Files Changed

- `src/a2a/{server,task-store,client-executor,safe-fetch,schemas,product}.ts`
- `src/runtime-agent-binding.ts`
- `packages/agent/src/session-lineage/compaction/file-tracker.ts`
- `packages/coding/src/{types,child-executor}.ts`
- `packages/coding/src/agent-runtime/tool-execution-context.ts`
- `packages/coding/src/tools/{read,grep,glob}.ts`
- Adjacent A2A, binding, tool, child-executor, CLI, and protocol tests

#### Tests Added

- Added regressions for same-origin endpoint trust, A2A 1.0 Bearer Card shape,
  mapped/private address handling, per-file read guards, child policy
  inheritance, input continuation, retention, cleanup, history/list validation,
  staged/Skill/direct/remote artifacts, failed Skill output, non-published
  ordinary writes, authenticated SSE, cross-task/mismatched JSON-RPC responses,
  appended artifact chunks, stable cursor pagination, authorization scope, lock
  ownership, redaction, failed starts, and early stream EOF.

### 162: A2A serve drops Runtime defaults and Markdown Agent provider

- **Priority**: High
- **Status**: **Resolved** (v0.7.70)
- **Introduced**: v0.7.69
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.70

#### Original Problem

`kodax a2a serve --provider zai-coding` could start listening but fail the
first inbound run with `runtime.runs.start requires input.options.provider or
runtime defaultProvider`. Declaring the same provider in the selected user
Markdown Agent did not help. The expected behavior is that an admitted local
Agent uses its explicit provider, while an Agent without one falls back through
the serving Runtime's CLI, environment, core config, and built-in defaults.

#### Context

The failure blocked both `runtime-default` and user Markdown Agent A2A serving
when no other provider happened to reach the Runtime. The same Commander option
ownership pattern could silently drop prefixed provider/model/reasoning options
from daemon, ACP, and Skill subcommands. It failed closed and did not expose
credentials or expand remote authority.

#### Root Cause

- Commander stored duplicated root/subcommand options on the root command,
  while affected actions read only their local option object.
- A root option before a subcommand bypassed the raw `argv[0]` early-return
  check and could fall through into the ordinary CLI after the subcommand.
- `a2a serve` did not run the normal environment/config/default Runtime
  provider and provider-compatible model selection.
- The Markdown loader supported model and effort but omitted the already
  supported `AgentContent.provider` field.
- Integration tests configured only a bare command and therefore did not
  reproduce the real root/subcommand collision.

#### Resolution

Affected actions now merge accepted global and local options explicitly, with
the selected command's values authoritative, without changing Commander's
existing option-position compatibility. Parsed command identity, rather than
raw argument position, prevents subcommand fallthrough. `a2a serve` now applies
the same CLI/environment/config/default provider precedence and model-provider
compatibility rule as other hosted Runtime entry points. Markdown Agent
`provider` is trimmed, validated, admitted, discoverable, and passed to local
Runtime runs; remote requests still cannot override provider or model.

#### Files Changed

- `src/cli_option_helpers.ts`
- `src/kodax_cli.ts`
- `src/integration-cli.ts`
- `packages/coding/src/construction/markdown-loader.ts`
- Related CLI, integration, Markdown loader, and Runtime binding tests

#### Tests Added

- Root/subcommand duplicate option positions and subcommand fallthrough
- A2A CLI, environment, config, model compatibility, and override precedence
- Markdown provider pass-through, discovery, validation, and Runtime binding

### 161: MCP complete discovery can exceed result capacity or trust malformed pagination/cache state

- **Priority**: High
- **Status**: **Resolved** (v0.7.70)
- **Introduced**: v0.7.70 RC
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.70

#### Original Problem

The progressive MCP catalog implementation can return a page larger than the
reported `toolResultCapacityTokens` when even one rendered capability does not
fit. At the provider boundary, structurally invalid cache files can prevent a
healthy live server from recovering, and invalid or cyclic MCP list pagination
can be accepted as complete or can keep discovery paging indefinitely.

#### Context

These failures affect `mcp_search` inventory/search results, first-use live
catalog validation, stale-cache fallback, and any MCP server whose list results
are paginated. They violate the feature's complete-or-explicitly-incomplete and
capacity-bounded contracts.

#### Root Cause

- Capacity fitting returned the one-item candidate without checking whether it
  actually fit.
- Cache loading trusted TypeScript casts instead of validating the two persisted
  catalog files as one coherent snapshot.
- MCP list parsing treated malformed payloads as empty lists and did not reject
  repeated cursors or duplicate capabilities across pages.
- A successful live refresh was marked stale when only optional cache
  persistence failed.

#### Proposed Solution

Reject or explicitly report an unrenderable page without consuming an item;
validate cache structure and cross-file consistency; fail boundedly on malformed
or cyclic pagination while deduplicating stable capability ids; and keep live
catalog truth independent from best-effort cache persistence.

#### Resolution

Capacity fitting now returns a bounded no-consumption marker when even one item
cannot fit, and reports context exhaustion rather than an oversized item when
an empty result's metadata cannot fit. Search ranking uses complete-token
coverage as a dominant sort key.
List parsing rejects malformed containers, entries, identifiers, resource URIs,
explicit null or repeated cursors while deduplicating ids across pages. A
`list_changed` notification received during pagination invalidates the in-flight
transaction instead of being overwritten by its result. Concurrent first-use
discovery calls share one refresh, and kind-filtered cursors use a revision scoped
to that filtered catalog. Cache reads validate
both files as one coherent snapshot, so corrupt state falls through to live
recovery. Live discovery remains complete when only best-effort cache
persistence fails; the error is emitted and retained in diagnostics. Inventory
and ranked results both mark provider data as untrusted.

#### Files Changed

- `packages/agent/src/capabilities/mcp/catalog.ts`
- `packages/agent/src/capabilities/mcp/runtime.ts`
- `packages/agent/src/capabilities/mcp/catalog.test.ts`
- `packages/agent/src/capabilities/mcp/runtime.test.ts`
- `packages/agent/src/capabilities/mcp/provider.test.ts`
- `packages/coding/src/tools/mcp-search.ts`
- `packages/coding/src/tools/mcp-tools.test.ts`
- `docs/features/v0.8.5.md`
- `docs/test-guides/FEATURE_035_v0.7.70_TEST_GUIDE.md`

#### Tests Added

- Single-item capacity overflow, empty-result exhaustion, and no-consumption behavior.
- Long-query complete-token ranking dominance.
- Malformed list shape/entry/id/URI rejection, repeated-cursor rejection, and
  explicit-null cursor rejection, cross-page id deduplication, and in-flight
  `list_changed` invalidation.
- Corrupt-cache live recovery and cache-write-failure live truth.
- Concurrent discovery coalescing and kind-scoped catalog revisions.
- Untrusted-data labeling on inventory output.

### 160: Shared-daemon rollback omits reverse-bridge mutations and daemon-owned background work

- **Priority**: High
- **Status**: **Resolved** (v0.7.70)
- **Introduced**: v0.7.70 RC
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.70

#### Original Problem

The revisioned daemon-to-inline rollback fence did not classify credential and
Host Tool register/revoke/completion requests as draining-sensitive mutations.
Those requests could still alter reverse-bridge state after rollback draining
began. Stop preflight also ignored non-terminal Workflow and External Agent
tasks, so `canStop` could be true while daemon-owned background work remained.

#### Root Cause

The protocol mutation classifier was reused as the management draining fence
but omitted reverse-bridge control methods. Runtime preflight projected only
ordinary runs and pending interactions, while management revision observed
ordinary Runtime events rather than every daemon-owned background lifecycle.

#### Proposed Solution

Fence all reverse-bridge state changes without persisting credentials, expose
active Workflow and AgentTask state in typed preflight, fail closed on active or
uncertain work, and make rollback CAS observe background lifecycle changes.
Add race tests that mutate each state after inspection and require `conflict`.

#### Resolution

Reverse-bridge register/revoke/supply/completion requests now use a dedicated
draining-sensitive classifier. This keeps them inside the atomic stop fence
without adding credential or Host Tool result frames to the durable operation
journal. Typed preflight now exposes active Workflows and AgentTasks, treats
unknown/future non-terminal states conservatively, and reports dedicated
blockers. Management fingerprints each authoritative preflight projection, so
background lifecycle changes advance the rollback revision even when they do
not emit a normal Runtime event.

#### Files Changed

- `src/runtime-daemon/protocol.ts`
- `src/runtime-daemon/server.ts`
- `src/runtime-daemon/management.ts`
- `src/sdk-runtime.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`
- `docs/features/v0.7.70.md`
- `docs/test-guides/ISSUE_F269_v0.7.70_REGRESSION_GUIDE.md`

#### Tests Added

- All six credential/Host Tool state-changing methods are rejected by the
  management fence during draining while remaining outside durable operations.
- Running/paused Workflow and non-terminal/unknown AgentTask states block stop
  and clear only after reaching terminal states.
- A background lifecycle change after management inspection advances revision
  and rejects the stale rollback without changing owner policy.

### 159: Windows process cleanup can lose descendants when `taskkill /t` fails under load

- **Priority**: High
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.67
- **Created**: 2026-07-15
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.69

#### Original Problem

Windows subprocess cleanup treated completion of `taskkill /t` as if the tree
had been terminated, even when the command timed out or exited non-zero. The
fallback then depended on CIM/WMIC parent queries, which can themselves fail
under the same management-service load. A surviving descendant could therefore
outlive its direct parent and accumulate across release-test runs.

#### Root Cause

The helper discarded the `taskkill` exit status and had no native parent graph
that was independent of Windows management services. The agent runtime and LLM
CLI-event copies repeated the same assumption.

#### Resolution

`taskkill` now reports success explicitly. When it does not finish successfully,
cleanup captures the process parent graph with Toolhelp32 through a bounded,
non-interactive PowerShell helper before directly terminating the root. The
existing CIM/WMIC path remains a compatibility fallback only. Descendants are
then terminated leaf-first and the helper waits for the complete target set.
Both production copies use the same escalation contract.

#### Files Changed

- `packages/agent/src/runtime/process-tree.ts`
- `packages/agent/src/runtime/process-tree.test.ts`
- `packages/llm/src/cli-events/process-tree.ts`
- `docs/test-guides/ISSUE_159_v0.7.69_REGRESSION_GUIDE.md`

#### Tests Added

- A Windows-only integration regression starts a real parent and nested Node
  child, invokes process-tree cleanup, and verifies the descendant exits.

### 158: Post-hoc output/history loss hides evidence and can increase end-to-end token use

- **Priority**: High
- **Status**: **Resolved** (reopened and corrected after implementation review)
- **Introduced**: v0.7.61
- **Created**: 2026-07-14
- **Resolved**: 2026-07-15
- **Fixed**: v0.7.69

#### Original Problem

FEATURE_251 applied command-aware lossy filters and fixed per-tool truncation
before the model's next request. In a real `git log --stat` review, the Worker
received a compressed result, announced that it needed to read the raw artifact,
and performed that recovery read. The intended one-round token saving therefore
added a second tool-result cycle, while the first response no longer contained
all decision-relevant evidence. A separate malformed `git log --format` command
was also rerun in the trace, but that rerun is not attributed to compression.

The same failure mode existed beyond Bash: fixed caps or shortened fields in
`grep`, `glob`, `code_search`, retrieval rendering, long-line `read`, completed
`task_output`, and independently guarded SA/AMA dispatch paths could omit data
before the system knew whether the complete result fit the real context window.
The old 32 KiB / 600-line threshold was an empirical preview size, not a valid
model-capacity boundary.

The audit found the same policy error in history compaction. Default
microcompaction could clear ordinary tool results below physical capacity, and
the semantic compactor could prune tool results or crop user messages before
asking the summary model. Static trigger/target percentages ignored the final
provider system prompt, tool schema, output reserve, and fixed request overhead.
Those operations could discard exact evidence when the next request still fit.

#### Root Cause

- A local `never_worse` comparison optimized only the current string; it did
  not price recovery calls, an extra inference round, or evidence loss.
- Bash semantic filters ran transparently after execution, so the model could
  not choose a task-preserving projection before producing the data.
- Multiple layers owned truncation independently: Bash, retrieval helpers,
  bridge dispatch, and the AMA Runner. Their fixed byte/line caps ignored the
  aggregate tool-result batch and the physical next-request capacity.
- History compaction treated a percentage of the advertised context window as
  the decision boundary and used destructive pre-summary/fallback pruning. It
  did not stop as soon as the final physical provider request fit.
- The 512 KiB Bash capture constant was an irreversible tail cap rather than a
  memory-to-disk transition. Long lines also lacked an exact continuation
  coordinate.
- Anthropic cache-read/write tokens were included in total input and then
  charged again, distorting the cost signal used to assess the optimization.

#### Evidence

The evidence is one captured production-shaped review, not a population
benchmark:

- Session: `C:\Users\iceto\.kodax\sessions\c-works-gitworks-kodax-author-kodax-66910f2fd8\20260714_174750.jsonl`
- Raw artifact: `C:\Users\iceto\.kodax\tool-results\2026-07-14T09-52-03-904Z-KodaX-bash-output-raw-6qsktp.txt`

The first `git log v0.7.68..HEAD --oneline --stat` result was replaced with
`[git log summarized: showing 30 of 207 lines]`. The Worker then said it needed
the complete raw output and read the 12,577-byte artifact. It also repaired and
reran a separate `%`-escaping-broken `git log --format` command. This establishes
one recovery read and its additional tool-result cycle after automatic lossy
filtering; it does not establish that compression caused the format-command
rerun. It also does **not** establish a recovery frequency, percentage token
penalty, or break-even rate; earlier percentage claims had no supporting sample
set and were removed.

#### Reopened Review Findings (2026-07-15)

The first corrective implementation established the intended aggregate-capacity
direction, but review found unresolved correctness and resource regressions:

- untrusted tool text could forge the internal incomplete-result marker and a
  recovery path;
- batch-capacity failures did not carry a recoverable transcript and could save
  an empty authoritative session;
- AMA observers and the stall sidecar consumed raw results before batch
  admission;
- child evidence and removed acquisition/concurrency limits bypassed the
  next-request capacity owner;
- Bash spool finalization still materialized the complete output in memory, and
  generic ANSI removal was not contract-equivalent;
- public compatibility, reference-aware artifact cleanup, and documentation
  claims were incomplete.

#### Final Resolution After Review

- Incomplete-result idempotence now requires trusted structured `outputPath`
  metadata. Raw tool text containing a forged marker is treated as ordinary
  content and, when necessary, receives a new canonical artifact.
- SA and AMA capacity failures attach the last legal transcript; empty error
  carriers cannot overwrite a valid stored session. AMA result observers and
  stall-sidecar inputs fire only after batch admission.
- Child evidence is admitted against the actual routed provider/model initial
  request, including system prompt and active tool schemas. Acquisition work is
  bounded without silent loss: grep/code-search return `scan_offset` after 512
  candidates, and changed-diff bundles reject more than 64 unique paths while
  running Git subprocesses four at a time.
- ANSI normalization strips SGR styling and terminal metadata but preserves
  cursor-control sequences it cannot render losslessly. Bash tracks total bytes,
  releases raw buffers after decode, avoids a redundant spool copy, and directly
  seals a recovery artifact only when the cl100k token-byte upper bound proves
  the output cannot fit the active request. Its canonical manifest path is
  propagated as trusted tool-call metadata on both SA and AMA paths, and the
  terminal marker remains last so final admission reuses rather than nests it.
- Bash spools now live under the managed tool-results directory. REPL session
  startup scans active and archived JSONL references and removes only old,
  unreferenced artifacts; reference discovery failure performs no deletion.
- Legacy public budget builders/clamps were restored for SDK source
  compatibility. Internal admission still consumes only the fixed-point
  aggregate token capacity, so the compatibility surface is not a second owner.

#### Initial Resolution (incomplete; retained for audit history)

- Tool handlers now capture and return complete results. Bash keeps output from
  the first byte and changes from memory to a temporary spool at 512 KiB; that
  value is no longer an output limit. Completed background tasks return their
  full terminal output.
- Default Bash processing is limited to contract-equivalent terminal
  normalization. Command-specific compiled/declarative lossy filters remain
  available only for explicit use and are not selected by the default registry;
  compound commands receive no semantic adapter.
- One aggregate batch owner now decides delivery after every tool call in the
  batch settles. If the complete batch fits the actual next-request budget, it
  is delivered unchanged. Only overflow of the final operational budget
  (physical request, output reserve, and estimation safety) persists the
  complete value and emits one idempotent `KODAX_RESULT_INCOMPLETE` preview. An
  unrepresentable minimum marker fails explicitly instead of overfilling the
  request.
  *(Superseded 2026-08-27 by FEATURE_296 / ADR-067: an unrepresentable marker
  now records capacity debt and commits the complete tool_use/tool_result
  pair; a bounded recovery ladder — forced compaction, floor-bounded reserve
  shrink, irreducible-input degradation — owns the next request instead of
  failing the run. Termination is reserved for requests that cannot be made
  legal and surfaces as the structured `context_capacity` failure kind.)*
- Capacity first solves the largest final input `Pmax` satisfying
  `Pmax + providerReservedOutputTokens + max(2048, ceil(Pmax * 3%)) <=
  contextWindow`, then admits at most `Cbatch = max(0, Pmax -
  currentPhysicalRequestTokens)`. Computing the margin from the smaller
  pre-batch request is incorrect. Cache tokens remain part of physical context
  occupancy. The margin is an uncertainty guardrail, not a token-saving claim,
  and must be calibrated against estimate-vs-actual/recovery evidence rather
  than copied into per-tool caps.
- `read` has exact Unicode-safe `line_offset` continuation. Hidden result caps
  were removed from `grep`, `glob`, `code_search`, and retrieval rendering;
  unreadable or acquisition-limited sources carry `SOURCE_INCOMPLETE`. Local
  and provider code search, semantic lookup, keyword tool search, MCP search,
  web search, read, and grep use a true one-extra-item probe before claiming a
  limit was reached. Invalid negative `grep.head_limit` is rejected rather than
  becoming `0=unlimited`.
- Public guards without physical-capacity context are pass-through. MCP keeps
  genuinely distinct text/structured channels (including the fallback path)
  without duplicating an ordinary
  resource body into both, and rejects incomplete pagination instead of caching
  partial pages. Explicit search limits probe one extra item so the limit marker
  is truthful. Exact self-knowledge topics return full content. Bash cancellation
  first waits a bounded interval for process-tree termination and stream closure.
  If close is delayed, capture ownership moves to live recovery artifacts and
  the result exposes `KODAX_CAPTURE_INCOMPLETE`; only the later
  `KODAX_CAPTURE_COMPLETE` footer proves drain completion. A spool-read failure
  emits the same incomplete contract and a recovery locator instead of hanging
  or pretending completion. Live/paged/acquisition-limited results remain
  allowed only when their incompleteness and continuation contract are explicit.
- Hidden preview caps were also removed from changed-diff bundles, inline edit
  receipts, relationship supplemental evidence, exact tool selection, child
  evidence refs, and child completion envelopes. Their explicit schema limits
  remain valid query contracts; aggregate delivery belongs to the next-request
  batch/envelope capacity owner.
- Cache cost now splits uncached input, cache read, and cache write tokens and
  charges each token exactly once.
- Physical fallback accounting uses the final system prompt exactly once,
  includes active tool schemas and same-request synthetic recovery messages,
  and remains available when a provider omits usage. Provider-reported usage,
  when valid, remains authoritative. The misleading pre-batch
  instantaneous-slack behavior is not used internally; append capacity has one
  fixed-point implementation. Legacy snapshot/byte helpers remain exported only
  for SDK source compatibility.
- Recovery artifacts are canonical evidence for resumable sessions and are not
  deleted by an age-only TTL. REPL session startup performs reference-aware GC
  over active and archived JSONL, deleting only old unreferenced artifacts and
  failing closed if references cannot be discovered. The legacy age-only helper
  remains an explicit host/operator compatibility action. REPL
  startup likewise no longer deletes 24-hour-old pasted images referenced by
  session messages. The explicitly transient managed-task checkpoint window is
  measured from its latest successful write, not the task's original creation.
- Automatic history compaction now uses the same physical-capacity invariant.
  Default microcompaction and destructive graceful pruning are disabled.
  Below capacity, history remains exact; at actual pressure, semantic summary
  is attempted first over complete atomic message/tool pairs and stops when the
  next physical request fits. A failed, empty, or insufficient summary leaves
  canonical history unchanged and raises a typed capacity error instead of
  silently deleting messages. The immutable leading Worker system prompt is
  retained byte-for-byte; invalid summaries consume no source chunk, and hard
  capacity errors carry the latest recoverable transcript for persistence.
- The default automatic trigger is capacity-only. A static trigger below 100%
  is an explicit opt-in policy, and manual `/compact` remains an explicit force
  operation; neither is presented as guaranteed token optimization.

The two history-compaction bullets above record the `v0.7.69` closure state.
FEATURE_272 (`v0.7.74`) supersedes only that large-compaction trigger policy:
automatic large compaction is now always enabled with the percentage/absolute/
physical minimum described by Issue 192. The tool-result, microcompaction, and
artifact-recovery conclusions of this issue remain current.

#### Files Changed

- `packages/coding/src/tools/bash.ts`, `bash-output-collector.ts`,
  `output-filters/`, `read.ts`, `grep.ts`, `glob.ts`, `code-search.ts`,
  `semantic-lookup.ts`, `retrieval.ts`, `web-fetch.ts`, `web-search.ts`,
  `task-output.ts`
- `packages/coding/src/tools/mcp-call.ts`, `mcp-read-resource.ts`,
  `mcp-get-prompt.ts`, `packages/coding/src/self-knowledge/resolver.ts`
- `packages/coding/src/tools/changed-diff.ts`, `edit.ts`, `tool-search.ts`,
  `relationship-scan.ts`, `envelope-budget.ts`,
  `packages/coding/src/child-executor.ts`
- `packages/coding/src/tools/tool-result-budget.ts`, `tool-result-policy.ts`
- `packages/coding/src/tools/tool-output-gc.ts`,
  `packages/repl/src/session/public-api.ts`
- `packages/coding/src/agent-runtime/tool-dispatch.ts`
- `packages/coding/src/task-engine/runner-driven.ts`
- `packages/coding/src/task-engine/_internal/managed-task/checkpoint.ts`
- `packages/agent/src/context-capacity.ts`, `primitives/runner.ts`,
  `primitives/runner-tool-loop.ts`, `capabilities/mcp/runtime.ts`,
  `session-lineage/compaction/`
- `packages/coding/src/compaction-config.ts`,
  `agent-runtime/middleware/compaction-orchestration.ts`,
  `task-engine/_internal/managed-task/compaction.ts`
- `packages/llm/src/cost-rates.ts`, `cost-tracker.ts`
- `packages/repl/src/interactive/repl.ts`, `ui/InkREPL.tsx`

#### Tests Added

- Raw Bash fidelity for git/test/JSON/compound commands, OSC 8 URLs, and
  stdout/stderr larger than 512 KiB.
- Aggregate fit/spill behavior, one-marker idempotence, SA/AMA parity, and
  explicit minimum-marker capacity failure.
- Forged marker rejection, recovery-transcript persistence, post-admission AMA
  observation, routed child-briefing capacity, bounded acquisition continuation,
  Bash guaranteed-oversize artifacts, semantic ANSI preservation, public budget
  compatibility, and reference-aware artifact retention.
- Exact long-line continuation, complete terminal task output, and removal of
  hidden grep/glob/code-search/retrieval caps.
- N/N+1 boundaries for semantic/code/tool/MCP/web search and grep; MCP direct
  and fallback channel fidelity; delayed Bash drain recovery; pasted-image and
  long-task checkpoint retention.
- Source-incomplete diagnostics for unreadable files and bounded network
  acquisition, plus cache read/write single-charge accounting.
- Capacity-only history triggers, default microcompaction no-op, summary-first
  compaction, preserved atomic tool pairs/fixed overhead, and typed failure
  without mutation when no recoverable compacted request can fit.

#### Design Record

The corrective decision and regression matrix are recorded in ADR-050,
`docs/features/v0.7.61.md`, and
`docs/test-guides/FEATURE_251_v0.7.61_TEST_GUIDE.md`.

### 157: F267/F269 review found durability, network, concurrency, and diagnostic gaps

- **Priority**: High
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.69 RC
- **Created**: 2026-07-14
- **Resolved**: 2026-07-14
- **Fixed**: v0.7.69

#### Original Problem

An external review reported 25 possible defects across the shared Runtime
daemon, A2A transport, governed memory, and SDK documentation. Reproduction and
source-to-sink validation confirmed that daemon state and owner locks were not
fsynced; A2A streams could remain blocked after idle/dispose; blocking A2A calls
had no wait bound; request handling could mix hot configurations; default A2A
fetch validated and connected through separate DNS resolutions; concurrent
memory forgets restored deleted index entries; expired credential leases and
malformed stale learning locks were retained or reclaimed unsafely; and corrupt
best-effort records were skipped without internal diagnostics.

#### Root Cause

- Two new daemon files did not reuse the existing `0600` plus fsync pattern.
- Streaming and blocking A2A paths lacked explicit lifecycle bounds, and hot
  options were read repeatedly across asynchronous request steps.
- URL policy validation preceded a second resolver inside global `fetch`.
- Memory index mutation occurred outside the lifecycle lock with a direct
  read-modify-write, while malformed locks were treated as provably abandoned.
- Best-effort public APIs preserved availability but did not emit a redacted
  diagnostic when they skipped invalid persisted input.

#### Resolution

Daemon state staging and owner locks now use `0600` file descriptors and fsync
before publication. A2A event streams have connection/idle aborts tied to
executor disposal, blocking calls return the current task after a configurable
wait, each request and its run capture one hot-options snapshot, and the default
HTTP(S) transport pins the validated address while retaining the hostname for
Host/TLS verification. Memory forget now serializes file removal, atomic index
replacement, and tombstone update under the lifecycle lock. Expired credential
leases are pruned on registration, malformed stale locks fail closed, and
invalid review/session records plus A2A fallback/recovery failures emit redacted
diagnostics without changing their public fail-soft result.
Windows lock probes also treat transient `EPERM`/`EACCES`/`EBUSY` during
concurrent removal as non-stale and retry instead of reclaiming ownership or
leaking the raw filesystem race.
Root-level static validation also exposes the server's implemented
`whenReady()` method, returns a structurally narrowed DNS address, and derives
safe request-body input from `RequestInit` instead of an unavailable DOM-only
type name.

#### Files Changed

- `src/runtime-daemon/state.ts`
- `src/runtime-daemon/reverse-bridge.ts`
- `src/a2a/client-executor.ts`, `safe-fetch.ts`, `server.ts`, `types.ts`, `config.ts`
- `packages/agent/src/memory-control/lifecycle.ts`, `review-inbox.ts`
- `packages/agent/src/learning/store.ts`
- `packages/repl/src/session/public-api.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`, `docs/features/v0.7.69.md`

#### Tests Added

- File-descriptor fsync and restrictive daemon-file modes.
- Stream disposal/idle abort, bounded blocking waits, and hot-option snapshots.
- DNS address pinning against a hostname unavailable to the system resolver.
- Root `tsc --noEmit` plus safe-fetch and server readiness/hot-option tests.
- Concurrent direct lifecycle forgets, malformed stale locks, lease renewal,
  and diagnostics for invalid persisted records.

#### Review Disposition

The remaining report items were not changed when they described intentional
fail-closed behavior, documented sandbox limits, bounded synchronous storage,
or lifecycle ownership: credential errors are already normalized before public
serialization; no-code A2A is explicitly single-principal; daemon startup and
ownership timers intentionally keep work alive; transport close intentionally
rejects pending RPCs; socket `EADDRINUSE` remains authoritative; detached daemon
survival is required; PowerShell aliases and symlinks are rejected/skipped
fail-closed; and the memory shell guard's process-isolation limit is already
recorded under Issue 153.

### 156: Bare `kodax -r` repeatedly full-reads large session sets before opening the picker

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.68
- **Created**: 2026-07-14
- **Resolved**: 2026-07-14
- **Fixed**: v0.7.69

#### Original Problem

Opening bare `kodax -r` becomes noticeably slow as the session store grows.
On a real Windows store containing 1174 session files and about 221 MB of data,
the picker waited roughly 13.8 seconds before becoming interactive.

#### Root Cause

The CLI requested up to 1000 sessions in pages of 100. Every project-scoped
cursor request entered the general `listSessions` path, which traversed the
session tree, read every candidate JSONL file in full, sorted the complete set,
and only then sliced one page. Up to ten pages therefore repeated the same
directory scan and transcript reads.

#### Resolution

The picker now requests its bounded 1000-session dataset in one pass. The
general list path reads only the metadata first line for modern sessions, in
batches of 48, and falls back to a full read only for legacy metadata that lacks
`activeMessageCount` or for a pathological metadata line over 64 KiB. It still
scans project aliases so old sessions are not hidden.

On the same 755 matching sessions, the published v0.7.68 path took about
13.8 seconds. The worktree source completed in about 0.47 seconds and the
publish-shaped bundle in about 0.77 seconds, while returning the same 755 IDs.

#### Files Changed

- `src/kodax_cli.ts`
- `packages/repl/src/interactive/storage.ts`
- `packages/repl/src/session/public-api.ts`
- `packages/repl/src/session/public-api.test.ts`
- `tests/kodax_cli.test.ts`

#### Tests Added

- Project-scoped listing must not full-read a modern session transcript.
- The CLI resume picker dataset must be loaded with one bounded list pass.
- Real-store source and publish-bundle timings retain the complete result set.

### 155: Bare `kodax -r` exits after selection during the picker-to-TUI handoff

- **Priority**: High
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.68
- **Created**: 2026-07-14
- **Resolved**: 2026-07-14
- **Fixed**: v0.7.69

#### Original Problem

Running bare `kodax -r` opens the searchable session picker and allows normal
keyboard navigation, but pressing Enter briefly opens the main KodaX UI and
then exits the process before the resumed transcript is rendered. The failure
reproduces for both new and old sessions. Resuming the same session with
`kodax -r <session-id>` works because that path bypasses the picker.

#### Root Cause

The picker uses the external Ink renderer while the main KodaX UI uses the
project-owned renderer. External Ink releases raw input ownership on picker
unmount by calling `process.stdin.unref()`. The owned renderer then enables raw
mode and attaches its data listener, but it does not restore the stream
reference. With no referenced event-loop handle left, its `beforeExit` handler
immediately unmounts the newly rendered main UI.

#### Proposed Solution

Use the project-owned renderer for the session picker too, keeping input
ownership inside one renderer lifecycle. Add a regression that exercises the
Enter-to-resumed-UI transition, not only picker filtering and static rendering.
Keep direct ID/title resume and Escape/Ctrl+C cancellation behavior unchanged.

#### Resolution

`SessionPicker` now imports `render`, `useApp`, and `useInput` from KodaX's
owned TUI facade. Picker selection and the resumed REPL therefore share one
input-ownership model and no external Ink teardown can unref stdin between the
two surfaces.

#### Workaround

List sessions with `kodax -s list`, then resume explicitly with
`kodax -r <session-id>`. `kodax -c` also remains available for the most recent
session.

#### Affected Files

- `packages/repl/src/ui/SessionPicker.tsx`
- `packages/repl/src/ui/SessionPicker.test.tsx`

#### Test Gap

The v0.7.68 tests verify filtering, paging, hints, and static rendering, but do
not start a second interactive renderer after the picker exits. The human guide
contains the expected Enter-resume behavior, but it was not enforced by an
automated lifecycle test.

#### Tests Added

- A simulated TTY renders the picker through the owned renderer, sends Enter,
  and verifies that the highlighted session is selected through that lifecycle.
- Existing filtering, paging, rendering, and terminal-input controller tests
  remain green.

### 154: FEATURE_267/268 review found remote execution and hot-reload reliability gaps

- **Priority**: High
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.69 RC
- **Created**: 2026-07-13
- **Resolved**: 2026-07-13
- **Fixed**: v0.7.69

#### Original Problem

Joint review found that inbound A2A tool execution could wait for an interactive
permission response after its deployment guardrail had already authorized the
call; lexical workspace checks allowed a symlink/Junction to escape; and the
no-code CLI returned the initial submitted A2A task instead of following it to a
stable state. F268 replacement also treated a failed MCP prewarm as usable,
could reject after a successful provider swap when old cleanup failed, and
copied subscriber/watch exceptions into user-visible diagnostics.

#### Root Cause

- The remote Runtime binding supplied neither a headless permission decision nor
  a permission-mode default.
- Workspace containment used `path.resolve` without resolving the existing
  target or nearest existing parent.
- `a2a call` sent one JSON-RPC request outside the F258 task lifecycle.
- MCP prewarm deliberately used fail-soft startup semantics for replacement too.
- Provider swap and old-instance disposal shared one rejection result, while the
  config controller classified validation and activation in one catch block.

#### Proposed Solution

Add failing regression tests first, then keep the pinned guardrail as the remote
authority while supplying deterministic headless approval, add real-path
containment, route CLI calls through F258, make replacement prewarm strict, and
separate swap success from cleanup diagnostics. Never expose raw activation or
watcher exceptions.

#### Resolution

The Runtime binding now checks lexical plus real containment for existing and
future targets and proceeds without interactive approval only after its pinned
guardrail. The CLI discovers an `external:<name>` registration, starts it on the
F258 plane, and waits through submitted/working states. MCP replacement rejects
and disposes a broken candidate while retaining the previous provider. Failed
old-provider cleanup records a generic `dispose` diagnostic without rolling back
the new instance or poisoning later shutdown. Integration validation,
activation, and watcher degradation now have distinct generic diagnostics.

#### Files Changed

- `src/runtime-agent-binding.ts`
- `src/integration-cli.ts`
- `packages/agent/src/capabilities/mcp/provider.ts`
- `packages/coding/src/capabilities/providers/mcp-adapter.ts`
- `packages/coding/src/extensions/runtime.ts`
- `packages/repl/src/common/integration-config.ts`

#### Tests Added

- Existing and future targets below a symlink/Junction are denied.
- Headless remote calls do not enter the interactive permission wait.
- CLI polling observes submitted, working, and completed A2A states.
- Broken MCP candidates retain the active provider.
- Cleanup failures retain the replacement and redact secret/path canaries.
- Activation diagnostics retain the prior snapshot and redact exception data.

#### Remaining Risk

Real-path validation is defense in depth against stable links; ASRT or an outer
container/VM remains the process-isolation boundary for admitted scripts and
hostile tenants. Independent A2A TCK/client evidence, POSIX release validation,
and a provisioned Windows ASRT run remain release gates rather than code gaps.

### 153: FEATURE_260 post-release review found memory guard bypass and persistence isolation gaps

- **Priority**: High
- **Status**: **Resolved** (v0.7.69)
- **Introduced**: v0.7.68
- **Created**: 2026-07-12
- **Resolved**: 2026-07-12
- **Fixed**: v0.7.69

#### Original Problem

Post-release adversarial review showed that the governed-memory shell guard can
be bypassed by chaining a permitted read with an interpreter write, or by using
home-relative and environment-relative paths. Separately, malformed approval
metadata can be dropped without a warning and allow a later proposal write to
replace the remaining store; a review drain without `projectId` can claim
project-owned work; and stale lock recovery can remove a successor owner's lock.

Expected behavior is fail-closed protection of governed memory at the Bash tool
boundary, fail-loud preservation of corrupt proposal stores, exact project
ownership during drains, and owner-checked release of recovered file locks.

#### Root Cause

- The shell guard recognizes literal configured roots but treats any command
  beginning with a read verb as read-only, even when later commands mutate.
- Five approval fields return an invalid proposal without appending a warning.
- Missing drain filters behave as wildcards for project-owned entries.
- Lock files contain no owner token and are removed unconditionally by path.

#### Proposed Solution

Add failing boundary tests first, then enforce single read-only shell commands,
warn on every invalid stored field, make project-less drains defer project-owned
reviews, and release locks only when their owner token still matches. Preserve
tenant-wide listing, legitimate read-only inspection, and normal project-scoped
drains.

#### Resolution

The Bash guard now recognizes scoped and legacy memory paths in absolute,
home-relative, and environment-relative forms, and permits only a single simple
read-only inspection when governed memory is addressed. Every invalid approval
field now emits a warning, so proposal writes refuse to replace a corrupt store.
Project-less drains defer project-owned reviews while retaining tenant-wide list
and project-less owner behavior. Proposal and lifecycle locks now persist PID and
random owner tokens, check process liveness before stale recovery, and remove a
lock only when the releasing token still owns it. Lifecycle state writes and
review inbox writes also use cleaned-up atomic temporary files, and persisted
outcome evidence receives complete runtime shape validation.

#### Files Changed

- `packages/coding/src/tools/memory-mutation-guard.ts`
- `packages/agent/src/learning/store.ts`
- `packages/agent/src/memory-control/review-inbox.ts`
- `packages/agent/src/memory-control/lifecycle.ts`

#### Tests Added

- Chained, piped, home-relative, environment-relative, and legacy memory shell paths.
- All five approval metadata corruption fields plus fail-closed rewrite preservation.
- Project-owned versus project-less review drain ownership.
- Successor lock token preservation and malformed outcome evidence rejection.

#### Remaining Risk

The Bash check is deterministic defense-in-depth for commands that directly
address recognized governed-memory paths. It is not an OS filesystem sandbox:
an intentionally obfuscated program can construct a path without including the
protected literal in its command text. Preventing that broader same-user process
authority requires process-level filesystem isolation or a privileged memory
writer boundary, which is outside this minimal patch.

### 152: FEATURE_260 review found credential, mutation-guard, concurrent persistence, and eval-integrity gaps

- **Priority**: High
- **Status**: **Resolved** (v0.7.68)
- **Introduced**: v0.7.68 release candidate
- **Created**: 2026-07-12
- **Resolved**: 2026-07-12
- **Fixed**: v0.7.68

#### Original Problem

The post-implementation FEATURE_260 review found five release-integrity gaps:
raw Git remotes could retain embedded HTTP credentials in project identity and
legacy storage paths; structured and shell memory guards were case-sensitive or
allowed interpreter-based mutation; concurrent inbox drains could review one
episode twice while proposal/lifecycle read-modify-write operations lost sibling
updates; the eval manifest omitted untracked candidate files; and malformed raw
eval JSON was silently treated as a missing cache cell.

The final routing result remained valid for policy behavior, but these gaps made
the current working tree unsafe to publish as-is and weakened its audit trail.

#### Root Cause

- Repository identity reused `remote.origin.url` before canonical redaction.
- Mutation protection relied on `.md` suffixes and a mutating-command allowlist.
- Shared JSON stores and episode drains had atomic writes but no serialization or
  atomic work claim.
- Eval provenance hashed only `git diff HEAD`, which excludes untracked files.
- Cache recovery grouped `SyntaxError` with `ENOENT`, allowing regeneration.

#### Resolution

Repository identities now canonicalize HTTPS/SSH remotes without userinfo,
query strings, or raw fallback bytes. Managed-path checks are Windows-safe and
protect governance sidecars; shell commands that address a managed root are
fail-closed except for a narrow read-only inspection set. Pending reviews move
atomically into a processing claim with stale-claim recovery, and proposal plus
lifecycle stores serialize cross-process read-modify-write sections with bounded
stale locks. The eval manifest schema now binds tracked submodule-aware diffs and
untracked file path/content hashes. Malformed cache JSON fails loudly, and the
summary declares the main-session review as a separate artifact rather than a
permanently pending field.

The post-review documentation pass also split governed memory out of the legacy
sessions manual topic, added all-command drift coverage for `kodax_manual`, and
documented direct `/experimental-memory` SDK ownership and safety boundaries.

#### Files Changed

- `packages/coding/src/memory-runtime.ts`
- `packages/coding/src/tools/memory-mutation-guard.ts`
- `packages/agent/src/memory/paths.ts`
- `packages/agent/src/memory-control/review-inbox.ts`
- `packages/agent/src/memory-control/lifecycle.ts`
- `packages/agent/src/learning/store.ts`
- `benchmark/datasets/feature-260/experiment-contract.ts`
- `benchmark/datasets/feature-260/runner.ts`
- `packages/coding/src/self-knowledge/registry.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`

#### Tests Added

- Credential-bearing HTTPS and equivalent SSH repository identity.
- Windows path casing, interpreter shell mutation, and governance-sidecar guards.
- Concurrent review claim, proposal upsert, and lifecycle tombstone persistence.
- Untracked source-snapshot hashing and fail-loud malformed eval cache handling.
- Memory/manual query routing and full built-in-command drift coverage.

### 151: Runtime config tests leak detached daemon processes and interrupted background fixtures can survive

- **Priority**: High
- **Status**: **Resolved** (v0.7.67)
- **Introduced**: v0.7.67 release candidate
- **Created**: 2026-07-11
- **Resolved**: 2026-07-11
- **Fixed**: v0.7.67

#### Original Problem

Windows Task Manager showed many long-lived Node processes after KodaX test
runs. Process ownership/command-line inspection separated 26 Codex-owned MCP
servers from four real KodaX residues: three `config-*` daemon processes whose
test parents were gone, and one background command fixture whose test parent
had been forcibly terminated.

The daemon behavior itself is intentional: a process daemon survives client
detach and stops only through explicit shutdown. The defect is that
`sdk-runtime.config.test.ts` creates that persistent owner but only closes the
client before deleting its temporary home. Separately, infinite-loop child
fixtures assume Vitest always reaches `afterEach`; a forced runner timeout can
prevent cleanup.

#### Root Cause

- The config test treated client `close()` as daemon shutdown, contrary to the
  explicit daemon ownership contract.
- Long-running process fixtures had no parent-liveness watchdog for abnormal
  test-runner termination.
- Task Manager also groups Codex MCP servers under Node.js, which made the KodaX
  residue appear much larger than it was.

#### Proposed Solution

- Track the config test's daemon profile, explicitly request
  `runtime.shutdown`, and verify daemon state disappears before deleting the
  temporary home; keep an `afterEach` fallback for failed assertions.
- Make infinite background test fixtures exit when their original parent
  process no longer exists, without changing production background jobs.
- Document that daemon mode is persistent by design and provide the explicit
  `kodax daemon stop` cleanup command; do not kill unrelated Node/Codex MCP
  processes.

#### Resolution

The runtime config suite now records the exact daemon `homeDir + profile`, sends
an authenticated `runtime.shutdown`, waits until owner state disappears, and
keeps an `afterEach` fallback for assertion failures. Its regression run passed
3/3 with a before/after process diff of `NEW_NODE_PIDS=none`. Infinite child
fixtures in the Bash and managed-process suites now poll their original parent
and self-exit if a forcibly terminated test runner cannot reach normal cleanup.

A v0.7.68 full-suite follow-up exposed one remaining race: daemon state was
rewritten by truncating `daemon.json` in place, so a shutdown poll could observe
an empty/partial file as transiently missing and return before the subsequent
`stopping` state became readable. State updates now use a same-directory staging
file plus atomic rename. The config shutdown case passed three repeated runs,
and the final process/staging-file audit found no residue.

Five already-orphaned, command-line-verified KodaX test processes were stopped.
The 26 Node processes owned by the active `codex.exe` parent were identified as
Codex MCP servers and intentionally left untouched.

#### Files Changed

- `src/sdk-runtime.config.test.ts`
- `src/runtime-daemon/state.ts`
- `src/runtime-daemon/state.test.ts`
- `packages/coding/src/tools/bash.test.ts`
- `packages/agent/src/runtime/managed-child-processes.test.ts`
- `docs/SDK_EMBEDDER_GUIDE.md`

#### Tests Added or Hardened

- Auto-started config daemon state must disappear after explicit test shutdown.
- The daemon test run must leave no new Node PID after completion.
- State replacement is atomic and leaves no staging file behind.
- Long-lived process fixtures have an abnormal-parent-exit fallback while
  retaining normal managed cleanup assertions.

### 150: v0.7.67 外部 Agent 脚本路由与执行平面关闭契约存在发布阻断缺口

- **Priority**: High
- **Status**: **Resolved** (v0.7.67)
- **Introduced**: v0.7.67 release candidate
- **Created**: 2026-07-11
- **Resolved**: 2026-07-11
- **Fixed**: v0.7.67

#### Original Problem

Post-release review found that `WorkflowSpawnAgentInput.target` was present in
the public Agent type and consumed by the Workflow runtime, but the restricted
script host boundary silently omitted it. The same whitelist also omitted the
public `phase` field. Therefore a model-authored `run_workflow` script could not
route a child through FEATURE_258's shared dispatchable-agent catalog even
though direct/built-in Workflow calls could.

The same review found deterministic lifecycle gaps in the executor plane:
`close()` disposed executors without settling pending `tasks.wait()` promises,
and every registration/catalog/task method remained callable after close.
Adjacent trust-boundary hardening gaps affected scoped-review structured values,
Feature 259 baseline reconstruction, and non-authoritative local-ledger updates.

#### Context

- Affected components: restricted Workflow script RPC, external Agent executor
  plane lifecycle, built-in scoped review, Feature 259 eval contract, local task
  ledger mirroring.
- Reproduction: run a restricted script with
  `target: {agentId:'external:...'}` and inspect the `WorkflowApi.runAgent`
  input; start `tasks.wait(id)` without a timeout and close the plane.
- Expected: every public spawn field crosses the script boundary with validation;
  close is terminal and settles pending waits; ancillary validation/ledger
  failures cannot silently corrupt authoritative results.

#### Root Cause

The restricted-script whitelist was updated for Feature 259 briefing fields but
not Feature 258's target or the existing phase field. The executor plane had no
closed state and modeled waiters as resolve-only callbacks. The remaining gaps
were local trust-boundary assumptions that lacked fail-loud assertions.

#### Proposed Solution

- Parse and validate `phase` and `target` at the restricted-script boundary.
- Make executor-plane close idempotent and terminal, reject all pending waiters,
  and reject all service calls after close.
- Validate built-in scoped-review structured values against their declared
  schemas.
- Make every Feature 259 baseline prompt rewrite required and byte-auditable.
- Keep local-ledger mirroring best-effort without replacing child results/errors.

#### Resolution

The v0.7.67 GitHub release and tag were withdrawn before npm publication. The
restricted script boundary now validates and forwards both `phase` and
`target`; malformed external targets fail before dispatch. Executor-plane
closure is idempotent and terminal, rejects every pending waiter, and rejects
all subsequent registration/catalog/task service calls. Scoped-review values
are checked against the declared schemas, Feature 259 baseline reconstruction
uses fail-loud exact replacements and no longer leaks proposed-only fields, and
local ledger mirror failures are diagnostic-only.

#### Files Changed

- `packages/agent/src/workflow/script-runner.ts`
- `packages/agent/src/external-agents/executor-plane.ts`
- `packages/coding/src/workflows/builtin/scoped-review.ts`
- `packages/coding/src/tools/dispatch-child-tasks.ts`
- `benchmark/datasets/feature-259/cases.ts`

#### Tests Added

- Restricted scripts preserve `phase`, `target.agentId`, and configuration
  revision, while rejecting blank target IDs.
- Closing an executor plane rejects an unbounded waiter, rejects every service
  surface after close, and remains safe when called twice.
- Malformed scoped-review output fails with a schema diagnostic.
- Local ledger mirror failure cannot replace an authoritative child result.
- Frozen Feature 259 baselines exclude candidate-only briefing fields and the
  previously malformed schema fragment.

### 149: ACP tests persist empty sessions into the real user store

- **Priority**: High
- **Status**: **Resolved** (v0.7.67)
- **Introduced**: v0.7.66 (`7dc5df52`, 2026-07-09)
- **Created**: 2026-07-11
- **Resolved**: 2026-07-11
- **Fixed**: v0.7.67

#### Original Problem

Running the ACP test suites created batches of empty, user-scope `ACP Session`
files in the real `~/.kodax/sessions` project bucket. These zero-message records
polluted KodaX and SDK-consumer history, statistics, and recent-session windows.
The affected machine accumulated 304 broad title/surface/message matches; 285
also met the stricter no-lineage/no-artifact/no-extension cleanup predicate.

#### Context

- Affected components: ACP server lifecycle, both ACP test harnesses, Runtime
  persistence home, session SDK list contract, CLI resume/list UX.
- Reproduction: run `tests/acp_server.test.ts` from v0.7.66 and inspect the
  current project's `~/.kodax/sessions` bucket.
- Expected: protocol handshakes and tests that never submit a prompt leave no
  durable user session or Runtime run evidence.

#### Root Cause

Commit `7dc5df52` added eager `runtime.sessions.create()` inside ACP
`newSession()`. The main integration harness did not inject storage; a later
optional injection covered only one test. The second ACP unit harness used an
isolated `sessionsDir` in one case but left Runtime persistence on a shared
home. `dispose()` correctly stopped runs but had no basis to delete already
persisted empty sessions.

#### Resolution

- ACP sessions remain provisional until the first valid prompt, which creates
  the Runtime session once and titles it from that prompt.
- Both ACP suites now use temporary session and Runtime homes; the integration
  harness fails immediately if a resolved path enters the real user state root.
- SDK and Runtime listing gained exact `surface` filtering and opaque cursor
  continuation, including Daemon schema parity.
- Bare `-r` now opens a searchable/paged TUI; `-s list` omits non-resumable
  zero-message entries.
- `-s cleanup-acp` performs a strict preview. The separately confirmed
  `--apply-session-cleanup` action archives matched records reversibly and is
  never run automatically.

#### Files Changed

- `src/acp_server.ts`
- `src/acp_server.test.ts`
- `tests/acp_server.test.ts`
- `packages/repl/src/session/public-api.ts`
- `packages/repl/src/ui/SessionPicker.tsx`
- `src/sdk-runtime.ts`
- `src/runtime-daemon/schema.ts`
- `src/kodax_cli.ts`
- `src/acp_session_cleanup.ts`

#### Tests Added

- Provisional ACP session persistence and isolated storage/runtime-home guards.
- Session surface filtering and cursor continuation at public SDK and Runtime layers.
- Daemon protocol schema coverage for surface/cursor fields.
- Session picker filtering/paging render contracts and strict cleanup predicate tests.
- Full ACP integration regression: real-user pollution count remained unchanged.

### 148: FEATURE_258 外部任务在持久化失败、配置热更新和并发回调下可能失联或状态回退

- **Priority**: High
- **Status**: **Resolved** (v0.7.67)
- **Introduced**: v0.7.67 release candidate
- **Created**: 2026-07-10
- **Resolved**: 2026-07-10
- **Fixed**: v0.7.67

#### Original Problem

FEATURE_258 review 发现四个相互关联的生命周期缺陷：远端 Start 已成功后若本地事件账本写入失败，任务会丢失远端句柄并错误落为 `failed`；registration 从旧 revision 更新后，在途任务无法继续 input/cancel/reconcile；慢 continuation 与终态事件并发时，旧快照可把 `completed` 覆盖回 `working`；Workflow external 分支忽略 `wait(..., { timeoutMs })`。

#### Context

- Components: external Agent executor plane、统一 task ledger、Workflow external adapter。
- Impact: 远端任务可能成为无法取消或恢复的孤儿任务，终态可能回退，Workflow 可能无限等待。
- Reproduction: fault-injection event store、registration 热更新、受控 continuation/event 并发，以及 input-required external Workflow timeout。

#### Root Cause

远端 Start 与其后的本地持久化共用同一个失败分支；后续控制根据当前 registration 而非任务启动时绑定的 executor 路由；异步调用完成后直接写回调用前捕获的快照；Workflow external wait 提前返回，绕过了 timeout 归一化和透传。

#### Resolution

- 远端引用返回后进入独立 accepted 阶段，后续账本异常保留引用并记为 `unknown`。
- 活动任务保存不可变 executor binding，registration 更新或删除不再重定向在途任务。
- 所有事件和远端 continuation/cancel/reconcile 回写通过任务级 mutation queue 读取最新快照，终态不再回退。
- Workflow external wait 校验并透传 `timeoutMs`。

#### Files Changed

- `packages/agent/src/external-agents/executor-plane.ts`
- `packages/agent/src/external-agents/executor-plane.test.ts`
- `packages/coding/src/workflows/agent-adapter.ts`
- `packages/coding/src/workflows/external-agent-adapter.test.ts`

#### Tests Added

- accepted Start 后账本失败仍保留远端句柄。
- registration revision 更新后旧任务仍可 continuation。
- completion 与 continuation 并发时终态保持单调。
- Workflow external wait 正确执行超时和参数校验。

### 147: GitHub Release 二进制归档遗漏 Runtime 与工具 Worker sidecar

- **Priority**: High
- **Status**: **Resolved** (v0.7.66)
- **Introduced**: v0.7.66 release candidate
- **Created**: 2026-07-10
- **Resolved**: 2026-07-10
- **Fixed**: v0.7.66

#### Original Problem

`scripts/build-binary.mjs` 已将 `provider-capabilities.json`、
`semantic-worker.js`、`runtime-worker.js` 和
`constructed-handler-worker.js` 复制到每个 standalone binary 目录，运行时也按
`process.execPath` 从同目录加载这些文件；但 `.github/workflows/release.yml`
仍只把 executable 与 `builtin/` 放入 GitHub Release 压缩包。打 tag 后生成的下载版
会丢失 provider metadata、repo-intelligence Worker、Worker-hosted Runtime 和
constructed-handler Worker。

#### Context

- Components: standalone binary GitHub Release pipeline.
- Impact: npm 包不受影响，但 GitHub 下载的免 Node 版本会静默降级或无法启用
  v0.7.66 的 Worker Runtime / constructed handler 隔离能力。
- Reproduction: 对比 `dist/binary/<target>/` 的构建产物与 release workflow 的
  `Compress-Archive` / `tar` 输入清单。

#### Root Cause

新增 Worker sidecar 时只更新了 build/copy guard 和发布文档，没有同步历史 release
archive 白名单，也没有确定性测试锁定该白名单。

#### Resolution

- release workflow 在打包前逐项检查所有 sidecar，缺失时立即失败。
- Windows zip 与 Unix tar 清单都包含 provider metadata 和三个 Worker sidecar。
- GitHub Release notes 与 binary distribution 文档同步说明完整内容。

#### Files Changed

- `.github/workflows/release.yml`
- `docs/release.md`
- `tests/release-workflow.test.ts`

#### Tests Added

- `tests/release-workflow.test.ts` 解析真实 YAML，断言 `Package archive` 步骤包含
  四个运行时 sidecar；测试在修复前失败、修复后通过。

### 146: 图片路径粘贴处理失败时吞掉原始输入且无可见反馈

- **Priority**: Medium
- **Status**: **Resolved** (v0.7.66)
- **Introduced**: v0.7.40 (FEATURE_134)
- **Created**: 2026-07-10
- **Resolved**: 2026-07-10
- **Fixed**: v0.7.66

#### Original Problem

在 REPL 输入框粘贴以 `.png` 等图片扩展名结尾的路径时，FEATURE_134 会先消费原始粘贴事件并异步读取、解码图片。若文件不存在、不可读或图片处理失败，错误分支只发出默认不可见的 diagnostic，既不恢复原始路径，也不给用户可见反馈；用户看到的结果是粘贴内容静默消失。去掉扩展名最后一个字符后不会触发图片分支，因此可以按普通文本粘贴。

#### Context

- Components: `packages/repl/src/ui/utils/prompt-input-controller.ts`, `packages/repl/src/ui/components/InputPrompt.tsx`, `packages/repl/src/ui/InkREPL.tsx`.
- Impact: 图片路径粘贴失败会丢失当前输入，用户无法判断失败原因；有效图片粘贴不受影响。
- Workaround before fix: 先粘贴不完整扩展名，再手动输入最后一个字符。

#### Root Cause

`handleKey` 在扩展名匹配后立即把 paste 标记为 handled；`insertImageRefsFromPaste` 的 `outcome.kind === "error"` 分支只调用 `emitKodaXDiagnostic`。交互式 REPL 默认没有 diagnostic UI sink，且 diagnostics 不写历史，所以该错误既不可见也没有文本 fallback。

#### Resolution

- 图片路径处理失败时，以 `paste: false` 将原始粘贴内容恢复到当前输入框，避免再次触发图片识别。
- 通过局部 `onPasteFallback` 回调复用现有两秒 `ClipboardToastSurface`，显示 `Image paste failed; inserted as plain text.` 警告。
- Toast 只存在于 React 临时状态，不追加 history、不持久化，也不进入 LLM 上下文；技术 diagnostic 继续保留供调试使用。
- 有效图片仍转换为 `@<temporary-image-path>`，普通文本粘贴行为不变。

#### Files Changed

- `packages/repl/src/ui/utils/prompt-input-controller.ts`
- `packages/repl/src/ui/components/InputPrompt.tsx`
- `packages/repl/src/ui/types.ts`
- `packages/repl/src/ui/InkREPL.tsx`

#### Tests Added

- `packages/repl/src/ui/utils/prompt-input-controller.test.ts`: 验证错误时恢复原路径、触发临时通知，且不提交、不写历史。
- Existing paste/InputPrompt/ClipboardToast regression suites remain green.

### 145: Runtime daemon / SDK 边界存在生命周期、事件、权限与协议一致性缺口

- **Priority**: High
- **Status**: **Resolved** (v0.7.66)
- **Introduced**: v0.7.64-v0.7.66 (FEATURE_254 / FEATURE_255)
- **Created**: 2026-07-10
- **Resolved**: 2026-07-10
- **Fixed**: v0.7.66

#### Original Problem

对 v0.7.63 之后的 embedded runtime 与 local daemon 进行跨提交审查时，发现若干在单实例 happy path 中不明显、但会破坏多客户端和长生命周期宿主的边界缺口：首个 auto-start client 关闭会连带终止共享 daemon；持久化事件序号在 runtime 重建后回退；事件消费者异常会逃逸到生产者；活动 run 与会话历史变更缺少冲突保护；`permissionMode` 未真正约束 runtime 工具执行；CLI daemon REPL 会把含函数、`AbortSignal` 和进程内对象的 options 直接跨 JSON 发送；wire error、frame 大小、订阅建连竞态、artifact 路径和核心 schema 参数也缺少完整的边界处理。

#### Context

- Components: `src/sdk-runtime.ts`, `src/runtime-daemon/*`, CLI/ACP host adapters, diagnostic sink, LSP shutdown cleanup.
- Impact: daemon peer clients can unexpectedly断连；重连 replay 可漏事件；权限请求可能挂起或重复；失败结果在 socket client 侧退化为 `{}`；异常/畸形输入可跨越协议边界。
- Scope: 修复现有 FEATURE_254 / FEATURE_255 contract，不引入第二套 runtime 或假想配置层。

#### Resolution

- auto-start daemon host 与首个 SDK client 解耦；`close()` 只断开 client，显式 shutdown 才释放 host，peer client 在 owner 断开后继续可用。
- event sequence 从持久化 cursor / event log 恢复；listener 异常隔离；delta 继续全量 replay，但按 tick/阈值批量落盘并限制单 run 日志体积。
- active run 阻止 rewind / active-entry / compact；runtime permission policy、client broker、bridge meta-tool 单次授权和 protected-path 规则统一。
- `run.await` Error 增加 wire codec；frame/buffer 限制为 8 MiB；订阅早到事件缓冲；dispatcher 按方法 schema 校验 params/result。
- artifact create 校验可读普通文件与 256 MiB 上限；CLI daemon REPL 使用显式 JSON-safe DTO，桥接流式事件、权限和 abort。
- ACP 共用注入 session storage 根；diagnostic sink 支持非 LIFO restore；LSP managed-child 在 stdio close 后才注销。

#### Files Changed

- `src/sdk-runtime.ts`, `src/runtime-daemon/*`, `src/kodax_cli.ts`, `src/acp_server.ts`
- `packages/agent/src/diagnostics.ts`, `packages/agent/src/runtime/managed-child-processes.ts`
- `packages/coding/src/agent-runtime/tool-dispatch.ts`, `packages/coding/src/lsp/client.ts`
- `packages/repl/src/index.ts`, `packages/repl/src/interactive/*`, `packages/repl/src/ui/InkREPL.tsx`

#### Verification

- Runtime/daemon/host/ACP/LSP/diagnostic/bridge targeted suites passed.
- Root TypeScript check and package build passed.
- Full local suite reached 9,420 passed; its only codebase-owned failure was this tracker summary before the resolved count was updated. The other failure scanned the developer machine's mutable real-session corpus and is re-run under a clean CI-style home.

### 141: CI workflow long-red on Linux — cross-platform test bugs

- **Priority**: Medium
- **Status**: **Open** (partially fixed — see Progress)
- **Introduced**: long-standing; CI `ci.yml` has been red on the `KodaX` branch across many releases (v0.7.48–v0.7.51) while the product itself is unaffected
- **Created**: 2026-06-18
- **Fixed**: -

#### Overview

The GitHub Actions `CI` workflow (`.github/workflows/ci.yml`, Ubuntu, full
`npm test`) has been failing on every push for 40+ runs. This is **not a
product regression** — the suite is green locally on Windows and the
tag-triggered `Release` workflow (binaries + GitHub Release) succeeds
independently. The red is a cluster of **cross-platform / environment test
bugs** that only surface on the Linux CI runner.

#### Root Causes (diagnosed 2026-06-18 via CI as the repro environment)

1. **`packages/repl/src/interactive/storage.test.ts` (6 tests)** — `FileSessionStorage.list()` (`storage.ts:~1307`) derives the per-project session key from a **live** `inspectWorkspaceRuntime({ cwd: gitRoot })`, whereas `save()` derives it from the persisted session data. When the test's `gitRoot` is a non-existent directory, the `git`-spawn-with-bad-cwd fallback diverges between Windows and Linux, so the list-time key ≠ the save-time key and `list()` returns `[]`. **A portable-path fix was tried and DISPROVEN by CI** — the failure is the runtime-inspection layer, not path format. **Robust fix:** mock `inspectWorkspaceRuntime` in these 6 tests (as the passing "lists sibling workspace sessions" test already does) so the key derivation is deterministic on all platforms. Needs a Linux repro to verify.
2. **`benchmark/harness/h2-boundary-runner.test.ts` (3 tests)** — env propagation to the spawned fake-kodax process (`KODAX_FORCE_MAX_HARNESS`, `KODAX_PLANNER_INPUTFILTER`) + `mustNotTouchViolations` forbidden-path detection behave differently under the Linux spawn/path semantics.
3. **`packages/coding/src/tools/bash.test.ts` (2 tests)** — "registers background commands for managed cleanup" / "stops background commands when the caller aborts": background-process registration + kill/abort lifecycle differs on Linux (process-tree semantics). (The third bash failure, "keeps the tail for large command output", was a shell-quoting bug and is **fixed**.)
4. **`packages/agent/src/capabilities/skills/skill-creator-tools.test.ts` (collection failure)** — the file throws at module-load time: `agent-task-runner: API key env DEEPSEEK_API_KEY not set for alias ds/v4flash`. **Fix:** skip (or lazily construct) when the API key is absent, so the suite collects without provider credentials.

#### Progress (fixed and CI-confirmed, 2026-06-17→18)

- **Node 18 floor dropped** (commit `f9ab5596`): a `v`-flag RegExp (unicodeSets, requires Node 20+) in a dependency made ~65 of 71 node-18 test files fail to even load. `engines.node` raised to `>=20.0.0` (root + 4 packages), `ci.yml` matrix reduced to `['20','22']`, README/AGENTS/CLAUDE tech-stack tables synced. This eliminated the bulk of the red.
- **`bash.test.ts` large-output** (`e9b88a95`): backtick/`${}` in a `node -e` script was expanded by POSIX `sh`; switched to single-quoted concatenation.
- **`terminalCapabilities.test.ts`** + **`workspace-runtime.test.ts`** (`8344a13a`): `isScreenReader()` treats `CI` as a signal (Actions sets `CI=true`) — test now clears it; `resolveSessionRuntimeInfo` normalizes via `path.resolve`, so the legacy-gitRoot case now uses a both-absolute root.

Net: node 22 went from **71 failed files → 4 failed files / 11 failed tests**.

#### Why this is tracked rather than fixed now

The remaining failures (storage `list()`, h2 spawn, bash background) are Linux
runtime/process/workspace behaviors that **cannot be fixed confidently without a
Linux reproduction environment** — the one blind hypothesis attempted (storage
portable path) was disproven by CI. The dev machine has no Docker and no
installed WSL distro, and `node_modules` deps were wiped post-publish
(`npm ls` = empty), so local verification is currently impossible.

#### Proposed Solution

Pick up with a Linux repro env (WSL distro / Docker / Linux box):
1. Mock `inspectWorkspaceRuntime` in the 6 storage `list()` tests.
2. Make `skill-creator-tools.test.ts` skip when `DEEPSEEK_API_KEY` is absent.
3. Reproduce + fix the h2-boundary-runner env-propagation and bash background-process tests on Linux.
4. Verify the full matrix (node 20 + 22) goes green, then keep CI green as a gate.

#### Context

- Full per-root-cause diagnosis captured in this session; the analysis is the hard part — once on Linux the fixes are largely mechanical.
- `Release` workflow is independent of `CI` and remains green.

---

### 136: 流式 / 滚动时 spinner 动画卡顿 + 计时变慢 — 瓶颈在 CPU 侧每帧渲染，非终端写入字节量

- **Priority**: Low（用户实测"影响不大"；不阻塞功能，纯视觉/手感）
- **Status**: **Open**（根因待 trace 确认）
- **Introduced**: 待调研（疑似一直存在；v0.7.41 spinner stats 尾巴 `58682cbf` 让每 tick 输出变化，可能放大可见度）
- **Created**: 2026-05-31

#### Symptom

流式输出过程中、以及上下文很长时滚动过程中，spinner 动画明显卡顿、计时变慢（驱动 spinner 的 `setInterval` 回调被推迟，帧率不稳）。注意：**打字卡顿是另一个独立症状，已由 FEATURE_212 cell-diff（`60c38896`）修复**；本 issue 的 spinner 卡顿独立存在，未被修复。

#### Investigation — 已排除的假设（两次 I/O 否证）

- ❌ **假设 1「全屏每帧整屏重画（~6KB ANSI 写）是瓶颈」** → FEATURE_212 fullscreen cell-diff（`60c38896`，default ON）把打字时的写入量从整屏降到只画变化的格子，**打字卡顿消失**，但 spinner 卡顿无变化。
- ❌ **假设 2「滚动时 cell-diff 退化成近整屏写」** → FEATURE_212 DECSTBM 硬件滚动快路径（`870f59aa`→`424b1a34`，default ON）把滚动写入量降到只画滚进来的行（terminal-model gate 证明逐字节重建正确），**实测 spinner 卡顿仍无变化**。
- **结论**：两次都否证了「终端写入字节量（I/O 侧）是瓶颈」。DECSTBM 对本症状无效（见下方 Related 的回滚评估）。

#### Likely root cause（待 trace 确认）

瓶颈在 **CPU 侧每帧渲染工作**，不在 I/O 字节量：

- 流式每个 token 到达 / 滚动每帧都触发 React reconciliation 重建整棵 transcript 子树；
- `outputToScreen` / `Output.getGrid` 全量重建 Screen 网格（参考 FEATURE_172 Phase A 诊断 + Issue 094 的"核心渲染文件过大/耦合"）；
- 上述同步 CPU 工作（叠加同步 stdout 写）占满主线程 → 驱动 spinner 动画的 `setInterval` 回调被推迟 → 动画帧率不稳 + 计时变慢。

DECSTBM 只优化了「把字节写到终端」这一 I/O 步，没有触碰上面的 CPU 侧重建——这正解释了为何它对 spinner 无效。

#### Next

- 用 `KODAX_RENDER_TRACE` + 多 agent 并行 trace（参考 `feedback_render_pipeline_full_trace`）定位 CPU 侧热点，**端到端测 wall-time**（参考 `feedback_bench_must_be_end_to_end`，不要只测 inner function）。
- 对照 `C:/Works/claudecode` 的 spinner 机制：是否用不受 render 阻塞的独立 timer，或对流式 render 做节流（throttle / coalesce）。

#### Related

- **FEATURE_212**：`60c38896`（cell-diff）有效修复打字卡顿，保留。DECSTBM 部分（`870f59aa`→`424b1a34`）对本 issue（spinner）**无效**——它只降低滚动帧的 I/O 写入量，不碰 CPU 侧重建。但用户实测**滚动本身手感有改善**（I/O 写入量下降的预期效果，与 spinner 症状独立）→ **保留**（2026-05-31，escape hatch `KODAX_SCROLL_DECSTBM=0`）。本 issue 的 spinner 卡顿仍 **Open**，需 CPU 侧 trace。
- [FEATURE_172](FEATURE_LIST.md#feature_172) / ADR-028 — render pipeline 底层瓶颈（真实瓶颈在 ink 底层 ~80%，非数据层）。
- Issue 094 — 核心渲染文件过大、职责耦合。

---


### 133: `repo-intelligence/runtime.test.ts` "falls back to OSS when premium returns malformed preturn payloads" intermittent flake

- **Priority**: Low（测试 flake only；不影响 user-facing 行为，仅在并行 suite 高负载下偶发）
- **Status**: Open（调研已展开，**暂未复现**，候选根因 narrowed）
- **Introduced**: 待调研（commit history 显示文件最近一次改动是 v0.7.37 FEATURE_142 `a840f22b`，但 flake 表现实际何时起飞需调研）
- **Created**: 2026-05-16

#### Current Behavior

跑 `npm test` 全套（512 files / 5,935 tests，Windows 并行模式）偶尔出现这个 case 失败；单独 `npx vitest run packages/coding/src/repo-intelligence/runtime.test.ts` 始终通过（5 tests / 288ms）。多次 full-suite 跑结果跳跃（pass → fail → pass）。

**2026-05-16 复现尝试**：连续 5 次 full-suite run **0/5 复现**；本次调研期间反而稳定通过。可能性：
- (a) 本次 PR 加的全局 `vitest.setup.queue.ts` `_resetMessageQueueForTests()` 间接降低了 worker 内 module-state 污染概率（不直接相关但环境变了）
- (b) Flake 本身概率极低（之前 ~6 次中触发 1 次 ≈ 17%），5 次未复现仍可能 just lucky
- (c) 失败模式可能与 specific worker 调度顺序相关，难以稳定 trigger

#### Code Reading 发现的候选根因（**code-read 已确认存在；race trigger 未实证**）

在 [`packages/coding/src/repo-intelligence/runtime.ts:57-62`](../packages/coding/src/repo-intelligence/runtime.ts#L57-L62) 有 **module-level 单例 cache**：

```typescript
const PRETURN_CACHE_TTL_MS = 1_500;
const premiumPreturnCache = new Map<string, { expiresAt: number; promise: Promise<PremiumPreturnResult | null>; }>();
```

Cache key（[runtime.ts:296-305](../packages/coding/src/repo-intelligence/runtime.ts#L296-L305)）由 `mode / endpoint / bin / executionCwd / gitRoot / targetPath / refresh / trace` 组成。

**关键观察**：每个 test 用 `mkdtempSync` 创建独立 `tempDir` → cache key 中 `executionCwd` 不同 → 同文件内 test 间 cache key **理论不冲突**。但：

1. **gitRoot 未在 test context 中显式设**：测试只传 `{ executionCwd: tempDir }`，没传 gitRoot。Cache key 用 `context.gitRoot ?? ''`。但如果 `tryPremiumPreturn` 内部隐式 resolve gitRoot 为 `process.cwd()` 的 git root（在 vitest worker 中是 monorepo root），则**所有 test 共享同一个 gitRoot 段**——但 cacheKey 看的是 `context.gitRoot`，不是 resolved value，所以仍是 ''
2. **Promise 是 cached**（不只 result）：cache 存 `Promise<PremiumPreturnResult | null>`。如果 test A 的 mock 返回的 promise 被存进 cache，test B 复用了同一个 cacheKey（极小可能 — 需要相同 tempDir，几乎不可能），就会拿到 test A 的 mock 结果
3. **`vi.mock('./premium-client.js')` 是 file-scoped**：vitest 的 vi.mock hoist 到文件顶部，正常情况不会跨 file 污染——除非 worker 复用时模块状态部分泄漏

#### 暂不复现 → 暂不修

无法实证复现路径，**贸然修代码风险大于收益**（可能引入新 bug，或修了非 root cause）。建议留作 dormant tracking：
- 后续如再次复现，捕获完整 stderr/stdout + cache 状态 dump
- 在 `beforeEach` 加 `premiumPreturnCache.clear()` 是低成本防御性 fix 但属非测试代码改动；当前不做

#### Workaround

- 跑测试时若复现，单独 `npx vitest run` 该文件验证；不构成实际功能问题
- 若高频复现可在 [runtime.ts](../packages/coding/src/repo-intelligence/runtime.ts) export 一个 `_resetPremiumPreturnCacheForTests()` 并在测试 beforeEach 调用（test helper 模式）—— 同 `_resetMessageQueueForTests` 的做法

#### Related

- Issue 132（同期 known flake，h2-boundary-runner.test.ts）—— 两个 flake 都在 heavy parallel load 下偶发，但失败模式 root cause 不同（132 是 Windows fs visibility，133 是 module cache 假设）
- precedent commit `d4a47bc9`（v0.7.37）—— "logic is sound — single-test runs always pass" 同款判断

---


### 126: tmux 默认不透传 OSC 8 超链接 — kodax 输出中的 file:// / docs URL 在 tmux 内不可点击

- **Priority**: Low
- **Status**: Open（terminal multiplexer 默认配置问题，非 KodaX bug；提供一行 workaround）
- **Introduced**: 一直存在（OSC 8 hyperlink 自 v0.6.x 起被广泛用于 file 路径 / docs 链接）
- **Created**: 2026-04-28
- **Target Version**: 不修复（外部依赖）

#### Background

KodaX 在多处使用 OSC 8 hyperlink escape sequence（`\x1b]8;;<URL>\x1b]8;;\x07`）让支持的终端把 URL 渲染成可点击文本：

- `file://` 链接：edit/read 工具结果中的文件引用
- `docs/...` 路径：诊断消息中指向项目文档的快捷跳转
- 外部 URL：知识/技能链接

主流现代终端（iTerm2、WezTerm、Alacritty、Windows Terminal、Ghostty、VS Code integrated terminal）默认支持 OSC 8。**但 tmux ≤ 3.3 默认开启的"过滤未知 OSC"行为会丢弃所有 OSC 8 序列**，URL 不渲染为可点击，只看到裸文字。

FEATURE_057 Track F（v0.7.30 cell-level diff renderer）评审过程中确认这是 tmux 已知缺省行为，与 KodaX 的渲染层无关——legacy log-update.js 路径同样被影响。

#### Reproduction

1. 在原生终端（iTerm2 / WezTerm / Windows Terminal）运行 kodax，让其输出一条带 `file://` 链接的诊断消息 → 链接显示为带下划线、可 Cmd/Ctrl+点击
2. 进入 tmux session（默认配置），同样运行 → 链接显示为普通文本，鼠标点击无响应
3. `cat` 一段内联 OSC 8 测试串验证：`printf '\e]8;;https://example.com\e\\example link\e]8;;\e\\\n'`

#### Workaround

在用户的 `~/.tmux.conf` 添加一行：

```
set -g allow-passthrough on
```

之后 `tmux kill-server` + 重新 attach 生效。`allow-passthrough` 让 tmux 把它不识别的 OSC/CSI/DCS 序列原样转给底层终端，OSC 8 即被外部终端解析。

注意：`allow-passthrough on` 是 tmux 3.3+ 的设置。tmux 3.2 及以下需要升级或忍受 OSC 8 不可用。

#### Why Not Fix in KodaX

- 关闭 OSC 8 emission 会让所有非 tmux 用户失去可点击链接（占绝大多数）
- 自动 detect tmux 不可靠：`$TMUX` 环境变量在嵌套 SSH / sudo 后可能丢失，且无法判断用户是否已设 passthrough
- terminfo 没有标准化 OSC 8 capability bit，运行时 probe 成本高
- tmux upstream 已在演进 passthrough 默认策略，由 tmux 维护者收敛是更合理的归宿

KodaX 选择记录 known issue + 一行 workaround，让 tmux 用户主动配置。

#### Related

- FEATURE_057 Track F Phase 4 review（v0.7.30）— 在 cell-level renderer 终端兼容性分析中确认该 issue 跨 legacy / cell 路径同形
- `packages/repl/src/tui/substrate/ink/osc.ts` — OSC 8 emit 实现（`link()` / `LINK_END`）
- tmux upstream 讨论：[tmux/tmux#3083](https://github.com/tmux/tmux/issues/3083) passthrough default 历史记录

---
### 125: Thinking-mode cross-provider replay — 三个不可测 OpenAI-compat 与 anthropic 官方 strict mode 待实证

- **Priority**: Low
- **Status**: Open（tracking — 不阻塞发版，记录待实证项以便未来拿到 API key 时回填）
- **Introduced**: v0.7.28（伴随 deepseek V4 thinking-mode 400 修复 + 跨 provider 切换保护工作落地）
- **Created**: 2026-04-26
- **Target Version**: 无固定版本，等可获取的 API key / 实证窗口

#### Background

DeepSeek V4 thinking-mode 修复（v0.7.28）落地了三层保护：

1. **L1**（[openai.ts:807](../packages/llm/src/providers/openai.ts)）：`replayReasoningContent: true` flag 的 provider 把每个 assistant turn 的 `reasoning_content` 字段补齐（默认 `''`），避免 multi-turn 缺字段时 400
2. **L5**（[anthropic.ts:619-645](../packages/llm/src/providers/anthropic.ts)）：strict signature mode 下，缺签名的跨 provider thinking 块转 `<prior_reasoning>` text 注入 ——目的是切到 anthropic 官方时不丢推理痕迹
3. **Kimi guard**（[anthropic.ts:704](../packages/llm/src/providers/anthropic.ts)）：assistant tool_use turn 缺 thinking 块时注入 `{ thinking: '...', signature: '' }` 占位

L1 deepseek V4 路径已实证（直接 API probe 重现 400 + 修复）。但还有三个**未独立实证**的项：

#### Unverified Items

| 项 | 风险 | 现状 |
|---|---|---|
| `kimi` / `qwen` / `zhipu` OpenAI-compat 是否真的拒绝缺 `reasoning_content` 的 replay | 低 — 同字段约定，假设失败模式同形 | v0.7.28 全部 opt-in `replayReasoningContent: true`（按 deepseek 方案 max-tolerance），但**没有 probe 证明该 flag 必要 / 安全**。若任一家对额外字段 strict，会引入新 regression（罕见 — Chinese OpenAI-compat 普遍 lenient on extra fields） |
| Anthropic 官方对历史 thinking 块的签名严格度（L5 strict mode 的真实工作场景） | 极低 — 默认 strict flag 仅对 `anthropic` provider 启用 | 未跑过实测；只在理论上有效。需要 ANTHROPIC_API_KEY 跑一次「带跨 provider thinking history → 切到 anthropic.com」端到端验证 |
| Kimi guard 注入 `{thinking:'...', signature:''}` 是否仍必要 | 低 — 5 个第三方 Anthropic-compat provider（kimi-code / ark-coding / mimo-coding / minimax-coding / zhipu-coding）实测对 (a) 无 thinking 块 / (b) 空 thinking / (c) `'...'` 占位 / (d) 真 thinking 全 LENIENT | guard 当前可能是死代码。删除是独立 cleanup，等再观察 1-2 个版本无人触发后再做 |

#### Reproduction（待补）

各项需要的实证步骤：

1. **kimi/qwen/zhipu OpenAI-compat 严格度**：用对应的 `KIMI_API_KEY` / `DASHSCOPE_API_KEY` / `ZHIPU_API_KEY`（注意：用户当前持有的 `ZHIPU_API_KEY` 是 `zhipu-coding` 的 Anthropic-compat 端点 key，不是 `zhipu` OpenAI-compat 的；`KIMI_API_KEY` 同理与 `kimi-code` 不同）跑 `c:/tmp/openai-compat-tool-calls-probe.mjs`，看 (II.omit) vs (II.empty) 是否复现 deepseek 的 400/200 模式
2. **Anthropic 官方 L5 strict**：用 `ANTHROPIC_API_KEY` 构造一段含「signature 缺失或不可信的 thinking block」历史，切到 `anthropic` provider 重发，观察是否真按 strict 拒绝 → 验证 `<prior_reasoning>` text 转换路径
3. **Kimi guard**：监控生产 trace，若 1-2 版本内无人在含 tool_use 的 anthropic-compat 历史上触发该 guard 注入路径，可视为死代码删除

#### Workaround / Acceptance

当前 v0.7.28 接受这三项 known limitation：
- kimi/qwen/zhipu OpenAI-compat：opt-in 失败的 risk 低（同协议族 lenient on extra fields），收益大（max-tolerance），用户报障再回退
- Anthropic 官方 L5：默认行为正确（pass-through with 空签名），strict mode 是额外保护层，最坏情况是退回 pre-v0.7.28 行为
- Kimi guard：保留无害；观察期满后再删

#### Related

- 修复 commit 链：L0 错误史保护（runner-driven.ts:2679）/ L1 reasoning_content always-attach（openai.ts:807）/ L3 sanitize_thinking_and_retry recovery action / L5 cross-provider thinking conversion（anthropic.ts:619-645）/ Kimi guard（anthropic.ts:704）
- [v0.7.28.md FEATURE_087/088 Risk 节](features/v0.7.28.md) 同一限制条目
- 经验性证据矩阵：deepseek V4 直接 API probe 已重现 400 + 修复确认；5 个 Anthropic-compat provider 4 种 thinking shape 全 LENIENT；其余维度未测

---
### 124: AMA 子 Agent dispatch 实际触发率偏低 — Controller fanout gate + H1 工具白名单串联收得过紧

- **Priority**: High
- **Status**: Open
- **Introduced**: v0.7.18 / v0.7.19（FEATURE_067 / 047 / 052 落地时定的保守门槛）
- **Created**: 2026-04-26
- **Target Version**: v0.7.28（unreleased，与本次 prompt+gate 调整同期）

#### Current Behavior

`dispatch_child_task` 工具（FEATURE_067）和 fan-out scheduler（FEATURE_047）已经在 v0.7.18-v0.7.19 落地并通过测试，但**真实运行中子 Agent 派发频率明显低于预期**。表现：

- H1 普通改代码任务：Generator 看不到 `dispatch_child_task` 工具（白名单未包含），无法并行修改多个独立模块
- H1 read-only 调研任务：Scout 升级到 H1 后 controller 的 `fanout.admissible` 立刻变 false，Scout fan-out 提示被关闭
- H2 写多模块任务：`hypothesis-check` fanout class 在 controller 里硬编码 `return false`，Generator 即使在 H2 也得不到 fanout 提示
- Plan / systemic 任务的调研阶段：`profile === 'tactical'` 一刀切，managed profile 完全没有 fan-out 路径

#### Expected Behavior

子 Agent dispatch 是已交付能力，应当在能提升效率的场景被自然激活：

- H1 read-only 调研：Scout 和 Generator 都能在多目标场景派 read-only child
- H2 多模块写入：Generator 能在独立模块改动时派 write child（已有 worktree 隔离机制）
- Plan / systemic 调研：Scout / Planner 能并行调研多个模块作为决策输入

但**不能**强制并行——Rule A/B/C prompt 仍由 LLM 自主判断，gate 只负责"capability available"。

#### Reproduction

观察任意真实多模块任务的 KodaX session：

1. `kodax "审查 packages/llm 和 packages/coding 的安全问题"` —— 触发 H1 review-only 路径，Scout 会 fan-out（这条路径正常）
2. `kodax "在 packages/llm、packages/agent、packages/coding 三个独立模块各加一个空函数"` —— 触发 H2 write，但 Generator 不会派 write child（hypothesis-check 硬编码 false）
3. `kodax "重构 task-engine 的 H1/H2 路由逻辑"` —— 触发 managed profile（`requiresBrainstorm + code` 命中），即使是 read-only 调研阶段也拿不到 fan-out 提示

#### Root Cause（已通过 isolated eval 实测确认）

实测证据：`tests/dispatch-prompt-comparison.eval.ts` 在 zhipu-coding / minimax-coding / deepseek 三家 provider 上，**给 LLM 看到 `dispatch_child_task` 工具 + 现有 RULE A/B/C prompt 的隔离环境下，T1（fan-out）任务全部正确触发 3 child，T2（不该派）全部正确不派，T3（context preservation）多数正确**。说明 LLM 知道何时该派——**问题不在 prompt，在 gate**。

现状的 4 层串联 gate（任一层关上即 0 触发）：

**Layer 1 - Controller fanout class gate**（[reasoning.ts:1098-1133](../packages/coding/src/reasoning.ts)）：
- `evidence-scan`（bugfix/investigation read-only）只在 `harnessProfile === 'H0_DIRECT'` 启用，H1/H2 一律关闭
- `module-triage`（lookup）同上
- `hypothesis-check`（write 类）硬编码 `return false`
- 只有 `finding-validation`（review）永远开

**Layer 2 - Profile filter**（[reasoning.ts:1158](../packages/coding/src/reasoning.ts)）：
- `profile === 'tactical'` 一刀切。plan / systemic / brainstorm 任务的 managed profile 直接屏蔽 fan-out

**Layer 3 - H1 工具白名单**（V1 chain 时期分析；FEATURE_193 (v0.7.43) 已 retire 整层）：
- 初步分析以为"H1 Generator 在非 review-only 路径下拿不到 `dispatch_child_task`"，但**实地核对后是误判**：
  - 当时 `H1_READONLY_GENERATOR_ALLOWED_TOOLS` 数组本身已经包含 `dispatch_child_task`（该常量在 FEATURE_193 v0.7.43 退役 V1 Planner / readonly Generator 时被删）
  - 非 review-only / 非 docs-scoped 的默认 H1 路径返回 `undefined`，没有 `allowedTools` 过滤，全工具可用
  - 当时 Generator agent 的 tools 数组无条件包含 `generatorDispatch`（FEATURE_193 v0.7.43 退役 V1 chain agent declarations 时删除）
- 既有测试 `Shard 6d-Q — dispatch_child_task exposed to Scout + Generator only` 已经覆盖这个不变量（FEATURE_193 retire 后测试也已迁移到 Worker）
- **本层无 fix 工作**（A3 移除）。V2 Worker 直接拿全工具集，不走 allow-list 路径。

**Layer 4 - 缺乏 telemetry**（[dispatch-child-tasks.ts](../packages/coding/src/tools/dispatch-child-tasks.ts)）：
- 现有 `onToolUseStart` 已记录 LLM 端的"我要派 child"，但缺乏 child 完成的状态 + 耗时聚合
- 改完无法度量"触发率上升了多少 / 平均耗时 / 有没有过头"
- 解决路径：复用工具内已有的 `ctx.reportToolProgress`（KodaXEvents 标准事件），在入口和出口加结构化标记行，无需引入新类型

#### Proposed Solution（v0.7.28 切片）

**Prompt 层（最小化）**：
- A5b：在 Scout 和 Generator 的 RULE C 后追加 "When NOT to use" 否定清单 4 条（参考 Claude Code / opencode 的 negative-bumper 风格）。**已实测无回归**。
- 不重写 RULE A/B/C 结构（实测说明对国产 coding 模型 RULE 标签是有效 anchor）

**Gate 层（核心修复）**：
- A1：`evidence-scan` 解锁到 H1 + read-only（去掉 `harnessProfile === 'H0_DIRECT'` 限制）
- A2：`hypothesis-check` 解锁到 H2_PLAN_EXECUTE_EVAL（去掉硬 `return false`）
- ~~A3~~：实地核对后**phantom problem**，Generator 一直能 dispatch_child_task，无 fix 工作
- B1：`profile === 'tactical'` 改为对 read-only fanout class 不限制 profile，对 hypothesis-check 仍要求 tactical（精确放开，避免一刀切）

**Telemetry 层（验证手段）**：
- A4：在 `dispatch-child-tasks.ts` 入口和出口通过现有 `ctx.reportToolProgress` 发送结构化标记行（`[dispatch] start childId=... readOnly=...` / `[dispatch] end childId=... status=... duration_ms=...`）。**复用既有 KodaXEvents 通道，零新类型、零新 logger**。session transcript 自动持久化，未来 `grep '\[dispatch\]'` 可聚合"改完之后触发率上升了多少 / 哪些任务派了几个 / 平均跑多久 / 是否过头"。

**Provider/model 行为差异（实测发现）**：
跨 provider × 跨 deepseek 模型档位的 dispatch 行为不完全一致——这是模型本身的特性，不是 prompt 缺陷：
- `zhipu-coding (glm-5.1)` / `minimax-coding (M2.7)` / `deepseek-v4-flash`：T1 fan-out 全部 100% 直接派 child
- `deepseek-v4-pro`：60% 直接 fan-out，40% 先 glob 侦察再下一轮 dispatch（v4-pro 是深度推理档，"scope-first" 是合理特性，**不是漏 dispatch**——延迟一轮而已）
- `deepseek-chat`（已废弃，2026-07-24 deprecate）：40% 直接 fan-out，因模型问题不是 prompt 问题
T3（context preservation 单 child）所有 provider 都有概率走"先 grep 再 dispatch"的多轮路径——这是合理 strategy（先看搜索结果再决定要不要 child），不是回归。

**Follow-up（不在本次切片）**：
- B2：Scout opportunity scan 字段（实测说明非紧急）
- B3：Rule B 的 `≥10 file reads` 数字调整（实测说明 LLM 用语义不用数字，无害）
- A2 pre-Scout 限制：`buildAmaControllerDecision` 用的是 routing heuristic 预测的 `harnessProfile`（不是 Scout 确认值）。本次依靠 Generator role-prompt 里的 post-Scout 二次 gate（[role-prompt.ts:608-610](../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts)）兜底，但 controller 信号在"routing 预测 H1 / Scout 升 H2"路径上仍是关闭的——后续若 telemetry 数据显示该路径有真实需求，可考虑改为 post-Scout 重算 `activeFanoutClass`

#### Acceptance Criteria

Issue 124 关闭条件：
1. v0.7.28 发布后跑过的真实 session 中，`grep '\[dispatch\] start' ~/.kodax/sessions/*/transcript*` 出现非零结果——证明 telemetry 路径通
2. 上述结果至少覆盖一种之前关闭的路径（H1 read-only 调研 / managed profile 调研 / H2 write hypothesis-check 至少一种）——证明 gate 解锁实际生效
3. 没有 user-reported "误派 child / token 飙升" 回归——证明 R5 风险（过度并行）未兑现

不需要硬性"触发率提升 X%"指标，因为没有可信的 baseline（改之前 telemetry 不存在）。改完用绝对触发数 + 主观体感判断即可。

#### Context

- [reasoning.ts:1098-1186](../packages/coding/src/reasoning.ts)（fan-out class gate + buildAmaControllerDecision）
- [tool-policy.ts:362-394](../packages/coding/src/task-engine/_internal/managed-task/tool-policy.ts)（H1 Generator allowedTools）
- [role-prompt.ts:476-499](../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts)（Scout dispatch_child_task prompt）
- [role-prompt.ts:572-595](../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts)（Generator dispatch_child_task prompt）
- [tests/dispatch-prompt-comparison.eval.ts](../tests/dispatch-prompt-comparison.eval.ts)（prompt 实测基线，3 providers × 3 variants × 3 tasks）
- [tests/dispatch-prompt-deepseek-variance.eval.ts](../tests/dispatch-prompt-deepseek-variance.eval.ts)（deepseek 跨模型方差探针：v4-flash 100% / v4-pro 60% / chat 40% 直接 fan-out）

#### References

- FEATURE_067 Child Agent Execution（v0.7.18 完成）
- FEATURE_047 Invisible Adaptive Parallelism（v0.7.19 完成）
- FEATURE_052 Dual-Profile AMA Harness and Child Fan-Out Boundaries（v0.7.19 完成）
- 用户反馈：现实际使用中子 Agent 触发频率明显偏低
- 跨家 prompt 风格对比：Claude Code（Agent tool, 4 层结构）、opencode（task tool, "Use 1 / Use multiple" 场景对照）、pi-mono（subagent extension, single/parallel/chain mode 参数）

---

### 122: edit / multi_edit 错误消息在 v0.7.26 过度精简 — 丢失关键信息载体导致 LLM 恢复失败

- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.7.26
- **Fixed**: -
- **Created**: 2026-04-23
- **Resolved**: -
- **Target Version**: v0.7.27（修复已 commit `4423e0d` 于 KodaX 分支，等待随 v0.7.27 发布）

#### Current Behavior

v0.7.26 在 commit `ef085fc` 里为降低 token 开销对 `edit` / `multi_edit` 的错误消息和工具描述做了精简，但与此同时也把若干**信息载体**（不是脚手架）砍掉了。对**强模型**（Claude Opus / Sonnet / GPT-4 级）影响小，但对**中档模型做 Scout**（Kimi / MiniMax / Zhipu 的 capped-budget 档，正是 AMA 里 Scout 的常见模型）会观察到错误消息不足以帮它自恢复：

- **ambiguous-match 缺具体示例**：原消息 `"(a heading, function name, or distinctive comment)"` 被砍 → LLM 不知道什么算"nearby unique context"，可能选随意文本作为 widen 的依据
- **`"Do NOT just shorten"` 的 scope limiter `"just"` 被砍**：变成 `"(Shorter anchors match more, not fewer.)"` 这类范畴判断 → 可能被 LLM 误应用为"任何场景都不要缩短"
- **not-found 错误丢了第二个备选诊断**：原文里 `"...whitespace drift vs the actual file, OR it was never in the file to begin with"` 的 `OR` 分支被砍 → 当 LLM 实际**幻觉**了 anchor 时，它会无限尝试"再读更宽窗口找精确文本"而永远找不到
- **anchor-consumed 诊断语气削弱**：原文 `"is present in the original file but was consumed by..."` 告诉 LLM "你的 anchor 本来对了，问题在另一个 edit"；精简版 `"anchor was consumed by ..."` 读起来像普通失败
- **ANCHOR WARNING 丢了触发语**：原文 `"If later edits need to reference text an earlier edit overlaps..."` 的前置条件被砍 → 规则从"if-then 识别"变成"plain fact"，触发概率下降
- **UNIQUENESS RULE 丢了具体尺寸和示例**：`"#1 cause"` 框架、`"a 6-line window"` 具体尺寸、`"multi-line block"` 示例都被砍

#### Expected Behavior

错误消息在保持 token 经济的前提下**不丢信息载体**。具体来说，具体示例 / scope limiter / 幻觉备选诊断 / diagnostic framing / 触发条件应该全部保留——纯脚手架（`Either (a) ... or (b) ...` 外壳 / `"on that edit if all matches should change"` 等冗余从句）是可砍的。

一次恢复失败造成的额外 retry 成本（几百至几千 tokens）远大于保留这些信息载体的 per-error 成本（每条错误 <25 tokens）。

#### Reproduction

观察到的触发场景（2026-04-23 实际会话）：

```
✗ [Scout] multi_edit (failed)
  edits[1] old_string not found. ...Re-read the file and retry with a stable anchor.

Scout → read - offset=226 - limit=6   # 窄 6 行重读

✗ [Scout] multi_edit (failed)
  edits[1] matched 2 places. Retry with a unique anchor or set replace_all=true on that edit.
```

Scout 的 6 行窄重读在整文件里产生歧义 anchor；v0.7.26 的错误消息**既没提示窄读陷阱，也没提示 anchor 可能根本不在文件里**，Scout 只能盲猜继续。

#### Root Cause

Commit `ef085fc` 把 V1 精简到 V2 时没区分"信息载体"和"脚手架"，整体砍。具体对照：

| 被砍内容 | 作用类别 | 是否该保留 |
|---|---|---|
| `Either (a) ... or (b) ...` 枚举外壳 | 脚手架 | 可砍 |
| `"on that edit if all matches should change"` 从句 | 脚手架 | 可砍 |
| `"at lines"` → `"lines"` | 脚手架 | 可砍 |
| `"This aborts the whole batch — no edits have been applied"` | 冗余（tool description 已有） | 可砍 |
| **`"(a heading, function name, or distinctive comment)"`** | **信息载体** | **必保留** |
| **`"Do NOT just shorten"` 里的 `just`** | **scope limiter** | **必保留** |
| **`"OR it was never in the file to begin with"`** | **幻觉备选诊断** | **必保留** |
| **`"is present in the original file but was consumed"`** | **diagnostic framing** | **必保留** |
| **ANCHOR WARNING 的 `"If later edits need to reference..."`** | **触发语** | **必保留** |
| **UNIQUENESS RULE 的 `"#1 cause"` / 具体尺寸 / `"multi-line block"`** | **具体示例** | **必保留** |

#### Proposed Solution

已在 commit `4423e0d`（KodaX 分支本地，未发布）里**选择性回填**所有信息载体，保留所有脚手架的精简。应用对象：`edit.ts` + `multi_edit.ts` + `registry.ts`，并同步更新 `edit.test.ts` / `multi-edit.test.ts` 断言。

- 净开销：4 个错误消息 +~280 chars（平均 +70/条），工具描述 +~130 chars（session 级缓存）
- 等价 token：每次错误 <25 tokens
- 验证：29/29 edit+multi_edit 测试绿，`tsc --noEmit` 干净

**关闭条件**：v0.7.27 tag 推出时由 `4423e0d` 随版本发布 → 将本 issue 标为 Resolved，Fixed 字段填 v0.7.27。

#### References

- v0.7.26 原精简 commit: `ef085fc fix(coding): enrich edit / multi_edit errors with locations + narrow-read hints`
- 回填 commit（本地未发布）: `4423e0d fix(coding): restore information-carrying detail in edit/multi_edit error messages (bundled for v0.7.27)`
- 相关文件: `packages/coding/src/tools/{edit,multi-edit,registry}.ts` + 对应 `*.test.ts`
- 原 review 建议（要求"少 token"）：v0.7.26 发布前对话上下文

---

### 120: Skill / Plan-mode 调用路径下流式注入 prompt 失效 — `canQueueFollowUps` 未开启

- **Priority**: High
- **Status**: Open
- **Introduced**: 一直存在（自 v0.6.0 引入队列功能起，非主对话路径就未接入）
- **Fixed**: -
- **Created**: 2026-04-20

- **Update 2026-05-04 (FEATURE_110, v0.7.34)**: plan-mode 路径 1 已整体删除（`runWithPlanMode` / `/plan` slash 命令 / `[planMode, setPlanMode]` state 全部移除），本 issue 现仅剩 skill / prompt 调用一条路径。skill 路径已在 v0.7.24 (Issue 121) 顺手补了 `setCanQueueFollowUps(true)` 包裹（[InkREPL.tsx:6237-6239](../packages/repl/src/ui/InkREPL.tsx#L6237-L6239)），需独立验证是否完全闭合。

- **Original Problem**:

  用户通过 `/skill:...`（例如 `/skill:smart-changelog`）或 plan-mode（已于 v0.7.34 删除）触发 agent 执行期间，在流式过程中按 Enter 想排队追加下一条 prompt，会出现：

  - 输入栏字符被吞（由 [prompt-input-controller.ts:251-252](../packages/repl/src/ui/utils/prompt-input-controller.ts#L251-L252) 无条件 `clear()` 导致）
  - 底部 `QueuedCommandsSurface` 无排队提示
  - 输入栏占位符显示 `Agent is busy...`（不是 `Queue a follow-up...`）

  按占位符映射 [surface-liveness.ts:66-71](../packages/repl/src/ui/view-models/surface-liveness.ts#L66-L71)：`busy` = `isLoading=true` + `canQueueFollowUps=false`。证实 `handleSubmit` 在 [InkREPL.tsx:5849](../packages/repl/src/ui/InkREPL.tsx#L5849) 的 `if (!canQueueFollowUps) return;` 命中，输入被静默丢弃。

- **Context**:

  **三条"agent 执行"路径，只有一条开启队列**：

  | 入口 | 调用 | `canQueueFollowUps` |
  |---|---|---|
  | 普通对话（[InkREPL.tsx:6518](../packages/repl/src/ui/InkREPL.tsx#L6518)） | `runQueueableAgentSequence` → 内部 `setCanQueueFollowUps(true)` | ✅ true |
  | Skill / prompt 调用（[InkREPL.tsx:6349](../packages/repl/src/ui/InkREPL.tsx#L6349) → `executeInvocation` 内 [:5763](../packages/repl/src/ui/InkREPL.tsx#L5763)） | 直接 `runAgentRound` | ❌ false |
  | Plan mode（[InkREPL.tsx:6466](../packages/repl/src/ui/InkREPL.tsx#L6466)） | 直接 `runWithPlanMode` | ❌ false |

  另有 `executeInvocation` 内的 plan-mode 子分支（[InkREPL.tsx:5749-5753](../packages/repl/src/ui/InkREPL.tsx#L5749-L5753)）同样未接入。

  **为什么 v0.7.22/v0.7.23 才被察觉**：代码路径一直是这样。用户升级后开始频繁使用 `/skill:` 命令（如 `smart-changelog`），才撞上这个一直存在的盲区。queue 代码本身自 v0.7.20 未变。

  **另有一条独立路径**（同 issue 另一病灶，当 `isLoading=false` 但屏幕仍在流式时）尚未完全复现，需后续追查——本 issue 先闭合可确诊的这一条。

- **Planned Resolution**: **B-全（修"不丢 + 自动续"）**

  **方向**：不做 v0.7.30/v0.8.0 预告的"REPL substrate 重写"（那是大工），只在 skill / plan-mode 两条旁路上**对齐普通对话路径的队列语义**：

  1. 流式期间允许入队（`canQueueFollowUps=true`）
  2. 本轮结束后自动 drain 队列，每条作为后续对话轮执行

  **改动点**（约 30 行集中在 [InkREPL.tsx](../packages/repl/src/ui/InkREPL.tsx)）：

  1. **新增 helper `drainPendingInputsAsFollowUps`**（紧邻 `runQueueableAgentSequence` 之后）
     - 从 `streamingState.pendingInputs` 取第一条
     - 通过 `stageQueuedPrompt` 补 UI 前置
     - 调 `runQueueableAgentSequence` 用这条作 initialPrompt，它内部会 drain 后续所有

  2. **包一层 `setCanQueueFollowUps(true)` / `finally` `setCanQueueFollowUps(false)` 到 `executeInvocation`**
     - 现有 try/catch 结构保留
     - 外层 finally 关闸
     - 正常返回路径后调 `drainPendingInputsAsFollowUps`；抛错路径不 drain（队列保留到用户下一次提交时 drain，与主路径失败行为一致）

  3. **同样模式应用到 handleSubmit 的 plan-mode 分支**（[InkREPL.tsx:6459-6500](../packages/repl/src/ui/InkREPL.tsx#L6459-L6500)）
     - 在 `setIsLoading(false)` 之前 drain，保证 drain 期间仍有 loading 状态

  **不做的事**（刻意保持边界窄）：
  - 不碰 `runQueueableAgentSequence` 本身
  - 不改 `handleSubmit` 的主结构
  - 不碰 `runAgentRound` / task-engine / 任何 coding 层代码
  - 不做 plan-mode-aware drain（drained follow-ups 走普通 agent round，与主路径一致）

  **与 v0.7.30/v0.8.0 roadmap 的关系**：FEATURE_055 "REPL Substrate Hardening" 会重写整个 submit / queue / surface 层。本补丁是"**撑到 v0.7.30**"的战术修复——集中在两处 wrapper，届时随 InkREPL 被抽薄自然被 prune。

  **测试**：
  - 人工 e2e：`/skill:smart-changelog` 流式中按 Enter → 底部排队提示出现 → 命令结束后自动跑该 prompt
  - plan-mode 同路径验证
  - 回归：`packages/repl/src/ui/utils/queued-prompt-sequence.test.ts` 仍绿（不动 sequence 核心）

---
### 119: Scout 升级 H0→H1 后残留 pre-Scout mutationSurface — Generator 被错误锁为 docs-only

- **Priority**: High
- **Status**: Open
- **Introduced**: v0.7.20（结构性遗留，v0.7.20 修复了 harness/ceiling 两条残留通道后暴露）
- **Fixed**: -
- **Created**: 2026-04-19

- **Original Problem**:

  Scout 把任务从 H0 升级到 H1 后，Generator 的系统提示仍带着 `This H1 run is docs-only. Restrict any edits to documentation artifacts.` 这种约束，导致 Generator 看到用户明确要求（例如"补测试"、"把完成状态挪到对应版本"）也不敢修改测试文件或代码，只能改文档。真实会话中出现过：用户要求补测试 + 同步 FEATURE_LIST.md + 调整版本归属，Scout 已升级到 H1，Generator 仍只做了文档侧编辑、跳过测试。

  本质是 `plan.decision.mutationSurface` 这个字段**同时承担了两个语义**：
  1. Scout **前**：正则启发（`deriveMutationSurface` on original prompt）推出的粗糙上界，给 Scout 当参考
  2. Scout **后**：下游 Generator / fan-out scheduler 读来判断"允许改动面"

  Scout 可以覆盖 `confirmedHarness`（commit `3efdb7b` 已修 clamp bug）和 `upgradeCeiling`（commit `fa4708f` 已修 evaluator 读旧 ceiling），但 `mutationSurface` 从没被 Scout 覆盖过的渠道——升级后仍然是 pre-Scout 的正则残留值。这是"升级后残留"这条主线 bug 的第三条通道。

- **Context**:

  **触发路径**：
  - [packages/coding/src/reasoning.ts:2275](../packages/coding/src/reasoning.ts#L2275) — `deriveMutationSurface` 基于原始 prompt 文本做正则匹配，把 `plan.decision.mutationSurface` 初始化为 `docs-only` 等值
  - [packages/coding/src/task-engine.ts:951-1011](../packages/coding/src/task-engine.ts#L951-L1011) — `applyScoutDecisionToPlan` 只同步 `harnessProfile` 和 `upgradeCeiling`，**从不触碰** `mutationSurface`
  - [packages/coding/src/task-engine.ts:3096-3104](../packages/coding/src/task-engine.ts#L3096-L3104) — Generator 的 `h1MutationGuardance` 读 `decision.mutationSurface`，看到旧的 `docs-only` 就把 Generator 锁死

  **相关下游读点**（同样读 pre-Scout 残留值）：
  - [task-engine.ts:1743-1744](../packages/coding/src/task-engine.ts#L1743-L1744) — fan-out scheduler 判 read-only/docs-only
  - [task-engine.ts:2567, 2578](../packages/coding/src/task-engine.ts#L2567-L2578) — `createRolePrompt` 的 H1 分支
  - [task-engine.ts:2915](../packages/coding/src/task-engine.ts#L2915) — 元数据打印
  - [task-engine.ts:3401](../packages/coding/src/task-engine.ts#L3401) — 传给 `createRolePrompt`

  **相关已修复 commits**（同类 bug 的另外两条通道）：
  - `3efdb7b fix(task-engine): trust Scout routing authority, fix ceiling clamp context-loss bug`
  - `fa4708f fix(task-engine): evaluator prompt uses effective ceiling, not stale heuristic`

  这两个 commit 修了 harness/ceiling 的残留，但漏了 `mutationSurface`。本 issue 闭合最后一条通道。

- **Planned Resolution**:

  **方向**：单一真理源 + 轻推断。不加新字段、不加 validator、不加 retry、不改 Scout prompt。让下游停止信任 Scout 前的启发式字段，改读 Scout 自己的结构化输出。

  **为什么不走"让 Scout 多声明一个字段 + 升级时强制要求"路线**：
  - 违背 KodaX 极简 + 智能哲学，把"LLM 该自己判断"的事变成"schema 枷锁 + retry 循环"
  - 反而把 bug 换方向：未声明时如果 auto-relax 到 `code`，纯 review 任务又会被错误放开
  - Scout 的 `scope` / `reviewFilesOrAreas` / `primaryTask` 已经携带了比"一个 enum 值"更精确的意图信息，不需要再加一个冗余字段

  **具体改动**（半天量）：

  1. **新增纯函数 `inferScoutMutationIntent(scout, primaryTask)`**（约 20 行）
     返回三档：`'review-only'` / `'docs-scoped'` / `'open'`
     - `primaryTask === 'review'` 且 `scope` 为空 → `review-only`
     - `scope ∪ reviewFilesOrAreas` 全部匹配 `*.md`/`docs/`/`CHANGELOG` 等文档路径 → `docs-scoped`
     - 其它 → `open`（默认开放，信任 Scout scope + Evaluator 兜底）

  2. **替换 [task-engine.ts:3096-3104](../packages/coding/src/task-engine.ts#L3096-L3104) 的 `h1MutationGuardance`**
     改读 Scout 的 directive 而非 `decision.mutationSurface`；语气从"restrict/do not mutate"改成"unless ... asks for fixes"的软引导；`open` 档不加任何约束

  3. **迁移或删除另外 4 处下游读点**
     [task-engine.ts:1743-1744, 2567, 2578, 3401](../packages/coding/src/task-engine.ts) — 或迁移到同一推断，或直接删除该分支（依赖 Scout scope + Evaluator 作为自然约束）
     [task-engine.ts:2915](../packages/coding/src/task-engine.ts#L2915) 元数据打印保留，但改为打印 Scout 推断结果

  4. **保留不动的东西**
     - `KodaXManagedScoutPayload` 结构、Scout prompt、validator、parser、persistence schema 全部不动
     - `plan.decision.mutationSurface` 字段本身保留（`reasoning.ts` 内部仍用它推 `topologyCeiling`），只是**下游 H1+ 路径不再读它**
     - `applyScoutDecisionToPlan` 不动（或仅加一条 routing note 声明"下游已走推断"）

  5. **测试**
     - `inferScoutMutationIntent` 纯函数单测（3 档各 1-2 例）
     - 3 个核心回归（task-engine.test.ts）：
       * Scout H0→H1 升级 + 原启发式为 `docs-only` → Generator prompt 不再含"docs-only"字样
       * Scout H1 review 任务（scope 空）→ Generator prompt 含 review-only 软引导
       * Scout H1 纯文档任务（scope 全 .md）→ Generator prompt 含 docs-scoped 软引导
     - 手工 e2e：重跑触发此 bug 的那类 docs + tests 组合任务，确认 Generator 能改 test 文件

  **风险与代价**：
  - Scout `scope` 描述粒度粗时（如 `packages/coding/src`），`isDocsLikePath` 会判失败，推断落 `'open'` → 这是正确行为，不算退化。极简原则下信任 Scout scope 本身 + Evaluator 兜底，不要硬收紧
  - 现有依赖 `decision.mutationSurface === 'docs-only'` 的测试会需要更新（因为下游不再读它）——这反映的是语义修复，不是回归

  **为什么不选其他方案**：
  - ❌ Scout payload 新增 `confirmedMutationSurface` + fail-loud retry：违背极简哲学，加枷锁；retry 烧 token 且体验不自然；弱模型缺省会频繁失败
  - ❌ Scout 升级未声明时 auto-relax 到 `code`：方向错了，会把纯 review 任务错误放开，比现状还危险
  - ❌ 拆 `heuristicMutationSurface` / `mutationSurface` 双字段：结构上更干净，但 7+ 处读点要迁移 + 持久化 schema 扩字段 + 旧快照迁移，scope 太大，收益被推断方案覆盖
  - ❌ 只做最小补丁（Scout 覆盖时同步清 `mutationSurface`）：治标不治本，下次再有"Scout 前 vs Scout 后"冲突字段还会复发

---
### 112: ask_user_question 交互机制不完备 — 数字编号歧义 + 缺少 input/multiSelect 模式 (RESOLVED)

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.18
- **Fixed**: v0.7.62
- **Created**: 2026-04-12
- **Resolved**: 2026-07-06

- **Original Problem**:

  `ask_user_question` 的 Select 对话框存在两个根本性缺陷：

  **缺陷 1 — 数字编号歧义（当前最严重的体验问题）**

  KodaX Select 使用"输入数字编号 + 按 Enter"选择方式（`InkREPL.tsx` L4152-4196）。当 LLM 的文字输出中也包含编号列表时（如 smart-changelog 列出的步骤 1-6），用户会混淆"步骤编号"和"选项编号"：

  ```
  [LLM 的文字输出]
  步骤 1: Update CHANGELOG.md
  步骤 2: Sync version
  步骤 3: Create Git Tag
  ...

  [Select 对话框]
  1. 步骤 1,2,3      ← 用户以为按 1 = 选步骤 1
  2. 步骤 1,2,3,4    ← 用户按 2 以为 = 选步骤 2，实际选了这个组合
  3. 全部执行
  ```

  Claude Code 使用**上下箭头导航 + Enter 确认**模式（`CustomSelect/use-select-navigation.ts`），聚焦项显示 `❯` 指针，完全避免了数字编号歧义。

  **缺陷 2 — 缺少 input 和 multiSelect 模式**

  KodaX `ask_user_question` 只有单选列表一种交互模式。Claude Code 提供三种：
  - **单选**（默认）：上下导航 + Enter
  - **multiSelect**：空格键切换选中/取消，✓ 标记已选项，Enter 提交全部选择
  - **input 类型选项**：Tab 键展开自由文本输入，用户可输入任意内容

  缺少后两种模式导致：组合选择场景（如 "选择步骤 1,3,5"）LLM 被迫将组合打包为预设选项；用户无法自行输入任意组合。

- **Context**:

  **KodaX 现有实现**：
  - 工具定义：`packages/coding/src/tools/registry.ts` L420-462 — `required: ['question', 'options']`
  - 工具实现：`packages/coding/src/tools/ask-user-question.ts` — 始终走 `ctx.askUser()` → Select 路径
  - REPL Select 交互：`packages/repl/src/ui/InkREPL.tsx` L4152-4196 — 数字输入 + Enter
  - UI 已有 Input 对话框：`showInputDialog()` 支持自由文本 + 默认值，但 `ask_user_question` 无法触发

  **Claude Code 参考实现**（`C:\Works\claudecode`）：
  - `CustomSelect/use-select-navigation.ts` — 基于 reducer 的焦点管理，支持 up/down/pageUp/pageDown
  - `CustomSelect/use-select-input.ts` L241-282 — 数字键快捷选择（可通过 `disableSelection: 'numeric'` 禁用）
  - `CustomSelect/select-option.tsx` — `ListItem` 渲染：`❯` 聚焦指针 + `✓` 选中标记
  - `AskUserQuestionTool.tsx` L19-23 — schema 包含 `multiSelect?: boolean`
  - `use-multiple-choice-state.ts` — 完整的多问题 + 多选状态管理
  - `keybindings/defaultBindings.ts` L319-330 — Select 上下文绑定：up/down/j/k/enter/escape/space

  **影响范围**：所有需要自由文本/组合输入的 skill（smart-changelog, monorepo version-strategy 等）

- **Planned Resolution**:

  **分两阶段实施，第一阶段解决最紧迫的数字歧义问题：**

  **Phase 1：Select 从数字输入改为上下导航（高优先级）**

  将 Select 对话框从"输入数字编号"改为 Claude Code 风格的"上下箭头导航 + Enter 确认"：

  1. **DialogSurface 渲染层**：
     - 选项不再显示 `1. xxx`，改为 `❯ xxx`（聚焦项）/ `  xxx`（非聚焦项）
     - 追踪 `focusedIndex` 状态，随箭头键更新
     - 选中项右侧显示 `✓`

  2. **Keypress handler 改造**（`InkREPL.tsx` L4152-4196）：
     - `↑` / `k` → 上移焦点
     - `↓` / `j` → 下移焦点
     - `Enter` → 确认当前聚焦项（替代数字 + Enter）
     - `Escape` → 取消
     - 数字键保留为**快捷键**直接选中（按 `2` 直接确认第 2 项，不需再按 Enter），但不是主交互方式

  3. **Select 状态提升**：将 `focusedIndex` 加入 `uiRequest` state，让 DialogSurface 能渲染焦点指针

  这一步完全消除数字编号歧义——用户通过视觉焦点指针明确知道选的是哪一项。

  **Phase 2：新增 multiSelect + input 模式（中优先级）**

  1. **multiSelect 模式**：
     - `ask_user_question` schema 新增 `multiSelect?: boolean`
     - 空格键切换当前聚焦项的选中/取消，`✓` 标记已选项
     - Enter 提交所有已选项，返回逗号分隔的 value 列表
     - 解决"选择步骤组合"场景，用户按空格自由勾选任意步骤

  2. **input 模式**：
     - `ask_user_question` schema 新增 `kind?: "select" | "input"`
     - `kind: "input"` 时走 `showInputDialog(question, default)`
     - 用户可自由输入任意文本（如 "1,3,5" 或 "all"）
     - `options` 在 input 模式下变为可选

  3. **返回格式**：
     - 单选：`{"success": true, "choice": "selected_value"}`
     - 多选：`{"success": true, "choice": "value1, value2, value3"}`
     - 输入：`{"success": true, "choice": "<用户自由输入>"}`

  具体改动文件：
  - `packages/repl/src/ui/components/DialogSurface.tsx` — 渲染焦点指针 + 选中标记
  - `packages/repl/src/ui/InkREPL.tsx` — keypress handler 改造 + multiSelect/input 路由
  - `packages/coding/src/tools/registry.ts` — schema 增加 `multiSelect`, `kind`
  - `packages/coding/src/tools/ask-user-question.ts` — 按 kind/multiSelect 分流
  - `packages/coding/src/types.ts` — `AskUserQuestionOptions` 增加新字段

  **为什么不选其他方案**：
  - ❌ 只加 input 模式不改 Select：不解决数字歧义根因，单选场景仍有问题
  - ❌ 只改 skill prompt：无法解决工具能力缺失，LLM 仍被迫打包组合
  - ❌ 全量复刻 Claude Code CustomSelect 组件：过度工程化，KodaX 的 Ink 版本和组件体系不同

#### Resolution (v0.7.62)

- `ask_user_question` now supports `kind: "input"` for free-text answers, with
  cancellation surfaced through the standard cancelled-tool result.
- Select questions now support `multi_select`, `min_selections`, and
  `max_selections`; unsatisfiable bounds are rejected before opening a dialog.
- Choice dialogs now allow a host-provided custom input option by default
  (`allow_custom_input: false` opts out), with custom answers normalized into
  `choice` / `choices` plus `custom_inputs` metadata.
- The agent-layer interaction contract models custom input answers with a typed
  sentinel (`ASK_USER_CUSTOM_INPUT_SIGNAL`) instead of overloading normal option
  values.
- The REPL routes custom choice answers through the existing input dialog and
  supports focused single-select / multi-select submission, preserving
  backward-compatible string and string-array host returns.

#### Files Changed

- `packages/agent/src/runtime/user-interaction.ts`
- `packages/coding/src/tools/ask-user-question.ts`
- `packages/coding/src/tools/tool-definitions.ts`
- `packages/coding/src/types.ts`
- `packages/repl/src/ui/InkREPL.tsx`
- `packages/repl/src/ui/utils/ask-user.ts`
- `tests/ui/ask-user.test.ts`
- `packages/coding/src/tools/ask-user-question.test.ts`

#### Tests Added / Run

- `npm test -- packages/coding/src/tools/ask-user-question.test.ts tests/ui/ask-user.test.ts`
- `npm test -- tests/tracker-consistency.test.ts tests/memory-prompt-injection.test.ts`

---


### 118: esbuild 打包替代 tsc 直接运行 — 消除运行时模块开销与 React dev 模式

- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.7.19
- **Created**: 2026-04-17

- **Original Problem**:

  KodaX 使用 `tsc` 编译 + `tsx`/`node` 直接运行，没有 bundling。这导致：

  1. **React development 模式默认加载**：`process.env.NODE_ENV` 在运行时检查，React 加载 `react-reconciler.development.js`。开发模式每次 render 创建 PerformanceMeasure 和 prop diff 追踪对象（heap snapshot 确认每轮 +20万个 string、+54万个 Array、+6万个 PerformanceMeasure），永不释放。当前通过 `--require ./scripts/production-env.cjs` 设 NODE_ENV 绕过，但不如编译期替换干净。
  2. **Source map 字符串占 ~10MB**：tsx 将 source map 以 `data:application/json;base64,...` 内联到内存。
  3. **模块加载 baseline ~85MB**：每个 `.js` 文件是独立模块，V8 维护模块元数据。
  4. **Tiktoken BPE 数据 4 份副本**、**React reconciler 2 份**：模块被多次解析。

  Claude Code 通过 esbuild/Bun bundler 在编译期 `define: { 'process.env.NODE_ENV': '"production"' }` 彻底消除 development 分支，单文件部署，baseline 显著降低。

- **Proposed Fix**:

  使用 esbuild 打包，编译期替换 NODE_ENV，tree-shake 无用代码，合并模块，外置 source map。预期 baseline 从 85MB 降至 40-50MB，同时消除对 `--require` preload 的依赖。

  注意事项：需处理 Node.js 原生模块 external、动态 import（skill 加载、MCP provider）、打包后回归测试。

---


### 110: 缺少 /mcp status 和 /mcp refresh REPL 命令

- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.7.16
- **Fixed**: -
- **Created**: 2026-04-11

- **Original Problem**:
  用户无法在 REPL 中查看 MCP 连接状态（哪些 server 连接成功、哪些失败、catalog 有什么工具），也无法手动刷新 catalog。只能从 prompt context 间接看到 status=idle/ready/error。

- **Context**: 涉及 `packages/repl/src/interactive/commands.ts`。调用 `extensionRuntime.getDiagnostics()` 和 `refreshCapabilityProviders()`。

- **Planned Resolution**: 在 FEATURE_065 范围内添加 `/mcp` 命令（status 子命令 + refresh 子命令）。

---


### 107: harnessProfile 类型命名残留 - H0/H1/H2 应替换为 worker-chain composition

- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.7.16
- **Fixed**: -
- **Created**: 2026-04-11

- **Original Problem**:
  FEATURE_061 移除了预 Scout 状态机和 Tactical Flow，但 `harnessProfile: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL'` 类型命名残留在 237 处引用、10 个文件中。这些名字编码的是"哪个预设配置"的思维，而 FEATURE_061 后系统实际运作方式是"Scout 决定需要哪些角色"。

- **Context**:
  `harnessProfile` 字段在以下位置被广泛使用：
  - `types.ts`（5 处）：类型定义
  - `reasoning.ts`（29 处）：路由决策
  - `task-engine.ts`（106 处）：核心引擎
  - `provider-policy.ts`（4 处）：provider 策略
  - `agent.ts`（1 处）：agent 层
  - 各测试文件（~90 处）

  当前 `harnessProfile` 实际上只是一个 worker chain 的标签：
  - `H0_DIRECT` → `[scout]`
  - `H1_EXECUTE_EVAL` → `[generator, evaluator]`
  - `H2_PLAN_EXECUTE_EVAL` → `[planner, generator, evaluator]`

  `buildManagedTaskWorkers` 已经在做 worker chain 映射，harnessProfile 只是触发条件。

- **Planned Resolution**:
  1. 在 `KodaXTaskRoutingDecision` 中用 `workerChain: KodaXTaskRole[]` 替代 `harnessProfile`
  2. 保留 `harnessProfile` 作为 derived label（向后兼容导出类型）
  3. 内部路由逻辑改为基于 `workerChain` 而非 `harnessProfile`
  4. 逐步更新 237 处引用

- **Workaround**: 无需 workaround，当前命名不影响功能正确性。

---
### 106: Managed-task structured worker blocks remain text-coupled and can fail closed on protocol drift
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.7.14
- **Fixed**: -
- **Created**: 2026-04-08

- **Original Problem**:
  Managed-task workers still depend on long visible prose that ends with fenced protocol blocks such as
  `kodax-task-scout`, `kodax-task-contract`, `kodax-task-handoff`, and `kodax-task-verdict`.

  In practice, minor protocol drift can still break orchestration:

  1. evaluator verdicts can be rejected when structured output drifts
  2. planner / scout / handoff blocks can still fail closed on formatting variations
  3. missing protocol blocks can produce blocked runs even when visible content is otherwise useful
  4. malformed worker output can push too much raw text into failure paths, artifacts, or session memory

- **Context**:
  This issue is broader than a single evaluator bug. It is a protocol-layer reliability issue across all managed workers.
  The recent `missing kodax-task-verdict` crash / OOM chain exposed the highest-severity symptom, but the same text-coupled
  design exists for planner, scout, and handoff blocks too.

- **Planned Resolution**:
  Resolve in phases under `FEATURE_059 Managed Task Structured Protocol V2`:

  1. harden all managed parsers to accept the last valid block, JSON variants, and common field aliases
  2. keep protocol-failure UI compact while persisting raw artifacts separately
  3. move toward a dual-track model with separate `visibleText` and `protocolPayload`
  4. eventually let evaluator act as a structured verdict producer instead of relying on a prose-tail block

---


### 082: packages/llm 缺少单元测试
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.5.21
- **Created**: 2026-03-08

- **Original Problem**:
  `packages/llm` 已经补上了一批 provider / reasoning 相关单元测试，但覆盖仍不完整。当前 issue 已从“完全没有单元测试”收敛为“关键基础层测试覆盖仍然偏薄”。

  当前仍需继续补齐的模块：
  - `providers/base.ts` - Provider 基类行为与回退链
  - `providers/registry.ts` - Provider 注册、配置状态与默认快照
  - `providers/gemini-cli.ts` - Gemini CLI 凭证提取和桥接边界
  - `providers/codex-cli.ts` - Codex CLI 凭证提取和桥接边界
  - `providers/anthropic.ts` / `providers/openai.ts` - 更贴近真实 stream 执行路径的契约测试

- **Expected Behavior**:
  - 测试覆盖率应达到 80%+
  - 至少覆盖：凭证提取、消息转换、SSE 解析、错误处理

- **Impact**: 中等
  - 无法保证代码质量和回归测试
  - 重构时容易引入 bug
  - 新增 provider 时缺乏参考模式

- **Current Coverage**:
  - 已有测试：`reasoning-overrides.test.ts`
  - 已有测试：`providers/anthropic-message-serialization.test.ts`
  - 已有测试：`providers/anthropic-reasoning-capability.test.ts`
  - 已有测试：`providers/capability-profile.test.ts`
  - 已有测试：`providers/openai-reasoning-capability.test.ts`
  - 已有测试：`providers/streaming-robustness.test.ts`

- **Context**:
  - 项目全局测试覆盖要求见 `~/.claude/rules/common/testing.md`
  - IMPROVEMENT_CLI_PROVIDERS.md 中也提到了此问题 (P0)

- **Phase 1 Progress (2026-03-23)**:
  - 新增 `providers/base.test.ts`
  - 新增 `providers/registry.test.ts`
  - 新增 `providers/cli-bridge-providers.test.ts`
  - 问题仍保持 Open，后续继续补 CLI bridge 与真实 provider stream 契约测试

- **Proposed Solution**:
  1. 创建 `tests/providers/` 目录
  2. 为每个 provider 创建测试文件
  3. 优先覆盖关键路径：认证、消息转换、流式响应解析
  4. 使用 mock 避免真实 API 调用

---


### 091: 缺少一等公民 MCP / Web Search / Code Search 工具体系 (OPEN)
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.6.10
- **Created**: 2026-03-18

- **Original Problem**:
  KodaX 当前 runtime 仍主要依赖本地文件工具和 shell。对于 MCP、web search、web fetch、code search 这类现代 coding agent 的核心工具族，尚未提供一等公民的结构化实现，导致很多任务只能退回到 bash 或外部 CLI，削弱了安全性、可解释性和产品竞争力。

- **Expected Behavior**:
  - KodaX 应提供结构化、可授权、可归因的 MCP / search / retrieval 工具
  - 外部证据和代码探索结果应具备统一的数据模型和权限边界
  - 研究型与验证型任务不应过度依赖临时 shell 命令

- **Context**:
  - `packages/coding/src/tools/`
  - `packages/repl/`
  - `README.md` 当前能力声明

- **Root Cause**:
  1. 早期优先完成了本地读写与 project workflow
  2. 尚未建立统一的 connector / retrieval abstraction
  3. 尚未建立 evidence-carrying result model

- **Proposed Solution**:
  - 实施现有 `FEATURE_035 MCP 能力 Provider`
  - 实施现有 `FEATURE_028 First-Class 搜索检索与证据工具`
  - 以 `FEATURE_034 Extension + Capability Runtime` 作为连接器与能力运行时底座

---

### 092: Team 模式已暴露但原生多 Agent 架构仍未闭环 (OPEN)
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.6.10
- **Created**: 2026-03-18

- **Original Problem**:
  KodaX 已经在 CLI 层暴露了 `--team` 和 orchestration 能力，但产品层面仍缺少原生 subagent 角色模型、权限边界、任务路由、证据聚合和与 project truth 的深度集成。当前能力更像并行 runner，而不是成熟的多 Agent 产品。

- **Expected Behavior**:
  - 多 Agent 能力应具备明确的角色语义、状态聚合和 review 边界
  - Team 模式应与 Session Tree、Project Harness、feature truth 协同工作
  - CLI 暴露的能力边界应与真实产品成熟度一致

- **Context**:
  - `src/kodax_cli.ts`
  - `packages/coding/src/orchestration.ts`
  - `docs/FEATURE_LIST.md` 中的 `FEATURE_022`

- **Root Cause**:
  1. 已具备 orchestration plumbing，但 subagent product model 尚未完成
  2. 缺少共享 evidence model 和 role-aware execution layer
  3. 当前 Team mode 仍未与后续 session / harness 体系完全打通

- **Proposed Solution**:
  - `FEATURE_067 Parallel Task Dispatch` (v0.7.18) 作为最小可用切片：Scout 识别可并行子任务 → `runOrchestration` 并行派发 → 聚合结果
  - 完整的 Team Agent 架构 (角色语义/状态聚合/review 边界) 留 v0.8.0 与 FEATURE_059 (Protocol V2) 同版本

---

### 093: 缺少 IDE / Desktop / Web 一体化分发表面 (OPEN)
- **Priority**: Low (2026-04-11 降级: Vibe Coding 时代 terminal 是主入口，IDE Bridge 非关键)
- **Status**: Open
- **Introduced**: v0.6.10
- **Created**: 2026-03-18

- **Original Problem**:
  KodaX 当前主要提供 terminal 与 library 形态，缺少 IDE、desktop、web 等分发表面，因此无法很好承载文件上下文注入、可视化 diff review、远程长任务监控和跨设备会话接力等场景。

- **Expected Behavior**:
  - 至少应具备一个 IDE integration、一个 desktop review surface 和一个 remote / web long-running task surface
  - 不同表面之间应共享同一引擎、session 和 project context

- **Context**:
  - `README.md`
  - `packages/repl/`
  - 当前仓库中缺少对应 app / sdk surface 目录

- **Priority Downgrade Rationale (2026-04-11)**:
  基于 KodaX vs Claude Code 全面对比分析，IDE Bridge 的优先级从 Medium 降级为 Low：
  1. Vibe Coding 范式下对话终端是主入口，不是 IDE 编辑器
  2. KodaX 已有 terminal host 检测 (FEATURE_051)，在 VSCode 集成终端中可正常工作
  3. Cursor/Windsurf/Copilot 已占领 IDE 原生 AI 赛道，KodaX 的核心差异化 (AMA/多 Provider/Repo Intelligence) 全部是 CLI-native
  4. 建 IDE bridge 是高成本低差异化投入 (Claude Code 的 bridge 有 25+ 文件)

- **Root Cause**:
  1. 研发重心长期集中在 CLI 与 project workflow
  2. 缺少统一的 surface protocol 与 session handoff layer
  3. 尚未形成跨表面的产品抽象

- **Proposed Solution**:
- 长期目标：实施 `FEATURE_030 Multi-Surface Delivery`
- 短期：依赖 terminal host 检测 + IDE 集成终端作为分发面
- 在 terminal UX 和 multi-agent 基础稳定后再评估是否需要原生 IDE 集成

---

### 094: 核心工作流文件与函数过大，职责耦合导致重构成本持续上升 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  经本轮逐条核对后确认，仓库里仍有多处核心 runtime 文件与主函数承担了过多职责，已经明显超出“单点修补”可持续维护的范围。相关代码同时混合了参数解析、状态推进、权限判断、会话保存、工具调度、provider 适配与 UI / harness 协调，导致回归风险高、修改面大、代码评审成本持续上升。

- **Expected Behavior**:
  - 核心工作流应按职责拆分为可单测、可替换的子模块
  - 入口函数应主要负责编排，不应同时承担解析、执行、持久化和展示细节
  - handler / evaluator 层应具备清晰的输入输出类型边界

- **Context**:
  - `packages/repl/src/interactive/project-commands.ts`
  - `packages/repl/src/interactive/project-harness.ts`
  - `packages/coding/src/repo-intelligence/query.ts`
  - `src/kodax_cli.ts`
  - `packages/coding/src/agent.ts`
  - `packages/coding/src/reasoning.ts`
  - `packages/llm/src/providers/anthropic.ts`
  - `packages/llm/src/providers/openai.ts`

- **Source Debt IDs**:
  - `C5`, `C6`, `H1`, `H2`, `H3`, `H4`, `H5`, `H6`, `H7`, `H8`, `H9`, `H10`

- **Root Cause**:
  1. 功能长期沿着现有入口持续堆叠，缺少阶段性模块化回收
  2. 运行时状态与副作用分布在同一层，导致拆分边界不清晰
  3. 项目 workflow、REPL runtime 与 provider stream 演进速度不一致，最终集中在少数超大文件中

- **Proposed Solution**:
  - 先从 `project-commands.ts`、`project-harness.ts`、`kodax_cli.ts` 开始按职责拆分
  - 把 `agent.ts` 的执行编排继续下沉到独立 helper / service 层
  - 为 provider `stream()` 拆出 event parsing、delta normalization、tool result serialization 等子模块

---

### 095: Agent / REPL 主流程仍存在重复编排与手写运行时流程 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  虽然本轮已经消掉了一部分重复逻辑，但 agent 与 REPL 主流程里仍残留多段手写的执行编排代码，包括 reroute、权限前置、会话保存、git / shell 调度和直接修改运行时上下文的路径。它们在行为上高度相关，却没有统一抽象，后续继续演进时很容易再次漂移。

- **Expected Behavior**:
  - 相同语义的运行时流程应复用统一 helper，而不是在多个入口重复实现
  - 会话持久化、权限执行、reroute 策略和错误分类应集中在清晰的边界层
  - REPL context 更新应通过收敛后的状态接口完成，而不是在多处直接改写字段

- **Context**:
  - `packages/coding/src/agent.ts`
  - `packages/repl/src/interactive/repl.ts`
  - `packages/coding/src/reasoning.ts`
  - `packages/coding/src/prompts/builder.ts`

- **Source Debt IDs**:
  - `H38`, `H39`, `H40`, `H41`, `H44`, `M39`

- **Root Cause**:
  1. 不同入口在不同时期各自补齐了相似的 runtime 行为
  2. 会话状态与权限模型缺少统一的 façade 层
  3. 历史上更强调尽快打通功能路径，而不是抽象复用

- **Proposed Solution**:
  - 提炼统一的 permission-aware execution helper
  - 收敛 session snapshot / save / title 更新等流程到可复用 API
  - 将 reroute / git evidence / shell evidence 之类的相邻逻辑合并到单一编排层

---

### 096: 类型边界过宽且共享可变状态较多 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  当前代码库仍有一批 “先用 `any` / `unknown` / 断言打通，再在下游兜底” 的边界，以及若干共享可变状态、公共可变容器和原地修改对象的实现。这类问题短期不一定直接出错，但会削弱重构信心，也会让 provider / skills / session 相关代码更难建立稳定的类型约束。

- **Expected Behavior**:
  - 外部输入、provider 事件、skill 上下文和 registry 应尽量使用显式类型与 type guard
  - 共享状态应最小化暴露面，避免 public mutable collection 和原地修改
  - session / routing / registry 相关模型应尽量复用统一类型定义

- **Context**:
  - `packages/llm/src/providers/anthropic.ts`
  - `packages/coding/src/agent.ts`
  - `packages/coding/src/acp/pseudo-acp-server.ts`
  - `packages/skills/src/skill-registry.ts`
  - `packages/repl/src/interactive/plan-mode.ts`
  - `packages/repl/src/interactive/new-command.ts`
  - `packages/repl/src/ui/InkREPL.tsx`
  - `packages/repl/src/permission/executor.ts`

- **Source Debt IDs**:
  - `H7`
  - `H10`, `H11`, `H12`, `H13`, `H14`, `H15`, `H16`
  - `H42`, `H43`, `H44`, `H45`, `H46`, `H47`
  - `M21`, `M22`, `M23`, `M24`
  - `M6`, `M40`, `M42`, `M43`, `M44`, `M46`, `M47`, `M48`, `M49`, `M67`
  - `L22`, `L27`, `L32`, `L37`

- **Root Cause**:
  1. 多数边界最初优先保证联通性，类型建模滞后
  2. registry / session / tool runtime 各自独立演进，导致共享模型碎片化
  3. 一部分对象被默认当作可变工作区使用，没有及时收敛成不可变接口

- **Proposed Solution**:
  - 先清理 provider 与 ACP 边界的 `any` / 断言
  - 为 skill registry、session storage、routing snapshot 建立统一模型
  - 逐步把 public mutable state 改成受控 accessor 或不可变更新

---

### 097: 错误处理、阻塞式 I/O 与执行侧副作用清理仍不完整 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  一批较低风险但会持续侵蚀可观测性的技术债仍然存在，包括静默 `catch`、fire-and-forget async 路径、同步文件系统调用、执行链路里的库层 `console.*` 副作用，以及少数仍依赖 shell / editor / discovery 副作用的分支。它们不像前几批安全问题那样紧急，但会让错误更难定位，也会限制后续把运行时行为统一收口。

- **Expected Behavior**:
  - 静默吞错应仅出现在明确可接受的 best-effort 路径，并附带注释或日志策略
  - 热路径中的同步 I/O 应迁移到缓存或异步接口
  - library / loader / discovery 层应避免直接向控制台输出副作用
  - 命令执行的剩余边角路径应继续向统一执行抽象收敛

- **Context**:
  - `packages/repl/src/common/utils.ts`
  - `packages/repl/src/common/compaction-config.ts`
  - `packages/repl/src/common/permission-config.ts`
  - `packages/repl/src/interactive/plan-storage.ts`
  - `packages/repl/src/permission/permission.ts`
  - `packages/repl/src/permission/executor.ts`
  - `packages/coding/src/tools/read.ts`
  - `packages/coding/src/tools/grep.ts`
  - `packages/skills/src/discovery.ts`

- **Source Debt IDs**:
  - `H19`, `H20`, `H21`, `H22`, `H23`, `H24`, `H25`, `H26`, `H27`, `H28`, `H29`, `H30`
  - `H48`, `H51`, `H52`, `H54`, `H55`, `H58`
  - `M38`
  - `L10`, `L17`, `L23`, `L26`

- **Root Cause**:
  1. 早期实现大量依赖 best-effort fallback，缺少统一的日志/遥测约束
  2. 部分工具和 loader 仍沿用同步 I/O 以降低实现复杂度
  3. 执行层的命令、编辑器和技能发现路径没有完全统一到同一套运行时约束

- **Proposed Solution**:
  - 为允许静默失败的路径建立显式注释和统一 helper
  - 逐步替换热路径同步 I/O，并对保留的同步路径注明原因
  - 把 loader / discovery / permission 侧的 `console.*` 收敛到 logger
  - 继续收口剩余 command execution 分支到权限感知的执行抽象

- **Phase 1 Progress (2026-03-23)**:
  - `packages/coding/src/tools/read.ts` 改为基于 `fs.stat()` 的异步可访问性检查，移除了 `existsSync`
  - `packages/coding/src/tools/grep.ts` 改为异步路径探测，并为不可访问路径补充明确错误信息
  - `packages/repl/src/common/utils.ts` 为版本号与 `feature_list.json` 进度读取增加缓存，降低热路径同步 I/O 频率
  - `packages/repl/src/common/permission-config.ts`、`packages/repl/src/common/plan-storage.ts` 为保留的 best-effort 静默失败补上显式注释
  - `packages/repl/src/permission/executor.ts` 移除了临时脚本检查里的同步 `existsSync`
  - `packages/repl/src/permission/permission.ts` 为路径 canonicalization 和系统 temp 目录解析增加缓存，减少重复同步文件系统探测
  - 问题仍保持 Open，后续继续清理剩余权限路径解析同步逻辑与执行侧副作用

---

### 098: 重复 helper、兼容层导出、魔法数字与硬编码字符串需要收敛 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  经核对后仍有一批低风险但会持续制造噪音的清理项，包括重复 helper、长期保留的兼容层导出、仓库内无人消费的遗留 API、魔法数字、硬编码提示字符串，以及若干轻量级设计瑕疵。单个问题都不大，但累计起来会影响可读性，也会提高理解成本。

- **Expected Behavior**:
  - helper / utility 应优先复用而不是多处复制
  - 兼容层与 deprecated 导出应有明确退场计划
  - 算法阈值、缓存大小和提示文案应以命名常量或共享常量表达
  - 轻量级设计瑕疵应在不破坏兼容的前提下逐步收敛

- **Context**:
  - `packages/repl/src/ui/utils/message-utils.ts`
  - `packages/repl/src/ui/utils/textUtils.ts`
  - `packages/coding/src/providers/index.ts`
  - `packages/coding/src/reasoning.ts`
  - `packages/agent/src/compaction/compaction.ts`
  - `packages/skills/src/file-tracker.ts`
  - `packages/skills/src/discovery.ts`

- **Source Debt IDs**:
  - `H32`, `H33`, `H34`
  - `M3`, `M4`, `M5`, `M6`, `M7`, `M8`, `M9`, `M11`, `M12`, `M13`, `M14`, `M15`, `M17`, `M18`, `M19`, `M20`
  - `M26`, `M27`, `M28`, `M29`, `M30`, `M31`, `M32`, `M33`, `M34`, `M35`, `M36`, `M41`, `M45`, `M52`, `M53`, `M54`, `M55`, `M56`, `M58`
  - `L1`, `L2`, `L3`, `L4`, `L5`, `L6`, `L8`, `L11`, `L12`, `L13`, `L14`, `L18`, `L19`, `L20`, `L21`, `L25`, `L31`, `L33`

- **Root Cause**:
  1. 多数条目来源于兼容层保留、局部复制粘贴和快速迭代残留
  2. 一些常量原本只在局部使用，后续没有及时抽象或命名
  3. 文案、缓存和占位实现长期存在，但缺少集中清理窗口

- **Proposed Solution**:
  - 先清理无人消费的 helper / export / placeholder
  - 收敛重复字符串与阈值常量
  - 对仍需兼容保留的导出明确 deprecation 注释和删除条件

---

### 099: 测试辅助代码重复，局部验证资产需要收敛 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  除了已单独跟踪的 `082 packages/llm 缺少单元测试` 之外，当前测试资产本身也存在一批结构性债务，包括超大的测试文件、重复实现 helper、散落的 scratch / 临时验证脚本，以及若干直接依赖硬编码常量的断言。这类问题会降低新增测试的速度，也会让回归定位变得更慢。

- **Expected Behavior**:
  - 通用测试 helper 应抽到共享位置，而不是在多个测试文件内重复实现
  - scratch / 临时验证脚本应清理或迁移到明确的实验目录
  - 大测试文件应按模块拆开，覆盖目标更清晰

- **Context**:
  - `packages/repl/src/interactive/interactive.test.ts`
  - `packages/repl/src/ui/session-history.test.ts`
  - `packages/repl/src/ui/banner.test.ts`
  - `src/cli_option_helpers.test.ts`
  - `tests/kodax_core.test.ts`
  - `tests/scratch/test-retry.ts`

- **Source Debt IDs**:
  - `H12`, `H60`
  - `M10`, `M11`, `M12`, `M59`, `M60`, `M61`, `M62`, `M63`, `M65`, `M68`
  - `L28`, `L29`, `L30`

- **Root Cause**:
  1. 测试在不同阶段由不同模块各自补齐，复用层没有同步建设
  2. 临时验证资产在问题解决后没有及时回收
  3. 对测试代码的整洁度要求低于生产代码，导致债务长期累积

- **Proposed Solution**:
  - 提取共享 test helper，并拆分超大测试文件
  - 清理或迁移 `tests/scratch` 中已失效的实验资产
  - 为测试资产建立最小限度的 lint / consistency 约束

---


### 105: kodax -c 可选择空 ACP 占位 session，classic REPL 还会忽略 resume (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.14
- **Fixed**: v0.7.74
- **Created**: 2026-04-03
- **Resolved**: 2026-07-23

- **Original Problem**:
  用户报告使用 `kodax -c`（继续最近会话）后，之前的历史记录没有正常注入 LLM 上下文。
  LLM 似乎"忘记"了之前的对话内容，表现为不认识之前讨论过的内容。

- **Expected Behavior**:
  - `kodax -c` 应该自动加载当前目录最近的会话历史
  - 历史消息应该作为 `initialMessages` 注入 LLM 上下文
  - UI 应显示 `[Continuing session: xxx]` 横幅

- **Confirmed Root Cause**:
  1. `FileSessionStorage.list()` returns sessions newest-first and includes
     zero-message user-scoped records. Ink startup and the single-task
     `resolveCliTaskSessionId()` path selected element zero directly, unlike
     `kodax -s list` / bare `-r`, which already filter `msgCount > 0`.
  2. A cluster of newer empty ACP placeholder sessions could fill the default
     ten-result list, so `kodax -c` loaded an empty ACP session instead of the
     latest real conversation.
  3. The terminal-compatibility classic REPL path did not process
     `session.resume` or `session.autoResume` at startup at all.
  4. The lower-level coding-runtime CAP-043 auto-resume middleware still chose
     element zero, and classic startup did not guarantee that an explicit ID
     won when a resume flag was also present.

- **Resolution**:
  - Added one resumable-session selector shared by Ink, classic, and
    `kodax -c "prompt"`; it requests up to 1000 summaries and chooses the
    first session with `msgCount > 0`.
  - Classic startup now loads the selected session's messages, UI history,
    lineage, artifact ledger, extension state, runtime identity, title, tag,
    and session ID before creating its interactive context.
  - Ink startup now records the resolved session ID in live options as well as
    the context, keeping subsequent saves and runtime handoff explicit.
  - The coding-runtime middleware mirrors the non-empty broad-scan rule without
    depending on REPL, and explicit IDs short-circuit discovery everywhere.
  - Classic shell execution and workflow project-key derivation use the resumed
    Session's normalized execution workspace rather than the launch directory.

- **Files Changed**:
  - `packages/repl/src/session/resumable-session.ts`
  - `packages/repl/src/session/resumable-session.test.ts`
  - `packages/repl/src/interactive/repl.ts`
  - `packages/repl/src/interactive/repl-startup-session.test.ts`
  - `packages/repl/src/ui/InkREPL.tsx`
  - `packages/repl/src/index.ts`
  - `packages/agent/src/types.ts`
  - `packages/coding/src/agent-runtime/middleware/auto-resume.ts`
  - `packages/coding/src/agent-runtime/__contract-tests__/cap-043-auto-resume.contract.test.ts`
  - `src/kodax_cli.ts`
  - `docs/test-guides/ISSUE_105_v0.7.74_REGRESSION_GUIDE.md`

- **Tests Added**:
  - Resumable selection skips newer zero-message ACP placeholders and requests
    the broad 1000-session scan.
  - Classic `-c` startup loads the first non-empty conversation with its
    messages, tag, and saved workspace runtime; an explicit ID wins even when a
    resume flag is present.
  - CAP-043 direct/SDK auto-resume skips empty placeholders and requests the
    same broad scan.
  - A built-artifact probe against the affected local session store selected
    `20260722_071230` (43 messages) instead of the newest empty ACP record.

---

## Summary
- Total: 203 (34 Open, 169 Resolved, 0 Partially Resolved, 0 Won't Fix)
- Highest Priority Open: 091 - 缺少一等公民 MCP / Web Search / Code Search 工具体系 (High)
- Historical archived issues are maintained in ISSUES_ARCHIVED.md

## Changelog

### 2026-08-28: Issues 321-324 recorded (post-FEATURE_295 review follow-ups)

- Review of the 13 commits after FEATURE_295 recorded four Medium follow-ups:
  user attribution on every cancellation terminal (321), irreducible-input
  compaction resetting the summarizer breaker counter (322), quota-worded
  non-429 errors reporting as upstream errors while retrying as rate limits
  (323), and identical-stat same-file edits still collapsing to the last diff
  (324). All four are follow-up fixes; none block the 0.7.96 release.

### 2026-08-28: Issue 320 resolved (Unix pre-lock target read race)

- Unix trusted text commits derive the namespace slot without opening the
  target, then perform content and identity validation only after acquiring the
  cross-process slot lock. A peer atomic replace now yields stale instead of a
  false hard-link error; real hard links remain denied.

### 2026-08-28: Issue 319 resolved (Electron ASAR physical native artifacts)

- Packaged Electron embeds explicitly unpack KodaX native artifacts and the
  Windows ASRT runner instead of depending on virtual ASAR file metadata.
- Embedded-manifest loading maps only to an existing `app.asar.unpacked`
  sibling and retains all stable-file, bounded-read, digest, and protected-cache
  verification.

### 2026-08-27: Issue 318 resolved (allow-root ancestor ACL propagation)

- Native shell admission no longer writes traversal ACEs to private ancestors;
  persistent capability changes are exact-root only.
- Enabled Windows traverse privilege preserves reachability without widening
  ancestor content authority, and a cold `%TEMP%` shell now starts within the
  existing launch budget.

### 2026-08-27: Issue 317 resolved (hash-pinned package hardlink import)

- A package-store hardlink is accepted as an ASRT source only in bundled builds
  after a handle-bound bounded read matches the embedded release digest;
  development manifests and sources remain single-link.
- The protected executable cache remains single-link, ACL-protected, and
  hash-verified, so installation layout no longer triggers ordinary-permission
  fallback without weakening the execution boundary.

### 2026-08-27: Issue 316 resolved (concurrent Windows reader/replace race)

- Trusted text commit now holds a target delete/write reservation across final
  CAS and atomic replacement and uses compatible-reader POSIX rename semantics.
- Continuous readers observe only complete old/new revisions; an external write
  before final CAS still returns stale without overwriting the newer content.

### 2026-08-27: Issues 313-315 resolved (legacy ACL, fixed-root serialization, and native staging)

- Legacy shared-account ACEs no longer fail shell admission, removing the
  reboot/setup lockout without recursive cleanup. The account SID remains for
  required subprocess compatibility, and Issue 309 records the resulting
  explicit child-DACL authority residual.
- Fixed sensitive-root denies are native, persistent, and setup-time. Cold
  admission idempotently guards an exact sensitive directory created after
  setup, while independent command lifetimes remain parallel.
- Native artifact staging uses a short random same-directory name so a valid
  final cache path is not rejected by PowerShell 5.1's legacy path limit.

### 2026-08-27: Issue 312 resolved (dead native control request self-healing)

- Explicit Windows sandbox setup now retires only expired dead-owner request
  records and proven-drained terminal records before repairing a host-owned
  control DACL.
- Live, unexpired, malformed, unknown, and ACL-recovery records remain
  fail-closed; doctor continues to perform no repair.
- The complete real Windows policy suite now runs after a simulated drift and
  recovery without poisoning every later shell test.

### 2026-08-27: Issues 310/311 resolved (Windows text-owner and Runtime cursor self-healing)

- Trusted Windows text replacement now self-heals old/current sandbox-owned
  files into trusted-host ownership and preserves the ordered effective ACE
  policy without freezing stale inherited authority; Windows may canonicalize
  DACL protection/inheritance control at namespace commit. A legacy
  low-integrity label is normalized instead of being reapplied by a host that
  cannot safely assign it.
- Session sequence persistence no longer depends on Windows DELETE sharing;
  lock-held durable cursor writes retry transient sharing conflicts and recover
  a truncated cursor from durable event ledgers.
- Workspace-local `.kodax/runtime` is now denied to sandbox shell reads and
  writes even while the surrounding workspace remains writable.

### 2026-08-27: Issue 309 recorded (ambient trustee child-DACL boundary)

- Reproduced the Windows `WRITE_RESTRICTED` compatibility trade-off with a real
  target-created file: after an owner grants Everyone modify, a later token can
  satisfy both access-check passes without the earlier root capability.
- Rejected an inheritable OWNER RIGHTS deny after real tests proved it also
  blocks the trusted host from managing existing host-owned deny roots.
- Confirmed with real Node/cmd/PowerShell probes that the primary sandbox-user
  SID must remain alongside logon/Everyone for subprocess compatibility. Exact
  read capabilities remain, but Issue 309 stays open for all retained ambient
  trustees; trusted text tools remain outside this boundary.

### 2026-08-27: Issue 308 recorded (ASRT Windows distinct-policy proxy capacity)
- FEATURE_295 now pools one ASRT Windows network broker per exact network
  policy and sandbox-account generation inside a Runtime process, so concurrent
  same-policy shell commands no longer multiply fixed proxy-port consumption.
- ASRT 0.0.65 still provides no authenticated per-connection identity for
  routing different policies through one ingress. Distinct policies and
  Runtime processes therefore remain bounded by five simultaneous brokers in
  the ten-port range. The issue stays Open rather than weakening policy,
  widening WFP exposure, or restoring a command-lifetime serialization lock.

### 2026-08-26: Issue 307 recorded (Windows v2 upstream bootstrap boundary)
- KodaX creates every final shell target in its no-breakaway Job through the
  creation-time Job attribute, and it hardens/authenticates the ASRT-created
  runner before accepting target work. ASRT itself still starts that runner
  under the shared sandbox account before KodaX code executes, so KodaX cannot
  atomically apply a runner process DACL or Job at creation. A concurrently
  compromised process under that account therefore retains a narrow pre-main
  race against the runner. Closing it requires ASRT to accept creation-time
  process/thread security descriptors or a privileged spawn service; adding a
  post-spawn KodaX patch would only disguise the same race. Current Codex
  `2764e836` has the same `CreateProcessWithLogonW` runner-bootstrap residual,
  while assigning the final target Job at process creation. KodaX sets inherited
  error mode in its host before ASRT launch and again in runner `main`, which
  covers final-target faults. An image loader failure before runner `main`
  still depends on ASRT preserving that inherited mode and is therefore inside
  this same upstream bootstrap window. FEATURE_295 does
  not broaden this residual to trusted text tools, which never use ASRT.

### 2026-08-25: Issue 304 resolved (v0.7.96-alpha)
- Workspace session closes now defer behind live leases (defer-before-evict,
  lease re-check at fence commit, entry-registered in-flight drain set) so a
  long-lived background command keeps its session reusable instead of parking
  a reset that fails every later text mutation closed.
- Cleanups that never started no longer poison the Windows sandbox owner
  account; cleanup RPC timeouts retire only the timed-out request; and
  standalone SDK admission fails structurally behind leased sessions instead
  of pre-clearing the cache and terminating them.
- Pending session resets are scoped per policy key (keyless resets and all
  ACL transitions stay globally blocking), and text mutations carry
  structured unavailability reasons through to the user-facing error.

### 2026-08-24: Issue 304 opened
- Documented the Windows pending-reset fail-closed collision with long-lived
  background sandbox commands: a parked workspace session close keeps
  `pendingWorkspaceSessionResets` non-empty, and `getWorkspaceSession` returns
  `undefined` immediately, so every later sandboxed text mutation reports
  unavailable. Pinned current semantics with a regression test; deep fix needs
  a design decision (bounded wait, lease-aware close abandonment, or fence-owner
  sharing).

### 2026-08-24: Issue 303 resolved (v0.7.96-alpha)
- Bundled Windows builds now ship a `vendor/srt-win/<arch>/srt-win.exe` sidecar
  and resolve it from `resolveSrtWinSourcePath()` instead of the ASRT
  library's module-relative lookup, which points onto Bun's virtual `B:\`
  drive inside `--compile` binaries.
- Windows sandbox setup prepares the runner first and passes its resolved
  spawn descriptor to `installWindowsSandbox()`, so account provisioning no
  longer re-runs the broken library lookup on machines without an existing
  sandbox account.

### 2026-08-23: Issue 302 resolved (v0.7.95)
- Delayed the coding `onComplete` signal until extension completion and
  asynchronous result finalization have produced the authoritative result.
- Preserved the Runtime's lost-executor-Promise fallback and added a CAP-005
  ordering regression so A2A cannot publish an empty successful answer again.
- Made completion observers post-finalization notifications whose failures are
  diagnosed without rewriting persisted terminal facts.

### 2026-08-21: Issue 300 resolved (v0.7.94)
- Replaced ASRT wildcard git trust with a bounded authorized-root set, including
  repo-bearing read grants that remain prioritized under the eight-root cap.
- Added verified linked-worktree and submodule metadata relationships, a
  minifier-safe shared broker implementation, and fail-closed malformed-env
  handling.

### 2026-08-20: Issue 300 opened
- Documented the misaligned sandboxed git trust set: read-authorized roots are
  never emitted as `safe.directory`, linked-worktree sessions fail on missing
  `<main>/.git` read access (not on ownership), and more than eight write roots
  collapse ASRT's emission to `safe.directory=*`.
- Fix in progress: per-exec argv-level takeover of the `GIT_CONFIG_*` set with
  the exact authorized-root list (never `*`), linked-worktree gitdir read grants
  plus gitfile write guards, and a `gitSafeDirectory` v4 marker field for stale
  daemon detection. Detection: a daemon capability snapshot whose
  `sandboxRuntime` object lacks `gitSafeDirectory` predates the fix.

### 2026-08-19: Issues 297, 298, and 299 resolved (v0.7.93)
- Ended the 170-second orderly Windows exit wait when the exact owner already
  persisted a terminal `failed` shutdown outcome.
- Added a machine-lock-scoped recovery-only path for previous-boot ACL marker
  sets and kept same-boot or unverifiable markers fail-closed.
- Classified isolated Anthropic/OpenAI `APIUserAbortError` objects as
  `AbortError` so managed Stop stays interrupted before credential redaction.

### 2026-08-18: Issue 296 resolved (v0.7.92 development)
- Rebuilt resumed terminal history from the bounded canonical message projection
  before applying lossy `uiHistory` display metadata and UI-only entries.
- Bounded canonical and restored UI-only history independently so sparse command
  tails cannot evict the canonical conversation window.
- Kept presentation-only `agent-completed` / `task-completed` events host-owned
  when a non-empty CLI `uiHistory` exists.

### 2026-08-16: Issue 293 resolved (Unreleased)
- Made managed run/runtime context envelopes topology-transparent to ordinary
  conversation history while preserving raw audit history and legitimate
  repeated content.
- Invalidated v3 conversation page caches so affected Sessions rebuild the
  corrected projection on first open or pagination.

### 2026-08-12: Issue 291 resolved (v0.7.86)
- Atomically recovered only provably dead inline owner fences during daemon
  enable and made inline close failures visible and retryable.

### 2026-08-10: Issue 290 resolved (v0.7.85 development)
- Preserved mixed-case custom provider aliases during dynamic model completion
  while retaining case-insensitive filtering and ranking.

### 2026-08-09: Issues 285 and 286 resolved (v0.7.85 development)
- Protected agent-home roots, Runtime control state, and sensitive files while
  preserving ordinary Agent definition and working-artifact mutations.
- Made Learned Skill binding traverse the real remote/local physical roots,
  preserve owning-store lifecycle mutations, cover `remote-hash:*`, and retain
  the deprecated public single-scope configuration spelling.

### 2026-08-05: Issue 281 resolved (v0.7.82)
- Reordered input admission around the authoritative Run and cached its minimal
  admitted Session context, eliminating canonical transcript reads from active
  interrupt/after-turn submission and daemon preflight.
- Preserved delayed after-turn launch, queue-time settings, Partner/unknown
  surface rejection, stale and interrupt-window responses, and exact-operation
  single-enqueue behavior; aligned daemon active phases with the SDK.

### 2026-08-05: Issue 280 resolved (v0.7.82)
- Fenced managed Provider recovery, continuation, and tool admission after an
  observed Run abort, and cooperatively converged Run-admitted Actor turns.
- Preserved trusted Stop/Abort causality before credential redaction so every
  terminal surface reports interrupted consistently without changing genuine
  completion or independent-failure races.

### 2026-08-05: Issue 279 resolved (v0.7.82)
- Added a lease-scoped Host Tool snapshot and composed it with the active MCP
  snapshot for unfiltered discovery; explicit server searches select only the
  matching source and report a missing source as an empty degraded snapshot.
- Preserved complete database discovery, model-facing Host Tool discovery, and
  bound Host Tool execution without leaking Host Tools across server filters.
- Added red/green regressions for database-only, Host-only, unfiltered, and
  missing-active-provider paths, plus uncapped legacy-provider discovery.

### 2026-08-04: Issue 275 resolved (v0.7.80)
- Kept ordinary search selectors, directory scopes, and Git reads on the
  deterministic read path while retaining credential and dynamic boundaries.
- Used trusted tool side-effect metadata for network reads and contained Agent
  tools, and adapted a truncated classifier retry from 256 to 1024 tokens.

### 2026-08-04: v0.7.80 hardening release
- The CLI honors `worker.configuredA2A` in `~/.kodax/config.json` (Worker-hosted
  embedded Runtime with the configured A2A plane inside the Worker owner) and
  sanitizes Worker-hosted run options exactly like daemon mode
  (`docs/KNOWN_ISSUES.md` Issue 243 follow-up).
- Managed AMA turns gain a 500-iteration per-invocation panic fuse with a
  structured `RunnerIterationLimitError` carrying the recovery transcript;
  idle-yield resumes reset the counter and the managed-task lifecycle stays
  unbounded.
- Managed-run repetition loops are prevented (bounded managed-run/runtime
  context projections, stall detection, verifier-recorder/LLM-judge
  convergence); parallel review and delegation guidance are restored and
  tightened.

### 2026-08-04: Issue 256 rescheduled to v0.7.84 (no longer blocks v0.7.79)
- Issue 256 was explicitly rescheduled from a v0.7.79 release blocker to a
  v0.7.84 resolution target. The identity-checked Windows snapshot mitigation
  remains the v0.7.79 behavior; spawn-time Job Object containment and a
  host-issued Worker owner lease are the v0.7.84 closure work.
- The v0.7.79 release gates in `docs/release.md` no longer require Issue 256 to
  be resolved before tagging.

### 2026-08-03: Issue 273 added and resolved (v0.7.79 development)
- Isolated the Runtime actor liveness test child from inherited Node proxy
  activation and routing variables while keeping strict stderr validation.
- Added a deterministic contaminated-parent regression and verified all 1465
  fast-suite tests.

### 2026-08-03: Issue 272 added and resolved (v0.7.79 development)
- Made MCP close surface every unverified descendant cleanup immediately and
  kept reopen blocked until a retry proves termination.
- Replaced production workspace-private Agent imports with public entrypoints
  and bounded runtime-bound daemon shutdown outcomes for concurrent readers.
- Completed the v0.7.79 changelog and SDK persistence notes, while retaining
  the exact-identity and indeterminate-commit fail-closed designs.

### 2026-08-03: Issue 271 added and resolved (v0.7.79 development)
- Bounded revision-fenced fork projection without touching ordinary Session
  load/resume/cache paths.
- Closed narrow Git short-cluster, first Windows snapshot, duplicated-copy
  comment, and production fault-injection hardening gaps.
- Documented intentional `sessions.load()` and classifier-decision contracts;
  rejected cache LRU and archived-filter findings that do not match runtime
  behavior.

### 2026-08-03: Issue 269 added (v0.7.79 development)
- Confirmed Node 20 POSIX cached-PID signaling cannot make the watchdog's
  identity check atomic with process-tree termination.
- Made expected-identity POSIX escalation fail closed and tracked a retained
  pidfd/kqueue/native-supervisor boundary as the required complete solution.

### 2026-08-03: Issue 268 added and resolved (v0.7.79 development)
- Made Auto[LLM] allow-by-default with only concrete credential/security-
  control access and concrete system destruction/resource exhaustion eligible
  for `ask`.
- Converted historical Tier 0 matches into classifier facts for Auto[LLM]
  while retaining the legacy deterministic gate for explicit Auto[Rules].
- Prevented the Ink REPL's cross-mode denial cache from overriding a later
  Auto[LLM] allow.
- Made a user's rejection call-local with explicit safer-alternative feedback;
  revised calls still receive a fresh, final classifier decision.

### 2026-08-03: Issue 267 added and resolved (v0.7.79 development)
- Completed daemon-serve process cleanup after host shutdown, made unresolved
  current-owner child trees fail closed, and explicitly exited the dedicated
  host only after graceful cleanup succeeded.
- Added real Run, MCP-child PID, public SDK stop, owner-file, and directory
  release regressions without weakening connected-client or active-work stop
  refusal.
- Added exact OS-process watchdog escalation for hung/asynchronously pending or
  synchronously blocked shutdown, and replacement-owner re-observation before
  reporting the profile's final state.

### 2026-08-02: Issue 259 added and resolved (v0.7.79 development)
- Deferred durable REPL Session creation until the first real prompt while
  preserving settings synchronization for existing and newly active Sessions.
- Reversibly archived 19 zero-message REPL records: 15 left by the 2026-08-01
  startup performance investigation, two created concurrently before the fix
  was built, and two older strict empty records.

### 2026-08-01: Issue 258 added and resolved (v0.7.79 development)
- Required all user-visible TodoList fields to follow the query's primary
  natural language in both the Worker plan contract and Todo mutation tools.
- Localized the deterministic Todo counter, transcript heading, and summary
  folds through the configured REPL locale.

### 2026-07-31: Issues 247 and 254 resolved after independent review
- Prevented the first v0.7.78 Session handoff from replaying a polluted
  historical branch, while preserving intentional repeated content.
- Strengthened locator authority with traversal-completeness checks and a
  cross-process topology epoch, and added the macOS-primary tiny-Session cold
  observation benchmark.

### 2026-07-31: Issue 253 added and resolved (v0.7.79 development)
- Split Actor admission fencing from progress/mailbox revisions and serialized
  only the short collaboration admission section, preserving parallel child
  execution while eliminating spurious strategy `revision_conflict` failures.

### 2026-07-31: Issues 248-252 added and resolved (v0.7.79 development)
- Unified collision-resistant Session identity generation across Agent and REPL.
- Distinguished standalone JavaScript children from KodaX self-entry, embedded
  Skill dispatch, configured-shell probes, and project-local LSP startup.
- Made programmable command imports Windows-safe and load failures observable
  without pre-judging Node, Bun, or loader TypeScript support.
- Aligned constructed-handler worker resolution with every published sidecar
  layout and verified a real Worker startup.
- Made final-waiter shell probe cancellation wait for bounded process cleanup,
  verify the root and every pre-snapshotted Windows descendant by creation
  identity, and fail closed when identity snapshots are unavailable.

### 2026-07-31: Issue 247 added and resolved
- Unified immutable Session capture, process-wide canonical path indexing,
  first-materialization single-flight, and pure read-only Runtime Session APIs
  remove repeated cold-read I/O without weakening fail-closed snapshot,
  cancellation, or revision-bound cursor semantics.

### 2026-07-31: Issue 241 resolved (v0.7.79 development)
- Assigned standalone process startup exclusively to the bootstrap while
  preserving direct Node CLI and daemon execution.
- Added a real compiled-artifact smoke gate that rejects duplicate A2A JSON
  documents.

### 2026-07-31: Issue 246 added and resolved (v0.7.79 development)
- Added a non-forgeable `runtimeEventCoalescing: 1` capability requirement and
  governed auto-start upgrade path for legacy daemon replacement.
- Enforced the 8KiB accumulated merge bound before concatenation and corrected
  the ACP cancellation fixture to settle through real executor interruption.

### 2026-07-31: Issue 245 added and resolved (v0.7.79 development)
- Prepared a protected content-addressed Windows runner outside private global
  npm paths, propagated it to every ASRT session, and used its directory for
  readiness and initialization child processes.
- Added complete account-state validation, bounded coded WFP diagnostics, and
  regressions for the reported `CreateProcessWithLogonW` access-denied case.

### 2026-07-31: Issue 244 added and resolved (v0.7.79 development)
- Coalesced compatible Runtime streaming fragments before sequence allocation
  at 50ms/8KiB, limited progress to first-plus-latest 20Hz delivery, and
  preserved strict structural flush boundaries.
- Committed contiguous sequence ranges and same-Run JSONL batches atomically,
  with cross-Runtime retry ordering, partial-write repair, fail-closed
  indeterminate commits, and post-commit failure isolation.
- Added long-stream, tool identity, reconnect/watermark, progress, boundary,
  persistence-failure, and lock-cleanup regression coverage.

### 2026-07-30: Issue 242 resolved (v0.7.79 development)
- Replaced automatic provider/model setup without a credential with a
  read-only Windows/macOS/Linux environment-variable guide and an explicit
  close-and-reopen-terminal boundary.
- Kept API-key values outside KodaX, avoided setup-file initialization on the
  guidance path, and preserved explicit setup plus automatic metadata setup
  when a supported credential already exists.

### 2026-07-30: Issue 241 added
- Confirmed that Bun-compiled standalone binaries invoke the CLI entry twice,
  duplicating both read-only output and mutating/interactive command handling.
- Traced the regression to the v0.7.72 bootstrap entry plus the importable
  CLI bundle's direct-entry guard. Node/npm execution remains single-shot.

### 2026-07-30: Issue 240 resolved
- Separated managed finalization from executor termination, added durable
  stage/subtask and fail-closed Stop outcome status, and bounded extension
  `turn:complete` finalizers. Latched terminal callbacks and progress barriers
  preserve completion/Stop event order across late callbacks and recovery.
- Added a dedicated read-only, timeout/cancel-aware Runtime Session diagnostic
  boundary and aligned its strict daemon schema with embedded behavior without
  consuming transcript-page cache capacity. The final review also made owner
  and Stop errors independently reportable, preserved client/daemon version
  skew, and enforced the deadline while owner liveness is unresponsive.
- Persisted a latched executor terminal synchronously during Runtime close
  before releasing the owner-liveness endpoint.
- Corrected successful snapshot clearing of stale crash metadata without
  regressing partial or cross-instance Session writers.

### 2026-07-30: Issue 239 resolved
- Made archive/unarchive fail closed when a destination contains an orphan
  modern or legacy sidecar, preserving every source and destination file.

### 2026-07-30: Issue 238 resolved
- Restored append-order transcript recovery with private adjacency anchors,
  stable parent-aware legacy fallback, full-record preservation, and locked
  main/sidecar snapshot reads.
- Preserved retained-message logical/source identity across compaction without
  adding public timestamp or sequence fields.
- Added storage, public SDK, Runtime paging, and provenance regressions for the
  observed and adversarial edge cases.

### 2026-07-29: Issue 237 resolved (v0.7.78 development)
- The authorized F263 `.3` safety panel found no credible high-severity harm and
  no negative project canary, but only 3/9 positive canaries survived production
  validation even though all 9 raw decisions selected `project_canary`.
- Blind review identified one systematic cross-provider mismatch: six
  human-readable Skill names violated an undocumented production slug invariant.
- Added the existing slug pattern and length bound to the production prompt and
  schema without weakening validation, changing policy, or rewriting output.
- Stopped F263 downstream and the F277 panel; fresh `.4` revisions bind the
  corrected bytes to one new exact candidate instead of shopping old evidence.

### 2026-07-29: Issue 236 resolved (v0.7.78 development)
- The paid F263 validity pilot stopped expansion after 3/4 malformed production
  results and 0/2 positive `project_canary` decisions.
- The failure was reviewed blind before reveal and preserved outside the
  repository under the frozen `f263-v0.7.78.2` raw root.
- Required the two top-level carriers and documented the governed approval
  invariant without changing the strict normalizer or Skill admission policy.
- Focused regression and zero-call manifest suites pass. A new exact-candidate
  `.3` pilot remains a release gate; no malformed output is silently accepted.

### 2026-07-29: Issue 235 resolved (v0.7.78 development)
- Replaced absent/stale semantic release gates with frozen, resumable F263 and
  F277 current-policy runners.
- Kept production semantics authoritative: gates consume exact production bytes
  and fail closed on drift instead of changing implementation to satisfy an old
  expectation.
- Added explicit generation and owner-authorization fences; default test runs
  remain zero-cost.

### 2026-07-29: Issue 234 resolved (v0.7.78 development)
- Replaced a Windows-only standalone sandbox environment assertion with exact
  platform-specific transport checks.
- Preserved production environment and containment behavior; the defect was in
  the release gate, not the broker implementation.

### 2026-07-29: Issue 233 resolved (v0.7.78 development)
- Delayed learned Skill trust until all three exact-revision canary outcomes
  settle with at least one independently verified success.
- Revalidated revision and fingerprint inside the invocation mutation so a
  two-lock race cannot attribute stale bytes to the current artifact.
- Replaced stale one-success integration expectations instead of weakening the
  FEATURE_263 lifecycle to satisfy old gates.

### 2026-07-29: Issue 232 resolved (v0.7.78 development)
- Denied workspace-shell reads from sensitive home credential paths and
  prevented home-local `PATH` grants from reopening those paths.
- Protected custom agent homes and used Windows per-exec denies to avoid
  long-lived ACL initialization timeouts.
- Preserved ordinary reads, workspace/temp writes, bootstrap execution, and
  the existing network policy.

### 2026-07-29: Issue 231 resolved (v0.7.78 development)
- Preserved an explicit host-bound `memory_intent` through later root
  cancellation without admitting observations or lessons from the cancelled
  task.
- Kept foreground cancellation non-blocking after durable review enqueue; a
  same-process drain is best effort and a later run recovers persisted work.

### 2026-07-29: Issue 230 resolved (v0.7.78 development)
- Added Runtime-identity IPC liveness for durable Actor owners, so PID reuse
  cannot indefinitely pin crashed ownership while legacy snapshots remain
  fail-closed.

### 2026-07-29: Issue 229 resolved (v0.7.78 development)
- Prevented the built-in A2A HTTP listener from returning endpoints that
  Fetch-compatible clients reject before connecting.
- Explicit blocked ports now fail clearly, while ephemeral allocation retries
  without changing A2A task or transport semantics.

### 2026-07-29: Issue 228 resolved (v0.7.78 development)
- Required Auto guardrail v4 during daemon auto-start and corrected embedded,
  Worker, and daemon metadata to report non-persistent classifier fallback.
- Added exact v3 replacement and capability-parity regressions.

### 2026-07-29: Issue 227 resolved (v0.7.78 development)
- Completed the root MemorySession and durable review loop in both SA and AMA.
- Added semantic `memory_intent` capture with current-user-turn quote binding,
  auditable evidence, one-shot idempotency, and truthful lifecycle wording.

### 2026-07-29: Issue 226 resolved (v0.7.78 development)
- Applied Edit/Plan policy before client broker escalation so already-allowed
  calls no longer become permission work.
- Allowed the outer `skill` loading tool in Plan mode while preserving
  downstream action-specific permission checks, and disabled inline dynamic
  commands unless the live mode is non-Plan and the Runtime host supplies a
  mediated executor.

### 2026-07-29: Issue 225 resolved (v0.7.78 development)
- Removed two stale release-gate assumptions without changing production:
  pre-aborted Bash calls remain unable to spawn, while the cleanup rejection
  test now aborts an already-started bounded command.
- Kept invalid explicit-home integration provenance truthful as `source:user`
  while preserving degraded safe-empty behavior.

### 2026-07-28: Issue 223 resolved (v0.7.78 development)
- Retried transient Auto[LLM] classifier failures once and added structured
  prompt-size, phase, and TTFT diagnostics to Runtime permission events.
- Replaced hard classifier stops and silent rules widening with user
  confirmation plus an Accept-edits failure fallback.
- Routed exact user-authorized workspace mutations through a one-shot ASRT
  sandbox admission before allowing ordinary shell copy/move/delete operations;
  fixed Windows mutation-switch parsing, bounded current intent, enforced
  provider-independent deadlines, and surfaced/rechecked missing ASRT setup.

### 2026-07-28: Issue 222 resolved (v0.7.78 development)
- Isolated invalid optional MCP, A2A, and Extension configuration from core
  daemon readiness while preserving last-known-good state and source bytes.
- Added structured domain health, explicit-home consistency, independent CLI
  validation, legacy-source hot recovery, continuously bounded bootstrap logs,
  a versioned Runtime capability, manual guidance, and source/real-process
  regression coverage.

### 2026-07-28: Issue 221 resolved (v0.7.78 development)
- Closed FEATURE_276 review gaps in first-run gating, truly read-only help,
  split-config validation, concurrent migration/provider writes, and custom
  `KODAX_HOME` template paths.
- Added real built-process setup coverage plus schema, concurrency, EOF, help,
  template, and self-knowledge regressions.

### 2026-07-28: Issue 220 resolved (v0.7.77 development)
- Routed fullscreen Ink integration events through the existing two-second
  transient toast instead of writing directly over the terminal footer.
- Preserved classic and non-interactive `[integrations]` logging when no Ink
  notice subscriber is mounted.

### 2026-07-27: Issue 217 resolved (v0.7.77 development)
- Separated generated ACP conversation IDs from native Codex/Gemini resume IDs;
  first turns are fresh and only CLI-reported IDs can be resumed.
- Removed the global stateless ACP session, released one-shot mappings, and
  made non-zero CLI exits reject through pseudo-ACP and `AcpClient`.
- Serialized first connection initialization, rejected overlapping prompts for
  one explicit conversation, and fail-closed normalized CLI failure events.

### 2026-07-27: Issue 216 resolved (v0.7.77 development)
- Preserved official Codex CLI cache read/write and Gemini CLI cache-read usage
  through CLI events, pseudo-ACP, normalized usage, and Runtime diagnostics.
- Preserved explicit zero while leaving unreported or invalid counters absent;
  input totals remain upstream totals rather than double-counting cache fields.

### 2026-07-27: Issue 215 resolved (v0.7.77 development)
- Added hashed logical-context prompt-cache affinity across AMA, SA, retries,
  fallback, compaction, restored Sessions, and recursive root/child execution.
- Enabled only verified Kimi Code, public Kimi, official OpenAI, and explicit
  custom Provider opt-ins; strict compatible gateways remain unchanged.

### 2026-07-27: Issue 214 review hardening resolved (v0.7.77 development)
- Denied credentials for all registered Providers, preserved Session shell
  inheritance through explicit Run `undefined`, rebuilt current Registry
  variables without stale daemon expansion, and corrected PowerShell argv.
- Added pre-probe execution-control filtering, deny-precedence coverage,
  Git Bash hint isolation, waiter-counted probe cancellation, and a targeted
  Windows CI gate.

### 2026-07-26: Issue 214 initial implementation (v0.7.77 development)
- Added a strict Session/Run shell contract with cwd-specific two-stage
  environment resolution, pre/post credential filtering, bounded cache
  refresh, explicit interpreter execution, child/evaluator propagation, and
  interpreter-bound permission grants.
- Preserved the unconfigured legacy path and made configured-shell failures
  visible instead of silently reinterpreting commands.

### 2026-07-26: Issue 214 added
- Confirmed daemon shell execution couples per-run cwd to a stale startup
  environment, implicit interpreter, and unfiltered process credentials.

### 2026-07-26: Issue 213 resolved (v0.7.77 repack)
- Rebuilt the v0.7.77 archive from clean commit `3363f1cf`, verified its
  request-only suffix implementation, and added native/legacy automatic-
  compaction regressions.

### 2026-07-26: Issue 213 added
- Confirmed the supplied v0.7.77 archive predates the request-only AMA
  managed-context implementation even though its package version is current.

### 2026-07-26: Issue 212 resolved (v0.7.77 development)
- Repaired child-evidence sanitization and made interrupt-batch validation
  non-destructive and all-or-nothing.
- Aligned memory governance hashing, terminal events, live-turn status, and the
  pattern-disposition Schema with their production contracts.

### 2026-07-26: Issue 211 resolved (v0.7.77 development)
- Removed Session scratch paths from the AMA stable System prompt and moved
  all volatile managed-run facts to the existing request-only Provider suffix.
- Added two-new-Session prefix stability, suffix diagnostics/context-budget,
  Actor refresh, and exact Qwen cache-creation usage regressions.

### 2026-07-26: Issue 210 resolved (v0.7.77 development)
- Completed logical root/child identity on diagnostic payloads without
  weakening Session/Agent isolation.
- Added inline/daemon latest provider-cache lookup and reconnect recovery.

### 2026-07-26: Issue 209 resolved (v0.7.77 development)
- Made root/child cache and budget diagnostics logical-identity aware,
  Provider-wire accurate, compaction-complete, prompt-free, and fail-open.
- Preserved recursive Actor children while restoring specialist contracts,
  closing descendant tool/provider ceiling gaps, and hiding unbound
  collaboration/Workflow surfaces from actorless leaves.

### 2026-07-26: Issue 208 resolved (v0.7.77 release candidate)
- Restored absolute managed Runner and ordinary coding bounds for repeated
  active-Run lifecycle continuations while preserving one final generation for
  accepted input.
- Expanded governed-memory prompt-safety matching and documented the existing
  prompt-cache diagnostics gate.

### 2026-07-25: Issue 207 resolved (v0.7.77 release candidate)
- Runtime run admission now resolves a provider-only selection to that
  provider's static default model before Auto LLM preflight and launch.
- Explicit model precedence and fail-fast behavior for providers with no
  resolvable default remain unchanged.

### 2026-07-23: Issue 204 resolved (v0.7.74)
- Auto renders the configured/observed LLM or rules engine without a transient
  bare state.
- Per-Session Runtime setting writes are serialized so rapid mode cycling is
  last-action-wins while sticky rules fallback remains explicit.

### 2026-07-23: Issue 105 resolved (v0.7.74)
- Made all `-c` entry paths skip empty placeholder sessions and scan beyond the
  legacy ten-session list cap.
- Restored resume loading in the classic REPL startup path.

### 2026-07-23: Issues 202-203 resolved (v0.7.74)
- Kept canonical compaction checkpoints, first-kept pointers, and post-compact
  attachments on one active lineage path while retaining legacy checkpoint
  compatibility.
- Escalated PowerShell bracket wildcards on path parameters without treating
  bracket-bearing `LiteralPath` filenames as dynamic.

### 2026-07-23: Issues 200-201 resolved (v0.7.74)
- Made root completion delivery explicitly recoverable and legacy-safe through
  persisted pending-delivery IDs, post-commit acknowledgements, and scoped
  queue deduplication across hard restart and soft Runtime rebuild.
- Restricted model waits to mailbox/user activity, kept system reminders from
  ending waits, and corrected Workflow progress guidance.

### 2026-07-22: Issue 198 resolved (v0.7.74)
- Unified SA/AMA durable-compaction and history-tool binding, made the tool pair
  visibility atomic, and closed default AMA's advertised-but-unavailable path.
- Made persistent child compaction inherit policy, retain context-scoped
  telemetry, and archive/search only a separately minted hidden child lineage.

### 2026-07-22: Issue 199 resolved (v0.7.74)
- Closed interrupt admission at managed completion and ordinary completion/error
  callbacks as well as external abort, while releasing abort listeners on every
  Runtime-owned terminal path.
- Terminalized synchronous coding and managed-task launch failures without
  changing the caller-visible `runs.start()` rejection.
- Kept Sidecar observer failures on the diagnostic channel so they cannot close
  a still-consumable interrupt window, with deterministic Runtime and bridge
  regression coverage.

### 2026-07-22: Issues 195-197 added and resolved (v0.7.74)
- Bypassed the LLM for exact safe reads while moving sensitive paths and
  environment disclosure ahead of classifier decisions; the post-resolution
  closure covers bare/Git-object operands and analyzer-less SDK callers.
- Added grep source paging and independent attention admission without
  restoring the Issue 158 universal truncation behavior; all production entry
  paths now use the owner, physical and attention ledgers are separate, and
  persistence failure preserves physically admissible evidence.
- Recognized current user-shaped compaction checkpoints at round exit and
  removed duplicate query/final appends.

### 2026-07-22: Issues 192/194 post-implementation review closure
- Moved terminal Actor receipts behind transcript/session commit, filtered
  acknowledged direct-child event replay, and aligned repeated persisted text
  to the latest canonical suffix.
- Required emergency compaction fallback to reduce tokens and restore physical
  validity before emitting successful compatibility events.
- Synchronized canonical config templates, `kodax_manual`, and current-state
  compaction documentation.

### 2026-07-22: Issue 194 added and resolved (v0.7.74)
- Recorded the local-specialist dispatch contract break, progress-wait model
  amplification, duplicate terminal delivery, non-idempotent resumed tool
  history, ambiguous guardrail denial, and missing tool-result timestamp.
- Resolved catalog selection, terminal-only waiting, durable turn-ID
  acknowledgement, canonical tool-ID resume repair, denial diagnostics, and
  result timestamping; verified 2,299 tests plus the reported real session.

### 2026-07-21: Issue 193 added and resolved (v0.7.73 development)
- Added the versioned Runtime/daemon interrupt-input contract, reused the
  canonical Actor queue for same-Run FIFO safe-boundary delivery, exposed
  queued/delivered status and ordered batch events, and prevented terminal or
  restarted Runs from leaking undelivered input.

### 2026-07-21: Issue 192 added and resolved (v0.7.74)
- Recorded and fixed the large-compaction policy/coverage defect, root/child
  event ambiguity, and unbounded observation transport through FEATURE_272.

### 2026-07-20: Issue 190 added and resolved (v0.7.73)
- Made matcherless legacy grants non-authorizing while retaining management
  compatibility, kept the bounded all-action classifier projection, and added
  escaped-JSON credential redaction.

### 2026-07-20: Issue 189 added and resolved (v0.7.73)
- Unified native reasoning controls, synchronized environment-backed Auto
  settings into Runtime, preserved persisted engine choices, made sidecar
  `none` capability-aware, fixed Qwen hybrid thinking disable requests, and
  serialized parallel confirmation dialogs.

### 2026-07-20: Issue 188 added and resolved (v0.7.73)
- Replaced raw assistant tool arguments and results with bounded semantic
  summaries/status metadata, added fail-closed constructed/extension/MCP
  projection contracts and auditable exemptions, anchored both genuine
  user-intent boundaries under byte pressure, and made first-run provider
  readiness observe the hydrated Runtime environment.

### 2026-07-19: Issue 187 added and resolved (Unreleased)
- Closed the shared-daemon Auto permission owner, safe old-daemon upgrade,
  Windows/Tier-0 path, bounded preview, and 0.7.x SDK compatibility gaps.
- Post-review closure restricted path grants to known file tools, preserved
  POSIX backslashes, rejected dynamic PowerShell persistent grants, aligned
  concrete `toolInput` across embedded/daemon SDKs, preserved embedded host
  policy hooks, committed rewritten calls before execution in both Runner
  paths, derived trusted previews from concrete input, narrowed legacy scope
  responses to Runtime-issued matchers, and propagated blocked calls through
  Runner audit.

### 2026-07-19: Issue 186 added and resolved (v0.7.72)
- Added an awaitable daemon subscription readiness boundary so a second client
  cannot outrun installation of a permission/event listener.

### 2026-07-19: Issue 185 added
- Deferred F266 learning-lock crash recovery hardening; rejected a blanket
  30-second acquisition timeout in favor of a future owner-aware atomic claim.

### 2026-07-19: Issue 184 added
- Deferred sed effect-aware permission classification to avoid shipping a
  blanket write classification that would regress legitimate read-only use.

### 2026-07-18: Issue 183 added and resolved (v0.7.72-hotfix.0)
- Unified CLI and SDK daemon startup ownership, reclaimed only the current
  failed/cancelled candidate process tree, and added a test-only worker-death
  shutdown fallback without changing persistent production daemon semantics.

### 2026-07-18: Issue 182 added and resolved (v0.7.72-hotfix.0)
- Retried bounded Windows sharing-denial errors as lifecycle-lock contention;
  unrelated filesystem errors remain fail-fast.

### 2026-07-18: Issue 181 added and resolved (v0.7.72-hotfix.0)
- Aligned the stale default MiniMax media-capability assertion with the current
  image-capable MiniMax M3 provider default.

### 2026-07-18: Issues 179-180 added and resolved (v0.7.72-hotfix.0)
- Increased Auto[LLM]'s default classifier budget to 20 seconds, removed
  pure readonly invocations from the classifier path, retained classification
  for semantic index refresh, and exposed SDK/daemon overrides.
- Unified queued input on the session-root Actor scope and made `wait_agent`
  plus idle-yield wake lossless without canceling the whole run. SA compatibility,
  single-session SDK auto-binding, explicit concurrent-session routing, and
  ambiguity rejection are covered without reintroducing a second control plane.

### 2026-07-18: Issue 178 added and resolved (v0.7.72-hotfix.0)
- Released stdin ownership on bare-resume cancellation so PowerShell regains
  its prompt without a follow-up keypress; the selected-session handoff remains
  unchanged.

### 2026-07-18: Issue 177 added and resolved (v0.7.72)
- Promoted current Actor capacity to a shared authoritative first-section
  prompt contract for both full and fallback Worker paths, with a passing
  fresh five-track follow-up pilot.

### 2026-07-18: Issues 175-176 added and resolved (v0.7.72)
- Closed the Actor start/interrupt cancellation gap, terminal no-op writes,
  closed mailbox semantics, and daemon Actor capability negotiation.
- Closed Learning lost-wakeup, disconnect waiter cleanup, and transient
  principal facade retention without changing durable cursor identity.

### 2026-07-18: Issue 174 added and resolved (v0.7.72-hotfix.0)
- Bound the searchable `-r` picker to the real process terminal streams, kept
  it alive by owning an unreferenced stdin handle, restored Ctrl+C cancellation,
  separated explicit cancel from unexpected exit, and added a clear
  non-interactive error path.
- Kept the selected picker visible while the full CLI preloads, then transferred
  stdin liveness into the REPL without a transition gap; preload failures clean
  up and preserve the original error.

### 2026-07-18: Issue 172 resolved after production-path closure (v0.7.72-hotfix.0)
- Forwarded guardrails through managed Runner, authorized exact concrete bridge
  calls with one-shot receipts, completed execution-cwd/path-role handling,
  preserved legacy daemon preview input compatibility, and verified the full
  Runtime SDK suite plus publish build.

### 2026-07-18: Issue 172 reopened
- Production review found that managed-task did not forward Runtime guardrails,
  `tool_call` classified only its wrapper, and two command-path forms still
  lost deterministic boundary signals. The issue remains open until the final
  concrete-call authorization path and compatibility regressions are verified.

### 2026-07-17: Issue 172 added and resolved (v0.7.72-hotfix.0)
- Installed and Session-scoped the real auto-mode guardrail in daemon Runtime
  runs, limited the shared permission broker to explicit escalations, separated
  project boundaries from execution cwd, and bounded permission transport data.

### 2026-07-16: Issue 168 added and resolved (v0.7.71)
- Closed A2A executor shutdown/durability, daemon ownership/readiness,
  extension/artifact policy, inbound admission/replay/close/auth/media, and SSE
  resource-boundary gaps found by the final cross-chain review.

### 2026-07-16: Issue 167 added and resolved (v0.7.71)
- Closed A2A OAuth validation/redaction gaps and made config-owned hot
  activation persistence-first, ownership-aware, and revision-conditional.

### 2026-07-15: Issue 164 added and resolved (v0.7.70)
- Added cost-admitted, lossless zero-match MCP recovery and compact CJK query
  segmentation without changing successful lexical-search behavior.

### 2026-07-15: Issue 163 added and resolved (v0.7.70)
- Closed A2A endpoint trust, read-boundary, task continuation/retention,
  artifact, cleanup, redaction, version, and stream-interoperability gaps while
  retaining the existing lightweight Runtime and file-store architecture.

### 2026-07-15: Issue 162 added and resolved (v0.7.70)
- Restored hosted Runtime provider/model precedence for `a2a serve`, admitted
  Markdown Agent providers, and made root/subcommand option ownership and
  command termination explicit.

### 2026-07-15: Issue 161 added and resolved (v0.7.70)
- Closed MCP result-capacity, ranking, pagination integrity, cache recovery,
  cache-persistence truth, and provider-data trust-label gaps found in review.

### 2026-07-15: Issue 160 added and resolved (v0.7.70)
- Added reverse-bridge draining and daemon-owned Workflow/External Agent
  blockers to the atomic rollback revision so shutdown cannot abandon live
  background work or mutate transient credential/Host Tool state.

### 2026-07-15: Resolved issues older than 30 days archived
- Moved 40 resolved issues to `ISSUES_ARCHIVED.md`; all open and recent issues remain active.

### 2026-07-15: Issue 158 reopened review findings resolved (v0.7.69)
- Closed trusted-marker, recovery-transcript, observer-ordering, child-capacity,
  bounded-acquisition, Bash memory/ANSI, public-API, and artifact-lifecycle gaps
  found during implementation review.

### 2026-07-14: Issue 158 added and initially resolved (v0.7.69)
- Replaced transparent post-hoc lossy compression with complete collection and
  one aggregate next-request capacity decision.
- Removed default semantic Bash filters and hidden fixed caps, added exact
  recovery coordinates and incomplete-source markers, and corrected cache-token
  cost accounting.
- Replaced default destructive history microcompaction/static percentage
  targeting with physical-capacity, summary-first compaction and typed failure
  that preserves canonical history.
- Added regression coverage and a corrective ADR/feature/test-guide record.

### 2026-07-14: Issues 155 and 156 added and resolved (v0.7.69)
- Unified the resume picker with the owned TUI input lifecycle.
- Replaced repeated full-transcript pagination with one bounded, concurrent
  metadata-head scan while preserving legacy project aliases.

### 2026-07-11: Issue 151 added and resolved (v0.7.67)
- Distinguished Codex-owned MCP Node processes from KodaX test residues by
  command line, parent PID, and start time.
- Added explicit Runtime daemon shutdown to the config suite and parent-death
  watchdogs to long-running process fixtures.
- Verified the corrected suite leaves no new Node PID and removed five verified
  orphaned KodaX test processes without touching Codex MCP servers.

### 2026-07-11: Issue 150 added and resolved (v0.7.67)
- Withdrew the initial GitHub release/tag before npm publication.
- Restored restricted-script `phase` / external `target` forwarding.
- Made executor-plane close terminal and waiter-safe.
- Hardened scoped-review schemas, Feature 259 baseline reconstruction, and
  best-effort local ledger mirroring.
- Added focused regression tests and prepared a rebuilt v0.7.67 release.

### 2026-07-11: Issue 149 added and resolved (v0.7.67)

- Isolated both ACP test harnesses from real user session and Runtime storage.
- Delayed ACP persistence until the first valid prompt and added reversible,
  preview-first cleanup for the narrow legacy placeholder shape.
- Added searchable session resume plus SDK/Daemon surface and cursor pagination.

### 2026-07-10: Issue 147 added and resolved (v0.7.66)

- GitHub Release archive 现在携带 provider metadata 与全部 Worker sidecar。
- 新增 workflow YAML 回归测试，并在 sidecar 缺失时让发布任务 fail closed。

### 2026-07-10: Issue 146 added and resolved (v0.7.66)

- 图片路径处理失败时恢复原始文本，并通过非持久化两秒 Toast 提示用户。
- 保留有效图片附件行为；新增回归测试锁定不提交、不写历史的边界。

### 2026-07-10: Issue 145 added and resolved (v0.7.66)
- Resolved the runtime daemon / SDK lifecycle, event replay, permission,
  serialization, protocol-validation, artifact, and host-cleanup gaps found in
  the post-v0.7.63 architecture review.
- Added multi-client socket, restart/replay, listener isolation, active-run
  conflict, protected-path broker, frame-limit, wire-error, subscription-race,
  JSON-safe REPL, ACP storage, diagnostic restore, and LSP close regressions.

### 2026-07-06: Issue 112 resolved (v0.7.62)
- Resolved 112: `ask_user_question` now supports free-text input,
  multi-select with selection bounds, and default-on custom input answers. The
  REPL routes custom choice answers through the existing input dialog, while the
  tool returns normalized `choice` / `choices` and `custom_inputs` fields for
  the model.

### 2026-06-25: Issue 143 resolved (v0.7.57)
- Resolved 143: Auto[llm] speculative classify 窗口默认 500ms + late verdict 被丢弃 → 远程/慢 provider 下 near-100% 误弹确认框 (High).
- Fix (5 workstream, all landed): WS1 late-verdict 采纳（窗口过期改为 `await` 同一 classifyPromise 并采纳裁决 — allow/block 不弹框，仅真 escalate 弹框；比原 peek-race 设计更简洁、无 UI 改动、无闪烁）+ WS2 无 askUser ⇒ 窗口强制 0（修对 SDK/非交互）+ WS3 `autoMode.speculativeWindowMs` config 面 + env 透传（REPL+Space）+ WS4 v0.7.39.md 对账（late-verdict 使 micro-bench 失去正确性意义，按 EVAL_GUIDELINES Layer 1 不补跑付费 bench）+ WS5 防 double-record/settle 验证。
- Verification: coding 3570 passed（1 项 orchestration maxConcurrent 并发计时 flaky，隔离复跑绿，无关）、repl 2135 passed、coding+repl tsc clean；新增 17 个单测（guardrail 7 + permission-config 8 + bootstrap 2）。
- cost-tracker 在 classify.ts:96-98 内部结算恰好一次 → 二次 await 不 double-settle（reviewer code-trace 证实）；迟到 block 现正确喂 denial-tracker（旧路径丢弃曾误记为 breaker error）。

### 2026-06-25: Issue 143 added
- Added 143: Auto[llm] speculative classify 窗口默认 500ms + late verdict 被丢弃 → 远程/慢 provider 下 near-100% 误弹确认框，auto 模式形同虚设 (High, Open).
- Diagnosis (代码实证): 三根因叠加 —— (1) 窗口过期后后台 classify 裁决在 v1 被硬丢弃，即便迟到 allow 也变成必须人点的硬弹窗 (`guardrail.ts:443-449` / `speculative.ts:13-17`); (2) 500ms 是占位值，FEATURE_158 承诺的 Anthropic/DeepSeek/Zhipu micro-bench 从未回填 (文档末尾无报告 + release gate 未勾 + benchmark 无数据); (3) 窗口 500ms 与 classifier timeout 8000ms 的 16× 内部矛盾使远程/慢 provider 误弹成数学必然。REPL 与 Space 均未传 `speculativeWindowMs`，且无 config.json 面。
- Proposed (完整修复，非治标): WS1 采纳 late verdict / peek 模式 (窗口降级为"是否显示 pending UI") + WS2 无 askUser ⇒ 不投机 (修对 SDK/非交互) + WS3 补 `autoMode.speculativeWindowMs` config 面 + WS4 回填 micro-bench 固化默认 + WS5 防 double-record 验证。显式 descope provider/latency-aware knob (采纳 WS1 后冗余)。
- cost-tracker 在 `classify.ts:96-98` 内部结算，每次 classify 恰好一次，与窗口无关 → 采纳 late verdict 不会 double-settle。

### 2026-06-25: Issue 142 added and resolved
- Added and resolved 142: kimi-code thinking-only completion can terminate Worker with only `[Worker]` visible (High).
- Diagnosis: upstream reasoning provider can return a completed thinking-only/whitespace-only turn; KodaX v0.7.56 only retried fully-empty turns, so the Runner could incorrectly accept it as a terminal text-only completion.
- Fix: classify "no user-visible text and no tool calls" as degraded empty output, retry via the existing bounded re-stream path, fail locally if retries are exhausted, and guard the UI against committing bare managed role labels.

### 2026-06-18: Issue 140 resolved (v0.7.52)
- Resolved 140: Published bundle leaves computed `./agent.js` child-executor import, breaking workflow child agents (High).
- Fix: child-executor keeps lazy loading but uses a literal `import('./agent.js')`, and build/release guards reject raw child-executor runtime imports in generated bundles before publishing.
- Verification: fixed release line v0.7.52 was checked at the bundle/package level, not only through source-level TypeScript tests.

### 2026-06-15: Issue 138 added & resolved
- Added & Resolved 138: Workflow host RPC 边界对对象载荷零校验 — `synthesize` 传非数组 inputs 崩裸 TypeError + `runAgent`/`spawnAgent` 缺 name/prompt 静默烧 token (High)
- Root cause: host RPC 边界对标量字符串参数两层校验，但对对象载荷（runAgent/spawnAgent/synthesize/log input）只检查"是对象"后 `as unknown as` 裸转，字段形状零校验；`buildSynthesisPrompt` 同步 `.inputs.map` 让非数组直接崩，runAgent/spawnAgent 的缺字段则静默派发空 objective 子 Agent。
- Fix: runtime 容忍 inputs 为 array/string/object（`normalizeSynthesisInputs/Rubric`）+ script-runner 新增 `readSpawnAgentInput`/`readSynthesizeInput`/`readLogEvent` 替换 4 处裸转、强制 name/prompt 非空 + readOnly 布尔 + rubric 非空 + generator prompt 提示。
- Verification: workflow 全套件 135 passed、agent+coding typecheck clean、`npm run build:packages` success。

### 2026-06-05: Issue 137 added & resolved
- Added & Resolved 137: Streamable HTTP MCP transport drops `Mcp-Session-Id` on sessionful servers (High)
- Root cause: `createStreamableHttpTransport` did not persist the session id returned by initialize and did not attach it to later POST / GET / DELETE requests.
- Fix: persist `Mcp-Session-Id`, inject it into later requests, delay notification stream startup until after the first successful POST, and clear session state on 404 expiry.
- Verification: transport regression tests, MCP provider/tool tests, agent package typecheck, and live `toolMcpCall` smoke against `http://82.156.201.14:4747/api/mcp`.

### 2026-05-16: Issue 132 resolved (v0.7.41)
- Resolved 132: `h2-boundary-runner.test.ts` "session.jsonl" ENOENT — eager-read + retry budget enlargement
- Strategy: structurally eliminate the race window (read content immediately after `findEvalSessionJsonl`'s `fs.stat` succeeds, before git diff / worktree cleanup / 3x fs.writeFile add 200-400ms) instead of just absorbing it
- AgentTaskResult adds `sessionJsonlContent: string | null` (alongside existing `sessionJsonlPath`); persistCell now consumes content directly (no readFile)
- retry budget: 6 attempts × `[50, 100, 200, 400, 800]` ms backoff = ~1.55s total (outlasts Windows AV scan windows observed >150ms in initial fix attempt)
- Verification: 5 sequential full-suite runs (heavy parallel load) green; no warning fired

### 2026-05-16: Issue 132 + Issue 133 added (test flake tracking)
- Added 132: `h2-boundary-runner.test.ts` "session.jsonl" ENOENT race — runner silent error swallow + cleanup race causes intermittent flake under heavy parallel load (Low, Open，调研中，per user 暂不动 runner 代码)
- Added 133: `repo-intelligence/runtime.test.ts` "falls back to OSS when premium returns malformed preturn payloads" intermittent flake under heavy parallel load (Low, Open，独立调研，per user 不推迟到后续版本 milestone)
- 同期 `compaction.test.ts` "keeps partial summary progress when a later summary attempt fails" 加 `{ timeout: 15_000 }` 直接 fix（precedent commit `d4a47bc9` 模式）

### 2026-05-09: Issue 129 added & resolved
- Added 129: Auto 模式下纯只读管道命令被误判为"修改文件"并强制确认 (Medium)
- Resolved 129 in v0.7.38: 三个相互叠加的根因（`2>NUL` 假阳性 + 缺 `findstr` 白名单 + 管道一票否决）以最小切口"strip-then-classify"统一修掉
- 新增 `NULL_DEVICE_REDIRECT_PATTERN` 模块常量被 `isBashReadCommand` / `isBashWriteCommand` 共用；`BASH_SAFE_READ_COMMANDS` 加 `findstr`、`fc`、`where` 三件套
- 新加 8 个 unit test，全包重跑 232/232 PASS

### 2026-04-11: Issue 107 added
- Added 107: harnessProfile 类型命名残留 - H0/H1/H2 应替换为 worker-chain composition (Medium Priority)
- 由 FEATURE_061 Phase 5 识别，237 处引用跨 10 文件，需 v0.7.16 提交后独立处理

### 2026-04-03: Issue 105 added
- Added 105: kodax -c 历史记录未注入 LLM 上下文 - resume 路径可能存在 gitRoot 过滤不一致 (Medium Priority)
- 代码链分析完成，确认代码路径完整但存在多个潜在故障点
- 主要关注: agent.ts 中 storage.list() 未传 gitRoot 参数、旧会话缺少 gitRoot 字段、compact 策略下 initialMessages 不传递

### 2026-03-28: Issues 102-104 resolved
- Resolved 102: Repo-intelligence now reuses the same source-aware file collector across overview and query/index layers
- Resolved 103: managed-task planning now reuses `repoRoutingSignals` across `runKodaX()` and `task-engine`
- Resolved 104: repo-intelligence cache readers now validate runtime JSON shape and treat mismatches as cache invalidation

### 2026-03-28: Issues 102-104 added
- Added 102: Repo-intelligence mixes git-tracked and filesystem-discovered file sets (Medium Priority)
- Added 103: Managed-task planning recomputes repo routing signals in the same workspace (Low Priority)
- Added 104: Repo-intelligence cache JSON is read without runtime shape validation (Low Priority)

### 2026-03-27: Issue 101 resolved
- Resolved 101: Adaptive multi-agent code review loses Generator output and gives Evaluator a truncated handoff (High Priority)
- dependency handoff 现在保留 `Summary + Result artifact + fuller output`，Evaluator 不再只拿到截断摘要
- managed-task transcript 现在会保留非终态 worker 输出，Generator 文本不会在 Evaluator 收口后直接消失
- AMA 新增显式 refinement loop，review 最终答复也改成 final review，而不是 review-of-review

### 2026-03-27: Issue 101 added
- Added 101: Adaptive multi-agent code review loses Generator output and gives Evaluator a truncated handoff (High Priority)
- Generator review text vanishes from UI when Evaluator takes over, and lossy handoff (truncateText 400 chars) limits Evaluator evidence

### 2026-03-23: Issues 013-077 batch resolved
- Resolved 8 legacy low-priority issues (013, 014, 015, 017, 018, 055, 061, 077) at v0.6.17

### 2026-03-23: Issue 100 resolved
- Resolved 100: ACP Server 缺少日志/可观测性输出 (High Priority)
- 新增 `src/acp_logger.ts`，统一将 ACP 日志安全写入 `stderr`，避免污染 ACP `stdout` JSONL 协议流
- 补充 ACP 启动摘要、会话生命周期、prompt 开始/结束、权限协商、取消和错误日志
- 支持 `KODAX_ACP_LOG=off|error|info|debug` 控制 ACP 日志级别，并同步更新 CLI 帮助和 README 文档

### 2026-03-23: Issue 100 added
- Added 100: ACP Server 缺少日志/可观测性输出 (High Priority)
- 问题确认：`kodax acp serve` 当前缺少启动摘要、会话生命周期、权限协商、错误与关闭日志，stdout 又被 ACP JSONL 协议占用，导致实际只能依赖 stderr 做安全日志输出
- 后续修复方向：补充 stderr logger、启动摘要、关键生命周期日志，以及可控日志级别开关

### 2026-03-22: Technical debt audit merged into canonical issue tracker
- Verified and landed the fix batch for `C10`, `H17`, `H18`, `H53`, `H59`, `M37`, `M57`, and `M69` during the cleanup pass
- Rolled the remaining verified technical debt into active issues `094` through `099`, so each unresolved item now has a stable issue home
- Removed the temporary `docs/TECHNICAL_DEBT.md` document after migrating the remaining backlog into `KNOWN_ISSUES.md`

### 2026-03-19: Issue 090 resolved
- Resolved 090: CLI Provider 桥接语义降级：上下文与 MCP 能力丢失 (High Priority)
- 新增 provider capability profile，显式区分 Native API 与 CLI bridge，并记录上下文语义和 MCP 支持边界
- `/model` 与 `/status` 现在会直接披露 bridge provider 的限制：只转发最新一条用户消息，且 MCP 不可用
- 新增 `packages/llm/src/providers/capability-profile.test.ts` 与 `packages/repl/src/interactive/provider-capabilities.test.ts`，防止桥接 provider 再次被误标为原生语义

### 2026-03-19: Issue 089 resolved
- Resolved 089: Feature / Design / Summary 元数据漂移 (High Priority)
- 新增 `tests/tracker-consistency.test.ts`，自动校验 FEATURE_LIST 版本/summary、KNOWN_ISSUES summary/最高优先级 open issue，以及关键 design 文件存在性
- 同步修正 KNOWN_ISSUES summary 漂移，后续再发生同类问题会直接由测试报错

### 2026-03-18: Strategic comparison backlog intake
- Added 089: Feature / Design / Summary 元数据漂移 (High Priority)
- Added 090: CLI Provider 桥接语义降级：上下文与 MCP 能力丢失 (High Priority)
- Added 091: 缺少一等公民 MCP / Web Search / Code Search 工具体系 (High Priority)
- Added 092: Team 模式已暴露但原生多 Agent 架构仍未闭环 (High Priority)
- Added 093: 缺少 IDE / Desktop / Web 一体化分发表面 (Medium Priority)
- 来源：对标 opencode / Gemini CLI / Codex CLI / Claude Code 的差距分析，并已同步映射到 feature backlog

### 2026-03-16: Issue 088 新增并修复
- Added & Resolved 088: 消息列表视口布局不稳定 - 底部区域跳动/最后一行被裁剪 (High Priority)
- 核心变更：引入 Viewport Budget + Transcript Layout 架构
  1. 新增 `viewport-budget.ts` 统一计算底部区块行数
  2. 新增 `transcript-layout.ts` 将消息渲染改为扁平 TranscriptRow[] 数据模型
  3. StatusBar 导出 `getStatusBarText()` 纯函数供预算计算复用
  4. MessageList 移除 Static/Dynamic 分割，改为统一 TranscriptRow 渲染
  5. AutocompleteSuggestions 状态管理提升到父组件
  6. Select 对话框选项根据 viewport budget 截断
- Code Review 遗留 5 个未修复问题（model fallback、paddingY 未扣除等）
- 新增 7 个测试用例（viewport-budget 3 + transcript-layout 4）
- 版本：v0.5.39

### 2026-03-13: Issue 087 修复
- Added & Resolved 087: 自动补全触发冲突 - @文件路径中/错误触发命令补全 (Medium Priority)
- 问题：输入 `@.kodax/` 时，路径中的 `/` 错误触发命令补全
- 根因：多个 Completer 的 `canComplete()` 只检查触发符位置，未检查是否在有效触发位置（开头或空格后）
- 解决方案：统一规则 - `/` 和 `@` 不在开头时，前面必须有空格才能触发补全
- 修改文件：
  - `packages/repl/src/interactive/autocomplete.ts` - FileCompleter, CommandCompleter
  - `packages/repl/src/interactive/autocomplete-provider.ts` - shouldTrigger
  - `packages/repl/src/interactive/completers/argument-completer.ts` - ArgumentCompleter
  - `packages/repl/src/interactive/completers/skill-completer.ts` - SkillCompleter

### 2026-03-13: Issue 087 修复
- Added & Resolved 087: 自动补全触发冲突 - @文件路径中/错误触发命令补全 (Medium Priority)
- 问题：输入 `@.kodax/` 时，路径中的 `/` 错误地触发了命令补全
- 根因：各 Completer 的 `canComplete()` 只检查最后一个 `/` 或 `@`，没有验证是否在有效的触发位置
- 修复：统一触发规则 - `/` 和 `@` 在输入中段时，前面必须有空格才能触发
- 修改文件：
  - `packages/repl/src/interactive/autocomplete.ts`
  - `packages/repl/src/interactive/autocomplete-provider.ts`
  - `packages/repl/src/interactive/completers/argument-completer.ts`
  - `packages/repl/src/interactive/completers/skill-completer.ts`
- 测试：71 个测试全部通过，- 版本：v0.5.33

### 2026-03-12: Issue 086 新增
- Added 086: 自动补全前缀匹配方向错误导致超长输入仍匹配短选项 (High Priority)
- 根因分析：`combinedMatch()` 中的 `prefixMatch()` 检查方向错误，检查的是"选项是否以用户输入开头"而非"用户输入是否以选项开头"
- 现象：输入 `/model zhipu-coding` 时，补全列表仍显示 `zhipu` 选项，按回车会替换为 `/model zhipu`
- 影响文件：`packages/repl/src/interactive/fuzzy.ts`, `autocomplete-provider.ts`, `autocomplete.ts`, `argument-completer.ts`

### 2026-03-12: Issue 083 修复
- Resolved 083: 缺少快捷键系统 (Medium Priority)
- 实现内容：
  1. 创建集中式快捷键注册表 (ShortcutsRegistry)
  2. 创建 useShortcut React Hook 集成 KeypressContext
  3. 定义默认快捷键（中断、清屏、帮助、思考等）
  4. 添加 GlobalShortcuts 组件注册全局快捷键
  5. 集成 ShortcutsProvider 到 InkREPL
  6. 帮助面板仅在输入为空时显示，发送后自动隐藏
- GPT Review 后修复：
  1. `?` 快捷键优先级从 -10 提升到 150（高于 InputPrompt 的 100）
  2. 添加 Shift+Tab 转义序列 `\x1b[Z` 支持
  3. 移除 toggleWorkMode 快捷键（语义错误）
  4. 移除用户配置相关代码（按用户要求不实现）
- 修改文件：`packages/repl/src/ui/shortcuts/` 目录下 7 个文件 + `InkREPL.tsx` + `InputPrompt.tsx` + `keypress-parser.ts`
- 设计决策：按用户要求不实现用户配置文件，保持简洁

### 2026-03-12: Issue 085 修复
- Added & Resolved 085: 只读 Bash 命令白名单未在非 plan 模式复用 (Medium Priority)
- 修复内容：
  1. 将 `isBashReadCommand()` 检查移到所有模式下都生效
  2. 将只读命令检查移到**受保护路径检查之前**，项目目录外的只读命令也能自动放行
- 修改文件：`packages/repl/src/ui/InkREPL.tsx`, `packages/repl/src/interactive/repl.ts`

### 2026-03-12: Issue 084 新增
- Added 084: 流式响应长时间静默中断无任何提示 (High Priority)
- 现象：长时间（9小时）后会话静默中断，无重试/错误信息，API 无调用日志
- 可能原因：流式响应 `for await` 循环在网络断开时静默结束，或超时机制未生效

### 2026-03-11: Won't Fix Issues 归档
- Archived 3 Won't Fix issues to ISSUES_ARCHIVED.md:
  - 039: 死代码 printStartupBanner (误报)
  - 053: /help 命令输出重复渲染
  - 063: Shift+Enter 换行功能失效
- Remaining: 10 Open issues only

### 2026-03-11: Issue 058 归档
- Issue 058 (终端流式输出闪烁问题) 归档到 ISSUES_ARCHIVED.md
- VS Code Terminal 兼容性问题已确认解决方案（关闭 GPU 加速）
- Remaining: 10 Open, 3 Won't Fix

### 2026-03-11: Issue 归档
- 31 resolved issues archived to ISSUES_ARCHIVED.md
- Remaining: 10 Open, 1 Partially Resolved, 3 Won't Fix
- Issue 083 added: 缺少快捷键系统 (Medium Priority)

### 2026-03-11: Issue 状态审查更新
- **Issue 006**: Open → Resolved (存储层 `getFeatureByIndex()` 添加了范围验证)
- **Issue 039**: Open → Won't Fix (误报 - `printStartupBanner` 函数实际在 `repl.ts` 第 156 行被调用，非死代码)
- **Issue 060**: Deferred → Resolved (定时器已同步：StreamingContext flush 80ms 与 Spinner 动画帧 80ms 同步)
- **Issue 067**: Open → Resolved (v0.5.27 实现了正确的重试循环和回调式 UI 通知)
- **Issue 069**: Open → Resolved (`toolAskUserQuestion` 工具已存在于 `packages/coding/src/tools/ask-user-question.ts`)
- **Issue 070**: Open → Resolved (代码审查确认换行符在流式管道中被正确保留，非 KodaX 代码问题)
- **Issue 081**: Open → Resolved (Provider 已使用 `useMemo` 记忆化，所有回调使用 `useCallback` 包装)
- 更新 Summary 统计: 10 Open, 32 Resolved, 1 Partially Resolved, 3 Won't Fix

### 2026-02-28: Issue 052 修复
- Resolved 052: 受保护路径确认对话框显示错误选项
- 修复 `gitRoot` 变量读取错误：从 `options.context?.gitRoot` 改为 `context.gitRoot`
- 新增 `isCommandOnProtectedPath()` 函数检测 bash 命令中的受保护路径
- 扩展受保护路径检查：同时覆盖 `write`/`edit` 工具和 `bash` 命令
- 修改文件：`InkREPL.tsx`, `permission/permission.ts`, `permission/index.ts`

### 2026-02-28: Issue 051 修复
- Resolved 051: 权限确认取消时无提示
- 在 `beforeToolExecute` 中用户拒绝确认时添加取消提示消息
- 修改文件：`packages/repl/src/ui/InkREPL.tsx`

### 2026-02-27: Issue 002 标记为 Won't Fix
- Issue 002 (/plan 命令未使用 _currentConfig 参数) 标记为 Won't Fix
- 理由：下划线前缀是 TypeScript 标准约定，表示"故意不使用"
- 类型签名要求该参数，无法删除
- 无实际功能问题

### 2026-02-27: Issue 001 已修复
- Issue 001 (未使用常量 PLAN_GENERATION_PROMPT) 已修复
- 删除了 `packages/repl/src/common/plan-mode.ts` 中未使用的 `PLAN_GENERATION_PROMPT` 常量（25 行代码）
- 该常量从未被 `generatePlan` 函数使用，是纯粹的死代码删除

### 2026-02-27: Issue 046 最终修复
- Issue 046 (Session 恢复时消息显示异常) 已完全修复
- 根本原因分析和修复：
  1. **用户消息重复**：`InkREPL.tsx` 和 `agent.ts` 都添加用户消息，删除前者的 push 操作
  2. **消息截断**：`MessageList.tsx` 默认 `maxLines=20` 太小，改为 1000
  3. **[Complex content]**：纯 tool_result 消息返回空字符串并在 UI 层过滤
  4. **thinking 内容显示**：`extractTextContent` 不应提取 thinking 块内容
- 修改文件：`InkREPL.tsx`, `MessageList.tsx`, `message-utils.ts`

### 2026-02-26: Issue 046 重新打开
- Issue 046 (Session 恢复时消息显示异常) 并未完全修复
- 发现更多问题：
  1. 用户消息重复显示（同一消息出现两遍）
  2. Assistant 回复被截断（显示 `... (33 more lines)`）
  3. tool_result 仍显示为 [Complex content]
- 提升优先级为 High

### 2026-02-26: Issue 046 部分修复（后发现问题未解决）
- 扩展 extractTextContent 支持 thinking/tool_use/redacted_thinking 块
- 但后续测试发现仍有用户消息重复、回复截断等问题

### 2026-02-26: Issue 036 修复
- Resolved 036: React 状态同步潜在问题 - 将三个独立 useState 合并为单一状态对象，确保原子更新

### 2026-02-26: Issue 037 状态更新
- Resolved 037: 两套键盘事件系统冲突 - InputPrompt 已迁移使用 KeypressContext
- InkREPL 现使用 KeypressProvider 包裹，使用优先级系统注册处理器
- 当前 Open Issues 降至 12 个

### 2026-02-26: Issue 047 新增
- Added 047: 流式输出时界面闪烁 (Medium Priority)
- 高速流式输出时界面出现闪烁，可能与 Ink 渲染频率有关

### 2026-02-26: Issue 019 修复
- Resolved 019: 状态栏 Session ID 显示问题 - 移除截断逻辑，显示完整 Session ID
- 修正 KNOWN_ISSUES.md 中过时的描述（原描述针对已废弃的 status-bar.ts）
- 当前 Open Issues 降至 12 个

### 2026-02-26: Issue 011 & 012 修复
- Resolved 011: 命令预览长度不一致 - 统一使用 PREVIEW_MAX_LENGTH 常量
- Resolved 012: ANSI Strip 性能问题 - 缓存正则表达式避免重复编译
- 更新 Issue 011 状态（之前已修复但未更新状态）
- 当前 Open Issues 降至 15 个

### 2026-02-25: Issue 045 新增
- Added 045: Spinner 出现时问答顺序颠倒 (High Priority)
- 问题表现与 Issue 040 类似，都涉及渲染顺序问题
- 需要进一步排查 Spinner 组件与 MessageList 的渲染顺序关系

### 2026-02-25: Issue 040 修复完成
- Resolved 040: REPL 显示问题 - 命令输出渲染位置错误
- 最终方案：捕获 console.log 输出并添加到 history
- 命令输出现在按正确顺序出现在用户消息之后
- 相关提交：fddc97c, 9c40f40

### 2026-02-24: Issue 040 重新打开
- Issue 040 之前的修复只解决了部分问题
- 新发现的根本问题：命令输出（/help, /model 等）渲染在 Banner 下面、用户消息上面
- 根因：console.log 被 Ink patchConsole 捕获后渲染在 MessageList 之前的位置
- 解决方案：修改命令返回输出字符串，添加到 history 而非使用 console.log

### 2026-02-24: Issue 040 修复 (v0.4.2)
- Resolved 040: REPL 显示问题 - Banner重复/消息双重输出
- 修复内容：
  1. Banner 使用 Ink `<Static>` 组件固定在顶部
  2. 移除冗余的 `console.log` 用户消息输出
  3. MessageList 在流式响应时过滤掉最后一条 assistant 历史
  4. 添加 React 状态更新等待确保渲染顺序正确

### 2026-02-24: v0.4.0 发布 + Issue 040 更新
- 完成架构重构：@kodax/core + @kodax/repl monorepo
- 更新 Issue 040：添加实际测试观察结果
  - Banner 延迟显示（首次交互后才出现）
  - 用户消息双重显示（console.log + MessageList）
  - [Complex content] 与实际内容重复显示
  - 命令输出实际可见（问题 3 部分缓解）
  - 新发现 punycode 弃用警告（低优先级）
- 修复计划调整为短期快速修复 + 长期架构重构

### 2026-02-24: Issue 044 修复
- Resolved 044: 流式输出时 Ctrl+C 延迟生效
- 根因：AbortSignal 未传递给底层 SDK，HTTP 请求无法被取消
- 修复：传递 signal 给 Anthropic/OpenAI SDK 的 create 方法
- 参考 Gemini CLI 的 abort 处理模式实现
- 更新 6 个文件实现完整的中断功能

### 2026-02-23: Issue 040 详细分析
- 深度分析 040: REPL 显示严重问题
- 发现问题远超预期：重复消息、占位符、命令不可见、顺序混乱
- 对比 Gemini CLI 的 ConsolePatcher 架构
- 提出短期修复和长期重构方案
- 长期方案融合到 v0.4.0 monorepo 重构计划

### 2026-02-23: Issue 044 新增
- Added 044: 流式输出时 Ctrl+C 延迟生效 (High Priority)
- 根因：流式迭代期间 Ctrl+C 事件被延迟处理
- 043 修复了 AbortSignal 传递，但 Ctrl+C 按键事件处理仍有问题

### 2026-02-23: Issue 043 修复
- Resolved 043: 流式响应中断不完全
- 添加 AbortSignal 传递链：UI → runKodaX → provider → SDK
- 参考 Gemini CLI 的 abort 处理模式实现
- 更新 7 个文件实现完整的中断功能

### 2026-02-23: Issue 035 后续修复
- Resolved 041: 历史导航清空输入无法恢复
- Resolved 042: Shift+Enter/Ctrl+J 换行无效
- Added 043: 流式响应中断不完全（需要传递 AbortSignal 到 API 调用）

### 2026-02-23: REPL 显示问题
- Added 040: REPL 历史显示乱序 - Banner 出现在对话中间 (High Priority)
- 根因：console.log 与 MessageList 双重输出 + Ink patchConsole 机制导致渲染顺序混乱
- 解决方案：移除冗余的 console.log 用户输入输出

### 2026-02-22: Issue 状态更新
- Issue 037 (两套键盘事件系统冲突) → 计划在 v0.4.0 解决，已融合到 feature design
- Issue 038 (输入焦点竞态条件) → Won't Fix，理论问题无实际影响
- Issue 039 (死代码 printStartupBanner) → 计划在 v0.4.0 解决，已融合到 feature design
- 更新 v0.4.0 feature design 文档，添加同步解决的已知问题章节

### 2026-02-22: REPL 代码审查
- Added 035: Backspace 检测边缘情况 (High Priority)
- Added 036: React 状态同步潜在问题 (Medium Priority)
- Added 037: 两套键盘事件系统冲突 (Medium Priority)
- Added 038: 输入焦点竞态条件 (Low Priority)
- Added 039: 死代码 printStartupBanner (Low Priority)
- 所有新 issue 都包含详细的根因分析和安全修复方案
- Issue 037, 038, 039 推迟到 v0.4.0 处理

### 2026-02-22: 代码质量修复
- Resolved 008: 交互提示缺少输入验证
- Resolved 009: 不安全的类型断言

### 2026-02-21: 格式更新 (v0.3.3)
- 更新 KNOWN_ISSUES.md 格式以符合新版 known-issues-tracker 技能规范
- 添加 `Introduced` 和 `Fixed` 版本追踪字段
- 根据提交历史推断问题引入版本（v0.3.1: 交互式 UI 首次引入）

### 2026-02-20: v0.3.3 流式显示修复
- Resolved 031: Thinking 内容不显示
- Resolved 032: 非流式输出
- Resolved 033: Banner 消失
- Resolved 034: /help 输出不可见
- Added 28 test cases

### 2026-02-20: Phase 6-8 完成与会话管理修复
- Resolved 029: --continue 会话不恢复
- Resolved 030: gitRoot 未设置

### 2026-02-20: v0.3.2 高优先级问题修复
- Resolved 026: Resize handler 空引用
- Resolved 027: 异步上下文直接退出
- Resolved 028: 超宽终端分隔符

### 2026-02-20: 按键问题修复
- Resolved 023: Delete 键无效
- Resolved 024: Backspace 键无效
- Resolved 025: Shift+Enter 换行无效

### 2026-02-19: 代码审查与重构
- Resolved 020: 资源泄漏 - Readline 接口
- Resolved 021: 全局可变状态
- Resolved 022: 函数过长
- Added open issues 001-018 from code review
