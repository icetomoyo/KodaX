import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createNoteStore,
  readMemoryStats,
  resolveNoteRoot,
  setAgentConfigHome,
  type ReflectionJudge,
} from '@kodax-ai/agent';
import type { KodaXBaseProvider, KodaXMessage } from '@kodax-ai/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderJudge, finishNoteRun, scheduleNoteRunFinish, type NoteRunFinish } from './note-reflection-job.js';
import { REFLECT_TOOL_NAME } from './note-reflection.js';
import { resolveNotePlace } from './note-memory.js';
import type { KodaXOptions } from '../types.js';

let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'note-job-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'note-job-cwd-'));
  setAgentConfigHome(home);
});
afterEach(() => {
  setAgentConfigHome(undefined);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const CORRECTION = 'No, in this repo tests must be run with `make check-fast`, bare npm test skips the setup.';
const messages = (extra: KodaXMessage[] = []): KodaXMessage[] => [
  { role: 'user', content: 'Fix the pagination bug.' },
  { role: 'assistant', content: [{ type: 'text', text: 'Done, I ran npm test.' }] },
  { role: 'user', content: CORRECTION },
  ...extra,
];

function provider(toolBlocks: readonly { name: string; input: Record<string, unknown> }[]): KodaXBaseProvider {
  return {
    name: 'fake',
    isConfigured: () => true,
    stream: vi.fn().mockResolvedValue({ textBlocks: [], thinkingBlocks: [], toolBlocks: toolBlocks.map((block, index) => ({ type: 'tool_use', id: `t${index}`, ...block })) }),
  } as unknown as KodaXBaseProvider;
}

const finish = (overrides: Partial<NoteRunFinish> = {}): NoteRunFinish => ({
  place: resolveNotePlace({ provider: 'anthropic', context: { executionCwd: cwd, gitRoot: cwd } } as KodaXOptions),
  reflect: true,
  sessionId: 'sess-1',
  messages: messages(),
  earlierCalls: new Set(),
  provider: provider([]),
  ...overrides,
});

describe('createProviderJudge', () => {
  it('sends the reflection request with its own tool and turns the answer into operations', async () => {
    const fake = provider([
      { name: REFLECT_TOOL_NAME, input: { operation: 'write', id: 'tests', description: 'Run make check-fast', quote: CORRECTION } },
      { name: 'bash', input: { command: 'rm -rf /' } },
      { name: REFLECT_TOOL_NAME, input: { id: '' } },
    ]);
    const operations = await createProviderJudge(fake, 'model-x')({ evidence: { segments: [{ source: 'user', label: 'user', text: CORRECTION, isError: false }], userText: CORRECTION, omitted: 0 }, notes: [] });
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ operation: 'write', id: 'tests' });
    const [sent, tools, system, , options] = (fake.stream as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([REFLECT_TOOL_NAME]);
    expect(system).toContain('note');
    expect(JSON.stringify(sent)).toContain(CORRECTION);
    expect(options.modelOverride).toBe('model-x');
  });
});

describe('finishNoteRun', () => {
  it('writes the user\'s correction as an active note through the host guards, then lists it', async () => {
    const judge = createProviderJudge(provider([{ name: REFLECT_TOOL_NAME, input: { operation: 'write', id: 'tests', type: 'feedback', description: 'Run tests with make check-fast', body: 'Bare npm test skips the setup.', quote: CORRECTION } }]), undefined);
    await finishNoteRun(finish(), judge);
    const project = createNoteStore(resolveNoteRoot(cwd, 'project'), 'project');
    expect(await project.list()).toMatchObject([{ id: 'tests', status: 'active', source: 'user', session: 'sess-1' }]);
    expect(fs.readFileSync(path.join(project.root, 'MEMORY.md'), 'utf8')).toContain('make check-fast');
    expect(await readMemoryStats(resolveNoteRoot(cwd, 'user'))).toMatchObject({ reflections: 1, write: 1 });
  });

  it('lets local output in a second project confirm a user-scope candidate the first project proposed', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'note-job-cwd2-'));
    try {
      const placeOf = (dir: string) => resolveNotePlace({ provider: 'anthropic', context: { executionCwd: dir, gitRoot: dir } } as KodaXOptions);
      const ran: KodaXMessage[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'bash', input: { command: 'npx vitest run' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'npx: command not found; fnm node bin added to PATH, 12 tests passed' }] },
      ];
      const write = { operation: 'write' as const, id: 'fnm-path', scope: 'user' as const, type: 'user' as const, description: 'Put the fnm Node bin on PATH when npx is not found', why: 'npx was not found until the fnm bin was added' };
      const confirm = { operation: 'corroborate' as const, id: 'fnm-path', scope: 'user' as const, quote: 'fnm node bin added to PATH, 12 tests passed' };
      await finishNoteRun(finish({ messages: messages(ran) }), async () => [write]);
      await finishNoteRun(finish({ sessionId: 'sess-2', messages: messages(ran) }), async () => [confirm]);
      const user = createNoteStore(resolveNoteRoot(cwd, 'user'), 'user');
      expect(await user.list()).toMatchObject([{ id: 'fnm-path', status: 'candidate' }]);
      expect(await readMemoryStats(user.root)).toMatchObject({ reflections: 2, rejected: 1 });
      await finishNoteRun(finish({ place: placeOf(other), sessionId: 'sess-3', messages: messages(ran) }), async () => [confirm]);
      expect(await user.list()).toMatchObject([{ id: 'fnm-path', status: 'active', source: 'inferred' }]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('counts the notes the run opened, but not reads that were already in the session', async () => {
    const project = createNoteStore(resolveNoteRoot(cwd, 'project'), 'project');
    await project.write({ id: 'tests', type: 'feedback', description: 'Run make check-fast', body: 'x' });
    const file = path.join(project.root, 'tests.md');
    const read = (id: string): KodaXMessage[] => [
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: { path: file } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    ];
    await finishNoteRun(finish({ messages: [...read('old'), ...read('new')], earlierCalls: new Set(['old']) }), async () => []);
    expect((await project.list())[0]!.used).toBe(1);
    expect(await readMemoryStats(resolveNoteRoot(cwd, 'user'))).toMatchObject({ reads: 1 });
  });

  it('never reflects through a CLI bridge, which would run its own agent, but still counts reads', async () => {
    const project = createNoteStore(resolveNoteRoot(cwd, 'project'), 'project');
    await project.write({ id: 'tests', type: 'feedback', description: 'Run make check-fast', body: 'x' });
    const file = path.join(project.root, 'tests.md');
    const bridge = {
      ...provider([]),
      getCapabilityProfile: () => ({ transport: 'cli-bridge', toolCallingFidelity: 'limited' }),
    } as unknown as KodaXBaseProvider;
    const opened: KodaXMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'read', input: { path: file } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'ok' }] },
    ];
    await finishNoteRun(finish({ provider: bridge, messages: [...messages(), ...opened] }));
    expect(bridge.stream).not.toHaveBeenCalled();
    expect((await project.list())[0]!.used).toBe(1);
    expect(fs.existsSync(path.join(resolveNoteRoot(cwd, 'user'), '.reflection-budget.json'))).toBe(false);
  });

  it('makes no model call when the host owns learning', async () => {
    const fake = provider([]);
    await finishNoteRun(finish({ provider: fake, reflect: false }));
    expect(fake.stream).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(resolveNoteRoot(cwd, 'user'), '.reflection-budget.json'))).toBe(false);
  });

  it('does not call the model for a session with nothing to learn from', async () => {
    const fake = provider([]);
    await finishNoteRun(finish({ messages: [{ role: 'user', content: 'What is 2+2?' }], provider: fake }));
    expect(fake.stream).not.toHaveBeenCalled();
  });

  it('reflects a session whose pass failed when a later session of the project ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-26T08:00:00Z'));
      const failing: ReflectionJudge = async () => { throw new Error('provider down'); };
      await expect(finishNoteRun(finish(), failing)).rejects.toThrow('provider down');
      vi.setSystemTime(new Date('2026-11-26T09:00:00Z'));
      const judge = createProviderJudge(provider([{ name: REFLECT_TOOL_NAME, input: { operation: 'write', id: 'tests', type: 'feedback', description: 'Run tests with make check-fast', quote: CORRECTION } }]), undefined);
      await finishNoteRun(finish({ sessionId: 'sess-2', messages: [{ role: 'user', content: 'What is 2+2?' }] }), judge);
      const project = createNoteStore(resolveNoteRoot(cwd, 'project'), 'project');
      expect(await project.list()).toMatchObject([{ id: 'tests', status: 'active', session: 'sess-1' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('scheduleNoteRunFinish', () => {
  it('never rejects: a failing model call is reported and the session stays open for a retry', async () => {
    const failing = { name: 'fake', isConfigured: () => true, stream: vi.fn().mockRejectedValue(new Error('provider down')) } as unknown as KodaXBaseProvider;
    await expect(scheduleNoteRunFinish(finish({ provider: failing }))).resolves.toBeUndefined();
    const fake = provider([{ name: REFLECT_TOOL_NAME, input: { operation: 'write', id: 'tests', type: 'feedback', description: 'Run tests with make check-fast', body: 'x', quote: CORRECTION } }]);
    await scheduleNoteRunFinish(finish({ provider: fake }));
    expect(await createNoteStore(resolveNoteRoot(cwd, 'project'), 'project').list()).toHaveLength(1);
  });
});
