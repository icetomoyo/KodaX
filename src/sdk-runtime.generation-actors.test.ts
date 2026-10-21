import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionLineage } from '@kodax-ai/agent';
import { executeChildAgents } from '../packages/coding/src/child-executor.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders, type KodaXMessage } from '@kodax-ai/llm';

vi.mock('../packages/coding/src/child-executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/coding/src/child-executor.js')>(), executeChildAgents: vi.fn(),
}));
const directories: string[] = [];
afterEach(async () => { vi.mocked(executeChildAgents).mockReset(); clearRuntimeModelProviders(); delete process.env.KODAX_GENERATION_FIXTURE_KEY;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('preserves and resumes an original Workflow leaf after Host restart without invoking its script again', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-workflow-generation-'));
  directories.push(homeDir);
  class FixtureProvider extends KodaXBaseProvider {
    readonly name = 'generation-fixture'; readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_GENERATION_FIXTURE_KEY', model: 'fixture', supportsThinking: false };
    async stream(): Promise<never> { throw new Error('Unexpected LLM request outside the child seam'); }
  }
  process.env.KODAX_GENERATION_FIXTURE_KEY = 'local-test-only';
  registerModelProvider('generation-fixture', () => new FixtureProvider());
  const first = await createKodaXRuntime({ homeDir, defaultProvider: 'generation-fixture' });
  const session = await first.sessions.create({ title: 'Workflow recovery', projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'ama' });
  vi.mocked(executeChildAgents).mockImplementationOnce(async (_bundles, _ctx, child) => {
    const messages = [{ role: 'user' as const, content: 'EDIT019 is complete. JSON only.' }];
    const lineage = createSessionLineage(messages);
    await child.historyStorage!.save('workflow-original-worker', { messages, lineage, scope: 'managed-task-worker', title: 'Workflow worker', gitRoot: homeDir });
    await child.parentOptions.events!.onContextCapacityBlocked!({ checkpoint: { version: 1, sessionId: 'workflow-original-worker',
      activeEntryId: lineage.activeEntryId, messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') } }, child.abortSignal,
      { childAgentId: child.contextAgentId ?? child.actorControl?.callerPath, turnId: child.actorTurnId });
    throw new Error('Original executor remains suspended');
  });
  const started = await first.workflows.start({ sessionId: session.id, projectRoot: homeDir, provider: 'generation-fixture', source: { kind: 'inline',
    manifest: { name: 'generation-recovery', description: 'Verify existing results', readOnly: true,
      maxAgents: 2, maxConcurrency: 2, tokenBudget: 1000, phases: ['inspect'], patterns: ['fan-out-and-synthesize'] },
    source: 'async function run(wf) { const result = await wf.runAgent({ name: "verify", prompt: "Verify EDIT019 without repetition.", readOnly: true }); return { synthesis: result.finalText }; }',
  } });
  if (started.kind !== 'started') throw new Error(started.reason);
  await vi.waitFor(async () => { const status = await first.runs.get(started.runId);
    expect(status.contextRecovery?.children?.[0]?.checkpoint, JSON.stringify({ status, tree: await first.agents.tree(session.id), calls: vi.mocked(executeChildAgents).mock.calls.length })).toBeDefined(); });
  const actor = (await first.agents.tree(session.id)).actors.find(value => value.path !== '/root' && value.kind !== 'workflow')!;
  const originalBundle = vi.mocked(executeChildAgents).mock.calls[0]![0][0];
  await first.close();
  const restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'generation-fixture' });
  try {
    expect((await restarted.agents.output(session.id, actor.path, actor.currentTurnId!)).state).toBe('running');
    vi.mocked(executeChildAgents).mockImplementationOnce(async (bundles, _ctx, child) => {
      expect(bundles).toEqual([originalBundle]);
      expect(child.generationCheckpoint?.sessionId).toBe('workflow-original-worker');
      return { results: [{ childId: originalBundle!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
        summary: 'Verified EDIT019', evidenceRefs: [], contradictions: [] }], mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [] };
    });
    const freshAuthority = { resumeCheckpoint: true,
      providerCredentialAccessFactory: () => ({ allowedProviders: ['generation-fixture'], acquire: async () => 'fixture-only' }) };
    await restarted.agents.followup(session.id, actor.path, '', freshAuthority);
    await vi.waitFor(async () => expect((await restarted.agents.output(session.id, actor.path, actor.currentTurnId!)).state).toBe('completed'));
    expect(executeChildAgents).toHaveBeenCalledTimes(2);
    expect((await restarted.agents.output(session.id, actor.path, actor.currentTurnId!)).structured).toMatchObject({ taskId: originalBundle!.id });
  } finally { await restarted.close(); }
}, 30_000);

it.each([0, 1, 2])('resumes an independently authorized Actor and its nested checkpoints after Host restart (depth=%s)', async depth => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-actor-generation-'));
  directories.push(homeDir);
  const first = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  const session = await first.sessions.create({ title: 'Independent recovery' });
  const authority = { origin: { principalId: 'original-client', clientName: 'test' },
    providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'test-only' }),
    tools: ['read'], authorization: undefined };
  let checkpoint: { version: 1; sessionId: string; activeEntryId: string | null; messagesDigest: string } | undefined;
  const nestedTurns: Array<{ actorPath: string; turnId: string }> = [];
  const checkpoints = new Map<string, NonNullable<typeof checkpoint>>();
  vi.mocked(executeChildAgents).mockImplementation(async (_bundles, _context, options) => {
    const actorPath = options.actorControl!.callerPath;
    if ((depth > 0 && actorPath.endsWith('/worker')) || (depth > 1 && actorPath.endsWith('/nested'))) {
      const taskName = actorPath.endsWith('/worker') ? 'nested' : 'leaf';
      nestedTurns.push(await options.actorControl!.spawn({ taskName, objective: 'Retain nested constraints.', capabilities: { tools: ['read'] } }));
    }
    const messages = [{ role: 'user' as const, content: 'Keep exports. EDIT019 already completed.' }];
    const lineage = createSessionLineage(messages);
    const workerId = actorPath.replaceAll('/', '-') + '-exact';
    await options.historyStorage!.save(workerId, { messages, lineage, gitRoot: homeDir, title: 'Worker', scope: 'managed-task-worker' });
    const current = { version: 1 as const, sessionId: workerId, activeEntryId: lineage.activeEntryId,
      messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
    checkpoints.set(actorPath, current);
    if (actorPath.endsWith('/worker')) checkpoint = current;
    await options.parentOptions!.events!.onContextCapacityBlocked!({ checkpoint: current }, options.abortSignal,
      { childAgentId: options.actorControl!.callerPath, turnId: options.actorTurnId });
    throw new Error('Old executor must remain suspended');
  });
  const turn = await first.agents.spawn(session.id, { taskName: 'worker', objective: 'Report without repeating EDIT019.' }, authority);
  const actorRunId = `actor_${createHash('sha256').update(JSON.stringify([session.id, turn.turnId])).digest('hex')}`;
  await vi.waitFor(async () => expect((await first.agents.detail(session.id, turn.actorPath)).turns[0]?.checkpoint).toBeDefined());
  await vi.waitFor(async () => expect((await first.runs.get(actorRunId)).phase).toBe('recovering'));
  await vi.waitFor(() => expect(nestedTurns).toHaveLength(depth));
  for (const nestedTurn of nestedTurns) await vi.waitFor(async () => expect((await first.agents.detail(session.id, nestedTurn.actorPath)).turns[0]?.checkpoint).toBeDefined());
  await first.close();
  const restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  try {
    expect(await restarted.runs.get(actorRunId)).toMatchObject({ phase: 'recovering', contextRecovery: { checkpoint } });
    expect((await restarted.agents.output(session.id, turn.actorPath, turn.turnId)).state).toBe('running');
    await expect(restarted.agents.followup(session.id, turn.actorPath, '', { resumeCheckpoint: true })).rejects.toThrow();
    vi.mocked(executeChildAgents).mockImplementation(async (_bundles, _context, options) => {
      expect(options.generationCheckpoint).toEqual(checkpoints.get(options.actorControl!.callerPath));
      expect([turn.turnId, ...nestedTurns.map(value => value.turnId)]).toContain(options.actorTurnId);
      expect(options.initialMessages).toEqual([]);
      return { results: [{ childId: turn.actorPath, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
        summary: 'Verified EDIT019 without replay', evidenceRefs: [], contradictions: [] }], mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [] };
    });
    const recovered = await restarted.agents.followup(session.id, turn.actorPath, '', { ...authority, resumeCheckpoint: true });
    expect(recovered.turn.turnId).toBe(turn.turnId);
    await vi.waitFor(async () => expect((await restarted.agents.output(session.id, turn.actorPath, turn.turnId)).state).toBe('completed'));
    for (const nestedTurn of nestedTurns) await vi.waitFor(async () => expect((await restarted.agents.output(session.id, nestedTurn.actorPath, nestedTurn.turnId)).state).toBe('completed'));
    expect(executeChildAgents).toHaveBeenCalledTimes((depth + 1) * 2);
  } finally { await restarted.close(); }
}, 20_000);

