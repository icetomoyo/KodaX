/**
 * FEATURE_101 admission audit — the 5-step process `Runner.admit` runs
 * against an untrusted manifest.
 *
 * Pure orchestration of the building blocks declared elsewhere in
 * @kodax/core:
 *
 *   1. **Schema validation** — manifest has well-formed name, instructions,
 *      tools, declaredInvariants, requestedToolCapabilities. Fail-fast on
 *      shape errors (no clamps).
 *   2. **Resolve effective invariants** — required (system policy) ∪
 *      declared (manifest voluntary). Required is computed from
 *      role / toolScope / harnessTier; declared can only ADD.
 *   3. **Run admit hooks** — for each effective invariant that has an
 *      admit hook registered, call it with the (manifest, ctx) tuple.
 *      Collect reject / clamp / warn results.
 *   4. **Compose patches** — clamp-severity results carry patches; we
 *      compose them with `composePatches` (min-wins for clamps, union
 *      for collections).
 *   5. **Apply patches** — `applyManifestPatch` produces the final
 *      admitted manifest. Reject results short-circuit before this step.
 *
 * Returns an `AdmissionVerdict` discriminated union — `ok: true` carries
 * the `AdmittedHandle` plus `clampNotes`; `ok: false` carries `reason`
 * and the `retryable` flag.
 *
 * Pure function (no I/O, no logging). The Runner shell is responsible
 * for tracing / observability around this call.
 */

import type { Agent } from './agent.js';
import {
  applyManifestPatch,
  composePatches,
  getInvariant,
  resolveEffectiveInvariants,
  resolveRequiredInvariants,
} from './admission-runtime.js';
import {
  _incAdmitOk,
  _incAdmitReject,
  _incAdmitTotal,
  isAdmissionDebugEnabled,
} from './admission-metrics.js';
import type {
  AdmissionCtx,
  AdmissionVerdict,
  AgentManifest,
  InvariantId,
  ManifestPatch,
  SystemCap,
  ToolCapability,
} from './admission.js';

// ---------------------------------------------------------------------------
// Default system cap — permissive ceiling that any deployment can override.
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_CAPABILITIES: readonly ToolCapability[] = [
  'read',
  'edit',
  'bash:test',
  'bash:read-only',
  'bash:mutating',
  'bash:network',
  'subagent',
];

/**
 * Default system cap — high ceilings so admission only clamps when
 * deployments have explicitly declared tighter limits. The numbers
 * mirror the legacy `runManagedTask` budget defaults so this is a
 * compatibility-preserving baseline, not a policy tightening.
 */
export const DEFAULT_SYSTEM_CAP: SystemCap = {
  maxBudget: 200_000,
  maxIterations: 200,
  allowedToolCapabilities: DEFAULT_TOOL_CAPABILITIES,
};

/**
 * Options accepted by `runAdmissionAudit` (and surfaced by `Runner.admit`).
 * All fields are optional — the audit substitutes safe defaults so the
 * SDK call surface stays a single positional argument: the manifest.
 */
export interface AdmissionAuditOptions {
  readonly systemCap?: SystemCap;
  readonly activatedAgents?: ReadonlyMap<string, Agent>;
  /**
   * FEATURE_101 v0.7.31.1 — same-batch staged agents. Manifests that
   * have been staged but not yet activated still need to participate
   * in `handoffLegality` cycle detection: a generator that writes A
   * (handoff to B) and B (handoff to A) in the same batch sees neither
   * activated when admission runs on each individually. With
   * `stagedAgents` populated, the second admission detects the back
   * edge to the first and rejects.
   *
   * Sourced from `ConstructionRuntime` which builds a Map of
   * staged-status manifests at the call site.
   */
  readonly stagedAgents?: ReadonlyMap<string, Agent>;
  readonly role?: 'scout' | 'planner' | 'generator' | 'evaluator' | 'direct';
  readonly toolScope?: readonly string[];
  readonly harnessTier?: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
  /**
   * ISO timestamp recorded on the AdmittedHandle. Defaults to
   * `new Date().toISOString()` — overridable so tests can pin a value.
   */
  readonly nowIso?: string;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const VALID_INVARIANT_IDS: ReadonlySet<string> = new Set<string>([
  'finalOwner',
  'handoffLegality',
  'budgetCeiling',
  'toolPermission',
  'evidenceTrail',
  'boundedRevise',
  'independentReview',
  'harnessSelectionTiming',
]);

const VALID_TOOL_CAPABILITIES: ReadonlySet<string> = new Set<string>(DEFAULT_TOOL_CAPABILITIES);

/**
 * FEATURE_101 v0.7.31.1 — static prompt-injection patterns flagged in
 * untrusted manifest.instructions. Detection is conservative: a flagged
 * manifest is rejected (retryable) so the generator can rephrase.
 * The list mirrors FEATURE_101 §systemPrompt 双层包装's mitigation
 * checklist; it is NOT exhaustive (the design explicitly frames this
 * as mitigation, not elimination — eval metrics carry the residual).
 *
 * Each pattern is matched case-insensitive against the full
 * instructions string. Patterns are intentionally short to avoid false
 * positives on legitimate role descriptions ("ignore previous output"
 * is *not* in the list — it's the entire phrase "ignore previous
 * instructions" / "ignore all previous" that signals injection).
 */
const INJECTION_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: 'ignore-previous', pattern: /\bignore\s+(?:all\s+)?previous\s+(?:instructions?|prompts?|messages?|directives?|system)/i },
  { id: 'system-prompt-ref', pattern: /\b(?:reveal|leak|show|print|dump|disclose)\s+(?:the\s+)?system\s+prompt/i },
  { id: 'system-tag', pattern: /<\/?system>/i },
  { id: 'override-system', pattern: /\b(?:override|bypass|disable)\s+(?:the\s+)?system\s+(?:rules?|prompt|instructions?)/i },
  { id: 'inst-template', pattern: /\[\s*INST\s*\]|\[\s*\/\s*INST\s*\]/i },
  { id: 'role-impersonation', pattern: /\b(?:you\s+are\s+now|pretend\s+to\s+be|act\s+as)\s+(?:the\s+)?(?:system|developer|root|admin)/i },
];

