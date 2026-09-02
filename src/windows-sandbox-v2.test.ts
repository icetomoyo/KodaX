import { describe, expect, it } from 'vitest';

import {
  asrtWindowsNetworkOnlyConfig,
  createWindowsSandboxV2RunRequest,
  encodeWindowsSandboxV2Bootstrap,
  encodeWindowsSandboxV2ControlFrame,
  splitAsrtWindowsInvocation,
  windowsSandboxV2PolicyCapabilitySid,
  windowsSandboxV2PolicyFingerprint,
  windowsSandboxV2Generation,
} from './windows-sandbox-v2.js';
import { mergeWindowsSandboxTargetEnvironment } from './windows-git-sandbox.js';

describe('Windows sandbox v2 policy and ASRT boundary', () => {
  it('keeps target EOF and command termination as distinct control frames', () => {
    expect([...encodeWindowsSandboxV2ControlFrame('close-stdin')])
      .toEqual([1, 0, 0, 0, 5]);
    expect([...encodeWindowsSandboxV2ControlFrame('terminate')])
      .toEqual([1, 0, 0, 0, 10]);
  });

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
      windows: {
        proxyPortRange: [60_080, 60_143],
      },
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
      allowRead: ['C:\\Runtime'],
      allowWrite: ['C:\\Work\\Repo', 'D:\\Cache'],
      denyRead: ['C:\\Secret'],
      denyWrite: ['C:\\Work\\Repo\\.git'],
    });
    const second = windowsSandboxV2PolicyFingerprint({
      generation: 'generation-a',
      allowRead: ['c:/runtime'],
      allowWrite: ['d:/cache', 'c:/work/repo', 'D:\\CACHE'],
      denyRead: ['c:/secret'],
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
      allowRead: [],
      allowWrite: ['C:\\work'],
      denyRead: [],
      denyWrite: [],
    });
    const changedGeneration = windowsSandboxV2PolicyFingerprint({
      generation: 'generation-b',
      allowRead: [],
      allowWrite: ['C:\\work'],
      denyRead: [],
      denyWrite: [],
    });
    const changedDeny = windowsSandboxV2PolicyFingerprint({
      generation: 'generation-a',
      allowRead: [],
      allowWrite: ['C:\\work'],
      denyRead: [],
      denyWrite: ['C:\\work\\locked'],
    });
    const changedRead = windowsSandboxV2PolicyFingerprint({
      generation: 'generation-a',
      allowRead: ['C:\\runtime'],
      allowWrite: ['C:\\work'],
      denyRead: [],
      denyWrite: [],
    });

    expect(windowsSandboxV2PolicyCapabilitySid(changedGeneration)).not.toBe(
      windowsSandboxV2PolicyCapabilitySid(base),
    );
    expect(windowsSandboxV2PolicyCapabilitySid(changedDeny)).not.toBe(
      windowsSandboxV2PolicyCapabilitySid(base),
    );
    expect(windowsSandboxV2PolicyCapabilitySid(changedRead)).not.toBe(
      windowsSandboxV2PolicyCapabilitySid(base),
    );
  });

  it('binds one native request to its immutable policy and controller', () => {
    const generation = windowsSandboxV2Generation({
      setupGenerationNonce: '00000000-0000-4000-8000-000000000001',
      sandboxUserSid: 'S-1-5-21-1-2-3-1001',
      sandboxGroupSid: 'S-1-5-21-1-2-3-1000',
      asrtSha256: 'a'.repeat(64),
      shellSha256: 'b'.repeat(64),
    });
    const request = createWindowsSandboxV2RunRequest({
      generation,
      filesystemCapabilityNonce: '00000000-0000-4000-8000-000000000003',
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
      preinstalledReadRoots: ['C:\\work'],
      allowRead: ['C:\\work'],
      allowWrite: ['C:\\work'],
      denyRead: [],
      denyWrite: ['C:\\work\\.git'],
      controllerPipe: '\\\\.\\pipe\\kodax-v2-1234-12345678-1234-1234-1234-123456789abc',
      terminalRecordPath: 'C:\\control\\windows-terminal.json',
      terminalNonce: '12345678-1234-1234-1234-123456789abc',
      operationDeadlineUnixMs: 123_456,
      setupMarkerPath: 'C:\\control\\windows-v2-cutover.json',
      setupMarkerSha256: 'c'.repeat(64),
    });

    expect(request).toMatchObject({
      protocol: 10,
      generation,
      sandboxUserSid: 'S-1-5-21-1-2-3-1001',
      sandboxGroupSid: 'S-1-5-21-1-2-3-1000',
      asrtExecutable: 'C:\\runner\\srt-win.exe',
      asrtPrefixArgs: ['exec', '--quiet', '--'],
      targetArgv: ['cmd.exe', '/d', '/s', '/c', 'echo hello'],
      preinstalledReadRoots: ['C:\\work'],
      controllerPipe: '\\\\.\\pipe\\kodax-v2-1234-12345678-1234-1234-1234-123456789abc',
      operationDeadlineUnixMs: 123_456,
    });
    expect(request.policyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(request.policyCapabilitySid).toBe(
      windowsSandboxV2PolicyCapabilitySid(request.policyFingerprint),
    );
  });

  it('rejects per-command denyRead before constructing a WRITE_RESTRICTED request', () => {
    expect(() => createWindowsSandboxV2RunRequest({
      generation: 'g',
      filesystemCapabilityNonce: '00000000-0000-4000-8000-000000000003',
      sandboxUserSid: 'S-1-5-21-1-2-3-1001',
      sandboxGroupSid: 'S-1-5-21-1-2-3-1000',
      asrtInvocation: {
        executable: 'srt-win.exe',
        prefixArgs: ['exec', '--'],
        targetArgv: ['cmd.exe'],
        childEnvironment: {},
      },
      targetArgv: ['cmd.exe'],
      cwd: 'C:\\work',
      preinstalledReadRoots: [],
      allowRead: ['C:\\work'],
      allowWrite: [],
      denyRead: ['C:\\secret'],
      denyWrite: [],
      controllerPipe: '\\\\.\\pipe\\kodax-v2-1234-12345678-1234-1234-1234-123456789abc',
      terminalRecordPath: 'C:\\control\\windows-terminal.json',
      terminalNonce: '12345678-1234-1234-1234-123456789abc',
      operationDeadlineUnixMs: 123_456,
      setupMarkerPath: 'C:\\control\\windows-v2-cutover.json',
      setupMarkerSha256: 'c'.repeat(64),
    })).toThrow(/denyRead is unsupported/);
  });

  it('rejects a request without an exact ASRT prefix or private pipe', () => {
    const base = {
      generation: 'g',
      filesystemCapabilityNonce: '00000000-0000-4000-8000-000000000003',
      sandboxUserSid: 'S-1-5-21-1-2-3-1001',
      sandboxGroupSid: 'S-1-5-21-1-2-3-1000',
      targetArgv: ['cmd.exe'],
      cwd: 'C:\\work',
      preinstalledReadRoots: [],
      allowRead: [],
      allowWrite: ['C:\\work'],
      denyRead: [],
      denyWrite: [],
      terminalRecordPath: 'C:\\control\\windows-terminal.json',
      terminalNonce: '12345678-1234-1234-1234-123456789abc',
      operationDeadlineUnixMs: 123_456,
      setupMarkerPath: 'C:\\control\\windows-v2-cutover.json',
      setupMarkerSha256: 'c'.repeat(64),
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
    expect(() => createWindowsSandboxV2RunRequest({
      ...base,
      setupMarkerPath: undefined as unknown as string,
      controllerPipe: '\\\\.\\pipe\\kodax-v2-1234-12345678-1234-1234-1234-123456789abc',
      asrtInvocation: {
        executable: 'srt-win.exe',
        prefixArgs: ['exec', '--'],
        targetArgv: ['cmd.exe'],
        childEnvironment: {},
      },
    })).toThrow(/setup marker proof/);
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
      protocol: 10,
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
