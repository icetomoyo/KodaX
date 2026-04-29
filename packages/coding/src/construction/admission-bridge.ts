/**
 * FEATURE_089 (v0.7.31) — bridge between `AgentContent` (the manifest
 * shape persisted in `.kodax/constructed/agents/`) and the FEATURE_101
 * `AgentManifest` shape that `Runner.admit` consumes.
 *
 * Why a dedicated bridge module:
 *
 *   - `AgentContent` is the on-disk schema — declarative, decoupled
 *     from runtime types, JSON-serializable. Refs are strings.
 *   - `AgentManifest` is the Layer A admission input — typed against
 *     `Agent` so admission invariants can reason about handoff graphs,
 *     tool capability tiers, declared invariant sets, budget caps.
 *
 * The bridge resolves tool / handoff / guardrail refs to the minimum
 * structural shape admission needs (tool names, handoff target Agent
 * objects, declared invariants). It does NOT resolve refs to fully
 * runnable tool definitions — that's Phase 3.4 Resolver work, used at
 * `Runner.run` time, not at admit time. Admission only inspects
 * structural properties.
 *
 * Pure function. No I/O, no shared mutable state.
 */

import type { Agent, AgentManifest, InvariantId } from '@kodax/core';

import type {
  AgentContent,
  AgentHandoffRef,
  ToolRef,
} from './types.js';

/**
 * Parse a ref string like `builtin:read` or `constructed:foo@1.0.0`
 * into the bare tool name. Falls back to the whole ref when the
 * `<scheme>:` prefix is missing — keeps the function tolerant of
 * legacy / hand-authored manifests.
 */
export function parseToolNameFromRef(ref: string): string {
  const colon = ref.indexOf(':');
  if (colon === -1) return ref;
  const tail = ref.slice(colon + 1);
  // Strip @version suffix for constructed refs.
  const at = tail.indexOf('@');
  return at === -1 ? tail : tail.slice(0, at);
}

/**
 * Resolve a list of ToolRefs to the structural Agent.tools shape that
 * admission needs (each tool exposes `.name`). Capability classification
 * happens inside `toolPermission.admit` via `resolveToolCapability`.
 */
function refsToTools(refs: readonly ToolRef[] | undefined): readonly { readonly name: string }[] | undefined {
  if (!refs || refs.length === 0) return undefined;
  return refs.map((r) => ({ name: parseToolNameFromRef(r.ref) }));
}

/**
 * Build a stub `Agent` for a handoff target. We don't need the full
 * runtime Agent at admit time — `handoffLegality` walks names + outgoing
 * edges, and `independentReview` checks role names. The stub carries
 * the parsed name + an empty instructions string; downstream invariant
 * hooks ignore the rest.
 */
function refToHandoffTargetAgent(ref: string): Agent {
  return {
    name: parseToolNameFromRef(ref),
    instructions: '',
  };
}

function refsToHandoffs(refs: readonly AgentHandoffRef[] | undefined) {
  if (!refs || refs.length === 0) return undefined;
  return refs.map((h) => ({
    target: refToHandoffTargetAgent(h.target.ref),
    kind: h.kind,
    description: h.description,
  }));
}

/**
 * Build the FEATURE_101 `AgentManifest` admission input from the
 * persisted `AgentContent`. The artifact's `name` becomes the
 * manifest's `name` (admission's `finalOwner` / `handoffLegality`
 * invariants both key on names).
 *
 * `declaredInvariants` is passed through unchanged so `Runner.admit`'s
 * schema validation can surface unknown ids as a clear retryable
 * error. (Earlier versions filtered unknown ids silently here; that
 * masked LLM typos behind an empty declared set — better to let
 * admission report "manifest.declaredInvariants contains unknown
 * invariant id 'harnessSelectionTimeing'" so the LLM can fix the
 * typo.)
 */
function passThroughDeclaredInvariants(
  ids: readonly string[] | undefined,
): readonly InvariantId[] | undefined {
  if (!ids || ids.length === 0) return undefined;
  // The cast is structural: AgentContent.declaredInvariants is
  // `string[]` for JSON serializability; admission's audit narrows to
  // InvariantId at validation time. We don't filter here — let
  // unknown ids fail loudly in the audit.
  return ids as readonly InvariantId[];
}

export interface BuildAdmissionManifestInput {
  readonly name: string;
  readonly content: AgentContent;
}

/**
 * Pure manifest-building function. Output is fed straight into
 * `Runner.admit(manifest, options)`.
 */
export function buildAdmissionManifest(
  input: BuildAdmissionManifestInput,
): AgentManifest {
  const { name, content } = input;
  const tools = refsToTools(content.tools);
  const handoffs = refsToHandoffs(content.handoffs);
  const declaredInvariants = passThroughDeclaredInvariants(content.declaredInvariants);

  const manifest: AgentManifest = {
    name,
    instructions: content.instructions,
    ...(tools !== undefined ? { tools: tools as unknown as AgentManifest['tools'] } : {}),
    ...(handoffs !== undefined ? { handoffs: handoffs as unknown as AgentManifest['handoffs'] } : {}),
    ...(content.reasoning !== undefined ? { reasoning: content.reasoning } : {}),
    ...(content.guardrails !== undefined
      ? {
          guardrails: content.guardrails.map((g) => ({
            kind: g.kind,
            name: parseToolNameFromRef(g.ref),
          })),
        }
      : {}),
    ...(content.model !== undefined ? { model: content.model } : {}),
    ...(content.provider !== undefined ? { provider: content.provider } : {}),
    ...(content.outputSchema !== undefined ? { outputSchema: content.outputSchema } : {}),
    ...(content.maxBudget !== undefined ? { maxBudget: content.maxBudget } : {}),
    ...(declaredInvariants !== undefined ? { declaredInvariants } : {}),
  };

  return manifest;
}
