import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { getSessionLineagePath, getSessionMessageEntryId, persistCompactedSessionHistory } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';
import {
  KodaXBaseProvider, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { createKodaXRuntime, type RuntimeRunInputDeliveredEventPayload } from './sdk-runtime.js';

it.each(['load', 'read', 'peek'] as const)('keeps explicit source identity through storage.%s and a rewritten save', async (method) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-identity-read-'));
  try {
    const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions') });
    const message: KodaXMessage = { role: 'user', content: 'same query', timestamp: '2026-09-11T02:24:03.231Z' };
    await storage.save('read-identity', { title: 'read identity', gitRoot: root, messages: [message] });
    const originalId = getSessionMessageEntryId(message);
    const read = await storage[method]('read-identity');
    if (read === null) throw new Error('missing source session');
    await storage.save('read-identity', { ...read, lineage: undefined, messages: [
      { role: 'user', content: 'new context', _synthetic: true }, ...read.messages,
      { role: 'user', content: 'same query', timestamp: message.timestamp },
    ] });
    const rewritten = await storage.load('read-identity');
    if (rewritten?.lineage === undefined) throw new Error('missing rewritten lineage');
    const active = getSessionLineagePath(rewritten.lineage);
    expect(active.at(-2)?.logicalId).toBe(originalId);
    expect(active.at(-2)?.sourceEntryId).toBe(originalId);
    expect(active.at(-1)?.logicalId).not.toBe(originalId);
    expect(active.at(-1)?.sourceEntryId).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});

it('keeps real Runtime interrupt delivery resolvable through context saves, compaction, restart and pages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-interrupt-identity-'));
  const sessionsDir = path.join(root, 'sessions');
  const providerName = 'runtime-interrupt-identity-provider';
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstRequest = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let call = 0;
  class IdentityProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_IDENTITY_TEST_KEY', model: 'identity-test', supportsThinking: false,
    };
    async stream(): Promise<KodaXStreamResult> {
      call += 1;
      if (call === 1) { firstStarted(); await firstGate; }
      return { textBlocks: [{ type: 'text', text: `answer ${call}` }], toolBlocks: [], thinkingBlocks: [] };
    }
  }
  vi.stubEnv('KODAX_IDENTITY_TEST_KEY', 'offline-test');
  const unregister = registerModelProvider(providerName, () => new IdentityProvider());
  let runtime = await createKodaXRuntime({ homeDir: root, sessionsDir, defaultProvider: providerName });
  try {
    const session = await runtime.sessions.create({ title: 'identity lifecycle', projectPath: root });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'initial query',
      mode: 'managed_task', options: { model: 'identity-test', lsp: false } });
    await firstRequest;
    const input = await runtime.runs.submitInput({ sessionId: session.id, afterRunId: run.runId,
      delivery: 'interrupt', input: { type: 'text', text: 'queued query' } });
    expect(input.accepted).toBe(true);
    releaseFirst();
    const result = await run.result;
    expect(result.phase).toBe('completed');
    const events = await runtime.events.replay({ runId: run.runId, type: 'run.input.delivered' });
    const deliveredEntryId = (events[0]?.payload as RuntimeRunInputDeliveredEventPayload).inputs[0]?.entryId;
    expect(deliveredEntryId).toMatch(/^entry_/);
    const storage = new FileSessionStorage({ sessionsDir });
    const saved = await storage.load(session.id);
    if (saved === null) throw new Error('missing saved session');
    // Managed boundary saves strip this context; compaction saves may carry it.
    // Reinsert it through the real writer, retaining the source message objects.
    const withContext: KodaXMessage[] = [{ role: 'user', content: 'runtime context', _synthetic: true,
      _source: 'managed-run-context' }, ...saved.messages];
    await storage.save(session.id, { ...saved, lineage: undefined, messages: withContext });
    const afterSave = await runtime.sessions.conversation(session.id);
    expect(afterSave?.entries.filter((entry) => entry.auditEntryIds.includes(deliveredEntryId!))).toHaveLength(1);
    const reloaded = await storage.load(session.id);
    if (reloaded === null) throw new Error('missing rewritten session');
    expect(reloaded.messages.slice(-2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'queued query' }),
    ]));
    const compactedLineage = await persistCompactedSessionHistory({ storage, sessionId: session.id,
      compactedMessages: reloaded.messages.slice(-2), update: {
        preCompactionMessages: reloaded.messages,
        anchor: { summary: 'earlier context', tokensBefore: 10, tokensAfter: 2, entriesRemoved: 3,
          reason: 'identity_regression' },
      } });
    expect(getSessionLineagePath(compactedLineage).filter((entry) => entry.type === 'message' && entry.message.content === 'queued query')
      .map((entry) => ({ id: entry.id, logicalId: entry.logicalId, sourceEntryId: entry.sourceEntryId })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ logicalId: deliveredEntryId })]));
    const compacted = await runtime.sessions.conversation(session.id);
    expect(compacted?.entries.map((entry) => ({ boundaryId: entry.boundaryId, aliases: entry.auditEntryIds })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ aliases: expect.arrayContaining([deliveredEntryId]) })]));
    await runtime.close();
    runtime = await createKodaXRuntime({ homeDir: root, sessionsDir, defaultProvider: providerName });
    const conversation = await runtime.sessions.conversation(session.id);
    if (conversation === null) throw new Error('missing restarted conversation');
    expect(conversation.entries.filter((entry) => entry.auditEntryIds.includes(deliveredEntryId!))).toHaveLength(1);
    const replayed = await runtime.events.replay({ runId: run.runId, type: 'run.input.delivered' });
    expect((replayed[0]?.payload as RuntimeRunInputDeliveredEventPayload).inputs[0]?.entryId).toBe(deliveredEntryId);
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({ interruptInputs: [
      expect.objectContaining({ state: 'delivered', entryId: deliveredEntryId }),
    ] });
    let cursor: string | undefined;
    const pagedIds: string[] = [];
    const pagedBoundaries: Array<string | undefined> = [];
    do {
      const page = await runtime.sessions.conversationPage({ sessionId: session.id, limit: 1, cursor });
      if (page === null) throw new Error('missing page');
      expect(page.revision).toBe(conversation.revision);
      expect(page.sourceRevision).toBe(conversation.sourceRevision);
      for (const item of page.entries) {
        if (item.entry === undefined) continue;
        pagedIds.push(...item.entry.auditEntryIds);
        pagedBoundaries.unshift(item.entry.boundaryId);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(pagedIds.filter((id) => id === deliveredEntryId)).toHaveLength(1);
    expect(pagedBoundaries).toEqual(conversation.entries.map((entry) => entry.boundaryId));
  } finally {
    releaseFirst();
    await runtime.close();
    unregister();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
