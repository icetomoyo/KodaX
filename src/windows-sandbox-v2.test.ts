import { describe, expect, it } from 'vitest';

import {
  asrtWindowsNetworkOnlyConfig,
  createWindowsSandboxV2RunRequest,
  encodeWindowsSandboxV2Bootstrap,
  splitAsrtWindowsInvocation,
  windowsSandboxV2PolicyCapabilitySid,
  windowsSandboxV2PolicyFingerprint,
  windowsSandboxV2Generation,
} from './windows-sandbox-v2.js';
import { mergeWindowsSandboxTargetEnvironment } from './windows-git-sandbox.js';

describe('Windows sandbox v2 policy and ASRT boundary', () => {
  it('keeps ASRT network policy while disabling its filesystem authority', () => {
    const original = {
      network: {
        allowedDomains: ['example.com'],
        deniedDomains: ['blocked.example'],
      },
      filesystem: {
        denyRead: ['C:\\secret'],
        allowRead: ['C:\\workspace'],
        allowWrite: ['C:\\workspace'],
        denyWrite: ['C:\\workspace\\locked'],
      },
    };

    const networkOnly = asrtWindowsNetworkOnlyConfig(original);

    expect(networkOnly).toEqual({
      ...original,
      filesystem: {
        ...original.filesystem,
        disabled: true,
        denyRead: [],
        allowRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    });
    expect(original.filesystem).not.toHaveProperty('disabled');
  });

  it('splits the ASRT launch prefix from the exact final target argv', () => {
    expect(splitAsrtWindowsInvocation({
      executable: 'C:\\runner\\srt-win.exe',
      args: [
        'exec',
        '--quiet',
        '--env',
        'HTTP_PROXY=http://127.0.0.1:40000',
        '--',
        'C:\\Program Files\\nodejs\\node.exe',
        '-e',
        'helper source',
      ],
    })).toEqual({
      executable: 'C:\\runner\\srt-win.exe',
      prefixArgs: [
        'exec',
        '--quiet',
        '--',
      ],
      childEnvironment: {
        HTTP_PROXY: 'http://127.0.0.1:40000',
      },
      targetArgv: [
        'C:\\Program Files\\nodejs\\node.exe',
        '-e',
        'helper source',
      ],
    });
  });

  it('rejects an ASRT descriptor without one unambiguous target separator', () => {
    expect(() => splitAsrtWindowsInvocation({
      executable: 'srt-win.exe',
      args: ['exec', 'cmd.exe'],
    })).toThrow('target separator');
    expect(() => splitAsrtWindowsInvocation({
      executable: 'srt-win.exe',
      args: ['exec', '--', 'cmd.exe', '--', 'other.exe'],
    })).toThrow('exactly one');
    expect(() => splitAsrtWindowsInvocation({
      executable: 'srt-win.exe',
      args: ['exec', '--ENV=SECRET=value', '--', 'cmd.exe'],
    })).toThrow(/inline environment/i);
  });

  it('collapses real ASRT case aliases with Windows last-assignment semantics', () => {
    expect(splitAsrtWindowsInvocation({
      executable: 'srt-win.exe',
      args: [
        'exec',
        '--env',
        'HTTP_PROXY=first',
        '--env',
        'http_proxy=second',
        '--',
        'cmd.exe',
      ],
    }).childEnvironment).toEqual({ http_proxy: 'second' });
  });

  it('derives one stable policy capability independent of input ordering and casing', () => {
    const first = windowsSandboxV2PolicyFingerprint({
      generation: 'generation-a',
      allowWrite: ['C:\\Work\\Repo', 'D:\\Cache'],
      denyWrite: ['C:\\Work\\Repo\\.git'],
    });
    const second = windowsSandboxV2PolicyFingerprint({
      generation: 'generation-a',
      allowWrite: ['d:/cache', 'c:/work/repo', 'D:\\CACHE'],
      denyWrite: ['c:/work/repo/.git'],
    });

    expect(second).toBe(first);
    expect(windowsSandboxV2PolicyCapabilitySid(first)).toMatch(
      /^S-1-5-21(?:-\d+){4}$/,
    );
    expect(windowsSandboxV2PolicyCapabilitySid(second)).toBe(
      windowsSandboxV2PolicyCapabilitySid(first),
    );
  });

  it('changes the capability when the generation or deny policy changes', () => {
    const base = windowsSandboxV2PolicyFingerprint({
      generation: 'generation-a',
      allowWrite: ['C:\\work'],
      denyWrite: [],
    });
    const changedGeneration = windowsSandboxV2PolicyFingerprint({
      generation: 'generation-b',
      allowWrite: ['C:\\work'],
      denyWrite: [],
    });
    const changedDeny = windowsSandboxV2PolicyFingerprint({
      generation: 'generation-a',
      allowWrite: ['C:\\work'],
      denyWrite: ['C:\\work\\locked'],
    });

    expect(windowsSandboxV2PolicyCapabilitySid(changedGeneration)).not.toBe(
      windowsSandboxV2PolicyCapabilitySid(base),
    );
    expect(windowsSandboxV2PolicyCapabilitySid(changedDeny)).not.toBe(
      windowsSandboxV2PolicyCapabilitySid(base),
    );
  });

  it('binds one native request to its immutable policy and controller', () => {
    const generation = windowsSandboxV2Generation({
      sandboxUserSid: 'S-1-5-21-1-2-3-1001',
      sandboxGroupSid: 'S-1-5-21-1-2-3-1000',
      asrtSha256: 'a'.repeat(64),
      shellSha256: 'b'.repeat(64),
    });
    const request = createWindowsSandboxV2RunRequest({
      generation,
      sandboxUserSid: 'S-1-5-21-1-2-3-1001',
      sandboxGroupSid: 'S-1-5-21-1-2-3-1000',
      asrtInvocation: {
        executable: 'C:\\runner\\srt-win.exe',
        prefixArgs: ['exec', '--quiet', '--'],
        targetArgv: ['cmd.exe', '/c', 'sentinel'],
        childEnvironment: {},
      },
      targetArgv: ['cmd.exe', '/d', '/s', '/c', 'echo hello'],
      cwd: 'C:\\work',
      allowRead: ['C:\\work'],
      allowWrite: ['C:\\work'],
      denyRead: ['C:\\secret'],
      denyWrite: ['C:\\work\\.git'],
      controllerPipe: '\\\\.\\pipe\\kodax-v2-1234-12345678-1234-1234-1234-123456789abc',
      launchDeadlineUnixMs: 123_456,
    });

    expect(request).toMatchObject({
      protocol: 4,
      generation,
      sandboxUserSid: 'S-1-5-21-1-2-3-1001',
      sandboxGroupSid: 'S-1-5-21-1-2-3-1000',
      asrtExecutable: 'C:\\runner\\srt-win.exe',
      asrtPrefixArgs: ['exec', '--quiet', '--'],
      targetArgv: ['cmd.exe', '/d', '/s', '/c', 'echo hello'],
      controllerPipe: '\\\\.\\pipe\\kodax-v2-1234-12345678-1234-1234-1234-123456789abc',
      launchDeadlineUnixMs: 123_456,
    });
    expect(request.policyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(request.policyCapabilitySid).toBe(
      windowsSandboxV2PolicyCapabilitySid(request.policyFingerprint),
    );
  });

  it('rejects a request without an exact ASRT prefix or private pipe', () => {
    const base = {
      generation: 'g',
      sandboxUserSid: 'S-1-5-21-1-2-3-1001',
      sandboxGroupSid: 'S-1-5-21-1-2-3-1000',
      targetArgv: ['cmd.exe'],
      cwd: 'C:\\work',
      allowRead: [],
      allowWrite: ['C:\\work'],
      denyRead: [],
      denyWrite: [],
      launchDeadlineUnixMs: 123_456,
    } as const;
    expect(() => createWindowsSandboxV2RunRequest({
      ...base,
      controllerPipe: '\\\\.\\pipe\\short',
      asrtInvocation: {
        executable: 'srt-win.exe',
        prefixArgs: ['exec'],
        targetArgv: ['cmd.exe'],
        childEnvironment: {},
      },
    })).toThrow(/controller pipe|ASRT prefix/);
    expect(() => createWindowsSandboxV2RunRequest({
      ...base,
      sandboxGroupSid: base.sandboxUserSid,
      controllerPipe: '\\\\.\\pipe\\kodax-v2-1234-12345678-1234-1234-1234-123456789abc',
      asrtInvocation: {
        executable: 'srt-win.exe',
        prefixArgs: ['exec', '--'],
        targetArgv: ['cmd.exe'],
        childEnvironment: {},
      },
    })).toThrow(/independent account group/);
  });

  it('encodes target environment only in the private bounded bootstrap frame', () => {
    const frame = encodeWindowsSandboxV2Bootstrap({ Path: 'C:\\bin', SECRET: 'sentinel' });
    const length = frame.readUInt32LE(0);
    const message = JSON.parse(frame.subarray(4).toString('utf8')) as {
      protocol: number;
      targetEnvironment: Array<{ name: string; value: string }>;
    };
    expect(length).toBe(frame.byteLength - 4);
    expect(message).toEqual({
      protocol: 4,
      targetEnvironment: [
        { name: 'Path', value: 'C:\\bin' },
        { name: 'SECRET', value: 'sentinel' },
      ],
    });
    expect(() => encodeWindowsSandboxV2Bootstrap({ Path: 'one', PATH: 'two' }))
      .toThrow(/ambiguous/i);
    const unicode = encodeWindowsSandboxV2Bootstrap({ '环境': '值' });
    expect(JSON.parse(unicode.subarray(4).toString('utf8'))).toMatchObject({
      targetEnvironment: [{ name: '环境', value: '值' }],
    });
  });

  it('merges ASRT control and target environments without argv-shaped secret material', () => {
    const merged = mergeWindowsSandboxTargetEnvironment({
      HTTP_PROXY: 'http://127.0.0.1:40000',
      Path: 'C:\\asrt',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
    }, {
      HTTP_PROXY: 'http://untrusted.invalid',
      PATH: 'C:\\target',
      SECRET: 'sentinel',
    }, ['C:/workspace']);

    expect(merged).toMatchObject({
      HTTP_PROXY: 'http://127.0.0.1:40000',
      PATH: 'C:\\target',
      SECRET: 'sentinel',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: 'C:/workspace',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: 'C:/workspace/*',
    });
    expect(Object.keys(merged)).not.toContain('Path');
  });
});
