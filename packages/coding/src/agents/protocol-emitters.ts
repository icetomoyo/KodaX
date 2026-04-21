/**
 * Protocol emitter tools — FEATURE_084 Shard 2 (v0.7.26).
 *
 * Four role-specific `RunnableTool`s that replace the fenced-block text
 * protocol used by Scout / Planner / Generator / Evaluator today. Each tool
 * accepts a structured JSON payload, normalizes it via
 * `coerceManagedProtocolToolPayload` (the same normalizer the old fenced-block
 * parser uses), and surfaces the normalized payload on the tool result
 * `metadata.payload` field so the new Runner-driven task engine
 * (FEATURE_084 Shard 5) can make routing decisions without text parsing.
 *
 * **Data-only at this shard**: nothing consumes these tools yet. The SA
 * preset path and the existing managed-task engine continue to use the
 * legacy `emit_managed_protocol` tool + fenced-block fallback unchanged.
 *
 * **Payload parity contract**: a given JSON input MUST produce an identical
 * normalized payload to what the legacy fenced-block parser would produce
 * for the same JSON. This is enforced by sharing
 * `coerceManagedProtocolToolPayload` between both paths.
 */

import type { RunnableTool, RunnerToolResult } from '@kodax/core';
import {
  EVALUATOR_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  PLANNER_AGENT_NAME,
} from '@kodax/core';

import { coerceManagedProtocolToolPayload } from '../managed-protocol.js';
import type { KodaXManagedProtocolPayload } from '../types.js';

/** Public tool name — LLM sees this on the tool list. */
export const EMIT_SCOUT_VERDICT_TOOL_NAME = 'emit_scout_verdict';
export const EMIT_CONTRACT_TOOL_NAME = 'emit_contract';
export const EMIT_HANDOFF_TOOL_NAME = 'emit_handoff';
export const EMIT_VERDICT_TOOL_NAME = 'emit_verdict';

/**
 * Shared metadata shape on the tool result. The Runner-driven task engine
 * (Shard 5) inspects `payload` to understand verdicts and
 * `handoffTarget` to execute the next role transition.
 */
export interface ProtocolEmitterMetadata {
  /** The role that emitted this payload — always matches the tool's role. */
  readonly role: 'scout' | 'planner' | 'generator' | 'evaluator';
  /** Normalized payload slice (scout / contract / handoff / verdict). */
  readonly payload: Partial<KodaXManagedProtocolPayload>;
  /**
   * FEATURE_084 Shard 4 handoff signal. When set, the Runner looks up the
   * handoff in `currentAgent.handoffs` and transfers ownership. When
   * undefined, the current agent remains responsible (terminal / direct
   * case). See each emitter's body for the payload → target mapping.
   */
  readonly handoffTarget?: string;
  /**
   * True when the payload denotes a terminal outcome (H0 direct, accept,
   * blocked). The Runner uses this as a signal that no further LLM turn is
   * expected after the current one.
   */
  readonly isTerminal?: boolean;
}

/**
 * Map a normalized payload → handoff target agent name. Pure function so
 * both the emitter and unit tests can verify the mapping rules.
 */
function resolveHandoffTarget(
  role: ProtocolEmitterMetadata['role'],
  normalized: Partial<KodaXManagedProtocolPayload>,
): { handoffTarget?: string; isTerminal: boolean } {
  if (role === 'scout') {
    const harness = normalized.scout?.confirmedHarness;
    if (harness === 'H1_EXECUTE_EVAL') return { handoffTarget: GENERATOR_AGENT_NAME, isTerminal: false };
    if (harness === 'H2_PLAN_EXECUTE_EVAL') return { handoffTarget: PLANNER_AGENT_NAME, isTerminal: false };
    // H0_DIRECT or missing harness → Scout keeps ownership, terminal.
    return { isTerminal: true };
  }
  if (role === 'planner') {
    return { handoffTarget: GENERATOR_AGENT_NAME, isTerminal: false };
  }
  if (role === 'generator') {
    // Generator always hands off to evaluator, regardless of status
    // (blocked/incomplete still need evaluator to decide).
    return { handoffTarget: EVALUATOR_AGENT_NAME, isTerminal: false };
  }
  // evaluator
  const status = normalized.verdict?.status;
  if (status === 'accept' || status === 'blocked') {
    return { isTerminal: true };
  }
  // revise — next_harness picks the escalation target (default: back to generator).
  const next = normalized.verdict?.nextHarness;
  if (next === 'H2_PLAN_EXECUTE_EVAL') {
    return { handoffTarget: PLANNER_AGENT_NAME, isTerminal: false };
  }
  return { handoffTarget: GENERATOR_AGENT_NAME, isTerminal: false };
}

