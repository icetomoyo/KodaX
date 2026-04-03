import { describe, expect, it } from 'vitest';
import { buildAmaControllerDecision, buildFallbackRoutingDecision } from './reasoning.js';
import {
  applyFanoutBranchTransition,
  buildFanoutSchedulerPlan,
  countActiveFanoutBranches,
  createFanoutSchedulerInput,
  getFanoutBranch,
} from './fanout-scheduler.js';
import type { KodaXChildContextBundle, KodaXParentReductionContract } from './types.js';

function createBundles(count: number): KodaXChildContextBundle[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `finding-${index + 1}`,
    fanoutClass: 'finding-validation',
    objective: `Validate finding ${index + 1}`,
    scopeSummary: `Finding ${index + 1}`,
    evidenceRefs: [`diff:${index + 1}`],
    constraints: ['Read-only'],
    readOnly: true,
  }));
}

function createEvidenceBundles(count: number): KodaXChildContextBundle[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `shard-${index + 1}`,
    fanoutClass: 'evidence-scan',
    objective: `Validate evidence shard ${index + 1}`,
    scopeSummary: `Evidence shard ${index + 1}`,
    evidenceRefs: [`evidence:${index + 1}`],
    constraints: ['Read-only'],
    readOnly: true,
  }));
}

const reductionContract: KodaXParentReductionContract = {
  owner: 'parent',
  strategy: 'evaluator-assisted',
  collapseChildTranscripts: true,
  summary: 'Parent remains the only user-facing authority.',
  requiredArtifacts: ['child-result.json'],
};

