import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { KodaXEvents, KodaXOptions, KodaXResult, RunningSession } from '@kodax-ai/coding';
import { createWorkflowProcessTracker } from '@kodax-ai/agent';
import { createKodaXRuntime } from './sdk-runtime.js';
import { connectKodaXClient } from './sdk-client.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import { createCliClientPlane, createCliSessionCommands } from './cli-client-plane.js';
import { runInteractiveMode } from '../packages/repl/src/interactive/repl.js';
import { runInkInteractiveMode } from '../packages/repl/src/ui/InkREPL.js';

const fixture = vi.hoisted(() => ({ start: vi.fn(), render: vi.fn(), ask: vi.fn() }));
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

it('renders current Host activity and accepts follow-ups when attaching Ink to a busy Session', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ink-activity-'));
  vi.stubEnv('KODAX_HOME', path.join(homeDir, '.kodax'));
  vi.stubEnv('KODAX_TUI_RENDERER', 'owned');
  const stdin = new TerminalInput();
  const stdout = new TerminalOutput();
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const rawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: () => {} });
  let mounted: ReturnType<typeof import('../packages/repl/src/ui/tui.js').render> | undefined;
  fixture.render.mockImplementation((render: typeof import('../packages/repl/src/ui/tui.js').render,
    element: Parameters<typeof render>[0], options: Parameters<typeof render>[1]) => {
    mounted = render(element, { ...options, stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, stderr: stdout as unknown as NodeJS.WriteStream });
    return mounted;
  });
  const abort = vi.fn();
  let events: KodaXEvents | undefined;
  let finish: ((result: KodaXResult) => void) | undefined;
  fixture.start.mockImplementation((options: KodaXOptions): RunningSession => {
    events = options.events;
    const result = new Promise<KodaXResult>(resolve => { finish = resolve; });
    return { id: options.session!.id!, currentProvider: options.provider, currentModel: options.model,
      currentReasoning: options.reasoningMode, aborted: false, attached: true,
      setProvider() {}, setModel() {}, setReasoning() {}, abort, result };
  });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'anthropic' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId,
    pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Isolated Host lock unavailable');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-ink-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  const session = await client.sessions.create({ title: 'Activity', projectPath: homeDir });
  let repl: Promise<void> | undefined;
  try {
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'Work started from a different client',
      options: { agentMode: 'sa' } });
    events!.onTodoUpdate?.([{ id: 'todo', subject: 'Verify the Host activity boundary', status: 'in_progress' }]);
    events!.onManagedTaskStatus?.({ agentMode: 'ama', harnessProfile: 'H1_EXECUTE_EVAL', phase: 'worker',
      activeWorkerTitle: 'Host reviewer', childFanoutClass: 'finding-validation', childFanoutCount: 3 });
    events!.onToolUseStart?.({ id: 'child-call', name: 'read', input: { path: 'HOST_BOUNDARY.md' } },
      { childAgentId: 'child', childAgentName: 'Host child', liveOnly: true, contextKind: 'child' });
    if (events!.getCostReport) events!.getCostReport.current = () => 'Total cost: $0.012';
    events!.onIterationEnd?.({ iter: 1, maxIter: 10, tokenCount: 10, tokenSource: 'estimate', scope: 'parent' });
    const received: import('@kodax-ai/coding/client-contract').ClientSessionView[] = [];
    const plane = createCliClientPlane(client);
    const observe = plane.observe;
    plane.observe = (id, listener, options) => observe(id, view => { received.push(view); listener(view); }, options);
    repl = runInkInteractiveMode({ provider: 'anthropic', agentMode: 'ama', session: { id: session.id },
      clientPlane: plane, sessionCommands: createCliSessionCommands(client), hardExitOnClose: false });
    await expect.poll(() => received.at(-1)?.activity?.todos?.[0]?.subject).toBe('Verify the Host activity boundary');
    await expect.poll(() => stripVTControlCharacters(stdout.text).replace(/\s/g, ''), { timeout: 10_000 })
      .toContain('VerifytheHostactivityboundary');
    await expect.poll(() => stripVTControlCharacters(stdout.text).replace(/\s/g, '')).toContain('HOST_BOUNDARY.md');
    await expect.poll(() => stripVTControlCharacters(stdout.text).replace(/\s/g, '')).toContain('Validating3findings');
    await expect.poll(() => stripVTControlCharacters(stdout.text).replace(/\s/g, '')).toContain('Hostrevieweractive');
    const snapshot = createWorkflowProcessTracker({ runId: 'inline-workflow', workflowName: 'Host model workflow' }).getSnapshot();
    events!.onWorkflowProcessEvent?.({ type: 'workflow_updated', snapshot });
    events!.onWorkflowAgentDigest?.({ runId: snapshot.runId, event: { type: 'agent_completed', seq: 1,
      data: { name: 'Verifier', status: 'completed', summary: 'Verified the complete Host source.', summaryKind: 'digest' } } });
    await expect.poll(() => stripVTControlCharacters(stdout.text).replace(/\s/g, '')).toContain('Hostmodelworkflow');
    await expect.poll(() => stripVTControlCharacters(stdout.text).replace(/\s/g, '')).toContain('VerifiedthecompleteHostsource.');
    stdin.emit('data', Buffer.from('queued from attached Ink'));
    await expect.poll(() => stripVTControlCharacters(stdout.text).replace(/\s/g, '')).toContain('queuedfromattachedInk');
    stdin.emit('data', Buffer.from('\r'));
    const observed: import('@kodax-ai/coding/client-contract').ClientSessionView[] = [];
    const observation = await client.sessions.observe(session.id, view => observed.push(view));
    try {
      await expect.poll(() => observed.at(-1)?.queue.map(entry => entry.text)).toContain('queued from attached Ink');
      expect(fixture.start).toHaveBeenCalledTimes(1);
      for (const entry of observed.at(-1)?.queue ?? []) await client.inputs.withdraw(session.id, entry.inputId);
    } finally { observation.close(); }
    stdin.emit('data', Buffer.from('\u0003'));
    await expect.poll(() => abort.mock.calls.length).toBe(1);
    stdout.text = '';
    finish?.({ success: true, lastText: 'Done', messages: [], sessionId: session.id });
    await run.result;
    await expect.poll(() => stripVTControlCharacters(stdout.text).replace(/\s/g, '')).toContain('Typeamessage...');
    stdin.emit('data', Buffer.from('/cost'));
    await expect.poll(() => stripVTControlCharacters(stdout.text)).toContain('/cost');
    stdin.emit('data', Buffer.from('\r'));
    await expect.poll(() => stripVTControlCharacters(stdout.text).replace(/\s/g, '')).toContain('Totalcost:$0.012');
    mounted?.unmount();
    mounted?.cleanup();
    await repl;
    mounted = undefined;
    repl = undefined;
    received.length = 0;
    const createInterface = readline.createInterface;
    const readlineSpy = vi.spyOn(readline, 'createInterface').mockImplementation(options => createInterface({
      ...(options as readline.ReadLineOptions), input: stdin as unknown as NodeJS.ReadableStream,
      output: stdout as unknown as NodeJS.WritableStream, terminal: false,
    }));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    fixture.ask.mockImplementationOnce(async () => {
      await expect.poll(() => received.at(-1)?.activity?.costReport).toBe('Total cost: $0.012');
      return '/cost';
    }).mockResolvedValue('/exit');
    try {
      await runInteractiveMode({ provider: 'anthropic', agentMode: 'sa', session: { id: session.id },
        clientPlane: plane, sessionCommands: createCliSessionCommands(client) });
      expect(logs.mock.calls.flat().join(' ')).toContain('Total cost: $0.012');
    } finally { readlineSpy.mockRestore(); logs.mockRestore(); }

  } finally {
    mounted?.unmount();
    mounted?.cleanup();
    if (repl) await repl;
    finish?.({ success: true, lastText: '', messages: [], sessionId: session.id });
    await client.disconnect();
    await host.close();
    await runtime.close();
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor); else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (rawDescriptor) Object.defineProperty(process.stdin, 'setRawMode', rawDescriptor); else Reflect.deleteProperty(process.stdin, 'setRawMode');
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true });
  }
}, 25_000);
