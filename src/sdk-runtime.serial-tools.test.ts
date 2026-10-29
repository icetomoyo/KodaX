import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { registerTool } from '@kodax-ai/coding';
import { clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';

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
