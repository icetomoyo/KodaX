import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerCustomProviders } from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';

it.each([
  ['coding', 'cancel'], ['managed_task', 'cancel'], ['coding', 'exhaust'],
] as const)(
  'keeps %s HTTP SSE %s separate from the other recovery outcome',
  async (mode, action) => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-http-stop-'));
    let requestCount = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requestCount += 1;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({
          id: 'http-stop', object: 'chat.completion.chunk', created: 1, model: 'test-model',
          choices: [{ index: 0, delta: { content: 'Still working.' }, finish_reason: null }],
        })}\n\n`);
        if (action === 'exhaust') response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No HTTP address.');
    vi.stubEnv('KODAX_HOST_HTTP_STOP_KEY', 'local-test-only');
    let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    try {
      await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
      await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({
        provider: 'host-http-stop', model: 'test-model',
        customProviders: [{
          name: 'host-http-stop', protocol: 'openai', model: 'test-model',
          apiKeyEnv: 'KODAX_HOST_HTTP_STOP_KEY', baseUrl: `http://127.0.0.1:${address.port}/v1`,
        }],
      }));
      runtime = await createKodaXRuntime({ homeDir });
      const session = await runtime.sessions.create({ projectPath: homeDir });
      let resolveFirstDelta = (): void => undefined;
      const firstDelta = new Promise<void>((resolve) => { resolveFirstDelta = resolve; });
      const subscription = runtime.events.subscribe({ sessionId: session.id, type: 'assistant.delta' },
        resolveFirstDelta);
      const recoveries: unknown[] = [];
      const recoverySubscription = runtime.events.subscribe({ sessionId: session.id, type: 'provider.recovery' },
        (event) => recoveries.push(event.payload));
      try {
        const run = await runtime.runs.start({ sessionId: session.id, mode, prompt: 'Continue working.',
          options: { timeouts: { llm: { maxRetryDelaySec: 0.001 } } },
        });
        await firstDelta;
        if (action === 'cancel') {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          expect((await runtime.runs.abort(run.runId)).accepted).toBe(true);
        }
        const result = await run.result;
        if (action === 'cancel') {
          expect(result.phase).toBe('interrupted');
          expect(result.failureDetail?.failureKind).not.toBe('network');
          expect(result.stop).toMatchObject({ state: 'confirmed', outcome: 'interrupted' });
          expect(recoveries).toEqual([]);
        } else {
          expect(result.phase).toBe('failed');
          expect(result.stop).toBeUndefined();
          expect(requestCount).toBeGreaterThan(1);
          expect(recoveries).toEqual(expect.arrayContaining([expect.objectContaining({
            event: expect.objectContaining({ recoveryAction: 'manual_continue' }),
          })]));
        }
      } finally {
        recoverySubscription.close();
        subscription.close();
      }
    } finally {
      await runtime?.close();
      registerCustomProviders([]);
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000,
);
