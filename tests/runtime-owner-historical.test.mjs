import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { HISTORICAL_OWNERS, loadHistoricalOwner } from './fixtures/historical-runtime-owner.mjs';

const current = await tsImport('../src/runtime-daemon/state.ts', import.meta.url);

for (const snapshot of HISTORICAL_OWNERS) {
  test(`${snapshot.version} owner cannot restore inline ownership after unified cutover`, { timeout: 30_000 }, async context => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-historical-owner-'));
    try {
      const legacy = await loadHistoricalOwner(snapshot, directory);
      const paths = legacy.resolveRuntimeDaemonPaths(directory, 'legacy');
      const sessionsDir = path.join(directory, '.kodax', 'sessions');
      const owner = { runtimeId: 'inline_historical_fixture', pid: process.pid,
        createdAt: new Date().toISOString(), kind: 'inline' };

      // Positive control: execute the old public state API, including its real
      // OS identity observation and owner lock. Migration must not steal it.
      const first = legacy.acquireRuntimeInlineOwner(paths, owner, true);
      assert.equal(legacy.readRuntimeOwnerPolicy(paths).mode, 'inline');
      assert.throws(() => current.prepareRuntimeDaemonOwner(paths, sessionsDir), /active|liveness/i);
      assert.equal(legacy.releaseRuntimeDaemonOwnership(paths, first), true);

      // Merely writing daemon would allow the old SDK to switch back after idle
      // exit. Demonstrate that exact old implementation before testing cutover.
      legacy.enableRuntimeDaemonOwner(paths);
      const rollback = legacy.acquireRuntimeInlineOwner(paths, owner, true);
      assert.equal(legacy.readRuntimeOwnerPolicy(paths).mode, 'inline');
      assert.equal(legacy.releaseRuntimeDaemonOwnership(paths, rollback), true);

      const migrated = current.prepareRuntimeDaemonOwner(paths, sessionsDir);
      assert.equal(migrated.unified, true);
      const saved = await readFile(paths.ownerPolicyFile, 'utf8');
      assert.equal(JSON.parse(saved).mode, 'host');
      assert.throws(() => legacy.readRuntimeOwnerPolicy(paths), /corrupt/i);
      assert.throws(() => legacy.acquireRuntimeInlineOwner(paths, owner, true), /corrupt/i);
      assert.equal(existsSync(paths.lockFile), false);
      assert.equal(await readFile(paths.ownerPolicyFile, 'utf8'), saved);
      assert.deepEqual(current.prepareRuntimeDaemonOwner(paths, sessionsDir), migrated);
      context.diagnostic(`Historical owner implementation: ${snapshot.revision}; state SHA-256 ${snapshot.hashes['src/runtime-daemon/state.ts']}`);
    } finally {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
