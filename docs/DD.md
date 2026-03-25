# KodaX Detailed Design

> Last updated: 2026-03-25
>
> This document defines the target internal model for the architecture shift carried by `FEATURE_022`: the adaptive task engine, native multi-agent control plane, and runtime substrate.

---

## 1. Scope

This document covers:

- task-first persistence
- intent classification and harness routing
- native multi-agent role boundaries
- evidence-driven completion
- provider-aware harness policy
- the boundary between the new control plane and `FEATURE_034`

This document does not define:

- full UI behavior for every surface
- every built-in command syntax
- implementation details for every future capability package

---

## 2. Core Domain Model

### 2.1 Task envelope

Every incoming request that survives intake becomes a normalized task envelope.

```ts
type TaskKind =
  | "answer"
  | "read"
  | "review"
  | "edit"
  | "bugfix"
  | "refactor"
  | "research"
  | "design"
  | "long_running";

type ComplexityBand = "L0" | "L1" | "L2" | "L3";

type ChangeIntent =
  | "read_only"
  | "append"
  | "overwrite"
  | "new_task"
  | "unknown";

interface TaskEnvelope {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string | null;
  executionCwd: string | null;
  sourceSurface: "cli" | "repl" | "acp" | "other";
  rawRequest: string;
  normalizedRequest: string;
  kind: TaskKind;
  complexity: ComplexityBand;
  changeIntent: ChangeIntent;
  needsBrainstorm: boolean;
  needsDurableState: boolean;
  requestedByUser: {
    sessionId?: string;
    actor?: string;
  };
}
```

### 2.2 Harness profile

```ts
type HarnessProfile =
  | "H0_DIRECT"
  | "H1_EXECUTE_EVAL"
  | "H2_PLAN_EXECUTE_EVAL"
  | "H3_MULTI_WORKER";

interface HarnessSelection {
  profile: HarnessProfile;
  reasonCodes: string[];
  providerPolicy: ProviderPolicySnapshot;
  escalationAllowed: boolean;
}
```

### 2.3 Role model

```ts
type AgentRole =
  | "lead"
  | "planner"
  | "generator"
  | "evaluator"
  | "worker_research"
  | "worker_test"
  | "worker_refactor"
  | "worker_ui";

interface RoleAssignment {
  role: AgentRole;
  instanceId: string;
  modelRef?: string;
  providerRef?: string;
  ownership?: {
    files?: string[];
    modules?: string[];
    taskSlice?: string;
  };
  status: "pending" | "active" | "completed" | "failed";
}
```

### 2.4 Contract model

The contract is the task-local source of truth.

```ts
interface TaskContract {
  taskId: string;
  version: number;
  goal: string;
  scope: string[];
  outOfScope: string[];
  assumptions: string[];
  constraints: string[];
  changeIntent: ChangeIntent;
  successCriteria: ContractCriterion[];
  requiredEvidence: EvidenceRequirement[];
  approvalNeeded?: string[];
  createdBy: "lead" | "planner";
  createdAt: string;
}

interface ContractCriterion {
  id: string;
  label: string;
  kind: "behavior" | "code" | "test" | "design" | "integration";
  severity: "must" | "should";
}

interface EvidenceRequirement {
  id: string;
  type: "deterministic_check" | "artifact" | "test" | "review" | "behavioral";
  label: string;
  required: boolean;
}
```

### 2.5 Evidence model

```ts
type EvidenceVerdict = "pass" | "fail" | "warning" | "unknown";

interface EvidenceBlock {
  id: string;
  taskId: string;
  source:
    | "generator"
    | "evaluator"
    | "tool"
    | "test"
    | "search"
    | "review"
    | "human";
  category:
    | "code_change"
    | "deterministic_check"
    | "behavioral_check"
    | "contract_review"
    | "artifact"
    | "research";
  summary: string;
  detailsRef?: string;
  verdict: EvidenceVerdict;
  timestamp: string;
}
```

### 2.6 Decision model

```ts
type TaskDecisionType =
  | "intake"
  | "routing"
  | "contract"
  | "assignment"
  | "retry"
  | "escalation"
  | "completion"
  | "blocked";

interface TaskDecision {
  id: string;
  taskId: string;
  type: TaskDecisionType;
  actor: "lead" | "planner" | "evaluator" | "system";
  summary: string;
  reasonCodes: string[];
  timestamp: string;
}
```

### 2.7 Session tree and checkpoints

`FEATURE_019` expands the old session model into task-aware lineage.

```ts
interface SessionNode {
  id: string;
  taskId: string;
  parentId: string | null;
  role: AgentRole;
  summary: string;
  messageRef: string;
  createdAt: string;
}

interface TaskCheckpoint {
  id: string;
  taskId: string;
  label?: string;
  sessionNodeId?: string;
  artifactRefs: string[];
  createdAt: string;
}
```

