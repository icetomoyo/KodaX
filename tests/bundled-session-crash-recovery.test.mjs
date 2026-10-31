import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startRuntimeFixtureProcess } from './fixtures/runtime-fixture-process.mjs';
import { createCustomProvider, KodaXBaseProvider, registerModelProvider } from '../dist/sdk-llm.js';
import { runKodaX, awaitLatestCodingMemoryReviewDrain } from '../dist/sdk-coding.js';
import { FileSessionStorage } from '../dist/sdk-repl.js';
import { connectKodaXClient } from '../dist/sdk-client.js';
import { createProviderCredentialAuthorizer, ensureKodaXRuntime, waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';

if (process.argv[2] === '--run-fixture') {
  const folder = process.argv[3], mode = process.argv[4], sessionId = 'cold-crash-session';
  const configHome = path.join(folder, '.kodax');
  process.env.KODAX_HOME = configHome;
  process.env.KODAX_RECOVERY_UNUSED = 'offline-provider-never-sends-http';
  const storage = new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome });
  let calls = 0;
  class RecoveryProvider extends KodaXBaseProvider {
    name = 'offline-crash-recovery';
    supportsThinking = false;
    config = { model: 'fixture', apiKeyEnv: 'KODAX_RECOVERY_UNUSED' };
    async stream(messages, tools) {
      if (tools.some(tool => tool.name === 'commit_episode_learning_review')) {
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'review', name: 'commit_episode_learning_review',
          input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['one_off'] } } }], stopReason: 'tool_use' };
      }
      calls++;
      if (mode === 'crash') throw new Error('offline-provider-crash');
      assert.ok(messages.some(message => message.content === 'Original user intent'));
      const blocks = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
      assert.ok(!blocks.some(block => block.type === 'tool_use' && block.id === 'orphan'));
      return { textBlocks: [{ type: 'text', text: 'History restored without replay.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('offline-crash-recovery', () => new RecoveryProvider());
  const result = await runKodaX({ provider: 'offline-crash-recovery', maxIter: 2, lsp: false,
    context: { executionCwd: folder, gitRoot: folder, configHome, repoIntelligenceMode: 'off' },
    session: { id: sessionId, resume: true, storage },
  }, mode === 'crash' ? 'Continue and preserve prior history.' : 'Resume the saved task.');
  await awaitLatestCodingMemoryReviewDrain(5_000);
  const saved = await storage.load(sessionId);
  process.send({ success: result.success, lastText: result.lastText, calls,
    title: saved.title, errorMetadata: saved.errorMetadata, messages: saved.messages,
    extensionState: saved.extensionState, extensionRecords: saved.extensionRecords });
  process.disconnect();
} else {
  test('published run crash snapshots survive independent process restarts with clean history and increasing error counts', { timeout: 45_000 }, async t => {
    const folder = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-bundle-cold-snapshot-'));
    let child, passed = false;
    t.after(async () => {
      await child?.stop();
      if (passed) {
        assert.equal(path.dirname(folder), await realpath(os.tmpdir()));
        assert.ok(path.basename(folder).startsWith('kodax-bundle-cold-snapshot-'));
        await rm(folder, { recursive: true, force: true });
      } else t.diagnostic(`Retained cold snapshot fixture: ${folder}`);
    });
    const configHome = path.join(folder, '.kodax');
    const storage = new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome });
    await storage.save('cold-crash-session', {
      title: 'Preserved original title', gitRoot: folder,
      messages: [{ role: 'user', content: 'Original user intent' }, { role: 'assistant', content: [
        { type: 'tool_use', id: 'completed-read', name: 'read', input: { path: 'prior.txt' } },
      ] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'completed-read', content: 'Previously completed evidence' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'Interrupted before executing a tool.' },
        { type: 'tool_use', id: 'orphan', name: 'write', input: { path: 'must-not-replay.txt', content: 'unauthorized replay' } },
      ] }],
      errorMetadata: { lastError: 'previous crash', lastErrorTime: 1, consecutiveErrors: 2 },
      extensionState: { fixture: { visits: 7 } },
      extensionRecords: [{ id: 'record-1', extensionId: 'fixture', type: 'retained', ts: 1, data: { value: 42 } }],
    });
    async function execute(mode) {
      child = startRuntimeFixtureProcess(import.meta.url, ['--run-fixture', folder, mode], t.signal);
      const outcome = await child.message();
      const exit = await child.waitForExit();
      assert.equal(exit.code, 0, exit.stderr);
      return outcome;
    }
    // FileSessionStorage heals the legacy orphan and resets the old recovery
    // counter once. Subsequent clean crash snapshots must accumulate normally.
    for (const expected of [1, 2]) {
      const crashed = await execute('crash');
      assert.equal(crashed.success, false);
      assert.equal(crashed.errorMetadata.consecutiveErrors, expected);
      assert.equal(crashed.errorMetadata.lastError, 'Provider request failed. (Error)');
      assert.equal(crashed.title, 'Preserved original title');
      assert.deepEqual(crashed.extensionState, { fixture: { visits: 7 } });
      assert.equal(crashed.extensionRecords[0].id, 'record-1');
      assert.ok(!JSON.stringify(crashed.messages).includes('"id":"orphan"'));
      assert.ok(JSON.stringify(crashed.messages).includes('Previously completed evidence'));
    }
    const resumed = await execute('resume');
    assert.equal(resumed.success, true);
    assert.equal(resumed.lastText, 'History restored without replay.');
    assert.equal(resumed.calls, 1);
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(path.join(folder, 'must-not-replay.txt')), { code: 'ENOENT' });
    passed = true;
  });

  test('Product Client resumes a failed durable session in a cold Host only with fresh authorization', { timeout: 60_000 }, async t => {
    const folder = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-bundle-crash-host-'));
    const configHome = path.join(folder, '.kodax'), sessionsDir = path.join(configHome, 'sessions');
    const sessionId = 'host-crash-recovery', provider = 'cold-host-fixture';
    const storage = new FileSessionStorage({ sessionsDir, configHome });
    const errors = [], authorizations = [], wireInputs = [];
    let runtime, client, owner, authorizer, lastAuthorization, rejectPrimary = true, passed = false;
    const server = createServer((request, response) => {
      void (async () => {
        let body = ''; for await (const chunk of request) body += chunk;
        const input = JSON.parse(body);
        assert.equal(request.headers.authorization, 'Bearer explicit-fixture-credential');
        const review = input.tools?.some(tool => tool.function?.name === 'commit_episode_learning_review');
        if (!review) {
          wireInputs.push(input);
          assert.ok(body.includes('Previously completed evidence'));
          assert.ok(!body.includes('must-not-replay.txt'));
          if (rejectPrimary) {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'offline-cold-host-failure' } }));
            return;
          }
        }
        const delta = review ? { tool_calls: [{ index: 0, id: 'review', type: 'function', function: {
          name: 'commit_episode_learning_review', arguments: JSON.stringify({ memoryPlan: { actions: [], warnings: [] },
            capabilityDecision: { disposition: 'discard', reasonCodes: ['one_off'] } }),
        } }] } : { content: 'Completed after cold Host recovery.' };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: review ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })}\n\ndata: [DONE]\n\n`);
      })().catch(error => { errors.push(error); response.destroy(error); });
    });
    async function stopHost() {
      const failures = [];
      try { await authorizer?.close(); } catch (error) { failures.push(error); }
      try { await client?.disconnect(); } catch (error) { failures.push(error); }
      client = undefined;
      if (runtime) {
        try { await runtime.daemon.shutdown(); } catch (error) { failures.push(error); }
        try { await runtime.close(); } catch (error) { failures.push(error); }
        try {
          assert.equal((await waitForRuntimeDaemonShutdown({ configHome, owner })).status, 'succeeded');
          runtime = undefined;
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Cold Host cleanup failed');
    }
    t.after(async () => {
      try { await stopHost(); } catch (error) { errors.push(error); }
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (passed && !errors.length) {
        assert.equal(path.dirname(folder), await realpath(os.tmpdir()));
        assert.ok(path.basename(folder).startsWith('kodax-bundle-crash-host-'));
        await rm(folder, { recursive: true, force: true });
      } else t.diagnostic(`Retained cold Host fixture: ${folder}`);
      if (errors.length) throw new AggregateError(errors, 'Cold Host fixture errors');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const connection = { name: provider, protocol: 'openai', model: 'fixture', contextWindow: 32768, maxOutputTokens: 1024,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'KODAX_COLD_HOST_UNSET' };
    await mkdir(configHome, { recursive: true });
    await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ customProviders: [connection] }));
    await storage.save(sessionId, { title: 'Original durable title', gitRoot: folder, messages: [
      { role: 'user', content: 'Original user intent' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'completed', name: 'read', input: { path: 'prior.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'completed', content: 'Previously completed evidence' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'write', input: { path: 'must-not-replay.txt', content: 'Do not execute' } }] },
    ], errorMetadata: { lastError: 'legacy interruption', lastErrorTime: 1, consecutiveErrors: 1 },
    extensionState: { fixture: { retained: true } },
    extensionRecords: [{ id: 'retained', extensionId: 'fixture', type: 'saved', ts: 1, data: 42 }] });
    async function startHost() {
      runtime = await ensureKodaXRuntime({ homeDir: folder, sessionsDir, defaultProvider: provider, daemonOrphanExitMs: 1000,
        clientInfo: { name: 'cold-host-owner', clientType: 'cli' }, requirements: { daemonManagement: 1, providerCredentialBroker: 2 } });
      owner = (await runtime.daemon.inspect()).owner;
      assert.notEqual(owner.pid, process.pid);
      authorizer = createProviderCredentialAuthorizer({ sources: [{ kind: 'environment', provider,
        connectionFingerprint: createCustomProvider(connection).getCredentialConnectionFingerprint(), apiKeyEnv: 'KODAX_COLD_HOST_UNSET' }],
      environment: () => ({ KODAX_COLD_HOST_UNSET: 'explicit-fixture-credential' }) });
      client = await connectKodaXClient({ homeDir: folder, clientInfo: { name: 'cold-host-product', clientType: 'cli' },
        authorizeExecution: async (request, services) => {
          authorizations.push({ kind: request.kind, runtimeId: services.identity.runtimeId });
          lastAuthorization = await authorizer.authorizeExecution(request, services);
          return lastAuthorization;
        } });
      await runtime.sessions.updateSettings(sessionId, { provider, model: 'fixture', reasoningMode: 'off' });
    }
    await startHost();
    const originalRuntimeId = runtime.identity.runtimeId;
    const first = await client.inputs.submit({ sessionId, inputId: randomUUID(), text: 'Continue the saved task.' });
    assert.ok(first.runId);
    assert.equal((await client.runs.await(first.runId)).phase, 'failed');
    const oldCredential = lastAuthorization.credential;
    await stopHost();
    const failed = await storage.load(sessionId);
    assert.ok(failed.errorMetadata.consecutiveErrors > 0);
    assert.ok(!JSON.stringify(failed.messages).includes('must-not-replay.txt'));
    assert.equal(failed.title, 'Original durable title');
    await startHost();
    assert.notEqual(runtime.identity.runtimeId, originalRuntimeId);
    const beforeRead = authorizations.length, beforeWire = wireInputs.length;
    await client.sessions.readHistory(sessionId, { limit: 100 });
    assert.equal(authorizations.length, beforeRead);
    assert.equal(wireInputs.length, beforeWire, 'Cold loading history must not replay work');
    await assert.rejects(runtime.credentials.resumeScoped(oldCredential.leaseId, async () => 'forbidden'));
    const secondFailure = await client.inputs.submit({ sessionId, inputId: randomUUID(), text: 'Retry the saved task.' });
    assert.equal((await client.runs.await(secondFailure.runId)).phase, 'failed');
    await stopHost();
    const failedAgain = await storage.load(sessionId);
    assert.equal(failedAgain.errorMetadata.consecutiveErrors, failed.errorMetadata.consecutiveErrors + 1);
    assert.equal(failedAgain.title, 'Original durable title');
    await startHost();
    rejectPrimary = false;
    const beforeResume = authorizations.length;
    const resumed = await client.inputs.submit({ sessionId, inputId: randomUUID(), text: 'Resume with fresh authorization.' });
    assert.equal((await client.runs.await(resumed.runId)).phase, 'completed');
    assert.equal(authorizations.length, beforeResume + 1);
    assert.equal(authorizations.at(-1).runtimeId, runtime.identity.runtimeId);
    await stopHost();
    const saved = await storage.load(sessionId);
    assert.ok(JSON.stringify(saved.messages).includes('Previously completed evidence'));
    assert.deepEqual(saved.extensionState, { fixture: { retained: true } });
    assert.equal(saved.extensionRecords[0].id, 'retained');
    await assert.rejects(access(path.join(folder, 'must-not-replay.txt')), { code: 'ENOENT' });
    passed = true;
  });
}
