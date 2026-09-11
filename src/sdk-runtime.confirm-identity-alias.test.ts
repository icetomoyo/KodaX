import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { getSessionMessagesFromLineage } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';
import { KodaXBaseProvider, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime, type RuntimeRunInputDeliveredEventPayload } from './sdk-runtime.js';
import { parseRuntimeEvent } from './runtime-event.js';
import { createLegacyIdentityLineage, LEGACY_IDENTITY_TARGET_ID } from './fixtures/session-identity-repair.js';

it.each(['inline', 'worker'] as const)('rejects an identity confirmation without its persisted delivery receipt in %s', async (isolation) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-confirm-identity-'));
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir: path.join(root, 'sessions'), isolation });
  try {
    const session = await runtime.sessions.create({ title: 'receipt validation', projectPath: root });
    expect(runtime.sessions.confirmIdentityAlias).toBeTypeOf('function');
    await expect(runtime.sessions.confirmIdentityAlias({
      sessionId: session.id, sourceEntryId: 'entry-old', targetEntryId: 'entry-new',
      expectedSourceRevision: 'sha256:source', confirmationReference: 'host-confirmation-1',
      delivery: { runId: 'missing-run', inputId: 'missing-input', eventId: 'missing-event' },
    })).rejects.toMatchObject({ code: 'conflict' });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

it.each(['unique', 'conflicting duplicate'] as const)('handles %s delivery identity while preserving caches and replay across restart', async (receiptKind) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-confirm-delivery-'));
  const sessionsDir = path.join(root, 'sessions');
  const providerName = 'runtime-confirm-identity-provider';
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  class IdentityProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_CONFIRM_IDENTITY_TEST_KEY', model: 'identity-test', supportsThinking: false,
    };
    async stream(): Promise<KodaXStreamResult> {
      calls += 1;
      if (calls === 1) { firstStarted(); await gate; }
      return { textBlocks: [{ type: 'text', text: `answer ${calls}` }], toolBlocks: [], thinkingBlocks: [] };
    }
  }
  vi.stubEnv('KODAX_CONFIRM_IDENTITY_TEST_KEY', 'offline-test');
  const unregister = registerModelProvider(providerName, () => new IdentityProvider());
  let runtime = await createKodaXRuntime({ homeDir: root, sessionsDir, defaultProvider: providerName });
  try {
    const session = await runtime.sessions.create({ title: 'legacy identity confirmation', projectPath: root });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'initial query',
      mode: 'managed_task', options: { model: 'identity-test', lsp: false } });
    await started;
    await expect(runtime.sessions.confirmIdentityAlias({
      sessionId: session.id, sourceEntryId: 'entry-old', targetEntryId: 'entry-new',
      expectedSourceRevision: 'sha256:source', confirmationReference: 'host-confirmation-1',
      delivery: { runId: run.runId, inputId: 'pending', eventId: 'pending' },
    })).rejects.toMatchObject({ code: 'conflict' });
    const submitted = await runtime.runs.submitInput({ sessionId: session.id, afterRunId: run.runId,
      delivery: 'interrupt', input: { type: 'text', text: 'queued query' } });
    expect(submitted.accepted).toBe(true);
    releaseFirst();
    expect((await run.result).phase).toBe('completed');
    const events = await runtime.events.replay({ runId: run.runId, type: 'run.input.delivered' });
    const event = events[0];
    if (event === undefined) throw new Error('missing delivered event');
    const delivered = (event.payload as RuntimeRunInputDeliveredEventPayload).inputs[0];
    if (delivered?.entryId === undefined) throw new Error('missing delivered entry');
    const storage = new FileSessionStorage({ sessionsDir });
    const saved = await storage.load(session.id);
    const source = saved?.lineage?.entries.find((entry) => entry.id === delivered.entryId);
    if (saved?.lineage === undefined || source?.type !== 'message') throw new Error('missing saved delivery');
    const legacy = createLegacyIdentityLineage({ sourceEntryId: source.id, message: source.message });
    const copiedTail = legacy.entries.slice(3).map((entry, index) => index === 0
      ? { ...entry, parentId: source.parentId } : entry);
    const lineage = { ...saved.lineage, entries: [...saved.lineage.entries, ...copiedTail],
      activeEntryId: legacy.activeEntryId };
    await storage.save(session.id, { ...saved, lineage, messages: getSessionMessagesFromLineage(lineage) });
    const before = await runtime.sessions.conversation(session.id);
    if (before === null) throw new Error('missing legacy conversation');
    expect(before.entries.filter((entry) => entry.auditEntryIds.includes(source.id))).toHaveLength(0);
    const cached = await runtime.sessions.conversationPage({ sessionId: session.id, limit: 1 });
    expect(cached?.sourceRevision).toBe(before.sourceRevision);
    let input = { sessionId: session.id, sourceEntryId: source.id, targetEntryId: LEGACY_IDENTITY_TARGET_ID,
      expectedSourceRevision: before.sourceRevision, confirmationReference: 'host-confirmed:legacy-identity',
      delivery: { runId: run.runId, inputId: delivered.inputId, eventId: event.id } };
    if (receiptKind === 'conflicting duplicate') {
      const journalPath = path.join(root, '.kodax', 'runtime', 'runs', encodeURIComponent(run.runId), 'events.jsonl');
      const originalJournal = await readFile(journalPath, 'utf8');
      const conflictingEvent = { ...event, payload: { inputs: [delivered,
        { ...delivered, entryId: 'entry_competing_delivery' }] } };
      const changedJournal = originalJournal.split('\n').map((line) => line.trim() !== ''
        && (JSON.parse(line) as { id: string }).id === event.id ? JSON.stringify(conflictingEvent) : line).join('\n');
      try {
        await writeFile(journalPath, changedJournal);
        expect(parseRuntimeEvent(conflictingEvent)).toEqual({ ok: true, event: conflictingEvent });
        await expect(runtime.sessions.confirmIdentityAlias(input)).rejects.toMatchObject({ code: 'conflict' });
        expect((await runtime.sessions.conversation(session.id))?.entries).toEqual(before.entries);
        expect((await storage.load(session.id))?.extensionRecords).toEqual(saved.extensionRecords);
      } finally {
        await writeFile(journalPath, originalJournal);
      }
      return;
    }
    await expect(runtime.sessions.confirmIdentityAlias({ ...input, expectedSourceRevision: 'stale' }))
      .rejects.toMatchObject({ code: 'data_changed' });
    await expect(runtime.sessions.confirmIdentityAlias({ ...input, delivery: { ...input.delivery, inputId: 'other' } }))
      .rejects.toMatchObject({ code: 'conflict' });
    await runtime.close();
    runtime = await createKodaXRuntime({ homeDir: root, sessionsDir });
    const cold = await runtime.sessions.conversation(session.id);
    if (cold === null) throw new Error('missing cold conversation');
    input = { ...input, expectedSourceRevision: cold.sourceRevision };
    // Claiming the persisted Actor changes the exact source revision. The host
    // must recapture after that conflict rather than bypassing the storage CAS.
    await expect(runtime.sessions.confirmIdentityAlias(input)).rejects.toMatchObject({ code: 'data_changed' });
    const claimed = await runtime.sessions.conversation(session.id);
    if (claimed === null) throw new Error('missing claimed conversation');
    expect(claimed.sourceRevision).not.toBe(cold.sourceRevision);
    expect(claimed.entries).toEqual(cold.entries);
    input = { ...input, expectedSourceRevision: claimed.sourceRevision };
    const record = await runtime.sessions.confirmIdentityAlias(input);
    expect(record.data).toMatchObject({ sourceEntryId: source.id, targetEntryId: LEGACY_IDENTITY_TARGET_ID,
      deliveryWitness: { ...input.delivery, seq: event.seq, eventDigest: expect.any(String) } });
    expect(await runtime.sessions.confirmIdentityAlias(input)).toEqual(record);
    await expect(runtime.sessions.confirmIdentityAlias({ ...input, targetEntryId: source.parentId! }))
      .rejects.toMatchObject({ code: 'conflict' });
    const after = await runtime.sessions.conversation(session.id);
    if (after === null) throw new Error('missing repaired conversation');
    expect(after.sourceRevision).not.toBe(before.sourceRevision);
    const repairedIndex = after.entries.findIndex((entry) => entry.auditEntryIds.includes(source.id));
    expect(repairedIndex).toBeGreaterThanOrEqual(0);
    expect(after.entries[repairedIndex]?.boundaryId).toBe(LEGACY_IDENTITY_TARGET_ID);
    expect(after.entries).toHaveLength(before.entries.length);
    await runtime.close();
    runtime = await createKodaXRuntime({ homeDir: root, sessionsDir });
    expect(await runtime.sessions.confirmIdentityAlias(input)).toEqual(record);
    const restarted = await runtime.sessions.conversation(session.id);
    if (restarted === null) throw new Error('missing restarted conversation');
    expect(restarted).toMatchObject({ entries: after.entries, status: after.status, issues: after.issues });
    const page = await runtime.sessions.conversationPage({ sessionId: session.id, limit: 100 });
    expect(page?.entries.flatMap((item) => item.entry?.auditEntryIds ?? []).filter((id) => id === source.id)).toHaveLength(1);
    const chunk = await runtime.sessions.conversationEntryChunk({ sessionId: session.id,
      revision: restarted.revision, entryIndex: repairedIndex });
    if (chunk === null) throw new Error('missing repaired chunk');
    expect(JSON.parse(Buffer.from(chunk.data, 'base64').toString('utf8')))
      .toMatchObject({ auditEntryIds: expect.arrayContaining([source.id]) });
    expect(await runtime.events.replay({ runId: run.runId, type: 'run.input.delivered' })).toEqual(events);
  } finally {
    releaseFirst();
    await runtime.close();
    unregister();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
