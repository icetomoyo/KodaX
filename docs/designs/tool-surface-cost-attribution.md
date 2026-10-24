# Tool surface cost attribution

Current portfolio decisions and validation sequence: [全盘工具与注入方案](tool-portfolio-plan.md).
The family-specific audits below remain evidence, not separate implementation priorities.

## 2026-10-24 comparison clarification: capability absence versus inactive state

The preceding KodaX binding audit did not establish that all comparators implement
the same visibility rule. Follow-up inspection pins local Codex `970111f6cb` and
DSH `22ddee3792`; no production change or model run.

- Codex `core/src/tools/spec_plan.rs:1315` registers synchronous user input when
  its config enables it, with direct exposure even in Code Mode Only. The handler
  checks root/mode eligibility at execution; async input additionally depends on
  model support. This is not universal hiding outside Plan mode.
- Codex `ext/goal/src/extension.rs:559` contributes all three Goal tools when the
  runtime is visible/enabled, independent of whether a goal exists. Visibility
  and executability differ: a nonpersistent thread can still see them but receives
  `Goal tools require a persistent thread` (`tool.rs:172`). Thus unbound-capability
  filtering is a KodaX-specific correctness proposal, not exact Codex parity.
- DSH Standard and PTC preset patches both include `tool-ask-user` and `tool-goal`.
  Their plugins depend respectively on `userQuestions` and `goals` services; neither
  waits for an existing question/goal to register tools. UI mounting is explicitly
  separate from preset tool composition (`client/ui-user-questions/src/index.ts`).
- DSH `plan/plan-mode/src/index.ts:375` gates `exit_plan_mode` on selected-active OR
  entered Plan state. It retains execution-time state checks and handles the rest
  of a tool batch / next-step transition. Core Codex has no same-named approval
  tool; its `update_plan` is a different planning operation.

Refined recommendation: keep functioning question and Goal capabilities in normal
KodaX sessions. Do not claim zero intelligence impact from removing model-visible
declarations; absence of callable implementation proves no loss of that execution
path, not model-decision equivalence. Missing-binding cleanup remains conditional
Host correctness with zero normal full-Host token saving, not the next major
optimization. State-gating `exit_plan_mode` is a separate DSH-supported candidate;
it requires effective Plan-mode transitions, resume, same-batch and native/bridge
checks and must not gate AMA planning. Neither candidate is implemented here.

## 2026-10-24 unbound interaction, approval and Goal audit

Analysis only, after the LSP implementation below. No production changes or model
calls. The current assembled context with no interaction/approval/Goal adapters
still exposes all five native tools. Seven offline audit checks and 60 existing
question, plan-exit, Goal handler and Goal binding tests passed. Raw audit:
OS Temp `kodax-host-binding-audit-lOaewn/report.json`.

| Builtin family | Evidence for completely unavailable | States that must retain exposure |
| --- | --- | --- |
| `ask_user_question` | All three effective callbacks (`askUser`, `askUserInput`, `askUserMulti`) absent | Any one callback present; each single-binding variant executed successfully |
| `exit_plan_mode` | Effective `exitPlanMode` callback absent | Bound callback outside Plan mode, rejected approval, cancelled/pending approval; state is not absence of capability |
| `create_goal`, `get_goal`, `update_goal` | Effective `goalContext` absent after Host assembly | Bound context with no goal, completed/blocked goal, temporarily unavailable journal, or no initial conversation branch |

Goal absence cannot be inferred from `get_goal` output: both an unbound fallback
and a real empty binding return `No goal set`. The real binding successfully
created and read a fixture goal afterward. Menu assembly did not invoke the goal
reader or approval callback. Do not probe live state or perform I/O to decide
availability. Plan approval is the permission-mode approval interface, not the
AMA planning/dispatch mechanism; do not change Todo or AMA policy.

Source: `tools/ask-user-question.ts`, `tools/exit-plan-mode.ts`, `tools/goal-tools.ts`,
`goal/tools-context.ts`, `goal/runtime-wiring.ts`, `goal/session-binding.ts`,
`agent-runtime/tool-execution-context.ts`, and `src/sdk-runtime.ts` Run events /
Goal binding assembly. Shared Host interaction proxies are real bindings even
without a currently connected UI; they must not be removed by inspecting only
original client callbacks. Storage without `mutateLineage` yields no Goal binding;
a temporary session-read failure throws instead and must not be treated as a
permanent missing capability.

Pure declaration-deletion deltas from the post-LSP frozen `ama-empty` request in
`kodax-first-turn-wire-kbrPz0`, with all other model fields unchanged:

| Family | OpenAI estimate saved | Anthropic estimate saved |
| --- | ---: | ---: |
| Question | 800 | 793 |
| Plan approval | 238 | 231 |
| Goal three | 548 | 526 |
| All five absent | 1,586 | 1,550 |

The hypothetical empty-Host totals are 17,425 → 15,839 OpenAI and 17,143 → 15,593
Anthropic. These are deletion estimates on actual serialized request bytes, not
implemented captures or provider usage. The normal shared Runtime Host binds all
three families, so this proposed rule yields **zero** reduction there. Do not
subtract these deltas from the full-Host Codex comparison or count them as already
achieved. No prompt-rewrite saving is included.

Smallest next implementation, not yet authorized by this audit: add the three
builtin-only availability predicates at the existing shared menu/discovery/bridge
ceiling, based on resolved execution bindings. Preserve raw unassembled SDK
contexts, direct handlers, invocation-time callback bindings, extension overrides
and role ceilings. Retain all forms when any question callback is usable; do not
add partial-schema variants, a new mode or discovery round. Restore exposure on
the next bound assembly and keep stale-call refusals explicit. Offline acceptance
should cover missing/partial/full bindings, empty-state transitions, shared Host
proxies, extension/role restrictions, native/discovery/bridge parity, permission
refusal/recovery and single work charging. Existing normal Host normalized input
should remain identical. This is configuration correctness, not a demonstrated
normal-Host first-turn reduction or model-intelligence result.

## 2026-10-24 disabled-unbound LSP implementation

Implemented only the first audit recommendation below. Context assembly resolves
the existing injected/default service once and records `lspNavigationDisabled`
when no service is available. This is an execution-context fact, not a new user
setting. The shared builtin discovery filter consumes it only when no service is
bound, covering AMA native assembly, discovery and bridge targets. The eight
navigation tools and their prepare-call-hierarchy compatibility entry remain
registered; SDK handlers, lazy startup, injected services, extension replacements,
role restrictions and AMA strategy are unchanged. A new enabled assembly restores
availability. No LSP merge or other capability-family gate was introduced.

The first regression failed on all eight native declarations before the fix.
Nine focused cases now pass for disabled menus/search/bridge, stale-call rejection
and read fallback, environment/run precedence and re-enable, initial/late host
binding, raw SDK compatibility, extension replacement, permission rejection and
recovery, and role visibility. Existing fake-LSP execution and bridge cancellation/
budget tests also pass: 122 distinct targeted tests across nine files, including
the 16-scenario public wire inventory. Source/test typechecks, a separate strict
typecheck of the new regression file, and the coding package TypeScript build
passed. No paid model evaluation was run or implied.

