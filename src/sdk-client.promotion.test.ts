import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { expect, it } from 'vitest';
import { FileSessionStorage } from '@kodax-ai/repl';
import type { KodaXSessionData } from '@kodax-ai/agent';
import { ensureKodaXClient, connectKodaXClient } from './sdk-client.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from './sdk-runtime.js';
import { readRuntimeDaemonState, resolveRuntimeDaemonPaths } from './runtime-daemon/state.js';

it('promotes a Quick Ask through its independent Host and preserves the Session identity', async () => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-promotion-'));
  const profile = 'promotion';
  let client = await ensureKodaXClient({ homeDir, profile });
  try {
    const session = await client.sessions.create({ title: 'Quick question', tag: 'quick-ask', projectPath: homeDir });
    await expect(client.sessions.promote({ sessionId: session.id, requestId: 'invalid',
      expectedRevision: 'not-a-revision', tag: 'coder' })).rejects.toMatchObject({ code: 'invalid_params' });
    const promoted = await client.sessions.promote({ sessionId: session.id, requestId: 'promote-first',
      expectedRevision: session.metadataRevision!, tag: 'coder' });
    expect(promoted).toMatchObject({ requestId: 'promote-first', session: {
      id: session.id, title: 'Quick question', tag: 'coder', msgCount: 0,
    } });
    expect(promoted.session.metadataRevision).not.toBe(session.metadataRevision);
    const peer = await connectKodaXClient({ homeDir, profile });
    try {
      expect(await peer.sessions.readPromotion(session.id, 'promote-first')).toEqual(promoted);
      expect(await peer.sessions.read(session.id)).toMatchObject(promoted.session);
      expect(await peer.sessions.promote({ sessionId: session.id, requestId: 'promote-first',
        expectedRevision: session.metadataRevision!, tag: 'coder' })).toEqual(promoted);
      await expect(peer.sessions.promote({ sessionId: session.id, requestId: 'promote-other',
        expectedRevision: session.metadataRevision!, tag: 'partner' })).rejects.toMatchObject({ code: 'conflict' });
      expect(await peer.sessions.readPromotion(session.id, 'promote-other')).toBeNull();
    } finally { await peer.disconnect(); }
    const originalOwner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
    if (!originalOwner) throw new Error('Missing isolated Host owner.');
    await client.host.shutdown();
    await client.disconnect();
    expect(await waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'),
      profile, owner: originalOwner })).toMatchObject({ status: 'succeeded' });
    client = await ensureKodaXClient({ homeDir, profile });
    expect(await client.sessions.readPromotion(session.id, 'promote-first')).toEqual(promoted);
    expect(await client.sessions.list({ tag: 'coder' })).toMatchObject([{ id: session.id, tag: 'coder' }]);
  } finally {
    const owner = (await getKodaXRuntimeOwnerState({ homeDir, profile })).owner;
    await client.host.shutdown();
    await client.disconnect();
    if (owner) expect(await waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'),
      profile, owner, timeoutMs: 30_000 })).toMatchObject({ status: 'succeeded' });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);

