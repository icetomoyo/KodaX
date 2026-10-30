import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProviderSetupConfigConflictError,
  ProviderSetupInvalidConfigError,
  inspectProviderSetupReadiness,
  persistProviderSetupChoice,
  providerSetupRestartInstructions,
  type ProviderSetupCatalogEntry,
  type ProviderSetupChoice,
} from './provider-setup.js';

let tempDirectory: string;
let configPath: string;

const catalog: readonly ProviderSetupCatalogEntry[] = [
  {
    name: 'alpha',
    apiKeyEnv: 'ALPHA_API_KEY',
    defaultModel: 'alpha-default',
    models: ['alpha-default', 'alpha-fast'],
  },
  {
    name: 'beta',
    apiKeyEnv: 'BETA_API_KEY',
    defaultModel: 'beta-default',
    models: ['beta-default'],
  },
];

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'kodax-provider-setup-'));
  configPath = join(tempDirectory, 'config.json');
});

afterEach(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  writeFileSync(configPath, JSON.stringify(value, null, 2), 'utf8');
}

it('persists the explicit Responses API through setup without changing omitted API defaults', () => {
  const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });
  persistProviderSetupChoice({ configPath, expectedRevision: readiness.configRevision, catalog, choice: {
    kind: 'custom', provider: { name: 'responses', protocol: 'openai', api: 'responses',
      model: 'model', baseUrl: 'https://example.test/v1', apiKeyEnv: 'RESPONSES_KEY' },
  } });
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
    customProviders: [{ name: 'responses', protocol: 'openai', api: 'responses' }],
  });
});

it('preserves subscription metadata and requires a host broker even when its placeholder environment variable is set', () => {
  writeConfig({ provider: 'subscription', customProviders: [{ name: 'subscription', protocol: 'openai', api: 'responses', oauth: 'openai-chatgpt',
    baseUrl: 'https://api.openai.com/v1', model: 'chosen', apiKeyEnv: 'KODAX_OAUTH_BROKER_ONLY' }] });
  expect(inspectProviderSetupReadiness({ configPath, catalog, environment: { KODAX_OAUTH_BROKER_ONLY: 'ignored' } }))
    .toMatchObject({ status: 'needs-host-broker', provider: 'subscription' });
});

describe('inspectProviderSetupReadiness', () => {
  it('offers first-run setup whenever config.json is missing, even if a credential already exists', () => {
    expect(inspectProviderSetupReadiness({
      configPath,
      catalog,
      environment: { ALPHA_API_KEY: 'already-configured-outside-kodax' },
    })).toMatchObject({
      status: 'needs-provider',
      configPath,
    });
  });

  it('keeps offering setup until config.json selects a provider', () => {
    writeConfig({});

    expect(inspectProviderSetupReadiness({
      configPath,
      catalog,
      environment: { ALPHA_API_KEY: 'already-configured-outside-kodax' },
    })).toMatchObject({
      status: 'needs-provider',
      configPath,
    });
  });

  it('does not override an explicit provider choice that still needs a credential', () => {
    expect(inspectProviderSetupReadiness({
      configPath,
      catalog,
      environment: {},
      explicitProvider: 'alpha',
    })).toMatchObject({
      status: 'needs-credential',
      provider: 'alpha',
      apiKeyEnv: 'ALPHA_API_KEY',
    });
  });

  it('recognizes a configured provider with its environment variable without exposing its value', () => {
    writeConfig({ provider: 'alpha', model: 'alpha-fast' });

    const readiness = inspectProviderSetupReadiness({
      configPath,
      catalog,
      environment: { ALPHA_API_KEY: 'do-not-display-me' },
    });

    expect(readiness).toMatchObject({
      status: 'ready',
      provider: 'alpha',
    });
    expect(JSON.stringify(readiness)).not.toContain('do-not-display-me');
  });

  it('keeps a valid configured provider out of automatic setup when its credential is absent', () => {
    writeConfig({ provider: 'beta' });

    expect(inspectProviderSetupReadiness({ configPath, catalog, environment: {} })).toMatchObject({
      status: 'needs-credential',
      provider: 'beta',
      apiKeyEnv: 'BETA_API_KEY',
    });
  });

  it('does not reinterpret a configured CLI bridge as an invalid API-key provider', () => {
    writeConfig({ provider: 'codex-cli', model: 'codex' });

    expect(inspectProviderSetupReadiness({ configPath, environment: {} })).toMatchObject({
      status: 'ready',
      provider: 'codex-cli',
    });
  });

  it('does not overwrite malformed JSON during first-run setup', () => {
    writeFileSync(configPath, '{ not json', 'utf8');

    const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });
    expect(readiness).toMatchObject({ status: 'invalid-config', configPath });
    expect(readFileSync(configPath, 'utf8')).toBe('{ not json');
  });

  it('treats malformed existing custom providers as invalid instead of offering a lossy setup', () => {
    writeConfig({ customProviders: [{ name: 'broken-existing-entry' }] });

    expect(inspectProviderSetupReadiness({ configPath, catalog, environment: {} })).toMatchObject({
      status: 'invalid-config',
      configPath,
      reason: expect.stringMatching(/customProviders/i),
    });
  });

  it('refuses to preserve an existing custom provider URL that carries a credential', () => {
    writeConfig({
      customProviders: [{
        name: 'unsafe-existing',
        protocol: 'openai',
        baseUrl: 'https://example.test/v1?x-api-key=private-value',
        apiKeyEnv: 'SAFE_ENV_NAME',
        model: 'example-model',
      }],
    });

    expect(inspectProviderSetupReadiness({ configPath, catalog, environment: {} })).toMatchObject({
      status: 'invalid-config',
      reason: expect.stringMatching(/credential query parameter/i),
    });
  });
});