New raw wire evidence: OS Temp `kodax-first-turn-wire-kbrPz0/inventory.json`,
compared with `kodax-first-turn-wire-dsClDp`. For the explicitly disabled empty
AMA fixture, native entries fall from 52 to 44, tool estimates by 1,151 OpenAI /
1,094 Anthropic; existing capability-aware prompt assembly also removes about
49 estimated tokens of unavailable LSP advice. For the ordinary full Runtime
Host, both protocols' normalized complete input hashes are identical to the
pre-fix captures: 54 entries and no default input reduction. These are offline
request-byte estimates, not usage or model-quality measurements. Relevant
executable regressions: `packages/coding/src/agent-runtime/lsp-tool-availability.test.ts`
and `tests/first-turn-wire-inventory.test.ts`.

## 2026-10-24 capability binding and shared LSP offline audit

This audit supersedes the unmeasured LSP proposal in the status section below.
Scope: current working tree on `8d3f05e0`; source inspection, production-menu
inspection and controlled offline execution only. No production behavior change,
provider call or model-quality claim. AMA, SDK handlers and specialist policies
remain unchanged.

### Confirmed availability boundaries

- **Disabled default LSP:** `lsp:false` / `KODAX_LSP=0`, with no injected service,
  leaves all eight navigation declarations in the AMA model menu. The actual
  handler returns `LSP is unavailable`. This is also visible in the frozen public
  `runManagedTask` empty-workspace wire capture, not just a factory fixture.
  Removing these declarations in that unavailable configuration could save about
  1,152 OpenAI / 1,094 Anthropic estimated tokens. This is conditional saving,
  not a saving in the default full Host, whose lazy LSP service is available.
- **Lazy and injected LSP:** a service need not have started a language-server
  process to be usable. The context builder preserves an explicitly injected
  service even when default LSP is disabled; a real handler reached its injected
  method in the offline fixture. Neither a cold process nor a server missing for
  one language establishes absence of the whole capability.
- **Unbound Host tools:** `ask_user_question`, `exit_plan_mode` and goal tools
  remain declared without the respective Host adapters. Direct input-question,
  exit-plan and create-goal calls returned binding errors. `memory_recall` remains
  declared but returns the same no-applicable-claim response used for empty recall.
  Any question callback can provide a usable question form; no active goal is
  different from no goal adapter; empty memory is different from no memory binding.
  Memory mutation also has a legacy adapter path, so it must not be gated on only
  the newer binding. These are configuration-specific candidates, not proof that
  the normal interactive Host can discard these tools.
- Workflow, skill-script, history, actor and MCP have existing discovery gates;
  do not count their already-absent schemas as new savings.
- **Repo off needs semantic alignment first:** the builder carries the per-run
  setting in `parentAgentConfig.repoIntelligenceMode`, while `module_context`
  invokes the query without a mode override. In a fixture with per-run `off` and
  global `light`, it still returned indexed module evidence. Global `off` returned
  limited/unavailable evidence, while `repo_overview` still returned a valid
  filesystem overview. The legacy off filter is broader than this distinction.
  Copying that filter into AMA would conflate index availability with independent
  file/Git abilities. Do not hide the whole Repo family on this evidence.

Source anchors: `agent-runtime/tool-execution-context.ts`, `lsp/service.ts`,
`tools/tool-search.ts`, `tools/lsp-navigation.ts`, `tools/module-context.ts`,
`repo-intelligence/runtime.ts`, and managed-task `agent-chain.ts` / `llm-adapter.ts`.

### Shared native LSP: measured benefit and equivalence limit

The measurement replaces eight declarations with one hypothetical `lsp_query`
enum operation, shares path/position fields, and retains all eight existing
operation descriptions. No discovery call is added. Same frozen full-Host request
bytes and `countTokens` estimator as the status table; not actual provider usage.

| Protocol | Existing LSP | Shared LSP | Net reduction | Whole input before → hypothetical after |
| --- | ---: | ---: | ---: | ---: |
| OpenAI | 1,152 | 752 | 400 | 20,028 → 19,628 |
| Anthropic | 1,094 | 745 | 349 | 19,675 → 19,326 |

The offline adapter delegates to the existing bridge, not a new production
dispatcher. All eight operations preserved leaf arguments/results and the
controlled refusal/recovery sequence: denied work charged zero, successful work
charged one, and both paths used three scripted responses including the final
report. Invalid positional input, service failure and subsequent recovery also
preserved observable content/error semantics, charging three attempted executions.
An initial strict object-equality assertion failed on existing optional-key
representation (`isError:false`/`metadata:undefined` versus omitted keys); comparison
was corrected to observable semantics without altering execution behavior.

**Full permission equivalence is NOT established.** The prototype calls the Host
permission callback for both `lsp_query` and the concrete leaf, versus just the
leaf natively. Production `resolveToolBridgeTarget` recognizes `tool_call`, not
this new alias, so existing automatic review does not yet resolve its operation.
The shared schema also weakens per-operation required fields to prose plus handler
validation; provider conditional-schema acceptance and model argument quality are
unverified. A production wrapper would need a fixed operation allowlist, concrete
policy resolution, no duplicate review/budget charge, and override/role/cancellation
coverage. Zero added discovery steps does not prove zero added review requests or
recovery rounds. Do not ship this prototype for a roughly 1.8–2.0% input saving.

Evidence: 14 controlled audit checks passed; 22 existing checks passed across
`agent-chain.bridge-boundary.test.ts`, `tools/lsp-navigation.test.ts` and
`tests/deferred-repo-lsp.e2e.test.ts` (including local fake-LSP protocol execution,
permission rejection, cancellation and single work charging). These support the
existing bridge, not complete shared-alias or real-model equivalence. Final raw
audit: OS Temp `kodax-capability-lsp-audit-QXwbkz/report.json`; prior failed assertion
retained in `kodax-capability-lsp-audit-ptFFhK`. No paid reruns.

### Smallest recommended next change, not yet implemented

First address only verified unavailable builtin bindings at the resolved-context
assembly boundary, reusing the existing discovery/dispatch ceiling. Start with
disabled-and-unbound LSP; preserve injected/lazy services and extension overrides.
Keep native projection, discovery and bridge availability consistent; reject stale
calls clearly and restore exposure when a later assembled run has a binding.
Do not infer SDK raw-context unavailability before its normal context assembly.
Then apply the same narrowly verified rule to wholly unbound question/plan/goal
adapters. Keep valid SDK and specialist access unchanged. No new mode, router,
discovery step or paid model evaluation is needed for these deterministic checks.
Separately align Repo mode propagation and distinguish baseline operations from
index-backed queries before deciding any Repo visibility change. Defer the shared
LSP default unless its additional policy/schema work becomes independently useful.

## 2026-10-24 current workspace refresh

This section supersedes older totals below, not their frozen experiment results.
Current KodaX is HEAD `8d3f05e0` plus the working-tree local-search/contract and
same-snapshot identity changes. The existing first-turn wire inventory passed
all 16 serialized scenarios with synthetic responses and zero external calls.
Raw requests, hashes and `current-comparison.json` are preserved in OS Temp
`kodax-first-turn-wire-dsClDp`. No production changes or paid model runs were
made for this status review.

The table uses the same compact, nonempty system/instructions/messages/input/tools
fields and `countTokens` heuristic. These are actual request bytes measured with
an estimator, not API usage, BPE or UI context. Codex/DSH remain the previously
captured pins (`deede7201d` / `687f282e86`); their currently checked local HEADs
are `970111f6cb` / `22ddee3792`. No claim of fresh captures for those new HEADs.

