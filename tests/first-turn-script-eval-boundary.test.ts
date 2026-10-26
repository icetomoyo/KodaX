import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runComplexRuntime } from './first-turn-complex-runtime.js';
import { inputHash } from './first-turn-eval-support.js';
import type { KodaXStreamResult } from '@kodax-ai/llm';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('records a resolved Runtime failure instead of reporting an empty error', async () => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SCRIPT_EVAL_KEY', 'offline');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-script-eval-'));
  try {
    const record = await runComplexRuntime({ id: 'failure', provider: 'offline', model: 'fixture', env: 'SCRIPT_EVAL_KEY' }, directory,
      async () => { throw new Error('Offline injected provider failure'); }, { calls: 1, tools: 1, timeoutMs: 30000 });
    expect(record.phase).toBe('failed');
    expect(record.error).toContain('Provider request failed');
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 45000);

it.each([
  { name: 'protected mutation', code: "await tools.write({path:'README.md',content:'must not change'});", reason: 'Only implementations, new tests and fixture scratch may change.' },
  { name: 'external retrieval', code: "await tools.web_fetch({url:'https://example.invalid'});", reason: 'External retrieval and session data are outside this bounded fixture.' },
])('enforces the complex fixture $name boundary inside a real Script cell', async ({ code, reason }) => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SCRIPT_EVAL_KEY', 'offline');
  const fetcher = vi.fn(() => { throw new Error('Offline test forbids network'); }); vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-script-eval-'));
  try {
    const record = await runComplexRuntime({ id: 'script-boundary', provider: 'offline', model: 'fixture', env: 'SCRIPT_EVAL_KEY' }, directory,
      async (input, _signal, index) => {
        expect(input.tools.map(tool => tool.name)).toContain('script_exec');
        const result: KodaXStreamResult = { textBlocks: index ? [{ type: 'text', text: 'Done.' }] : [], thinkingBlocks: [],
          toolBlocks: index ? [] : [{ type: 'tool_use', id: 'cell-1', name: 'script_exec', input: { code } }],
          stopReason: index ? 'end_turn' : 'tool_use' };
        return { inputHash: inputHash(input), result, text: '', toolCalls: result.toolBlocks, usage: null, estimatedUsd: null,
          error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }, { calls: 4, tools: 8, timeoutMs: 30000 }, false, 'Exercise a bounded Script fixture.', [], 'script');
    expect(record.groundtruth.protectedUnchanged).toBe(true);
    expect(record.error, JSON.stringify({ phase: record.phase, counts: record.counts, events: record.events })).toContain(reason);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 45000);

it('returns original refusal and successful recovery in one Script cell without another model round', async () => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SCRIPT_EVAL_KEY', 'offline');
  const fetcher = vi.fn(() => { throw new Error('Offline test forbids network'); }); vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-script-eval-'));
  let sawRecovery = false;
  try {
    const record = await runComplexRuntime({ id: 'script-recovery', provider: 'offline', model: 'fixture', env: 'SCRIPT_EVAL_KEY' }, directory,
      async (input, _signal, index) => {
        if (index > 1) throw new Error('Unexpected extra model round');
        if (index === 1) {
          const receipt = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
            .find(block => block.type === 'tool_result' && block.tool_use_id === 'cell-recover');
          expect(receipt?.type).toBe('tool_result');
          if (receipt?.type !== 'tool_result') throw new Error('Missing Script receipt');
          const cell = JSON.parse(String(receipt.content)) as { hadToolErrors: boolean; receipts: { result: { isError:boolean; content:string; metadata: {toolCall:{input:{path:string}}} } }[] };
          expect(cell.hadToolErrors).toBe(true);
          expect(cell.receipts.map(row => row.result.metadata.toolCall.input.path)).toEqual(['../outside.md', 'README.md']);
          expect(cell.receipts[0]?.result.isError).toBe(true);
          expect(cell.receipts[1]?.result.isError).toBe(false);
          expect(cell.receipts[1]?.result.content).toContain('Tenant cache client');
          sawRecovery = true;
        }
        const result: KodaXStreamResult = { textBlocks: index ? [{ type: 'text', text: 'Read the allowed README after the refusal.' }] : [], thinkingBlocks: [],
          toolBlocks: index ? [] : [{ type: 'tool_use', id: 'cell-recover', name: 'script_exec', input: {
            code: "const denied = await tools.read({path:'../outside.md'}); if (!denied.isError) throw Error('Expected refusal'); return await tools.read({path:'README.md'});",
          } }], stopReason: index ? 'end_turn' : 'tool_use' };
        return { inputHash: inputHash(input), result, text: '', toolCalls: result.toolBlocks, usage: null, estimatedUsd: null,
          error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }, { calls: 3, tools: 3, timeoutMs: 30000 }, false, 'Read fixture evidence and report the result.', [], 'script');
    expect(record.error).toBeNull(); expect(record.phase).toBe('completed');
    expect(sawRecovery).toBe(true); expect(record.counts.responses).toBe(2);
    expect(record.counts.toolCount).toBe(3); expect(record.counts.nestedToolCount).toBe(2);
    expect(record.groundtruth.protectedUnchanged).toBe(true); expect(fetcher).not.toHaveBeenCalled();
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 45000);

it.each([2, 4])('counts %i nested calls against one shared cap and blocks a later effect across cells', async leaves => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SCRIPT_EVAL_KEY', 'offline');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-script-eval-'));
  const fetcher = vi.fn(() => { throw new Error('Offline test forbids network'); }); vi.stubGlobal('fetch', fetcher);
  try {
    const record = await runComplexRuntime({ id: 'script-cap', provider: 'offline', model: 'fixture', env: 'SCRIPT_EVAL_KEY' }, directory,
      async (input, _signal, index) => {
        if (index > 1) throw new Error('Cap did not stop dispatch');
        const code = index === 0
          ? `for (const path of ${JSON.stringify(['README.md', 'package.json', 'src/cache.js', 'tests/basic.test.js'].slice(0, leaves))}) await tools.read({path});`
          : "await tools.write({path:'tests/should-not-exist.js',content:'forbidden by eval budget'});";
        const result: KodaXStreamResult = { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: `cell-${index}`, name: 'script_exec', input: { code } }], stopReason: 'tool_use' };
        return { inputHash: inputHash(input), result, text: '', toolCalls: result.toolBlocks, usage: null, estimatedUsd: null,
          error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }, { calls: 3, tools: leaves + 2, timeoutMs: 30000 }, false, 'Exercise a bounded Script fixture.', [], 'script');
    expect(record.error).toBe('budget-censored: actual tool cap');
    expect(record.counts.responses).toBe(2);
    expect(record.counts.nestedToolCount).toBe(leaves + 1);
    await expect(fs.stat(path.join(directory, 'workspace/tests/should-not-exist.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 45000);
