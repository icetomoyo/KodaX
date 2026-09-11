// Read-only reconstruction from complete main + islands lineage; bypasses page caches.
import fs from 'node:fs/promises';
import { readSessionCapture } from '../packages/repl/dist/session/public-api.js';
import { buildSessionConversationHistory } from '../packages/repl/dist/session/conversation-history.js';

const sessionId = '20260911_100157_8gbfe22d504b2f';
const destination = process.argv[2] ?? 'scratch/space-sdk-current-projection.json';
const capture = await readSessionCapture(sessionId);
if (!capture?.transcript.lineage) throw new Error('A full read-only lineage capture is required.');
const projection = buildSessionConversationHistory(capture.transcript.lineage, capture.sourceRevision);
const redacted = {
  revision: projection.revision, sourceRevision: projection.sourceRevision, status: projection.status,
  entries: projection.entries.map(({ boundaryId, auditEntryIds, message }) => ({
    boundaryId, auditEntryIds, message: {
      role: message.role, content: '[redacted]', turnId: message.turnId, timestamp: message.timestamp,
    },
  })),
};
await fs.writeFile(destination, JSON.stringify(redacted));
process.stdout.write(JSON.stringify({ status: redacted.status, entries: redacted.entries.length,
  lineageEntries: capture.transcript.lineage.entries.length,
  deliveredAliasFound: redacted.entries.some((entry) => entry.auditEntryIds.includes('entry_fdb4f2769c49')),
}) + '\n');
