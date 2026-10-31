/** Pure profile, verification and visibility contracts shared with Product clients. */
import type { ToolSideEffect } from './tools/side-effect.js';

/** Last assembled execution surface. Visibility does not grant effect permission. */
export interface KodaXEffectiveTaskConfig {
  readonly agentMode: 'sa' | 'ama' | 'amaw';
  readonly workMode: 'agent' | 'coding' | 'script';
  readonly agentProfile?: KodaXAgentProfile;
  /** Executable targets, including deferred/Script leaf tools. */
  readonly toolScope: readonly string[];
  /** Names actually disclosed to the model after projection, when a request exists. */
  readonly modelToolScope?: readonly string[];
  readonly verification?: KodaXTaskVerificationContract;
}

export interface KodaXTaskCapabilityHint {
  kind: 'skill' | 'tool' | 'command' | 'workflow';
  name: string;
  details?: string;
}

export interface KodaXTaskVerificationCriterion {
  id: string;
  label: string;
  description: string;
  threshold: number;
  weight: number;
  requiredEvidence?: string[];
}

export interface KodaXRuntimeVerificationContract {
  startupCommand?: string;
  cwd?: string;
  env?: Record<string, string>;
  readySignal?: string;
  baseUrl?: string;
  uiFlows?: string[];
  apiChecks?: string[];
  dbChecks?: string[];
  fixtures?: string[];
}

export interface KodaXTaskVerificationContract {
  summary?: string;
  instructions?: string[];
  requiredEvidence?: string[];
  requiredChecks?: string[];
  capabilityHints?: KodaXTaskCapabilityHint[];
  rubricFamily?:
    | 'code-review'
    | 'frontend'
    | 'product-completeness'
    | 'functionality'
    | 'code-quality'
    // FEATURE_247: profile-scoped families for non-coding SDK surfaces (e.g.
    // KodaX-Space Partner research). Additive — never selected unless a caller
    // sets it, so default coding verification is unchanged.
    | 'partner-research';
  criteria?: KodaXTaskVerificationCriterion[];
  runtime?: KodaXRuntimeVerificationContract;
}

export interface KodaXAgentProfile {
  /** Surface/profile label, e.g. `'code'` | `'partner'`. Opaque to the core. */
  readonly surface?: string;
  /** Stable profile id (UUID or stable name). Opaque to the core. */
  readonly id?: string;
  /** Profile version. Opaque to the core. */
  readonly version?: string;
  /** Human-facing display name. Opaque to the core. */
  readonly name?: string;
  /**
   * Behavior instructions prepended to the AMA Worker prompt or used as the SA
   * base prompt, retaining the admitted Skill catalog in either mode. An explicit
   * `context.systemPromptOverride` still replaces the complete SA prompt.
   */
  readonly instructions?: string;
  /**
   * Profile-default verification standard. Merged with per-task
   * `context.taskVerification` (per-task fields win) before reaching the Sidecar
   * Verifier.
   */
  readonly verification?: KodaXTaskVerificationContract;
}

/**
 * FEATURE_247 (R2) — a minimal, stable per-tool view handed to a
 * {@link KodaXToolVisibilityPolicy}. Only the load-bearing declarative metadata
 * is exposed (never the handler / full schema) so the contract stays stable as
 * tools evolve. `sideEffect` distinguishes readonly / reads-network /
 * mutates-* classes; `planModeAllowed` marks query-shaped tools.
 */
export interface KodaXToolVisibilityMeta {
  readonly name: string;
  readonly sideEffect: ToolSideEffect;
  readonly planModeAllowed: boolean;
}

/**
 * FEATURE_247 (R2) — an SDK-consumer predicate evaluated for every candidate
 * tool BEFORE the model-visible tool list is built. Return `false` to hide a
 * tool from the model. Space uses this to express profile-scoped rules such as
 * "only readonly + reads-network visible" and to default-deny anything it does
 * not explicitly recognize, without enumerating a name list that drifts as the
 * SDK adds tools. Covers SDK builtin + host-registered + extension + MCP tools
 * uniformly (each carries a required `sideEffect`). A tool with no resolvable
 * metadata is hidden (fail-closed).
 */
export type KodaXToolVisibilityPolicy = (tool: KodaXToolVisibilityMeta) => boolean;
