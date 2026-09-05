import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class LegacyProvider extends KodaXBaseProvider {
  readonly name = 'product-legacy-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_LEGACY_TEST_KEY', model: 'product-legacy-test', supportsThinking: false,
  };
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    requests.push(structuredClone(messages));
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    return { textBlocks: [{ type: 'text', text: `REPLY ${userText.slice(-1)}` }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

let requests: KodaXMessage[][] = [];
// Only rounds carrying the warm-up text are conversational (learning-review
// judge frames are single-user JSON prompts).
function conversationalRequests(): number {
  return requests.filter((messages) =>
    messages.some((message) => typeof message.content === 'string' && message.content.startsWith('Ask round')),
  ).length;
}
let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

async function bootHost(): Promise<void> {
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-legacy-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire the legacy-runs Host.');
  const endpointPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\kodax-legacy-' + randomUUID()
    : path.join(homeDir, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  second = await connectKodaXClient({ homeDir, endpoint: endpointPath });
}

async function shutDownHost(): Promise<void> {
  // bootHost may fail partway; teardown stays safe on partial state.
  await Promise.allSettled([first?.disconnect(), second?.disconnect()]);
  await host?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
}

function statusFileFor(runId: string): string {
  const profileDir = path.join(homeDir, '.kodax', 'runtime', 'profiles', 'default');
  return path.join(profileDir, 'runs', encodeURIComponent(runId), 'status.json');
}

function runDirFor(runId: string): string {
  return path.dirname(statusFileFor(runId));
}

async function tamperStatus(runId: string, phase: 'running' | 'queued'): Promise<void> {
  const file = statusFileFor(runId);
  const parsed = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
  const tampered: Record<string, unknown> = {
    ...parsed,
    phase,
    stage: phase === 'queued' ? 'queued' : 'executing',
  };
  delete tampered.endedAt;
  delete tampered.terminal;
  delete tampered.stop;
  await writeFile(file, JSON.stringify(tampered, null, 2), 'utf-8');
}

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-legacy-'));
  requests = [];
  registerModelProvider('product-legacy-test', () => new LegacyProvider());
  vi.stubEnv('KODAX_PRODUCT_LEGACY_TEST_KEY', 'test-only');
  await bootHost();
});

afterEach(async () => {
  await shutDownHost();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

it('reads legacy runs conservatively without repairing them from Runtime events', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const round1 = await first.inputs.submit({ sessionId: session.id, inputId: 'round-1', text: 'Ask round 1' });
  await runtime.runs.await(round1.runId!);
  const round2 = await first.inputs.submit({ sessionId: session.id, inputId: 'round-2', text: 'Ask round 2' });
  await runtime.runs.await(round2.runId!);

  const historyBefore = await first.sessions.readHistory(session.id);
  const beforeTexts = historyBefore.items.map((item) => item.text).join('\n');
  expect(beforeTexts).toContain('Ask round 1');

  // Simulate legacy records: the terminal events (including run.completed)
  // stay intact on disk while the status files regress to non-terminal and
  // queued shapes, plus one unreadable status record.
  await shutDownHost();
  requests = [];
  await tamperStatus(round1.runId!, 'running');
  await tamperStatus(round2.runId!, 'queued');
  await mkdir(path.dirname(statusFileFor('legacy-corrupt-run')), { recursive: true });
  await writeFile(statusFileFor('legacy-corrupt-run'), '{not-json', 'utf-8');
  await bootHost();

  // A legacy non-terminal run reads as interrupted with unknown effects —
  // never as completed inferred from the intact terminal Runtime event.
  const running = await second.runs.read(round1.runId!);
  expect(running.phase).toBe('interrupted');
  expect(running.error).toBe('daemon_crashed');
  // A legacy queued record was never executed and stays that way.
  const queued = await second.runs.read(round2.runId!);
  expect(queued.phase).toBe('interrupted');
  expect(queued.error).toBe('runtime_restarted');
  // Unreadable run metadata is an explicit error, not a fabricated fact.
  await expect(first.runs.read('legacy-corrupt-run')).rejects.toThrow(/Runtime run not found/);
  // Nothing resumed: no Provider round happened across the restart.
  expect(conversationalRequests()).toBe(0);
  // Session content stays readable and unchanged.
  const historyAfter = await first.sessions.readHistory(session.id);
  expect(historyAfter.items.map((item) => item.text).join('\n')).toBe(beforeTexts);
}, 120_000);

it('keeps legacy paths defined after Runtime event files are deleted', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const round = await first.inputs.submit({ sessionId: session.id, inputId: 'round-1', text: 'Ask round 1' });
  await runtime.runs.await(round.runId!);
  const historyBefore = await first.sessions.readHistory(session.id);
  const before = historyBefore.items.map((item) => item.text).join('\n');

  // Remove every Runtime event artifact for the run, regress its status to a
  // legacy non-terminal shape, and restart: reads stay defined.
  await shutDownHost();
  requests = [];
  const dir = runDirFor(round.runId!);
  for (const artifact of ['events.jsonl', 'events.watermark', 'event-journals.json']) {
    await rm(path.join(dir, artifact), { force: true, maxRetries: 10, retryDelay: 100 });
  }
  await tamperStatus(round.runId!, 'running');
  await bootHost();

  const status = await second.runs.read(round.runId!);
  expect(status.phase).toBe('interrupted');
  expect(status.error).toBe('daemon_crashed');
  expect(conversationalRequests()).toBe(0);
  const historyAfter = await first.sessions.readHistory(session.id);
  expect(historyAfter.items.map((item) => item.text).join('\n')).toBe(before);
}, 120_000);
