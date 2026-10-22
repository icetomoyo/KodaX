import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createSessionLineage, type AgentActorSnapshot, type KodaXSessionData, type KodaXSessionStorage } from '@kodax-ai/agent';
import { CodingActorSession } from '../agent-runtime/actor-runtime.js';
import { executeChildAgents } from '../child-executor.js';
import { createCodingWorkflowBackend } from './agent-adapter.js';
import type { KodaXOptions, KodaXToolExecutionContext } from '../types.js';

vi.mock('../child-executor.js', async importOriginal => ({ ...await importOriginal<typeof import('../child-executor.js')>(), executeChildAgents: vi.fn() }));

it.each(['none', 'repair', 'repair-restart'])('resumes the original native Workflow leaf without its script or prior tool calls after executor reconstruction (%s)', async scenario => {
  const repair = scenario !== 'none';
  let saved: AgentActorSnapshot | undefined;
  const histories = new Map<string, KodaXSessionData>();
  const storage: KodaXSessionStorage = { save: async (id, data) => { histories.set(id, structuredClone(data)); },
    load: async id => structuredClone(histories.get(id) ?? null) };
  const store = { load: async () => saved === undefined ? undefined : structuredClone(saved),
    save: async (value: AgentActorSnapshot) => { saved = structuredClone(value); } };
  const options: KodaXOptions = { provider: 'deepseek', session: { storage }, context: { runtimeRunId: 'parent-run' } };
  const first = new CodingActorSession({ store, historyStorage: storage });
  await first.initialize();
  const ctx = { backups: new Map<string, string>(), runtimeRunId: 'parent-run' } as KodaXToolExecutionContext;
  ctx.actorHost = first;
  ctx.actorControl = first.attach(ctx, options);
  ctx.actorControl = await first.createWorkflowOwner('/root', 'original-workflow');
  const messages = [{ role: 'user' as const, content: 'JSON only. EDIT019 is complete; never repeat it.' }];
  const lineage = createSessionLineage(messages);
  await storage.save('original-worker', { messages, lineage, scope: 'managed-task-worker', title: 'Original worker', gitRoot: '' });
  const checkpoint = { version: 1 as const, sessionId: 'original-worker', activeEntryId: lineage.activeEntryId,
    messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
  vi.mocked(executeChildAgents).mockImplementationOnce(async (_bundles, _ctx, child) => {
    await child.parentOptions.events!.onContextCapacityBlocked!({ checkpoint }, child.abortSignal);
    throw new Error('Old execution must remain suspended');
  });
  const backend = createCodingWorkflowBackend({ ctx, runId: 'original-workflow', childOptions: {
    maxIterationsPerChild: 12, parentRole: 'worker', parentHarness: 'tool-dispatch', historyStorage: storage,
    parentOptions: { events: { onContextCapacityBlocked: async (_state, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }) } },
  } });
  const task = await backend.spawn({ name: 'verify', prompt: 'Verify the existing edit.', readOnly: !repair, constraints: ['JSON only'],
    ...(repair ? { verification: { requiresMutation: false, rejectPreparatoryFinalText: true } } : {}) });
  const actor = first.rootControl().list().actors.find(value => value.path !== '/root' && value.kind !== 'workflow')!;
  await vi.waitFor(() => expect(first.rootControl().get(actor.path).turns[0]?.checkpoint).toBeDefined());
  const originalBundle = vi.mocked(executeChildAgents).mock.calls[0]![0][0];
  await first.close();
  const second = new CodingActorSession({ store, historyStorage: storage });
  await second.initialize();
  const fresh = { backups: new Map<string, string>(), actorHost: second, runtimeRunId: 'parent-run' } as KodaXToolExecutionContext;
  fresh.parentEvents = { onContextCapacityBlocked: async (_state, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }) };
  fresh.actorControl = second.attach(fresh, options);
  vi.mocked(executeChildAgents).mockImplementationOnce(async (bundles, _ctx, child) => {
    expect(bundles).toEqual([originalBundle]);
    expect(child.generationCheckpoint).toEqual(checkpoint);
    expect(child.actorTurnId).toBe(actor.currentTurnId);
    expect(child.initialMessages).toEqual([]);
    expect(child.actorControl).toBeUndefined();
    expect(child.workflowCorrelation).toMatchObject({ workflowRunId: 'original-workflow', childAgentId: task.taskId });
    return { results: [{ childId: task.taskId, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
      summary: repair ? 'I will now start inspecting the files.' : '{"verified":"EDIT019"}', evidenceRefs: [], contradictions: [] }], totalTokensUsed: 0, cancelledChildren: [], mergedFindings: [], mergedArtifacts: [] };
  });
  if (repair) vi.mocked(executeChildAgents).mockImplementationOnce(async (bundles, _ctx, child) => {
    expect(bundles[0]?.objective).toContain('Workflow verification repair');
    expect(child.generationCheckpoint).toBeUndefined();
    expect(child.initialMessages).toEqual(messages);
    if (scenario === 'repair-restart') {
      await child.parentOptions.events!.onContextCapacityBlocked!({ checkpoint }, child.abortSignal);
      throw new Error('Repair remains suspended');
    }
    return { results: [{ childId: task.taskId, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
      summary: '{"verified":"EDIT019"}', evidenceRefs: [], contradictions: [] }], totalTokensUsed: 0, cancelledChildren: [], mergedFindings: [], mergedArtifacts: [] };
  });
  let active = second;
  try {
    await second.resumeCheckpointTurn(actor.path, actor.currentTurnId!);
    if (scenario === 'repair-restart') {
      await vi.waitFor(() => expect(second.rootControl().get(actor.path).turns[0]?.checkpoint).toMatchObject({ workflow: { repairAttempts: 1 } }));
      await second.close();
      active = new CodingActorSession({ store, historyStorage: storage });
      await active.initialize();
      const latest = { ...fresh, actorHost: active };
      latest.actorControl = active.attach(latest, options);
      vi.mocked(executeChildAgents).mockImplementationOnce(async (bundles, _ctx, child) => {
        expect(bundles[0]?.objective).toContain('Repair attempt 1/2');
        expect(child.generationCheckpoint).toEqual(checkpoint);
        return { results: [{ childId: task.taskId, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid', summary: '{"verified":"EDIT019"}', evidenceRefs: [], contradictions: [] }], totalTokensUsed: 0, cancelledChildren: [], mergedFindings: [], mergedArtifacts: [] };
      });
      await active.resumeCheckpointTurn(actor.path, actor.currentTurnId!);
    }
    await vi.waitFor(() => expect(active.rootControl().output(actor.path, actor.currentTurnId!).state).toBe('completed'));
    expect(active.rootControl().output(actor.path, actor.currentTurnId!).structured).toMatchObject({ workflowRunId: 'original-workflow', taskId: task.taskId });
    expect(saved?.mailboxes['/root']).toContainEqual(expect.objectContaining({ kind: 'completion', senderPath: actor.path, turnId: actor.currentTurnId }));
    expect(executeChildAgents).toHaveBeenCalledTimes(scenario === 'repair-restart' ? 4 : repair ? 3 : 2);
  } finally { await active.close(); vi.mocked(executeChildAgents).mockReset(); }
});
