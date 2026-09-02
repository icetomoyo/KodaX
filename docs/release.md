# Release & Binary Distribution

KodaX is distributed as **standalone binaries** built with `bun build --compile`.
Target machines do **not** need Node.js or any runtime installed.

## Distribution layout

Each archive (`tar.gz` for Linux/macOS, `zip` for Windows) contains the
following side-by-side files. Extract it into a dedicated directory:

```
./
├── kodax                          # Bun-compiled executable (~60 MB)
├── builtin/                       # Built-in skills
│   ├── code-review/SKILL.md
│   ├── tdd/SKILL.md
│   └── ...
├── provider-capabilities.json     # Provider metadata
├── semantic-worker.js             # Repo-intelligence Worker
├── runtime-worker.js              # SDK Runtime Worker
├── constructed-handler-worker.js  # Constructed-tool Worker
└── vendor/kodax-native/<platform-arch>/
    ├── manifest.json               # Protocol and SHA-256 manifest
    ├── LICENSE-APACHE.txt          # Native component license
    └── kodax[-windows]-text-transaction.node  # Trusted text binding
```

Windows archives additionally contain `kodax-windows-sandbox.exe` in the same
native directory and the pinned ASRT runner at
`vendor/srt-win/<arch>/srt-win.exe`. The native directory also carries
`NOTICE-windows-sandbox.txt`, including the Codex-informed attribution.

Run `./kodax` (or `kodax.exe`) from any working directory. The binary locates
all sidecars relative to `process.execPath`, so the extracted files must be
moved or archived as one unit.

## Supported targets

| Target          | OS / Arch                       | CI runner          |
| --------------- | ------------------------------- | ------------------ |
| `win-x64`       | Windows 10 1809+ / x64          | `windows-latest`   |
| `linux-x64`     | Linux glibc 2.27+ / x64         | `ubuntu-latest`    |
| `linux-arm64`   | Linux glibc 2.27+ / aarch64     | `ubuntu-24.04-arm` |
| `darwin-x64`    | macOS 11+ / Intel               | `macos-15-intel`   |
| `darwin-arm64`  | macOS 11+ / Apple Silicon       | `macos-15`         |

Win7 and pre-glibc-2.27 distros (NeoKylin v7, CentOS 6/7) are **not supported**.
LoongArch64 / MIPS are **not supported** (Bun has no toolchain for them).

## Local builds (manual testing)

### Prerequisites

- Node.js 20+ (for build orchestration)
- Bun on PATH:
  ```
  Windows : scoop install bun       # or: npm i -g bun
  macOS   : brew install bun        # or: npm i -g bun
  Linux   : curl -fsSL https://bun.sh/install | bash
  ```
- `npm ci` at repo root

### Commands

```bash
# Current platform/architecture only
npm run build:native
npm run build:binary

# Explicit target on its matching native host
npm run build:native
node scripts/build-binary.mjs --target=linux-arm64

# Reuse existing dist/ (skip TypeScript rebuild)
node scripts/build-binary.mjs --skip-tsc

# Clean prior outputs first
node scripts/build-binary.mjs --clean
```

Output lives under `dist/binary/<target>/`. FEATURE_295 native bindings are
built and executed on a matching OS/architecture; the release workflow's five
native runners aggregate the npm package afterward. The build runs the local
artifact with an isolated `KODAX_HOME` and requires `a2a list` to emit exactly
one A2A v2 JSON document. A supplementary manual version smoke is:

```bash
dist/binary/linux-x64/kodax --version
```

## v0.7.90 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.90`. This release is
prepared for the `v0.7.90` tag and GitHub Release; npm publication remains a
separate manual operator step. It includes every commit after `v0.7.89`:

- workspace-session RPC timeouts fail pending requests and retire the shared
  ASRT session through orderly close; cleanup uses the 130-second reset-grace
  budget instead of the generic RPC deadline;
- daemon diagnostics retain Error names/messages, AggregateError members, and
  cyclic cause chains rather than collapsing details to `{}`;
- chained-compaction clone provenance uses the direct physical predecessor,
  keeps a retained predecessor addressable during one-hop archive slimming,
  and attaches archive markers to the retained topology;
- run-scoped tool materialization normalizes open lease/embedder schemas to the
  provider object-schema contract and filters invalid `required` entries;
- all product, architecture, SDK, public guide, release, feature-tracker, and
  `kodax_manual` documentation is synchronized for this stabilization release.

The release intentionally contains Runtime/sandbox, Agent lineage, Coding
runtime, and REPL persistence system-code fixes. It does not weaken fail-closed
cleanup, permission, or sandbox fallback contracts.

Before tagging, all of the following must be true:

1. all package versions, `CHANGELOG.md`, README/README_CN, PRD/HLD/DD/ADR,
   feature tracker, known-issue record, public docs, this checklist,
   `docs/features`, and `kodax_manual` agree on v0.7.90;
2. focused tests cover orderly workspace-session timeout retirement and
   diagnostics, direct clone provenance and archive topology, run-scoped schema
   normalization, and the existing v0.7.89 feature contracts;
3. TypeScript, config-template checks, bundled SDK/Worker/sidecar builds, fast,
   unit, contract, and system suites pass;
4. the packed `kodax-ai-kodax-0.7.90.tgz` is inspected and smoke-installed into
   an empty consumer for the root package and all 12 SDK subpaths;
5. root and `docs/features` are clean, with the submodule commit reachable from
   its remote; `.codex*` local artifacts and alternate pnpm metadata are ignored
   and not tracked;
6. GitHub CI is green for the exact commit on Node 20/22, Unix Runtime,
   Windows Shell, and packaged Electron gates; the tag-triggered Release job
   produces all platform archives, sidecars, and `SHA256SUMS`. npm publication is
   left to the maintainer.

Only after these gates pass may the exact commit be tagged `v0.7.90`.

## v0.7.96-alpha.6 release preparation

Release state: commit `a71d2b98` is tagged as `v0.7.96-alpha.6` and published
as a GitHub pre-release. The exact commit passed the branch CI and tag-triggered
Release workflows; the release contains the audited universal npm tarball,
five platform archives, per-archive checksums, and `SHA256SUMS` (13 assets).
npm publication remains a separate manual maintainer action.

Release gates:

1. Every root/workspace package and lockfile entry is `0.7.96-alpha.6`; public
   declarations, README/README_CN, PRD/HLD/DD/ADR, feature/release records,
   SDK/configuration guides, regression guides, changelog, and `kodax_manual`
   describe the same sandbox-first contract.
2. Recognized nested shell forms remain recursively inspectable; unlowerable
   bodies stay opaque for exact outer Exec Policy and the normal Edits/Auto[LLM]
   host-boundary decision. Only explicit matched forbids and concrete critical
   effects are non-bypassable.
3. A loaded embedded Windows native manifest resolves its exact verified
   protected-cache hash before mutable package/link source. A missing exact hash
   publishes atomically. Neither path adds a command lock, serial queue, or retry.
4. Real Windows dual-Runtime, background-shell-plus-foreground, large-tree cold
   start, target-start, terminal-proof, and host-fallback gates overlap without
   a machine-global admission boundary.
5. Injecting `EPERM` into post-proof private-Temp leaf removal must preserve the
   proven command result and emit a warning. Per-command cleanup must never
   remove the shared hashed parent or delay an independent shell; native
   lifecycle/Job-drain failure remains fail-closed.
6. Typecheck, native fmt/test/clippy, focused and full Vitest suites, build,
   declaration generation, package-independence checks, documentation links,
   and `git diff --check` pass on the exact commit. GitHub CI must be green before
   tagging or publishing.

