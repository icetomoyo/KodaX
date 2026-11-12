import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createExtensionRuntime } from '@kodax-ai/coding';
import { applySessionCompaction, createSessionLineage, COMPACTION_SUMMARY_PREFIX, COMPACTED_HISTORY_RECOVERY_GUIDANCE } from '@kodax-ai/agent';
import { MAX_QUEUED_SIDE_LETTERS, MAX_SIDE_LETTER_CHARS, SideChats, sideBranch, sideCanDeliver, sideLetterRejection, sideRequester, sideToolRuntime } from './side-chat.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('retains a report across compaction and rejects a rewind beyond the snapshot', () => {
  const source = createSessionLineage([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'done' }]);
  const side = { id: 'child', parent: 'parent', boundary: source.activeEntryId, branch: sideBranch(source), letters: [] };
  const summary = 'First turn finished.';
  const compact = applySessionCompaction(source, [{ role: 'user',
    content: COMPACTION_SUMMARY_PREFIX + summary + COMPACTED_HISTORY_RECOVERY_GUIDANCE,
    _synthetic: true, _source: 'compaction-checkpoint' }], { summary });
  expect(sideCanDeliver(side, compact)).toBe(true);
  expect(sideCanDeliver(side, { ...compact, activeEntryId: source.entries[0]!.id })).toBe(false);
});

it('restores published bindings and keeps unpublished or foreign side ids inaccessible', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'side-bindings-'));
  directories.push(dir);
  const store = () => new SideChats(dir, (file, data) => writeFileSync(file, JSON.stringify(data)));
  const writer = store();
  const binding = sideRequester.run('alice', () => writer.allocate('parent', 'main', null));
  expect(writer.admits(binding.id)).toBe(false);
  writer.save({ ...binding, preparing: true });
  expect(store().admits(binding.id)).toBe(false);
  writer.save({ ...binding, letters: [{ id: '1', content: 'Only B', wake: false }] });
  const reader = store();
  expect(reader.admits(binding.id, 'other')).toBe(false);
  expect(reader.admits(binding.id, 'alice')).toBe(true);
  expect(reader.receipts(reader.forParent('parent'))[0]?.text).toContain('queued');
  reader.remove(binding);
  expect(store().admits(binding.id)).toBe(false);
});

it('rejects a caller-chosen recipient, forged call identity and malformed wake flag', async () => {
  const tool = sideToolRuntime(async () => { throw new Error('unexpected delivery'); });
  for (const input of [{ text: 'x', parent: 'other' }, { text: '   ' }, { text: 'x', wake: 'yes' }]) {
    await expect(tool.executeCapability('mcp', 'send_to_parent', input, { toolCallId: 'real' })).rejects.toThrow('Invalid');
  }
  await expect(tool.executeCapability('mcp', 'send_to_parent', { text: 'x' })).rejects.toThrow('Invalid');
});

it('marks a report that asked the parent to resume so both views can show why a Run started', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'side-wake-receipt-'));
  directories.push(dir);
  const store = new SideChats(dir, (file, data) => writeFileSync(file, JSON.stringify(data)));
  const binding = store.allocate('parent', 'main', null);
  store.save({ ...binding, letters: [{ id: 'note', content: 'Just FYI', wake: false }, { id: 'go', content: 'Check drive letters', wake: true }] });
  const [note, go] = store.receipts(store.forParent('parent'));
  expect(note?.text).toBe('From side chat (queued): Just FYI');
  expect(go?.text).toBe('From side chat (queued, resume requested): Check drive letters');
});

it('shows a parent only the side bindings that belong to the requesting principal', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'side-owner-view-'));
  directories.push(dir);
  const store = new SideChats(dir, (file, data) => writeFileSync(file, JSON.stringify(data)));
  const binding = sideRequester.run('alice', () => store.allocate('parent', 'main', null));
  store.save({ ...binding, letters: [{ id: '1', content: 'Private to alice', wake: false }] });
  expect(store.visibleTo('parent', 'alice')).toHaveLength(1);
  expect(store.visibleTo('parent', 'bob')).toHaveLength(0);
  expect(store.visibleTo('parent')).toHaveLength(1);
});

it('rejects a letter that is too long or arrives while too many are still undelivered', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'side-letter-limits-'));
  directories.push(dir);
  const store = new SideChats(dir, (file, data) => writeFileSync(file, JSON.stringify(data)));
  const binding = store.allocate('parent', 'main', null);
  expect(sideLetterRejection(binding, 'short')).toBeUndefined();
  expect(sideLetterRejection(binding, 'x'.repeat(MAX_SIDE_LETTER_CHARS + 1))).toMatch(/too long/);
  const letters = Array.from({ length: MAX_QUEUED_SIDE_LETTERS }, (_, n) => ({ id: String(n), content: 'n', wake: false }));
  expect(sideLetterRejection({ ...binding, letters }, 'one more')).toMatch(/undelivered/);
  const delivered = letters.map(letter => ({ ...letter, deliveredRunId: 'run' }));
  expect(sideLetterRejection({ ...binding, letters: delivered }, 'one more')).toBeUndefined();
});

it('refuses a binding file whose letters carry fields of the wrong type', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'side-letter-types-'));
  directories.push(dir);
  const writer = new SideChats(dir, (file, data) => writeFileSync(file, JSON.stringify(data)));
  const binding = writer.allocate('parent', 'main', null);
  for (const bad of [{ principalId: 7 }, { deliveredRunId: false }]) {
    writer.save({ ...binding, letters: [{ id: '1', content: 'x', wake: false, ...bad } as never] });
    expect(() => new SideChats(dir, writer['writeAtomic']).forParent('parent')).toThrow('Invalid side conversation binding');
  }
});

it('keeps the session policy runtime\'s hooks and events active around the side tools', async () => {
  const policy = createExtensionRuntime();
  policy.registerHook('tool:before', ({ name }) => name === 'read' ? 'Blocked by policy.' : undefined,
    { source: { kind: 'runtime', id: 'policy', label: 'policy' } });
  const hooked = sideToolRuntime(async () => ({}), policy) as unknown as Pick<typeof policy, 'runHook' | 'emit'>;
  expect(await hooked.runHook('tool:before', { name: 'read', input: {} })).toBe('Blocked by policy.');
  expect(await hooked.runHook('tool:before', { name: 'grep', input: {} })).toBeUndefined();
  await policy.dispose();
  // Without a policy runtime there is nothing to delegate to; the frame then carries no hooks.
  expect('runHook' in sideToolRuntime(async () => ({}))).toBe(false);
});
