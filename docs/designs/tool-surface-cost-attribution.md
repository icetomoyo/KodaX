# Tool surface cost attribution

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
