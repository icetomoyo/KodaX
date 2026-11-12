import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs/promises';
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
import { createSessionLineage, applySessionCompaction, COMPACTION_SUMMARY_PREFIX, COMPACTED_HISTORY_RECOVERY_GUIDANCE, getSessionMessagesFromLineage } from '@kodax-ai/agent';
import { MAX_SIDE_LETTER_CHARS, SideChats, sideRequester } from './side-chat.js';
import { createKodaXRuntime } from "../tests/runtime-fixture.js";
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
    const scripted = await sideScript?.(...args);
    if (scripted) return scripted;
    requests.push(structuredClone(messages));
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    args[4]?.onTextDelta?.(`REPLY ${userText.slice(-1)}`);
    return { textBlocks: [{ type: 'text', text: `REPLY ${userText.slice(-1)}` }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

let sideScript: KodaXBaseProvider['stream'] | undefined;
let requests: KodaXMessage[][] = [];
let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-lineage-'));
  requests = [];
  sideScript = undefined;
  registerModelProvider('product-lineage-test', () => new LineageProvider());
  vi.stubEnv('KODAX_PRODUCT_LINEAGE_TEST_KEY', 'test-only');
  await openHost();
});

async function openHost() {
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
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath, clientInfo: {
    name: 'lineage', instanceId: 'lineage-first', instanceSecret: 'lineage-fixture-persistent-client-secret' } });
  second = await connectKodaXClient({ homeDir, endpoint: endpointPath });
}

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

it('relays only the selected conclusion while a real parent tool remains in flight', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const probe = path.join(homeDir, 'parent-only.txt');
  await fs.writeFile(probe, 'parent tool finished');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const original = fs.stat.bind(fs);
  const blocked = vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
    if (String(args[0]) === probe && reads++ === 0) await gate;
    return original(...args);
  });
  const mainFrames: KodaXMessage[][] = [];
  const sideTools: string[][] = [];
  const tool = (name: string, input: Record<string, unknown>): KodaXStreamResult => ({
    thinkingBlocks: [], textBlocks: [], toolBlocks: [{ type: 'tool_use', name, input, id: name + '-1' }], stopReason: 'tool_use',
  });
  sideScript = async (messages, tools, system) => {
    const last = messages.at(-1);
    if (last?.content === 'Read parent probe') {
      mainFrames.push(messages);
      return tool('read', { path: probe });
    }
    if (last?.content === 'Send only finding B') {
      sideTools.push(tools.map(t => t.name));
      return tool('send_to_parent', { text: 'Selected finding B' });
    }
    if (!system.includes('independent side conversation') && JSON.stringify(messages).includes('Read parent probe')) {
      mainFrames.push(structuredClone(messages));
    }
    return { thinkingBlocks: [], toolBlocks: [], textBlocks: [{ type: 'text', text: 'Acknowledged' }], stopReason: 'end_turn' };
  };
  try {
    const running = await first.inputs.submit({ sessionId: parent.id, inputId: 'parent', text: 'Read parent probe' });
    await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThan(0);
    const side = await first.sessions.openSide(parent.id);
    for (const [index, text] of ['Private finding A', 'Consider finding B', 'Send only finding B'].entries()) {
      const submitted = await first.inputs.submit({ sessionId: side.id, inputId: 'side-' + index, text });
      expect((await runtime.runs.await(submitted.runId!)).phase).toBe('completed');
    }
    expect(sideTools.flat()).toContain('send_to_parent');
    expect(sideTools.flat()).not.toContain('bash');
    const sideTrace = JSON.stringify((await runtime.sessions.transcript(side.id))?.activeMessages);
    expect(sideTrace).toContain('queued');
    release();
    expect((await runtime.runs.await(running.runId!)).phase).toBe('completed');
    const delivered = mainFrames.at(-1)!.filter(m => m._source === 'side-chat');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.content).toContain('Selected finding B');
    expect(JSON.stringify(mainFrames)).not.toContain('Private finding A');
    const view = await runtime.sessions.transcript(parent.id);
    expect(JSON.stringify(view)).not.toContain('Consider finding B');
  } finally {
    release();
    blocked.mockRestore();
  }
}, 60_000);

