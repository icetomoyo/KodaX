import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';

import type { KodaXInterruptedRunEvidence } from '../types.js';
import { runSubstrate } from './run-substrate.js';

const PROVIDER_NAME = 'sa-interrupted-run-recovery-test';
const API_KEY_ENV = 'SA_INTERRUPTED_RUN_RECOVERY_TEST_API_KEY';
const RECOVERY_HEADER = '=== Interrupted Run Recovery ===';

class RecordingProvider extends KodaXBaseProvider {
  static requests: KodaXMessage[][] = [];
  static toolCallsLeft = 0;

  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'recovery-model',
    supportsThinking: false,
    contextWindow: 128_000,
    maxOutputTokens: 1_000,
  };

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _systemPrompt: string,
    _reasoning?: boolean | KodaXReasoningRequest,
  ): Promise<KodaXStreamResult> {
    RecordingProvider.requests.push(structuredClone(messages));
    if (RecordingProvider.toolCallsLeft > 0) {
      RecordingProvider.toolCallsLeft -= 1;
      return {
        textBlocks: [],
        thinkingBlocks: [],
        toolBlocks: [{ type: 'tool_use', id: 'glob-1', name: 'glob', input: { pattern: '*.none' } }],
      };
    }
    return { textBlocks: [{ type: 'text', text: 'done' }], thinkingBlocks: [], toolBlocks: [] };
  }
}

const history: KodaXMessage[] = [
  { role: 'user', content: 'build the episode', turnId: 'turn_a' },
];

const interrupted: KodaXInterruptedRunEvidence = {
  runId: 'run_a',
  turnId: 'turn_a',
  terminalCode: 'daemon_crashed',
  operations: [{ toolUseId: 'call_write', name: 'write', target: 'out/script.md', result: 'File created' }],
  replies: [{ turnId: 'turn_a', text: 'Script drafted; rendering next.', truncated: false }],
};

function run(journals: readonly KodaXInterruptedRunEvidence[] | undefined) {
  return runSubstrate({
    provider: PROVIDER_NAME,
    model: 'recovery-model',
    maxIter: 3,
    reasoningMode: 'off',
    context: { systemPromptOverride: 'sys', ...(journals ? { interruptedRunEvidence: journals } : {}) },
    session: { initialMessages: history },
  }, 'continue');
}

function recoveryMessages(messages: readonly KodaXMessage[]): KodaXMessage[] {
  return messages.filter((message) => JSON.stringify(message.content).includes(RECOVERY_HEADER));
}

describe('runSubstrate interrupted-run recovery', { timeout: 30_000 }, () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    RecordingProvider.requests = [];
    RecordingProvider.toolCallsLeft = 0;
    registerModelProvider(PROVIDER_NAME, () => new RecordingProvider());
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('shows the recovery record to the provider without saving it', async () => {
    const result = await run([interrupted]);

    const [request] = RecordingProvider.requests;
    const injected = recoveryMessages(request!);
    expect(injected).toHaveLength(1);
    expect(JSON.stringify(injected[0]!.content)).toContain('out/script.md');
    expect(JSON.stringify(injected[0]!.content)).toContain('Script drafted; rendering next.');
    expect(request!.at(-1)!.content).toContain('continue');
    expect(recoveryMessages(result.messages)).toHaveLength(0);
  });

  it('keeps the record on every call of the run, once each', async () => {
    RecordingProvider.toolCallsLeft = 1;

    const result = await run([interrupted]);

    expect(RecordingProvider.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of RecordingProvider.requests) {
      expect(recoveryMessages(request)).toHaveLength(1);
    }
    expect(recoveryMessages(result.messages)).toHaveLength(0);
  });

  it('sends the transcript unchanged when no interrupted run applies', async () => {
    await run(undefined);
    await run([{ ...interrupted, turnId: 'turn_off_path' }]);

    for (const request of RecordingProvider.requests) {
      expect(recoveryMessages(request)).toHaveLength(0);
    }
  });
});
