import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';

// Read-only forensic replay. Session message bodies never leave this process.
const sourcePath = 'packages/agent/src/session-lineage/kodax-session-lineage.ts';
const source = execFileSync('git', ['show', `1d4a7a7d:${sourcePath}`], { encoding: 'utf8' });
const directory = await mkdtemp(path.resolve('scratch', 'kodax-old-writer-replay-'));
try {
  const outfile = path.join(directory, 'legacy-writer.mjs');
  const isolatedSource = source.replace(/from '(\.\/compaction\/[^']+)\.js'/g,
    (_match, relative) => `from '${pathToFileURL(path.resolve('packages/agent/dist/session-lineage', `${relative}.js`)).href}'`);
  await build({ stdin: { contents: isolatedSource, loader: 'ts' },
    outfile, bundle: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const legacy = await import(pathToFileURL(outfile).href);
  const base = 'C:/Users/ADMIN/.kodax/sessions/c-users-admin-kodax-workspace-b9fab24ed4/20260911_100157_8gbfe22d504b2f';
  const records = new Map();
  for (const filename of [`${base}.islands.jsonl`, `${base}.jsonl`]) {
    for (const line of (await readFile(filename, 'utf8')).split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.entry) records.set(record.entry.id, record.entry);
    }
  }
  const full = { version: 2, entries: [...records.values()], activeEntryId: 'entry_fdb4f2769c49' };
  const beforePath = legacy.getSessionLineagePath(full);
  const afterPath = legacy.getSessionLineagePath(full, 'entry_c49fccdba757');
  let shared = 0;
  while (beforePath[shared]?.id === afterPath[shared]?.id && shared < Math.min(beforePath.length, afterPath.length)) shared += 1;
  const beforeTail = beforePath.slice(shared);
  const afterTail = afterPath.slice(shared);
  assert.equal(afterTail[0].message._source, 'managed-run-context');
  assert.equal(afterTail.length, beforeTail.length + 1);
  const previous = { version: 2, entries: beforePath, activeEntryId: beforePath.at(-1).id };
  const incoming = afterPath.map((entry) => entry.message);
  const replay = legacy.createSessionLineage(incoming, previous);
  const replayPath = legacy.getSessionLineagePath(replay);
  const replayTail = replayPath.slice(shared);
  const branchBase = legacy.setSessionLineageActiveEntry(previous, beforePath[shared - 1].id);
  assert(branchBase);
  // Every incoming message is a fresh object. In particular the final user
  // query has no WeakMap/object provenance from the delivered source entry.
  const independentInput = structuredClone(incoming);
  const deliberateBranch = legacy.createSessionLineage(independentInput, branchBase);
  const branchTail = legacy.getSessionLineagePath(deliberateBranch).slice(shared);
  const normalizedTail = (entries) => entries.map((entry) => ({
    type: entry.type, freshLogicalId: entry.logicalId === entry.id,
    sourceEntryId: entry.sourceEntryId, timestamp: entry.timestamp, message: entry.message,
  }));
  assert.equal(isDeepStrictEqual(normalizedTail(replayTail), normalizedTail(afterTail)), true, 'legacy writer shape differs');
  assert.equal(isDeepStrictEqual(normalizedTail(branchTail), normalizedTail(replayTail)), true, 'branch tail differs');
  const normalizeLineage = (lineage) => {
    const ids = new Map(lineage.entries.map((entry, index) => [entry.id, `physical-${index}`]));
    const normalize = (value) => typeof value === 'string' ? (ids.get(value) ?? value)
      : Array.isArray(value) ? value.map(normalize)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)])) : value;
    return normalize(lineage);
  };
  assert.equal(isDeepStrictEqual(normalizeLineage(deliberateBranch), normalizeLineage(replay)), true, 'complete lineage differs');
  const withoutTurn = ({ turnId, ...message }) => message;
  const fork = legacy.forkSessionLineage(previous);
  const rewind = legacy.rewindSessionLineage(previous, beforePath[shared - 1].id);
  const toolIds = (entries) => entries.flatMap((entry) => Array.isArray(entry.message?.content)
    ? entry.message.content.flatMap((block) => block.type === 'tool_use' ? [{ type: 'use', id: block.id }]
      : block.type === 'tool_result' ? [{ type: 'result', id: block.tool_use_id }] : []) : []);
  const childrenOf = (id) => [...records.values()].filter((entry) => entry.parentId === id);
  const facts = {
    sdkCommit: '1d4a7a7d', sessionId: '20260911_100157_8gbfe22d504b2f',
    sharedEntries: shared, beforeTailEntries: beforeTail.length, afterTailEntries: afterTail.length,
    insertedContextId: afterTail[0].id,
    contentPairsEqual: beforeTail.every((entry, index) => isDeepStrictEqual(entry.message.content, afterTail[index + 1].message.content)),
    turnIdDifferences: beforeTail.filter((entry, index) => entry.message.turnId !== afterTail[index + 1].message.turnId).length,
    nonTurnFieldsEqual: beforeTail.every((entry, index) => isDeepStrictEqual(withoutTurn(entry.message), withoutTurn(afterTail[index + 1].message))),
    exactLegacyWriterShapeReproduced: true,
    deliberateSetActiveThenSaveIndistinguishable: true,
    wholeLineageIncludingParentReferencesEqual: true,
    independentQueryHasNewObjectIdentity: independentInput.at(-1) !== incoming.at(-1),
    publicForkRecordsExplicitProvenance: fork.entries.filter((entry) => entry.type === 'message').every((entry) => entry.sourceEntryId !== undefined),
    publicRewindRecordsMarker: rewind.entries.some((entry) => entry.type === 'rewind_marker'),
    sourceLeafInFullLineage: childrenOf(beforePath.at(-1).id).length === 0,
    targetChildCount: childrenOf(afterPath.at(-1).id).length,
    sourceTailToolUses: toolIds(beforeTail).filter((block) => block.type === 'use').length,
    toolIdPairSequencesEqual: JSON.stringify(toolIds(beforeTail)) === JSON.stringify(toolIds(afterTail)),
    markerContainsRunId: JSON.stringify(afterTail[0].message).includes('run_mtwbz5qa_f2e9922d'),
  };
  process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
  for (const owner of ['run_mtwbz5qa_f2e9922d', '20260911_100157_8gbfe22d504b2f']) {
    const events = (await readFile(`C:/Users/ADMIN/.kodax/runtime/profiles/coder/runs/${owner}/events.jsonl`, 'utf8'))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const lifecycle = events.filter((event) => /compaction|rewound|active_entry|input.delivered|run.started|run.completed/.test(event.type));
    process.stdout.write(`${JSON.stringify({ owner, lifecycle: lifecycle.map((event) => ({
      seq: event.seq, type: event.type, time: event.time,
      ...(event.type === 'run.input.delivered' ? { inputEntryIds: event.payload.inputs?.map((input) => input.entryId) } : {}),
    })) }, null, 2)}\n`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
