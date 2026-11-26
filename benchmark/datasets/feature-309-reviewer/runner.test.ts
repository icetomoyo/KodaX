import { describe, expect, it } from 'vitest';

import { LEARNING_REVIEW_SYSTEM_PROMPT, LEARNING_REVIEW_TOOL } from '../../../packages/coding/src/learning-reviewer.js';
import { hashOf } from '../feature-308-reflect/experiment-contract.js';
import { FEATURE_309_REVIEWER_CASES } from './cases.js';
import { REVIEWER_ARM_A_SHA256, REVIEWER_BUDGET, REVIEWER_CASES_SHA256 } from './experiment-contract.js';
import { armAHash, buildRequest, plannedCells, prepareCells, skillDecision } from './runner.js';

const caseById = (id: string) => FEATURE_309_REVIEWER_CASES.find((item) => item.id === id)!;

describe('feature-309 reviewer A/B', () => {
  it('pins the cases and the frozen arm A', () => {
    expect(hashOf(FEATURE_309_REVIEWER_CASES)).toBe(REVIEWER_CASES_SHA256);
    expect(armAHash()).toBe(REVIEWER_ARM_A_SHA256);
  });

  it('plans the budgeted cell counts', () => {
    expect(plannedCells('pilot')).toHaveLength(REVIEWER_BUDGET.pilotCalls);
    expect(plannedCells('full')).toHaveLength(REVIEWER_BUDGET.fullCalls);
    expect(REVIEWER_BUDGET.pilotCalls + REVIEWER_BUDGET.fullCalls).toBeLessThanOrEqual(REVIEWER_BUDGET.maxProviderCalls);
  });

  it('sends arm B exactly the production prompt and tool', async () => {
    const request = await buildRequest(caseById('m1'), 'B');
    expect(request.systemPrompt).toBe(LEARNING_REVIEW_SYSTEM_PROMPT);
    expect(request.tools).toEqual([LEARNING_REVIEW_TOOL]);
    expect(JSON.parse(request.userMessage).evidence.qualification).toEqual({
      reusableMethodEvidence: true, independentEpisodeCount: 2, verifiedOutcome: true, failedWithLesson: false,
    });
  });

  it('sends arm A the old prompt, tool and input fields', async () => {
    const request = await buildRequest(caseById('m2'), 'A');
    expect(request.systemPrompt).not.toBe(LEARNING_REVIEW_SYSTEM_PROMPT);
    expect(Object.keys((request.tools[0]!.input_schema as { properties: object }).properties)).toContain('capabilityDecision');
    const evidence = JSON.parse(request.userMessage).evidence;
    expect(Object.keys(evidence)).toEqual(['outcomeDigest', 'exactInvokedSkill', 'verifierFacts', 'priorDigests', 'qualification']);
    expect(evidence.qualification.explicitSkillPreservation).toBe(true);
    expect(evidence.qualification.exactSkillInvoked).toBe(false);
  });

  it('gives each case one input per arm, shared across aliases and repetitions', async () => {
    const cells = await prepareCells('full');
    const hashes = new Map<string, Set<string>>();
    for (const cell of cells) hashes.set(`${cell.caseId}:${cell.arm}`, (hashes.get(`${cell.caseId}:${cell.arm}`) ?? new Set()).add(cell.inputHash));
    expect([...hashes.values()].every((set) => set.size === 1)).toBe(true);
    expect(new Set(cells.map((cell) => cell.key)).size).toBe(cells.length);
  });

  it('reads arm A Skill decisions for the unblinded diagnostics', () => {
    const toolCalls = [{
      name: 'commit_episode_learning_review',
      input: { memoryPlan: { actions: [] }, capabilityDecision: { disposition: 'project_canary', operation: 'create', spec: { name: 'release-patch' } } },
    }];
    expect(skillDecision({ text: '', toolCalls })).toBe('project_canary create release-patch');
    expect(skillDecision({ text: '', toolCalls: [] })).toBe('none');
  });
});
