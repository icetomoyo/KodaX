import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXStreamResult,
} from '@kodax-ai/llm';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import { readRunnerRecoveryTranscript, type Agent } from '@kodax-ai/agent';

import { buildRunnerLlmAdapter } from './llm-adapter.js';

const PROVIDER_NAME = 'managed-recovery-carrier';
const PROVIDER_KEY_ENV = 'MANAGED_RECOVERY_CARRIER_KEY';
const controller = { current: new AbortController() };

class AbortingProvider extends KodaXBaseProvider {
  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: PROVIDER_KEY_ENV,
    model: 'carrier-model',
    supportsThinking: false,
    contextWindow: 32_000,
    maxOutputTokens: 1_000,
  };

  async stream(): Promise<KodaXStreamResult> {
    controller.current.abort();
    throw new DOMException('user cancelled', 'AbortError');
  }
}

// De-identified split topology: managed context between tool calls and the
// user message carrying their results.
const transcript: KodaXMessage[] = [
  { role: 'user', content: 'inspect the files' },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b.txt' } },
    ],
  },
  {
    role: 'user',
    content: 'managed task context',
    _synthetic: true,
    _source: 'managed-run-context',
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_a', content: 'alpha' },
      { type: 'tool_result', tool_use_id: 'call_b', content: 'beta' },
    ],
  },
];

describe('managed LLM adapter recovery carrier', () => {
  beforeEach(() => {
    controller.current = new AbortController();
    process.env[PROVIDER_KEY_ENV] = 'test-key';
    registerModelProvider(PROVIDER_NAME, () => new AbortingProvider());
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[PROVIDER_KEY_ENV];
  });

  it('carries the Runner transcript, not the provider-normalized request copy', async () => {
    const adapter = buildRunnerLlmAdapter({
      provider: PROVIDER_NAME,
      model: 'carrier-model',
      effort: 'none',
      abortSignal: controller.current.signal,
    });
    const agent: Agent = {
      name: 'worker',
      instructions: 'work',
      tools: [],
      reasoning: { default: 'none', max: 'none' },
    };

    const failure = await adapter([
      { role: 'system', content: 'stable rules' },
      ...transcript,
    ], agent).then(
      () => { throw new Error('expected the provider call to abort'); },
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(readRunnerRecoveryTranscript(failure)).toEqual(transcript);
  });
});
