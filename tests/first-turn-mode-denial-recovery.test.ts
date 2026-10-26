import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXStreamResult } from '@kodax-ai/llm';
import { CACHE_FILES, CACHE_GOLDEN } from '../benchmark/datasets/search-entry-complex/fixture.js';
import { inputHash } from './first-turn-eval-support.js';
import { runComplexRuntime } from './first-turn-complex-runtime.js';
import { TOOL_RECOVERY_GUIDANCE } from '../packages/coding/src/prompts/execution-guidance.js';

vi.mock('node:child_process', { spy: true });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Original r1 commands, not rewritten into an easier or permitted syntax.
const refusals = [
  ['type README.md & echo ===== & type package.json & echo ===== & type tests\\basic.test.js', 'Only literal review separators are in scope.'],
  ['cd packages && for /r %f in (*.js) do @echo === %f === & type "%f"', 'Unsupported shell syntax in evaluation.'],
  ['fc examples\\legacy-cache.js packages\\cache\\store.js & fc examples\\legacy-key.js packages\\identity\\key.js & echo done', 'Executable is outside the fixture test and inspection scope.'],
  ['mkdir tests 2>nul & dir tests', 'Directory creation must stay in fixture scratch.'],
  ['del tests/debug.test.js && npm test', 'Executable is outside the fixture test and inspection scope.'],
  ['del tests/debug.test.js', 'Executable is outside the fixture test and inspection scope.'],
  ['move tests/debug.test.js .agent/tmp/sessions/case/debug.test.js', 'Executable is outside the fixture test and inspection scope.'],
  ['erase tests/debug.test.js', 'Executable is outside the fixture test and inspection scope.'],
  ['git clean -f tests/debug.test.js', 'Git operation is outside the fixture scope.'],
  ['cmd /c del tests/debug.test.js', 'Executable is outside the fixture test and inspection scope.'],
] as const;

it.each(['native', 'bridge', 'script'] as const)('delivers original mode-trial refusals via %s, permits legal edits/tests and completes the Run', async entry => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('MODE_RECOVERY_KEY', 'offline-only');
  const fetcher = vi.fn(() => { throw new Error('Offline test forbids network'); }); vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-mode-recovery-'));
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const forbiddenExecutions: string[] = [];
  let actualTestExecutions = 0;
  vi.mocked(spawn).mockImplementation((...args) => {
    const serialized = JSON.stringify(args.slice(0, 2));
    if (refusals.some(([command]) => serialized.includes(JSON.stringify(command).slice(1, -1)))) {
      forbiddenExecutions.push(serialized); throw new Error('Forbidden shell reached OS boundary');
    }
    if (serialized.includes('node --test')) actualTestExecutions++;
    return actual.spawn(...args);
  });
  const tool = (name: string, input: Record<string, unknown>, id: string) => ({ type: 'tool_use' as const, name, input, id });
  let sawRefusals = false;
  let sawTests = false;
  let sawLegacyReflection = false;
  const leafTools = refusals.length + 8;
  const totalTools = leafTools + (entry === 'script' ? 4 : entry === 'bridge' ? refusals.length : 0);
  try {
    const record = await runComplexRuntime({ id: 'mode-recovery', provider: 'offline', model: 'fixture', env: 'MODE_RECOVERY_KEY' }, directory,
      async (input, _signal, round) => {
        if (round > 4) throw new Error('Unexpected extra model round');
        expect(input.system.split(TOOL_RECOVERY_GUIDANCE)).toHaveLength(2);
        const transcript = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
        let calls: ReturnType<typeof tool>[] = [];
        if (round === 0) calls = [
          ...refusals.map(([command], i) => tool('bash', { command }, `denied-${i}`)),
          ...Object.keys(CACHE_GOLDEN).map((file, i) => tool('read', { path: file }, `read-${i}`)),
        ];
        if (round === 1) {
          const receipt = transcript.find(block => block.type === 'tool_result' && block.tool_use_id === 'cell-0');
          const cell = entry === 'script' && receipt?.type === 'tool_result'
            ? JSON.parse(String(receipt.content)) as { receipts: { name: string; result: { isError: boolean; content: string; metadata: { toolCall: { input: Record<string, unknown> } } } }[] } : undefined;
          for (const [i, [command, reason]] of refusals.entries()) {
            const needsScopeFeedback = reason.startsWith('Executable') || reason.startsWith('Git operation');
            if (entry === 'script') {
              expect(cell?.receipts[i]).toMatchObject({ name: 'bash', result: { isError: true, content: expect.stringContaining(reason),
                metadata: { toolCall: { input: { command } } } } });
              if (needsScopeFeedback) expect(cell?.receipts[i]?.result.content).toContain('do not retry them with aliases, another shell or Git');
            } else {
              expect(transcript).toContainEqual(expect.objectContaining({ type: 'tool_use', id: `denied-${i}`,
                input: entry === 'bridge' ? { name: 'bash', input: { command } } : { command } }));
              expect(transcript).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: `denied-${i}`, is_error: true,
                content: expect.stringContaining(reason) }));
              if (needsScopeFeedback) expect(transcript).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: `denied-${i}`,
                content: expect.stringContaining('do not retry them with aliases, another shell or Git') }));
            }
          }
          sawRefusals = true;
          calls = Object.entries(CACHE_GOLDEN).map(([file, content], i) => tool('edit', {
            path: file, edits: [{ old_string: CACHE_FILES[file], new_string: content }],
          }, `edit-${i}`));
        }
        if (round === 2) {
          // All three implementations were edited. A Script leaf must not add
          // legacy SA review/escalation teaching to the parent AMA transcript.
          sawLegacyReflection = /SA mode|re-run under AMA|\[Scope:/.test(JSON.stringify(transcript));
          calls = [tool('write', { path: 'tests/recovery.test.js', content:
          "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {createCache} from '../src/cache.js';\ntest('zero TTL is stale',()=>{const cache=createCache({clock:()=>0});cache.set('id','v',0);assert.equal(cache.get('id'),undefined);});\n",
          }, 'new-test')];
        }
        if (round === 3) calls = [tool('bash', { command: 'node --test' }, 'run-tests')];
        if (round === 4) {
          expect(transcript).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: entry === 'script' ? 'cell-3' : 'run-tests',
            is_error: false, content: expect.stringContaining('# pass 2') }));
          sawTests = true;
        }
        if (entry === 'script' && calls.length) calls = [tool('script_exec', {
          code: `for (const call of ${JSON.stringify(calls)}) await tools[call.name](call.input);`,
        }, `cell-${round}`)];
        else if (entry === 'bridge' && round === 0) calls = calls.map(call => call.name === 'bash'
          ? tool('tool_call', { name: call.name, input: call.input }, call.id) : call);
        const result: KodaXStreamResult = { textBlocks: calls.length ? [] : [{ type: 'text', text: 'Original commands refused; legal edits and two tests completed.' }],
          thinkingBlocks: [], toolBlocks: calls, stopReason: calls.length ? 'tool_use' : 'end_turn' };
        return { inputHash: inputHash(input), result, text: '', toolCalls: calls, usage: null, estimatedUsd: null, error: null,
          physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }, { calls: 5, tools: totalTools, timeoutMs: 30000 }, false, 'Recover from refused commands, fix and test the fixture.', [], entry === 'script' ? 'script' : 'agent');
    expect(record.error).toBeNull(); expect(record.phase).toBe('completed');
    expect(sawRefusals).toBe(true); expect(sawTests).toBe(true);
    expect(sawLegacyReflection).toBe(false);
    expect(record.counts.responses).toBe(5); expect(record.counts.toolCount).toBe(totalTools);
    expect(record.counts.nestedToolCount).toBe(entry === 'script' ? leafTools : 0);
    expect(record.groundtruth).toMatchObject({ protectedUnchanged: true, oraclePass: true, publicTestsPass: true });
    expect(forbiddenExecutions).toEqual([]); expect(actualTestExecutions).toBeGreaterThan(0);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 45000);

