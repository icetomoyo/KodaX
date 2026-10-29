import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as runtimeSdk from '@kodax-ai/kodax/runtime';
import * as rootSdk from '@kodax-ai/kodax';

const homeDir = process.argv[2];
const profile = 'legacy';
for (const sdk of [runtimeSdk, rootSdk]) {
  for (const name of ['createKodaXHostRuntime', 'acquireKodaXInlineOwner', 'setKodaXRuntimeOwnerMode']) {
    assert.equal(name in sdk, false, `${name} must not be exported by a published SDK entry`);
  }
  await assert.rejects(sdk.createKodaXRuntime(), { code: 'runtime_host_migration_required' });
  for (const options of [
    {}, { mode: 'embedded' }, { mode: 'daemon', sharedDaemonHost: false },
    { mode: 'daemon', daemonHostRuntimeId: undefined }, { mode: 'daemon', externalAgents: undefined },
  ]) {
    const rejectedHome = path.join(homeDir, 'must-not-create');
    await assert.rejects(sdk.createKodaXRuntime({ ...options, homeDir: rejectedHome }), {
      code: 'runtime_host_migration_required',
    });
    assert.equal(existsSync(rejectedHome), false, 'Rejected compatibility calls must not create state');
  }
}

const ownerOptions = {
  mode: 'daemon', homeDir, profile, daemonStartupTimeoutMs: 60_000,
  execPolicy: { adminRules: [{ prefix: ['git', 'push'], decision: 'forbidden', justification: 'Package fixture.' }] },
  autoReview: { administratorPolicy: 'Do not publish fixture work.', modelGuidance: 'Offline verification.' },
};
let host;
let peer;
let owner;
try {
  host = await runtimeSdk.createKodaXRuntime(ownerOptions);
  owner = (await host.daemon.inspect()).owner;
  assert.notEqual(owner.pid, process.pid, 'The SDK caller must not own the execution process');
  assert.equal(host.identity.isolation, 'process');
  const session = await host.sessions.create({ title: 'Packed unified Host' });
  peer = await runtimeSdk.connectKodaXRuntime({ homeDir, profile });
  assert.equal(peer.identity.runtimeId, host.identity.runtimeId);
  await assert.rejects(runtimeSdk.createKodaXRuntime(ownerOptions), /already|owner|policy|running/i);
  await host.close();
  host = undefined;
  assert.ok((await peer.sessions.list()).some(item => item.id === session.id), 'Disconnect must retain the shared Session');
  const stateDirectory = path.join(homeDir, '.kodax', 'runtime', 'daemon', profile);
  assert.equal((await readdir(stateDirectory)).some(name => name.startsWith('owner-bootstrap-')), false);
  assert.equal(JSON.parse(await readFile(path.join(stateDirectory, 'owner-policy.json'), 'utf8')).mode, 'host');
} finally {
  const shutdown = peer ?? host;
  if (shutdown) {
    try { await shutdown.daemon.shutdown(); }
    finally { await peer?.close(); await host?.close(); }
  }
  if (owner) {
    const stopped = await runtimeSdk.waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'), profile, owner });
    assert.equal(stopped.status, 'succeeded', JSON.stringify(stopped));
  }
}
process.stdout.write('PACKED_UNIFIED_HOST_PASSED\n');
