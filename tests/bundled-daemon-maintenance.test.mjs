import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ensureKodaXRuntime } from '../dist/sdk-runtime.js';

test('the bundled ready Host removes only abandoned publications through its lazy maintenance entry', { timeout: 60_000 }, async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bundled-maintenance-'));
  const profile = 'maintenance';
  const root = path.join(homeDir, '.kodax/runtime/daemon', profile);
  await fs.mkdir(root, { recursive: true });
  const record = { runtimeId: 'retired-publication', pid: 2_147_483_647,
    processStartIdentity: 'retired', createdAt: new Date().toISOString(), kind: 'daemon' };
  const abandoned = path.join(root, `daemon.lock.${randomUUID()}.tmp`);
  const active = path.join(root, `daemon.lock.${randomUUID()}.tmp`);
  await fs.writeFile(abandoned, JSON.stringify(record));
  const activeBytes = JSON.stringify({ ...record, pid: process.pid });
  await fs.writeFile(active, activeBytes);
  let runtime;
  try {
    runtime = await ensureKodaXRuntime({ homeDir, profile, daemonStartupTimeoutMs: 30_000 });
    const deadline = Date.now() + 15_000;
    while (true) {
      try { await fs.access(abandoned); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      assert.ok(Date.now() < deadline, 'The ready Host did not perform its idle maintenance round');
      await delay(50);
    }
    assert.equal(await fs.readFile(active, 'utf8'), activeBytes);
    assert.equal((await runtime.status.snapshot()).runtimeId, runtime.identity.runtimeId);
  } finally {
    if (runtime) {
      await runtime.daemon.shutdown();
      await runtime.close();
    }
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
