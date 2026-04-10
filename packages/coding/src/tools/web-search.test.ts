import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolWebSearch } from './web-search.js';

describe('toolWebSearch', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let previousEndpoint: string | undefined;

  beforeEach(() => {
    previousEndpoint = process.env.KODAX_WEB_SEARCH_ENDPOINT;
  });

  afterEach(async () => {
    if (previousEndpoint === undefined) {
      delete process.env.KODAX_WEB_SEARCH_ENDPOINT;
    } else {
      process.env.KODAX_WEB_SEARCH_ENDPOINT = previousEndpoint;
    }

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
  });

  it('parses lightweight html search results', async () => {
    server = createServer((request, response) => {
      const q = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('q');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end([
        '<html><body>',
        `<a href="https://example.com/a">${q} result A</a>`,
        '<a href="https://example.com/b">Result B</a>',
        '</body></html>',
      ].join(''));
    });

    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (address && typeof address === 'object') {
          process.env.KODAX_WEB_SEARCH_ENDPOINT = `http://127.0.0.1:${address.port}/search`;
        }
        resolve();
      });
    });

    const result = await toolWebSearch({
      query: 'kodax',
      limit: 2,
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('Retrieval result for web_search');
    expect(result).toContain('kodax result A');
    expect(result).toContain('https://example.com/a');
  });

  it('uses provider-backed search when requested', async () => {
    const result = await toolWebSearch({
      query: 'kodax',
      provider_id: 'provider-1',
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      extensionRuntime: {
        searchCapabilities: async () => ([
          { title: 'Provider Result', url: 'https://provider.example/result' },
        ]),
      } as never,
    });

    expect(result).toContain('Provider: provider-1');
    expect(result).toContain('Provider Result');
  });
});