| Windows isolated workspace, full Host where applicable | Model input estimate | Tool representation | Remaining input | KodaX OpenAI excess |
| --- | ---: | ---: | ---: | ---: |
| KodaX AMA / OpenAI, current | 20,028 | 12,291 | 7,737 | — |
| KodaX AMA / Anthropic, current | 19,675 | 11,909 | 7,766 | — |
| Codex Sol / captured default Only | 17,048 | 9,271 | 7,777 | 2,980 |
| DSH Standard / captured preset | 9,325 | 7,234 | 2,091 | 10,703 |
| DSH PTC / captured preset | 11,760 | 8,753 | 3,007 | 8,268 |

KodaX current Host has 54 native entries versus the previous 55. Relative to
the preceding 20,276 OpenAI model-field capture, the total is lower by 248;
tools account for 218 and other input for 30. Do not attribute the whole delta
to the latest change or mix the different 19,732 embedded-Runtime fixture into
this series. This empty non-Git fixture does not exercise the combined Git
overview/scope identity deduplication; the earlier ~33-token two-line estimate
applies to that separate Git sample.

The Codex excess reconciles as tools +3,020 and other input -40. The DSH Standard
excess instead combines tools +5,057 and other input +5,646; PTC combines +3,538
and +4,730. These are differing capability/prompt assemblies, not equal-quality
benchmarks. The separate same-model Codex Direct capture was 15,174 versus
Only 17,047; Code Mode is not a free first-turn reduction.

Current OpenAI per-entry estimates: LSP eight total 1,152; Repo four total 647;
relationship_scan 428; ask_user_question 801; spawn_agent 738; todo_update 564;
memory_intent 513. Per-entry rounding differs from full-array sums. Tool size
is a screening signal, not removable excess: questions and spawn were already
close to their captured Codex counterparts, and four Repo capsules retain
evidence missing from the aggregate.

Next-step recommendation, analysis only:

1. Audit explicit capability-disable and Host binding consistency across root,
   child, discovery and execution. Remove unusable declarations only on proof
   of explicit unavailability, not because a lazy service is not started or a
   catalog is temporarily empty. LSP's 1,152 is an upper bound in disabled
   scenarios, not an additional default saving; existing gates must not be
   counted again. Restore valid exposure when authoritative state changes.
2. If further default reduction is needed, first calculate a compact native
   LSP operation contract offline. It could share file/position fields without
   a discovery round, but needs full operation teaching and leaf permission,
   budget, result and recovery equivalence. No net saving is yet measured and
   no new dispatcher is approved. DSH's four-operation LSP is not a substitute
   for all eight KodaX operations.
3. Do not expand small metadata/prose edits, replace Repo four with the current
   aggregate, or broadly defer tools. Prior Kimi preflight increased from two
   to three requests and 34,573 to 49,740 task tokens; that is sufficient reason
   not to ship a universal deferred default. Do not initiate paid reruns for
   these small changes. PTC remains a separate total-task efficiency proposal,
   and stable caching is a billing/latency question rather than smaller first
   context.

There is currently no demonstrated multi-thousand-token default reduction
that simultaneously guarantees unchanged model choices and no extra rounds.
Preserve AMA and the validated native path while evaluating a bounded candidate;
the absence of such evidence should stop implementation, not trigger more
repeated sampling.

Status: source-pinned attribution and necessity audit, 2026-10-21. KodaX
`3a87e7fe` complete Windows AMA Host capture; Codex `3b8f43a06b` Sol
source-built capture. Codex local HEAD was rechecked unchanged. No paid requests.

## Accounting boundary

Both use the same compact model-field order and KodaX countTokens estimator.
KodaX is 20,191 versus Codex 17,032: difference 3,159. Tool representations are
12,424 versus 9,271: difference 3,153; non-tool inputs differ by six. This is
not BPE, provider usage, UI context, intelligence parity or a same-capability
benchmark. Tool count is 55 native versus 11 native + 12 embedded SDK declarations.

Each KodaX row counts the complete OpenAI function object. Each Codex native
entry is counted once. The functions.exec description contains all twelve SDK
sections: their costs are deletion deltas from that actual serialized entry,
while the orchestration prefix keeps shared runtime/MCP type instructions.
Serialization/namespace/rounding residuals reconcile both sums exactly. Raw
requests, hashes and executable attribution remain in OS Temp.

## Capability-family reconciliation

Families are analytical groupings, not equal APIs. Zero means no dedicated
entry in this particular capture; shell/code execution can still perform work.

| Family | KodaX | Codex | Difference |
| --- | ---: | ---: | ---: |
| collaboration | 2,121 | 1,313 | +808 |
| questions | 801 | 714 | +87 |
| planning | 1,899 | 761 | +1,138 |
| filesShell | 2,445 | 1,107 | +1,338 |
| repoLsp | 2,964 | 0 | +2,964 |
| memoryHost | 1,625 | 602 | +1,023 |
| web | 235 | 2,750 | -2,515 |
| orchestration | 338 | 1,934 | -1,596 |
| residual | -4 | 90 | -94 |
| Total tools | 12,424 | 9,271 | +3,153 |

The three-thousand-token gap is a **net** result. Codex Web and orchestration
are substantially larger; summing only KodaX-exclusive tools would overstate
removable excess. The current spawn pair differs by just 66 (738 versus 672);
the collaboration difference is mostly additional discovery/output semantics
and richer messaging/interrupt contracts. Questions differ by 87 even though
KodaX retains batch, flat text and expiry behavior.

## Necessity and more effective alternatives

- **Todo (1,112) and exit_plan_mode (238):** these dominate the planning difference,
  partly offset by KodaX's smaller Goal contracts. Codex's captured menu has no
  separate update_plan; its source also supports planning tools under other
  configurations, so this is not proof that Codex never plans. Replacing KodaX
  Todos with whole-plan text would lose stable IDs, incremental preservation,
  owner/state transitions, hook vetoes and completion evaluators. An action-based
  single tool would move those schemas into a union and require new routing;
  no demonstrated saving yet justifies that implementation. Prefer auditing
  repeated Todo explanation and optional metadata/evaluator disclosure first.
- **Repository/LSP (2,964):** ordinary lookup can use grep/glob/bash, but LSP
  resolves current semantic positions while repo capsules provide bounded
  module/process/impact evidence. Missing dedicated Codex tools does not prove
  these results are redundant. relationship_scan already composes module, symbol,
  process and impact queries; it is the strongest existing replacement candidate
  for overlapping root entry points. Its broader output, warming/partial failure,
  latency and fallback grep behavior must be compared against the narrow tools
  before changing visibility. Keep SDK handlers, specialist menus and native
  entries for now. code_search (222) and repo_overview (123) alone cannot close
  the gap; their previous invalid/limited trials are not retirement evidence.
- **Files/shell (2,445):** Codex's shell/patch approach covers many workflows with
  fewer names, but KodaX edit/write enforce trusted mutation and stale identity,
  while undo and worktree operations carry independent state. changed_scope
  returns structured scope analysis, changed_diff returns patch evidence; neither
  replaces the other. insert_after_anchor (135) overlaps edit but adds automatic
  newline placement and normalized-anchor ambiguity handling. Compare those
  cases through edit before considering entry consolidation; shell rewrites are
  not an equivalent fallback. Existing edit batches and parallel calls already
  cover multi-edit and independent reads; a new batch tool is unnecessary.
