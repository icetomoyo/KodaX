/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction (Slice 6)
 *
 * Managed-task budget controller extracted from task-engine.ts. Zero-behavior-change
 * move. The single state shape `ManagedTaskBudgetController` is exported so
 * task-engine.ts can continue to declare parameters of that type.
 *
 * The controller is intentionally a plain mutable object (not a class): FEATURE_062
 * simplified the budget model to `totalBudget + spentBudget + harness state` and
 * 4 pure functions (`create`, `increment`, `extend`, `remaining`). Keeping the
 * shape as data rather than a class is consistent with the rest of the code base
 * and lets the controller be passed around as a record.
 */

import {
  DEFAULT_MANAGED_WORK_BUDGET,
  GLOBAL_WORK_BUDGET_APPROVAL_THRESHOLD,
  GLOBAL_WORK_BUDGET_INCREMENT,
} from '../constants.js';
import { truncateText } from '../text-utils.js';
import type { ReasoningPlan } from '../../../reasoning.js';
import type {
  KodaXAgentMode,
  KodaXBudgetDisclosureZone,
  KodaXEvents,
  KodaXManagedBudgetSnapshot,
  KodaXManagedTask,
  KodaXManagedTaskStatusEvent,
  KodaXOptions,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
} from '../../../types.js';

/**
 * FEATURE_062 simplified budget state. Four fields: the total cap, the amount
 * spent, the currently-active harness, and an optional upgrade ceiling. Plus a
 * last-approval stamp used by `maybeRequestAdditionalWorkBudget` to avoid
 * re-prompting when the controller state hasn't changed.
 */
export interface ManagedTaskBudgetController {
  totalBudget: number;
  spentBudget: number;
  currentHarness: KodaXTaskRoutingDecision['harnessProfile'];
  upgradeCeiling?: KodaXTaskRoutingDecision['harnessProfile'];
  lastApprovalBudgetTotal?: number;
}

/**
 * Default budget cap per harness profile. H0 is 50 units (direct Scout
 * completion is cheap); H1/H2 both default to DEFAULT_MANAGED_WORK_BUDGET.
 */
const MANAGED_TASK_BUDGET_BASE: Record<KodaXTaskRoutingDecision['harnessProfile'], number> = {
  H0_DIRECT: 50,
  H1_EXECUTE_EVAL: DEFAULT_MANAGED_WORK_BUDGET,
  H2_PLAN_EXECUTE_EVAL: DEFAULT_MANAGED_WORK_BUDGET,
};

export function createManagedBudgetController(
  _options: KodaXOptions,
  plan: ReasoningPlan,
  agentMode: KodaXAgentMode,
): ManagedTaskBudgetController {
  const isH0 = agentMode !== 'ama' || plan.decision.harnessProfile === 'H0_DIRECT';
  return {
    totalBudget: isH0 ? MANAGED_TASK_BUDGET_BASE.H0_DIRECT : MANAGED_TASK_BUDGET_BASE[plan.decision.harnessProfile],
    spentBudget: 0,
    currentHarness: isH0 ? 'H0_DIRECT' : plan.decision.harnessProfile,
    upgradeCeiling: isH0 ? undefined : plan.decision.upgradeCeiling,
  };
}

// FEATURE_062: Simplified snapshot — zone derived from used/cap ratio, no per-role iter limits.
export function createBudgetSnapshot(
  controller: ManagedTaskBudgetController,
  harness: KodaXTaskRoutingDecision['harnessProfile'],
  round: number,
  role: KodaXTaskRole | undefined,
  workerId?: string,
): KodaXManagedBudgetSnapshot {
  const remaining = Math.max(0, controller.totalBudget - controller.spentBudget);
  const pct = controller.totalBudget > 0 ? controller.spentBudget / controller.totalBudget : 0;
  const zone: KodaXBudgetDisclosureZone = pct < 0.7 ? 'green' : pct < 0.85 ? 'yellow' : pct < 0.95 ? 'orange' : 'red';
  return {
    totalBudget: controller.totalBudget,
    reserveBudget: 0,
    reserveRemaining: 0,
    upgradeReserveBudget: 0,
    upgradeReserveRemaining: 0,
    plannedRounds: 1,
    currentRound: round,
    spentBudget: controller.spentBudget,
    remainingBudget: remaining,
    workerId,
    role,
    currentHarness: controller.currentHarness || harness,
    upgradeCeiling: controller.upgradeCeiling,
    zone,
    showExactRoundCounter: zone === 'orange' || zone === 'red',
    allowExtensionRequest: zone === 'orange' || zone === 'red',
    mustConverge: zone === 'red',
    softMaxIter: remaining,
    hardMaxIter: remaining,
  };
}

