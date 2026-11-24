import { describe, expect, it } from 'vitest';

import { HostProtocolError } from '../host-protocol/codec.js';
import { HOST_METHODS } from '../host-protocol/methods.js';
import { redactUserMcpConfig, userSettingsRefusal } from './user-settings.js';

const refusal = (
  method: string,
  params: Readonly<Record<string, unknown>>,
  locks: readonly string[] = [],
  environment: Readonly<Record<string, string | undefined>> = {},
): { code: string; reason: string | undefined } | undefined => {
  const error = userSettingsRefusal(method, params, { locks: new Set(locks), environment });
  if (error === undefined) return undefined;
  expect(error).toBeInstanceOf(HostProtocolError);
  return { code: error.kodaxCode, reason: error.reason };
};

describe('userSettingsRefusal', () => {
  it('lets a person change their own settings while nothing is locked', () => {
    expect(refusal('config.update', { patch: { provider: 'openai', permissionMode: 'full-access' } })).toBeUndefined();
    expect(refusal('mcp.server.upsert', { name: 'docs', config: { type: 'stdio', command: 'npx' } })).toBeUndefined();
    expect(refusal('session.settings.update', { sessionId: 's', patch: { permissionMode: 'full-access' } })).toBeUndefined();
    expect(refusal('interaction.respond', { requestId: 'r', interactionId: 'i', response: { kind: 'permission', decision: { type: 'allow_always', suggestionId: 'x' } } })).toBeUndefined();
  });

  it('refuses each method its lock guards', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['provider.custom.upsert', 'providers'],
      ['provider.custom.remove', 'providers'],
      ['provider.reasoning.probe', 'providers'],
      ['mcp.server.upsert', 'mcp'],
      ['mcp.server.remove', 'mcp'],
      ['mcp.server.reload', 'mcp'],
      ['extension.reload', 'extensions'],
    ];
    for (const [method, lock] of cases) {
      expect(refusal(method, { name: 'x', provider: {}, config: {} }, [lock]), method).toEqual({ code: 'forbidden', reason: 'locked' });
      expect(refusal(method, { name: 'x', provider: {}, config: {} }, []), method).toBeUndefined();
    }
  });

  it('refuses the locked fields of a configuration change and keeps the rest open', () => {
    expect(refusal('config.update', { patch: { model: 'gpt' } }, ['providers'])).toEqual({ code: 'forbidden', reason: 'locked' });
    expect(refusal('config.update', { patch: { permissionMode: 'plan' } }, ['permissions'])).toEqual({ code: 'forbidden', reason: 'locked' });
    expect(refusal('config.update', { patch: { permissionMode: 'full-access' } }, ['fullAccess'])).toEqual({ code: 'forbidden', reason: 'locked' });
    expect(refusal('config.update', { patch: { permissionMode: 'auto' } }, ['fullAccess'])).toBeUndefined();
    expect(refusal('config.update', { patch: { locale: 'en' } }, ['providers', 'permissions', 'fullAccess', 'mcp', 'extensions'])).toBeUndefined();
  });

  it('never lets a person point the Host at its own paths', () => {
    expect(refusal('config.update', { patch: { extensions: ['./mine.js'] } })).toEqual({ code: 'forbidden', reason: 'host_path' });
    expect(refusal('config.update', { patch: { repoIntelligence: { storageDir: '/tmp/x' } } })).toEqual({ code: 'forbidden', reason: 'host_path' });
    expect(refusal('config.update', { patch: { repoIntelligence: { toolWaitMs: 10 } } })).toBeUndefined();
    expect(refusal('config.update', { patch: { extensions: null } })).toEqual({ code: 'forbidden', reason: 'host_path' });
  });

  it('holds full access shut on a Session too when it is locked', () => {
    expect(refusal('session.settings.update', { sessionId: 's', patch: { permissionMode: 'full-access' } }, ['fullAccess']))
      .toEqual({ code: 'forbidden', reason: 'locked' });
    expect(refusal('session.settings.update', { sessionId: 's', patch: { permissionMode: 'plan' } }, ['fullAccess', 'permissions']))
      .toBeUndefined();
  });

  it('refuses a lasting approval while permissions are locked', () => {
    const always = { requestId: 'r', interactionId: 'i', response: { kind: 'permission', decision: { type: 'allow_always', suggestionId: 'x' } } };
    const once = { requestId: 'r', interactionId: 'i', response: { kind: 'permission', decision: { type: 'allow_session', suggestionId: 'x' } } };
    // The lock reads the answer the connection lets through, so the test sends that answer.
    for (const params of [always, once]) expect(HOST_METHODS['interaction.respond'].params.safeParse(params).error).toBeUndefined();
    expect(refusal('interaction.respond', always, ['permissions'])).toEqual({ code: 'forbidden', reason: 'locked' });
    expect(refusal('interaction.respond', once, ['permissions'])).toBeUndefined();
  });

  it('keeps the Host environment and cloud identity out of a provider a person adds', () => {
    const provider = { name: 'mine', protocol: 'openai', baseUrl: 'https://llm.example.com', apiKeyEnv: 'MINE_KEY', model: 'm' };
    expect(refusal('provider.custom.upsert', { provider })).toBeUndefined();
    expect(refusal('provider.custom.upsert', { provider }, [], { MINE_KEY: 'host secret' }))
      .toEqual({ code: 'forbidden', reason: 'host_environment' });
    expect(refusal('provider.custom.upsert', { provider: { ...provider, cloud: { kind: 'aws' } } }))
      .toEqual({ code: 'forbidden', reason: 'host_environment' });
  });

  it('refuses a command-line MCP server when the Host may not run commands', () => {
    expect(refusal('mcp.server.upsert', { name: 'docs', config: { type: 'stdio', command: 'npx' } }, ['mcpStdio']))
      .toEqual({ code: 'forbidden', reason: 'tool_ceiling' });
    expect(refusal('mcp.server.upsert', { name: 'docs', config: { command: 'npx' } }, ['mcpStdio']))
      .toEqual({ code: 'forbidden', reason: 'tool_ceiling' });
    expect(refusal('mcp.server.upsert', { name: 'docs', config: { type: 'streamable-http', url: 'https://x' } }, ['mcpStdio']))
      .toBeUndefined();
  });

  it('refuses a server that would save a redacted value as its secret', () => {
    expect(refusal('mcp.server.upsert', { name: 'docs', config: { type: 'sse', url: 'https://x', headers: { Authorization: '[redacted]' } } }))
      .toEqual({ code: 'invalid_params', reason: 'redacted_value' });
  });
});

describe('redactUserMcpConfig', () => {
  it('hides the values of env and headers and keeps their names', () => {
    expect(redactUserMcpConfig({ type: 'stdio', command: 'npx', env: { TOKEN: 'abc' }, headers: { Authorization: 'Bearer x' } }))
      .toEqual({ type: 'stdio', command: 'npx', env: { TOKEN: '[redacted]' }, headers: { Authorization: '[redacted]' } });
    expect(redactUserMcpConfig({ type: 'sse', url: 'https://x' })).toEqual({ type: 'sse', url: 'https://x' });
  });
});