interface EmitterSpec {
  readonly name: string;
  readonly role: ProtocolEmitterMetadata['role'];
  readonly description: string;
  readonly inputSchema: RunnableTool['input_schema'];
}

function buildEmitter(spec: EmitterSpec): RunnableTool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema,
    execute: async (input): Promise<RunnerToolResult> => {
      const normalized = coerceManagedProtocolToolPayload(spec.role, input);
      if (!normalized) {
        return {
          content:
            `[${spec.name}] payload could not be normalized for role ${spec.role}. ` +
            'Check that required fields are present and enum values match the schema.',
          isError: true,
        };
      }
      const { handoffTarget, isTerminal } = resolveHandoffTarget(spec.role, normalized);
      const metadata: ProtocolEmitterMetadata = {
        role: spec.role,
        payload: normalized,
        handoffTarget,
        isTerminal,
      };
      return {
        content: `${spec.role} payload recorded (${summarizeNormalized(spec.role, normalized)})`,
        metadata: metadata as unknown as Record<string, unknown>,
      };
    },
  };
}

function summarizeNormalized(
  role: ProtocolEmitterMetadata['role'],
  normalized: Partial<KodaXManagedProtocolPayload>,
): string {
  if (role === 'scout' && normalized.scout) {
    const harness = normalized.scout.confirmedHarness ?? 'unknown';
    const direct = normalized.scout.directCompletionReady;
    return direct ? `harness=${harness}, direct=${direct}` : `harness=${harness}`;
  }
  if (role === 'planner' && normalized.contract) {
    return `criteria=${normalized.contract.successCriteria?.length ?? 0}`;
  }
  if (role === 'generator' && normalized.handoff) {
    return `status=${normalized.handoff.status}`;
  }
  if (role === 'evaluator' && normalized.verdict) {
    const next = normalized.verdict.nextHarness ? `, next=${normalized.verdict.nextHarness}` : '';
    return `status=${normalized.verdict.status}${next}`;
  }
  return 'ok';
}

/**
 * Scout verdict emitter. Reports the outcome of scope analysis and the
 * chosen harness tier. The Runner-driven task engine reads
 * `metadata.payload.scout.confirmedHarness` to decide whether to hand off
 * to Generator (H1) or Planner (H2), or to finish directly (H0).
 */
export const emitScoutVerdict: RunnableTool = buildEmitter({
  name: EMIT_SCOUT_VERDICT_TOOL_NAME,
  role: 'scout',
  description:
    'Emit the Scout verdict — harness tier, scope facts, required evidence, and optional skill map. ' +
    'Call this exactly once when scope analysis is complete. The chosen `confirmed_harness` ' +
    'determines the downstream pipeline: H0_DIRECT (Scout answers), H1_EXECUTE_EVAL ' +
    '(hand off to Generator), or H2_PLAN_EXECUTE_EVAL (hand off to Planner).',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One-line summary of the scope assessment.' },
      scope: { type: 'array', items: { type: 'string' }, description: 'Files / areas in scope.' },
      required_evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence items the downstream worker must gather.',
      },
      review_files_or_areas: {
        type: 'array',
        items: { type: 'string' },
        description: 'High-priority files for downstream review.',
      },
      confirmed_harness: {
        type: 'string',
        enum: ['H0_DIRECT', 'H1_EXECUTE_EVAL', 'H2_PLAN_EXECUTE_EVAL'],
        description: 'Chosen harness tier.',
      },
      harness_rationale: { type: 'string', description: 'Why this harness tier.' },
      blocking_evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Issues blocking escalation.',
      },
      direct_completion_ready: {
        type: 'string',
        enum: ['yes', 'no'],
        description: 'For H0 only — is the direct answer already complete?',
      },
      evidence_acquisition_mode: {
        type: 'string',
        enum: ['overview', 'diff-bundle', 'diff-slice', 'file-read'],
        description: 'How evidence was acquired.',
      },
      skill_map: {
        type: 'object',
        properties: {
          skill_summary: { type: 'string' },
          execution_obligations: { type: 'array', items: { type: 'string' } },
          verification_obligations: { type: 'array', items: { type: 'string' } },
          ambiguities: { type: 'array', items: { type: 'string' } },
          projection_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    required: ['confirmed_harness'],
  },
});

