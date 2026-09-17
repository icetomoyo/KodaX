import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isBareResumeRequest,
  isVersionRequest,
  runKodaXBootstrap,
  type BootstrapResumeRoute,
} from './kodax_bootstrap.js';

describe('KodaX CLI bootstrap', () => {
  it.each([
    [['-r']],
    [['--resume']],
  ])('routes the exact bare resume form through the lightweight selector: %j', async (args) => {
    const argv = ['node', 'kodax', ...args];
    const callOrder: string[] = [];
    const main = vi.fn(async () => undefined);
    const loadCli = vi.fn(async () => {
      callOrder.push('load-cli');
      return { main };
    });
    const resolveBareResume = vi.fn(async (options?: {
      readonly beforeSelect?: () => Promise<void>;
    }): Promise<BootstrapResumeRoute> => {
      callOrder.push('select');
      await options?.beforeSelect?.();
      callOrder.push('selected');
      return {
        kind: 'continue',
        argv: ['-r', 'selected-session'],
      };
    });
    const ref = vi.fn();
    const pause = vi.fn();

    await runKodaXBootstrap({
      argv,
      loadResume: async () => ({ resolveBareResume }),
      loadCli,
      stdin: { isTTY: true, pause, ref },
    });

    expect(resolveBareResume).toHaveBeenCalledTimes(1);
    expect(loadCli).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['select', 'load-cli', 'selected']);
    expect(argv.slice(2)).toEqual(['-r', 'selected-session']);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(ref).toHaveBeenCalledTimes(1);
    expect(main).toHaveBeenCalledTimes(1);
  });

  it.each([
    [[]],
    [['-r', 'session-id']],
    [['--resume', 'Session title']],
    [['-r', '--provider', 'openai']],
    [['--mode', 'json', '-r']],
  ])('keeps non-bare forms on the existing CLI parser: %j', async (args) => {
    const argv = ['node', 'kodax', ...args];
    const loadResume = vi.fn();
    const main = vi.fn(async () => undefined);
    const pause = vi.fn();
    const ref = vi.fn();

    await runKodaXBootstrap({
      argv,
      loadResume,
      loadCli: async () => ({ main }),
      stdin: { isTTY: true, pause, ref },
    });

    expect(loadResume).not.toHaveBeenCalled();
    expect(argv.slice(2)).toEqual(args);
    expect(pause).not.toHaveBeenCalled();
    expect(ref).not.toHaveBeenCalled();
    expect(main).toHaveBeenCalledTimes(1);
  });

  it('releases terminal input without loading the full CLI when the picker cancels', async () => {
    const loadCli = vi.fn();
    const pause = vi.fn();
    const ref = vi.fn();
    const unref = vi.fn();

    await runKodaXBootstrap({
      argv: ['node', 'kodax', '-r'],
      loadResume: async () => ({
        resolveBareResume: async () => ({ kind: 'exit' }),
      }),
      loadCli,
      stdin: { isTTY: true, pause, ref, unref },
    });

    expect(loadCli).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(ref).not.toHaveBeenCalled();
  });

  it('propagates selection preload failures without retaining stdin', async () => {
    const failure = new Error('CLI preload failed');
    const ref = vi.fn();

    await expect(runKodaXBootstrap({
      argv: ['node', 'kodax', '-r'],
      loadResume: async () => ({
        resolveBareResume: async (options) => {
          await options?.beforeSelect?.();
          return { kind: 'continue', argv: ['-r', 'unreachable'] };
        },
      }),
      loadCli: async () => { throw failure; },
      stdin: { isTTY: true, ref },
    })).rejects.toBe(failure);

    expect(ref).not.toHaveBeenCalled();
  });

  it('recognizes only an exact one-token bare resume request', () => {
    expect(isBareResumeRequest(['-r'])).toBe(true);
    expect(isBareResumeRequest(['--resume'])).toBe(true);
    expect(isBareResumeRequest(['-r', 'id'])).toBe(false);
    expect(isBareResumeRequest(['--provider', 'openai', '-r'])).toBe(false);
  });

  it.each([['-V'], ['--version']])(
    'prints version without loading the full CLI: %s',
    async (flag) => {
      const previousVersion = process.env.KODAX_VERSION;
      process.env.KODAX_VERSION = '9.8.7-test';
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const loadCli = vi.fn();
      try {
        await runKodaXBootstrap({
          argv: ['node', 'kodax', flag],
          loadCli,
        });
        expect(loadCli).not.toHaveBeenCalled();
        expect(write).toHaveBeenCalledWith('9.8.7-test\n');
      } finally {
        write.mockRestore();
        if (previousVersion === undefined) delete process.env.KODAX_VERSION;
        else process.env.KODAX_VERSION = previousVersion;
      }
    },
  );

  it('recognizes only exact version requests', () => {
    expect(isVersionRequest(['-V'])).toBe(true);
    expect(isVersionRequest(['--version'])).toBe(true);
    expect(isVersionRequest(['--version', 'extra'])).toBe(false);
    expect(isVersionRequest(['completion', '--version'])).toBe(false);
  });
});

describe('production environment preload', () => {
  const require = createRequire(import.meta.url);
  const preloadPath = path.resolve('scripts/production-env.cjs');
  const envKeys = [
    'NODE_ENV',
    'KODAX_INTERNAL_NODE_ENV',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'ELECTRON_RUN_AS_NODE',
    'KODAX_DISABLE_HARDENING',
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve(preloadPath)];
  });

  it('sets production mode and strips linker and Electron bootstrap variables', () => {
    delete process.env.NODE_ENV;
    delete process.env.KODAX_DISABLE_HARDENING;
    process.env.LD_PRELOAD = '/tmp/preload.so';
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/preload.dylib';
    process.env.DYLD_LIBRARY_PATH = '/tmp/lib';
    process.env.ELECTRON_RUN_AS_NODE = '1';

    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);

    expect(process.env.NODE_ENV).toBe('production');
    expect(process.env.LD_PRELOAD).toBeUndefined();
    expect(process.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(process.env.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('honors hardening opt-out but always consumes the Electron bootstrap variable', () => {
    process.env.KODAX_DISABLE_HARDENING = '1';
    process.env.LD_PRELOAD = '/tmp/preload.so';
    process.env.ELECTRON_RUN_AS_NODE = '1';

    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);

    expect(process.env.LD_PRELOAD).toBe('/tmp/preload.so');
    expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
