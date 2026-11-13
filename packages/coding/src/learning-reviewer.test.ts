import type { KodaXBaseProvider } from '@kodax-ai/llm';
import { describe, expect, it, vi } from 'vitest';

import {
  createProductionLearningReviewer,
  hostOwnsLearning,
  installProductionLearningReviewer,
  LEARNING_REVIEW_SYSTEM_PROMPT,
  LEARNING_REVIEW_TOOL,
} from './learning-reviewer.js';

const input = {
  cacheDomain: 'learning-review' as const,
  memory: {
    trigger: 'episode_completed' as const,
    userFeedback: '',
    task: 'Verify the release',
    sourceRefs: ['digest-1'],
    candidateRefs: [],
    warnings: [],
  },
  evidence: {
    outcomeDigest: {
      id: 'digest-1',
      reviewKey: 'review-1',
      sessionId: 'session-1',
      branchId: 'session-1',
      sequence: 1,
      objective: 'Verify the release',
      approach: 'Run tests',
      outcome: 'succeeded' as const,
      summary: 'Tests passed',
      evidenceRefs: ['artifact:check-1'],
      visibility: 'prompt_safe' as const,
      createdAt: '2026-07-27T00:00:00.000Z',
    },
    exactInvokedSkill: null,
    verifierFacts: [{ ref: 'artifact:check-1', verdict: 'passed' as const }],
    priorDigests: [],
    qualification: {
      reusableMethodEvidence: true,
      explicitSkillPreservation: false,
      independentEpisodeCount: 2,
      verifiedOutcome: true,
      exactSkillInvoked: false,
    },
  },
};

function provider(toolInput?: Record<string, unknown>): KodaXBaseProvider {
  return {
    name: 'fake-learning-provider',
    isConfigured: () => true,
    stream: vi.fn().mockResolvedValue({
      textBlocks: [],
      thinkingBlocks: [],
      toolBlocks: toolInput === undefined ? [] : [{
        type: 'tool_use',
        id: 'review-1',
        name: LEARNING_REVIEW_TOOL.name,
        input: toolInput,
      }],
    }),
  } as unknown as KodaXBaseProvider;
}

describe('FEATURE_263 production unified learning reviewer', () => {
  it('installs the production reviewer only when the host supplied no reviewer', () => {
    const resolvedProvider = provider();
    const installed = installProductionLearningReviewer({
      provider: 'anthropic',
    }, resolvedProvider, 'review-model');
    const custom = vi.fn();
    const preserved = installProductionLearningReviewer({
      provider: 'anthropic',
      learningReviewer: custom,
    }, resolvedProvider, 'review-model');

    expect(installed.learningReviewer).toBeTypeOf('function');
    expect(preserved.learningReviewer).toBe(custom);
    expect(hostOwnsLearning(installed)).toBe(false);
    expect(hostOwnsLearning({ ...installed })).toBe(false);
    expect(hostOwnsLearning(preserved)).toBe(true);
    expect(hostOwnsLearning({ memoryReviewer: vi.fn() })).toBe(true);
  });

  it('declares every governed Memory action field required by the apply path', () => {
    const memoryPlan = LEARNING_REVIEW_TOOL.input_schema.properties?.memoryPlan;
    const actions = memoryPlan?.properties?.actions;
    const actionProperties = actions?.items?.properties;

    expect(actionProperties).toMatchObject({
      proposedBody: { type: 'string', minLength: 1 },
      claimKind: { type: 'string' },
      claimKey: { type: 'string' },
      actionSignature: { type: 'string' },
      preconditions: { type: 'string' },
      counterexamples: { type: 'array' },
      relationship: { type: 'string' },
    });
    expect(actions?.items?.allOf).toContainEqual({
      if: {
        properties: {
          action: { enum: ['write_memdir', 'patch_memdir', 'conflict_report'] },
        },
      },
      then: { required: ['proposedBody', 'claimKind', 'claimKey'] },
    });
  });

  it('makes the unified result shape and approval invariant explicit to the model', () => {
    const memoryPlan = LEARNING_REVIEW_TOOL.input_schema.properties?.memoryPlan;
    const capability = LEARNING_REVIEW_TOOL.input_schema.properties?.capabilityDecision;
    const spec = capability?.properties?.spec;

    expect(LEARNING_REVIEW_TOOL.input_schema.required).toEqual([
      'memoryPlan',
      'capabilityDecision',
    ]);
    expect(LEARNING_REVIEW_SYSTEM_PROMPT).toContain(
      'memoryPlan and capabilityDecision as top-level siblings',
    );
    expect(LEARNING_REVIEW_SYSTEM_PROMPT).toContain(
      'Set requiresApproval to true on every Memory action',
    );
    expect(LEARNING_REVIEW_SYSTEM_PROMPT).toContain(
      'lowercase hyphenated slug',
    );
    expect(memoryPlan?.required).toEqual(['actions', 'warnings']);
    expect(memoryPlan?.properties?.trigger).toBeUndefined();
    expect(memoryPlan?.properties?.sourceRefs).toBeUndefined();
    expect(spec?.properties?.name).toMatchObject({
      type: 'string',
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
      maxLength: 64,
    });
  });

  it('makes one forced structured call under a dedicated cache domain', async () => {
    const model = provider({
      memoryPlan: {
        trigger: 'episode_completed',
        createdAt: '2026-07-27T00:01:00.000Z',
        sourceRefs: ['digest-1'],
        candidateRefs: [],
        actions: [],
        warnings: [],
      },
      capabilityDecision: { disposition: 'discard', reasonCodes: ['one_off'] },
    });
    const reviewer = createProductionLearningReviewer({ provider: model, model: 'review-model' });

    await expect(reviewer(input)).resolves.toMatchObject({
      capabilityDecision: { disposition: 'discard' },
    });
    expect(model.stream).toHaveBeenCalledOnce();
    const call = vi.mocked(model.stream).mock.calls[0]!;
    expect(call[1]).toEqual([LEARNING_REVIEW_TOOL]);
    expect(call[4]).toMatchObject({
      forcedToolName: LEARNING_REVIEW_TOOL.name,
      modelOverride: 'review-model',
      promptCacheKey: expect.stringMatching(/^learning-review:/),
      maxOutputTokensOverride: 1_200,
    });
    expect(call[0]).toMatchObject([{
      role: 'user',
      content: expect.stringContaining('"cacheDomain":"learning-review"'),
    }]);
  });

  it('classifies a missing structured tool call as a retryable malformed response', async () => {
    const reviewer = createProductionLearningReviewer({ provider: provider() });

    await expect(reviewer(input)).rejects.toMatchObject({
      name: 'EpisodeReviewFailure',
      kind: 'malformed_response',
    });
  });
});
