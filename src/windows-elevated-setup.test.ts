import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openWindowsElevatedSession,
  SandboxSetupError,
  type SandboxSetupPhase,
} from './windows-elevated-setup.js';

// Stands in for `kodax-windows-sandbox.exe __elevated-setup`. FAKE_MODE picks
// the behavior: approve and serve, dismiss the UAC prompt, or never answer.
const FAKE_HELPER = String.raw`
const net = require('node:net');
const argv = process.argv.slice(process.argv.indexOf('__elevated-setup') + 1);
const mode = process.env.FAKE_MODE;
if (mode === 'cancel') process.exit(10);
if (mode === 'crash') { process.stderr.write('helper broke'); process.exit(3); }
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  const socket = net.connect(argv[0]);
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      if (request.op === 'exit') { socket.end(); return; }
      if (request.args && request.args[0] === 'slow') continue;
      socket.write(JSON.stringify({
        exitCode: request.op === 'srt-win' && request.args[0] === 'fail' ? 12 : 0,
        output: JSON.stringify({ request, launch: argv }),
      }) + '\n');
    }
  });
  socket.on('end', () => process.exit(0));
}
`;

function open(mode: string, elevationTimeoutMs = 10_000, phases: SandboxSetupPhase[] = []) {
  vi.stubEnv('FAKE_MODE', mode);
  return openWindowsElevatedSession({
    helper: { command: process.execPath, args: ['-e', FAKE_HELPER] },
    srtWin: { exe: 'C:\\runner\\srt-win.exe', prependArgs: ['--srt-win'], sha256: 'a'.repeat(64) },
    elevationTimeoutMs,
    onPhase: (phase) => phases.push(phase),
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SandboxSetupError);
    return (error as SandboxSetupError).code;
  }
}

describe.skipIf(process.platform !== 'win32')('openWindowsElevatedSession', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs every step through one elevated session and reports its phases', async () => {
    const phases: SandboxSetupPhase[] = [];
    const session = await open('serve', 10_000, phases);
    try {
      const uninstall = await session.request({ op: 'srt-win', args: ['uninstall'] }, 5_000);
      const install = await session.request({ op: 'srt-win', args: ['install', '--force'] }, 5_000);
      const capabilities = await session.request({ op: 'account-capabilities', envelope: 'e30=' }, 5_000);
      expect([uninstall.exitCode, install.exitCode, capabilities.exitCode]).toEqual([0, 0, 0]);
      const echoed = JSON.parse(install.output) as { request: unknown; launch: string[] };
      expect(echoed.request).toEqual({ op: 'srt-win', args: ['install', '--force'] });
      expect(echoed.launch[0]).toMatch(/^\\\\\.\\pipe\\kodax-elevated-setup-[0-9a-f-]{36}$/);
      expect(echoed.launch.slice(1)).toEqual([
        String(process.pid), 'C:\\runner\\srt-win.exe', 'a'.repeat(64), '--', '--srt-win',
      ]);
      expect((await session.request({ op: 'srt-win', args: ['fail'] }, 5_000)).exitCode).toBe(12);
      expect(phases).toEqual(['awaiting-elevation', 'elevated']);
    } finally {
      await session.close();
    }
  });

  it('reports a dismissed UAC prompt as elevation_cancelled', async () => {
    expect(await codeOf(open('cancel'))).toBe('elevation_cancelled');
  });

  it('times the consent wait on its own clock and stops the launcher', async () => {
    expect(await codeOf(open('hang', 1_500))).toBe('elevation_timeout');
  });

  it('reports a helper that fails before connecting as elevated_step_failed', async () => {
    const failure = open('crash');
    expect(await codeOf(failure)).toBe('elevated_step_failed');
    await expect(failure).rejects.toThrow(/helper broke/);
  });

  it('reports a helper that cannot start as native_artifact_unavailable', async () => {
    const failure = openWindowsElevatedSession({
      helper: { command: 'C:\\missing\\kodax-windows-sandbox.exe' },
      srtWin: { exe: 'C:\\runner\\srt-win.exe', prependArgs: [], sha256: 'a'.repeat(64) },
      elevationTimeoutMs: 5_000,
    });
    expect(await codeOf(failure)).toBe('native_artifact_unavailable');
  });

  it('fails a step that outlives its own timeout without waiting for elevation again', async () => {
    const session = await open('serve');
    try {
      expect(await codeOf(session.request({ op: 'srt-win', args: ['slow'] }, 300)))
        .toBe('elevated_step_failed');
      expect(await codeOf(session.request({ op: 'srt-win', args: ['uninstall'] }, 300)))
        .toBe('elevated_step_failed');
    } finally {
      await session.close();
    }
  });
});
