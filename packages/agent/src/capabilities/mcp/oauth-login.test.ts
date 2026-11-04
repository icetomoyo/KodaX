import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentConfigPath, setAgentConfigHome } from '../../runtime/agent-home.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokenWithResource,
  loadClientInfo,
  loadValidToken,
  performOAuthLogin,
  refreshTokenWithResource,
  registerOAuthClient,
} from './oauth-login.js';
import { startOAuthCallbackServer } from './oauth.js';
import { createFetchHttpFixture } from '../../../../../tests/fetch-http-fixture.js';

const servers: http.Server[] = [];
const tempDirs: string[] = [];

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-oauth-login-'));
  tempDirs.push(dir);
  setAgentConfigHome(dir);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

async function getFreePort(): Promise<number> {
  const { server, url } = await createFetchHttpFixture((_request, response) => response.end());
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return Number(new URL(url).port);
}

interface OAuthServer {
  origin: string;
  register: Array<Record<string, unknown>>;
  token: Array<Record<string, string>>;
}

/** A combined fake resource + authorization server (discovery, DCR, token). */
async function startOAuthServer(asMetadataExtra: Record<string, unknown> = {}): Promise<OAuthServer> {
  const state: OAuthServer = { origin: '', register: [], token: [] };
  const { server, url } = await createFetchHttpFixture(async (req, res) => {
    const url = new URL(req.url ?? '/', state.origin || 'http://localhost');
    const json = (body: Record<string, unknown>): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      json({ authorization_servers: [state.origin], resource: 'https://rs.example/mcp', scopes_supported: ['read', 'write'] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      json({
        authorization_endpoint: `${state.origin}/authorize`,
        token_endpoint: `${state.origin}/token`,
        registration_endpoint: `${state.origin}/register`,
        ...asMetadataExtra,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      state.register.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      json({ client_id: 'dcr-client-1' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      state.token.push(Object.fromEntries(new URLSearchParams(await readBody(req))));
      json({ access_token: 'at-123', refresh_token: 'rt-456', expires_in: 3600, token_type: 'Bearer', scope: 'read write' });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  state.origin = url;
  return state;
}

describe('buildAuthorizeUrl', () => {
  it('includes PKCE S256 + scope + RFC 8707 resource', () => {
    const url = new URL(buildAuthorizeUrl({
      authorizationEndpoint: 'https://as.example/authorize',
      clientId: 'c1',
      redirectUri: 'http://localhost:33418/callback',
      state: 'st',
      challenge: 'chal',
      scope: 'read write',
      resource: 'https://rs.example/mcp',
    }));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('resource')).toBe('https://rs.example/mcp');
  });
});

describe('registerOAuthClient (RFC 7591)', () => {
  it('POSTs a public-client registration and returns the issued client_id', async () => {
    const srv = await startOAuthServer();
    const client = await registerOAuthClient({
      registrationEndpoint: `${srv.origin}/register`,
      redirectUri: 'http://localhost:33418/callback',
      clientName: 'KodaX (test)',
      scope: 'read',
    });
    expect(client).toEqual({ clientId: 'dcr-client-1' });
    expect(srv.register[0]).toMatchObject({
      client_name: 'KodaX (test)',
      redirect_uris: ['http://localhost:33418/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      scope: 'read',
    });
  });
});

describe('exchangeCodeForTokenWithResource', () => {
  it('sends grant + code_verifier + resource and parses the token', async () => {
    const srv = await startOAuthServer();
    const token = await exchangeCodeForTokenWithResource({
      tokenEndpoint: `${srv.origin}/token`,
      clientId: 'c1',
      code: 'auth-code',
      verifier: 'verif',
      redirectUri: 'http://localhost:33418/callback',
      resource: 'https://rs.example/mcp',
    });
    expect(token.accessToken).toBe('at-123');
    expect(token.refreshToken).toBe('rt-456');
    expect(srv.token[0]).toMatchObject({
      grant_type: 'authorization_code',
      code: 'auth-code',
      code_verifier: 'verif',
      resource: 'https://rs.example/mcp',
    });
  });
});

describe('refreshTokenWithResource', () => {
  it('sends a refresh grant with the resource indicator', async () => {
    const srv = await startOAuthServer();
    const token = await refreshTokenWithResource({
      tokenEndpoint: `${srv.origin}/token`,
      clientId: 'c1',
      refreshToken: 'rt-old',
      resource: 'https://rs.example/mcp',
    });
    expect(token.accessToken).toBe('at-123');
    expect(srv.token[0]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'rt-old',
      resource: 'https://rs.example/mcp',
    });
  });
});

describe('startOAuthCallbackServer', () => {
  it('selects a Fetch-compatible callback fixture after a refused port', async () => {
    const originalFetch = globalThis.fetch;
    const probe = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('bad port') }))
      .mockImplementation(originalFetch);
    let callback: Awaited<ReturnType<typeof startOAuthCallbackServer>> | undefined;
    try {
      const port = await getFreePort();
      callback = await startOAuthCallbackServer(port);
      expect((await fetch(`http://127.0.0.1:${port}/callback?code=checked&state=ready`)).status).toBe(200);
      await expect(callback.waitForCode()).resolves.toEqual({ code: 'checked', state: 'ready' });
      expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      callback?.close();
      probe.mockRestore();
    }
  });

  it('delivers code+state from a callback and is idempotently closable', async () => {
    const port = await getFreePort();
    const cb = await startOAuthCallbackServer(port);
    try {
      const got = cb.waitForCode();
      expect((await fetch(`http://127.0.0.1:${port}/callback?code=c1&state=s1`)).status).toBe(200);
      expect(await got).toEqual({ code: 'c1', state: 's1' });
    } finally {
      cb.close();
      cb.close(); // idempotent — must not throw
    }
  });

  it('buffers a callback that arrives before waitForCode is awaited (no lost redirect)', async () => {
    const port = await getFreePort();
    const cb = await startOAuthCallbackServer(port);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/callback?code=early&state=st`)).status).toBe(200);
      await expect(cb.waitForCode()).resolves.toEqual({ code: 'early', state: 'st' });
    } finally {
      cb.close();
    }
  });

  it('rejects on an OAuth error redirect', async () => {
    const port = await getFreePort();
    const cb = await startOAuthCallbackServer(port);
    try {
      // Observe both the callback error and redirect transport failure immediately.
      await Promise.all([
        expect(cb.waitForCode()).rejects.toThrow(/access_denied/),
        fetch(`http://127.0.0.1:${port}/callback?error=access_denied`)
          .then(response => expect(response.status).toBe(400)),
      ]);
    } finally {
      cb.close();
    }
  });
});

describe('performOAuthLogin (discovery → DCR → loopback → token)', () => {
  it('refuses to log in when the AS advertises PKCE methods without S256', async () => {
    const srv = await startOAuthServer({ code_challenge_methods_supported: ['plain'] });
    let consented = false;
    await expect(performOAuthLogin({
      serverId: 'srv-pkce',
      serverUrl: `${srv.origin}/mcp`,
      consent: async () => { consented = true; return true; },
      redirectPort: await getFreePort(),
    })).rejects.toThrow(/S256/);
    // The refusal happens during discovery, before any user consent prompt.
    expect(consented).toBe(false);
    expect(srv.register).toHaveLength(0);
  });

  it('runs the full flow, persists the client + token', async () => {
    const srv = await startOAuthServer();
    const port = await getFreePort();

    // The consent gate simulates the browser: once the loopback is up, the
    // authorization server "redirects" back with the code + state.
    const consent = async (authorizationUrl: string): Promise<boolean> => {
      const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
      setTimeout(() => {
        void fetch(`http://127.0.0.1:${port}/callback?code=auth-code&state=${state}`).catch(() => {});
      }, 80);
      return true;
    };

    const token = await performOAuthLogin({
      serverId: 'srv-1',
      serverUrl: `${srv.origin}/mcp`,
      consent,
      redirectPort: port,
    });

    expect(token?.accessToken).toBe('at-123');
    // dynamic registration happened and the client was persisted.
    expect(srv.register).toHaveLength(1);
    expect(await loadClientInfo('srv-1')).toEqual({ clientId: 'dcr-client-1' });
    // the token exchange carried the discovered resource indicator.
    expect(srv.token[0]).toMatchObject({ resource: 'https://rs.example/mcp', code: 'auth-code' });
    // the token was persisted and is loadable.
    expect((await loadValidToken('srv-1'))?.accessToken).toBe('at-123');
    // the persisted token file lives under the redirected config home.
    await expect(readFile(path.join(getAgentConfigPath('mcp-tokens'), 'srv-1.json'), 'utf-8'))
      .resolves.toContain('at-123');
  });

  it('aborts (undefined) when the user declines consent — no token, no callback', async () => {
    const srv = await startOAuthServer();
    const port = await getFreePort();
    const token = await performOAuthLogin({
      serverId: 'srv-2',
      serverUrl: `${srv.origin}/mcp`,
      consent: async () => false,
      redirectPort: port,
    });
    expect(token).toBeUndefined();
    expect(srv.token).toHaveLength(0);
  });

  it('skips dynamic registration when a client_id is configured', async () => {
    const srv = await startOAuthServer();
    const port = await getFreePort();
    const consent = async (authorizationUrl: string): Promise<boolean> => {
      const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
      setTimeout(() => {
        void fetch(`http://127.0.0.1:${port}/callback?code=auth-code&state=${state}`).catch(() => {});
      }, 80);
      return true;
    };
    const token = await performOAuthLogin({
      serverId: 'srv-3',
      serverUrl: `${srv.origin}/mcp`,
      configuredClientId: 'preconfigured-client',
      consent,
      redirectPort: port,
    });
    expect(token?.accessToken).toBe('at-123');
    expect(srv.register).toHaveLength(0);
  });
});