it('keeps an idle parent asleep until an explicitly requested wake delivers both reports', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa', permissionMode: 'full-access' });
  await runRound(parent.id, 1);
  const side = await first.sessions.openSide(parent.id);
  sideScript = async (messages, _tools, system) => {
    requests.push(structuredClone(messages));
    const text = messages.at(-1)?.content;
    if (system.includes('independent side conversation') && (text === 'Leave note' || text === 'Send and resume')) {
      return { thinkingBlocks: [], textBlocks: [], toolBlocks: [{ type: 'tool_use', name: 'send_to_parent',
        id: 'send', input: { text, wake: text === 'Send and resume' } }], stopReason: 'tool_use' };
    }
    return { thinkingBlocks: [], textBlocks: [{ type: 'text', text: 'Done' }], toolBlocks: [], stopReason: 'end_turn' };
  };
  const send = async (text: string) => {
    const receipt = await first.inputs.submit({ sessionId: side.id, inputId: text, text });
    expect((await runtime.runs.await(receipt.runId!)).phase).toBe('completed');
  };
  const parentReports = () => requests.filter(messages => messages.some(m => m._source === 'side-chat'));
  await send('Leave note');
  expect(parentReports()).toHaveLength(0);
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  await openHost();
  await send('Send and resume');
  const wakeResult = (await runtime.sessions.transcript(side.id))?.activeMessages.filter(message =>
    Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result')).at(-1);
  expect(JSON.stringify(wakeResult)).toContain('wakeRunId');
  await expect.poll(() => parentReports().length).toBe(1);
  expect(parentReports()[0]?.filter(m => m._source === 'side-chat')).toHaveLength(2);
}, 60_000);

it('opens one independent side conversation and retains its own follow-up history', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa' });
  await runRound(parent.id, 1);
  const [side, reopened] = await Promise.all([
    first.sessions.openSide(parent.id), first.sessions.openSide(parent.id),
  ]);
  expect(reopened.id).toBe(side.id);
  expect(side.id).not.toBe(parent.id);
  const foreign = await second.sessions.openSide(parent.id);
  expect(foreign.id).not.toBe(side.id);
  await expect(second.sessions.read(side.id)).rejects.toThrow();
  await runRound(side.id, 2);
  await runRound(side.id, 3);
  const thirdFrame = requests.find(messages => messages.at(-1)?.content === 'Ask round 3');
  expect(JSON.stringify(thirdFrame)).toContain('Ask round 1');
  expect(JSON.stringify(thirdFrame)).toContain('REPLY 2');
  const parentHistory = await runtime.sessions.transcript(parent.id);
  expect(JSON.stringify(parentHistory)).not.toContain('Ask round 2');
  expect((await first.sessions.list()).map(session => session.id)).not.toContain(side.id);
});

