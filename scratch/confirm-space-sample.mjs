// Confirm ONLY an isolated copy under this checkout's scratch directory.
// The real user archive is intentionally not an accepted input to this regression runner.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createKodaXRuntime } from '../dist/sdk-runtime.js';

const sample = await fs.realpath(process.argv[2] ?? '');
const allowed = await fs.realpath('scratch');
assert(sample.startsWith(allowed + path.sep), 'Only a scratch directory copy may be confirmed.');
const sessionId = '20260911_100157_8gbfe22d504b2f';
const runId = 'run_mtwbz5qa_f2e9922d';
const sourceEntryId = 'entry_fdb4f2769c49';
const targetEntryId = 'entry_c49fccdba757';
const options = { homeDir: sample, profile: 'coder', sharedDaemonHost: true, sessionsDir: path.join(sample, 'sessions') };
const journalPath = path.join(sample, '.kodax/runtime/profiles/coder/runs', runId, 'events.jsonl');
const journalDigest = () => fs.readFile(journalPath).then((bytes) => createHash('sha256').update(bytes).digest('hex'));
const originalJournalDigest = await journalDigest();
const output = (history) => ({ revision: history.revision, sourceRevision: history.sourceRevision,
  status: history.status, entries: history.entries.map(({ boundaryId, auditEntryIds, message }) => ({
    boundaryId, auditEntryIds, message: { role: message.role, content: '[redacted]',
      turnId: message.turnId, timestamp: message.timestamp },
  })) });
let runtime = await createKodaXRuntime(options);
try {
  const before = await runtime.sessions.conversation(sessionId);
  await fs.writeFile(path.join(sample, 'projection-before.json'), JSON.stringify(output(before)));
  assert(!before.entries.some((entry) => entry.auditEntryIds.includes(sourceEntryId)), 'Use an unconfirmed sample copy.');
  const input = { sessionId, sourceEntryId, targetEntryId,
    expectedSourceRevision: before.sourceRevision,
    confirmationReference: 'isolated-regression:sample-delivery-to-canonical-query',
    delivery: { runId, inputId: 'input_mtwc19u7_a43e70f0', eventId: 'evt_7556_b9d48627' },
  };
  let record;
  let reloadedAfterClaim = false;
  try { record = await runtime.sessions.confirmIdentityAlias(input); }
  catch (error) {
    if (error?.code !== 'data_changed') throw error;
    const refreshed = await runtime.sessions.conversation(sessionId);
    assert.deepEqual(refreshed.entries, before.entries, 'Reload must retain exactly the reviewed canonical history.');
    assert.equal(refreshed.status, before.status);
    assert.notEqual(refreshed.sourceRevision, before.sourceRevision);
    reloadedAfterClaim = true;
    record = await runtime.sessions.confirmIdentityAlias({ ...input, expectedSourceRevision: refreshed.sourceRevision });
  }
  const after = await runtime.sessions.conversation(sessionId);
  assert.equal(after.entries.length, before.entries.length, 'Confirmation must not alter canonical message count.');
  const query = after.entries.filter((entry) => entry.auditEntryIds.includes(sourceEntryId));
  assert.equal(query.length, 1);
  assert(query[0].auditEntryIds.includes(targetEntryId));
  assert(query[0].auditEntryIds.includes('entry_b04c17ada4dc'));
  await runtime.close();
  runtime = await createKodaXRuntime(options);
  const restarted = await runtime.sessions.conversation(sessionId);
  assert.deepEqual(restarted.entries, after.entries, 'Restart must retain exactly the same projection.');
  let cursor;
  let pageCount = 0;
  let pagedAliases = 0;
  do {
    const page = await runtime.sessions.conversationPage({ sessionId, cursor, limit: 37 });
    assert(page);
    pagedAliases += page.entries.filter((item) => item.entry?.auditEntryIds.includes(sourceEntryId)).length;
    cursor = page.nextCursor;
    pageCount += 1;
    assert(pageCount < 100, 'Pagination must advance.');
  } while (cursor);
  assert.equal(pagedAliases, 1, 'Paged history must resolve the delivery exactly once.');
  const entryIndex = restarted.entries.findIndex((entry) => entry.auditEntryIds.includes(sourceEntryId));
  const chunk = await runtime.sessions.conversationEntryChunk({ sessionId, revision: restarted.revision, entryIndex });
  assert(chunk);
  const chunkEntry = JSON.parse(Buffer.from(chunk.data, 'base64').toString('utf8'));
  assert(chunkEntry.auditEntryIds.includes(sourceEntryId));
  assert.equal(await journalDigest(), originalJournalDigest, 'The original delivery journal must stay byte-identical.');
  await fs.writeFile(path.join(sample, 'projection-after.json'), JSON.stringify(output(restarted)));
  process.stdout.write(JSON.stringify({ receiptId: record.id, status: restarted.status,
    entries: restarted.entries.length, auditEntryIds: query[0].auditEntryIds,
    restarted: true, reloadedAfterClaim, pageCount, journalUnchanged: true }) + '\n');
} finally { await runtime.close(); }
