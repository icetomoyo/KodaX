import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectEpisodeReviewJob, listPendingEpisodeReviews } from '../dist/sdk-agent.js';
import { deriveCodingMemoryIdentity } from '../dist/sdk-coding.js';
import { FileSessionStorage } from '../dist/sdk-repl.js';
import { createKodaXRuntime, ensureKodaXRuntime, getKodaXRuntimeOwnerState,
  waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';

const provider = 'bundle-memory-openai';
const keyEnv = 'KODAX_BUNDLE_MEMORY_TEST_KEY';
const reviewTool = 'commit_episode_learning_review';

async function eventually(read, accepts, label, signal) {
  const deadline = Date.now() + 10_000;
  do {
    signal.throwIfAborted();
    const value = await read();
    signal.throwIfAborted();
    if (accepts(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}

function finishResponse(response, review) {
  const delta = review ? { tool_calls: [{ index: 0, id: 'review-call', type: 'function',
    function: { name: reviewTool, arguments: JSON.stringify({
      memoryPlan: { actions: [], warnings: [] },
      capabilityDecision: { disposition: 'discard', reasonCodes: ['one_off'] },
    }) } }] } : { content: 'The requested inspection is complete.' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'local-response', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: review ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  })}\n\ndata: [DONE]\n\n`);
}

async function createModelEndpoint() {
  const state = { holdReview: true, holdPrimary: false, reviews: [], primaryRequests: 0,
    disconnected: 0, primaryDisconnected: 0, errors: [] };
  const held = new Map();
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const review = input.tools?.some((tool) => tool.function?.name === reviewTool) === true;
      if (review) state.reviews.push(input);
      else state.primaryRequests += 1;
      if (review ? state.holdReview : state.holdPrimary) {
        held.set(response, review);
        response.on('close', () => {
          held.delete(response);
          if (!response.writableEnded) state[review ? 'disconnected' : 'primaryDisconnected'] += 1;
        });
        return;
      }
      finishResponse(response, review);
    })().catch((error) => {
      state.errors.push(error);
      response.destroy(error);
    });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    server.closeAllConnections();
    if (server.listening) await closeHttpServer(server);
    throw error;
  }
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    releaseHeld() {
      state.holdReview = false;
      state.holdPrimary = false;
      for (const [response, review] of held) finishResponse(response, review);
    },
    async close() {
      server.closeAllConnections();
      await closeHttpServer(server);
    },
  };
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function createFixture(t) {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-bundle-memory-close-'));
  const endpoint = await createModelEndpoint();
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = 'loopback-only-test-key';
  const configHome = path.join(homeDir, '.kodax');
  const sessionsDir = path.join(homeDir, 'sessions');
  const handles = [];
  const evidence = { keep: false };
  t.after(async () => {
    // Release the synthetic response even when an assertion aborts the test.
    endpoint.releaseHeld();
    const closures = await Promise.allSettled(handles.map((handle) => handle.stop()));
    const errors = closures.filter((result) => result.status === 'rejected').map((result) => result.reason);
    try {
      await endpoint.close();
    } catch (error) {
      errors.push(error);
    } finally {
      if (previousKey === undefined) delete process.env[keyEnv];
      else process.env[keyEnv] = previousKey;
    }
    if (!evidence.keep && closures.every((result) => result.status === 'fulfilled')) {
      // mkdtemp owns exactly this absolute directory; never remove a caller root.
      assert.equal(path.dirname(homeDir), await realpath(os.tmpdir()));
      assert.ok(path.basename(homeDir).startsWith('kodax-bundle-memory-close-'));
      await rm(homeDir, { recursive: true, force: true });
    } else {
      t.diagnostic(`Retained test evidence or unverified Runtime profile: ${homeDir}`);
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Bundled review test cleanup failed');
  });
  await mkdir(configHome, { recursive: true });
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ customProviders: [{
    name: provider, protocol: 'openai', baseUrl: endpoint.baseUrl, apiKeyEnv: keyEnv,
    model: 'local-model', contextWindow: 32768, maxOutputTokens: 1024,
  }] }));
  return { homeDir, configHome, sessionsDir, endpoint, handles, evidence, signal: t.signal,
    storage: new FileSessionStorage({ sessionsDir, configHome }) };
}

async function openRuntime(fixture, mode) {
  const common = { homeDir: fixture.homeDir, sessionsDir: fixture.sessionsDir, defaultProvider: provider };
  fixture.signal.throwIfAborted();
  const opening = mode === 'embedded'
    ? createKodaXRuntime(common)
    : ensureKodaXRuntime({ ...common, daemonOrphanExitMs: 1000,
      clientInfo: { name: 'bundle-memory-close', instanceId: randomUUID(), instanceSecret: randomUUID() },
      requirements: { daemonManagement: 1 } });
  let owner;
  let stopped = false;
  const handle = { runtime: undefined,
    async stop() {
      if (stopped) return;
      const runtime = await opening;
      let stopError;
      try {
        if (mode === 'daemon') {
          const state = await runtime.daemon.inspect();
          owner ??= state.owner;
          await runtime.daemon.shutdown();
        }
      } catch (error) { stopError = error; }
      await runtime.close();
      if (mode === 'daemon') await assertDaemonStopped(fixture, owner);
      stopped = true;
      if (stopError !== undefined) throw stopError;
    },
  };
  // Register the startup promise before awaiting it, so timeout cleanup owns it.
  fixture.handles.push(handle);
  const runtime = await opening;
  handle.runtime = runtime;
  fixture.signal.throwIfAborted();
  if (mode === 'daemon') {
    owner = (await runtime.daemon.inspect()).owner;
  }
  return handle;
}

async function assertDaemonStopped(fixture, owner) {
  assert.ok(owner, 'Cannot verify daemon shutdown without its exact owner identity');
  const verified = await waitForRuntimeDaemonShutdown({ configHome: fixture.configHome, owner });
  assert.equal(verified.status, 'succeeded', JSON.stringify(verified));
  const ownership = getKodaXRuntimeOwnerState({ homeDir: fixture.homeDir });
  assert.equal(ownership.ownerStatus, 'unowned');
  assert.equal(ownership.owner, null);
}

async function startTurn(fixture, handle) {
  fixture.signal.throwIfAborted();
  const session = await handle.runtime.sessions.create({ title: 'Review close', projectPath: fixture.homeDir });
  fixture.signal.throwIfAborted();
  const run = await handle.runtime.runs.start({ sessionId: session.id,
    prompt: 'Inspect the current implementation.', mode: 'managed_task',
    options: { provider, model: 'local-model', lsp: false, context: { repoIntelligenceMode: 'off' } },
    ...(handle.lease ? { credential: { leaseId: handle.lease.id, mode: 'scoped', providers: [provider] } } : {}),
  });
  return { session, run, identity: deriveCodingMemoryIdentity({ provider,
    context: { configHome: fixture.configHome, executionCwd: fixture.homeDir, gitRoot: fixture.homeDir },
  }, fixture.homeDir, session.id) };
}

async function completeTurn(fixture, handle) {
  const turn = await startTurn(fixture, handle);
  assert.equal((await turn.run.result).phase, 'completed');
  return turn;
}

async function reviewReceipts(storage, sessionId) {
  const lineage = await storage.loadFullLineage(sessionId);
  return lineage?.entries.filter((entry) => entry.type === 'memory_review_receipt') ?? [];
}

async function assertDeferredReview(fixture, identity, session, jobId, expectedProviderAttempts = 0) {
  const snapshot = await inspectEpisodeReviewJob(identity, jobId);
  assert.equal(snapshot?.state.status, 'pending');
  assert.equal(snapshot.state.claimToken, undefined);
  assert.equal(snapshot.state.providerAttempts, expectedProviderAttempts);
  if (expectedProviderAttempts === 0) assert.equal(snapshot.state.nextAttemptAt, undefined);
  else assert.equal(Date.parse(snapshot.state.nextAttemptAt) - Date.parse(snapshot.state.updatedAt), 60_000);
  assert.equal(snapshot.state.applyAttempts, 0);
  assert.equal(snapshot.state.completionAttempts, 0);
  assert.ok(snapshot.input);
  assert.equal(snapshot.decision, undefined);
  assert.deepEqual(snapshot.actions, []);
  assert.deepEqual(await reviewReceipts(fixture.storage, session.id), []);
  return snapshot;
}

async function resumeReviewInEmbeddedRuntime(fixture, session, jobId) {
  fixture.endpoint.state.holdReview = false;
  fixture.endpoint.state.holdPrimary = false;
  const replacement = await openRuntime(fixture, 'embedded');
  await completeTurn(fixture, replacement);
  const receipts = await eventually(() => reviewReceipts(fixture.storage, session.id),
    (entries) => entries.some((entry) => entry.jobId === jobId), 'recovered review receipt', fixture.signal);
  assert.equal(receipts.filter((entry) => entry.jobId === jobId).length, 1);
  await replacement.stop();
}

for (const mode of ['embedded', 'daemon']) {
  // Use the SDK's ambient credential mode with a loopback-only key. Run-scoped
  // broker authority may already be closed when terminal review begins.
  test(`bundled ${mode} cancels ambient-credential production review HTTP and the next Runtime resumes its durable job`,
    { timeout: 60_000 }, async (t) => {
      const fixture = await createFixture(t);
      try {
        const original = await openRuntime(fixture, mode);
        const { identity, session } = await completeTurn(fixture, original);
        await eventually(() => fixture.endpoint.state.reviews.length, (count) => count === 1, 'review HTTP request', t.signal);
        const [job] = await listPendingEpisodeReviews(identity);
        assert.equal(job?.version, 2);
        const started = performance.now();
        await original.stop();
        t.diagnostic(`${mode} close and shutdown verification: ${Math.round(performance.now() - started)}ms`);
        // Shutdown must disconnect the production reviewer before recovery begins.
        await eventually(() => fixture.endpoint.state.disconnected, (count) => count === 1, 'HTTP peer disconnect', t.signal);
        const deferred = await assertDeferredReview(fixture, identity, session, job.jobId);
        await delay(100);
        assert.deepEqual(await assertDeferredReview(fixture, identity, session, job.jobId), deferred);
        await resumeReviewInEmbeddedRuntime(fixture, session, job.jobId);
        assert.ok(fixture.endpoint.state.reviews.length >= 2);
        assert.deepEqual(fixture.endpoint.state.errors, []);
      } catch (error) {
        fixture.evidence.keep = true;
        t.diagnostic(JSON.stringify({ reviewRequests: fixture.endpoint.state.reviews.length }));
        throw error;
      }
    });
}

test('bundled scoped daemon aborts a Run with an active startup review before quit and recovery',
  { timeout: 100_000 }, async (t) => {
    const fixture = await createFixture(t);
    try {
      const original = await openRuntime(fixture, 'daemon');
      original.lease = await original.runtime.credentials.registerScoped(
        { providers: [provider] }, async () => 'loopback-only-test-key',
      );
      const first = await completeTurn(fixture, original);
      const [job] = await listPendingEpisodeReviews(first.identity);
      assert.equal(job?.version, 2);
      // A settled Run's closed authority leaves its terminal review recoverable.
      await eventually(() => inspectEpisodeReviewJob(first.identity, job.jobId),
        (snapshot) => snapshot?.state.status === 'pending'
          && snapshot.state.lastError?.includes('provider is not configured'), 'deferred terminal review', t.signal);
      const primaryBefore = fixture.endpoint.state.primaryRequests;
      fixture.endpoint.state.holdPrimary = true;
      const second = await startTurn(fixture, original);
      await eventually(() => fixture.endpoint.state.reviews.length, (count) => count === 1, 'scoped startup review HTTP', t.signal);
      await eventually(() => fixture.endpoint.state.primaryRequests, (count) => count > primaryBefore, 'active primary HTTP', t.signal);
      // Space stops its active Run before requesting the daemon's safe quit.
      await original.runtime.runs.abort(second.run.runId);
      assert.equal((await second.run.result).phase, 'interrupted');
      await eventually(() => inspectEpisodeReviewJob(first.identity, job.jobId),
        (snapshot) => snapshot?.state.status === 'pending' && snapshot.state.providerAttempts === 1,
        'Run-scoped cancellation settlement before quit', t.signal);
      await original.stop();
      await eventually(() => fixture.endpoint.state.disconnected, (count) => count === 1, 'review HTTP peer disconnect', t.signal);
      assert.ok(fixture.endpoint.state.primaryDisconnected > 0);
      const deferred = await assertDeferredReview(fixture, first.identity, first.session, job.jobId, 1);
      // Run lease revocation has an existing provider-error backoff. Runtime-close
      // cancellation above has zero attempts; do not conflate the two contracts.
      const waitMs = Math.max(0, Date.parse(deferred.state.nextAttemptAt) - Date.now()) + 25;
      t.diagnostic(`Waiting ${waitMs}ms for the existing scoped-provider retry deadline`);
      await delay(waitMs, undefined, { signal: t.signal });
      await resumeReviewInEmbeddedRuntime(fixture, first.session, job.jobId);
      assert.deepEqual(fixture.endpoint.state.errors, []);
    } catch (error) {
      fixture.evidence.keep = true;
      t.diagnostic(JSON.stringify({ reviewRequests: fixture.endpoint.state.reviews.length,
        disconnected: fixture.endpoint.state.disconnected, primaryDisconnected: fixture.endpoint.state.primaryDisconnected }));
      throw error;
    }
  });
