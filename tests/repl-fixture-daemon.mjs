import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

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
      await runtime.daemon.shutdown();
    } finally {
      await runtime.close();
    }
  }
  const result = await waitForRuntimeDaemonShutdown({
    configHome: process.env.KODAX_HOME, owner, timeoutMs: 15000,
  });
  if (result.status !== 'succeeded') throw new Error('Fixture daemon cleanup failed: ' + JSON.stringify(result));
`;

export function replFixtureEnvironment(homeDir) {
  return { ...process.env, HOME: homeDir, USERPROFILE: homeDir, KODAX_HOME: path.join(homeDir, '.kodax'),
    KODAX_INTERNAL_DAEMON_TEST_PARENT_PID: String(process.pid) };
}

export async function readReplFixtureDaemonOwner(homeDir) {
  try {
    return JSON.parse(await readFile(path.join(homeDir, '.kodax/runtime/daemon/default/daemon.lock'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// A probe's freshly created Home is exclusively owned by that probe. Never auto-start during cleanup.
export async function stopReplFixtureDaemon({ repo, homeDir, sourceEntry = false, owner }) {
  const configHome = path.join(homeDir, '.kodax');
  let state;
  try {
    state = JSON.parse(await readFile(path.join(configHome, 'runtime/daemon/default/daemon.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  owner ??= await readReplFixtureDaemonOwner(homeDir);
  if (!state && !owner) return;
  assert.ok(owner, 'Fixture daemon must have a verifiable owner');
  if (state) {
    assert.equal(path.resolve(state.configHome), path.resolve(configHome), 'Fixture daemon must own the temporary Home');
    assert.equal(state.runtimeId, owner.runtimeId, 'Fixture daemon must retain its captured owner');
    assert.equal(state.pid, owner.pid, 'Fixture daemon must retain its captured PID');
  }
  const sdk = pathToFileURL(path.join(repo, sourceEntry ? 'src/sdk-runtime.ts' : 'dist/sdk-runtime.js')).href;
  const loader = sourceEntry ? ['--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href] : [];
  await execute(process.execPath, [...loader, '--input-type=module', '-e', stopScript, sdk, homeDir,
    JSON.stringify(owner), state ? 'running' : 'stopping'], {
    cwd: repo, env: replFixtureEnvironment(homeDir), windowsHide: true, timeout: 45_000,
  });
}
