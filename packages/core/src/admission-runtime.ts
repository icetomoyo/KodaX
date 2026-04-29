/**
 * FEATURE_101 (v0.7.31) admission runtime — patch reducer + invariant registry.
 *
 * Deterministic, side-effect-free helpers consumed by `Runner.admit()` (in
 * `./runner.ts`, added in the next 1A.3 increment).
 *
 *   - `applyManifestPatch(manifest, patch)`: produces a new manifest with the
 *     patch applied. Used when admission needs to clamp tools / budget /
 *     iterations to system caps.
 *   - `composePatches(patches)`: merges multiple patches (deterministic
 *     reducer; min wins for clamp values, union for collections).
 *   - `InvariantRegistry`: in-memory registry mapping `InvariantId` to
 *     `QualityInvariant` implementations. Open-ended — FEATURE_101 v1
 *     registers 7 closed-set invariants; FEATURE_106 registers 1 external
 *     invariant; future features may add more.
 *   - `resolveRequiredInvariants(role, toolScope, harnessTier)`: pure
 *     function returning the InvariantId set the admission layer enforces
 *     by default (caller's `manifest.declaredInvariants` is unioned on
 *     top — declared can only ADD, never remove from required).
 *
 * Pure data + pure functions. No I/O, no shared mutable state visible
 * outside the registry's own opaque object. Tests live in
 * `./admission-runtime.test.ts`.
 */

import type {
  AgentManifest,
  InvariantId,
  ManifestPatch,
  QualityInvariant,
} from './admission.js';

// ---------------------------------------------------------------------------
// ManifestPatch reducer
// ---------------------------------------------------------------------------

/**
 * Apply a patch to a manifest, returning a NEW manifest. Pure function;
 * input is not mutated.
 *
 * Semantics per field:
 *
 *   - `removeTools`:        manifest.tools filtered by `(t) => !patch.removeTools.includes(t.name)`
 *   - `clampMaxBudget`:     manifest.maxBudget = min(current, patch.clampMaxBudget) when current > clamp
 *   - `clampMaxIterations`: NO field on Agent today — recorded in the new
 *                           manifest's `declaredInvariants` via 'boundedRevise'
 *                           (see § Required vs Declared Invariants); the
 *                           clamp value is honoured at runtime by the
 *                           budget controller. We expose the value via the
 *                           `_admissionMeta` symbol path (future-compatible).
 *   - `addInvariants`:      union into manifest.declaredInvariants
 *   - `notes`:              ignored at the manifest level — surfaced
 *                           through AdmissionVerdict.clampNotes
 *
 * The patch is monotone: tools can only be REMOVED (admission can shrink,
 * never expand), budgets can only be CLAMPED DOWN, invariants can only be
 * ADDED. This invariant is what makes "clamp severity is safe to apply
 * automatically" — the manifest can't end up MORE permissive than what
 * the LLM submitted.
 */
export function applyManifestPatch(
  manifest: AgentManifest,
  patch: ManifestPatch,
): AgentManifest {
  let next: AgentManifest = manifest;

  if (patch.removeTools && patch.removeTools.length > 0 && manifest.tools) {
    const toRemove = new Set(patch.removeTools);
    const filteredTools = manifest.tools.filter(
      (tool) => !toRemove.has(getToolName(tool)),
    );
    next = { ...next, tools: filteredTools };
  }

  if (typeof patch.clampMaxBudget === 'number') {
    const current = next.maxBudget;
    if (typeof current !== 'number' || current > patch.clampMaxBudget) {
      next = { ...next, maxBudget: patch.clampMaxBudget };
    }
  }

  if (patch.addInvariants && patch.addInvariants.length > 0) {
    const existing = new Set<InvariantId>(next.declaredInvariants ?? []);
    for (const id of patch.addInvariants) {
      existing.add(id);
    }
    next = { ...next, declaredInvariants: Array.from(existing) };
  }

  return next;
}

/**
 * Tools may be either a `RunnableTool` (with .name) or a `KodaXToolDefinition`.
 * Both expose `.name` as a string field; this helper centralizes the
 * fallback to `'(unnamed)'` for malformed tool entries (which admission
 * itself will reject via schema validation upstream).
 */
function getToolName(tool: AgentManifest['tools'] extends readonly (infer T)[] | undefined ? T : never): string {
  if (typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string') {
    return tool.name;
  }
  return '(unnamed)';
}

/**
 * Compose multiple patches into one. Order is preserved for `notes`; numeric
 * clamp fields use min-wins (most restrictive); collections union.
 *
 * Used when several invariants each return clamp at admission time — the
 * Runner accumulates patches and applies them in one pass.
 */