- **Memory/manual/history (1,625):** mediated memory writes, version-bound product
  knowledge, Skill invocation and persisted history are independent contracts.
  File reads cannot replace their scope/authority/provenance. Optional-field
  disclosure is more credible than deleting these capabilities.
- **Collaboration:** list_dispatchable_agents selects registered specialists;
  list_agents pages live topology. agent_output retrieves exact-turn artifacts;
  wait_agent consumes mailbox evidence. Combining these would require modes and
  careful pagination/history semantics, not simply deleting an alias. DSH's
  send_message can start an idle child's turn, unlike KodaX messaging; it cannot
  replace followup_task without changing AMA scheduling.

No new tool, tool retirement, role policy or visibility change is accepted here.
The [relationship entry coverage audit](relationship-entry-coverage.md) at
`6a0c6a0f` subsequently found independent evidence and recovery differences;
it recommends retaining all four native entries. Their research-only deletion
saves 659 estimated first-input tokens, not a proven complete-task saving.

The relationship audit records its remaining corrective and validation work.
Other candidates are Todo optional-field disclosure and anchor insertion versus
checked edit. First measure schema savings after retaining every obligation,
then run offline output/permission/recovery equivalence and bounded real-task
pairs if necessary. Do not introduce a generic query router, extra configuration
or a new code runtime just to reach a numeric target.

## Complete per-tool attribution

| KodaX native entry | Estimated tokens |
| --- | ---: |
| ask_user_question | 801 |
| spawn_agent | 738 |
| todo_update | 564 |
| memory_intent | 513 |
| relationship_scan | 449 |
| grep | 402 |
| todo_create | 380 |
| changed_diff | 315 |
| edit | 311 |
| update_goal | 307 |
| kodax_manual | 302 |
| send_message | 295 |
| bash | 275 |
| read | 250 |
| skill | 242 |
| exit_plan_mode | 238 |
| session_history_search | 224 |
| code_search | 222 |
| tool_search | 217 |
| write | 214 |
| changed_scope | 206 |
| list_dispatchable_agents | 206 |
| semantic_lookup | 201 |
| wait_agent | 200 |
| impact_estimate | 191 |
| create_goal | 182 |
| followup_task | 179 |
| interrupt_agent | 176 |
| lsp_definition | 172 |
| memory_recall | 172 |
| session_history_read | 172 |
| list_agents | 171 |
| todo_list | 168 |
| lsp_references | 165 |
| process_context | 162 |
| symbol_context | 162 |
| cyclic_dependencies | 158 |
| agent_output | 156 |
| lsp_implementation | 150 |
| lsp_hover | 147 |
| module_context | 144 |
| web_fetch | 137 |
| worktree_remove | 137 |
| insert_after_anchor | 135 |
| lsp_workspace_symbols | 135 |
| lsp_incoming_calls | 134 |
| lsp_outgoing_calls | 134 |
| repo_overview | 123 |
| tool_call | 121 |
| lsp_document_symbols | 115 |
| web_search | 98 |
| worktree_create | 93 |
| glob | 71 |
| get_goal | 60 |
| undo | 36 |
| serialization residual | -4 |

| Codex native / embedded SDK entry | Estimated tokens |
| --- | ---: |
| web__run | 2750 |
| functions.exec orchestration | 1415 |
| exec_command | 733 |
| collaboration.spawn_agent | 672 |
| update_goal | 528 |
| functions.request_user_input_async | 375 |
| functions.wait | 339 |
| functions.request_user_input | 339 |
| write_stdin | 313 |
| create_goal | 171 |
| list_mcp_resource_templates | 171 |
| view_image | 171 |
| collaboration.wait_agent | 161 |
| collaboration.followup_task | 160 |
| list_mcp_resources | 147 |
| collaboration.send_message | 124 |
| read_mcp_resource | 113 |
| clock.sleep | 107 |
| collaboration.interrupt_agent | 105 |
| collaboration.list_agents | 91 |
| serialization/namespace/rounding residual | 90 |
| clock__curr_time | 73 |
| get_goal | 62 |
| apply_patch | 61 |

Primary sources: KodaX tools/tool-definitions.ts, tool-resolution.ts,
relationship-scan.ts, lsp-navigation.ts, changed-scope.ts, changed-diff.ts,
insert-after-anchor.ts, todo-create.ts, todo-update.ts and agent-collaboration.ts
under packages/coding/src; Codex core/src/tools/{spec.rs,spec_plan.rs,handlers/}
and code-mode-protocol/src/description.rs under codex-rs; DSH subagent control
contracts at reference revision 1517a4dbca. Historical capture dates and limitations
remain in [Windows comparison](first-turn-windows-comparison.md).

## 2026-10-23 current-source entry audit and proposed next gate

Status: **analysis only; no new tool visibility, handler or default change**.
KodaX remains `92dc1126a8`; current local reference HEADs match the captures:
Codex `deede7201da27a178c39befa6b4959bb7d451645`, DSH
`687f282e8625c6b8d11ff58211a90524be2e4317`. Six saved raw request hashes and
their same-estimator model-field totals were independently rechecked with
zero external calls. These are source-pinned heuristic input estimates,
not provider usage, desktop context readings or same-capability comparisons.

| Current Windows capture | Model-field estimate | Tool representation |
| --- | ---: | --- |
| KodaX AMA OpenAI Host | 20,276 | 55 native; 12,509 tool tokens |
| KodaX AMA Anthropic Host | 19,916 | 55 native; 12,120 tool tokens |
| Codex Sol | 17,048 | 11 native + 12 embedded SDK; 9,271 combined |
| Codex Astra | 16,960 | Same representation |
| DSH Standard | 9,325 | 31 native; 7,234 tool tokens |
| DSH PTC | 11,760 | 1 native + 30 SDK; SDK input/output included |

OpenAI Host versus Sol differs by 3,228 overall: tools +3,238, other input -10.
The previous family attribution still applies except filesShell increases by
85 from the retained read recovery contract (2,445 to 2,530). Repo/LSP's 2,964
are dedicated KodaX surfaces, not proof of redundant capability; Codex's larger
Web/orchestration contracts offset much of the net gap. PTC is not intrinsically
smaller: its full SDK stays in model input. DSH HTTP extensions and backend
consumption remain unknown as recorded in the Windows comparison.

The following deltas remove entries from the **complete frozen request** only.
They include JSON-array rounding and are not net implementation/task savings.
For example, code_search's standalone object is 222, but its removal delta is
221. No replacement hint, discovery result, extra model round or cache effect
has been subtracted.

