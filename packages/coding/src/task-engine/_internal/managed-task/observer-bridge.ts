

import type {
  KodaXEvents,
  KodaXHarnessProfile,
  KodaXManagedTaskPhase,
  KodaXResult,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskStatus,
} from '../../../types.js';
import type { ReasoningPlan } from '../../../reasoning.js';
import {
  buildManagedStatusBudgetFields,
  type ManagedTaskBudgetController,
} from './budget.js';
import {
  DEFAULT_MANAGED_WORK_BUDGET,
  GLOBAL_WORK_BUDGET_INCREMENT,
} from '../constants.js';
import type { ObserverBridge } from './types.js';

/**
 * Managed-task work-budget cap, in LLM-turn units. Each role emit + each
 * coding-tool invocation consumes one unit (via `incrementManagedBudgetUsage`);
 * the 90%-utilization extension dialog tops it up on demand.
 *
 * Reasoning single-tracking: the former per-harness tiered Records
 * (`BUDGET_CAP_BY_HARNESS` H0=100/H1=H2=200, `BUDGET_EXTENSION_BY_HARNESS`,
 * `MAX_ROUNDS_BY_HARNESS`) collapsed to single constants. Once FEATURE_114's
 * V2 single-loop made every fresh run start at PLANNED, the H0/H1/H2 tiers no
 * longer selected different agent topologies — they were *only* budget tiers,
 * and the differentiation only stayed reachable via the resume path (a latent
 * fresh-vs-resume inconsistency: a fresh run executes at PLANNED=200/8 but
 * recorded its routing tier H0/H1, so resume diverged downward to 100/1 or
 * 200/6). Collapsing removes that obsolete divergence so resume matches fresh.
 * claudecode likewise has no per-complexity budget table — this matches its
 * single-cap model.
 */
export const MANAGED_WORK_BUDGET_CAP = DEFAULT_MANAGED_WORK_BUDGET;

/**
 * Budget granted each time the user approves the 90%-threshold extension
 * dialog. Single constant for the same reason as `MANAGED_WORK_BUDGET_CAP`.
 */
export const MANAGED_WORK_BUDGET_EXTENSION = GLOBAL_WORK_BUDGET_INCREMENT;

/**
 * Display-name mapping for each role. The REPL UI renders this as the
 * status-line label (e.g. "[Scout] Thinking..."). Keys are lowercase role
 * ids; values are the capitalised titles the legacy path used.
 */
const ROLE_TO_TITLE: Record<KodaXTaskRole, string> = {
  scout: 'Scout',
  planner: 'Planner',
  generator: 'Generator',
  evaluator: 'Evaluator',
  direct: 'Direct',
  // FEATURE_114 v0.7.36 — AMA Harness V2 single-loop role.
  worker: 'Worker',
};

/**
 * Max-rounds hint for progress reporting only. The Runner.run inner loop caps
 * per-agent tool iterations at `MAX_TOOL_LOOP_ITERATIONS` (20); this value is
 * the role-chain length upper bound rendered as the "round i of N" denominator
 * (and auto-grows by 1 on each approved budget extension). It does NOT cap
 * work — the actual ceiling is the LLM loop + budget controller. Collapsed
 * from the per-harness `MAX_ROUNDS_BY_HARNESS` Record (see
 * `MANAGED_WORK_BUDGET_CAP` for the rationale); PLANNED's 8 is the canonical
 * value every run (fresh + resume) now uses.
 */
export const MANAGED_MAX_ROUNDS = 8;

/**
 * Shard 6d-R: derive a per-role evidence entry at emit time. Legacy
 * `task-engine.ts` kept an append-only `evidence.entries[]` list so
 * downstream consumers (`buildManagedTaskRoundHistory`, resume flow,
 * REPL transcript dump) could reconstruct per-round role history.
 *
 * Status mapping:
 *   - scout / planner / direct → 'completed' (always terminal for their turn)
 *   - generator → derived from handoff.status (ready→completed,
 *                 incomplete→running, blocked→blocked)
 *   - evaluator → derived from verdict.status (accept→completed,
 *                 revise→running, blocked→blocked)
 *
 * Signal + reason are only populated on the final-emitter roles
 * (evaluator/direct) because those are the only turns that carry a
 * user-observable `COMPLETE | BLOCKED | DECIDE` signal.
 */
