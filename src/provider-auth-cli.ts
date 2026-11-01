import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createOAuthRefreshDriver, openOAuthSession, validateCustomProviderConfig, type KodaXCustomProviderConfig } from '@kodax-ai/llm';
import { getAgentConfigPath } from '@kodax-ai/agent';
import { linkProviderOAuthRegistration, createTerminalProviderSetupInteraction } from '@kodax-ai/repl';
import { createProviderCredentialManager } from './provider-credential-manager.js';
export { createProviderCredentialManager } from './provider-credential-manager.js';
import { assertProviderOAuthSessionScope, migrateProviderOAuthRegistration, providerOAuthStore } from './provider-oauth-store.js';
export { providerOAuthStore } from './provider-oauth-store.js';
import { loginProviderOAuth } from './provider-oauth-login.js';

export async function readOAuthConnection(configPath: string, name: string): Promise<KodaXCustomProviderConfig> {
  const config: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || !('customProviders' in config) || !Array.isArray(config.customProviders)) throw new Error('Configure a custom OAuth provider with kodax setup first.');
  const provider = config.customProviders.find((value: unknown) => value && typeof value === 'object' && 'name' in value && value.name === name) as KodaXCustomProviderConfig | undefined;
  if (!provider?.oauth) throw new Error('Choose a configured OAuth provider alias.');
  validateCustomProviderConfig(provider); return provider;
}
function openBrowser(url: string): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (process.platform === 'win32' && (!systemRoot || !path.isAbsolute(systemRoot))) return Promise.reject(new Error('Windows system browser launcher is unavailable.'));
  const [command, args] = process.platform === 'win32' ? [path.join(systemRoot!, 'System32', 'rundll32.exe'), [path.join(systemRoot!, 'System32', 'url.dll') + ',FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command!, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('Browser launch failed. Open the printed authorization URL on this machine.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
/** Loopback only, exact registered path; PKCE/state validation remains in the OAuth exchange. */
export function receiveOAuthCallback(redirectUri: string, authorizationUrl: string, signal: AbortSignal,
  launch: (url: string) => Promise<void> = openBrowser): Promise<string> {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) || redirect.username || redirect.password || redirect.search || redirect.hash || !redirect.port) throw new Error('Browser login requires an explicit registered HTTP loopback callback and port.');
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const callback = new URL(request.url ?? '/', redirect.origin);
      if (request.method !== 'GET' || callback.pathname !== redirect.pathname) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Authorization received. Return to KodaX.');
      finish(undefined, callback.href);
    });
    let settled = false;
    const abort = () => finish(new Error('OAuth browser login cancelled or timed out.'));
    const finish = (error?: Error, result?: string) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', abort); server.close(); server.closeIdleConnections();
      if (error) reject(error); else resolve(result!);
    };
    server.once('error', () => finish(new Error('Cannot bind the registered OAuth callback port.')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    server.listen(Number(redirect.port), redirect.hostname.replace(/^\[|\]$/g, ''), () => {
      void launch(authorizationUrl).catch(() => { process.stderr.write('Browser launch unavailable; open the printed authorization URL on this machine.\n'); });
    });
  });
}
export function configureProviderAuthCommand(program: Command, command?: Command): void {
  const auth = command ?? program.command('auth').description('Save API keys, login, inspect or revoke provider credentials');
  auth.command('set-key <provider>').description('Enter a hidden API key and save it in permission-protected plaintext auth.json').action(async (name: string) => {
    const manager = createProviderCredentialManager(), before = await manager.describe(name);
    const interaction = createTerminalProviderSetupInteraction({ input: process.stdin, output: process.stdout });
    try {
      const key = await interaction.secret?.('API key (hidden; saved locally in plaintext auth.json)');
      if (key === undefined) { process.stdout.write('Key update cancelled.\n'); return; }
      await manager.setApiKey(name, key, before); process.stdout.write(`Saved API key for ${name}; online validity unverified.\n`);
    } finally { interaction.close?.(); }
  });
  auth.command('remove-key <provider>').description('Remove the saved API key; show the remaining credential source').action(async (name: string) => {
    const manager = createProviderCredentialManager(), before = await manager.describe(name), next = await manager.removeApiKey(name, before);
    process.stdout.write(`Saved API key removed. Credential source: ${next.source}.\n`);
  });
  auth.command('login <provider>').requiredOption('--client-id <id>', 'Your own client registration ID (OpenRouter: your Main application identity)')
    .option('--scope <scopes...>', 'Scopes permitted for your client registration', [])
    .option('--device', 'Use the provider device authorization flow')
    .option('--redirect-uri <uri>', 'Registered HTTP loopback callback for browser login')
    .action(async (name: string, options: { clientId: string; scope: string[]; device?: boolean; redirectUri?: string }) => {
      const configPath = getAgentConfigPath('config.json'), provider = await readOAuthConnection(configPath, name), store = providerOAuthStore(configPath);
      const lifetime = AbortSignal.timeout(5 * 60 * 1000);
      if (!options.device && !options.redirectUri) throw new Error('Pass your registered --redirect-uri, or select an available --device flow.');
      const login = await loginProviderOAuth({ profile: 'default', service: provider.oauth!, clientId: options.clientId, scopes: options.scope, store,
        ...(provider.oauth === 'radius' ? { issuer: provider.baseUrl } : {}), redirectUri: options.redirectUri, signal: lifetime,
        ...(options.device ? { device: async (step: { verificationUri: string; userCode: string }) => { process.stdout.write(`Open ${step.verificationUri} and enter ${step.userCode}\n`); } }
          : { browser: async (step: { authorizationUrl: string }) => { process.stdout.write(`Open ${step.authorizationUrl}\n`); return receiveOAuthCallback(options.redirectUri!, step.authorizationUrl, lifetime); } }) });
      try { lifetime.throwIfAborted(); linkProviderOAuthRegistration({ configPath, name, service: provider.oauth!, expectedRegistration: provider.oauthRegistration, registration: login.registrationId }); }
      catch (error) { await login.session.revoke(); throw error; }
      if (provider.oauthRegistration) await migrateProviderOAuthRegistration({ configPath, registrationId: provider.oauthRegistration });
      if (provider.oauthRegistration) {
        const previous = await openOAuthSession({ id: provider.oauthRegistration, store, driver: createOAuthRefreshDriver(provider.oauth!) });
        if ((previous.profile ?? 'default') === 'default') {
          assertProviderOAuthSessionScope({ service: provider.oauth!, profile: 'default', ...(provider.oauth === 'radius' ? { issuer: provider.baseUrl } : {}) }, previous);
          await previous.revoke();
        }
      }
      process.stdout.write(`Authorized ${name} with a new isolated grant. No verified user subject is claimed.\n`);
    });
  auth.command('status <provider>').action(async (name: string) => {
    const status = await createProviderCredentialManager().describe(name);
    if (status.source !== 'oauth') { process.stdout.write(`Credential source: ${status.source}; saved key: ${status.stored ? 'yes' : 'no'}; online validity unverified.\n`); return; }
    const configPath = getAgentConfigPath('config.json'), provider = await readOAuthConnection(configPath, name);
    if (!provider.oauthRegistration) { process.stdout.write('Login required.\n'); return; }
    await migrateProviderOAuthRegistration({ configPath, registrationId: provider.oauthRegistration });
    const record = await providerOAuthStore(configPath).transact(provider.oauthRegistration, async record => ({ record, result: record }));
    if (record && (record.profile ?? 'default') !== 'default') { process.stdout.write('Registration belongs to another profile. Login required for the default profile.\n'); return; }
    process.stdout.write(record?.credentials ? `Stored ${record.identityKind ?? 'account'} registration; live entitlement unverified.\n` : 'Login required.\n');
  });
  auth.command('logout <provider>').action(async (name: string) => {
    const configPath = getAgentConfigPath('config.json'), provider = await readOAuthConnection(configPath, name);
    if (!provider.oauthRegistration) { process.stdout.write('Already logged out.\n'); return; }
    await migrateProviderOAuthRegistration({ configPath, registrationId: provider.oauthRegistration });
    const session = await openOAuthSession({ id: provider.oauthRegistration, store: providerOAuthStore(configPath), driver: createOAuthRefreshDriver(provider.oauth!) });
    assertProviderOAuthSessionScope({ service: provider.oauth!, profile: 'default', ...(provider.oauth === 'radius' ? { issuer: provider.baseUrl } : {}) }, session);
    const result = await session.revoke();
    linkProviderOAuthRegistration({ configPath, name, service: provider.oauth!, expectedRegistration: provider.oauthRegistration });
    process.stdout.write(`Local grant revoked; remote revocation ${result.remote}.\n`);
  });
}
