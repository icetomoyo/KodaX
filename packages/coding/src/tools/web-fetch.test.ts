import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { toolWebFetch } from './web-fetch.js';
import { getToolDefinition } from './registry.js';
import { DEFERRED_TOOL_HINTS } from './deferred-tools.js';
import { createFetchHttpFixture } from '../../../../tests/fetch-http-fixture.js';

describe('toolWebFetch', () => {
  let server: Server | undefined;
  let baseUrl = '';

  it('advertises the implemented plain-text, redirect and cache contract', () => {
    const description = getToolDefinition('web_fetch')!.description;
    expect(description).toContain('plain text');
    expect(description).toContain('follows redirects');
    expect(description).toContain('does not cache');
    expect(description).not.toContain('markdown');
    expect(DEFERRED_TOOL_HINTS.web_fetch).toContain('plain text');
    expect(DEFERRED_TOOL_HINTS.web_fetch).not.toMatch(/markdown|cached/);
  });

  it('follows redirects and performs a fresh GET on repeated reads', async () => {
    let reads = 0;
    ({ server, url: baseUrl } = await createFetchHttpFixture((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/target' });
        response.end();
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<h1>Read ${++reads}</h1><a href="/other">Link</a>`);
      }
    }));
    const ctx = { backups: new Map<string, string>(), executionCwd: process.cwd() };
    const first = await toolWebFetch({ url: `${baseUrl}/redirect` }, ctx);
    const second = await toolWebFetch({ url: `${baseUrl}/redirect` }, ctx);
    expect(first).toContain(`${baseUrl}/target`);
    expect(first).toContain('Read 1');
    expect(second).toContain('Read 2');
    expect(first).not.toContain('[Link](');
    expect(reads).toBe(2);
  });

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
    ({ server, url: baseUrl } = await createFetchHttpFixture((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><head><title>Spec</title></head><body><main><h1>Hello</h1><p>Wave B retrieval body.</p></main></body></html>');
    }));

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

  it('preserves leading and trailing whitespace in non-HTML response bodies', async () => {
    ({ server, url: baseUrl } = await createFetchHttpFixture((_, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('  leading\nmiddle\ntrailing  ');
    }));

    const result = await toolWebFetch({ url: `${baseUrl}/plain` }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('Content:\n  leading\nmiddle\ntrailing  \n\nArtifacts:');
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

  it('marks a response incomplete when the network acquisition safety limit is reached', async () => {
    ({ server, url: baseUrl } = await createFetchHttpFixture((_, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`first\n${'x'.repeat(512 * 1024)}\nlast-after-limit`);
    }));

    const result = await toolWebFetch({ url: `${baseUrl}/large` }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('SOURCE_INCOMPLETE');
    expect(result).toContain('- truncated: true');
    expect(result).not.toContain('last-after-limit');
  });
});
