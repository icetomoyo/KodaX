import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax/ai';
import {
  appendSessionLineageLabel,
  applySessionCompaction,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  forkSessionLineage,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
  resolveSessionLineageTarget,
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
});