export function applyManagedBudgetRuntimeState(
  runtime: KodaXManagedTask['runtime'] | undefined,
  controller: ManagedTaskBudgetController,
  budgetApprovalRequired = false,
): NonNullable<KodaXManagedTask['runtime']> {
  return {
    ...(runtime ?? {}),
    currentHarness: controller.currentHarness,
    upgradeCeiling: controller.upgradeCeiling,
    globalWorkBudget: controller.totalBudget,
    budgetUsage: controller.spentBudget,
    budgetApprovalRequired,
  };
}

export function buildManagedStatusBudgetFields(
  controller: ManagedTaskBudgetController | undefined,
  budgetApprovalRequired = false,
): Pick<KodaXManagedTaskStatusEvent, 'globalWorkBudget' | 'budgetUsage' | 'budgetApprovalRequired'> {
  return {
    globalWorkBudget: controller?.totalBudget,
    budgetUsage: controller?.spentBudget,
    budgetApprovalRequired,
  };
}

export function incrementManagedBudgetUsage(
  controller: ManagedTaskBudgetController,
  amount = 1,
): void {
  controller.spentBudget = Math.max(0, controller.spentBudget + amount);
}

export function resolveRemainingManagedWorkBudget(controller: ManagedTaskBudgetController): number {
  return Math.max(1, controller.totalBudget - controller.spentBudget);
}

// FEATURE_062: Simplified — just add iterations to the cap.
export function extendManagedWorkBudget(
  controller: ManagedTaskBudgetController,
  additionalUnits = GLOBAL_WORK_BUDGET_INCREMENT,
): void {
  controller.totalBudget += additionalUnits;
}

export async function maybeRequestAdditionalWorkBudget(
  events: KodaXEvents | undefined,
  controller: ManagedTaskBudgetController,
  context: {
    summary: string;
    currentRound: number;
    maxRounds: number;
    originalTask?: string;
    /**
     * Per-harness extension amount. Defaults to the legacy
     * `GLOBAL_WORK_BUDGET_INCREMENT` (200) so behaviour is unchanged for
     * callers that don't care. Runner-driven path passes harness-specific
     * values (H0 -> +100, H1/H2 -> +200) matching the tiered cap model.
     */
    additionalUnits?: number;
  },
): Promise<'approved' | 'denied' | 'skipped'> {
  if (!events?.askUser) {
    return 'skipped';
  }

  const threshold = Math.ceil(controller.totalBudget * GLOBAL_WORK_BUDGET_APPROVAL_THRESHOLD);
  if (controller.spentBudget < threshold) {
    return 'skipped';
  }
  if (controller.lastApprovalBudgetTotal === controller.totalBudget) {
    return 'skipped';
  }

  const increment = context.additionalUnits ?? GLOBAL_WORK_BUDGET_INCREMENT;
  const usedPercent = Math.min(100, Math.round((controller.spentBudget / Math.max(1, controller.totalBudget)) * 100));
  const useChinese = /[\u4e00-\u9fff]/.test(context.originalTask ?? context.summary);
  const choice = await events.askUser({
    question: useChinese
      ? `当前 AMA 运行已使用 ${controller.spentBudget}/${controller.totalBudget} 工作单元（${usedPercent}%），需要更多工作量。是否追加 ${increment} 单元？`
      : `This AMA run has used ${controller.spentBudget}/${controller.totalBudget} work units (${usedPercent}%) and needs more work. Add ${increment} more work units?`,
    options: [
      {
        label: useChinese ? `继续 (+${increment})` : `Continue (+${increment})`,
        value: 'continue',
        description: useChinese
          ? `追加 ${increment} 工作单元，从第 ${context.currentRound}/${context.maxRounds} 轮继续。`
          : `Grant ${increment} more work units and continue from round ${context.currentRound}/${context.maxRounds}.`,
      },
      {
        label: useChinese ? '停止' : 'Stop here',
        value: 'stop',
        description: useChinese
          ? `使用当前最佳结果。最新进展：${truncateText(context.summary, 80)}`
          : `Finish now with the current best result. Latest note: ${truncateText(context.summary, 80)}`,
      },
    ],
    default: 'continue',
  });

  const promptedBudgetTotal = controller.totalBudget;
  if (choice === 'continue') {
    controller.lastApprovalBudgetTotal = promptedBudgetTotal;
    extendManagedWorkBudget(controller, increment);
    return 'approved';
  }
  controller.lastApprovalBudgetTotal = promptedBudgetTotal;
  return 'denied';
}

// FEATURE_062: Simplified budget hint based on used/cap ratio.
export function formatBudgetHint(snapshot: KodaXManagedBudgetSnapshot | undefined): string | undefined {
  if (!snapshot || snapshot.totalBudget <= 0) {
    return undefined;
  }
  const pct = snapshot.spentBudget / snapshot.totalBudget;
  if (pct >= 0.85) {
    return `[Budget] ${snapshot.remainingBudget} iterations remaining. Produce a complete result now.`;
  }
  if (pct >= 0.7) {
    return '[Budget] Begin converging. Reduce exploration, organize completion path.';
  }
  return undefined;
}
