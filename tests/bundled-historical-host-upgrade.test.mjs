import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Provision this exact public npm artifact outside the test. CI never downloads implicitly:
// npm pack @kodax-ai/kodax@0.7.97-alpha.11 --ignore-scripts --pack-destination <temp>
// KODAX_ALPHA11_TARBALL=<temp>/kodax-ai-kodax-0.7.97-alpha.11.tgz node --test <this file>
const archive = process.env.KODAX_ALPHA11_TARBALL;
const integrity = 'Fo4qL6qvA/1ViL8sElvXB+X0+xP6c23GGJ5iJY10wDUDLXokIiVXY8+4bXx3r8OYFyiqUyBJ7+9v2UnCc5cNHg==';
const repository = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);

test('real alpha.11 Host keeps busy work and upgrades in place without losing its Session', {
  timeout: 180_000,
}, async t => {
  assert.ok(archive, 'Provide the integrity-pinned alpha.11 npm tarball through KODAX_ALPHA11_TARBALL.');
  const bytes = await readFile(archive);
  assert.equal(createHash('sha512').update(bytes).digest('base64'), integrity);
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-historical-host-upgrade-'));
  const installation = path.join(root, 'package');
  const homeDir = path.join(root, 'home');
  const configHome = path.join(homeDir, '.kodax');
  const profile = 'historical-upgrade';
  const evidence = { historicalVersion: '0.7.97-alpha.11', integrity: `sha512-${integrity}`, stages: [], requests: [] };
  const env = { ...process.env, KODAX_HOME: configHome, KODAX_TRACING: '0', KODAX_H05_TEST_KEY: 'local-fixture-only' };
  delete env.KODAX_VERSION;
  delete env.KODAX_BUNDLED;
  delete env.NODE_OPTIONS;
  let heldResponse;
  let requestCount = 0;
  let resolveRequest;
  const requestReceived = new Promise(resolve => { resolveRequest = resolve; });
  const finish = () => {
    if (!heldResponse) return;
    heldResponse.writeHead(200, { 'content-type': 'text/event-stream' });
    heldResponse.end(`data: ${JSON.stringify({ id: 'historical-answer', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'H05_RETAINED_ANSWER' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`);
    heldResponse = undefined;
  };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    evidence.requests.push(input);
    if (input.tools?.some(tool => tool.function?.name === 'commit_episode_learning_review')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: 'historical-review', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'h05-review', type: 'function',
          function: { name: 'commit_episode_learning_review', arguments: JSON.stringify({
            memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['one_off'] },
          }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: 'historical-tool', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'h05-write-once', type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'echo H05_TOOL_RECEIPT >> h05-tool-marker.txt' }) } }] },
          finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    heldResponse = response;
    resolveRequest();
  });
  let runtime;
  let historical;
  let oldOwner;
  let failure;
  let currentFilesInstalled = false;
  let passed = false;
  const driver = path.join(root, 'driver.mjs');
  const runDriver = async action => {
    const result = await execute(process.execPath, [driver, action, installation, homeDir, profile], {
      env, windowsHide: true, timeout: 80_000, maxBuffer: 1024 * 1024,
      signal: action === 'cleanup' ? undefined : t.signal,
    });
    await writeFile(path.join(root, `${action}.log`), `${result.stdout}\n${result.stderr}`);
    const record = result.stdout.split('\n').find(line => line.startsWith('H05_RESULT '));
    assert.ok(record, result.stdout + result.stderr);
    return JSON.parse(record.slice('H05_RESULT '.length));
  };
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    finish();
    try {
      await runtime?.close(); runtime = undefined;
      if (currentFilesInstalled) evidence.cleanup = await runDriver('cleanup');
      else if (historical && oldOwner) {
        runtime = await historical.connectKodaXRuntime({ homeDir, profile });
        for (const run of await runtime.runs.list({})) {
          if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.phase)) {
            await runtime.runs.abort(run.runId);
            await runtime.runs.await(run.runId);
          }
        }
        await runtime.daemon.shutdown(); await runtime.close(); runtime = undefined;
        evidence.cleanup = await historical.waitForRuntimeDaemonShutdown({ configHome, profile, owner: oldOwner });
        assert.equal(evidence.cleanup.status, 'succeeded');
      }
    } catch (error) {
      evidence.cleanupError = String(error); passed = false;
      failure = failure ? new AggregateError([failure, error], 'Historical upgrade and cleanup failed.') : error;
    } finally {
      await runtime?.close();
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
    t.diagnostic(`Historical upgrade evidence: ${root}; passed=${passed}`);
    // Keep evidence and the exact installed artifacts in OS temporary storage.
  })();
  t.after(async () => {
    await cleanup();
    if (failure) throw failure;
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening', { signal: t.signal });
    await execute('tar', ['-xf', path.resolve(archive), '-C', root], { windowsHide: true, signal: t.signal });
    // The package's bundled dependencies remain intact; other dependencies use the
    // already-installed release-test environment, without changing that installation.
    await symlink(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(JSON.parse(await readFile(path.join(installation, 'package.json'), 'utf8')).version, evidence.historicalVersion);
    await mkdir(configHome, { recursive: true });
    await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ provider: 'historical-local', model: 'fixture',
      permissionMode: 'full-access', customProviders: [{ name: 'historical-local', protocol: 'openai',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'KODAX_H05_TEST_KEY', model: 'fixture',
        contextWindow: 32768, maxOutputTokens: 1024 }] }));
    // Import and launch genuine, unmodified historical JavaScript before replacing files.
    const originalHome = process.env.KODAX_HOME;
    const originalKey = process.env.KODAX_H05_TEST_KEY;
    process.env.KODAX_HOME = configHome;
    process.env.KODAX_H05_TEST_KEY = env.KODAX_H05_TEST_KEY;
    try {
      historical = await import(pathToFileURL(path.join(installation, 'dist/sdk-runtime.js')).href);
      runtime = await historical.ensureKodaXRuntime({ homeDir, profile, daemonLifecycle: 'persistent' });
    } finally {
      if (originalHome === undefined) delete process.env.KODAX_HOME; else process.env.KODAX_HOME = originalHome;
      if (originalKey === undefined) delete process.env.KODAX_H05_TEST_KEY; else process.env.KODAX_H05_TEST_KEY = originalKey;
    }
    const oldIdentity = runtime.identity;
    assert.equal(oldIdentity.version, evidence.historicalVersion);
    oldOwner = (await runtime.daemon.inspect()).owner;
    evidence.oldIdentity = oldIdentity;
    evidence.oldOwnerPid = oldOwner.pid;
    const session = await runtime.sessions.create({ title: 'H05 retained Session', projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { workMode: 'agent', provider: 'historical-local', model: 'fixture' });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'H05_RETAINED_INPUT',
      mode: 'managed_task', options: { provider: 'historical-local', model: 'fixture', workMode: 'agent', reasoningMode: 'off' } });
    void run.result.catch(() => {}); // Detaching is expected while the genuine old Host keeps working.
    await waitForFixtureRequest(requestReceived, run.result, t.signal);
    assert.equal((await readFile(path.join(homeDir, 'h05-tool-marker.txt'), 'utf8')).trim(), 'H05_TOOL_RECEIPT');
    await runtime.close(); runtime = undefined;
    evidence.sessionId = session.id;
    evidence.runId = run.runId;
    await writeFile(path.join(root, 'ids.json'), JSON.stringify({ sessionId: session.id, runId: run.runId, oldIdentity }));
    await writeFile(driver, DRIVER);
    // Model a real installation update. Keep the path and version honest; only the
    // newly built code bytes replace the old package while its already-loaded Host lives.
    await rm(path.join(installation, 'dist'), { recursive: true, force: true });
    await cp(path.join(repository, 'dist'), path.join(installation, 'dist'), { recursive: true });
    await cp(path.join(repository, 'package.json'), path.join(installation, 'package.json'));
    currentFilesInstalled = true;
    const busy = await runDriver('busy');
    assert.equal(busy.accepted, false);
    assert.ok(busy.blockers.includes('active_runs') || busy.blockers.includes('active_agent_turns'), JSON.stringify(busy));
    const descriptorPath = path.join(configHome, 'runtime/daemon', profile, 'daemon.json');
    assert.equal(JSON.parse(await readFile(descriptorPath, 'utf8')).runtimeId, oldIdentity.runtimeId);
    assert.doesNotThrow(() => process.kill(oldOwner.pid, 0));
    evidence.stages.push({ busy });
    finish();
    runtime = await historical.connectKodaXRuntime({ homeDir, profile });
    assert.equal((await runtime.runs.await(run.runId)).phase, 'completed');
    const before = await runtime.sessions.transcript(session.id);
    const sessionBefore = await runtime.sessions.load(session.id);
    assert.match(JSON.stringify(before), /H05_RETAINED_ANSWER/);
    assert.match(JSON.stringify(before), /h05-write-once/);
    await runtime.close(); runtime = undefined;
    const requestsBeforeUpgrade = requestCount;
    assert.equal(requestsBeforeUpgrade, 2, 'The historical Run makes one tool request and one answer request.');
    const upgraded = await runDriver('upgrade');
    assert.notEqual(upgraded.identity.runtimeId, oldIdentity.runtimeId);
    assert.equal(upgraded.identity.build.origin, oldIdentity.build.origin);
    assert.notEqual(upgraded.identity.build.fingerprint, oldIdentity.build.fingerprint);
    assert.equal(upgraded.session.title, sessionBefore.title);
    assert.equal(upgraded.settings.workMode, 'agent');
    assert.deepEqual(upgraded.transcript.activeMessages, before.activeMessages);
    assert.equal(upgraded.run.phase, 'completed');
    assert.equal(upgraded.peerRuntimeId, upgraded.identity.runtimeId);
    assert.ok(upgraded.progress.includes('upgrading'));
    assert.throws(() => process.kill(oldOwner.pid, 0), { code: 'ESRCH' });
    assert.equal(requestCount, requestsBeforeUpgrade, 'Upgrade must not resubmit the completed historical Run.');
    assert.equal((await readFile(path.join(homeDir, 'h05-tool-marker.txt'), 'utf8')).trim(), 'H05_TOOL_RECEIPT');
    evidence.stages.push({ upgraded, requestsBeforeUpgrade, requestCount });
    passed = true;
  } catch (error) {
    failure = error;
    evidence.failure = String(error);
  } finally {
    await cleanup();
  }
  if (failure) throw failure;
});


