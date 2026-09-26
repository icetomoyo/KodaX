import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/agent';
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { FileSessionStorage } from '@kodax-ai/repl';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

async function withHistory(
  messages: KodaXMessage[],
  check: (client: KodaXProductClient, sessionId: string) => Promise<void>,
): Promise<void> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-history-boundaries-'));
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Isolated history Host lock unavailable.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-history-boundaries-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    const storage = new FileSessionStorage({
      sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax'),
    });
    const data = (await storage.load(session.id))!;
    data.messages = messages;
    delete data.lineage;
    await storage.save(session.id, data);
    await check(client, session.id);
  } finally {
    await client.disconnect();
    await host.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function readBody(client: KodaXProductClient, sessionId: string, itemId: string): Promise<string> {
  let body = '';
  let offset = 0;
  for (let page = 0; page < 30; page += 1) {
    const chunk = await client.sessions.readHistoryEntry(sessionId, itemId, { offset });
    expect(chunk).not.toBeNull();
    expect(chunk).toMatchObject({ id: itemId, offset });
    body += chunk!.text;
    if (chunk!.nextOffset === undefined) {
      expect(body.length).toBe(chunk!.totalLength);
      return body;
    }
    expect(chunk!.nextOffset).toBeGreaterThan(offset);
    offset = chunk!.nextOffset;
  }
  throw new Error('History body did not finish within the test read budget.');
}

it.each([
  ['below 256 KiB', 'x'.repeat(256 * 1024 - 512)],
  ['at 256 KiB', 'x'.repeat(256 * 1024)],
  ['above 256 KiB', 'x'.repeat(300 * 1024)],
  // Seven-byte repetitions across at least two 256 KiB boundaries guarantee
  // that a multi-byte character spans a chunk, regardless of the JSON prefix.
  ['UTF-8 across three chunks', '中🙂'.repeat(90_000)],
])('reads oversized history and search references: %s', async (_label, text) => {
  const body = `BOUNDARY-NEEDLE ${text}`;
  await withHistory([{ role: 'assistant', outputId: 'large', content: body }], async (client, sessionId) => {
    const page = await client.sessions.readHistory(sessionId);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ text: body.slice(0, 8192), totalTextLength: body.length });
    expect(page.oversized).toHaveLength(1);
    expect(await readBody(client, sessionId, page.items[0]!.id)).toBe(body);
    expect(await readBody(client, sessionId, page.oversized[0]!.itemId)).toBe(body);
    const search = await client.sessions.searchHistory(sessionId, { query: 'BOUNDARY-NEEDLE' });
    expect(search.hits).toHaveLength(1);
    expect(await readBody(client, sessionId, search.hits[0]!.itemId)).toBe(body);
  });
});

it('retains tool blocks, results and inputs when an entry expands past the display window', async () => {
  const content = Array.from({ length: 80 }, (_, index) => [
    { type: 'tool_use' as const, id: `call-${index}`, name: 'bash', input: { command: `echo ${index}` } },
    { type: 'text' as const, text: `after-${index}` },
  ]).flat();
  const results = Array.from({ length: 80 }, (_, index) => ({
    type: 'tool_result' as const, tool_use_id: `call-${index}`, content: `result-${index}`,
    ...(index % 3 === 0 ? {} : { is_error: true }),
    ...(index % 3 === 2 ? { metadata: { cancelled: true } } : {}),
  }));
  await withHistory([
    { role: 'assistant', outputId: 'many-tools', content }, { role: 'user', content: results },
  ], async (client, sessionId) => {
    const latest = await client.sessions.readHistory(sessionId, { limit: 1 });
    expect(latest.items).toEqual([]);
    expect(latest.nextCursor).toBeDefined();
    const page = await client.sessions.readHistory(sessionId, { limit: 1, cursor: latest.nextCursor });
    expect(page.nextCursor).toBeUndefined();
    expect(page.revision).toBe(latest.revision);
    expect(page.items).toHaveLength(160);
    const tools = page.items.filter(item => item.type === 'tool');
    expect(tools.map(item => item.tool?.callId)).toEqual(Array.from({ length: 80 }, (_, index) => `call-${index}`));
    expect(page.items.filter(item => item.type === 'assistant').map(item => item.text))
      .toEqual(Array.from({ length: 80 }, (_, index) => `after-${index}`));
    for (const [index, item] of tools.entries()) {
      expect(item.tool?.status).toBe(['success', 'error', 'cancelled'][index % 3]);
      expect(await readBody(client, sessionId, item.id)).toBe(`result-${index}`);
      const input = await client.sessions.readHistoryEntry(sessionId, item.id, { part: 'input' });
      expect(input?.text).toBe(`{"command":"echo ${index}"}`);
    }
  });
});

it('keeps every ordered block of a single message through history page and item reads', async () => {
  const content = Array.from({ length: 80 }, (_, index) => [
    { type: 'thinking' as const, thinking: ` thought-${index}\n` },
    { type: 'text' as const, text: ` answer-${index}\n\n` },
  ]).flat();
  await withHistory([{ role: 'assistant', outputId: 'many-blocks', content }], async (client, sessionId) => {
    const page = await client.sessions.readHistory(sessionId, { limit: 1 });
    expect(page.nextCursor).toBeUndefined();
    expect(page.items).toHaveLength(160);
    expect(page.items.map(item => [item.type, item.text])).toEqual(Array.from({ length: 80 }, (_, index) => [
      ['thinking', ` thought-${index}\n`], ['assistant', ` answer-${index}\n\n`],
    ]).flat());
    for (const item of page.items) {
      expect(item).toMatchObject({ outputId: 'many-blocks', outputState: 'committed', textRevision: 0 });
      expect(await readBody(client, sessionId, item.id)).toBe(item.text);
    }
  });
});