function buildEvidenceEntryForRoleEmit(args: {
  readonly role: KodaXTaskRole;
  readonly round: number;
  readonly sessionId: string | undefined;
}): KodaXTaskEvidenceEntry {
  const { role, round, sessionId } = args;
  let status: KodaXTaskStatus = 'completed';
  let summary: string | undefined;
  let signal: KodaXTaskEvidenceEntry['signal'];
  let signalReason: string | undefined;
  // FEATURE_193 (v0.7.43): scout / planner / generator role branches removed —
  // V1 chain retired, those roles never reach onRoleEmit on the V2 path.
  // The 'direct' branch is retained for the H0_DIRECT execution path which
  // still publishes a direct-completion summary even though V1 Scout no
  // longer drives it.
  if (role === 'direct') {
    // FEATURE_193 (v0.7.43): H0_DIRECT direct-completion path. The
    // V1 `recorder.scout?.payload.scout?.summary` source was removed
    // along with the scout slot; remaining H0_DIRECT traces fire with
    // `summary: undefined` + `signal: COMPLETE`.
    signal = 'COMPLETE';
  }
  return {
    assignmentId: role,
    role,
    status,
    title: ROLE_TO_TITLE[role],
    round,
    summary,
    sessionId,
    signal,
    signalReason,
  };
}

/**
 * Emit `KodaXManagedTaskStatusEvent` with the full field set legacy
 * consumers (REPL UI, CLI JSON events, observability) depend on.
 *
 * Fields populated:
 *   - agentMode / harnessProfile — static for the run (harness updated on
 *     Scout emit)
 *   - phase / activeWorkerId / activeWorkerTitle — the canonical trio
 *   - currentRound / maxRounds — progress indicator
 *   - upgradeCeiling — same as harness (Runner path does not observe
 *     mid-run ceiling changes beyond Scout commitment)
 *   - globalWorkBudget / budgetUsage / budgetApprovalRequired — via
 *     `buildManagedStatusBudgetFields`
 *   - note / detailNote — short status label + optional long-form detail
 *     (detailNote comes from the recorder's most-recent payload summary
 *     when available)
 *   - persistToHistory — `true` for terminal events (completed / blocked)
 *     and `false` for transient progress ticks (REPL ledger contract)
 *   - events[] — inline live-event list, currently one entry per observer
 *     tick so the REPL ticker has something to render
 */
/**
 * H3 routing-note builder. Emitted once before Scout's preflight so the
 * REPL work-strip can label the task's routing context (review target,
 * review scale, routing override reason). The
 * Runner-driven path doesn't have `repoRoutingSignals` in plan (those
 * were computed by the legacy planner earlier); we fall back to the
 * decision fields plan surfaces directly.
 */
export function buildRunnerRoutingNote(plan: ReasoningPlan): string {
  const detailParts: string[] = [];
  const decision = plan.decision;
  const reviewScale = decision.reviewScale ? ` (${decision.reviewScale})` : '';
  if (decision.reviewTarget) {
    detailParts.push(`${decision.reviewTarget}${reviewScale}`);
  }
  if (decision.routingSource && decision.routingSource !== 'model') {
    detailParts.push(`routing=${decision.routingSource}`);
  }
  if (decision.routingAttempts && decision.routingAttempts > 1) {
    detailParts.push(`attempts=${decision.routingAttempts}`);
  }
  return detailParts.length > 0
    ? `AMA routing · ${detailParts.join(' · ')}`
    : 'AMA routing';
}

