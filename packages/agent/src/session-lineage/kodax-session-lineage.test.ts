import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';
import type { KodaXSessionLineage, KodaXSessionMessageEntry } from '../index.js';
import {
  COMPACTED_HISTORY_RECOVERY_GUIDANCE,
  COMPACTION_SUMMARY_PREFIX,
} from './compaction/compaction.js';
import {
  appendSessionLineageLabel,
  applyLineageTruncation,
  applySessionCompaction,
  archiveOldIslands,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  evictOldIslandMessageContent,
  findPreviousUserEntryId,
  forkSessionLineage,
  getSessionMessageEntryId,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
  resolveSessionLineageTarget,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from './kodax-session-lineage.js';

function createTextMessage(role: KodaXMessage['role'], content: string): KodaXMessage {
  return { role, content };
}

function messageEntries(lineage: KodaXSessionLineage): KodaXSessionMessageEntry[] {
  return lineage.entries.filter((entry): entry is KodaXSessionMessageEntry => entry.type === 'message');
}

function legacyPollutedLineageFixture(): KodaXSessionLineage {
  const assistant: KodaXMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'inspect the old Session', signature: 'sig-old' },
      { type: 'text', text: 'I will inspect it.' },
      { type: 'tool_use', id: 'tool-old', name: 'read', input: { path: 'old.ts' } },
    ],
  };
  const toolResult: KodaXMessage = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool-old', content: 'old result' }],
  };
  const entry = (
    id: string,
    parentId: string | null,
    message: KodaXMessage,
  ): KodaXSessionMessageEntry => ({
    type: 'message',
    id,
    parentId,
    logicalId: id,
    timestamp: '2026-07-29T00:00:00.000Z',
    message,
  });
  const root = entry('entry_legacy_root', null, createTextMessage('user', 'original query'));
  const activeAssistant = entry('entry_legacy_active_assistant', root.id, assistant);
  const activeToolResult = entry('entry_legacy_active_result', activeAssistant.id, toolResult);
  const activeFollowup = entry(
    'entry_legacy_active_followup',
    activeToolResult.id,
    createTextMessage('user', 'follow-up'),
  );
  const activeResponse = entry(
    'entry_legacy_active_response',
    activeFollowup.id,
    createTextMessage('assistant', 'follow-up answer'),
  );
  const replayAssistant = entry('entry_legacy_replay_assistant', root.id, assistant);
  const replayCarrier = entry(
    'entry_legacy_compaction_context',
    replayAssistant.id,
    {
      role: 'system',
      content: '[Post-compact: legacy context carrier]',
      _synthetic: true,
      _source: 'compaction-context',
    },
  );
  return JSON.parse(JSON.stringify({
    version: 2,
    activeEntryId: activeResponse.id,
    // v0.7.78 could leave a later same-content replay sibling whose physical
    // compaction-context child diverted content-based reconciliation away from
    // the actual active path after a JSON round-trip.
    entries: [
      root,
      activeAssistant,
      activeToolResult,
      activeFollowup,
      activeResponse,
      replayAssistant,
      replayCarrier,
    ],
  })) as KodaXSessionLineage;
}