async function waitForFixtureRequest(requestReceived, runResult, signal) {
  signal.throwIfAborted();
  let timer;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(new Error('Historical Host did not reach the fixture response within 30 seconds.')), 30_000);
  });
  try {
    await Promise.race([requestReceived, deadline, runResult.then(result => {
      throw new Error(`Run ended before fixture request: ${JSON.stringify(result)}`);
    })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

const DRIVER = `import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const [action, installation, homeDir, profile] = process.argv.slice(2);
const sdk = await import(pathToFileURL(path.join(installation, 'dist/sdk-runtime.js')).href);
const ids = JSON.parse(await readFile(path.join(path.dirname(installation), 'ids.json'), 'utf8'));
let runtime;
const progress = [];
let result;
try {
  if (action === 'busy') {
    try { runtime = await sdk.ensureKodaXRuntime({ homeDir, profile, daemonStartupTimeoutMs: 10000 }); result = { accepted: true }; }
    catch (error) { result = { accepted: false, code: error.code, blockers: error.preflight?.blockers ?? [], message: error.message }; }
  } else if (action === 'cleanup') {
    runtime = await sdk.connectKodaXRuntime({ homeDir, profile });
    const owner = (await runtime.daemon.inspect()).owner;
    for (const run of await runtime.runs.list({})) if (!['completed','failed','cancelled','interrupted'].includes(run.phase)) {
      await runtime.runs.abort(run.runId); await runtime.runs.await(run.runId);
    }
    await runtime.daemon.shutdown(); await runtime.close(); runtime = undefined;
    result = await sdk.waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'), profile, owner });
    if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
  } else {
    runtime = await sdk.ensureKodaXRuntime({ homeDir, profile, daemonStartupTimeoutMs: 60000, onStartupProgress: event => progress.push(event.stage) });
    const peer = await sdk.connectKodaXRuntime({ homeDir, profile });
    try { result = { identity: runtime.identity, session: await runtime.sessions.load(ids.sessionId),
      settings: await runtime.sessions.getSettings(ids.sessionId), transcript: await runtime.sessions.transcript(ids.sessionId),
      run: await runtime.runs.get(ids.runId), peerRuntimeId: peer.identity.runtimeId, progress }; }
    finally { await peer.close(); }
  }
} finally { await runtime?.close(); }
process.stdout.write('H05_RESULT ' + JSON.stringify(result) + '\\n');
`;
