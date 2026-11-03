import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { inspectStorageRepair, inspectStorageRepairCandidate, applyStorageRepair, confirmStorageRepair } from '../dist/sdk-runtime.js';
import { tryAcquireStorageFileLock } from '../dist/sdk-agent.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/kodax_cli.js', import.meta.url));
// Storage repair refuses filesystem aliases; macOS temporary roots sit under
// the /var symbolic link, so fixtures must use the canonical base.
const canonicalTemporaryRoot = await realpath(os.tmpdir());

test('published task repair rejects missing captured authority before publishing a replacement', async () => {
  const root = await mkdtemp(path.join(canonicalTemporaryRoot, 'kodax-bundled-repair-task-'));
  const directory = path.join(root, 'tasks', createHash('sha256').update('task').digest('hex'));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'snapshot.json'), candidate = path.join(root, 'candidate.json');
  const original = '{retained-original'; await writeFile(file, original);
  const task = { taskId: 'task', route: 'external', agentId: 'fixture', objective: 'Retain work', state: 'working', cancellation: 'none',
    registration: {}, idempotencyKey: 'fixture', dispatchAttempt: 1, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
  try {
    const plan = inspectStorageRepair({ kind: 'runtime-agent-snapshot', root, taskId: 'task' });
    await writeFile(candidate, JSON.stringify(task));
    await assert.rejects(applyStorageRepair(plan, { allWritersStopped: true, candidate: inspectStorageRepairCandidate(candidate) }), /candidate/);
    assert.equal(await readFile(file, 'utf8'), original);
    await assert.rejects(stat(path.join(directory, '.repair-fence')), { code: 'ENOENT' });
    task.registration = { agentId: 'fixture', origin: 'external', executorId: 'fixture', protocol: 'http', configurationRevision: 'v1',
      capabilities: { streaming: 'unsupported', durableTasks: 'supported', inputRequired: 'unsupported', cancellation: 'unsupported', artifacts: 'unsupported' },
      effects: { remote: 'unknown', workspace: 'none' } };
    await writeFile(candidate, JSON.stringify(task));
    const receipt = await applyStorageRepair(plan, { allWritersStopped: true, candidate: inspectStorageRepairCandidate(candidate) });
    assert.ok(await stat(receipt.fence));
    await confirmStorageRepair(receipt, { allWritersStopped: true, verifiedCurrentState: true });
    assert.equal(inspectStorageRepair(plan.target).diagnosis.state, 'valid');
    assert.equal(await readFile(receipt.backup, 'utf8'), original);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), canonicalTemporaryRoot);
    assert.ok(path.basename(root).startsWith('kodax-bundled-repair-task-'));
    await rm(root, { recursive: true, force: true });
  }
});
test('published CLI maintenance keeps backups, excludes a real writer and requires explicit verification', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(path.join(canonicalTemporaryRoot, 'kodax-bundle-storage-repair-'));
  let lease;
  try {
    const root = path.join(home, 'agents'), taskId = 'retained';
    const directory = path.join(root, 'tasks', createHash('sha256').update(taskId).digest('hex'));
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'events.jsonl'), original = '{bad middle}\n{bad tail}';
    await writeFile(file, original);
    const candidate = path.join(home, 'candidate.jsonl');
    const event = JSON.stringify({ taskId, seq: 1, timestamp: '2026-11-01T00:00:00Z', type: 'state' });
    await writeFile(candidate, event);
    const plan = inspectStorageRepair({ kind: 'runtime-agent-ledger', root, taskId });
    const request = path.join(home, 'plan.json'); await writeFile(request, JSON.stringify(plan));
    const run = args => execute(process.execPath, [cli, ...args], { cwd: home, windowsHide: true, timeout: 10_000,
      env: { ...process.env, KODAX_HOME: path.join(home, '.kodax'), FORCE_COLOR: '0', KODAX_TRACING: '0' } });
    const repair = ['doctor', '--repair-storage', request, '--repair-candidate', candidate, '--writers-stopped'];
    lease = tryAcquireStorageFileLock(path.join(root, '.store.lock'));
    assert.ok(lease);
    await assert.rejects(run(repair), /busy|owned|lock/i);
    assert.equal(await readFile(file, 'utf8'), original);
    lease.release(); lease = undefined;
    const receipt = JSON.parse((await run(repair)).stdout);
    assert.equal(await readFile(receipt.backup, 'utf8'), original);
    assert.equal(await readFile(file, 'utf8'), event);
    const receiptFile = path.join(home, 'receipt.json'); await writeFile(receiptFile, JSON.stringify(receipt));
    await assert.rejects(run(['doctor', '--verify-storage', receiptFile, '--writers-stopped']), /verification|verified/i);
    assert.ok(await stat(receipt.fence));
    const confirmed = JSON.parse((await run(['doctor', '--verify-storage', receiptFile, '--writers-stopped', '--verified-current-state'])).stdout);
    assert.equal(confirmed.verified, true);
    await assert.rejects(stat(receipt.fence), { code: 'ENOENT' });
    assert.equal(await readFile(receipt.backup, 'utf8'), original);
    assert.equal(inspectStorageRepair(plan.target).diagnosis.state, 'valid');
  } finally {
    lease?.release();
    assert.equal(path.dirname(path.resolve(home)), canonicalTemporaryRoot);
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Node command components ship without becoming eager CLI imports', async () => {
  const source = await readFile(cli, 'utf8');
  for (const component of ['provider-auth-cli', 'storage-repair-cli', 'kodax_doctor', 'one-shot-task']) {
    assert.ok((await stat(new URL(`../dist/${component}.js`, import.meta.url))).isFile());
    assert.doesNotMatch(source, new RegExp(`import\\s*(?:\\{[^}]*\\}|\\*[^;]*)from["']\\./${component}\\.js["']`));
  }
});
