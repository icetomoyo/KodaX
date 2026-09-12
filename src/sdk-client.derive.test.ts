import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { withKodaXFileLock } from '@kodax-ai/agent';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import { SessionViewOwner } from './session-view.js';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class DeriveProvider extends KodaXBaseProvider {
  readonly name = 'product-derive-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_DERIVE_TEST_KEY', model: 'product-derive-test', supportsThinking: false,
  };
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    requests.push(structuredClone(messages));
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    return { textBlocks: [{ type: 'text', text: `REPLY ${userText.slice(-1)}` }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

let requests: KodaXMessage[][] = [];
// Judge frames (learning review) are single-user JSON prompts; only rounds
// carrying the warm-up text are conversational.
function conversationalRequests(): number {
  return requests.filter((messages) =>
    messages.some((message) => typeof message.content === 'string' && message.content.startsWith('Ask round')),
  ).length;
}
// The recovered session has no warm-up text; its continuation rounds are
// recognized by their own prompt prefix.
function continuationRequests(): number {
  return requests.filter((messages) =>
    messages.some((message) => typeof message.content === 'string' && message.content.startsWith('Continue from')),
  ).length;
}
let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-derive-'));
  requests = [];
  registerModelProvider('product-derive-test', () => new DeriveProvider());
  vi.stubEnv('KODAX_PRODUCT_DERIVE_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-derive-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated derive Host.');
  const endpointPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\kodax-derive-' + randomUUID()
    : path.join(homeDir, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  second = await connectKodaXClient({ homeDir, endpoint: endpointPath });
});

afterEach(async () => {
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

async function runRound(sessionId: string, index: number): Promise<void> {
  const accepted = await first.inputs.submit({ sessionId, inputId: `round-${index}`, text: `Ask round ${index}` });
  await runtime.runs.await(accepted.runId!);
}

it('forks an idle session at an explicit boundary with settings and source intact', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  await runRound(session.id, 1);
  await runRound(session.id, 2);

  const sourceLineage = await first.sessions.readLineage(session.id);
  const sourceSettings = await first.sessions.getSettings(session.id);

  const forked = await first.sessions.forkSession(session.id);
  expect(forked.id).not.toBe(session.id);
  expect(forked.gitRoot).toBe(session.gitRoot);
  // The other client reads the fork with the same effective settings and the
  // full source history; the source itself stays untouched. Domain forks
  // re-key entry ids and drop non-forkable metadata (learning digests), so
  // the conversation structure is compared; the derivation notice records
  // provenance as the newest entry.
  const forkedLineage = await second.sessions.readLineage(forked.id);
  const messageCount = (lineage: { readonly entries: readonly { readonly type: string }[] }): number =>
    lineage.entries.filter((entry) => entry.type === 'message').length;
  expect(messageCount(forkedLineage!)).toBe(messageCount(sourceLineage!));
  expect(forkedLineage!.entries.at(-1)!.type).toBe('client_notice');
  expect(await second.sessions.getSettings(forked.id)).toEqual(sourceSettings);
  expect(await first.sessions.readLineage(session.id)).toEqual(sourceLineage);
  // Provenance is recorded on the fork itself.
  const views: Parameters<Parameters<typeof second.sessions.observe>[1]>[0][] = [];
  const observation = await second.sessions.observe(forked.id, (view) => views.push(view));
  try {
    expect(views[0]!.items.some((item) => item.type === 'info' && item.text.includes(`Forked from session ${session.id}`)))
      .toBe(true);
  } finally { observation.close(); }
  // Deriving never talked to the Provider.
  expect(conversationalRequests()).toBe(2);

  // An unresolvable selector is an explicit conflict, never a silent
  // full-history copy.
  await expect(first.sessions.forkSession(session.id, { selector: 'missing-entry' }))
    .rejects.toMatchObject({ code: 'conflict' });

  // An active source refuses to fork with an explicit conflict.
  const active = await first.inputs.submit({ sessionId: session.id, inputId: 'active-round', text: 'Ask round 3' });
  try {
    await expect(first.sessions.forkSession(session.id))
      .rejects.toMatchObject({ code: 'conflict' });
  } finally {
    await runtime.runs.await(active.runId!);
  }

  // A stale history boundary is an explicit resync, never a silent fork.
  const page = await first.sessions.readHistory(session.id);
  const boundaryEntry = page.items.find((item) => item.type === 'user');
  expect(boundaryEntry).toBeDefined();
  await runRound(session.id, 4);
  await expect(first.sessions.forkSession(session.id, {
    historyBoundary: { entryId: boundaryEntry!.id, sourceRevision: page.revision },
  })).rejects.toMatchObject({ code: 'resync_required' });
}, 90_000);

it('recovers into a new session via a deterministic seed and continues with one input', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  await runRound(session.id, 1);
  await runRound(session.id, 2);

  const sourceLineage = await first.sessions.readLineage(session.id);
  const sourceSettings = await first.sessions.getSettings(session.id);

  const recovered = await first.sessions.recoverSession(session.id, { reason: 'provider session recovery' });
  expect(recovered.id).not.toBe(session.id);
  expect(recovered.title.startsWith('Recovered from ')).toBe(true);
  expect(recovered.gitRoot).toBe(session.gitRoot);
  // The workspace and effective settings carry over, and the source stays
  // unchanged; raw tool/provider history is not replayed as conversation.
  const history = await second.sessions.readHistory(recovered.id);
  expect(history.items.some((item) => item.type === 'user')).toBe(false);
  expect(await second.sessions.getSettings(recovered.id)).toEqual(sourceSettings);
  expect(await first.sessions.readLineage(session.id)).toEqual(sourceLineage);
  // The deterministic seed costs no Provider call.
  expect(conversationalRequests()).toBe(2);

  // Provenance is recorded on the recovered session too.
  const recoveredLineage = await second.sessions.readLineage(recovered.id);
  expect(recoveredLineage!.entries.at(-1)!.type).toBe('client_notice');

  // An empty session has nothing to recover from.
  const empty = await first.sessions.create({ projectPath: homeDir });
  await expect(first.sessions.recoverSession(empty.id))
    .rejects.toMatchObject({ code: 'conflict' });

  // Continuation is one normal input whose request carries the deterministic
  // seed as the leading system memory; a retry with the same inputId never
  // duplicates it.
  const acceptance = await second.inputs.submit({
    sessionId: recovered.id, inputId: 'recover-continue', text: 'Continue from the recovered memory.',
  });
  await runtime.runs.await(acceptance.runId!);
  expect(continuationRequests()).toBe(1);
  const continued = [...requests].reverse().find((messages) =>
    messages.some((message) => typeof message.content === 'string' && message.content.startsWith('Continue from')));
  expect(continued).toBeDefined();
  const seedMessage = continued!.find((message) => typeof message.content === 'string' && message.content.includes('Recovered session memory'));
  expect(seedMessage?.role).toBe('system');
  expect(seedMessage!.content).toContain(`Source session: ${session.id}`);
  const retry = await second.inputs.submit({
    sessionId: recovered.id, inputId: 'recover-continue', text: 'Continue from the recovered memory.',
  });
  expect(retry).toEqual(acceptance);
  expect(continuationRequests()).toBe(1);

  // Recovery shares the idle gate: an active source refuses explicitly.
  const activeSource = await first.inputs.submit({ sessionId: session.id, inputId: 'active-recover', text: 'Ask round 3' });
  try {
    await expect(first.sessions.recoverSession(session.id))
      .rejects.toMatchObject({ code: 'conflict' });
  } finally {
    await runtime.runs.await(activeSource.runId!);
  }
}, 90_000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function sessionWriteLock(sessionId: string): string {
  const key = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  return path.join(homeDir, '.kodax', 'sessions', '.write-locks', `${key}.lock`);
}

const idleSourceReads = {
  session: (sessionId: string) => first.sessions.read(sessionId),
  settings: (sessionId: string) => first.sessions.getSettings(sessionId),
  stats: (sessionId: string) => first.sessions.getAutoModeStats(sessionId),
  lineage: (sessionId: string) => first.sessions.readLineage(sessionId),
  fork: (sessionId: string) => first.sessions.forkSession(sessionId),
  recover: (sessionId: string) => first.sessions.recoverSession(sessionId),
};

it.each(Object.entries(idleSourceReads))(
  '%s waits for its Host display checkpoint before reading the idle source',
  async (_name, readSource) => {
    const session = await first.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
    const held = deferred<void>();
    const release = deferred<void>();
    const flushed = deferred<'flush'>();
    const mutate = FileSessionStorage.prototype.mutateUiHistory;
    const writer = vi.spyOn(FileSessionStorage.prototype, 'mutateUiHistory')
      .mockImplementation(async function (this: FileSessionStorage, id, mutation) {
        // Hold the real Session write lock inside the Host checkpoint promise.
        // No fake read result or delay controls the reader's outcome.
        await withKodaXFileLock(sessionWriteLock(id), async () => {
          held.resolve();
          await release.promise;
        });
        return mutate.call(this, id, mutation);
      });
    let restoreFlush: (() => void) | undefined;
    let reading: Promise<unknown> | undefined;
    try {
      await runRound(session.id, 1);
      await held.promise;
      const flush = SessionViewOwner.prototype.flush;
      const flushSpy = vi.spyOn(SessionViewOwner.prototype, 'flush')
        .mockImplementation(function (this: SessionViewOwner, id) {
          if (id === session.id) flushed.resolve('flush');
          return flush.call(this, id);
        });
      restoreFlush = () => flushSpy.mockRestore();
      reading = readSource(session.id);
      const firstOutcome = await Promise.race([
        flushed.promise,
        reading.then(() => 'read' as const, () => 'failed' as const),
      ]);
      expect(firstOutcome).toBe('flush');
      release.resolve();
      expect(await reading).not.toBeNull();
    } finally {
      release.resolve();
      if (reading) await Promise.allSettled([reading]);
      restoreFlush?.();
      writer.mockRestore();
    }
  },
);

it('rejects an external writer instead of returning a partial lineage snapshot', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await withKodaXFileLock(sessionWriteLock(session.id), async () => {
    await expect(first.sessions.readLineage(session.id)).rejects.toMatchObject({ code: 'data_changed' });
  });
  await expect(first.sessions.readLineage(session.id)).resolves.toBeDefined();
});

it.each(Object.entries(idleSourceReads))(
  '%s propagates a failed Host checkpoint instead of reading an older source',
  async (_name, readSource) => {
    const session = await first.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
    const held = deferred<void>();
    const release = deferred<void>();
    const flushed = deferred<void>();
    let restoreFlush: (() => void) | undefined;
    let reading: Promise<unknown> | undefined;
    const writer = vi.spyOn(FileSessionStorage.prototype, 'mutateUiHistory')
      .mockImplementation(async () => {
        held.resolve();
        await release.promise;
        throw new Error('checkpoint-save-failed');
      });
    try {
      await runRound(session.id, 1);
      await held.promise;
      const flush = SessionViewOwner.prototype.flush;
      const flushSpy = vi.spyOn(SessionViewOwner.prototype, 'flush').mockImplementation(function (this: SessionViewOwner, id) {
        flushed.resolve();
        return flush.call(this, id);
      });
      restoreFlush = () => flushSpy.mockRestore();
      reading = readSource(session.id);
      await Promise.race([flushed.promise, reading.catch(() => undefined)]);
      release.resolve();
      await expect(reading).rejects.toThrow('checkpoint-save-failed');
    } finally {
      release.resolve();
      if (reading) await Promise.allSettled([reading]);
      restoreFlush?.();
      writer.mockRestore();
    }
  },
);
