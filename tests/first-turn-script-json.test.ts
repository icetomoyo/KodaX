import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { runManagedTask } from '@kodax-ai/coding';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import type { ScriptCellResult, ScriptReceipt } from '../packages/coding/src/agent-runtime/script/cell.js';
import type { ExtensionRuntimeContract } from '../packages/coding/src/extensions/runtime-contract.js';

it('computes from concurrent Host JSON in a production Script cell and reads its committed file after the write barrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kodax-script-json-'));
  const storage = new FileSessionStorage({ sessionsDir: join(root, 'sessions'), configHome: root, cwd: root });
  const source = {
    west: { samples: [[2, 3], [5, 7]], complete: false },
    east: { samples: [[11, 13]], complete: true },
  };
  const warnings = ['WARNING: west readings remain provisional', 'WARNING: east readings are a limited sample'];
  const expected = { total: 41, complete: false };
  const executed: string[] = [];
  const budget = { totalBudget: 4, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  let requests = 0;
  let started = 0;
  let release!: () => void;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const bothStarted = new Promise<void>(resolveGate => { release = resolveGate; });
  const hostCall = vi.fn(async (provider: string, capability: string, input: Record<string, unknown>) => {
    expect(provider).toBe('mcp');
    expect(capability).toBe('fixture:measurements');
    expect(input).toEqual({ region: expect.stringMatching(/^(west|east)$/) });
    if (++started === 1) deadline = setTimeout(release, 10_000);
    if (started === 2) release();
    await bothStarted;
    expect(started, 'Both readonly Host calls must be admitted concurrently').toBe(2);
    const region = input.region as keyof typeof source;
    return { kind: 'tool' as const, content: warnings[region === 'west' ? 0 : 1], structuredContent: source[region] };
  });
  const extensionRuntime: ExtensionRuntimeContract = {
    listRunTools: () => [{ name: 'measurements.sample-grid', description: 'Read measured samples for one region.',
      capabilityId: 'fixture:measurements', inputSchema: { type: 'object', properties: {
        region: { type: 'string', enum: ['west', 'east'] },
      }, required: ['region'] }, sideEffect: 'readonly', planModeAllowed: true }],
    searchCapabilities: async () => [], describeCapability: async () => undefined, executeCapability: hostCall,
    readCapability: async () => ({ kind: 'resource', content: '' }), getCapabilityPrompt: async () => undefined,
    getCapabilityPromptContext: async () => undefined,
  };
  const fetcher = vi.fn(() => { throw new Error('No network is permitted in deterministic Script acceptance'); });
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('KODAX_SCRIPT_JSON_TEST_KEY', 'offline');
  vi.stubEnv('KODAX_HOME', root);
  class Fixture extends KodaXBaseProvider {
    readonly name = 'script-json-offline';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_SCRIPT_JSON_TEST_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      const step = requests++;
      expect(step).toBeLessThan(2);
      expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['script_exec', 'tool_call', 'bash']));
      if (step === 0) return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
        { type: 'tool_use', id: 'json-cell', name: 'script_exec', input: { selected_output: true, code: `
          const sources = await Promise.all(['west','east'].map(region => tools['measurements.sample-grid']({region})));
          if (sources.some(r => r.isError || r.data?.kind !== 'json')) throw Error('Missing typed source');
          const summary = {
            total: sources.flatMap(r => r.data.value.samples.flat()).reduce((sum,n) => sum+n,0),
            complete: sources.every(r => r.data.value.complete)
          };
          const writing = tools.write({path:'summary.json',content:JSON.stringify(summary)});
          const reading = tools.read({path:'summary.json'});
          const [written,readback] = await Promise.all([writing,reading]);
          if (written.isError || readback.isError || readback.data?.kind !== 'text') throw Error('Readback failed');
          return JSON.parse(readback.data.text);
        ` } },
      ] };
      const receipt = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === 'json-cell');
      if (receipt?.type !== 'tool_result') throw new Error('Missing model-visible Script receipt');
      expect(receipt.is_error).not.toBe(true);
      const cell = JSON.parse(String(receipt.content)) as ScriptCellResult;
      expect(cell).toMatchObject({ status: 'completed', hadToolErrors: false, value: expected });
      for (const warning of warnings) expect(String(receipt.content)).toContain(warning);
      return { textBlocks: [{ type: 'text', text: 'Computed and checked the sample summary.' }], thinkingBlocks: [],
        toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('script-json-offline', () => new Fixture());
  try {
    const result = await runManagedTask({ provider: 'script-json-offline', workMode: 'script', agentMode: 'ama',
      reasoningMode: 'off', lsp: false, extensionRuntime, session: { id: 'json-session', storage },
      context: { executionCwd: root, gitRoot: root, repoIntelligenceMode: 'off', managedWorkBudget: budget },
      events: { beforeToolExecute: async name => {
        executed.push(name);
        if (name === 'read') expect(await readFile(join(root, 'summary.json'), 'utf8')).toBe(JSON.stringify(expected));
        return ['measurements.sample-grid', 'write', 'read'].includes(name);
      } },
    }, 'Calculate the sample total and completeness from both regions, save summary.json, and verify the saved result.');
    expect(result.success).toBe(true);
    expect(requests).toBe(2);
    expect(hostCall).toHaveBeenCalledTimes(2);
    expect(hostCall.mock.calls.map(([, , input]) => input)).toEqual([{ region: 'west' }, { region: 'east' }]);
    expect(executed).toEqual(['measurements.sample-grid', 'measurements.sample-grid', 'write', 'read']);
    expect(budget.spentBudget).toBe(4);
    expect(await readFile(join(root, 'summary.json'), 'utf8')).toBe(JSON.stringify(expected));
    const records = (await storage.load('json-session'))?.extensionRecords ?? [];
    const receipts = records.filter(record => record.type === 'call.settled')
      .map(record => (record.data as unknown as { data: ScriptReceipt }).data);
    expect(receipts).toHaveLength(4);
    for (const [index, region] of ['west', 'east'].entries()) {
      const receipt = receipts.find(item => item.name === 'measurements.sample-grid' && item.input.region === region);
      expect(receipt).toMatchObject({ input: { region }, result: { isError: false,
        data: { kind: 'json', value: source[region as keyof typeof source] } } });
      expect(String(receipt?.result.content)).toContain(warnings[index]);
    }
    expect(receipts.find(item => item.name === 'write')).toMatchObject({
      input: { path: 'summary.json', content: JSON.stringify(expected) }, result: { isError: false,
        metadata: { toolCall: { name: 'write', input: { path: 'summary.json', content: JSON.stringify(expected) } } } },
    });
    expect(receipts.find(item => item.name === 'read')).toMatchObject({ input: { path: 'summary.json' },
      result: { isError: false, data: { kind: 'text', text: JSON.stringify(expected), complete: true } } });
    expect(records.filter(record => record.type === 'cell.started')).toHaveLength(1);
    expect(records.filter(record => record.type === 'cell.settled')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ data: expect.objectContaining({
        status: 'completed', hadToolErrors: false, value: expected, spentBudget: 4,
      }) }) }),
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    release(); if (deadline) clearTimeout(deadline);
    clearRuntimeModelProviders(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    if (dirname(root) !== resolve(tmpdir()) || !root.includes('kodax-script-json-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
