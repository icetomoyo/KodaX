import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { mkdir, readFile, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import type { OAuthConfig, OAuthToken } from './oauth.js';
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generatePKCE,
  isTokenExpired,
  loadToken,
  refreshToken,
  saveToken,
} from './oauth.js';

describe('OAuth', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `kodax-oauth-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    await mkdir(path.join(tempDir, '.kodax', 'mcp-tokens'), { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('generatePKCE', () => {
    it('returns valid verifier and challenge', () => {
      const { verifier, challenge } = generatePKCE();
      expect(verifier).toBeDefined();
      expect(challenge).toBeDefined();
      expect(typeof verifier).toBe('string');
      expect(typeof challenge).toBe('string');
      expect(verifier.length).toBeGreaterThan(0);
      expect(challenge.length).toBeGreaterThan(0);
    });

    it('generates different values on each call', () => {
      const result1 = generatePKCE();
      const result2 = generatePKCE();
      expect(result1.verifier).not.toBe(result2.verifier);
      expect(result1.challenge).not.toBe(result2.challenge);
    });
  });

  describe('isTokenExpired', () => {
    it('returns false for fresh token without expiration', () => {
      const token: OAuthToken = {
        accessToken: 'token123',
      };
      expect(isTokenExpired(token)).toBe(false);
    });

    it('returns false for token that expires in future', () => {
      const token: OAuthToken = {
        accessToken: 'token123',
        expiresAt: Date.now() + 3600000,
      };
      expect(isTokenExpired(token)).toBe(false);
    });

    it('returns true for expired token', () => {
      const token: OAuthToken = {
        accessToken: 'token123',
        expiresAt: Date.now() - 1000,
      };
      expect(isTokenExpired(token)).toBe(true);
    });

    it('uses 60s buffer before expiration', () => {
      const token: OAuthToken = {
        accessToken: 'token123',
        expiresAt: Date.now() + 30000, // 30s in future
      };
      expect(isTokenExpired(token)).toBe(true);
    });
  });

  describe('buildAuthorizationUrl', () => {
    it('includes all required parameters', () => {
      const config: OAuthConfig = {
        type: 'oauth2',
        clientId: 'client-123',
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
      };
      const pkce = { challenge: 'challenge123' };
      const redirectUri = 'http://localhost:8000/callback';
      const state = 'state123';

      const url = buildAuthorizationUrl(config, pkce, redirectUri, state);

      expect(url).toContain('https://example.com/auth?');
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=client-123');
      expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback');
      expect(url).toContain('state=state123');
      expect(url).toContain('code_challenge=challenge123');
      expect(url).toContain('code_challenge_method=S256');
    });

    it('includes scopes when provided', () => {
      const config: OAuthConfig = {
        type: 'oauth2',
        clientId: 'client-123',
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
        scopes: ['read:data', 'write:data'],
      };
      const pkce = { challenge: 'challenge123' };
      const redirectUri = 'http://localhost:8000/callback';
      const state = 'state123';

      const url = buildAuthorizationUrl(config, pkce, redirectUri, state);

      expect(url).toContain('scope=read%3Adata+write%3Adata');
    });

    it('does not include scopes when empty', () => {
      const config: OAuthConfig = {
        type: 'oauth2',
        clientId: 'client-123',
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
        scopes: [],
      };
      const pkce = { challenge: 'challenge123' };
      const redirectUri = 'http://localhost:8000/callback';
      const state = 'state123';

      const url = buildAuthorizationUrl(config, pkce, redirectUri, state);

      expect(url).not.toContain('scope=');
    });
  });

  describe('saveToken and loadToken', () => {
    it('saves token to disk', async () => {
      const token: OAuthToken = {
        accessToken: 'access123',
        refreshToken: 'refresh123',
        expiresAt: Date.now() + 3600000,
        tokenType: 'Bearer',
        scope: 'read write',
      };

      await saveToken('test-server', token);

      const tokenPath = path.join(os.homedir(), '.kodax', 'mcp-tokens', 'test-server.json');
      const content = await readFile(tokenPath, 'utf-8');
      const loaded = JSON.parse(content) as OAuthToken;

      expect(loaded.accessToken).toBe('access123');
      expect(loaded.refreshToken).toBe('refresh123');
      expect(loaded.tokenType).toBe('Bearer');
    });

    it('loads token from disk', async () => {
      const token: OAuthToken = {
        accessToken: 'access123',
        refreshToken: 'refresh123',
        expiresAt: Date.now() + 3600000,
        tokenType: 'Bearer',
        scope: 'read write',
      };

      await saveToken('test-server-load-test', token);
      const loaded = await loadToken('test-server-load-test');

      expect(loaded).toEqual(token);
    });

    afterEach(async () => {
      try {
        const tokenPath = path.join(os.homedir(), '.kodax', 'mcp-tokens');
        await rm(tokenPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('returns null when token file does not exist', async () => {
      const loaded = await loadToken('nonexistent-server-abc123');
      expect(loaded).toBeNull();
    });
  });

  describe('exchangeCodeForToken', () => {
    it('exchanges authorization code for token', async () => {
      const mockResponse = {
        access_token: 'access123',
        refresh_token: 'refresh123',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'read write',
      };

      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const config: OAuthConfig = {
        type: 'oauth2',
        clientId: 'client-123',
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
      };

      const token = await exchangeCodeForToken(
        config,
        'auth-code-123',
        'verifier123',
        'http://localhost:8000/callback',
      );

      expect(token.accessToken).toBe('access123');
      expect(token.refreshToken).toBe('refresh123');
      expect(token.tokenType).toBe('Bearer');
      expect(token.expiresAt).toBeDefined();

      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[0]).toBe('https://example.com/token');
      expect(callArgs[1].method).toBe('POST');
    });

    it('throws error when token exchange fails', async () => {
      global.fetch = vi.fn(async () =>
        new Response('Invalid request', {
          status: 400,
        }),
      );

      const config: OAuthConfig = {
        type: 'oauth2',
        clientId: 'client-123',
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
      };

      await expect(
        exchangeCodeForToken(config, 'bad-code', 'verifier123', 'http://localhost:8000/callback'),
      ).rejects.toThrow('OAuth token exchange failed');
    });

    it('throws error when no access_token in response', async () => {
      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ refresh_token: 'refresh123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const config: OAuthConfig = {
        type: 'oauth2',
        clientId: 'client-123',
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
      };

      await expect(
        exchangeCodeForToken(config, 'code', 'verifier', 'http://localhost:8000/callback'),
      ).rejects.toThrow('No access_token');
    });
  });

  describe('refreshToken', () => {
    it('refreshes an expired token', async () => {
      const mockResponse = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      };

      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const config: OAuthConfig = {
        type: 'oauth2',
        clientId: 'client-123',
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
      };

      const oldToken: OAuthToken = {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1000,
      };

      const newToken = await refreshToken(config, oldToken);

      expect(newToken.accessToken).toBe('new-access-token');
      expect(newToken.refreshToken).toBe('new-refresh-token');

      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[0]).toBe('https://example.com/token');
      expect(callArgs[1].body).toContain('grant_type=refresh_token');
    });

    it('throws error when no refresh token available', async () => {
      const config: OAuthConfig = {
        type: 'oauth2',
        clientId: 'client-123',
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
      };

      const token: OAuthToken = {
        accessToken: 'access123',
      };

      await expect(refreshToken(config, token)).rejects.toThrow('No refresh token available');
    });

    it('throws error when refresh fails', async () => {
      global.fetch = vi.fn(async () =>
        new Response('Invalid refresh token', {
          status: 401,
        }),
      );

      const config: OAuthConfig = {
        type: 'oauth2',
        clientId: 'client-123',
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
      };

      const token: OAuthToken = {
        accessToken: 'access123',
        refreshToken: 'bad-refresh',
      };

      await expect(refreshToken(config, token)).rejects.toThrow('OAuth token refresh failed');
    });
  });
});
