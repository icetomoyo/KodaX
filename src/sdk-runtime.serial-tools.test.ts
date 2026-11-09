import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { createExtensionRuntime, registerTool } from '@kodax-ai/coding';
import { clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createSessionManager } from '@kodax-ai/repl';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

it.each((['ama', 'sa'] as const).flatMap(agentMode => [false, true].map(bridge => ({ agentMode, bridge })) ))(
  'keeps a registered serial predicate through real dispatch: $agentMode bridge=$bridge', async ({ agentMode, bridge }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-tool-serial-'));
  const calls: string[] = [];
  let serial = true; let rootTurn = 0; let parallelStarted = 0; let releaseParallel!: () => void;
  const parallelGate = new Promise<void>(resolve => { releaseParallel = resolve; });
  const unregister = registerTool({ name: 'serial_fixture', description: 'Controlled local state operation.', sideEffect: 'mutates-state',
    requiresSerialExecution: input => input.serial === true,
    toClassifierInput: input => `Local operation ${String((input as { label?: unknown }).label)}`,
    input_schema: { type: 'object', properties: { label: { type: 'string' }, serial: { type: 'boolean' } }, required: ['label', 'serial'] },
    handler: async input => {
      const label = String(input.label); calls.push(`${label}:start`);
      if (input.serial === true) await new Promise<void>(resolve => setTimeout(resolve, 20));
      else { if (++parallelStarted === 2) releaseParallel(); await parallelGate; }
      calls.push(`${label}:end`); return label;
    } });
  vi.stubEnv('KODAX_SERIAL_FIXTURE', 'offline');
  class Provider extends KodaXBaseProvider {
    readonly name = 'serial-fixture'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_SERIAL_FIXTURE', model: 'fixture', supportsThinking: false };
    async stream(_messages: import('@kodax-ai/llm').KodaXMessage[], tools: import('@kodax-ai/llm').KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      if (tools.some(tool => tool.name === 'serial_fixture') && rootTurn++ === 0) return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
        toolBlocks: ['first', 'second'].map(label => ({ type: 'tool_use', id: 'duplicate-provider-id', name: bridge ? 'tool_call' : 'serial_fixture',
          input: bridge ? { name: 'serial_fixture', input: { label, serial } } : { label, serial } })) };
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('serial-fixture', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'serial-fixture', defaultModel: 'fixture' });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { agentMode, workMode: 'coding', permissionMode: 'full-access' });
    const first = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'serial', text: 'Run the two controlled serial operations.' });
    expect((await runtime.runs.await(first.runId!)).phase).toBe('completed');
    expect(calls).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    calls.length = 0; rootTurn = 0; serial = false;
    const parallel = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'parallel', text: 'Run the independent operations.' });
    expect((await runtime.runs.await(parallel.runId!)).phase).toBe('completed');
    expect(calls.slice(0, 2)).toEqual(['first:start', 'second:start']);
  } finally { releaseParallel(); await runtime.close(); unregister(); clearRuntimeModelProviders(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true }); }
}, 30_000);

