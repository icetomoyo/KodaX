import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult, type KodaXToolUseBlock,
} from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { createCliClientPlane } from './cli-client-plane.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

const ROUNDS = 6;
// One oversized assistant reply must stay above the Host's 128 KiB inline
// entry limit so it surfaces as a large-result reference instead of a page item.
const HUGE_BODY = `HUGE-BODY-MARKER ${'x'.repeat(140 * 1024)}`;

class HistoryProvider extends KodaXBaseProvider {
  readonly name = 'product-history-page-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_HISTORY_PAGE_TEST_KEY', model: 'product-history-page-test', supportsThinking: false,
  };
  constructor(private readonly onRequest: (messages: KodaXMessage[]) => void) { super(); }
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    this.onRequest(messages);
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const userText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : JSON.stringify(lastUser?.content ?? '');
    const huge = userText.includes('HUGE-REQUEST');
    if (userText.includes('ERROR-REQUEST')) {
      return {
        textBlocks: [{ type: 'text', text: 'Checking two missing files.' }], thinkingBlocks: [],
        toolBlocks: [
          { type: 'tool_use', id: 'missing-a', name: 'read', input: { path: path.join(homeDir, 'absent-a.txt') } },
          { type: 'tool_use', id: 'missing-b', name: 'read', input: { path: path.join(homeDir, 'absent-b.txt') } },
        ], stopReason: 'tool_use',
      };
    }
    const tool = userText.includes('TOOL-REQUEST') && !userText.includes('previous response was truncated');
    return {
      textBlocks: [{ type: 'text', text: huge ? HUGE_BODY : `FACT-${userText.slice(-1)} acknowledged.` }],
      thinkingBlocks: [],
      toolBlocks: tool ? [{ type: 'tool_use', id: 'call-history-tool', name: 'bash', input: { command: 'echo tool-round-ok' } }] : [],
      stopReason: tool ? 'tool_use' : 'end_turn',
    };
  }
}

