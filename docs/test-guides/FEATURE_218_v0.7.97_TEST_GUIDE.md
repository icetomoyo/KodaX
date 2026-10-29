# Built-in manual current-contract regression

## Scope

Baseline: `0f3930e9`, package `0.7.97-alpha.11`; follow-up checked 2026-10-29.
This change repairs the built-in manual and deterministic lookup, not execution,
session loading, permission policy, or provider requests. It is not a new release.

The public seam is `resolveKodaXManual`, also consumed by `kodax_manual` and
REPL `/help <topic>`. Requirements come from FEATURE_218/221 in
`docs/features/v0.7.47.md` and the current `docs/SDK_MIGRATION.md` and
`docs/CLIENT_CONTRACT.md`. Historical byte-cap constants are deprecated;
exact bodies remain complete, with final tool-result admission owning capacity.

## Contracts

- `query` first tries an exact ID, its lowercase form, then an exact alias before
  existing token-overlap ranking. An explicit `topic` still takes precedence.
  Unknown input still returns the index. Only selected/injected topics participate;
  `baseTopics: []` does not restore hidden KodaX topics. Custom IDs retain exact
  spelling, same-ID overrides and product branding.
- `SDK` resolves to sdk instead of memory. `work-mode`, `workMode`, `script`,
  `工作模式`, `Script 模式` and `怎么切换工作模式？` reach commands and explain
  Coding default, experimental Script, idle switching, persistence and scope.
- `token` and `工具原文` reach tools; estimates remain separate from Provider
  usage and UTF-16 offsets, and original reads require a specific tool item.
- `任务报告`, `sidecar`, and `Bash(pattern)` reach sessions, agents, and skills.
  Reports preserve unknown state; the automatic Sidecar Verifier is retired;
  constrained shell patterns still require Host authorization.
- Agents/sessions no longer describe an automatic final verifier. Tools no
  longer promise a durable Runtime event journal. Permission and sandbox topics
  explain Host-owned question deadlines and verify-only filesystem readiness.
- SDK guidance points to current per-topic instructions before compatibility
  notes. Historical release material remains; this change does not broadly prune
  the SDK topic or alter the routing prompt/tool schema.

## Reproduction and validation

Before the fix, exact `SDK` returned memory, six work-mode queries missed their
instructions, and current-topic regressions exposed the obsolete verifier text
and missing original/token/report/Skill guidance. Each failing group was run
before its corresponding fix. One historical test itself required the retired
Sidecar claim; it now requires the current retirement contract.

Run:

```powershell
npx vitest run packages/coding/src/self-knowledge packages/coding/src/tools/manual.test.ts packages/repl/src/interactive/commands-manual-drift.test.ts
npm run typecheck
npm run build
```

The focused source suite passed 100 tests in 7 files. It includes custom-manual
override/full-replacement, alias uniqueness, unknown fallback, complete bodies,
tool wrapping and command inventory guards.

Full build and source/test typechecks also passed. The focused registry/resolver
coverage run reported 100% lines and 92.95% branches (not whole-repository coverage).
The generated `dist/sdk-coding.js` export passed the same 11 concrete query cases
plus consumer full-replacement and obsolete-claim checks without starting a Host.

Per `benchmark/EVAL_GUIDELINES.md`, this is Layer 1 deterministic evidence at the
production lookup seam: fixed queries and returned manual facts directly answer
the bug question. Cost is zero Provider calls. No model-behavior, token-saving,
or broad performance improvement is claimed. New prose follows ADR-033's
single-concept guidance; it describes product facts rather than changing agent
dispatch instructions. Issue 371's historical first-read latency remains open.
