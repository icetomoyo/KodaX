# Issue 159 v0.7.69 Regression Guide

## Purpose

Verify that Windows process-tree cleanup does not leave a nested descendant
behind when the primary `taskkill /t` path fails or times out.

## Automated gate

Run on Windows with Node 20 and Node 22:

```powershell
npx vitest run packages/agent/src/runtime/process-tree.test.ts
```

Expected result: all three tests pass, including `kills a nested Windows child
process tree`. The test starts a real Node parent and nested child, invokes the
production cleanup helper, and waits until the descendant PID no longer exists.

Then run the package and type gates:

```powershell
npm run build:packages
npm run build:bundle
npm run build:dts
npx tsc --noEmit
```

## Manual stress check

1. Start a KodaX workload that creates nested local child processes.
2. While Windows management services are busy, cancel or time out the workload.
3. Confirm KodaX returns within the configured cleanup bound.
4. In Task Manager or `Get-Process`, confirm no child from that workload remains.
5. Repeat at least ten times; do not accept accumulating `node`, shell, or test
   worker descendants.

## Pass criteria

- The real nested-process regression passes on both supported Node lines.
- No workload descendant survives cleanup.
- Agent-runtime and LLM CLI-event cleanup remain behaviorally aligned.
- Build, bundle, DTS, and root type validation stay green.

## 2026-10-30 standalone Shell cleanup addendum

The earlier fixed-build full regression passed its functional assertions but emitted
11 `Managed child cleanup is unverified` warnings from `bash.node-env.test.ts`.
Windows short-lived commands/probes lost their roots before complete process-tree
evidence was retained. The registry correctly refused to infer descendant exit.
The new standalone launch gate uses the existing effect Job before starting user
code, and releases registry evidence only after its authoritative drain succeeds.

Run on Windows against the final source/build:

```powershell
npx vitest run packages/coding/src/tools/bash.node-env.test.ts packages/coding/src/tools/bash.windows-cleanup.test.ts packages/agent/src/runtime/windows-managed-process.test.ts packages/agent/src/runtime/process-tree.windows.test.ts packages/agent/src/runtime/managed-child-processes.test.ts packages/coding/src/child-executor.shell-cleanup.test.ts
```

Acceptance requires all of the following:

- The 11 environment-isolation cases keep their original assertions and require
  `cleanup.skipped === 0`; unverified cleanup fails while retaining its records.
- Actual normal exit, cancellation and timeout preserve stdout/stderr and the
  native exit/stop result, with both root and detached descendant PIDs absent
  before completion. Both active and quarantined recovery registries are empty.
- A prepared gate cannot start user effects before registration and release;
  an owner sweep can reclaim a still-gated process without running its command.
- Stdin and original target environment/exit status survive the gate unchanged.
- Target preloads cannot run in the gate before admission. Budget expiry and
  durable-registration failure prevent command/setup effects; bootstrap stream
  errors remain observed. Missing executables retain the original fallback rule.
- Failed Job drain, PID reuse and incomplete historical trees remain fail-closed.
  Child cleanup retry does not release its fence before cleanup is verified.
- Rebuild once, then freeze sources and package/root dist artifacts. Run the full
  Vitest suite and `npm run test:bundle` without editing/rebuilding between them;
  verify unchanged content fingerprints. No cleanup-warning-only acceptance.
  The bundle suite includes `tests/bundled-shell-cleanup.test.mjs`, which invokes
  the published coding SDK and independently checks actual descendant PIDs and
  the original probe/command recovery registry.

Native sandbox/verified Host Job paths keep their original ownership. Historical
unresolved records cannot be retroactively declared clean from a missing root PID.
This Windows gate does not substitute for POSIX-specific sandbox acceptance.

The subsequent fixed-build full run completed with 18,059 passing assertions,
two failures and no cleanup warnings. It is not a passing final acceptance:
`checkpoint.test.ts` exposed fractional filesystem mtimes being compared against
integer `Date.now()`, and the HTTP disconnect test incorrectly required optional
upstream errno metadata. A controlled fractional-time regression must retain the
checkpoint; real disconnect classification, request count and partial-usage
assertions remain required. Provider tests separately assert preservation of
available upstream codes and omission when no code is supplied. After these fixes,
rebuild and restart the full frozen-build gate rather than combining partial runs.

