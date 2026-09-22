import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectEpisodeReviewJob, listPendingEpisodeReviews, resolveMemoryRoot,
  LearnedAreaStore, commitLearnedSkillRevision, createLearnedCapabilityScope, resolveProjectLearnedAreaRoot,
  type UnifiedLearningReviewRunner } from '@kodax-ai/agent';
import { deriveCodingMemoryIdentity } from '@kodax-ai/coding';
import { KodaXBaseProvider, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime, type KodaXEvents, type RuntimeRunMode } from './sdk-runtime.js';

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function awaitEvent<T>(event: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([event, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function reviewerGate() {
  const entered = deferred<AbortSignal>();
  const aborted = deferred<void>();
  const release = deferred<void>();
  const cleanup = deferred<void>();
  const reviewer: UnifiedLearningReviewRunner = async (input, signal) => {
    if (!signal) throw new Error('Runtime review must supply a cancellation signal');
    entered.resolve(signal);
    const stop = deferred<void>();
    const onAbort = () => stop.resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (!signal.aborted) await Promise.race([release.promise, stop.promise]);
      if (signal.aborted) {
        aborted.resolve();
        await cleanup.promise;
        throw Object.assign(new Error('review cancelled'), { name: 'AbortError' });
      }
      return { memoryPlan: { trigger: input.memory.trigger, createdAt: new Date().toISOString(),
        sourceRefs: input.memory.sourceRefs, candidateRefs: input.memory.candidateRefs,
        actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: [] } };
    } finally { signal.removeEventListener('abort', onAbort); }
  };
  return { reviewer, entered: entered.promise, aborted: aborted.promise,
    release: () => release.resolve(), finishCleanup: () => cleanup.resolve() };
}

async function initializeRuntime(root: string, providerName: string, unregister: () => void) {
  let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  try {
    runtime = await createKodaXRuntime({ homeDir: root,
      sessionsDir: path.join(root, 'sessions'), defaultProvider: providerName });
    const session = await runtime.sessions.create({ title: 'Memory exit', projectPath: root });
    return { runtime, session };
  } catch (error) {
    try { await runtime?.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Runtime fixture initialization and close failed'); }
    finally { unregister(); }
    // Preserve the fixture on initialization failure for diagnosis.
    throw error;
  }
}

async function fixture(existingRoot?: string) {
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-memory-exit-'));
  const providerName = `memory-exit-${randomUUID()}`;
  let modelGate: { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
  class Provider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_MEMORY_EXIT_TEST_KEY', model: 'offline', supportsThinking: false,
    };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      const held = modelGate;
      modelGate = undefined;
      held?.entered.resolve();
      await held?.release.promise;
      args[5]?.throwIfAborted();
      return { textBlocks: [{ type: 'text', text: 'finished' }], toolBlocks: [], thinkingBlocks: [] };
    }
  }
  vi.stubEnv('KODAX_MEMORY_EXIT_TEST_KEY', 'offline-test');
  const unregister = registerModelProvider(providerName, () => new Provider());
  const { runtime, session } = await initializeRuntime(root, providerName, unregister);
  const identity = deriveCodingMemoryIdentity({ provider: providerName,
    context: { configHome: path.join(root, '.kodax'), executionCwd: root, gitRoot: root } }, root, session.id);
  return { root, runtime, session, identity,
    start: (reviewer: UnifiedLearningReviewRunner, mode: RuntimeRunMode = 'managed_task', events?: KodaXEvents) =>
      runtime.runs.start({ sessionId: session.id, prompt: 'Inspect the current implementation.', mode,
        options: { model: 'offline', lsp: false, learningReviewer: reviewer, events,
          context: { repoIntelligenceMode: 'off' } } }),
    pauseNextRun() {
      const held = { entered: deferred<void>(), release: deferred<void>() };
      modelGate = held;
      return { entered: held.entered.promise, release: () => held.release.resolve() };
    },
    async close(removeRoot = true) {
      try { await runtime.close(); }
      finally { unregister(); }
      if (removeRoot) await fs.rm(root, { recursive: true, force: true });
    },
  };
}

it.each(['coding', 'managed_task'] as const)('cancels owned %s terminal review and waits for reviewer cleanup before releasing its claim', async (mode) => {
  const f = await fixture();
  const review = reviewerGate();
  try {
    const run = await f.start(review.reviewer, mode);
    await expect(run.result).resolves.toMatchObject({ phase: 'completed' });
    const signal = await awaitEvent(review.entered, 'terminal reviewer started');
    const [pending] = await listPendingEpisodeReviews(f.identity);
    expect(pending?.version).toBe(2);
    if (pending?.version !== 2) throw new Error('Expected a durable v2 review job');
    const closing = f.runtime.close();
    await awaitEvent(Promise.race([closing, review.aborted]), 'reviewer cancellation');
    expect(signal.aborted).toBe(true);
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    review.finishCleanup();
    await awaitEvent(closing, 'terminal review close');
    const snapshot = await inspectEpisodeReviewJob(f.identity, pending.jobId);
    expect(snapshot?.state).toMatchObject({ status: 'pending', providerAttempts: 0 });
    expect(snapshot?.state.claimToken).toBeUndefined();
    expect(snapshot?.input).toBeDefined();
    expect(snapshot?.decision).toBeUndefined();
    expect(snapshot?.actions).toEqual([]);
  } finally {
    review.release(); review.finishCleanup();
    await f.close();
  }
});

function holdMemoryWrite(root: string, phase: 'setup' | 'finalize' | 'maintenance' | 'skill-release') {
  const entered = deferred<void>();
  const release = deferred<void>();
  const original = fs.writeFile;
  let started = false;
  let finished = false;
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    const file = path.resolve(String(args[0]));
    const target = file.startsWith(path.join(root, '.kodax') + path.sep)
      && (phase === 'skill-release' ? String(args[1]).includes('"canary":') && !String(args[1]).includes('"binding":')
        : phase === 'maintenance' ? file.includes(`${path.sep}.governance${path.sep}reports${path.sep}`)
        : phase === 'setup' ? path.basename(file).startsWith('branch-authority.json.')
          : file.includes(`${path.sep}pending${path.sep}`));
    const held = target && !started;
    if (held) { started = true; entered.resolve(); }
    try {
      if (held) await release.promise;
      await original(...args);
    } finally { if (held) finished = true; }
  });
  syncBuiltinESMExports();
  return { entered: entered.promise, release: () => release.resolve(), finished: () => finished };
}

