import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { KODAX_PROVIDERS } from './registry.js';
import {
  observeProviderOperation,
  runWithProviderRequestObserver,
  type ProviderRequestObservation,
} from '../provider-request-observation.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['disconnect', 'cancel', 'complete'] as const)(
  'classifies a GLM HTTP stream that will %s without retrying or inventing usage',
  async action => {
    const controller = new AbortController();
    const facts: ProviderRequestObservation[] = [];
    let requests = 0;
    let disconnect = (): void => { throw new Error('HTTP stream is not ready.'); };
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requests++;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (event: Record<string, unknown>): void => {
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        send({ type: 'message_start', message: {
          id: 'local-glm', type: 'message', role: 'assistant', model: 'glm-5.3',
          content: [], usage: { input_tokens: 12, output_tokens: 0 },
        } });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first delta' } });
        disconnect = () => response.destroy();
        if (action === 'complete') {
          send({ type: 'content_block_stop', index: 0 });
          send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
          send({ type: 'message_stop' });
          response.end();
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address.');
    const fetcher = globalThis.fetch;
    vi.stubEnv('ZAI_CODING_API_KEY', 'local-test-only');
    vi.stubGlobal('fetch', (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetcher(`http://127.0.0.1:${address.port}/v1/messages`, init));
    try {
      const provider = KODAX_PROVIDERS['zai-coding']!();
      const pending = runWithProviderRequestObserver(fact => facts.push(fact), () =>
        observeProviderOperation(provider.name, 'primary', undefined, () => provider.stream(
          [{ role: 'user', content: 'Local transport control.' }], [], '', false, {
            modelOverride: 'glm-5.3', maxOutputTokensOverride: 128, singleAttempt: true,
            onTextDelta: () => {
              if (action === 'cancel') controller.abort();
              if (action === 'disconnect') disconnect();
            },
          }, controller.signal), undefined, controller.signal));
      if (action === 'complete') {
        await expect(pending).resolves.toMatchObject({
          textBlocks: [{ type: 'text', text: 'first delta' }],
          usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
        });
      } else if (action === 'cancel') {
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      } else {
        await expect(pending).rejects.toMatchObject({
          // A real socket disconnect need not expose an upstream errno.
          name: 'KodaXProviderError', metadata: { stage: 'transport' },
        });
        expect(controller.signal.aborted).toBe(false);
      }
      expect(requests).toBe(1);
      const terminal = facts.filter(fact => fact.boundary === 'physical_attempt').at(-1);
      expect(terminal?.state).toBe(action === 'complete' ? 'succeeded' : action === 'cancel' ? 'cancelled' : 'failed');
      if (action !== 'complete') {
        expect(terminal?.usage).toBeUndefined();
        expect(terminal?.partialUsage?.inputTokens).toBe(12);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },
);
