import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  KodaXContextOverflowError,
  registerModelProvider,
} from '@kodax-ai/llm';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';

import { estimateTokens, countTokens } from '../tokenizer.js';
import { createRuntimeContextBudgetSnapshot } from './context-budget.js';
import type { RuntimeContextBudgetSnapshot } from './context-budget.js';
import { runSubstrate } from './run-substrate.js';
import type { ToolGuardrail } from '@kodax-ai/agent';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TOOL_OUTPUT_DIR_ENV } from '../tools/truncate.js';

const PROVIDER_NAME = 'sa-capacity-accounting-test';
const API_KEY_ENV = 'SA_CAPACITY_ACCOUNTING_TEST_API_KEY';
const CONTEXT_WINDOW = 128_000;

interface CapturedRequest {
  readonly messages: KodaXMessage[];
  readonly tools: KodaXToolDefinition[];
  readonly systemPrompt: string;
}

class CapacityAccountingProvider extends KodaXBaseProvider {
  static requests: CapturedRequest[] = [];
  static mode: 'text' | 'tool' | 'reject_once' = 'text';
  static usage: KodaXStreamResult['usage'] = undefined;

  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'capacity-model',
    supportsThinking: false,
    contextWindow: CONTEXT_WINDOW,
    maxOutputTokens: 1_000,
  };

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    systemPrompt: string,
    _reasoning?: boolean | KodaXReasoningRequest,
  ): Promise<KodaXStreamResult> {
    CapacityAccountingProvider.requests.push({
      messages: structuredClone(messages),
      tools: [...tools],
      systemPrompt,
    });
    if (CapacityAccountingProvider.mode === 'reject_once' && CapacityAccountingProvider.requests.length === 1) {
      throw new KodaXContextOverflowError({ contextWindow: CONTEXT_WINDOW, inputTokensKind: 'unknown' });
    }
    if (CapacityAccountingProvider.mode === 'tool') {
      return {
        textBlocks: [],
        thinkingBlocks: [],
        toolBlocks: [{
          type: 'tool_use',
          id: 'read-1',
          name: 'read',
          input: { path: 'capacity-fixture.txt' },
        }],
        usage: CapacityAccountingProvider.usage,
      };
    }
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      thinkingBlocks: [],
      toolBlocks: [],
      usage: CapacityAccountingProvider.usage,
    };
  }
}

