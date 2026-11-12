import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNoteStore, resolveMemoryRoot, resolveNoteRoot, setAgentConfigHome, setKodaXDiagnosticSink } from '@kodax-ai/agent';

import { buildCapabilityContextSections } from '../prompts/capability-sections.js';
import type { KodaXOptions } from '../types.js';
import { getBuiltinRegisteredToolDefinition } from '../tools/registry.js';
import { activateMemoryTool, MEMORY_TOOL_NAME, toolMemory } from '../tools/memory.js';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  createNoteMemoryBinding,
  isNoteMemoryEnabled,
  renderNoteMemorySection,
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

describe('note memory switch', () => {
  it('is off unless KODAX_MEMORY_NOTES is exactly 1', () => {
    expect(isNoteMemoryEnabled({})).toBe(false);
    expect(isNoteMemoryEnabled({ KODAX_MEMORY_NOTES: '0' })).toBe(false);
    expect(isNoteMemoryEnabled({ KODAX_MEMORY_NOTES: '1' })).toBe(true);
  });
});

describe('renderNoteMemorySection', () => {
  it('says there are no notes yet and shows both directories', () => {
    const text = renderNoteMemorySection(cwd);
    expect(text).toContain('(no notes yet)');
    expect(text).toContain(resolveNoteRoot(cwd, 'project'));
    expect(text).toContain(resolveNoteRoot(cwd, 'user'));
  });

  it('includes the saved index and is byte-stable while notes are unchanged', async () => {
    const store = createNoteStore(resolveNoteRoot(cwd, 'project'), 'project');
    await store.write({ id: 'test-cmd', type: 'project', description: 'Run tests with npm test', body: 'b' });
    const first = renderNoteMemorySection(cwd);
    expect(first).toContain('Run tests with npm test');
    expect(renderNoteMemorySection(cwd)).toBe(first);
  });

  it('keeps candidate notes out of the prompt', async () => {
    const store = createNoteStore(resolveNoteRoot(cwd, 'project'), 'project');
    await store.write({
      id: 'guess', type: 'project', description: 'Inferred thing', why: 'seen once', body: 'b', status: 'candidate',
    });
    expect(renderNoteMemorySection(cwd)).not.toContain('Inferred thing');
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
    const memory = sections.find((s) => s.id === 'project-memory');
    expect(memory?.content).toContain('# Memory');
    expect(memory?.content).toContain('memory tool');
  });

  it('keeps the legacy memory sections when the switch is off', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '');
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
    expect(sections.find((s) => s.id === 'project-memory')?.content).toContain('Run make check-fast');
    expect(fs.existsSync(path.join(legacyDir(), 'feedback_tests.md'))).toBe(true);
  });

  it('does not touch the legacy directory while the switch is off', async () => {
    fs.writeFileSync(path.join(legacyDir(), 'a.md'), '---\ndescription: legacy\n---\n');
    vi.stubEnv('KODAX_MEMORY_NOTES', '');
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
    expect(sections.some((s) => s.id === 'project-memory')).toBe(true);
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
    const bind = createNoteMemoryBinding(cwd, () => userText);
    const stored = await bind({
      operation: 'write', id: 'pkg-manager', type: 'project', description: 'Use pnpm', userQuote: 'we use pnpm here',
    });
    expect(stored.ok).toBe(true);
    expect(renderNoteMemorySection(cwd)).toContain('Use pnpm');

    userText = 'something unrelated';
    const refused = await bind({ operation: 'delete', id: 'pkg-manager', userQuote: 'we use pnpm here' });
    expect(refused.ok).toBe(false);
    expect(renderNoteMemorySection(cwd)).toContain('Use pnpm');
  });

  it('stores an unquoted write as a candidate that stays out of the prompt', async () => {
    const bind = createNoteMemoryBinding(cwd, () => 'hi');
    const result = await bind({
      operation: 'write', id: 'maybe', type: 'project', description: 'Maybe true', why: 'saw it once', body: 'b',
    });
    expect(result.ok).toBe(true);
    expect(renderNoteMemorySection(cwd)).not.toContain('Maybe true');
  });
});