---

## 3. Storage Layout

### 3.1 Canonical layout

```text
.agent/
  tasks/
    <task-id>/
      task.json
      intake.json
      contract.json
      plan.md
      role-assignments.json
      decisions.jsonl
      evidence/
        index.jsonl
        *.json
      runs/
        *.json
      checkpoints/
        index.jsonl
      session-tree/
        nodes.jsonl
      artifacts/
        *.md
        *.json
```

### 3.2 File responsibilities

| File | Purpose |
|---|---|
| `task.json` | task envelope and high-level status |
| `intake.json` | raw intake reasoning and routing input |
| `contract.json` | active contract |
| `plan.md` | human-readable execution plan |
| `role-assignments.json` | active role assignments |
| `decisions.jsonl` | append-only decision log |
| `evidence/index.jsonl` | append-only evidence index |
| `runs/*.json` | per-run orchestration trace |
| `checkpoints/index.jsonl` | rewindable checkpoints |
| `session-tree/nodes.jsonl` | multi-role conversation lineage |

### 3.3 Backward compatibility

During migration, the engine may read from:

- `feature_list.json`
- `PROGRESS.md`
- `.agent/project/`

But new truth should be written under `.agent/tasks/<task-id>/`.

---

## 4. Intake and Routing Pipeline

### 4.1 Intake phases

1. Normalize request text.
2. Capture workspace and session context.
3. Classify task kind.
4. Estimate complexity.
5. Infer read-only vs append vs overwrite.
6. Decide whether brainstorm is required.
7. Decide whether durable state is required.
8. Select harness profile.

### 4.2 Complexity heuristics

Routing should use simple, inspectable heuristics first:

- user asks for edits or file changes
- request spans multiple modules
- existing project state exists
- request is ambiguous or architectural
- verification cost is non-trivial
- provider capability is weak for requested behavior

Example policy:

- read-only explanation -> `L0`
- small explicit file change -> `L1`
- medium request with design uncertainty -> `L2`
- long-running or cross-module delivery -> `L3`

### 4.3 Append vs overwrite inference

Inputs:

- explicit user language
- existing task state
- current repo status
- current task contract

Rules:

- destructive overwrite must be surfaced clearly
- inference may be automatic
- dangerous state transitions still require confirmation

### 4.4 Brainstorm trigger policy

Brainstorm should be auto-triggered when:

- the user states an outcome, not an implementation
- there are multiple plausible architectural directions
- a large request lacks acceptance criteria
- overwrite vs append is unclear

This replaces the old assumption that brainstorm is only entered through `/project brainstorm`.

---

## 5. Control Plane

### 5.1 Lead loop

The Lead owns orchestration:

```ts
while (!taskDone) {
  if (!contract) buildContract();
  assignRoles();
  collectOutputs();
  evaluateEvidence();
  if (needsRetry) refineAndRetry();
  if (needsEscalation) escalateHarness();
  if (verdictReached) break;
}
```

Lead responsibilities:

- own task status
- preserve invariants
- decide retries and escalation
- prevent the generator from self-certifying completion

### 5.2 Planner flow

Planner outputs:

- scope
- assumptions
- decomposition
- success criteria
- proposed evidence requirements

The Planner should not dominate execution after handoff unless the Lead requests replanning.

### 5.3 Generator flow

Generator outputs:

- code changes
- artifact changes
- implementation notes
- self-reported claims

These claims are advisory only until evaluated.

### 5.4 Evaluator flow

Evaluator inputs:

- current contract
- generator outputs
- deterministic check outputs
- evidence index

Evaluator outputs:

- verdict per criterion
- missing evidence list
- retry guidance
- blocked reasons

### 5.5 Multi-worker flow

`H3_MULTI_WORKER` may create specialized workers with bounded ownership.

Rules:

- each worker needs a clear slice
- overlapping write sets should be avoided
- synthesis remains centralized
- evaluator remains independent of generators

---

## 6. Evidence-Driven Completion

### 6.1 Completion rule

A task is complete only when:

1. contract criteria are satisfied
2. required evidence exists
3. evaluator verdict is sufficiently positive
4. no blocking risk remains unacknowledged

### 6.2 Evidence classes

Recommended minimum classes:

- deterministic checks
- test results
- code-diff or artifact references
- behavioral verification where available
- explicit evaluator review summary

### 6.3 Verdict record

```ts
interface CompletionVerdict {
  taskId: string;
  status: "complete" | "blocked" | "needs_retry";
  satisfiedCriteria: string[];
  failedCriteria: string[];
  missingEvidence: string[];
  summary: string;
  decidedAt: string;
}
```