it.each([
  ['coding', 'setup'], ['coding', 'finalize'],
  ['managed_task', 'setup'], ['managed_task', 'finalize'],
  ['managed_task', 'maintenance'],
] as const)('settles an already started %s memory %s write before close returns', async (mode, phase) => {
  const f = await fixture();
  const memoryWrite = holdMemoryWrite(f.root, phase);
  const review = reviewerGate();
  review.release();
  try {
    if (phase === 'maintenance') {
      vi.stubEnv('KODAX_HOME', path.join(f.root, '.kodax'));
      const memoryRoot = resolveMemoryRoot(f.root);
      if (!memoryRoot.startsWith(f.root + path.sep)) throw new Error('Memory fixture must stay inside its temporary root');
      await fs.mkdir(memoryRoot, { recursive: true });
      for (const name of ['alpha', 'beta']) {
        await fs.writeFile(path.join(memoryRoot, `${name}.md`),
          `---\nname: Shared memory\ndescription: ${name} duplicate\ntype: project\n---\nsame body\n`);
      }
    }
    const run = await f.start(review.reviewer, mode);
    await awaitEvent(memoryWrite.entered, `${mode} memory ${phase} write`);
    let closed = false;
    const closing = f.runtime.close().then(() => {
      expect(memoryWrite.finished()).toBe(true);
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    memoryWrite.release();
    await awaitEvent(closing, `${mode} memory ${phase} close`);
    await run.result;
  } finally {
    memoryWrite.release(); review.finishCleanup();
    await f.close();
  }
});

async function seedLearnedCanary(f: Awaited<ReturnType<typeof fixture>>) {
  const configHome = path.join(f.root, '.kodax');
  const scope = { tenantId: f.identity.tenantId, projectId: f.identity.projectId! };
  const store = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, scope));
  await store.initialize();
  const record = await commitLearnedSkillRevision(store, {
    scope: createLearnedCapabilityScope(configHome, scope), operation: 'create', disposition: 'project_canary',
    spec: { name: 'verify-release', description: 'Use to validate this project before release.',
      purpose: 'Verify release evidence.', triggers: ['A release needs verification.'],
      steps: ['Run the release test suite.'], verification: ['Require a passing artifact.'],
      pitfalls: ['Do not trust self-reports.'] },
    provenance: { jobId: 'memory-exit-fixture', inputHash: 'c'.repeat(64),
      decisionId: 'memory-exit-decision', actionId: 'memory-exit-action' },
  });
  return { store, record };
}

it('settles a real learned canary release write before classic Runtime close returns', async () => {
  const f = await fixture();
  const review = reviewerGate();
  review.release();
  let write: ReturnType<typeof holdMemoryWrite> | undefined;
  let verified = false;
  try {
    const { store, record } = await seedLearnedCanary(f);
    write = holdMemoryWrite(f.root, 'skill-release');
    const run = await f.start(review.reviewer, 'coding');
    await awaitEvent(write.entered, 'learned canary release write');
    const bound = await store.readCapability(record.capabilityId);
    if (bound?.schemaVersion !== 2) throw new Error('Expected a scoped canary before release');
    expect(bound.canary).toHaveProperty('binding');
    const closing = f.runtime.close();
    // The actual file write stays gated; give unrelated close IO time to settle.
    const closedBeforeRelease = await Promise.race([closing.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))]);
    expect(closedBeforeRelease).toBe(false);
    write.release();
    await awaitEvent(closing, 'learned canary release close');
    await run.result;
    const released = await store.readCapability(record.capabilityId);
    if (released?.schemaVersion !== 2) throw new Error('Expected a scoped canary after release');
    expect(released.canary).not.toHaveProperty('binding');
    verified = true;
  } finally {
    write?.release(); review.finishCleanup();
    await f.close(verified);
  }
});

