import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXOptions, RunningSession } from '@kodax-ai/coding';
import { createKodaXRuntime } from './sdk-runtime.js';
import { connectKodaXClient } from './sdk-client.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import { createCliClientPlane, createCliSessionCommands } from './cli-client-plane.js';
import { runInteractiveMode } from '../packages/repl/src/interactive/repl.js';
import { runInkInteractiveMode } from '../packages/repl/src/ui/InkREPL.js';

const fixture = vi.hoisted(() => ({ start: vi.fn(), ask: vi.fn(), readline: vi.fn(), render: vi.fn() }));
vi.mock('readline', async original => ({ ...await original<typeof import('readline')>(), createInterface: (...args: unknown[]) => fixture.readline(...args) }));
vi.mock('@kodax-ai/coding', async original => ({
  ...await original<typeof import('@kodax-ai/coding')>(), startKodaX: fixture.start,
}));
vi.mock('../packages/repl/src/interactive/readline-helpers.js', async original => ({
  ...await original<typeof import('../packages/repl/src/interactive/readline-helpers.js')>(), askInput: fixture.ask,
}));
vi.mock('../packages/repl/src/ui/tui.js', async original => {
  const module = await original<typeof import('../packages/repl/src/ui/tui.js')>();
  return { ...module, render: (...args: Parameters<typeof module.render>) => fixture.render(module.render, ...args) };
});
class TerminalInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean) { this.isRaw = value; }
  ref() {}
  unref() {}
  resume() { return this; }
  pause() { return this; }
  setEncoding() { return this; }
  read() { return null; }
}
class TerminalOutput extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 48;
  text = '';
  write(chunk: string) { this.text += chunk; return true; }
}

it.each(['classic', 'ink'] as const)('keeps an unsent %s draft available when observation fails, then submits only after observation recovers', async mode => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-observation-'));
  vi.stubEnv('KODAX_HOME', path.join(homeDir, '.kodax'));
  vi.stubEnv('TERM', 'xterm-256color');
  vi.stubEnv('KODAX_TUI_RENDERER', 'owned');
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'anthropic' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId,
    pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Isolated Host lock unavailable');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-observe-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  const session = await client.sessions.create({ title: 'Observation', projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { agentMode: 'sa' });
  const plane = createCliClientPlane(client);
  const observe = plane.observe;
  let available = false;
  plane.observe = async (...args) => {
    if (!available) throw new Error('Injected observation failure');
    return observe(...args);
  };
  const readInput = plane.readInput!;
  plane.readInput = async (...args) => {
    if (!available) throw new Error('Host input state is also unavailable');
    return readInput(...args);
  };
  fixture.start.mockReset();
  fixture.start.mockImplementation((options: KodaXOptions): RunningSession => ({
    id: session.id, currentProvider: options.provider, currentModel: options.model,
    currentReasoning: options.reasoningMode, aborted: false, attached: true,
    setProvider() {}, setModel() {}, setReasoning() {}, abort() {},
    result: Promise.resolve({ success: true, lastText: 'Accepted once', messages: [], sessionId: session.id }),
  }));
  const input = new PassThrough();
  const output = new PassThrough();
  const createInterface = readline.createInterface;
  fixture.readline.mockImplementation((options: readline.ReadLineOptions) =>
    createInterface({ ...(options as readline.ReadLineOptions), input, output, terminal: true }));
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  const draft = `Inspect @existing-attachment.txt ${'preserve raw draft '.repeat(100)}`;
  let restored = '';
  let mounted: ReturnType<typeof import('../packages/repl/src/ui/tui.js').render> | undefined;
  let repl: Promise<void> | undefined;
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const rawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  fixture.ask.mockReset();
  fixture.ask.mockResolvedValueOnce(draft).mockImplementationOnce(async (rl: readline.Interface) => {
    expect(fixture.start).not.toHaveBeenCalled();
    expect(logs.mock.calls.flat().join(' ')).toContain('not submitted');
    expect(rl).toMatchObject({ terminal: true, history: [draft] });
    // Exercise readline's real history recall, not an inaccessible saved variable.
    rl.write(undefined, { name: 'up' });
    restored = rl.line;
    expect(restored).toBe(draft);
    available = true;
    return restored;
  }).mockResolvedValue('/exit');
  try {
    if (mode === 'classic') {
      await runInteractiveMode({ provider: 'anthropic', agentMode: 'sa', session: { id: session.id, resume: true },
        clientPlane: plane, sessionCommands: createCliSessionCommands(client) });
    } else {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: () => {} });
      const stdin = new TerminalInput();
      const stdout = new TerminalOutput();
      fixture.render.mockImplementation((render: typeof import('../packages/repl/src/ui/tui.js').render,
        element: Parameters<typeof render>[0], options: Parameters<typeof render>[1]) => {
        mounted = render(element, { ...options, stdout: stdout as unknown as NodeJS.WriteStream,
          stdin: stdin as unknown as NodeJS.ReadStream, stderr: stdout as unknown as NodeJS.WriteStream });
        return mounted;
      });
      const outputText = () => stripVTControlCharacters(stdout.text).replace(/\s/g, '');
      repl = runInkInteractiveMode({ provider: 'anthropic', agentMode: 'sa', session: { id: session.id, resume: true },
        clientPlane: plane, sessionCommands: createCliSessionCommands(client), hardExitOnClose: false });
      await expect.poll(outputText, { timeout: 10_000 }).toContain('observationunavailable');
      stdin.emit('data', Buffer.from(draft));
      await new Promise(resolve => setTimeout(resolve, 100));
      stdout.text = '';
      stdin.emit('data', Buffer.from('\r'));
      await expect.poll(outputText).toContain('Inputnotsubmitted');
      expect(fixture.start).not.toHaveBeenCalled();
      await expect.poll(outputText).toContain('Typeamessage');
      stdout.text = '';
      stdin.emit('data', Buffer.from('\u001b[A'));
      await expect.poll(outputText).toContain('existing-attachment.txt');
      available = true;
      stdin.emit('data', Buffer.from('\r'));
      await expect.poll(() => fixture.start.mock.calls.length).toBe(1);
      await expect.poll(async () => await plane.activeRun(session.id)).toBeUndefined();
    }
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.start.mock.calls[0]?.[1]).toBe(draft.trim());
  } finally {
    mounted?.unmount(); mounted?.cleanup();
    if (repl) await repl;
    logs.mockRestore(); input.destroy(); output.destroy();
    await client.disconnect(); await host.close(); await runtime.close();
    vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true });
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor); else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (rawDescriptor) Object.defineProperty(process.stdin, 'setRawMode', rawDescriptor); else Reflect.deleteProperty(process.stdin, 'setRawMode');
  }
}, 30_000);
