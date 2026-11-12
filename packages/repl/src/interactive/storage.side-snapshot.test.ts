import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendSessionLineageLabel, createSessionLineage } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';
import { FileSessionStorage, type SessionData } from './storage.js';

let root: string;
let storage: FileSessionStorage;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-side-snapshot-'));
  storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions') });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const source = (messages: KodaXMessage[]): SessionData => ({ title: 'parent', gitRoot: root, messages });
const toolUse = (id: string): KodaXMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: {} }] });
const toolResult = (id: string): KodaXMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });

async function snapshot(data: SessionData) {
  const boundary = await storage.saveSideSnapshot('parent', 'child', data);
  const child = await storage.load('child');
  return { boundary, child, messages: child?.messages ?? [] };
}

it('stops at the last point with no tool call in flight and ends with the side boundary marker', async () => {
  const messages: KodaXMessage[] = [{ role: 'user', content: 'ask' }, { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'again' }, toolUse('t1')];
  const lineage = createSessionLineage(messages);
  const { boundary, messages: seeded } = await snapshot({ ...source(messages), lineage });
  expect(boundary).toBe(lineage.entries[2]!.id);
  expect(JSON.stringify(seeded)).not.toContain('tool_use');
  expect(seeded.map(m => m.content).slice(0, 3)).toEqual(['ask', 'answer', 'again']);
  expect(seeded.at(-1)?._source).toBe('side-boundary');
});

it('keeps a completed tool exchange intact', async () => {
  const { messages: seeded } = await snapshot(source([{ role: 'user', content: 'ask' }, toolUse('t1'), toolResult('t1'),
    { role: 'assistant', content: 'done' }]));
  expect(JSON.stringify(seeded)).toContain('tool_use');
  expect(JSON.stringify(seeded)).toContain('tool_result');
});

it('refuses history with a duplicate active tool call or a tool result nobody asked for', async () => {
  await expect(storage.saveSideSnapshot('parent', 'dup', source([{ role: 'user', content: 'ask' }, toolUse('t1'), toolUse('t1')])))
    .rejects.toThrow('duplicate active tool call');
  await expect(storage.saveSideSnapshot('parent', 'orphan', source([{ role: 'user', content: 'ask' }, toolResult('ghost')])))
    .rejects.toThrow('unmatched tool result');
});

it('seeds only the boundary marker when the parent has no committed history', async () => {
  const { boundary, messages: seeded } = await snapshot(source([]));
  expect(boundary).toBeNull();
  expect(seeded).toHaveLength(1);
  expect(seeded[0]?._source).toBe('side-boundary');
});

it('drops thinking from inherited messages, replaces a thinking-only message and turns system into user', async () => {
  const { messages: seeded } = await snapshot(source([
    { role: 'user', content: 'ask' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 's' }, { type: 'text', text: 'visible' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'only', signature: 's' }] },
    { role: 'system', content: 'note' },
  ]));
  expect(JSON.stringify(seeded)).not.toContain('secret');
  expect(JSON.stringify(seeded)).not.toContain('"only"');
  expect(seeded[1]?.content).toEqual([{ type: 'text', text: 'visible' }]);
  expect(seeded[2]?.content).toBe('[Earlier reasoning omitted]');
  expect(seeded[3]).toMatchObject({ role: 'user', content: 'note' });
});

it('leaves the parent label out of the side history', async () => {
  const messages: KodaXMessage[] = [{ role: 'user', content: 'ask' }, { role: 'assistant', content: 'answer' }];
  const plain = createSessionLineage(messages);
  const lineage = appendSessionLineageLabel(plain, plain.entries[0]!.id, 'parent-only-label')!;
  expect(lineage.entries.some(entry => entry.type === 'label')).toBe(true);
  const { child } = await snapshot({ ...source(messages), lineage });
  expect(child?.lineage?.entries.some(entry => entry.type === 'label')).toBe(false);
  expect(JSON.stringify(child)).not.toContain('parent-only-label');
});
