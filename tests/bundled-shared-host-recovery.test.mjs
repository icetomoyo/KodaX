import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/kodax_cli.js', import.meta.url));

test('ordinary CLI Host exits after 30 idle seconds and releases ownership', { timeout: 90_000 }, async (context) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-cli-idle-exit-'));
  const configHome = path.join(homeDir, '.kodax');
  const environment = { ...process.env, KODAX_HOME: configHome, KODAX_TRACING: '0' };
  const ownerDir = path.join(configHome, 'runtime/daemon/default');
  let ownerPid;
  let supervisorPid;
  try {
    execFileSync(process.execPath, [cli, '--session', 'list'], {
      env: environment, windowsHide: true, timeout: 30_000, encoding: 'utf8',
    });
    assert.doesNotMatch(await fs.readFile(path.join(ownerDir, 'bootstrap.log'), 'utf8'), /\[kodax-startup\]/,
      'A non-interactive launch without a progress observer must not enable Host progress records');
    const idleAt = performance.now();
    const state = JSON.parse(await fs.readFile(path.join(ownerDir, 'daemon.json'), 'utf8'));
    ownerPid = state.pid;
    supervisorPid = JSON.parse(await fs.readFile(path.join(ownerDir, 'daemon.lock'), 'utf8')).supervisorPid;
    const sdk = await import('../dist/sdk-runtime.js');
    // The CLI used a KODAX_HOME override, whose endpoint scope is the config
    // directory. Attach to its descriptor instead of deriving a canonical Home scope.
    const client = await sdk.connectKodaXRuntime({ homeDir, endpoint: state.endpoint });
    assert.equal(client.identity.runtimeId, state.runtimeId);
    assert.equal(client.capabilities.daemonOrphanExit.version, 1);
    await client.close();
    const detachedAt = performance.now();
    await delay(27_500);
    assert.equal(JSON.parse(await fs.readFile(path.join(ownerDir, 'daemon.json'), 'utf8')).runtimeId, state.runtimeId);
    const deadline = performance.now() + 15_000;
    let ownerPresent = true;
    while (ownerPresent && performance.now() < deadline) {
      try { await fs.access(path.join(ownerDir, 'daemon.lock')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; ownerPresent = false; }
      if (ownerPresent) await delay(100);
    }
    assert.equal(ownerPresent, false, 'Idle CLI Host must release its owner fence');
    await assert.rejects(fs.access(path.join(ownerDir, 'daemon.json')), { code: 'ENOENT' });
    await waitForPidExit(ownerPid);
    if (supervisorPid !== undefined) await waitForPidExit(supervisorPid);
    context.diagnostic(`CLI startup/reconnect ${Math.round(detachedAt - idleAt)}ms; idle owner release ${Math.round(performance.now() - detachedAt)}ms`);
  } finally {
    const stopped = JSON.parse(execFileSync(process.execPath, [cli, 'daemon', 'stop', '--json'], {
      env: environment, windowsHide: true, timeout: 20_000, encoding: 'utf8',
    }));
    assert.ok(stopped.stopped || stopped.reason === 'missing');
    if (ownerPid !== undefined) await waitForPidExit(ownerPid);
    if (supervisorPid !== undefined) await waitForPidExit(supervisorPid);
    assert.equal(path.dirname(homeDir), path.resolve(os.tmpdir()));
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

async function waitForPidExit(pid) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  assert.fail('The private idle Host process did not exit');
}