This verdict should be persisted, not inferred from chat text.

---

## 7. Provider-Aware Harness Policy

### 7.1 Provider policy snapshot

```ts
interface ProviderPolicySnapshot {
  provider: string;
  model?: string;
  provenance: "native" | "bridge";
  supportsThinkingControl: boolean;
  supportsToolCalling: boolean;
  supportsMultimodalInput: boolean;
  contextReliability: "high" | "medium" | "low";
  orchestrationWarnings: string[];
}
```

### 7.2 Routing impact

Examples:

- low tool reliability may require stronger evaluation
- bridge-backed providers may disable some harness shapes
- weak context fidelity may force smaller worker scopes
- no multimodal support blocks image-centric evaluation

### 7.3 Why this matters

KodaX must stop pretending native and bridge providers are interchangeable when they are not.

---

## 8. Boundary with FEATURE_034

This boundary is critical.

### 8.1 What `FEATURE_034` owns

`FEATURE_034` is the runtime substrate. It owns:

- extension loading
- capability registration
- tool override semantics
- diagnostics and provenance
- structured capability results
- host-neutral runtime participation

### 8.2 What `FEATURE_034` does not own

It does not own:

- task decomposition
- role policy
- harness selection
- evaluator authority
- cross-agent completion semantics
- long-running task truth model

### 8.3 Relationship to other features

| Feature | Owns |
|---|---|
| `019` | session tree, checkpoints, lineage |
| `022` | native multi-agent control plane |
| `025` | task intelligence and harness routing |
| `034` | extension and capability runtime |
| `035` | MCP capability provider |
| `038` | official sandbox extension |

If `034` starts absorbing orchestration or task semantics, the architecture becomes muddled again.

---

## 9. Compatibility Surface

### 9.1 `/project`

`/project` becomes a facade over managed tasks:

- create or continue task
- inspect plan
- inspect evidence
- trigger verify
- pause, resume, or override routing

### 9.2 `--init`

`--init` becomes a convenience way to create a task envelope with durable state enabled.

### 9.3 `--auto-continue`

`--auto-continue` becomes a non-REPL task runner over the same task engine.

### 9.4 `--team`

`--team` should be downgraded to one of:

- compatibility alias
- hidden debug entry point
- explicit deprecation path

It should no longer define the product story for multi-agent work.

---

## 10. Integration with Current Codebase

### 10.1 Existing components to preserve

Current strengths should be reused:

- prompt builder and long-running prompt rules
- orchestration runtime primitives
- project harness verifier patterns
- `.agent/project/` persistence ideas

### 10.2 Expected migration targets

| Current component | Future role |
|---|---|
| long-running prompt injection | hint layer for `H2` and `H3` |
| project storage | source material for task store migration |
| orchestration runtime | substrate for `FEATURE_022` |
| `/project` commands | control surface facade |
| project harness | evidence and evaluation seed |

---

## 11. Implementation Priorities

1. Establish task-first persistence.
2. Establish harness router and control-plane skeleton.
3. Add role separation and evaluator authority.
4. Migrate `/project` and auto-continue flows onto the new engine.
5. Retire `--team` as a product concept.
6. Expand knowledge, retrieval, sandbox, and multi-surface features on top.

---

## 12. References

- [ADR](ADR.md)
- [HLD](HLD.md)
- [PRD](PRD.md)
- [Feature Roadmap](features/README.md)

---

## Appendix A: Current Runtime Reference

This appendix retains compact current-state details that are still useful while migrating toward the target design.

### A.1 Current core runtime concepts

Current KodaX still revolves around a few existing primitives:

- `KodaXMessage`
- `KodaXToolDefinition`
- `KodaXOptions`
- `PermissionMode`
- `KodaXEvents`

These are part of the migration surface even if the target design introduces richer task-engine models.

### A.2 Current provider model

The current provider layer still follows:

- abstract provider base
- registry-based lookup
- provider-specific stream implementations
- mixed native and bridge-backed providers

This matters because `FEATURE_029` and `FEATURE_022` build on top of it rather than replacing it wholesale.

### A.3 Current tool model

The current tool layer still relies on:

- a centralized registry
- named tool handlers
- built-in tool schemas
- host-mediated confirmation and permission behavior

`FEATURE_034` evolves this into a stronger capability/runtime model, but implementation work must still account for the existing registry and built-in tools.

### A.4 Current host callback model

The current system already exposes host-driven lifecycle behavior through callback/event-style interfaces such as:

- streaming deltas
- tool start/result notifications
- completion/error notifications
- confirmation hooks
- before-tool-execute style checks

