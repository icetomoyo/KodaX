import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXCustomProviderConfig } from '@kodax/coding';

const { registerCustomProvidersMock } = vi.hoisted(() => ({
  registerCustomProvidersMock: vi.fn(),
}));

vi.mock('@kodax/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax/coding')>();
  return {
    ...actual,
    registerCustomProviders: registerCustomProvidersMock,
  };
});

import {
  hydrateProcessEnvFromShell,
  registerConfiguredCustomProviders,
  resetShellEnvironmentHydrationForTesting,
} from './utils.js';

const CUSTOM_PROVIDER: KodaXCustomProviderConfig = {
  name: 'custom-openai',
  protocol: 'openai',
  baseUrl: 'https://example.test/v1',
  apiKeyEnv: 'CUSTOM_OPENAI_API_KEY',
  model: 'custom-model',
};

describe('runtime bootstrap helpers', () => {
  beforeEach(() => {
    registerCustomProvidersMock.mockReset();
    resetShellEnvironmentHydrationForTesting();
  });

  describe('hydrateProcessEnvFromShell', () => {
    it('hydrates missing variables from the user shell without overwriting inherited values', () => {
      const env: NodeJS.ProcessEnv = {
        SHELL: '/bin/zsh',
        PATH: '/usr/bin',
        EXISTING_TOKEN: 'keep-me',
      };
      const run = vi.fn().mockReturnValue({
        status: 0,
        stdout: [
          'shell banner',
          '__KODAX_SHELL_ENV_START__\0',
          'CUSTOM_OPENAI_API_KEY=from-shell\0',
          'EXISTING_TOKEN=override-attempt\0',
          'PATH=/opt/homebrew/bin:/usr/bin\0',
        ].join(''),
        stderr: '',
        signal: null,
        pid: 1234,
        output: [],
      } as const);

      const hydrated = hydrateProcessEnvFromShell({
        env,
        platform: 'darwin',
        run,
        shell: '/bin/zsh',
      });

      expect(hydrated).toBe(true);
      expect(env.CUSTOM_OPENAI_API_KEY).toBe('from-shell');
      expect(env.EXISTING_TOKEN).toBe('keep-me');
      expect(env.PATH).toBe('/usr/bin');
        expect(run).toHaveBeenCalledWith(
          '/bin/zsh',
          ['-ic', "printf '%s\\0' '__KODAX_SHELL_ENV_START__'; env -0"],
          expect.objectContaining({
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
          }),
        );
      });

      it('uses fish interactive mode with a separate command flag', () => {
        const env: NodeJS.ProcessEnv = {
          SHELL: '/usr/bin/fish',
        };
        const run = vi.fn().mockReturnValue({
          status: 0,
          stdout: [
            '__KODAX_SHELL_ENV_START__\0',
            'CUSTOM_OPENAI_API_KEY=from-fish\0',
          ].join(''),
          stderr: '',
          signal: null,
          pid: 1234,
          output: [],
        } as const);

        const hydrated = hydrateProcessEnvFromShell({
          env,
          platform: 'linux',
          run,
          shell: '/usr/bin/fish',
        });

        expect(hydrated).toBe(true);
        expect(env.CUSTOM_OPENAI_API_KEY).toBe('from-fish');
        expect(run).toHaveBeenCalledWith(
          '/usr/bin/fish',
          ['-i', '-c', "printf '%s\\0' '__KODAX_SHELL_ENV_START__'; env -0"],
          expect.objectContaining({
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
          }),
        );
      });

      it('skips shell hydration on Windows and when the shell path is unavailable', () => {
        const run = vi.fn();

      expect(
        hydrateProcessEnvFromShell({
          env: { SHELL: '/bin/zsh' },
          platform: 'win32',
          run,
        }),
      ).toBe(false);
      expect(
        hydrateProcessEnvFromShell({
          env: {},
          platform: 'darwin',
          run,
        }),
      ).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('registerConfiguredCustomProviders', () => {
    it('registers configured custom providers verbatim', () => {
      registerConfiguredCustomProviders({
        customProviders: [CUSTOM_PROVIDER],
      });

      expect(registerCustomProvidersMock).toHaveBeenCalledWith([CUSTOM_PROVIDER]);
    });

    it('clears the custom provider registry when no custom providers are configured', () => {
      registerConfiguredCustomProviders({});

      expect(registerCustomProvidersMock).toHaveBeenCalledWith([]);
    });
  });
});
