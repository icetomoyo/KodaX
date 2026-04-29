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
  // Step 1 — schema validation.
  const schemaError = validateSchema(manifest);
  if (schemaError) {
    return {
      ok: false,
      reason: `admission: ${schemaError.reason}`,
      retryable: schemaError.retryable,
    };
  }

  const systemCap = options?.systemCap ?? DEFAULT_SYSTEM_CAP;
  const activatedAgents = options?.activatedAgents ?? new Map<string, Agent>();
  const role = options?.role ?? 'direct';
  const toolScope = options?.toolScope ?? [];
  const harnessTier = options?.harnessTier ?? 'H0_DIRECT';

  // Step 2 — resolve effective invariants.
  const required = resolveRequiredInvariants(role, toolScope, harnessTier);
  const effective = resolveEffectiveInvariants(required, manifest.declaredInvariants);

  const ctx: AdmissionCtx = { manifest, activatedAgents, systemCap };

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
      return {
        ok: false,
        reason: result.reason,
        retryable: false,
      };
    }
    if (result.severity === 'clamp') {
      patches.push(result.patch);
      clampNotes.push(`[${id}] ${result.reason}`);
      continue;
    }
    // warn — informational only.
    clampNotes.push(`[${id}] ${result.reason}`);
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
