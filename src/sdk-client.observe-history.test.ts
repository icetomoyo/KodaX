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

it('keeps an interrupted draft inside its aliased input round when that input is outside the byte-budget page', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
  const data = (await storage.load(session.id))!;
  data.messages = [{ role: 'user', inputId: 'original', inputIds: ['original', 'alias-original'], content: 'Q'.repeat(30_000) }];
  for (let index = 0; index < 4; index += 1) data.messages.push(
    { role: 'user', inputId: `later-${index}`, content: `Later ${index}` },
    { role: 'assistant', outputId: `answer-${index}`, content: 'x'.repeat(125_000) },
  );
  data.uiHistory = [{ id: 'partial', type: 'assistant', outputId: 'interrupted', afterInputId: 'alias-original', text: 'Interrupted partial' }];
  delete data.lineage;
  await storage.save(session.id, data);
  const page = await runtime.sessions.conversationPage({ sessionId: session.id, limit: 80 });
  expect(page?.hasMore).toBe(true);
  expect(page?.entries[0]?.index).toBeGreaterThan(0);
  let view: ClientSessionView | undefined;
  const observation = await client.sessions.observe(session.id, next => { view = next; });
  try {
    expect(view!.items.map(item => item.inputId ?? item.outputId))
      .toEqual(['original', 'interrupted', 'later-0', 'answer-0', 'later-1', 'answer-1', 'later-2', 'answer-2', 'later-3', 'answer-3']);
  } finally { observation.close(); }
});

it('keeps checkpointed tools before continuations when the real byte-budget page has no shared anchor', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
  const data = (await storage.load(session.id))!;
  data.messages = [
    { role: 'user', inputId: 'review', content: 'Review changes' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'early', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'early', is_error: false, content: 'E'.repeat(30_000) }] },
  ];
  for (let index = 0; index < 4; index += 1) {
    if (index > 0) data.messages.push({ role: 'user', _synthetic: true, content: 'Continue the previous response.' });
    data.messages.push({ role: 'assistant', outputId: `continuation-${index}`, content: `${index}${'x'.repeat(124_999)}` });
  }
  data.uiHistory = [{ type: 'tool_group', afterInputId: 'review', tools: [{ id: 'early', name: 'read', status: 'success', output: 'E'.repeat(30_000) }] }];
  delete data.lineage;
  await storage.save(session.id, data);
  const page = await runtime.sessions.conversationPage({ sessionId: session.id, limit: 80 });
  expect(page?.hasMore).toBe(true);
  expect(page?.entries[0]?.index).toBe(3);
  expect(page?.entries.every(entry => !entry.oversized)).toBe(true);
  let view: ClientSessionView | undefined;
  const observation = await client.sessions.observe(session.id, next => { view = next; });
  try {
    expect(view!.items.filter(item => item.tool || item.outputId).map(item => item.tool?.callId ?? item.outputId))
      .toEqual(['early', 'continuation-0', 'continuation-1', 'continuation-2', 'continuation-3']);
    const compacted = await runtime.sessions.compact({ sessionId: session.id,
      provider: 'product-history-test', contextWindow: 200_000, triggerTokens: 1 });
    expect(compacted.compacted, JSON.stringify(compacted)).toBe(true);
    const tail = await storage.load(session.id);
    expect(tail?.messages.some(message => typeof message.content !== 'string'
      && message.content.some(block => block.type === 'tool_use' && block.id === 'early'))).toBe(false);
    const after = await runtime.sessions.conversationPage({ sessionId: session.id, limit: 80 });
    expect(after?.revision).not.toBe(page?.revision);
    const refreshed = await client.sessions.observe(session.id, next => { view = next; });
    try {
      expect(view!.items.filter(item => item.tool || item.outputId).map(item => item.tool?.callId ?? item.outputId))
        .toEqual(['early', 'continuation-0', 'continuation-1', 'continuation-2', 'continuation-3']);
    } finally { refreshed.close(); }
  } finally { observation.close(); }
}, 60_000);

it('preserves accepted user identity when the literal text mentions internal worker prompts', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const text = 'Explain the string "You are the Generator role" in this source.';
  const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'quoted-role', text });
  await runtime.runs.await(accepted.runId!);
  const history = await client.sessions.readHistory(session.id);
  expect(history.items.filter(item => item.type === 'user')).toMatchObject([{ inputId: 'quoted-role', text }]);
  let view: ClientSessionView | undefined;
  const observation = await client.sessions.observe(session.id, next => { view = next; });
  try {
    expect(view!.items.filter(item => item.type === 'user')).toMatchObject([{ inputId: 'quoted-role', text }]);
  } finally { observation.close(); }
});

