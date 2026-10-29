import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { ensureKodaXClient } from '../dist/sdk-client.js';
import { FileSessionStorage } from '../dist/sdk-repl.js';
import { waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';

async function closeFixtureHost(clients, configHome) {
  const closing = clients.splice(0);
  if (!closing[0]) return;
  let owner;
  try {
    owner = JSON.parse(await readFile(path.join(configHome, 'runtime/daemon/default/daemon.lock'), 'utf8'));
    await Promise.all(closing.slice(1).map(client => client.disconnect()));
    await closing[0].host.shutdown();
  } finally {
    await Promise.all(closing.map(client => client.disconnect()));
  }
  const result = await waitForRuntimeDaemonShutdown({ configHome, owner });
  assert.equal(result.status, 'succeeded', 'The exact fixture Host and its process containment must exit');
  return owner.runtimeId;
}

test('concurrent resume clients recover exited Windows trees without per-record helper startup', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async t => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-startup-recovery-'));
  const configHome = path.join(homeDir, '.kodax');
  const registry = path.join(configHome, 'runtime/processes/children');
  const clients = [];
  let passed = false;
  try {
    await mkdir(registry, { recursive: true });
    const ownerPid = 2_146_999_999;
    assert.throws(() => process.kill(ownerPid, 0), { code: 'ESRCH' });
    for (let index = 0; index < 220; index++) {
      const pid = 2_147_000_000 + index;
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      const registrationId = randomUUID();
      await writeFile(path.join(registry, `${pid}.${registrationId}.json`), JSON.stringify({
        version: 4, registrationId, pid, ownerPid, registeredAtMs: Date.now(),
        kind: 'startup-recovery-fixture', command: 'no-command-is-executed',
        processStartIdentity: '1', processTreeIdentities: [{ pid, creationTime: '1' }],
        processTreeComplete: true,
      }));
    }
    const pendingPid = 2_147_000_220;
    assert.throws(() => process.kill(pendingPid, 0), { code: 'ESRCH' });
    const pendingRegistration = randomUUID();
    const pendingName = `${pendingPid}.${pendingRegistration}.json`;
    const pendingFile = path.join(registry, pendingName);
    const pendingContents = JSON.stringify({
      version: 4, registrationId: pendingRegistration, pid: pendingPid, ownerPid,
      registeredAtMs: Date.now(), kind: 'bash', command: 'no-command-is-executed',
      runtimeRunId: 'startup-unresolved-run', runCleanupRequired: true,
      processStartIdentity: '1', processTreeIdentities: [{ pid: pendingPid, creationTime: '1' }],
      processTreeComplete: false,
    });
    await writeFile(pendingFile, pendingContents);
    const sessionId = '20261029_000001_371000000001';
    const messages = Array.from({ length: 400 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `resume fixture ${index}\n${'saved history '.repeat(80)}`,
    }));
    await new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome })
      .save(sessionId, { title: 'Cold resume history', gitRoot: homeDir, messages });

    const started = performance.now();
    const launches = await Promise.allSettled([0, 1].map(async () => {
      const client = await ensureKodaXClient({ homeDir, daemonStartupTimeoutMs: 12_000 });
      clients.push(client);
      return client;
    }));
    for (const launch of launches) if (launch.status === 'rejected') throw launch.reason;
    const readyMs = Math.round(performance.now() - started);
    assert.ok(readyMs < 10_000, `Cold recovery took ${readyMs} ms for 220 exited trees`);
    assert.deepEqual((await readdir(registry)).filter(file => file.endsWith('.json')), [pendingName]);
    assert.equal(await readFile(pendingFile, 'utf8'), pendingContents, 'Unresolved Run evidence must survive recovery');

    const readStarted = performance.now();
    await Promise.all(clients.map(async client => {
      const session = await client.sessions.read(sessionId);
      assert.equal(session.id, sessionId);
      assert.equal(session.msgCount, messages.length);
      const history = await client.sessions.readHistory(sessionId, { limit: 10 });
      assert.ok(history.items.some(item => item.text.includes('resume fixture 399')));
    }));
    const readMs = Math.round(performance.now() - readStarted);
    assert.ok(readMs < 2_000, `First concurrent Session/history reads took ${readMs} ms`);
    const originalRuntimeId = await closeFixtureHost(clients, configHome);
    const restartedAt = performance.now();
    const restarted = await ensureKodaXClient({ homeDir, daemonStartupTimeoutMs: 12_000 });
    clients.push(restarted);
    const replacement = JSON.parse(await readFile(path.join(configHome, 'runtime/daemon/default/daemon.lock'), 'utf8'));
    assert.notEqual(replacement.runtimeId, originalRuntimeId, 'Resume must start a new generation after verified shutdown');
    assert.equal((await restarted.sessions.read(sessionId)).msgCount, messages.length);
    const history = await restarted.sessions.readHistory(sessionId, { limit: 10 });
    assert.ok(history.items.some(item => item.text.includes('resume fixture 399')));
    assert.equal(await readFile(pendingFile, 'utf8'), pendingContents);
    const restartMs = Math.round(performance.now() - restartedAt);
    assert.ok(restartMs < 10_000, `Resume after verified shutdown took ${restartMs} ms`);
    const saved = await new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome }).load(sessionId);
    assert.equal(JSON.stringify(saved.messages), JSON.stringify(messages), 'Recovery and restart must preserve every saved message');
    t.diagnostic(`220 exited trees: ready ${readyMs} ms; first concurrent history reads ${readMs} ms; restart ${restartMs} ms`);
    passed = true;
  } finally {
    await closeFixtureHost(clients, configHome);
    // Failed fixtures remain available for diagnosis. Only remove this test's
    // freshly allocated isolated HOME after its exact Host and Job have exited.
    if (passed) {
      assert.equal(path.dirname(homeDir), path.resolve(os.tmpdir()));
      await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } else t.diagnostic(`Retained isolated fixture: ${homeDir}`);
  }
});
