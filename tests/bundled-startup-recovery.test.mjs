import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { ensureKodaXClient } from '../dist/sdk-client.js';
import { FileSessionStorage } from '../dist/sdk-repl.js';

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
    assert.equal((await readdir(registry)).filter(file => file.endsWith('.json')).length, 0);

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
    const saved = await new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome }).load(sessionId);
    assert.equal(JSON.stringify(saved.messages), JSON.stringify(messages), 'Recovery must preserve every saved message');
    t.diagnostic(`220 exited trees: ready ${readyMs} ms; first concurrent history reads ${readMs} ms`);
    passed = true;
  } finally {
    try {
      if (clients[0]) {
        for (const client of clients.slice(1)) await client.disconnect();
        await clients[0].host.shutdown();
      }
    } finally {
      await clients[0]?.disconnect();
    }
    // Failed fixtures remain available for diagnosis. Only remove this test's
    // freshly allocated isolated HOME after its Host has accepted shutdown.
    if (passed) {
      assert.equal(path.dirname(homeDir), path.resolve(os.tmpdir()));
      await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } else t.diagnostic(`Retained isolated fixture: ${homeDir}`);
  }
});
