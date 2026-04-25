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
 * Persisted artifact shape (one JSON file per name/version under
 * `.kodax/constructed/<kind>/<name>/<version>.json`).
 *
 * v0.7.28 only emits `kind: 'tool'`. The `kind` union is intentionally
 * narrow now; FEATURE_089 / FEATURE_090 will widen it.
 */
export interface ConstructionArtifact {
  readonly kind: 'tool';
  readonly name: string;
  readonly version: string;
  readonly content: ToolContent;
  status: ArtifactStatus;
  readonly signedBy?: string;
  readonly createdAt: number;
  readonly sourceAgent?: string;
  testedAt?: number;
  activatedAt?: number;
  revokedAt?: number;
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
