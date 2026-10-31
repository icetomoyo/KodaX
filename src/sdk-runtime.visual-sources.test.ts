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

function lastToolText(wire: unknown, protocol: 'openai' | 'anthropic'): string {
  const messages = (wire as { messages: Array<{ role: string; content: unknown }> }).messages;
  let content = messages.filter(message => message.role === 'tool' || message.role === 'user').at(-1)?.content;
  if (protocol === 'anthropic' && Array.isArray(content)) {
    content = (content as { type: string; content?: unknown }[]).find(block => block.type === 'tool_result')?.content;
  }
  if (Array.isArray(content)) content = (content as { type: string; text?: string }[])
    .filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
  if (typeof content !== 'string') throw new Error('Expected a serialized tool result.');
  return content;
}

it.each(cases)('reads, discovers exact history IDs and inspects immutable bytes: $workMode/$protocol bridge=$bridge', async ({ workMode, protocol, bridge }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-source-'));
  const firstPath = path.join(homeDir, 'first.png'); const secondPath = path.join(homeDir, 'second.png');
  const original = await new Jimp({ width: 2, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
  const other = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png');
  const expectedCrop = await new Jimp({ width: 1, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
  await writeFile(firstPath, original); await writeFile(secondPath, other);
  vi.stubEnv('KODAX_VISUAL_SOURCE_TEST', 'offline-only');
  const wires: unknown[] = [];
  let ids: string[] = []; let turn = 0; let leafReceiptPinned = false;
  let history: { observationId: string; sourceKey: string }[] = [];
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
      if (turn === 0) {
        for (const name of ['visual_inspect', 'visual_read_pixels']) {
          expect(tools.some(tool => tool.name === name), `${name} detail schema waits for visual evidence or an acknowledged call`).toBe(false);
        }
      } else if (turn === 1) {
        for (const name of ['visual_inspect', 'visual_read_pixels']) {
          const contract = tools.find(tool => tool.name === name);
          expect(contract, `${name} detail schema returns after the original rejected call is acknowledged`).toBeDefined();
          const views = contract!.input_schema.properties.views as {
            items: { properties: { observationId: { description?: string } } };
          };
          const referenceHelp = views.items.properties.observationId.description;
          expect(referenceHelp, `${name} must explain the source of its accepted ID`).toEqual(expect.stringContaining('visual_history'));
          expect(referenceHelp).toMatch(/filename|path|label/);
          expect(contract!.description).toMatch(/read.*first.*Runtime/);
        }
      }
      await provider.complete(messages, tools, system);
      if (turn === 1) expect(lastToolText(wires.at(-1), protocol)).toContain('Visual observation unavailable or access denied');
      const call = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: 'duplicate-provider-id',
        name: bridge ? 'tool_call' : name, input: bridge ? { name, input } : input });
      if (turn++ === 0) return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [call('visual_inspect', {
        question: 'Inspect a file using an invented label.', views: [{ label: firstPath, observationId: 'sheet03' }],
      })] };
      if (turn === 2) return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: workMode === 'script'
        ? [{ type: 'tool_use', id: 'duplicate-provider-id', name: 'script_exec', input: {
          code: `await tools.read({path:${JSON.stringify(firstPath)}}); return await tools.read({path:${JSON.stringify(secondPath)}});` } }]
        : [call('read', { path: firstPath }), call('read', { path: secondPath })] };
      if (turn === 3) {
        ids = [...new Set(JSON.stringify(messages).match(/obs_[a-f0-9-]{36}/g) ?? [])];
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [call('visual_history', {
          sourceKey: `read:${firstPath}`, limit: 1,
        })] };
      }
      if (turn === 4) {
        history = (JSON.parse(lastToolText(wires.at(-1), protocol)) as { observations: typeof history }).observations;
        ids[0] = history[0]!.observationId;
        await writeFile(firstPath, other);
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [call('visual_inspect', {
          question: 'Compare the original images in order.', views: [
            { label: 'detail', observationId: ids[0], region: { x: 1, y: 0, width: 1, height: 2 } },
            { label: 'second image', observationId: ids[1] },
            { label: 'detail again', observationId: ids[0], region: { x: 1, y: 0, width: 1, height: 2 } },
          ],
        })] };
      }
      if (turn === 5) return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [call('visual_read_pixels', {
        question: 'Verify the old green and red pixels.', views: [
          { label: 'green grid', observationId: ids[0], region: { x: 0, y: 0, width: 2, height: 2 }, rows: 2, columns: 2 },
          { label: 'red pixel', observationId: ids[1], region: { x: 0, y: 0, width: 1, height: 1 }, rows: 1, columns: 1 },
        ],
      })] };
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    };
    return provider;
  });
  let runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'visual-source-fixture', defaultModel: 'fixture' });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { provider: 'visual-source-fixture', model: 'fixture', workMode, permissionMode: 'full-access', maxIter: 12 });
    const accepted = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'read-images', text: 'Read and inspect the images.' });
    const result = await runtime.runs.await(accepted.runId!);
    const toolMessages = wires.at(-1) as { messages?: Array<{ role: string; content: unknown }> };
    expect(ids, JSON.stringify(toolMessages.messages?.filter(message => message.role === 'tool' || message.role === 'user')).slice(-4000)).toHaveLength(2);
    expect(result.error, JSON.stringify(result)).toBeUndefined(); expect(result.phase).toBe('completed');
    expect(history).toEqual([expect.objectContaining({ observationId: ids[0], sourceKey: `read:${firstPath}` })]);
    const published = JSON.stringify(wires);
    expect(published).toContain('Visual observation unavailable or access denied');
    if (workMode === 'coding' && protocol === 'openai' && !bridge) {
      const declarations = (wires[1] as { tools: Array<{ function: { name: string; description: string;
        parameters: { properties: { views: { items: { properties: { observationId: { description?: string } } } } } } } }> }).tools;
      for (const name of ['visual_inspect', 'visual_read_pixels']) {
        const contract = declarations.find(tool => tool.function.name === name)!.function;
        const referenceHelp = contract.parameters.properties.views.items.properties.observationId.description;
        expect(referenceHelp, `${name} must explain the source of its accepted ID`).toEqual(expect.stringContaining('visual_history'));
        expect(referenceHelp).toMatch(/filename|path|label/);
        expect(contract.description).toMatch(/read.*first.*Runtime/);
      }
    }
    expect(JSON.stringify(wires.at(-1)).includes(expectedCrop.toString('base64')),
      JSON.stringify(toolMessages.messages?.filter(message => message.role === 'tool' || message.role === 'user')).slice(-4000)).toBe(true);
    expect(JSON.stringify(wires.at(-1))).toContain('nearest');
    const inspected = wires.at(-2) as { messages?: Array<{ role: string; content: unknown }> };
    const lastResult = JSON.stringify(inspected.messages?.filter(message => message.role === 'tool' || message.role === 'user').at(-1));
    const imagePayloads = [...lastResult.matchAll(protocol === 'openai' ? /"url":"data:image\/png;base64,([^\"]+)"/g : /"data":"([^\"]+)"/g)].map(match => match[1]);
    expect(imagePayloads).toEqual([expectedCrop.toString('base64'), other.toString('base64'), expectedCrop.toString('base64')]);
    const numericText = lastToolText(wires.at(-1), protocol);
    expect(JSON.parse(numericText)).toMatchObject({ status: 'complete', palette: [[0, 255, 0, 255], [255, 0, 0, 255]],
      views: [{ label: 'green grid', indices: [[0, 0], [0, 0]] }, { label: 'red pixel', indices: [[1]] }] });
    expect(numericText).not.toContain('truncated');
    const storage = createSessionManager({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
    const saved = await storage.loadSession(session.id);
    expect(saved!.extensionRecords?.filter(record => record.extensionId === 'kodax.visual' && record.type === 'observation')).toHaveLength(2);
    if (workMode === 'script') expect(leafReceiptPinned).toBe(true);
    const originals = saved!.messages.flatMap(message => Array.isArray(message.content) ? message.content.flatMap(block =>
      block.type === 'tool_result' && Array.isArray(block.content) ? block.content.filter(item => item.type === 'image') : []) : []);
    expect(originals.length).toBeGreaterThan(0);
    expect(await readFile(firstPath)).toEqual(other);
    const corrupted = await new Jimp({ width: 2, height: 2, color: 0x0000ffff }).getBuffer('image/png');
    for (const retained of new Set(originals.map(image => image.path))) await writeFile(retained, corrupted);
    await runtime.close();
    runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'visual-source-fixture', defaultModel: 'fixture' });
    const restored = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'check-history-integrity', text: 'Continue; do not replace missing historical evidence with a new frame.' });
    expect((await runtime.runs.await(restored.runId!)).phase).toBe('completed');
    const restoredWire = JSON.stringify(wires.at(-1));
    expect(restoredWire.includes('SHA-256 integrity check failed'), 'Restored owned history must explain its integrity failure.').toBe(true);
    expect(restoredWire.includes(corrupted.toString('base64')), 'Changed bytes must not be uploaded as the old observation.').toBe(false);
    expect((await storage.loadSession(session.id))!.extensionRecords?.filter(record => record.extensionId === 'kodax.visual' && record.type === 'observation')).toHaveLength(2);
    if (workMode === 'coding' && protocol === 'openai' && !bridge) {
      await rm(originals[0]!.path);
      const missing = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'check-missing-history', text: 'Continue with explicit evidence availability.' });
      expect((await runtime.runs.await(missing.runId!)).phase).toBe('completed');
      expect(JSON.stringify(wires.at(-1)).includes('local attachment file is missing')).toBe(true);
      expect(JSON.stringify(wires.at(-1)).includes(corrupted.toString('base64'))).toBe(false);
    }
  } finally { saveSpy.mockRestore(); await runtime.close(); clearRuntimeModelProviders(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true }); }
}, 30_000);
