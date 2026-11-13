import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureKodaXClient } from '../dist/sdk-client.js';
import { loadAgentsFiles, loadInstructionFiles } from '../dist/sdk-coding.js';
import { FileSessionStorage } from '../dist/sdk-repl.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';

test('built Product SDK loads tagged instructions and derives complete history through its Host', { timeout: 90_000 }, async () => {
  const temporary = await realpath(os.tmpdir());
  const homeDir = await mkdtemp(path.join(temporary, 'kodax-bundled-history-'));
  const configHome = path.join(homeDir, '.kodax');
  let client;
  try {
    await mkdir(path.join(configHome, 'rules'), { recursive: true });
    await writeFile(path.join(homeDir, 'AGENTS.md'), 'project instruction');
    await writeFile(path.join(configHome, 'rules', 'fixture.md'), 'fragment instruction');
    const options = { cwd: homeDir, projectRoot: homeDir, kodaxDir: configHome };
    assert.ok(loadAgentsFiles(options).every(file => path.basename(file.path) === 'AGENTS.md'));
    assert.ok(loadInstructionFiles(options).some(file => file.kind === 'rule' && file.content === 'fragment instruction'));
    client = await ensureKodaXClient({ homeDir,
      requirements: { productHistoryTurnResolution: 2, productHistoryLocation: 2 } });
    assert.equal(client.capabilities.supports('productHistoryTurnResolution', 2), true);
    const session = await client.sessions.create({ projectPath: homeDir });
    const storage = new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome });
    const saved = await storage.load(session.id);
    assert.ok(saved);
    saved.messages = [
      { role: 'user', content: 'first query' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'saved-call', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'saved-call', content: 'saved result' }] },
      { role: 'user', content: 'second query' }, { role: 'assistant', content: 'second answer' },
    ];
    delete saved.lineage;
    await storage.save(session.id, saved);
    const newest = await client.sessions.readHistory(session.id, { limit: 1 });
    const older = await client.sessions.readHistory(session.id, { limit: 1, cursor: newest.nextCursor });
    assert.ok(older.newerCursor);
    assert.deepEqual((await client.sessions.readHistory(session.id, { limit: 1, cursor: older.newerCursor })).items, newest.items);
    const page = await client.sessions.readHistory(session.id);
    await assert.rejects(client.sessions.forkSession(session.id, {
      historyBoundary: page.items.find(item => item.type === 'tool').historyBoundary,
    }), { code: 'invalid_params' });
    const turn = await client.sessions.resolveHistoryTurn(session.id, { kind: 'previous' });
    assert.equal(turn.status, 'ready');
    const fork = await client.sessions.forkSession(session.id, { turn });
    assert.deepEqual((await storage.load(fork.id)).messages[2].content,
      [{ type: 'tool_result', tool_use_id: 'saved-call', content: 'saved result' }]);
    const retry = await client.sessions.forkSession(session.id, { turn, before: true });
    assert.equal((await storage.load(retry.id)).messages.length, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.sessions.readHistory(session.id, { signal: controller.signal }), { code: 'read_cancelled' });
  } finally {
    if (client) {
      const owner = getKodaXRuntimeOwnerState({ homeDir }).owner;
      try { await client.host.shutdown(); } finally { await client.disconnect(); }
      if (owner) assert.equal((await waitForRuntimeDaemonShutdown({ configHome, owner })).status, 'succeeded');
    }
    assert.equal(path.dirname(homeDir), temporary);
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
