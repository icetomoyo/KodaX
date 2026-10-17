import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Reproduce the CI resource contention with the original public SDK test and
// its unchanged 15s/10s budgets. Every worker owns an isolated temporary Home.
assert.equal(process.platform, 'win32');
const affinity = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$target = [System.Diagnostics.Process]::GetProcessById(${process.pid}); `
  + '$mask = $target.ProcessorAffinity.ToInt64(); $target.ProcessorAffinity = [IntPtr]($mask -band (-$mask))',
], { encoding: 'utf8', windowsHide: true });
if (affinity.error) throw affinity.error;
assert.equal(affinity.status, 0, 'Unable to pin the pressure gate to one available CPU');

const fixture = fileURLToPath(new URL('./bundled-shared-host-recovery.test.mjs', import.meta.url));
async function worker(index) {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--test', fixture], { windowsHide: true, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve()
        : reject(new Error(`SDK pressure worker ${index}, iteration ${iteration} failed (${code ?? signal})`)));
    });
  }
}
// Await all workers, including cleanup, before reporting a failure.
const results = await Promise.allSettled([0, 1, 2].map(worker));
const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
if (failures.length > 0) throw new AggregateError(failures, 'Windows SDK attachment under CPU contention failed');
