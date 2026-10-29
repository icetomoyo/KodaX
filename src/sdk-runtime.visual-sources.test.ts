import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, createCustomProvider, registerModelProvider } from '@kodax-ai/llm';
import { NATIVE_PROVIDER_CAPABILITY_PROFILE } from '../packages/llm/src/providers/capability-profile.js';
import { createSessionManager, FileSessionStorage } from '@kodax-ai/repl';
import { createKodaXRuntime } from './sdk-runtime.js';

const cases = (['coding', 'agent', 'script'] as const).flatMap(workMode =>
  (['openai', 'anthropic'] as const).flatMap(protocol => [false, true].map(bridge => ({ workMode, protocol, bridge }))));

it.each(cases)('pins read bytes before delivery and inspects a region: $workMode/$protocol bridge=$bridge', async ({ workMode, protocol, bridge }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-source-'));
  const firstPath = path.join(homeDir, 'first.png'); const secondPath = path.join(homeDir, 'second.png');
  const original = await new Jimp({ width: 2, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
  const other = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png');
  const expectedCrop = await new Jimp({ width: 1, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
  await writeFile(firstPath, original); await writeFile(secondPath, other);
  vi.stubEnv('KODAX_VISUAL_SOURCE_TEST', 'offline-only');
  const wires: unknown[] = [];
  let ids: string[] = []; let turn = 0; let leafReceiptPinned = false;
  const save = FileSessionStorage.prototype.save;
  const saveSpy = vi.spyOn(FileSessionStorage.prototype, 'save').mockImplementation(async function (this: FileSessionStorage, id, data) {
    await save.call(this, id, data);
    if (workMode === 'script' && !leafReceiptPinned && data.extensionRecords?.some(record => record.extensionId === 'kodax.script' && record.type === 'call.settled')) {
      leafReceiptPinned = data.extensionRecords.some(record => record.extensionId === 'kodax.visual' && record.type === 'observation');
      await writeFile(firstPath, other);
    }
  });
  registerModelProvider('visual-source-fixture', () => {
    const provider = createCustomProvider({ name: 'visual-source-fixture', protocol, model: 'fixture', baseUrl: 'https://visual-source.invalid',
      apiKeyEnv: 'KODAX_VISUAL_SOURCE_TEST', imageInput: true, capabilityProfile: { ...NATIVE_PROVIDER_CAPABILITY_PROFILE } });
    const create = async (wire: unknown) => { wires.push(wire); return protocol === 'openai'
      ? { choices: [{ message: { content: 'Serialized.' }, finish_reason: 'stop' }] }
      : { content: [{ type: 'text', text: 'Serialized.' }], stop_reason: 'end_turn' }; };
    Reflect.set(provider, '_client', protocol === 'openai' ? { chat: { completions: { create } } } : { messages: { create } });
    provider.stream = async (messages, tools, system) => {
      if (!tools.some(tool => tool.name === 'todo_update')) return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
      await provider.complete(messages, tools, system);
      const call = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: 'duplicate-provider-id',
        name: bridge ? 'tool_call' : name, input: bridge ? { name, input } : input });
      if (turn++ === 0) return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: workMode === 'script'
        ? [{ type: 'tool_use', id: 'duplicate-provider-id', name: 'script_exec', input: {
          code: `await tools.read({path:${JSON.stringify(firstPath)}}); return await tools.read({path:${JSON.stringify(secondPath)}});` } }]
        : [call('read', { path: firstPath }), call('read', { path: secondPath })] };
      if (turn === 2) {
        ids = [...new Set(JSON.stringify(messages).match(/obs_[a-f0-9-]{36}/g) ?? [])];
        await writeFile(firstPath, other);
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [call('visual_inspect', {
          question: 'Compare the original images in order.', views: [
            { label: 'detail', observationId: ids[0], region: { x: 1, y: 0, width: 1, height: 2 } },
            { label: 'second image', observationId: ids[1] },
            { label: 'detail again', observationId: ids[0], region: { x: 1, y: 0, width: 1, height: 2 } },
          ],
        })] };
      }
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    };
    return provider;
  });
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'visual-source-fixture', defaultModel: 'fixture' });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { provider: 'visual-source-fixture', model: 'fixture', workMode, permissionMode: 'full-access' });
    const accepted = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'read-images', text: 'Read and inspect the images.' });
    const result = await runtime.runs.await(accepted.runId!);
    const toolMessages = wires.at(-1) as { messages?: Array<{ role: string; content: unknown }> };
    expect(ids, JSON.stringify(toolMessages.messages?.filter(message => message.role === 'tool' || message.role === 'user')).slice(-4000)).toHaveLength(2);
    expect(result.error).toBeUndefined(); expect(result.phase).toBe('completed');
    expect(JSON.stringify(wires.at(-1)).includes(expectedCrop.toString('base64')),
      JSON.stringify(toolMessages.messages?.filter(message => message.role === 'tool' || message.role === 'user')).slice(-4000)).toBe(true);
    expect(JSON.stringify(wires.at(-1))).toContain('nearest');
    const lastResult = JSON.stringify(toolMessages.messages?.filter(message => message.role === 'tool' || message.role === 'user').at(-1));
    const imagePayloads = [...lastResult.matchAll(protocol === 'openai' ? /"url":"data:image\/png;base64,([^\"]+)"/g : /"data":"([^\"]+)"/g)].map(match => match[1]);
    expect(imagePayloads).toEqual([expectedCrop.toString('base64'), other.toString('base64'), expectedCrop.toString('base64')]);
    const storage = createSessionManager({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
    const saved = await storage.loadSession(session.id);
    expect(saved!.extensionRecords?.filter(record => record.extensionId === 'kodax.visual' && record.type === 'observation')).toHaveLength(2);
    if (workMode === 'script') expect(leafReceiptPinned).toBe(true);
    const originals = saved!.messages.flatMap(message => Array.isArray(message.content) ? message.content.flatMap(block =>
      block.type === 'tool_result' && Array.isArray(block.content) ? block.content.filter(item => item.type === 'image') : []) : []);
    expect(originals.length).toBeGreaterThan(0);
    expect(await readFile(firstPath)).toEqual(other);
  } finally { saveSpy.mockRestore(); await runtime.close(); clearRuntimeModelProviders(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true }); }
}, 30_000);