it.each(['actor', 'workflow'] as const)('checkpoints the parent mailbox receipt and resumes its child after Host restart (%s)', async kind => {
  const agentMode = 'ama';
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-wait-generation-'));
  directories.push(homeDir);
  let calls = 0;
  let resumed = false;
  const requests: KodaXMessage[][] = [];
  class FixtureProvider extends KodaXBaseProvider {
    readonly name = 'generation-fixture'; readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_GENERATION_FIXTURE_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[]) {
      requests.push(structuredClone(messages));
      calls++;
      return { thinkingBlocks: [], textBlocks: resumed ? [{ type: 'text' as const, text: 'Verified EDIT019.' }] : [],
        toolBlocks: resumed ? [] : [{ type: 'tool_use' as const, id: `tool-${calls}`, name: calls === 1 ? kind === 'actor' ? 'spawn_agent' : 'run_workflow' : 'wait_agent',
          input: calls === 1 ? kind === 'actor' ? { task_name: 'worker', objective: 'Verify EDIT019 without repeating it.', read_only: true } : {
            manifest: { name: 'resume-test', description: 'Verify receipts', readOnly: true, maxAgents: 2, maxConcurrency: 2, tokenBudget: 1000, phases: ['inspect'], patterns: ['fan-out-and-synthesize'] },
            source: 'async function run(wf) { const result = await wf.runAgent({ name: "worker", prompt: "Verify EDIT019", readOnly: true }); return { synthesis: result.finalText }; }',
          } : { timeout_ms: 60_000 } }] };
    }
  }
  process.env.KODAX_GENERATION_FIXTURE_KEY = 'local-test-only';
  registerModelProvider('generation-fixture', () => new FixtureProvider());
  const first = await createKodaXRuntime({ homeDir, defaultProvider: 'generation-fixture' });
  const session = await first.sessions.create({ title: 'Parent wait recovery', projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode });
  vi.mocked(executeChildAgents).mockImplementationOnce(async (_bundles, _ctx, child) => {
    const messages = [{ role: 'user' as const, content: 'EDIT019 is complete. Preserve exports.' }];
    const lineage = createSessionLineage(messages);
    await child.historyStorage!.save('wait-worker', { messages, lineage, title: 'Worker', gitRoot: homeDir, scope: 'managed-task-worker' });
    await child.parentOptions.events!.onContextCapacityBlocked!({ checkpoint: { version: 1, sessionId: 'wait-worker', activeEntryId: lineage.activeEntryId,
      messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') } }, child.abortSignal,
      { childAgentId: child.contextAgentId ?? child.actorControl?.callerPath, turnId: child.actorTurnId });
    throw new Error('Original worker remains suspended');
  });
  const handle = await first.runs.start({ sessionId: session.id, prompt: `EDIT019 is complete. ${kind === 'workflow' ? 'Use a workflow to' : 'Delegate'} verify and wait for the worker.`,
    options: { agentMode, ...(kind === 'workflow' ? { workflowRunsBaseDir: join(homeDir, 'workflows'), context: { workflowIntent: 'explicit' } } : {}) } });
  try {
    await vi.waitFor(async () => expect(await first.runs.get(handle.runId), JSON.stringify({ calls, tree: await first.agents.tree(session.id), children: vi.mocked(executeChildAgents).mock.calls.length, last: requests.at(-1)?.slice(-3) })).toMatchObject({ phase: 'waiting_agent', contextRecovery: { children: [expect.objectContaining({ checkpoint: expect.anything() })] } }), { timeout: 5_000 });
  } catch (error) { await first.close(); throw error; }
  const actor = (await first.agents.tree(session.id)).actors.find(actor => actor.path !== '/root' && actor.kind !== 'workflow')!;
  await first.close();
  const restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'generation-fixture' });
  try {
    expect(await restarted.runs.get(handle.runId)).toMatchObject({ phase: 'recovering', contextRecovery: { checkpoint: expect.anything() } });
    resumed = true;
    vi.mocked(executeChildAgents).mockImplementationOnce(async (bundles, _ctx, child) => {
      expect(child.generationCheckpoint?.sessionId).toBe('wait-worker');
      return { results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid', summary: 'Verified EDIT019', evidenceRefs: [], contradictions: [] }], totalTokensUsed: 0, cancelledChildren: [], mergedFindings: [], mergedArtifacts: [] };
    });
    const recovered = await restarted.runs.recover({ runId: handle.runId });
    await recovered.result;
    await vi.waitFor(async () => expect((await restarted.agents.output(session.id, actor.path, actor.currentTurnId!)).state).toBe('completed'));
    expect(executeChildAgents).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requests.at(-1))).toContain('interrupted');
    expect(JSON.stringify(requests.at(-1))).toContain('tool-2');
  } finally { await restarted.close(); }
}, 30_000);

