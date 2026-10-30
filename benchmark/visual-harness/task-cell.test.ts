import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTaskCell } from './task-cell.js';
import { createTaskFixtures } from './task-fixtures.js';
import { setKodaXDiagnosticSink } from '@kodax-ai/agent';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('allows the frozen three-read → edit → test → informed final-answer path without hiding tool feedback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-four-round-test-'));
  let main = 0;
  try {
    const { D } = await createTaskFixtures(Buffer.from([2, 0, 1, 3]));
    for (const [file, bytes] of Object.entries(D.files)) await writeFile(path.join(directory, file), bytes);
    const call = (name: string, input: Record<string, unknown>) => ({ id: `four-${main}-${name}-${JSON.stringify(input).length}`,
      type: 'function' as const, function: { name, arguments: JSON.stringify(input) } });
    const result = await runTaskCell({ workspace: directory, home: path.join(directory, 'home'), prompt: D.prompt,
      limits: { mainResponses: 4, toolsPerResponse: 4 },
      respond: async request => {
        if (!(JSON.stringify(request.tools) ?? '').includes('todo_update')) return { content: '{"candidates":[]}' };
        main++;
        if (main === 1) return { content: '', tool_calls: ['config.mjs', 'config.test.mjs', 'package.json'].map(file => call('read', { path: file })) };
        if (main === 2) return { content: '', tool_calls: [call('edit', { path: 'config.mjs', edits: [{ old_string: 'const value = JSON.parse(text);', new_string: "const value = JSON.parse(text.trim() || '{}');" }] })] };
        if (main === 3) return { content: '', tool_calls: [call('bash', { command: 'node --test config.test.mjs', timeout: 10 })] };
        expect(JSON.stringify(request.messages)).toMatch(/pass\\?\s+5/);
        return { content: 'Five existing tests passed; empty and blank configurations now use defaults.' };
      } });
    expect(result.result.phase).toBe('completed');
    expect(result.mainResponses).toBe(4);
    expect(result.tools.map(tool => tool.name)).toEqual(['read', 'read', 'read', 'edit', 'bash']);
    expect(result.tools.every(tool => !tool.content.startsWith('[Tool Error]'))).toBe(true);
    expect(result.answer).toContain('Five existing tests passed');
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('uses the production Runtime, executes a proposed read and returns the real file before the final answer', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-cell-test-'));
  try {
    await writeFile(path.join(directory, 'config.mjs'), 'export const retries = 3;\n');
    const requests: Record<string, unknown>[] = [];
    const result = await runTaskCell({ workspace: directory, home: path.join(directory, 'home'), prompt: '读取 config.mjs 并给出 retries 的值。',
      respond: async request => {
        requests.push(request);
        const primary = (JSON.stringify(request.tools) ?? '').includes('todo_update');
        if (!primary) return { content: '{"candidates":[]}', tool_calls: [] };
        return requests.filter(item => (JSON.stringify(item.tools) ?? '').includes('todo_update')).length === 1
          ? { content: '', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'config.mjs' }) } }] }
          : { content: 'retries = 3', tool_calls: [] };
      } });
    expect(result.mainResponses).toBe(2);
    expect(result.tools).toEqual([expect.objectContaining({ name: 'read', content: expect.stringContaining('retries = 3') })]);
    expect(JSON.stringify(requests.at(-1))).toContain('retries = 3');
    expect(result.answer).toContain('retries = 3');
    expect(result.backgroundSettled).toBe(true);
    expect(await readFile(path.join(directory, 'config.mjs'), 'utf8')).toBe('export const retries = 3;\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('returns a settled boundary outcome without dispatching an oversized write batch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-batch-stop-test-'));
  let requests = 0;
  try {
    const result = await runTaskCell({ workspace: directory, home: path.join(directory, 'home'), prompt: 'Work on the local fixture.',
      respond: async () => { requests++; return { content: '', tool_calls: ['a', 'b', 'c'].map(name => ({ id: name, type: 'function' as const,
        function: { name: 'write', arguments: JSON.stringify({ path: `${name}.txt`, content: 'must not be written' }) } })) }; } });
    expect(result.error?.message).toContain('Two tool calls per response');
    expect(result.tools).toEqual([]);
    expect((await readdir(directory)).filter(file => file.endsWith('.txt'))).toEqual([]);
    expect(requests).toBe(1);
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('retains real completed tool feedback when the next main request exceeds the frozen slots', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-stopped-outcome-test-'));
  let requests = 0;
  try {
    for (const name of ['a', 'b', 'c']) await writeFile(path.join(directory, `${name}.txt`), `real ${name}`);
    const result = await runTaskCell({ workspace: directory, home: path.join(directory, 'home'), prompt: 'Inspect local files.',
      respond: async request => {
        if (!(JSON.stringify(request.tools) ?? '').includes('todo_update')) return { content: '{"candidates":[]}' };
        const file = ['a', 'b', 'c'][requests++];
        return { content: '', tool_calls: [{ id: `read-${requests}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `${file}.txt` }) } }] };
      } });
    expect(result.error?.message).toContain('Three main response slots');
    expect(result.mainResponses).toBe(3);
    expect(requests).toBe(3);
    expect(result.visibleCompletionMs).toBeNull();
    expect(result.tools.map(tool => tool.content).join('\n')).toContain('real c');
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('preserves production recovery for a malformed ordinary bridge proposal within the remaining slots', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-bridge-recovery-test-'));
  let requests = 0;
  try {
    await writeFile(path.join(directory, 'config.mjs'), 'export const retries = 3;\n');
    const result = await runTaskCell({ workspace: directory, home: path.join(directory, 'home'), prompt: 'Read the local config.',
      respond: async request => {
        if (!(JSON.stringify(request.tools) ?? '').includes('todo_update')) return { content: '{"candidates":[]}' };
        requests++;
        return requests <= 2 ? { content: '', tool_calls: [{ id: `bridge-${requests}`, type: 'function', function: { name: 'tool_call',
          arguments: requests === 1 ? '{"name":"read","input":{"path":"config.mjs"}' : '{"name":"read","input":{"path":"config.mjs"}}' } }] } : { content: 'retries = 3' };
      } });
    expect(result.mainResponses).toBe(3);
    expect(result.tools.some(tool => tool.content.includes('retries = 3'))).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it.each(['spawn_agent', 'tool_call'])('stops the %s child-generation entrance before any child model request', async name => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-no-child-test-'));
  let requests = 0;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KODAX_TASK_CELL_KEY;
  try {
    const result = await runTaskCell({ workspace: directory, home: path.join(directory, 'home'), prompt: 'Check the local fixture.',
      respond: async () => { requests++; return { content: '', tool_calls: [{ id: 'child', type: 'function',
        function: { name, arguments: name === 'tool_call' ? '{"name":"spawn_agent","input":{"agent_id":"worker","message":"Read local files"}}' : '{"agent_id":"worker","message":"Read local files"}' } }] }; } });
    expect(result.error?.message).toContain('Child/workflow generation is outside');
    expect(requests).toBe(1);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(process.env.KODAX_TASK_CELL_KEY).toBe(originalKey);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('keeps an ordinary portable read bridge available and returns its real file feedback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-bridge-read-test-'));
  let requests = 0;
  try {
    await writeFile(path.join(directory, 'config.mjs'), 'export const retries = 3;\n');
    const result = await runTaskCell({ workspace: directory, home: path.join(directory, 'home'), prompt: 'Read the local config.',
      respond: async request => {
        if (!(JSON.stringify(request.tools) ?? '').includes('todo_update')) return { content: '{"candidates":[]}' };
        requests++;
        return requests === 1 ? { content: '', tool_calls: [{ id: 'bridge', type: 'function', function: { name: 'tool_call',
          arguments: '{"name":"read","input":{"path":"config.mjs"}}' } }] } : { content: 'retries = 3' };
      } });
    expect(result.tools.some(tool => tool.content.includes('retries = 3'))).toBe(true);
    expect(result.answer).toContain('retries = 3');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('sends the same original image bytes through the public Runtime image input', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-image-test-'));
  const diagnostics: unknown[] = [];
  const restore = setKodaXDiagnosticSink(value => { diagnostics.push(value); });
  try {
    const { A } = await createTaskFixtures(Buffer.from([2, 0, 1, 3]));
    await writeFile(path.join(directory, 'wiring.png'), A.files['wiring.png']!);
    let wire = '';
    const result = await runTaskCell({ workspace: directory, home: path.join(directory, 'home'), prompt: A.prompt, images: A.images,
      respond: async request => { if ((JSON.stringify(request.tools) ?? '').includes('todo_update')) wire = JSON.stringify(request); return { content: 'Need to follow the line.', tool_calls: [] }; } });
    expect(result.result.phase, JSON.stringify({ diagnostics, result: result.result })).toBe('completed');
    const images = [...wire.matchAll(/data:image\/(\w+);base64,([^"\\]+)/g)].map(match => ({ type: match[1], bytes: Buffer.from(match[2]!, 'base64').length }));
    expect(wire.includes(A.files['wiring.png']!.toString('base64')), JSON.stringify(images)).toBe(true);
    expect(result.mainResponses).toBe(1);
  } finally { restore(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('compacts real admitted historical image inputs before revealing the new question', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-history-test-'));
  try {
    const { B } = await createTaskFixtures(Buffer.from([2, 0, 1, 3]));
    for (const [file, bytes] of Object.entries(B.files)) await writeFile(path.join(directory, file), bytes);
    const wires: Record<string, unknown>[] = [];
    const result = await runTaskCell({ workspace: directory, home: path.join(directory, 'home'), prompt: B.prompt,
      history: B.history,
      respond: async request => {
        wires.push(request);
        return { content: (JSON.stringify(request.tools) ?? '').includes('todo_update') ? 'Need to compare the retained screenshots.' : '## Goal\nThe user supplied three console screenshots for a later investigation, captured before an upgrade, immediately after it, and during a separate later operation. Preserve the original image paths and their chronology.\n## Progress\nEight routine service health checks completed without reporting deleted jobs or a storage failure.\n## Next steps\nWait for the user to describe the problem, then consult the retained original evidence rather than guessing.', tool_calls: [] };
      } });
    expect(result.compaction?.compacted).toBe(true);
    expect(wires.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(wires[0])).not.toContain(B.prompt);
    expect(JSON.stringify(wires[0])).toContain('升级前面板');
    expect(JSON.stringify(wires.find(wire => (JSON.stringify(wire.tools) ?? '').includes('todo_update')))).toContain(B.prompt);
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
