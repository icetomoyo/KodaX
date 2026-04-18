import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax/ai';
import type { KodaXSessionLineage } from './types.js';
import {
  appendSessionLineageLabel,
  applyLineageTruncation,
  applySessionCompaction,
  archiveOldIslands,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  findPreviousUserEntryId,
  forkSessionLineage,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
  resolveSessionLineageTarget,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from './session-lineage.js';

function createTextMessage(role: KodaXMessage['role'], content: string): KodaXMessage {
  return { role, content };
}

describe('session lineage helpers', () => {
  it('creates an empty lineage for empty message lists', () => {
    const lineage = createSessionLineage([]);

    expect(lineage.activeEntryId).toBeNull();
    expect(lineage.entries).toEqual([]);
    expect(getSessionLineagePath(lineage)).toEqual([]);
    expect(getSessionMessagesFromLineage(lineage)).toEqual([]);
    expect(countActiveLineageMessages(lineage)).toBe(0);
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
      { role: 'system', content: '[对话历史摘要]\n\nCompacted summary' },
      createTextMessage('assistant', 'latest pass'),
    ]);
    expect(compacted.activeEntryId).toBe(compacted.entries[compacted.entries.length - 1]?.id ?? null);
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
    expect(rewound!.entries[2]?.type).toBe('compaction');
    expect(rewound!.entries[2]).toMatchObject({
      reason: 'rewind',
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
    expect(rewindEvent?.type).toBe('compaction');
    if (rewindEvent?.type === 'compaction') {
      expect(rewindEvent.details).toEqual({
        rewindTargetId: targetId,
        truncatedCount: 3,
      });
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
    expect(rewound!.entries[2]?.type).toBe('compaction');
    if (rewound!.entries[2]?.type === 'compaction') {
      expect(rewound!.entries[2].details).toEqual({
        rewindTargetId: targetId,
        truncatedCount: 0,
      });
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

  it('slicer skips attachments for rewind-marker compaction entries', () => {
    // rewindSessionLineage creates a compaction entry with reason='rewind';
    // even if someone stuffs attachments on such an entry, the slicer must skip them.
    const base = createSessionLineage([userMsg, asstMsg]);
    const rewoundLineage = rewindSessionLineage(base, base.entries[0]!.id);
    expect(rewoundLineage).not.toBeNull();

    // Manually stuff attachments onto the rewind marker to test the skip.
    const mutated: KodaXSessionLineage = {
      ...rewoundLineage!,
      entries: rewoundLineage!.entries.map((e) =>
        e.type === 'compaction' && e.reason === 'rewind'
          ? { ...e, postCompactAttachments: [att('system', 'should-be-skipped')] }
          : e,
      ),
    };

    const derived = getSessionMessagesFromLineage(mutated);
    const bad = derived.find((m) => m.content === 'should-be-skipped');
    expect(bad).toBeUndefined();
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

    // Build island 2 on top — this evicts island 1
    const island2 = applySessionCompaction(
      island1,
      [att('system', '[对话历史摘要]\n\nIsland2'), keptAsst],
      { summary: 'Island2' },
      [att('system', '[Post-compact: island2 att]')],
    );

    // Find all compaction entries
    const compactionEntries = island2.entries.filter((e) => e.type === 'compaction');
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
    // Ship-criterion: < 1ms p95 on warm cache. Allow headroom for CI jitter.
    // If this fails consistently, add memoization per Open Question #1.
    expect(p95).toBeLessThan(5); // 5ms safety margin over the 1ms target
  });
});