describe('runSubstrate physical request accounting', { timeout: 30_000 }, () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    CapacityAccountingProvider.requests = [];
    CapacityAccountingProvider.mode = 'text';
    CapacityAccountingProvider.usage = undefined;
    registerModelProvider(PROVIDER_NAME, () => new CapacityAccountingProvider());
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('recovers a rejected SA generation after persisting reduced tool history', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-sa-rejection-'));
    const previous = process.env[TOOL_OUTPUT_DIR_ENV];
    process.env[TOOL_OUTPUT_DIR_ENV] = directory;
    CapacityAccountingProvider.mode = 'reject_once';
    let commits = 0;
    try {
      const result = await runSubstrate({ provider: PROVIDER_NAME, model: 'capacity-model', maxIter: 1,
        reasoningMode: 'off', context: { systemPromptOverride: 'sys' },
        session: { initialMessages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'bash', input: { command: 'cat file' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: "print('x')\n".repeat(17_000) }] },
        ] },
        events: { onCompactedMessages: async () => { commits += 1; } },
      }, 'continue');
      expect(result.success).toBe(true);
      expect(commits).toBeGreaterThan(0);
      expect(CapacityAccountingProvider.requests.length).toBeGreaterThanOrEqual(2);
      expect(estimateTokens(CapacityAccountingProvider.requests.at(-1)!.messages))
        .toBeLessThan(estimateTokens(CapacityAccountingProvider.requests[0]!.messages));
    } finally {
      if (previous === undefined) delete process.env[TOOL_OUTPUT_DIR_ENV];
      else process.env[TOOL_OUTPUT_DIR_ENV] = previous;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('does not count skills separately when systemPromptOverride is the complete wire prompt', async () => {
    const snapshots: RuntimeContextBudgetSnapshot[] = [];
    const systemPromptOverride = 'EXACT OVERRIDE PROMPT';

    await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capacity-model',
      maxIter: 1,
      reasoningMode: 'off',
      context: {
        systemPromptOverride,
        skillsPrompt: 'THIS SKILL CATALOG IS BYPASSED BY THE OVERRIDE',
        contextDiagnostics: true,
      },
      events: {
        onContextBudgetSnapshot: (snapshot) => snapshots.push(snapshot),
      },
    }, 'inspect capacity');

    expect(CapacityAccountingProvider.requests).toHaveLength(1);
    expect(CapacityAccountingProvider.requests[0]!.systemPrompt).toBe(systemPromptOverride);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.tokenBreakdown.systemPrompt).toBe(countTokens(systemPromptOverride));
    expect(snapshots[0]!.tokenBreakdown.skillCatalog).toBe(0);
  });

  it('injects an explicit Skill into the SA wire prompt even with a child override', async () => {
    await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capacity-model',
      maxIter: 1,
      reasoningMode: 'off',
      context: {
        systemPromptOverride: 'CHILD AGENT SYSTEM PROMPT',
        skillInvocation: {
          name: 'hidden-skill',
          path: 'C:/skills/hidden-skill/SKILL.md',
          expandedContent: '<skill name="hidden-skill">SA_SKILL_SENTINEL</skill>',
        },
      },
    }, 'run child objective');

    expect(CapacityAccountingProvider.requests).toHaveLength(1);
    const systemPrompt = CapacityAccountingProvider.requests[0]!.systemPrompt;
    expect(systemPrompt).toContain('CHILD AGENT SYSTEM PROMPT');
    expect(systemPrompt).toContain('SA_SKILL_SENTINEL');
    expect(systemPrompt.match(/SA_SKILL_SENTINEL/g)).toHaveLength(1);
  });

  it('keeps the exact user request in the transcript when the execution prompt is prepared', async () => {
    const rawUserInput = '/writing-great-skills 请检查刚刚写的技能';
    const preparedPrompt = 'User request: the active Skill "writing-great-skills" 请检查刚刚写的技能';

    const result = await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capacity-model',
      maxIter: 1,
      reasoningMode: 'off',
      context: {
        rawUserInput,
        skillInvocation: {
          name: 'writing-great-skills',
          path: 'C:/skills/writing-great-skills/SKILL.md',
          expandedContent: '<skill name="writing-great-skills">Audit the requested Skill.</skill>',
        },
      },
    }, preparedPrompt);

    expect(JSON.stringify(result.messages)).toContain(rawUserInput);
    expect(JSON.stringify(result.messages)).not.toContain(preparedPrompt);
    expect(JSON.stringify(CapacityAccountingProvider.requests[0]?.messages)).toContain(rawUserInput);
    expect(JSON.stringify(CapacityAccountingProvider.requests[0]?.messages)).not.toContain(preparedPrompt);
  });

  it('rebases a no-usage snapshot from the final request envelope through assistant and tool appends', async () => {
    CapacityAccountingProvider.mode = 'tool';
    const result = await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capacity-model',
      maxIter: 1,
      reasoningMode: 'off',
      context: { systemPromptOverride: 'CAPACITY TEST PROMPT' },
      events: {
        beforeToolExecute: async () => 'complete tool evidence',
      },
    }, 'inspect capacity');

    const request = CapacityAccountingProvider.requests[0]!;
    const preCallEnvelopeTokens = createRuntimeContextBudgetSnapshot({
      contextWindow: CONTEXT_WINDOW,
      systemPrompt: request.systemPrompt,
      toolDefinitions: request.tools,
      messages: request.messages,
    }).usedTokens;
    const appendedTranscriptTokens = estimateTokens(result.messages) - estimateTokens(request.messages);
    const expectedCompletedTokens = preCallEnvelopeTokens + appendedTranscriptTokens;

    expect(result.contextTokenSnapshot).toMatchObject({
      currentTokens: expectedCompletedTokens,
      baselineEstimatedTokens: estimateTokens(result.messages),
      source: 'estimate',
    });
    expect(result.contextTokenSnapshot?.currentTokens).toBeGreaterThan(estimateTokens(result.messages));
  });

  it('keeps valid provider usage authoritative', async () => {
    CapacityAccountingProvider.usage = {
      inputTokens: 1_234,
      outputTokens: 56,
      totalTokens: 1_290,
    };

    const result = await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capacity-model',
      maxIter: 1,
      reasoningMode: 'off',
      context: { systemPromptOverride: 'CAPACITY TEST PROMPT' },
    }, 'inspect capacity');

    expect(result.contextTokenSnapshot).toMatchObject({
      currentTokens: 1_290,
      source: 'api',
      usage: CapacityAccountingProvider.usage,
    });
  });

  it('runs ToolGuardrails before the concrete permission hook and records the final rewrite', async () => {
    CapacityAccountingProvider.mode = 'tool';
    const seen: string[] = [];
    const rewrite: ToolGuardrail = {
      kind: 'tool',
      name: 'rewrite-path',
      beforeTool: async (call) => ({
        action: 'rewrite',
        payload: { ...call, input: { path: 'final-fixture.txt' } },
      }),
    };
    const receipt: ToolGuardrail = {
      kind: 'tool',
      name: 'receipt',
      beforeTool: async (call) => {
        seen.push(`guardrail:${call.id}:${call.name}:${String(call.input.path)}`);
        return { action: 'allow' };
      },
      afterTool: async () => ({
        action: 'rewrite',
        payload: { content: 'guarded result' },
      }),
    };

    const result = await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capacity-model',
      maxIter: 1,
      reasoningMode: 'off',
      guardrails: [rewrite, receipt],
      context: { systemPromptOverride: 'GUARDRAIL TEST PROMPT' },
      events: {
        beforeToolExecute: async (name, input, meta) => {
          seen.push(`permission:${meta?.toolId}:${name}:${String(input.path)}`);
          return true;
        },
      },
    }, 'inspect guardrails');

    expect(seen).toEqual([
      'guardrail:read-1:read:final-fixture.txt',
      'permission:read-1:read:final-fixture.txt',
    ]);
    const serialized = JSON.stringify(result.messages);
    expect(serialized).toContain('final-fixture.txt');
    expect(serialized).not.toContain('capacity-fixture.txt');
    expect(serialized).toContain('guarded result');
  });
});
