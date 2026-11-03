import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { runManagedTask } from '@kodax-ai/coding';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import type { ScriptCellResult } from '../packages/coding/src/agent-runtime/script/cell.js';
import type { ExtensionRuntimeContract } from '../packages/coding/src/extensions/runtime-contract.js';

it.each(['native', 'parallel', 'host', 'selected'] as const)('supports the %s tool path through the production Script-mode model', async (scenario) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-native-'));
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions'), configHome: root, cwd: root });
  let requests = 0;
  const executed: string[] = [];
  let independentReads = 0;
  let releaseReads!: () => void;
  const readsReady = new Promise<void>(resolve => { releaseReads = resolve; });
  const hostCall = vi.fn(async (_provider: string, capability: string, input: Record<string, unknown>) => {
    expect(capability).toBe('fixture:host_extract');
    expect(input).toEqual({ value: 'native equivalence evidence' });
    return { kind: 'tool' as const, content: 'host processed native equivalence evidence' };
  });
  const extensionRuntime: ExtensionRuntimeContract = {
    listRunTools: () => [{ name: 'host_extract', description: 'Process supplied fixture text.', capabilityId: 'fixture:host_extract',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, sideEffect: 'readonly', planModeAllowed: true }],
    searchCapabilities: async () => [], describeCapability: async () => undefined,
    executeCapability: hostCall, readCapability: async () => ({ kind: 'resource', content: '' }),
    getCapabilityPrompt: async () => undefined, getCapabilityPromptContext: async () => undefined,
  };
  vi.stubEnv('KODAX_SCRIPT_TEST_KEY', 'offline');
  vi.stubEnv('KODAX_HOME', root);
  await writeFile(path.join(root, 'native.txt'), scenario === 'selected' ? 'private payload for selection\n'.repeat(300) : 'native equivalence evidence');
  class NativeFixture extends KodaXBaseProvider {
    readonly name = 'script-native-offline';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_SCRIPT_TEST_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      const step = requests++;
      if (step > (scenario === 'selected' ? 2 : 1)) throw new Error('Unexpected model round');
      expect(tools.map(tool => tool.name)).toContain('tool_call');
      const description = tools.find(tool => tool.name === 'script_exec')!.description;
      expect(description).toContain('Native tool_call');
      expect(description).toContain('"name":"read"');
      if (step === 1) {
        if (scenario === 'selected') {
          expect(JSON.stringify(messages)).not.toContain('private payload for selection');
          expect(JSON.stringify(messages)).toContain('Showing lines');
          expect(JSON.stringify(messages)).toContain('selected-count');
        } else expect(JSON.stringify(messages)).toContain('native equivalence evidence');
        const receipt = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(block => block.type === 'tool_result' && block.tool_use_id === (scenario === 'native' ? 'native-read' : 'parallel-cell'));
        expect(receipt?.type === 'tool_result' && receipt.is_error === true).toBe(false);
        if (scenario === 'selected' && receipt?.type === 'tool_result') {
          expect(tools.map(tool => tool.name)).toContain('script_read');
          const cell = JSON.parse(String(receipt.content)) as { cellId: string };
          expect(cell.cellId).toBeTypeOf('string');
          return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
            { type: 'tool_use', id: 'original', name: 'script_read', input: { cell_id: cell.cellId, call_id: 1 } },
          ] };
        }
      }
      if (step === 2) expect(JSON.stringify(messages)).toContain('private payload for selection');
      return { textBlocks: step ? [{ type: 'text', text: 'Read the file through the native tool.' }] : [], thinkingBlocks: [],
        toolBlocks: step ? [] : scenario === 'native' ? [{ type: 'tool_use', id: 'native-read', name: 'tool_call',
          input: { name: 'read', input: { path: 'native.txt' } } }]
          : [{ type: 'tool_use', id: 'parallel-cell', name: 'script_exec', input: { ...(scenario === 'selected' ? { selected_output: true } : {}), code: scenario === 'selected'
            ? "const source = await tools.read({path:'native.txt',limit:2}); return {'selected-count':source.content.split('\\n').length};"
            : scenario === 'host'
            ? "const value = await tools.read({path:'native.txt'}); return await tools.host_extract({value:value.content.split('native equivalence evidence')[1] === undefined ? 'missing' : 'native equivalence evidence'});"
            :
            "const reads = [tools.read({path:'native.txt'}), tools.read({path:'native.txt'})]; const write = tools.write({path:'after.txt',content:'after reads'}); const last = tools.read({path:'after.txt'}); return await Promise.all([...reads,write,last]);" } }],
        stopReason: step ? 'end_turn' : 'tool_use' };
    }
  }
  registerModelProvider('script-native-offline', () => new NativeFixture());
  try {
    const result = await runManagedTask({ provider: 'script-native-offline', workMode: 'script', agentMode: 'ama',
      reasoningMode: 'off', lsp: false, session: { id: 'native-script-session', storage },
      ...(scenario === 'host' ? { extensionRuntime } : {}),
      context: { executionCwd: root, gitRoot: root, repoIntelligenceMode: 'off' },
      events: { beforeToolExecute: async (name, input) => {
        executed.push(name);
        if (scenario === 'parallel' && name === 'read' && input.path === 'native.txt') {
          if (++independentReads === 2) releaseReads();
          await Promise.race([readsReady, new Promise(resolve => setTimeout(resolve, 150))]);
          expect(independentReads).toBe(2);
        }
        return ['read', 'write', 'tool_call', 'host_extract', 'script_read'].includes(name);
      } },
    }, 'Read native.txt using the native tool path.');
    expect(result.success).toBe(true);
    expect(requests).toBe(scenario === 'selected' ? 3 : 2);
    expect(executed).toContain('read');
    expect(executed).not.toContain('script_exec');
    const records = (await storage.load('native-script-session'))?.extensionRecords ?? [];
    if (scenario === 'native') expect(records.filter(record => record.type === 'cell.started')).toEqual([]);
    else if (scenario === 'parallel') {
      expect(executed).toEqual(['read', 'read', 'write', 'read']);
      expect(records.filter(record => record.type === 'call.settled')).toHaveLength(4);
      expect(await readFile(path.join(root, 'after.txt'), 'utf8')).toBe('after reads');
    } else if (scenario === 'host') {
      expect(hostCall).toHaveBeenCalledOnce();
      expect(executed).toEqual(['read', 'host_extract']);
      expect(records.filter(record => record.type === 'call.settled')).toHaveLength(2);
    } else {
      expect(JSON.stringify(records.filter(record => record.type === 'call.settled'))).toContain('private payload for selection');
      expect(executed.filter(name => name !== 'script_read')).toEqual(['read']);
    }
  } finally {
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-script-native-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);