let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let client: Awaited<ReturnType<typeof connectKodaXClient>>;
let reconnect: Awaited<ReturnType<typeof connectKodaXClient>> | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-history-'));
  registerModelProvider('product-history-page-test', () => new HistoryProvider(() => undefined));
  vi.stubEnv('KODAX_PRODUCT_HISTORY_PAGE_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-history-page-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated history Host.');
  const endpointPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\kodax-history-${randomUUID()}`
    : path.join(homeDir, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  client = await connectKodaXClient({ homeDir, endpoint: endpointPath });
});

afterEach(async () => {
  await reconnect?.disconnect();
  reconnect = undefined;
  await client.disconnect();
  await host.close();
  await runtime.close();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

async function runRound(sessionId: string, index: number, huge = false): Promise<void> {
  const text = huge ? `HUGE-REQUEST ${index}` : `Ask round ${index}`;
  const accepted = await client.inputs.submit({ sessionId, inputId: `round-${index}`, text });
  await runtime.runs.await(accepted.runId!);
}

async function toolRound(sessionId: string): Promise<void> {
  const accepted = await client.inputs.submit({ sessionId, inputId: 'tool-round', text: 'TOOL-REQUEST run the echo' });
  await runtime.runs.await(accepted.runId!);
}

it('shares accepted input identity across history and observation for identical prompts', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  for (const inputId of ['first-identical', 'second-identical']) {
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId, text: 'Same prompt' });
    await runtime.runs.await(accepted.runId!);
  }
  const page = await client.sessions.readHistory(session.id);
  expect(page.items.filter(item => item.type === 'user')).toMatchObject([
    { text: 'Same prompt', inputId: 'first-identical' },
    { text: 'Same prompt', inputId: 'second-identical' },
  ]);
  let users: readonly unknown[] = [];
  const observation = await client.sessions.observe(session.id, view => {
    users = view.items.filter(item => item.type === 'user');
  });
  try {
    expect(users).toMatchObject([
      { text: 'Same prompt', inputId: 'first-identical' },
      { text: 'Same prompt', inputId: 'second-identical' },
    ]);
  } finally { observation.close(); }
});

it('preserves failed tool outcomes in history after the run settles', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'errors', text: 'ERROR-REQUEST' });
  await runtime.runs.await(accepted.runId!);
  const page = await client.sessions.readHistory(session.id);
  const tools = page.items.filter((item) => item.type === 'tool');
  expect(tools).toHaveLength(2);
  expect(tools.map((item) => item.tool?.status)).toEqual(['error', 'error']);
  const second = tools.find((item) => item.tool?.callId === 'missing-b')!;
  const input = await client.sessions.readHistoryEntry(session.id, second.id, { part: 'input' });
  expect(JSON.parse(input!.text)).toEqual({ path: path.join(homeDir, 'absent-b.txt') });
  const output = await client.sessions.readHistoryEntry(session.id, second.id);
  expect(output?.text).toContain('absent-b.txt');
  expect(output?.text).not.toContain('absent-a.txt');
  const pagedTools: typeof tools = [];
  let cursor: string | undefined;
  do {
    const single = await client.sessions.readHistory(session.id, { limit: 1, ...(cursor ? { cursor } : {}) });
    pagedTools.push(...single.items.filter((item) => item.type === 'tool'));
    cursor = single.nextCursor;
  } while (cursor !== undefined);
  expect(pagedTools.map((item) => ({ id: item.id, text: item.text, status: item.tool?.status })))
    .toEqual(tools.map((item) => ({ id: item.id, text: item.text, status: item.tool?.status })));
}, 30_000);

it('pages older history with stable ids, copyable bodies, and oversized entry reads', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  for (let index = 1; index <= ROUNDS; index += 1) await runRound(session.id, index);
  await runRound(session.id, ROUNDS + 1, true);

  // Small pages force real paging; walk cursors until the oldest exchange shows.
  const seenTexts: string[] = [];
  const pageIds = new Set<string>();
  let cursor: string | undefined;
  let oldestPageReached = false;
  let oversizedIds: string[] = [];
  for (let guard = 0; guard < 20 && !oldestPageReached; guard += 1) {
    const page = await client.sessions.readHistory(session.id, { limit: 4, ...(cursor !== undefined ? { cursor } : {}) });
    expect(typeof page.revision).toBe('string');
    for (const item of page.items) {
      expect(pageIds.has(item.id)).toBe(false);
      pageIds.add(item.id);
      seenTexts.push(item.text);
    }
    oversizedIds = [...oversizedIds, ...page.oversized.map((entry) => entry.itemId)];
    if (page.nextCursor === undefined) oldestPageReached = true;
    else cursor = page.nextCursor;
  }
  expect(oldestPageReached).toBe(true);
  // The oldest exchange is reachable by paging, not only via the newest page.
  expect(seenTexts.some((text) => text.includes('Ask round 1'))).toBe(true);
  expect(seenTexts.some((text) => text.includes('FACT-3 acknowledged.'))).toBe(true);
  // Bodies stay copyable in full for inline entries.
  expect(seenTexts.some((text) => text.includes('HUGE-BODY-MARKER'))).toBe(true);
  expect(seenTexts.filter((text) => text === 'Ask round 1')).toHaveLength(1);

  // The oversized assistant reply is referenced, and its full body reads back chunked.
  expect(oversizedIds.length).toBeGreaterThanOrEqual(1);
  const first = await client.sessions.readHistoryEntry(session.id, oversizedIds[0]!);
  expect(first).not.toBeNull();
  expect(first!.text.startsWith('HUGE-BODY-MARKER')).toBe(true);
  expect(first!.totalLength).toBeGreaterThanOrEqual(HUGE_BODY.length);
  expect(first!.nextOffset).toBeGreaterThan(0);
  const tail = await client.sessions.readHistoryEntry(session.id, oversizedIds[0]!, { offset: first!.nextOffset });
  expect(tail).not.toBeNull();
  expect(tail!.offset).toBe(first!.nextOffset);

  // Re-reading at the unchanged revision resolves the same item identities.
  const firstPage = await client.sessions.readHistory(session.id, { limit: 4 });
  const firstPageAgain = await client.sessions.readHistory(session.id, { limit: 4 });
  expect(firstPageAgain.items.map((item) => item.id)).toEqual(firstPage.items.map((item) => item.id));

  // A freshly connected client pages the same old session the same way.
  reconnect = await connectKodaXClient({ homeDir, endpoint: (host.endpoint as { path: string }).path });
  const reopened = await reconnect.sessions.readHistory(session.id, { limit: 4 });
  expect(reopened.items.map((item) => item.id)).toEqual(firstPage.items.map((item) => item.id));

  // A real tool exchange pages as a tool item with copyable command and
  // output, and its raw tool parameters read back verbatim.
  await toolRound(session.id);
  const withTool = await client.sessions.readHistory(session.id);
  const toolItem = withTool.items.find((item) => item.type === 'tool' && item.tool?.name === 'bash');
  expect(toolItem).toBeDefined();
  expect(toolItem!.tool!.inputText).toContain('echo tool-round-ok');
  expect(toolItem!.text).toContain('tool-round-ok');
  const toolInput = await client.sessions.readHistoryEntry(session.id, toolItem!.id, { part: 'input' });
  expect(toolInput).not.toBeNull();
  expect(toolInput!.text).toContain('"command"');
  expect(toolInput!.text).toContain('echo tool-round-ok');
  const plane = createCliClientPlane(runtime);
  let liveToolId: string | undefined;
  const stopObserving = await plane.observe(session.id, view => {
    liveToolId = view.items.find(item => item.tool?.callId === 'call-history-tool')?.id;
  });
  try {
    expect(liveToolId).toBeDefined();
    const liveInput = await plane.readItem!(session.id, liveToolId!, { part: 'input', offset: 0 });
    expect(JSON.parse(liveInput!.text)).toEqual({ command: 'echo tool-round-ok' });
  } finally { stopObserving(); }
}, 60_000);

it('marks old cursors stale after history changes and searches the whole history', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  for (let index = 1; index <= ROUNDS; index += 1) await runRound(session.id, index);

  const firstPage = await client.sessions.readHistory(session.id, { limit: 3 });
  expect(firstPage.nextCursor).toBeDefined();

  // History grows: the old cursor is explicitly stale, never silently reinterpreted.
  await runRound(session.id, ROUNDS + 1);
  await expect(client.sessions.readHistory(session.id, { cursor: firstPage.nextCursor! }))
    .rejects.toMatchObject({ code: 'resync_required' });
  const fresh = await client.sessions.readHistory(session.id);
  expect(fresh.items.some((item) => item.text.includes('FACT-7'))).toBe(true);

  const search = await client.sessions.searchHistory(session.id, { query: 'FACT-4 acknowledged', limit: 5 });
  expect(search.hits.length).toBeGreaterThanOrEqual(1);
  expect(search.hits[0]!.snippet).toContain('FACT-4 acknowledged.');
  expect(typeof search.hits[0]!.entryIndex).toBe('number');
}, 60_000);