| Candidate | Raw first-input ceiling | Necessity and minimum viable proposal |
| --- | ---: | --- |
| Five accepted aliases | 0 | multi_edit, changed_diff_bundle, tool_describe, todo_get and LSP prepare are already absent. Preserve their SDK handlers and same-name extensions. |
| exit_plan_mode outside Plan | 238 | First candidate for offline audit: a trusted non-Plan Host state makes the action invalid. Keep it native in Plan, retain callback/SDK/approval behavior, and restore visibility on authoritative mode changes. Unknown embedding state and extension overrides retain existing visibility. This is not an implemented DSH policy. |
| Local code_search entry | 221 | grep/glob cover ordinary content/path lookup; grep's 256-character regex safety ceiling, literal escaping, combined path/content results and extension providers prevent complete substitution. Test only a root builtin display projection with full discovery/execution retained; do not change the handler or add another search tool. |
| impact_estimate entry | 191 | relationship_scan already loads impact information. Compare this one detailed entry first; preserve target/overlap/caller/freshness evidence, original permission identity and extension dispatch. Aggregate output/latency can exceed the narrow query, so do not assume net task savings. |
| insert_after_anchor entry | 134 | Checked edit can express ordinary insertion, but automatic LF/CRLF placement, end-of-file and normalized-anchor ambiguity behavior are distinct. Offline characterization first; retain native unless sufficient evidence supports a worthwhile change. |
| Four detailed repo entries together | 659 | Not a lossless replacement: module tests/docs, symbol signature/imports and process notes/alternatives remain independent. Previous refresh/warning fixes do not prove complete coverage. Do not hide all four. |
| Eight LSP entries | 1,151 | Compiler resolution, overloads, re-exports, references and call hierarchy are not replaced by text search or approximate repo graphs. Do not create an action router merely to reduce tool count. |
| Todo create/update/list | 1,112 | Stable IDs, incremental updates, ownership, vetoes/evaluators and recovery differ from whole-plan text. Preserve current AMA semantics; combining under an action union requires independent value, not just fewer names. |

Even raw removal of exit_plan_mode, code_search, impact_estimate and
insert_after_anchor together saves only 785: 20,276 to 19,491, still 2,443 above
Sol, before replacement costs. This is not an adoption target. A safe small
change cannot be advertised as closing the whole gap.

Proposed order, not yet implemented:

1. Audit state-specific exit_plan_mode visibility using the existing trusted
   Host state. No new user preset/configuration. Verify Plan entry/exit,
   approval denial/cancellation, live settings changes, restart/compaction and
   child/SDK/extension behavior. A static excludeTools filter is unsuitable if
   it cannot restore the tool; abandon the candidate if it needs a new state
   machine. Keep request-prefix/cache changes in the measurement.
2. Separately test one root-local code_search projection. Keep native
   grep/glob/read; preserve long literal/provider results through checked
   discovery/bridge, all SDK and specialist/child entries, active permissions
   and dynamically registered providers. Do not add it to the global alias
   filter or confuse exclusion with model presentation. If discovery causes
   an extra full-context request, it may dominate the roughly 221 saved tokens.
3. Treat impact and anchor as separate offline candidates. Do not expand
   relationship_scan into another general query router, or add apply_patch
   merely to replace existing trusted edits. Keep current native when output,
   recovery or whole-task value is not equivalent.

Validation must freeze the actual ordered production menu, source, task and
budgets per experiment. First use zero-network SDK serialization and real
native/bridge regressions to check results, denied-call recovery, canonical
ownership, CAS/atomicity, cancellation, work-unit accounting, same-name
extensions, provider activation/revocation and post-compaction discovery.
Then use small blinded GLM/Kimi Layer 2/3 pairs for semantic comparison;
controlled fixtures must include the candidate's differentiating cases.
Only after that gate, at most one complex smoke per model checks real readonly
QA, autonomous recovery, actual edit/test, exact child report integration and
AMA settlement. Whole-task input/output including cache, auxiliary calls,
unknown reservations and wall time accompany the task-level review. No
automatic per-metric pass threshold replaces semantic assessment, and smoke
is not a prompt A/B or global intelligence non-inferiority claim. Existing
final-native GLM/Kimi closure evidence remains baseline evidence only.

Primary implementation boundaries: `agent-runtime/tool-resolution.ts:67`
(accepted builtin aliases), `tools/model-tool-definition.ts:18` (model-only
projection), `tools/tool-search.ts:84` and `:132` (discovery and full contracts),
`tools/code-search.ts:88`, `tools/grep.ts:9`, `tools/exit-plan-mode.ts:24`,
`src/sdk-runtime.ts:14593` and `:20711` (approval binding/state),
`tools/relationship-scan.ts:531` and `:670`,
`repo-intelligence/semantic-render.ts:84`, `tools/insert-after-anchor.ts:79`
and `:114`, under the corresponding KodaX package. DSH deliberately retains
a cross-mode catalog for cache stability (`standard.patch.yml:59`); its Plan
tool registers before checking mode at execution (`plan-mode/src/index.ts:277`).
Here the DSH paths are `packages/bundle/web-app/presets/standard.patch.yml`
and `packages/plan/plan-mode/src/index.ts` at the pinned revision. Codex source
boundaries are `codex-rs/core/src/tools/spec_plan.rs:1013` (SDK assembly),
`:1235` (feature/model tool selection), and
`codex-rs/core/src/tools/handlers/multi_agents_v2/{send_message,followup_task}.rs:39`
(QueueOnly versus TriggerTurn). Its patch grammar is
`codex-rs/core/assets/tools/apply_patch.lark:1`; its multi-file delta/failure
contract is not KodaX's single-file atomic edit contract.
The new attribution/projection outputs are in OS Temp
`kodax-tool-entry-audit-20261023-boqG7d`; research drafts remain ignored.

### Request-body size versus observed model usage

The comparison above must not hide the larger DSH payload. KodaX OpenAI's
complete JSON request body estimates 20,303, Codex Sol's 17,434, DSH Standard's
23,228 and PTC's 28,097. These exclude HTTP headers. DSH Standard sends 92,788
UTF-8 bytes, PTC 112,269. Within those bodies, session-log values alone estimate
10,700 / 13,147, and plugin package inventories 3,163 / 3,149 respectively.
Those field values have separate JSON-wrapper/rounding costs; they are not an
exact additive token bill. The PTC SDK remains included in system/model fields.

DSH's adapter really merges and posts both extensions
(`llm-deepseek/src/request-extensions.ts:34-42`, `adapter.ts:122-139` under
`packages/llm`). Public client code does not establish backend consumption or
billing. The 9,325 / 11,760 figures describe conventional model fields only;
neither they nor full-body text estimates are observed provider input usage.
The captures used production client paths and isolated mock inference endpoints,
not billable official model responses. Keep full body, conventional model fields
and actual usage as distinct evidence columns in future reports; actual DSH
usage remains unknown. Layer recheck JSON is preserved in the same OS Temp
audit directory as `wire-layer-clarification.json`, with zero new model calls.

## 2026-10-23 broader research: schema loading, not capability removal

Status: **proposed experiments only**. No production visibility, provider,
permission, tool handler, AMA policy or default changed. This extends the narrow
entry audit above; it does not approve those removals or accept a new tool mode.
The six source-pinned capture totals and DSH backend-usage uncertainty above
remain unchanged. Research drafts remain ignored, with necessary reasoning and
acceptance conditions recorded here independently.

### What the additional evidence supports

- Current pi at `58c0b02ce552adab76014e7ed712ab7981359aa8` defaults to
  read/bash/edit/write, without builtin AMA/Plan parity. Its built-in codemode
  and tool_search extensions default inactive. The useful reference is dynamic
  activation recorded in the transcript and lowered per provider, with ordinary
  full-list fallback when unsupported: `packages/agent/src/agent-loop.ts:332`,
  `packages/coding-agent/src/core/agent-session.ts:1748`,
  `packages/ai/src/api/openai-responses-shared.ts:225` and
  `packages/ai/src/api/anthropic-messages.ts:1264` under the local pi
  checkout. Four default tools are not evidence of equivalent KodaX capability.
