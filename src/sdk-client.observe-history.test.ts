import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import { FileSessionStorage } from '@kodax-ai/repl';

const REPLY_TEXT = 'A sufficiently detailed recorded summary of the exchange that carries usable semantic content for later turns.';

class HistoryProvider extends KodaXBaseProvider {
  readonly name = 'product-history-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_HISTORY_TEST_KEY', model: 'product-history-test', supportsThinking: false,
  };
  async stream(): Promise<KodaXStreamResult> {
    return {
      textBlocks: [{ type: 'text', text: REPLY_TEXT }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let client: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-history-'));
  registerModelProvider('product-history-test', () => new HistoryProvider());
  vi.stubEnv('KODAX_PRODUCT_HISTORY_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-history-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated history Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-history-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
});

afterEach(async () => {
  await client?.disconnect().catch(() => undefined);
  await host?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('reads a frozen oversized output by its original identity after it leaves the view and is archived', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
  const data = await storage.load(session.id);
  if (!data) throw new Error('Fixture session missing');
  const body = `Archived original ${'x'.repeat(140 * 1024)}`;
  data.messages = [{ role: 'user', content: 'original query', inputId: 'original' },
    { role: 'assistant', outputId: 'archived-output', content: body }];
  delete data.lineage;
  await storage.save(session.id, data);
  const views: ClientSessionView[] = [];
  const observation = await client.sessions.observe(session.id, view => views.push(view));
  try {
    const frozen = views.at(-1)!.items.find(item => item.outputId === 'archived-output');
    expect(frozen).toBeDefined();
    const current = await storage.load(session.id);
    if (!current) throw new Error('Fixture session missing');
    current.messages.push(...Array.from({ length: 85 }, (_, index) => [
      { role: 'user' as const, content: `Later question ${index}`, inputId: `later-${index}` },
      { role: 'assistant' as const, content: `Later answer ${index}`, outputId: `later-output-${index}` },
    ]).flat());
    delete current.lineage;
    await storage.save(session.id, current);
    const compacted = await runtime.sessions.compact({ sessionId: session.id,
      provider: 'product-history-test', contextWindow: 200_000, triggerTokens: 1 });
    expect(compacted.compacted, JSON.stringify(compacted)).toBe(true);
    await expect.poll(() => views.at(-1)?.items.some(item => item.id === frozen!.id)).toBe(false);
    let offset = 0;
    let full = '';
    do {
      const chunk = await client.sessions.readItem(session.id, frozen!.id, { offset });
      expect(chunk).not.toBeNull();
      expect(chunk?.outputState).toBe('committed');
      full += chunk!.text;
      if (chunk!.nextOffset === undefined) break;
      offset = chunk!.nextOffset;
    } while (offset < body.length);
    expect(full).toBe(body);
  } finally { observation.close(); }
}, 60_000);

it('shows pre-compaction conversation history in the current view after compaction', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const ancient = await client.inputs.submit({
    sessionId: session.id, inputId: 'ancient', text: 'Ancient pre-compaction fact worth keeping.',
  });
  await runtime.runs.await(ancient.runId!);

  // Force a real compaction with a tiny context window so the protected
  // tail cannot retain the ancient exchange in the storage messages.
  const compacted = await runtime.sessions.compact({
    sessionId: session.id, provider: 'product-history-test', contextWindow: 60_000, triggerTokens: 1,
  });
  expect(compacted.compacted, String((compacted as { reason?: string }).reason)).toBe(true);

  const recent = await client.inputs.submit({
    sessionId: session.id, inputId: 'recent', text: 'Post compaction note.',
  });
  await runtime.runs.await(recent.runId!);

  const first: ClientSessionView[] = [];
  const observation = await client.sessions.observe(session.id, (view) => first.push(view));
  try {
    const items = first[0]!.items;
    expect(items.some((item) => item.type === 'user' && item.text === 'Post compaction note.')).toBe(true);
    // The canonical conversation (not just the storage tail) is the view's
    // history source, so the pre-compaction exchange remains visible.
    expect(items.some((item) => item.type === 'user' && item.text === 'Ancient pre-compaction fact worth keeping.')).toBe(true);
    const ancientItem = items.find((item) => item.text === 'Ancient pre-compaction fact worth keeping.')!;
    expect(ancientItem.id).toContain('history');

    // Stable identity: a fresh observation resolves the same item id.
    const second: ClientSessionView[] = [];
    const reopened = await client.sessions.observe(session.id, (view) => second.push(view));
    try {
      expect(second[0]!.items.some((item) => item.id === ancientItem.id)).toBe(true);
    } finally { reopened.close(); }
  } finally { observation.close(); }
}, 60_000);

it('keeps settled output single between live items and conversation history', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const views: ClientSessionView[] = [];
  const observation = await client.sessions.observe(session.id, (view) => views.push(view));
  try {
    const active = await client.inputs.submit({
      sessionId: session.id, inputId: 'settling', text: 'Produce one settled answer.',
    });
    // Capture the live streaming item's id before settlement.
    await expect.poll(() => views.at(-1)!.items
      .find((item) => item.type === 'assistant' && item.text === REPLY_TEXT)?.id, { timeout: 15_000 })
      .toEqual(expect.any(String));
    const liveId = views.at(-1)!.items
      .find((item) => item.type === 'assistant' && item.text === REPLY_TEXT)!.id;
    await runtime.runs.await(active.runId!);
    // After settlement the answer exists as a live run item AND in the
    // canonical conversation; the view must show it exactly once, under the
    // same id it had while streaming.
    await expect.poll(() => views.at(-1)!.items
      .filter((item) => item.type === 'assistant' && item.text === REPLY_TEXT).length, { timeout: 10_000 })
      .toBe(1);
    expect(views.at(-1)!.items.find((item) => item.text === REPLY_TEXT)?.id).toBe(liveId);
  } finally { observation.close(); }
}, 60_000);