describe('fanout scheduler', () => {
  it('respects AMA tactical child budget when scheduling review shards', () => {
    const decision = buildAmaControllerDecision({
      ...buildFallbackRoutingDecision('Please review this diff for merge blockers.'),
      primaryTask: 'review',
      reviewScale: 'large',
      mutationSurface: 'read-only',
      executionPattern: 'checked-direct',
      harnessProfile: 'H0_DIRECT',
      confidence: 0.92,
    });
    const input = createFanoutSchedulerInput(
      decision,
      createBundles(4),
      reductionContract,
    );

    expect(input).toBeDefined();
    const plan = buildFanoutSchedulerPlan(input!);

    expect(plan.enabled).toBe(true);
    expect(plan.maxParallel).toBe(3);
    expect(plan.scheduledBundleIds).toEqual(['finding-1', 'finding-2', 'finding-3']);
    expect(plan.deferredBundleIds).toEqual(['finding-4']);
    expect(plan.mergeStrategy).toBe('evaluator-assisted');
    expect(plan.branches).toEqual([
      { bundleId: 'finding-1', status: 'scheduled' },
      { bundleId: 'finding-2', status: 'scheduled' },
      { bundleId: 'finding-3', status: 'scheduled' },
      {
        bundleId: 'finding-4',
        status: 'deferred',
        reason: 'Deferred by the current AMA fan-out budget.',
      },
    ]);
  });

  it('does not schedule fan-out when the AMA controller keeps the task on a direct path', () => {
    const decision = buildAmaControllerDecision(
      buildFallbackRoutingDecision('Write a concise summary of this small request.'),
    );
    const input = createFanoutSchedulerInput(
      decision,
      createBundles(2),
      reductionContract,
    );

    expect(input).toBeUndefined();
  });

  it('deduplicates repeated bundles before scheduling and preserves overflow as deferred branches', () => {
    const decision = buildAmaControllerDecision({
      ...buildFallbackRoutingDecision('Please review this diff for merge blockers.'),
      primaryTask: 'review',
      reviewScale: 'large',
      mutationSurface: 'read-only',
      executionPattern: 'checked-direct',
      harnessProfile: 'H0_DIRECT',
      confidence: 0.92,
    });
    const duplicateBundles = [...createBundles(4), { ...createBundles(1)[0] }];
    const input = createFanoutSchedulerInput(
      decision,
      duplicateBundles,
      reductionContract,
    );

    expect(input).toBeDefined();
    const plan = buildFanoutSchedulerPlan(input!);

    expect(plan.scheduledBundleIds).toEqual(['finding-1', 'finding-2', 'finding-3']);
    expect(plan.deferredBundleIds).toEqual(['finding-4']);
    expect(plan.branches.map((branch) => branch.bundleId)).toEqual([
      'finding-1',
      'finding-2',
      'finding-3',
      'finding-4',
    ]);
  });

  it('returns a disabled plan when no bundles match the requested fan-out class', () => {
    const decision = buildAmaControllerDecision({
      ...buildFallbackRoutingDecision('Please review this diff for merge blockers.'),
      primaryTask: 'review',
      reviewScale: 'large',
      mutationSurface: 'read-only',
      executionPattern: 'checked-direct',
      harnessProfile: 'H0_DIRECT',
      confidence: 0.92,
    });
    const input = createFanoutSchedulerInput(
      decision,
      [],
      reductionContract,
    );

    expect(input).toBeDefined();
    const plan = buildFanoutSchedulerPlan(input!);

    expect(plan.enabled).toBe(false);
    expect(plan.branches).toEqual([]);
    expect(plan.scheduledBundleIds).toEqual([]);
    expect(plan.deferredBundleIds).toEqual([]);
    expect(plan.reason).toContain('No child bundles matched');
  });

  it('applies lifecycle transitions through a single scheduler reducer', () => {
    const decision = buildAmaControllerDecision({
      ...buildFallbackRoutingDecision('Please review this diff for merge blockers.'),
      primaryTask: 'review',
      reviewScale: 'large',
      mutationSurface: 'read-only',
      executionPattern: 'checked-direct',
      harnessProfile: 'H0_DIRECT',
      confidence: 0.92,
    });
    const input = createFanoutSchedulerInput(
      decision,
      createBundles(3),
      reductionContract,
    );

    expect(input).toBeDefined();
    const initialPlan = buildFanoutSchedulerPlan(input!);
    expect(countActiveFanoutBranches(initialPlan)).toBe(3);

    const assignedPlan = applyFanoutBranchTransition(initialPlan, {
      type: 'assign',
      bundleId: 'finding-1',
      workerId: 'validator-01',
    });
    expect(getFanoutBranch(assignedPlan, 'finding-1')).toEqual(
      expect.objectContaining({
        bundleId: 'finding-1',
        status: 'scheduled',
        workerId: 'validator-01',
      }),
    );
    expect(countActiveFanoutBranches(assignedPlan)).toBe(3);

    const completedPlan = applyFanoutBranchTransition(assignedPlan, {
      type: 'complete',
      bundleId: 'finding-1',
      childId: 'finding-1',
    });
    expect(getFanoutBranch(completedPlan, 'finding-1')).toEqual(
      expect.objectContaining({
        bundleId: 'finding-1',
        status: 'completed',
        childId: 'finding-1',
        workerId: 'validator-01',
      }),
    );
    expect(countActiveFanoutBranches(completedPlan)).toBe(2);

    const cancelledPlan = applyFanoutBranchTransition(completedPlan, {
      type: 'cancel',
      bundleId: 'finding-2',
      reason: 'Cancelled for deterministic test coverage.',
    });
    expect(getFanoutBranch(cancelledPlan, 'finding-2')).toEqual(
      expect.objectContaining({
        bundleId: 'finding-2',
        status: 'cancelled',
        reason: 'Cancelled for deterministic test coverage.',
      }),
    );
    expect(countActiveFanoutBranches(cancelledPlan)).toBe(1);
  });

  it('assigns winner-cancel policy to evidence-scan schedules', () => {
    const decision = buildAmaControllerDecision({
      ...buildFallbackRoutingDecision('Investigate why this read-only bug still happens.'),
      primaryTask: 'bugfix',
      taskFamily: 'investigation',
      executionPattern: 'checked-direct',
      recommendedMode: 'investigation',
      mutationSurface: 'read-only',
      harnessProfile: 'H0_DIRECT',
      confidence: 0.9,
    });
    const input = createFanoutSchedulerInput(
      decision,
      createEvidenceBundles(2),
      reductionContract,
    );

    expect(input).toBeDefined();
    const plan = buildFanoutSchedulerPlan(input!);

    expect(plan.fanoutClass).toBe('evidence-scan');
    expect(plan.cancellationPolicy).toBe('winner-cancel');
  });

  it('fails fast when a lifecycle transition targets an unknown bundle id', () => {
    const decision = buildAmaControllerDecision({
      ...buildFallbackRoutingDecision('Please review this diff for merge blockers.'),
      primaryTask: 'review',
      reviewScale: 'large',
      mutationSurface: 'read-only',
      executionPattern: 'checked-direct',
      harnessProfile: 'H0_DIRECT',
      confidence: 0.92,
    });
    const input = createFanoutSchedulerInput(
      decision,
      createBundles(2),
      reductionContract,
    );

    expect(input).toBeDefined();
    const plan = buildFanoutSchedulerPlan(input!);

    expect(() => applyFanoutBranchTransition(plan, {
      type: 'assign',
      bundleId: 'finding-missing',
      workerId: 'validator-01',
    })).toThrow('Unknown fan-out bundle id: finding-missing');
  });
});