it('isolates review cancellation between Runtimes without delaying a successor Run', async () => {
  const first = await fixture();
  const second = await fixture();
  const firstReview = reviewerGate();
  const secondReview = reviewerGate();
  try {
    await (await first.start(firstReview.reviewer)).result;
    const firstSignal = await awaitEvent(firstReview.entered, 'first reviewer started');
    await expect((await first.start(firstReview.reviewer)).result).resolves.toMatchObject({ phase: 'completed' });
    await (await second.start(secondReview.reviewer)).result;
    const secondSignal = await awaitEvent(secondReview.entered, 'second reviewer started');
    const closing = first.runtime.close();
    expect(first.runtime.close()).toBe(closing);
    await awaitEvent(firstReview.aborted, 'first reviewer cancelled');
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
    firstReview.finishCleanup();
    await awaitEvent(closing, 'isolated Runtime close');
    await first.runtime.close();
    expect(secondSignal.aborted).toBe(false);
  } finally {
    firstReview.release(); firstReview.finishCleanup();
    secondReview.release(); secondReview.finishCleanup();
    await Promise.all([first.close(), second.close()]);
  }
});

it.each(['coding', 'managed_task'] as const)('recovers unfinished review at %s startup without delaying Stop', async (mode) => {
  const original = await fixture();
  const interruptedReview = reviewerGate();
  const resumedReview = reviewerGate();
  let resumed: Awaited<ReturnType<typeof fixture>> | undefined;
  let model: ReturnType<Awaited<ReturnType<typeof fixture>>['pauseNextRun']> | undefined;
  try {
    await (await original.start(interruptedReview.reviewer, mode)).result;
    await awaitEvent(interruptedReview.entered, 'original reviewer started');
    const [pending] = await listPendingEpisodeReviews(original.identity);
    if (pending?.version !== 2) throw new Error('Expected a durable v2 review job');
    const closing = original.runtime.close();
    await awaitEvent(interruptedReview.aborted, 'original reviewer cancelled');
    interruptedReview.finishCleanup();
    await awaitEvent(closing, 'original Runtime close');
    const before = await inspectEpisodeReviewJob(original.identity, pending.jobId);
    resumed = await fixture(original.root);
    model = resumed.pauseNextRun();
    const receipt = deferred<void>();
    const run = await resumed.start(resumedReview.reviewer, mode, { onMemoryReviewReceipt(event) {
      if (event.jobId === pending.jobId) receipt.resolve();
    } });
    await awaitEvent(Promise.all([model.entered, resumedReview.entered]), 'startup review and Run started');
    const processing = await inspectEpisodeReviewJob(original.identity, pending.jobId);
    expect(processing?.state.status).toBe('processing');
    expect(processing!.state.claimEpoch).toBeGreaterThan(before!.state.claimEpoch);
    expect(processing?.input?.evidenceHash).toBe(before?.input?.evidenceHash);
    await expect(resumed.runtime.runs.abort(run.runId)).resolves.toMatchObject({ accepted: true });
    model.release();
    await expect(run.result).resolves.toMatchObject({ phase: 'interrupted' });
    expect((await resumedReview.entered).aborted).toBe(false);
    resumedReview.release();
    await awaitEvent(receipt.promise, 'resumed review completed');
    expect(await listPendingEpisodeReviews(original.identity)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ jobId: pending.jobId })]));
  } finally {
    interruptedReview.release(); interruptedReview.finishCleanup();
    resumedReview.release(); resumedReview.finishCleanup(); model?.release();
    try { await resumed?.close(false); } finally { await original.close(); }
  }
});

it('persists the completed memory job before a completion observer closes Runtime', async () => {
  const f = await fixture();
  const review = reviewerGate();
  let started = false;
  let closing: Promise<void> | undefined;
  let pendingAtCompletion: ReturnType<typeof listPendingEpisodeReviews> | undefined;
  void review.entered.then(() => { started = true; });
  try {
    const run = await f.start(review.reviewer, 'managed_task', { onManagedTaskStatus(status) {
      if (status.phase === 'completed') {
        pendingAtCompletion ??= listPendingEpisodeReviews(f.identity);
        closing ??= f.runtime.close();
      }
    } });
    await run.result;
    expect(closing).toBeDefined();
    await awaitEvent(closing!, 'Runtime close from completion event');
    expect(await pendingAtCompletion).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 2, ownerSessionRef: f.session.id }),
    ]));
    expect(started).toBe(false);
  } finally {
    review.release(); review.finishCleanup();
    await f.close();
  }
});
