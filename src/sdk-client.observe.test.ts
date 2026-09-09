import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

it('observes an actual Host current view and replaces settings without event cursors', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-view-'));
  const profile = 'observe';
  const runtime = await createKodaXRuntime({ homeDir, profile });
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
    await runtime.sessions.updateSettings(session.id, { model: 'reviewed-model' });
    await expect.poll(() => views.at(-1)?.settings.model).toBe('reviewed-model');
    expect(views[0]?.settings.model).toBeUndefined();
    await runtime.sessions.appendNotice({ sessionId: session.id, content: 'Historical note.' });
    await expect.poll(() => views.at(-1)?.items.some((item) => item.text.includes('Historical note.'))).toBe(true);
    const historical = views.at(-1)!.items.find((item) => item.text.includes('Historical note.'))!;
    expect(await client.sessions.readItem(session.id, historical.id)).toMatchObject({ id: historical.id, text: 'Historical note.', offset: 0, totalLength: 16 });
    await runtime.sessions.updateSettings(session.id, { model: 'next-model' });
    await expect.poll(() => views.at(-1)?.settings.model).toBe('next-model');
    expect(views.at(-1)!.items.find((item) => item.id === historical.id)).toBe(historical);
    observation.close();
    const count = views.length;
    await runtime.sessions.updateSettings(session.id, { model: 'later-model' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(views).toHaveLength(count);
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
