import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class HistoryProvider extends KodaXBaseProvider {
  readonly name = 'product-history-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_HISTORY_TEST_KEY', model: 'product-history-test', supportsThinking: false,
  };
  constructor(private readonly request: (messages: KodaXMessage[]) => Promise<void>) { super(); }
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    await this.request(messages);
    return {
      textBlocks: [{ type: 'text', text: 'A sufficiently detailed recorded summary of the exchange that carries usable semantic content for later turns.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

let homeDir: string;
let requests: KodaXMessage[][] = [];
let onRequest: () => Promise<void> = async () => undefined;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let client: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-history-'));
  requests = [];
  registerModelProvider('product-history-test', () => new HistoryProvider(async (messages) => {
    requests.push(structuredClone(messages));
    await onRequest();
  }));
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
