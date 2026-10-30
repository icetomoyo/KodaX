import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAsDiscoveryUrls,
  discoverAuthorizationServerMetadata,
  discoverOAuthEndpoints,
  discoverProtectedResourceMetadata,
  extractInsufficientScope,
  extractResourceMetadataUrl,
  parseWwwAuthenticate,
} from './oauth-discovery.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

/** A fake HTTP server that serves a fixed map of pathname -> JSON (404 otherwise),
 *  recording every requested path. */
async function startServer(
  routes: Record<string, Record<string, unknown>>,
): Promise<{ origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    hits.push(pathname);
    const body = routes[pathname];
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  // The OS can allocate a port blocked by Fetch (for example 6000).
  // Check the actual URL before using it as a discovery endpoint; retain real HTTP coverage.
  for (let attempt = 0; attempt < 10; attempt++) {
    const origin = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });
    try {
      const response = await fetch(origin);
      await response.body?.cancel();
      hits.length = 0;
      return { origin, hits };
    } catch (error: unknown) {
      if (!(error instanceof Error && error.cause instanceof Error && error.cause.message === 'bad port')) throw error;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
  throw new Error('Could not allocate a Fetch-compatible loopback test port.');
}

describe('parseWwwAuthenticate', () => {
  it('parses scheme + quoted and bare params', () => {
    const challenge = parseWwwAuthenticate('Bearer realm="mcp", resource_metadata="https://api/.well-known/x", error=insufficient_scope');
    expect(challenge?.scheme).toBe('Bearer');
    expect(challenge?.params).toEqual({
      realm: 'mcp',
      resource_metadata: 'https://api/.well-known/x',
      error: 'insufficient_scope',
    });
  });

  it('returns undefined for an empty header', () => {
    expect(parseWwwAuthenticate(undefined)).toBeUndefined();
    expect(parseWwwAuthenticate('')).toBeUndefined();
  });
});

describe('extractResourceMetadataUrl', () => {
  it('pulls the RFC 9728 pointer out of a 401 challenge', () => {
    expect(
      extractResourceMetadataUrl('Bearer resource_metadata="https://api.example/.well-known/oauth-protected-resource"'),
    ).toBe('https://api.example/.well-known/oauth-protected-resource');
  });

  it('is undefined when the challenge has no pointer', () => {
    expect(extractResourceMetadataUrl('Bearer realm="x"')).toBeUndefined();
  });
});

describe('extractInsufficientScope', () => {
  it('returns the required scope only for insufficient_scope errors', () => {
    expect(extractInsufficientScope('Bearer error="insufficient_scope", scope="read write admin"')).toBe('read write admin');
  });

  it('ignores other errors', () => {
    expect(extractInsufficientScope('Bearer error="invalid_token", scope="read"')).toBeUndefined();
    expect(extractInsufficientScope('Bearer realm="x"')).toBeUndefined();
  });
});

describe('buildAsDiscoveryUrls', () => {
  it('tries oauth-authorization-server before openid-configuration at the root', () => {
    expect(buildAsDiscoveryUrls('https://as.example/')).toEqual([
      'https://as.example/.well-known/oauth-authorization-server',
      'https://as.example/.well-known/openid-configuration',
    ]);
  });

  it('builds path-aware variants for a multi-tenant issuer', () => {
    expect(buildAsDiscoveryUrls('https://as.example/tenant/abc')).toEqual([
      'https://as.example/.well-known/oauth-authorization-server/tenant/abc',
      'https://as.example/.well-known/openid-configuration/tenant/abc',
      'https://as.example/tenant/abc/.well-known/openid-configuration',
    ]);
  });
});

