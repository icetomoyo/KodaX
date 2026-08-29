import { afterEach, describe, expect, it } from 'vitest';

import {
  applyConfigEnvironment,
  inspectConfigEnvironmentSource,
  KODAX_CONFIG_ENV_BINDINGS,
} from './utils.js';

const ENV_NAMES = KODAX_CONFIG_ENV_BINDINGS.map((binding) => binding.env);
const ORIGINAL_ENV = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('config.json environment bindings', () => {
  it('keeps one unique semantic mapping per config path and environment name', () => {
    const configPaths = KODAX_CONFIG_ENV_BINDINGS.map((binding) => binding.configPath);
    expect(new Set(configPaths).size).toBe(configPaths.length);
    expect(new Set(ENV_NAMES).size).toBe(ENV_NAMES.length);
    expect(KODAX_CONFIG_ENV_BINDINGS).toEqual(expect.arrayContaining([
      { configPath: 'provider', env: 'KODAX_PROVIDER' },
      { configPath: 'effort', env: 'KODAX_EFFORT' },
      { configPath: 'runtimeMode', env: 'KODAX_RUNTIME_MODE' },
      { configPath: 'sessionRetentionDays', env: 'KODAX_SESSION_RETENTION_DAYS' },
      { configPath: 'lspAutoDownload', env: 'KODAX_LSP_DOWNLOAD' },
      { configPath: 'repoIntelligenceMode', env: 'KODAX_REPO_INTELLIGENCE' },
      { configPath: 'sandbox.envPass', env: 'KODAX_SANDBOX_ENV_PASS' },
    ]));
  });

  it('projects config values into canonical env names without overriding shell values', () => {
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.KODAX_PROVIDER = 'shell-provider';

    applyConfigEnvironment({
      provider: 'config-provider',
      effort: 'high',
      runtimeMode: 'daemon',
      verifierLog: false,
      sessionRetentionDays: 14,
      lspAutoDownload: true,
      repoIntelligenceMode: 'full',
      repoIntelligence: { toolWaitMs: 250 },
      workflow: { maxConcurrency: 3 },
      sandbox: { envPass: ['GH_TOKEN', 'GITHUB_TOKEN'] },
    });

    expect(process.env.KODAX_PROVIDER).toBe('shell-provider');
    expect(process.env.KODAX_EFFORT).toBe('high');
    expect(process.env.KODAX_RUNTIME_MODE).toBe('daemon');
    expect(process.env.KODAX_VERIFIER_LOG).toBe('0');
    expect(process.env.KODAX_SESSION_RETENTION_DAYS).toBe('14');
    expect(process.env.KODAX_LSP_DOWNLOAD).toBe('1');
    expect(process.env.KODAX_REPO_INTELLIGENCE).toBe('full');
    expect(process.env.KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS).toBe('250');
    expect(process.env.KODAX_WORKFLOW_MAX_CONCURRENCY).toBe('3');
    expect(process.env.KODAX_SANDBOX_ENV_PASS).toBe('GH_TOKEN,GITHUB_TOKEN');
  });

  it('updates and clears values previously projected from config', () => {
    delete process.env.KODAX_EFFORT;

    applyConfigEnvironment({ effort: 'high' });
    expect(process.env.KODAX_EFFORT).toBe('high');
    expect(inspectConfigEnvironmentSource('KODAX_EFFORT')).toBe('persisted');

    applyConfigEnvironment({ effort: 'low' });
    expect(process.env.KODAX_EFFORT).toBe('low');

    applyConfigEnvironment({});
    expect(process.env.KODAX_EFFORT).toBeUndefined();
  });

  it('stops projecting when a caller replaces a projected value', () => {
    delete process.env.KODAX_EFFORT;
    applyConfigEnvironment({ effort: 'high' });

    process.env.KODAX_EFFORT = 'shell-value';
    expect(inspectConfigEnvironmentSource('KODAX_EFFORT')).toBe('environment');
    applyConfigEnvironment({ effort: 'low' });

    expect(process.env.KODAX_EFFORT).toBe('shell-value');
  });
});
