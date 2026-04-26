/**
 * Auto-reroute middleware (depth escalation + task-family reroute) — CAP-019
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-019-auto-reroute-depth-escalation--task-family-reroute
 *
 * Class 3 (declarable opt-in middleware). Invoked by the judge gates
 * (CAP-017 pre-answer judge, CAP-018 post-tool judge) when the model's
 * trajectory needs adjustment:
 *
 *   - **Depth escalation** — bumps reasoning depth (e.g., L0 → L1) so
 *     the next turn gets more thinking budget.
 *   - **Task-family reroute** — switches `primaryTask` (e.g.,
 *     `review` → `bugfix`) so the next turn loads a different prompt
 *     overlay + provider policy.
 *
 * Counters cap each escalation type at **once per session** — no infinite
 * deepening, no infinite rerouting. The combined `autoFollowUpCount` is
 * also bounded by `autoFollowUpLimit` from `runKodaX` options. When
 * FEATURE_078 lands, depth escalation also clamps to the L1 user ceiling.
 *
 * **`maybeBuildAutoReroutePlan`** is the thin wrapper around
 * `maybeCreateAutoReroutePlan` (in `reasoning.ts`) that swallows reroute
 * planning errors — best-effort, never blocks the run. A failure here
 * just means "no follow-up plan, continue as-is".
 *
 * **`maybeAdvanceAutoReroute`** is the orchestrator: gates by counters
 * and mode, calls `maybeBuildAutoReroutePlan`, on success rebuilds the
 * reasoning execution state via the injected `buildExecutionState`
 * callback (which still lives in `agent.ts` for P2 — see CAP-052), runs
 * the optional `onApply` hook, persists session state, fires
 * `events.onRetry`, and returns the new plan + counters to the caller.
 *
 * **Dependency injection**: `buildExecutionState` is passed in rather
 * than imported because `buildReasoningExecutionState` lives in
 * `agent.ts` and the substrate-side migration (CAP-052) is queued.
 * Keeping this module decoupled from agent.ts via a callback avoids a
 * cycle and lets the substrate executor inject its own resolver in P3.
 *
 * **Default for**: `defaultCodingAgent`, `generatorAgent`.
 *
 * Migration history: extracted from `agent.ts:1076-1104`
 * (`maybeBuildAutoReroutePlan`) and `agent.ts:1156-1246`
 * (`maybeAdvanceAutoReroute`) — pre-FEATURE_100 baseline — during
 * FEATURE_100 P2.
 */

import type { KodaXBaseProvider, KodaXMessage } from '@kodax/ai';

import type { KodaXEvents, KodaXOptions } from '../../types.js';
import { type ReasoningPlan, maybeCreateAutoReroutePlan } from '../../reasoning.js';
import type { RuntimeSessionState } from '../runtime-session-state.js';
import { saveSessionSnapshot } from './session-snapshot.js';

export type AutoReroutePlan = Awaited<ReturnType<typeof maybeCreateAutoReroutePlan>>;

export async function maybeBuildAutoReroutePlan(
  provider: KodaXBaseProvider,
  options: KodaXOptions,
  prompt: string,
  reasoningPlan: ReasoningPlan,
  lastText: string,
  allowances: {
    allowDepthEscalation: boolean;
    allowTaskReroute: boolean;
  },
  toolEvidence?: string,
): Promise<AutoReroutePlan> {
  try {
    return await maybeCreateAutoReroutePlan(
      provider,
      options,
      prompt,
      reasoningPlan,
      lastText,
      allowances,
      toolEvidence ? { toolEvidence } : undefined,
    );
  } catch (rerouteError) {
    if (process.env.KODAX_DEBUG_ROUTING) {
      console.error('[AutoReroute] Failed, continuing without reroute:', rerouteError);
    }
    return null;
  }
}

