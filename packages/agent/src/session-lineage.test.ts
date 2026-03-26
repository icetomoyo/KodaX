import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax/ai';
import {
  appendSessionLineageLabel,
  buildSessionTree,
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
});
