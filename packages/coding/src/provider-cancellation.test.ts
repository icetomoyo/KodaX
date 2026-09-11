import { describe, expect, it, vi } from 'vitest';
import { APIUserAbortError as AnthropicAbortError } from '@anthropic-ai/sdk';
import { APIUserAbortError as OpenAIAbortError } from 'openai';
import { Runner, createAgent } from '@kodax-ai/agent';
import {
  createCustomProvider, KODAX_PROVIDERS,
  KodaXAnthropicCompatProvider, KodaXOpenAICompatProvider,
} from '@kodax-ai/llm';
import { classifyError, ErrorCategory } from './error-classification.js';
import { classifyResilienceError } from './resilience/classifier.js';

const factories = [
  ...Object.entries(KODAX_PROVIDERS),
  ...(['anthropic', 'openai'] as const).map((protocol) => [
    `custom-${protocol}`,
    () => createCustomProvider({
      name: `custom-${protocol}`, protocol, model: 'test-model',
      baseUrl: 'https://provider.invalid', apiKeyEnv: 'UNUSED_TEST_KEY',
    }),
  ] as const),
];

describe.each(factories)('%s cancellation through Runner', (_name, factory) => {
  const sample = factory();
  const methods = sample instanceof KodaXAnthropicCompatProvider || sample instanceof KodaXOpenAICompatProvider
    ? ['stream', 'complete'] as const : ['stream'] as const;

  it.each(methods)('%s reports user cancellation without provider recovery', async (method) => {
    const provider = factory();
    const controller = new AbortController();
    const anthropic = provider instanceof KodaXAnthropicCompatProvider;
    const openai = provider instanceof KodaXOpenAICompatProvider;
    // The ACP transport is supplied below; do not probe or launch a real CLI.
    if (!anthropic && !openai) Reflect.set(provider, 'acpClientOptions', {});
    const request = vi.fn(async () => {
      controller.abort(new DOMException('user requested stop', 'AbortError'));
      if (anthropic) throw new AnthropicAbortError();
      if (openai) throw new OpenAIAbortError();
      throw new DOMException('user requested stop', 'AbortError');
    });
    Reflect.set(provider, '_client', anthropic ? { messages: { create: request } }
      : openai ? { chat: { completions: { create: request } } }
        : {
          isConnectionOpen: () => true,
          createNewSession: async () => 'test-session',
          prompt: request, releaseSession: () => undefined,
        });
    const run = Runner.run(createAgent({ name: 'cancel-test', instructions: 'test' }), 'hello', {
      tracer: null, abortSignal: controller.signal,
      llm: async () => {
        await provider[method]([{ role: 'user', content: 'hello' }], [], 'system', undefined, undefined, controller.signal);
        return 'should not complete after cancellation';
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const error: unknown = await run.catch((caught: unknown) => caught);
    if (!(error instanceof Error)) throw new Error('Expected an Error');
    expect(classifyError(error)).toMatchObject({ category: ErrorCategory.USER_ABORT, retryable: false, maxRetries: 0 });
    expect(classifyResilienceError(error)).toMatchObject({ errorClass: 'user_abort', retryable: false, maxRetries: 0 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
