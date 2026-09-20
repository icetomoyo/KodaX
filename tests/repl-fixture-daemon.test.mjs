import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { stopReplFixtureDaemon } from './repl-fixture-daemon.mjs';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));

async function startFixture(t, extraEnv = {}, baseUrl = 'http://127.0.0.1:1/v1') {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-repl-cleanup-test-'));
  const configHome = path.join(homeDir, '.kodax');
  await mkdir(configHome);
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({
    provider: 'parity-local', customProviders: [{
      name: 'parity-local', protocol: 'openai', baseUrl,
      apiKeyEnv: 'KODAX_ACCEPTANCE_KEY', model: 'parity-model',
    }],
  }));
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, KODAX_HOME: configHome,
    KODAX_INTERNAL_DAEMON_TEST_PARENT_PID: String(process.pid), KODAX_ACCEPTANCE_KEY: 'local-fixture-only', ...extraEnv };
  const command = (action) => execute(process.execPath, [path.join(repo, 'scripts/kodax-bin.cjs'),
    'daemon', action, '--home', homeDir, '--timeout-ms', '15000', '--json'],
  { cwd: repo, env, windowsHide: true, timeout: 30_000 });
  t.after(async () => { await command('stop'); });
  await command('start');
  const owner = JSON.parse(await readFile(path.join(configHome, 'runtime/daemon/default/daemon.lock'), 'utf8'));
  process.kill(owner.pid, 0);
  return { homeDir, configHome, owner, env };
}

test('REPL fixture teardown waits for its detached daemon and Job owner to exit', { timeout: 60_000 }, async (t) => {
  const { homeDir, owner } = await startFixture(t);

  await assert.rejects(stopReplFixtureDaemon({ repo, homeDir, owner: { ...owner, runtimeId: 'another-owner' } }),
    /retain its captured owner/);
  process.kill(owner.pid, 0);
  await stopReplFixtureDaemon({ repo, homeDir, sourceEntry: true });

  assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' });
  if (owner.supervisorPid) {
    assert.throws(() => process.kill(owner.supervisorPid, 0), { code: 'ESRCH' });
  }
});

test('teardown aborts an unfinished fixture run before shutting down', { timeout: 60_000 }, async (t) => {
  let requestReceived;
  const received = new Promise(resolve => { requestReceived = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': fixture holds the stream open\n\n');
    requestReceived();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { homeDir, owner, env } = await startFixture(t, {}, `http://127.0.0.1:${server.address().port}/v1`);
  const code = `
    const { connectKodaXRuntime } = await import(process.argv[1]);
    const runtime = await connectKodaXRuntime({ homeDir: process.argv[2], autoStart: false });
    try {
      const session = await runtime.sessions.create({ projectPath: process.argv[2] });
      await runtime.runs.start({ sessionId: session.id, prompt: 'Wait for the fixture response', options: { agentMode: 'sa' } });
    } finally { await runtime.close(); }
  `;
  await execute(process.execPath, ['--input-type=module', '-e', code,
    pathToFileURL(path.join(repo, 'dist/sdk-runtime.js')).href, homeDir], { cwd: repo, env, windowsHide: true, timeout: 15_000 });
  let timer;
  try {
    await Promise.race([received, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture must reach its local provider')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
  await stopReplFixtureDaemon({ repo, homeDir, owner });
  assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' });
});

test('teardown of a fixture that never started does not create a daemon', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-repl-unstarted-'));
  await stopReplFixtureDaemon({ repo, homeDir });
  await assert.rejects(access(path.join(homeDir, '.kodax')), { code: 'ENOENT' });
});

test('teardown verifies a captured owner even after daemon state has been removed', { timeout: 60_000 }, async (t) => {
  const { homeDir, configHome, owner, env } = await startFixture(t, {
    KODAX_INTERNAL_DAEMON_TEST_FINAL_CLEANUP_DELAY_MS: '4000',
  });
  const code = `
    const { connectKodaXRuntime } = await import(process.argv[1]);
    const runtime = await connectKodaXRuntime({ homeDir: process.argv[2], autoStart: false });
    try { await runtime.daemon.shutdown(); } finally { await runtime.close(); }
  `;
  await execute(process.execPath, ['--input-type=module', '-e', code,
    pathToFileURL(path.join(repo, 'dist/sdk-runtime.js')).href, homeDir], { cwd: repo, env, windowsHide: true });
  const stateFile = path.join(configHome, 'runtime/daemon/default/daemon.json');
  const deadline = Date.now() + 5000;
  while (await access(stateFile).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) {
    assert.ok(Date.now() < deadline, 'Host must release state before final cleanup');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  process.kill(owner.pid, 0);
  await stopReplFixtureDaemon({ repo, homeDir, owner });
  assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' });
});
