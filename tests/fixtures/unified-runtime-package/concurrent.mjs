import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureKodaXRuntime, waitForRuntimeDaemonShutdown } from '@kodax-ai/kodax/runtime';

const [homeDir, barrier, role] = process.argv.slice(2);
if (role !== 'verify') {
  // Both independent callers load the installed SDK before the parent releases
  // them together. Neither can acquire a Host before this explicit barrier.
  await writeFile(path.join(barrier, `${role}.ready`), String(process.pid));
  const deadline = Date.now() + 30_000;
  while (!existsSync(path.join(barrier, 'go'))) {
    assert.ok(Date.now() < deadline, 'Concurrent launcher barrier timed out');
    await delay(20);
  }
}
const runtime = await ensureKodaXRuntime({ homeDir, profile: 'legacy', daemonStartupTimeoutMs: 60_000 });
let owner;
try {
  if (role === 'verify') {
    owner = (await runtime.daemon.inspect()).owner;
    const sessions = await runtime.sessions.list();
    assert.ok(sessions.some(session => session.title === 'concurrent-first'));
    assert.ok(sessions.some(session => session.title === 'concurrent-second'));
    process.stdout.write(JSON.stringify({ runtimeId: runtime.identity.runtimeId, pid: owner.pid,
      sessionIds: sessions.map(session => session.id) }) + '\n');
  } else {
    const session = await runtime.sessions.create({ title: `concurrent-${role}` });
    const descriptor = JSON.parse(await readFile(path.join(homeDir, '.kodax/runtime/daemon/legacy/daemon.json'), 'utf8'));
    assert.equal(descriptor.status, 'ready');
    assert.equal(descriptor.runtimeId, runtime.identity.runtimeId);
    assert.notEqual(descriptor.pid, process.pid);
    process.stdout.write(JSON.stringify({ runtimeId: runtime.identity.runtimeId, pid: descriptor.pid, sessionId: session.id }) + '\n');
  }
} finally {
  if (owner) {
    try { await runtime.daemon.shutdown(); } finally { await runtime.close(); }
    const stopped = await waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'), profile: 'legacy', owner });
    assert.equal(stopped.status, 'succeeded', JSON.stringify(stopped));
  } else await runtime.close();
}
