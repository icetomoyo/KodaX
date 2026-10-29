import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Jimp } from 'jimp';
import { afterEach, expect, it, vi } from 'vitest';
import { registerTool } from '@kodax-ai/coding';
import type { ToolHandlerSync } from '../packages/coding/src/tools/types.js';
import { createVisualEnvironmentTools, type VisualEnvironmentAdapter } from '@kodax-ai/coding/visual-environment';
import { createSessionManager } from '@kodax-ai/repl';
import { clearRuntimeModelProviders, createCustomProvider, registerModelProvider } from '@kodax-ai/llm';
import { NATIVE_PROVIDER_CAPABILITY_PROFILE } from '../packages/llm/src/providers/capability-profile.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { measureModelFields } from '../tests/first-turn-uniform-costs.js';

afterEach(() => { clearRuntimeModelProviders(); vi.unstubAllEnvs(); });

async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-environment-'));
  let step = 0; let episode = 0; let revealed = false; let effects = 0;
  let lastAction: ReturnType<VisualEnvironmentAdapter['state']>['lastAction'];
  let captureHook: (() => Promise<void>) | undefined;
  let actionHook: (() => Promise<void>) | undefined;
  let childBasis: Record<string, unknown> | undefined; let childCalled = false;
  const actorCalls: string[] = [];
  const actorResults: string[] = [];
  const frames: { version: string; bytes: number; sha256: string; fixtureEncodeMs: number }[] = [];
  const version = () => `${episode}:${step}`;
  const adapter: VisualEnvironmentAdapter = {
    state: () => ({ version: version(), lastAction }),
    async capture() {
      const snapshot = { version: version(), revealed };
      const png = new Jimp({ width: 2, height: 1, color: 0x777777ff });
      if (snapshot.revealed) { png.setPixelColor(0xff0000ff, 0, 0); png.setPixelColor(0x00ff00ff, 1, 0); }
      await captureHook?.();
      const started = performance.now(); const bytes = await png.getBuffer('image/png');
      frames.push({ version: snapshot.version, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), fixtureEncodeMs: performance.now() - started });
      return { version: snapshot.version, bytes, mediaType: 'image/png' };
    },
    async act(action, expectedVersion, invocationId, signal) {
      signal?.throwIfAborted();
      if (expectedVersion !== version()) return { invocationId, status: 'not_dispatched', version: version(), detail: 'adapter version changed' };
      await actionHook?.();
      if (action === 'reveal') revealed = true;
      else if (action !== 'select:1' || !revealed) throw new Error('Selection lacks visible green evidence.');
      effects++; step++;
      lastAction = { invocationId, status: 'completed', version: version(), detail: action === 'reveal' ? 'cards revealed' : 'green selected' };
      return lastAction;
    },
  };
  const install = () => createVisualEnvironmentTools({ cards: adapter }).map(tool => registerTool({ ...tool,
    handler: async (input, ctx) => {
      if (tool.name === 'visual_act') actorCalls.push(ctx.actorTurnRef?.actorPath ?? 'root');
      let result;
      try { result = await (tool.handler as ToolHandlerSync)(input, ctx); }
      catch (error) { actorResults.push(error instanceof Error ? error.message : String(error)); throw error; }
      if (tool.name === 'visual_act') actorResults.push(typeof result === 'string' ? result : JSON.stringify(result[0]));
      return result;
    } }));
  let registrations = install();
  const wires: unknown[] = []; let commands: { name: string; input: Record<string, unknown> }[] = [];
  vi.stubEnv('KODAX_ENV_TEST', 'offline');
  registerModelProvider('visual-env-fixture', () => {
    const provider = createCustomProvider({ name: 'visual-env-fixture', protocol: 'openai', model: 'fixture',
      baseUrl: 'https://visual-env.invalid', apiKeyEnv: 'KODAX_ENV_TEST', imageInput: true,
      capabilityProfile: { ...NATIVE_PROVIDER_CAPABILITY_PROFILE } });
    Reflect.set(provider, '_client', { chat: { completions: { create: async (wire: unknown) => {
      wires.push(wire); return { choices: [{ message: { content: 'Serialized.' }, finish_reason: 'stop' }] };
    } } } });
    provider.stream = async (messages, tools, system) => {
      if (!tools.some(tool => tool.name === 'visual_observe')) return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
      await provider.complete(messages, tools, system);
      if (childBasis && JSON.stringify(messages.filter(message => message.role === 'user')).includes('ENV-CHILD-ACTION')) {
        if (childCalled) return { textBlocks: [{ type: 'text', text: 'Child done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
        childCalled = true;
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'same-provider-id', name: 'visual_act', input: childBasis }], stopReason: 'tool_use' };
      }
      const command = commands.shift();
      return command ? { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'same-provider-id', ...command }], stopReason: 'tool_use' }
        : { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    };
    return provider;
  });
  const options = { homeDir, sharedDaemonHost: true, defaultProvider: 'visual-env-fixture', defaultModel: 'fixture' };
  let runtime = await createKodaXRuntime(options);
  const session = await runtime.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { workMode: 'coding', permissionMode: 'full-access' });
  const storage = createSessionManager({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
  let input = 0;
  return {
    adapter, wires, session, actorCalls, actorResults, frames, get runtime() { return runtime; }, get effects() { return effects; },
    capture(hook?: () => Promise<void>) { captureHook = hook; }, action(hook?: () => Promise<void>) { actionHook = hook; },
    reset() { episode++; step = 0; revealed = false; },
    async mode(permissionMode: 'plan' | 'full-access') { await runtime.sessions.updateSettings(session.id, { permissionMode }); },
    team(basis: Record<string, unknown>) { childBasis = basis; childCalled = false; },
    async call(name: string, values: Record<string, unknown> = {}, after: { name: string; input: Record<string, unknown> }[] = []) {
      commands = [{ name, input: values }, ...after];
      const accepted = await runtime.runs.acceptInput({ sessionId: session.id, inputId: `env-${++input}`, text: 'Execute the controlled environment operation.' });
      await runtime.runs.await(accepted.runId!);
      const saved = await storage.loadSession(session.id);
      const results = saved!.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []);
      const content = results.at(-1)?.content;
      return typeof content === 'string' ? content : content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
    },
    async restart() { await runtime.close(); registrations.forEach(dispose => dispose()); registrations = install(); runtime = await createKodaXRuntime(options); },
    async close() { await runtime.close(); registrations.forEach(dispose => dispose()); await rm(homeDir, { recursive: true, force: true }); },
  };
}

