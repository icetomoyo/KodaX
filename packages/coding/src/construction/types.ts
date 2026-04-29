/**
 * KodaX Constructed-World types (FEATURE_087, v0.7.28).
 *
 * Runtime-generated capabilities (tools / agents / skills / ...) live in
 * `.kodax/constructed/` and are loaded into the same registries as builtin
 * primitives. v0.7.28 only ships tool generation (FEATURE_088); other kinds
 * land in FEATURE_089 / FEATURE_090.
 *
 * Cross-references:
 *   - DD §14 — lifecycle, security model, registry merge semantics.
 *   - docs/features/v0.7.28.md — capability schema, generation flow.
 */

/**
 * Handler script source. v0.7.28 limits language to `'javascript'` so that
 * `loadHandler()` can `await import()` the file directly without an
 * intermediate TS → JS compile step (no esbuild / tsx dependency).
 *
 * TypeScript handlers are explicitly out of scope; Coding Agent generates
 * JS strings on the wire.
 */
export interface ScriptSource {
  readonly kind: 'script';
  readonly language: 'javascript';
  readonly code: string;
}

/**
 * Capability declaration.
 *
 * v0.7.28 ships the single-dimension form: a whitelist of builtin tool
 * names that the handler may invoke through `ctx.tools.<name>(...)`.
 * All I/O — fs / net / env — must flow through builtin tools (`read` /
 * `write` / `bash` / etc.); handlers do not receive direct `ctx.fs` /
 * `ctx.net` / `ctx.env` entry points.
 *
 * Forward-compatible evolution: if the future demands path/domain-level
 * constraints, this can grow to `(string | { name; constraints })[]`
 * without breaking existing manifests.
 */
export interface Capabilities {
  readonly tools: readonly string[];
}

/**
 * Tool-kind artifact body (the `content` of `ConstructionArtifact` when
 * `kind === 'tool'`).
 */
export interface ToolContent {
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly capabilities: Capabilities;
  readonly handler: ScriptSource;
  /**
   * Per-tool timeout override. Defaults to {@link DEFAULT_HANDLER_TIMEOUT_MS}
   * when omitted. Bounded by AbortController in `loadHandler()`.
   */
  readonly timeoutMs?: number;
}

/**
 * Default handler timeout. Picked to match the historical ceiling on
 * builtin streaming tools (30s); revisit if a constructed tool demands
 * longer-running computation.
 */
export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/**
 * Lifecycle state on disk. Drives both the startup glob filter and the
 * `revoke()` semantics. See DD §14.1 — file system is the single source
 * of truth; no separate `_manifest.json` index file (C4 decision).
 */
export type ArtifactStatus = 'staged' | 'active' | 'revoked';

/**
 * Reference to a tool by stable id. v0.7.31 (FEATURE_089) introduces
 * Agent manifests that bundle tool refs rather than inline tool bodies;
 * the resolver expands these refs to concrete `KodaXToolDefinition`
 * instances at activate time.
 *
 * `ref` shape:
 *   - `builtin:<name>`            — a tool from the static registry
 *     (e.g. `builtin:read`, `builtin:bash`)
 *   - `constructed:<name>@<ver>`  — a previously-activated constructed tool
 */
export interface ToolRef {
  readonly ref: string;
}

/**
 * Reference to a Guardrail by stable id. The Layer A `Guardrail`
 * declaration is name-only (no runtime hooks); resolvers map known
 * names to constructed `ToolGuardrail` / `InputGuardrail` /
 * `OutputGuardrail` instances at activation time.
 */
export interface GuardrailRef {
  readonly kind: 'input' | 'output' | 'tool';
  readonly ref: string;
}

/**
 * Reference to a handoff target by stable id (another constructed agent
 * or a builtin role). The resolver expands `target.ref` to the actual
 * `Agent` declaration at admission time so the handoff DAG check
 * (`handoffLegality` invariant) sees the full graph.
 */
export interface AgentHandoffRef {
  readonly target: { readonly ref: string };
  readonly kind: 'continuation' | 'as-tool';
  readonly description?: string;
}

/**
 * Reasoning profile declaration mirroring the Layer A
 * `AgentReasoningProfile`. Kept structurally identical so the resolver
 * passes the value through without re-shaping.
 */
export interface AgentReasoningRef {
  readonly default: 'quick' | 'balanced' | 'deep';
  readonly max?: 'quick' | 'balanced' | 'deep';
  readonly escalateOnRevise?: boolean;
}

/**
 * Sandbox test case. Used by `sandbox_test_agent` to verify a
 * constructed agent before it can activate. Each case feeds `input`
 * to a sandbox Runner instance and grades the agent's final output:
 *
 *   - `expectMatch`     — final text must match this regex (string form)
 *   - `expectNotMatch`  — final text must NOT match this regex
 *   - `expectFinalText` — exact substring match (case-sensitive)
 *
 * At least one of the three expect-fields must be present; the cases
 * are graded by `runSandboxAgentTest()` (FEATURE_089 Phase 3.5).
 */
export interface AgentTestCase {
  readonly id: string;
  readonly input: string;
  readonly expectMatch?: string;
  readonly expectNotMatch?: string;
  readonly expectFinalText?: string;
}

/**
 * Agent-kind artifact body (the `content` of `ConstructionArtifact`
 * when `kind === 'agent'`).
 *
 * FEATURE_089 (v0.7.31): all fields except `instructions` are optional;
 * a minimal "echo agent" can be expressed as `{ instructions: '...' }`.
 * Tool / handoff / guardrail refs are resolved at admission time
 * (Runner.admit's 5-step audit expands them and feeds the resolved
 * Agent through the invariant chain).
 */