These gates passed on commit `a71d2b98`. The exact commit is tagged
`v0.7.96-alpha.6`; the resulting
[GitHub pre-release](https://github.com/icetomoyo/KodaX/releases/tag/v0.7.96-alpha.6)
and its audited assets are published. npm publication remains manual.

## v0.7.96-alpha.5 release preparation

Release state: `v0.7.96-alpha.5` is tagged and published as a GitHub
pre-release on the release-record commit. npm publication remains a manual
maintainer action. It
contains the alpha.4 permission-profile work and completes Issue 326 with
per-command runner/pipe/Job lifecycles, no machine-global command-hot-path
  mutex or queue, atomic native-artifact self-healing, subprocess-free warm
  path/identity/hash verification, and SemVer-bounded idle-daemon replacement.

Release gates:

1. Every root/workspace package and lockfile entry is `0.7.96-alpha.5`; an
   alpha.5 client replaces an idle older daemon, refuses to kill a busy older
   daemon, does not downgrade a newer daemon, and does not mutate an unknown
   version.
2. Native protocol/setup are generation 10. Independent sessions overlap;
   cancellation, timeout, controller loss, and target/runner/host termination
   produce durable per-command Job-drain evidence without a global queue. Warm
   admission changes no shared Temp/AppData ACL: each command receives an empty
   private Temp child. Every canonical root converges the same stable capability
   ACE set and the command token activates only its authorized clauses.
   A native controller/runner-path failure retires only that broker generation;
   existing holders continue and the next command starts a replacement.
3. Missing current-hash native artifacts self-heal on execution through atomic
   publication. Doctor is verify-only; publication owns owner/DACL construction,
   and every warm command performs local path/identity/hash verification without
   a PowerShell subprocess. Existing malformed content fails closed. Alpha.6
   later made a loaded embedded manifest prefer its exact protected-cache
   generation before mutable npm-link source.
4. Typecheck, native fmt/test/clippy, focused Vitest suites, real opt-in Windows
   dual-Runtime/background/termination gates, build, declaration generation,
   and `git diff --check` pass on the exact commit.
5. Tag or publish only after review and CI. This checklist does not push refs,
   create releases, or publish packages.

Only after these gates pass may the exact commit be tagged
`v0.7.96-alpha.5`.

## v0.7.96-alpha.4 release preparation (superseded)

Release state: `v0.7.96-alpha.4` was superseded before tagging by alpha.5 and
must not be tagged, released, or published. This historical checklist records
the permission-profile work now carried by alpha.5. It replaces the
permission-before-sandbox path with the FEATURE_297
sandbox-first route, four permission profiles, JSONC Exec Policy, fixed
90/180-second host-boundary review, broader sandbox reads/environment/network,
and normal global Git behavior.

Release gates:

1. Root/Worker/daemon capability metadata must advertise `sandboxRuntime:11`,
   `runtimeAutoModeGuardrail:5`, and `sharedSessionSettings:2`; an auto-starting
   alpha.4 client must safely replace an idle sandbox-v9-or-older, guardrail-v4, or shared-settings-v1 daemon,
   while attach-only clients fail closed.
2. Public declarations must expose exact canonical/input permission types,
   host-owned Exec Policy and Auto-review options, ACP mode identifiers, and
   the capability constant from the documented package entries.
3. Legacy `auto-in-project`, `permissionMode: "default"`, Rules-engine fields,
   and malformed auto-rules files must remain non-blocking compatibility input;
   none may become Full Access or be rewritten destructively.
4. README/README_CN, PRD/HLD/DD/ADR-070, Issue 326, feature tracker/design, public
   configuration and SDK guides, config templates, changelog, test guide, and
   `kodax_manual` must describe the same sandbox-first route.
5. Protocol 10/setup generation 10, the generation-8 one-time migration proof,
   released-generation-9 in-place startup recovery, one-install convergence for
   concurrent interactive clients, post-setup real target-start/exit proof,
   protected two-phase synchronous setup with no admission-overlapping helper,
   the native sidecar/hash manifest, receipt
   convergence, bounded-idle broker release, and the real opt-in Windows
   120-second dual-Runtime overlap must pass the Issue 326 regression guide. A
   fresh custom `KODAX_HOME` below system TMP must also launch without widening
   the shared Temp ACL or reporting a missing protected deny-root.
6. Focused permission/Runtime/daemon/ACP/manual tests, full typecheck, `git diff --check`,
   build, package contents, generated declarations, and an empty-consumer smoke
   of the root, `/runtime`, and `/repl` exports must pass. Root and
   `docs/features` must both be clean and the recorded submodule commit reachable.
7. Tag or publish only the exact reviewed commit after CI is green. Publishing
   packages, pushing Git refs, and creating releases remain explicit operator
   actions and are not performed by this checklist.

Do not tag `v0.7.96-alpha.4`; use the alpha.5 release gates above.

## v0.7.96-alpha.3 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.96-alpha.3`. This
pre-release is prepared for the `v0.7.96-alpha.3` tag and GitHub pre-release;
npm publication remains a separate manual operator step. It includes every
commit after `v0.7.96-alpha.2`:

- Scoped Provider credential leases (ADR-068, `9587ab29` + `141d2c1f`): the
  v2 broker keeps Provider secrets in the OS keychain and resolves them
  lazily, per wire call, for one closed purpose inside revocable leases;
  manual compaction runs keychain-only through a stable `session.compact`
  operation target; native/constructed child Agents derive the intersection
  of the live parent authorization and their concrete capabilities; detached
  Workflows receive closable derived leases; `config.readEffective()` exposes
  credential presence and source without values. Admission hardening makes
  shared-daemon native/constructed/workflow Agent turns require an explicit
  scoped binding and fail closed without one, closes Agent authority wire
  records against unknown fields, and keeps the v1 exact-Provider broker
  compatible.
- Bounded daemon client inventory (`d05f07e1`): daemons advertising
  `daemonClientInventory:1` return display-only connected-client diagnostics
  through `preflight.clients`.
- Docs: ADR-068, DD credential sections, embedder-guide binding/inventory
  contracts, and the self-knowledge manual topics (`sdk`, `agents`).

Gates:

1. Version agreement: root + 4 workspace packages + `package-lock.json`
   workspace entries are `0.7.96-alpha.3`, matching this document,
   `docs/features`, and the embedder guide.
2. Branch CI green on the release commit on Node 20/22 before tagging. The
   Release pipeline is unchanged, so the tag-triggered Release workflow
   reuses the validated alpha pipeline.
3. Tag `v0.7.96-alpha.3` on the release commit; the Release workflow
   publishes the GitHub pre-release with the npm tarball and `SHA256SUMS`.
   npm publication stays with the maintainer.

Only after these gates pass is the commit tagged `v0.7.96-alpha.3`.

## v0.7.96-alpha.2 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.96-alpha.2`. This is
a Windows-only hotfix pre-release for the `v0.7.96-alpha.2` tag and GitHub
pre-release; npm publication remains a separate manual operator step. It
includes every commit after `v0.7.96-alpha.1`:

- Issue 325 fix: restore `windowsAclPowerShellExecutable()` in
  `src/sandbox-runtime.ts` verbatim from the pre-cleanup implementation so the
  Windows boot-identity probe resolves PowerShell 7 / Windows PowerShell 5.1
  again, plus a win32-only regression test that reproduces the
  `ReferenceError` when the helper is missing.
- Docs: CHANGELOG alpha.2 entry, KNOWN_ISSUES Issue 325 record, this release
  checklist, README/README_CN hotfix notes, baseline pointers
  (PRD/HLD/DD/FEATURE_LIST/public_docs), the `alpha.1.1` version
  normalization in `docs/features/v0.7.96.md`, and the Issue 325 regression
  guide.

Gates:

1. Version agreement: root + 4 workspace packages + `package-lock.json`
   workspace entries are `0.7.96-alpha.2`, matching this document and
   `docs/features`.
2. Windows regression coverage: the Windows boot identity resolution test
   passes on real Windows (30 passed / 40 skipped in
   `src/sandbox-runtime.test.ts`) and fails with the exact `ReferenceError`
   when the fix is reverted (verified with a `git stash` RED check).
3. Branch CI green on the hotfix commit on Node 20/22 before tagging. The
   Release pipeline is unchanged by this hotfix, so the tag-triggered Release
   workflow reuses the alpha.1 pipeline.
4. Tag `v0.7.96-alpha.2` on the hotfix commit; the Release workflow publishes
   the GitHub pre-release with the npm tarball and `SHA256SUMS`. npm
   publication stays with the maintainer.

Only after these gates pass is the commit tagged `v0.7.96-alpha.2`.

## v0.7.96-alpha.1 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.96-alpha.1`. This
pre-release is prepared for the `v0.7.96-alpha.1` tag and GitHub Release (marked
as a pre-release); npm publication remains a separate manual operator step. It
includes every commit after `v0.7.95`:

- FEATURE_295 (ADR-066): trusted text transactions and platform shell
  containment are separate authorities on Windows, Linux, and macOS.
  `write`/`edit`/`multi_edit`/`insert_after_anchor`/`undo` commit in the
  trusted KodaX Runtime with final identity policy, a cross-Runtime per-file
  kernel lock, revision CAS, and flushed atomic replacement, never entering
  ASRT/workspace-session state. Windows shell keeps ASRT for network/account
  services and runs through the native restricted-token runner with
  nonce-bound per-policy private desktops and creation-time Job containment;
  the native shell protocol is version 7 and Windows `sandboxRuntime` advances
  `5 -> 6` (one-time `kodax sandbox setup` cutover), while
  `runtimeExitSettlement:2` and `crashOutcomeModel:2` are unchanged;
- FEATURE_296 (ADR-067): capacity-debt admission replaces the local
  tool-result capacity hard gate. Executed `tool_use`/`tool_result` pairs
  commit; an over-budget batch records `capacityDebt` metadata, the next
  iteration's compaction relieves the debt through a bounded recovery ladder,
  the output reserve shrinks floor-bounded (3000), an irreducibly oversized
  fresh user input degrades to a paged volatile pointer, and local capacity
  terminals classify as `failureKind: "context_capacity"` with structured
  `contextTokens`;
- classified Runtime failures expose one credential-safe `failureDetail`
  across failure events, Run result/status, and Session diagnostics;
- unified text diff rendering anchors LCS matches so unchanged regions render
  stably across sequential edits;
- Issue 303: the bundled `srt-win` sidecar is loaded from its physical
  packaged location; Issue 304: trusted-text targets are read under lock on
  Unix; Issue 305/306: controller pipe ownership and packaged Electron native
  artifact loading are pinned; Issue 317: ASRT package-store hardlinks are
  verified against the embedded release digest; Issue 318: traversal-named ACE
  entries are rejected; Issues 310-316/319/320: sandbox v2 hardening and
  review fixes recorded in `docs/KNOWN_ISSUES.md`;
- custom providers can opt into image input with `"imageInput": true`;
  `deepseek-v4-flash-vision-exp` and `glm-5.3-flash` are registered;
- synchronized product, architecture, detailed-design, public SDK, release
  checklist, feature index, known-issue, and `kodax_manual` content.

Issues 256, 307, 308, 309, and 321-324 remain open and documented; none block
this pre-release.

Before tagging, all of the following must be true:

1. all package versions, `CHANGELOG.md`, README/README_CN, PRD/HLD/DD/ADR,
   feature tracker, known-issue record, public docs, this checklist,
   `docs/features`, and `kodax_manual` agree on v0.7.96-alpha.1;
2. focused tests cover the trusted-text/native-shell authority split, the
   `sandboxRuntime:6` cutover fencing, capacity-debt admission and the
   recovery ladder, `context_capacity` terminal classification,
   credential-safe `failureDetail`, anchored diff rendering, and the existing
   v0.7.95 regression contracts;
3. TypeScript, config-template checks, bundled SDK/Worker/sidecar builds, fast,
   unit, contract, and system suites pass;
4. the packed tarball is inspected and smoke-installed into an empty consumer
   for the root package and all 12 SDK subpaths — locally, `node
   scripts/release.mjs --pack-only` produces a host-only LOCAL TEST TARBALL
   that keeps `private: true` (npm refuses to publish it) for `npm install
   <path>` consumer testing; the universal publish candidate is assembled,
   audited, and installed by the Release workflow's `npm-package` job from
   all five platform authorities;
5. root and `docs/features` are clean, with the submodule commit reachable from
   its remote; `.codex*` local artifacts and alternate pnpm metadata are ignored
   and not tracked;
6. GitHub CI is green for the exact commit on Node 20/22, Unix Runtime,
   Windows Shell, and packaged Electron gates; a manual `release.yml`
   `workflow_dispatch` for `target=all` (no release created) is green before
   tagging; the tag-triggered Release job produces all platform archives,
   sidecars, `SHA256SUMS`, and the CI-built universal npm tarball
   (`kodax-ai-kodax-0.7.96-alpha.1.tgz` + `kodax-ai-kodax-npm.sha256`) as
   GitHub pre-release assets. npm publication remains a manual maintainer
   step: `node scripts/release.mjs` downloads those exact Release assets,
   verifies the sha256 checksum and sidecar audit, and publishes those bytes.

Only after these gates pass may the exact commit be tagged `v0.7.96-alpha.1`.

## v0.7.95 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.95`. This maintenance
release is prepared for the `v0.7.95` tag and GitHub Release; npm publication
remains a separate manual operator step. It includes every commit after
`v0.7.94`:

- Windows sandbox cleanup is self-healing: the machine-global cleanup Job is
  recoverable across reboots, recovery tickets repair without operator input,
  and background retries observe the exact daemon and supervisor process
  generations before acting;
- same-boot `unconfirmed-owner` recovery retries automatically and clears only
  after an exact sandbox-user SID-idle proof, with text cleanup attestations
  retained across the retry;
- dynamic worktrees register their cleanup policy at creation instead of
  inheriting an implicit one;
- Issue 301: learning locks whose owner data is stale zero-byte, malformed, or
  truncated are reclaimed through unchanged bytes/stat verification; fullscreen
  TUI teardown restores the terminal; Explicit Skill execution separates exact
  canonical user input from execution overlays, rejects multiple active
  references, and treats `PreToolUse` failure as a denial; terminal Run
  persistence failure publishes `unknown` (or `run_settlement_not_persisted`)
  and invalidates live Session observations when no durable event can be
  committed, while a terminal status rename that commits before later cleanup
  throws is reread once and emitted exactly once;
- Issue 302: the coding runtime delays its public `onComplete` completion
  signal until extension completion and asynchronous result finalization have
  produced the authoritative `KodaXResult`, including the lost-executor-Promise
  fallback path, so A2A responses can no longer publish an empty successful
  answer;
- Windows `sandboxRuntime` advances `4 -> 5` and `runtimeExitSettlement`
  advances `1 -> 2`; `crashOutcomeModel:2` is unchanged;
- synchronized product, architecture, detailed-design, public SDK, release
  checklist, feature index, known-issue, regression-guide, and `kodax_manual`
  content.

The release does not add a Feature slot and does not close Issue 256's
lost-ancestor descendant-closure boundary. No system implementation is
silently changed by the release-documentation pass.

Before tagging, all of the following must be true:

1. all package versions, `CHANGELOG.md`, README/README_CN, PRD/HLD/DD/ADR,
   feature tracker, known-issue record, public SDK guide, this checklist,
   `docs/features`, and `kodax_manual` agree on v0.7.95;
2. focused tests cover the recoverable cleanup Job, self-healing recovery
   tickets, generation-checked background retries, dynamic-worktree policy
   registration, same-boot SID-idle clearing, stale learning-lock reclamation,
   fullscreen TUI teardown, Explicit Skill exact-input / multi-reference /
   `PreToolUse` denial, terminal `unknown` / rename-reread settlement, the
   delayed `onComplete` finalization contract, and the existing v0.7.94
   regression contracts;
3. TypeScript, config-template checks, bundled SDK/Worker/sidecar builds, fast,
   unit, contract, and system suites pass, with any host-only Windows sandbox
   limitation documented rather than silently changing system code;
4. the packed `kodax-ai-kodax-0.7.95.tgz` is inspected and smoke-installed into
   an empty consumer for the root package and all 12 SDK subpaths;
5. root and `docs/features` are clean, with the submodule commit reachable from
   its remote; `.codex*` local artifacts and alternate pnpm metadata are ignored
   and not tracked;
6. GitHub CI is green for the exact commit on Node 20/22, Unix Runtime,
   Windows Shell, and packaged Electron gates; the tag-triggered Release job
   produces all platform archives, sidecars, and `SHA256SUMS`. npm publication is
   left to the maintainer.

Only after these gates pass may the exact commit be tagged `v0.7.95`.

## v0.7.94 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.94`. This maintenance
release is prepared for the `v0.7.94` tag and GitHub Release; npm publication
remains a separate manual operator step. It includes every commit after
`v0.7.93`:

- Runtime text tools may overlap a compatible live Bash lease because snapshot
  and commit run through the same ASRT workspace policy, with same-path FIFO
  and fail-closed sandbox unavailability for covered workspace targets;
- sandboxed text mutations reject hard links, mint backup identity from the
  opened helper, and keep worktree Git drain fail-closed when process-tree
  completion is unprovable;
- Windows sandboxed git trusts authorized repo roots only, never
  `safe.directory=*`, and requires linked-worktree / submodule backlinks
  (Issue 300);
- scheduled daemon shutdown reports a failed cleanup instead of a safe stop;
- a missing workspace directory omits the concurrent text sandbox at Run start
  instead of aborting option construction;
- Runtime advertises `conversationHistory:2` so hosts can reject daemons that
  still expose the legacy ordinary-history projection;
- explicit Skill invocation (`/<name>`, `/skill:<name>`) is independent of
  model discovery; `disable-model-invocation` cannot be bypassed by a
  model-authored slash token, and structured `skillInvocation` provenance
  follows Workflow/child execution;
- invalid Skill `allowed-tools` entries and malformed hook JSON are diagnosed;
  `PostToolUse` still runs if an embedder result observer throws;
- sandboxed text-helper stdin failures stay on the operation Promise, and
  linked-worktree / submodule relationship files are read through strict byte
  bounds before git trust;
- Run terminal settlement observes every finalization rejection, reports
  `run_settlement_not_persisted` when durability is unknown, and recovers an
  admitted `runId` through `runs.get()` / `runs.await()` instead of
  replaying `runs.start()`;
- synchronized product, architecture, detailed-design, public SDK, release
  checklist, feature index, known-issue, regression-guide, and `kodax_manual`
  content.

The release does not add a Feature slot, does not change
`sandboxRuntime` / `crashOutcomeModel` versions, and does not close Issue 256's
lost-ancestor descendant-closure boundary. `gitSafeDirectory:
authorized-repo-roots` is a v4 marker field, not a capability bump. No system
implementation is silently changed by the release-documentation pass.

Before tagging, all of the following must be true:

1. all package versions, `CHANGELOG.md`, README/README_CN, PRD/HLD/DD/ADR,
   feature tracker, known-issue record, public SDK guide, this checklist,
   `docs/features`, and `kodax_manual` agree on v0.7.94;
2. focused tests cover concurrent sandboxed text mutations, Issue 300 git
   trust, helper stdin observation, bounded git-metadata reads, scheduled
   shutdown failure reporting, missing-workspace Run start, explicit vs
   model Skill invocation, invalid `allowed-tools` / malformed hook
   diagnosis, Run-settlement / typed-disconnect recovery, and the existing
   v0.7.93 regression contracts;
3. TypeScript, config-template checks, bundled SDK/Worker/sidecar builds, fast,
   unit, contract, and system suites pass, with any host-only Windows sandbox
   limitation documented rather than silently changing system code;
4. the packed `kodax-ai-kodax-0.7.94.tgz` is inspected and smoke-installed into
   an empty consumer for the root package and all 12 SDK subpaths;
5. root and `docs/features` are clean, with the submodule commit reachable from
   its remote; `.codex*` local artifacts and alternate pnpm metadata are ignored
   and not tracked;
6. GitHub CI is green for the exact commit on Node 20/22, Unix Runtime,
   Windows Shell, and packaged Electron gates; the tag-triggered Release job
   produces all platform archives, sidecars, and `SHA256SUMS`. npm publication is
   left to the maintainer.

Only after these gates pass may the exact commit be tagged `v0.7.94`.

## v0.7.93 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.93`. This maintenance
release is prepared for the `v0.7.93` tag and GitHub Release; npm publication
remains a separate manual operator step. It includes every commit after
`v0.7.92`:

- a durable Windows `failed` shutdown outcome ends the 170-second orderly
  daemon-exit wait and enters the existing exact recovery path immediately
  (Issue 297);
- after a verified Windows boot change, settlement may recover shared previous-
  boot ACL markers under the machine lock, records the recovery scope, and only
  then clears revalidated markers (Issue 299);
- Anthropic/OpenAI `APIUserAbortError` objects are classified by isolated SDK
  class identity when the request signal is already aborted, so managed Stop
  stays `interrupted` before credential redaction (Issue 298);
- synchronized product, architecture, detailed-design, public SDK, release
  checklist, feature index, known-issue, regression-guide, and `kodax_manual`
  content.

The release does not add a Feature slot, does not change
`sandboxRuntime` / `crashOutcomeModel` versions, and does not close Issue 256's
lost-ancestor descendant-closure boundary. Same-boot ACL and POSIX recovery
remain fail-closed. No system implementation is silently changed by the
release-documentation pass.

Before tagging, all of the following must be true:

1. all package versions, `CHANGELOG.md`, README/README_CN, PRD/HLD/DD/ADR,
   feature tracker, known-issue record, public SDK guide, this checklist,
   `docs/features`, and `kodax_manual` agree on v0.7.93;
2. focused tests cover failed-outcome fast settlement, previous-boot ACL
   recovery, isolated provider abort classification (Issues 297/298/299), and
   the existing v0.7.92 regression contracts;
3. TypeScript, config-template checks, bundled SDK/Worker/sidecar builds, fast,
   unit, contract, and system suites pass, with any host-only Windows sandbox
   limitation documented rather than silently changing system code;
4. the packed `kodax-ai-kodax-0.7.93.tgz` is inspected and smoke-installed into
   an empty consumer for the root package and all 12 SDK subpaths;
5. root and `docs/features` are clean, with the submodule commit reachable from
   its remote; `.codex*` local artifacts and alternate pnpm metadata are ignored
   and not tracked;
6. GitHub CI is green for the exact commit on Node 20/22, Unix Runtime,
   Windows Shell, and packaged Electron gates; the tag-triggered Release job
   produces all platform archives, sidecars, and `SHA256SUMS`. npm publication is
   left to the maintainer.

Only after these gates pass may the exact commit be tagged `v0.7.93`.

## v0.7.92 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.92`. This maintenance
release is prepared for the `v0.7.92` tag and GitHub Release; npm publication
remains a separate manual operator step. It includes every commit after
`v0.7.91`:

- filesystem-effect queue tickets share an operation token with the exact
  coordinator lock, heartbeat while waiting, and are reclaimed only when stale
  and no longer owning that lock;
- effect release records a token-scoped durable marker so a later coordinator
  transaction can retire the matching settled owner while the daemon PID remains
  alive;
- file-lock release handoff is retryable (single handle close; marker only after
  owner cleanup fails);
- managed Runs persist the canonical Session before completion; repo-intelligence
  and task-file projections are asynchronous maintenance; Runtime uses the
  executor Promise, not managed `onComplete`, as terminal authority;
- `sandboxRuntime:4` and `crashOutcomeModel:2` fence idle older daemons;
- resume reconstruction derives the TUI transcript from canonical Session
  `messages` first; a sparse or damaged `uiHistory` may overlay display
  metadata or append UI-only entries, but cannot hide ordinary conversation
  (Issue 296). Presentation-only `agent-completed` / `task-completed` events
  remain host-owned when a non-empty CLI `uiHistory` exists;
- synchronized product, architecture, detailed-design, public SDK, sandbox
  guide, release checklist, feature index, known-issue, regression-guide, and
  `kodax_manual` content.

The release intentionally contains Runtime/daemon, Agent lock, and Coding
runtime system-code changes. It does not weaken fail-closed ownership,
permission, shell, or sandbox contracts, and it does not close Issue 256's
lost-ancestor descendant-closure boundary. No system implementation is silently
changed by the release-documentation pass.

Before tagging, all of the following must be true:

1. all package versions, `CHANGELOG.md`, README/README_CN, PRD/HLD/DD/ADR,
   feature tracker, known-issue record, public SDK guide, this checklist,
   `docs/features`, and `kodax_manual` agree on v0.7.92;
2. focused tests cover stale same-PID ticket reclaim with an exact-lock fence,
   recorded-release owner recovery, managed Session-before-completion ordering,
   non-authoritative managed `onComplete`, canonical-first resume restore
   (Issue 296), and the existing v0.7.91 regression contracts;
3. TypeScript, config-template checks, bundled SDK/Worker/sidecar builds, fast,
   unit, contract, and system suites pass, with any host-only Windows sandbox
   limitation documented rather than silently changing system code;
4. the packed `kodax-ai-kodax-0.7.92.tgz` is inspected and smoke-installed into
   an empty consumer for the root package and all 12 SDK subpaths;
5. root and `docs/features` are clean, with the submodule commit reachable from
   its remote; `.codex*` local artifacts and alternate pnpm metadata are ignored
   and not tracked;
6. GitHub CI is green for the exact commit on Node 20/22, Unix Runtime,
   Windows Shell, and packaged Electron gates; the tag-triggered Release job
   produces all platform archives, sidecars, and `SHA256SUMS`. npm publication is
   left to the maintainer.

Only after these gates pass may the exact commit be tagged `v0.7.92`.

## v0.7.91 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.91`. This maintenance
release is prepared for the `v0.7.91` tag and GitHub Release; npm publication
remains a separate manual operator step. It includes every commit after
`v0.7.90`:

- the SDK-owned `runtimeExitSettlement:1` capability and
  `settleKodaXRuntimeExit()` transaction, including exact owner/process-start
  and boot identity persistence, crash-resumable settlement, verified Windows
  process/Job/ACL repair, and fail-closed POSIX same-boot ambiguity;
- the SDK-owned live output-segment projection for provider retry, fallback,
  non-stream fallback, max-token continuation, and recovery, with logical
  `responseId`, physical `providerRequestId`, append/replace mode, and raw
  journal retention;
- standalone Bun packaging of the lazy Anthropic/OpenAI SDK dependency graphs,
  including transitive provider packages previously resolved from filesystem
  `node_modules`;
- bounded AskUser and permission lifecycles with owner AbortSignals, validated
  Runtime defaults, timeout-aware MCP elicitation, and the public
  `handleRuntimePermissionRequest()` host helper;
- stale prepared Session tails now recover through an authoritative full delta
  after `data_changed`; background persistence failures become diagnostics, and
  CLI/SDK hosts can configure `userInputTimeoutMs` independently from
  `permissionTimeoutMs`;
- synchronized product, architecture, detailed-design, public SDK, release,
  feature-index, known-issue, regression-guide, and `kodax_manual` content.

The release intentionally contains Runtime/daemon, LLM packaging, Coding
runtime, and SDK system-code changes. It does not weaken fail-closed ownership,
permission, shell, or sandbox contracts. No system implementation is silently
changed by the release-documentation pass.

Before tagging, all of the following must be true:

1. all package versions, `CHANGELOG.md`, README/README_CN, PRD/HLD/DD/ADR,
   feature tracker, known-issue record, public SDK guide, this checklist,
   `docs/features`, and `kodax_manual` agree on v0.7.91;
2. focused tests cover crash-resumable exit settlement, exact owner and ACL
   recovery, output-segment replacement/continuation, lazy provider loading,
   bounded user-input/permission lifecycles, stale prepared-session recovery,
   and the existing v0.7.90 regression contracts;
3. TypeScript, config-template checks, bundled SDK/Worker/sidecar builds, fast,
   unit, contract, and system suites pass, with any host-only Windows sandbox
   limitation documented rather than silently changing system code;
4. the packed `kodax-ai-kodax-0.7.91.tgz` is inspected and smoke-installed into
   an empty consumer for the root package and all 12 SDK subpaths;
5. root and `docs/features` are clean, with the submodule commit reachable from
   its remote; `.codex*` local artifacts and alternate pnpm metadata are ignored
   and not tracked;
6. GitHub CI is green for the exact commit on Node 20/22, Unix Runtime,
   Windows Shell, and packaged Electron gates; the tag-triggered Release job
   produces all platform archives, sidecars, and `SHA256SUMS`. npm publication is
   left to the maintainer.

Only after these gates pass may the exact commit be tagged `v0.7.91`.

## v0.7.89 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.89`. This release is
prepared for the `v0.7.89` tag and GitHub Release; npm publication remains a
separate manual operator step. It includes every commit after `v0.7.88`:

- Issue 293: managed-run and managed-runtime context envelopes are transparent
  to ordinary conversation topology and pagination, with v4 cache invalidation,
  physical-track boundaries, and fail-closed ambiguity for unverifiable branches.
- FEATURE_293: built-in zero-service `web_search` uses bounded DuckDuckGo HTML →
  Bing RSS → Bing HTML fallback, truthful attempt diagnostics, normalized direct
  URLs, freshness metadata, and isolated custom endpoint behavior.
- FEATURE_294: leased Host Tools materialize as run-scoped agent tools, publish a
  cache-stable host capability catalog line, dispatch registry-first, enforce
  conservative plan-mode metadata, revoke fail-closed, reject collisions, and
  support A2A `host:` authorization.
- Documentation, `kodax_manual`, and human regression coverage are synchronized
  for the two features and Issue 293.

The release changes coding, REPL conversation projection, Runtime daemon host
bridges, A2A authorization, and their tests. No shell or sandbox system code is
changed by this release preparation; existing shell/sandbox gates remain
mandatory and must pass on the exact release commit.

Before tagging, all of the following must be true:

1. all package versions, `CHANGELOG.md`, README/README_CN, PRD/HLD/DD/ADR,
   feature tracker, known-issue record, public docs, this checklist,
   `docs/features`, and `kodax_manual` agree on v0.7.89;
2. focused tests cover Issue 293 topology-transparent history/cache behavior,
   FEATURE_293 fallback ordering and custom endpoint isolation, and FEATURE_294
   host-tool materialization, collision/revoke hardening, plan-mode policy,
   registry-first dispatch, and A2A authorization;
3. TypeScript, config-template checks, bundled SDK/Worker/sidecar builds, fast,
   unit, contract, and system suites pass;
4. the packed `kodax-ai-kodax-0.7.89.tgz` is inspected and smoke-installed into
   an empty consumer for the root package and all 12 SDK subpaths;
5. the human checks in `docs/test-guides/ISSUE_293_v0.7.89_REGRESSION_GUIDE.md`
   and `docs/test-guides/ISSUE_294_v0.7.89_REGRESSION_GUIDE.md` are available
   for release acceptance;
6. root and `docs/features` are clean, with the submodule commit reachable from
   its remote; `.codex*` local artifacts and alternate pnpm metadata are ignored
   and not tracked;
7. GitHub CI is green for the exact commit on Node 20/22, Unix Runtime,
   Windows Shell, and packaged Electron gates; the tag-triggered Release job
   produces all platform archives, sidecars, and `SHA256SUMS`. npm publication is
   left to the maintainer.

Only after these gates pass may the exact commit be tagged `v0.7.89`.

## v0.7.88 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.88`. This release is
prepared for the `v0.7.88` tag and GitHub Release; npm publication remains a
separate manual operator step. It includes every change after `v0.7.87`:

- Actor settlement convergence v2: mutation order, process-local queue
  dequeue, writer eligibility, cancellable pre-commit work, canonical
  replacement, and serialized maintenance are distinct durability phases;
  capability negotiation exposes `actorSettlementConvergence:2`;
- bounded startup/resume work and the CLI startup dependency audit, including
  deferred Anthropic SDK, image, LSP, TypeScript, and extension dependencies;
- bounded guardrail classifier-reason diagnostics and REPL dismissal of stale
  learning-recovery notices after a query is submitted;
- GLM-5.3 as the default for `zhipu-coding`, `zai-coding`, and `ark-coding`,
  with `glm-5.2` retained and Ark's `glm-latest` alias preserved; exact wire
  IDs remain `glm-5.3` / `glm-5.2`, and `off` / `none` lowers to `low` for the
  always-thinking GLM-5.3 route;
- synchronized all current documentation, public SDK guides, `kodax_manual`,
  the `docs/features` submodule, known-issue totals, and regression guides.

The Actor controller, Runtime/storage, startup/resume, provider registry and
capability metadata, REPL, and bundle-boundary changes are intentional system
code changes, not test-only or release-process changes. The shell/sandbox
contracts were not changed by the release preparation work; their existing
regression gates remain mandatory. Issue 256's remaining Worker owner-lease
boundary remains open after v0.7.88 and receives no replacement target here.

Before tagging, all of the following must be true:

1. all package versions, `CHANGELOG.md`, README/README_CN, PRD/HLD/DD/ADR,
   feature tracker, known-issue record, public docs, this checklist,
   `docs/features`, and `kodax_manual` agree on v0.7.88;
2. focused tests cover GLM-5.3/5.2 availability, exact wire IDs, GLM
   `off`/`none` lowering, lazy heavy imports, REPL recovery dismissal, and
   Actor settlement convergence;
3. the exact commit passes the deterministic gate:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

4. the packed `kodax-ai-kodax-0.7.88.tgz` is inspected and smoke-installed
   into an empty consumer for the root package and all 12 SDK subpaths;
5. the human checks in
   `docs/test-guides/ISSUE_292_v0.7.88_REGRESSION_GUIDE.md` and
   `docs/test-guides/ISSUE_GLM53_v0.7.88_REGRESSION_GUIDE.md` pass;
6. root and `docs/features` are clean, with the submodule commit reachable
   from its remote; `.codex*` local artifacts are ignored and not tracked;
7. GitHub CI is green for the exact commit on Node 20/22, Unix Runtime,
   Windows Shell Contract, and packaged Electron jobs;
8. the tag-triggered Release workflow is green and publishes all expected
   archives, checksums, sidecars, and `SHA256SUMS`. npm publication is left to
   the maintainer.

Only after these gates pass may the exact commit be tagged `v0.7.88`.

## v0.7.87 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.87`. This release is
prepared for the `v0.7.87` tag and GitHub Release; npm publication remains a
separate manual operator step. It includes every commit after `v0.7.86`:

- GLM-5.3 capability, cost, context, output, and reasoning metadata for the
  public Zhipu and both Coding Plan aliases;
- `zhipu-coding` defaults to `glm-5.3` while retaining `glm-5.2` as an explicit
  rollback route;
- `zai-coding` defaults to `glm-5.2` while retaining `glm-5.3` for accounts
  granted overseas Coding Plan access;
- Coding Plan sends `glm-5.3` / `glm-5.2` verbatim, removing the invalid
  synthetic `[1m]` suffix;
- GLM-5.3 maps none/minimal/light/low to low, medium/high to high, and
  xhigh/max/ultra to max; `off` / `none` becomes enabled low-effort thinking
  because the upstream model does not support disabling thought. REPL controls
  hide the impossible off rung and report legacy saved intent as `off->low`;
- synchronized README/README_CN, package guide, PRD/HLD/DD/ADR, feature and
  issue records, public documentation, release checklist, feature-design
  submodule, regression guide, and `kodax_manual` content.

The provider registry, capability metadata, reasoning normalization, and
Anthropic/OpenAI-compatible serializers are intentional `packages/llm` system-
code changes, not test-only or release-process changes. Issue 256's remaining
Worker owner-lease boundary is not included and remains Open after v0.7.87;
this release assigns no replacement target.

Before tagging, all of the following must be true:

1. version metadata, changelog, README/README_CN, PRD/HLD/DD/ADR, feature
   tracker, known-issue record, this checklist, public SDK/package guides,
   `docs/features`, and `kodax_manual` agree on the v0.7.87 contract;
2. focused provider tests prove both models remain selectable, exact wire IDs
   contain no `[1m]` suffix, and GLM-5.3 off/none lowers to low for both
   Anthropic- and OpenAI-compatible transports;
3. minimal live probes confirm `zhipu-coding/glm-5.3`,
   `zhipu-coding/glm-5.2`, and `zai-coding/glm-5.2`; a
   `zai-coding/glm-5.3` 1220 response is recorded as account entitlement rather
   than model-ID failure;
4. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
5. the exact release commit passes the deterministic gate:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

6. the exact `kodax-ai-kodax-0.7.87.tgz` is hashed, inspected, and installed
   into an empty consumer that imports the root plus all 12 SDK subpaths;
7. the human checks in
   `docs/test-guides/ISSUE_GLM53_v0.7.87_REGRESSION_GUIDE.md` pass;
8. GitHub `CI` is green for the exact commit on Node 20/22, Unix Runtime
   socket, Windows Shell Contract, and packaged Electron jobs;
9. the tag-triggered release workflow is green and the GitHub Release contains
   all five archives, their five `.sha256` files, and `SHA256SUMS`. npm
   publication is left to the maintainer.

Only after these gates pass may the exact commit be tagged `v0.7.87`.

## v0.7.86 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry must be version `0.7.86`. This release is
prepared for the `v0.7.86` tag and GitHub Release; npm publication remains a
separate manual operator step. It is a non-Feature hardening release and
includes all commits after `v0.7.85`, including:

- atomic recovery of abandoned inline Runtime owner fences (Issue 291), with
  retryable close failures and fail-closed handling for ambiguous owners;
- process-start identities in Runtime owner records and learning-file locks,
  preventing PID reuse from preserving stale ownership;
- Windows sandbox lifecycle attestation, termination-proof-before-recovery,
  durable ACL owner markers, cross-profile recovery locking, and no-replay
  behavior when a Shell effect is not proven drained;
- Windows workspace Shell execution now preserves the case-insensitive
  `PATH`/`Path` environment contract, derives bounded read grants from the
  final shell PATH and executable, and carries quoted `cmd.exe` arguments
  through both broker layers without re-parsing them;
- exact Windows workspace, Agent Home, additional-filesystem, toolchain, and
  network policies now form a cross-process policy group. Compatible owners
  join without global ACL recovery and only the last owner performs recovery;
  incompatible policy or pre-start infrastructure failures return to the
  already-authorized normal permission path, while started/unknown commands
  are never replayed. Runtime sandbox capability v3 fences older daemon policy
  revisions;
- filesystem-effect coordinator handoff waits through the lock protocol's
  30-second stale-owner proof window, while incompatible effect categories
  retain the one-second fail-closed admission boundary;
- POSIX workspace-session safety latching, so an unconfirmed process-tree or
  cleanup failure blocks replacement sandbox sessions instead of allowing a
  stale owner to race a new one. Fresh `KODAX_HOME` policy roots are initialized
  before policy identity capture, concrete admission waits only for its
  workspace-local warm-up within the Shell abort/deadline, and failed lease
  cleanup retires the invalid cached session;
- explicit aggregation of spawn, lease-release, and sandbox-cleanup failures,
  with lifecycle safety diagnostics and retained recovery evidence;
- packaged Electron sandbox probes and regression coverage for all of the above.

These include intentional Runtime, agent, coding, and sandbox system-code
changes; they are not test-only or release-process changes. Issue 256 remains
Open: the Worker owner-lease portion needed to prove descendant closure after
an intermediate parent exits is not included in this release and is explicitly
rescheduled to `v0.7.87`.

Before tagging, all of the following must be true:

1. version metadata, changelog, README/README_CN, PRD/HLD/DD/ADR, feature
   tracker, known-issue record, this checklist, public SDK/package guides,
   `docs/features`, and `kodax_manual` agree on the v0.7.86 contract;
2. no incomplete Feature or known High release blocker is presented as
   shipped; Issue 256 remains explicitly Open and outside this release scope;
3. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
4. the exact release commit passes the deterministic gate:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

5. focused checks pass for Issue 291, Windows sandbox lifecycle/ACL behavior,
   Runtime owner recovery, process-start identity locks, `kodax_manual`, and
   the packaged Electron fixture;
6. the exact `kodax-ai-kodax-0.7.86.tgz` is hashed, inspected, and installed
   into an empty consumer that imports the root plus all 12 SDK subpaths;
7. GitHub `CI` is green for the exact commit on Node 20/22, Unix Runtime
   socket, Windows Shell Contract, and packaged Electron jobs;
8. the tag-triggered release workflow is green and the GitHub Release contains
   all five archives plus `SHA256SUMS`. npm publication is left to the
   maintainer.

Only after these gates pass may the exact commit be tagged `v0.7.86`.

## v0.7.85 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.85`. This release is
prepared for the `v0.7.85` tag and GitHub Release; npm publication remains a
separate manual operator step. The release includes all commits after
`v0.7.84`, including the following Feature and system-code scope:

- `FEATURE_289`: bounded Memory review draining, pipeline observability,
  startup/turn-end recovery, and the `memory doctor` surface;
- `FEATURE_290`: governed lesson/verdict production, `failedWithLesson`
  admission, and review safety boundaries;
- `FEATURE_291`: Session-scoped Runtime Event Journals, scoped replay cursors,
  A2A Session binding, and `sessionEventJournal:1` daemon negotiation;
- `FEATURE_292`: conversation-first Memory management, governed explicit
  remember/forget/recall/correction/decision handling, and the additive
  `MemoryManagementAgent` SDK facade;
- system-code fixes for Actor settlement convergence (Issue 282), Agent Home
  and learned-root guardrails (Issues 285/286), terminal Run startup replay
  avoidance (Issue 287), idle repo-intelligence Worker retirement (Issue 288),
  Windows sandbox/ACL containment, custom-provider completion, and their tests.

These are intentional runtime, agent, coding, REPL, SDK, and sandbox changes;
they are not test-only or release-process changes. Issue 256 remains Open: the
Worker owner-lease portion needed to prove descendant closure after an
intermediate parent exits is not included in this release and is explicitly
scheduled for `v0.7.86`.

Before tagging, all of the following must be true:

1. version metadata, changelog, README/README_CN, PRD/HLD/DD/ADR, feature
   tracker, known-issue record, this checklist, public SDK/package guides,
   `docs/features`, and `kodax_manual` agree on the v0.7.85 contract;
2. no incomplete Feature or known High release blocker is presented as
   shipped; Issue 256 remains explicitly Open and outside this release scope;
3. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
4. the exact release commit passes the deterministic gate:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

5. focused checks pass for F289/F290/F291/F292, Issues 282/287/288, the
   `kodax_manual` registry, Runtime session events, memory SDK, Agent Home
   guardrails, and repo-intelligence worker lifecycle;
6. the exact `kodax-ai-kodax-0.7.85.tgz` is hashed, inspected, and installed
   into an empty consumer that imports the root plus all 12 SDK subpaths.
   Runtime, semantic, sandbox, constructed-handler sidecars, provider
   capabilities, and built-in Skills must be present;
7. any benchmark/evaluation evidence follows
   `benchmark/EVAL_GUIDELINES.md` and remains supporting evidence rather than
   replacing correctness gates;
8. GitHub `CI` is green for the exact commit on Node 20/22, Unix Runtime
   socket, Windows Shell Contract, and packaged Electron jobs;
9. a manual `release.yml` `workflow_dispatch` with `target=all` is green
   before tagging, proving all five binary targets without creating a release;
10. only then is that exact commit tagged `v0.7.85`. The tag-triggered
    workflow must finish green and the GitHub Release must contain all five
    archives plus `SHA256SUMS`. npm publication is left to the maintainer.

## v0.7.84 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.84`. This release is
prepared for the `v0.7.84` tag and GitHub Release; npm publication remains a
separate manual operator step. Its scope is a non-Feature Actor
settlement-recovery hardening patch for Issue 282:

- Agent progress persistence is bounded to one in-flight durable projection
  plus one latest replacement, so terminal settlement is not delayed by an
  unbounded progress backlog;
- a same-owner Stop can reconcile a late Actor snapshot after an unknown
  durability outcome, validate the owner fence, quiesce remaining turns, and
  retry repair;
- Promise terminal facts remain authoritative over fallback callbacks after
  repair, while foreign owners, missing snapshots, and persistent storage
  failures remain fail-closed;
- no-op quiescence avoids an unnecessary Session rewrite. These are intentional
  runtime system-code fixes, not a new Feature release.

Issue 256's Worker owner-lease portion remains scheduled for `v0.7.85` and
`FEATURE_287` remains planned for `v0.7.93`; neither is represented as shipped
by this release.

Before tagging, all of the following must be true:

1. version metadata, changelog, README/README_CN, PRD/HLD/DD/ADR, feature
   tracker, known-issue record, this checklist, SDK/package guides,
   `docs/features`, and `kodax_manual` agree on the v0.7.84 contract;
2. no incomplete Feature or known High release blocker is presented as shipped;
   Issue 256 retains its v0.7.85 Worker owner-lease disposition;
3. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
4. a clean-install-equivalent deterministic gate passes on the exact release
   commit:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

5. focused Issue 282 regression checks pass for the Agent controller, Actor
   runtime, SDK Stop/recovery paths, and `kodax_manual` registry;
6. the exact publish-shaped `kodax-ai-kodax-0.7.84.tgz` is hashed, inspected,
   and installed into an empty consumer that imports the root plus all 12 SDK
   subpaths. Runtime, semantic, sandbox, and constructed-handler sidecars,
   provider capabilities, and built-in Skills must be present;
7. any performance evidence follows `benchmark/EVAL_GUIDELINES.md` and is
   supporting evidence, not a substitute for correctness gates;
8. GitHub `CI` is green for the exact commit on Node 20/22, the Unix Runtime
   socket job, Windows Shell Contract, and packaged Electron;
9. a manual `release.yml` `workflow_dispatch` for `target=all` is green before
   tagging, proving all five binary targets without creating a release;
10. only then is that exact commit tagged `v0.7.84`. The tag-triggered workflow
    must finish green and the GitHub Release must contain all five archives plus
    `SHA256SUMS`. npm publication remains the maintainer-owned manual step after
    the audited bytes are approved.

## v0.7.83 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.83`. This release is
prepared for the `v0.7.83` tag and GitHub Release; npm publication remains a
separate manual operator step. Its scope is a non-Feature Windows daemon
containment hardening patch:

- a new Windows daemon is created suspended, assigned to a kill-on-close Job
  Object before resume/user code, and watched by an out-of-Job supervisor until
  Job accounting reports zero active processes;
- `waitForRuntimeDaemonShutdown()` requires the exact durable cleanup outcome,
  daemon exit, and containment-supervisor exit; `daemonShutdownVerification:1`
  advertises this contract and CLI stop waits on the same boundary;
- legacy daemons without Job containment are not reported as verified and are
  not silently upgraded in place; explicit stop/relaunch is required before a
  host requires the capability;
- the review-found Job-assignment failure path terminates and waits for a
  still-suspended process before closing handles, preventing an uncontained
  orphan; this is an intentional runtime system-code fix;
- containment allows final cleanup to retire incomplete current-owner child
  records without redundant per-child synchronous exit hooks or repeated tree
  scans. The Worker owner-lease portion of Issue 256 remains scheduled for
  `v0.7.84`; `FEATURE_287` remains planned for `v0.7.93`.

Before tagging, all of the following must be true:

1. version metadata, changelog, README/README_CN, PRD/HLD/DD/ADR, feature
   tracker, known-issue record, this checklist, SDK/package guides,
   `docs/features`, and `kodax_manual` agree on the v0.7.83 contract;
2. no incomplete Feature or known High release blocker is presented as shipped;
   Issue 256 retains its v0.7.84 Worker owner-lease disposition;
3. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
4. a clean-install-equivalent deterministic gate passes on the exact release
   commit:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

5. focused verification covers Windows Job assignment before resume, supervisor
   exit after Job emptiness, exact shutdown verification, legacy-daemon refusal,
   managed-child containment pruning, CLI stop, and SDK upgrade behavior;
6. the exact publish-shaped `kodax-ai-kodax-0.7.83.tgz` is hashed, inspected,
   and installed into an empty consumer that imports the root plus all 12 SDK
   subpaths. Runtime, semantic, sandbox, and constructed-handler sidecars,
   provider capabilities, and built-in Skills must be present;
   Local `--pack-only` audit evidence: SHA-256
   `B4988DAD1B714A0C984B95E8BFA894E60FE6663A730486A26C340E32A5B1D71A`;
   consumer import evidence: root plus all 12 SDK subpaths.
7. any performance evidence follows `benchmark/EVAL_GUIDELINES.md` and is
   supporting evidence, not a substitute for correctness gates;
8. GitHub `CI` is green for the exact commit on Node 20/22, the Unix Runtime
   socket job, Windows Shell Contract, and packaged Electron;
9. a manual `release.yml` `workflow_dispatch` for `target=all` is green before
   tagging, proving all five binary targets without creating a release;
10. only then is that exact commit tagged `v0.7.83`. The tag-triggered workflow
    must finish green and the GitHub Release must contain all five archives plus
    `SHA256SUMS`. npm publication remains the maintainer-owned manual step after
    the audited bytes are approved.

## v0.7.82 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.82`. This release is
prepared for the `v0.7.82` tag and GitHub Release; npm publication remains a
separate manual operator step. Its scope is a non-Feature runtime-causality
patch:

- unfiltered daemon discovery composes the active MCP and lease-scoped Host Tool
  snapshots as live/complete data; an explicit `server` filter selects only its
  source, and a legacy provider is uncapped then reported incomplete/unknown;
- an observed managed Run Stop cooperatively fences later Provider recovery and
  continuation, Runner guardrail/tool dispatch, and Run-admitted Actor work;
  trusted Stop/Abort is classified before credential redaction without changing
  a genuine completion or an independent failure;
- `runtime.runs.submitInput()` resolves its admitted authoritative Run before
  reading mutable Session history, avoiding transient `data_changed` during
  active interrupt and after-turn admission while preserving predecessor
  settlement and exact-operation idempotency.

`FEATURE_287` remains planned for `v0.7.93`; no incomplete Feature is
represented as shipped. Issue 256 remains scheduled for `v0.7.84` and is not a
v0.7.82 gate.

Before tagging, all of the following must be true:

1. version metadata, changelog, README/README_CN, PRD/HLD/DD/ADR, feature
   tracker, known-issue record, this checklist, SDK/package guides,
   `docs/features`, and `kodax_manual` agree on the v0.7.82 contract;
2. no incomplete Feature or known High release blocker is presented as shipped;
   FEATURE_287 and Issue 256 retain the explicit dispositions above;
3. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
4. a clean-install-equivalent deterministic gate passes on the exact release
   commit:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

5. focused verification covers MCP/Host Tool source filtering and legacy
   discovery truthfulness; managed Stop versus completion/independent-failure
   races and trusted Abort redaction; and active interrupt/after-turn admission,
   predecessor settlement, and exact-operation idempotency;
6. the exact publish-shaped `kodax-ai-kodax-0.7.82.tgz` is hashed, inspected,
   and installed into an empty consumer that imports the root plus all 12 SDK
   subpaths. The Runtime, semantic, sandbox, and constructed-handler sidecars,
   provider capabilities, and built-in Skills must be present;

   Local `--pack-only` audit evidence: SHA-256
   `3530757F8B4A7084C056E2749BB6025904060D0E0A201715093EA337179E1C6D`;
   consumer import evidence: root plus all 12 SDK subpaths.
7. any performance evidence from `npm run bench:session-cold-open` follows
   `benchmark/EVAL_GUIDELINES.md` and is supporting evidence, not a substitute
   for correctness gates or a task-quality claim;
8. GitHub `CI` is green for the exact commit on Node 20/22, the Unix Runtime
   socket job, Windows Shell Contract, and packaged Electron;
9. a manual `release.yml` `workflow_dispatch` for `target=all` is green before
   tagging, proving all five binary targets without creating a release;
10. only then is that exact commit tagged `v0.7.82`. The tag-triggered workflow
    must finish green and the GitHub Release must contain all five archives plus
    `SHA256SUMS`. npm publication remains the maintainer-owned
    `node scripts/release.mjs` step after the audited bytes are approved.

## v0.7.81 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.81`. This release is
prepared for the `v0.7.81` tag and GitHub Release; npm publication remains a
separate manual operator step. Its scope is a non-Feature runtime-integrity
patch:

- a Runtime-owned Session saves each accepted active-Run interrupt prompt as
  its own canonical user entry before publishing delivery;
- `RuntimeInterruptInputStatus` and every newly durable
  `run.input.delivered` item expose the exact physical Session-lineage `entryId`;
  a multi-input safe-boundary drain keeps every user prompt separate and maps
  each queue id to its own entry;
- required persistence, canonical-provenance ambiguity, or a missing entry
  reference fails delivery closed before a delivered status or durable event can
  be emitted; a newly recorded reference survives replay, Session compaction,
  and Runtime restart, while legacy records remain readable without `entryId`.

`FEATURE_287` was rescheduled from `v0.7.81` to `v0.7.88` before this cut, so no
incomplete feature is represented as shipped. Issue 256 remains scheduled for
`v0.7.84` and is not a v0.7.81 gate.

Before tagging, all of the following must be true:

1. version metadata, changelog, README/README_CN, PRD/HLD/DD/ADR, feature
   tracker, this checklist, SDK/package guides, `docs/features`, and
   `kodax_manual` agree on the v0.7.81 contract;
2. no incomplete feature or known High release blocker is presented as shipped;
   FEATURE_287 has the explicit v0.7.88 disposition above and Issue 256 is not
   a v0.7.81 gate;
3. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
4. a clean-install-equivalent deterministic gate passes on the exact release
   commit:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

5. focused verification covers a two-input active-Run interrupt batch, exact
   `entryId` correlation in Run status and `run.input.delivered`, storage
   failure before delivery publication, and the same reference after event
   replay, Session compaction, and Runtime restart;
6. the exact publish-shaped `kodax-ai-kodax-0.7.81.tgz` is hashed, inspected,
   and installed into an empty consumer that imports the root plus all 12 SDK
   subpaths. The Runtime, semantic, sandbox, and constructed-handler sidecars,
   provider capabilities, and built-in Skills must be present;

   Local `--pack-only` audit evidence: SHA-256
   `07D746D19834D9C07DF1F4E4C345840485263E04EA9BDCD7D0595E49BEE66A13`;
   consumer import evidence: root plus all 12 SDK subpaths.
7. any performance evidence from `npm run bench:session-cold-open` follows
   `benchmark/EVAL_GUIDELINES.md` and is recorded as supporting evidence, not a
   substitute for correctness gates or a task-quality claim;
8. GitHub `CI` is green for the exact commit on Node 20/22, the Unix Runtime
   socket job, Windows Shell Contract, and packaged Electron;
9. a manual `release.yml` `workflow_dispatch` for `target=all` is green before
   tagging, proving all five binary targets without creating a release;
10. only then is that exact commit tagged `v0.7.81`. The tag-triggered workflow
    must finish green and the GitHub Release must contain all five archives plus
    `SHA256SUMS`. npm publication remains the maintainer-owned
    `node scripts/release.mjs` step after the audited bytes are approved.

## v0.7.80 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.80`. This release is
prepared for the `v0.7.80` tag and GitHub Release; npm publication remains a
separate manual operator step. Its scope is:

- the CLI honors `worker.configuredA2A` in `~/.kodax/config.json`: the embedded
  Runtime becomes Worker-hosted and loads the configured A2A plane inside the
  Worker owner, so configured outbound Agents appear as `external:<name>` and
  can be dispatched with `spawn_agent`. The mode rejects configured MCP servers
  or Extensions (they cannot cross the Worker boundary); Worker-hosted embedded
  CLI sessions also reduce run options to the JSON-safe wire DTO exactly like
  daemon mode instead of crashing with `RuntimeTransportBoundaryError`;
- a structured `RunnerIterationLimitError` failure carrying the last legal
  transcript, plus a 500-iteration per-invocation panic fuse for one
  uninterrupted managed tool loop that resets on every idle-yield resume while
  the managed-task idle-yield lifecycle stays unbounded;
- Issue 275 Auto permission fix: ordinary search scopes, directory and Git
  reads, and trusted tool side-effect metadata stay on the deterministic read
  path, GET-only `web_fetch` is a network read, and a
  `max_tokens`-truncated classifier retry uses a 1024-token output budget;
- managed-run repetition-loop prevention with bounded managed-run/runtime
  context projections, stall detection, and verifier-recorder/LLM-judge
  convergence, restoring parallel review and tightening parallel delegation
  guidance.

FEATURE_278/279/282/283/285 were explicitly rescheduled to `v0.7.85` on
2026-08-04 per the
[roadmap reschedule](FEATURE_LIST.md#2026-08-04-v0780-roadmap-reschedule);
v0.7.80 is a debug/patch slot and none of the items above claim a feature
outcome. Issue 256 remains scheduled for `v0.7.84` and is not a v0.7.80 gate;
Issue 275 was resolved in this release.

Before tagging, all of the following must be true:

1. version metadata, changelog, README/README_CN, PRD/HLD/DD/ADR, feature and
   issue trackers, this checklist, SDK/package guides, configuration examples,
   and `kodax_manual` agree on the 0.7.80 behavior;
2. no incomplete feature or known High release blocker is presented as shipped;
   FEATURE_278/279/282/283/285 have the explicit v0.7.85 disposition above, and
   Issue 256 is not a v0.7.80 gate;
3. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
4. a clean-install-equivalent deterministic gate passes on the exact release
   commit:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

5. focused human verification covers
   [`ISSUE_243_v0.7.79_REGRESSION_GUIDE.md`](test-guides/ISSUE_243_v0.7.79_REGRESSION_GUIDE.md)
   (configured A2A in embedded/Worker/daemon modes, now including the CLI
   `worker.configuredA2A` opt-in) and
   [`ISSUE_274_v0.7.79_REGRESSION_GUIDE.md`](test-guides/ISSUE_274_v0.7.79_REGRESSION_GUIDE.md),
   plus standalone `--version`, exactly-one-command execution, an Auto[LLM]
   read-heavy session (Issue 275), and a managed task that completes across
   idle-yield child completions without repetition or a panic-fuse exit;
6. the exact publish-shaped `kodax-ai-kodax-0.7.80.tgz` is hashed, inspected,
   and installed into an empty consumer that imports the root plus all 12 SDK
   subpaths. The Runtime, semantic, sandbox, and constructed-handler sidecars,
   provider capabilities, and built-in Skills must be present;

   Local `--pack-only` audit evidence: SHA-256
   `DF73C5256044043F16727688C9283D2596E2914A40789AEA1E3D8BC3EF58156A`.
7. any performance evidence from `npm run bench:session-cold-open` follows
   `benchmark/EVAL_GUIDELINES.md` and is recorded as supporting evidence, not a
   substitute for correctness gates or a task-quality claim;
8. GitHub `CI` is green for the exact commit on Node 20/22, the Unix Runtime
   socket job, Windows Shell Contract, and packaged Electron;
9. a manual `release.yml` `workflow_dispatch` for `target=all` is green before
   tagging, proving all five binary targets without creating a release;
10. only then is that exact commit tagged `v0.7.80`. The tag-triggered workflow
    must finish green and the GitHub Release must contain all five archives plus
    `SHA256SUMS`. npm publication remains the maintainer-owned
    `node scripts/release.mjs` step after the audited bytes are approved.

## v0.7.79 release preparation

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.79`. v0.7.79 was tagged at
commit `bbdc12c0` on 2026-08-04 after the push CI run and the manual
`target=all` release run were green, and the audited bytes were published to
npm. The prepared scope below remains the record of that release gate:

- FEATURE_281 explicit configured-A2A network authorization, including the
  Worker-hosted configured plane and independent default-deny permissions for
  private addresses and non-loopback plaintext HTTP;
- authoritative Runtime Session status, bounded read-only diagnostics,
  byte-preserving bundle export, strict transcript/history observation, and
  cold-Session capture/location/materialization reuse;
- immutable ordinary-conversation projection through standalone
  `readConversationHistory()` and Runtime `sessions.conversation*`, with only
  provenance/topology-proven copies folded and ambiguity retained;
- bounded text/reasoning event coalescing with
  `runtimeEventCoalescing:1` capability negotiation and idle-only daemon
  upgrade;
- standalone/bundled child-process, Session-ID, shell-probe, sidecar-layout,
  Windows command-path, Actor admission, and lineage-reconciliation hardening
  recorded in the v0.7.79 changelog, including explicit `unknown` cleanup
  outcomes instead of false success;
- OpenAI-compatible `maxOutputTokensField`, corrected DeepSeek V4 Flash/Pro
  reasoning profiles, text-only capability metadata, and current cost rates;
- first-run credential guidance, MCP environment-reference expansion, and
  protected Windows global-install ASRT runner preparation.

FEATURE_280 was explicitly rescheduled to `v0.7.81` on 2026-08-03, then to
`v0.7.86` on 2026-08-04 per the
[roadmap reschedule](FEATURE_LIST.md#2026-08-04-v0780-roadmap-reschedule);
none of the items above claim its cache-stable prompt/tool-surface outcome.
`docs/features/v0.7.79.md`, `FEATURE_LIST.md`, the README/README_CN release
notes, and this checklist were updated together with that decision.

Issue 256 was explicitly rescheduled to `v0.7.84` on 2026-08-04 and is not a
v0.7.79 release blocker. Identity-checked Windows process snapshots prevent
PID-reuse mis-kills and expose observable uncertainty, but they cannot prove
descendant closure after an intermediate parent exits. The v0.7.84 resolution
requires spawn-time Job Object containment plus an independently invalidatable
Worker owner lease; post-spawn assignment or a bare-PID fallback does not
satisfy that gate. `docs/features/v0.7.79.md`, `KNOWN_ISSUES.md`, this
checklist, and the README/README_CN release notes were updated together with
that decision.

Before tagging, all of the following must be true:

1. version metadata, changelog, README/README_CN, PRD/HLD/DD/ADR, feature and
   issue trackers, this checklist, SDK/package guides, configuration examples,
   and `kodax_manual` agree on the 0.7.79 behavior;
2. FEATURE_280 and Issue 256 have the explicit dispositions described above, and
   no incomplete feature or known High release blocker is presented as shipped;
3. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
4. a clean-install-equivalent deterministic gate passes on the exact candidate:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

5. focused human verification covers
   [`FEATURE_281_v0.7.79_TEST_GUIDE.md`](test-guides/FEATURE_281_v0.7.79_TEST_GUIDE.md)
   and
   [`ISSUE_243_v0.7.79_REGRESSION_GUIDE.md`](test-guides/ISSUE_243_v0.7.79_REGRESSION_GUIDE.md),
   plus standalone `--version`, exactly-one-command execution, configured A2A
   list/call, Session status/diagnostic/export/ordinary-conversation reads, and
   cancelled child cleanup. The v0.7.84 release gate separately requires
   Windows verification of descendant containment when an intermediate parent
   exits (Issue 256);
6. the exact publish-shaped `kodax-ai-kodax-0.7.79.tgz` is hashed, inspected,
   and installed into an empty consumer that imports the root plus all 12 SDK
   subpaths. The Runtime, semantic, sandbox, and constructed-handler sidecars,
   provider capabilities, and built-in Skills must be present;
7. any performance evidence from `npm run bench:session-cold-open` follows
   `benchmark/EVAL_GUIDELINES.md` and is recorded as supporting evidence, not a
   substitute for correctness gates or a task-quality claim;
8. GitHub `CI` is green for the exact commit on Node 20/22, the Unix Runtime
   socket job, Windows Shell Contract, and packaged Electron;
9. a manual `release.yml` `workflow_dispatch` for `target=all` is green before
   tagging, proving all five binary targets without creating a release;
10. only then is that exact commit tagged `v0.7.79`. The tag-triggered workflow
    must finish green and the GitHub Release must contain all five archives plus
    `SHA256SUMS`. npm publication remains the maintainer-owned
    `node scripts/release.mjs` step after the audited bytes are approved.

## v0.7.78 release verification

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.78`. The release contains:

- FEATURE_263 evidence-gated background Skill learning: Memory-first review,
  immutable project-scoped canaries, canonical record-gated discovery,
  exact-revision outcome attribution, and Learning Center control;
- FEATURE_276 complete first-run split-configuration setup without overwriting
  existing core/MCP/Extensions/A2A configuration or collecting secrets;
- FEATURE_277 intent-aligned Auto[LLM] permission behavior, bounded
  classifier retry/Accept-edits fallback, optional ASRT containment, explicit
  `/sandbox` diagnostics, and the standalone `/sandbox` SDK subpath;
- Runtime Actor ownership, daemon lifecycle, integration resilience, and
  packaged shell/sandbox hardening recorded in the v0.7.78 changelog;
- release-candidate closure for Skill promotion, Edit/Plan Skill admission,
  governed AMA Memory intent, unbounded Workflow Actor polling, and the
  `runtimeAutoModeGuardrail` v4 non-persistent fallback contract.

The release must be cut from one integrated commit after concurrent fix tasks
have landed. Evidence produced against an earlier working tree is preliminary
and must not be reused as the final release decision.

Before tagging, all of the following must be true:

1. both the root repository and `docs/features` submodule are clean, and the
   parent points to a submodule commit reachable from its remote;
2. a clean-install-equivalent deterministic gate passes on the exact candidate:

   ```bash
   npm ci
   npm run config:templates:check
   npm run build:packages
   npm run build:bundle
   npm run build:dts
   npm run test:full
   npm run test:electron-daemon:built
   node scripts/release.mjs --pack-only
   ```

3. the exact publish-shaped `kodax-ai-kodax-0.7.78.tgz` is hashed, inspected,
   and installed into an empty consumer that imports the root plus all 12 SDK
   subpaths; `/sandbox` declarations and
   `dist/sandbox-workspace-session.js` must be present;
4. FEATURE_263's preregistered paid semantic gate runs only after explicit
   owner authorization. Frozen revision `f263-v0.7.78.4` uses a four-call
   reviewer pilot, an inclusive 54-cell safety panel, and a 24-cell blinded
   downstream comparison. Its ceiling is 78 calls, 850,000 tokens, estimated
   `$0.78-$7.80`, and a hard `$10` external-spend cap. Raw output and blind
   main-session review stay outside the repository as required by
   `benchmark/EVAL_GUIDELINES.md`; the owner records the final ship decision.
   The entry point is `tests/feature-263-learning-release.eval.ts`;
5. FEATURE_277's required classifier semantic eval has a frozen experiment
   revision `f277-v0.7.78.4`, production-byte fixtures, budgets, raw dump, and
   blind review contract before any provider call. It uses a four-call pilot
   and an inclusive 60-cell panel with a 300,000-token ceiling, estimated
   `$0.60-$6.00`, and hard `$6` external-spend cap. Existing v0.7.33/v0.7.73
   evals are regression evidence, not a substitute for the v0.7.78 permission
   policy. The entry point is
   `tests/feature-277-permission-policy.eval.ts`;
6. GitHub `CI` is green for the exact commit on Node 20/22, the Unix Runtime
   socket job, Windows Shell Contract, and packaged Electron;
7. a manual `release.yml` `workflow_dispatch` for `target=all` is green before
   tagging, proving all five binary targets without creating a release;
8. only then is that exact commit tagged `v0.7.78`. The tag-triggered workflow
   must finish green and the GitHub Release must contain all five archives plus
   `SHA256SUMS`.

npm publication is deliberately outside this checklist's automated actions.
The maintainer publishes the already audited bytes with:

```bash
node scripts/release.mjs
```

Use `--otp=<code>` when npm 2FA requires it. Do not use bare `npm publish`;
the development manifest intentionally remains `private: true`.

The human verification guides are
[`FEATURE_263_v0.7.78_TEST_GUIDE.md`](test-guides/FEATURE_263_v0.7.78_TEST_GUIDE.md),
[`FEATURE_276_v0.7.78_TEST_GUIDE.md`](test-guides/FEATURE_276_v0.7.78_TEST_GUIDE.md),
and
[`FEATURE_277_v0.7.78_TEST_GUIDE.md`](test-guides/FEATURE_277_v0.7.78_TEST_GUIDE.md).

## v0.7.77 release verification

Release state: the root package, all four workspace packages, and every
`package-lock.json` workspace entry are version `0.7.77`. The candidate adds
FEATURE_274 pattern-aware adaptive AMA, FEATURE_275 governed event-triggered
memory intervention, the public 1M `kimi-k3` route, prompt-cache diagnostics,
Runtime interrupt/default-model reliability fixes, and the final child-runtime
cache/context identity and Actor capability hardening. Release hardening also
adds the host-configurable Shell Execution Contract, compaction-safe
request-only managed context, stable logical-context Provider cache affinity,
official Codex/Gemini CLI cache-usage preservation, ACP/native-CLI session
isolation with restartable pseudo transports and fail-closed process exits, and
terminal/schema/memory integrity fixes.

The version was tagged, released on GitHub, and published to npm on
2026-07-27. Its completed pre-tag gates were:

1. the deterministic local gate and exact tarball audit pass from a clean
   install;
2. the candidate commit's GitHub `CI` workflow is green for Node 20, Node 22,
   the Unix Runtime socket gate, the dedicated Windows Shell Contract gate,
   and packaged Electron on Windows;
3. the `docs/features` submodule points at the reviewed v0.7.77 design commit
   and both repositories are clean;
4. the preregistered F274/F275 paid evaluation is run only after explicit owner
   authorization and a frozen pre-call manifest, the main-session review is
   recorded, and the owner makes the joint ship decision. This gate completed
   on 2026-07-27 with a joint `SHIP` decision.

No task-effect improvement is claimed from deterministic tests or the bounded
release pilots.

Run the same deterministic shape as GitHub CI, followed by the exact package
inspection:

```bash
npm ci
npm run config:templates:check
npm run build:packages
npm run build:bundle
npm run build:dts
npm run test:full
node scripts/release.mjs --pack-only
```

`--pack-only` runs the production build, temporarily applies the publishable
`private: false` metadata, creates the exact candidate archive, audits the
bundled Sidecar prompt and budget bridge, and restores the development
manifest. Use `kodax-ai-kodax-0.7.77.tgz` for consumer validation; a real npm
publication sends those same audited bytes.

Final local candidate evidence on 2026-07-27: the clean-install template,
package build, bundle, declaration, fast/unit/contract/system, packaged
Electron, and exact tarball audit gates passed. The final audited
`kodax-ai-kodax-0.7.77.tgz` is 4,144,186 bytes with SHA-256
`E30B447059F1C237B81E5896E51698D3FFD7987A8C5E1CF15F9F2354C846F63C`.
It was produced by `node scripts/release.mjs --pack-only`, including the
production build and exact Sidecar archive audit. Archive-level declaration
inspection confirmed `promptCacheKey`, `promptCacheAffinityHash`, and optional
cache read/write fields; production bundles retain the Kimi/OpenAI affinity and
Codex/Gemini cache-usage parser wire fields. The final release-evidence commit
passed Node 20, Node 22 (including the Unix Runtime socket gate), the dedicated
Windows Shell Contract job, and packaged Electron before tagging.

For a focused v0.7.77 rerun:

```bash
npx vitest run \
  benchmark/datasets/feature-274/experiment-contract.test.ts \
  benchmark/datasets/feature-275/experiment-contract.test.ts \
  packages/agent/src/experimental-memory/memory-agent.test.ts \
  packages/coding/src/memory/intervention-selector.test.ts \
  packages/coding/src/orchestration/pattern-catalog.test.ts \
  packages/coding/src/orchestration/pattern-strategy.test.ts \
  packages/coding/src/orchestration/pattern-trace.test.ts \
  packages/coding/src/agent-runtime/run-substrate.memory-intervention.test.ts \
  packages/coding/src/agent-runtime/run-substrate.terminal-interrupt.test.ts \
  packages/coding/src/child-executor.test.ts \
  packages/coding/src/orchestration/pattern-result.test.ts \
  packages/coding/src/shell-execution/contract.test.ts \
  packages/coding/src/shell-execution/environment.test.ts \
  packages/coding/src/shell-execution/resolver.test.ts \
  packages/coding/src/agent-runtime/prompt-cache-affinity.test.ts \
  packages/coding/src/agent-runtime/recursive-actor-integration.test.ts \
  packages/coding/src/agent-runtime/__contract-tests__/cap-071-non-streaming-fallback.contract.test.ts \
  packages/coding/src/agent-runtime/tool-execution-context.test.ts \
  packages/coding/src/task-engine/runner-driven.compaction-context.test.ts \
  packages/coding/src/task-engine/_internal/managed-task/llm-adapter.cache-affinity.test.ts \
  packages/coding/src/tools/bash.test.ts \
  packages/coding/src/workflows/structured-output.test.ts \
  packages/coding/src/self-knowledge/registry.test.ts \
  packages/coding/src/tools/manual.test.ts \
  packages/llm/src/providers/anthropic-message-serialization.test.ts \
  packages/llm/src/providers/openai-reasoning-capability.test.ts \
  packages/llm/src/providers/image-serialization.test.ts \
  packages/llm/src/cli-events/codex-parser.test.ts \
  packages/llm/src/cli-events/gemini-parser.test.ts \
  packages/llm/src/cli-events/executor.test.ts \
  packages/llm/src/cli-events/acp-client.test.ts \
  packages/llm/src/cli-events/pseudo-acp-server.test.ts \
  packages/llm/src/providers/acp-base.test.ts \
  packages/llm/src/providers/runtime-registry.test.ts \
  src/runtime-daemon/process.test.ts \
  src/runtime-permission-scope.test.ts \
  src/sdk-runtime.test.ts
```

The real concurrent-owner readiness boundary is covered separately:

```bash
npx vitest run src/kodax_cli.daemon-smoke.test.ts \
  -t "does not become ready before initial A2A reconciliation completes"
```

The focused human/host contracts are
[`ISSUE_212_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_212_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_213_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_213_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_214_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_214_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_215_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_215_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_216_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_216_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_217_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_217_v0.7.77_REGRESSION_GUIDE.md),
[`ISSUE_218_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_218_v0.7.77_REGRESSION_GUIDE.md),
and
[`ISSUE_219_v0.7.77_REGRESSION_GUIDE.md`](test-guides/ISSUE_219_v0.7.77_REGRESSION_GUIDE.md).

The paid runners require explicit authorization in addition to available
credentials and persist resumable raw cells outside the repository. The frozen
release runs completed against clean commit
`25d5521e3eadc20ff1da2bd69d171736724bbcba`:

- F274 `f274-v0.7.77.6`: 96 Layer 2 calls and 40 Layer 3 calls, 820,432 tokens,
  estimated `$0.02122291`; blinded recommendation `recommend-ship`.
- F275 `f275-v0.7.77.3`: 16 pilot calls, 7,113 tokens, estimated
  `$0.00022152`; blinded recommendation `recommend-ship`.
- Joint decision: `SHIP` deterministic F274/F275 behavior. F275 semantic
  selection remains experimental/host opt-in; the 144-call validation is not
  run because v0.7.77 makes no semantic default-on or task-effect claim.

Raw outputs and blinded reviews remain under the OS temp directory specified
by `benchmark/EVAL_GUIDELINES.md`, never in the repository.
The immutable review bindings and post-review count corrections are recorded
in `%TEMP%/kodax-eval-dumps/v0.7.77-review-integrity-addendum.json` (SHA-256
`7600C403CAF159B65528FDFCA01FF51ACFA33F3B806A47BDD00F072957E0EBF9`);
the original blinded review files were not rewritten.

With the relevant live credentials configured, the provider and cache probes
are optional operator checks:

```powershell
$env:KODAX_INTEGRATION_TEST = '1'
npm run test:integration -- packages/llm/src/providers/kimi-wire.integration.test.ts
npm run probe:prompt-cache
```

On Windows, after a successful build, run the packaged Electron boundary:

```bash
npm run test:electron-daemon:built
```

Packaged KodaX Space validation remains a non-blocking product follow-up. Install
the exact generated tarball and run
[`ISSUE_205_v0.7.75_REGRESSION_GUIDE.md`](test-guides/ISSUE_205_v0.7.75_REGRESSION_GUIDE.md)
on Windows 10 and Windows 11, recording the Space build, OS build, tarball hash,
tester, date, and outcome. Automated output must not pre-fill the human result.

After every gate above was satisfied, the complete candidate was tagged
`v0.7.77`; the five-platform GitHub Release workflow built its binaries. npm
publication was completed separately by the maintainer.

## Automated release (CI)

### Trigger paths

1. **Push a `v*` tag** → `release.yml` builds all 5 targets, creates a GitHub
   Release, and uploads archives + SHA256SUMS.

   ```bash
   # 1. Bump version in root package.json (and sync workspaces)
   # 2. Commit, then:
   git tag v<version>
   git push --tags
   ```

   Release notes are auto-generated from `git log <prev-tag>..<this-tag>`.
   Tags matching `*-rc*` / `*-beta*` / `*-alpha*` are flagged as pre-release.

2. **Manual via GitHub Actions UI** (`workflow_dispatch`) → builds without
   creating a release. Useful for testing the pipeline before tagging.

   - Repo → Actions → Release → Run workflow
   - Pick `target` (default `all`)
   - Artifacts available for 14 days under the workflow run

### Pipeline stages

```
on: push tag v*  ─┐
                  ├─→ build matrix (5 targets, native runners)
on: workflow_dispatch ─┘     │
                             ├─→ smoke test (--version)
                             ├─→ archive (tar.gz / zip + .sha256)
                             ├─→ upload native-authority-<target>
                             └─→ npm-package job
                                 ├─→ download all 5 native authorities
                                 ├─→ build neutral bundles
                                 ├─→ release.mjs --skip-build --pack-only
                                 ├─→ test:packed-native (empty-consumer install)
                                 └─→ sha256 + upload kodax-npm-package

                             [tag push only]
                             └─→ release job
                                 ├─→ download all artifacts
                                 ├─→ aggregate SHA256SUMS
                                 ├─→ generate notes from git log
                                 └─→ softprops/action-gh-release
                                     (archives + SHA256SUMS +
                                      kodax-ai-kodax-<version>.tgz +
                                      kodax-ai-kodax-npm.sha256)
```

### npm publication (maintainer step)

The npm package embeds prebuilt native authorities for five platforms, and
Rust artifacts must be compiled on their target OS/arch — a single machine
can never assemble the universal tarball. The publishable bytes therefore
come from the Release workflow's `npm-package` job and are attached to the
GitHub Release as `kodax-ai-kodax-<version>.tgz` plus
`kodax-ai-kodax-npm.sha256`.

After the tag-triggered Release workflow is green:

```bash
node scripts/release.mjs            # download + verify + publish CI bytes
```

The script refuses to proceed while the git tree is dirty or the lockfile is
out of sync, verifies the tarball sha256 against the checksum asset, re-runs
the sidecar audit on the downloaded bytes, and publishes exactly those bytes
to `registry.npmjs.org` (the CI pack already sets `private: false` inside the
tarball, so the local development manifest is never mutated). Use `--dry-run`
to rehearse and `--otp=<code>` for npm 2FA.

The asset download honors `HTTPS_PROXY` / `https_proxy` via undici's
`ProxyAgent` (Node's global fetch ignores proxy env vars, which would fail
with an opaque connect timeout on machines that reach github.com only
through a local proxy). Proxy-free environments never load undici.

`node scripts/release.mjs --pack-only` on a local machine now produces a
host-only LOCAL TEST TARBALL that keeps `private: true`, so npm physically
refuses to publish it; consumers can still `npm install <path>` it for SDK
testing. On CI (where all five authorities are staged) the same command packs
the audited universal publish candidate.

## Build-time defines

`scripts/build-binary.mjs` injects three constants via Bun `--define`,
substituted at compile time as string literals:

| Define                       | Value                  | Purpose                                          |
| ---------------------------- | ---------------------- | ------------------------------------------------ |
| `process.env.NODE_ENV`       | `"production"`         | React strips dev-only profiling code (saves ~100 MB/turn) |
| `process.env.KODAX_BUNDLED`  | `"true"`               | Selects sidecar paths and gives the bootstrap exclusive CLI startup ownership |
| `process.env.KODAX_VERSION`  | `<version>`            | Source of truth for `kodax --version` (no fs read) |

These flags only exist in compiled binaries. **npm install / `npm link` /
`npm run dev` paths are completely unaffected** — they fall through to the
existing `__dirname`-based resolution.

## Code signing

**Currently unsigned**, matching common unsigned CLI distribution practice (Bun, Deno,
ripgrep, fd). Users will see warnings on first run:

- **macOS**: `xattr -d com.apple.quarantine kodax` once after extraction.
- **Windows**: SmartScreen "More info → Run anyway" once.
- **Linux**: no warning.

If signing is added later, hooks would slot into the `release.yml` build job
between `Build binary` and `Package archive`, gated on platform:

- macOS: `codesign` + `xcrun notarytool` (requires Apple Developer Program $99/yr)
- Windows: `signtool` (requires OV/EV cert $80–500/yr)

## Troubleshooting

**`bun: command not found` from `npm run build:binary`** — Bun isn't on PATH.
The script prints install hints and exits with code 1. Install Bun and retry.

**`Missing packages/agent/dist/capabilities/skills/builtin`** — `npm run build`
did not run, or the agent package's `copy:builtin` step failed. Run
`npm run build` or `npm run copy:builtin -w @kodax-ai/agent` to verify, then
retry.

**Binary runs but reports `kodax 0.0.0`** — `KODAX_VERSION` define wasn't
injected. Check `scripts/build-binary.mjs` was used, not raw `bun build`.

**Skill discovery returns empty in compiled binary** — sidecar `builtin/`
directory is missing next to the executable. Verify the archive was extracted
intact; the binary alone is not enough.

**Worker, trusted text, or sandbox mode fails in a compiled binary** - verify
`semantic-worker.js`, `runtime-worker.js`, and
`constructed-handler-worker.js` are next to the executable, and verify the
matching `vendor/kodax-native/<platform-arch>` directory. Windows also requires
the pinned `vendor/srt-win/<arch>/srt-win.exe`.
`scripts/build-binary.mjs` fails the build when any source sidecar is missing,
but copying only the executable after extraction breaks sidecar resolution at
runtime.