describe('discoverProtectedResourceMetadata', () => {
  it('reallocates a Fetch-blocked port before serving discovery metadata', async () => {
    const address = vi.spyOn(http.Server.prototype, 'address');
    // Exercise Fetch's real bad-port refusal without binding or contacting port 6000.
    address.mockImplementationOnce(() => ({ address: '127.0.0.1', family: 'IPv4', port: 6000 }));
    try {
      const { origin } = await startServer({
        '/.well-known/oauth-protected-resource': { authorization_servers: ['https://as.example/'] },
      });
      expect(new URL(origin).port).not.toBe('6000');
      expect(await discoverProtectedResourceMetadata({ serverUrl: origin }))
        .toMatchObject({ authorizationServers: ['https://as.example/'] });
    } finally {
      address.mockRestore();
    }
  });
  it('reads authorization_servers + resource + scopes from the well-known doc', async () => {
    const { origin, hits } = await startServer({
      '/.well-known/oauth-protected-resource': {
        authorization_servers: ['https://as.example/'],
        resource: `${'https://rs.example/mcp'}`,
        scopes_supported: ['read', 'write'],
      },
    });
    const prm = await discoverProtectedResourceMetadata({ serverUrl: `${origin}/mcp` });
    expect(prm).toEqual({
      authorizationServers: ['https://as.example/'],
      resource: 'https://rs.example/mcp',
      scopesSupported: ['read', 'write'],
    });
    // path-specific probed first, then root.
    expect(hits).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
  });

  it('prefers the resource_metadata URL from the 401 challenge', async () => {
    const { origin, hits } = await startServer({
      '/custom/prm': { authorization_servers: ['https://as.example/'] },
    });
    const prm = await discoverProtectedResourceMetadata({
      serverUrl: `${origin}/mcp`,
      resourceMetadataUrl: `${origin}/custom/prm`,
    });
    expect(prm?.authorizationServers).toEqual(['https://as.example/']);
    expect(hits[0]).toBe('/custom/prm');
  });

  it('returns undefined when no document advertises authorization servers', async () => {
    const { origin } = await startServer({});
    expect(await discoverProtectedResourceMetadata({ serverUrl: `${origin}/mcp` })).toBeUndefined();
  });
});

describe('discoverAuthorizationServerMetadata', () => {
  it('reads the endpoints from the oauth-authorization-server doc', async () => {
    const { origin } = await startServer({
      '/.well-known/oauth-authorization-server': {
        issuer: 'https://as.example',
        authorization_endpoint: 'https://as.example/authorize',
        token_endpoint: 'https://as.example/token',
        registration_endpoint: 'https://as.example/register',
        scopes_supported: ['read'],
        code_challenge_methods_supported: ['S256'],
      },
    });
    const as = await discoverAuthorizationServerMetadata({ authorizationServerUrl: origin });
    expect(as).toEqual({
      issuer: 'https://as.example',
      authorizationEndpoint: 'https://as.example/authorize',
      tokenEndpoint: 'https://as.example/token',
      registrationEndpoint: 'https://as.example/register',
      scopesSupported: ['read'],
      codeChallengeMethodsSupported: ['S256'],
    });
  });

  it('falls back to openid-configuration when oauth-authorization-server is absent', async () => {
    const { origin, hits } = await startServer({
      '/.well-known/openid-configuration': {
        authorization_endpoint: 'https://as.example/authorize',
        token_endpoint: 'https://as.example/token',
      },
    });
    const as = await discoverAuthorizationServerMetadata({ authorizationServerUrl: origin });
    expect(as?.tokenEndpoint).toBe('https://as.example/token');
    expect(hits).toEqual([
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]);
  });

  it('skips a doc that lacks a token endpoint', async () => {
    const { origin } = await startServer({
      '/.well-known/oauth-authorization-server': { authorization_endpoint: 'https://as.example/authorize' },
    });
    expect(await discoverAuthorizationServerMetadata({ authorizationServerUrl: origin })).toBeUndefined();
  });
});

describe('discoverOAuthEndpoints (PRM → AS chain)', () => {
  it('resolves endpoints + resource indicator end to end', async () => {
    // The authorization server serves its own RFC 8414 metadata.
    const { origin: asOrigin } = await startServer({
      '/.well-known/oauth-authorization-server': {
        authorization_endpoint: 'https://as.example/authorize',
        token_endpoint: 'https://as.example/token',
        registration_endpoint: 'https://as.example/register',
      },
    });
    // The resource server's PRM points at that authorization server.
    const { origin: rsOrigin } = await startServer({
      '/.well-known/oauth-protected-resource/mcp': {
        authorization_servers: [asOrigin],
        resource: 'https://rs.example/mcp',
        scopes_supported: ['read'],
      },
    });

    const endpoints = await discoverOAuthEndpoints({ serverUrl: `${rsOrigin}/mcp` });
    expect(endpoints?.authorizationEndpoint).toBe('https://as.example/authorize');
    expect(endpoints?.tokenEndpoint).toBe('https://as.example/token');
    expect(endpoints?.registrationEndpoint).toBe('https://as.example/register');
    expect(endpoints?.resource).toBe('https://rs.example/mcp');
    expect(endpoints?.resourceScopesSupported).toEqual(['read']);
  });

  it('returns undefined when the resource advertises no authorization server', async () => {
    const { origin } = await startServer({
      '/.well-known/oauth-protected-resource': { resource: 'https://rs.example' },
    });
    expect(await discoverOAuthEndpoints({ serverUrl: `${origin}/` })).toBeUndefined();
  });
});
