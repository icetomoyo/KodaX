# One Host per `KODAX_HOME` — design draft, 2026-11-10

Status: **accepted 2026-11-10; T1–T5 implemented**. Review decisions are in §8.
Tracked as [FEATURE_305](../features/v0.7.98.md#feature_305-one-host-per-kodax_home) (tickets T1–T7).
Decision record:
[ADR-075](../ADR.md#adr-075-one-host-per-kodax_home-profile-is-not-host-identity). Tracks [Issue 407](../KNOWN_ISSUES.md#issue-407-passive-connections-and-exit-receipts-ignore-the-session-storage-owner);
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
- The Host always uses the canonical slot, which keeps the existing names
  `runtime/daemon/default/` and `runtime/profiles/default/` (Q1). One constant
  names the slot, with a comment that `default` is a fixed location, not a
  profile. Every CLI user's state is already there, and every older client
  looks there directly or reaches it through the redirect.
- The Host-location `profile` is **removed now** (Q3), not deprecated:
  - Removed from the public SDK options of `ensureKodaXRuntime`,
    `connectKodaXRuntime`, `connectKodaXClient` and `readKodaXClientExits`,
    and from the `daemon` command flags (`--profile`).
  - TypeScript callers get a compile error. JavaScript callers that still
    pass `profile`, and CLI users who pass `--profile`, get an explicit error
    that names the removal, says what to do instead (drop it; use a separate
    `homeDir`/`KODAX_HOME` for isolation) and points to the migration section
    in `docs/SDK_MIGRATION.md`, which ships in the npm package. Nothing is
    silently ignored.
  - The `identity.profile` wire field stays, always `default`, because older
    clients check it on connect. It is marked deprecated for readers.
- Unaffected, and the migration text must say so because they share the
  word: credential profile (the account namespace inside `auth.json`: API-key
  bindings, OAuth registrations), Agent/execution profiles
  (`KodaXAgentProfile`, `createExecutionProfile`) and Session `profileId`.
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

They act on the canonical slot and take no `--profile`. If a legacy Host owns
storage they report and stop that Host, and the output names its legacy slot.

### 4.3 State migration (one time, idempotent)

Runs at canonical Host startup, after it holds the storage owner and the owner
policy lock. It skips any `runtime/profiles/<p>/` whose daemon slot has a live
owner. Per source profile `p` ≠ `default`:

| Item | Rule |
|---|---|
| `runs/<runId>/` | move if absent in the target; if present in both (should not happen, ids are random) keep the target, log |
| `session-settings/<sid>.json` | move if absent; if both exist keep the newer mtime and log both revisions (revisions are per-store counters and are not comparable); a copied file keeps its source mtime, so with several legacy profiles the newest write wins |
| `session-orders/<sid>.json` | write `max(source, target)`; the counter must stay monotonic; if the source counter is unreadable, delete the target counter so the next allocation rescans the merged Runs |
| `pending-inputs/<sid>` | move if absent; if both exist keep both entries, deduplicated by input id across pending and withdrawn (target wins); the Host restores at most 5 pending inputs, so legacy entries over the limit become withdrawn receipts and are reported |
| `permission-grants.json` | import grants scoped to one Session (`scope.sessionId` set), skipping ids already present; drop grants without a Session scope and report their count, because importing them would extend approvals given in Space to every CLI Session (Q2) |
| `run-status-index.json` | delete the target index after merging Runs; the existing fail-closed scan rebuilds it |

`session-stops/` and `session-mcp/` hold per-Session records and move like
Runs. Unknown entries (such as `agents/`) stay in the source and are listed as
`retained`.

Afterwards the source is renamed to `runtime/profiles/<p>.merged-<date>/`
(`-2`, `-3`, … when that name exists), and its mtime is set to the merge time
so retention counts from the merge.
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
- `sdk-client.ts`: `connectKodaXClient` resolves the storage owner's slot when a
  legacy Host owns storage, else the canonical slot (`resolveRuntimeHostSlot`).
  `readKodaXClientExits` reads the receipts of every daemon slot in the home, so
  exits recorded by a legacy Host stay recoverable after it is replaced.
- `kodax_cli.ts`: `daemon` commands without `--profile`; explicit error when
  it is passed.
- `home-retention.ts`: one rule for `runtime/profiles/*.merged-*`.
- Also removed in T1+T2: `profile` on `ensureKodaXClient`, `createKodaXRuntime`,
  `getKodaXRuntimeOwnerState` and `waitForRuntimeDaemonShutdown`, and
  `kodax a2a serve --profile`. Internal APIs (`createKodaXHostRuntime`,
  `acquireRuntimeDaemonLease`, the state.ts resolvers) keep a slot argument so
  tests can stand in for a legacy Host. On Windows such a test Host must run
  inside a Job, because current clients require `daemonShutdownVerification`
  and a Host advertises it only when it is Job-contained.
- Public type declarations: remove the option fields; mark
  `RuntimeIdentity.profile` `@deprecated` with the reason in its JSDoc.

Documentation for SDK users. All of these ship in the npm package, so a user
who installs the new version sees them under `node_modules/@kodax-ai/kodax/`:

- `CHANGELOG.md` `[Unreleased]`: a breaking-change entry at the top that
  lists the removed options and flag, the error text, the one-line fix and a
  link to the migration section.
- `docs/SDK_MIGRATION.md`: a section "One Host per KODAX_HOME (`profile`
  removed)" with before/after code for each removed option, isolation through
  `homeDir`/`KODAX_HOME`, the meaning of `identity.profile`, the one-time state
  merge and its permission-grant rule, the three unaffected "profile"
  concepts, and what an older Space or CLI does next to the new Host.
- `docs/CLIENT_CONTRACT.md`: replace the `profile?: string` connection row and
  the "profile is a connection name" text with the data-root identity.
- `public_docs/sdk/embedder-guide.md`: update the `profile` examples.
- The thrown error messages link the migration section by name.
- Internal: DD runtime layout, ADR-075.

Space (after the bundled SDK carries the change):

- `runtime-host-adapter.ts`: remove the `coder` profile (lines ~2171, ~2478, ~8968).
- `runtime-daemon-control.ts`: stop without `--profile`.
- `runtime-credential-recovery.ts`, `runtime-client-secret-file.ts`: unchanged
  (T6 decision). They verify rc.2 legacy keychain secrets against the journal of
  the old Space `coder` Host, the only Host that ever saw those secrets. T4 merges
  only `runtime/profiles/*`, and retention never removes `runtime/daemon/coder/`.
- `space-manual-topics.ts`: update the `--profile coder` recovery text.

## 7. Tests

- Two launchers with different `profile` values in one home share one Host and
  one Runtime state directory (start order both ways).
- Passive connect and exit receipts find a legacy-slot Host that owns storage.
- Passing `profile` to each removed SDK option, and `--profile` to each
  `daemon` command, fails with the migration error; type tests confirm the
  fields are gone from the declarations.
- Migration: each table row, idempotence after a crash between steps, skip on
  a live legacy owner, diagnostic contents.
- Old/new matrix with the real released beta.4 binary and Space packaged E2E
  (scenarios A–D from the Issue 405/406 run), provider API keys scrubbed.

## 8. Review decisions (2026-11-10)

- **Q1. Slot name: keep `default`.** A new name such as `runtime/host/` would
  migrate every CLI user's state as well, and older clients only look under
  `runtime/daemon/<profile>/`. They would not see the Host, start their own
  and fail on the storage owner, which is Issue 405 again. Avoiding that
  needs a second descriptor in the old place, which brings back two
  identities.
- **Q2. Permission grants: import Session-scoped grants, drop global ones.**
  Either choice was acceptable to the owner. A Session-scoped grant affects
  only its Session. A global grant approved in Space would silently apply to
  every CLI Session after the merge. Dropped global grants cost one more
  approval each. New grants after the merge apply to every client, which is
  the intended meaning of one Host.
- **Q3. Remove the Host-location `profile` now.** The SDK has other users,
  but they are a closely connected team in the same refactoring period, so
  they change in step with this release. The removal needs full
  documentation that npm users can see (§6) and explicit errors instead of
  silent acceptance (§3).
