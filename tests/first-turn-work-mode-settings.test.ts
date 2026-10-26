import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createKodaXRuntime } from '../src/sdk-runtime.js';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';

it('persists the selected work mode across restart and model changes without changing other sessions or defaults', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mode-settings-'));
  const fetcher = vi.fn(() => { throw new Error('No models or external requests'); });
  vi.stubGlobal('fetch', fetcher);
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ workMode: 'script' }));
  let runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  const effectiveMode = async (id: string) => {
    let selected: string | undefined = 'not-observed';
    const observation = await runtime.sessions.observeView(id, view => { selected = view.settings.workMode; });
    observation.close();
    return selected ?? 'coding';
  };
  try {
    const first = await runtime.sessions.create({ title: 'First', projectPath: homeDir });
    const second = await runtime.sessions.create({ title: 'Legacy default', projectPath: homeDir });
    const defaults = await runtime.config.read();
    for (const workMode of ['agent', 'coding', 'script'] as const) {
      await expect(runtime.sessions.updateSettings(first.id, { workMode })).resolves.toMatchObject({ workMode });
    }
    await runtime.sessions.updateSettings(first.id, { provider: 'deepseek', model: 'offline-model' });
    expect(await runtime.sessions.getSettings(first.id)).toMatchObject({ workMode: 'script' });
    expect((await runtime.sessions.getSettings(second.id)).workMode ?? 'coding').toBe('coding');
    expect(await effectiveMode(second.id)).toBe('coding');
    await expect(runtime.sessions.updateSettings(first.id, { workMode: 'invalid' as 'script' })).rejects.toThrow(/workMode/i);
    await runtime.close();
    runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
    expect(await runtime.sessions.getSettings(first.id)).toMatchObject({ workMode: 'script', model: 'offline-model' });
    await runtime.sessions.updateSettings(first.id, { workMode: null });
    expect((await runtime.sessions.getSettings(first.id)).workMode ?? 'coding').toBe('coding');
    expect(await effectiveMode(first.id)).toBe('coding');
    expect(await runtime.config.read()).toEqual(defaults);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await runtime.close(); vi.unstubAllGlobals();
    if (path.dirname(homeDir) !== path.resolve(os.tmpdir()) || !path.basename(homeDir).startsWith('kodax-mode-settings-')) throw new Error('Unsafe cleanup');
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);

it('rejects an unavailable Script executor before changing settings or starting a Run', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mode-settings-'));
  const fetcher = vi.fn(() => { throw new Error('No external requests'); });
  vi.stubGlobal('fetch', fetcher);
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { workMode: 'agent' });
    const vm = await import('../packages/coding/src/agent-runtime/script/cell.js');
    const construct = vi.spyOn(vm, 'runScriptCell').mockRejectedValue(new Error('Fixture executor unavailable'));
    try {
      await expect(runtime.sessions.updateSettings(session.id, { workMode: 'script' })).rejects.toThrow(/unavailable/i);
      const snapshot = await runtime.sessions.getSettingsVersioned(session.id);
      await expect(runtime.sessions.updateSettingsVersioned(session.id, { workMode: 'script' }, { expectedRevision: snapshot.revision })).rejects.toThrow(/unavailable/i);
      expect((await runtime.sessions.getSettings(session.id)).workMode).toBe('agent');
      await expect(runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: 'Do not generate.', options: { workMode: 'script' } }))
        .rejects.toThrow(/unavailable/i);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { construct.mockRestore(); }
  } finally {
    await runtime.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    if (path.dirname(homeDir) !== path.resolve(os.tmpdir()) || !path.basename(homeDir).startsWith('kodax-mode-settings-')) throw new Error('Unsafe cleanup');
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);

it('switches the actual Run menu only while idle and executes Script through the Runtime owner', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mode-settings-'));
  const fetcher = vi.fn(() => { throw new Error('No models or external requests'); });
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('KODAX_MODE_FIXTURE_KEY', 'offline');
  vi.stubEnv('KODAX_HOME', homeDir);
  let mode: 'agent' | 'coding' | 'script' = 'coding';
  let requests = 0;
  let enter = (): void => undefined;
  let release = (): void => undefined;
  let gate: Promise<void> = Promise.resolve();
  class Fixture extends KodaXBaseProvider {
    readonly name = 'work-mode-offline';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_MODE_FIXTURE_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      if (!tools.some(tool => tool.name === 'todo_update')) {
        const error = new Error('Auxiliary requests are outside this offline fixture'); error.name = 'AbortError'; throw error;
      }
      const step = requests++;
      const names = tools.map(tool => tool.name);
      expect(names).toContain('undo');
      expect(names.includes('script_exec')).toBe(mode === 'script');
      expect(names.includes('read')).toBe(mode !== 'script');
      expect(names.includes('relationship_scan')).toBe(mode === 'coding');
      if (step === 0) { enter(); await gate; }
      if (mode === 'script' && step === 1) {
        const results = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(block => block.type === 'tool_result' && block.tool_use_id === 'runtime-cell');
        expect(results).toHaveLength(1);
        expect(JSON.stringify(results)).toContain('Runtime Script evidence');
      }
      if (step > (mode === 'script' ? 1 : 0)) throw new Error('Unexpected extra root generation');
      const call = mode === 'script' && step === 0;
      return { textBlocks: call ? [] : [{ type: 'text', text: 'Offline task complete.' }], thinkingBlocks: [],
        toolBlocks: call ? [{ type: 'tool_use', id: 'runtime-cell', name: 'script_exec', input: { code: "await tools.read({path:'fixture.txt'});" } }] : [],
        stopReason: call ? 'tool_use' : 'end_turn' };
    }
  }
  registerModelProvider('work-mode-offline', () => new Fixture());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'work-mode-offline', defaultModel: 'fixture' });
  try {
    await writeFile(path.join(homeDir, 'fixture.txt'), 'Runtime Script evidence');
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
    for (mode of ['coding', 'agent', 'script'] as const) {
      if (mode !== 'coding') await runtime.sessions.updateSettings(session.id, { workMode: mode });
      requests = 0;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      gate = new Promise<void>(resolve => { release = resolve; });
      const run = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: `Verify ${mode} mode; read fixture.txt in Script.`,
        options: { lsp: false, reasoningMode: 'off', context: { repoIntelligenceMode: 'off' } } });
      await Promise.race([entered, run.result.then(result => { throw new Error(`Run ended before fixture entry: ${JSON.stringify(result)}`); })]);
      const snapshot = await runtime.sessions.getSettingsVersioned(session.id);
      await expect(runtime.sessions.updateSettings(session.id, { workMode: 'coding' })).rejects.toMatchObject({ code: 'conflict' });
      await expect(runtime.sessions.updateSettingsVersioned(session.id, { workMode: 'coding' }, { expectedRevision: snapshot.revision }))
        .rejects.toMatchObject({ code: 'conflict' });
      expect((await runtime.sessions.getSettings(session.id)).workMode ?? 'coding').toBe(mode);
      release();
      await expect(run.result).resolves.toMatchObject({ phase: 'completed' });
      expect(requests).toBe(mode === 'script' ? 2 : 1);
      await awaitLatestCodingMemoryReviewDrain(5_000);
    }
    await runtime.sessions.updateSettings(session.id, { workMode: 'coding' });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    release(); await runtime.close(); await awaitLatestCodingMemoryReviewDrain(5_000);
    clearRuntimeModelProviders(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    if (path.dirname(homeDir) !== path.resolve(os.tmpdir()) || !path.basename(homeDir).startsWith('kodax-mode-settings-')) throw new Error('Unsafe cleanup');
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);
