import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { ContextCapacityError, createSessionLineage } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';
import { KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

const historicalWrite = 'EDIT019 already completed and verified.\n';
const currentMarker = 'External follow-up preserved after verified EDIT019.\n';

const scenarios = {
  'legacy-agent': 'resumes the same legacy Agent Run without selecting or unlocking its Session mode',
  'modern-locked': 'refuses an Agent continuation that conflicts with a modern Coding lock',
  'status-mismatch': 'refuses a saved Agent snapshot that conflicts with its persisted Coding Run',
  'modern-empty': 'refuses mode selection through a modern empty-history recovery checkpoint',
  'caller-override': 'ignores a fresh caller mode override when resuming the frozen Agent Run',
  'missing-status': 'recovers the effective saved mode when an old Run status has no mode field',
  'profile-effective': 'retains the effective Coding mode of a saved Agent request with an SDK profile',
  'callback-effective': 'uses the saved callback declaration to retain Coding mode and invokes only fresh authority',
  'fresh-mode-drift': 'refuses fresh authorization context that changes the admitted effective Agent mode',
  'checkpoint-repeat': 'resumes the same legacy Agent checkpoint after two real Host close and restart cycles',
} as const;
for (const scenario of Object.keys(scenarios) as Array<keyof typeof scenarios>) {
const modernLocked = scenario === 'modern-locked';
const effectiveMode = scenario === 'profile-effective' || scenario === 'callback-effective' ? 'coding' : 'agent';
const statusMode = scenario === 'missing-status' ? undefined : scenario === 'status-mismatch' ? 'coding' : effectiveMode;
it(scenarios[scenario], async ({ onTestFailed, signal }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-legacy-work-mode-'));
  const configHome = join(homeDir, '.kodax');
  const sessionId = 'legacy-agent-session';
  const runId = 'legacy-agent-run';
  const marker = join(homeDir, 'completed-edit.txt');
  const providerName = 'legacy-agent-offline';
  const fetcher = vi.fn(() => { throw new Error('Legacy recovery fixture cannot make HTTP requests.'); });
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('UNUSED_LEGACY_AGENT_KEY', 'offline-fixture-only');
  let calls = 0;
  let policyCalls = 0;
  let received: KodaXMessage[] | undefined;
  let lastResult: unknown;
  let lastRun: unknown;
  let resultFailure: string | undefined;
  onTestFailed(() => { process.stderr.write(`Legacy mode recovery evidence: ${JSON.stringify({ lastResult, lastRun, calls, resultFailure })}\n`); });
  class FixtureProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'UNUSED_LEGACY_AGENT_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      calls++;
      received = messages;
      expect(tools.some(tool => tool.name === 'read')).toBe(true);
      expect(tools.some(tool => tool.name === 'relationship_scan')).toBe(false);
      expect(tools.some(tool => tool.name === 'script_exec')).toBe(false);
      if (scenario === 'checkpoint-repeat' && calls <= 2) {
        throw new ContextCapacityError({ contextWindow: 64_000, currentTokens: 128_000 }, 'Offline repeated checkpoint');
      }
      return { textBlocks: [{ type: 'text', text: 'Continued the original Agent task; EDIT019 remains complete.' }],
        thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider(providerName, () => new FixtureProvider());
  let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  try {
    await writeFile(marker, currentMarker);
    const messages: KodaXMessage[] = scenario === 'modern-empty' ? [] : [
      { role: 'user', content: 'Continue the original Agent task without repeating EDIT019.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'completed-edit', name: 'write',
        input: { path: marker, content: historicalWrite } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'completed-edit', content: 'EDIT019 completed and verified.' }] },
    ];
    const lineage = createSessionLineage(messages);
    await new FileSessionStorage({ sessionsDir: join(configHome, 'sessions'), configHome }).save(sessionId,
      { title: 'Legacy Agent checkpoint', gitRoot: homeDir, messages, lineage,
        runtimeInfo: { surface: 'partner', ...(modernLocked ? { workModeLocked: true }
          : scenario === 'modern-empty' ? { workModeLocked: false } : {}) } });
    const checkpoint = { version: 1, sessionId, turnId: 'original-turn', activeEntryId: lineage.activeEntryId,
      messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
    const runDir = join(configHome, 'runtime', 'runs', runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'status.json'), JSON.stringify({ runId, sessionId, phase: 'recovering',
      mode: 'managed_task', workMode: statusMode, provider: providerName, model: 'fixture', startedAt: '2026-11-01T00:00:00Z',
      contextRecovery: { waitingSince: '2026-11-01T00:00:00Z', checkpoint },
      _runtime: { revision: 1, owner: { ownerId: 'dead-legacy-owner', runtimeId: 'dead-legacy-runtime',
        pid: 2147483647, startedAt: '2026-11-01T00:00:00Z' } } }));
    await writeFile(join(runDir, 'generation-recovery.json'), JSON.stringify({ version: 1, checkpoint,
      start: { prompt: 'Continue the original Agent task without repeating EDIT019.', options: {
        provider: providerName, model: 'fixture', workMode: 'agent', agentMode: 'sa', lsp: false, reasoningMode: 'off',
        context: { gitRoot: homeDir, executionCwd: homeDir, repoIntelligenceMode: 'off',
          ...(scenario === 'profile-effective' ? { agentProfile: { instructions: 'Keep the admitted SDK Coding surface.' } } : {}),
          ...(scenario === 'fresh-mode-drift' ? { workModePolicy: 'intersect' } : {}) },
      }, requiredBindings: scenario === 'callback-effective' || scenario === 'fresh-mode-drift'
        ? [{ path: 'context.toolVisibilityPolicy', type: 'function' }] : [] },
      requiresCredential: false, requiresHostTools: false, actorTurnBaseline: [] }));

    runtime = await createKodaXRuntime({ homeDir, defaultProvider: providerName, defaultModel: 'fixture' });
    expect(await runtime.runs.get(runId)).toMatchObject({ phase: 'recovering' });
    expect((await runtime.runs.get(runId)).workMode).toBe(statusMode);
    expect(await runtime.sessions.getSettingsVersioned(sessionId)).toMatchObject({ workModeLocked: scenario !== 'modern-empty' });
    expect((await runtime.sessions.getSettings(sessionId)).workMode).toBeUndefined();
    if (modernLocked || scenario === 'status-mismatch' || scenario === 'modern-empty' || scenario === 'fresh-mode-drift') {
      await expect(runtime.runs.recover({ runId, ...(scenario === 'fresh-mode-drift' ? { options: { context: {
        toolVisibilityPolicy: () => true, currentAgentId: 'fresh-child',
      } } } : {}) })).rejects.toMatchObject({ code: 'conflict',
        ...(scenario === 'status-mismatch' ? { message: 'Generation recovery mode does not match the persisted Run.' }
          : scenario === 'fresh-mode-drift' ? { message: 'Generation recovery must retain the admitted Run mode.' } : {}) });
      expect(await runtime.runs.get(runId)).toMatchObject({ phase: 'recovering', workMode: statusMode });
      if (scenario === 'fresh-mode-drift') {
        expect((await runtime.sessions.getSettings(sessionId)).workMode).toBeUndefined();
        const saved = await new FileSessionStorage({ sessionsDir: join(configHome, 'sessions'), configHome }).load(sessionId);
        expect(saved?.runtimeInfo).not.toHaveProperty('workModeLocked');
        expect(await readFile(marker, 'utf8')).toBe(currentMarker);
      }
      expect(calls).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
      return;
    }
    if (scenario === 'checkpoint-repeat') {
      let previousWait = '2026-11-01T00:00:00Z';
      for (let restart = 0; restart < 2; restart++) {
        const paused = await runtime.runs.recover({ runId });
        for (;;) {
          signal.throwIfAborted();
          const status = await runtime.runs.get(runId);
          lastRun = status;
          if (status.phase === 'failed') throw new Error(`Checkpoint fixture failed: ${JSON.stringify(status)}`);
          if (status.phase === 'recovering' && status.contextRecovery?.checkpoint
            && status.contextRecovery.waitingSince !== previousWait) {
            previousWait = status.contextRecovery.waitingSince;
            break;
          }
          await delay(10, undefined, { signal });
        }
        expect(calls).toBe(restart + 1);
        await runtime.close();
        await expect(paused.result).resolves.toMatchObject({ phase: 'recovering' });
        runtime = await createKodaXRuntime({ homeDir, defaultProvider: providerName, defaultModel: 'fixture' });
        expect(await runtime.runs.get(runId)).toMatchObject({ phase: 'recovering', workMode: 'agent' });
        expect((await runtime.sessions.getSettings(sessionId)).workMode).toBeUndefined();
      }
    }
    const recovered = await runtime.runs.recover({ runId,
      ...(scenario === 'caller-override' ? { options: { workMode: 'script' } }
        : scenario === 'callback-effective' ? { options: { context: { toolVisibilityPolicy: () => { policyCalls++; return true; } } } } : {}) });
    expect(recovered.runId).toBe(runId);
    const result = await recovered.result;
    lastResult = result;
    resultFailure = result.error === undefined ? undefined : String(result.error);
    lastRun = await runtime.runs.get(runId);
    expect(lastResult, JSON.stringify(lastResult)).toMatchObject({ phase: 'completed' });
    expect(await runtime.runs.get(runId)).toMatchObject({ phase: 'completed', workMode: effectiveMode });
    expect(calls).toBe(scenario === 'checkpoint-repeat' ? 3 : 1);
    if (scenario === 'callback-effective') expect(policyCalls).toBeGreaterThan(0);
    expect(JSON.stringify(received)).toContain('EDIT019 completed and verified.');
    expect(await readFile(marker, 'utf8')).toBe(currentMarker);
    expect((await runtime.sessions.getSettings(sessionId)).workMode).toBeUndefined();
    expect(await runtime.sessions.getSettingsVersioned(sessionId)).toMatchObject({ workModeLocked: true });
    const saved = await new FileSessionStorage({ sessionsDir: join(configHome, 'sessions'), configHome }).load(sessionId);
    expect(saved?.runtimeInfo).not.toHaveProperty('workModeLocked');
    await expect(runtime.sessions.updateSettings(sessionId, { workMode: 'agent' })).rejects.toMatchObject({ code: 'conflict' });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await runtime?.close();
    clearRuntimeModelProviders();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Unsafe legacy fixture cleanup.');
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);
}
