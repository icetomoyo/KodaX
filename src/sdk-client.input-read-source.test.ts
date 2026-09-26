import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { restoreSessionViewItems } from './session-view.js';
import { FileSessionStorage } from '@kodax-ai/repl';
import type { KodaXMessage } from '@kodax-ai/agent';
import { createKodaXRuntime } from './sdk-runtime.js';
import { randomUUID } from 'node:crypto';
import { connectKodaXClient } from './sdk-client.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

async function withMessages(messages: KodaXMessage[], check: (client: Awaited<ReturnType<typeof connectKodaXClient>>, sessionId: string, storage: FileSessionStorage, runtime: Awaited<ReturnType<typeof createKodaXRuntime>>) => Promise<void>) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-contract-review-'));
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Isolated review lock unavailable');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-contract-review-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
    const data = (await storage.load(session.id))!;
    data.messages = messages;
    delete data.lineage;
    await storage.save(session.id, data);
    await check(client, session.id, storage, runtime);
  } finally {
    await client.disconnect();
    await host.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
}

it('keeps an observed long user input readable after append moves it outside the window', async () => {
  const original: KodaXMessage = { role: 'user', inputId: 'selected-input', content: 'original-' + 'x'.repeat(9_000) };
  await withMessages([original, { ...original, inputId: 'same-text-other-input' }], async (runtime, sessionId, storage) => {
    let selectedId = '';
    let visibleIds: string[] = [];
    const observation = await runtime.sessions.observe(sessionId, view => {
      visibleIds = view.items.map(item => item.id);
      selectedId ||= view.items.find(item => item.inputId === 'selected-input')?.id ?? '';
    });
    try {
      expect(selectedId).not.toBe('');
      expect(visibleIds).toContain(`${sessionId}:input:same-text-other-input`);
      expect(selectedId).not.toBe(`${sessionId}:input:same-text-other-input`);
      expect((await runtime.sessions.readItem(sessionId, selectedId))?.totalLength).toBe(9_009);
      const data = (await storage.load(sessionId))!;
      data.messages.push(...Array.from({ length: 85 }, (_, index): KodaXMessage[] => [
        { role: 'user', inputId: `new-${index}`, content: `new question ${index}` },
        { role: 'assistant', outputId: `answer-${index}`, content: `new answer ${index}` },
      ]).flat());
      delete data.lineage;
      await storage.save(sessionId, data);
      await runtime.sessions.appendNotice(sessionId, { content: 'refresh' });
      await expect.poll(() => visibleIds.includes(selectedId)).toBe(false);
      expect(await runtime.sessions.readItem(sessionId, selectedId)).toMatchObject({ totalLength: 9_009 });
    } finally { observation.close(); }
  });
});


it('normalizes persisted identified user IDs and never borrows the identity of same-text input', () => {
  const data = { title: '', gitRoot: '', messages: [
    { role: 'user' as const, inputId: 'one', content: 'same text' },
    { role: 'user' as const, inputId: 'two', content: 'same text' },
  ], uiHistory: [{ id: 'legacy-hash', type: 'user' as const, inputId: 'one', text: 'same text' }] };
  const first = restoreSessionViewItems('session', data, data.messages);
  const live = [{ id: 'legacy-live', type: 'user' as const, inputId: 'one', text: 'same text' }];
  expect(first.map(item => item.id)).toEqual(['session:input:one', 'session:input:two']);
  expect(restoreSessionViewItems('session', data, data.messages, live).map(item => item.id))
    .toEqual(first.map(item => item.id));
});

it('does not read an identified user from the abandoned branch after rewind', async () => {
  await withMessages([
    { role: 'user', inputId: 'retained', content: 'same text' },
    { role: 'assistant', outputId: 'answer', content: 'answer' },
    { role: 'user', inputId: 'abandoned', content: 'same text' },
  ], async (client, sessionId) => {
    const observation = await client.sessions.observe(sessionId, () => {});
    try {
      const lineage = (await client.sessions.readLineage(sessionId))!;
      const root = lineage.entries.find(entry => entry.type === 'message' && entry.parentId === null)!;
      const selectedId = `${sessionId}:input:abandoned`;
      expect((await client.sessions.readItem(sessionId, selectedId))?.text).toBe('same text');
      await client.sessions.rewindSession(sessionId, { selector: root.id, expectedHead: lineage.activeEntryId! });
      expect(await client.sessions.readItem(sessionId, selectedId)).toBeNull();
      expect((await client.sessions.readItem(sessionId, `${sessionId}:input:retained`))?.text).toBe('same text');
    } finally { observation.close(); }
  });
});

it('reads an off-window identified user from canonical conversation after real compaction', async () => {
  class SummaryProvider extends KodaXBaseProvider {
    readonly name = 'input-source-summary';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_INPUT_SUMMARY_KEY', model: 'fixture', supportsThinking: false };
    async stream(): Promise<KodaXStreamResult> {
      return { textBlocks: [{ type: 'text', text: 'A useful summary of earlier fixture messages, preserving the original user request and completed answers.' }],
        thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider('input-source-summary', () => new SummaryProvider());
  vi.stubEnv('KODAX_INPUT_SUMMARY_KEY', 'fixture');
  const original = 'Selected original ' + 'x'.repeat(9000);
  try {
    await withMessages([{ role: 'user', inputId: 'pre-compact', content: original },
      ...Array.from({ length: 85 }, (_, index): KodaXMessage[] => [
        { role: 'user', inputId: `later-${index}`, content: `Later question ${index}` },
        { role: 'assistant', outputId: `answer-${index}`, content: 'Detailed answer '.repeat(200) },
      ]).flat()], async (client, sessionId, storage, runtime) => {
      const selectedId = `${sessionId}:input:pre-compact`;
      expect((await client.sessions.readItem(sessionId, selectedId))?.text).toBe(original);
      const result = await runtime.sessions.compact({ sessionId, provider: 'input-source-summary', contextWindow: 60_000, triggerTokens: 1 });
      expect(result.compacted).toBe(true);
      expect((await storage.load(sessionId))!.messages.some(message => message.inputId === 'pre-compact')).toBe(false);
      expect((await client.sessions.readItem(sessionId, selectedId))?.text).toBe(original);
    });
  } finally { unregister(); vi.unstubAllEnvs(); }
}, 60_000);

it('never lends an identified user checkpoint to a same-text legacy user', () => {
  const messages: KodaXMessage[] = [{ role: 'user', inputId: 'one', content: 'same' }, { role: 'user', content: 'same' }];
  const items = restoreSessionViewItems('session', { title: '', gitRoot: '', messages,
    uiHistory: [{ id: 'session:input:one', type: 'user', inputId: 'one', text: 'same' }] }, messages);
  expect(items).toHaveLength(2);
  expect(items.filter(item => item.inputId === 'one')).toHaveLength(1);
  expect(new Set(items.map(item => item.id)).size).toBe(2);
});
