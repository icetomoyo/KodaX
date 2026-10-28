import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureKodaXClient } from '../dist/sdk-client.js';
import { FileSessionStorage } from '../dist/sdk-repl.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const tasks = items => items.filter(item => item.taskResult);
async function readAll(read) {
  let body = '', offset = 0;
  for (;;) {
    const chunk = await read(offset);
    assert.ok(chunk);
    body += chunk.text;
    if (chunk.nextOffset === undefined) return body;
    offset = chunk.nextOffset;
  }
}

test('built Product SDK preserves task reports through independent daemon IPC and restart', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-bundled-task-results-'));
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, '.kodax/sessions'), configHome: path.join(root, '.kodax'), cwd: root });
  const bodies = ['\n# Failed child\n```xml\n<tag value="&amp; literal"/>\n```\n' + '图文🙂'.repeat(40_000), '# Same report', '# Same report', 'failed: prose alone'];
  const metadata = ['failed', 'cancelled', 'completed'].map((status, index) => ({ type: 'task_result',
    source: index === 2 ? 'workflow' : 'child_task', taskId: `task-${index}`, status, summary: bodies[index],
    ...(index === 2 ? { runId: 'workflow-run' } : {}) }));
  const envelope = index => `<agent-completed turn_id="task-${index}" state="${metadata[index].status}">\n${xml(bodies[index])}\n</agent-completed>`;
  const messages = [{ role: 'user', content: 'Saved task reports.' },
    { role: 'user', _synthetic: true, _source: 'agent-completed', content: envelope(0), _taskResult: metadata[0] },
    { role: 'user', _synthetic: true, _source: 'agent-completed', content: envelope(1) + '\n' + envelope(2), _taskResults: metadata.slice(1) },
    { role: 'user', _synthetic: true, _source: 'task-completed', content: `<task-completed task_id="legacy">${bodies[3]}</task-completed>` }];
  let client;
  try {
    await storage.save('reports', { title: 'Reports', gitRoot: root, scope: 'user', messages,
      uiHistory: [{ type: 'info', text: envelope(0), presentationOnly: true }] });
    let identities;
    for (let restart = 0; restart < 2; restart++) {
      client = await ensureKodaXClient({ homeDir: root, daemonStartupTimeoutMs: 60_000 });
      let receive;
      const snapshot = new Promise(resolve => { receive = resolve; });
      const observation = await client.sessions.observe('reports', receive);
      try {
        const view = tasks((await snapshot).items);
        assert.equal(view.length, 4);
        assert.deepEqual(view.map(item => item.taskResult.status), ['failed', 'cancelled', 'completed', 'unknown']);
        if (identities) assert.deepEqual(view.map(item => item.id), identities);
        else identities = view.map(item => item.id);
        const page = await client.sessions.readHistory('reports', { limit: 20 });
        const history = tasks(page.items);
        assert.deepEqual(history.map(item => item.taskResult), view.map(item => item.taskResult));
        for (let index = 0; index < 4; index++) {
          assert.equal(hash(await readAll(offset => client.sessions.readHistoryEntry('reports', history[index].id, { offset }))), hash(bodies[index]));
          assert.equal(hash(await readAll(offset => client.sessions.readItem('reports', view[index].id, { offset }))), hash(bodies[index]));
        }
      } finally { observation.close(); }
      await client.host.shutdown();
      await client.disconnect();
      client = undefined;
    }
  } finally {
    try { if (client) await client.host.shutdown(); }
    finally {
      await client?.disconnect();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
