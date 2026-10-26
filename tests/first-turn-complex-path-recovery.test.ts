import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXStreamResult } from '@kodax-ai/llm';
import { CACHE_FILES, CACHE_GOLDEN } from '../benchmark/datasets/search-entry-complex/fixture.js';
import { inputHash } from './first-turn-eval-support.js';
import { runComplexRuntime } from './first-turn-complex-runtime.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('records the refused Runtime request when a shared response budget stops dispatch', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('COMPLEX_OFFLINE_KEY', 'offline-only');
  const fetcher = vi.fn(async () => { throw new Error('Offline regression forbids network'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-budget-admission-'));
  const invoke = vi.fn(async (): Promise<never> => { throw new Error('Budget must stop before dispatch'); });
  try {
    const result = await runComplexRuntime({ id: 'budget-admission', provider: 'offline', model: 'offline', env: 'COMPLEX_OFFLINE_KEY' }, directory, invoke,
      { calls: 0, tools: 2, timeoutMs: 15000 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('budget-censored: shared root/child response cap');
    expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'provider-budget-rejected', contextKind: 'root',
      toolNames: expect.arrayContaining(['spawn_agent']), lastMessage: expect.objectContaining({ role: 'user' }),
    })]));
    expect(invoke).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it.each(['read', 'tool_call'])('denies an unchanged outside %s, returns its actual tool error, and completes editing through the real Runtime', async entry => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('COMPLEX_OFFLINE_KEY', 'offline-not-a-credential');
  const fetcher = vi.fn(async () => { throw new Error('Offline regression forbids network'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-path-recovery-'));
  const outsideSecret = 'OUTSIDE-FIXTURE-CONTENT-MUST-NOT-LEAK';
  const badPath = directory + '/invented-registry/../outside.txt';
  await fs.mkdir(path.join(directory, 'invented-registry'));
  await fs.writeFile(path.join(directory, 'outside.txt'), outsideSecret);
  const tool = (name: string, input: Record<string, unknown>, id: string) => ({ type: 'tool_use' as const, name, input, id });
  const outsideCall = entry === 'read' ? tool('read', { path: badPath }, 'outside-read')
    : tool('tool_call', { name: 'read', input: { path: badPath } }, 'outside-read');
  const originalCall = structuredClone(outsideCall);
  let rootCalls = 0;
  let sawDenial = false;
  let denialTranscript = '';
  let denialIsError = false;
  try {
    const record = await runComplexRuntime({ id: 'offline-recovery', provider: 'offline', model: 'offline', env: 'COMPLEX_OFFLINE_KEY' }, directory, async (input, _signal, _index, meta) => {
      expect(meta.streamOptions?.maxOutputTokensOverride).toBe(8192);
      const round = rootCalls++;
      let tools: ReturnType<typeof tool>[] = [];
      if (round === 0) tools = [
        tool('read', { path: 'src/cache.js' }, 'allowed-before'), outsideCall,
        tool('read', { path: 'tests/basic.test.js' }, 'allowed-after'),
      ];
      if (round === 1) {
        const text = JSON.stringify(input.messages);
        denialTranscript = text;
        denialIsError = input.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'outside-read' && b.is_error === true));
        sawDenial = true;
        tools = Object.keys(CACHE_GOLDEN).map((file, i) => tool('read', { path: file }, 'read-' + i));
      }
      if (round === 2) tools = Object.entries(CACHE_GOLDEN).map(([file, text], i) => tool('edit', { path: file, edits: [{ old_string: CACHE_FILES[file], new_string: text }] }, 'edit-' + i));
      if (round === 3) tools = [tool('write', { path: 'tests/recovery.test.js', content: "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {createCache} from '../src/cache.js';\ntest('zero TTL is immediately stale',()=>{const cache=createCache({clock:()=>0});cache.set('id','v',0);assert.equal(cache.get('id'),undefined);});\n" }, 'new-test')];
      if (round === 4) tools = [tool('bash', { command: 'npm test' }, 'run-tests')];
      const result: KodaXStreamResult = { textBlocks: tools.length ? [] : [{ type: 'text', text: 'Offline scripted recovery completed; tests ran after edits.' }], thinkingBlocks: [], toolBlocks: tools, stopReason: tools.length ? 'tool_use' : 'end_turn' };
      return { inputHash: inputHash(input), result, text: '', toolCalls: tools, usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
    }, { calls: 9, tools: 20, timeoutMs: 30000, output: 8192 });
    expect(record.error).toBeNull();
    expect(record.success).toBe(true);
    expect(record.counts.nestedToolCount).toBe(0);
    expect(record.counts.toolCount).toBe(record.calls.reduce((count, call) => count + call.toolCalls.reduce(
      (sum, tool) => sum + (tool.name === 'tool_call' ? 2 : 1), 0), 0));
    expect(sawDenial).toBe(true);
    expect(denialTranscript).toContain('outside-read');
    expect(denialTranscript).toContain('Path leaves the fixture workspace.');
    expect(denialTranscript).not.toContain(outsideSecret);
    expect(denialIsError).toBe(true);
    expect(denialTranscript).toContain("export { createCache }");
    expect(denialTranscript).toContain('basic caching and expiry after deadline');
    expect(record.groundtruth).toMatchObject({ protectedUnchanged: true, oraclePass: true, publicTestsPass: true });
    expect(outsideCall).toEqual(originalCall);
    expect(JSON.stringify(record.events)).not.toContain(outsideSecret);
    expect(await fs.readFile(path.join(directory, 'outside.txt'), 'utf8')).toBe(outsideSecret);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it('inherits the read boundary in an actual readonly child and lets that child recover', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('COMPLEX_OFFLINE_KEY', 'offline-not-a-credential');
  const fetcher = vi.fn(async () => { throw new Error('Offline regression forbids network'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-child-path-recovery-'));
  const outsideSecret = 'CHILD-MUST-NOT-READ-THIS';
  const badPath = path.join(directory, 'outside.txt');
  await fs.writeFile(badPath, outsideSecret);
  let rootCalls = 0;
  let childCalls = 0;
  let childSawError = false;
  try {
    const record = await runComplexRuntime({ id: 'child-recovery', provider: 'offline', model: 'offline', env: 'COMPLEX_OFFLINE_KEY' }, directory, async input => {
      const child = input.system.includes('focused sub-agent');
      const round = child ? childCalls++ : rootCalls++;
      const tools = child
        ? round === 0 ? [{ type: 'tool_use' as const, id: 'child-outside', name: 'read', input: { path: badPath } }]
          : round === 1 ? [{ type: 'tool_use' as const, id: 'child-inside', name: 'read', input: { path: 'README.md' } }] : []
        : round === 0 ? [{ type: 'tool_use' as const, id: 'spawn-readonly', name: 'spawn_agent', input: { task_name: 'compat', objective: 'Read README only and report compatibility.', read_only: true, fork_turns: 'none' } }] : [];
      if (child && round === 1) {
        expect(JSON.stringify(input.messages)).toContain('Path leaves the fixture workspace.');
        expect(JSON.stringify(input.messages)).not.toContain(outsideSecret);
        childSawError = true;
      }
      const result: KodaXStreamResult = { textBlocks: tools.length ? [] : [{ type: 'text', text: child ? 'Readonly compatibility inspection complete.' : 'Integrated readonly inspection.' }], thinkingBlocks: [], toolBlocks: tools, stopReason: tools.length ? 'tool_use' : 'end_turn' };
      return { inputHash: inputHash(input), result, text: '', toolCalls: tools, usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
    }, { calls: 10, tools: 12, timeoutMs: 30000 }, true);
    expect(record.error).toBeNull();
    expect(record.success).toBe(true);
    expect(childSawError).toBe(true);
    expect(childCalls).toBe(3);
    expect(record.counts.allowedSpawns).toBe(1);
    expect(JSON.stringify(record.tree)).toContain('"state":"completed"');
    expect(JSON.stringify(record.events)).not.toContain(outsideSecret);
    expect(record.groundtruth.protectedUnchanged).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it.each([
  { commandText: 'cd packages & cd .. & git diff', reason: 'Shell argument leaves the fixture workspace.' },
  { commandText: 'cd packages & git diff', reason: 'Directory change must target the fixture root.' },
])('preserves the readonly child directory command and its refusal category: $commandText', async ({ commandText, reason }) => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('COMPLEX_OFFLINE_KEY', 'offline-only');
  const fetcher = vi.fn(async () => { throw new Error('Offline regression forbids network'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-child-cwd-recovery-'));
  const command = { type: 'tool_use' as const, id: 'rejected-cwd', name: 'bash', input: { command: commandText } };
  const original = structuredClone(command);
  let rootCalls = 0;
  let childCalls = 0;
  let childSawDenial = false;
  try {
    const record = await runComplexRuntime({ id: 'child-cwd-recovery', provider: 'offline', model: 'offline', env: 'COMPLEX_OFFLINE_KEY' }, directory, async input => {
      const child = input.system.includes('focused sub-agent');
      const round = child ? childCalls++ : rootCalls++;
      const tools = child ? round === 0 ? [command] : round === 1
        ? [{ type: 'tool_use' as const, id: 'inspect-root', name: 'read', input: { path: 'README.md' } }] : []
        : round === 0 ? [{ type: 'tool_use' as const, id: 'spawn-qa', name: 'spawn_agent', input: { task_name: 'qa', objective: 'Readonly review.', read_only: true, fork_turns: 'none' } }] : [];
      if (child && round === 1) {
        childSawDenial = input.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
            block.type === 'tool_result' && block.tool_use_id === 'rejected-cwd' && block.is_error === true && String(block.content).includes(reason)));
      }
      if (child && round === 2) expect(input.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
        block.type === 'tool_result' && block.tool_use_id === 'inspect-root' && !block.is_error && String(block.content).includes(CACHE_FILES['README.md']!)))).toBe(true);
      const result: KodaXStreamResult = { textBlocks: tools.length ? [] : [{ type: 'text', text: 'Offline inspection finished after the denied command.' }],
        thinkingBlocks: [], toolBlocks: tools, stopReason: tools.length ? 'tool_use' : 'end_turn' };
      return { inputHash: inputHash(input), result, text: '', toolCalls: tools, usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
    }, { calls: 10, tools: 12, timeoutMs: 30000 }, true);
    expect(record.error).toBeNull();
    expect(record.success).toBe(true);
    expect(childSawDenial).toBe(true);
    expect(childCalls).toBe(3);
    expect(record.events).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'guard', tool: 'bash', input: original.input, denied: reason,
    })]));
    expect(command).toEqual(original);
    expect(record.groundtruth.protectedUnchanged).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it.each([
  { name: ' write ', input: { path: '../escape.js', content: 'outside mutation' } },
  { name: ' spawn_agent ', input: { task_name: 'writable-child', objective: 'out of scope', read_only: false } },
  { name: ' bash ', input: { command: 'node --test ../outside.test.js' } },
  { name: ' bash ', input: { command: 'node --version && type ../outside.txt' } },
  { name: ' bash ', input: { command: 'node --version && curl https://example.invalid' } },
  { name: ' bash ', input: { command: 'node --version && cd packages && curl https://example.invalid' } },
].flatMap(target => (typeof target.input.command === 'string' && target.input.command.startsWith('node --version')
  ? ['bash', 'tool_call'] : ['tool_call']).map(entry => ({ entry, target }))))('blocks forbidden $entry target without granting it execution: $target.name', async ({ entry, target }) => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('COMPLEX_OFFLINE_KEY', 'offline-not-a-credential');
  const fetcher = vi.fn(async () => { throw new Error('Offline regression forbids network'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bridge-hard-stop-'));
  let calls = 0;
  const call = { type: 'tool_use' as const, id: 'forbidden-bridge', name: entry === 'bash' ? target.name.trim() : entry,
    input: entry === 'bash' ? target.input : target };
  const original = structuredClone(call);
  try {
    const record = await runComplexRuntime({ id: 'bridge-hard-stop', provider: 'offline', model: 'offline', env: 'COMPLEX_OFFLINE_KEY' }, directory, async input => {
      if (calls === 1) expect(input.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
        block.type === 'tool_result' && block.tool_use_id === call.id && block.is_error === true))).toBe(true);
      const tools = calls++ === 0 ? [call] : [];
      const result: KodaXStreamResult = { textBlocks: tools.length ? [] : [{ type: 'text', text: 'The requested command was refused.' }], thinkingBlocks: [], toolBlocks: tools, stopReason: tools.length ? 'tool_use' : 'end_turn' };
      return { inputHash: inputHash(input), result, text: '', toolCalls: tools, usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
    }, { calls: 3, tools: 5, timeoutMs: 30000 });
    if (target.name.trim() === 'bash') {
      expect(record.error).toBeNull(); expect(calls).toBe(2);
    } else {
      expect(record.error).toContain('isolation-rejected-before-execution'); expect(calls).toBe(1);
    }
    expect(record.counts.allowedSpawns).toBe(0);
    expect(record.groundtruth.protectedUnchanged).toBe(true);
    expect(await fs.stat(path.join(directory, 'escape.js')).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })).toBe(false);
    expect(call).toEqual(original);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
