import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/kodax_cli.js', import.meta.url));

test('ensure recovers a shared Session directory from an idle default-profile Host', { timeout: 60_000 }, async (context) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-shared-host-recovery-'));
  const configHome = path.join(homeDir, '.kodax');
  const previousHome = process.env.KODAX_HOME;
  process.env.KODAX_HOME = configHome;
  const sdk = await import('../dist/sdk-runtime.js');
  const trace = [];
  let phase = 'initial';
  let startedAt = performance.now();
  const onStartupProgress = event => { trace.push({ phase, ms: Math.round(performance.now() - startedAt), ...event }); };
  let runtime;
  try {
    runtime = await sdk.ensureKodaXRuntime({ homeDir, profile: 'default', daemonStartupTimeoutMs: 15_000, onStartupProgress });
    context.diagnostic(`Initial SDK attachment: ${Math.round(performance.now() - startedAt)}ms`);
    await runtime.close();
    runtime = undefined;
    phase = 'refresh';
    startedAt = performance.now();
    runtime = await sdk.ensureKodaXRuntime({
      homeDir,
      profile: 'coder',
      daemonOrphanExitMs: 30_000,
      daemonStartupTimeoutMs: 10_000,
      requirements: { daemonOrphanExit: 1, productClient: 1 },
      onStartupProgress,
    });
    context.diagnostic(`SDK Host refresh and attachment: ${Math.round(performance.now() - startedAt)}ms`);
    assert.equal(runtime.identity.profile, 'coder');
    assert.equal(runtime.capabilities.daemonOrphanExit.version, 1);
  } catch (error) {
    context.diagnostic(`SDK startup stages: ${JSON.stringify(trace)}`);
    throw error;
  } finally {
    await runtime?.close();
    for (const profile of ['default', 'coder']) {
      const result = JSON.parse(execFileSync(process.execPath, [
        cli, 'daemon', 'stop', '--profile', profile, '--timeout-ms', '5000', '--json',
      ], { env: { ...process.env, KODAX_HOME: configHome }, windowsHide: true, timeout: 20_000, encoding: 'utf8' }));
      if (!result.stopped && result.health !== 'missing') {
        const status = JSON.parse(execFileSync(process.execPath, [cli, 'daemon', 'status', '--profile', profile, '--json'], {
          env: { ...process.env, KODAX_HOME: configHome }, windowsHide: true, timeout: 10_000, encoding: 'utf8',
        }));
        assert.equal(status.pidAlive, false, `Unable to clean up isolated ${profile} Host`);
      }
    }
    if (previousHome === undefined) delete process.env.KODAX_HOME;
    else process.env.KODAX_HOME = previousHome;
    assert.equal(path.dirname(homeDir), path.resolve(os.tmpdir()));
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
