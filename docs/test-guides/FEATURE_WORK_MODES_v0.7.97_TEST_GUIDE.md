# Shared-contract capability retention acceptance

2026-10-27, Windows x64, Node 22.23.1. Production checkpoint: `c5c296ff`,
compared with `a349eabb`. This checkpoint was committed and pushed before
acceptance began. The subsequent changes repair acceptance drift and a missing
`/work-mode` manual entry; they do not change AMA dispatch, tool handlers or
permissions. Current execution results are recorded below, including failures.

## Scope and evidence levels

The inventory covers all registered tool families and the non-tool product
surfaces. A passing deterministic test proves its exercised contract, not model
intelligence or compatibility with every external service. No paid model calls
were added. Historical natural-task/model evidence and its limitations remain in
[the shared-contract design](../designs/shared-contract-natural-validation.md).

| Capability | Executed regression families / acceptance boundary |
| --- | --- |
| read, write, edit, multi_edit, anchor insertion, undo, glob, grep | `packages/coding/src/tools/*`: real temporary files, stale edits, backups, ownership, refusal/recovery |
| Shell and native writes | bash/process-tree/sandbox tests; Rust transaction and sandbox suites; real installed native binding |
| RepoIntel overview, changes, relation/module/symbol/process/impact/cycle analysis, local/semantic search | `packages/coding/src/repo-intelligence`, tools/changed-diff, repo-intelligence-tools, semantic-lookup: local Git/FS/index and fallback/refresh |
| LSP navigation, symbols and call hierarchy | `lsp/client-integration`: actual stdio handshake, requests, cancellation and shutdown against a fixture server; not every real language server |
| MCP tools/resources/prompts, search/catalogs, reconnect, cancellation, reverse requests | agent MCP runtime/transport and coding mcp-reverse: real local child/HTTP/SSE protocol fixtures; not third-party account availability |
| AMA, children, Todo, Goal, questions and plan approval | Actor/controller, runner-driven, task-engine, Goal runtime and tool tests; real local execution with scripted model decisions |
| Agent/Coding/Script boundaries | managed contract and Script tests; actual provider serialization; installed package and Windows binary lifecycle tests |
| Tool discovery/bridge, constructed tools/Agents, activation, self-modification | coding tools, construction and capability/runtime suites; authorization/availability boundaries preserved |
| Skills, scripts, extensions, workflow and external Agent adapters | agent capabilities, coding extensions/workflows and construction tests; packaged skill dispatcher; external installed agents not exhaustively exercised |
| Memory, learning, history, context/compaction, project instructions | agent memory-control/learning/session-lineage and coding context/prompt suites; durable receipts, quote/ref/fingerprint and trust rules |
| Providers, reasoning, streaming, cancellation, fallback, usage/cost | llm and runtime tests plus local HTTP fixtures; no claim of current live credentials, bills or model quality |
| Web retrieval | parsing, redirect, truncation and failure contracts with HTTP mocks; live search engines not certified |
| CLI/REPL, configuration, manual, sessions/new/fork/rewind/resume, queue and interaction | source suites and real node-pty/xterm acceptance; isolated home and local provider |
| Host/daemon, SDK/client, ACP/A2A, ownership/recovery | contract/system suites and built/installed SDK checks; local protocol peers rather than every external IDE/service |
| Media and Artifact creation, editing, evidence, rendering and distribution | artifact/media tests, real Chromium rendering, built Host worker and installed tarball; LibreOffice conversion remains mocked |
| Tracing, telemetry, team/multi-instance and persistence | respective agent/coding suites; deliberate error-path warnings are not silently treated as successful operations |

The new combined adapter case in `managed-system-contract.test.ts` binds a real
Actor controller, extension runtime and cached MCP provider together with the
Coding Repo tools. Canonical versus compact requests retain every tool name,
the complete MCP/Repo contracts, original Repo policy and dynamic evidence. Each
adapter invocation makes one request; SDK/custom-host rules remain separately
covered. This is an assembly test, not an MCP server or semantic-index E2E.

## Reproducible checks and results

Raw logs, captured requests and temporary packages stay under OS Temp; they are
not committed. The initial logs use prefix `kodax-capability-*-c5c296ff`.

