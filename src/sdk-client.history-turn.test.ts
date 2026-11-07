import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { FileSessionStorage } from '@kodax-ai/repl';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it('resolves complete legacy turns through the daemon Product API and preserves hidden tool results', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-history-turn-'));
  let providerCalls = 0;
  class FixtureProvider extends KodaXBaseProvider {
    readonly name = 'history-turn-fixture';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { model: 'fixture', apiKeyEnv: 'KODAX_HISTORY_TURN_FIXTURE_KEY', supportsThinking: false };
    async stream(): Promise<KodaXStreamResult> {
      providerCalls += 1;
      return { textBlocks: [{ type: 'text', text: 'new saved answer' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  vi.stubEnv('KODAX_HISTORY_TURN_FIXTURE_KEY', 'offline-fixture');
  const unregister = registerModelProvider('history-turn-fixture', () => new FixtureProvider());
  const runtime = await createKodaXRuntime({ homeDir: root, sharedDaemonHost: true, defaultProvider: 'history-turn-fixture' });
  const paths = resolveRuntimeDaemonPaths(root);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Expected isolated Host lock.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-turn-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(root, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir: root, endpoint: endpoint.path });
  try {
    const session = await client.sessions.create({ projectPath: root });
    const storage = new FileSessionStorage({ sessionsDir: path.join(root, '.kodax/sessions'), configHome: path.join(root, '.kodax') });
    const data = (await storage.load(session.id))!;
    data.messages = [
      { role: 'user', content: 'same prompt' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'read', input: { path: 'fixture' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'saved result' }] },
      { role: 'user', content: 'same prompt' }, { role: 'assistant', content: 'last answer' },
    ];
    delete data.lineage;
    await storage.save(session.id, data);
    const target = await client.sessions.resolveHistoryTurn(session.id, { kind: 'previous' });
    expect(target).toMatchObject({ status: 'ready', turnIndex: 0, hasLaterTurn: true, excerpt: 'same prompt' });
    if (target.status !== 'ready') throw new Error('Expected complete first turn.');
    const fork = await client.sessions.forkSession(session.id, { historyBoundary: target.historyBoundary });
    const forked = (await storage.load(fork.id))!;
    expect(forked.messages).toHaveLength(3);
    expect(forked.messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'call', content: 'saved result' }]);
    expect(await client.sessions.resolveHistoryTurn(session.id, { kind: 'latest' }))
      .toMatchObject({ status: 'ready', turnIndex: 1, hasLaterTurn: false });
    expect(await client.sessions.resolveHistoryTurn(session.id, { kind: 'index', index: 99 }))
      .toMatchObject({ status: 'unavailable' });
    let view: import('@kodax-ai/coding/client-contract').ClientSessionView | undefined;
    const observation = await client.sessions.observe(session.id, next => { view = next; });
    try {
      const selected = view!.items.find(item => item.type === 'user')!;
      expect(selected.historyBoundary).toBeDefined();
      const fromView = await client.sessions.resolveHistoryTurn(session.id, {
        kind: 'item', source: 'view', itemId: selected.id, revision: selected.historyBoundary!.sourceRevision,
      });
      expect(fromView).toMatchObject({ status: 'ready', turnIndex: 0, historyBoundary: target.historyBoundary });
      const page = await client.sessions.readHistory(session.id);
      const selectedHistory = page.items.find(item => item.type === 'tool')!;
      const fromHistory = await client.sessions.resolveHistoryTurn(session.id, {
        kind: 'item', source: 'history', itemId: selectedHistory.id, revision: page.revision,
      });
      expect(fromHistory).toMatchObject({ status: 'ready', turnIndex: 0, historyBoundary: target.historyBoundary });
      const search = await client.sessions.searchHistory(session.id, { query: 'saved result' });
      expect(search.hits).toHaveLength(1);
      const resultPage = await client.sessions.readHistory(session.id, { around: { searchItemId: search.hits[0]!.itemId } });
      expect(resultPage.locatedBoundaryId).toBeUndefined();
      expect(resultPage.items.some(item => item.type === 'tool')).toBe(true);
      expect(await client.sessions.resolveHistoryTurn(session.id, {
        kind: 'item', source: 'history', itemId: search.hits[0]!.itemId, revision: search.revision,
      })).toMatchObject({ status: 'ready', turnIndex: 0 });
      await storage.mutateUiHistory(session.id, () => [{ type: 'info', text: 'new metadata' }]);
      expect(await client.sessions.resolveHistoryTurn(session.id, {
        kind: 'item', source: 'history', itemId: selectedHistory.id, revision: page.revision,
      })).toMatchObject({ status: 'stale' });
      const current = await client.sessions.resolveHistoryTurn(session.id, { kind: 'previous' });
      if (current.status !== 'ready') throw new Error('Expected refreshed first turn.');
      // A cold mutation may claim the Actor and invalidate the previously read
      // source. Never silently retry a mutation against a new target.
      await expect(client.sessions.rewindSession(session.id, {
        historyBoundary: current.historyBoundary, expectedHead: current.expectedHead,
      })).rejects.toMatchObject({ code: 'resync_required' });
      expect((await storage.load(session.id))!.messages).toHaveLength(5);
      const reconfirmed = await client.sessions.resolveHistoryTurn(session.id, { kind: 'previous' });
      if (reconfirmed.status !== 'ready') throw new Error('Expected same turn after cold admission.');
      expect(reconfirmed).toMatchObject({ turnIndex: current.turnIndex, excerpt: current.excerpt });
      await expect(client.sessions.rewindSession(session.id, {
        historyBoundary: reconfirmed.historyBoundary, expectedHead: reconfirmed.expectedHead,
      })).resolves.toMatchObject({ id: session.id });
      expect((await storage.load(session.id))!.messages).toHaveLength(3);
      const fresh = await client.sessions.create({ projectPath: root });
      await client.sessions.updateSettings(fresh.id, { permissionMode: 'full-access', agentMode: 'sa' });
      let freshView: import('@kodax-ai/coding/client-contract').ClientSessionView | undefined;
      const freshObservation = await client.sessions.observe(fresh.id, next => { freshView = next; });
      try {
      const accepted = await client.inputs.submit({ sessionId: fresh.id, inputId: 'newly-accepted', text: 'newly saved query' });
      expect((await client.runs.await(accepted.runId!)).phase).toBe('completed');
      await expect.poll(() => freshView?.items.find(item => item.type === 'user' && item.text === 'newly saved query')?.inputId).toBeTruthy();
      const newUser = freshView!.items.find(item => item.type === 'user' && item.text === 'newly saved query')!;
      expect(await client.sessions.resolveHistoryTurn(fresh.id, {
        kind: 'item', source: 'view', itemId: newUser.id, inputId: newUser.inputId,
      })).toMatchObject({ status: 'ready', excerpt: 'newly saved query' });
      expect(providerCalls, 'read-only history resolution must not invoke the Provider').toBe(1);
      } finally { freshObservation.close(); }
    } finally { observation.close(); }
  } finally {
    await client.disconnect();
    await host.close();
    await runtime.close();
    unregister();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
