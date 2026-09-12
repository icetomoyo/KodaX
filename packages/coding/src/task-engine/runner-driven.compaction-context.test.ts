import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, compact: vi.fn() };
});

import {
  compact as mockedCompact,
  type CompactionResult,
} from '@kodax-ai/agent';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
  type KodaXEphemeralSuffix,
  type KodaXMessage,
  type KodaXProviderStreamOptions,
  type KodaXReasoningRequest,
  type KodaXStreamResult,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import type {
  KodaXOptions,
} from '../types.js';
import type { RuntimeContextBudgetSnapshot } from '../agent-runtime/context-budget.js';
import { estimateTokens } from '../tokenizer.js';
import { buildFallbackRoutingDecision, type ReasoningPlan } from '../reasoning.js';
import { runManagedTaskViaRunner } from './runner-driven.js';

const PROVIDER_NAME = 'runner-compaction-context-test';
const PROVIDER_API_KEY_ENV = 'RUNNER_COMPACTION_CONTEXT_TEST_API_KEY';
const SKILLS_ADDENDUM_SENTINEL = 'AMA_SKILLS_ADDENDUM_SURVIVES_COMPACTION';
const SELECTED_SKILL_SENTINEL = 'AMA_SELECTED_SKILL_SURVIVES_COMPACTION';
const TASK_CONSTRAINT_SENTINEL = 'AMA_TASK_CONSTRAINT_SURVIVES_COMPACTION';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;

interface PhysicalRequest {
  readonly messages: readonly KodaXMessage[];
  readonly system: string;
  readonly suffix: KodaXEphemeralSuffix | undefined;
  readonly promptCacheKey: string | undefined;
}

let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-compaction-context-'));
});

