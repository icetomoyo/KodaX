import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileSessionStorage } from '../dist/sdk-repl.js';
import { connectKodaXRuntime, waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';

const summary = '## Goal\nContinue implementing the requested feature.\n## Progress\n'
  + 'The earlier investigation identified the affected components and preserved the user requirements.\n'
  + '## Next Steps\nFinish implementation and verify the behavior with regression tests.';

async function reconnectAfterTakeover(original, options, leaseId, broker) {
  const replacement = await connectKodaXRuntime(options);
  try {
    for (let attempt = 0; attempt < 40 && original.connection.current().state !== 'disconnected'; attempt += 1) {
      await delay(25);
    }
    assert.equal(original.connection.current().state, 'disconnected');
    assert.equal(original.connection.current().reconnectable, true);
    await replacement.close();
    await assert.rejects(original.credentials.registerScoped(
      { providers: ['daemon-test-openai'] }, broker,
    ), /transport.*closed/i);
    const resumed = await connectKodaXRuntime(options);
    await original.close();
    try {
      await resumed.credentials.resumeScoped(leaseId, broker);
      return resumed;
    } catch (error) {
      await resumed.close();
      throw error;
    }
  } finally {
    await replacement.close();
  }
}

test('bundled daemon routes manual and managed compaction through the v2 broker', { timeout: 60_000 }, async (t) => {
  // macOS /var tmp paths are symlinks; the Runtime requires canonical roots.
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-bundle-compaction-'));
  const sessionsDir = path.join(homeDir, 'sessions');
  let runtime;
  let owner;
  let rejectRequest = false;
  const receivedKeys = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the local test request. */ }
    receivedKeys.push(request.headers.authorization ?? request.headers['x-api-key']);
    if (rejectRequest) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'daemon-test-auth-rejection' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({
      id: 'test-summary', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: summary }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5000, completion_tokens: 80, total_tokens: 5080 },
    })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    try {
      // Test timeout does not unwind an unresolved run.result; this hook must
      // release the client even if the test body's finally was never reached.
      await runtime?.close();
      if (owner) {
        const stopped = await waitForRuntimeDaemonShutdown({
          configHome: path.join(homeDir, '.kodax'), owner,
        });
        assert.equal(stopped.status, 'succeeded');
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(homeDir, { recursive: true, force: true });
    }
  });
  const customProviders = ['openai', 'anthropic'].map((protocol) => ({
    name: `daemon-test-${protocol}`, protocol,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKeyEnv: 'KODAX_DAEMON_TEST_UNSET_KEY', model: 'test-model',
    contextWindow: 32768, maxOutputTokens: 1024,
  }));
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ customProviders }));
  const storage = new FileSessionStorage({ sessionsDir });
  for (const name of [...customProviders.map(({ name }) => name), 'managed-session']) {
    await storage.save(name, {
      title: name, gitRoot: homeDir,
      messages: Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index % 2 === 0 ? `Please continue step ${index}.` : 'Earlier implementation evidence. '.repeat(180),
      })),
    });
  }
  const connectionOptions = {
    homeDir, sessionsDir, autoStart: true, daemonOrphanExitMs: 1000,
    clientInfo: { name: 'bundle-compaction-test', instanceId: 'bundle-compaction', instanceSecret: randomUUID() },
    requirements: { providerCredentialBroker: 2, daemonManagement: 1 },
  };
  runtime = await connectKodaXRuntime(connectionOptions);
  try {
    owner = (await runtime.daemon.inspect()).owner;
    const brokerRequests = [];
    const broker = async (request) => {
      brokerRequests.push(request);
      return 'daemon-test-scoped-key';
    };
    const lease = await runtime.credentials.registerScoped(
      { providers: customProviders.map(({ name }) => name) },
      broker,
    );
    runtime = await reconnectAfterTakeover(runtime, connectionOptions, lease.id, broker);
    for (const { name, protocol } of customProviders) {
      rejectRequest = protocol === 'anthropic';
      const operationId = `compact-${name}`;
      const operation = runtime.sessions.compact({
        sessionId: name, provider: name, contextWindow: 32768, triggerTokens: 2000,
        credential: { leaseId: lease.id, mode: 'scoped', providers: [name] },
        operation: { operationId },
      });
      if (rejectRequest) await assert.rejects(operation, /daemon-test-auth-rejection/);
      else assert.equal((await operation).compacted, true);
      const request = brokerRequests.at(-1);
      assert.equal(request.provider, name);
      assert.equal(request.sessionId, name);
      assert.equal(request.purpose, 'compaction');
      assert.deepEqual(request.target, { kind: 'operation', operation: 'session.compact', operationId });
    }
    assert.equal(brokerRequests.length, 2);
    assert.deepEqual(receivedKeys, ['Bearer daemon-test-scoped-key', 'daemon-test-scoped-key']);
    rejectRequest = false;
    await runtime.sessions.updateSettings('managed-session', { compactionTriggerTokens: 2000 });
    const run = await runtime.runs.start({
      sessionId: 'managed-session', prompt: 'Continue the task.', mode: 'managed_task',
      options: { provider: 'daemon-test-openai', model: 'test-model' },
      credential: { leaseId: lease.id, mode: 'scoped', providers: ['daemon-test-openai'] },
      operation: { operationId: 'managed-run-operation' },
    });
    assert.equal((await run.result).phase, 'completed');
    const managedRequests = brokerRequests.filter((request) => request.sessionId === 'managed-session');
    assert.ok(managedRequests.some((request) => request.purpose === 'compaction'), JSON.stringify(managedRequests));
    assert.ok(managedRequests.some((request) => request.purpose === 'primary'));
    for (const request of managedRequests) assert.deepEqual(request.target, {
      kind: 'run', runId: run.runId, operationId: 'managed-run-operation',
    });
    const events = await runtime.events.replay({ runId: run.runId, type: 'context.compaction.finished' });
    assert.ok(events.some(({ payload }) => payload.committed === true), JSON.stringify(events));
  } finally {
    try {
      const state = await runtime.daemon.inspect();
      owner ??= state.owner;
      await runtime.daemon.stopForInline({
        expectedRuntimeId: state.runtimeId,
        expectedRevision: state.revision,
        expectedOwnerPolicyRevision: state.ownerPolicy.revision,
      });
    } finally {
      // A failed shutdown RPC must not leave the client attached and disable
      // orphan exit. Close before the server/home cleanup registered above.
      await runtime.close();
    }
  }
});
