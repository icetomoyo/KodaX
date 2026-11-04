import type { LookupAddress } from 'node:dns';
import { createServer, globalAgent } from 'node:http';
import { connect } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolWebFetch } from './web-fetch.js';
import { getToolDefinition } from './registry.js';
import { DEFERRED_TOOL_HINTS } from './deferred-tools.js';

const network = vi.hoisted(() => ({
  dnsAnswers: new Map<string, string>(),
  publicAddresses: new Set<string>(),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const lookup = (
    hostname: string,
    options: object,
    callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ): void => {
    const answer = network.dnsAnswers.get(hostname);
    if (answer === undefined) {
      actual.lookup(hostname, { ...options, all: true }, callback);
      return;
    }
    callback(null, [{ address: answer, family: answer.includes(':') ? 6 : 4 }]);
  };
  return { ...actual, default: { ...actual, lookup }, lookup };
});

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return {
    ...actual,
    isPrivateNetworkAddress: (address: string) => (
      !network.publicAddresses.has(address) && actual.isPrivateNetworkAddress(address)
    ),
  };
});

describe('toolWebFetch', () => {
  let server: ReturnType<typeof createServer> | undefined;
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
    server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/target' });
        response.end();
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<h1>Read ${++reads}</h1><a href="/other">Link</a>`);
      }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local HTTP fixture address');
    baseUrl = `http://127.0.0.1:${address.port}`;
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
    network.dnsAnswers.clear();
    network.publicAddresses.clear();
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

  it('preserves leading and trailing whitespace in non-HTML response bodies', async () => {
    server = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('  leading\nmiddle\ntrailing  ');
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
    server = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`first\n${'x'.repeat(512 * 1024)}\nlast-after-limit`);
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

    const result = await toolWebFetch({ url: `${baseUrl}/large` }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('SOURCE_INCOMPLETE');
    expect(result).toContain('- truncated: true');
    expect(result).not.toContain('last-after-limit');
  });

  async function listenLocal(handler: Parameters<typeof createServer>[0]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local HTTP fixture address');
    return `http://127.0.0.1:${address.port}`;
  }

  const ctx = () => ({ backups: new Map<string, string>(), executionCwd: process.cwd() });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://2852039166/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://[::ffff:169.254.169.254]/',
    'http://100.100.100.200/latest/meta-data/',
  ])('refuses the cloud metadata target %s before connecting', async (url) => {
    const result = await toolWebFetch({ url }, ctx());
    expect(result).toMatch(/^\[Tool Error\] web_fetch: .*cloud metadata/);
  });

  it('refuses a hostname that resolves to cloud metadata', async () => {
    network.dnsAnswers.set('metadata.example.test', '169.254.169.254');
    const result = await toolWebFetch({ url: 'http://metadata.example.test/' }, ctx());
    expect(result).toMatch(/^\[Tool Error\] web_fetch: .*cloud metadata/);
  });

  it('refuses a redirect into cloud metadata', async () => {
    const base = await listenLocal((_, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
    });
    const result = await toolWebFetch({ url: `${base}/start` }, ctx());
    expect(result).toMatch(/^\[Tool Error\] web_fetch: .*cloud metadata/);
  });

  it.each([
    ['an address literal', 'http://10.0.0.5/admin', undefined],
    ['a hostname', 'http://intranet.example.test/admin', '10.0.0.5'],
  ])('refuses a redirect from a public site into the private network through %s', async (_, location, answer) => {
    if (answer) network.dnsAnswers.set('intranet.example.test', answer);
    network.publicAddresses.add('127.0.0.1');
    const base = await listenLocal((_request, response) => {
      response.writeHead(302, { location });
      response.end();
    });
    const result = await toolWebFetch({ url: `${base}/start` }, ctx());
    expect(result).toMatch(/^\[Tool Error\] web_fetch: .*private network/);
  });

  it('refuses a public redirect into a private host whose keep-alive socket is still pooled', async () => {
    let intranetReads = 0;
    const intranet = createServer((_, response) => {
      intranetReads += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('intranet body');
    });
    await new Promise<void>(resolve => intranet.listen(0, '127.0.0.2', resolve));
    try {
      const address = intranet.address();
      if (!address || typeof address === 'string') throw new Error('Missing intranet fixture address');
      network.dnsAnswers.set('pooled.example.test', '127.0.0.2');
      const intranetUrl = `http://pooled.example.test:${address.port}/admin`;
      expect(await toolWebFetch({ url: intranetUrl }, ctx())).toContain('intranet body');
      network.publicAddresses.add('127.0.0.1');
      const base = await listenLocal((_request, response) => {
        response.writeHead(302, { location: intranetUrl });
        response.end();
      });
      const result = await toolWebFetch({ url: `${base}/start` }, ctx());
      expect(result).toMatch(/^\[Tool Error\] web_fetch: .*private network/);
      expect(intranetReads).toBe(1);
    } finally {
      await new Promise<void>(resolve => intranet.close(() => resolve()));
    }
  });

  describe('behind an environment proxy', () => {
    // An environment proxy connects every request to the proxy without calling lookup().
    async function routeThroughProxy(handler: Parameters<typeof createServer>[0]): Promise<void> {
      const proxyPort = Number(new URL(await listenLocal(handler)).port);
      vi.spyOn(globalAgent, 'createConnection').mockImplementation(() => connect(proxyPort, '127.0.0.1'));
    }

    afterEach(() => {
      vi.restoreAllMocks();
      globalAgent.destroy();
    });

    it('treats a hop whose address the proxy hid as public', async () => {
      await routeThroughProxy((_request, response) => {
        response.writeHead(302, { location: 'http://10.0.0.5/admin' });
        response.end();
      });
      const result = await toolWebFetch({ url: 'http://proxied-public.example.test/start' }, ctx());
      expect(result).toMatch(/^\[Tool Error\] web_fetch: .*private network/);
    });

    it('follows redirects between hostnames the proxy resolves', async () => {
      await routeThroughProxy((request, response) => {
        if (request.url === '/start') {
          response.writeHead(302, { location: 'http://proxied-next.example.test/page' });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('proxied body');
      });
      const result = await toolWebFetch({ url: 'http://proxied-first.example.test/start' }, ctx());
      expect(result).toContain('proxied body');
      expect(result).toContain('http://proxied-next.example.test/page');
    });
  });

  it('reads a private network target that the user asked for directly', async () => {
    network.dnsAnswers.set('intranet.example.test', '127.0.0.1');
    const base = await listenLocal((_, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('intranet body');
    });
    const port = new URL(base).port;
    const result = await toolWebFetch({ url: `http://intranet.example.test:${port}/page` }, ctx());
    expect(result).toContain('intranet body');
    expect(result).toContain(`http://intranet.example.test:${port}/page`);
  });

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)('decodes %s response bodies', async (encoding, compress) => {
    const base = await listenLocal((request, response) => {
      expect(request.headers['accept-encoding']).toContain(encoding);
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': encoding });
      response.end(compress(Buffer.from(`compressed ${encoding} body`)));
    });
    const result = await toolWebFetch({ url: `${base}/compressed` }, ctx());
    expect(result).toContain(`compressed ${encoding} body`);
  });

  it('reports non-standard status codes instead of failing', async () => {
    const base = await listenLocal((_, response) => {
      response.writeHead(999, { 'content-type': 'text/plain' });
      response.end('denied by the site');
    });
    const result = await toolWebFetch({ url: `${base}/blocked` }, ctx());
    expect(result).toContain('non-success status 999');
    expect(result).toContain('denied by the site');
  });
});
