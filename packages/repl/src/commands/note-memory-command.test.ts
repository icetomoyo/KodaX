import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { setAgentConfigHome } from '@kodax-ai/agent';
import { noteStoresFor, resolveNotePlace, type NotePlace } from '@kodax-ai/coding';

import { memoryCommand } from './memory-command.js';

let home: string;
let cwd: string;
let lines: string[];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'note-cmd-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'note-cmd-cwd-'));
  setAgentConfigHome(home);
  vi.stubEnv('KODAX_MEMORY_NOTES', '1');
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setAgentConfigHome(undefined);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const place = (): NotePlace => resolveNotePlace({ provider: 'anthropic', context: { executionCwd: cwd, gitRoot: cwd } });
const run = async (...args: string[]): Promise<string> => {
  lines = [];
  const callbacks = { createKodaXOptions: () => ({ provider: 'anthropic', context: { executionCwd: cwd, gitRoot: cwd } }) };
  await memoryCommand.handler(args, { messages: [], runtimeInfo: { executionCwd: cwd } } as never, callbacks as never, {} as never);
  return lines.join('\n');
};

async function seed(): Promise<void> {
  const stores = noteStoresFor(place());
  await stores.project.write({ id: 'build', type: 'project', description: 'Build with make dist', body: 'b' });
  await stores.project.write({ id: 'guess', type: 'project', description: 'Maybe uses pnpm', why: 'saw a lockfile', body: 'b', status: 'candidate', source: 'inferred' });
  await stores.user.write({ id: 'tone', type: 'user', description: 'Answer in Chinese', body: 'b' });
}

it('lists the active notes of both scopes and points at the unconfirmed ones', async () => {
  await seed();
  const out = await run();
  expect(out).toMatch(/project notes[\s\S]*Build with make dist[\s\S]*1 unconfirmed[\s\S]*user notes[\s\S]*Answer in Chinese/);
  expect(out).not.toContain('Maybe uses pnpm');
});

it('approves a candidate as a user-confirmed active note', async () => {
  await seed();
  expect(await run('candidates')).toContain('Maybe uses pnpm');
  expect(await run('approve', 'guess')).toContain('approved project:guess');
  expect((await noteStoresFor(place()).project.list()).find((note) => note.id === 'guess')).toMatchObject({ status: 'active', source: 'user' });
});

it('forgets one note and asks for a scope when both scopes share the id', async () => {
  await seed();
  await noteStoresFor(place()).user.write({ id: 'build', type: 'user', description: 'My build habit', body: 'b' });
  expect(await run('forget', 'build')).toContain('use project:build or user:build');
  expect(await run('forget', 'user:build')).toContain('forgot user:build');
  expect((await noteStoresFor(place()).user.list()).map((note) => note.id)).toEqual(['tone']);
});

it('shows one note in full', async () => {
  await seed();
  const out = await run('show', 'guess');
  expect(out).toContain('candidate');
  expect(out).toContain('why: saw a lockfile');
  expect(await run('show', 'missing')).toContain('no note named missing');
});
