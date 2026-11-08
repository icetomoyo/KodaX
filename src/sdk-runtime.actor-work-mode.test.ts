import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSessionLineage, type AgentTurnRef } from '@kodax-ai/agent';
import { KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { executeChildAgents } from '../packages/coding/src/child-executor.js';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

vi.mock('../packages/coding/src/child-executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/coding/src/child-executor.js')>(),
  executeChildAgents: vi.fn(),
}));

const providerName = 'actor-work-mode-offline';
type Runtime = Awaited<ReturnType<typeof createKodaXRuntime>>;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolvePromise => { release = resolvePromise; });
  return { promise, release };
}

function installOfflineProvider(rootGate: Promise<void>, enter: () => void) {
  let rootRequests = 0;
  const fetcher = vi.fn(() => { throw new Error('External requests are outside the Actor work mode fixture.'); });
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('KODAX_ACTOR_MODE_FIXTURE_KEY', 'offline-only');
  class FixtureProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_ACTOR_MODE_FIXTURE_KEY', model: 'fixture', supportsThinking: false };
    async stream(_messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      if (!tools.some(tool => tool.name === 'todo_update')) {
        throw new DOMException('Auxiliary requests are outside the offline fixture.', 'AbortError');
      }
      expect(tools.some(tool => tool.name === 'read')).toBe(true);
      expect(tools.some(tool => tool.name === 'relationship_scan')).toBe(false);
      expect(tools.some(tool => tool.name === 'script_exec')).toBe(false);
      rootRequests += 1;
      if (rootRequests === 1) { enter(); await rootGate; }
      return { textBlocks: [{ type: 'text', text: 'Offline root work complete.' }], thinkingBlocks: [],
        toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider(providerName, () => new FixtureProvider());
  return { fetcher, requests: () => rootRequests };
}

function childResult(childId: string): Awaited<ReturnType<typeof executeChildAgents>> {
  return { results: [{ childId, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
    summary: 'Independent Actor verified EDIT019.', evidenceRefs: [], contradictions: [] }],
  mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [] };
}

async function awaitActorTerminal(runtime: Runtime, sessionId: string, turn: AgentTurnRef,
  expected: 'completed' | 'failed', signal: AbortSignal): Promise<void> {
  let cursor = 0;
  for (;;) {
    signal.throwIfAborted();
    const output = await runtime.agents.output(sessionId, turn.actorPath, turn.turnId);
    if (output.state !== 'accepted' && output.state !== 'running') {
      expect(output.state, JSON.stringify(output)).toBe(expected);
      return;
    }
    const event = await runtime.agents.wait(sessionId, cursor, 100, { signal });
    if (event) cursor = event.sequence;
  }
}

async function assertAgentModeLocked(runtime: Runtime, sessionId: string): Promise<void> {
  const snapshot = await runtime.sessions.getSettingsVersioned(sessionId);
  expect(snapshot).toMatchObject({ workModeLocked: true, value: { workMode: 'agent' } });
  await expect(runtime.sessions.updateSettings(sessionId, { workMode: 'coding' })).rejects.toMatchObject({ code: 'conflict' });
  await expect(runtime.sessions.updateSettingsVersioned(sessionId, { workMode: 'coding' }, { expectedRevision: snapshot.revision }))
    .rejects.toMatchObject({ code: 'conflict' });
  await expect(runtime.runs.start({ sessionId, mode: 'managed_task', prompt: 'Do not change the locked work mode.',
    options: { workMode: 'coding' } })).rejects.toMatchObject({ code: 'conflict' });
  await expect(runtime.sessions.updateSettings(sessionId, { workMode: 'agent' })).resolves.toMatchObject({ workMode: 'agent' });
}

for (const outcome of ['completed', 'failed'] as const) {
  it(`keeps the root mode lock and queued Run intact after an independent Actor ${outcome}`, async ({ signal, onTestFailed }) => {
    const temporaryRoot = resolve(tmpdir());
    const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-mode-settlement-'));
    const rootEntered = deferred();
    const rootExecution = deferred();
    signal.addEventListener('abort', rootExecution.release, { once: true });
    const offline = installOfflineProvider(rootExecution.promise, rootEntered.release);
    const runtime = await createKodaXRuntime({ homeDir, defaultProvider: providerName, defaultModel: 'fixture' });
    let lastEvidence = '';
    onTestFailed(() => { process.stderr.write(`Actor work mode settlement evidence: ${lastEvidence}\n`); });
    try {
      const session = await runtime.sessions.create({ title: `Locked root and ${outcome} Actor`, projectPath: homeDir });
      await runtime.sessions.updateSettings(session.id, { workMode: 'agent', permissionMode: 'full-access' });
      const root = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: 'Keep the root active while its independent Actor settles.',
        options: { lsp: false, reasoningMode: 'off', context: { repoIntelligenceMode: 'off' } } });
      let rootSettled = false;
      void root.result.then(() => { rootSettled = true; });
      await Promise.race([rootEntered.promise, root.result.then(value => {
        throw new Error(`Root ended before fixture entry: ${JSON.stringify(value)}`);
      })]);
      await assertAgentModeLocked(runtime, session.id);
      const queued = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: 'Start only after the root finishes.',
        options: { lsp: false, reasoningMode: 'off', context: { repoIntelligenceMode: 'off' } } });
      await expect(runtime.runs.get(queued.runId)).resolves.toMatchObject({ phase: 'queued', workMode: 'agent' });
      vi.mocked(executeChildAgents).mockImplementation(async bundles => {
        if (outcome === 'failed') throw new Error('Fixture independent Actor execution failed.');
        return childResult(bundles[0]!.id);
      });
      const authority = { origin: { principalId: 'actor-mode-client', clientName: 'test' },
        providerCredentialAccessFactory: () => ({ allowedProviders: [providerName], acquire: async () => 'offline-child-only' }),
        tools: ['read'], authorization: undefined };
      const actor = await runtime.agents.spawn(session.id, { taskName: 'worker', objective: 'Settle independently without releasing the Session root.' }, authority);
      await awaitActorTerminal(runtime, session.id, actor, outcome, signal);
      const actorRun = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === actor.turnId);
      if (!actorRun) throw new Error('Independent Actor has no exact Runtime Run.');
      await expect(runtime.runs.await(actorRun.runId)).resolves.toMatchObject({ phase: outcome, terminal: { kind: outcome } });
      const rootStatus = await runtime.runs.get(root.runId);
      const queuedStatus = await runtime.runs.get(queued.runId);
      lastEvidence = JSON.stringify({ rootStatus, queuedStatus, actorRun, rootSettled, rootRequests: offline.requests() });
      expect(rootSettled, lastEvidence).toBe(false);
      expect(['completed', 'failed', 'cancelled', 'interrupted'], lastEvidence).not.toContain(rootStatus.phase);
      expect(queuedStatus, lastEvidence).toMatchObject({ phase: 'queued', workMode: 'agent' });
      expect(offline.requests(), lastEvidence).toBe(1);
      await expect(runtime.sessions.load(session.id)).resolves.toMatchObject({ id: session.id });
      await assertAgentModeLocked(runtime, session.id);

      rootExecution.release();
      await expect(root.result).resolves.toMatchObject({ phase: 'completed' });
      await expect(queued.result).resolves.toMatchObject({ phase: 'completed' });
      await runtime.sessions.updateSettings(session.id, { model: 'fixture-next' });
      await assertAgentModeLocked(runtime, session.id);
      expect(executeChildAgents).toHaveBeenCalledTimes(1);
      expect(offline.fetcher).not.toHaveBeenCalled();
    } finally {
      rootExecution.release();
      await runtime.close();
      signal.removeEventListener('abort', rootExecution.release);
      clearRuntimeModelProviders();
      vi.mocked(executeChildAgents).mockReset();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 30_000);
}

