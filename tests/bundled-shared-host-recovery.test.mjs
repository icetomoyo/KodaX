import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/kodax_cli.js', import.meta.url));

test('ensure recovers a shared Session directory from an idle default-profile Host', { timeout: 60_000 }, async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-shared-host-recovery-'));
  const configHome = path.join(homeDir, '.kodax');
  const previousHome = process.env.KODAX_HOME;
  process.env.KODAX_HOME = configHome;
  const sdk = await import('../dist/sdk-runtime.js');
  let runtime;
  try {
    runtime = await sdk.ensureKodaXRuntime({ homeDir, profile: 'default', daemonStartupTimeoutMs: 15_000 });
    await runtime.close();
    runtime = undefined;
    runtime = await sdk.ensureKodaXRuntime({
      homeDir,
      profile: 'coder',
      daemonOrphanExitMs: 30_000,
      daemonStartupTimeoutMs: 10_000,
      requirements: { daemonOrphanExit: 1, productClient: 1 },
    });
    assert.equal(runtime.identity.profile, 'coder');
    assert.equal(runtime.capabilities.daemonOrphanExit.version, 1);
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
