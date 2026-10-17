import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

// Exercise concurrent callers with the original public SDK test and unchanged
// 15s/10s budgets. Each worker owns an isolated Home and an available CPU slot.
// Deliberately starving three separate Hosts on one CPU is a deadline probe,
// not a requirement that every cold start must still succeed within 10s.
assert.equal(process.platform, 'win32');
const workers = Math.min(3, availableParallelism());
process.stdout.write(`Windows SDK attachment: ${workers} concurrent workers, 3 cases each\n`);

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
const results = await Promise.allSettled(Array.from({ length: workers }, (_, index) => worker(index)));
const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
if (failures.length > 0) throw new AggregateError(failures, 'Windows SDK attachment under CPU contention failed');
