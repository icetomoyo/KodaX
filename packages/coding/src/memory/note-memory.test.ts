import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createNoteStore,
  resolveMemoryRoot,
  resolveNoteRoot,
  resolveScopedMemoryRoot,
  setAgentConfigHome,
  setKodaXDiagnosticSink,
  type MemoryContextIdentity,
} from '@kodax-ai/agent';

import { deriveCodingMemoryIdentity } from '../memory-runtime.js';
import { buildCapabilityContextSections } from '../prompts/capability-sections.js';
import type { KodaXOptions } from '../types.js';
import { getBuiltinRegisteredToolDefinition } from '../tools/registry.js';
import { activateMemoryTool, MEMORY_TOOL_NAME, toolMemory } from '../tools/memory.js';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  convertLegacyMemory,
  createNoteMemoryBinding,
  isNoteMemoryEnabled,
  noteFailureReminder,
  renderNoteMemorySection,
  resolveNotePlace,
  toolBatchFailed,
  type NotePlace,
} from './note-memory.js';

let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'note-mem-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'note-mem-cwd-'));
  setAgentConfigHome(home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  setAgentConfigHome(undefined);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const ctxWith = (memoryNotes: KodaXToolExecutionContext['memoryNotes']): KodaXToolExecutionContext =>
  ({ memoryNotes }) as KodaXToolExecutionContext;

const optionsWith = (context: KodaXOptions['context'] = {}): KodaXOptions =>
  ({ provider: 'anthropic', context: { executionCwd: cwd, gitRoot: cwd, ...context } }) as KodaXOptions;
const place = (): NotePlace => resolveNotePlace(optionsWith());

const tenant = (tenantId: string): MemoryContextIdentity =>
  ({ configHome: home, tenantId, userId: 'u1', agentId: 'space', projectId: 'p1', sessionId: 's' });

describe('resolveNotePlace', () => {
  it('follows the project remote layout when the host names no identity', () => {
    expect(place().roots).toEqual({ project: resolveNoteRoot(cwd, 'project'), user: resolveNoteRoot(cwd, 'user') });
  });

  it('gives each hosted tenant its own stores, so tenants never see each other\'s notes', () => {
    const a = resolveNotePlace(optionsWith({ memoryIdentity: tenant('tenant-a') }));
    const b = resolveNotePlace(optionsWith({ memoryIdentity: tenant('tenant-b') }));
    expect(a.roots.project).not.toBe(b.roots.project);
    expect(a.roots.user).not.toBe(b.roots.user);
    expect(a.roots.project.startsWith(path.join(home, 'memory-scopes'))).toBe(true);
    expect(a.legacy.map((source) => source.root)).not.toContain(resolveMemoryRoot(cwd));
  });

  it('gives a root run, its child agents and the /memory command one store, in the run\'s config home', () => {
    const runtimeHome = path.join(home, 'runtime-home');
    const child = optionsWith({ configHome: runtimeHome, parentAgentId: '/root' });
    // The runner derives an identity for a root run; that is not a host naming a tenant.
    const root = optionsWith({ configHome: runtimeHome, memoryIdentity: deriveCodingMemoryIdentity(child, cwd, 'session-1') });
    const expected = { project: resolveNoteRoot(cwd, 'project', runtimeHome), user: resolveNoteRoot(cwd, 'user', runtimeHome) };
    expect(resolveNotePlace(root).roots).toEqual(expected);
    expect(resolveNotePlace(child).roots).toEqual(expected);
    expect(resolveNotePlace(root).legacy.map((source) => source.root)).toContain(resolveMemoryRoot(cwd));
  });

  it('keeps project and user notes apart for a hosted identity with only an agent', () => {
    const roots = resolveNotePlace(optionsWith({ memoryIdentity: { tenantId: 't', agentId: 'a', sessionId: 's' } })).roots;
    expect(roots.project).not.toBe(roots.user);
  });
});

describe('convertLegacyMemory', () => {
  it('brings in memories the legacy control plane kept in its project and user scopes', async () => {
    const current = place();
    fs.mkdirSync(resolveScopedMemoryRoot(current.identity, 'project'), { recursive: true });
    fs.mkdirSync(resolveScopedMemoryRoot(current.identity, 'user'), { recursive: true });
    fs.writeFileSync(path.join(resolveScopedMemoryRoot(current.identity, 'project'), 'build.md'), '---\ndescription: Build with make dist\n---\n');
    fs.writeFileSync(path.join(resolveScopedMemoryRoot(current.identity, 'user'), 'tone.md'), '---\ndescription: Answer in Chinese\ntype: user\n---\n');
    await convertLegacyMemory(current);
    expect(renderNoteMemorySection(current)).toMatch(/## Project notes[\s\S]*Build with make dist[\s\S]*## User notes[\s\S]*Answer in Chinese/);
  });
});

describe('note memory switch', () => {
  it('is on unless KODAX_MEMORY_NOTES is exactly 0', () => {
    expect(isNoteMemoryEnabled({})).toBe(true);
    expect(isNoteMemoryEnabled({ KODAX_MEMORY_NOTES: '1' })).toBe(true);
    expect(isNoteMemoryEnabled({ KODAX_MEMORY_NOTES: '0' })).toBe(false);
  });
});

describe('renderNoteMemorySection', () => {
  it('says there are no notes yet and shows both directories', () => {
    const text = renderNoteMemorySection(place());
    expect(text).toContain('(no notes yet)');
    expect(text).toContain(resolveNoteRoot(cwd, 'project'));
    expect(text).toContain(resolveNoteRoot(cwd, 'user'));
  });

  it('includes the saved index and is byte-stable while notes are unchanged', async () => {
    const store = createNoteStore(resolveNoteRoot(cwd, 'project'), 'project');
    await store.write({ id: 'test-cmd', type: 'project', description: 'Run tests with npm test', body: 'b' });
    const first = renderNoteMemorySection(place());
    expect(first).toContain('Run tests with npm test');
    expect(renderNoteMemorySection(place())).toBe(first);
  });

  it('keeps candidate notes out of the prompt', async () => {
    const store = createNoteStore(resolveNoteRoot(cwd, 'project'), 'project');
    await store.write({
      id: 'guess', type: 'project', description: 'Inferred thing', why: 'seen once', body: 'b', status: 'candidate',
    });
    expect(renderNoteMemorySection(place())).not.toContain('Inferred thing');
  });
});

describe('toolBatchFailed', () => {
  const result = (content: string, isError?: boolean) => ({
    type: 'tool_result' as const, tool_use_id: 't', content, ...(isError === undefined ? {} : { is_error: isError }),
  });

  it('counts a tool error', () => {
    expect(toolBatchFailed([result('[Tool Error] read: File not found: a.ts', true)])).toBe(true);
  });

  it('counts a shell command that exited non-zero', () => {
    expect(toolBatchFailed([result('Command: npx vitest\nExit: 127\n\n[stderr]\nbash: npx: command not found')])).toBe(true);
    expect(toolBatchFailed([result('Command: tsc --noEmit\nExit: 2\nsrc/a.ts(1,1): error TS2322')])).toBe(true);
    expect(toolBatchFailed([result('Command: npm test\nExit: 1\nFAIL src/a.test.ts\n[stderr]\nnpm error Lifecycle script `test` failed')])).toBe(true);
  });

  it('reads the exit code of a multi-line command', () => {
    expect(toolBatchFailed([result("Command: cat <<'X' | node\nconsole.log(1)\nX\nExit: 127\n\n[stderr]\nnode: not found")])).toBe(true);
    expect(toolBatchFailed([result("Command: cat <<'X' | node\nconsole.log(1)\nX\nExit: 0\n1\n")])).toBe(false);
  });

  it('does not count exit 1 with nothing on stderr, the way grep says no match', () => {
    expect(toolBatchFailed([result('Command: grep -rn foo src\nExit: 1\n')])).toBe(false);
  });

  it('does not count a batch where everything succeeded', () => {
    expect(toolBatchFailed([result('Command: ls\nExit: 0\nsrc\n'), result('file text')])).toBe(false);
    expect(toolBatchFailed([])).toBe(false);
  });

  it('counts the batch when any one result failed', () => {
    expect(toolBatchFailed([result('file text'), result('Command: git pull\nExit: 128\n\n[stderr]\nfatal: unable to access')])).toBe(true);
  });
});

describe('noteFailureReminder', () => {
  it('stays silent while the index lists no note', async () => {
    expect(noteFailureReminder(place())).toBeUndefined();
    const store = createNoteStore(resolveNoteRoot(cwd, 'project'), 'project');
    await store.write({ id: 'guess', type: 'project', description: 'Inferred thing', why: 'seen once', body: 'b', status: 'candidate' });
    expect(noteFailureReminder(place())).toBeUndefined();
  });

  it('points at the index once a note is listed in either scope', async () => {
    const store = createNoteStore(resolveNoteRoot(cwd, 'user'), 'user');
    await store.write({ id: 'node-path', type: 'project', description: 'Node comes from fnm', body: 'b' });
    const reminder = noteFailureReminder(place());
    expect(reminder?.content).toContain('memory index');
    expect(reminder?.content).not.toContain('Node comes from fnm');
  });
});

describe('capability sections gate', () => {
  const options = (): KodaXOptions => ({
    provider: 'anthropic',
    context: { executionCwd: cwd, gitRoot: cwd, rawUserInput: 'hello' },
  } as KodaXOptions);

  it('emits the note section instead of the legacy memory sections when the switch is on', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    const sections = await buildCapabilityContextSections(options(), false, cwd);
    expect(sections.some((s) => s.id === 'memory-rules')).toBe(false);
    const memory = sections.find((s) => s.id === 'memory-notes');
    expect(memory?.content).toContain('# Memory');
    expect(memory?.content).toContain('memory tool');
  });

  it('keeps the legacy memory sections when the switch is off', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '0');
    const sections = await buildCapabilityContextSections(options(), false, cwd);
    expect(sections.some((s) => s.id === 'memory-rules')).toBe(true);
  });

  const legacyDir = (): string => {
    const dir = resolveMemoryRoot(cwd);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('brings the project\'s legacy memories into the note store the first time the switch is on', async () => {
    fs.writeFileSync(path.join(legacyDir(), 'feedback_tests.md'), '---\ndescription: Run make check-fast\ntype: feedback\n---\nbody\n');
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    const sections = await buildCapabilityContextSections(options(), false, cwd);
    expect(sections.find((s) => s.id === 'memory-notes')?.content).toContain('Run make check-fast');
    expect(fs.existsSync(path.join(legacyDir(), 'feedback_tests.md'))).toBe(true);
  });

  it('does not touch the legacy directory while the switch is off', async () => {
    fs.writeFileSync(path.join(legacyDir(), 'a.md'), '---\ndescription: legacy\n---\n');
    vi.stubEnv('KODAX_MEMORY_NOTES', '0');
    await buildCapabilityContextSections(options(), false, cwd);
    expect(fs.existsSync(resolveNoteRoot(cwd, 'project'))).toBe(false);
  });

  it('still builds the prompt and reports a diagnostic when the conversion fails', async () => {
    fs.writeFileSync(path.join(legacyDir(), 'a.md'), '---\ndescription: legacy\n---\n');
    fs.mkdirSync(path.join(legacyDir(), '.governance'));
    fs.writeFileSync(path.join(legacyDir(), '.governance', 'lifecycle.json'), '{}');
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    const seen: string[] = [];
    const stop = setKodaXDiagnosticSink((diagnostic) => seen.push(diagnostic.message));
    const sections = await buildCapabilityContextSections(options(), false, cwd);
    stop();
    expect(sections.some((s) => s.id === 'memory-notes')).toBe(true);
    expect(seen.join('\n')).toContain('legacy memories');
  });
});

