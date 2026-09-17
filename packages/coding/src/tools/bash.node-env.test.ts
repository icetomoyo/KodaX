import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXShellExecutionContract } from '../types.js';
import { clearShellExecutionEnvironmentCache } from '../shell-execution/resolver.js';
import { toolBash } from './bash.js';

const require = createRequire(import.meta.url);
const preloadPath = resolve('scripts/production-env.cjs');
const shellExecution: KodaXShellExecutionContract = {
  version: 1,
  shell: { kind: process.platform === 'win32' ? 'cmd' : 'bash', profile: 'none' },
};

describe('user shell NODE_ENV isolation', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'kodax-shell-node-env-'));
    for (const name of Object.keys(process.env)) {
      if (/^npm_config_/i.test(name)) vi.stubEnv(name, undefined);
    }
    for (const name of ['NODE_ENV', 'KODAX_INTERNAL_NODE_ENV', 'KODAX_DEV']) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv('KODAX_DISABLE_HARDENING', '1');
    vi.stubEnv('ELECTRON_RUN_AS_NODE', undefined);
    vi.stubEnv('npm_config_userconfig', join(cwd, 'user.npmrc'));
    vi.stubEnv('npm_config_globalconfig', join(cwd, 'global.npmrc'));
    await writeFile(join(cwd, 'user.npmrc'), '');
    await writeFile(join(cwd, 'global.npmrc'), '');
    delete require.cache[preloadPath];
    clearShellExecutionEnvironmentCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete require.cache[preloadPath];
    clearShellExecutionEnvironmentCache();
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(['legacy', 'configured', 'sandbox'])(
    'keeps the CLI in production without making npm omit devDependencies (%s)', async (mode) => {
      require(preloadPath);
      // The packaged bootstrap can execute the preload again after the CJS shim.
      delete require.cache[preloadPath];
      require(preloadPath);

      const result = await toolBash({ command: 'npm config get omit' }, {
        backups: new Map(),
        executionCwd: cwd,
        ...(mode === 'legacy' ? {} : { shellExecution }),
        ...(mode !== 'sandbox' ? {} : {
          shellSandbox: {
            prepare: async (input) => {
              expect(input.env?.NODE_ENV).toBeUndefined();
              expect(input.env?.KODAX_INTERNAL_NODE_ENV).toBeUndefined();
              if (input.executable === undefined || input.args === undefined) {
                throw new Error('Expected a resolved shell invocation');
              }
              return {
                executable: input.executable,
                args: input.args,
                env: input.env,
                windowsVerbatimArguments: input.windowsVerbatimArguments,
                cleanup: async () => undefined,
              };
            },
          },
        }),
      });

      expect(result).toContain('\nExit: 0\n');
      expect(result.split('\nExit: 0\n')[1]?.trim()).toBe('');
      expect(process.env.NODE_ENV).toBe('production');
    },
  );

  it.each(['production', 'development', 'test', ''])('preserves explicit NODE_ENV=%j', async (value) => {
    vi.stubEnv('NODE_ENV', value);
    require(preloadPath);
    await writeFile(join(cwd, 'inspect-env.cjs'),
      "process.stdout.write(JSON.stringify(process.env.NODE_ENV ?? null));");

    const result = await toolBash({ command: 'node inspect-env.cjs' }, { backups: new Map(), executionCwd: cwd });

    expect(result).toContain('\nExit: 0\n');
    expect(result.split('\nExit: 0\n')[1]?.trim()).toBe(JSON.stringify(value));
    expect(process.env.NODE_ENV).toBe(value);
  });

  it('keeps npm production semantics when the user explicitly requests production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    require(preloadPath);
    const result = await toolBash({ command: 'npm config get omit' }, {
      backups: new Map(), executionCwd: cwd, shellExecution,
    });
    expect(result).toContain('\nExit: 0\n');
    expect(result.split('\nExit: 0\n')[1]?.trim()).toBe('dev');
  });

  it('allows environment.set to explicitly restore production for a user command', async () => {
    require(preloadPath);
    const result = await toolBash({ command: 'npm config get omit' }, {
      backups: new Map(), executionCwd: cwd,
      shellExecution: { ...shellExecution, environment: { set: { NODE_ENV: 'production' } } },
    });
    expect(result).toContain('\nExit: 0\n');
    expect(result.split('\nExit: 0\n')[1]?.trim()).toBe('dev');
  });

  it('preserves a shell setup that explicitly selects production', async () => {
    require(preloadPath);
    const result = await toolBash({ command: 'npm config get omit' }, {
      backups: new Map(), executionCwd: cwd,
      shellExecution: {
        ...shellExecution,
        environment: { setup: process.platform === 'win32' ? 'set NODE_ENV=production' : 'export NODE_ENV=production' },
      },
    });
    expect(result).toContain('\nExit: 0\n');
    expect(result.split('\nExit: 0\n')[1]?.trim()).toBe('dev');
  });

  it('keeps KODAX_DEV local to KodaX', async () => {
    vi.stubEnv('KODAX_DEV', '1');
    require(preloadPath);
    await writeFile(join(cwd, 'inspect-env.cjs'),
      "process.stdout.write(JSON.stringify({nodeEnv:process.env.NODE_ENV??null,marker:process.env.KODAX_INTERNAL_NODE_ENV??null}));");
    const result = await toolBash({ command: 'node inspect-env.cjs' }, {
      backups: new Map(), executionCwd: cwd, shellExecution,
    });
    expect(result).toContain('\nExit: 0\n');
    expect(result.split('\nExit: 0\n')[1]?.trim()).toBe('{"nodeEnv":null,"marker":null}');
    expect(process.env.NODE_ENV).toBe('development');
  });
});
