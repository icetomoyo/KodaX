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

it.each(['sa', 'ama'] as const)('exposes bounded live thinking and tool input facts from the real %s Provider through the Host', async agentMode => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-streaming-'));
  let releaseThinking!: () => void;
  let releaseTool!: () => void;
  const thinkingGate = new Promise<void>(resolve => { releaseThinking = resolve; });
  const toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
  let firstRequest = true;
  const thought = 'Checking the existing file.';
  const toolInput = JSON.stringify({ path: 'fixture.txt' });
  const providerServer = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the real request before replying. */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({
      id: 'stream-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    if (firstRequest) {
      firstRequest = false;
      chunk({ reasoning_content: thought });
      await thinkingGate;
      chunk({ tool_calls: [{ index: 0, id: 'read-fixture', type: 'function', function: { name: 'read', arguments: toolInput.slice(0, 8) } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: toolInput.slice(8) } }] });
      await toolGate;
      chunk({}, 'tool_calls');
    } else chunk({ content: 'File checked.' }, 'stop');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address();
  if (!address || typeof address === 'string') throw new Error('Local fixture port unavailable');
  await mkdir(path.join(homeDir, '.kodax'));
  await writeFile(path.join(homeDir, 'fixture.txt'), 'Fixture content');
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ customProviders: [{
    name: 'streaming-facts-test', protocol: 'openai', model: 'stream-model',
    apiKeyEnv: 'KODAX_STREAMING_FACTS_TEST_KEY', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    reasoning: { efforts: ['low', 'medium', 'high'], default: 'medium' },
  }] }));
  vi.stubEnv('KODAX_STREAMING_FACTS_TEST_KEY', 'test-only');
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId,
    pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Isolated Host lock unavailable');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-streaming-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { provider: 'streaming-facts-test', model: 'stream-model',
    agentMode, permissionMode: 'full-access', effort: 'high' });
  const views: ClientSessionView[] = [];
  const observation = await client.sessions.observe(session.id, view => views.push(view));
  let runId: string | undefined;
  let completed = false;
  try {
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'stream', text: 'Read fixture.txt and finish.' });
    runId = accepted.runId;
    await expect.poll(() => views.at(-1)?.activity?.streaming, { timeout: 15_000 }).toMatchObject({ kind: 'thinking', charCount: thought.length });
    const thinking = views.at(-1)!.activity!.streaming!;
    expect(thinking.providerRequestId).toBeTruthy();
    if (thinking.kind !== 'thinking') throw new Error('Expected a thinking item');
    expect(views.at(-1)!.items.find(item => item.id === thinking.itemId)?.text).toBe(thought);
    releaseThinking();
    await expect.poll(() => views.at(-1)?.activity?.streaming).toEqual({ kind: 'tool-input',
      providerRequestId: thinking.providerRequestId, toolName: 'read', callId: 'read-fixture', charCount: toolInput.length });
    expect(JSON.stringify(views.at(-1)?.activity?.streaming)).not.toContain('fixture.txt');
    releaseTool();
    expect(await client.runs.await(runId!)).toMatchObject({ phase: 'completed' });
    completed = true;
    await expect.poll(() => views.at(-1)?.activity?.streaming).toBeUndefined();
  } finally {
    releaseThinking(); releaseTool(); observation.close();
    if (runId && !completed) await client.sessions.cancel({ sessionId: session.id, expectedRunId: runId, requestId: 'cleanup-stream' });
    await client.disconnect(); await host.close(); await runtime.close();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    registerCustomProviders([]); vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => providerServer.close(error => error ? reject(error) : resolve()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
