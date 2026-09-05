import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { ensureKodaXRuntime } from './sdk-runtime.js';
import { readRuntimeDaemonLockOwner, resolveRuntimeDaemonPaths, type RuntimeDaemonPaths } from './runtime-daemon/state.js';

let homeDir: string;
let configHome: string;
let providerServer: Server;
let providerRequests = 0;
let providerMode: 'hold-all' | 'tool-call-then-hold' = 'hold-all';
const providerSockets = new Set<Socket>();
// The daemon is spawned detached; any early test failure must still be
// followed by an owner kill in afterEach, or the child outlives vitest.
const liveScenarioPaths: RuntimeDaemonPaths[] = [];

function writeSseToolCallResponse(response: ServerResponse): void {
  const chunk = (delta: unknown, finishReason: string | null): string => JSON.stringify({
    id: 'chatcmpl-crash', object: 'chat.completion.chunk', created: 1, model: 'crash-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const command = JSON.stringify({ command: 'echo tool-ran | tee -a crash-marker.txt' });
  const frames = [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-crash', type: 'function', function: { name: 'bash', arguments: '' } }] }, null),
    chunk({ tool_calls: [{ index: 0, function: { arguments: command } }] }, null),
    chunk({}, 'tool_calls'),
  ].map((frame) => `data: ${frame}\n\n`).join('') + 'data: [DONE]\n\n';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(frames);
}

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-crash-'));
  configHome = path.join(homeDir, '.kodax');
  providerRequests = 0;
  providerMode = 'hold-all';
  providerServer = createServer((request, response) => {
    if (request.url?.includes('/chat/completions')) providerRequests += 1;
    response.socket?.on('error', () => undefined);
    // The first request may script a tool call; later requests hang forever
    // so the crashed Host keeps them pending.
    if (providerMode === 'tool-call-then-hold' && providerRequests === 1) {
      writeSseToolCallResponse(response);
    }
  });
  providerServer.on('connection', (socket) => {
    providerSockets.add(socket);
    socket.on('close', () => providerSockets.delete(socket));
  });
  await new Promise<void>((resolve) => { providerServer.listen(0, '127.0.0.1', resolve); });
  const port = (providerServer.address() as { port: number }).port;
  fs.mkdirSync(configHome, { recursive: true });
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({
    provider: 'crash-mock',
    model: 'crash-model',
    customProviders: [{
      name: 'crash-mock',
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKeyEnv: 'KODAX_CRASH_MOCK_KEY',
      model: 'crash-model',
    }],
  }), 'utf8');
  vi.stubEnv('KODAX_CRASH_MOCK_KEY', 'test-only');
}, 120_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const paths of liveScenarioPaths) killRemainingOwner(paths);
  liveScenarioPaths.length = 0;
  for (const socket of providerSockets) socket.destroy();
  providerSockets.clear();
  await new Promise<void>((resolve) => { providerServer.close(() => resolve()); });
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
}, 120_000);

interface CrashScenario {
  readonly first: Awaited<ReturnType<typeof ensureKodaXRuntime>>;
  readonly client: Awaited<ReturnType<typeof connectKodaXClient>>;
  readonly sessionId: string;
  readonly runId: string;
  readonly paths: RuntimeDaemonPaths;
  readonly homeDir: string;
  readonly profile: string;
}

async function startScenario(inputText: string): Promise<CrashScenario> {
  const profile = 'crash';
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  fs.mkdirSync(paths.configHome, { recursive: true });
  const first = await ensureKodaXRuntime({ homeDir, profile, daemonStartupTimeoutMs: 60_000 });
  const client = await connectKodaXClient({ homeDir, profile });
  const session = await client.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const accepted = await client.inputs.submit({
    sessionId: session.id, inputId: 'crash-input', text: inputText,
  });
  expect(accepted).toMatchObject({ state: 'submitted' });
  liveScenarioPaths.push(paths);
  return { first, client, sessionId: session.id, runId: accepted.runId!, paths, homeDir, profile };
}

async function killHostAndRestart(scenario: CrashScenario): Promise<{
  readonly survivor: Awaited<ReturnType<typeof connectKodaXClient>>;
  readonly restarted: Awaited<ReturnType<typeof ensureKodaXRuntime>>;
}> {
  const owner = readRuntimeDaemonLockOwner(scenario.paths.lockFile);
  expect(owner?.pid).toBeDefined();
  process.kill(owner!.pid!, 'SIGKILL');
  await scenario.client.disconnect().catch(() => undefined);
  await scenario.first.close().catch(() => undefined);
  const restarted = await ensureKodaXRuntime({
    homeDir: scenario.homeDir, profile: scenario.profile, daemonStartupTimeoutMs: 60_000,
  });
  const survivor = await connectKodaXClient({
    homeDir: scenario.homeDir, profile: scenario.profile,
  });
  expect(restarted.identity.runtimeId).not.toBe(scenario.first.identity.runtimeId);
  return { survivor, restarted };
}