it.each([false, true].flatMap(persistedByHost => ['success', 'projected', 'denied', 'failed', 'cancelled'].map(scenario => ({ persistedByHost, scenario }))))(
  'assembles full contracts and settles $scenario (host persistence=$persistedByHost)', async ({ persistedByHost, scenario }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-model-'));
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions'), configHome: root, cwd: root });
  let requests = 0;
  const executed: string[] = [];
  const results: string[] = [];
  let restoredValue: Record<string, unknown> | undefined;
  let generatedContent: string | undefined;
  const budget = { totalBudget: 12, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const controller = new AbortController();
  const fetcher = vi.fn(() => { throw new Error('No external requests permitted'); });
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('KODAX_SCRIPT_TEST_KEY', 'offline');
  vi.stubEnv('KODAX_HOME', root);
  await writeFile(path.join(root, 'value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'check.mjs'), "import {value} from './value.mjs'; if(value!==2) throw Error('wrong value');\n"
    + (scenario === 'projected' ? "process.stdout.write('checked-value=2\\n'.repeat(80));\n" : ''));
  await storage.save('script-session', { messages: [{ role: 'user', content: 'host-owned history' }], title: 'Host title', gitRoot: root });
  class Fixture extends KodaXBaseProvider {
    readonly name = 'script-model-offline';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_SCRIPT_TEST_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      const step = requests++;
      if (step > 1) throw new Error('Unexpected extra model round');
      const names = tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['script_exec', 'bash', 'undo', 'spawn_agent', 'todo_create']));
      expect(names).not.toContain('read');
      const script = tools.find(tool => tool.name === 'script_exec')!;
      expect(script.description).toContain('"name":"read"');
      expect(script.description).toContain('"name":"edit"');
      expect(script.description).toContain('"edits"');
      expect(script.description).toContain('run_in_background');
      if (step === 1) {
        const receipt = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(block => block.type === 'tool_result' && block.tool_use_id === 'cell-1');
        expect(receipt?.type).toBe('tool_result');
        if (receipt?.type !== 'tool_result') throw new Error('missing cell receipt');
        expect(receipt.is_error === true).toBe(scenario !== 'success' && scenario !== 'projected');
        expect(String(receipt.content)).toContain('"name":"read"');
        if (scenario === 'denied') expect(String(receipt.content)).toMatch(/block|denied/i);
        if (scenario === 'failed') expect(String(receipt.content)).toMatch(/not found|no match/i);
        if (scenario === 'projected') {
          const cell = JSON.parse(String(receipt.content)) as ScriptCellResult & {
            value_fields_from_receipts: Record<string, { id: number; field: 'result' | 'content' }>;
            value_reference_note: string;
          };
          const reference = cell.value_fields_from_receipts.output!;
          expect(reference.field).toBe('content');
          const outputReceipt = cell.receipts.find(item => item.id === reference.id)!;
          expect(outputReceipt.name).toBe('bash');
          expect(outputReceipt.result.isError).toBe(false);
          expect(String(outputReceipt.result.content).match(/checked-value=2/g)).toHaveLength(80);
          expect(cell.value).toEqual({ summary: 'fixture checks passed' });
          restoredValue = { ...(cell.value as Record<string, unknown>), output: outputReceipt.result.content };
          const source = cell.receipts.find(item => item.name === 'read')!;
          generatedContent = String(source.result.content).toUpperCase();
          const written = cell.receipts.find(item => item.name === 'write')!;
          expect(written.result.metadata?.toolCall).toMatchObject({ name: 'write',
            input: { path: 'generated.txt', content: generatedContent } });
          expect(cell.value_reference_note).toContain('no additional tool call');
          const { value_fields_from_receipts: _references, value_reference_note: _note, ...sameEvidence } = cell;
          expect(String(receipt.content).length).toBeLessThan(JSON.stringify({ ...sameEvidence, value: restoredValue }).length);
        }
      }
      return { textBlocks: step ? [{ type: 'text', text: 'Changed value to 2 and ran node check.mjs successfully.' }] : [],
        thinkingBlocks: [], toolBlocks: step ? [] : [{ type: 'tool_use', id: 'cell-1', name: 'script_exec', input: {
          code: (scenario === 'denied' ? "await tools.write({path:'blocked.txt',content:'never'});" : '')
            + "const source = await tools.read({path:'value.mjs'});"
            + (scenario === 'projected' ? "const generated = String(source.content).toUpperCase(); const written = await tools.write({path:'generated.txt',content:generated}); if(written.metadata.toolCall.input.content !== generated) throw Error('Guest lost canonical input');" : '')
            + (scenario === 'failed' ? "await tools.edit({path:'value.mjs',edits:[{old_string:'missing anchor',new_string:'wrong'}]}); await tools.read({path:'value.mjs'});" : '')
            + "await tools.edit({path:'value.mjs',edits:[{old_string:'value = 1',new_string:'value = 2'}]}); const checked = await tools.bash({command:'node check.mjs'});"
            + (scenario === 'projected' ? "return {output:checked.content,summary:'fixture checks passed'};" : 'return checked;'),
        } }], stopReason: step ? 'end_turn' : 'tool_use' };
    }
  }
  registerModelProvider('script-model-offline', () => new Fixture());
  try {
    const running = runManagedTask({ provider: 'script-model-offline', workMode: 'script', agentMode: 'ama',
      reasoningMode: 'off', lsp: false, abortSignal: controller.signal, session: { id: 'script-session', storage, persistedByHost },
      context: { executionCwd: root, gitRoot: root, repoIntelligenceMode: 'off', managedWorkBudget: budget },
      events: { beforeToolExecute: async name => { executed.push(name); return ['read', 'edit', 'bash', ...(scenario === 'projected' ? ['write'] : [])].includes(name); },
        onToolResult: receipt => { results.push(receipt.name); if (scenario === 'cancelled' && receipt.name === 'read') controller.abort(); } },
    }, 'Read value.mjs, change value 1 to 2, run node check.mjs and report the result.');
    if (scenario === 'cancelled') await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    else expect((await running).success).toBe(true);
    expect(await readFile(path.join(root, 'value.mjs'), 'utf8')).toContain(scenario === 'cancelled' ? 'value = 1' : 'value = 2');
    const expected = scenario === 'cancelled' ? ['read'] : scenario === 'projected' ? ['read', 'write', 'edit', 'bash'] : scenario === 'denied' ? ['write', 'read', 'edit', 'bash']
      : scenario === 'failed' ? ['read', 'edit', 'read', 'edit', 'bash'] : ['read', 'edit', 'bash'];
    expect(executed).toEqual(expected);
    expect(results.filter(name => name !== 'script_exec')).toEqual(expected);
    expect(requests).toBe(scenario === 'cancelled' ? 1 : 2);
    expect(budget.spentBudget).toBe(expected.length - (scenario === 'denied' ? 1 : 0));
    await expect(readFile(path.join(root, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const records = (await storage.load('script-session'))?.extensionRecords ?? [];
    expect(records.filter(record => record.type === 'call.settled')).toHaveLength(expected.length);
    expect(records.filter(record => record.type === 'cell.settled')).toHaveLength(1);
    if (scenario === 'projected') {
      expect(await readFile(path.join(root, 'generated.txt'), 'utf8')).toBe(generatedContent);
      expect(records.filter(record => record.type === 'call.settled')).toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ data: expect.objectContaining({ name: 'write',
          input: { path: 'generated.txt', content: generatedContent },
          result: expect.objectContaining({ metadata: expect.objectContaining({ toolCall: expect.objectContaining({
            name: 'write', input: { path: 'generated.txt', content: generatedContent },
          }) }) }),
        }) }) }),
      ]));
      expect(records.find(record => record.type === 'cell.settled')).toMatchObject({
        data: { data: { value: restoredValue, spentBudget: 4 } },
      });
      expect(restoredValue?.output).toBeDefined();
      expect(JSON.stringify(records)).not.toContain('value_fields_from_receipts');
    }
    if (persistedByHost) {
      const saved = await storage.load('script-session');
      expect(saved?.title).toBe('Host title');
      expect(saved?.messages).toEqual([expect.objectContaining({ role: 'user', content: 'host-owned history' })]);
    }
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    clearRuntimeModelProviders(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-script-model-')) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);