it('reconciles a missing delivery acknowledgement after a cold Host restart', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const side = await first.sessions.openSide(parent.id);
  sideScript = async (messages) => {
    if (messages.at(-1)?.content === 'Send only B') return { textBlocks: [], thinkingBlocks: [],
      toolBlocks: [{ type: 'tool_use', id: 'report', name: 'send_to_parent', input: { text: 'Chosen B only' } }],
      stopReason: 'tool_use' };
    return { textBlocks: [{ type: 'text', text: 'Acknowledged' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  };
  const sent = await first.inputs.submit({ sessionId: side.id, inputId: 'send', text: 'Send only B' });
  expect((await runtime.runs.await(sent.runId!)).phase).toBe('completed');
  const write = SideChats.prototype.save;
  let lost = 0;
  const lostAck = vi.spyOn(SideChats.prototype, 'save').mockImplementation(function (this: SideChats, binding) {
    if (binding.letters.some(l => l.deliveredRunId)) { lost++; return; }
    write.call(this, binding);
  });
  try {
    await runRound(parent.id, 1);
    expect(lost).toBeGreaterThan(0);
  } finally { lostAck.mockRestore(); }
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  await openHost();
  expect((await first.sessions.openSide(parent.id)).id).toBe(side.id);
  const observed: ClientSessionView[] = [];
  const observation = await first.sessions.observe(parent.id, view => observed.push(view));
  expect(observed.at(-1)?.items.some(item => item.text === 'From side chat (delivered): Chosen B only')).toBe(true);
  observation.close();
  await runRound(parent.id, 2);
  const reports = (await runtime.sessions.transcript(parent.id))!.activeMessages.filter(m => m._source === 'side-chat');
  expect(reports).toHaveLength(1);
  expect(reports[0]?.content).toContain('Chosen B only');
}, 60_000);

it('resumes the same side branch after committed parent history moves to a compaction archive', async () => {
  const parent = { id: 'compacted-parent' };
  const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
  const messages: KodaXMessage[] = [{ role: 'user', content: 'Prior question' }, { role: 'assistant', content: 'Prior answer' }];
  await storage.createGenerated(parent.id, { title: 'Compaction', gitRoot: homeDir, messages, lineage: createSessionLineage(messages) });
  const side = await first.sessions.openSide(parent.id);
  const previous = await storage.load(parent.id);
  if (!previous?.lineage) throw new Error('Missing source lineage');
  const summary = 'Parent round finished.';
  const lineage = applySessionCompaction(previous.lineage, [{ role: 'user',
    content: COMPACTION_SUMMARY_PREFIX + summary + COMPACTED_HISTORY_RECOVERY_GUIDANCE,
    _synthetic: true, _source: 'compaction-checkpoint' }], { summary });
  await storage.save(parent.id, { ...previous, lineage, messages: getSessionMessagesFromLineage(lineage) });
  const stored = await storage.readFullSnapshot(parent.id);
  const kinds = stored?.data.lineage?.entries.map(e => [e.type, e.id, e.parentId]);
  expect(kinds?.some(e => e[0] === 'archive_marker'), JSON.stringify({ kinds, full: stored?.lineage?.entries.map(e => e.type) })).toBe(true);

  expect((await first.sessions.openSide(parent.id)).id).toBe(side.id);
}, 60_000);

it('reopens after deleting the child and removes its private history when the parent is deleted', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  const original = await first.sessions.openSide(parent.id);
  await first.sessions.delete(original.id);
  const replacement = await first.sessions.openSide(parent.id);
  expect(replacement.id).not.toBe(original.id);
  await first.sessions.delete(parent.id);
  await expect(first.sessions.read(replacement.id)).rejects.toThrow();
});

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
    .rejects.toMatchObject({ code: 'resync_required', data: { reason: 'head_changed' } });
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

it('tells the woken parent the side agent asked to resume instead of claiming the user did', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa', permissionMode: 'full-access' });
  await runRound(parent.id, 1);
  const side = await first.sessions.openSide(parent.id);
  sideScript = async (messages, _tools, system) => {
    requests.push(structuredClone(messages));
    if (system.includes('independent side conversation') && messages.at(-1)?.content === 'Send and resume') {
      return { thinkingBlocks: [], textBlocks: [], toolBlocks: [{ type: 'tool_use', name: 'send_to_parent',
        id: 'send', input: { text: 'Check drive letters', wake: true } }], stopReason: 'tool_use' };
    }
    return { thinkingBlocks: [], textBlocks: [{ type: 'text', text: 'Done' }], toolBlocks: [], stopReason: 'end_turn' };
  };
  const receipt = await first.inputs.submit({ sessionId: side.id, inputId: 'wake', text: 'Send and resume' });
  expect((await runtime.runs.await(receipt.runId!)).phase).toBe('completed');
  await expect.poll(() => requests.some(messages => messages.some(m => m._source === 'side-chat'))).toBe(true);
  const woken = JSON.stringify(requests.find(messages => messages.some(m => m._source === 'side-chat')));
  expect(woken).toContain('The side agent asked this session to resume');
  expect(woken).not.toContain('The user requested');
}, 60_000);