it.each(['native', 'script'].flatMap(entry => ['responses', 'tools'].map(cap => ({ entry, cap }))))(
  'keeps $cap exhaustion terminal after a recoverable $entry refusal', async ({ entry, cap }) => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('MODE_RECOVERY_KEY', 'offline-only');
    const fetcher = vi.fn(() => { throw new Error('Offline test forbids network'); }); vi.stubGlobal('fetch', fetcher);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-mode-cap-'));
    let invocations = 0;
    try {
      const record = await runComplexRuntime({ id: 'mode-cap', provider: 'offline', model: 'fixture', env: 'MODE_RECOVERY_KEY' }, directory,
        async (input, _signal, round) => {
          invocations++;
          if (round > 1) throw new Error('Budget must stop further generation');
          const leaf = round === 0 ? { name: 'bash', input: { command: refusals[0][0] } }
            : { name: 'write', input: { path: 'tests/never.js', content: 'must not execute' } };
          const call = { type: 'tool_use' as const, id: `call-${round}`, ...leaf };
          const calls = entry === 'script' ? [{ type: 'tool_use' as const, id: `cell-${round}`, name: 'script_exec',
            input: { code: `return await tools.${leaf.name}(${JSON.stringify(leaf.input)});` } }] : [call];
          const result: KodaXStreamResult = { textBlocks: [], thinkingBlocks: [], toolBlocks: calls, stopReason: 'tool_use' };
          return { inputHash: inputHash(input), result, text: '', toolCalls: calls, usage: null, estimatedUsd: null, error: null,
            physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
        }, { calls: cap === 'responses' ? 1 : 3, tools: cap === 'tools' ? (entry === 'script' ? 2 : 1) : 8, timeoutMs: 30000 },
        false, 'Exercise bounded refusal recovery.', [], entry === 'script' ? 'script' : 'agent');
      expect(record.error).toBe(cap === 'responses' ? 'budget-censored: shared root/child response cap' : 'budget-censored: actual tool cap');
      expect(invocations).toBe(cap === 'responses' ? 1 : 2);
      expect(record.phase).not.toBe('completed');
      await expect(fs.stat(path.join(directory, 'workspace/tests/never.js'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(record.groundtruth.protectedUnchanged).toBe(true); expect(fetcher).not.toHaveBeenCalled();
    } finally {
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup');
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 45000,
);