export function composePatches(patches: readonly ManifestPatch[]): ManifestPatch {
  if (patches.length === 0) return {};
  if (patches.length === 1) return patches[0]!;

  const removeToolsSet = new Set<string>();
  const addInvariantsSet = new Set<InvariantId>();
  const allNotes: string[] = [];
  let clampMaxBudget: number | undefined;
  let clampMaxIterations: number | undefined;

  for (const p of patches) {
    if (p.removeTools) {
      for (const t of p.removeTools) removeToolsSet.add(t);
    }
    if (p.addInvariants) {
      for (const i of p.addInvariants) addInvariantsSet.add(i);
    }
    if (p.notes) allNotes.push(...p.notes);
    if (typeof p.clampMaxBudget === 'number') {
      clampMaxBudget =
        typeof clampMaxBudget === 'number'
          ? Math.min(clampMaxBudget, p.clampMaxBudget)
          : p.clampMaxBudget;
    }
    if (typeof p.clampMaxIterations === 'number') {
      clampMaxIterations =
        typeof clampMaxIterations === 'number'
          ? Math.min(clampMaxIterations, p.clampMaxIterations)
          : p.clampMaxIterations;
    }
  }

  const composed: ManifestPatch = {};
  if (removeToolsSet.size > 0) {
    (composed as { removeTools?: readonly string[] }).removeTools = Array.from(removeToolsSet);
  }
  if (addInvariantsSet.size > 0) {
    (composed as { addInvariants?: readonly InvariantId[] }).addInvariants = Array.from(addInvariantsSet);
  }
  if (allNotes.length > 0) {
    (composed as { notes?: readonly string[] }).notes = allNotes;
  }
  if (typeof clampMaxBudget === 'number') {
    (composed as { clampMaxBudget?: number }).clampMaxBudget = clampMaxBudget;
  }
  if (typeof clampMaxIterations === 'number') {
    (composed as { clampMaxIterations?: number }).clampMaxIterations = clampMaxIterations;
  }
  return composed;
}

// ---------------------------------------------------------------------------
// Invariant registry
// ---------------------------------------------------------------------------

/**
 * Open-ended registry mapping `InvariantId` to `QualityInvariant`
 * implementations. The admission v1 closed set (7 invariants) is
 * registered by `@kodax/coding/src/agent-runtime/invariants/index.ts`
 * during package initialization; FEATURE_106 registers the 8th
 * (`harnessSelectionTiming`) on the same registry; future features may
 * register more.
 *
 * Single shared module-scope registry — same instance whether accessed
 * from @kodax/core or via an @kodax/coding consumer. Tests reset it via
 * `_resetInvariantRegistry()`.
 */
const _registry = new Map<InvariantId, QualityInvariant>();

/**
 * Register an invariant implementation. Throws if the id is already
 * registered (overwrite would be a silent contract bug). Tests that
 * need a fresh registry call `_resetInvariantRegistry()` first.
 */
export function registerInvariant(invariant: QualityInvariant): void {
  if (_registry.has(invariant.id)) {
    throw new Error(
      `[admission-runtime] Invariant "${invariant.id}" is already registered. ` +
        'Use _resetInvariantRegistry() in tests; in production, register each invariant exactly once.',
    );
  }
  if (!invariant.admit && !invariant.observe && !invariant.assertTerminal) {
    throw new Error(
      `[admission-runtime] Invariant "${invariant.id}" must implement at least one of admit / observe / assertTerminal.`,
    );
  }
  _registry.set(invariant.id, invariant);
}

/**
 * Look up a registered invariant by id. Returns undefined when not
 * registered — Runner.admit treats this as "skip this id silently"
 * because the closed-set guarantee belongs to the registry caller, not
 * to the runtime.
 */
export function getInvariant(id: InvariantId): QualityInvariant | undefined {
  return _registry.get(id);
}

/**
 * Snapshot of the currently-registered invariant ids. Read-only —
 * mutations on the returned array do NOT affect the registry.
 */
export function listRegisteredInvariants(): readonly InvariantId[] {
  return Array.from(_registry.keys());
}

/**
 * Reset the registry to empty. **Tests only** — production code should
 * never invoke this. Module export name is prefixed with `_` to make
 * accidental imports stand out.
 */
export function _resetInvariantRegistry(): void {
  _registry.clear();
}

// ---------------------------------------------------------------------------
// Required invariant resolver
// ---------------------------------------------------------------------------

/**
 * Per-role / per-tool-scope / per-harness-tier required invariant set.
 *
 * Pure function — same inputs always return the same set. The admission
 * layer unions this with `manifest.declaredInvariants` to produce the
 * effective set. Declared can only ADD (it's an LLM voluntary commitment
 * on top of what the system requires).
 *
 * v1 default policy: every manifest gets the 7 admission-v1 closed-set
 * invariants. role / toolScope / harnessTier are accepted but currently
 * not used to differentiate — they're plumbed through so future
 * refinements can specialize without breaking the API.
 */
export function resolveRequiredInvariants(
  _role: 'scout' | 'planner' | 'generator' | 'evaluator' | 'direct',
  _toolScope: readonly string[],
  _harnessTier: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL',
): readonly InvariantId[] {
  // v1: the 7 admission closed-set invariants apply uniformly.
  // Future versions may relax (e.g. independentReview optional in H0
  // since H0 has no Evaluator role — see FEATURE_101 §晋升 ADR-021 前
  // 需要回答的开放问题 #2).
  return [
    'finalOwner',
    'handoffLegality',
    'budgetCeiling',
    'toolPermission',
    'evidenceTrail',
    'boundedRevise',
    'independentReview',
  ];
}

/**
 * Effective invariant set for a manifest = union of required (system)
 * and declared (LLM voluntary). Returned in stable order (required
 * first, then declared additions in insertion order).
 */
export function resolveEffectiveInvariants(
  required: readonly InvariantId[],
  declared: readonly InvariantId[] | undefined,
): readonly InvariantId[] {
  if (!declared || declared.length === 0) return [...required];
  const seen = new Set<InvariantId>(required);
  const result: InvariantId[] = [...required];
  for (const id of declared) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
