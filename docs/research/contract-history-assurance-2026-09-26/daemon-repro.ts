import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FileSessionStorage } from '@kodax-ai/repl';
import type { KodaXMessage } from '@kodax-ai/agent';
import { createKodaXRuntime } from './sdk-runtime.js';
import { randomUUID } from 'node:crypto';
import { connectKodaXClient } from './sdk-client.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

async function withMessages(messages: KodaXMessage[], check: (client: Awaited<ReturnType<typeof connectKodaXClient>>, sessionId: string, storage: FileSessionStorage) => Promise<void>) {
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
    await check(client, session.id, storage);
  } finally {
    await client.disconnect();
    await host.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
}

it('reads a 300 KiB oversized assistant through the public history page', async () => {
  await withMessages([{ role: 'assistant', outputId: 'large', content: 'NEEDLE' + 'x'.repeat(300 * 1024) }], async (runtime, sessionId) => {
    await expect(runtime.sessions.readHistory(sessionId)).resolves.toMatchObject({ oversized: expect.any(Array) });
  });
});

it('keeps an observed long user input readable after append moves it outside the window', async () => {
  const original: KodaXMessage = { role: 'user', inputId: 'selected-input', content: 'original-' + 'x'.repeat(9_000) };
  await withMessages([original], async (runtime, sessionId, storage) => {
    let selectedId = '';
    let visibleIds: string[] = [];
    const observation = await runtime.sessions.observe(sessionId, view => {
      visibleIds = view.items.map(item => item.id);
      selectedId ||= view.items.find(item => item.inputId === 'selected-input')?.id ?? '';
    });
    try {
      expect(selectedId).not.toBe('');
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

it('reads a 300 KiB search result through its public reference', async () => {
  await withMessages([{ role: 'assistant', outputId: 'large', content: 'NEEDLE' + 'x'.repeat(300 * 1024) }], async (runtime, sessionId) => {
    const result = await runtime.sessions.searchHistory(sessionId, { query: 'NEEDLE' });
    expect(result.hits).toHaveLength(1);
    await expect(runtime.sessions.readHistoryEntry(sessionId, result.hits[0]!.itemId)).resolves.toMatchObject({ totalLength: 6 + 300 * 1024 });
  });
});

it('does not silently drop content blocks from a single canonical history entry', async () => {
  const content: Exclude<KodaXMessage['content'], string> = Array.from({ length: 80 }, (_, index) => [
    { type: 'thinking' as const, thinking: `thought-${index}` },
    { type: 'text' as const, text: `answer-${index}` },
  ]).flat();
  await withMessages([{ role: 'assistant', outputId: 'many-blocks', content }], async (runtime, sessionId) => {
    const page = await runtime.sessions.readHistory(sessionId);
    expect(page.nextCursor).toBeUndefined();
    expect(page.items.length).toBe(160);
  });
});

it('control: preserves canonical text whitespace and typed thinking through history item reads', async () => {
  await withMessages([{ role: 'assistant', outputId: 'ordered', content: [
    { type: 'text', text: ' first\n\n' }, { type: 'thinking', thinking: 'reasoning-marker' },
    { type: 'text', text: ' final\n' },
  ] }], async (runtime, sessionId) => {
    const page = await runtime.sessions.readHistory(sessionId);
    expect(page.items.map(item => [item.type, item.text])).toEqual([
      ['assistant', ' first\n\n'], ['thinking', 'reasoning-marker'], ['assistant', ' final\n'],
    ]);
    for (const item of page.items) expect((await runtime.sessions.readHistoryEntry(sessionId, item.id))?.text).toBe(item.text);
    expect((await runtime.sessions.searchHistory(sessionId, { query: 'reasoning-marker' })).hits).toHaveLength(0);
  });
});

it('control: preserves explicit cancelled tool output, input and search reference', async () => {
  await withMessages([
    { role: 'assistant', outputId: 'tool', content: [{ type: 'tool_use', id: 'cancelled-call', name: 'bash', input: { command: 'echo UNIQUE-COMMAND' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cancelled-call', content: 'CANCELLED-EVIDENCE', is_error: true, metadata: { cancelled: true } }] },
  ], async (runtime, sessionId) => {
    const page = await runtime.sessions.readHistory(sessionId);
    const tool = page.items.find(item => item.tool?.callId === 'cancelled-call')!;
    expect(tool.tool?.status).toBe('cancelled');
    expect((await runtime.sessions.readHistoryEntry(sessionId, tool.id))?.text).toBe('CANCELLED-EVIDENCE');
    expect((await runtime.sessions.readHistoryEntry(sessionId, tool.id, { part: 'input' }))?.text).toBe('{"command":"echo UNIQUE-COMMAND"}');
    const result = await runtime.sessions.searchHistory(sessionId, { query: 'CANCELLED-EVIDENCE' });
    expect((await runtime.sessions.readHistoryEntry(sessionId, result.hits[0]!.itemId))?.text).toBe('CANCELLED-EVIDENCE');
  });
});