it('does not start a parent Run for a wake when the parent has no Run record of its own', async () => {
  const source = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(source.id, { agentMode: 'sa', permissionMode: 'full-access' });
  await runRound(source.id, 1);
  const parent = await first.sessions.forkSession(source.id);
  const side = await first.sessions.openSide(parent.id);
  sideScript = async (messages, _tools, system) => {
    requests.push(structuredClone(messages));
    if (system.includes('independent side conversation') && messages.at(-1)?.content === 'Send and resume') {
      return { thinkingBlocks: [], textBlocks: [], toolBlocks: [{ type: 'tool_use', name: 'send_to_parent',
        id: 'send', input: { text: 'Check drive letters', wake: true } }], stopReason: 'tool_use' };
    }
    return { thinkingBlocks: [], textBlocks: [{ type: 'text', text: 'Done' }], toolBlocks: [], stopReason: 'end_turn' };
  };
  const receipt = await first.inputs.submit({ sessionId: side.id, inputId: 'wake', text: 'Send and resume' });
  expect((await runtime.runs.await(receipt.runId!)).phase).toBe('completed');
  const sideResult = JSON.stringify((await runtime.sessions.transcript(side.id))?.activeMessages.filter(message =>
    Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result')).at(-1));
  expect(sideResult).toContain('Waiting for the next authorized parent run');
  expect(sideResult).not.toContain('wakeRunId');
  expect(requests.some(messages => messages.some(m => m._source === 'side-chat'))).toBe(false);
}, 60_000);

it('deletes a parent whose side binding file is unreadable and removes the orphaned side Session', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa', permissionMode: 'full-access' });
  await runRound(parent.id, 1);
  const side = await first.sessions.openSide(parent.id);
  const bindings = (await fs.readdir(homeDir, { recursive: true })).find(entry => entry.includes('side-chats') && entry.endsWith('.json'));
  expect(bindings).toBeDefined();
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  await fs.writeFile(path.join(homeDir, bindings!), '{not json');
  await openHost();
  await first.sessions.delete(parent.id);
  await expect(first.sessions.read(parent.id)).rejects.toThrow();
  const remaining = (await fs.readdir(homeDir, { recursive: true })).filter(entry => entry.includes(side.id));
  expect(remaining, JSON.stringify(remaining)).toEqual([]);
  expect((await fs.readdir(path.dirname(path.join(homeDir, bindings!)))).some(name => name.includes('.corrupt-'))).toBe(true);
}, 60_000);

it('tells the side agent when a report is too long and keeps it out of the parent', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa', permissionMode: 'full-access' });
  await runRound(parent.id, 1);
  const side = await first.sessions.openSide(parent.id);
  sideScript = async (messages, _tools, system) => {
    if (system.includes('independent side conversation') && messages.at(-1)?.content === 'Send everything') {
      return { thinkingBlocks: [], textBlocks: [], toolBlocks: [{ type: 'tool_use', name: 'send_to_parent',
        id: 'send', input: { text: 'x'.repeat(MAX_SIDE_LETTER_CHARS + 1) } }], stopReason: 'tool_use' };
    }
    return { thinkingBlocks: [], textBlocks: [{ type: 'text', text: 'Done' }], toolBlocks: [], stopReason: 'end_turn' };
  };
  const receipt = await first.inputs.submit({ sessionId: side.id, inputId: 'long', text: 'Send everything' });
  await runtime.runs.await(receipt.runId!);
  const result = JSON.stringify((await runtime.sessions.transcript(side.id))?.activeMessages.filter(message =>
    Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result')).at(-1));
  expect(result).toContain('too long');
  expect(JSON.stringify(await runtime.sessions.transcript(parent.id))).not.toContain('xxxxxxxx');
}, 60_000);

it('reports the original failure when cleaning up a half-opened side chat also fails, and opens cleanly afterwards', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa' });
  await runRound(parent.id, 1);
  const snapshot = vi.spyOn(FileSessionStorage.prototype, 'saveSideSnapshot').mockRejectedValue(new Error('snapshot failed'));
  const cleanup = vi.spyOn(FileSessionStorage.prototype, 'delete').mockRejectedValue(new Error('cleanup failed'));
  try {
    await expect(first.sessions.openSide(parent.id)).rejects.toThrow('snapshot failed');
  } finally {
    snapshot.mockRestore();
    cleanup.mockRestore();
  }
  const side = await first.sessions.openSide(parent.id);
  expect(side.id).toMatch(/^side_/);
}, 60_000);

it('discards a preparing binding left by a crashed open even when it belongs to another owner or branch', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa' });
  await runRound(parent.id, 1);
  const side = await first.sessions.openSide(parent.id);
  const relative = (await fs.readdir(homeDir, { recursive: true })).find(entry => entry.includes('side-chats') && entry.endsWith('.json'))!;
  const file = path.join(homeDir, relative);
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  const store = new SideChats(path.dirname(file), () => undefined);
  const ghost = sideRequester.run('ghost', () => store.allocate(parent.id, 'ghost-branch', null));
  const bindings = JSON.parse(await fs.readFile(file, 'utf8')) as unknown[];
  await fs.writeFile(file, JSON.stringify([...bindings, { ...ghost, preparing: true }]));
  await openHost();
  expect((await first.sessions.openSide(parent.id)).id).toBe(side.id);
  const left = JSON.parse(await fs.readFile(file, 'utf8')) as { id: string }[];
  expect(left.map(binding => binding.id)).toEqual([side.id]);
}, 60_000);

