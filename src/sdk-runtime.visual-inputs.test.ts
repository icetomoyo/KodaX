import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { afterEach, expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, registerCustomProviders } from '@kodax-ai/llm';
import { createSessionVisualObservationOwner } from '@kodax-ai/coding';
import { readVisualObservationRecord, sessionVisualMediaDirectory } from '@kodax-ai/agent/media';
import { FileSessionStorage } from '@kodax-ai/repl';
import { setKodaXDiagnosticSink } from '@kodax-ai/agent';
import { prepareRuntimeVisualInput } from './runtime-visual-input.js';
import { withProductExecution } from './product-execution-authorization.js';
import { createKodaXRuntime } from './sdk-runtime.js';

afterEach(() => { clearRuntimeModelProviders(); registerCustomProviders([]); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each<{ restart: boolean; toolRead: boolean; batch: boolean; delivery: 'after_turn' | 'steer' | 'redirect'; withdraw?: boolean; failedDelivery?: 'before' | 'after'; freshLease?: boolean; damage?: 'missing' | 'hash'; largeUpload?: boolean; dropSteer?: boolean }>([
  { restart: false, toolRead: false, batch: false, delivery: 'after_turn' as const, withdraw: false },
  { restart: true, toolRead: false, batch: false, delivery: 'after_turn' as const, withdraw: false },
  { restart: false, toolRead: true, batch: false, delivery: 'after_turn' as const, withdraw: false },
  { restart: true, toolRead: false, batch: true, delivery: 'after_turn' as const, withdraw: false },
  { restart: false, toolRead: true, batch: false, delivery: 'steer' as const, withdraw: false },
  { restart: false, toolRead: false, batch: false, delivery: 'redirect' as const, withdraw: false },
  { restart: true, toolRead: false, batch: false, delivery: 'after_turn' as const, withdraw: true },
  { restart: false, toolRead: false, batch: false, delivery: 'after_turn', failedDelivery: 'after' },
  { restart: false, toolRead: true, batch: false, delivery: 'after_turn', failedDelivery: 'before' },
  { restart: true, toolRead: false, batch: false, delivery: 'after_turn', freshLease: true },
  { restart: false, toolRead: true, batch: false, delivery: 'after_turn', damage: 'missing' },
  { restart: false, toolRead: true, batch: false, delivery: 'after_turn', damage: 'hash' },
  { restart: true, toolRead: false, batch: false, delivery: 'after_turn', largeUpload: true },
  { restart: true, toolRead: false, batch: false, delivery: 'steer', dropSteer: true },
])(
  'pins $delivery bytes before acknowledgement; restart=$restart read=$toolRead batch=$batch withdraw=$withdraw failure=$failedDelivery lease=$freshLease damage=$damage large=$largeUpload drop=$dropSteer', async ({ restart, toolRead, batch, delivery, withdraw, failedDelivery, freshLease, damage, largeUpload, dropSteer }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-queued-visual-'));
  const source = path.join(homeDir, 'queued.png');
  const png = await new Jimp({ width: 2, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
  const original = largeUpload ? Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]) : png;
  const replacement = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png');
  await writeFile(source, original);
  const readSource = path.join(homeDir, 'tool.png');
  if (toolRead) await writeFile(readSource, await new Jimp({ width: 2, height: 2, color: 0x0000ffff }).getBuffer('image/png'));
  let entered!: () => void; let release!: () => void; let turns = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wires: unknown[] = [];
  const queueErrors: string[] = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    if (diagnostic.source.startsWith('runtime.input')) queueErrors.push(`${diagnostic.message} ${JSON.stringify(diagnostic.detail)}`);
  });
  vi.stubEnv('KODAX_QUEUED_VISUAL_TEST', 'offline-only');
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://queued-visual.invalid/')) throw new Error('Unexpected external request in queued-image fixture.');
    const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.text() : undefined;
    if (!body) throw new Error('Missing SDK request body.');
    const wire = JSON.parse(body) as { stream?: boolean; tools?: { function?: { name: string } }[] };
    wires.push(wire);
    const firstRoot = wire.tools?.some(tool => tool.function?.name === 'todo_update') && turns++ === 0;
    if (firstRoot) {
      if (delivery === 'redirect') init?.signal?.addEventListener('abort', () => { writeFileSync(source, replacement); release(); }, { once: true });
      entered(); await gate;
    }
    if (!wire.stream) return Response.json({ choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }] });
    const chunks = toolRead && firstRoot ? [
      { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'read-after-queue', type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ path: readSource }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ] : [{ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
    const sse = chunks.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const open = () => createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'openai', defaultModel: 'fixture' });
  let runtime = await open();
  let lease = 'old-lease';
  const accept = (input: Parameters<typeof runtime.runs.acceptInput>[0]) => withProductExecution(freshLease
    ? { principalId: 'visual-client', key: lease, bindRun: async value => ({ ...value, origin: { principalId: 'visual-client' } }) }
    : undefined, () => runtime.runs.acceptInput(input));
  try {
    await runtime.catalog.upsertCustomProvider({ name: 'queued-visual', protocol: 'openai', model: 'fixture', imageInput: true,
      baseUrl: 'https://queued-visual.invalid', apiKeyEnv: 'KODAX_QUEUED_VISUAL_TEST' });
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { provider: 'queued-visual', model: 'fixture', permissionMode: 'full-access', workMode: 'coding' });
    const active = await accept({ sessionId: session.id, inputId: 'active', text: 'Wait for the next input.' });
    await started;
    const input = { sessionId: session.id, inputId: 'queued-image', delivery, text: 'Remember the queued green image.',
      ...(delivery !== 'after_turn' ? { targetRunId: active.runId! } : {}),
      inputArtifacts: [{ kind: 'image' as const, path: source, mediaType: 'image/png' as const }] };
    const second = { ...input, inputId: 'queued-image-2', text: 'Compare this second image.' };
    if (batch) await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'queued-text', delivery: 'after_turn', text: 'First, a plain queued input.' });
    expect(['queued', 'submitted']).toContain((await accept(input)).state);
    if (batch) await runtime.runs.acceptInput(second);
    const sessionsDir = path.join(homeDir, '.kodax', 'sessions');
    const storage = new FileSessionStorage({ sessionsDir, configHome: path.join(homeDir, '.kodax') });
    const owner = createSessionVisualObservationOwner(storage, session.id, sessionVisualMediaDirectory(sessionsDir, session.id));
    const records = (await storage.load(session.id))!.extensionRecords?.flatMap(record => {
      const observation = readVisualObservationRecord(record); return observation ? [observation] : [];
    }) ?? [];
    expect(records).toHaveLength(batch ? 2 : 1);
    expect(records[0]!.source?.inputId).toBe(input.inputId);
    expect((await readFile(owner.imagePath(records[0]!))).equals(original)).toBe(true);
    if (delivery !== 'redirect') expect(await owner.list()).toEqual([]);
    await writeFile(source, replacement);
    if (dropSteer) {
      const closing = runtime.close(); release(); await closing; runtime = await open();
      await expect(accept(input)).rejects.toThrow(/unavailable/);
      expect(await owner.list()).toEqual([]);
      expect(JSON.stringify(wires)).not.toContain(original.toString('base64'));
      return;
    }
    if (damage) {
      if (damage === 'missing') await rm(owner.imagePath(records[0]!));
      else await writeFile(owner.imagePath(records[0]!), replacement);
      release(); await runtime.runs.await(active.runId!);
      await vi.waitFor(() => expect(queueErrors.join('\n')).toMatch(damage === 'missing' ? /missing/ : /hash mismatch/), { timeout: 5000 });
      expect((await owner.list()).some(item => item.source?.inputId === input.inputId)).toBe(false);
      expect(JSON.stringify(wires)).not.toContain(replacement.toString('base64'));
      return;
    }
    if (withdraw) {
      for (let index = 0; index < 4; index++) await runtime.runs.acceptInput({ sessionId: session.id, inputId: `extra-${index}`, delivery: 'after_turn', text: `Queued ${index}.` });
      await expect(runtime.runs.acceptInput({ ...input, inputId: 'over-capacity' })).rejects.toThrow(/limit/);
      const append = vi.spyOn(FileSessionStorage.prototype, 'appendSessionRecords').mockRejectedValueOnce(new Error('Receipt storage unavailable.'));
      await expect(runtime.runs.withdrawInput(session.id, input.inputId)).rejects.toThrow('Receipt storage unavailable.');
      expect((await runtime.runs.getInput(session.id, input.inputId))?.state).toBe('queued');
      expect(await owner.list()).toEqual([]);
      append.mockRestore();
      await runtime.runs.withdrawInput(session.id, input.inputId);
      const closing = runtime.close(); release(); await closing; runtime = await open();
      await expect(runtime.runs.acceptInput(input)).rejects.toThrow(/withdrawn/);
      expect(await owner.list()).toEqual([]);
      expect(JSON.stringify(wires)).not.toContain(original.toString('base64'));
      return;
    }
    expect(['queued', 'submitted']).toContain((await accept(input)).state);
    await expect(accept({ ...input, text: 'Different intent.' })).rejects.toThrow(/intent/);
    if (failedDelivery) {
      const save = FileSessionStorage.prototype.save;
      let injected = false;
      const failure = failedDelivery === 'after'
        ? vi.spyOn(FileSessionStorage.prototype, 'save').mockImplementation(async function (this: FileSessionStorage, id, data) {
          await save.call(this, id, data);
          if (data.messages.some(message => message.role === 'user' && message.inputId === input.inputId)) {
            injected = true; throw new Error('Delivery save ACK failed after commit.');
          }
        })
        : vi.spyOn(FileSessionStorage.prototype, 'appendSessionRecords').mockImplementation(async () => { injected = true; throw new Error('Delivery Run receipt unavailable.'); });
      release(); await runtime.runs.await(active.runId!);
      await vi.waitFor(() => expect(injected).toBe(true));
      failure.mockRestore();
      if (failedDelivery === 'before') expect((await owner.list()).some(item => item.source?.inputId === input.inputId)).toBe(false);
      else {
        expect((await owner.list()).some(item => item.source?.inputId === input.inputId)).toBe(true);
        await expect(runtime.runs.withdrawInput(session.id, input.inputId)).rejects.toThrow(/canonical history/);
        await runtime.runs.acceptInput(second);
        await writeFile(source, 'Mutable source is no longer an image.');
      }
      await runtime.runs.acceptInput(input);
    }
    if (restart) {
      await rm(source);
      const closing = runtime.close(); release(); await closing;
      runtime = await open();
      if (freshLease) {
        lease = 'fresh-lease';
        await expect(withProductExecution({ principalId: 'foreign', key: lease, bindRun: async value => value },
          () => runtime.runs.acceptInput(input))).rejects.toThrow(/principal/);
      }
      if (batch) await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'queued-text', delivery: 'after_turn', text: 'First, a plain queued input.' });
      await accept(input);
      if (batch) await runtime.runs.acceptInput(second);
    } else {
      release();
      const finished = await runtime.runs.await(active.runId!);
      expect((await storage.load(session.id))!.extensionRecords?.some(record => record.id === records[0]!.observationId)).toBe(true);
      if (!failedDelivery) expect(finished.error).toBeUndefined();
    }
    expect((await storage.load(session.id))!.extensionRecords?.some(record => record.id === records[0]!.observationId)).toBe(true);
    await vi.waitFor(async () => expect((await runtime.runs.getInput(session.id, input.inputId))?.state, queueErrors.join('\n')).toBe('submitted'), { timeout: 5000 });
    const delivered = await runtime.runs.getInput(session.id, input.inputId);
    expect((await runtime.runs.await(delivered!.runId!)).phase).toBe('completed');
    expect(JSON.stringify(wires.at(-1))).toContain(original.toString('base64'));
    if (failedDelivery !== 'after') expect(JSON.stringify(wires.at(-1))).not.toContain(replacement.toString('base64'));
    const visible = await owner.list();
    expect(visible.some(item => item.observationId === records[0]!.observationId)).toBe(true);
    if (failedDelivery === 'after') {
      await vi.waitFor(async () => expect((await runtime.runs.getInput(session.id, second.inputId))?.state).toBe('submitted'), { timeout: 5000 });
      await runtime.runs.await((await runtime.runs.getInput(session.id, second.inputId))!.runId!);
      expect((await owner.list()).some(item => item.source?.inputId === second.inputId)).toBe(true);
      expect(JSON.stringify(wires.at(-1))).toContain(replacement.toString('base64'));
    } else expect(visible).toHaveLength((toolRead ? 2 : 1) + (batch ? 1 : 0));
    if (batch) {
      expect((await runtime.runs.getInput(session.id, second.inputId))?.runId).toBe(delivered!.runId);
      await runtime.close(); runtime = await open();
      expect((await runtime.runs.acceptInput(second)).runId).toBe(delivered!.runId);
      expect((await owner.list()).map(value => value.observationId)).toEqual(records.map(value => value.observationId));
    }
  } finally { release(); await runtime.close(); restoreDiagnostics(); await rm(homeDir, { recursive: true, force: true }); }
}, 30_000);

