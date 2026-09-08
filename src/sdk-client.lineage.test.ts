import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import type { ClientLineageSummary, ClientSessionView } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { FileSessionStorage } from '@kodax-ai/repl';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class LineageProvider extends KodaXBaseProvider {
  readonly name = 'product-lineage-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_LINEAGE_TEST_KEY', model: 'product-lineage-test', supportsThinking: false,
  };
  async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
    const messages = args[0];
    requests.push(structuredClone(messages));
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    args[4]?.onTextDelta?.(`REPLY ${userText.slice(-1)}`);
    return { textBlocks: [{ type: 'text', text: `REPLY ${userText.slice(-1)}` }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

let requests: KodaXMessage[][] = [];
let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-lineage-'));
  requests = [];
  registerModelProvider('product-lineage-test', () => new LineageProvider());
  vi.stubEnv('KODAX_PRODUCT_LINEAGE_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-lineage-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated lineage Host.');
  const endpointPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\kodax-lineage-' + randomUUID()
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

function firstUserEntryId(lineage: ClientLineageSummary): string {
  const entry = lineage.entries.find((item) => item.type === 'message' && item.parentId === null);
  if (entry === undefined) throw new Error('No root message entry in lineage.');
  return entry.id;
}

it('waits for the completed run display checkpoint before opening a transcript boundary', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  let release = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = FileSessionStorage.prototype.mutateUiHistory;
  const checkpoint = vi.spyOn(FileSessionStorage.prototype, 'mutateUiHistory').mockImplementation(async function (this: FileSessionStorage, ...args) {
    await blocked;
    return original.apply(this, args);
  });
  try {
    await runRound(session.id, 1);
    await expect.poll(() => checkpoint.mock.calls.length).toBeGreaterThan(0);
    let settled = false;
    const transcript = runtime.sessions.transcript(session.id).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    release();
    expect((await transcript)?.activeMessages.at(-1)?.content).toEqual([{ type: 'text', text: 'REPLY 1' }]);
  } finally {
    release();
    await runtime.close();
    checkpoint.mockRestore();
  }
}, 60_000);

it('continues a legacy pathless session without claiming its shared unknown bucket', async () => {
  const storage = new FileSessionStorage({
    sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax'),
  });
  // HEAD sessions.create({ title }) persisted these fields; execution used
  // process.cwd() but neither gitRoot nor runtimeInfo stored that identity.
  const sessionId = 'legacy-pathless';
  await storage.createGenerated(sessionId, { messages: [], title: 'Legacy', gitRoot: '', scope: 'user' });
  await storage.createGenerated('legacy-neighbor', { messages: [], title: 'Neighbor', gitRoot: '', scope: 'user' });
  const neighborPath = path.join(homeDir, '.kodax', 'sessions', '_unknown', 'legacy-neighbor.jsonl');
  const neighbor = await readFile(neighborPath, 'utf8');
  await runtime.sessions.updateSettings(sessionId, {
    agentMode: 'sa', permissionMode: 'full-access', executionCwd: homeDir,
  });
  const accepted = await first.inputs.submit({ sessionId, inputId: 'legacy-round', text: 'Ask round 1' });
  const result = await runtime.runs.await(accepted.runId!);
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ phase: 'completed' });
  expect((await runtime.sessions.transcript(sessionId))?.activeMessages.at(-1)?.content)
    .toEqual([{ type: 'text', text: 'REPLY 1' }]);
  const persisted = await storage.load(sessionId);
  expect(persisted?.gitRoot).toBe('');
  expect(persisted?.runtimeInfo?.canonicalRepoRoot).toBeUndefined();
  expect(persisted?.runtimeInfo?.executionCwd).toBeUndefined();
  const continued = await first.inputs.submit({ sessionId, inputId: 'legacy-round-2', text: 'Ask round 2' });
  expect(await runtime.runs.await(continued.runId!)).toMatchObject({ phase: 'completed' });
  expect(await readFile(neighborPath, 'utf8')).toBe(neighbor);
  await expect(readFile(path.join(homeDir, '.kodax', 'sessions', '_unknown', 'project.json'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
}, 60_000);

it('labels branches and moves the head with both clients seeing the same lineage', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  await runRound(session.id, 1);
  await runRound(session.id, 2);

  const before = await first.sessions.readLineage(session.id);
  expect(before).not.toBeNull();
  expect(before!.entries.length).toBeGreaterThanOrEqual(4);
  expect(before!.activeEntryId).not.toBeNull();
  // Both clients read identical lineage facts.
  expect(await second.sessions.readLineage(session.id)).toEqual(before);

  const rootId = firstUserEntryId(before!);
  const labeled = await first.sessions.labelEntry(session.id, { selector: rootId, label: 'v1' });
  expect(labeled.entries.some((entry) => entry.type === 'label' && entry.targetId === rootId && entry.label === 'v1')).toBe(true);
  expect(await second.sessions.readLineage(session.id)).toEqual(labeled);

  // Precise label modification: relabeling writes a new label fact, and
  // removing the label writes an unlabel fact; the original entries stay.
  const relabeled = await second.sessions.labelEntry(session.id, { selector: rootId, label: 'v2' });
  expect(relabeled.entries.some((entry) => entry.type === 'label' && entry.targetId === rootId && entry.label === 'v2')).toBe(true);
  const unlabeled = await first.sessions.labelEntry(session.id, { selector: rootId });
  expect(unlabeled.entries.filter((entry) => entry.type === 'label' && entry.targetId === rootId && entry.label === undefined).length).toBe(1);
  expect(unlabeled.entries.length).toBeGreaterThan(labeled.entries.length);

  // Unknown selectors are explicit conflicts, never silent no-ops, and an
  // empty label cannot silently unlabel — removal must omit the field.
  await expect(first.sessions.labelEntry(session.id, { selector: 'missing-entry', label: 'x' }))
    .rejects.toMatchObject({ code: 'conflict' });
  await expect(first.sessions.labelEntry(session.id, { selector: rootId, label: '  ' }))
    .rejects.toMatchObject({ code: 'invalid_params' });

  // Selecting by label moves the head for both clients.
  await second.sessions.labelEntry(session.id, { selector: rootId, label: 'v1' });
  const moved = await first.sessions.selectBranch(session.id, 'v1');
  expect(moved.id).toBe(session.id);
  const afterMove = await second.sessions.readLineage(session.id);
  expect(afterMove!.activeEntryId).toBe(rootId);
  expect((await first.sessions.readLineage(session.id))!.activeEntryId).toBe(rootId);

  // A label name itself resolves as a selector for later label edits.
  const renamed = await first.sessions.labelEntry(session.id, { selector: 'v1', label: 'v1-renamed' });
  expect(renamed.entries.some((entry) => entry.type === 'label' && entry.targetId === rootId && entry.label === 'v1-renamed')).toBe(true);

  // A stale selection is an explicit conflict.
  await expect(first.sessions.selectBranch(session.id, 'missing-entry'))
    .rejects.toMatchObject({ code: 'conflict' });

  // Lineage commands never started a Run (background learning-review frames excluded).
  const conversational = requests.filter((messages) => messages.some((message) => typeof message.content === 'string' && message.content.startsWith('Ask round')));
  expect(conversational.length).toBe(2);
}, 60_000);

it('rewinds the head through the Host without dropping entries', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  await runRound(session.id, 1);
  await runRound(session.id, 2);

  const before = await first.sessions.readLineage(session.id);
  const rootId = firstUserEntryId(before!);
  const abandonedHead = before!.activeEntryId!;
  const rootIndex = before!.entries.findIndex((entry) => entry.id === rootId);
  const views: ClientSessionView[] = [];
  const observation = await second.sessions.observe(session.id, view => views.push(view));
  expect(views.at(-1)!.items.some(item => item.text === 'REPLY 2')).toBe(true);
  await expect(first.sessions.rewindSession(session.id, { selector: rootId, expectedHead: rootId }))
    .rejects.toMatchObject({ code: 'conflict' });
  expect((await second.sessions.readLineage(session.id))!.activeEntryId).toBe(abandonedHead);
  const rewound = await first.sessions.rewindSession(session.id, { selector: rootId, expectedHead: abandonedHead });
  expect(rewound.id).toBe(session.id);
  const after = await second.sessions.readLineage(session.id);
  expect(after!.activeEntryId).toBe(rootId);
  await expect.poll(() => views.at(-1)!.items.some(item => item.text === 'REPLY 2')).toBe(false);
  observation.close();
  // Rewind moves the head only: kept entries stay visible, the abandoned
  // branch is accounted by a rewind marker (archived through the lineage
  // domain, never deleted), and already-executed file effects are untouched
  // by construction.
  const marker = after!.entries.find((entry) => entry.type === 'rewind_marker');
  expect(marker?.truncatedCount).toBe(before!.entries.length - rootIndex - 1);
  for (const entry of before!.entries.slice(0, rootIndex + 1)) {
    expect(after!.entries.some((item) => item.id === entry.id)).toBe(true);
  }
  // The archived head no longer resolves: selecting it is an explicit conflict.
  await expect(first.sessions.selectBranch(session.id, abandonedHead))
    .rejects.toMatchObject({ code: 'conflict' });

  // Continuing from the rewound head works through a normal input.
  const next = await second.inputs.submit({ sessionId: session.id, inputId: 'post-rewind', text: 'Continue from here.' });
  await runtime.runs.await(next.runId!);
  const tail = await first.sessions.readLineage(session.id);
  expect(tail!.activeEntryId).not.toBe(rootId);
}, 60_000);