| Check | Result / limitation |
| --- | --- |
| fast | Initial: 2,854 passed, 6 failed, 45 skipped. Three obsolete fixture files were repaired; their 11 cases pass across the focused reruns described below. |
| unit | Initial: 12,270 passed, 1 failed, 4 skipped. The failure was the manual drift guard for missing `/work-mode`; manual/registry/command and release-workflow follow-up: 73 passed. |
| contract | 975 passed, 19 TODO. TODO is not counted as pass. Some historical TODOs have equivalent coverage elsewhere. |
| system | Initial: 1,480 passed, 4 failed, 42 skipped. Three failures explicitly rejected a stale launcher build, one timed out during the same rebuild. The validation run had rebuilt compiled artifacts concurrently. After freezing artifacts, the complete daemon-smoke file passed 26/26; no production guard or timeout was changed. |
| native | Initial fixture `icacls /setintegritylevel L` failed in a checkout-owned directory before product code. Same test passed under user TEMP. Runner now honors existing `KODAX_NATIVE_TEST_TEMP` and defaults to user TEMP; full native command passed. |
| bundle | 48 passed; actual tarball Script read/execution/isolation and missing-worker failure included. |
| Artifact browser | 5 passed with installed Chromium 1248 explicitly selected, rather than accepting default skips. |
| Artifact built/installed package | 4 passed, including real PPT pixels, assets, public imports and consumer declarations. |
| packed native | Passed: actual installed tarball loaded protocol 5 and satisfied the existing doctor/ASRT gate. |
| Windows binary | Bun 1.4.2 build and standalone SDK/native/skill smoke passed. Final archive lifecycle test passed: modes, partial effects, cancellation, restart and receipts with no installed Node/Bun in child PATH. |
| actual terminal | 50/50 passed: Ink 30 and classic 20. Real questions, queueing, cancellation, extensions, RepoIntel trace, three-mode Session selection, new-session isolation and persisted resume. node-pty also emitted a ConPTY AttachConsole cleanup warning; product exit and Host state assertions passed. |
| packaged Electron | Passed with installed Electron 42.5.0: 20 sandboxed commands, four parallel Sessions, process/UI policy and Host lifecycle. Separate gate, not included in `test:full`. |
| combined MCP + Repo assembly | 7 managed-system-contract cases passed, including the new combined case. |
| build / types | Full build and source/test type checks passed; added-test type check passed. |

`test:full` stops on the first failed tier. Therefore unit, contract and system
were explicitly continued and must be accounted separately. Independent
`.test.mjs`, browser, PTY, Electron and native gates are not implied by that command.
Do not add their overlapping counts into a claim of distinct capabilities.

## Failure classification and retained guards

- Old compact experiments asserted that an already compact production request
  must shrink again. They now assert adopted teaching and idempotent historical
  projection while preserving real editing/testing, child refusal and AMA closure.
- The deferred manual experiment required capability names to be repeated in
  system text. Operation contracts now carry those names. The test checks their
  actual retained contracts. A separate obsolete expectation attempted manual
  retrieval through an editing fixture that explicitly forbids it: it now checks
  the hard stop. The tail-command case recovers through an allowed local read;
  manual content and SDK topic injection are verified by `tools/manual.test.ts`.
  The fixture whitelist and production execution policy were not expanded.
- The native fixture could not set an integrity label under inherited checkout
  ACLs. Only its storage location changed; security-label, commit, concurrency,
  cancellation, manifest and native-binding assertions remain intact.
- The old Windows archive test compared Script's compact shell description with
  the SDK's long canonical description. It now compares the actual full shell
  contracts across all three modes, including `run_in_background:boolean`.
- PTY previously requested retired SA. It now uses AMA, tests Agent/Coding/Script
  Session selection and reads current Host state. A continued marker-only query
  need not launch RepoIntel; the trace test now requests a real repository review.
  User high effort is an AMA ceiling, not a demand to override Worker's medium
  default; the rejection fixture targets the actual chosen effort. New-session
  isolation permits exactly the platform envelope plus the real prompt, and
  prohibits inherited assistant/tool history. No production policy was changed
  to satisfy these checks.

## Explicitly unverified

This run does not certify macOS/Linux or other native architectures; live
GLM/Kimi/DeepSeek and all other provider/vision behavior; arbitrary MCP/LSP/ACP/A2A
servers; real LibreOffice layout fidelity; or every historical user-session
shape. Ordinary test execution is not a measured repository-wide coverage
percentage. No new statistical guarantee of intelligence or whole-task latency
non-regression is inferred from deterministic success.

The contract suite's 19 TODOs require interpretation: for example CAP-013's
cleanup persistence is covered by CAP-082, and CAP-045 session load by CAP-008.
CAP-015's historical “read clears edit blocking” TODO conflicts with current
CAP-026 and Script recovery behavior: only a successful supported edit unlocks
that state. Do not revive the old behavior to remove a TODO.

## Final disposition

No unresolved executed-test failure remains after the targeted repairs and the
stable-build daemon rerun. Initial failures remain in the raw logs; this is not a
claim that the first `test:full` command was green or that all tiers were rerun
after every fixture-only change. The complete deterministic tiers plus targeted
repairs cover over 17,500 assertions; independent package/terminal/native gates
are reported separately to avoid double counting. The only production change
made during this acceptance is the manual's missing `/work-mode` entry.

Independent review of the eight code/test changes: Standards 0 findings, Spec 0
findings. Both reviews explicitly require keeping the assembly-versus-external-E2E
distinction. No new model call, discovery round, tool removal or AMA policy
change was introduced. Further token work is analysis only at this checkpoint.
The current complete-input costs and source-backed next candidate are recorded
in [Agent below 10K](../designs/agent-under-10k-next-plan.md); proposed savings
there are not counted as implemented improvements.


## Subsequent rule-ownership batch

The next implementation preserves this capability baseline and changes only
ordinary-root presentation. Its TDD, full-fast failures and focused resolutions,
actual SDK wire comparisons, installed tarball and build/type checks are recorded
in [the rule-ownership execution record](../designs/agent-under-10k-next-plan.md#execution-record-rule-ownership-candidate).
Current same-counter inputs are Agent **10,712**, Coding **14,344**, Script
**16,214**; each saves 871 versus this guide's original checkpoint. This later
batch did not repeat paid model evaluation or the entire cross-platform matrix.