it('serializes peer promotion CAS and recovers a committed operation whose success response was lost', async () => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-promotion-response-'));
  const profile = 'promotion-response';
  const client = await ensureKodaXClient({ homeDir, profile });
  const peer = await connectKodaXClient({ homeDir, profile });
  try {
    const race = await client.sessions.create({ tag: 'quick-ask', projectPath: homeDir });
    const results = await Promise.allSettled([client.sessions.promote({ sessionId: race.id, requestId: 'race-a',
      expectedRevision: race.metadataRevision!, tag: 'coder' }), peer.sessions.promote({ sessionId: race.id, requestId: 'race-b',
      expectedRevision: race.metadataRevision!, tag: 'partner' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }]);
    for (const requestId of ['race-a', 'race-b']) {
      const committed = results.find(result => result.status === 'fulfilled' && result.value.requestId === requestId);
      expect(await client.sessions.readPromotion(race.id, requestId)).toEqual(committed?.status === 'fulfilled' ? committed.value : null);
    }
    const question = await client.sessions.create({ title: 'Unacknowledged question', tag: 'quick-ask', projectPath: homeDir });
    const state = readRuntimeDaemonState(resolveRuntimeDaemonPaths(homeDir, profile));
    if (!state) throw new Error('Missing isolated Host endpoint.');
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\kodax-promotion-drop-${randomUUID()}` : path.join(homeDir, 'drop.sock');
    const proxy = await dropPromotionResponse(state.endpoint, endpoint);
    const lossy = await connectKodaXClient({ homeDir, profile, endpoint });
    try {
      const request = { sessionId: question.id, requestId: 'lost-success', expectedRevision: question.metadataRevision!, tag: 'coder' };
      await expect(lossy.sessions.promote(request)).rejects.toThrow();
      expect(proxy.dropped()).toBe(true);
      const receipt = await client.sessions.readPromotion(question.id, request.requestId);
      expect(receipt).toMatchObject({ requestId: request.requestId, session: { id: question.id, title: question.title, tag: 'coder' } });
      expect(await client.sessions.promote(request)).toEqual(receipt);
    } finally { await lossy.disconnect(); await proxy.close(); }
  } finally {
    await peer.disconnect();
    const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
    await client.host.shutdown(); await client.disconnect();
    if (owner) expect(await waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'), profile, owner })).toMatchObject({ status: 'succeeded' });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);

/** Drop the actual successful frame, after the independent Host has committed it. */
async function dropPromotionResponse(target: string, endpoint: string) {
  const sockets = new Set<Socket>();
  let dropped = false;
  const server = createServer(downstream => {
    const upstream = createConnection(target);
    sockets.add(downstream); sockets.add(upstream);
    const inputDecoder = new StringDecoder('utf8');
    const outputDecoder = new StringDecoder('utf8');
    let input = '', output = '';
    let requestId: unknown;
    downstream.on('data', (chunk: Buffer) => {
      input += inputDecoder.write(chunk);
      let end: number;
      while ((end = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.method === 'session.promote') requestId = frame.id;
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      output += outputDecoder.write(chunk);
      let end: number;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (requestId !== undefined && frame.id === requestId && frame.result !== undefined) {
          dropped = true; downstream.destroy(); upstream.destroy(); return;
        }
        downstream.write(`${line}\n`);
      }
    });
    downstream.on('close', () => { sockets.delete(downstream); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  return { dropped: () => dropped, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

it('rejects a new promotion while busy but returns an already committed receipt without another write', async () => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-promotion-busy-'));
  const profile = 'promotion-busy';
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ customProviders: [{
    name: 'promotion-fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1',
    apiKeyEnv: 'KODAX_PROMOTION_UNUSED_KEY', model: 'fixture',
  }] }));
  let holding = false;
  let release = () => {};
  let leaseId: string | undefined;
  let credentialId: string | undefined;
  const runIds: string[] = [];
  const client = await ensureKodaXClient({ homeDir, profile, async authorizeExecution(_request, services) {
    credentialId ??= (await services.credentials.registerScoped({ providers: ['promotion-fixture'] }, async () => 'fixture-only')).id;
    leaseId ??= (await services.hostTools.register([{ name: 'hold_promotion', description: 'Hold a fixture operation.',
      inputSchema: { type: 'object', properties: {} }, sideEffect: 'none' }], {
      async hold_promotion() {
        holding = true;
        await new Promise<void>(resolve => { release = resolve; });
        holding = false;
        return { content: 'Fixture released.' };
      },
    })).id;
    return { credential: { mode: 'scoped', leaseId: credentialId, providers: ['promotion-fixture'] }, hostTools: { leaseId } };
  } });
  try {
    const session = await client.sessions.create({ title: 'Busy question', tag: 'quick-ask', projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { permissionMode: 'full-access', provider: 'promotion-fixture', model: 'fixture' });
    const request = { sessionId: session.id, requestId: 'promote-busy', expectedRevision: session.metadataRevision!, tag: 'coder' };
    const first = await client.runs.startTool({ sessionId: session.id, inputId: 'hold-first', rawInput: 'Hold first.', name: 'hold_promotion', input: {} });
    runIds.push(first.runId);
    await expect.poll(() => holding, { timeout: 10_000 }).toBe(true);
    await expect(client.sessions.promote(request)).rejects.toMatchObject({ code: 'conflict' });
    expect(await client.sessions.readPromotion(session.id, request.requestId)).toBeNull();
    expect(await client.sessions.read(session.id)).toMatchObject({ tag: 'quick-ask' });
    release();
    expect((await client.runs.await(first.runId)).phase).toBe('completed');
    const committed = await client.sessions.promote(request);
    const second = await client.runs.startTool({ sessionId: session.id, inputId: 'hold-second', rawInput: 'Hold second.', name: 'hold_promotion', input: {} });
    runIds.push(second.runId);
    await expect.poll(() => holding, { timeout: 10_000 }).toBe(true);
    expect(await client.sessions.promote(request)).toMatchObject({ requestId: request.requestId, session: {
      id: session.id, tag: 'coder', metadataRevision: committed.session.metadataRevision,
    } });
    release();
    expect((await client.runs.await(second.runId)).phase).toBe('completed');
  } finally {
    release();
    for (const runId of runIds) await client.runs.await(runId);
    const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
    await client.host.shutdown(); await client.disconnect();
    if (owner) expect(await waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'), profile, owner })).toMatchObject({ status: 'succeeded' });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);

it('keeps crashed canonical/native history and attachments intact and gives forks their own promotion identity', async () => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-promotion-history-'));
  const profile = 'promotion-history';
  const configHome = path.join(homeDir, '.kodax');
  const storage = new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome });
  const id = 'promotion-history';
  const data: KodaXSessionData = { title: 'Retained answer', gitRoot: homeDir, tag: 'quick-ask',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Original question' },
      { type: 'image', path: path.join(homeDir, 'original.png'), mediaType: 'image/png' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'unresolved-call', name: 'read', input: { path: 'original.txt' } }],
      nativeHistory: { version: 1, id: 'native-original', source: { provider: 'anthropic', api: 'anthropic-messages', model: 'fixture' },
        inputDigest: 'input', outputDigest: 'output', append: [{ role: 'user', content: 'Original question' }],
        output: [{ type: 'tool_use', id: 'unresolved-call', name: 'read', input: { path: 'original.txt' } }],
        requested: { system: 'system', tools: 'tools' } } }],
    artifactLedger: [{ id: 'attachment', kind: 'image_input', target: path.join(homeDir, 'original.png'), timestamp: '2026-11-02T00:00:00Z' }],
    errorMetadata: { consecutiveErrors: 1, lastError: 'Interrupted fixture' } };
  await storage.save(id, data);
  const client = await ensureKodaXClient({ homeDir, profile });
  try {
    const before = await storage.read(id);
    expect(before?.messages[1]?.nativeHistory).toEqual(data.messages[1]!.nativeHistory);
    const session = await client.sessions.read(id);
    const statistics = await client.statistics.read(id);
    await client.sessions.promote({ sessionId: id, requestId: 'original-promotion', expectedRevision: session.metadataRevision!, tag: 'coder' });
    const after = await storage.read(id);
    for (const key of ['messages', 'lineage', 'artifactLedger', 'errorMetadata', 'lastMessageAt'] as const) {
      expect(after?.[key], key).toEqual(before?.[key]);
    }
    expect(await client.statistics.read(id)).toEqual(statistics);
    const fork = await client.sessions.forkSession(id);
    expect(await client.sessions.readPromotion(fork.id, 'original-promotion')).toBeNull();
    await expect(client.sessions.promote({ sessionId: fork.id, requestId: 'fork-promotion',
      expectedRevision: fork.metadataRevision!, tag: 'partner' })).resolves.toMatchObject({ session: { id: fork.id, tag: 'partner' } });
  } finally {
    const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
    await client.host.shutdown(); await client.disconnect();
    if (owner) expect(await waitForRuntimeDaemonShutdown({ configHome, profile, owner })).toMatchObject({ status: 'succeeded' });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