export interface MaybeAdvanceAutoRerouteParams<TExecutionState> {
  provider: KodaXBaseProvider;
  options: KodaXOptions;
  prompt: string;
  reasoningPlan: ReasoningPlan;
  lastText: string;
  autoFollowUpCount: number;
  autoDepthEscalationCount: number;
  autoTaskRerouteCount: number;
  autoFollowUpLimit: number;
  events: KodaXEvents;
  isNewSession: boolean;
  retryLabelPrefix: string;
  toolEvidence?: string;
  allowTaskReroute?: boolean;
  /**
   * Substrate-side execution-state builder. Injected so this middleware
   * stays decoupled from `buildReasoningExecutionState` (CAP-052) which
   * lives in `agent-runtime/reasoning-plan-entry.ts` since FEATURE_100 P2.
   * The DI shape is preserved even after both modules co-exist in
   * `agent-runtime/` — the cycle that motivated the callback (CAP-019
   * → CAP-052 → CAP-019 indirectly through reroute apply) would
   * still close if the call were direct.
   */
  buildExecutionState: (
    options: KodaXOptions,
    plan: ReasoningPlan,
    isNewSession: boolean,
  ) => Promise<TExecutionState>;
  onApply?: () => Promise<void> | void;
  persistSession?: {
    sessionId: string;
    messages: KodaXMessage[];
    title: string;
    runtimeSessionState?: RuntimeSessionState;
  };
}

export interface AutoRerouteAdvanceResult<TExecutionState> {
  reasoningPlan: ReasoningPlan;
  currentExecution: TExecutionState;
  autoFollowUpCount: number;
  autoDepthEscalationCount: number;
  autoTaskRerouteCount: number;
}

export async function maybeAdvanceAutoReroute<TExecutionState>(
  params: MaybeAdvanceAutoRerouteParams<TExecutionState>,
): Promise<AutoRerouteAdvanceResult<TExecutionState> | null> {
  if (
    params.reasoningPlan.mode !== 'auto'
    || params.autoFollowUpCount >= params.autoFollowUpLimit
    || (params.autoDepthEscalationCount > 0 && params.autoTaskRerouteCount > 0)
  ) {
    return null;
  }

  const followUpPlan = await maybeBuildAutoReroutePlan(
    params.provider,
    params.options,
    params.prompt,
    params.reasoningPlan,
    params.lastText,
    {
      allowDepthEscalation: params.autoDepthEscalationCount === 0,
      allowTaskReroute: (params.allowTaskReroute ?? true) && params.autoTaskRerouteCount === 0,
    },
    params.toolEvidence,
  );

  if (!followUpPlan) {
    return null;
  }

  const autoFollowUpCount = params.autoFollowUpCount + 1;
  const autoDepthEscalationCount =
    params.autoDepthEscalationCount + (followUpPlan.kind === 'depth-escalation' ? 1 : 0);
  const autoTaskRerouteCount =
    params.autoTaskRerouteCount + (followUpPlan.kind === 'task-reroute' ? 1 : 0);
  const currentExecution = await params.buildExecutionState(
    params.options,
    followUpPlan,
    params.isNewSession,
  );

  await params.onApply?.();

  if (params.persistSession) {
    await saveSessionSnapshot(params.options, params.persistSession.sessionId, {
      messages: params.persistSession.messages,
      title: params.persistSession.title,
      runtimeSessionState: params.persistSession.runtimeSessionState,
    });
  }

  params.events.onRetry?.(
    `${
      followUpPlan.kind === 'depth-escalation'
        ? `${params.retryLabelPrefix} depth escalation`
        : `${params.retryLabelPrefix} reroute`
    }: ${followUpPlan.decision.reason}`,
    autoFollowUpCount,
    params.autoFollowUpLimit,
  );

  return {
    reasoningPlan: followUpPlan,
    currentExecution,
    autoFollowUpCount,
    autoDepthEscalationCount,
    autoTaskRerouteCount,
  };
}