describe('persistProviderSetupChoice', () => {
  it('atomically persists a built-in provider/model while preserving unrelated config', () => {
    writeConfig({ locale: 'zh-CN', extensions: ['example.js'] });
    const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });

    const result = persistProviderSetupChoice({
      configPath,
      expectedRevision: readiness.configRevision,
      catalog,
      choice: { kind: 'builtin', provider: 'alpha', model: 'alpha-fast' },
    });

    expect(result).toEqual({
      provider: 'alpha',
      model: 'alpha-fast',
      apiKeyEnv: 'ALPHA_API_KEY',
      configPath,
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      locale: 'zh-CN',
      extensions: ['example.js'],
      provider: 'alpha',
      model: 'alpha-fast',
    });
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it('rejects a stale setup screen instead of overwriting a concurrent config edit', () => {
    const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });
    writeConfig({ provider: 'beta', model: 'beta-default' });

    expect(() => persistProviderSetupChoice({
      configPath,
      expectedRevision: readiness.configRevision,
      catalog,
      choice: { kind: 'builtin', provider: 'alpha', model: 'alpha-default' },
    })).toThrow(ProviderSetupConfigConflictError);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ provider: 'beta' });
  });

  it('rechecks the revision after choice normalization before replacing config', () => {
    const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });
    let edited = false;
    const choice: ProviderSetupChoice = {
      kind: 'builtin',
      get provider() {
        if (!edited) {
          edited = true;
          writeConfig({ provider: 'beta', model: 'beta-default' });
        }
        return 'alpha';
      },
      model: 'alpha-default',
    };

    expect(() => persistProviderSetupChoice({
      configPath,
      expectedRevision: readiness.configRevision,
      catalog,
      choice,
    })).toThrow(ProviderSetupConfigConflictError);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      provider: 'beta',
      model: 'beta-default',
    });
  });

  it('serializes setup writers so two wizards cannot pass the same revision check', () => {
    const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });
    const lockPath = `${configPath}.write.lock`;
    const lock = openSync(lockPath, 'wx');
    try {
      expect(() => persistProviderSetupChoice({
        configPath,
        expectedRevision: readiness.configRevision,
        catalog,
        choice: { kind: 'builtin', provider: 'alpha', model: 'alpha-default' },
      })).toThrow(ProviderSetupConfigConflictError);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      closeSync(lock);
      rmSync(lockPath, { force: true });
    }
  });

  it('validates custom provider metadata and never accepts an API key value', () => {
    const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });

    expect(() => persistProviderSetupChoice({
      configPath,
      expectedRevision: readiness.configRevision,
      catalog,
      choice: {
        kind: 'custom',
        provider: {
          name: 'local',
          protocol: 'openai',
          baseUrl: 'https://example.test/v1',
          apiKeyEnv: 'NOT A VALID ENV NAME',
          model: 'local-model',
        },
      },
    })).toThrow(/environment variable name/i);
    expect(existsSync(configPath)).toBe(false);
  });

  it('drops unknown runtime fields instead of persisting an injected API key', () => {
    const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });
    const providerWithInjectedSecret = {
      name: 'runtime-injected',
      protocol: 'openai' as const,
      baseUrl: 'https://example.test/v1',
      apiKeyEnv: 'RUNTIME_INJECTED_API_KEY',
      model: 'runtime-model',
      apiKey: 'private-runtime-value',
    };

    persistProviderSetupChoice({
      configPath,
      expectedRevision: readiness.configRevision,
      catalog,
      choice: { kind: 'custom', provider: providerWithInjectedSecret },
    });

    const persisted = readFileSync(configPath, 'utf8');
    expect(persisted).not.toContain('private-runtime-value');
    expect(JSON.parse(persisted).customProviders[0]).not.toHaveProperty('apiKey');
  });

  it('rejects credentials embedded in a custom provider URL', () => {
    const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });

    expect(() => persistProviderSetupChoice({
      configPath,
      expectedRevision: readiness.configRevision,
      catalog,
      choice: {
        kind: 'custom',
        provider: {
          name: 'unsafe',
          protocol: 'openai',
          baseUrl: 'https://user:secret@example.test/v1',
          apiKeyEnv: 'SAFE_ENV_NAME',
          model: 'local-model',
        },
      },
    })).toThrow(/must not contain credentials/i);
    expect(existsSync(configPath)).toBe(false);
  });

  it('rejects credential-like query parameters while allowing public endpoint parameters', () => {
    const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });
    const choice = (baseUrl: string) => ({
      kind: 'custom' as const,
      provider: {
        name: 'query-provider',
        protocol: 'openai' as const,
        baseUrl,
        apiKeyEnv: 'QUERY_PROVIDER_API_KEY',
        model: 'local-model',
      },
    });

    expect(() => persistProviderSetupChoice({
      configPath,
      expectedRevision: readiness.configRevision,
      catalog,
      choice: choice('https://example.test/v1?api_key=secret'),
    })).toThrow(/credential query parameter/i);
    expect(existsSync(configPath)).toBe(false);

    expect(() => persistProviderSetupChoice({
      configPath,
      expectedRevision: readiness.configRevision,
      catalog,
      choice: choice('https://example.test/v1?api-version=2026-07-20'),
    })).not.toThrow();
  });

  it('refuses to discard malformed existing custom providers during a custom setup write', () => {
    writeConfig({
      locale: 'zh-CN',
      customProviders: [{ name: 'broken-existing-entry' }],
    });
    const readiness = inspectProviderSetupReadiness({ configPath, catalog, environment: {} });

    expect(() => persistProviderSetupChoice({
      configPath,
      expectedRevision: readiness.configRevision,
      catalog,
      choice: {
        kind: 'custom',
        provider: {
          name: 'local',
          protocol: 'openai',
          baseUrl: 'https://example.test/v1',
          apiKeyEnv: 'LOCAL_API_KEY',
          model: 'local-model',
        },
      },
    })).toThrow(ProviderSetupInvalidConfigError);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      locale: 'zh-CN',
      customProviders: [{ name: 'broken-existing-entry' }],
    });
  });
});

describe('providerSetupRestartInstructions', () => {
  it('explains the config-name and environment-value handoff without printing a key placeholder', () => {
    const text = providerSetupRestartInstructions({
      apiKeyEnv: 'ALPHA_API_KEY',
      platform: 'win32',
    }).join('\n');

    expect(text).toContain('ALPHA_API_KEY');
    expect(text).toMatch(/config\.json.*name only/i);
    expect(text).toMatch(/required next step/i);
    expect(text).toMatch(/provider.*API key.*value/i);
    expect(text).toMatch(/KodaX cannot set.*environment variable/i);
    expect(text).toContain('restart');
    expect(text).not.toContain('=');
    expect(text).not.toMatch(/<your-key>|paste/i);
  });
});