describe('memory tool', () => {
  it('is a registered builtin that mutates state and is refused in plan mode', () => {
    const definition = getBuiltinRegisteredToolDefinition(MEMORY_TOOL_NAME);
    expect(definition).toMatchObject({ name: 'memory', sideEffect: 'mutates-state', planModeAllowed: false });
  });

  it('activation adds and removes exactly the memory tool', () => {
    expect(activateMemoryTool(['read'], true)).toEqual(['read', 'memory']);
    expect(activateMemoryTool(['read', 'memory'], false)).toEqual(['read']);
  });

  it('rejects calls without an operation, id or host binding', async () => {
    const bound = ctxWith(async () => ({ ok: true, message: 'x' }));
    expect(await toolMemory({ id: 'a' }, bound)).toContain('operation');
    expect(await toolMemory({ operation: 'write' }, bound)).toContain('id');
    expect(await toolMemory({ operation: 'write', id: 'a' }, ctxWith(undefined))).toContain('not available');
  });

  it('forwards typed fields and drops invalid enum values', async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith(async (input) => { seen.push(input); return { ok: true, message: 'saved' }; });
    const out = await toolMemory({ operation: 'write', id: 'a', scope: 'galaxy', type: 'feedback', description: 'd', body: 5 }, ctx);
    expect(out).toBe('saved');
    expect(seen[0]).toMatchObject({ operation: 'write', id: 'a', scope: undefined, type: 'feedback', description: 'd', body: undefined });
  });

  it('marks failures so the model sees a rejection', async () => {
    const ctx = ctxWith(async () => ({ ok: false, message: 'nope' }));
    expect(await toolMemory({ operation: 'delete', id: 'a' }, ctx)).toBe('[Memory rejected: nope]');
  });
});

describe('createNoteMemoryBinding', () => {
  it('lets a quote from the current user message create an active note and reads the message lazily', async () => {
    let userText = 'please remember that we use pnpm here';
    const bind = createNoteMemoryBinding(place(), () => userText);
    const stored = await bind({
      operation: 'write', id: 'pkg-manager', type: 'project', description: 'Use pnpm', userQuote: 'we use pnpm here',
    });
    expect(stored.ok).toBe(true);
    expect(renderNoteMemorySection(place())).toContain('Use pnpm');

    userText = 'something unrelated';
    const refused = await bind({ operation: 'delete', id: 'pkg-manager', userQuote: 'we use pnpm here' });
    expect(refused.ok).toBe(false);
    expect(renderNoteMemorySection(place())).toContain('Use pnpm');
  });

  it('stores an unquoted write as a candidate that stays out of the prompt', async () => {
    const bind = createNoteMemoryBinding(place(), () => 'hi');
    const result = await bind({
      operation: 'write', id: 'maybe', type: 'project', description: 'Maybe true', why: 'saw it once', body: 'b',
    });
    expect(result.ok).toBe(true);
    expect(renderNoteMemorySection(place())).not.toContain('Maybe true');
  });
});
