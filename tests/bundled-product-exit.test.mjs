import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureKodaXClient, connectKodaXClient, readKodaXClientExits } from '../dist/sdk-client.js';

async function verifiedExit(homeDir, clientInfo, requestId) {
  const deadline = Date.now() + 20_000;
  do {
    const receipt = (await readKodaXClientExits({ homeDir, clientInfo })).find(row => row.requestId === requestId);
    if (receipt?.host.state === 'failed') assert.fail(receipt.host.message);
    if (receipt?.host.state === 'succeeded' && receipt.recovery?.state === 'ready') return receipt;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail('Exact Host exit was not verified.');
}

test('Product quit protects an idle peer after the exiting client immediately disconnects', { timeout: 60_000 }, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-bundle-product-exit-peer-'));
  const ownInfo = { name: 'exiting', instanceId: randomUUID(), instanceSecret: randomUUID() };
  const peerInfo = { name: 'idle-peer', instanceId: randomUUID(), instanceSecret: randomUUID() };
  const own = await ensureKodaXClient({ homeDir, clientInfo: ownInfo });
  const peer = await connectKodaXClient({ homeDir, clientInfo: peerInfo });
  try {
    await peer.sessions.create({ projectPath: homeDir });
    await own.lifecycle.requestExit({ requestId: 'quit-own', shutdownHost: true });
    await own.disconnect();
    let receipt;
    const deadline = Date.now() + 10_000;
    do {
      receipt = (await readKodaXClientExits({ homeDir, clientInfo: ownInfo })).find(row => row.requestId === 'quit-own');
      if (receipt?.host.state === 'protected' || receipt?.host.state === 'succeeded') break;
      await delay(25);
    } while (Date.now() < deadline);
    assert.equal(receipt?.host.state, 'protected');
    assert.ok((await peer.sessions.create({ projectPath: homeDir })).id);
  } finally {
    await own.disconnect();
    try { await peer.lifecycle.requestExit({ requestId: 'quit-peer', shutdownHost: true });
      await peer.disconnect(); await verifiedExit(homeDir, peerInfo, 'quit-peer'); }
    catch (error) { if (!/closed|disconnected|socket|connection|EOF|EPIPE/i.test(String(error))) throw error; }
    await peer.disconnect();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Product quit verifies exact process cleanup offline and never quits a replacement Host', { timeout: 90_000 }, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-bundle-product-exit-'));
  const clientInfo = { name: 'Space-exit-test', instanceId: randomUUID(), instanceSecret: randomUUID() };
  let client;
  try {
    client = await ensureKodaXClient({ homeDir, clientInfo });
    const accepted = await client.lifecycle.requestExit({ requestId: 'quit-original', shutdownHost: true });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.host.state, 'pending');
    await client.disconnect();
    const completed = await verifiedExit(homeDir, clientInfo, 'quit-original');
    assert.equal(completed.cleanup.state, 'succeeded', JSON.stringify(completed));
    assert.equal(completed.host.cleanup, 'succeeded');
    assert.equal(completed.host.owner.runtimeId, accepted.runtimeId);
    // Emulate the legacy client's lost acknowledgement after a real verified
    // process/Job shutdown. Keep the actual owner and shutdown evidence intact.
    const digest = value => createHash('sha256').update(value).digest('hex');
    const file = path.join(homeDir, '.kodax', 'runtime', 'daemon', 'default', 'client-exits',
      digest(accepted.clientId), `${digest(accepted.requestId)}.json`);
    const original = JSON.parse(await readFile(file, 'utf8'));
    const unconfirmed = JSON.stringify({ ...original, cleanup: { ...original.cleanup, state: 'unknown',
      issues: ['Client memory work remains unconfirmed.'] } });
    await writeFile(file, unconfirmed);
    for (let restart = 0; restart < 2; restart += 1) {
      const offline = await verifiedExit(homeDir, clientInfo, 'quit-original');
      assert.equal(offline.cleanup.state, 'unknown');
      assert.equal(offline.recovery.nextAction, 'start_or_connect');
      client = await ensureKodaXClient({ homeDir, clientInfo });
      const recovered = await client.lifecycle.readExit('quit-original');
      assert.equal(recovered.cleanup.state, 'unknown');
      assert.equal(recovered.recovery.state, 'ready');
      assert.equal(recovered.host.replacementRunning, true);
      assert.deepEqual(await client.lifecycle.listPendingExits(), []);
      const replayed = await client.lifecycle.requestExit({ requestId: 'quit-original', shutdownHost: true });
      assert.equal(replayed.runtimeId, accepted.runtimeId);
      assert.equal(replayed.recovery.state, 'ready');
      await delay(100);
      assert.ok((await client.sessions.create({ projectPath: homeDir })).id);
      assert.equal(await readFile(file, 'utf8'), unconfirmed);
      const requestId = `quit-replacement-${restart}`;
      const replacement = await client.lifecycle.requestExit({ requestId, shutdownHost: true });
      assert.notEqual(replacement.runtimeId, accepted.runtimeId);
      await client.disconnect();
      await verifiedExit(homeDir, clientInfo, requestId);
    }
  } finally {
    if (client) {
      try { await client.lifecycle.requestExit({ requestId: 'test-cleanup', shutdownHost: true }); }
      catch (error) { if (!/closed|disconnected|socket|connection|EOF/i.test(String(error))) throw error; }
      await client.disconnect();
    }
    // Only this test's freshly created temp directory is removed.
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
