import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, createCustomProvider, registerModelProvider, type KodaXMessage } from '@kodax-ai/llm';
import { NATIVE_PROVIDER_CAPABILITY_PROFILE } from '../packages/llm/src/providers/capability-profile.js';
import { createSessionManager, FileSessionStorage } from '@kodax-ai/repl';
import { Jimp } from 'jimp';
import { evictOldIslandMessageContent, persistCompactedSessionHistory } from '@kodax-ai/agent';
import { sessionVisualMediaDirectory } from '@kodax-ai/agent/media';
import { createKodaXRuntime } from './sdk-runtime.js';

afterEach(() => { clearRuntimeModelProviders(); vi.unstubAllEnvs(); });

it('recalls the accepted user image through Runtime, native inspect and the real serializer after restart', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-runtime-'));
  const source = path.join(homeDir, 'input.png');
  const PNG = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png');
  await writeFile(source, PNG);
  vi.stubEnv('KODAX_VISUAL_TEST_KEY', 'offline-only');
  const wires: unknown[] = [];
  let observationId = '';
  let turn = 0;
  registerModelProvider('visual-fixture', () => {
    const provider = createCustomProvider({ name: 'visual-fixture', protocol: 'openai', model: 'fixture',
      apiKeyEnv: 'KODAX_VISUAL_TEST_KEY', imageInput: true, baseUrl: 'https://visual-fixture.invalid',
      capabilityProfile: { ...NATIVE_PROVIDER_CAPABILITY_PROFILE } });
    Reflect.set(provider, '_client', { chat: { completions: { create: async (wire: unknown) => {
      wires.push(wire);
      return { choices: [{ message: { content: 'Serialized.' }, finish_reason: 'stop' }] };
    } } } });
    provider.stream = async (messages, tools, system) => {
      if (!tools.some(tool => tool.name === 'todo_update')) return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
      await provider.complete(messages, tools, system);
      expect(tools.map(tool => tool.name)).toContain('visual_inspect');
      observationId ||= JSON.stringify(messages).match(/obs_[a-f0-9-]+/)?.[0] ?? '';
      expect(observationId).not.toBe('');
      if (turn++ === 0) return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'repeated-id', name: 'visual_inspect',
        input: { question: 'Recall the original.', views: [{ label: 'original', observationId }] } }], stopReason: 'tool_use' };
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    };
    return provider;
  });
  let runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'visual-fixture', defaultModel: 'fixture' });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir, draft: true });
    await runtime.sessions.updateSettings(session.id, { provider: 'visual-fixture', model: 'fixture', permissionMode: 'full-access', workMode: 'coding' });
    const input = { sessionId: session.id, inputId: 'first-image', text: 'Remember this image.',
      inputArtifacts: [{ kind: 'image' as const, path: source, mediaType: 'image/png' as const }] };
    const settingsDirectory = path.join(homeDir, '.kodax', 'runtime', 'profiles', 'default', 'session-settings');
    await (await import('node:fs/promises')).mkdir(path.dirname(settingsDirectory), { recursive: true });
    await writeFile(settingsDirectory, 'Block settings promotion after the canonical image save.');
    await expect(runtime.runs.acceptInput(input)).rejects.toThrow();
    expect(await runtime.runs.list({ sessionId: session.id })).toEqual([]);
    await rm(settingsDirectory);
    await writeFile(source, 'Changed between failed promotion and restart.');
    await runtime.close();
    runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'visual-fixture', defaultModel: 'fixture' });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', workMode: 'coding' });
    const accepted = await runtime.runs.acceptInput(input);
    const canonical = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
    const acceptedInput = (await canonical.load(session.id))!.messages.find(message => message.inputId === input.inputId)!;
    expect(Array.isArray(acceptedInput.content) && acceptedInput.content.find(block => block.type === 'image')?.path).not.toBe(source);
    const completed = await runtime.runs.await(accepted.runId!);
    expect(completed.error).toBeUndefined();
    expect(completed).toMatchObject({ phase: 'completed' });
    expect(JSON.stringify(wires.at(-1))).toContain(PNG.toString('base64'));
    await writeFile(source, 'The source has been replaced.');
    await runtime.close();
    const beforeCompaction = (await canonical.load(session.id))!;
    const summary = `Continue the visual task using ${observationId}.`;
    await persistCompactedSessionHistory({ storage: canonical, sessionId: session.id,
      compactedMessages: [{ role: 'system', content: `[对话历史摘要]\n\n${summary}` }],
      update: { preCompactionMessages: beforeCompaction.messages,
        anchor: { summary, tokensBefore: 100, tokensAfter: 20, entriesRemoved: beforeCompaction.messages.length, reason: 'manual' } } });
    const compacted = (await canonical.load(session.id))!;
    await canonical.save(session.id, { ...compacted, lineage: evictOldIslandMessageContent(compacted.lineage!) });
    runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'visual-fixture', defaultModel: 'fixture' });
    turn = 0;
    const retried = await runtime.runs.acceptInput(input);
    expect(retried.runId).toBe(accepted.runId);
    expect((await runtime.runs.await(retried.runId!)).phase).toBe('completed');
    const resumed = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'recall-after-restart', text: 'Recall the accepted image.' });
    expect((await runtime.runs.await(resumed.runId!)).phase).toBe('completed');
    expect(JSON.stringify(wires.at(-1))).toContain(PNG.toString('base64'));
    await expect(runtime.runs.acceptInput({ ...input, text: 'A different intent.' })).rejects.toThrow(/different intent/i);
    const storage = createSessionManager({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
    const saved = await storage.loadSession(session.id);
    const fullLineage = await canonical.loadFullLineage(session.id);
    const images = fullLineage!.entries.flatMap(entry => entry.type === 'message' && entry.message.inputId === input.inputId ? [entry.message] : [])
      .flatMap((message: KodaXMessage) => Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'image') : []);
    expect(images).toHaveLength(1);
    expect(await readFile(images[0]!.path)).toEqual(PNG);
    expect(saved!.extensionRecords?.filter(record => record.extensionId === 'kodax.visual' && record.type === 'observation')).toHaveLength(1);
    const receipt = saved!.extensionRecords!.find(record => record.extensionId === 'kodax.visual' && record.type === 'input');
    expect(receipt?.data).toMatchObject({ runId: accepted.runId });
    const child = await runtime.sessions.fork({ sessionId: session.id, title: 'Inherited input identity' });
    expect(child).not.toBeNull();
    await expect(runtime.runs.acceptInput({ ...input, sessionId: child!.id, text: 'Changed intent under inherited image input ID.' })).rejects.toThrow(/inherited|different intent/i);
    await expect(runtime.runs.acceptInput({ ...input, sessionId: child!.id })).rejects.toThrow(/inherited/i);
    await runtime.sessions.archive(session.id);
    expect(await readFile(images[0]!.path)).toEqual(PNG);
    await runtime.sessions.delete(session.id);
    await expect(readFile(images[0]!.path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await runtime.close(); await rm(homeDir, { recursive: true, force: true }); }
}, 30_000);

