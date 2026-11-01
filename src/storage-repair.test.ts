import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { inspectStorageRepair, applyStorageRepair, confirmStorageRepair } from './storage-repair.js';
import { createRuntimeAgentExecutorPlaneStore } from './runtime-agent-store.js';
import { withCoreConfigWriteLock, CoreConfigWriteConflictError } from '../packages/repl/src/common/core-config-lock.js';
import { createExtensionStore, createAgentExecutorPlane } from '@kodax-ai/agent';
import { A2AFileTaskStore } from './a2a/task-store.js';

const recoveryTask = { taskId: 'task', route: 'external', agentId: 'fixture', objective: 'Retain external work',
  state: 'working', cancellation: 'none', idempotencyKey: 'fixture', dispatchAttempt: 1,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  registration: { agentId: 'fixture', origin: 'external', executorId: 'fixture', protocol: 'http', configurationRevision: 'v1',
    capabilities: { streaming: 'unsupported', durableTasks: 'supported', inputRequired: 'unsupported', cancellation: 'unsupported', artifacts: 'unsupported' },
    effects: { remote: 'unknown', workspace: 'none' } } } as const;

it.each([{ registration: {} }, { registration: { ...recoveryTask.registration, capabilities: {} } },
  { registration: { ...recoveryTask.registration, effects: {} } }, { state: 'future-state' }, { cancellation: 'future-cancellation' },
])('rejects an incomplete replacement task before creating a backup, receipt or fence: %j', async patch => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-repair-task-shape-'));
  const directory = path.join(root, 'tasks', createHash('sha256').update('task').digest('hex'));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'snapshot.json'); fs.writeFileSync(file, '{retained-original');
  const candidate = path.join(root, 'candidate.json'), bytes = JSON.stringify({ ...recoveryTask, ...patch });
  fs.writeFileSync(candidate, bytes);
  try {
    const plan = inspectStorageRepair({ kind: 'runtime-agent-snapshot', root, taskId: 'task' });
    await expect(applyStorageRepair(plan, { allWritersStopped: true,
      candidate: { path: candidate, sha256: createHash('sha256').update(bytes).digest('hex') } })).rejects.toThrow(/candidate/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{retained-original');
    expect(fs.readdirSync(directory)).toEqual(['snapshot.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('keeps a fully validated replacement task cancellable after separately verified repair', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-repair-task-cancel-'));
  const directory = path.join(root, 'tasks', createHash('sha256').update('task').digest('hex'));
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'snapshot.json'), '{retained-original');
  const candidate = path.join(root, 'candidate.json'), bytes = JSON.stringify(recoveryTask); fs.writeFileSync(candidate, bytes);
  const store = createRuntimeAgentExecutorPlaneStore(root);
  let plane: Awaited<ReturnType<typeof createAgentExecutorPlane>> | undefined;
  try {
    const plan = inspectStorageRepair({ kind: 'runtime-agent-snapshot', root, taskId: 'task' });
    const receipt = await applyStorageRepair(plan, { allWritersStopped: true,
      candidate: { path: candidate, sha256: createHash('sha256').update(bytes).digest('hex') } });
    await confirmStorageRepair(receipt, { allWritersStopped: true, verifiedCurrentState: true });
    plane = await createAgentExecutorPlane({ factories: [], policy: async () => ({ allowed: true }), store });
    expect(await plane.tasks.cancel('task')).toMatchObject({ state: 'unknown', cancellation: 'unsupported' });
    expect(fs.readFileSync(receipt.backup, 'utf8')).toBe('{retained-original');
  } finally { await plane?.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('repairs a syntax-only ledger tail with a retained backup and persistent unknown-effect fence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-ledger-repair-'));
  const taskId = 'retained-task';
  const directory = path.join(root, 'tasks', createHash('sha256').update(taskId).digest('hex'));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'events.jsonl');
  const prefix = JSON.stringify({ taskId, seq: 1, timestamp: '2026-11-01T00:00:00Z', type: 'state' }) + '\n';
  const broken = prefix + '{"taskId":"retained-task","seq":2';
  fs.writeFileSync(file, broken);
  const writer = createRuntimeAgentExecutorPlaneStore(root, { exclusive: true });
  try {
    const plan = inspectStorageRepair({ kind: 'runtime-agent-ledger', root, taskId });
    expect(plan.diagnosis.state).toBe('invalid-json-tail');
    await expect(applyStorageRepair(plan, { allWritersStopped: true })).rejects.toThrow(/busy|owned/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
    writer.close();
    const receipt = await applyStorageRepair(plan, { allWritersStopped: true });
    expect(fs.readFileSync(receipt.backup, 'utf8')).toBe(broken);
    expect(fs.readFileSync(file, 'utf8')).toBe(prefix);
    await expect(createRuntimeAgentExecutorPlaneStore(root).loadEvents(taskId)).rejects.toThrow(/unknown|reconciliation/i);
    expect(await applyStorageRepair(plan, { allWritersStopped: true })).toEqual(receipt);
  } finally { writer.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('refuses a modified repair plan instead of truncating additional valid ledger records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-ledger-plan-conflict-'));
  const taskId = 'retained-task', directory = path.join(root, 'tasks', createHash('sha256').update(taskId).digest('hex'));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'events.jsonl');
  const original = JSON.stringify({ taskId, seq: 1, timestamp: '2026-11-01T00:00:00Z', type: 'state' }) + '\n{broken';
  fs.writeFileSync(file, original);
  try {
    const plan = inspectStorageRepair({ kind: 'runtime-agent-ledger', root, taskId });
    await expect(applyStorageRepair({ ...plan, diagnosis: { state: 'invalid-json-tail', validPrefixBytes: 0 } },
      { allWritersStopped: true })).rejects.toThrow(/plan|conflict|diagnosis/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('verifies a complete no-LF replacement, resumes append and reopens without corrupting the repaired ledger', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-ledger-repair-append-'));
  const taskId = 'task', directory = path.join(root, 'tasks', createHash('sha256').update(taskId).digest('hex'));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'events.jsonl'); fs.writeFileSync(file, '{invalid-middle}\n{invalid-tail}');
  const candidate = path.join(root, 'candidate.jsonl');
  const first = { taskId, seq: 1, timestamp: '2026-11-01T00:00:00Z', type: 'state' as const };
  const bytes = JSON.stringify(first); fs.writeFileSync(candidate, bytes);
  try {
    const plan = inspectStorageRepair({ kind: 'runtime-agent-ledger', root, taskId });
    const receipt = await applyStorageRepair(plan, { allWritersStopped: true, candidate: {
      path: candidate, sha256: createHash('sha256').update(bytes).digest('hex'),
    } });
    await expect(confirmStorageRepair(receipt, { allWritersStopped: true, verifiedCurrentState: false })).rejects.toThrow(/verif|confirm|reconciliation/i);
    await confirmStorageRepair(receipt, { allWritersStopped: true, verifiedCurrentState: true });
    const writer = createRuntimeAgentExecutorPlaneStore(root, { exclusive: true });
    await writer.appendEvent({ ...first, seq: 2 }); writer.close();
    expect(await createRuntimeAgentExecutorPlaneStore(root).loadEvents(taskId)).toEqual([first, { ...first, seq: 2 }]);
    expect(fs.readFileSync(receipt.backup, 'utf8')).toBe('{invalid-middle}\n{invalid-tail}');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('never exposes candidate or receipt parser excerpts in maintenance errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-repair-redaction-'));
  fs.writeFileSync(path.join(root, 'tasks.json'), '{');
  const candidate = path.join(root, 'candidate.json'), privateValue = 'SYNTHETIC_PRIVATE_CANDIDATE_VALUE';
  fs.writeFileSync(candidate, privateValue);
  const plan = inspectStorageRepair({ kind: 'a2a', root });
  try {
    let failure: unknown;
    try { await applyStorageRepair(plan, { allWritersStopped: true, candidate: { path: candidate, sha256: createHash('sha256').update(privateValue).digest('hex') } }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('SYNTHETIC');
    expect(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).toBe('{');
    fs.writeFileSync(`${plan.file}.repair.${plan.id}.json`, privateValue);
    await expect(applyStorageRepair(plan, { allWritersStopped: true })).rejects.toThrow(/metadata|receipt/i);
    try { await applyStorageRepair(plan, { allWritersStopped: true }); }
    catch (error) { expect(String(error)).not.toContain('SYNTHETIC'); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each([false, true])('holds the real config-generation reclamation barrier, including malformed UTF-8 metadata (%s)', async malformed => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-lock-repair-generation-'));
  const config = path.join(root, 'config.json'), file = `${config}.write.lock`;
  const original = malformed ? Buffer.concat([Buffer.from('{"version":1,"pid":2146999999,"nonce":"fixture-dead-generation","note":"'), Buffer.from([255]), Buffer.from('"}')])
    : Buffer.from(JSON.stringify({ version: 1, pid: 2_146_999_999, nonce: 'fixture-dead-generation' }));
  fs.writeFileSync(file, original);
  const plan = inspectStorageRepair({ kind: 'lock', root, path: file });
  const rename = fs.renameSync;
  let competitorEntered = false;
  const fault = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (from === file) {
      try { withCoreConfigWriteLock(config, () => { competitorEntered = true; }); }
      catch (error) { if (!(error instanceof CoreConfigWriteConflictError)) throw error; }
    }
    rename(from, to);
  });
  try {
    const receipt = await applyStorageRepair(plan, { allWritersStopped: true });
    expect(competitorEntered).toBe(false);
    expect(fs.readFileSync(receipt.backup)).toEqual(original);
  } finally { fault.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

it.each(['extension', 'a2a'] as const)('restores a complete %s candidate and requires explicit verification before normal access', async kind => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-snapshot-recovery-'));
  vi.stubEnv('KODAX_HOME', home);
  const root = kind === 'extension' ? path.join(home, 'extension-store', 'fixture') : path.join(home, 'a2a');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, kind === 'extension' ? 'store.jsonl' : 'tasks.json');
  fs.writeFileSync(file, '{broken');
  const raw = kind === 'extension' ? JSON.stringify({ _type: 'entry', key: 'accountReference', value: 'verified-account', version: 'fixture-version', updatedAt: 1 }) : '[]';
  const candidate = path.join(home, 'recovery.snapshot'); fs.writeFileSync(candidate, raw);
  try {
    const plan = inspectStorageRepair({ kind, root });
    await expect(applyStorageRepair(plan, { allWritersStopped: true })).rejects.toThrow(/complete.*candidate/i);
    const receipt = await applyStorageRepair(plan, { allWritersStopped: true, candidate: { path: candidate, sha256: createHash('sha256').update(raw).digest('hex') } });
    expect(fs.readFileSync(receipt.backup, 'utf8')).toBe('{broken');
    if (kind === 'extension') await expect(createExtensionStore('fixture').get('accountReference')).rejects.toThrow(/unverified|repair/i);
    else expect(() => new A2AFileTaskStore(root)).toThrow(/unverified|repair/i);
    await expect(confirmStorageRepair(receipt, { allWritersStopped: true, verifiedCurrentState: false })).rejects.toThrow(/verified|verification/i);
    const confirmed = await confirmStorageRepair(receipt, { allWritersStopped: true, verifiedCurrentState: true });
    expect(confirmed.verified).toBe(true);
    if (kind === 'extension') expect((await createExtensionStore('fixture').get('accountReference'))?.value).toBe('verified-account');
    else { const store = new A2AFileTaskStore(root); store.close(); }
    expect(fs.readFileSync(receipt.backup, 'utf8')).toBe('{broken');
  } finally { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); }
});

it.each(['config', 'coordination', 'migration', 'sealed', 'claim'] as const)('quarantines only the diagnosed %s lock and preserves all user data', async kind => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-offline-lock-repair-'));
  const relative = kind === 'config' ? 'config.json.write.lock' : kind === 'coordination' ? 'runtime/daemon/default/owner-policy.lock'
    : kind === 'migration' ? 'sessions/.migration-lock' : kind === 'sealed' ? `provider-oauth/${'a'.repeat(64)}.sealed.lock`
      : `config.json.write.lock.reclaim.${'b'.repeat(64)}`;
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (kind === 'migration' || kind === 'sealed') fs.mkdirSync(file);
  else fs.writeFileSync(file, kind === 'claim' ? JSON.stringify({ pid: 2_146_999_999, nonce: 'retired' }) : kind === 'coordination' ? '{' : '');
  const protectedFile = path.join(root, 'auth.json'); fs.writeFileSync(protectedFile, '{"fixture":"retained-credentials"}');
  try {
    const plan = inspectStorageRepair({ kind: 'lock', root, path: file });
    await expect(applyStorageRepair(plan, { allWritersStopped: false })).rejects.toThrow(/stopped/i);
    const receipt = await applyStorageRepair(plan, { allWritersStopped: true });
    expect(fs.existsSync(file)).toBe(false); expect(fs.existsSync(receipt.backup)).toBe(true);
    expect(fs.readFileSync(protectedFile, 'utf8')).toBe('{"fixture":"retained-credentials"}');
    expect(await applyStorageRepair(plan, { allWritersStopped: true })).toEqual(receipt);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each(['live', 'changed', 'session-writer', 'proper-lockfile'] as const)('refuses unsafe %s lock quarantine', async kind => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-lock-quarantine-refused-'));
  const file = path.join(root, kind === 'session-writer' ? `sessions/.write-locks/${'a'.repeat(64)}.lock` : kind === 'proper-lockfile' ? 'auth.json.lock' : 'config.json.write.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = kind === 'live' ? JSON.stringify({ version: 1, pid: process.pid, nonce: 'active' }) : '';
  fs.writeFileSync(file, raw);
  try {
    const plan = inspectStorageRepair({ kind: 'lock', root, path: file });
    if (kind === 'changed') fs.writeFileSync(file, 'replacement-generation');
    await expect(applyStorageRepair(plan, { allWritersStopped: true })).rejects.toThrow(/live|conflict|changed|unsupported|protocol/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(kind === 'changed' ? 'replacement-generation' : raw);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('resumes a completed quarantine after receipt publication failed without moving a new owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-quarantine-resume-'));
  const file = path.join(root, 'config.json.write.lock'); fs.writeFileSync(file, '');
  const plan = inspectStorageRepair({ kind: 'lock', root, path: file });
  const receiptFile = `${file}.repair.${plan.id}.json`, rename = fs.renameSync;
  let writes = 0;
  const fault = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === receiptFile && ++writes === 2) throw new Error('fixture receipt publication failed');
    rename(from, to);
  });
  try {
    await expect(applyStorageRepair(plan, { allWritersStopped: true })).rejects.toThrow('fixture receipt publication failed');
    fault.mockRestore();
    const current = JSON.stringify({ version: 1, pid: process.pid, nonce: 'new-owner' }); fs.writeFileSync(file, current);
    const receipt = await applyStorageRepair(plan, { allWritersStopped: true });
    expect(receipt.completed).toBe(true); expect(fs.readFileSync(receipt.backup, 'utf8')).toBe('');
    expect(fs.readFileSync(file, 'utf8')).toBe(current);
  } finally { fault.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});
