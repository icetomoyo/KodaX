import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { toolWebFetch } from './web-fetch.js';

describe('toolWebFetch', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl = '';

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
      baseUrl = '';
    }
  });

  it('fetches and normalizes html content', async () => {
    server = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><head><title>Spec</title></head><body><main><h1>Hello</h1><p>Wave B retrieval body.</p></main></body></html>');
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });

    const result = await toolWebFetch({
      url: `${baseUrl}/spec`,
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('Retrieval result for web_fetch');
    expect(result).toContain('Spec');
    expect(result).toContain('Wave B retrieval body.');
  });

  it('uses provider-backed fetch when requested', async () => {
    const result = await toolWebFetch({
      provider_id: 'provider-1',
      capability_id: 'resource-1',
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      extensionRuntime: {
        readCapability: async () => ({
          kind: 'resource',
          content: 'provider body',
          metadata: { freshness: 'unknown' },
        }),
      } as never,
    });

    expect(result).toContain('Provider: provider-1');
    expect(result).toContain('provider body');
  });
});