export interface AgentContent {
  readonly instructions: string;
  readonly tools?: readonly ToolRef[];
  readonly handoffs?: readonly AgentHandoffRef[];
  readonly reasoning?: AgentReasoningRef;
  readonly guardrails?: readonly GuardrailRef[];
  readonly model?: string;
  readonly provider?: string;
  /**
   * Optional structured-output schema mirroring `Agent.outputSchema`.
   * Pure pass-through to the runtime — admission does not validate
   * shape semantics here, only well-formed JSON.
   */
  readonly outputSchema?: Record<string, unknown>;
  /**
   * Optional sandbox test cases. When present, `sandbox_test_agent`
   * runs them; when absent, the test step performs only the static
   * checks (manifest schema + admission audit).
   */
  readonly testCases?: readonly AgentTestCase[];
  /**
   * Maximum total budget (iteration count) the agent may consume.
   * Plumbed onto the resolved `AgentManifest.maxBudget` and clamped by
   * `budgetCeiling` invariant during admission.
   */
  readonly maxBudget?: number;
  /**
   * Voluntary additional invariants the LLM declares this agent
   * commits to. Plumbed onto `AgentManifest.declaredInvariants`;
   * unioned on top of the required set during admission.
   */
  readonly declaredInvariants?: readonly string[];
}

/**
 * Persisted artifact shape (one JSON file per name/version under
 * `.kodax/constructed/<kind>s/<name>/<version>.json`).
 *
 * Discriminated union over `kind`:
 *   - `kind: 'tool'`  — v0.7.28 (FEATURE_088) tool generation
 *   - `kind: 'agent'` — v0.7.31 (FEATURE_089) agent generation; passes
 *                       through `Runner.admit()` at activation time
 *
 * Lifecycle fields (status / timestamps / contentHash / sourceAgent /
 * signedBy) are common to all kinds.
 */
export type ConstructionArtifact = ToolArtifact | AgentArtifact;

interface ConstructionArtifactBase {
  readonly name: string;
  readonly version: string;
  status: ArtifactStatus;
  readonly signedBy?: string;
  readonly createdAt: number;
  readonly sourceAgent?: string;
  testedAt?: number;
  activatedAt?: number;
  revokedAt?: number;
  /**
   * SHA-256 of `JSON.stringify(content)` captured at activate time.
   * `rehydrateActiveArtifacts()` recomputes and compares — a mismatch
   * indicates the manifest was edited between activation and the next
   * boot (naive cross-session tampering, e.g. an LLM rewriting the .json
   * via the Write tool without recomputing the hash). Mismatched
   * artifacts are skipped at rehydrate with a stderr warning. This is
   * NOT a defense against a coordinated attacker who recomputes the
   * hash; the threat model is single-user CLI integrity, not multi-user
   * supply chain.
   */
  contentHash?: string;
}

export interface ToolArtifact extends ConstructionArtifactBase {
  readonly kind: 'tool';
  readonly content: ToolContent;
}

export interface AgentArtifact extends ConstructionArtifactBase {
  readonly kind: 'agent';
  readonly content: AgentContent;
}

/**
 * Returned by {@link ConstructionRuntime.stage}; opaque handle that
 * downstream `test()` / `activate()` calls bind to.
 */
export interface StagedHandle {
  readonly artifact: ConstructionArtifact;
  readonly stagedAt: number;
}

/**
 * Outcome of {@link ConstructionRuntime.test}. `ok=false` blocks
 * activation; `warnings` surface but do not block.
 */
export interface TestResult {
  readonly ok: boolean;
  readonly errors?: readonly string[];
  readonly warnings?: readonly string[];
}

/**
 * Policy gate — invoked once per `activate()` before the artifact is
 * registered. Default rejects implicit auto-approval; the REPL surface
 * binds a dialog-based policy in `packages/repl/src/common/construction-
 * bootstrap.ts` so user approval flows through the live askUser channel.
 *
 * Modeled as a function type rather than an interface (D3 decision):
 * keeps the contract surface tiny, no class boilerplate.
 *
 * No declarative `kodax.config.ts` override hatch is provided — see the
 * "Deferred Design Decisions" section in `features/v0.7.28.md` for why
 * a `risk_mode` enum (when truly needed) is preferred over user-authored
 * policy functions.
 */
export type ConstructionPolicy = (
  artifact: ConstructionArtifact,
) => Promise<ConstructionPolicyVerdict>;

export type ConstructionPolicyVerdict = 'approve' | 'reject' | 'ask-user';

/** Default policy: always ask the user; no implicit approvals. */
export const defaultPolicy: ConstructionPolicy = async () => 'ask-user';

/**
 * Thrown by `CtxProxy` when handler attempts to access a tool not declared
 * in `capabilities.tools`. Caught in tracer; surfaces as a tool error.
 */
export class CapabilityDeniedError extends Error {
  readonly toolName: string;
  readonly declaredTools: readonly string[];

  constructor(toolName: string, declaredTools: readonly string[]) {
    super(
      `Constructed handler attempted to call '${toolName}' but capabilities.tools only declares [${declaredTools.join(', ') || '<empty>'}]`,
    );
    this.name = 'CapabilityDeniedError';
    this.toolName = toolName;
    this.declaredTools = declaredTools;
  }
}

/**
 * Thrown when a manifest cannot be parsed / is missing required fields.
 * Surfaces during stage() / startup glob; tracer records details.
 */
export class ConstructionManifestError extends Error {
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'ConstructionManifestError';
    this.path = path;
  }
}