it('observes ambiguous cards, reveals evidence and selects using a fresh committed basis through Runtime and serializer', async () => {
  const f = await fixture();
  try {
    const initial = JSON.parse((await f.call('visual_observe', { source: 'cards' })).split('\n')[0]!) as { observationId: string; sourceVersion: string };
    expect(initial.sourceVersion).toBe('0:0');
    const reveal = JSON.parse((await f.call('visual_act', { source: 'cards', expectedObservationId: initial.observationId,
      expectedSourceVersion: initial.sourceVersion, action: 'reveal' })).split('\n')[0]!) as { status: string; observationId: string; sourceVersion: string };
    expect(reveal).toMatchObject({ status: 'completed', sourceVersion: '0:1' });
    expect(reveal.observationId).not.toBe(initial.observationId);
    expect(await f.call('visual_act', { source: 'cards', expectedObservationId: reveal.observationId,
      expectedSourceVersion: reveal.sourceVersion, action: 'select:1' })).toContain('green selected');
    expect(f.effects).toBe(2);
    expect(JSON.stringify(f.wires.at(-1))).toContain('data:image/png;base64,');
    expect(await f.call('visual_inspect', { question: 'Recall the ambiguous initial frame.', views: [{ label: 'before reveal', observationId: initial.observationId }] })).toContain(initial.observationId);
    const firstWire = f.wires[0] as Record<string, unknown> & { tools: { function: { name: string } }[] };
    const raw = JSON.stringify(firstWire); const withConsumer = measureModelFields(firstWire);
    const withoutConsumer = measureModelFields({ ...firstWire, tools: firstWire.tools.filter(tool => !['visual_observe', 'visual_act'].includes(tool.function.name)) });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-environment-cost-'));
    await writeFile(path.join(directory, 'request.json'), raw);
    await writeFile(path.join(directory, 'cost.json'), JSON.stringify({ withConsumer, withoutConsumer,
      deltaEstimatedTokens: withConsumer.estimatedTokens - withoutConsumer.estimatedTokens,
      rawSha256: createHash('sha256').update(raw).digest('hex'), frames: f.frames, width: 2, height: 1,
      externalCalls: 0, scope: 'OpenAI Coding Runtime; same request with only installed consumer schemas removed; fixture encode timings are not production decoder or model latency' }, null, 2));
    process.stdout.write(`Environment consumer cost saved: ${directory}\n`);
  } finally { await f.close(); }
}, 30_000);