- [FastMCP tool search](https://gofastmcp.com/servers/transforms/tool-search)
  supports pinned native tools plus search/call proxies through the normal
  authorization pipeline. This supports testing the bridge KodaX already has,
  not adding another tool framework or interpreter.
- [Cloudflare's two Code Mode patterns](https://developers.cloudflare.com/agents/model-context-protocol/codemode/)
  distinguish embedding all typed declarations from searching an external API
  definition. A single code tool can still carry the full SDK in its description.
  Neither fewer tool names nor the large-API savings prove a local coding win.
- [ToolRet](https://arxiv.org/abs/2503.01763v2) and
  [SRA](https://arxiv.org/abs/2604.24594v3) distinguish finding a capability,
  incorporating it and completing the task. Missing retrieval can hurt quality;
  preserved handlers alone do not prove preserved intelligence.
- [Toollery v2, Appendix B.2](https://arxiv.org/html/2609.22218v2) reports no
  billed-input-cost advantage in its natural-cache replay despite much smaller
  model-visible input. Its forced-warm condition excludes paid priming. Cache,
  context size and whole-task cost therefore need independent measurements.
- [Schema-compression research](https://arxiv.org/html/2605.26165v1) mainly
  demonstrates an overflow-budget benefit and does not establish native-wire
  compatibility or general safety of deleting descriptions. Do not replace
  native JSON schemas or strip authorization/default/argument-combination rules
  based on that benchmark.

These are workload-specific papers and implementation references, not a claim
that their gains reproduce on KodaX. No published percentage is substituted for
the current captures. The broader literature review also considered repository
retrieval, white-box tool selection and context assembly; none warrants a new
embedding service, model router, sandbox or context-optimizer framework here.

### Current implementation boundary

KodaX's existing compact descriptions leave the entire input_schema resident.
The managed AMA tool table is assembled once; returning a full contract from
tool_search does not by itself add a new native function next request. Exact
`select:NAME[,NAME...]` already resolves full discoverable contracts, while
keyword search and its no-match inventory only index DEFERRED_TOOL_HINTS;
LSP and other tools outside that set must become discoverable before hiding.
See `tools/tool-search.ts:84`, `:119`, `:132` and
`agent-runtime/tool-resolution.ts:141` under `packages/coding/src`.

A zero-network probe of actual exported SA dispatch and projection functions
confirmed that normal per-call context cloning leaves the WeakMap unlock on the
call context, not the next projection's base context. Direct handler invocation
does unlock that base. Full contracts are still returned, so this does not show
that current tools are unavailable; it disproves treating existing unlock state
as a working end-to-end native-activation mechanism. Both dispatch paths, with
and without progress events, were checked; no provider loop was run. Source
hashes and the probe are in OS Temp `kodax-lazy-boundary-20261023`.

Current child briefing reservation also counts raw full-registry schemas
(`packages/coding/src/child-executor.ts:1269`), so removing model
bytes alone does not prove more usable context. A later activation design must
use a coherent loaded-schema view for wire input, reservation and recovery.
Do not repair unlock by accidentally expanding every subsequent description
and then call that a token reduction.

Provider-native loading is a separate possible lowering, not a generic flag.
[OpenAI tool_search](https://developers.openai.com/api/docs/guides/tools-tool-search)
requires Responses and supports deferred namespaces/functions; flat functions
retain names/descriptions initially. KodaX's OpenAI serializer currently rebuilds
ordinary Chat Completions functions. [Kimi dynamic loading](https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading)
appends complete tools at a message position, with K3 examples; this does not
prove support on the current Kimi Code gateway. The current normalizer coalesces
system messages and cannot preserve that protocol merely by passing an extra
property. [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
has native deferred references, but compatible GLM/Kimi/DeepSeek endpoints are
not thereby proven compatible with that feature. Unknown endpoints keep the
current native behavior until separately verified.

### Quantified research projections

The following use the unchanged, hash-verified OpenAI Host request and the
production heuristic. Each removes full specialized schemas from the native
model menu and appends a compact exact-name/use-case directory plus bridge
instructions to the existing tool_search description. This includes directory
cost, unlike a deletion-only ceiling. All SDK/handlers remain conceptual
execution paths; these projected requests have not been run as a candidate.

| Deferred native schemas | Remaining native | First model-field estimate | Saving including directory | Gap to captured Codex Sol |
| --- | ---: | ---: | ---: | ---: |
| Eight LSP tools | 47 | 19,256 | 1,020 | +2,208 |
| Four detailed repo tools + eight LSP | 43 | 18,642 | 1,634 | +1,594 |
| Other repo/LSP; keep relationship_scan native | 39 | 17,978 | 2,298 | +930 |
| All seventeen repo/LSP tools | 38 | 17,551 | 2,725 | +503 |
| Also memory/history/manual, five entries | 33 | 16,209 | 4,067 | -839 |

The first two are narrower experiment boundaries; 17,978 is a useful second
target to investigate, not a release forecast. The last row may change proactive
memory and recovery behavior and is not recommended for the first candidate.
Descriptions explaining automatic native tool use also need to match a real
candidate; their edits, loaded definitions/results, extra generations, history,
cache invalidation, correctness and latency are not priced in this table.
It is not an actual provider-token, fee or intelligence comparison.

A separate static rare-parameter projection on spawn_agent and
ask_user_question saves only 304 including full-contract discovery hints.
It preserves read_only/scope/isolation, ordinary routing hints, specialist
selection, question defaults and custom-input safety. It still needs native vs
bridge validation and is lower priority than whole specialized schemas. Do not
add these savings to the table without serializing the combined candidate.
DSH-style description truncation of the current three-skill catalog saves zero
at a 500-character per-description limit; this is not a material next lever.

Frozen projections/script and exact names are in OS Temp
`kodax-broad-scenarios-20261023-tlBxDa` and the adjacent
`kodax-broad-scenarios-20261023.mts`. They made zero external model calls.

### Minimal candidate and staged decision

1. **Close offline discovery/execution gaps before changing visibility.** Use the
   full allowed capability inventory for exact and keyword discovery, including
   no-match recovery and bounded results. Keep discovery separate from model
   display and execution authorization; excludeTools must not stand in for a
   display-only change. Audit builtin identity, same-name and run-scoped
   extensions, service activation/revocation, canonical ownership and source
   ordering. Verify native/bridge results, denial feedback, cancellation and
   target work-budget equality; count extra discovery work separately.
2. **One experimental model-view boundary, with existing stable bridge.** Retain
   native file/shell/search, changed scope/diff, questions, Todo, AMA controls,
   relationship_scan and current specialist sets. Test the narrower detailed
   repo/LSP boundary first; keep its original implementations callable through
   tool_search/tool_call. This is deferred access to detailed output, not a
   claim that relationship_scan replaces it. A small catalog names available
   specialized capabilities and supports batch exact discovery. No new public
   mode, action-union router, classifier call or execution sandbox. Broader
   code_search/repo_overview deferral is a later independent decision.
3. **Compare controlled model behavior before free-running smoke.** Freeze the
   real ordered production menu, instructions, model/endpoint and byte hashes;
   do not repeat the historical index-1/index-5 control mismatch. A bounded
   GLM/Kimi Layer 2/3 suite covers tasks requiring no specialized tool, precise
   compiler relationships, detailed context absent from relationship_scan,
   ambiguous/no-match discovery and a refused invocation followed by autonomous
   recovery. Start with two pilot cases: ordinary work without delayed tools,
   and required compiler discovery with denial/recovery. The remaining dimensions
   require separate bounded fixtures after validating the pilot; two cases do
   not certify the whole suite. Do not supply the correct search query as a
   hidden intervention. Proposed initial maximum:
   2 models x 2 arms x 2 cases x 3 choreographed calls
   = 24 provider calls, 600k total tokens, 2,048 output tokens per call, one
   in-flight call per provider. Before any paid run, freeze exact fixtures,
   analysis/rubric, timeout, prices and a spend ceiling including unknown-call
   reserves. Expand only when the pilot is valid and leaves a decision unresolved;
   GLM Flash/DeepSeek Flash can then cover model-specific counterexamples.
4. **Final candidate complex smoke, then an adoption decision.** At most three
   cases per EVAL_GUIDELINES; use zhipu-coding/glm-5.3 and Kimi for real readonly
   child review, refused-tool recovery, file edits, executed tests, evidence
   integration and honest AMA closure. Include a task that actually needs the
   delayed capabilities; the existing small cache fixture cannot certify them.
   Smoke verifies the final chain and is not the A/B comparison. Existing GLM
   r3/Kimi r5 evidence remains current-baseline evidence only.
5. **Only then consider native activation/provider lowering.** Evaluate whether
   stronger per-tool parameter grounding warrants the additional seams: canonical
   loaded state, per-request managed menus, compaction/resume, schema changes,
   permission revocation and provider wire support. Prefer capability-specific
   append-only declarations when verified; do not assume adding tools to a
   conventional top-level list preserves cache. Do not couple this migration to
   a change in AMA planning, dispatch, role policy or reasoning budget.

Report first visible input and full request separately; record first token,
first useful tool result and total wall time. Whole-task accounting includes
root/child/auxiliary attempts, discovered schemas, input/output, cache read/write,
actual available usage and conservative unknown reservations, without counting
cached input twice. Assess semantic task quality, missing capabilities, bad
arguments, extra discovery/repair, report accuracy and cache behavior together.
One additional roughly 18k-context generation can consume many turns of a
2.3k-schema saving; fixed-turn multiplication is not a task forecast.
The decision remains recommend-ship/iterate/revert/eval-invalid with evidence,
not a mechanical pass-rate rule or a blanket claim of intelligence non-inferiority.

### Authorized experiment, 2026-10-23: offline gate and preregistration

The user authorized the twelve-entry experiment after the research above.
Production changes only expand tool_search keyword discovery to the current
allowed registry/run-scoped inventory and bound its no-match directory to
fifteen names with an explicit continuation hint. Exact lookup remains complete.
No default schema hiding, provider-native loading, SDK removal or AMA change is
included. The candidate is a test-only root model-input projection in
`tests/deferred-repo-lsp-support.ts`, using the existing checked bridge.

Offline checks exercise real handlers and registry/lease revocation, matching
native/bridge results and work counts, unchanged input parameters, permission
refusal and recovery, stable candidate menus and public SDK AMA closure.
LSP checks use the existing stdio JSON-RPC fixture; its two empty-result methods
are asserted as empty-result behavior, not successful real-compiler resolution.
Source/test typechecks and package builds pass. Initial targeted coverage was
95.57% statements / 92.85% branches across tool_search and the projection, before
the additional bounded-directory/root-location regressions. Full-repository
coverage and global intelligence non-inferiority are not claimed.

Both review axes identified pre-dispatch fixes: cap the no-match inventory,
restrict raw storage to OS Temp, include the actual benchmark fixture in source
hashes, assert specific LSP outputs, and record streaming/tool/cell timing.
The r1 and r2 preparations made zero paid calls and are retained. Corrected r3
also preserves the previously verified local auxiliary-preflight classification:
only a typed request-build rejection with no physical attempt can return its
reservation. Network failures retain their conservative settlement. The final
18 targeted checks and test typecheck pass. Phase markers prevent restarting a
paid phase.

Fresh public Runtime captures contain 54 root tools; the older 55-tool Full
Host capture additionally contains exit_plan_mode. This is existing Host binding
availability, not another candidate removal. The two actual pilot inputs estimate
20,163 -> 18,580 and 20,330 -> 18,747 with twelve schemas deferred, a net 1,583
each including the candidate directory. These are FrozenInput heuristic counts,
not actual provider usage or a new cross-product capture comparison.

Paid comparison follows Layer 2 first: two aliases, two arms and two frozen
tasks, eight first-response calls. Only after main-session blind semantic review
may at most two further choreographed calls per cell execute scoped readonly
production tools and integrate their actual results. The shared comparison cap
is 24 calls / 600k tokens / USD 0.20 at frozen repository reference rates,
2,048 output tokens per call and 120 seconds per request. It includes all
eight initial calls; a followup does not reset the ledger. No retry or fallback.
Arms share exact Host inputs, tool order and task bytes; candidate only changes
the root tools projection. No model arguments/output are corrected by the eval.

Pilot tasks are ordinary README evidence and detailed module discovery after
a real frozen SDK refusal of an escaped path. This narrows the earlier proposed
compiler-recovery pilot: no real language server is installed in the fixture,
so compiler-semantic performance cannot be established here. All eight LSP
protocols remain covered offline. That gap stays explicit rather than replacing
real compiler evidence with fake successful results in a paid task.

If the comparison supports further validation, two candidate-only complex
smokes use zhipu-coding/glm-5.3 and kimi-code/kimi-for-coding with the actual
Runtime. Each retains the one-readonly-child boundary and the existing cache
task, adding a request for complete cache-module evidence. They verify real
edit/test, denied-tool recovery if observed, child evidence integration,
report accuracy and AMA settlement. Shared cap: 80 calls / 2.4M tokens /
USD 0.25 reference, with per-model 40 calls / 80 tools / 600 seconds, at most
4,096 output tokens per call. At most one in-flight call per provider; different
providers may proceed concurrently. They are two Layer 3.5 cases, not prompt A/B.
Unknown usage retains conservative reservations, including cancelled auxiliary
attempts under the existing settlement contract. Never erase failed samples.

Exact prices, source/helper/dataset hashes, tasks, rubric, raw input snapshots,
blind mapping and phase ledgers are frozen under OS Temp
`kodax-eval-dumps/deferred-repo-lsp-20261023-r3`. A model-visible input reduction
does not establish a bill reduction. Streaming first-output time is a callback
proxy; actual tool durations and split-phase active cell time are recorded,
excluding the human review delay. Every raw response, partial/failed attempt,
cached read/write and unknown reservation remains in the task accounting.
Adoption remains undecided pending semantic review and final candidate evidence.

#### r3 controlled results (2026-10-23)

Manifest SHA-256: `4c8a556b6362a3ae1b124b71c74a8b8709d4ec86efd0a209b471c331f0407289`.
The eight first responses were reviewed with A/B mapping hidden, then the same
raw responses continued under the frozen three-generation ceiling. Followup
review is unblinded; it is not described as another independent blind sample.
N=1 per alias/task/arm. There were 19 physical calls total, 328,934 reported
input+output tokens, no unknown usage, and USD 0.009735205 reference cost.
Cached input is a subset of input, never added a second time. These repository
coding-plan reference prices are not an invoice or measured account deduction.

| Model / task | Calls baseline -> candidate | Reported task tokens | Reference USD | Active seconds |
| --- | --- | --- | --- | --- |
| GLM / README | 2 -> 2 | 36,989 -> 33,948 | 0.001859 -> 0.0017068 | 14.355 -> 18.897 |
| Kimi / README | 2 -> 2 | 34,422 -> 31,896 | 0.00017432 -> 0.00016244 | 7.295 -> 9.520 |
| GLM / module recovery | 3 -> 3 | 55,991 -> 51,375 | 0.0028097 -> 0.00258855 | 20.382 -> 21.507 |
| Kimi / module recovery | 2 -> 3 | 34,573 -> 49,740 | 0.000175525 -> 0.00025887 | 16.615 -> 25.272 |

Active seconds include generation and actual tools, excluding the intervening
human evidence review. GLM module baseline is **censored with a pending read**
at the fixed ceiling, so its row is not an equal-completion cost comparison.
Actual ordinary first inputs were GLM 18,239 -> 16,722 (-1,517) and Kimi
16,892 -> 15,591 (-1,301); their tokenizers differ from FrozenInput estimates.
Neither provider showed a reliable end-to-end latency improvement in this pilot.

All four README answers preserve the TTL=0 and >= boundary contracts without
plans or children. All four module cells autonomously replace the rejected
escaped path with a valid scoped selector and receive the actual same module
capsule. No argument rewriting, tool-result substitution or retry occurred.
The initial concern about target_path-only arguments was resolved by reading
the real contract: both module and target_path are supported optional selectors.

Quality is mixed, not a blanket non-regression pass. Kimi baseline reports
Tests/Docs as none without integrating the supplied root evidence. Candidate
spends an extra generation obtaining real grep evidence for tests/docs/reexports,
but calls a legacy copy word-for-word identical without reading it. GLM candidate
finishes, yet simplifies the buggy TTL truthiness expression into normal expiry
behavior. Kimi candidate README adds an unnecessary ambiguity note. These are
report-grounding limitations, not evidence that permission or execution ability
was removed; finite samples cannot attribute them confidently to the projection.

The recovery history already names module_context, and all model cells bypassed
tool_search. Thus these paid samples establish bridge recovery, **not independent
discovery reliability**. Keyword/exact discovery and permission revocation remain
offline evidence only. Real compiler semantics are still untested. The captured
production input also repeats overview/change-scope context; it was kept byte-for-
byte in both arms and is a separate future deduplication investigation.

Main-session recommendation is **recommend-iterate**, retaining defaults. Two
candidate-only final Runtime smokes are authorized within the frozen budget to
check real edits, tests, child evidence and AMA closure; they cannot turn this
small mixed comparison into a proof of general intelligence non-inferiority.

#### r3 final candidate smoke and decision

Both final candidate Runtime tasks completed without human intervention, argument
rewrites or reruns. Each used one inherited-model readonly child, integrated its
actual report, obtained module_context through the existing bridge, edited only
the three intended implementation files plus a new regression test, ran tests
and reached AMA completed. Root native menus stayed at 42; child menus retained
44 tools including the twelve Repo/LSP entries. Auxiliary menus were unchanged.
The protected README/manifests/reexports/examples/old tests and original comment
were preserved. No model happened to propose a refused tool in these two free
smokes: autonomous recovery evidence is the controlled real-SDK-refusal pair and
offline Runtime checks, not a claimed spontaneous denial in these smokes.

| Candidate smoke | Physical calls | Known input / output (cache read subset) | Conservative task tokens | Reference USD | Wall seconds | Public / independent checks |
| --- | --- | --- | --- | --- | --- | --- |
| GLM-5.3 | 12 (8 root, 3 child, 1 auxiliary) | 200,862 / 4,866 (173,824) | 216,291 | 0.01110905 | 148.668 | 11/11 and 6/6 |
| Kimi for Coding | 19 (14 root, 4 child, 1 auxiliary) | 402,652 / 11,309 (362,240) | 413,961 | 0.002182895 | 251.677 | 10/10 and 6/6 |

GLM's cancelled auxiliary attempt has unknown usage: its complete 10,563-token
reservation and USD 0.00057935 reference reservation remain charged; the other
11 calls report 205,728 tokens. This is normal bounded auxiliary cancellation
under the existing contract, not a transport retry or a zero-cost request.
There are no unsettled reservations. Kimi's first self-authored failure-retry
test contained an invalid expectation for an already-successful loader; the
model removed that assertion and continued itself. The final independent oracle
still covers failure release/retry, so removing it did not conceal a code defect.
Final reports correctly identify the TTL, identity and in-flight fixes, executed
test counts, module output limitations and protected scope. Readonly children
completed, and no child mutation was executed. No overall intelligence claim
or comparative E2E speedup is inferred from two successful smoke samples.

Zero-network counterfactual checks copied the final new tests to separate Temp
fixtures, then restored original identity, TTL or in-flight implementation one
at a time: all six single-fault checks fail as expected; both all-original
fixtures also fail. The original model workspaces/raw were left unchanged.
Thus these tests detect the actual repaired defects, beyond merely passing the
final implementation. Source hashes remained frozen throughout paid phases.

Experiment total: **50 physical calls**, 948,623 reported tokens plus the
10,563 unknown reservation = **959,186 conservative tokens**, **USD 0.02302715
reference**, one unknown attempt, no retry/fallback. Adding the preregistered
historical record yields 753 calls / 15,137,708 conservative tokens /
USD 0.6969207158 reference / 28 unknown attempts; historical limitations stay
unchanged. Prices are not real billing observations.

**Decision: recommend-iterate; default remains full native.** Keep the bounded
tool_search discovery fix and executable regressions; keep twelve-entry hiding
only in the manual experiment. Ordinary token savings and successful complex
smokes support feasibility, but extra-turn cost, mixed report grounding,
discovery priming and absent real-compiler evaluation prevent default adoption.
Next prefer auditing the observed identical overview/change-scope duplication
without changing capability menus; any future delayed-mode revision should
separate detailed Repo and LSP subsets and test unprimed capability discovery
with a real installed language server. These are proposals, not implemented
defaults or authorization to expand this completed experiment.

### Follow-on context fix and mode audit (2026-10-23)

After the r3 model experiment, the user authorized the next source audit.
The first actual SDK input regression reproduced duplicate automatic overview
and change-scope sections. The middleware now prefers the current baseline
over the same baseline in a cached preturn bundle, with the bundle retained
as failure fallback; caller content and active semantic evidence are untouched.
The removed historical fragment estimates about 405 tokens. A fresh offline
capture is 19,732 native / 19,192 Repo-only deferred / 18,756 LSP-only deferred /
18,149 all-twelve deferred, with 54/50/46/42 native entries respectively.
These estimates are not new provider usage; path/time differences prevent
attributing the whole old/new capture delta to deduplication. The old r3 all-
twelve projections remain byte-identical for both frozen inputs. r3 model
results remain pre-fix evidence rather than a claimed new final-model run.

The split candidates are test-only. Both narrowed subsets retain actual
bridge/discovery, denial/recovery and Runtime closure regressions. No paid
request, default switch, capability removal or generic JS runtime was added.
Source facts, the distinction between preset/role selection and Code Mode/PTC,
and the remaining discovery/compiler/budget gates are recorded self-contained
in [tool injection modes](tool-injection-modes.md); ignored research drafts
are not a dependency of this decision record.
