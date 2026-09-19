import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXEvents, KodaXOptions, KodaXResult, RunningSession } from '@kodax-ai/coding';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

const executor = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@kodax-ai/coding', async (original) => ({
  ...await original<typeof import('@kodax-ai/coding')>(), startKodaX: executor.start,
}));

it.each([true, false])('clears active Session overrides to the same Host settings as the next Run (profile=%s)', async hasProfile => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-effective-settings-'));
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  const profileSettings = hasProfile ? { permissionMode: 'plan', thinking: true, reasoningMode: 'deep', agentMode: 'sa' } : {};
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify(profileSettings));
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'mock-provider' });
  let captured: KodaXOptions | undefined;
  let finish: ((result: KodaXResult) => void) | undefined;
  const reasoningUpdates = vi.fn();
  executor.start.mockImplementation((options: KodaXOptions): RunningSession => {
    captured = options;
    const result = new Promise<KodaXResult>(resolve => { finish = resolve; });
    return { id: options.session!.id!, currentProvider: options.provider, currentModel: options.model,
      currentReasoning: options.reasoningMode, aborted: false, attached: true,
      setProvider() {}, setModel() {}, setReasoning: reasoningUpdates, abort() {}, result };
  });
  const session = await runtime.sessions.create({ projectPath: process.cwd() });
  const views: ClientSessionView[] = [];
  const observation = await runtime.sessions.observeView(session.id, view => views.push(view));
  try {
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', thinking: false, reasoningMode: 'off', agentMode: 'sa' });
    const start = () => runtime.runs.start({ sessionId: session.id, prompt: 'wait',
      options: { events: { beforeToolExecute: async () => 'original-policy' } } });
    const active = await start();
    await runtime.sessions.updateSettings(session.id, { permissionMode: null, thinking: null, reasoningMode: null, agentMode: null });
    expect(await runtime.sessions.getSettings(session.id)).toEqual({});
    // Product views resolve their built-in default without granting a low-level
    // Run an undeclared policy; its original approval hook still owns this call.
    await expect.poll(() => views.at(-1)?.settings).toEqual({ permissionMode: 'accept-edits', ...profileSettings });
    const decide = () => captured!.events!.beforeToolExecute!(hasProfile ? 'edit' : 'bash',
      hasProfile ? { path: path.join(process.cwd(), 'file.ts'), old_string: 'old', new_string: 'new' } : { command: 'echo test' });
    const activeDecision = await decide();
    expect(activeDecision).toEqual(hasProfile ? expect.stringContaining('[Blocked]') : 'original-policy');
    expect(reasoningUpdates).toHaveBeenLastCalledWith(hasProfile ? 'deep' : undefined, { effort: undefined, thinking: hasProfile ? true : undefined });
    finish?.({ success: true, lastText: '', messages: [], sessionId: session.id });
    await active.result;
    const next = await start();
    expect(await decide()).toEqual(activeDecision);
    expect(captured?.thinking).toBe(hasProfile ? true : undefined);
    expect(captured?.reasoningMode).toBe(hasProfile ? 'deep' : undefined);
    finish?.({ success: true, lastText: '', messages: [], sessionId: session.id });
    await next.result;
  } finally {
    finish?.({ success: true, lastText: '', messages: [], sessionId: session.id });
    observation.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

it('observes an actual Host current view and replaces settings without event cursors', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-view-'));
  const profile = 'observe';
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({
    compaction: { contextWindow: 120_000, triggerPercent: 66, triggerTokens: 70_000 },
  }));
  const runtime = await createKodaXRuntime({ homeDir, profile, defaultProvider: 'anthropic' });
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Isolated Host lock was unavailable.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-view-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
  try {
    const session = await runtime.sessions.create({ title: 'Current view' });
    const views: ClientSessionView[] = [];
    const observation = await client.sessions.observe(session.id, (view) => views.push(view));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ session: { id: session.id, title: 'Current view' }, items: [] });
    expect(views[0]).not.toHaveProperty('cursor');
    expect(views[0]).not.toHaveProperty('revision');
    expect(views[0]?.contextBudget).toMatchObject({ provider: 'anthropic', model: expect.any(String), contextWindow: 120_000 });
    const peer = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
    const peerViews: ClientSessionView[] = [];
    const peerObservation = await peer.sessions.observe(session.id, (view) => peerViews.push(view));
    await client.sessions.updateSettings(session.id, { provider: 'anthropic', model: 'reviewed-model', compactionTriggerPercent: 61 });
    await expect.poll(() => views.at(-1)?.settings.model).toBe('reviewed-model');
    expect(views.at(-1)?.contextBudget).toMatchObject({
      scope: 'parent', provider: 'anthropic', model: 'reviewed-model', contextWindow: 120_000,
      compaction: { enabled: true, triggerPercent: 61, absoluteTriggerTokens: 70_000 },
    });
    expect(views.at(-1)?.contextBudget?.compaction.triggerTokens).toBeUndefined();
    await expect.poll(() => peerViews.at(-1)?.contextBudget).toEqual(views.at(-1)?.contextBudget);
    await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({
      compaction: { contextWindow: 100_000, triggerPercent: 66, triggerTokens: 70_000 }, memory: { enabled: true },
    }));
    await client.config.reload();
    await expect.poll(() => views.at(-1)?.contextBudget?.contextWindow).toBe(100_000);
    await expect.poll(() => peerViews.at(-1)?.contextBudget?.contextWindow).toBe(100_000);
    expect(views.at(-1)?.contextBudget?.compaction.physicalCapacityTokens).toBeUndefined();
    peerObservation.close();
    await peer.disconnect();
    expect(views[0]?.settings.model).toBeUndefined();
    await runtime.sessions.appendNotice({ sessionId: session.id, content: 'Historical note.' });
    await expect.poll(() => views.at(-1)?.items.some((item) => item.text.includes('Historical note.'))).toBe(true);
    const historical = views.at(-1)!.items.find((item) => item.text.includes('Historical note.'))!;
    expect(await client.sessions.readItem(session.id, historical.id)).toMatchObject({ id: historical.id, text: 'Historical note.', offset: 0, totalLength: 16 });
    await runtime.sessions.updateSettings(session.id, { model: 'next-model' });
    await expect.poll(() => views.at(-1)?.settings.model).toBe('next-model');
    expect(views.at(-1)!.items.find((item) => item.id === historical.id)).toBe(historical);
    const statusEvents: string[] = [];
    const tracked = await client.sessions.observe(session.id, (view) => statusEvents.push(`view:${view.settings.model}`), {
      onStatus: status => statusEvents.push(status.state === 'closed' ? status.reason : status.state),
    });
    const failedRead = vi.spyOn(runtime.interactions, 'list').mockRejectedValueOnce(new Error('Synthetic projection read failure'));
    try {
      await client.sessions.updateSettings(session.id, { model: 'during-read-failure' });
      await expect.poll(() => statusEvents.at(-1)).toBe('interrupted');
      await client.sessions.updateSettings(session.id, { model: 'recovered-view' });
      await expect.poll(() => statusEvents.slice(-2)).toEqual(['view:recovered-view', 'live']);
    } finally { failedRead.mockRestore(); tracked.close(); }
    observation.close();
    const count = views.length;
    await runtime.sessions.updateSettings(session.id, { model: 'later-model' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(views).toHaveLength(count);
    const removed = await client.sessions.create({ title: 'Deleted observation' });
    const removedStatuses: string[] = [];
    const removedObservation = await client.sessions.observe(removed.id, () => undefined, {
      onStatus: status => removedStatuses.push(status.state === 'closed' ? status.reason : status.state),
    });
    await client.sessions.delete(removed.id);
    await expect.poll(() => removedStatuses).toEqual(['live', 'unavailable']);
    removedObservation.close();
  } finally {
    await client.disconnect();
    await host.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

it('keeps continuous long output bounded on actual IPC and reads its complete content by stable identity', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-view-volume-'));
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'mock-provider' });
  const paths = resolveRuntimeDaemonPaths(homeDir, 'default');
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Isolated Host lock was unavailable.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-volume-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  let events: KodaXEvents | undefined;
  let finish: ((result: KodaXResult) => void) | undefined;
  executor.start.mockImplementation((options: KodaXOptions): RunningSession => {
    events = options.events;
    const result = new Promise<KodaXResult>((resolve) => { finish = resolve; });
    return { id: options.session!.id!, currentProvider: options.provider, currentModel: options.model,
      currentReasoning: options.reasoningMode, aborted: false, attached: true,
      setProvider() {}, setModel() {}, setReasoning() {}, abort() {}, result };
  });
  const frames: Array<{ atMs: number; bytes: number; serializeMs: number }> = [];
  const rpcMs: number[] = [];
  const start = performance.now();
  const memoryBefore = process.memoryUsage();
  try {
    const session = await runtime.sessions.create({ title: 'Continuous output' });
    let current: ClientSessionView | undefined;
    const observation = await client.sessions.observe(session.id, (view) => {
      current = view;
      const began = performance.now();
      const bytes = Buffer.byteLength(JSON.stringify(view));
      frames.push({ atMs: began - start, bytes, serializeMs: performance.now() - began });
    });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'stream a long result' });
    events!.onOutputSegmentStart?.({ responseId: 'volume', providerRequestId: 'volume-request', mode: 'append' });
    const chunk = 'output line\n'.repeat(44_000);
    for (let index = 0; index < 20; index += 1) {
      events!.onTextDelta?.(chunk, { providerRequestId: 'volume-request' });
      await new Promise((resolve) => setTimeout(resolve, 85));
      const rpcStart = performance.now();
      await client.sessions.read(session.id);
      rpcMs.push(performance.now() - rpcStart);
    }
    events!.onTextDelta?.('END', { providerRequestId: 'volume-request' });
    finish!({ success: false, lastText: '', messages: [], sessionId: session.id });
    await run.result;
    await expect.poll(() => current?.items.at(-1)?.text.endsWith('END')).toBe(true);
    const itemId = current!.items.at(-1)!.id;
    let offset = 0;
    const parts: string[] = [];
    do {
      const part = await client.sessions.readItem(session.id, itemId, { offset });
      expect(part).not.toBeNull();
      parts.push(part!.text);
      offset = part!.nextOffset ?? 0;
    } while (offset !== 0);
    expect(parts.join('')).toBe(chunk.repeat(20) + 'END');
    expect(frames.length).toBeGreaterThan(3);
    expect(Math.max(...frames.map((frame) => frame.bytes))).toBeLessThan(8 * 1024 * 1024);
    observation.close();
  } finally {
    await writeFile(path.join(os.tmpdir(), 'kodax-session-view-volume.json'), JSON.stringify({
      scenario: '20 x 528000-character streaming chunks over local IPC', frames, rpcMs,
      elapsedMs: performance.now() - start, memoryBefore, memoryAfter: process.memoryUsage(),
    }, null, 2));
    finish?.({ success: false, lastText: '', messages: [], sessionId: 'cleanup' });
    await client.disconnect();
    await host.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);

