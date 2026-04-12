/**
 * KodaX MCP OAuth 2.0 Support
 *
 * Handles OAuth 2.0 Authorization Code + PKCE flow for MCP servers.
 * Manages token persistence and refresh.
 */
import { createServer, type Server } from 'http';
import { randomBytes, createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

/** Escape HTML special characters to prevent XSS in OAuth callback pages. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface OAuthConfig {
  readonly type: 'oauth2';
  readonly clientId: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes?: readonly string[];
  readonly redirectPort?: number;
}

export interface OAuthToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly tokenType?: string;
  readonly scope?: string;
}

const TOKEN_DIR = path.join(homedir(), '.kodax', 'mcp-tokens');

function getTokenPath(serverId: string): string {
  return path.join(TOKEN_DIR, `${serverId}.json`);
}

/**
 * Load cached token for a server.
 */
export async function loadToken(serverId: string): Promise<OAuthToken | null> {
  try {
    const data = await fs.readFile(getTokenPath(serverId), 'utf-8');
    return JSON.parse(data) as OAuthToken;
  } catch {
    return null;
  }
}

/**
 * Save token to disk.
 */
export async function saveToken(serverId: string, token: OAuthToken): Promise<void> {
  await fs.mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const tokenPath = getTokenPath(serverId);
  await fs.writeFile(tokenPath, JSON.stringify(token, null, 2), 'utf-8');
  // SECURITY: Restrict file permissions to owner-only so other users on a
  // shared system cannot read access/refresh tokens.
  if (process.platform !== 'win32') {
    await fs.chmod(tokenPath, 0o600);
  }
}

/**
 * Check if a token is expired (with 60s buffer).
 */
export function isTokenExpired(token: OAuthToken): boolean {
  if (!token.expiresAt) return false;
  return Date.now() >= (token.expiresAt - 60000);
}

/**
 * Generate PKCE code verifier and challenge.
 */
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Build the authorization URL for the OAuth flow.
 */
export function buildAuthorizationUrl(
  config: OAuthConfig,
  pkce: { challenge: string },
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  });
  if (config.scopes && config.scopes.length > 0) {
    params.set('scope', config.scopes.join(' '));
  }
  return `${config.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth token exchange failed (${response.status}): ${text}`);
  }

  const data = await safeParseJsonResponse(response, 'OAuth token exchange');
  return parseTokenResponse(data);
}

/**
 * Refresh an expired token.
 */
export async function refreshToken(
  config: OAuthConfig,
  token: OAuthToken,
): Promise<OAuthToken> {
  if (!token.refreshToken) {
    throw new Error('No refresh token available. Re-authorization required.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: token.refreshToken,
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth token refresh failed (${response.status}): ${text}`);
  }

  const data = await safeParseJsonResponse(response, 'OAuth token refresh');
  return parseTokenResponse(data);
}

/** Safely parse a JSON response, validating it is a non-null object. */
async function safeParseJsonResponse(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(`Failed to parse ${label} response as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${label} response is not a JSON object`);
  }
  return data as Record<string, unknown>;
}

function parseTokenResponse(data: Record<string, unknown>): OAuthToken {
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  if (!accessToken) throw new Error('No access_token in OAuth response');

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : undefined;

  return {
    accessToken,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    scope: typeof data.scope === 'string' ? data.scope : undefined,
  };
}

/**
 * Start a local HTTP server to receive the OAuth callback.
 * Returns the authorization code and state.
 */
export function startCallbackServer(
  port: number,
): Promise<{ code: string; state: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Authorization failed</h1><p>${escapeHtml(error)}</p></body></html>`);
        reject(new Error(`OAuth authorization failed: ${error}`));
        return;
      }

      if (code && state) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization successful</h1><p>You can close this window.</p></body></html>');
        resolve({ code, state, server });
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Missing authorization code</h1></body></html>');
      }
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    // Clear timeout on successful resolve
    const originalResolve = resolve;
    resolve = ((value: { code: string; state: string; server: Server }) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      originalResolve(value);
    }) as typeof resolve;

    server.listen(port, '127.0.0.1', () => {});
    server.on('error', reject);

    // Timeout after 120 seconds
    timeoutHandle = setTimeout(() => {
      server.close();
      reject(new Error('OAuth callback timeout (120s)'));
    }, 120000);
  });
}

/**
 * Get a valid token for an MCP server — load from cache, refresh if expired, or start new flow.
 */
export async function getValidToken(
  serverId: string,
  config: OAuthConfig,
): Promise<OAuthToken | null> {
  // 1. Try cached token
  const cached = await loadToken(serverId);
  if (cached && !isTokenExpired(cached)) {
    return cached;
  }

  // 2. Try refresh
  if (cached?.refreshToken) {
    try {
      const refreshed = await refreshToken(config, cached);
      await saveToken(serverId, refreshed);
      return refreshed;
    } catch (err) {
      // Refresh failed — log for debugging, then fall through to re-authorization.
      // This could be a transient network error or a permanently revoked refresh token.
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[kodax:mcp:oauth] Token refresh failed for ${serverId}: ${reason}\n`);
    }
  }

  // 3. New authorization needed (return null — caller decides whether to start interactive flow)
  return null;
}