function markerLines(): number {
  try {
    return fs.readFileSync(path.join(homeDir, 'crash-marker.txt'), 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

it('a Host crash after input acceptance preserves content, marks the Run interrupted, and redoes no work', async () => {
  const scenario = await startScenario('Work that never completes.');
  const { survivor, restarted } = await killHostAndRestart(scenario);
  try {
    await expect(survivor.sessions.read(scenario.sessionId)).resolves.toMatchObject({ id: scenario.sessionId });

    const status = await survivor.runs.read(scenario.runId);
    expect(status.phase).not.toBe('completed');
    expect(['interrupted', 'unknown']).toContain(status.phase);

    const recovered: ClientSessionView[] = [];
    const reopened = await survivor.sessions.observe(scenario.sessionId, (view) => recovered.push(view));
    try {
      expect(recovered[0]!.items.some((item) => item.type === 'user' && item.text.includes('Work that never completes.'))).toBe(true);
    } finally { reopened.close(); }

    // The restarted Host redoes neither the Provider call nor the input:
    // it holds no queued work, so a redo would have to start immediately;
    // sample twice across the restart-settle bound to see none did.
    const requestsAfterRestart = providerRequests;
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(providerRequests).toBe(requestsAfterRestart);
    expect(providerRequests).toBeLessThanOrEqual(1);
    // Acceptance identity is current-Host scoped by design; the Run fact is
    // the durable view the client reads after a Host change.
    expect(await survivor.inputs.read(scenario.sessionId, 'crash-input')).toBeNull();
  } finally {
    await survivor.disconnect().catch(() => undefined);
    await restarted.close().catch(() => undefined);
    killRemainingOwner(scenario.paths);
  }
}, 180_000);

it('a Host crash after tool dispatch keeps the executed tool un-redone and the Run interrupted', async () => {
  providerMode = 'tool-call-then-hold';
  const scenario = await startScenario('Run the scripted tool.');
  await expect.poll(() => markerLines(), { timeout: 60_000 }).toBe(1);
  const { survivor, restarted } = await killHostAndRestart(scenario);
  try {
    const status = await survivor.runs.read(scenario.runId);
    expect(status.phase).not.toBe('completed');
    expect(['interrupted', 'unknown']).toContain(status.phase);

    const sampledMarker = markerLines();
    const sampledRequests = providerRequests;
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(markerLines()).toBe(sampledMarker);
    expect(providerRequests).toBe(sampledRequests);
    expect(markerLines()).toBe(1);
    expect(providerRequests).toBeLessThanOrEqual(2);
  } finally {
    await survivor.disconnect().catch(() => undefined);
    await restarted.close().catch(() => undefined);
    killRemainingOwner(scenario.paths);
  }
}, 180_000);

it('a Host crash after the tool result entered the context shows interrupted, not an inferred success', async () => {
  providerMode = 'tool-call-then-hold';
  const scenario = await startScenario('Run the scripted tool.');
  // Request 2 carries the committed tool result: that is the observable of
  // the result entering the follow-up model context.
  await expect.poll(() => providerRequests, { timeout: 60_000 }).toBe(2);
  const { survivor, restarted } = await killHostAndRestart(scenario);
  try {
    const status = await survivor.runs.read(scenario.runId);
    expect(status.phase).not.toBe('completed');
    expect(['interrupted', 'unknown']).toContain(status.phase);

    const recovered: ClientSessionView[] = [];
    const reopened = await survivor.sessions.observe(scenario.sessionId, (view) => recovered.push(view));
    try {
      expect(recovered[0]!.items.some((item) => item.text.includes('tool-ran'))).toBe(true);
    } finally { reopened.close(); }

    const sampledMarker = markerLines();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(markerLines()).toBe(sampledMarker);
    expect(markerLines()).toBe(1);
    expect(providerRequests).toBe(2);
  } finally {
    await survivor.disconnect().catch(() => undefined);
    await restarted.close().catch(() => undefined);
    killRemainingOwner(scenario.paths);
  }
}, 180_000);

function killRemainingOwner(paths: RuntimeDaemonPaths): void {
  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (owner?.pid && owner.pid !== process.pid) {
    try { process.kill(owner.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