it('preserves the first root mode lock while an independent Actor checkpoint resumes after restart', async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-mode-recovery-'));
  const offline = installOfflineProvider(Promise.resolve(), () => undefined);
  const first = await createKodaXRuntime({ homeDir, defaultProvider: providerName, defaultModel: 'fixture' });
  let restarted: Runtime | undefined;
  const checkpointEntered = deferred();
  let lastEvidence = '';
  onTestFailed(() => { process.stderr.write(`Actor work mode checkpoint evidence: ${lastEvidence}\n`); });
  try {
    const session = await first.sessions.create({ title: 'Locked root and independent recovery', projectPath: homeDir });
    await first.sessions.updateSettings(session.id, { workMode: 'agent', permissionMode: 'full-access' });
    const root = await first.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: 'Complete the first root and permanently select Agent mode.',
      options: { lsp: false, reasoningMode: 'off', context: { repoIntelligenceMode: 'off' } } });
    await expect(root.result).resolves.toMatchObject({ phase: 'completed' });
    const originalRoot = await first.runs.get(root.runId);
    await assertAgentModeLocked(first, session.id);
    vi.mocked(executeChildAgents).mockImplementationOnce(async (_bundles, _context, options) => {
      const messages = [{ role: 'user' as const, content: 'EDIT019 already completed. Preserve the exact generation boundary.' }];
      const lineage = createSessionLineage(messages);
      const workerId = 'locked-mode-original-worker';
      await options.historyStorage!.save(workerId, { messages, lineage, gitRoot: homeDir, title: 'Locked mode worker', scope: 'managed-task-worker' });
      const checkpoint = { version: 1 as const, sessionId: workerId, activeEntryId: lineage.activeEntryId,
        messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
      checkpointEntered.release();
      await options.parentOptions!.events!.onContextCapacityBlocked!({ checkpoint }, options.abortSignal,
        { childAgentId: options.actorControl!.callerPath, turnId: options.actorTurnId });
      throw new Error('Original checkpoint executor must remain suspended.');
    });
    const authority = { origin: { principalId: 'actor-mode-recovery-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: [providerName], acquire: async () => 'fresh-offline-child-only' }),
      tools: ['read'], authorization: undefined };
    const actor = await first.agents.spawn(session.id, { taskName: 'worker', objective: 'Checkpoint without changing the Session work mode.' }, authority);
    await checkpointEntered.promise;
    let cursor = 0;
    let actorRun: Awaited<ReturnType<typeof first.runs.get>> | undefined;
    for (;;) {
      signal.throwIfAborted();
      const detail = await first.agents.detail(session.id, actor.actorPath);
      actorRun = (await first.runs.list({ sessionId: session.id })).find(value => value.turnId === actor.turnId);
      lastEvidence = JSON.stringify({ detail, actorRun });
      if (detail.turns.find(value => value.turnId === actor.turnId)?.checkpoint && actorRun?.contextRecovery?.checkpoint
        && actorRun.phase === 'recovering') break;
      const event = await first.agents.wait(session.id, cursor, 100, { signal });
      if (event) cursor = event.sequence;
    }
    const checkpoint = actorRun.contextRecovery?.checkpoint;
    if (!checkpoint) throw new Error('Independent Actor has no verified recovery checkpoint.');
    await assertAgentModeLocked(first, session.id);
    await first.close();
    restarted = await createKodaXRuntime({ homeDir, defaultProvider: providerName, defaultModel: 'fixture' });
    await expect(restarted.sessions.getSettingsVersioned(session.id)).resolves.toMatchObject({
      workModeLocked: true, value: { workMode: 'agent' },
    });
    await expect(restarted.runs.get(root.runId)).resolves.toMatchObject({ phase: 'completed', terminal: originalRoot.terminal });
    await expect(restarted.runs.get(actorRun.runId)).resolves.toMatchObject({ phase: 'recovering', contextRecovery: { checkpoint } });
    expect(executeChildAgents).toHaveBeenCalledTimes(1);
    vi.mocked(executeChildAgents).mockImplementationOnce(async (bundles, _context, options) => {
      expect(options.generationCheckpoint).toEqual(checkpoint);
      expect(options.actorTurnId).toBe(actor.turnId);
      return childResult(bundles[0]!.id);
    });
    const resumed = await restarted.agents.followup(session.id, actor.actorPath, '', { ...authority, resumeCheckpoint: true });
    expect(resumed.turn.turnId).toBe(actor.turnId);
    await awaitActorTerminal(restarted, session.id, actor, 'completed', signal);
    await expect(restarted.runs.await(actorRun.runId)).resolves.toMatchObject({ phase: 'completed', terminal: { kind: 'completed' } });
    await assertAgentModeLocked(restarted, session.id);
    await expect(restarted.runs.get(root.runId)).resolves.toMatchObject({ phase: 'completed', terminal: originalRoot.terminal });
    expect(offline.requests()).toBe(1);
    expect(executeChildAgents).toHaveBeenCalledTimes(2);
    expect(offline.fetcher).not.toHaveBeenCalled();
  } finally {
    await first.close();
    await restarted?.close();
    clearRuntimeModelProviders();
    vi.mocked(executeChildAgents).mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);