describe('session lineage helpers', () => {
  it('exposes the exact physical entry created for a message reference', () => {
    const message = createTextMessage('user', 'durable interrupt');
    const lineage = createSessionLineage([message]);

    expect(getSessionMessageEntryId(message)).toBe(lineage.activeEntryId);
  });

  it('does not choose an ordinal entry when one message reference has ambiguous provenance', () => {
    const message = createTextMessage('user', 'reused reference');
    createSessionLineage([message]);
    createSessionLineage([message]);

    expect(getSessionMessageEntryId(message)).toBeUndefined();
  });

  it('creates an empty lineage for empty message lists', () => {
    const lineage = createSessionLineage([]);

    expect(lineage.activeEntryId).toBeNull();
    expect(lineage.entries).toEqual([]);
    expect(getSessionLineagePath(lineage)).toEqual([]);
    expect(getSessionMessagesFromLineage(lineage)).toEqual([]);
    expect(countActiveLineageMessages(lineage)).toBe(0);
  });

  it('prefers message.timestamp for the entry timestamp (no batch collapse)', () => {
    const lineage = createSessionLineage([
      { role: 'user', content: 'hi', timestamp: '2020-01-02T03:04:05.000Z' },
    ]);
    const entry = lineage.entries.find((e) => e.type === 'message');
    expect(entry?.timestamp).toBe('2020-01-02T03:04:05.000Z');
  });

  it('falls back to a valid accounting-time timestamp when the message has none (backward compat)', () => {
    const lineage = createSessionLineage([{ role: 'user', content: 'hi' }]);
    const entry = lineage.entries.find((e) => e.type === 'message');
    expect(typeof entry?.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(entry!.timestamp))).toBe(false);
  });

  it('does NOT collapse a multi-message batch to one time (GOAL 2 core): each entry keeps its own message.timestamp', () => {
    // A whole managed task is accounted in ONE synchronous createSessionLineage
    // call; before the fix every entry got the same `new Date()` millisecond.
    const lineage = createSessionLineage([
      { role: 'user', content: 'q', timestamp: '2020-01-01T10:00:00.000Z' },
      { role: 'assistant', content: 'a', timestamp: '2020-01-01T10:05:00.000Z' },
    ]);
    const stamps = lineage.entries
      .filter((e) => e.type === 'message')
      .map((e) => e.timestamp);
    expect(stamps).toEqual(['2020-01-01T10:00:00.000Z', '2020-01-01T10:05:00.000Z']);
  });

  it('resume dedup ignores timestamp: same content + different timestamp reuses the entry (no duplicate)', () => {
    const first = createSessionLineage([
      { role: 'user', content: 'q', timestamp: '2020-01-01T00:00:00.000Z' },
    ]);
    const before = first.entries.filter((e) => e.type === 'message').length;
    // Re-account the SAME logical message with a DIFFERENT timestamp, as a fresh
    // object (so the reference-equality fast path does not apply). The fingerprint
    // is role:synthetic:content and must ignore timestamp — else resume would
    // duplicate the whole conversation every reload.
    const second = createSessionLineage(
      [{ role: 'user', content: 'q', timestamp: '2099-12-31T23:59:59.000Z' }],
      first,
    );
    const after = second.entries.filter((e) => e.type === 'message').length;
    expect(after).toBe(before);
  });

  it('upgrades a v0.7.78 polluted active context without replaying historical entries', () => {
    const legacy = legacyPollutedLineageFixture();
    const activeMessages = getSessionMessagesFromLineage(legacy);
    const beforeIds = legacy.entries.map((entry) => entry.id);

    const reconciled = createSessionLineage(structuredClone(activeMessages), legacy);

    expect(reconciled.entries.map((entry) => entry.id)).toEqual(beforeIds);
    expect(reconciled.activeEntryId).toBe(legacy.activeEntryId);
    expect(getSessionMessagesFromLineage(reconciled)).toEqual(activeMessages);
  });

  it('adds only one intentional query after a v0.7.78 polluted active context', () => {
    const legacy = legacyPollutedLineageFixture();
    const beforeIds = new Set(legacy.entries.map((entry) => entry.id));
    const repeatedButNewQuery = createTextMessage('user', 'original query');
    const messages = [
      ...structuredClone(getSessionMessagesFromLineage(legacy)),
      repeatedButNewQuery,
    ];

    const reconciled = createSessionLineage(messages, legacy);
    const added = reconciled.entries.filter((entry) => !beforeIds.has(entry.id));

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      type: 'message',
      parentId: legacy.activeEntryId,
      message: repeatedButNewQuery,
    });
    expect(added[0]?.id).not.toBe('entry_legacy_root');
    expect(getSessionMessagesFromLineage(reconciled)).toEqual(messages);
  });

  it('keeps the v0.7.78 handoff idempotent across repeated reconciliation', () => {
    const legacy = legacyPollutedLineageFixture();
    const messages = [
      ...structuredClone(getSessionMessagesFromLineage(legacy)),
      createTextMessage('user', 'one new query'),
    ];
    const first = createSessionLineage(messages, legacy);
    const firstIds = first.entries.map((entry) => entry.id);

    const second = createSessionLineage(structuredClone(messages), JSON.parse(
      JSON.stringify(first),
    ) as KodaXSessionLineage);

    expect(second.entries.map((entry) => entry.id)).toEqual(firstIds);
    expect(second.activeEntryId).toBe(first.activeEntryId);
    expect(getSessionMessagesFromLineage(second)).toEqual(messages);
  });

  it('preserves legacy thinking and tool provenance through immediate compaction', () => {
    const legacy = legacyPollutedLineageFixture();
    const activeMessages = getSessionMessagesFromLineage(legacy);
    const reconciliationMessages = structuredClone(activeMessages);
    const reconciled = createSessionLineage(reconciliationMessages, legacy);
    const retainedMessages = reconciliationMessages.slice(1, 3);
    const retainedSources = getSessionLineagePath(reconciled)
      .filter((entry): entry is KodaXSessionMessageEntry => entry.type === 'message')
      .slice(1, 3);

    const compacted = applySessionCompaction(
      reconciled,
      [
        { role: 'system', content: `${COMPACTION_SUMMARY_PREFIX}Legacy upgrade summary` },
        ...retainedMessages,
      ],
      { summary: 'Legacy upgrade summary' },
    );
    const compactionIndex = compacted.entries.findIndex(
      (entry) => entry.type === 'compaction' && entry.summary === 'Legacy upgrade summary',
    );
    const rematerialized = compacted.entries
      .slice(compactionIndex + 1)
      .filter((entry): entry is KodaXSessionMessageEntry => entry.type === 'message');

    expect(rematerialized).toHaveLength(2);
    expect(rematerialized.map((entry) => entry.message)).toEqual(retainedMessages);
    for (let index = 0; index < rematerialized.length; index += 1) {
      expect(rematerialized[index]).toMatchObject({
        logicalId: retainedSources[index]!.logicalId,
        sourceEntryId: retainedSources[index]!.id,
      });
    }
    expect(rematerialized[0]!.parentId).toBe(compacted.entries[compactionIndex]!.id);
    expect(rematerialized[1]!.parentId).toBe(rematerialized[0]!.id);
  });

  it('reuses existing history and branches cleanly from an earlier node', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'root'),
      createTextMessage('assistant', 'first branch'),
    ]);

    const rewound = setSessionLineageActiveEntry(initial, initial.entries[0]!.id);
    expect(rewound?.activeEntryId).toBe(initial.entries[0]!.id);

    const branched = createSessionLineage([
      createTextMessage('user', 'root'),
      createTextMessage('assistant', 'second branch'),
    ], rewound ?? undefined);

    const tree = buildSessionTree(branched);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(2);
    expect(getSessionMessagesFromLineage(branched)).toEqual([
      createTextMessage('user', 'root'),
      createTextMessage('assistant', 'second branch'),
    ]);
  });

  it('treats synthetic and real messages with the same content as distinct lineage entries', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'repeat'),
    ]);
    const syntheticMessage: KodaXMessage = {
      role: 'user',
      content: 'repeat',
      _synthetic: true,
    };

    const branched = createSessionLineage([syntheticMessage], initial);

    expect(branched.activeEntryId).not.toBe(initial.activeEntryId);
    expect(branched.entries.filter((entry) => entry.type === 'message')).toHaveLength(2);
    expect(getSessionMessagesFromLineage(branched)).toEqual([syntheticMessage]);
  });

  it('stores labels as lightweight checkpoints and resolves them for forking', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'checkpoint root'),
      createTextMessage('assistant', 'checkpoint leaf'),
    ]);

    const labeled = appendSessionLineageLabel(lineage, lineage.activeEntryId!, 'milestone-a');
    expect(resolveSessionLineageTarget(labeled!, 'milestone-a')?.id).toBe(lineage.activeEntryId);

    const forked = forkSessionLineage(labeled!, 'milestone-a');
    expect(forked).not.toBeNull();
    expect(getSessionMessagesFromLineage(forked!)).toEqual([
      createTextMessage('user', 'checkpoint root'),
      createTextMessage('assistant', 'checkpoint leaf'),
    ]);
    expect(buildSessionTree(forked!)).toHaveLength(1);
  });

  it('forks from the active leaf when no selector is provided', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'start from root'),
      createTextMessage('assistant', 'active branch answer'),
    ]);

    const labeled = appendSessionLineageLabel(lineage, lineage.activeEntryId!, 'active-leaf');
    const forked = forkSessionLineage(labeled!);

    expect(forked).not.toBeNull();
    expect(getSessionMessagesFromLineage(forked!)).toEqual([
      createTextMessage('user', 'start from root'),
      createTextMessage('assistant', 'active branch answer'),
    ]);
    expect(resolveSessionLineageTarget(forked!, 'active-leaf')?.id).toBe(forked!.activeEntryId);
  });

  it('preserves logical provenance when forking cloned transcript entries', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'start from root'),
      createTextMessage('assistant', 'active branch answer'),
    ]);
    const sourceEntries = messageEntries(lineage);

    expect(sourceEntries.map((entry) => entry.logicalId)).toEqual(
      sourceEntries.map((entry) => entry.id),
    );
    expect(sourceEntries.map((entry) => entry.sourceEntryId)).toEqual([undefined, undefined]);

    const forked = forkSessionLineage(lineage);
    expect(forked).not.toBeNull();
    const forkEntries = messageEntries(forked!);

    expect(forkEntries).toHaveLength(sourceEntries.length);
    for (let i = 0; i < sourceEntries.length; i++) {
      const source = sourceEntries[i]!;
      const fork = forkEntries[i]!;
      expect(fork.id).not.toBe(source.id);
      expect(fork.logicalId).toBe(source.logicalId);
      expect(fork.sourceEntryId).toBe(source.id);
    }

    const secondFork = forkSessionLineage(forked!);
    expect(secondFork).not.toBeNull();
    const secondForkEntries = messageEntries(secondFork!);
    for (let i = 0; i < sourceEntries.length; i++) {
      const source = sourceEntries[i]!;
      const secondForkEntry = secondForkEntries[i]!;
      expect(secondForkEntry.id).not.toBe(source.id);
      expect(secondForkEntry.logicalId).toBe(source.logicalId);
      // Direct addressing: the second-level fork names the first-level fork
      // clone's physical id as its source instead of collapsing to the
      // generation-0 original.
      expect(secondForkEntry.sourceEntryId).toBe(forkEntries[i]!.id);
      expect(secondForkEntry.sourceEntryId).not.toBe(source.id);
    }
  });

  it('adds a branch summary when switching branches and preserves it for future turns', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'root request'),
      createTextMessage('assistant', 'first implementation pass'),
    ]);

    const rewound = setSessionLineageActiveEntry(
      initial,
      initial.entries[0]!.id,
      { summarizeCurrentBranch: true },
    );
    expect(rewound).not.toBeNull();

    const summaryEntry = rewound!.entries[rewound!.entries.length - 1];
    expect(summaryEntry?.type).toBe('branch_summary');
    expect(rewound!.activeEntryId).toBe(summaryEntry?.id);

    const branchedMessages = [
      ...getSessionMessagesFromLineage(rewound!),
      createTextMessage('user', 'try a safer alternative'),
      createTextMessage('assistant', 'second implementation pass'),
    ];
    const continued = createSessionLineage(branchedMessages, rewound!);

    expect(continued.entries.filter((entry) => entry.type === 'branch_summary')).toHaveLength(1);
    expect(getSessionMessagesFromLineage(continued)).toEqual(branchedMessages);
  });

  it('skips branch summaries when summarizeCurrentBranch is disabled', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'root request'),
      createTextMessage('assistant', 'first implementation pass'),
    ]);

    const rewound = setSessionLineageActiveEntry(initial, initial.entries[0]!.id, {
      summarizeCurrentBranch: false,
    });

    expect(rewound).not.toBeNull();
    expect(rewound!.activeEntryId).toBe(initial.entries[0]!.id);
    expect(rewound!.entries.filter((entry) => entry.type === 'branch_summary')).toHaveLength(0);
  });

  it('returns null or undefined for missing selectors', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'root request'),
      createTextMessage('assistant', 'leaf'),
    ]);

    expect(resolveSessionLineageTarget(lineage, 'missing-label')).toBeUndefined();
    expect(setSessionLineageActiveEntry(lineage, 'missing-label')).toBeNull();
    expect(appendSessionLineageLabel(lineage, 'missing-label', 'checkpoint')).toBeNull();
    expect(forkSessionLineage(lineage, 'missing-label')).toBeNull();
  });

  it('treats orphaned entries as separate roots when building trees', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'root'),
      createTextMessage('assistant', 'leaf'),
    ]);
    const orphan = {
      type: 'message' as const,
      id: 'entry_orphan',
      parentId: 'entry_missing',
      timestamp: new Date().toISOString(),
      message: createTextMessage('assistant', 'orphaned leaf'),
    };

    const tree = buildSessionTree({
      ...lineage,
      entries: [...lineage.entries, orphan],
    });

    expect(tree).toHaveLength(2);
    expect(tree.map((node) => node.entry.id)).toContain('entry_orphan');
  });

  it('stops path traversal when lineage data contains a cycle', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'cyclic root'),
      createTextMessage('assistant', 'cyclic leaf'),
    ]);

    const root = lineage.entries[0]!;
    const leaf = lineage.entries[1]!;
    root.parentId = leaf.id;

    expect(() => getSessionLineagePath(lineage, leaf.id)).not.toThrow();
    expect(getSessionLineagePath(lineage, leaf.id).map((entry) => entry.id)).toEqual([
      root.id,
      leaf.id,
    ]);
  });

  it('applies compaction anchors as first-class lineage entries and keeps the compacted tail active', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'root task'),
      createTextMessage('assistant', 'first pass'),
      createTextMessage('user', 'follow-up'),
      createTextMessage('assistant', 'latest pass'),
    ]);

    const compacted = applySessionCompaction(
      initial,
      [
        { role: 'system', content: '[对话历史摘要]\n\nCompacted summary' },
        createTextMessage('assistant', 'latest pass'),
      ],
      {
        summary: 'Compacted summary',
        tokensBefore: 1000,
        tokensAfter: 200,
        artifactLedgerId: 'ledger_123',
        reason: 'automatic_compaction',
        details: {
          readFiles: ['packages/a.ts'],
          modifiedFiles: ['packages/b.ts'],
        },
        memorySeed: {
          objective: 'Continue the latest pass',
          constraints: ['Keep the fix minimal'],
          progress: {
            completed: ['Compacted older context'],
            inProgress: ['Finish the latest pass'],
            blockers: [],
          },
          keyDecisions: ['Use compact anchor'],
          nextSteps: ['Resume from latest pass'],
          keyContext: ['packages/a.ts'],
          importantTargets: ['packages/b.ts'],
          tombstones: [],
        },
      },
    );

    const compactionEntry = compacted.entries.find((entry) => entry.type === 'compaction');
    expect(compactionEntry).toEqual(expect.objectContaining({
      type: 'compaction',
      summary: 'Compacted summary',
      tokensBefore: 1000,
      tokensAfter: 200,
      artifactLedgerId: 'ledger_123',
      reason: 'automatic_compaction',
      firstKeptEntryId: expect.any(String),
      memorySeed: expect.objectContaining({
        objective: 'Continue the latest pass',
      }),
    }));
    expect(getSessionMessagesFromLineage(compacted)).toEqual([
      {
        role: 'user',
        content: `${COMPACTION_SUMMARY_PREFIX}Compacted summary${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`,
        _synthetic: true,
        _source: 'compaction-checkpoint',
      },
      createTextMessage('assistant', 'latest pass'),
    ]);
    expect(compacted.activeEntryId).toBe(compacted.entries[compacted.entries.length - 1]?.id ?? null);
  });

  it('preserves clone provenance when compaction rematerializes retained messages', () => {
    const source = createSessionLineage([
      createTextMessage('user', 'source prompt'),
      createTextMessage('assistant', 'same retained answer'),
      createTextMessage('assistant', 'same retained answer'),
    ]);
    const forked = forkSessionLineage(source);
    expect(forked).not.toBeNull();
    const forkedMessages = messageEntries(forked!);

    const compacted = applySessionCompaction(
      forked!,
      [
        { role: 'system', content: '[对话历史摘要]\n\nCompacted summary' },
        forkedMessages[1]!.message,
        forkedMessages[2]!.message,
        createTextMessage('assistant', 'new post-compaction message'),
      ],
      { summary: 'Compacted summary' },
    );
    const compactionEntryIndex = compacted.entries.findIndex(
      (entry) => entry.type === 'compaction' && entry.summary === 'Compacted summary',
    );
    const rematerialized = compacted.entries
      .slice(compactionEntryIndex + 1)
      .filter((entry): entry is KodaXSessionMessageEntry => entry.type === 'message');

    expect(rematerialized).toHaveLength(3);
    for (let index = 0; index < 2; index += 1) {
      const retained = forkedMessages[index + 1]!;
      const clone = rematerialized[index]!;
      expect(clone.id).not.toBe(retained.id);
      expect(clone.logicalId).toBe(retained.logicalId);
      // Direct addressing: the rematerialized clone names the retained fork
      // clone's own physical id, not its collapsed cross-generation source.
      expect(clone.sourceEntryId).toBe(retained.id);
    }
    expect(rematerialized[2]!.logicalId).toBe(rematerialized[2]!.id);
    expect(rematerialized[2]!.sourceEntryId).toBeUndefined();
  });

  it('points each compaction clone at its direct physical predecessor across chained compactions', () => {
    const gen0 = createSessionLineage([
      createTextMessage('user', 'chain prompt'),
      createTextMessage('assistant', 'chain answer'),
    ]);
    const original = messageEntries(gen0).at(-1)!;

    const gen1 = applySessionCompaction(
      gen0,
      [
        { role: 'system', content: '[对话历史摘要]\n\nChain summary one' },
        original.message,
      ],
      { summary: 'Chain summary one' },
    );
    const firstClone = messageEntries(gen1).find(
      (entry) => entry.id !== original.id && entry.message === original.message,
    )!;
    expect(firstClone.sourceEntryId).toBe(original.id);

    const gen2 = applySessionCompaction(
      gen1,
      [
        { role: 'system', content: '[对话历史摘要]\n\nChain summary two' },
        firstClone.message,
      ],
      { summary: 'Chain summary two' },
    );
    const secondClone = messageEntries(gen2).find(
      (entry) => entry.message === original.message
        && entry.id !== original.id
        && entry.id !== firstClone.id,
    )!;

    // The gen-2 clone must name the gen-1 clone's physical id instead of
    // collapsing to the gen-0 original, while the logical identity still
    // anchors to the generation-0 entry.
    expect(secondClone.sourceEntryId).toBe(firstClone.id);
    expect(secondClone.sourceEntryId).not.toBe(original.id);
    expect(secondClone.logicalId).toBe(original.id);
  });

  it('remaps a cloned compaction firstKeptEntryId into the fork', () => {
    const source = createSessionLineage([
      createTextMessage('user', 'first request'),
      createTextMessage('assistant', 'first answer'),
      createTextMessage('user', 'retained request'),
    ]);
    const retained = messageEntries(source).at(-1)!;
    const compacted = applySessionCompaction(
      source,
      [
        {
          role: 'user',
          content: `${COMPACTION_SUMMARY_PREFIX}summary${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`,
          _synthetic: true,
          _source: 'compaction-checkpoint',
        },
        retained.message,
        createTextMessage('assistant', 'post-compaction answer'),
      ],
      { summary: 'summary' },
    );

    const forked = forkSessionLineage(compacted);
    const compaction = forked?.entries.find(
      (entry) => entry.type === 'compaction',
    );

    expect(compaction?.type).toBe('compaction');
    if (compaction?.type !== 'compaction') return;
    expect(compaction.firstKeptEntryId).not.toBe(
      compacted.entries.find((entry) => entry.type === 'compaction')
        ?.firstKeptEntryId,
    );
    expect(forked?.entries.some(
      (entry) => entry.id === compaction.firstKeptEntryId,
    )).toBe(true);
  });

  it('keeps the first duplicate system message provenance when compaction deduplicates it', () => {
    const firstSystem = createTextMessage('system', 'same system context');
    const secondSystem = createTextMessage('system', 'same system context');
    const source = createSessionLineage([firstSystem, secondSystem]);
    const sourceEntries = messageEntries(source);

    const compacted = applySessionCompaction(
      source,
      [
        { role: 'system', content: '[对话历史摘要]\n\nSystem summary' },
        firstSystem,
        secondSystem,
      ],
      { summary: 'System summary' },
    );
    const sourceIds = new Set(source.entries.map((entry) => entry.id));
    const rematerialized = messageEntries(compacted).find((entry) =>
      !sourceIds.has(entry.id) && entry.message === firstSystem);

    expect(rematerialized?.logicalId).toBe(sourceEntries[0]!.id);
    expect(rematerialized?.sourceEntryId).toBe(sourceEntries[0]!.id);
  });

  it('does not give retained provenance to a new same-content message', () => {
    const retainedMessage = createTextMessage('assistant', 'same bytes');
    const source = createSessionLineage([
      createTextMessage('user', 'old prompt'),
      retainedMessage,
    ]);
    const retainedSource = messageEntries(source)[1]!;
    const newSameContent = createTextMessage('assistant', 'same bytes');

    const compacted = applySessionCompaction(
      source,
      [
        { role: 'system', content: '[对话历史摘要]\n\nIdentity summary' },
        retainedMessage,
        newSameContent,
      ],
      { summary: 'Identity summary' },
    );
    const sourceIds = new Set(source.entries.map((entry) => entry.id));
    const rematerialized = messageEntries(compacted).filter((entry) => !sourceIds.has(entry.id));
    const retainedClone = rematerialized.find((entry) => entry.message === retainedMessage);
    const newEntry = rematerialized.find((entry) => entry.message === newSameContent);

    expect(retainedClone?.logicalId).toBe(retainedSource.id);
    expect(retainedClone?.sourceEntryId).toBe(retainedSource.id);
    expect(newEntry?.logicalId).toBe(newEntry?.id);
    expect(newEntry?.sourceEntryId).toBeUndefined();
  });

  it('does not clone compacted-away identity onto a new same-content prefix message', () => {
    const oldSameContent = createTextMessage('assistant', 'ambiguous bytes');
    const retainedTail = createTextMessage('assistant', 'retained tail');
    const source = createSessionLineage([oldSameContent, retainedTail]);
    const sourceTail = messageEntries(source)[1]!;
    const newSameContent = createTextMessage('assistant', 'ambiguous bytes');

    const compacted = applySessionCompaction(
      source,
      [
        { role: 'system', content: '[对话历史摘要]\n\nPrefix summary' },
        newSameContent,
        retainedTail,
      ],
      { summary: 'Prefix summary' },
    );
    const sourceIds = new Set(source.entries.map((entry) => entry.id));
    const rematerialized = messageEntries(compacted).filter((entry) => !sourceIds.has(entry.id));
    const newEntry = rematerialized.find((entry) => entry.message === newSameContent);
    const retainedClone = rematerialized.find((entry) => entry.message === retainedTail);

    expect(newEntry?.logicalId).toBe(newEntry?.id);
    expect(newEntry?.sourceEntryId).toBeUndefined();
    expect(retainedClone?.logicalId).toBe(sourceTail.id);
    expect(retainedClone?.sourceEntryId).toBe(sourceTail.id);
  });

  it('matches a repeated message reference to the retained suffix occurrence', () => {
    const repeated = createTextMessage('assistant', 'same object twice');
    const retainedTail = createTextMessage('assistant', 'tail anchor');
    const source = createSessionLineage([repeated, repeated, retainedTail]);
    const sourceMessages = messageEntries(source);

    const compacted = applySessionCompaction(
      source,
      [
        { role: 'system', content: '[对话历史摘要]\n\nSuffix summary' },
        repeated,
        retainedTail,
      ],
      { summary: 'Suffix summary' },
    );
    const sourceIds = new Set(source.entries.map((entry) => entry.id));
    const repeatedClone = messageEntries(compacted).find((entry) =>
      !sourceIds.has(entry.id) && entry.message === repeated);

    expect(repeatedClone?.logicalId).toBe(sourceMessages[1]!.id);
    expect(repeatedClone?.sourceEntryId).toBe(sourceMessages[1]!.id);
  });

  it('preserves provenance when a prior compaction checkpoint survives in the protected tail', () => {
    const first = applySessionCompaction(
      createSessionLineage([
        createTextMessage('user', 'old prompt'),
        createTextMessage('assistant', 'old answer'),
      ]),
      [
        { role: 'system', content: '[对话历史摘要]\n\nFirst summary' },
        createTextMessage('assistant', 'first protected tail'),
      ],
      { summary: 'First summary' },
    );
    const firstCheckpoint = first.entries.find(
      (entry) => entry.type === 'compaction' && entry.summary === 'First summary',
    )!;
    const renderedFirstCheckpoint = getSessionMessagesFromLineage(first)[0]!;

    const second = applySessionCompaction(
      first,
      [
        { role: 'system', content: '[对话历史摘要]\n\nSecond summary' },
        renderedFirstCheckpoint,
        createTextMessage('assistant', 'first protected tail'),
      ],
      { summary: 'Second summary' },
    );
    const secondCheckpointIndex = second.entries.findIndex(
      (entry) => entry.type === 'compaction' && entry.summary === 'Second summary',
    );
    const clonedCheckpoint = second.entries
      .slice(secondCheckpointIndex + 1)
      .find((entry): entry is KodaXSessionMessageEntry =>
        entry.type === 'message' && entry.message === renderedFirstCheckpoint);

    expect(clonedCheckpoint?.logicalId).toBe(firstCheckpoint.logicalId);
    expect(clonedCheckpoint?.sourceEntryId).toBe(firstCheckpoint.id);
  });

  it('inherits rendered branch-summary provenance only for the actual rendered copy', () => {
    const branchSummary = {
      type: 'branch_summary' as const,
      id: 'entry_branch_summary_source',
      parentId: null,
      logicalId: 'logical_branch_summary_source',
      timestamp: '2026-07-30T00:00:00.000Z',
      summary: 'same rendered branch bytes',
    };
    const retainedTail = createTextMessage('assistant', 'retained branch tail');
    const tailEntry = {
      type: 'message' as const,
      id: 'entry_branch_tail',
      parentId: branchSummary.id,
      logicalId: 'logical_branch_tail',
      timestamp: '2026-07-30T00:00:01.000Z',
      message: retainedTail,
    };
    const source: KodaXSessionLineage = {
      version: 2,
      activeEntryId: tailEntry.id,
      entries: [branchSummary, tailEntry],
    };
    const renderedCopy = getSessionMessagesFromLineage(source)[0]!;
    const sameBytesButNew = structuredClone(renderedCopy);

    const compact = (candidate: KodaXMessage) => applySessionCompaction(
      source,
      [
        { role: 'system', content: '[对话历史摘要]\n\nBranch summary test' },
        candidate,
        retainedTail,
      ],
      { summary: 'Branch summary test' },
    );
    const rematerialized = (lineage: KodaXSessionLineage, message: KodaXMessage) =>
      messageEntries(lineage).find((entry) =>
        !source.entries.some((sourceEntry) => sourceEntry.id === entry.id)
        && entry.message === message);

    const trueCopy = rematerialized(compact(renderedCopy), renderedCopy);
    const collision = rematerialized(compact(sameBytesButNew), sameBytesButNew);

    expect(trueCopy?.logicalId).toBe(branchSummary.logicalId);
    expect(trueCopy?.sourceEntryId).toBe(branchSummary.id);
    expect(collision?.logicalId).toBe(collision?.id);
    expect(collision?.sourceEntryId).toBeUndefined();
  });

  it('recognizes the producer checkpoint bytes and keeps attachments on the active path', () => {
    const summary = 'Verified compacted summary';
    const checkpoint: KodaXMessage = {
      role: 'user',
      content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`,
      _synthetic: true,
      _source: 'compaction-checkpoint',
    };
    const attachment = createTextMessage('system', '[Post-compact: verified ledger]');
    const compacted = applySessionCompaction(
      createSessionLineage([
        createTextMessage('user', 'root task'),
        createTextMessage('assistant', 'old response'),
      ]),
      [checkpoint, createTextMessage('assistant', 'kept tail')],
      { summary },
      [attachment],
    );

    const compactionEntry = compacted.entries.find((entry) => entry.type === 'compaction');
    expect(compactionEntry?.type).toBe('compaction');
    if (!compactionEntry || compactionEntry.type !== 'compaction') return;

    expect(getSessionLineagePath(compacted).map((entry) => entry.type)).toEqual([
      'compaction',
      'message',
    ]);
    expect(compactionEntry.firstKeptEntryId).toBe(compacted.activeEntryId);
    expect(messageEntries(compacted).filter(
      (entry) => entry.message._source === 'compaction-checkpoint',
    )).toHaveLength(0);
    expect(getSessionMessagesFromLineage(compacted)).toEqual([
      checkpoint,
      attachment,
      createTextMessage('assistant', 'kept tail'),
    ]);
  });

  it('rewinds to a target entry and truncates all entries after it', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'message 1'),
      createTextMessage('assistant', 'message 2'),
      createTextMessage('user', 'message 3'),
      createTextMessage('assistant', 'message 4'),
    ]);

    const targetId = lineage.entries[1]!.id;
    const rewound = rewindSessionLineage(lineage, targetId);

    expect(rewound).not.toBeNull();
    expect(rewound!.activeEntryId).toBe(targetId);
    // Entries: [0], [1], [rewind event]
    expect(rewound!.entries).toHaveLength(3);
    expect(rewound!.entries[0]?.id).toBe(lineage.entries[0]!.id);
    expect(rewound!.entries[1]?.id).toBe(lineage.entries[1]!.id);
    expect(rewound!.entries[2]?.type).toBe('rewind_marker');
    expect(rewound!.entries[2]).toMatchObject({
      targetId,
      summary: expect.stringContaining('Rewound to entry'),
    });
  });

  it('rewind event records details about the truncation', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'message 1'),
      createTextMessage('assistant', 'message 2'),
      createTextMessage('user', 'message 3'),
      createTextMessage('assistant', 'message 4'),
      createTextMessage('user', 'message 5'),
    ]);

    const targetId = lineage.entries[1]!.id;
    const rewound = rewindSessionLineage(lineage, targetId);

    const rewindEvent = rewound!.entries[2];
    expect(rewindEvent?.type).toBe('rewind_marker');
    if (rewindEvent?.type === 'rewind_marker') {
      expect(rewindEvent).toEqual(expect.objectContaining({
        targetId,
        fromId: lineage.activeEntryId,
        truncatedCount: 3,
      }));
    }
  });

  it('does not write fromId when the source lineage has no active entry', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'message 1'),
      createTextMessage('assistant', 'message 2'),
    ]);

    const targetId = lineage.entries[0]!.id;
    const rewound = rewindSessionLineage({ ...lineage, activeEntryId: null }, targetId);
    const rewindEvent = rewound!.entries[1];

    expect(rewindEvent?.type).toBe('rewind_marker');
    if (rewindEvent?.type === 'rewind_marker') {
      expect(rewindEvent.fromId).toBeUndefined();
    }
  });

  it('returns null when target entry is not found', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'message 1'),
      createTextMessage('assistant', 'message 2'),
    ]);

    const rewound = rewindSessionLineage(lineage, 'entry_nonexistent');
    expect(rewound).toBeNull();
  });

  it('returns null when target entry is session side-state instead of a navigable entry', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'message 1'),
      createTextMessage('assistant', 'message 2'),
    ]);
    const labeled = appendSessionLineageLabel(lineage, lineage.entries[0]!.id, 'first');
    const labelEntry = labeled.entries.find((entry) => entry.type === 'label');
    expect(labelEntry).toBeDefined();
    expect(rewindSessionLineage(labeled, labelEntry!.id)).toBeNull();

    const rewound = rewindSessionLineage(lineage, lineage.entries[0]!.id);
    const rewindEntry = rewound!.entries.find((entry) => entry.type === 'rewind_marker');
    expect(rewindEntry).toBeDefined();
    expect(rewindSessionLineage(rewound!, rewindEntry!.id)).toBeNull();

    const legacyRewindLineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: 'entry_legacy_rewind',
      entries: [
        lineage.entries[0]!,
        {
          type: 'compaction',
          id: 'entry_legacy_rewind',
          parentId: lineage.entries[0]!.id,
          timestamp: '2026-07-07T01:00:00.000Z',
          logicalId: 'entry_legacy_rewind',
          summary: '[Rewind] Rewound to entry',
          reason: 'rewind',
        },
      ],
    };
    expect(rewindSessionLineage(legacyRewindLineage, 'entry_legacy_rewind')).toBeNull();
  });

  it('does not mutate the original lineage', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'message 1'),
      createTextMessage('assistant', 'message 2'),
      createTextMessage('user', 'message 3'),
    ]);

    const originalEntryCount = lineage.entries.length;
    const originalActiveId = lineage.activeEntryId;

    const targetId = lineage.entries[0]!.id;
    const rewound = rewindSessionLineage(lineage, targetId);

    // Original lineage unchanged
    expect(lineage.entries.length).toBe(originalEntryCount);
    expect(lineage.activeEntryId).toBe(originalActiveId);
    // New lineage is different
    expect(rewound!.entries.length).not.toBe(originalEntryCount);
    expect(rewound!.activeEntryId).not.toBe(originalActiveId);
  });

  it('can rewind to the first entry', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'message 1'),
      createTextMessage('assistant', 'message 2'),
      createTextMessage('user', 'message 3'),
    ]);

    const targetId = lineage.entries[0]!.id;
    const rewound = rewindSessionLineage(lineage, targetId);

    expect(rewound).not.toBeNull();
    expect(rewound!.activeEntryId).toBe(targetId);
    expect(rewound!.entries).toHaveLength(2); // [0] + rewind event
    expect(rewound!.entries[0]?.id).toBe(targetId);
  });

  it('can rewind to the last entry (no-op truncation)', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'message 1'),
      createTextMessage('assistant', 'message 2'),
    ]);

    const targetId = lineage.entries[1]!.id;
    const rewound = rewindSessionLineage(lineage, targetId);

    expect(rewound).not.toBeNull();
    expect(rewound!.activeEntryId).toBe(targetId);
    expect(rewound!.entries).toHaveLength(3); // [0], [1] + rewind event
    expect(rewound!.entries[2]?.type).toBe('rewind_marker');
    if (rewound!.entries[2]?.type === 'rewind_marker') {
      expect(rewound!.entries[2]).toEqual(expect.objectContaining({
        targetId,
        truncatedCount: 0,
      }));
    }
  });

  it('rewind event is set as new activeEntryId', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'message 1'),
      createTextMessage('assistant', 'message 2'),
      createTextMessage('user', 'message 3'),
    ]);

    const targetId = lineage.entries[0]!.id;
    const rewound = rewindSessionLineage(lineage, targetId);

    // Active is set to the target, not the rewind event
    expect(rewound!.activeEntryId).toBe(targetId);
  });
});

describe('findPreviousUserEntryId', () => {
  it('returns null for empty lineage', () => {
    const lineage = createSessionLineage([]);
    expect(findPreviousUserEntryId(lineage)).toBeNull();
  });

  it('returns null when only one user message exists', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'hello'),
      createTextMessage('assistant', 'hi'),
    ]);
    expect(findPreviousUserEntryId(lineage)).toBeNull();
  });

  it('returns the second-to-last user message id', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'first'),
      createTextMessage('assistant', 'reply 1'),
      createTextMessage('user', 'second'),
      createTextMessage('assistant', 'reply 2'),
    ]);
    const result = findPreviousUserEntryId(lineage);
    // The first user message entry should be returned
    const userEntries = lineage.entries.filter(
      (e) => e.type === 'message' && e.message.role === 'user',
    );
    expect(result).toBe(userEntries[0]!.id);
  });

  it('works with three user messages — returns second-to-last', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'first'),
      createTextMessage('assistant', 'reply 1'),
      createTextMessage('user', 'second'),
      createTextMessage('assistant', 'reply 2'),
      createTextMessage('user', 'third'),
    ]);
    const result = findPreviousUserEntryId(lineage);
    const userEntries = lineage.entries.filter(
      (e) => e.type === 'message' && e.message.role === 'user',
    );
    // Should return the second user entry (index 1), not the first (index 0)
    expect(result).toBe(userEntries[1]!.id);
  });

  it('skips tool_result-only user messages when selecting the previous prompt', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'first prompt'),
      createTextMessage('assistant', 'first answer'),
      createTextMessage('user', 'second prompt'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_2', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_2', content: 'ok' }],
      },
      createTextMessage('assistant', 'second answer'),
    ]);

    const result = findPreviousUserEntryId(lineage);
    const userEntries = lineage.entries.filter(
      (e) => e.type === 'message' && e.message.role === 'user',
    );

    expect(result).toBe(userEntries[0]!.id);
    expect(result).not.toBe(userEntries[2]!.id);
  });

  it('skips synthetic user messages when selecting the previous prompt', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'first prompt'),
      createTextMessage('assistant', 'first answer'),
      createTextMessage('user', 'second prompt'),
      { role: 'user', content: 'system reminder', _synthetic: true },
      { role: 'user', content: 'task completed', _synthetic: true, _source: 'task-completed' },
      createTextMessage('assistant', 'second answer'),
    ]);

    const result = findPreviousUserEntryId(lineage);
    const userEntries = lineage.entries.filter(
      (e) => e.type === 'message' && e.message.role === 'user',
    );

    expect(result).toBe(userEntries[0]!.id);
  });

  it('returns null when activeEntryId is null even if entries remain', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'first prompt'),
      createTextMessage('assistant', 'first answer'),
      createTextMessage('user', 'second prompt'),
    ]);

    expect(findPreviousUserEntryId({ ...lineage, activeEntryId: null })).toBeNull();
  });

  it('returns null when only system and assistant messages exist', () => {
    const lineage = createSessionLineage([
      createTextMessage('assistant', 'hello'),
    ]);
    expect(findPreviousUserEntryId(lineage)).toBeNull();
  });
});

describe('archiveOldIslands', () => {
  it('archives old island message entries after compaction, preserves current island', () => {
    // Create initial lineage (island 1: 4 entries)
    const initial = createSessionLineage([
      createTextMessage('user', 'old task'),
      createTextMessage('assistant', 'old reply'),
      createTextMessage('user', 'old follow-up'),
      createTextMessage('assistant', 'old conclusion'),
    ]);
    expect(initial.entries).toHaveLength(4);

    // Compact → creates island 2 with compaction entry + new entries
    const compacted = applySessionCompaction(
      initial,
      [
        { role: 'system', content: '[对话历史摘要]\n\nSummary' },
        createTextMessage('assistant', 'continue'),
      ],
      { summary: 'Summary', tokensBefore: 500, tokensAfter: 100 },
    );
    const totalBefore = compacted.entries.length;
    const msgBefore = compacted.entries.filter((e) => e.type === 'message').length;

    // Archive
    const result = archiveOldIslands(compacted);

    // Old island's 4 message entries should be archived
    expect(result.archivedCount).toBe(4);
    expect(result.archivedEntries).toHaveLength(4);
    expect(result.archiveBatchId).toBeTruthy();

    // Slimmed lineage should have fewer entries
    const msgAfter = result.slimmedLineage.entries.filter((e) => e.type === 'message').length;
    expect(msgAfter).toBe(msgBefore - 4);

    // Archive marker should be present
    const markers = result.slimmedLineage.entries.filter((e) => e.type === 'archive_marker');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0]).toMatchObject({
      type: 'archive_marker',
      archiveBatchId: result.archiveBatchId,
      archivedEntryCount: 4,
    });

    // Messages from active path should be unchanged
    expect(getSessionMessagesFromLineage(result.slimmedLineage)).toEqual(
      getSessionMessagesFromLineage(compacted),
    );
  });

  it('does not archive when there is only one island (no compaction)', () => {
    const lineage = createSessionLineage([
      createTextMessage('user', 'hello'),
      createTextMessage('assistant', 'world'),
    ]);

    const result = archiveOldIslands(lineage);
    expect(result.archivedCount).toBe(0);
    expect(result.slimmedLineage).toBe(lineage); // same reference, untouched
  });

  it('preserves label target entries and their ancestor chains', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'root'),
      createTextMessage('assistant', 'reply'),
      createTextMessage('user', 'follow-up'),
      createTextMessage('assistant', 'conclusion'),
    ]);

    // Label the second entry
    const labeled = appendSessionLineageLabel(initial, initial.entries[1]!.id, 'my-checkpoint');
    expect(labeled).toBeTruthy();

    // Compact — old entries become a separate island
    const compacted = applySessionCompaction(
      labeled!,
      [
        { role: 'system', content: '[对话历史摘要]\n\nSummary' },
        createTextMessage('assistant', 'after compaction'),
      ],
      { summary: 'Summary' },
    );

    const result = archiveOldIslands(compacted);

    // The labeled entry (entries[1]) and its ancestor (entries[0]) must be preserved
    const preservedIds = new Set(result.slimmedLineage.entries.map((e) => e.id));
    expect(preservedIds.has(initial.entries[0]!.id)).toBe(true); // ancestor of label target
    expect(preservedIds.has(initial.entries[1]!.id)).toBe(true); // label target itself

    // Some entries may still be archived (entries[2], entries[3] — not on label chain)
    expect(result.archivedCount).toBeGreaterThanOrEqual(0);
  });

  it('preserves non-message entries and their ancestor chains (prevents tree drift)', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'root'),
      createTextMessage('assistant', 'reply'),
    ]);

    // Compact → old entries become separate island, compaction entry has parentId: null
    const compacted = applySessionCompaction(
      initial,
      [{ role: 'system', content: '[对话历史摘要]\n\nSummary' }],
      { summary: 'Summary' },
    );

    // The compaction entry is a non-message entry in the old island
    const compactionEntry = compacted.entries.find((e) => e.type === 'compaction');
    expect(compactionEntry).toBeTruthy();

    const result = archiveOldIslands(compacted);

    // Compaction entry itself must be preserved (non-message)
    const preservedIds = new Set(result.slimmedLineage.entries.map((e) => e.id));
    expect(preservedIds.has(compactionEntry!.id)).toBe(true);
  });

  it('archive_marker is context-silent', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'old task'),
      createTextMessage('assistant', 'old reply'),
    ]);
    const compacted = applySessionCompaction(
      initial,
      [{ role: 'system', content: '[对话历史摘要]\n\nSummary' }],
      { summary: 'Summary' },
    );
    const result = archiveOldIslands(compacted);

    // Active path messages should be identical before and after archival
    const messagesBefore = getSessionMessagesFromLineage(compacted);
    const messagesAfter = getSessionMessagesFromLineage(result.slimmedLineage);
    expect(messagesAfter).toEqual(messagesBefore);
  });

  it('archive_marker is non-targetable in resolveSessionLineageTarget', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'old'),
      createTextMessage('assistant', 'reply'),
    ]);
    const compacted = applySessionCompaction(
      initial,
      [{ role: 'system', content: '[对话历史摘要]\n\nSummary' }],
      { summary: 'Summary' },
    );
    const result = archiveOldIslands(compacted);

    const marker = result.slimmedLineage.entries.find((e) => e.type === 'archive_marker');
    expect(marker).toBeTruthy();

    // Cannot navigate to archive_marker
    expect(resolveSessionLineageTarget(result.slimmedLineage, marker!.id)).toBeUndefined();

    // setSessionLineageActiveEntry also fails for archive_marker
    expect(setSessionLineageActiveEntry(result.slimmedLineage, marker!.id)).toBeNull();
  });

  it('archive_marker is visible in buildSessionTree', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'old'),
      createTextMessage('assistant', 'reply'),
    ]);
    const compacted = applySessionCompaction(
      initial,
      [{ role: 'system', content: '[对话历史摘要]\n\nSummary' }],
      { summary: 'Summary' },
    );
    const result = archiveOldIslands(compacted);

    const tree = buildSessionTree(result.slimmedLineage);
    const allNodeTypes = new Set<string>();
    function collectTypes(nodes: any[]) {
      for (const node of nodes) {
        allNodeTypes.add(node.entry.type);
        if (node.children) collectTypes(node.children);
      }
    }
    collectTypes(tree);

    expect(allNodeTypes.has('archive_marker')).toBe(true);
  });

  it('keeps a referenced direct predecessor of a retained clone out of the archive', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'archive candidate prompt'),
      createTextMessage('assistant', 'archive candidate answer'),
    ]);
    const originals = messageEntries(initial);
    const compacted = applySessionCompaction(
      initial,
      [
        { role: 'system', content: '[对话历史摘要]\n\nReferenced predecessor summary' },
        originals[1]!.message,
      ],
      { summary: 'Referenced predecessor summary' },
    );
    const retainedClone = compacted.entries.find(
      (entry): entry is KodaXSessionMessageEntry =>
        entry.type === 'message' && entry.id !== originals[1]!.id
        && entry.message === originals[1]!.message,
    )!;
    expect(retainedClone.sourceEntryId).toBe(originals[1]!.id);

    const { slimmedLineage, archivedEntries, archivedCount } = archiveOldIslands(compacted);

    // The retained clone still references the original answer entry, so that
    // direct predecessor must stay in slimmedLineage instead of being
    // archived — only the unreferenced prompt entry may be archived.
    const archivedIds = new Set(archivedEntries.map((entry) => entry.id));
    expect(archivedIds.has(originals[1]!.id)).toBe(false);
    expect(slimmedLineage.entries.some((entry) => entry.id === originals[1]!.id)).toBe(true);
    expect(archivedIds.has(originals[0]!.id)).toBe(true);
    expect(archivedCount).toBe(1);
  });

  it('never archives an entry still referenced by a retained message clone', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'invariant prompt'),
      createTextMessage('assistant', 'invariant answer'),
      createTextMessage('assistant', 'invariant tail'),
    ]);
    const originals = messageEntries(initial);
    const compacted = applySessionCompaction(
      initial,
      [
        { role: 'system', content: '[对话历史摘要]\n\nInvariant summary' },
        originals[2]!.message,
      ],
      { summary: 'Invariant summary' },
    );
    const retainedClone = compacted.entries.find(
      (entry): entry is KodaXSessionMessageEntry =>
        entry.type === 'message' && entry.id !== originals[2]!.id
        && entry.message === originals[2]!.message,
    )!;

    const { slimmedLineage, archivedEntries } = archiveOldIslands(compacted);

    // Invariant (one hop) — archive ∩ direct retained references = ∅: in this
    // single-round shape every slimmed message's sourceEntryId still resolves
    // inside the slimmed id set. Across multiple rounds the guarantee is one
    // hop: each newest clone's direct predecessor stays addressable; older
    // dangling references resolve again after the archive merge-back reload
    // (storage reconcile path, pinned by the epoch-2 reader test).
    const slimmedIds = new Set(slimmedLineage.entries.map((entry) => entry.id));
    for (const marker of slimmedLineage.entries) {
      if (marker.type !== 'archive_marker' || marker.parentId === null) continue;
      expect(slimmedIds.has(marker.parentId)).toBe(true);
    }
    for (const entry of messageEntries(slimmedLineage)) {
      if (entry.sourceEntryId === undefined || entry.sourceEntryId === entry.id) continue;
      expect(slimmedIds.has(entry.sourceEntryId)).toBe(true);
    }
    const archivedIds = new Set(archivedEntries.map((entry) => entry.id));
    expect(archivedIds.has(retainedClone.sourceEntryId)).toBe(false);
  });

  it('bounds retained predecessor generations across repeated compaction cycles', () => {
    const initial = createSessionLineage([
      createTextMessage('user', 'bounded round one'),
      createTextMessage('assistant', 'bounded answer one'),
      createTextMessage('user', 'bounded round two'),
      createTextMessage('assistant', 'bounded answer two'),
    ]);
    let working = initial;
    for (const summary of ['First cycle', 'Second cycle', 'Third cycle']) {
      const activeTail = getSessionLineagePath(working)
        .filter((entry): entry is KodaXSessionMessageEntry => entry.type === 'message')
        .at(-1)!;
      const compacted = applySessionCompaction(
        working,
        [
          { role: 'system', content: `[对话历史摘要]\n\n${summary}` },
          activeTail.message,
        ],
        { summary },
      );
      working = archiveOldIslands(compacted).slimmedLineage;
    }

    // Each cycle may retain at most one extra direct-predecessor generation,
    // so three consecutive compactions must not accumulate retained message
    // entries generation after generation.
    expect(messageEntries(working).length).toBeLessThanOrEqual(2);

    const latestClone = getSessionLineagePath(working)
      .filter((entry): entry is KodaXSessionMessageEntry => entry.type === 'message')
      .at(-1)!;
    const retainedIds = new Set(working.entries.map((entry) => entry.id));
    expect(latestClone.sourceEntryId).toBeDefined();
    expect(retainedIds.has(latestClone.sourceEntryId!)).toBe(true);
  });
});

describe('FEATURE_072: postCompactAttachments and slicer-layer emission', () => {
  const userMsg = createTextMessage('user', 'task start');
  const asstMsg = createTextMessage('assistant', 'done');
  const keptUser = createTextMessage('user', 'follow up');
  const keptAsst = createTextMessage('assistant', 'latest');

  function att(role: 'system' | 'user', text: string): KodaXMessage {
    return { role, content: text };
  }

  it('getContextMessagesForEntry contract: every entry in the active path produces ≤1 message (073 prerequisite)', () => {
    // The contract: the derivation count equals the count of "message-producing"
    // entries on the active path. archive_marker produces 0; compaction,
    // message, branch_summary each produce exactly 1. Attachments come
    // EXCLUSIVELY through the slicer-layer augmentation — not from
    // getContextMessagesForEntry.
    const lineageNoAttach = applySessionCompaction(
      createSessionLineage([userMsg, asstMsg]),
      [att('system', '[对话历史摘要]\n\nS'), keptUser, keptAsst],
      { summary: 'S' },
    );
    const activePath = getSessionLineagePath(lineageNoAttach);
    const derivedNoAttach = getSessionMessagesFromLineage(lineageNoAttach);
    const messageProducingEntries = activePath.filter(
      (e) => e.type === 'compaction' || e.type === 'message' || e.type === 'branch_summary',
    ).length;
    expect(derivedNoAttach.length).toBe(messageProducingEntries);
  });

  it('slicer inlines attachments for non-rewind compaction entries', () => {
    const attachments: readonly KodaXMessage[] = [
      att('system', '[Post-compact: ledger summary]'),
      att('system', '[Post-compact: file contents]'),
    ];
    const lineage = applySessionCompaction(
      createSessionLineage([userMsg, asstMsg]),
      [att('system', '[对话历史摘要]\n\nS'), keptUser, keptAsst],
      { summary: 'S' },
      attachments,
    );

    const derived = getSessionMessagesFromLineage(lineage);

    // Find the summary message index; attachments should follow immediately.
    const summaryIdx = derived.findIndex((m) =>
      typeof m.content === 'string' && m.content.includes('[对话历史摘要]'),
    );
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(derived[summaryIdx + 1]?.content).toBe('[Post-compact: ledger summary]');
    expect(derived[summaryIdx + 2]?.content).toBe('[Post-compact: file contents]');
  });

  it('slicer skips rewind marker entries', () => {
    const base = createSessionLineage([userMsg, asstMsg]);
    const rewoundLineage = rewindSessionLineage(base, base.entries[0]!.id);
    expect(rewoundLineage).not.toBeNull();
    expect(rewoundLineage!.entries.at(-1)?.type).toBe('rewind_marker');

    const derived = getSessionMessagesFromLineage(rewoundLineage!);
    expect(derived).toEqual([userMsg]);
  });

  it('slicer skips legacy rewind compaction entries', () => {
    const base = createSessionLineage([userMsg, asstMsg]);
    const targetId = base.entries[0]!.id;
    const legacyRewindId = 'entry_legacy_rewind';
    const legacyRewindLineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: legacyRewindId,
      entries: [
        base.entries[0]!,
        {
          type: 'compaction',
          id: legacyRewindId,
          parentId: targetId,
          timestamp: '2026-07-07T01:00:00.000Z',
          logicalId: legacyRewindId,
          summary: '[Rewind] Rewound to entry entry_user (truncated 1 entries)',
          firstKeptEntryId: targetId,
          tokensBefore: 20,
          tokensAfter: 5,
          reason: 'rewind',
          details: { rewindTargetId: targetId, truncatedCount: 1 },
          postCompactAttachments: [att('system', 'should stay out of context')],
        },
      ],
    };

    expect(getSessionMessagesFromLineage(legacyRewindLineage)).toEqual([userMsg]);
  });

  it('applySessionCompaction with no attachments leaves field undefined (zero overhead for existing callers)', () => {
    const lineage = applySessionCompaction(
      createSessionLineage([userMsg, asstMsg]),
      [att('system', '[对话历史摘要]\n\nS'), keptAsst],
      { summary: 'S' },
      // no attachments
    );
    const ce = lineage.entries.find((e) => e.type === 'compaction');
    expect(ce).toBeDefined();
    if (ce && ce.type === 'compaction') {
      expect(ce.postCompactAttachments).toBeUndefined();
    }
  });

  it('applySessionCompaction stores attachments on the CompactionEntry, not as inline messages', () => {
    // Structural strip invariant: compactedMessages (kept tail) should NOT
    // include [Post-compact: ...] entries; callers pass them separately.
    const attachments: readonly KodaXMessage[] = [
      att('system', '[Post-compact: ledger]'),
      att('user', '[Post-compact: file.ts contents]'),
    ];
    const lineage = applySessionCompaction(
      createSessionLineage([userMsg]),
      [att('system', '[对话历史摘要]\n\nS'), keptUser],
      { summary: 'S' },
      attachments,
    );

    // Attachments live on the CompactionEntry.
    const ce = lineage.entries.find((e) => e.type === 'compaction');
    expect(ce?.type).toBe('compaction');
    if (ce && ce.type === 'compaction') {
      expect(ce.postCompactAttachments?.length).toBe(2);
    }

    // Attachments do NOT appear as standalone `message` entries.
    const postCompactMessageEntries = lineage.entries.filter(
      (e) =>
        e.type === 'message'
        && typeof e.message.content === 'string'
        && e.message.content.startsWith('[Post-compact:'),
    );
    expect(postCompactMessageEntries).toHaveLength(0);
  });

  it('retains committed output ownership when old message bodies are evicted', () => {
    const original = createSessionLineage([userMsg, { ...asstMsg, outputId: 'archived-output' }]);
    const compacted = applySessionCompaction(original,
      [att('system', '[对话历史摘要]\n\nNew island'), keptUser], { summary: 'New island' });
    const evicted = evictOldIslandMessageContent(compacted);
    const output = evicted.entries.find(entry => entry.type === 'message' && entry.message.outputId === 'archived-output');
    expect(output?.type === 'message' ? output.message : undefined).toMatchObject({
      outputId: 'archived-output', content: [{ type: 'text', text: '[compacted]' }],
    });
  });

  it('evictOldIslandMessageContent strips postCompactAttachments on old-island compaction entries, preserves memorySeed and summary', () => {
    // Build island 1 with attachments
    const base1 = createSessionLineage([userMsg, asstMsg]);
    const island1 = applySessionCompaction(
      base1,
      [att('system', '[对话历史摘要]\n\nIsland1'), keptUser],
      {
        summary: 'Island1',
        memorySeed: {
          objective: 'obj1',
          constraints: [],
          progress: { completed: [], inProgress: [], blockers: [] },
          keyDecisions: [],
          nextSteps: [],
          keyContext: [],
          importantTargets: [],
          tombstones: [],
        },
      },
      [att('system', '[Post-compact: island1 att]')],
    );

    // Build island 2 on top. Compaction itself must keep exact payload until a
    // durable host acknowledgement explicitly authorizes in-memory eviction.
    const island2 = applySessionCompaction(
      island1,
      [att('system', '[对话历史摘要]\n\nIsland2'), keptAsst],
      { summary: 'Island2' },
      [att('system', '[Post-compact: island2 att]')],
    );

    const durableIsland1 = island2.entries.find(
      (e) => e.type === 'compaction' && e.summary === 'Island1',
    );
    expect(durableIsland1?.type).toBe('compaction');
    if (durableIsland1?.type === 'compaction') {
      expect(durableIsland1.postCompactAttachments?.length).toBe(1);
    }

    const evictedIsland2 = evictOldIslandMessageContent(island2);

    // Find all compaction entries
    const compactionEntries = evictedIsland2.entries.filter((e) => e.type === 'compaction');
    expect(compactionEntries.length).toBeGreaterThanOrEqual(2);

    // Island 1's compaction entry (the older one) must have:
    //   - summary preserved
    //   - memorySeed preserved
    //   - postCompactAttachments stripped (undefined)
    const island1CE = compactionEntries.find((e) => e.type === 'compaction' && e.summary === 'Island1');
    expect(island1CE).toBeDefined();
    if (island1CE && island1CE.type === 'compaction') {
      expect(island1CE.summary).toBe('Island1');
      expect(island1CE.memorySeed?.objective).toBe('obj1');
      expect(island1CE.postCompactAttachments).toBeUndefined();
    }

    // Island 2's compaction entry (active) must RETAIN attachments
    const island2CE = compactionEntries.find((e) => e.type === 'compaction' && e.summary === 'Island2');
    expect(island2CE).toBeDefined();
    if (island2CE && island2CE.type === 'compaction') {
      expect(island2CE.postCompactAttachments?.length).toBe(1);
    }
  });

  it('forkSessionLineage carries postCompactAttachments to the new branch via cloneForkableEntry', () => {
    const attachments: readonly KodaXMessage[] = [att('system', '[Post-compact: file-A]')];
    const lineage = applySessionCompaction(
      createSessionLineage([userMsg]),
      [att('system', '[对话历史摘要]\n\nS'), keptUser],
      { summary: 'S' },
      attachments,
    );

    const ce = lineage.entries.find((e) => e.type === 'compaction');
    expect(ce).toBeDefined();
    const forked = forkSessionLineage(lineage, ce!.id);
    expect(forked).not.toBeNull();

    const forkedCE = forked!.entries.find(
      (e) => e.type === 'compaction' && e.summary === 'S',
    );
    expect(forkedCE).toBeDefined();
    if (forkedCE && forkedCE.type === 'compaction') {
      // Attachments survived the fork (not dropped by manual field enumeration)
      expect(forkedCE.postCompactAttachments?.length).toBe(1);
      expect(forkedCE.postCompactAttachments?.[0]?.content).toBe('[Post-compact: file-A]');
      // And they are a DEEP clone — mutating the clone doesn't affect the original
      expect(forkedCE.postCompactAttachments).not.toBe(attachments);
    }
  });
});

describe('FEATURE_072 Phase B: attachments routing + strip invariant + benchmark', () => {
  function msg(role: 'user' | 'assistant' | 'system', content: string): KodaXMessage {
    return { role, content };
  }

  it('applySessionCompaction defensively strips inline [Post-compact:] messages from compactedMessages', () => {
    // Simulates agent.ts calling injectPostCompactAttachments first (P4), then
    // emitting the inlined array to REPL. applySessionCompaction must NOT
    // double-store attachments as inline message entries.
    //
    // Real post-compact attachments use role: 'system' (see
    // buildPostCompactAttachments / buildFileContentMessages); the strip
    // contract targets this shape.
    const inlinedCompacted: KodaXMessage[] = [
      msg('system', '[对话历史摘要]\n\nS'),
      msg('system', '[Post-compact: recent operations]\nledger text'),
      msg('system', '[Post-compact: file-a.ts contents]\n...'),
      msg('user', 'kept user follow-up'),
    ];
    const attachments: readonly KodaXMessage[] = [
      msg('system', '[Post-compact: recent operations]\nledger text'),
      msg('system', '[Post-compact: file-a.ts contents]\n...'),
    ];
    const lineage = applySessionCompaction(
      createSessionLineage([msg('user', 'start')]),
      inlinedCompacted,
      { summary: 'S' },
      attachments,
    );

    // No message entry in lineage should start with [Post-compact:
    const badEntries = lineage.entries.filter(
      (e) =>
        e.type === 'message'
        && typeof e.message.content === 'string'
        && e.message.content.startsWith('[Post-compact:'),
    );
    expect(badEntries).toHaveLength(0);

    // Attachments live on the compaction entry only
    const ce = lineage.entries.find((e) => e.type === 'compaction');
    expect(ce?.type).toBe('compaction');
    if (ce && ce.type === 'compaction') {
      expect(ce.postCompactAttachments?.length).toBe(2);
    }
  });

  it('acceptance #5: derived view structurally equals the flat `compacted` array after a compaction (post-072 wire-level parity)', () => {
    // Simulates the agent.ts → REPL flow: agent fires onCompactedMessages with
    // `[summary, ...attachments, ...kept]` inlined; REPL calls
    // applySessionCompaction with attachments passed separately. The derived
    // view must produce the SAME message shape (role + content) as the flat
    // array the agent sent — if this ever drifts, the REPL's context.messages
    // (which is set = flat array) would diverge from what future lineage
    // derivations produce, reintroducing dual-source-of-truth.
    const summary: KodaXMessage = {
      role: 'user',
      content: `${COMPACTION_SUMMARY_PREFIX}Acceptance5-summary${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`,
      _synthetic: true,
      _source: 'compaction-checkpoint',
    };
    const att1 = msg('system', '[Post-compact: ledger summary]');
    const att2 = msg('system', '[Post-compact: file-a contents]');
    const kept1 = msg('user', 'kept-user-1');
    const kept2 = msg('assistant', 'kept-assistant-1');

    // The array agent.ts would emit (post-inject, P4 belt-and-suspenders):
    const flatCompactedFromAgent: KodaXMessage[] = [summary, att1, att2, kept1, kept2];

    // REPL's handler effectively does:
    const lineage = applySessionCompaction(
      createSessionLineage([msg('user', 'pre-ctx')]),
      flatCompactedFromAgent,    // defensively stripped of [Post-compact:…] inside
      { summary: 'Acceptance5-summary' },
      [att1, att2],              // attachments passed separately
    );

    // Derived view drawn from lineage:
    const derived = getSessionMessagesFromLineage(lineage);

    // Acceptance invariant: structural equality on role + content across the
    // full active-path tail. The active path starts from the compaction entry
    // (copy-style, new island), so derived = [summary, att1, att2, kept1, kept2].
    expect(derived).toHaveLength(flatCompactedFromAgent.length);
    for (let i = 0; i < derived.length; i++) {
      expect(derived[i]!.role).toBe(flatCompactedFromAgent[i]!.role);
      expect(derived[i]!.content).toEqual(flatCompactedFromAgent[i]!.content);
    }
  });

  it('acceptance #12: rewind landing on a compaction with attachments emits them in the derived view', () => {
    // Rewind audit markers are context-silent. But if a user rewinds TO
    // (not past) an existing compaction entry that carries real attachments,
    // the derived view from the new leaf must still include those attachments
    // so the LLM retains the compressed state.
    const pre = createSessionLineage([
      msg('user', 'u0'),
      msg('assistant', 'a0'),
    ]);
    const ledger = msg('system', '[Post-compact: ledger for file-X]');
    const fileAtt = msg('system', '[Post-compact: file-X contents]');
    const withCompaction = applySessionCompaction(
      pre,
      [msg('system', '[对话历史摘要]\n\nS'), msg('user', 'u1'), msg('assistant', 'a1')],
      { summary: 'S' },
      [ledger, fileAtt],
    );

    // Locate the compaction entry carrying attachments and rewind to it.
    const ceWithAtt = withCompaction.entries.find(
      (e) => e.type === 'compaction' && e.postCompactAttachments && e.postCompactAttachments.length > 0,
    );
    expect(ceWithAtt).toBeDefined();
    const rewound = rewindSessionLineage(withCompaction, ceWithAtt!.id);
    expect(rewound).not.toBeNull();

    // After rewind, the new active leaf is the synthetic rewind marker; its
    // parent chain still includes the original compaction entry with
    // attachments, so the derived view must emit them.
    const derived = getSessionMessagesFromLineage(rewound!);
    const derivedContents = derived.map((m) => typeof m.content === 'string' ? m.content : '[complex]');
    expect(derivedContents.some((c) => c.includes('[Post-compact: ledger for file-X]'))).toBe(true);
    expect(derivedContents.some((c) => c.includes('[Post-compact: file-X contents]'))).toBe(true);
  });

  it('applyLineageTruncation reconciles lineage against trimmed messages without appending a CompactionEntry', () => {
    const initial = createSessionLineage([
      msg('user', 'u1'),
      msg('assistant', 'a1'),
      msg('user', 'u2'),
      msg('assistant', 'a2'),
    ]);
    const preCECount = initial.entries.filter((e) => e.type === 'compaction').length;
    expect(preCECount).toBe(0);

    // Simulate graceful trimming: drop u1 + a1
    const trimmed = [msg('user', 'u2'), msg('assistant', 'a2')];
    const result = applyLineageTruncation(initial, trimmed);

    // No new CompactionEntry was appended (graceful is NOT a summary)
    const postCECount = result.entries.filter((e) => e.type === 'compaction').length;
    expect(postCECount).toBe(0);

    // Derived view matches trimmed messages
    const derived = getSessionMessagesFromLineage(result);
    expect(derived.map((m) => m.content)).toEqual(['u2', 'a2']);
  });

  it('benchmark guard: getSessionMessagesFromLineage on 500-entry lineage completes quickly', () => {
    // Build a lineage with 500 message entries via iterative createSessionLineage
    // calls (not a single one — createSessionLineage's fingerprint matching
    // works across calls using an existing base).
    let lineage = createSessionLineage([]);
    for (let i = 0; i < 500; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      const m: KodaXMessage = { role, content: `message-${i}` };
      const allMessages: KodaXMessage[] = [];
      for (let j = 0; j <= i; j++) {
        allMessages.push({ role: j % 2 === 0 ? 'user' : 'assistant', content: `message-${j}` });
      }
      lineage = createSessionLineage(allMessages, lineage);
    }
    expect(lineage.entries.length).toBeGreaterThanOrEqual(500);

    // Warm-up call (populates fingerprint cache)
    getSessionMessagesFromLineage(lineage);

    const iterations = 10;
    const durations: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      getSessionMessagesFromLineage(lineage);
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    // p95 index for 10 samples = index 9 (0-indexed, ceil(10 * 0.95) = 10 → clamp to 9)
    const p95 = durations[9]!;
    // Ship-criterion: < 1ms p95 on warm cache. Unit-test runners can add
    // scheduler noise under full-suite load, so keep this as a broad regression
    // guard rather than a micro-benchmark.
    // If this fails consistently, add memoization per Open Question #1.
    expect(p95).toBeLessThan(20);
  });
});

describe('FEATURE_180 (v0.7.42): system message content-hash dedup at applySessionCompaction', () => {
  // Forensic background: 788-session scan found 47% of sessions persist 2+
  // duplicate copies of the Repository Intelligence system block (~13K each;
  // worst case 65 copies). Multiple write paths (compaction commit + handoff
  // replaceSystemMessage + V2 swap) each append the same instructions block
  // as a new lineage entry. The dedup at applySessionCompaction is the single
  // chokepoint where every compaction-emitted message array passes through.

  const RI_BLOCK = 'A'.repeat(50) + '\n## Repository Intelligence\n' + 'B'.repeat(100);
  const userMsg: KodaXMessage = { role: 'user', content: 'task' };
  const keptUser: KodaXMessage = { role: 'user', content: 'follow up' };

  it('drops exact duplicate system messages while keeping the first occurrence', () => {
    const compacted: KodaXMessage[] = [
      { role: 'system', content: RI_BLOCK },           // keep
      { role: 'system', content: '[对话历史摘要]\n\nS' }, // keep (different content)
      { role: 'system', content: RI_BLOCK },           // drop (duplicate of first)
      keptUser,
      { role: 'system', content: RI_BLOCK },           // drop (still duplicate)
    ];
    const lineage = applySessionCompaction(
      createSessionLineage([userMsg]),
      compacted,
      { summary: 'S' },
    );
    const derived = getSessionMessagesFromLineage(lineage);
    const riOccurrences = derived.filter(
      (m) => m.role === 'system' && m.content === RI_BLOCK,
    ).length;
    expect(riOccurrences).toBe(1);
    // Summary system message still present
    expect(derived.some((m) => m.role === 'system' && m.content === '[对话历史摘要]\n\nS'))
      .toBe(true);
    // User message preserved
    expect(derived.some((m) => m.role === 'user' && m.content === 'follow up'))
      .toBe(true);
  });

  it('preserves system messages with different content (e.g. handoff role switch)', () => {
    const compacted: KodaXMessage[] = [
      { role: 'system', content: 'Worker instructions A' },
      { role: 'system', content: '[对话历史摘要]\n\nS' },
      { role: 'system', content: 'Evaluator instructions B' }, // different role basePrompt
      keptUser,
    ];
    const lineage = applySessionCompaction(
      createSessionLineage([userMsg]),
      compacted,
      { summary: 'S' },
    );
    const derived = getSessionMessagesFromLineage(lineage);
    const systemContents = derived.filter((m) => m.role === 'system').map((m) => m.content);
    expect(systemContents).toContain('Worker instructions A');
    expect(systemContents).toContain('Evaluator instructions B');
    expect(systemContents).toContain('[对话历史摘要]\n\nS');
  });

  it('does NOT dedup duplicate user/assistant messages (legitimate repeated content must survive)', () => {
    // User may genuinely repeat themselves; assistant may emit identical
    // boilerplate. Dedup is strictly for system blocks where bytewise
    // identity = redundant copy from multiple write paths.
    const compacted: KodaXMessage[] = [
      { role: 'system', content: '[对话历史摘要]\n\nS' },
      { role: 'user', content: 'same question' },
      { role: 'assistant', content: 'noted' },
      { role: 'user', content: 'same question' },          // duplicate user
      { role: 'assistant', content: 'noted' },             // duplicate assistant
    ];
    const lineage = applySessionCompaction(
      createSessionLineage([userMsg]),
      compacted,
      { summary: 'S' },
    );
    const derived = getSessionMessagesFromLineage(lineage);
    const userDups = derived.filter((m) => m.role === 'user' && m.content === 'same question').length;
    const asstDups = derived.filter((m) => m.role === 'assistant' && m.content === 'noted').length;
    expect(userDups).toBe(2);
    expect(asstDups).toBe(2);
  });

  it('handles array-content system messages (not deduped — only string-content is checked)', () => {
    // System messages with array content are rare in practice but must not
    // crash the dedup pass. We choose not to serialize array content for
    // comparison: the cost would multiply and the duplication issue is
    // empirically all string-content blocks (RI / summary).
    const arrayContent = [{ type: 'text' as const, text: RI_BLOCK }];
    const compacted: KodaXMessage[] = [
      { role: 'system', content: arrayContent },
      { role: 'system', content: arrayContent },
      keptUser,
    ];
    const lineage = applySessionCompaction(
      createSessionLineage([userMsg]),
      compacted,
      { summary: 'S' },
    );
    const derived = getSessionMessagesFromLineage(lineage);
    // Both array-content system messages preserved (not deduped)
    const arrayContentSystems = derived.filter(
      (m) => m.role === 'system' && Array.isArray(m.content),
    );
    expect(arrayContentSystems.length).toBe(2);
  });

  it('is a no-op when there are no duplicates (zero behaviour change for normal sessions)', () => {
    const compacted: KodaXMessage[] = [
      {
        role: 'user',
        content: '[对话历史摘要]\n\nS',
        _synthetic: true,
        _source: 'compaction-checkpoint',
      },
      keptUser,
    ];
    const lineage = applySessionCompaction(
      createSessionLineage([userMsg]),
      compacted,
      { summary: 'S' },
    );
    const derived = getSessionMessagesFromLineage(lineage);
    expect(derived.length).toBe(2);
    expect(derived[0]?.role).toBe('user');
    expect(derived[0]?._source).toBe('compaction-checkpoint');
    expect(derived[1]?.content).toBe('follow up');
  });

  it('composes with the existing [Post-compact:] strip (no regression on FEATURE_072)', () => {
    // Both filters run: Post-compact strip first, then dedup.
    const compacted: KodaXMessage[] = [
      { role: 'system', content: '[Post-compact: ledger]' }, // strip (Post-compact)
      { role: 'system', content: RI_BLOCK },                 // keep
      { role: 'system', content: '[对话历史摘要]\n\nS' },     // keep
      { role: 'system', content: RI_BLOCK },                 // drop (duplicate RI)
      keptUser,
    ];
    const lineage = applySessionCompaction(
      createSessionLineage([userMsg]),
      compacted,
      { summary: 'S' },
    );
    const derived = getSessionMessagesFromLineage(lineage);
    const postCompact = derived.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith('[Post-compact:'),
    );
    expect(postCompact.length).toBe(0);
    const ri = derived.filter((m) => m.role === 'system' && m.content === RI_BLOCK);
    expect(ri.length).toBe(1);
  });
});
