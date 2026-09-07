# Issue 332 — Bundled compaction credential scope regression guide

**Version:** v0.7.96 development (not yet released)

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

## Sign-off

Manual cases: **7**; passed / failed / blocked: **pending integration testing**.

Tester, platforms, daemon build identity, and observations: **to be recorded**.
