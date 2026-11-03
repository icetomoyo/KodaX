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

const fixture = fileURLToPath(new URL('./bundled-shared-profile-recovery.test.mjs', import.meta.url));
async function worker(index) {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await new Promise((resolve, reject) => {
      let output = '';
      const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^ensure recovers a shared Session directory', fixture],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code !== 0) { reject(new Error(`SDK pressure worker ${index}, iteration ${iteration} failed (${code ?? signal})`)); return; }
        try {
          assert.match(output, /^ok \d+ - ensure recovers a shared Session directory from an idle default-profile Host\r?$/m,
            `SDK pressure worker ${index}, iteration ${iteration} did not execute the recovery case`);
          resolve();
        } catch (error) { reject(error); }
      });
    });
  }
}
// Await all workers, including cleanup, before reporting a failure.
const results = await Promise.allSettled(Array.from({ length: workers }, (_, index) => worker(index)));
const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
if (failures.length > 0) throw new AggregateError(failures, 'Windows SDK attachment under CPU contention failed');
