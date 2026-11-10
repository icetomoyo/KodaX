# One Host per `KODAX_HOME` — design draft, 2026-11-10

Status: **draft for review**. Nothing here is implemented. Decision record:
[ADR-075](../ADR.md#adr-075-one-host-per-kodax_home-profile-is-not-host-identity)
(Proposed). Tracks [Issue 407](../KNOWN_ISSUES.md#issue-407-passive-connections-and-exit-receipts-ignore-the-session-storage-owner);
[Issue 406](../KNOWN_ISSUES.md#issue-406-a-cli-redirected-to-spaces-host-fails-daemon-start-verification-and-provider-credential-authorization)
is already fixed on its own and is a precondition.

## 1. Problem

A Host (`kodax daemon serve`) is identified by two keys at once:

| Key | Where | Who uses it |
|-----|-------|-------------|
| Profile name | `runtime/daemon/<profile>/` (lock, `daemon.json`, pipe, token, log, exit receipts, owner policy) and `runtime/profiles/<profile>/` (Runtime state) | `--profile`, `connectKodaXClient`, `readKodaXClientExits`, `daemon start/stop/status`, Space's hard-coded `coder` |
| Session storage owner | `sessions/.product-host/owner.lock` | the single-writer fence; since v0.7.97-alpha.7 also the redirect in `ensureKodaXRuntime` |

Packaged Space runs profile `coder`; the CLI runs `default`; both use
`~/.kodax/sessions`. Only one Host can own the sessions directory, so the
second launcher is redirected to the first Host. Every path that still uses
the profile key then looks in the wrong place:

1. `daemon start` verifies the requested profile directory (Issue 406, fixed).
2. The credential authorizer compares Host profile to credential profile
   (Issue 406, fixed).
3. Passive `connectKodaXClient` does not follow the storage owner (Issue 407).
4. `readKodaXClientExits` reads receipts from the requested profile (Issue 407).
5. Per-Session Runtime state (settings, Session order, Runs, pending inputs,
   permission grants, run-status index) is stored under the profile that
   served the Session. The same Session has different settings depending on
   which product started first. A development machine already has both
   `runtime/profiles/default` and `runtime/profiles/coder` for one sessions
   directory (Issue 407).
6. Space hard-codes `coder` for stop (`daemon stop --profile coder`),
   credential recovery and the `host-tool-invocations.json` path. When the
   CLI's `default` Host owns storage, these act on an empty slot (to verify
   during implementation).

The profile key isolates nothing that a user asked to isolate. Configuration,
providers and sessions are already shared per `KODAX_HOME`. Profile does not
select a configuration file. It only names directories.

## 2. Reference designs

| | Process | Identity key | Profile meaning | Per-session settings |
|---|---|---|---|---|
| codex | one app-server/daemon per `CODEX_HOME` | data root | config overlay only | stored with the thread |
| opencode | one server per user state dir and channel, fixed port | state dir | none for process | in the session record (SQLite) |
| pi | no daemon | `agentDir` | none | in the session file |
| KodaX today | one Host per profile, plus storage-owner redirect | profile **and** sessions dir | Host directory name | `runtime/profiles/<profile>/` |

All three use one data-root key and never split process or storage by
profile.

## 3. Decision summary

- The Host identity is the data root (`KODAX_HOME`, default `~/.kodax`). One
  Host serves it. No client option selects another Host in the same home.
- The Host always uses the canonical slot. **Recommendation: reuse the
  existing names** `runtime/daemon/default/` and `runtime/profiles/default/`.
  Every CLI user's state is already there, and clients from v0.7.97-alpha.7
  onward reach it directly or through the redirect. A rename to
  `runtime/host/` reads better but migrates every user and breaks older
  clients. See open question Q1.
- `profile` stops being Host identity:
  - `--profile` on `daemon` commands and `profile` in `ensureKodaXRuntime`,
    `connectKodaXClient` and `readKodaXClientExits` are accepted and ignored
    for location. A non-default value emits one deprecation diagnostic per
    process. They are removed in a later major SDK version.
  - The `identity.profile` wire field stays (always `default`) so older
    clients' `expectedProfile` checks pass.
- Credential profile (the account namespace inside `auth.json`: API-key
  bindings, OAuth registrations) is unchanged. It is not Host identity.
- `sessions/.product-host/owner.lock` stays as the single-writer fence and
  keeps being written, because older clients redirect through it.

## 4. Behavior

### 4.1 Connect and start

| Situation | New client behavior |
|---|---|
| Canonical Host live | attach (start and passive connect alike) |
| No Host | start in the canonical slot (`ensureKodaXRuntime`); passive connect reports "no Host" |
| A legacy Host in another slot (old Space `coder`) owns storage | attach to it through the existing storage-owner redirect, for start **and** passive connect, and read its exit receipts there; when it is idle, the normal capability/version upgrade replaces it with a canonical Host |
| A client requests a sessions directory other than the Host's | explicit error `session_storage_mismatch`; no second Host |

The redirect code stays, but only as the legacy path. It is no longer how two
current products meet.

### 4.2 `daemon start | stop | status`

They act on the canonical slot. If a legacy Host owns storage they report and
stop that Host, with `profile` shown in the output.

### 4.3 State migration (one time, idempotent)

Runs at canonical Host startup, after it holds the storage owner and the owner
policy lock. It skips any `runtime/profiles/<p>/` whose daemon slot has a live
owner. Per source profile `p` ≠ `default`:

| Item | Rule |
|---|---|
| `runs/<runId>/` | move if absent in the target; if present in both (should not happen, ids are random) keep the target, log |
| `session-settings/<sid>.json` | move if absent; if both exist keep the newer mtime and log both revisions (revisions are per-store counters and are not comparable) |
| `session-orders/<sid>.json` | write `max(source, target)`; the counter must stay monotonic |
| `pending-inputs/<sid>` | move if absent; if both exist keep both entries, deduplicated by input id |
| `permission-grants.json` | see open question Q2 (recommendation: do not import) |
| `run-status-index.json` | delete the target index after merging Runs; the existing fail-closed scan rebuilds it |

Afterwards the source is renamed to `runtime/profiles/<p>.merged-<date>/`.
ADR-074 retention gets one exact allow-list rule that expires it after 30 days.
The migration emits one `runtime.host.state-merged` diagnostic with counts and
conflicts. Startup is not blocked by a failed item; that item stays in place
and is reported.

## 5. Compatibility

| Pair | Result |
|---|---|
| new CLI + new Space | one canonical Host |
| new CLI + old Space (≥ alpha.7 SDK, Host `coder` live) | new CLI attaches through the legacy redirect; old Space's Host is replaced when idle |
| old CLI (≥ alpha.7) + new Space | old CLI requests `default` = canonical slot, attaches directly |
| old CLI (< alpha.7) | requests `default` directly; works as long as it passes the capability check, otherwise its existing upgrade error |
| old Space (`coder`) started after new Host | old SDK redirects via `owner.lock` to `default`; its `--profile coder` stop/exit-receipt paths miss (already broken today; fixed by upgrading Space) |

## 6. Change list

KodaX:

- `runtime-daemon/state.ts`: canonical slot resolver from the data root;
  `resolveRuntimeDaemonPathsFromConfigHome(home, profile)` keeps its signature
  for the legacy path.
- `sdk-runtime.ts`: `ensureKodaXRuntime` and `createRuntimePersistence` use the
  canonical slot; drop the requested-profile fence for redirects; migration
  hook at Host startup.
- `sdk-client.ts`: `connectKodaXClient` and `readKodaXClientExits` resolve the
  canonical slot, falling back to the storage owner's slot.
- `kodax_cli.ts`: `daemon` commands, deprecation of `--profile`.
- `home-retention.ts`: one rule for `runtime/profiles/*.merged-*`.
- Docs: `CLIENT_CONTRACT.md`, `SDK_MIGRATION.md`, DD runtime layout, ADR-075.

Space (after the bundled SDK carries the change):

- `runtime-host-adapter.ts`: remove the `coder` profile (lines ~2171, ~2478, ~8968).
- `runtime-daemon-control.ts`: stop without `--profile`.
- `runtime-credential-recovery.ts`, `runtime-client-secret-file.ts`: take the
  Host directory from the SDK instead of `runtime/daemon/coder`.
- `space-manual-topics.ts`: update the `--profile coder` recovery text.

## 7. Tests

- Two launchers with different `profile` values in one home share one Host and
  one Runtime state directory (start order both ways).
- Passive connect and exit receipts find a legacy-slot Host that owns storage.
- Migration: each table row, idempotence after a crash between steps, skip on
  a live legacy owner, diagnostic contents.
- Old/new matrix with the real released beta.4 binary and Space packaged E2E
  (scenarios A–D from the Issue 405/406 run), provider API keys scrubbed.

## 8. Open questions for review

- **Q1. Slot name.** Keep `default` (recommended, no migration for CLI users,
  older clients work) or rename to `runtime/host/` (clearer, costs one more
  migration and breaks pre-alpha.7 clients).
- **Q2. Permission grants from `coder`.** Not importing is safe and costs some
  repeated approval prompts in Space. Importing keeps them but merges two
  approval histories into one store. Recommendation: do not import.
- **Q3. Removing `profile` from the public SDK.** Deprecate now, remove in the
  next major SDK version (recommended), or remove now.