it('refuses to open a side chat on an archived parent or on another side chat', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa' });
  await runRound(parent.id, 1);
  const side = await first.sessions.openSide(parent.id);
  await expect(first.sessions.openSide(side.id)).rejects.toThrow('cannot open another side chat');
  await first.sessions.archive(parent.id);
  await expect(first.sessions.openSide(parent.id)).rejects.toThrow(/archived/i);
}, 60_000);

it('does not deliver a report once the parent was rewound before the side snapshot', async () => {
  const parent = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(parent.id, { agentMode: 'sa', permissionMode: 'full-access' });
  await runRound(parent.id, 1);
  await runRound(parent.id, 2);
  const side = await first.sessions.openSide(parent.id);
  const lineage = (await first.sessions.readLineage(parent.id))!;
  await first.sessions.rewindSession(parent.id, { selector: firstUserEntryId(lineage), expectedHead: lineage.activeEntryId! });
  sideScript = async (messages, _tools, system) => {
    if (system.includes('independent side conversation') && messages.at(-1)?.content === 'Send now') {
      return { thinkingBlocks: [], textBlocks: [], toolBlocks: [{ type: 'tool_use', name: 'send_to_parent',
        id: 'send', input: { text: 'Stale finding' } }], stopReason: 'tool_use' };
    }
    return { thinkingBlocks: [], textBlocks: [{ type: 'text', text: 'Done' }], toolBlocks: [], stopReason: 'end_turn' };
  };
  const receipt = await first.inputs.submit({ sessionId: side.id, inputId: 'stale', text: 'Send now' });
  await runtime.runs.await(receipt.runId!);
  const result = JSON.stringify((await runtime.sessions.transcript(side.id))?.activeMessages.filter(message =>
    Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result')).at(-1));
  expect(result).toContain('Parent history has changed');
  expect(JSON.stringify(await runtime.sessions.transcript(parent.id))).not.toContain('Stale finding');
}, 60_000);
