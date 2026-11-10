import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applySessionCompaction, createSessionLineage, COMPACTION_SUMMARY_PREFIX, COMPACTED_HISTORY_RECOVERY_GUIDANCE } from '@kodax-ai/agent';
import { SideChats, sideBranch, sideCanDeliver, sideRequester, sideToolRuntime } from './side-chat.js';

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
