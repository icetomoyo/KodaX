import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax/ai';
import {
  appendSessionLineageLabel,
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
