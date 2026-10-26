import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { runManagedTask } from '@kodax-ai/coding';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';

it.each([false, true].flatMap(persistedByHost => ['success', 'denied', 'failed', 'cancelled'].map(scenario => ({ persistedByHost, scenario }))))(
  'assembles full contracts and settles $scenario (host persistence=$persistedByHost)', async ({ persistedByHost, scenario }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-model-'));
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions'), configHome: root, cwd: root });
  let requests = 0;
  const executed: string[] = [];
  const results: string[] = [];
  const budget = { totalBudget: 12, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const controller = new AbortController();
  const fetcher = vi.fn(() => { throw new Error('No external requests permitted'); });
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('KODAX_SCRIPT_TEST_KEY', 'offline');
  vi.stubEnv('KODAX_HOME', root);
  await writeFile(path.join(root, 'value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'check.mjs'), "import {value} from './value.mjs'; if(value!==2) throw Error('wrong value');\n");
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
        expect(receipt.is_error === true).toBe(scenario !== 'success');
        expect(String(receipt.content)).toContain('"name":"read"');
        if (scenario === 'denied') expect(String(receipt.content)).toMatch(/block|denied/i);
        if (scenario === 'failed') expect(String(receipt.content)).toMatch(/not found|no match/i);
      }
      return { textBlocks: step ? [{ type: 'text', text: 'Changed value to 2 and ran node check.mjs successfully.' }] : [],
        thinkingBlocks: [], toolBlocks: step ? [] : [{ type: 'tool_use', id: 'cell-1', name: 'script_exec', input: {
          code: (scenario === 'denied' ? "await tools.write({path:'blocked.txt',content:'never'});" : '')
            + "await tools.read({path:'value.mjs'});"
            + (scenario === 'failed' ? "await tools.edit({path:'value.mjs',edits:[{old_string:'missing anchor',new_string:'wrong'}]}); await tools.read({path:'value.mjs'});" : '')
            + "await tools.edit({path:'value.mjs',edits:[{old_string:'value = 1',new_string:'value = 2'}]}); return await tools.bash({command:'node check.mjs'});",
        } }], stopReason: step ? 'end_turn' : 'tool_use' };
    }
  }
  registerModelProvider('script-model-offline', () => new Fixture());
  try {
    const running = runManagedTask({ provider: 'script-model-offline', workMode: 'script', agentMode: 'ama',
      reasoningMode: 'off', lsp: false, abortSignal: controller.signal, session: { id: 'script-session', storage, persistedByHost },
      context: { executionCwd: root, gitRoot: root, repoIntelligenceMode: 'off', managedWorkBudget: budget },
      events: { beforeToolExecute: async name => { executed.push(name); return ['read', 'edit', 'bash'].includes(name); },
        onToolResult: receipt => { results.push(receipt.name); if (scenario === 'cancelled' && receipt.name === 'read') controller.abort(); } },
    }, 'Read value.mjs, change value 1 to 2, run node check.mjs and report the result.');
    if (scenario === 'cancelled') await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    else expect((await running).success).toBe(true);
    expect(await readFile(path.join(root, 'value.mjs'), 'utf8')).toContain(scenario === 'cancelled' ? 'value = 1' : 'value = 2');
    const expected = scenario === 'cancelled' ? ['read'] : scenario === 'denied' ? ['write', 'read', 'edit', 'bash']
      : scenario === 'failed' ? ['read', 'edit', 'read', 'edit', 'bash'] : ['read', 'edit', 'bash'];
    expect(executed).toEqual(expected);
    expect(results.filter(name => name !== 'script_exec')).toEqual(expected);
    expect(requests).toBe(scenario === 'cancelled' ? 1 : 2);
    expect(budget.spentBudget).toBe(expected.length - (scenario === 'denied' ? 1 : 0));
    await expect(readFile(path.join(root, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const records = (await storage.load('script-session'))?.extensionRecords ?? [];
    expect(records.filter(record => record.type === 'call.settled')).toHaveLength(expected.length);
    expect(records.filter(record => record.type === 'cell.settled')).toHaveLength(1);
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
