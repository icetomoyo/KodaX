// Windows lifecycle acceptance against the selected installation's built CLI/SDK.
// Usage: node tests/windows-daemon-handoff.mjs [--repo <installation>]
// The held-launcher seam imports target source through tsx; all serving/client work uses dist.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readReplFixtureDaemonOwner, replFixtureEnvironment, stopReplFixtureDaemon } from './repl-fixture-daemon.mjs';

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
  const inherited = replFixtureEnvironment(homeDir);
  const allowed = /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|commonprogramfiles|processor_architecture|home|userprofile|kodax_home|kodax_internal_daemon_test_parent_pid)$/i;
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => allowed.test(key))),
    KODAX_HANDOFF_LOCAL_KEY: 'local-fixture-only', KODAX_HANDOFF_A2A_TOKEN: 'local-fixture-only',
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
    executable: process.execPath, args: [cli, 'daemon', 'serve', '--home', home],
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
  const runtime = await (role === 'ensure' ? sdk.ensureKodaXRuntime : sdk.connectKodaXRuntime)({
    homeDir: home, defaultProvider: 'handoff-local', defaultModel: 'handoff-model',
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

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function configure(homeDir, providerPort, a2aPort) {
  const configHome = path.join(homeDir, '.kodax');
  await mkdir(configHome, { recursive: true });
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ provider: 'handoff-local', customProviders: [{
    name: 'handoff-local', protocol: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKeyEnv: 'KODAX_HANDOFF_LOCAL_KEY', model: 'handoff-model',
  }] }));
  if (a2aPort === undefined) return;
  await mkdir(path.join(configHome, 'integrations'), { recursive: true });
  await writeFile(path.join(configHome, 'integrations/a2a.json'), JSON.stringify({ version: 2, agents: {}, server: {
    execution: { kind: 'runtime-default' },
    published: { name: 'Handoff acceptance', description: 'Local lifecycle test', version: '1.0.0',
      skills: [], inputModes: ['text/plain'], outputModes: ['text/plain'] },
    listen: { hostname: '127.0.0.1', port: a2aPort },
    authentication: { type: 'bearer-env', tokenEnv: 'KODAX_HANDOFF_A2A_TOKEN', principalId: 'local-test' },
    dataDir: path.join(configHome, 'a2a-tasks'),
  } }));
}

async function served(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`,
      { signal: AbortSignal.timeout(500) });
    return response.status === 200;
  } catch { return false; }
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
    await stopReplFixtureDaemon({ repo, homeDir, owner: owner ?? await readReplFixtureDaemonOwner(homeDir) });
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
    const a2aPort = kind === 'abort-a2a' ? await freePort() : undefined;
    await configure(homeDir, server.address().port, a2aPort);
    const environment = isolatedEnvironment(homeDir);
    if (kind !== 'ensure') {
      a = worker('launcher', homeDir, environment);
      await message(a, 'held');
    }
    b = worker(kind === 'ensure' ? 'ensure' : 'client', homeDir, environment);
    owner = (await message(b, 'connected')).owner;
    await until('active local SSE request', () => provider.pending);
    if (a2aPort) assert.equal(await served(a2aPort), true, 'A2A must be public before cancellation');
    if (kind === 'kill') {
      a.child.kill();
      await finishChild(a, true);
    } else if (kind === 'abort-a2a') {
      a.child.send({ kind: 'abort' });
      await message(a, 'cancelled');
      await finishChild(a);
      assert.equal(await served(a2aPort), true, 'A2A must remain public after cancellation');
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

async function rejectedA2A() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-handoff-abort-a2a-'));
  const port = await freePort();
  await configure(homeDir, 1, port);
  const marker = path.join(homeDir, 'already-aborted');
  await writeFile(marker, '', { flag: 'wx' });
  const child = childProcess([cli, 'daemon', 'serve', '--home', homeDir], {
    ...isolatedEnvironment(homeDir), KODAX_INTERNAL_WINDOWS_JOB_HANDOFF: marker,
  });
  try {
    await until('aborted CLI exit', async () => {
      assert.equal(await served(port), false, 'A2A admitted requests after abort won');
      return child.exited;
    });
    assert.notEqual(child.exited.code, 0, child.logs);
    assert.match(child.logs, /startup cancelled before service publication/i);
    assert.equal(await served(port), false);
  } finally {
    if (!child.exited) { child.child.kill(); await finishChild(child, true); }
  }
  process.stdout.write('PASS abort-before-A2A: no listener publication\n');
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
  for (const kind of ['ensure', 'kill', 'abort-a2a']) await scenario(kind);
  await rejectedA2A();
}
