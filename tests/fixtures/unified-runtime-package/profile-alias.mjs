import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureKodaXRuntime, waitForRuntimeDaemonShutdown } from '@kodax-ai/kodax/runtime';

const homeDir = process.argv[2];
let original;
let alias;
let owner;
try {
  original = await ensureKodaXRuntime({ homeDir, profile: 'owner', daemonStartupTimeoutMs: 60_000 });
  owner = (await original.daemon.inspect()).owner;
  const session = await original.sessions.create({ title: 'Shared storage owner A' });
  alias = await ensureKodaXRuntime({ homeDir, profile: 'legacy', daemonStartupTimeoutMs: 60_000 });
  assert.equal(alias.identity.runtimeId, original.identity.runtimeId);
  assert.equal(alias.identity.profile, 'owner');
  assert.ok((await alias.sessions.list()).some(item => item.id === session.id));
  const requestedPolicy = JSON.parse(await readFile(path.join(homeDir, '.kodax/runtime/daemon/legacy/owner-policy.json'), 'utf8'));
  assert.equal(requestedPolicy.mode, 'host', 'Reusing owner A must also retire requested profile B inline rollback');
} finally {
  await alias?.close();
  if (original) {
    try { await original.daemon.shutdown(); } finally { await original.close(); }
  }
  if (owner) {
    const stopped = await waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'), profile: 'owner', owner });
    assert.equal(stopped.status, 'succeeded', JSON.stringify(stopped));
  }
}
process.stdout.write('PACKED_PROFILE_ALIAS_CUTOVER_PASSED\n');
