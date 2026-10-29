import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { connectKodaXRuntime } from '../dist/sdk-runtime.js';
import { FileSessionStorage } from '../dist/sdk-repl.js';

const exec = promisify(execFile);
function finish(response, delta, reason = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'offline-release', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
}
async function until(read) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await read()) return; await delay(50); }
  throw new Error('Timed out waiting for a durable Script read receipt');
}

// Invoked on the matching native CI runner after creating the exact release archive.
// Every provider request terminates at this loopback fixture; no external model is used.
test('release archive preserves work modes, partial effects, cancellation and restart on its shipped runtime', { timeout: 180_000 }, async t => {
  const archive = process.env.KODAX_MODE_RELEASE_ARCHIVE;
  assert.ok(archive, 'Set KODAX_MODE_RELEASE_ARCHIVE to the archive for this host platform');
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, 'kodax-release-modes-'));
  const evidence = process.env.KODAX_MODE_RELEASE_EVIDENCE
    ? path.resolve(process.env.KODAX_MODE_RELEASE_EVIDENCE)
    : await mkdtemp(path.join(temporary, 'kodax-release-evidence-'));
  await mkdir(evidence, { recursive: true });
  const packageDir = path.join(root, 'package');
  const homeDir = path.join(root, 'home');
  const configHome = path.join(homeDir, '.kodax');
  const workspace = path.join(root, 'workspace');
  const binary = path.join(packageDir, process.platform === 'win32' ? 'kodax.exe' : 'kodax');
  const requests = [];
  const failures = [];
  const cases = [];
  let nativeShellContract;
  let active;
  let client;
  let sessionId;
  let release = () => {};
  let hostStarted = false;
  let completedAssertions = false;
  const phase = name => process.stderr.write(`[release-mode] ${name}\n`);
  const wait = async (promise, signal = t.signal) => {
    signal.throwIfAborted();
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([promise, aborted]); }
    finally { signal.removeEventListener('abort', abort); }
  };
  // Do not forward provider credentials, proxy configuration or ambient KodaX overrides.
  const systemEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROCESSOR_ARCHITECTURE|LANG|LC_ALL)$/i.test(key)));
  const environment = { ...systemEnvironment, KODAX_HOME: configHome, KODAX_TRACING: '0',
    KODAX_RELEASE_MODE_KEY: 'offline-only', NODE_PATH: '', NODE_OPTIONS: '',
    // Windows keeps OS utilities but removes Node/Bun/Git installations from child PATH.
    ...(process.platform === 'win32' ? { PATH: [process.env.SystemRoot, path.join(process.env.SystemRoot, 'System32'),
      path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(';') } : {}) };
  const cli = (args, signal = t.signal) => exec(binary, args, { cwd: workspace, env: environment, windowsHide: true,
    signal, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      requests.push(parsed);
      assert.ok(requests.length <= 32, 'Offline request guard exceeded');
      const names = (parsed.tools ?? []).map(tool => tool.function?.name ?? tool.name);
      if (!names.includes('todo_update')) {
        // Record auxiliary requests separately. This fixture does not evaluate memory generation.
        finish(response, { content: '{}' }); return;
      }
      assert.ok(active, 'Unexpected root generation');
      const step = active.requests.length;
      active.requests.push(parsed);
      assert.ok(names.includes('undo') && names.includes('bash') && names.includes('spawn_agent'));
      assert.equal(names.includes('script_exec'), active.mode === 'script');
      assert.equal(names.includes('read'), active.mode !== 'script');
      assert.equal(names.includes('relationship_scan'), active.mode === 'coding');
      const definitions = (parsed.tools ?? []).map(tool => tool.function ?? tool);
      const shell = definitions.find(tool => tool.name === 'bash');
      assert.ok(shell?.description);
      assert.equal(shell.parameters?.properties?.run_in_background?.type, 'boolean');
      if (nativeShellContract) assert.deepEqual(shell, nativeShellContract,
        'All work modes retain the same native shell contract');
      else nativeShellContract = shell;
      if (active.mode === 'script') {
        assert.ok(definitions.find(tool => tool.name === 'script_exec').description.includes('Callable contracts (JSON Schema)'));
      } else {
        assert.equal(definitions.find(tool => tool.name === 'glob').description, 'Find file paths by glob.');
      }
      assert.ok(step < (active.code ? 2 : 1), 'Unexpected extra root generation');
      if (active.gate && step === 0) { active.enter(); await active.gate; }
      if (active.code && step === 0) {
        finish(response, { tool_calls: [{ index: 0, id: `cell-${active.name}`, type: 'function',
          function: { name: 'script_exec', arguments: JSON.stringify({ code: active.code }) } }] }, 'tool_calls');
      } else {
        if (active.code) {
          const result = parsed.messages.find(message => message.role === 'tool' && message.tool_call_id === `cell-${active.name}`);
          assert.ok(result, 'Missing original Script result');
          assert.match(result.content, /RELEASE_VALUE/);
          if (active.name === 'partial') assert.match(result.content, /intentional partial stop/);
        }
        finish(response, { content: active.name === 'partial' ? 'The edit completed; the cell then failed intentionally.' : 'Offline evidence verified.' });
      }
    } catch (error) {
      failures.push(String(error));
      process.stderr.write(`Offline release fixture failed: ${String(error)}\n`);
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  const connect = async () => {
    phase('starting packaged daemon');
    // The packaged daemon's cold start on a runner can exceed the CLI's 5s
    // default readiness budget; ask for the same 60s ceiling used elsewhere.
    await cli(['daemon', 'start', '--home', homeDir, '--timeout-ms', '60000', '--json']); hostStarted = true;
    const descriptor = JSON.parse(await readFile(path.join(configHome, 'runtime/daemon/default/daemon.json'), 'utf8'));
    client = await connectKodaXRuntime({ homeDir, endpoint: descriptor.endpoint, daemonStartupSignal: t.signal });
    assert.ok(client.capabilities.sharedSessionSettings.keys.includes('workMode'));
    return descriptor.runtimeId;
  };
  const stop = async () => {
    phase('stopping packaged daemon');
    try {
      await wait(client?.close(), AbortSignal.timeout(10_000));
    } finally {
      client = undefined;
      if (hostStarted) {
        const result = JSON.parse((await cli(['daemon', 'stop', '--home', homeDir, '--json'], AbortSignal.timeout(20_000))).stdout);
        assert.ok(result.stopped || result.reason === 'missing', JSON.stringify(result));
        hostStarted = false;
      }
    }
  };
  const run = async (name, mode, code, gated = false) => {
    phase(`running ${name} (${mode})`);
    let enter = () => {};
    const entered = new Promise(resolve => { enter = resolve; });
    active = { name, mode, code, requests: [], enter,
      ...(gated ? { gate: new Promise(resolve => { release = resolve; }) } : {}) };
    const handle = await client.runs.start({ sessionId, mode: 'managed_task', prompt: `Release check: ${name}.`,
      options: { lsp: false, reasoningMode: 'off', context: { repoIntelligenceMode: 'off' } } });
    if (gated) {
      await wait(Promise.race([entered, handle.result.then(result => { throw new Error(`Run ended before gate: ${JSON.stringify(result)}`); })]));
      const snapshot = await client.sessions.getSettingsVersioned(sessionId);
      await assert.rejects(client.sessions.updateSettings(sessionId, { workMode: 'coding' }), { code: 'conflict' });
      await assert.rejects(client.sessions.updateSettingsVersioned(sessionId, { workMode: 'coding' }, { expectedRevision: snapshot.revision }), { code: 'conflict' });
      release();
    }
    return handle;
  };
  const complete = async handle => {
    const result = await wait(handle.result);
    assert.equal(result.phase, 'completed', JSON.stringify(result));
    assert.equal(active.requests.length, active.code ? 2 : 1);
    cases.push({ name: active.name, mode: active.mode, primaryRequests: active.requests.length, phase: result.phase });
    phase(`completed ${active.name}`);
  };
  try {
    await wait((async () => {
      phase('extracting archive');
      await Promise.all([mkdir(packageDir), mkdir(workspace), mkdir(configHome, { recursive: true })]);
      // MSYS GNU tar treats drive-letter arguments (C:/...) as remote tape
      // specs; keep both tar paths relative to the extraction directory.
      await exec('tar', ['-xf', path.relative(packageDir, path.resolve(archive)), '-C', '.'], { cwd: packageDir, signal: t.signal, windowsHide: true, timeout: 60_000 });
      if (process.platform === 'win32') for (const runtime of ['node', 'bun']) {
        await assert.rejects(exec(path.join(process.env.SystemRoot, 'System32/where.exe'), [runtime], { env: environment, windowsHide: true }), { code: 1 });
      }
      await writeFile(path.join(workspace, 'fixture.txt'), 'RELEASE_VALUE=1\n');
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ provider: 'release-local', model: 'fixture',
        permissionMode: 'full-access', lsp: false, repoIntelligenceMode: 'off', customProviders: [{
          name: 'release-local', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKeyEnv: 'KODAX_RELEASE_MODE_KEY', model: 'fixture', contextWindow: 128000, reasoning: 'none' }] }));
      assert.match((await cli(['--help'])).stdout, /--work-mode/);
      const firstHost = await connect();
      const session = await client.sessions.create({ projectPath: workspace, title: 'Release modes' }); sessionId = session.id;
      await client.sessions.updateSettings(sessionId, { permissionMode: 'full-access', agentMode: 'ama' });
      assert.equal((await client.sessions.getSettings(sessionId)).workMode ?? 'coding', 'coding');
      await complete(await run('default', 'coding'));
      await client.sessions.updateSettings(sessionId, { workMode: 'agent' });
      await complete(await run('agent', 'agent', undefined, true));
      await client.sessions.updateSettings(sessionId, { workMode: 'script' });
      await complete(await run('partial', 'script', "await tools.read({path:'fixture.txt'}); await tools.edit({path:'fixture.txt',edits:[{old_string:'RELEASE_VALUE=1',new_string:'RELEASE_VALUE=2'}]}); throw Error('intentional partial stop');"));
      assert.equal(await readFile(path.join(workspace, 'fixture.txt'), 'utf8'), 'RELEASE_VALUE=2\n');
      const storage = new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome });
      const before = (await storage.load(sessionId)).extensionRecords.filter(record => record.extensionId === 'kodax.script');
      assert.ok(before.some(record => record.type === 'call.settled'));
      await client.sessions.updateSettings(sessionId, { model: 'fixture-next' });
      assert.equal((await client.sessions.getSettings(sessionId)).workMode, 'script');
      await stop();
      assert.notEqual(await connect(), firstHost);
      assert.equal((await client.sessions.getSettings(sessionId)).workMode, 'script');
      const after = (await storage.load(sessionId)).extensionRecords;
      for (const record of before) assert.ok(after.some(saved => JSON.stringify(saved) === JSON.stringify(record)));
      await complete(await run('restored', 'script', "await tools.read({path:'fixture.txt'});"));
      assert.equal(active.requests[0].model, 'fixture-next');
      assert.equal(await readFile(path.join(workspace, 'fixture.txt'), 'utf8'), 'RELEASE_VALUE=2\n');

      const cancellationCode = "await tools.read({path:'fixture.txt'}); const end=Date.now()+5000; while(Date.now()<end) {} await tools.write({path:'cancel-probe.txt',content:'reachable'});";
      const cancelled = await run('cancelled', 'script', cancellationCode);
      await until(async () => (await storage.load(sessionId)).extensionRecords.some(record => record.type === 'call.settled' && record.data?.runId === cancelled.runId));
      assert.equal((await client.runs.abort(cancelled.runId)).accepted, true);
      assert.equal((await wait(cancelled.result)).phase, 'interrupted');
      assert.equal(active.requests.length, 1);
      await assert.rejects(readFile(path.join(workspace, 'cancel-probe.txt')), { code: 'ENOENT' });
      cases.push({ name: 'cancelled', mode: 'script', primaryRequests: 1, phase: 'interrupted' });
      // Identical code without cancellation reaches the write; absence above is not an unreachable-code tautology.
      await complete(await run('cancel-control', 'script', cancellationCode));
      assert.equal(await readFile(path.join(workspace, 'cancel-probe.txt'), 'utf8'), 'reachable');

      active = { name: 'cli-override', mode: 'agent', requests: [] };
      await cli(['-p', 'Check temporary Agent mode.', '--session', sessionId, '--work-mode', 'agent', '--effort', 'off']);
      assert.equal(active.requests.length, 1);
      assert.equal((await client.sessions.getSettings(sessionId)).workMode, 'script');
      cases.push({ name: active.name, mode: active.mode, primaryRequests: 1 });
      await client.sessions.updateSettings(sessionId, { workMode: null });
      await complete(await run('cleared-default', 'coding'));
      const worker = path.join(packageDir, 'script-worker.cjs');
      await rename(worker, `${worker}.missing`);
      try {
        const requestCount = requests.length;
        await assert.rejects(client.sessions.updateSettings(sessionId, { workMode: 'script' }), /Script executor unavailable/);
        assert.equal((await client.sessions.getSettings(sessionId)).workMode ?? 'coding', 'coding');
        assert.equal(requests.length, requestCount);
      } finally { await rename(`${worker}.missing`, worker); }
      assert.deepEqual(failures, []);
      completedAssertions = true;
    })());
  } catch (error) {
    failures.push(`Harness: ${String(error)}`);
    throw error;
  } finally {
    phase('cleaning up fixture');
    release();
    try {
      const cleanupSignal = AbortSignal.timeout(20_000);
      try {
        if (client) for (const item of await wait(client.runs.list({}), cleanupSignal)) {
          if (!['completed', 'failed', 'interrupted'].includes(item.phase)) {
            await wait(client.runs.abort(item.runId), cleanupSignal);
          }
        }
      } finally {
        await stop();
      }
    } catch (error) {
      failures.push(`Cleanup: ${String(error)}`);
      throw error;
    } finally {
      server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
      await writeFile(path.join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
      await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ platform: process.platform, arch: process.arch,
        archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), cases, failures,
        primaryRequests: cases.reduce((sum, item) => sum + item.primaryRequests, 0), capturedRequests: requests.length,
        externalModelCalls: 0, completedAssertions }, null, 2));
      process.stderr.write(`Offline release evidence: ${evidence}\n`);
      if ((!completedAssertions || failures.length > 0) && existsSync(path.join(configHome, 'runtime'))) {
        await cp(path.join(configHome, 'runtime'), path.join(evidence, 'runtime'), { recursive: true });
      }
      if (path.dirname(root) !== temporary || !path.basename(root).startsWith('kodax-release-modes-')) throw new Error('Unsafe cleanup');
      if (completedAssertions && failures.length === 0) {
        await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      } else {
        process.stderr.write(`Retained failed release fixture: ${root}\n`);
      }
    }
  }
});