Historical closure of that checkpoint/HTTP repair: the fixed candidate's complete
default Vitest run subsequently exited 0 with 18,064 passed, 98 skipped and 19 todo
across 1,294 passed files and six skipped files; bundle acceptance passed 55/55.
The retained before/after manifests matched 7,221 source/build/document files with
SHA256 `53cd5300b6b14382b19436e871a7734f5aa656e0c85afe657f75207af83f75e1`.
Logs and manifests remain in `%TEMP%/kodax-cleanup-fix-20261030-135225/`.
Those results cover that historical candidate only. The later natural-exit drain
fence and repeated-root-recovery repairs require their own frozen-build gate;
the earlier 18,064/55 results do not prove those repairs.

## 2026-10-31 frozen gate and follow-up

The first gate used source commit `422acd4a` plus documentation edits on Windows,
Node `v22.23.1`, with retries disabled and two workers. It exited 1 after 2,012.83s:
1,292 files passed, two failed and six skipped; 18,076 tests passed, two failed,
98 skipped and 19 todo. It emitted zero `Managed child cleanup is unverified`
warnings. The 6,914 non-Markdown source/config/test and root/workspace dist files
matched before and after, SHA256
`e525e6c5ea056ec42926545a29cb8e6164303c174d82111f364b4962b2cb8aab`.

The failures were a repeated root recovery boundary timeout in
`tests/sdk-profile-contract.e2e.test.ts` and `ENOTEMPTY` during one-shot fixture
cleanup in `src/one-shot-task.test.ts`. This is a failed full invocation, not a
passing acceptance assembled from earlier targeted runs. Its complete log/JSON
are `%TEMP%/kodax-main-layered-n8Pqdk/final-full.{log,json}`.

Follow-up used two deterministic feedback loops instead of extending timeouts or
retrying directory deletion. A held real `FileSessionStorage.load` demonstrated
that view-owner close returned early and the read recreated the removed root and
`.location-index`; a held committed-item read exposed the same omission. Closing
now stops scheduling/late observations and drains all admitted view/item reads,
including released views, before saves and final close. The view/checkpoint and
one-shot suites passed 45/45, with checkpoint rejection and concurrent/idempotent
close behavior preserved; source/test noEmit passed. Production repair: `a0679021`.

The recovery HTTP fixture separately misclassified requests by their `stream`
flag: ordinary non-streaming fallback received a successful summary, while a real
streaming summary received a context error. Direct HTTP regressions failed on
both mismatches. Summary intent must use the production summary/update prompts,
with SSE for streaming summaries and JSON for non-streaming summaries. The first
full timeout did not retain its last Run state, so this proven fixture defect is
not presented as a proven reconstruction of that historical timeout. Subsequent
boundary failures retain their round, last Run state and request counts.

Final frozen source/build gate, after both follow-ups:

- Source baseline `d36d8f0d` plus documentation only, Windows / Node `v22.23.1`.
  Complete build and source/test type checks exited 0. CLI size is 5,259,331 bytes
  under the 5,260,288-byte budget; dependency and cold-entry assertions remain.
- `node node_modules/vitest/vitest.mjs run --retry=0 --maxWorkers=2` with verbose
  and JSON reporters exited 0 in 1,959.12s: 1,294 files passed, six skipped;
  18,085 tests passed, 98 skipped, 19 existing todo, zero failures. Both first-run
  failed cases and all added regression cases passed in this complete invocation.
- The frozen set of 6,914 non-Markdown repository files outside `docs/`, including
  root/workspace dist artifacts, retained the same before/after content identity:
  `f25c449ef6d7e5e722eb04e54965db7e88b36dc40b2a1a327d1a635366cd32a3`.
  `Managed child cleanup is unverified` warnings: zero.
- Logs, JSON and identity manifests are under
  `%TEMP%/kodax-main-layered-n8Pqdk/final2-{build,typecheck,full}.*`,
  `final2-before.json` and `final2-after-full.json`.
- On that same build, `npm run test:bundle` passed 55/55 with no skipped cases
  in 80.55s. `npm run test:host-cutover` passed 3/3 in 28.47s, covering actual
  historical policy readers, packed Host ownership and concurrent first startup.
  The integrity-pinned alpha.11 archive then passed `npm run test:host-upgrade`
  1/1 in 16.46s, preserving busy work and the Session through in-place upgrade.
  Historical upgrade evidence is
  `%TEMP%/kodax-historical-host-upgrade-LcmTC2/evidence.json`.
- The same content fingerprint remained unchanged after bundle, cutover and
  upgrade acceptance (`final2-after-bundle.json`, `final2-after-all.json`).
  Gate logs and exit codes use `final2-{bundle,cutover,upgrade}.{log,exit}`.

This records Windows/Node 22 offline acceptance, not Node 20 or native Linux/macOS
execution, live-model quality, package publication or completed Space migration.
