import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';

it.each(['cancel', 'disconnect'] as const)(
  'distinguishes %s after a real HTTP SSE text delta',
  async (action) => {
    const controller = new AbortController();
    let disconnect = (): void => { throw new Error('HTTP response is not ready.'); };
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({
          id: 'http-cancel', object: 'chat.completion.chunk', created: 1, model: 'test-model',
          choices: [{ index: 0, delta: { content: 'first delta' }, finish_reason: null }],
        })}\n\n`);
        disconnect = () => response.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No HTTP address.');
    vi.stubEnv('KODAX_HTTP_CANCEL_KEY', 'local-test-only');
    try {
      const provider = createCustomProvider({
        name: 'http-cancel', protocol: 'openai', model: 'test-model',
        apiKeyEnv: 'KODAX_HTTP_CANCEL_KEY', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const result = provider.stream([{ role: 'user', content: 'hold the stream' }], [], '', false, {
        onTextDelta: () => {
          setTimeout(() => {
            if (action === 'cancel') controller.abort(new Error('User cancelled the run.'));
            else disconnect();
          }, 20);
        },
      }, controller.signal);
      if (action === 'cancel') await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      else await expect(result).rejects.not.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  },
);