it('does not acknowledge an image when its canonical receipt save fails', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-save-failure-'));
  const source = path.join(homeDir, 'input.png');
  await writeFile(source, await new Jimp({ width: 2, height: 2, color: 0x00ff00ff }).getBuffer('image/png'));
  const runtime = await createKodaXRuntime({ homeDir, mode: 'embedded', defaultProvider: 'anthropic' });
  const save = FileSessionStorage.prototype.save;
  const failure = vi.spyOn(FileSessionStorage.prototype, 'save').mockImplementation(function (this: FileSessionStorage, id, data) {
    if (data.extensionRecords?.some(record => record.extensionId === 'kodax.visual')) return Promise.reject(new Error('Injected canonical save failure.'));
    return save.call(this, id, data);
  });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir, draft: true });
    await expect(runtime.runs.acceptInput({ sessionId: session.id, inputId: 'failed-image', text: 'Accept this image.',
      inputArtifacts: [{ kind: 'image', path: source }] })).rejects.toThrow('Injected canonical save failure');
    const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
    expect((await storage.load(session.id))?.extensionRecords ?? []).toEqual([]);
    expect(await runtime.runs.list({ sessionId: session.id })).toEqual([]);
    const mediaDirectory = sessionVisualMediaDirectory(path.join(homeDir, '.kodax', 'sessions'), session.id);
    expect(await readdir(mediaDirectory)).toHaveLength(1);
    await runtime.sessions.delete(session.id);
    await expect(readdir(mediaDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { failure.mockRestore(); await runtime.close(); await rm(homeDir, { recursive: true, force: true }); }
});
