import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, createCustomProvider, registerModelProvider } from '@kodax-ai/llm';
import { createSessionManager, FileSessionStorage, parseMcpIntegrationDocument, writeIntegrationDocument } from '@kodax-ai/repl';
import { NATIVE_PROVIDER_CAPABILITY_PROFILE } from '../packages/llm/src/providers/capability-profile.js';
import { createKodaXRuntime } from './sdk-runtime.js';

const cells = (['ama', 'sa'] as const).flatMap(agentMode => (['openai', 'anthropic'] as const)
  .flatMap(protocol => [false, true].map(bridge => ({ agentMode, protocol, bridge }))));
it.each(cells)('admits MCP typed bytes with exact call ordinals, permission and restore: $agentMode/$protocol bridge=$bridge', async ({ agentMode, protocol, bridge }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-mcp-'));
  const source = path.join(homeDir, 'source.png'); const callsPath = path.join(homeDir, 'calls.txt');
  const png = await new Jimp({ width: 2, height: 1, color: 0x00ff00ff }).getBuffer('image/png');
  const red = await new Jimp({ width: 2, height: 1, color: 0xff0000ff }).getBuffer('image/png');
  await writeFile(source, png);
  const server = path.join(homeDir, 'server.cjs');
  await writeFile(server, `const fs=require('node:fs'); require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
    const m=JSON.parse(line); if(m.id===undefined)return; let result={};
    if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'visual',version:'1'}};
    if(m.method==='tools/list')result={tools:['frames','read'].map(name=>({name,description:'Read two controlled PNG frames.',inputSchema:{type:'object',properties:{}}}))};
    if(m.method==='resources/list')result={resources:[{uri:'frame',name:'frame',mimeType:'image/png'}]};
    if(m.method==='resources/read')result={contents:[{uri:'frame',mimeType:'image/png',blob:'${png.toString('base64')}'}]};
    if(m.method==='tools/call'){fs.appendFileSync(${JSON.stringify(callsPath)},'called\\n');result={content:[{type:'text',text:'Two source images'},
      {type:'image',mimeType:'image/png',data:fs.readFileSync(${JSON.stringify(source)}).toString('base64')},
      {type:'image',mimeType:'image/png',data:'${red.toString('base64')}'}],structuredContent:{path:'not-a-media-attachment.png'}};}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  writeIntegrationDocument({ domain: 'mcp', configHome: path.join(homeDir, '.kodax'), validate: parseMcpIntegrationDocument,
    document: { version: 1, servers: { visual: { type: 'stdio', command: process.execPath, args: [server] } } } });
  vi.stubEnv('KODAX_VISUAL_MCP_TEST', 'offline');
  const wires: unknown[] = []; let turn = 0; let restored = false; let restoreCalled = false; let ids: string[] = [];
  let resourceMode = false; let fallbackMode = false;
  registerModelProvider('visual-mcp-fixture', () => {
    const provider = createCustomProvider({ name: 'visual-mcp-fixture', protocol, model: 'fixture', baseUrl: 'https://visual-mcp.invalid',
      apiKeyEnv: 'KODAX_VISUAL_MCP_TEST', imageInput: true, capabilityProfile: { ...NATIVE_PROVIDER_CAPABILITY_PROFILE } });
    const create = async (wire: unknown) => { wires.push(wire); return protocol === 'openai'
      ? { choices: [{ message: { content: 'Serialized.' }, finish_reason: 'stop' }] }
      : { content: [{ type: 'text', text: 'Serialized.' }], stop_reason: 'end_turn' }; };
    Reflect.set(provider, '_client', protocol === 'openai' ? { chat: { completions: { create } } } : { messages: { create } });
    provider.stream = async (messages, tools, system) => {
      if (!tools.some(tool => tool.name === 'todo_update')) return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
      await provider.complete(messages, tools, system);
      const call = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: 'duplicate-provider-id',
        name: bridge ? 'tool_call' : name, input: bridge ? { name, input } : input });
      if (!restored && turn++ === 0) return { textBlocks: [], thinkingBlocks: [], toolBlocks: [0, 1].map(() => fallbackMode
        ? call('read', { path: path.join(homeDir, 'missing.png') }) : resourceMode
          ? call('mcp_read_resource', { id: 'mcp:visual:resource:frame' }) : call('mcp_call', { id: 'mcp:visual:tool:frames' })), stopReason: 'tool_use' };
      if ((!restored && turn === 2) || (restored && !restoreCalled)) {
        ids = [...new Set(JSON.stringify(messages).match(/obs_[a-f0-9-]{36}/g) ?? [])];
        if (!restored) await writeFile(source, red); else restoreCalled = true;
        if (ids.length) return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [call('visual_inspect', {
          question: 'Compare original source frames.', views: [{ label: 'old green', observationId: ids[0] }, { label: 'old red', observationId: ids[1] }] })] };
      }
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    };
    return provider;
  });
  const options = { homeDir, sharedDaemonHost: true, defaultProvider: 'visual-mcp-fixture', defaultModel: 'fixture' };
  let runtime = await createKodaXRuntime(options);
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { agentMode, workMode: 'coding', permissionMode: 'full-access' });
    const input = { sessionId: session.id, inputId: 'mcp-frames', text: 'Read the two MCP frame calls and inspect the original images.' };
    const run = await runtime.runs.acceptInput(input); expect((await runtime.runs.await(run.runId!)).phase).toBe('completed');
    expect(ids).toHaveLength(4);
    const store = createSessionManager({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
    const observations = (await store.loadSession(session.id))!.extensionRecords!.filter(record => record.extensionId === 'kodax.visual' && record.type === 'observation');
    expect(observations).toHaveLength(ids.length);
    const sources = observations.map(record => (record.data as { source: { toolCallId: string; executionId: string; imageOrdinal: number } }).source);
    expect(sources.map(item => item.toolCallId)).toEqual(Array(ids.length).fill(bridge ? 'duplicate-provider-id:mcp_call' : 'duplicate-provider-id'));
    expect(new Set(sources.map(item => item.executionId)).size).toBe(ids.length / 2);
    for (const execution of new Set(sources.map(item => item.executionId))) expect(sources.filter(item => item.executionId === execution).map(item => item.imageOrdinal)).toEqual([0, 1]);
    expect(JSON.stringify(wires.at(-1)).includes(png.toString('base64'))).toBe(true);
    expect(JSON.stringify(wires.at(-1)).includes(red.toString('base64'))).toBe(true);
    await runtime.runs.acceptInput(input);
    expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toHaveLength(2);
    await rm(source); await runtime.close(); runtime = await createKodaXRuntime(options); restored = true;
    const resumed = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'restore-old-mcp', text: 'Recall the admitted old MCP frames without calling the source.' });
    expect((await runtime.runs.await(resumed.runId!)).phase).toBe('completed');
    expect(JSON.stringify(wires.at(-1)).includes(png.toString('base64'))).toBe(true);
    expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toHaveLength(2);
    restored = false; turn = 0;
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'plan' });
    const blocked = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'blocked-mcp', text: 'Attempt the controlled MCP call under plan policy.' });
    await runtime.runs.await(blocked.runId!);
    expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toHaveLength(2);
    expect((await store.loadSession(session.id))!.extensionRecords!.filter(record => record.extensionId === 'kodax.visual' && record.type === 'observation')).toHaveLength(observations.length);
    resourceMode = true; turn = 0;
    const resourceRun = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'typed-resource', text: 'Read the typed MCP resource.' });
    expect((await runtime.runs.await(resourceRun.runId!)).phase).toBe('completed');
    const resources = (await store.loadSession(session.id))!.extensionRecords!.filter(record => record.extensionId === 'kodax.visual' && record.type === 'observation'
      && (record.data as { sourceKey: string }).sourceKey === 'mcp:visual:resource:frame');
    expect(resources).toHaveLength(2);
    expect(JSON.stringify(wires.at(-1)).includes('source=mcp:visual:resource:frame')).toBe(true);
    if (agentMode === 'sa' && protocol === 'openai') {
      resourceMode = false; fallbackMode = true; turn = 0; await writeFile(source, png);
      await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
      const fallback = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'typed-fallback', text: 'Read the missing path using the available read fallback.' });
      expect((await runtime.runs.await(fallback.runId!)).phase).toBe('completed');
      const fallbackRecords = (await store.loadSession(session.id))!.extensionRecords!.filter(record => record.extensionId === 'kodax.visual' && record.type === 'observation'
        && (record.data as { sourceKey: string }).sourceKey === 'mcp:visual:tool:read');
      expect(fallbackRecords).toHaveLength(4);
      expect(JSON.stringify(wires.at(-1)).includes('source=mcp:visual:tool:read')).toBe(true);
    }
    if (agentMode === 'ama' && protocol === 'openai' && !bridge) {
      const failingSession = await runtime.sessions.create({ projectPath: homeDir });
      await runtime.sessions.updateSettings(failingSession.id, { permissionMode: 'full-access', workMode: 'coding' });
      await writeFile(source, png); resourceMode = false; fallbackMode = false; restored = false; turn = 0;
      const save = FileSessionStorage.prototype.save;
      const failure = vi.spyOn(FileSessionStorage.prototype, 'save').mockImplementation(function (this: FileSessionStorage, id, data) {
        if (id === failingSession.id && data.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'))) {
          return Promise.reject(new Error('MCP canonical result commit failed'));
        }
        return save.call(this, id, data);
      });
      try {
        const failed = await runtime.runs.acceptInput({ sessionId: failingSession.id, inputId: 'failed-result', text: 'Receive the typed MCP images.' });
        expect((await runtime.runs.await(failed.runId!)).phase).toBe('failed');
        expect((await store.loadSession(failingSession.id))!.extensionRecords?.filter(record => record.extensionId === 'kodax.visual') ?? []).toEqual([]);
      } finally { failure.mockRestore(); }
    }
  } finally { await runtime.close(); clearRuntimeModelProviders(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true }); }
}, 45_000);
