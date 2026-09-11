// Offline cross-repository probe. Reads SDK projection + the unchanged delivery journal.
// Bundle with esbuild; never mutates Space source or the user's session files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { composeMessages } from '../../KodaX-Space/apps/desktop/renderer/src/features/session/composeMessages.js';
import { useAppStore } from '../../KodaX-Space/apps/desktop/renderer/src/store/appStore.js';

interface Entry {
  boundaryId?: string;
  auditEntryIds: string[];
  message: { role: string; content: unknown; turnId?: string; timestamp?: string };
}
interface Projection { entries: Entry[]; status: string; sourceRevision: string; revision: string }
const [projectionPath, mode = 'live-history', journalPath] = process.argv.slice(2);
assert(projectionPath && journalPath, 'Usage: <projection.json> <live-history|late-delivery|cold|repeat-delivery> <journal.jsonl>');
assert(['live-history', 'late-delivery', 'cold', 'repeat-delivery'].includes(mode));
const projection: Projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
const journal = fs.readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const delivery = journal.find((event) => event.type === 'run.input.delivered'
  && event.payload?.inputs?.some((input: { inputId?: string }) => input.inputId === 'input_mtwc19u7_a43e70f0'));
assert(delivery, 'The original durable delivery event is required.');
const input = delivery.payload.inputs.find((item: { inputId?: string }) => item.inputId === 'input_mtwc19u7_a43e70f0');
assert.equal(input.entryId, 'entry_fdb4f2769c49', 'Never rewrite the old delivery identity.');
const matches = (entry: Entry, id: string) => entry.boundaryId === id || entry.auditEntryIds.includes(id);
const query = projection.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
  entry.message.role === 'user' && (matches(entry, input.entryId) || matches(entry, 'entry_c49fccdba757')));
assert.equal(query.length, 1, 'Exactly one canonical query must own the known source identities.');
const answer = projection.entries.map((entry, index) => ({ entry, index })).find(({ entry }) =>
  entry.message.role === 'assistant' && matches(entry, 'entry_b45508931984'));
assert(answer, 'The known final-answer entry must survive projection.');
assert(query[0]!.index < answer.index);

// Execute Space's real pure identity projector without importing its Electron host singleton.
// Boundary calculation is deliberately given an empty list; this probe needs only identity fields.
const sourcePath = path.resolve('../KodaX-Space/apps/desktop/electron/ipc/session.ts');
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const ast = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
const names = new Set(['conversationHistoryAsTranscript', 'conversationTurnBoundaries',
  'isVisibleConversationUserMessage', 'isRecord', 'boundedAuditEntryIds', 'stringField']);
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && node.name !== undefined && names.has(node.name.text)).map((node) => node.getText(ast));
assert.equal(functions.length, names.size, 'Space projector source changed; review the probe seam.');
const code = ts.transpileModule(functions.join('\n'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox = { exports: {} as Record<string, (...args: unknown[]) => {
  transcriptEntries: Array<{ entryId?: string; auditEntryIds?: string[]; canonicalIndex: number; turnId?: string }>;
}> };
vm.runInNewContext(code, sandbox, { filename: sourcePath });
const selected = [query[0]!, answer].map(({ entry, index }) => ({ index, entry: {
  ...entry, message: { ...entry.message, content: entry.message.role === 'user' ? 'ffmpeg query' : 'three animated clips answer' },
} }));
const transcript = sandbox.exports.conversationHistoryAsTranscript!(projection, selected, [], false).transcriptEntries;
const sid = 'sdk-space-replay';
const runtimeId = 'rt-repro';
const timestamp = Date.parse(delivery.time);
const origin = (seq: number) => ({ runtimeId, runId: delivery.runId, journalEpoch: 'original-journal', seq });
useAppStore.setState({ sessions: [{ sessionId: sid, projectRoot: '/repro', provider: 'mock',
  reasoningMode: 'auto', permissionMode: 'accept-edits', agentMode: 'ama', surface: 'code',
  createdAt: timestamp - 1000, lastActivityAt: timestamp }], currentSessionId: sid });
const store = useAppStore.getState();
const appendDelivery = () => store.appendEvent({ kind: 'mid_turn_user_prompt', sessionId: sid,
  content: 'ffmpeg query', queueId: input.inputId, entryId: input.entryId, turnId: delivery.turnId,
  turnUserOrdinal: 0, sentAt: timestamp, runtimeEvent: origin(delivery.seq) });
if (mode === 'live-history' || mode === 'repeat-delivery') {
  appendDelivery();
  store.appendEvent({ kind: 'text_delta', sessionId: sid, turnId: delivery.turnId,
    text: 'three animated clips answer', runtimeEvent: origin(11320) });
  store.appendEvent({ kind: 'session_complete', sessionId: sid, turnId: delivery.turnId,
    runtimeEvent: origin(11324) });
}
store.prependSessionHistory(sid, [
  { ...transcript[0]!, kind: 'user', content: 'ffmpeg query', turnId: delivery.turnId,
    turnUserOrdinal: 0, sentAt: Date.parse(query[0]!.entry.message.timestamp ?? delivery.time) },
  { ...transcript[1]!, kind: 'assistant', text: 'three animated clips answer', turnId: delivery.turnId,
    sentAt: Date.parse(answer.entry.message.timestamp ?? delivery.time) },
], timestamp - 1000, { replaceLoadedWindow: true, authoritativeNewest: true,
  conversationStatus: projection.status, sourceRevision: projection.sourceRevision,
  settledRuntimeRuns: [{ runtimeId, runId: delivery.runId, generation: 1 }] });
if (mode === 'late-delivery' || mode === 'repeat-delivery') appendDelivery();
const state = useAppStore.getState();
const rendered = composeMessages({ events: state.eventsBySession[sid] ?? [],
  userMessages: state.userMessagesBySession[sid] ?? [] }).flatMap((message) =>
  message.kind === 'user' ? ['Q'] : message.kind === 'assistant_text' ? ['A'] : []);
process.stdout.write(JSON.stringify({ mode, rendered, canonicalIndex: query[0]!.index,
  boundaryId: query[0]!.entry.boundaryId, auditEntryIds: query[0]!.entry.auditEntryIds,
  deliveredEntryId: input.entryId, deliverySeq: delivery.seq }) + '\n');
assert.deepEqual(rendered, ['Q', 'A'], 'Old journal delivery and SDK projection must render Q,A exactly once.');
