# FEATURE_305 — One Host per KODAX_HOME

Date: 2026-11-11. Status: T1–T7 done. Acceptance passed with a local package; Space keeps its
beta.4 pin until KodaX publishes.
[Design block](../features/v0.7.98.md#feature_305-one-host-per-kodax_home),
[ADR-075](../ADR.md#adr-075-one-host-per-kodax_home-profile-is-not-host-identity),
[design](../designs/one-host-per-kodax-home-2026-11-10.md).

This is pre-release acceptance with a local package. Nothing was published.

## Builds under test

| Name | Source |
|---|---|
| New SDK + CLI | `npm pack` of KodaX `3d5fc5cb9` (`kodax-ai-kodax-0.7.97-beta.5.tgz`, sha256 `f430a2b4…3c069`; version string not yet bumped) |
| Old SDK + CLI | Published npm `@kodax-ai/kodax@0.7.97-beta.4` (what Space 0.1.47-alpha.5 bundles) |
| Released binary | GitHub release `v0.7.97-beta.4`, `kodax-v0.7.97-beta.4-win-x64.zip`, sha256 file verified |
| New Space | KodaX-Space branch `feat/f305-one-host-space` with the new tarball installed, packaged with `node scripts/pack.mjs --win --allow-local-kodax` (see Packaged Space) |
| Old Space | Space main (`b7bfd2e3`) with beta.4: Host profile `coder` |

"Old Space" in the SDK matrix is the beta.4 SDK called the way Space 0.1.47-alpha.5 calls it:
`ensureKodaXRuntime({ profile: 'coder', daemonLifecycle: 'interactive', homeDir, sessionsDir, clientInfo })`.
"New Space" is the same call without `profile`.

## Isolation

- Every scenario uses a new temp data root (`%TEMP%\kodax-t7-<scenario>-*`); `KODAX_HOME` and `--home`
  point there. The real `~/.kodax` is never read or written.
- Provider credentials are removed from the environment of the test process and every CLI child
  (`*API_KEY`, `*_TOKEN`, `ANTHROPIC*`, `OPENAI*`, `KIMI*`, `ZHIPU*`, `DEEPSEEK*`, `GEMINI*`, `MOONSHOT*`,
  `DASHSCOPE*`). No model request is made.
- After each scenario every Host is stopped with the new CLI, the old CLI and `--profile coder`, then
  the root is deleted. Afterwards no process command line contains `kodax-t7-`.

## SDK and CLI matrix (Windows 11, Node 22.23.1)

Run each scenario in a fresh root. `new`/`old` mean the builds above; `b4` is the released binary.
`<H>` is the scenario root.

### A. New Space first, then new CLI

1. New SDK `ensureKodaXRuntime({ homeDir: H, … })`.
2. `kodax daemon status --home <H> --json` and `kodax daemon start --home <H> --json` (new CLI).

Expected: both report the Space Host's `runtimeId`; start says `already_running`;
`identity.profile` is `default`; `runtime/daemon/` and `runtime/profiles/` each contain only `default`.

### B. New CLI first, then new Space

1. `kodax daemon start --home <H> --json` (new CLI).
2. New SDK `ensureKodaXRuntime`.

Expected: Space attaches to the CLI Host (same `runtimeId`); only the `default` slot exists.

### C. Old Space (`coder` Host) live, then new clients

1. Old SDK `ensureKodaXRuntime({ profile: 'coder', … })`; create Session `t7-legacy-session`.
2. New CLI `daemon status` and `daemon start`.
3. New SDK `connectKodaXClient({ homeDir: H })`; create a Session through it; list Sessions.
4. Close old Space; new CLI `daemon stop --home <H> --json`.
5. New SDK `ensureKodaXRuntime`.

Expected: steps 2–3 act on the `coder` Host (status reports `profile: coder` and its `runtimeId`; the
Session created in 3 is visible from old Space). Step 4 stops that Host (`stopped: true`). Step 5 starts a
`default` Host with a new `runtimeId`; `runtime/profiles/` is `coder.merged-YYYYMMDD` and `default`;
`t7-legacy-session` is listed.

### C2. Old Space closes normally, then new Space

1. Old SDK `ensureKodaXRuntime({ profile: 'coder', … })`; create Session `t7-c2-session`; close it.
2. New SDK `ensureKodaXRuntime`; close; `ensureKodaXRuntime` again.

Expected: the new Host is `default` with a new `runtimeId`; `coder` state is merged into
`coder.merged-YYYYMMDD`; `t7-c2-session` is listed; the second start does not merge again
(exactly one `coder.merged-*`).

### D. New Host, then old clients

1. New SDK `ensureKodaXRuntime`.
2. Old npm CLI and released `kodax.exe`: `daemon status` and `daemon start`, each with `--home <H>`.
3. Old SDK `connectKodaXClient({ homeDir: H })`; create a Session through it.
4. Old SDK `ensureKodaXRuntime({ profile: 'coder', … })`.

Expected: every status/start reports the new Host's `runtimeId` (`already_running`); the old passive
client's Session is listed by new Space; old Space (`coder`) attaches to the same Host. No
`runtime/daemon/coder/daemon.json` appears (old SDK leaves only `events`, `runs` and
`owner-policy.json` there).

### E. Removed options

1. New SDK `ensureKodaXRuntime({ profile: 'coder', … })`.
2. New CLI `daemon start|status|stop|serve --profile coder`.

Expected: SDK rejects with `runtime_host_migration_required`; every CLI command fails. Both messages
name "One Host per KODAX_HOME (profile removed)" in `docs/SDK_MIGRATION.md`.

### Result (2026-11-11)

33 checks passed, 0 failed (A 4, B 3, C 10, C2 4, D 7, E 5).

Two harness corrections preceded the passing run; neither is a product defect:

- The first draft passed `daemonOrphanExitMs` like older tests do. A Host started by
  `kodax daemon start` is explicitly retained, so the SDK correctly refused a lifetime change
  (`RuntimeDaemonCapabilityUpgradeError`). Space itself passes `daemonLifecycle: 'interactive'`; the
  matrix now does the same.
- `KodaXProductClient` has no `identity`; passive-client checks now prove the attachment through a
  Session created on the live Host.

## Package contents

The new tarball ships `CHANGELOG.md` (breaking entry "One Host per KODAX_HOME") and
`docs/SDK_MIGRATION.md` (section "One Host per KODAX_HOME (profile removed)"), so an npm SDK user sees
them under `node_modules/@kodax-ai/kodax/`.

## Space (T6)

- Space unit suite against the new tarball: all pass except
  - two version-pin tests (`installed KodaX version matches the exact Space dependency pin`,
    `Space uses the published beta.4 SDK in both dependency manifests`), which compare against the
    unchanged beta.4 pin; and
  - two `runtime-sdk-migration` cases that expect a PNG attachment's `path` to be the original file.
    Since beta.5 a `read` image attachment points at the Host's `.media` copy; the same cases pass on
    Space main with beta.4. This is a beta.4 → beta.5 change, not FEATURE_305. Both items are handled
    when Space bumps its dependency.
- Packaged Space: see below.

## Packaged Space (Windows)

`scripts/pack.mjs` accepts only a tarball that carries every platform's native files. The local
`npm pack` holds only `win32-x64`, so the test tarball adds `dist/native/{darwin,linux}-{arm64,x64}`
(12 files) from the published `0.7.97-beta.5` package. FEATURE_305 changes no native code; the two
packages otherwise differ only in hash-named `dist/chunks` and `dist/types-chunks`. Test tarball sha256
`f3846044…e3a0be`. The Space manifests point at it with `file:` only while packaging and are restored
afterwards.

| Smoke | Result |
|---|---|
| `scripts/smoke-pack.mjs` (packaged SDK, Runtime, lifecycle probe in its own data root) | all checks passed |
| `e2e/boot-smoke-packaged.mjs` (Host `daemon.json` in `runtime/daemon/default/`) | PASS, Runtime ready, 122 historical child records preserved |
| `e2e/complete-exit-packaged.mjs` | 7 passed |

The first packaged run found Space files T6 had missed (boot smoke, live E2E scripts and the
diagnostic `.cmd` still used the `coder` slot or `--profile coder`). They are fixed in Space `8d1613ed`.

The boot smoke also requires the 122 seeded extinct child records to stay byte-identical in place.
Since beta.5 (Issue 398, KodaX `9e6cdf97e`) the Host moves them unchanged to
`runtime/processes/children/.unresolved/`. For this run the check also accepted the
`.unresolved/` copy; that local change was not committed and belongs to Space's beta.5 dependency
bump, like the PNG attachment path above.

## Not covered

- Real old packaged Space (0.1.47-alpha.5) GUI against the new Host. The SDK matrix runs the exact
  beta.4 SDK it bundles with the same call, so the GUI adds no Host-side path.
- macOS and Linux.
- Exit receipts written by a legacy-slot Host and read after replacement: covered by T3 unit tests
  (`readKodaXClientExits` reads every slot), not by this matrix.
