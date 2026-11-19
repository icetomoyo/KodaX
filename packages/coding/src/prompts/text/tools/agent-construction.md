<!-- @key t12i.tools/agent-construction.block.0 trail="\n" -->
Scaffolded agent manifest (fill TODO sections, then call validate_agent):

Manifest schema notes:
  - instructions: string (required) — the agent's system-prompt body.
  - tools: ToolRef[] — refs like { ref: "builtin:read" } or { ref: "constructed:foo@1.0.0" }.
  - handoffs: AgentHandoffRef[] — { target: { ref }, kind: "continuation"|"as-tool" }.
  - reasoning: { default, max? } — native effort strings, e.g. medium/high; explicit specialist policy.
  - guardrails: GuardrailRef[] — { kind: "input"|"output"|"tool", ref }.
  - maxBudget: number — clamped against systemCap.maxBudget at admission.
  - declaredInvariants: string[] — voluntary invariants (e.g. ["harnessSelectionTiming"]).
  - testCases: AgentTestCase[] — { id, input, expectMatch?|expectNotMatch?|expectFinalText? }.
