import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LearnedAreaStore, commitLearnedSkillRevision, createLearnedCapabilityScope, listLearnedSkillUsageReceipts,
  resolveProjectLearnedAreaRoot } from '@kodax-ai/agent';
import { KodaXBaseProvider, KodaXProviderError, registerModelProvider, type KodaXMessage, type KodaXProviderConfig,
  type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { runManagedTask } from './task-engine.js';
import { runKodaX } from './agent.js';
import { awaitLatestCodingMemoryReviewDrain } from './memory-runtime.js';

const cases = (['sa', 'ama'] as const).flatMap(mode => [
  ...(['success', 'error', 'cancel'] as const).map(ending => ({ mode, ending, catalog: 'HOST_CUSTOM_SKILL_CATALOG_MUST_SURVIVE', label: 'custom' })),
  ...['', '   '].map(catalog => ({ mode, ending: 'success' as const, catalog, label: catalog === '' ? 'empty' : 'whitespace' })),
]);
it.each(cases)(
  'offers, admits and releases a project canary through $mode ($ending, $label catalog)', async ({ mode, ending, catalog }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-learned-entry-'));
  const project = path.join(root, 'project');
  const configHome = path.join(root, 'home');
  await mkdir(project);
  const formal = path.join(project, '.kodax', 'skills', 'host-omitted-formal');
  await mkdir(formal, { recursive: true });
  await writeFile(path.join(formal, 'SKILL.md'), '---\nname: host-omitted-formal\ndescription: Omitted by the trusted Host catalog\n---\nFormal instructions.');
  const identity = { configHome, tenantId: 'fixture-tenant', agentId: 'coding-agent', projectId: 'fixture-project', sessionId: 'fixture-session' };
  const store = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, identity));
  await store.initialize();
  const record = await commitLearnedSkillRevision(store, {
    scope: createLearnedCapabilityScope(configHome, identity), disposition: 'project_canary', operation: 'create',
    spec: { name: 'verify-release', description: 'Verify a release using recorded evidence.', purpose: 'Verify release state.',
      triggers: ['A release needs verification.'], steps: ['Read recorded verification evidence.'],
      verification: ['Require a verified check.'], pitfalls: ['Self-report is not verification.'] },
    provenance: { jobId: 'fixture', inputHash: 'a'.repeat(64), decisionId: 'fixture', actionId: 'fixture' },
  });
  const requests: { system: string; messages: KodaXMessage[] }[] = [];
  const controller = new AbortController();
  let activeMemoryWork = 0, completedNotice = false, ownedReleases = 0;
  const originalWrite = LearnedAreaStore.prototype.writeCapability;
  const write = vi.spyOn(LearnedAreaStore.prototype, 'writeCapability').mockImplementation(async function (this: LearnedAreaStore, value) {
    if (mode === 'ama' && value.schemaVersion === 2 && value.capabilityId === record.capabilityId
      && value.canary.invocationCount > 0 && value.canary.binding === undefined) {
      expect(activeMemoryWork).toBeGreaterThan(0);
      expect(completedNotice).toBe(false);
      ownedReleases++;
    }
    return originalWrite.call(this, value);
  });
  const failure = new KodaXProviderError('fixture permanent request failure', 'learned-entry-fixture', { httpStatus: 400, retryable: false });
  class Provider extends KodaXBaseProvider {
    readonly name = 'learned-entry-fixture';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { model: 'fixture', apiKeyEnv: 'UNUSED_OFFLINE_FIXTURE_KEY', supportsThinking: false };
    override isConfigured(): boolean { return true; }
    async stream(messages: KodaXMessage[], _tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> {
      requests.push({ system, messages: structuredClone(messages) });
      if (requests.length > 1 && ending === 'error') throw failure;
      if (requests.length > 1 && ending === 'cancel') {
        controller.abort();
        controller.signal.throwIfAborted();
      }
      return requests.length === 1
        ? { textBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'learned-load', name: 'skill', input: { skill: 'verify-release' } }],
            thinkingBlocks: [], stopReason: 'tool_use' }
        : { textBlocks: [{ type: 'text', text: 'Loaded instructions; no verification claim.' }], toolBlocks: [],
            thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider('learned-entry-fixture', () => new Provider());
  try {
    const running = (mode === 'sa' ? runKodaX : runManagedTask)({ provider: 'learned-entry-fixture', abortSignal: controller.signal,
      agentMode: mode, effort: 'none', lsp: false, maxIter: 3, session: { id: identity.sessionId },
      events: { runMemoryWork: async work => {
        activeMemoryWork++;
        try { await work(controller.signal); } finally { activeMemoryWork--; }
      }, onComplete: () => { completedNotice = true; } },
      context: { executionCwd: project, gitRoot: project, configHome, memoryIdentity: identity, repoIntelligenceMode: 'off',
        skillsPrompt: catalog },
    }, 'Load the project verification instructions.');
    if (mode === 'ama' && ending !== 'success') {
      if (ending === 'error') await expect(running).rejects.toBe(failure);
      else await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    } else if (ending === 'error') {
      expect((await running).success).toBe(false);
    } else {
      const result = await running;
      expect(result.success).toBe(true);
      if (ending === 'cancel') expect(result.interrupted).toBe(true);
    }
    // AMA keeps its dynamic catalog outside the stable system prefix.
    expect(`${requests[0]?.system}\n${JSON.stringify(requests[0]?.messages)}`).toContain('verify-release');
    const prompt = `${requests[0]?.system}\n${JSON.stringify(requests[0]?.messages)}`;
    if (catalog.trim()) expect(prompt).toContain(catalog);
    expect(prompt).not.toContain('host-omitted-formal');
    expect(JSON.stringify(requests[1]?.messages)).toContain('Read recorded verification evidence.');
    const completed = await store.readCapability(record.capabilityId);
    expect(completed?.schemaVersion).toBe(2);
    if (completed?.schemaVersion !== 2) throw new Error('Expected a scoped learned capability');
    expect(completed.canary).toMatchObject({ invocationCount: 1, verifiedSuccesses: 0 });
    expect(completed.canary).not.toHaveProperty('binding');
    if (mode === 'ama') expect(ownedReleases).toBeGreaterThan(0);
    const receipts = await listLearnedSkillUsageReceipts(store, identity.sessionId);
    expect(receipts.map(receipt => receipt.kind).sort()).toEqual(['invoked', 'offered', 'outcome']);
    expect(receipts.find(receipt => receipt.kind === 'outcome')).toMatchObject({ outcome: 'inconclusive' });
  } finally {
    write.mockRestore();
    unregister();
    await awaitLatestCodingMemoryReviewDrain(15_000);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
