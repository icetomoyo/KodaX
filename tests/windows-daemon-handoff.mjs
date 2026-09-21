// Windows lifecycle acceptance against the selected installation's built CLI/SDK.
// Usage: node tests/windows-daemon-handoff.mjs [--repo <installation>]
// The held-launcher seam imports target source through tsx; all serving/client work uses dist.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const stopScript = `
  const { connectKodaXRuntime, waitForRuntimeDaemonShutdown } = await import(process.argv[1]);
  const homeDir = process.argv[2];
  const owner = JSON.parse(process.argv[3]);
  if (process.argv[4] === 'running') {
    const runtime = await connectKodaXRuntime({ homeDir, autoStart: false });
    try {
      const actual = (await runtime.daemon.inspect()).owner;
      if (actual.runtimeId !== owner.runtimeId || actual.pid !== owner.pid) {
        throw new Error('Fixture daemon owner changed; refusing to stop a replacement');
      }
      const before = await runtime.status.preflight();
      for (const run of [...before.queuedRuns, ...before.activeRuns]) await runtime.runs.abort(run.runId);
      const deadline = Date.now() + 10000;
      while (true) {
        const current = await runtime.status.preflight();
        if (current.canStop) break;
        if (Date.now() >= deadline) throw new Error('Fixture daemon is still busy: ' + current.blockers.join(', '));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const state = await runtime.daemon.inspect();
      await runtime.daemon.stopForInline({
        expectedRuntimeId: state.runtimeId,
        expectedRevision: state.revision,
        expectedOwnerPolicyRevision: state.ownerPolicy.revision,
      });
    } finally {
      await runtime.close();
    }
  }
  const result = await waitForRuntimeDaemonShutdown({
    configHome: process.env.KODAX_HOME, owner, timeoutMs: 15000,
  });
  if (result.status !== 'succeeded') throw new Error('Fixture daemon cleanup failed: ' + JSON.stringify(result));
`;

function acceptanceEnvironment(homeDir) {
  return { ...process.env, HOME: homeDir, USERPROFILE: homeDir, KODAX_HOME: path.join(homeDir, '.kodax'),
    KODAX_INTERNAL_DAEMON_TEST_PARENT_PID: String(process.pid) };
}

async function readAcceptanceDaemonOwner(homeDir) {
  try {
    return JSON.parse(await readFile(path.join(homeDir, '.kodax/runtime/daemon/default/daemon.lock'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// A probe's freshly created Home is exclusively owned by that probe. Never auto-start during cleanup.
async function stopAcceptanceDaemon({ repo, homeDir, owner }) {
  const configHome = path.join(homeDir, '.kodax');
  let state;
  try {
    state = JSON.parse(await readFile(path.join(configHome, 'runtime/daemon/default/daemon.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  owner ??= await readAcceptanceDaemonOwner(homeDir);
  if (!state && !owner) return;
  assert.ok(owner, 'Fixture daemon must have a verifiable owner');
  if (state) {
    assert.equal(path.resolve(state.configHome), path.resolve(configHome), 'Fixture daemon must own the temporary Home');
    assert.equal(state.runtimeId, owner.runtimeId, 'Fixture daemon must retain its captured owner');
    assert.equal(state.pid, owner.pid, 'Fixture daemon must retain its captured PID');
  }
  const sdk = pathToFileURL(path.join(repo, 'dist/sdk-runtime.js')).href;
  await execute(process.execPath, ['--input-type=module', '-e', stopScript, sdk, homeDir,
    JSON.stringify(owner), state ? 'running' : 'stopping'], {
    cwd: repo, env: acceptanceEnvironment(homeDir), windowsHide: true, timeout: 45_000,
  });
}

const self = fileURLToPath(import.meta.url);
const argument = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const repo = path.resolve(argument('--repo') ?? path.join(path.dirname(self), '..'));
const sdkUrl = pathToFileURL(path.join(repo, 'dist/sdk-runtime.js')).href;
const cli = path.join(repo, 'dist/kodax_cli.js');
const home = argument('--home');
const role = argument('--role');
const output = 'HANDOFF_PEER_COMPLETED';

function isolatedEnvironment(homeDir) {
  const inherited = acceptanceEnvironment(homeDir);
  const allowed = /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|commonprogramfiles|processor_architecture|home|userprofile|kodax_home|kodax_internal_daemon_test_parent_pid)$/i;
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => allowed.test(key))),
    KODAX_HANDOFF_LOCAL_KEY: 'local-fixture-only',
    KODAX_TRACING: '0' };
}

async function until(label, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

async function launcher() {
  const source = name => pathToFileURL(path.join(repo, 'src/runtime-daemon', name)).href;
  const { spawnWindowsJobContainedProcess } = await import(source('windows-job-supervisor.ts'));
  const { createRuntimeDaemonStartupProcess, waitForHealthyDaemonStartup } = await import(source('process.ts'));
  const { observeRuntimeDaemonHealth } = await import(source('lifecycle.ts'));
  const { resolveRuntimeDaemonPaths } = await import(source('state.ts'));
  const paths = resolveRuntimeDaemonPaths(home, 'default');
  const controller = new AbortController();
  process.on('message', message => { if (message.kind === 'abort') controller.abort(); });
  const contained = await spawnWindowsJobContainedProcess({
    executable: process.execPath, args: [cli, 'daemon', 'serve', '--home', home,
      '--provider', 'handoff-local', '--model', 'handoff-model'],
    cwd: repo, env: process.env, logFile: path.join(home, 'bootstrap.log'), startupHandoff: true,
  });
  const exited = contained.supervisor.exitCode !== null
    ? Promise.resolve({ code: contained.supervisor.exitCode, signal: null })
    : once(contained.supervisor, 'exit').then(([code, signal]) => ({ code, signal }));
  const child = createRuntimeDaemonStartupProcess(contained.supervisor, exited, contained.processPid,
    contained.terminate, contained.release);
  try {
    await waitForHealthyDaemonStartup(paths, { startupTimeoutMs: 30_000, startupSignal: controller.signal }, child,
      async (...args) => {
        const observed = await observeRuntimeDaemonHealth(...args);
        if (observed.state?.status === 'ready' && observed.identityMatches) {
          process.send({ kind: 'held', pid: contained.processPid });
          // Hold only A's health observation. The actual daemon is public and B uses normal SDK admission.
          return new Promise(() => {});
        }
        return observed;
      });
    throw new Error('Held launcher unexpectedly completed startup');
  } catch (error) {
    assert.match(String(error), /startup cancelled/i);
    process.send({ kind: 'cancelled' });
  } finally {
    process.disconnect();
  }
}

async function client() {
  const sdk = await import(sdkUrl);
  const runtime = await sdk.connectKodaXRuntime({
    homeDir: home, autoStart: role === 'ensure',
    defaultProvider: 'handoff-local', defaultModel: 'handoff-model',
  });
  try {
    const owner = (await runtime.daemon.inspect()).owner;
    process.send({ kind: 'connected', owner });
    const session = await runtime.sessions.create({ projectPath: home });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'Return the local acceptance marker.',
      options: { agentMode: 'sa' } });
    const result = await run.result;
    assert.equal(result.phase, 'completed', JSON.stringify(result));
    assert.ok(JSON.stringify(result.result).includes(output), JSON.stringify(result));
    process.send({ kind: 'completed' });
  } finally {
    await runtime.close();
    process.disconnect();
  }
}

function childProcess(args, environment) {
  const child = spawn(process.execPath, args, { cwd: repo, env: environment, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const state = { child, messages: [], logs: '', exited: undefined };
  child.on('message', message => state.messages.push(message));
  child.stdout.on('data', data => { state.logs = (state.logs + data).slice(-12000); });
  child.stderr.on('data', data => { state.logs = (state.logs + data).slice(-12000); });
  child.on('error', error => { state.logs += String(error); });
  child.on('exit', (code, signal) => { state.exited = { code, signal }; });
  return state;
}

function worker(kind, homeDir, environment) {
  const loader = kind === 'launcher'
    ? ['--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href] : [];
  return childProcess([...loader, self, '--repo', repo, '--home', homeDir, '--role', kind], environment);
}

async function message(state, kind) {
  return until(`child ${kind}`, () => {
    const received = state.messages.find(item => item.kind === kind);
    if (received) return received;
    if (state.exited) throw new Error(`Child exited before ${kind}: ${state.logs}`);
  });
}

async function finishChild(state, allowKilled = false) {
  if (!state) return;
  await until('child exit', () => state.exited, 10_000);
  if (!allowKilled) assert.equal(state.exited.code, 0, state.logs);
}

async function configure(homeDir, providerPort) {
  const configHome = path.join(homeDir, '.kodax');
  await mkdir(configHome, { recursive: true });
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ provider: 'handoff-local', customProviders: [{
    name: 'handoff-local', protocol: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKeyEnv: 'KODAX_HANDOFF_LOCAL_KEY', model: 'handoff-model',
  }] }));
}

function localProvider() {
  let finishResponse;
  let released = false;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { /* Drain only the local mock request. */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': held by handoff acceptance\n\n');
    const finish = () => response.end(`data: ${JSON.stringify({ id: 'handoff-local', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: output }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\ndata: [DONE]\n\n`);
    if (released) finish();
    else finishResponse = () => { released = true; finish(); };
  });
  return { server, get pending() { return finishResponse !== undefined; }, finish() { finishResponse?.(); } };
}

async function cleanupScenario({ kind, homeDir, provider, a, b, owner, primaryError }) {
  const errors = primaryError ? [primaryError] : [];
  try { provider.finish(); } catch (error) { errors.push(error); }
  for (const state of [a, b]) {
    if (!state || state.exited) continue;
    try { state.child.kill(); } catch (error) { errors.push(error); }
    try { await finishChild(state, true); } catch (error) { errors.push(error); }
  }
  try {
    await stopAcceptanceDaemon({ repo, homeDir, owner: owner ?? await readAcceptanceDaemonOwner(homeDir) });
  } catch (error) { errors.push(error); }
  try { provider.server.closeAllConnections(); } catch (error) { errors.push(error); }
  try {
    if (provider.server.listening) {
      await new Promise((resolve, reject) => provider.server.close(error => error ? reject(error) : resolve()));
    }
  } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, `${kind} failed; artifacts: ${homeDir}`);
}

async function scenario(kind) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), `kodax-handoff-${kind}-`));
  const provider = localProvider();
  const { server } = provider;
  let a;
  let b;
  let owner;
  let primaryError;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await configure(homeDir, server.address().port);
    const environment = isolatedEnvironment(homeDir);
    if (kind !== 'ensure') {
      a = worker('launcher', homeDir, environment);
      await message(a, 'held');
    }
    b = worker(kind === 'ensure' ? 'ensure' : 'client', homeDir, environment);
    owner = (await message(b, 'connected')).owner;
    await until('active local SSE request', () => {
      if (b.exited) throw new Error(`Client exited before provider request: ${b.logs}`);
      return provider.pending;
    });
    if (kind === 'kill') {
      a.child.kill();
      await finishChild(a, true);
    } else if (kind === 'abort') {
      a.child.send({ kind: 'abort' });
      await message(a, 'cancelled');
      await finishChild(a);
    }
    provider.finish();
    await message(b, 'completed');
    await finishChild(b);
  } catch (error) {
    primaryError = error;
  } finally {
    await cleanupScenario({ kind, homeDir, provider, a, b, owner, primaryError });
  }
  process.stdout.write(`PASS ${kind}: peer completed; exact daemon and Job shutdown verified\n`);
}

async function rejectedPublication() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-handoff-aborted-rpc-'));
  await configure(homeDir, 1);
  const marker = path.join(homeDir, 'already-aborted');
  await writeFile(marker, '', { flag: 'wx' });
  const child = childProcess([cli, 'daemon', 'serve', '--home', homeDir], {
    ...isolatedEnvironment(homeDir), KODAX_INTERNAL_WINDOWS_JOB_HANDOFF: marker,
  });
  try {
    await finishChild(child, true);
    assert.notEqual(child.exited.code, 0, child.logs);
    assert.match(child.logs, /startup cancelled before service publication/i);
    assert.equal(await readAcceptanceDaemonOwner(homeDir), undefined);
  } finally {
    if (!child.exited) { child.child.kill(); await finishChild(child, true); }
  }
  process.stdout.write('PASS abort-before-RPC: publication refused and owner released\n');
}

if (role) {
  try { await (role === 'launcher' ? launcher() : client()); }
  catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
} else if (process.platform !== 'win32') {
  throw new Error('This acceptance script requires Windows Job containment');
} else {
  await access(cli);
  await access(path.join(repo, 'src/runtime-daemon/windows-job-supervisor.ts'));
  for (const kind of ['ensure', 'kill', 'abort']) await scenario(kind);
  await rejectedPublication();
}