afterAll(async () => {
  if (!workspaceRoot) return;
  await rm(workspaceRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
});

beforeEach(() => {
  compactMock.mockReset();
});

afterEach(() => {
  clearRuntimeModelProviders();
  delete process.env[PROVIDER_API_KEY_ENV];
});

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function compactedResult(messages: KodaXMessage[]): CompactionResult {
  const compacted: KodaXMessage[] = [{
    role: 'user',
    content: '[Conversation history summary]\n\nThe README was inspected successfully.',
    _synthetic: true,
    _source: 'compaction-checkpoint',
  }];
  const tokensBefore = estimateTokens(messages);
  const tokensAfter = estimateTokens(compacted);
  return {
    compacted: true,
    messages: compacted,
    summary: 'The README was inspected successfully.',
    tokensBefore,
    tokensAfter,
    entriesRemoved: messages.length,
    report: {
      strategy: 'full_prefix',
      triggerSource: 'percentage',
      effectiveTriggerTokens: 120_000,
      protectedBudgetTokens: 8_000,
      fixedInputTokens: 0,
      eligibleTokens: tokensBefore,
      rawTailTokens: 0,
      summaryTokens: tokensAfter,
      queryLedgerTokens: 0,
    },
    anchor: {
      summary: 'The README was inspected successfully.',
      tokensBefore,
      tokensAfter,
      entriesRemoved: messages.length,
      reason: 'automatic',
    },
  };
}

function makePlan(prompt: string): ReasoningPlan {
  return {
    effort: 'medium',
    decision: buildFallbackRoutingDecision(prompt),
    promptOverlay: '',
  };
}

function registerScriptedProvider(
  supportsNativeSuffix: boolean,
  requests: PhysicalRequest[],
  timeline: string[],
): void {
  let streamCall = 0;
  class ScriptedProvider extends KodaXBaseProvider {
    readonly name = PROVIDER_NAME;
    readonly supportsThinking = false;
    protected readonly config = {
      apiKeyEnv: PROVIDER_API_KEY_ENV,
      model: 'scripted-compaction-context',
      supportsThinking: false,
      reasoningCapability: 'prompt-only' as const,
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
      capabilityProfile: {
        transport: 'native-api' as const,
        conversationSemantics: 'full-history' as const,
        mcpSupport: 'none' as const,
        contextFidelity: 'full' as const,
        toolCallingFidelity: 'full' as const,
        sessionSupport: 'stateless' as const,
        longRunningSupport: 'limited' as const,
        multimodalSupport: 'none' as const,
        evidenceSupport: 'limited' as const,
      },
    };

    override supportsEphemeralSuffix(): boolean {
      return supportsNativeSuffix;
    }

    async stream(
      messages: KodaXMessage[],
      _tools: KodaXToolDefinition[],
      system: string,
      _reasoning?: boolean | KodaXReasoningRequest,
      options?: KodaXProviderStreamOptions,
    ): Promise<KodaXStreamResult> {
      streamCall += 1;
      timeline.push(`stream-${streamCall}`);
      requests.push({
        messages: [...messages],
        system,
        suffix: options?.ephemeralSuffix,
        promptCacheKey: options?.promptCacheKey,
      });
      if (streamCall === 1) {
        return {
          textBlocks: [],
          toolBlocks: [{
            type: 'tool_use',
            id: 'read-before-compaction',
            name: 'read',
            input: {
              path: path.join(process.cwd(), 'README.md'),
              limit: 1,
            },
          }],
          thinkingBlocks: [],
          stopReason: 'tool_use',
          usage: {
            inputTokens: 129_900,
            outputTokens: 100,
            totalTokens: 130_000,
          },
        };
      }
      return {
        textBlocks: [{ type: 'text', text: 'done after automatic compaction' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 30_000,
          outputTokens: 50,
          totalTokens: 30_050,
        },
      };
    }
  }

  process.env[PROVIDER_API_KEY_ENV] = 'test-key';
  registerModelProvider(PROVIDER_NAME, () => new ScriptedProvider());
}

function makeOptions(
  snapshots: RuntimeContextBudgetSnapshot[],
  includeHostSession = true,
): KodaXOptions {
  return {
    provider: PROVIDER_NAME,
    model: 'scripted-compaction-context',
    compaction: {
      contextWindow: 200_000,
      triggerPercent: 60,
    },
    ...(includeHostSession
      ? { session: { id: `compaction-context-${Math.random().toString(36).slice(2, 8)}` } }
      : {}),
    context: {
      gitRoot: process.cwd(),
      executionCwd: process.cwd(),
      managedTaskWorkspaceDir: workspaceRoot,
      repoIntelligenceMode: 'off',
      contextDiagnostics: true,
      skillsPrompt: [
        '## Available Skills',
        `- ${SKILLS_ADDENDUM_SENTINEL}`,
      ].join('\n'),
      skillInvocation: {
        name: 'selected-compaction-skill',
        path: path.join(workspaceRoot, 'selected-skill', 'SKILL.md'),
        expandedContent: [
          '# Selected Skill',
          SELECTED_SKILL_SENTINEL,
        ].join('\n'),
      },
      taskMetadata: {
        constraint: TASK_CONSTRAINT_SENTINEL,
      },
    },
    events: {
      onContextBudgetSnapshot: (snapshot) => snapshots.push(snapshot),
    },
  };
}

describe.each([
  ['native ephemeral suffix', true],
  ['legacy provider lowering', false],
] as const)('AMA context reinjection after automatic compaction: %s', (_name, native) => {
  it('keeps one canonical context in-run and excludes it from durable history', async () => {
    const requests: PhysicalRequest[] = [];
    const snapshots: RuntimeContextBudgetSnapshot[] = [];
    const timeline: string[] = [];
    registerScriptedProvider(native, requests, timeline);
    compactMock.mockImplementation(async (messages: KodaXMessage[]) => {
      timeline.push('compact');
      return compactedResult(messages);
    });
    const prompt = 'Inspect the README, then report completion.';

    const result = await runManagedTaskViaRunner(
      makeOptions(snapshots),
      prompt,
      undefined,
      makePlan(prompt),
    );

    expect(result.success).toBe(true);
    expect(timeline.slice(0, 3)).toEqual(['stream-1', 'compact', 'stream-2']);
    expect(compactMock).toHaveBeenCalledTimes(1);
    const managedWorkerRequests = requests.filter((request) => (
      JSON.stringify(request).includes(SKILLS_ADDENDUM_SENTINEL)
    ));
    expect(managedWorkerRequests).toHaveLength(2);
    expect(managedWorkerRequests[0]?.promptCacheKey).toMatch(/^[a-f0-9]{64}$/);
    expect(managedWorkerRequests[1]?.promptCacheKey)
      .toBe(managedWorkerRequests[0]?.promptCacheKey);

    for (const request of managedWorkerRequests) {
      const physicalRequest = JSON.stringify({
        system: request.system,
        messages: request.messages,
        suffix: request.suffix?.content,
      });
      expect(countOccurrences(physicalRequest, SKILLS_ADDENDUM_SENTINEL)).toBe(1);
      expect(countOccurrences(physicalRequest, SELECTED_SKILL_SENTINEL)).toBe(1);
      expect(countOccurrences(physicalRequest, TASK_CONSTRAINT_SENTINEL)).toBe(1);
      expect(request.system).not.toContain(SKILLS_ADDENDUM_SENTINEL);
      expect(request.system).not.toContain(SELECTED_SKILL_SENTINEL);
      expect(request.system).not.toContain(TASK_CONSTRAINT_SENTINEL);
      expect(request.suffix).toBeUndefined();
      const contextIndex = request.messages.findIndex((message) =>
        message._source === 'managed-run-context');
      const anchorIndex = request.messages.findIndex((message) => (
        message._synthetic !== true && message.role === 'user'
      ) || message._source === 'compaction-checkpoint');
      expect(contextIndex).toBeGreaterThanOrEqual(0);
      expect(contextIndex).toBeLessThan(anchorIndex);
    }

    const compactableTranscript = JSON.stringify(compactMock.mock.calls[0]?.[0]);
    expect(compactableTranscript).not.toContain(SKILLS_ADDENDUM_SENTINEL);
    expect(compactableTranscript).not.toContain(SELECTED_SKILL_SENTINEL);
    expect(compactableTranscript).not.toContain(TASK_CONSTRAINT_SENTINEL);
    expect(compactableTranscript).not.toContain('managed-run-context');

    const durableTranscript = JSON.stringify(result.messages);
    expect(countOccurrences(durableTranscript, SKILLS_ADDENDUM_SENTINEL)).toBe(0);
    expect(countOccurrences(durableTranscript, SELECTED_SKILL_SENTINEL)).toBe(0);
    expect(countOccurrences(durableTranscript, TASK_CONSTRAINT_SENTINEL)).toBe(0);
    expect(countOccurrences(durableTranscript, 'managed-run-context')).toBe(0);
    expect(durableTranscript).toContain('compaction-checkpoint');

    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot.tokenBreakdown.skillCatalog).toBeGreaterThan(0);
      expect(snapshot.compactionBudget).toMatchObject({ reservedMemoryTokens: 0,
        triggerTokens: expect.any(Number), physicalCapacityTokens: expect.any(Number) });
    }
  }, 30_000);
});

it('creates one stable run-local affinity identity when the SDK host omits session config', async () => {
  const requests: PhysicalRequest[] = [];
  const timeline: string[] = [];
  registerScriptedProvider(true, requests, timeline);
  compactMock.mockImplementation(async (messages: KodaXMessage[]) => {
    timeline.push('compact');
    return compactedResult(messages);
  });
  const prompt = 'Inspect the README without a host Session, then report completion.';

  const result = await runManagedTaskViaRunner(
    makeOptions([], false),
    prompt,
    undefined,
    makePlan(prompt),
  );

  expect(result.success).toBe(true);
  const managedWorkerRequests = requests.filter((request) => (
    JSON.stringify(request).includes(SKILLS_ADDENDUM_SENTINEL)
  ));
  expect(managedWorkerRequests.length).toBeGreaterThanOrEqual(2);
  const affinityKeys = managedWorkerRequests.map((request) => request.promptCacheKey);
  expect(affinityKeys.every((key) => /^[a-f0-9]{64}$/.test(key ?? ''))).toBe(true);
  expect(new Set(affinityKeys).size).toBe(1);
}, 30_000);
