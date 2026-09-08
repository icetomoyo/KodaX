# Issue 332 — Bundled compaction credential scope regression guide

**Version:** v0.7.96-beta.2

**Date:** 2026-09-07

**Issue:** [332](../KNOWN_ISSUES.md#332-bundled-compaction-reads-a-duplicate-provider-credential-scope-and-never-acquires-scoped-keys)

## Scope and prerequisites

The beta.1 bundle included both the source and compiled copies of the Provider
credential context. The summarizer and daemon therefore used different
AsyncLocalStorage instances. The fix pins esbuild to the root tsconfig and
rejects duplicated credential modules in production build graphs.

Use a freshly built or packed SDK and restart the test daemon so that it loads
the corrected bytes. Use a separate test home/session store. For Space checks,
use Space v0.1.46-alpha.6 or later with broker v2 support, a test Provider whose
key is stored only in the OS keychain, and no corresponding environment key.
Never put keys in captured logs. Prepare enough conversation history to exceed
the configured compaction trigger. Record SDK version/build and daemon identity.

Local automated tests use fake credentials and a loopback HTTP Provider; they do
not exercise Space's UI or a real OS keychain. Those integrations remain manual.

## Manual cases

For each case, record actual observations and Pass / Fail / Blocked.

| ID / type / priority | Preconditions | Steps | Expected result |
| --- | --- | --- | --- |
| TC-001 Positive / High | Keychain-only Provider; broker v2 negotiated; sufficient history | Register a scoped lease, call `sessions.compact` with that lease and a unique `operation.operationId`; repeat for built-in and custom OpenAI/Anthropic Providers | Broker receives `purpose: 'compaction'` and target `{kind: 'operation', operation: 'session.compact', operationId}` with the original ID. A valid Provider response commits a summary. No environment-key error. |
| TC-002 Negative / High | Same setup; test endpoint returns HTTP 401 | Execute scoped manual compaction | Promise rejects with Provider failure; no false successful compaction, no missing-environment error, and original history remains available. |
| TC-003 Boundary / High | Scoped broker returns an empty credential | Compact a session with enough history | Fails closed with a missing broker credential error and no Provider HTTP request. Also compact a short session: a legitimate below-threshold skip must not be treated as an authentication failure. |
| TC-004 UI / High | Space connected to the rebuilt daemon with keychain-only credentials | Execute `/compact`, inspect the updated history, then continue a normal message | Space shows the compaction outcome, the session remains usable, and the new request uses the compacted history. Repeat with a rejected test key: no false success indication. |
| TC-005 Performance / Medium | Managed-task session above the compaction trigger; valid test endpoint | Start a managed run and inspect broker requests and `context.compaction.finished`; repeat on fresh sessions | The compaction request uses `purpose: 'compaction'`, run target and original operation ID. A committed compaction event appears and the run completes. No repeated missing-environment failure loop. Record duration; no new latency budget is claimed by this patch. |
| TC-006 Security / High | Ambient key exists; test leases are separately disallowed, closed, and empty | Attempt compaction under each lease and inspect endpoint request count | No ambient-key fallback and no Provider request. Disallowed/closed leases do not acquire; an empty broker response is rejected. No credential value appears in diagnostics. |
| TC-007 Compatibility / High | Supported Node 20/22; Windows, Linux, macOS; fresh bundles | Run `npm run test:bundle` after the normal build; smoke-test CLI help/version; repeat summary calls using legacy exact credentials and unbound environment credentials | Artifact tests pass; legacy credential modes still reach the Provider. Existing startup, size, sidecar, and Windows process-launch build guards pass. |

## Automated reproduction and verification

With the normal project Node/npm and native build prerequisites installed:

```sh
npm ci
npm run build
npm run test:bundle
npm run test:fast
```

`test:bundle` uses Node's test runner and imports `dist` directly. It deliberately
avoids Vitest source aliases, which concealed the duplicate-module bug.

- `tests/bundled-provider-credentials.test.mjs`: built-in and custom Providers,
  manual and cached summaries, purpose attribution, exact/environment
  compatibility, and disallowed/closed/empty lease failures.
- `tests/bundled-daemon-compaction.test.mjs`: actual bundled daemon, scoped broker
  v2, operation ID preservation, successful and rejected manual compaction, and
  successful managed compaction followed by a primary request.

For package verification, run `npm pack --ignore-scripts` after the full build,
extract the archive into a test directory, and place the two test files in its
`tests` directory. Run them against the extracted `dist` with package runtime
dependencies available. This checks packaged bytes; a clean installation is a
separate compatibility check.

## Recorded local results

Windows / Node 24.19.0 on 2026-09-07:

| Check | Result |
| --- | --- |
| Original bundle regression reproduction | All 8 scoped summary cases failed before the fix with the reported environment-key error |
| Restored duplicate-module build condition | New build guard rejected two credential context modules |
| Workspace TypeScript, full bundle, SDK declarations | Passed; existing startup/size/sidecar/Windows guards passed |
| Source fast suite | 1,659 passed, 32 skipped, 0 failed across 128 files |
| Focused credential/compaction/daemon source suite | 261 passed across 10 files |
| Final bundle suite | 13 passed |
| Extracted npm package suite | 13 passed, using workspace-provided runtime dependencies |
| CLI version/help | Passed |
| Independent Standards and Spec reviews | No unresolved findings |

Initial test runs were affected by restricted profile/native access and missing
npm in the agent environment. The recorded successful runs used a separate test
home, the required local permissions, and a temporary pinned npm toolchain.
Existing declaration-generator export warnings remain unchanged.

Linux Node 20/22 and Windows CI now run the artifact gate after building. Release
jobs run it for all five supported native architecture lanes. These remote lanes
and the manual Space/keychain cases are not claimed as locally executed.

One separate baseline issue surfaced when a managed run's primary request was
deliberately rejected: `runtime.run.await` rejected the result with
`result.failureDetail.provider is not allowed`. Its failure metadata/schema
mismatch predates this patch and remains a follow-up; this fix changes only
bundle resolution and validation gates. The manual compaction HTTP 401 case is
covered and passes.

## Follow-up: stable-identity connection takeover (2026-09-08, unreleased)

This follow-up fixes a separate beta.2 failure after a diagnostic client reused
Space's `principalId` and `instanceSecret`. A new connection took over the
reverse transport while the old socket kept accepting ordinary RPC. Closing
the new connection then left the old client unable to acquire credentials.

The contract is one active connection per authenticated stable identity:

1. B takes over A's reverse bridge. A's dispatcher, subscriptions and socket
   retire; the client observes a reconnectable disconnect. Pending credential
   acquisitions fail, and already-dispatched host calls remain unknown without
   automatic replay. Ordinary RPC and credential supply on retired A are rejected.
2. Closing B does not revive A. Reconnect as A2 and call
   `credentials.resumeScoped(leaseId, broker)` for still-live v2 leases, or
   register a new lease. Host handlers similarly use `hostTools.resume`.
   SDK connection objects do not silently reconnect or replay mutations.
3. An old close cannot detach A2. Expired/revoked leases remain unavailable,
   and different secrets/principals retain separate authority. Do not run two
   reconnect loops with the same identity: independent diagnostic clients
   must use independent identities; read-only diagnostics may use probe mode.

The actual bundle test now runs A → B takeover → B close → A2 reconnect and
scoped lease resume **before** the existing manual and managed compaction cases.
The old bundle fails because A remains `connected`; the corrected bundle must
commit a real manual summary and a managed `context.compaction.finished` event
through a local HTTP Provider, with the original purpose/target assertions.
Source tests additionally cover late replies, delayed closes and RPC retirement.

For Space integration, restart the daemon with rebuilt SDK bytes, confirm that
Space responds to `connection.subscribe` disconnection by establishing a fresh
connection and rebinding brokers, then repeat manual and automatic compaction.
This SDK change does not fix the separately reported gateway timeout or Space's
`appendNotice`/compaction read-lock race. Do not delete active lock files.

Local checks (2026-09-08): old bundle reproduced the connected/credential-dead
state; corrected bundle passed all 13 credential/daemon artifact tests including
manual and managed compaction. Actual Space UI/keychain and customer gateway
checks remain integration work.

Source regression checks passed 314 tests, including prior capacity recovery,
daemon transport/credential contracts and SDK capacity projection. Bundle and
SDK declaration generation passed. The optional root `tsc --noEmit` check still
reports 479 pre-existing diagnostics: a compiler comparison against HEAD file
contents found the same 479 diagnostics and zero additions.

## Follow-up: strict type checks without changing SDK packaging

The accepted scope is to separate production-source checking from source-test
checking, fix the remaining real TypeScript errors, and retain the production
bundle configuration, declaration resolver, package exports and existing
credential/compaction recovery contracts. Test checking follows Vitest's source
aliases and the REPL's JavaScript substrate; it must not mix source and dist
types. Do not remove public APIs or relax strictness to make checks pass.

After `npm run build:packages`, run `npm run typecheck`. Run `npm run build`,
the complete default test suite and `npm run test:bundle`. Check an actual npm
tarball in an external consumer without workspace aliases: every SDK entry must
load, declaration checking must resolve without private workspace packages,
and a scoped credential callback plus Runtime session operations must typecheck.
Compare SDK entry exports before/after. No declaration migration is required.

New behavioral regression cases cover the resolved memory-review Session ID,
A2A projection of unknown/waiting-agent/recovering results, and explicit rejection
of unsupported scoped credential methods by an embedded Runtime. Existing daemon
takeover/reconnect, manual/managed compaction, capacity recovery, Stop/Actor
settlement, session read-boundary and sandbox tests remain required.

Artifact checks (2026-09-08): an isolated snapshot with `npm ci` passes the full
build, both type checks, and all 13 bundled credential/daemon compaction tests.
An actual tarball installed outside the workspace loads all 13 public entries
and passes strict consumer checking with the repository's existing
`skipLibCheck: true`, plus Runtime session/history/compaction and embedded
credential-boundary checks. Package exports are unchanged; no declaration or
runtime export names were removed. The existing referenced
`CodingActorCredentialAccessFactory` type is now also exported.

The full default suite scanned 982 files / 15,028 cases: 14,898 passed initially,
78 were already skipped and 21 were existing TODOs. All 31 initial failures were
verification-copy conditions: locating the checkout under system temp changed
permission classifications, archive line endings broke an Electron fixture
substring, and the private design-doc submodule was absent. Relocating the copy
outside system temp and restoring the original fixture bytes/design docs made
all six affected files pass on rerun, without product changes. No failed cases
remain across the scan and rerun. The initial full scan includes 450 passing
capacity, compaction, token-accounting and credential tests in 39 files.

Checking third-party declaration internals with `skipLibCheck: false` separately
reports 141 diagnostics in the unchanged `@agentclientprotocol/sdk@0.15.0`
package (140 duplicate exports and one extensionless schema import). These are
not KodaX source errors or missing private workspace packages; fixing that
dependency is outside this configuration/typecheck change. The production
compiler settings, bundle resolver and credential-scope identity guard remain
unchanged.

### Standards

Independent review found no actionable violations of the repository rules or
code-smell baseline. Findings: 0; severity: none.

### Spec

Independent review found no missing requirements, public export removals or
unrequested packaging changes. Findings: 0; severity: none. Concurrent work on
trusted text mutation permissions was excluded from this review and commit.

## Original Issue 332 sign-off

Manual cases: **7**; passed / failed / blocked: **pending integration testing**.

Tester, platforms, daemon build identity, and observations: **to be recorded**.