/**
 * Scan an instructions string for known prompt-injection patterns.
 * Returns the first matching pattern id or undefined when clean.
 */
export function detectInstructionsInjection(text: string): string | undefined {
  for (const { id, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(text)) return id;
  }
  return undefined;
}

interface SchemaError {
  readonly reason: string;
  readonly retryable: boolean;
}

function validateSchema(manifest: AgentManifest): SchemaError | undefined {
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    return { reason: 'manifest.name must be a non-empty string', retryable: true };
  }
  if (
    typeof manifest.instructions !== 'string' &&
    typeof manifest.instructions !== 'function'
  ) {
    return {
      reason: 'manifest.instructions must be a string or a function',
      retryable: true,
    };
  }
  // FEATURE_101 v0.7.31.1 — static prompt-injection scan. We only
  // inspect string instructions; function instructions are SDK-provided
  // (trusted by definition — function manifests aren't reachable from
  // LLM-driven scaffolding). Hits a pattern → reject with a clear
  // pattern id so the generator can rewrite the offending phrase.
  if (typeof manifest.instructions === 'string') {
    const hit = detectInstructionsInjection(manifest.instructions);
    if (hit !== undefined) {
      return {
        reason:
          `manifest.instructions matched injection pattern '${hit}' — `
          + `untrusted manifests must not include directives that try to override `
          + `system instructions, reveal the system prompt, or impersonate privileged roles. `
          + `Rephrase the instruction in role-relevant terms (e.g. instead of 'ignore previous instructions', describe the role's task directly).`,
        retryable: true,
      };
    }
    // Length cap (FEATURE_101 open question Q4 — settled at 8 KB,
    // ~2000 tokens, comfortably above the documented ≤1000-token
    // recommendation while leaving headroom for richer role specs
    // exercised in the v0.7.31.1 patch eval).
    if (manifest.instructions.length > 8192) {
      return {
        reason:
          `manifest.instructions length=${manifest.instructions.length} exceeds 8192-char cap. `
          + `Trim the instructions; admission caps untrusted manifest text to bound the prompt-injection surface.`,
        retryable: true,
      };
    }
  }
  if (manifest.tools) {
    for (let i = 0; i < manifest.tools.length; i += 1) {
      const tool = manifest.tools[i];
      const name = (tool as { name?: unknown } | undefined)?.name;
      if (typeof name !== 'string' || name.length === 0) {
        return {
          reason: `manifest.tools[${i}].name must be a non-empty string`,
          retryable: true,
        };
      }
    }
  }
  if (manifest.declaredInvariants) {
    for (const id of manifest.declaredInvariants) {
      if (!VALID_INVARIANT_IDS.has(id)) {
        return {
          reason: `manifest.declaredInvariants contains unknown invariant id "${id}"`,
          retryable: true,
        };
      }
    }
  }
  if (manifest.requestedToolCapabilities) {
    for (let i = 0; i < manifest.requestedToolCapabilities.length; i += 1) {
      const perm = manifest.requestedToolCapabilities[i]!;
      if (typeof perm.tool !== 'string' || perm.tool.length === 0) {
        return {
          reason: `manifest.requestedToolCapabilities[${i}].tool must be a non-empty string`,
          retryable: true,
        };
      }
      if (!Array.isArray(perm.capabilities) || perm.capabilities.length === 0) {
        return {
          reason: `manifest.requestedToolCapabilities[${i}].capabilities must be a non-empty array`,
          retryable: true,
        };
      }
      for (const cap of perm.capabilities) {
        if (!VALID_TOOL_CAPABILITIES.has(cap)) {
          return {
            reason: `manifest.requestedToolCapabilities[${i}] declared unknown capability "${cap}"`,
            retryable: true,
          };
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 5-step audit
// ---------------------------------------------------------------------------

/**
 * Run the admission audit against an untrusted manifest. Returns an
 * `AdmissionVerdict` — never throws (errors are encoded in the verdict).
 *
 * Pure function: same inputs always return equivalent outputs (modulo
 * the `nowIso` timestamp, which can be pinned via options).
 */
export function runAdmissionAudit(
  manifest: AgentManifest,
  options?: AdmissionAuditOptions,
): AdmissionVerdict {
  _incAdmitTotal();
  const debug = isAdmissionDebugEnabled();
  const debugLog = (line: string): void => {
    if (debug) {
      // eslint-disable-next-line no-console
      console.error(`[admission:debug] ${line}`);
    }
  };
  debugLog(`begin manifest='${manifest.name}'`);
  // Step 1 — schema validation.
  const schemaError = validateSchema(manifest);
  if (schemaError) {
    _incAdmitReject(schemaError.retryable);
    debugLog(`reject(schema) reason='${schemaError.reason}' retryable=${schemaError.retryable}`);
    return {
      ok: false,
      reason: `admission: ${schemaError.reason}`,
      retryable: schemaError.retryable,
    };
  }

  const systemCap = options?.systemCap ?? DEFAULT_SYSTEM_CAP;
  const activatedAgents = options?.activatedAgents ?? new Map<string, Agent>();
  const stagedAgents = options?.stagedAgents ?? new Map<string, Agent>();
  const role = options?.role ?? 'direct';
  const toolScope = options?.toolScope ?? [];
  const harnessTier = options?.harnessTier ?? 'H0_DIRECT';

  // Step 2 — resolve effective invariants.
  const required = resolveRequiredInvariants(role, toolScope, harnessTier);
  const effective = resolveEffectiveInvariants(required, manifest.declaredInvariants);

  const ctx: AdmissionCtx = { manifest, activatedAgents, stagedAgents, systemCap };

  // Step 3 — run admit hooks. Reject short-circuits, clamps accumulate,
  // warns surface as clampNotes.
  const patches: ManifestPatch[] = [];
  const clampNotes: string[] = [];

  for (const id of effective) {
    const inv = getInvariant(id);
    if (!inv || !inv.admit) continue;
    const result = inv.admit(manifest, ctx);
    if (result.ok) continue;

    if (result.severity === 'reject') {
      _incAdmitReject(false);
      debugLog(`reject(invariant=${id}) reason='${result.reason}'`);
      return {
        ok: false,
        reason: result.reason,
        retryable: false,
      };
    }
    if (result.severity === 'clamp') {
      patches.push(result.patch);
      clampNotes.push(`[${id}] ${result.reason}`);
      debugLog(`clamp(invariant=${id}) reason='${result.reason}'`);
      continue;
    }
    // warn — informational only.
    clampNotes.push(`[${id}] ${result.reason}`);
    debugLog(`warn(invariant=${id}) reason='${result.reason}'`);
  }

  // Step 4 — compose patches (no-op when patches is empty: composePatches
  // returns {} which applyManifestPatch handles as a pass-through).
  const composed = composePatches(patches);

  // Step 5 — apply patches. Returns the manifest unchanged when composed
  // is empty.
  const finalManifest = applyManifestPatch(manifest, composed);

  // `invariantBindings` is what the *runtime* layer (observe + assertTerminal
  // hook dispatch) consults to know which invariants apply to this agent.
  // We filter to ids that exist in the registry: an effective id with no
  // implementation is a deployment gap, and listing it in bindings would
  // mis-report "this invariant governs this agent" to dispatch-eval
  // consumers when in fact no hook will ever run for it. Filtering at
  // admit time keeps the handle's bindings accurate; missing registrations
  // surface via the absence rather than via false coverage claims.
  const bindings: InvariantId[] = [];
  const seenBindings = new Set<InvariantId>();
  for (const id of effective) {
    if (seenBindings.has(id)) continue;
    if (!getInvariant(id)) continue;
    seenBindings.add(id);
    bindings.push(id);
  }

  const clamped = patches.length > 0;
  _incAdmitOk(clamped);
  debugLog(
    `ok manifest='${manifest.name}' clamped=${clamped} bindings=[${bindings.join(',')}] patches=${patches.length}`,
  );
  return {
    ok: true,
    handle: {
      manifest: finalManifest,
      admittedAt: options?.nowIso ?? new Date().toISOString(),
      appliedPatches: patches,
      invariantBindings: bindings,
    },
    clampNotes,
  };
}