/**
 * Planner contract emitter (H2 only). Produces the execution contract the
 * Generator consumes: success criteria, required evidence, constraints.
 */
export const emitContract: RunnableTool = buildEmitter({
  name: EMIT_CONTRACT_TOOL_NAME,
  role: 'planner',
  description:
    'Emit the execution contract after planning. Call this exactly once when the plan is ready. ' +
    'The contract binds the Generator: it lists what success looks like, what evidence must be ' +
    'produced, and what constraints must be respected.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One-line contract summary.' },
      success_criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'What success looks like.',
      },
      required_evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence the Generator must produce.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Constraints / gotchas to respect.',
      },
    },
    required: ['success_criteria'],
  },
});

/**
 * Generator handoff emitter. Signals that the Generator has finished its
 * execution round and hands off to the Evaluator for verification.
 */
export const emitHandoff: RunnableTool = buildEmitter({
  name: EMIT_HANDOFF_TOOL_NAME,
  role: 'generator',
  description:
    'Emit the Generator handoff to the Evaluator. Call this exactly once when execution is complete ' +
    '(or blocked). The Evaluator will verify against the contract and decide accept / revise / replan.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['ready', 'incomplete', 'blocked'],
        description: 'Execution state at handoff time.',
      },
      summary: { type: 'string', description: 'One-line handoff summary.' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence produced during execution.',
      },
      followup: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required next steps for the Evaluator.',
      },
    },
    required: ['status'],
  },
});

/**
 * Evaluator verdict emitter. Decides the terminal outcome of the round:
 * accept, revise (retry with same harness), or blocked. The Runner-driven
 * engine reads `metadata.payload.verdict.status` to decide next hop.
 */
export const emitVerdict: RunnableTool = buildEmitter({
  name: EMIT_VERDICT_TOOL_NAME,
  role: 'evaluator',
  description:
    'Emit the Evaluator verdict — accept / revise / blocked. Call this exactly once after ' +
    'verification is complete. A `revise` verdict may include `next_harness` to escalate (H1 → H2). ' +
    'When the task is complete, set `user_answer` to the multi-line answer the user should see.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['accept', 'revise', 'blocked'],
        description: 'Verdict outcome.',
      },
      reason: { type: 'string', description: 'One-line reason for the verdict.' },
      user_answer: {
        type: 'string',
        description: 'Multi-line final answer for the user (required when status=accept for H0/H1/H2 final).',
      },
      next_harness: {
        type: 'string',
        enum: ['H1_EXECUTE_EVAL', 'H2_PLAN_EXECUTE_EVAL'],
        description: 'For revise: which harness tier to retry in.',
      },
      followup: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required next steps (may be empty).',
      },
    },
    required: ['status'],
  },
});

/** All four emitter tools, exposed as a tuple for iteration. */
export const PROTOCOL_EMITTER_TOOLS: readonly RunnableTool[] = Object.freeze([
  emitScoutVerdict,
  emitContract,
  emitHandoff,
  emitVerdict,
]);
