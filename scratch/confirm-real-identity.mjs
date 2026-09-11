import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createSessionManager, exportSessionBundle } from '../dist/sdk-repl.js';
import { createKodaXRuntime } from '../dist/sdk-runtime.js';

const kodax = 'C:/Users/ADMIN/.kodax';
const sessionsDir = path.join(kodax, 'sessions');
assert.equal(JSON.parse(await fs.readFile(path.join(sessionsDir, '.layout.json'), 'utf8')).version, 3, 'Session layout must already be migrated.');
const sessionId = '20260911_100157_8gbfe22d504b2f';
const runId = 'run_mtwbz5qa_f2e9922d';
const sourceEntryId = 'entry_fdb4f2769c49';
const targetEntryId = 'entry_c49fccdba757';
const journalPath = path.join(kodax, 'runtime/profiles/coder/runs', runId, 'events.jsonl');
const manager = createSessionManager({ sessionsDir });
const capture = await manager.readSessionCapture(sessionId);
assert(capture?.transcript.lineage);
assert(!capture.data.actorSnapshot?.owner, 'An owned session must be repaired by its existing Runtime.');
assert(!capture.data.actorSnapshot?.turns.some((turn) => ['accepted', 'running'].includes(turn.state)));
const before = await manager.readConversationHistory(sessionId);
assert.equal(before.status, 'resolved');
assert.equal(before.sourceRevision, capture.sourceRevision);
assert(!before.entries.some((entry) => entry.auditEntryIds.includes(sourceEntryId)));
const target = before.entries.filter((entry) => entry.auditEntryIds.includes(targetEntryId));
assert.equal(target.length, 1);
assert(target[0].auditEntryIds.includes('entry_b04c17ada4dc'));
const originalJournal = await fs.readFile(journalPath);
const events = originalJournal.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const matches = events.filter((event) => event.id === 'evt_7556_b9d48627');
assert.equal(matches.length, 1);
const event = matches[0];
assert.equal(event.type, 'run.input.delivered');
assert.equal(event.sessionId, sessionId);
assert.equal(event.runId, runId);
assert.equal(event.seq, 7556);
const deliveries = event.payload.inputs.filter((input) => input.inputId === 'input_mtwc19u7_a43e70f0');
assert.equal(deliveries.length, 1);
assert.equal(deliveries[0].entryId, sourceEntryId);
assert.equal(deliveries[0].afterRunId, runId);
const bundle = await exportSessionBundle(sessionId, { sessionsDir });
assert.equal(bundle.status, 'ok');
const originalFiles = await Promise.all(bundle.files.map(async (file) => ({ ...file, bytes: await fs.readFile(file.path) })));
const main = originalFiles.find((file) => file.kind === 'main');
assert(main);
if (process.argv.includes('--check-only')) {
  process.stdout.write(JSON.stringify({ checked: true, sessionId, entries: before.entries.length, sourceEntryId, targetEntryId, files: originalFiles.length, deliverySeq: event.seq }) + '\n');
  process.exit(0);
}
const backup = path.join(kodax, 'backups', `identity-repair-${sessionId}-${Date.now()}`);
await fs.mkdir(backup, { recursive: true });
for (const file of originalFiles) await fs.writeFile(path.join(backup, path.basename(file.path)), file.bytes, { flag: 'wx' });
await fs.writeFile(path.join(backup, `${runId}.events.jsonl`), originalJournal, { flag: 'wx' });
for (const file of originalFiles) assert.deepEqual(await fs.readFile(file.path), file.bytes, 'Source changed during backup.');
assert.deepEqual(await fs.readFile(journalPath), originalJournal, 'Delivery journal changed during backup.');
const input = { sourceEntryId, targetEntryId, expectedSourceRevision: capture.sourceRevision,
  confirmationReference: 'User-confirmed legacy writer mapping; KodaX SDK repair validated with isolated session and Space replay on 2026-09-11.',
  deliveryWitness: { runId, inputId: deliveries[0].inputId, eventId: event.id, seq: event.seq,
    eventDigest: `sha256:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}` } };
const record = await manager.storage.confirmIdentityAlias(sessionId, input);
const registeredBytes = await fs.readFile(main.path);
assert.deepEqual(registeredBytes.subarray(0, main.bytes.length), main.bytes);
assert.deepEqual(await manager.storage.confirmIdentityAlias(sessionId, input), record);
assert.deepEqual(await fs.readFile(main.path), registeredBytes);
for (const file of originalFiles.filter((file) => file.kind !== 'main')) assert.deepEqual(await fs.readFile(file.path), file.bytes);
assert.deepEqual(await fs.readFile(journalPath), originalJournal);
// A separate read-only Runtime home avoids touching any existing run/profile state.
const readHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-identity-read-'));
let runtime = await createKodaXRuntime({ homeDir: readHome, sessionsDir });
try {
  const after = await runtime.sessions.conversation(sessionId);
  assert.equal(after.entries.length, before.entries.length);
  assert.equal(after.status, 'resolved');
  const index = after.entries.findIndex((entry) => entry.auditEntryIds.includes(sourceEntryId));
  assert.equal(index, before.entries.findIndex((entry) => entry.auditEntryIds.includes(targetEntryId)));
  assert.deepEqual(after.entries.map(({ auditEntryIds, ...entry }) => entry), before.entries.map(({ auditEntryIds, ...entry }) => entry));
  let cursor;
  let aliasCount = 0;
  let pages = 0;
  do {
    const page = await runtime.sessions.conversationPage({ sessionId, cursor, limit: 37 });
    assert(page);
    aliasCount += page.entries.filter((item) => item.entry?.auditEntryIds.includes(sourceEntryId)).length;
    cursor = page.nextCursor;
    assert(++pages < 100);
  } while (cursor);
  assert.equal(aliasCount, 1);
  await runtime.close();
  runtime = await createKodaXRuntime({ homeDir: readHome, sessionsDir });
  const restarted = await runtime.sessions.conversation(sessionId);
  assert.deepEqual(restarted.entries, after.entries);
  assert.deepEqual(await fs.readFile(main.path), registeredBytes);
  assert.deepEqual(await fs.readFile(journalPath), originalJournal);
  const projection = { ...restarted, entries: restarted.entries.map(({ boundaryId, auditEntryIds, message }) => ({
    boundaryId, auditEntryIds, message: { role: message.role, content: '[redacted]', turnId: message.turnId, timestamp: message.timestamp } })) };
  await fs.writeFile('scratch/real-identity-projection-after.json', JSON.stringify(projection));
  process.stdout.write(JSON.stringify({ backup, receiptId: record.id, entries: after.entries.length, index, pages, journalUnchanged: true }) + '\n');
} finally {
  await runtime.close();
  assert(path.resolve(readHome).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(readHome, { recursive: true, force: true });
}