it('keeps earlier output and retry history when replacing exactly one failed output segment', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-segments-'));
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'mock-provider' });
  const paths = resolveRuntimeDaemonPaths(homeDir, 'default');
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Isolated Host lock was unavailable.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-segments-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  let events: KodaXEvents | undefined;
  let finish: ((result: KodaXResult) => void) | undefined;
  executor.start.mockImplementation((options: KodaXOptions): RunningSession => {
    events = options.events;
    const result = new Promise<KodaXResult>((resolve) => { finish = resolve; });
    return {
      id: options.session!.id!, currentProvider: options.provider, currentModel: options.model,
      currentReasoning: options.reasoningMode, aborted: false, attached: true,
      setProvider() {}, setModel() {}, setReasoning() {}, abort() {}, result,
    };
  });
  try {
    const session = await runtime.sessions.create({ title: 'Segments' });
    const views: ClientSessionView[] = [];
    const observation = await client.sessions.observe(session.id, (view) => views.push(view));
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'review' });
    const segment = (providerRequestId: string, mode: 'append' | 'replace', text: string) => {
      events!.onOutputSegmentStart?.({ responseId: 'response', providerRequestId, mode });
      events!.onTextDelta?.(text, { providerRequestId });
    };
    segment('a', 'append', 'Earlier complete output.');
    segment('b', 'append', 'Failed partial output.');
    events!.onRetry?.('Connection reset', 1, 2);
    await expect.poll(() => views.at(-1)?.items.some(item => item.text === 'Failed partial output.')).toBe(true);
    const beforeReplacement = await client.sessions.observe(session.id, () => {});
    beforeReplacement.close();
    segment('c', 'replace', 'Replacement partial output.');
    events!.onThinkingDelta?.('partial reasoning', { providerRequestId: 'c' });
    events!.onThinkingEnd?.('Complete reasoning.', { providerRequestId: 'c' });
    events!.onToolUseStart?.({ id: 'test-call', name: 'bash', input: { command: 'npm test' } });
    events!.onToolProgress?.({ id: 'test-call', message: 'still running' });
    events!.onToolResult?.({ id: 'test-call', name: 'bash', content: '42 tests passed.' });
    events!.onSidecarMessage?.({ source: 'sidecar-verifier', verdict: 'revise', recipient: 'user',
      delivery: 'budget-exhausted', content: 'Check the remaining case.', suggestedFix: 'Add a boundary test.' });
    events!.onManagedTaskStatus?.({ agentMode: 'ama', harnessProfile: 'H1_EXECUTE_EVAL', phase: 'worker', events: [
      { key: 'ephemeral', kind: 'progress', summary: 'Transient countdown', persistToHistory: false },
      { key: 'saved', kind: 'warning', summary: 'Worker needs attention.', persistToHistory: true },
    ] });
    events!.onManagedTaskStatus?.({ agentMode: 'ama', harnessProfile: 'H1_EXECUTE_EVAL', phase: 'completed' });
    events!.onRetryAfter?.({ provider: 'mock-provider', reason: 'overloaded', source: 'retry-after-seconds', waitMs: 2000, attempt: 1, maxAttempts: 3 });
    events!.onProviderRateLimit?.(1, 3, 2000);
    events!.onTodoUpdate?.([{ id: 'todo-1', subject: 'Verify the boundary', status: 'in_progress' }]);
    if (events!.getCostReport) events!.getCostReport.current = () => 'Total cost: $0.012';
    const childMeta = { childAgentId: 'reviewer', childAgentName: 'Review', liveOnly: true, contextKind: 'child' as const };
    events!.onToolUseStart?.({ id: 'child-call', name: 'read', input: { path: 'README.md' } }, childMeta);
    events!.onThinkingDelta?.('Do not replace the concrete tool action', childMeta);
    events!.onIterationEnd?.({ iter: 2, maxIter: 20, tokenCount: 12000, tokenSource: 'api', scope: 'parent',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    events!.onCompactStart?.();
    await expect.poll(() => views.at(-1)?.activity?.compacting).toBe(true);
    expect(views.at(-1)?.activity).toMatchObject({
      todos: [{ id: 'todo-1', subject: 'Verify the boundary', status: 'in_progress' }],
      context: { tokenCount: 12000, tokenSource: 'api', scope: 'parent' },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      costReport: 'Total cost: $0.012',
      children: [{ id: 'reviewer', label: 'Review', kind: 'tool', detail: 'read README.md', status: 'running' }],
    });
    events!.onChildActivityEnd?.(childMeta);
    events!.onCompactStats?.({ tokensBefore: 12000, tokensAfter: 3000 });
    events!.onCompact?.(3000);
    events!.onCompactEnd?.();
    events!.onMemoryNotice?.({ episodeId: 'memory-1', summaries: ['Saved the requested preference'], proposalIds: ['proposal-1'] });
    // All changes fit between two deliveries: the durable display facts must survive coalescing.
    finish!({ success: false, lastText: '', messages: [], sessionId: session.id });
    await run.result;
    await expect.poll(() => views.at(-1)?.items.map((item) => item.text)).toEqual([
      'Earlier complete output.', 'Connection reset · retry 1/2', 'Replacement partial output.',
      'Complete reasoning.', '42 tests passed.', 'Check the remaining case.\nSuggested fix: Add a boundary test.', 'Worker needs attention.',
      '[Overloaded] (mock-provider) — retrying in 2s [retry-after-seconds] (1/3)',
      'Context auto-compacted (was ~12k tokens)', '[memory] Saved the requested preference',
    ]);
    const shown = views.at(-1)!.items;
    expect(views.at(-1)!.activity?.compacting).toBe(false);
    observation.close();
    const reopened: ClientSessionView[] = [];
    const again = await client.sessions.observe(session.id, (view) => reopened.push(view));
    expect(reopened[0]!.items).toEqual(shown);
    again.close();
    await client.disconnect();
    await host.close();
    await runtime.close();
    const recoveredRuntime = await createKodaXRuntime({ homeDir });
    const recoveredLock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: recoveredRuntime.identity.runtimeId, pid: process.pid, createdAt: recoveredRuntime.identity.startedAt,
    });
    if (!recoveredLock) throw new Error('Restarted Host lock was unavailable.');
    const recoveredHost = await startRuntimeDaemonHost({ runtime: recoveredRuntime, paths, lock: recoveredLock, endpoint });
    const recovered = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
    try {
      const afterRestart: ClientSessionView[] = [];
      const finalObservation = await recovered.sessions.observe(session.id, (view) => afterRestart.push(view));
      expect(afterRestart[0]!.items).toEqual(shown);
      finalObservation.close();
    } finally {
      await recovered.disconnect();
      await recoveredHost.close();
      await recoveredRuntime.close();
    }
  } finally {
    await client.disconnect();
    await host.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