it('keeps a newly committed delivery Run when an older Session snapshot is saved afterward', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-pending-visual-merge-'));
  const sessionsDir = path.join(homeDir, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir, configHome: homeDir });
  const source = path.join(homeDir, 'input.png');
  try {
    await writeFile(source, await new Jimp({ width: 1, height: 1, color: 0xff0000ff }).getBuffer('image/png'));
    const base = { title: 'pending', messages: [], gitRoot: homeDir };
    const options = { sessionId: 'visual-pending', inputId: 'queued', sessionsDir, productIntentDigest: 'same-intent', pending: true,
      content: [{ type: 'text' as const, text: 'Queued image.' }, { type: 'image' as const, path: source }] };
    const staged = await prepareRuntimeVisualInput({ ...options, session: base });
    await storage.save(options.sessionId, { ...base, extensionRecords: staged.records });
    const stale = (await storage.load(options.sessionId))!;
    const delivered = await prepareRuntimeVisualInput({ ...options, session: stale, runId: 'actual-delivery-run' });
    expect(await storage.appendSessionRecords(options.sessionId, delivered.records)).toBe(true);
    await storage.save(options.sessionId, stale);
    const current = (await storage.load(options.sessionId))!.extensionRecords!.find(record => record.type === 'input');
    expect(current?.data).toMatchObject({ runId: 'actual-delivery-run' });
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

it('rejects an image staged under a pre-existing canonical text input identity', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-input-collision-'));
  const sessionsDir = path.join(homeDir, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir, configHome: homeDir });
  const source = path.join(homeDir, 'input.png');
  try {
    await writeFile(source, await new Jimp({ width: 1, height: 1, color: 0x00ff00ff }).getBuffer('image/png'));
    await storage.save('collision', { title: 'Text identity', gitRoot: homeDir, messages: [{ role: 'user', inputId: 'old-input', content: 'An earlier plain text input.' }] });
    const session = (await storage.load('collision'))!;
    await expect(prepareRuntimeVisualInput({ sessionId: 'collision', inputId: 'old-input', sessionsDir, session, pending: true,
      content: [{ type: 'text', text: 'An earlier plain text input.' }, { type: 'image', path: source }] })).rejects.toThrow(/intent/);
    expect((await storage.load('collision'))?.extensionRecords ?? []).toEqual([]);
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

it('reuses a committed merged visual batch whose first input was plain text after a lost save acknowledgement', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-merged-retry-'));
  const sessionsDir = path.join(homeDir, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir, configHome: homeDir });
  const source = path.join(homeDir, 'input.png');
  try {
    await writeFile(source, await new Jimp({ width: 1, height: 1, color: 0x00ff00ff }).getBuffer('image/png'));
    const base = { title: 'Merged batch', gitRoot: homeDir, messages: [] };
    const content = [{ type: 'text' as const, text: 'Merged text and image.' }, { type: 'image' as const, path: source }];
    const staged = await prepareRuntimeVisualInput({ sessionId: 'merged', inputId: 'image-next', sessionsDir, session: base, content, pending: true });
    await storage.save('merged', { ...base, messages: [{ role: 'user', inputId: 'text-first', inputIds: ['text-first', 'image-next'], content: staged.content }], extensionRecords: staged.records });
    await rm(source);
    const session = (await storage.load('merged'))!;
    const retry = await prepareRuntimeVisualInput({ sessionId: 'merged', inputId: 'text-first', inputIds: ['text-first', 'image-next'], sessionsDir, session, content, runId: 'repaired-run' });
    expect(retry.content).toEqual(session.messages[0]!.content);
    expect(retry.records).toEqual([expect.objectContaining({ type: 'input', data: expect.objectContaining({ inputId: 'image-next', runId: 'repaired-run' }) })]);
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});
