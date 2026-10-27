import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXStreamResult, type KodaXToolDefinition,
} from '@kodax-ai/llm';
import { runManagedTask, type KodaXWorkMode } from '@kodax-ai/coding';
import { compactContractInput } from './first-turn-compact-contract.js';

// Deterministic integration, not an intelligence eval: identical scripted decisions,
// real read/edit/test handlers and AMA completion; no provider/network requests.
it.each<{ workMode: KodaXWorkMode; candidate: boolean }>([
  { workMode: 'coding', candidate: false }, { workMode: 'agent', candidate: false },
  { workMode: 'coding', candidate: true }, { workMode: 'agent', candidate: true },
])('completes the same read/edit/test task: $workMode compact=$candidate', async ({ workMode, candidate }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-work-mode-e2e-'));
  let calls = 0;
  const executed: string[] = [];
  const fetcher = vi.fn(() => { throw new Error('Offline fixture must not access a model endpoint'); });
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('KODAX_WORK_MODE_TEST_KEY', 'offline-fixture');
  await writeFile(path.join(directory, 'value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(directory, 'fixture.test.mjs'),
    "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from './value.mjs';\ntest('value is two', () => assert.equal(value, 2));\n");
  class FixtureProvider extends KodaXBaseProvider {
    readonly name = 'work-mode-offline';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_WORK_MODE_TEST_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> {
      expect(tools.find(tool => tool.name === 'glob')?.description).toBe('Find file paths by glob.');
      if (candidate) {
        const input = compactContractInput({ system, messages, tools }, true);
        // Managed roots now arrive with the adopted compact contract. The old
        // experiment must leave this already-projected request untouched.
        expect(system).toContain('TRUST AND SCOPE');
        expect(input.system).toBe(system);
        expect(input.tools).toBe(tools);
        expect(input.messages).toBe(messages);
        tools = [...input.tools];
      }
      const step = calls++;
      if (step > 3) throw new Error('Unexpected extra provider request after the completed task');
      const names = tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['read', 'edit', 'bash', 'spawn_agent', 'todo_create']));
      expect(names.includes('relationship_scan')).toBe(workMode === 'coding');
      const receipts = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block.type === 'tool_result');
      if (step > 0) {
        const receipt = receipts.find(block => block.tool_use_id === `step-${step - 1}`);
        expect(receipt).toBeDefined();
        expect(receipt!.is_error).not.toBe(true);
        if (step === 1) expect(String(receipt!.content)).toContain('export const value = 1;');
        if (step === 3) expect(String(receipt!.content)).toMatch(/pass\s+1/i);
      }
      const call = [
        { name: 'read', input: { path: 'value.mjs' } },
        { name: 'edit', input: { path: 'value.mjs', edits: [{ old_string: 'value = 1', new_string: 'value = 2' }] } },
        { name: 'bash', input: { command: 'node --test fixture.test.mjs' } },
      ][step];
      return {
        textBlocks: call ? [] : [{ type: 'text', text: 'Changed value to 2; node --test fixture.test.mjs passed one test.' }],
        thinkingBlocks: [], toolBlocks: call ? [{ type: 'tool_use', id: `step-${step}`, ...call }] : [],
        stopReason: call ? 'tool_use' : 'end_turn',
      };
    }
  }
  registerModelProvider('work-mode-offline', () => new FixtureProvider());
  try {
    const result = await runManagedTask({ provider: 'work-mode-offline', workMode, agentMode: 'ama',
      maxIter: 8, reasoningMode: 'off', lsp: false,
      context: { executionCwd: directory, gitRoot: directory, repoIntelligenceMode: 'off' },
      events: { beforeToolExecute: async (name, input) => {
        if (!['read', 'edit', 'bash'].includes(name)) return '[Tool Error] Outside fixture scope';
        if (name === 'bash' ? input.command !== 'node --test fixture.test.mjs' : input.path !== 'value.mjs') {
          return '[Tool Error] Outside fixture workspace or command';
        }
        executed.push(name);
        return true;
      } },
    }, 'Make the single-line change in value.mjs from value 1 to 2. Read first, run node --test fixture.test.mjs, report the actual result.');
    expect(result.success).toBe(true);
    expect(result.lastText).toContain('passed one test');
    expect(await readFile(path.join(directory, 'value.mjs'), 'utf8')).toBe('export const value = 2;\n');
    expect(executed).toEqual(['read', 'edit', 'bash']);
    expect(calls).toBe(4);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    clearRuntimeModelProviders(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-work-mode-e2e-')) {
      throw new Error('Unsafe fixture cleanup');
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);
