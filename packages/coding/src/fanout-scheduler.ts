import type {
  KodaXAmaControllerDecision,
  KodaXChildContextBundle,
  KodaXFanoutBranchTransition,
  KodaXFanoutBranchRecord,
  KodaXFanoutSchedulerInput,
  KodaXFanoutSchedulerPlan,
  KodaXParentReductionContract,
} from './types.js';

function dedupeBundles(
  bundles: KodaXChildContextBundle[],
): KodaXChildContextBundle[] {
  const seen = new Set<string>();
  const unique: KodaXChildContextBundle[] = [];
  for (const bundle of bundles) {
    if (seen.has(bundle.id)) {
      continue;
    }
    seen.add(bundle.id);
    unique.push(bundle);
  }
  return unique;
}

export function createFanoutSchedulerInput(
  controllerDecision: KodaXAmaControllerDecision,
  bundles: KodaXChildContextBundle[],
  reductionContract: KodaXParentReductionContract,
): KodaXFanoutSchedulerInput | undefined {
  if (!controllerDecision.fanout.admissible || !controllerDecision.fanout.class) {
    return undefined;
  }
  return {
    profile: controllerDecision.profile,
    fanoutClass: controllerDecision.fanout.class,
    maxChildren: controllerDecision.fanout.maxChildren,
    bundles,
    reductionStrategy: reductionContract.strategy,
  };
}

export function buildFanoutSchedulerPlan(
  input: KodaXFanoutSchedulerInput,
): KodaXFanoutSchedulerPlan {
  const uniqueBundles = dedupeBundles(
    input.bundles.filter((bundle) => bundle.fanoutClass === input.fanoutClass),
  );
  if (uniqueBundles.length === 0) {
    return {
      enabled: false,
      profile: input.profile,
      fanoutClass: input.fanoutClass,
      branches: [],
      scheduledBundleIds: [],
      deferredBundleIds: [],
      maxParallel: 1,
      mergeStrategy: input.reductionStrategy,
      cancellationPolicy: 'none',
      reason: 'No child bundles matched the requested fan-out class.',
    };
  }

  const requestedChildren = input.maxChildren && input.maxChildren > 0
    ? input.maxChildren
    : uniqueBundles.length;
  const scheduledBundles = uniqueBundles.slice(0, requestedChildren);
  const deferredBundles = uniqueBundles.slice(scheduledBundles.length);
  const branches: KodaXFanoutBranchRecord[] = [
    ...scheduledBundles.map((bundle) => ({
      bundleId: bundle.id,
      status: 'scheduled' as const,
    })),
    ...deferredBundles.map((bundle) => ({
      bundleId: bundle.id,
      status: 'deferred' as const,
      reason: 'Deferred by the current AMA fan-out budget.',
    })),
  ];
  const maxParallel = Math.max(
    1,
    Math.min(scheduledBundles.length, requestedChildren),
  );

  return {
    enabled: scheduledBundles.length > 0,
    profile: input.profile,
    fanoutClass: input.fanoutClass,
    branches,
    scheduledBundleIds: scheduledBundles.map((bundle) => bundle.id),
    deferredBundleIds: deferredBundles.map((bundle) => bundle.id),
    maxParallel,
    mergeStrategy: input.reductionStrategy,
    cancellationPolicy: 'none',
    reason: deferredBundles.length > 0
      ? `Scheduled ${scheduledBundles.length} child bundles and deferred ${deferredBundles.length} to stay within the current AMA fan-out budget.`
      : `Scheduled ${scheduledBundles.length} child bundles for ${input.fanoutClass}.`,
  };
}

export function getFanoutBranch(
  plan: KodaXFanoutSchedulerPlan,
  bundleId: string,
): KodaXFanoutBranchRecord {
  const branch = plan.branches.find((candidate) => candidate.bundleId === bundleId);
  if (!branch) {
    throw new Error(`Unknown fan-out bundle id: ${bundleId}`);
  }
  return branch;
}

export function countActiveFanoutBranches(
  plan: KodaXFanoutSchedulerPlan,
): number {
  return plan.branches.filter((branch) => branch.status === 'scheduled').length;
}

export function applyFanoutBranchTransition(
  plan: KodaXFanoutSchedulerPlan,
  transition: KodaXFanoutBranchTransition,
): KodaXFanoutSchedulerPlan {
  const branch = getFanoutBranch(plan, transition.bundleId);

  return {
    ...plan,
    branches: plan.branches.map((candidate) => {
      if (candidate.bundleId !== transition.bundleId) {
        return candidate;
      }

      switch (transition.type) {
        case 'assign':
          return {
            ...branch,
            workerId: transition.workerId,
          };
        case 'complete':
          return {
            ...branch,
            status: 'completed',
            childId: transition.childId ?? branch.childId,
            reason: undefined,
          };
        case 'cancel':
          return {
            ...branch,
            status: 'cancelled',
            reason: transition.reason,
          };
        default: {
          const exhaustive: never = transition;
          return exhaustive;
        }
      }
    }),
  };
}

export function assignFanoutBranchWorker(
  plan: KodaXFanoutSchedulerPlan,
  bundleId: string,
  workerId: string,
): KodaXFanoutSchedulerPlan {
  return applyFanoutBranchTransition(plan, {
    type: 'assign',
    bundleId,
    workerId,
  });
}

export function markFanoutBranchCompleted(
  plan: KodaXFanoutSchedulerPlan,
  bundleId: string,
  childId?: string,
): KodaXFanoutSchedulerPlan {
  return applyFanoutBranchTransition(plan, {
    type: 'complete',
    bundleId,
    childId,
  });
}

export function markFanoutBranchCancelled(
  plan: KodaXFanoutSchedulerPlan,
  bundleId: string,
  reason: string,
): KodaXFanoutSchedulerPlan {
  return applyFanoutBranchTransition(plan, {
    type: 'cancel',
    bundleId,
    reason,
  });
}
