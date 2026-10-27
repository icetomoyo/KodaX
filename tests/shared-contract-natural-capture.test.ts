import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Agent } from '@kodax-ai/agent';
import type { KodaXStreamResult, KodaXToolUseBlock } from '@kodax-ai/llm';
import * as scriptModel from '../packages/coding/src/agent-runtime/script/model.js';
import { runNaturalRuntime } from './shared-contract-natural-runtime.js';
import { restructuredContractInput } from './restructured-contract.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';

it('freezes three-mode natural checkpoints with real Runtime receipts and structured Script contracts', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubGlobal('fetch', () => { throw new Error('Offline capture cannot call a provider'); });
  const wrappers: Agent[] = [];
  const original = scriptModel.withScriptModelTool;
  const spy = vi.spyOn(scriptModel, 'withScriptModelTool').mockImplementation((...args) => {
    const agent = original(...args); wrappers.push(agent); return agent;
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-natural-capture-'));
  const checkpoints: Array<{ id: string; input: FrozenInput; scriptContracts?: ReturnType<typeof scriptModel.getScriptModelContracts> }> = [];
  const answer = (toolBlocks: KodaXToolUseBlock[] = []): KodaXStreamResult => ({
    toolBlocks, textBlocks: toolBlocks.length ? [] : [{ type: 'text', text: '离线检查点准备到此停止；未声称完成原任务。' }],
    thinkingBlocks: [], stopReason: toolBlocks.length ? 'tool_use' : 'end_turn',
  });
  try {
    for (const workMode of ['agent', 'coding', 'script'] as const) {
      for (const caseId of ['symptom-repair', 'verification-followup'] as const) {
        const directory = path.join(root, `${workMode}-${caseId}`);
        await fs.mkdir(directory);
        const record = await runNaturalRuntime(directory, caseId,
          async (input, _signal, index, meta) => {
            if (meta.kind !== 'root') throw new Error('Unexpected auxiliary/child in offline capture');
            if (caseId === 'symptom-repair' && index === 0) {
              const calls: KodaXToolUseBlock[] = ['README.md', 'src/recovery.js', 'test/recovery.test.js'].map((file, i) =>
                ({ type: 'tool_use', id: `read-${i}`, name: 'read', input: { path: file } }));
              return answer(workMode === 'script' ? [{ type: 'tool_use', id: 'read-source', name: 'script_exec',
                input: { code: calls.map(call => `await tools.read(${JSON.stringify(call.input)});`).join('\n') } }] : calls);
            }
            expect(index).toBe(caseId === 'symptom-repair' ? 1 : 0);
            if (caseId === 'symptom-repair') {
              const results = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
                .filter(block => block.type === 'tool_result');
              expect(results.length).toBeGreaterThan(0);
              expect(results.some(result => result.is_error)).toBe(false);
              expect(JSON.stringify(results)).toContain('cleanup.state');
            }
            const scriptContracts = wrappers.map(agent => scriptModel.getScriptModelContracts(agent, input.tools)).find(Boolean);
            const after = restructuredContractInput(input, true, scriptContracts);
            expect(input.system).toContain('TRUST AND SCOPE');
            expect(input.system).toContain('MUTATION DISCIPLINE:');
            // The old experiment must not re-transform an already adopted root.
            expect(after).toBe(input);
            expect(inputHash(after.messages)).toBe(inputHash(input.messages));
            expect(after.tools.map(tool => tool.input_schema)).toEqual(input.tools.map(tool => tool.input_schema));
            if (workMode === 'script') expect(scriptContracts?.leaves.some(tool => tool.name === 'read')).toBe(true);
            checkpoints.push({ id: `${workMode}-${caseId}`, input: structuredClone(input), scriptContracts });
            return answer();
          }, { workMode, limits: { calls: 3, tools: 6, timeoutMs: 30000 } });
        expect(record.error).toBeNull();
        expect(record.counts.requests).toBe(caseId === 'symptom-repair' ? 2 : 1);
        expect(record.protectedUnchanged).toBe(true);
      }
    }
    expect(checkpoints).toHaveLength(6);
    const file = path.join(root, 'capture.json');
    await fs.writeFile(file, JSON.stringify({ revision: 'managed-default-r2', externalCalls: 0, scope: 'log-inspired checkpoint preparation, not completed repair', checkpoints }, null, 2), { flag: 'wx' });
    process.stdout.write(`Natural checkpoints: ${file}\n`);
  } finally { spy.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
}, 120000);
