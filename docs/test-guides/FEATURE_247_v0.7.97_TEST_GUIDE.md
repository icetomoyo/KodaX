# Partner Agent work-mode intersection

Status: unreleased source change after `v0.7.97-alpha.11`, 2026-10-30.

Keep the existing Partner options and set `workMode: 'agent'` plus
`context.workModePolicy: 'intersect'`. Do not remove the profile, tool policy,
exclusions, connector leases or authorization callbacks. Integration details:
[embedder contract](../../public_docs/sdk/embedder-guide.md#partner--agent-intersection-unreleased-after-alpha11).

## Automated acceptance

```sh
npx vitest run packages/coding/src/work-mode.test.ts packages/coding/src/agent-runtime/work-mode.test.ts packages/coding/src/task-engine/feature-247-partner-profile.test.ts packages/coding/src/task-engine/result-verification.test.ts packages/coding/src/agent-runtime/middleware/repo-intelligence.test.ts src/runtime-generation-recovery.test.ts
```

The regression first failed because the model schema still contained
`repo_overview`. A separate runtime regression first failed because a stale
active inventory allowed an Agent-excluded LSP handler to execute.

Acceptance covers:

- The real managed LLM adapter's schema excludes all 18 repository/LSP entries;
  discovery and native/bridged execution also exclude their compatibility aliases.
- Partner policy denies shell/file mutation and all child-agent controls. Explicit
  exclusions and denied Host tools remain unavailable, even with a stale inventory.
- A real isolated Skill registry and web-search handler work through the bridge;
  mocked HTTP avoids live network dependencies. Run-scoped connector, Artifact
  and expert-tool fixtures reach the capability executor only after permission.
  A permission rejection prevents the effect.
- Profile identity, exact system instructions and merged verification requirements
  survive. Verification requirements still reach the provider request, and the
  effective-config observer reports Agent and the narrowed tool scope.
- Coder's default/Agent/Coding/Script resolution and specialist-child declarations
  remain compatible. Generation recovery keeps the opt-in and demands a new
  tool-policy binding. Agent skips automatic repo context while preserving supplied
  repository material.

Validation on 2026-10-30: the agent-runtime directory plus work-mode, Partner
profile, result-verification, child-executor, managed-system-contract and
generation-recovery suites passed: 154 files, 1484 tests, 19 existing todo tests.
The additional bound-AMA child-control case subsequently passed with all 11
work-mode runtime tests. Workspace TypeScript build and source/test type checks
passed. No live-model eval or deployed Space acceptance was performed.

## Space integration acceptance

Offline tests exercise KodaX's real schema, discovery, dispatch and prompt paths
with deterministic providers/Host-tool fixtures. They do not prove that a deployed
Space Host uses the new SDK or that live connector/Artifact/expert services work.
After upgrading both SDK and executing Host, run the existing Partner research
and Artifact workflow and inspect `onEffectiveConfig.workMode === 'agent'`.
Confirm the original profile/verification and allowed connector scopes, inspect
model schemas and tool discovery, attempt excluded tools through `tool_call`,
and verify permission denials prevent effects. Repeat Coder Agent/Coding/Script
and dedicated expert-child checks. Session `workMode` alone is not acceptance.

## 2026-10-31 repeated root recovery acceptance

`tests/sdk-profile-contract.e2e.test.ts` now forces two successive generation
checkpoints, kills and restarts the real Host each time, and re-registers scoped
credentials and Host tools. The matrix covers an original profile, independent
`authorization.tools`, a persona-only profile, wider/narrower/empty fresh tools,
and valid fresh authorization without a profile. Original metadata changes cannot
restore a forbidden target. The actual Provider request and effective snapshot
retain original persona instructions and verification, including original absence;
permitted reads and fresh lease calls still execute where their ceilings allow.

`src/runtime-generation-recovery.test.ts` covers two reconstruction cycles for
known complete profile policies, unrestricted `{}` and deny-all `[]`. Arbitrary
Runtime callbacks, unknown previous predicates and legacy records still require
fresh bindings. A caller-supplied floor alone cannot fabricate pure-policy origin.
Unknown predicates must return exactly `true`, preserving the existing fail-closed
boundary even for untyped `undefined`, `null`, numeric or string results.

Final targeted acceptance: the cross-process profile file plus three HTTP fixture
contracts passed 13/13 after summary-intent/SSE correction; recovery admission
unit file passed 12/12, source/test noEmit EXIT 0. Full frozen-build acceptance and its
content identity are recorded in the [cleanup gate](ISSUE_159_v0.7.69_REGRESSION_GUIDE.md).
These offline fixtures do not establish deployed Space or live-model acceptance.
