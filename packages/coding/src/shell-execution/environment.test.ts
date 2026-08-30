import { describe, expect, it } from 'vitest';

import type { KodaXShellExecutionContract } from '../types.js';
import {
  buildShellProbeEnvironment,
  environmentNameMatchesPattern,
  hardenShellCommandEnvironment,
  mergeWindowsRegistryEnvironment,
  mergeWindowsRegistryPath,
  parseWindowsRegistryEnvironment,
  parseWindowsRegistryPath,
  sanitizeResolvedShellEnvironment,
} from './environment.js';

const contract: KodaXShellExecutionContract = {
  version: 1,
  shell: { kind: 'cmd' },
  environment: {
    inherit: 'filtered',
    denyPatterns: ['PRIVATE_*'],
    set: { KODAX_VISIBLE: 'yes' },
  },
};

describe('shell execution environment', () => {
  it('inherits the host environment while removing only KodaX and Electron controls', () => {
    expect(hardenShellCommandEnvironment({
      PATH: 'C:\\Windows\\System32',
      nodefaultcurrentdirectoryinexepath: 'user-controlled',
      Node_Options: '--require=C:\\hook.js',
      BASH_ENV: 'C:\\hook.sh',
      ELECTRON_RUN_AS_NODE: '1',
      KODAX_EFFECT_COMMAND_JSON: '{}',
    }, 'cmd', 'win32')).toEqual({
      PATH: 'C:\\Windows\\System32',
      Node_Options: '--require=C:\\hook.js',
      BASH_ENV: 'C:\\hook.sh',
      NoDefaultCurrentDirectoryInExePath: '1',
    });
    expect(hardenShellCommandEnvironment({
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require=/tmp/hook.js',
      BASH_ENV: '/tmp/hook.sh',
    }, 'bash', 'linux'))
      .toEqual({
        PATH: '/usr/bin',
        NODE_OPTIONS: '--require=/tmp/hook.js',
        BASH_ENV: '/tmp/hook.sh',
      });
  });

  it('preserves ordinary shell and tool configuration variables', () => {
    const source = {
      PATH: '/usr/bin',
      RIPGREP_CONFIG_PATH: '/tmp/untrusted-rg.conf',
      'BASH_FUNC_cat%%': '() { node /tmp/hook.js; }',
      'BASH_FUNC_git()': '() { node /tmp/hook.js; }',
      SAFE_VALUE: 'safe',
    };

    expect(hardenShellCommandEnvironment(source, 'bash', 'linux')).toEqual({
      ...source,
    });
    expect(buildShellProbeEnvironment(source, {
      version: 1,
      shell: { kind: 'bash' },
      environment: { inherit: 'filtered' },
    }, undefined, 'linux')).toHaveProperty('RIPGREP_CONFIG_PATH', '/tmp/untrusted-rg.conf');
    expect(sanitizeResolvedShellEnvironment(source as Record<string, string>, {
      version: 1,
      shell: { kind: 'bash' },
    }, 'linux')).toEqual({
      ...source,
    });
  });

  it('inherits PATH without rewriting host entries', () => {
    expect(hardenShellCommandEnvironment({
      PATH: '/workspace/node_modules/.bin:relative-bin:/usr/local/bin:/usr/bin',
    }, 'bash', 'linux', [], '/workspace')).toEqual({
      PATH: '/workspace/node_modules/.bin:relative-bin:/usr/local/bin:/usr/bin',
    });
    expect(hardenShellCommandEnvironment({
      Path: 'C:\\workspace\\bin;.;C:\\Windows\\System32',
    }, 'cmd', 'win32', [], 'C:\\workspace')).toMatchObject({
      Path: 'C:\\workspace\\bin;.;C:\\Windows\\System32',
      NoDefaultCurrentDirectoryInExePath: '1',
    });
  });

  it('inherits built-in and active Provider credentials', () => {
    expect(hardenShellCommandEnvironment({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'built-in-secret',
      ANTHROPIC_AUTH_TOKEN: 'built-in-token',
      CUSTOM_PROVIDER_AUTH: 'custom-secret',
      SAFE_VALUE: 'safe',
    }, 'bash', 'linux')).toEqual({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'built-in-secret',
      ANTHROPIC_AUTH_TOKEN: 'built-in-token',
      CUSTOM_PROVIDER_AUTH: 'custom-secret',
      SAFE_VALUE: 'safe',
    });
  });

  it('does not require an allowlist for credentials or ordinary runtime variables', () => {
    expect(hardenShellCommandEnvironment({
      PATH: 'C:\\Windows\\System32',
      GH_TOKEN: 'gh-secret',
      github_token: 'github-secret',
      OPENAI_API_KEY: 'provider-secret',
      NODE_OPTIONS: '--require=C:\\hook.js',
      SAFE_VALUE: 'safe',
    }, 'cmd', 'win32')).toEqual({
      PATH: 'C:\\Windows\\System32',
      GH_TOKEN: 'gh-secret',
      github_token: 'github-secret',
      OPENAI_API_KEY: 'provider-secret',
      NODE_OPTIONS: '--require=C:\\hook.js',
      SAFE_VALUE: 'safe',
      NoDefaultCurrentDirectoryInExePath: '1',
    });

    expect(hardenShellCommandEnvironment({
      PATH: '/usr/bin',
      github_token: 'case-sensitive-secret',
    }, 'bash', 'linux')).toEqual({
      PATH: '/usr/bin',
      github_token: 'case-sensitive-secret',
    });
  });

  it('keeps credentials before profile startup and after profile resolution', () => {
    const source = {
      PATH: 'C:\\system',
      OPENAI_API_KEY: 'provider-secret',
      CUSTOM_PROVIDER_AUTH: 'provider-secret-with-a-nonstandard-name',
      PRIVATE_NOTE: 'private',
      NODE_OPTIONS: '--require=C:\\stale-hook.js',
      SAFE_VALUE: 'safe',
    };
    const bootstrap = buildShellProbeEnvironment(
      source,
      contract,
      'C:\\scratch',
      'win32',
    );
    expect(bootstrap).toMatchObject({
      PATH: 'C:\\system',
      SAFE_VALUE: 'safe',
      KODAX_VISIBLE: 'yes',
      KODAX_SESSION_TMP: 'C:\\scratch',
    });
    expect(bootstrap).toHaveProperty('OPENAI_API_KEY', 'provider-secret');
    expect(bootstrap).toHaveProperty('CUSTOM_PROVIDER_AUTH', 'provider-secret-with-a-nonstandard-name');
    expect(bootstrap).not.toHaveProperty('PRIVATE_NOTE');
    expect(bootstrap).toHaveProperty('NODE_OPTIONS', '--require=C:\\stale-hook.js');

    const resolved = sanitizeResolvedShellEnvironment({
      ...bootstrap as Record<string, string>,
      ANTHROPIC_API_KEY: 'profile-secret',
      CUSTOM_PROVIDER_AUTH: 'profile-secret-with-a-nonstandard-name',
      BASH_ENV: '/tmp/untrusted',
    }, contract, 'win32');
    expect(resolved).toHaveProperty('ANTHROPIC_API_KEY', 'profile-secret');
    expect(resolved).toHaveProperty('CUSTOM_PROVIDER_AUTH', 'profile-secret-with-a-nonstandard-name');
    expect(resolved).toHaveProperty('BASH_ENV', '/tmp/untrusted');
  });

  it('supports explicit bounded glob denies', () => {
    expect(environmentNameMatchesPattern('PRIVATE_TOKEN', 'PRIVATE_*')).toBe(true);
    expect(environmentNameMatchesPattern('PUBLIC_VALUE', 'PRIVATE_*')).toBe(false);
    expect(() => buildShellProbeEnvironment(
      { PATH: 'C:\\system' },
      {
        version: 1,
        shell: { kind: 'cmd' },
        environment: {
          denyPatterns: ['CUSTOM_PROVIDER_*'],
          set: { CUSTOM_PROVIDER_AUTH: 'must-not-be-reintroduced' },
        },
      },
      undefined,
      'win32',
    )).toThrow(/denied variable/i);
  });

  it('parses and merges current Windows Machine/User PATH values', () => {
    const machine = parseWindowsRegistryPath(
      '    Path    REG_EXPAND_SZ    %SystemRoot%\\System32;C:\\machine\n',
    );
    const user = parseWindowsRegistryPath(
      '    Path    REG_SZ    C:\\Users\\me\\bin\n',
    );
    expect(mergeWindowsRegistryPath(
      { SystemRoot: 'C:\\Windows', PATH: 'C:\\stale' },
      machine,
      user,
    ).PATH).toBe(
      'C:\\Windows\\System32;C:\\machine;C:\\Users\\me\\bin',
    );
  });

  it('expands current Windows registry variables without reusing stale daemon values', () => {
    const machine = parseWindowsRegistryEnvironment([
      'HKEY_LOCAL_MACHINE\\Environment',
      '    Path    REG_EXPAND_SZ    %SystemRoot%\\System32;C:\\machine',
      '    VOLTA_HOME    REG_SZ    C:\\fresh-volta',
    ].join('\r\n'));
    const user = parseWindowsRegistryEnvironment([
      'HKEY_CURRENT_USER\\Environment',
      '    Path    REG_EXPAND_SZ    %PATH%;%VOLTA_HOME%\\bin;C:\\user',
    ].join('\r\n'));

    expect(mergeWindowsRegistryEnvironment(
      {
        SystemRoot: 'C:\\Windows',
        PATH: 'C:\\stale-daemon',
        VOLTA_HOME: 'C:\\old-volta',
      },
      machine,
      user,
    )).toMatchObject({
      PATH: 'C:\\Windows\\System32;C:\\machine;C:\\fresh-volta\\bin;C:\\user',
      VOLTA_HOME: 'C:\\fresh-volta',
    });
  });

  it('does not reintroduce Session scratch variables denied by the host', () => {
    const result = buildShellProbeEnvironment(
      { PATH: 'C:\\system' },
      {
        version: 1,
        shell: { kind: 'cmd' },
        environment: { denyPatterns: ['KODAX_*'] },
      },
      'C:\\private-session-scratch',
      'win32',
    );

    expect(result).not.toHaveProperty('KODAX_SESSION_TMP');
  });
});