it('preserves a readonly serial predicate in Script and rejects a hook that adds it after parallel admission', async ({ signal }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-serial-'));
  const calls: string[] = [];
  let serial = true; let rewrite = false; let turn = 0; let releaseFirst = () => {}; let firstStarted = () => {};
  let firstGate = Promise.resolve();
  const unregister = registerTool({ name: 'script_serial_fixture', description: 'Read a controlled local fixture.', sideEffect: 'readonly',
    requiresSerialExecution: input => input.serial === true,
    toClassifierInput: input => `Read controlled fixture ${String((input as { label?: unknown }).label)}`,
    input_schema: { type: 'object', properties: { label: { type: 'string' }, serial: { type: 'boolean' } }, required: ['label', 'serial'] },
    handler: async input => {
      const label = String(input.label); calls.push(`${label}:start`);
      if (label === 'first') { firstStarted(); await firstGate; }
      calls.push(`${label}:end`); return label;
    } });
  const extension = createExtensionRuntime();
  extension.registerHook('tool:before', ({ name, input }) => {
    if (name === 'script_serial_fixture' && rewrite) input.serial = true;
  });
  vi.stubEnv('KODAX_SCRIPT_SERIAL_FIXTURE', 'offline');
  class Provider extends KodaXBaseProvider {
    readonly name = 'script-serial-fixture'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_SCRIPT_SERIAL_FIXTURE', model: 'fixture', supportsThinking: false };
    async stream(_messages: import('@kodax-ai/llm').KodaXMessage[], tools: import('@kodax-ai/llm').KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      if (tools.some(tool => tool.name === 'script_exec') && turn++ === 0) return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
        toolBlocks: [{ type: 'tool_use', id: 'script-cell', name: 'script_exec', input: { code: rewrite
          ? 'return await tools.script_serial_fixture({label:"rewritten",serial:false});'
          : `return await Promise.all([tools.script_serial_fixture({label:"first",serial:${serial}}),tools.script_serial_fixture({label:"second",serial:${serial}})]);` } }] };
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('script-serial-fixture', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'script-serial-fixture', defaultModel: 'fixture' });
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Script fixture test aborted.')), { once: true });
  });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { agentMode: 'ama', workMode: 'script', permissionMode: 'full-access' });
    const store = createSessionManager({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
    for (serial of [true, false]) {
      calls.length = 0; turn = 0;
      firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
      const started = new Promise<void>(resolve => { firstStarted = resolve; });
      const run = await runtime.runs.start({ sessionId: session.id, prompt: 'Read both controlled fixtures.', options: { extensionRuntime: extension } });
      const completed = runtime.runs.await(run.runId);
      await Promise.race([started, aborted, completed.then(async result => {
        throw new Error(`Run settled before its first fixture read: ${JSON.stringify({ result, saved: await store.loadSession(session.id) })}`);
      })]);
      if (serial) {
        // Both guest requests exist while the first handler still owns its gate.
        await vi.waitFor(async () => expect((await store.loadSession(session.id))!.extensionRecords?.filter(record =>
          (record.data as { runId?: string })?.runId === run.runId && record.extensionId === 'kodax.script' && record.type === 'call.started')).toHaveLength(2));
        expect(calls).toEqual(['first:start']);
      } else {
        // Positive control: the same fixture can overlap when its predicate is false.
        await vi.waitFor(() => expect(calls).toContain('second:end'));
        expect(calls).toEqual(['first:start', 'second:start', 'second:end']);
      }
      releaseFirst();
      expect((await completed).phase).toBe('completed');
      expect(calls).toEqual(serial ? ['first:start', 'first:end', 'second:start', 'second:end']
        : ['first:start', 'second:start', 'second:end', 'first:end']);
    }
    calls.length = 0; turn = 0; rewrite = true;
    const rejected = await runtime.runs.start({ sessionId: session.id, prompt: 'Read with the changing hook.', options: { extensionRuntime: extension } });
    expect((await runtime.runs.await(rejected.runId)).phase).toBe('completed');
    expect(calls).toEqual([]);
    const records = (await store.loadSession(session.id))!.extensionRecords?.filter(record =>
      (record.data as { runId?: string })?.runId === rejected.runId && record.extensionId === 'kodax.script') ?? [];
    expect(records.filter(record => record.type === 'call.started').map(record => (record.data as { data: unknown }).data)).toEqual([
      expect.objectContaining({ name: 'script_serial_fixture', input: { label: 'rewritten', serial: false } }),
    ]);
    expect(records.filter(record => record.type === 'call.prepared')).toEqual([]);
    const receipts = records.filter(record => record.type === 'call.settled').map(record => (record.data as { data: unknown }).data);
    expect(receipts, JSON.stringify(receipts)).toEqual([
      expect.objectContaining({ name: 'script_serial_fixture', input: { label: 'rewritten', serial: true },
        result: expect.objectContaining({ isError: true, content: expect.stringContaining('require serial execution') }) }),
    ]);
  } finally { releaseFirst(); await runtime.close(); extension.dispose(); unregister(); clearRuntimeModelProviders(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true }); }
}, 30_000);