export function buildObserverBridge(
  events: KodaXEvents | undefined,
  harnessRef: { current: KodaXHarnessProfile },
  rolesRef: { emitted: KodaXTaskRole[] },
  budget: ManagedTaskBudgetController,
  roundRef: { current: number },
  maxRoundsRef: { current: number },
  budgetApprovalRef: { current: boolean },
  entriesRef: { items: KodaXTaskEvidenceEntry[] },
  sessionIdRef: { current: string | undefined },
  checkpointWriter?: (role: KodaXTaskRole) => void,
): ObserverBridge {
  const emit = (partial: {
    phase: KodaXManagedTaskPhase;
    activeWorkerId?: string;
    activeWorkerTitle?: string;
    note?: string;
    detailNote?: string;
    persistToHistory?: boolean;
  }): void => {
    if (!events?.onManagedTaskStatus) return;
    const harness = harnessRef.current;
    events.onManagedTaskStatus({
      agentMode: 'ama',
      harnessProfile: harness,
      currentRound: roundRef.current,
      maxRounds: maxRoundsRef.current,
      upgradeCeiling: harness,
      ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
      ...partial,
    });
  };
  return {
    preflight: () => {
      // FEATURE_193 v0.7.43: V1 chain retired — preflight always labels Worker.
      emit({
        phase: 'preflight',
        activeWorkerId: 'worker',
        activeWorkerTitle: ROLE_TO_TITLE.worker,
        note: 'Worker analyzing task',
        persistToHistory: false,
      });
    },
    onRoleEmit: (role) => {
      rolesRef.emitted.push(role);
      roundRef.current += 1;
      const detail = undefined;
      // Shard 6d-R: accumulate `evidence.entries[]` per-turn. Mirrors legacy
      // `task-engine.ts` behaviour where each role completion appended a
      // `KodaXTaskEvidenceEntry` to the managed task's evidence bundle so
      // downstream consumers (`buildManagedTaskRoundHistory`, the REPL's
      // transcript dump, resume flow) could reconstruct per-round history.
      entriesRef.items.push(
        buildEvidenceEntryForRoleEmit({
          role,
          round: roundRef.current,
          sessionId: sessionIdRef.current,
        }),
      );
      emit({
        // Emit `worker` (not `round`) so the REPL's
        // `isForegroundManagedStreamingStatus` recognizes this as an
        // active worker turn and routes onProviderRecovery / onRetry into
        // the managed foreground layer (legacy task-engine.ts:~3752 also
        // emits `phase: 'worker'` per role activation). Without this,
        // `managedForegroundOwnerRef.current.workerId` is never set and
        // recovery / retry messages render below the user prompt instead
        // of inline with the worker output.
        phase: 'worker',
        activeWorkerId: role,
        activeWorkerTitle: ROLE_TO_TITLE[role],
        note: `${ROLE_TO_TITLE[role]} completed a turn`,
        detailNote: detail,
        persistToHistory: false,
      });
      if (checkpointWriter) checkpointWriter(role);
    },
    completed: (signal: KodaXResult['signal'], reason?: string) =>
      emit({
        phase: 'completed',
        note: signal === 'BLOCKED' ? 'Task blocked' : 'Task completed',
        detailNote: reason,
        persistToHistory: true,
      }),
    notifyBudgetApprovalRequest: () => {
      budgetApprovalRef.current = true;
      emit({
        phase: 'round',
        note: 'Awaiting budget extension approval',
        persistToHistory: false,
      });
    },
    notifyChildFanout: (fanoutClass, count) => {
      if (!events?.onManagedTaskStatus) return;
      // v0.7.26 parity (C2): do NOT set activeWorkerId:'child' here.
      // FEATURE_067 already learned (types.ts:1170) that an activeWorkerId
      // transition to 'child' triggers a foreground worker switch in the
      // REPL, which clears all live tool calls for the actual worker that
      // dispatched the children. Keep the active worker unchanged; use
      // `childFanoutClass` + `childFanoutCount` purely as decoration.
      events.onManagedTaskStatus({
        agentMode: 'ama',
        harnessProfile: harnessRef.current,
        currentRound: roundRef.current,
        maxRounds: maxRoundsRef.current,
        upgradeCeiling: harnessRef.current,
        phase: 'worker',
        childFanoutClass: fanoutClass,
        childFanoutCount: count ?? 1,
        note: `Dispatching ${fanoutClass} child task`,
        persistToHistory: false,
        ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
      });
    },
    idleWaiting: (role, pendingCount) => {
      if (!events?.onManagedTaskStatus) return;
      // FEATURE_156 — keep the activeWorker identity on whoever just
      // parked (today always Worker, but the wiring is agent-agnostic to
      // avoid hardcoding the V2-only invariant — see Step 0 of
      // FEATURE_120 docs for the future migration that could open this
      // path to additional roles). `idleWaiting=true` distinguishes the
      // alive-suspended sub-state from active execution; consumers
      // branch on that flag, not on a new phase value.
      //
      // `phase` is generic 'worker' (the existing "an agent is doing
      // work" phase used by every per-role emit at line ~1527, NOT the
      // V2-specific Worker role) — keeps the same fallback display
      // path other phases use. The role identity carries through
      // `activeWorkerId` / `activeWorkerTitle`, so any future role
      // arriving at this branch surfaces with the correct label
      // without a phase-enum change.
      const resolvedTitle = role ? ROLE_TO_TITLE[role] : undefined;
      events.onManagedTaskStatus({
        agentMode: 'ama',
        harnessProfile: harnessRef.current,
        currentRound: roundRef.current,
        maxRounds: maxRoundsRef.current,
        upgradeCeiling: harnessRef.current,
        phase: 'worker',
        activeWorkerId: role,
        activeWorkerTitle: resolvedTitle,
        idleWaiting: true,
        idleWaitingPendingCount: pendingCount,
        note:
          pendingCount > 0
            ? `${resolvedTitle ?? 'Agent'} idle — waiting for ${pendingCount} child task${pendingCount === 1 ? '' : 's'}`
            : `${resolvedTitle ?? 'Agent'} idle — resuming`,
        persistToHistory: false,
        ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
      });
    },
    agentSwitched: (role) => {
      // FEATURE_166 (v0.7.41 follow-up) — emit a lightweight status
      // event so the REPL flips `activeWorkerTitle` ahead of the new
      // agent's first streaming output.
      //
      // Pure UI label flip. Compared to `onRoleEmit`:
      //   - NO recorder mutation (slot stays driven by the
      //     authoritative emit_* tool path)
      //   - NO budget-extension dialog (no slot-success boundary
      //     crossed here)
      //   - NO checkpoint write (handoff_taken invariant + lineage
      //     entries handled by the agent runtime's handoff path)
      //   - NO evidence entry (those are slot-emission anchored)
      //   - `persistToHistory: false` mirrors `idleWaiting` — this
      //     is transient REPL state, not a lineage milestone
      //
      // When `role` is undefined (unmapped agent name), skip rather
      // than overwrite the existing label with a fallback — the
      // ObserverBridge contract says the consumer leaves the label
      // untouched in that case.
      if (!events?.onManagedTaskStatus) return;
      if (!role) return;
      events.onManagedTaskStatus({
        agentMode: 'ama',
        harnessProfile: harnessRef.current,
        currentRound: roundRef.current,
        maxRounds: maxRoundsRef.current,
        upgradeCeiling: harnessRef.current,
        phase: 'worker',
        activeWorkerId: role,
        activeWorkerTitle: ROLE_TO_TITLE[role],
        note: `${ROLE_TO_TITLE[role]} taking over`,
        persistToHistory: false,
        ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
      });
    },
    stallSidecarFired: (info) => {
      // FEATURE_187 Phase C (v0.7.43) — opt-in stall sidecar
      // observability. Gated upstream by `KODAX_STALL_LOG=1` (check
      // happens inside the stall-sidecar middleware factory's
      // `onVerdict` callback because stall verdicts arrive async; the
      // factory is the synchronous moment when the env check runs).
      // Persist one user-visible note in the Worker phase.
      if (!events?.onManagedTaskStatus) return;
      const sourceTag = info.source === 'explicit-env' ? 'env' : 'inherit';
      const modelLabel = info.model ?? '(default)';
      emit({
        phase: 'worker',
        note: `[Stall Sidecar] isStuck=${info.isStuck} · ${info.providerName}/${modelLabel} (${sourceTag}) · ${info.elapsedMs}ms · ${info.trace}`,
        persistToHistory: true,
      });
    },
  };
}

/**
 * No-op observer used by test paths and the agent-chain builder's
 * default parameter. All eight methods are silent — no events, no side
 * effects.
 */
export const NULL_OBSERVER: ObserverBridge = {
  preflight: () => undefined,
  onRoleEmit: () => undefined,
  completed: () => undefined,
  notifyBudgetApprovalRequest: () => undefined,
  notifyChildFanout: () => undefined,
  idleWaiting: () => undefined,
  agentSwitched: () => undefined,
  stallSidecarFired: () => undefined,
};