This matters because the target extension/runtime model should separate host callbacks from extension hooks without losing existing host integration behavior.

---

## Appendix B: Restored Current Runtime Design Notes

This appendix restores concrete current-state design material from the earlier DD so migration work keeps a clear picture of the runtime that exists today.

### B.1 Current core types retained

Representative current runtime concepts still include:

```ts
type PermissionMode =
  | "plan"
  | "default"
  | "accept-edits"
  | "auto-in-project";

interface KodaXOptions {
  provider: string;
  thinking?: boolean;
  maxIter?: number;
  parallel?: boolean;
  auto?: boolean;
  mode?: PermissionMode;
}
```

Other important current concepts retained from the earlier DD:

- `KodaXMessage`
- `KodaXContentBlock`
- `KodaXToolDefinition`
- `KodaXEvents`
- `KodaXResult`

These remain part of the migration surface even if the target architecture adds `TaskEnvelope`, `TaskContract`, and `EvidenceBlock`.

### B.2 Current event system retained

The earlier DD recorded an event/callback model that is still useful implementation reference:

- `onTextDelta`
- `onThinkingDelta`
- `onThinkingEnd`
- `onToolUseStart`
- `onToolResult`
- `onToolInputDelta`
- `onStreamEnd`
- `onSessionStart`
- `onIterationStart`
- `onCompact`
- `onRetry`
- `onComplete`
- `onError`
- `onConfirm`
- `beforeToolExecute`

This matters because host callbacks already exist and should be preserved while extension hooks evolve separately.

### B.3 Current provider system retained

The previous DD contained concrete provider-shape notes that still apply:

```ts
abstract class KodaXBaseProvider {
  abstract stream(
    messages: unknown[],
    tools: unknown[],
    system: string,
    thinking?: boolean,
    streamOptions?: unknown
  ): Promise<unknown>;
}

const PROVIDER_REGISTRY = new Map<string, () => KodaXBaseProvider>();
```

Still-useful properties of the current provider system:

- registry-based lookup
- per-provider capability differences
- mixed native and bridge-backed implementations
- provider-specific environment and error handling

### B.4 Current tool system retained

The earlier DD also captured the current tool model:

```ts
type ToolHandler = (
  input: Record<string, unknown>,
  context: unknown
) => Promise<string>;

const TOOL_REGISTRY = new Map<string, ToolHandler>();
```

Current built-in tool family still includes:

- `read`
- `write`
- `edit`
- `bash`
- `glob`
- `grep`
- `undo`
- `diff`
- `ask-user`

This tool registry remains the substrate that `FEATURE_034` evolves into a broader capability runtime.

### B.5 Current agent-loop notes retained

The older DD recorded a useful simplified shape of the current loop:

1. resolve provider and options
2. resolve or load session state
3. append the user message
4. stream model output
5. build assistant content blocks
6. inspect control signals
7. execute tool calls
8. append tool results and continue
9. persist session state and return result

Important current details retained:

- default max iterations around `200`
- compaction before or during long runs
- signal parsing from assistant output
- tool execution woven into the same loop

### B.6 Promise-signal notes retained

The current long-running system still relies on explicit completion/control signals such as:

- `COMPLETE`
- `BLOCKED`
- `DECIDE`

The exact representation may evolve, but this history still matters because managed execution already contains a notion of structured control beyond plain chat text.

### B.7 Permission-system notes retained

Still-useful current-state details:

- `plan` blocks mutation
- `default` asks for confirmation on risky mutation and shell behavior
- `accept-edits` removes most edit confirmations but still treats shell more carefully
- `auto-in-project` enables stronger automation within project boundaries

The earlier DD also preserved pattern-based permission ideas and protected-path handling. Those remain relevant to future sandbox integration and approval UX.

### B.8 Skills-system notes retained

The previous DD recorded baseline skill behavior that should remain visible:

- discovery from user and project skill directories
- markdown-first skill format
- natural-language triggering rather than command-only invocation
- coexistence of built-in and custom skills

### B.9 Project and managed-workflow notes retained

Before the task-engine reframing, the DD already described long-running project workflows such as:

- `/project init`
- `/project status`
- `/project next`
- `/project auto`
- `/project edit`
- `/project reset`
- `/project analyze`

Those flows are no longer the permanent top-level abstraction, but they remain crucial migration input because:

- they already define durable artifacts
- they already encode long-running workflow expectations
- they already contain the strongest existing verification semantics

### B.10 REPL and UI notes retained

Useful current-state details from the earlier DD remain:

- Ink-based component structure
- command-driven REPL interaction
- autocomplete across multiple sources
- history review and waiting/input distinctions
- theme and status rendering concerns

These continue to matter for `FEATURE_023`.