it('keeps identical Actor turn IDs in different Sessions in separate recovery records', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-actor-session-boundary-'));
  directories.push(homeDir);
  const first = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  const sessions = await Promise.all(['one', 'two'].map(title => first.sessions.create({ title })));
  const authority = { authorization: undefined, providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'test-only' }) };
  vi.mocked(executeChildAgents).mockImplementation(async (bundles, _ctx, child) => {
    const workerId = bundles[0]!.objective;
    const messages = [{ role: 'user' as const, content: `Keep ${workerId} private.` }];
    const lineage = createSessionLineage(messages);
    await child.historyStorage!.save(workerId, { messages, lineage, title: workerId, gitRoot: homeDir, scope: 'managed-task-worker' });
    await child.parentOptions.events!.onContextCapacityBlocked!({ checkpoint: { version: 1, sessionId: workerId,
      activeEntryId: lineage.activeEntryId, messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') } }, child.abortSignal,
      { childAgentId: child.actorControl!.callerPath, turnId: child.actorTurnId });
    throw new Error('Suspended');
  });
  const turns = await Promise.all(sessions.map((session, index) => first.agents.spawn(session.id, { taskName: 'same', objective: `private-worker-${index}` }, authority)));
  expect(turns[0]!.turnId).toBe(turns[1]!.turnId);
  for (const [index, session] of sessions.entries()) await vi.waitFor(async () => {
    const runId = `actor_${createHash('sha256').update(JSON.stringify([session.id, turns[index]!.turnId])).digest('hex')}`;
    expect(await first.runs.get(runId)).toMatchObject({ sessionId: session.id, contextRecovery: { checkpoint: { sessionId: `private-worker-${index}` } } });
  });
  await first.close();
  const restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  try {
    vi.mocked(executeChildAgents).mockImplementation(async (bundles, _ctx, child) => {
      expect(child.generationCheckpoint?.sessionId).toBe(bundles[0]!.objective);
      return { results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid', summary: 'Verified', evidenceRefs: [], contradictions: [] }], totalTokensUsed: 0, cancelledChildren: [], mergedFindings: [], mergedArtifacts: [] };
    });
    for (const [index, session] of sessions.entries()) {
      await restarted.agents.followup(session.id, turns[index]!.actorPath, '', { ...authority, resumeCheckpoint: true });
      await vi.waitFor(async () => expect((await restarted.agents.output(session.id, turns[index]!.actorPath, turns[index]!.turnId)).state).toBe('completed'));
    }
  } finally { await restarted.close(); }
});
