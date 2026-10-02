import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerCustomProviders } from '@kodax-ai/llm';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from './sdk-client.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it.each(['sa', 'ama'] as const)('uses saved %s Host output after IPC detach and restart without persisting recovery instructions', async agentMode => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-recovery-'));
  let holding = true;
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (text: string, finish: string | null = null) => response.write(`data: ${JSON.stringify({
      id: 'recovery-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
    })}\n\n`);
    send(holding ? 'SAVED_PARTIAL_PROGRESS' : 'NEXT_ANSWER');
    if (!holding) { send('', 'stop'); response.end('data: [DONE]\n\n'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider port unavailable');
  await mkdir(path.join(homeDir, '.kodax'));
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ customProviders: [{
    name: 'interrupted-recovery-test', protocol: 'openai', model: 'fixture', apiKeyEnv: 'KODAX_INTERRUPTED_RECOVERY_TEST_KEY',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  }] }));
  vi.stubEnv('KODAX_INTERRUPTED_RECOVERY_TEST_KEY', 'test-only');
  const start = async () => {
    const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
    const paths = resolveRuntimeDaemonPaths(homeDir);
    const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
    if (!lock) throw new Error('Isolated Host lock unavailable');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-recovery-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, `host-${randomUUID()}.sock`) };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
    return { runtime, host, client };
  };
  let active = await start();
  let observation: { close(): void } | undefined;
  let sessionId: string | undefined;
  let activeRunId: string | undefined;
  try {
    const session = await active.client.sessions.create({ projectPath: homeDir });
    sessionId = session.id;
    await active.client.sessions.updateSettings(session.id, { provider: 'interrupted-recovery-test', model: 'fixture', agentMode, permissionMode: 'full-access' });
    const views: ClientSessionView[] = [];
    observation = await active.client.sessions.observe(session.id, view => views.push(view));
    activeRunId = (await active.client.inputs.submit({ sessionId: session.id, inputId: 'first', text: 'Begin work.' })).runId;
    await expect.poll(() => views.at(-1)?.items.some(item => item.text === 'SAVED_PARTIAL_PROGRESS'), { timeout: 15_000 }).toBe(true);
    await active.client.sessions.cancel({ sessionId: session.id, expectedRunId: activeRunId!, requestId: 'stop-first' });
    expect((await active.client.runs.await(activeRunId!)).phase).not.toBe('completed');
    activeRunId = undefined;
    // readItem crosses the Host's existing checkpoint boundary.
    const draft = views.at(-1)!.items.find(item => item.text === 'SAVED_PARTIAL_PROGRESS')!;
    await active.client.sessions.readItem(session.id, draft.id);
    observation.close(); observation = undefined;
    await active.client.disconnect(); await active.host.close(); await active.runtime.close();
    holding = false;
    const requestsBefore = bodies.length;
    active = await start();
    expect(bodies).toHaveLength(requestsBefore);
    activeRunId = (await active.client.inputs.submit({ sessionId: session.id, inputId: 'second', text: 'Continue carefully.' })).runId;
    expect(await active.client.runs.await(activeRunId!)).toMatchObject({ phase: 'completed' });
    activeRunId = undefined;
    expect(bodies.slice(requestsBefore).join('\n').includes('SAVED_PARTIAL_PROGRESS')).toBe(true);
    expect(bodies.slice(requestsBefore).join('\n').includes('Interrupted Run Recovery')).toBe(true);
    const history = await active.client.sessions.readHistory(session.id);
    expect(JSON.stringify(history)).not.toContain('Interrupted Run Recovery');
    expect(JSON.stringify(history)).toContain('NEXT_ANSWER');
  } finally {
    observation?.close();
    if (sessionId && activeRunId) await active.client.sessions.cancel({ sessionId, expectedRunId: activeRunId, requestId: 'cleanup' });
    await active.client.disconnect(); await active.host.close(); await active.runtime.close();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    registerCustomProviders([]); vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);