it.each([
  { is_error: false, content: '[Error] is a documented literal', metadata: {}, status: 'success' },
  { is_error: true, content: 'Stopped by the user', metadata: { cancelled: true }, status: 'cancelled' },
])('shares the explicit $status tool outcome between view and history', async result => {
  const session = await client.sessions.create({ projectPath: homeDir });
  const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
  const data = (await storage.load(session.id))!;
  data.messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', is_error: result.is_error, content: result.content, metadata: result.metadata }] },
  ];
  delete data.lineage;
  await storage.save(session.id, data);
  let view: ClientSessionView | undefined;
  const observation = await client.sessions.observe(session.id, next => { view = next; });
  try {
    expect(view!.items.find(item => item.tool?.callId === 'call')?.tool?.status).toBe(result.status);
    const page = await client.sessions.readHistory(session.id);
    expect(page.items.find(item => item.tool?.callId === 'call')?.tool?.status).toBe(result.status);
  } finally { observation.close(); }
});

it('keeps canonical tool bodies and parameters complete across view and history without a display checkpoint', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
  const data = (await storage.load(session.id))!;
  const input = { content: `参数🧪${'x'.repeat(10_000)}` };
  const body = `结果🧪${'y'.repeat(70_000)}`;
  data.messages = [
    { role: 'user', inputId: 'input', content: 'Read the result' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'raw-tool', name: 'read', input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'raw-tool', is_error: false, content: body }] },
    { role: 'assistant', outputId: 'final', content: 'Complete.' },
  ];
  delete data.lineage;
  delete data.uiHistory;
  await storage.save(session.id, data);
  let view: ClientSessionView | undefined;
  const observation = await client.sessions.observe(session.id, next => { view = next; });
  try {
    const tool = view!.items.find(item => item.tool?.callId === 'raw-tool')!;
    expect(tool.tool?.startedAt).toBeUndefined();
    let full = '';
    do {
      const chunk = await client.sessions.readItem(session.id, tool.id, { offset: full.length });
      expect(chunk).not.toBeNull();
      expect(chunk!.totalLength).toBe(body.length);
      full += chunk!.text;
      if (chunk!.nextOffset === undefined) break;
    } while (full.length < body.length);
    expect(full).toBe(body);
    expect((await client.sessions.readItem(session.id, tool.id, { part: 'input' }))?.text).toBe(JSON.stringify(input));
    const history = await client.sessions.readHistory(session.id);
    const historical = history.items.find(item => item.tool?.callId === 'raw-tool')!;
    expect((await client.sessions.readHistoryEntry(session.id, historical.id, { part: 'input' }))?.text).toBe(JSON.stringify(input));
    expect(historical.totalTextLength).toBe(body.length);
  } finally { observation.close(); }
});

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

it.each(['assistant', 'tool'] as const)('reads a frozen oversized %s by its original identity after it leaves the view and is archived', async kind => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
  const data = await storage.load(session.id);
  if (!data) throw new Error('Fixture session missing');
  const body = `Archived original ${'x'.repeat(140 * 1024)}`;
  const input = { query: '查找'.repeat(2_000) };
  data.messages = [{ role: 'user', content: 'original query', inputId: 'original' },
    ...(kind === 'assistant' ? [{ role: 'assistant' as const, outputId: 'archived-output', content: body }]
      : [{ role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'archived-tool', name: 'read', input }] },
        { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'archived-tool', content: body, is_error: false }] }])];
  delete data.lineage;
  await storage.save(session.id, data);
  const views: ClientSessionView[] = [];
  const observation = await client.sessions.observe(session.id, view => views.push(view));
  try {
    const frozen = views.at(-1)!.items.find(item => kind === 'assistant'
      ? item.outputId === 'archived-output' : item.tool?.callId === 'archived-tool');
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
      if (kind === 'assistant') expect(chunk?.outputState).toBe('committed');
      full += chunk!.text;
      if (chunk!.nextOffset === undefined) break;
      offset = chunk!.nextOffset;
    } while (offset < body.length);
    expect(full).toBe(body);
    if (kind === 'tool') expect((await client.sessions.readItem(session.id, frozen!.id, { part: 'input' }))?.text)
      .toBe(JSON.stringify(input));
  } finally { observation.close(); }
}, 60_000);

it('invalidates frozen tool and output locators after switching the canonical branch', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
  const data = (await storage.load(session.id))!;
  data.messages = [
    { role: 'user', inputId: 'root', content: 'Start' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'old-tool', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'Old tool result' }] },
    { role: 'assistant', outputId: 'old-output', content: 'Old answer' },
  ];
  delete data.lineage;
  await storage.save(session.id, data);
  let view: ClientSessionView | undefined;
  const observation = await client.sessions.observe(session.id, next => { view = next; });
  try {
    const ids = view!.items.filter(item => item.tool || item.outputId).map(item => item.id);
    expect(ids).toHaveLength(2);
    const lineage = await client.sessions.readLineage(session.id);
    const rootEntry = lineage?.entries.find(entry => entry.type === 'message' && entry.parentId === null);
    expect(rootEntry).toBeDefined();
    await runtime.sessions.setActiveEntry({ sessionId: session.id, entryId: rootEntry!.id });
    for (const id of ids) expect(await client.sessions.readItem(session.id, id)).toBeNull();
  } finally { observation.close(); }
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
    expect(ancientItem.id).toBe(`${session.id}:input:ancient`);

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
