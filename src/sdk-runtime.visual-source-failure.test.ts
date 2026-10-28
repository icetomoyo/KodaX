import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { FileSessionStorage } from '@kodax-ai/repl';
import { createKodaXRuntime } from './sdk-runtime.js';
import { NATIVE_PROVIDER_CAPABILITY_PROFILE } from '../packages/llm/src/providers/capability-profile.js';
import { readVisualObservationRecord } from '@kodax-ai/agent/media';
import { readFile } from 'node:fs/promises';
import { createSessionVisualObservationOwner } from '@kodax-ai/coding';
import { sessionVisualMediaDirectory } from '@kodax-ai/agent/media';

it('never publishes a provisional read receipt when its tool-result commit fails', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-result-failure-'));
  const source = path.join(homeDir, 'source.png');
  await writeFile(source, await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png'));
  vi.stubEnv('KODAX_VISUAL_RESULT_FAILURE', 'offline');
  let calls = 0;
  class Provider extends KodaXBaseProvider {
    readonly name = 'visual-failure'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_VISUAL_RESULT_FAILURE', model: 'fixture', supportsThinking: false };
    async stream(): Promise<KodaXStreamResult> {
      if (calls++ === 0) return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'read', name: 'read', input: { path: source } }], stopReason: 'tool_use' };
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('visual-failure', () => new Provider());
  const save = FileSessionStorage.prototype.save;
  const failure = vi.spyOn(FileSessionStorage.prototype, 'save').mockImplementation(function (this: FileSessionStorage, id, data) {
    if (data.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'))) {
      return Promise.reject(new Error('Injected tool result commit failure.'));
    }
    return save.call(this, id, data);
  });
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'visual-failure', defaultModel: 'fixture' });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', workMode: 'coding' });
    const input = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'read-source', text: 'Read the image.' });
    expect((await runtime.runs.await(input.runId!)).phase).toBe('failed');
    const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
    expect((await storage.load(session.id))!.extensionRecords?.filter(record => record.extensionId === 'kodax.visual') ?? []).toEqual([]);
  } finally { failure.mockRestore(); await runtime.close(); clearRuntimeModelProviders(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true }); }
}, 30_000);

it('recovers a committed Script leaf image after outer cell settlement fails before returning it', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-leaf-recovery-'));
  const source = path.join(homeDir, 'source.png');
  const bytes = await new Jimp({ width: 2, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
  await writeFile(source, bytes); vi.stubEnv('KODAX_VISUAL_RESULT_FAILURE', 'offline');
  let recovering = false; let turn = 0; let observationId = ''; let scriptCalls = 0;
  let recalledPath: string | undefined; let lastToolContent = '';
  class Provider extends KodaXBaseProvider {
    readonly name = 'visual-leaf-failure'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_VISUAL_RESULT_FAILURE', model: 'fixture', supportsThinking: false,
      capabilityProfile: { ...NATIVE_PROVIDER_CAPABILITY_PROFILE, multimodalSupport: 'image-input' } };
    async stream(messages: import('@kodax-ai/llm').KodaXMessage[], tools: import('@kodax-ai/llm').KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      if (tools.some(tool => tool.name === 'todo_update') && turn++ === 0) {
        if (!recovering) scriptCalls++;
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: recovering
          ? [{ type: 'tool_use', id: 'inspect', name: 'visual_inspect', input: { question: 'Recall the settled leaf.', views: [{ label: 'leaf', observationId }] } }]
          : [{ type: 'tool_use', id: 'cell', name: 'script_exec', input: { code: `return await tools.read({path:${JSON.stringify(source)}});` } }] };
      }
      for (const message of messages) if (Array.isArray(message.content)) for (const block of message.content) {
        if (block.type === 'tool_result') lastToolContent = JSON.stringify(block.content);
        if (block.type === 'tool_result' && Array.isArray(block.content)) recalledPath ??= block.content.find(item => item.type === 'image')?.path;
      }
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('visual-leaf-failure', () => new Provider());
  const save = FileSessionStorage.prototype.save;
  const failure = vi.spyOn(FileSessionStorage.prototype, 'save').mockImplementation(function (this: FileSessionStorage, id, data) {
    if (data.extensionRecords?.some(record => record.extensionId === 'kodax.script' && record.type === 'cell.settled')) {
      return Promise.reject(new Error('Injected outer cell interruption.'));
    }
    return save.call(this, id, data);
  });
  let runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'visual-leaf-failure', defaultModel: 'fixture' });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', workMode: 'script' });
    const first = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'script-source', text: 'Read the source in a cell.' });
    expect((await runtime.runs.await(first.runId!)).phase).toBe('failed');
    failure.mockRestore(); await runtime.close();
    const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
    const saved = (await storage.load(session.id))!;
    expect(saved.extensionRecords?.some(record => record.extensionId === 'kodax.script' && record.type === 'call.settled')).toBe(true);
    const observations = saved.extensionRecords!.flatMap(record => { const value = readVisualObservationRecord(record); return value ? [value] : []; });
    expect(observations).toHaveLength(1); observationId = observations[0]!.observationId;
    const owner = createSessionVisualObservationOwner(storage, session.id, sessionVisualMediaDirectory(path.join(homeDir, '.kodax', 'sessions'), session.id));
    expect(await owner.list()).toHaveLength(1);
    const priorLeaf = saved.lineage!.activeEntryId!;
    const userEntry = saved.lineage!.entries.find(entry => entry.type === 'message' && entry.message.inputId === 'script-source')!;
    await storage.setActiveEntry(session.id, userEntry.id);
    expect(await owner.list()).toEqual([]);
    await storage.setActiveEntry(session.id, priorLeaf);
    await writeFile(source, 'The mutable source no longer contains an image.');
    recovering = true; turn = 0;
    runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'visual-leaf-failure', defaultModel: 'fixture' });
    const next = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'recall-leaf', text: 'Recall the committed leaf without replay.' });
    expect((await runtime.runs.await(next.runId!)).phase).toBe('completed');
    expect(recalledPath, lastToolContent).toBeDefined();
    expect(await readFile(recalledPath!)).toEqual(bytes);
    expect(scriptCalls).toBe(1);
  } finally { failure.mockRestore(); await runtime.close(); clearRuntimeModelProviders(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true }); }
}, 30_000);
