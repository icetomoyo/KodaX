import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerCustomProviders } from '@kodax-ai/llm';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { createClassicPlaneDisplayDiffer } from '../packages/repl/src/interactive/classic-plane-display.js';
import { clientViewToHistoryItems } from '../packages/repl/src/ui/client-plane.js';
import { connectKodaXClient } from './sdk-client.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it.each([
  { agentMode: 'sa', continuation: false }, { agentMode: 'ama', continuation: false },
  { agentMode: 'sa', continuation: true }, { agentMode: 'ama', continuation: true },
] as const)('preserves $agentMode outputs through HTTP, IPC, commit and restart (continuation=$continuation)', async ({ agentMode, continuation }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-output-owner-'));
  const answer = 'Report\n\n```js\nexample\n```\n\nEnd';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  let answerCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: { function?: { name?: string } }[] };
    const verifier = body.tools?.some(tool => tool.function?.name === 'emit_sidecar_verdict');
    if (!verifier) answerCalls++;
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (content: string, finish: string | null = null) => response.write(`data: ${JSON.stringify({
      id: 'ownership-fixture', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content }, finish_reason: finish }],
    })}\n\n`);
    const firstPart = continuation && !verifier && answerCalls === 1;
    const textChunks = firstPart ? ['Report\n\n'] : continuation && !verifier
      ? ['```js\n', 'example\n', '```\n\n', 'End'] : ['Report\n\n', '```js\n', 'example\n', '```\n\n', 'End'];
    for (const chunk of textChunks) send(chunk);
    await gate;
    send('', firstPart ? 'length' : 'stop'); response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  await mkdir(path.join(homeDir, '.kodax'));
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ customProviders: [{
    name: 'output-owner-test', protocol: 'openai', model: 'fixture', apiKeyEnv: 'KODAX_OUTPUT_OWNER_TEST_KEY',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  }] }));
  vi.stubEnv('KODAX_OUTPUT_OWNER_TEST_KEY', 'test-only');
  vi.stubEnv('KODAX_MAX_OUTPUT_TOKENS', '32000');
  const startHost = async () => {
    const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
    const paths = resolveRuntimeDaemonPaths(homeDir);
    const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId,
      pid: process.pid, createdAt: runtime.identity.startedAt });
    if (!lock) throw new Error('Isolated Host lock unavailable');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-output-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, `host-${randomUUID()}.sock`) };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
    return { runtime, host, client };
  };
  let active = await startHost();
  let closeObservation: (() => void) | undefined;
  let runId: string | undefined;
  let sessionId: string | undefined;
  let completed = false;
  try {
    const session = await active.client.sessions.create({ projectPath: homeDir });
    sessionId = session.id;
    await active.client.sessions.updateSettings(session.id, { provider: 'output-owner-test', model: 'fixture',
      agentMode, permissionMode: 'full-access' });
    const views: ClientSessionView[] = [];
    const writes: string[] = [];
    const display = createClassicPlaneDisplayDiffer(text => writes.push(text),
      (id, options) => active.client.sessions.readItem(session.id, id, options));
    let printing = Promise.resolve();
    const observe = async () => active.client.sessions.observe(session.id, view => {
      views.push(view);
      printing = printing.then(() => display(view.items));
    });
    closeObservation = (await observe()).close;
    runId = (await active.client.inputs.submit({ sessionId: session.id, inputId: 'output-owner', text: 'Return the scripted report.' })).runId;
    await expect.poll(() => views.at(-1)?.items.find(item => item.type === 'assistant')?.text, { timeout: 15_000 }).toBe(continuation ? 'Report\n\n' : answer);
    const liveId = views.at(-1)!.items.find(item => item.type === 'assistant')!.id;
    release();
    expect(await active.client.runs.await(runId!)).toMatchObject({ phase: 'completed' });
    completed = true;
    await expect.poll(() => views.at(-1)?.runs.find(run => run.runId === runId)?.phase).toBe('completed');
    const replies = views.at(-1)!.items.filter(item => item.type === 'assistant');
    const expectedTexts = continuation && agentMode === 'sa' ? ['Report\n\n', '```js\nexample\n```\n\nEnd'] : [answer];
    expect(replies.map(item => item.text)).toEqual(expectedTexts);
    expect(replies[0]?.id).toBe(liveId);
    expect(new Set(replies.map(item => item.id)).size).toBe(expectedTexts.length);
    expect(clientViewToHistoryItems(views.at(-1)!.items).filter(item => item.type === 'assistant')).toHaveLength(expectedTexts.length);
    for (const reply of replies) expect(await active.client.sessions.readItem(session.id, reply.id)).toMatchObject({ text: reply.text });
    await printing;
    expect(writes.filter(text => text.startsWith('assistant:')).map(text => text.slice('assistant:'.length)).join('')).toBe(answer);
    const callsBeforeRestart = calls;
    closeObservation(); await active.client.disconnect(); await active.host.close(); await active.runtime.close();
    active = await startHost();
    closeObservation = (await observe()).close;
    await printing;
    expect(views.at(-1)!.items.filter(item => item.type === 'assistant').map(item => [item.id, item.text]))
      .toEqual(replies.map(item => [item.id, item.text]));
    expect(writes.filter(text => text.startsWith('assistant:')).map(text => text.slice('assistant:'.length)).join('')).toBe(answer);
    expect(answerCalls).toBe(continuation ? 2 : 1);
    expect(calls).toBe(callsBeforeRestart);
  } finally {
    release(); closeObservation?.();
    if (runId && sessionId && !completed) await active.client.sessions.cancel({ sessionId, expectedRunId: runId, requestId: 'cleanup' });
    await active.client.disconnect(); await active.host.close(); await active.runtime.close();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    registerCustomProviders([]); vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 45_000);
