import { staticText } from './prompts/static-text.js';
import { createHash } from 'node:crypto';

import {
  EpisodeReviewFailure,
  invokeLlmJudge,
  type LlmJudgeFailureReason,
  type UnifiedLearningReviewRunner,
} from '@kodax-ai/agent';
import type {
  KodaXBaseProvider,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import type { KodaXOptions } from './types.js';

const TOOL_NAME = 'commit_episode_learning_review';

export const LEARNING_REVIEW_SYSTEM_PROMPT = [
  staticText("t12i.learning-reviewer.block.0"),
].join('\n');

const STRING_ARRAY = {
  type: 'array',
  items: { type: 'string' },
} as const;

export const LEARNING_REVIEW_TOOL: KodaXToolDefinition = {
  name: TOOL_NAME,
  description: 'Commit one structured Memory plan and optional learned Skill decision.',
  input_schema: {
    type: 'object',
    properties: {
      memoryPlan: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            items: {
              type: 'object',
              allOf: [{
                if: {
                  properties: {
                    action: { enum: ['write_memdir', 'patch_memdir', 'conflict_report'] },
                  },
                },
                then: { required: ['proposedBody', 'claimKind', 'claimKey'] },
              }],
              properties: {
                action: {
                  type: 'string',
                  enum: [
                    'no_op',
                    'link_refs',
                    'write_memdir',
                    'patch_memdir',
                    'handoff_to_skill_loop',
                    'quarantine',
                    'archive',
                    'conflict_report',
                  ],
                },
                targetRefIds: STRING_ARRAY,
                summary: { type: 'string' },
                rationale: { type: 'string' },
                confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
                risk: { type: 'string', enum: ['low', 'medium', 'high'] },
                requiresApproval: {
                  type: 'boolean',
                  enum: [true],
                  description: 'Must be true; review actions are governed proposals.',
                },
                proposedBody: { type: 'string', minLength: 1 },
                claimKind: {
                  type: 'string',
                  enum: ['fact', 'policy', 'preference', 'procedure', 'episode'],
                },
                claimKey: { type: 'string' },
                actionSignature: { type: 'string' },
                preconditions: { type: 'string' },
                counterexamples: STRING_ARRAY,
                relationship: {
                  type: 'string',
                  enum: ['same_claim', 'condition_refinement', 'conflict'],
                },
              },
              required: [
                'action',
                'targetRefIds',
                'summary',
                'rationale',
                'confidence',
                'risk',
                'requiresApproval',
              ],
            },
          },
          warnings: STRING_ARRAY,
        },
        required: ['actions', 'warnings'],
      },
      capabilityDecision: {
        type: 'object',
        properties: {
          disposition: {
            type: 'string',
            enum: ['discard', 'ready', 'project_canary'],
          },
          reasonCodes: STRING_ARRAY,
          operation: { type: 'string', enum: ['create', 'patch'] },
          requestedScope: { type: 'string', enum: ['project', 'global', 'ambiguous'] },
          semanticDisposition: { type: 'string', enum: ['allow', 'deny', 'ambiguous'] },
          targetCapabilityId: { type: 'string' },
          expectedFingerprint: { type: 'string' },
          expectedRevision: { type: 'number' },
          spec: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
                maxLength: 64,
                description: 'Lowercase hyphenated slug, for example verify-release.',
              },
              description: { type: 'string' },
              purpose: { type: 'string' },
              triggers: STRING_ARRAY,
              steps: STRING_ARRAY,
              verification: STRING_ARRAY,
              pitfalls: STRING_ARRAY,
            },
            required: [
              'name',
              'description',
              'purpose',
              'triggers',
              'steps',
              'verification',
              'pitfalls',
            ],
          },
        },
        required: ['disposition', 'reasonCodes'],
      },
    },
    required: ['memoryPlan', 'capabilityDecision'],
  },
};

export const LEARNING_REVIEW_PROMPT_SHA256 = createHash('sha256')
  .update(LEARNING_REVIEW_SYSTEM_PROMPT)
  .digest('hex');
export const LEARNING_REVIEW_SCHEMA_SHA256 = createHash('sha256')
  .update(JSON.stringify(LEARNING_REVIEW_TOOL))
  .digest('hex');

export interface CreateProductionLearningReviewerOptions {
  readonly provider: KodaXBaseProvider;
  readonly model?: string;
}

export function shouldInstallProductionLearningReviewer(
  options: Pick<KodaXOptions, 'learningReviewer' | 'memoryReviewer'>,
): boolean {
  return options.learningReviewer === undefined && options.memoryReviewer === undefined;
}

export function installProductionLearningReviewer(
  options: KodaXOptions,
  provider: KodaXBaseProvider,
  model: string | undefined,
): KodaXOptions {
  if (!shouldInstallProductionLearningReviewer(options)) return options;
  return {
    ...options,
    learningReviewer: createProductionLearningReviewer({
      provider,
      ...(model === undefined ? {} : { model }),
    }),
  };
}

type ReviewInvocation =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: LlmJudgeFailureReason };

export function createProductionLearningReviewer(
  options: CreateProductionLearningReviewerOptions,
): UnifiedLearningReviewRunner {
  const promptRevision = createHash('sha256')
    .update(`${LEARNING_REVIEW_PROMPT_SHA256}:${LEARNING_REVIEW_SCHEMA_SHA256}`)
    .digest('hex')
    .slice(0, 24);
  return async (input, signal) => {
    if (!options.provider.isConfigured()) {
      throw new EpisodeReviewFailure(
        'provider_unavailable',
        `learning review provider is not configured: ${options.provider.name}`,
      );
    }
    const result = await invokeLlmJudge<ReviewInvocation>({
      provider: options.provider,
      ...(options.model === undefined ? {} : { model: options.model }),
      systemPrompt: LEARNING_REVIEW_SYSTEM_PROMPT,
      reportTool: LEARNING_REVIEW_TOOL,
      reportToolName: TOOL_NAME,
      userMessage: JSON.stringify(input),
      parseToolCall: parseReview,
      defaultVerdict: (reason) => ({ ok: false, reason }),
      timeoutMs: 90_000,
      maxOutputTokens: 1_200,
      promptCacheKey: `learning-review:${promptRevision}:${options.provider.name}:${options.model ?? 'default'}`,
      abortSignal: signal,
    });
    if (result.ok) return result.value;
    throw new EpisodeReviewFailure(
      failureKind(result.reason),
      `learning reviewer failed: ${result.reason}`,
    );
  };
}

function parseReview(
  block: KodaXToolUseBlock,
  exact: boolean,
): ReviewInvocation | undefined {
  if (!exact || !isRecord(block.input)) return undefined;
  return { ok: true, value: block.input };
}

function failureKind(
  reason: LlmJudgeFailureReason,
): 'provider_timeout' | 'provider_error' | 'malformed_response' {
  if (reason === 'timeout') return 'provider_timeout';
  if (reason === 'provider_error') return 'provider_error';
  return 'malformed_response';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