it('blocks plan-mode effects, rejects reset/stale bases and keeps historical images after Runtime restore', async () => {
  const f = await fixture();
  try {
    const basis = JSON.parse((await f.call('visual_observe', { source: 'cards' })).split('\n')[0]!) as { observationId: string; sourceVersion: string };
    const action = { source: 'cards', expectedObservationId: basis.observationId, expectedSourceVersion: basis.sourceVersion, action: 'reveal' };
    await f.mode('plan'); await f.call('visual_act', action); expect(f.effects).toBe(0);
    await f.mode('full-access'); f.reset();
    expect(await f.call('visual_act', action)).toContain('not_dispatched'); expect(f.effects).toBe(0);
    await f.restart();
    expect(await f.call('visual_act', action)).toContain('not_dispatched');
    expect(await f.call('visual_inspect', { question: 'Recall the old episode.', views: [{ label: 'old', observationId: basis.observationId }] })).toContain(basis.observationId);
  } finally { await f.close(); }
}, 30_000);

it('retains an executed action across failed capture and restore, then supplements observation without replay', async () => {
  const f = await fixture();
  try {
    const basis = JSON.parse((await f.call('visual_observe', { source: 'cards' })).split('\n')[0]!) as { observationId: string; sourceVersion: string };
    f.capture(async () => { throw new Error('disconnected after effect'); });
    expect(await f.call('visual_act', { source: 'cards', expectedObservationId: basis.observationId, expectedSourceVersion: basis.sourceVersion, action: 'reveal' })).toContain('"status":"completed"');
    expect(f.effects).toBe(1); await f.restart(); f.capture();
    const observed = await f.call('visual_observe', { source: 'cards' });
    expect(observed).toContain('cards revealed'); expect(observed).toContain('"sourceVersion":"0:1"');
    expect(f.effects).toBe(1);
  } finally { await f.close(); }
}, 30_000);

it('rejects a real spawned Actor without a media owner instead of granting the parent observation by reference', async () => {
  const f = await fixture();
  try {
    const basis = JSON.parse((await f.call('visual_observe', { source: 'cards' })).split('\n')[0]!) as { observationId: string; sourceVersion: string };
    const input = { source: 'cards', expectedObservationId: basis.observationId, expectedSourceVersion: basis.sourceVersion, action: 'reveal' };
    f.team(input);
    await f.call('spawn_agent', { task_name: 'card-child', objective: 'ENV-CHILD-ACTION: reveal using the supplied committed observation.' }, [{ name: 'visual_act', input }]);
    expect(f.actorCalls.some(caller => caller.includes('card-child')), JSON.stringify(f.actorCalls)).toBe(true);
    expect(new Set(f.actorCalls).size).toBe(2);
    expect(f.effects).toBe(1);
    expect(f.actorResults.some(result => result.includes('requires an admitted Runtime owner')), JSON.stringify(f.actorResults)).toBe(true);
  } finally { await f.close(); }
}, 45_000);
