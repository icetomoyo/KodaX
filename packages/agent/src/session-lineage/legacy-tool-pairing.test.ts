import { describe, expect, it } from 'vitest';
import type { KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';
import type {
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
} from '../index.js';
import { COMPACTION_SUMMARY_PREFIX } from './compaction/compaction.js';
import {
  applySessionCompaction,
  createSessionLineage,
  forkSessionLineage,
  getSessionLineagePath,
  getSessionMessageEntryId,
  getSessionMessagesFromLineage,
} from './kodax-session-lineage.js';
import {
  createLegacyToolPairingLookup,
  findLegacyToolPairingRestorations,
  legacyAdjacentToolPairingProjection,
  type LegacyToolPairingLookup,
} from './legacy-tool-pairing.js';

const T = '2026-07-29T00:00:00.000Z';

const query: KodaXMessage = { role: 'user', content: 'inspect two files', timestamp: T };
const call: KodaXMessage = {
  role: 'assistant',
  timestamp: T,
  content: [
    { type: 'text', text: 'Reading both files.' },
    { type: 'tool_use', id: 'tool-a', name: 'read', input: { path: 'a.ts' } },
    { type: 'tool_use', id: 'tool-b', name: 'read', input: { path: 'b.ts' } },
  ],
};
const results: KodaXMessage = {
  role: 'user',
  timestamp: T,
  content: [
    { type: 'tool_result', tool_use_id: 'tool-a', content: 'A' },
    { type: 'tool_result', tool_use_id: 'tool-b', content: 'B' },
  ],
};
const ctx: KodaXMessage = {
  role: 'user',
  timestamp: T,
  content: '=== Managed Run Context ===\nround 2',
  _synthetic: true,
  _source: 'managed-run-context',
};
const callToolUses = (call.content as KodaXContentBlock[]).slice(1);
const next: KodaXMessage = { role: 'assistant', content: 'Both files read.', timestamp: T };
const newQuery: KodaXMessage = { role: 'user', content: 'next request', timestamp: T };
// Shapes the adjacent-only cleanup produced when ctx split the tool pair.
const strippedCall: KodaXMessage = {
  ...call,
  content: [{ type: 'text', text: 'Reading both files.' }],
};
const strippedResults: KodaXMessage = { ...results, content: [{ type: 'text', text: '' }] };

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function msg(
  id: string,
  parentId: string | null,
  message: KodaXMessage,
  provenance?: string,
): KodaXSessionMessageEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: T,
    logicalId: provenance ?? id,
    ...(provenance !== undefined ? { sourceEntryId: provenance } : {}),
    message: copy(message),
  };
}

/**
 * Minimal de-identified topology of the damaged session: a complete retained
 * copy (s_*) and the damaged active continuation (d_*) share k_query; y_* are
 * the next compaction-style copies of the damaged entries.
 */
function fixtureEntries(): KodaXSessionEntry[] {
  return [
    msg('p_query', null, query),
    msg('p_call', 'p_query', call),
    msg('p_result', 'p_call', results),
    {
      type: 'compaction',
      id: 'c1',
      parentId: null,
      timestamp: T,
      logicalId: 'c1',
      summary: 'summary',
      firstKeptEntryId: 'k_query',
    },
    msg('k_query', 'c1', query, 'p_query'),
    msg('s_call', 'k_query', call, 'p_call'),
    msg('s_ctx', 's_call', ctx),
    msg('s_result', 's_ctx', results, 'p_result'),
    msg('d_call', 'k_query', strippedCall),
    msg('d_ctx', 'd_call', ctx, 's_ctx'),
    msg('d_result', 'd_ctx', strippedResults),
    msg('d_next', 'd_result', next),
    msg('y_result', 'd_call', strippedResults, 'd_result'),
    msg('y_next', 'y_result', next, 'd_next'),
    msg('n_new', 'y_next', newQuery),
  ];
}

function fixture(
  mutate?: (entries: KodaXSessionEntry[]) => void,
  activeEntryId = 'n_new',
): KodaXSessionLineage {
  const entries = fixtureEntries();
  mutate?.(entries);
  return { version: 2, activeEntryId, entries };
}

function replace(
  entries: KodaXSessionEntry[],
  id: string,
  update: (entry: KodaXSessionMessageEntry) => KodaXSessionMessageEntry,
): void {
  const index = entries.findIndex((entry) => entry.id === id);
  entries[index] = update(entries[index] as KodaXSessionMessageEntry);
}

function entryById(lineage: KodaXSessionLineage, id: string): KodaXSessionEntry {
  return lineage.entries.find((entry) => entry.id === id)!;
}

function restorationsFor(lineage: KodaXSessionLineage) {
  return findLegacyToolPairingRestorations(
    getSessionLineagePath(lineage),
    createLegacyToolPairingLookup(lineage.entries),
  );
}

describe('legacy adjacent-only tool-pairing restoration', () => {
  it('renders the proven pre-projection content on the damaged active path', () => {
    const rendered = getSessionMessagesFromLineage(fixture());

    expect(String(rendered[0]?.content).startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
    expect(rendered.slice(1)).toEqual([query, call, results, next, newQuery]);
  });

  it('reports only restorations proven by a unique retained sibling chain', () => {
    const restorations = restorationsFor(fixture());

    expect([...restorations.keys()]).toEqual(['d_call', 'y_result']);
    expect(restorations.get('d_call')).toMatchObject({
      evidenceEntryId: 's_call',
      logicalId: 'p_call',
      sourceEntryId: 'p_call',
      message: call,
    });
    expect(restorations.get('y_result')).toMatchObject({
      evidenceEntryId: 's_result',
      logicalId: 'p_result',
      sourceEntryId: 'p_result',
      message: results,
    });
  });

  it('attributes restored messages to their physical path entries', () => {
    const rendered = getSessionMessagesFromLineage(fixture());

    expect(getSessionMessageEntryId(rendered[2]!)).toBe('d_call');
    expect(getSessionMessageEntryId(rendered[3]!)).toBe('y_result');
  });

  it('reconciles a re-save of the restored context without new entries', () => {
    const lineage = fixture();
    const rendered = getSessionMessagesFromLineage(lineage);

    const same = createSessionLineage(rendered, lineage);
    expect(same.entries).toHaveLength(lineage.entries.length);
    expect(same.activeEntryId).toBe('n_new');

    const extended = createSessionLineage(
      [...rendered, { role: 'assistant', content: 'answer', timestamp: T }],
      lineage,
    );
    expect(extended.entries).toHaveLength(lineage.entries.length + 1);
    expect(extended.entries.at(-1)?.parentId).toBe('n_new');
  });

  it('still matches a stale pre-restoration context without new entries', () => {
    const lineage = fixture();
    const rendered = getSessionMessagesFromLineage(lineage);
    const stale = [rendered[0]!, ...copy([query, strippedCall, strippedResults, next, newQuery])];

    const reconciled = createSessionLineage(stale, lineage);

    expect(reconciled.entries).toHaveLength(lineage.entries.length);
    expect(reconciled.activeEntryId).toBe('n_new');
  });

  it('attaches a divergent continuation below the restored path', () => {
    const lineage = fixture();
    const rendered = getSessionMessagesFromLineage(lineage);
    const divergent: KodaXMessage = { role: 'assistant', content: 'Different answer.', timestamp: T };

    const reconciled = createSessionLineage([...rendered.slice(0, 4), divergent], lineage);

    expect(reconciled.entries).toHaveLength(lineage.entries.length + 1);
    expect(reconciled.entries.at(-1)?.parentId).toBe('y_result');
  });

  it('carries restored content and proven identity into the next compaction', () => {
    const lineage = fixture();
    const rendered = getSessionMessagesFromLineage(lineage);

    const compacted = applySessionCompaction(
      lineage,
      [{ role: 'system', content: `${COMPACTION_SUMMARY_PREFIX}summary 2` }, ...rendered.slice(2)],
      { summary: 'summary 2' },
    );
    const copies = getSessionLineagePath(compacted)
      .filter((entry): entry is KodaXSessionMessageEntry => entry.type === 'message');

    expect(copies.map((entry) => entry.message)).toEqual([call, results, next, newQuery]);
    expect(copies.map((entry) => [entry.logicalId, entry.sourceEntryId])).toEqual([
      ['p_call', 'd_call'],
      ['p_result', 'y_result'],
      ['d_next', 'y_next'],
      ['n_new', 'n_new'],
    ]);
  });

  it('forks the restored content with its proven identity', () => {
    const forked = forkSessionLineage(fixture(), 'y_result');

    expect(forked).not.toBeNull();
    expect(getSessionMessagesFromLineage(forked!).slice(1)).toEqual([query, call, results]);
    const forkedPath = getSessionLineagePath(forked!);
    expect(forkedPath.slice(2).map((entry) => [entry.logicalId, entry.sourceEntryId])).toEqual([
      ['p_call', 'd_call'],
      ['p_result', 'y_result'],
    ]);
  });

  it('keeps the retained sibling branch and the persisted lineage untouched', () => {
    const lineage = fixture();
    const before = JSON.stringify(lineage);

    expect(getSessionMessagesFromLineage(lineage, 's_result').slice(1))
      .toEqual([query, call, ctx, results]);
    const first = getSessionMessagesFromLineage(lineage);
    const second = getSessionMessagesFromLineage(lineage);

    expect(second[2]).toBe(first[2]);
    expect(second[3]).toBe(first[3]);
    expect(JSON.stringify(lineage)).toBe(before);
    expect((entryById(lineage, 'd_call') as KodaXSessionMessageEntry).message).toEqual(strippedCall);
  });

  it.each<[string, (entries: KodaXSessionEntry[]) => void]>([
    ['a second explicit sibling competes for the evidence', (entries) => {
      entries.splice(8, 0, msg('s_other', 'k_query', call, 'p_call'));
    }],
    ['the sibling does not project onto the damaged message', (entries) => {
      replace(entries, 's_call', (entry) => ({
        ...entry,
        message: { ...call, content: [{ type: 'text', text: 'Other text.' }, ...callToolUses] },
      }));
    }],
    ['the sibling was appended after the damaged message', (entries) => {
      const [sibling] = entries.splice(5, 1);
      entries.splice(8, 0, sibling!);
    }],
    ['the managed context between the pair differs', (entries) => {
      replace(entries, 's_ctx', (entry) => ({ ...entry, message: { ...ctx, content: 'other ctx' } }));
    }],
    ['the sibling chain had continued with a live message', (entries) => {
      entries.splice(8, 0, msg('s_next', 's_result', next));
    }],
  ])('fails closed when %s', (_label, mutate) => {
    const lineage = fixture(mutate);

    expect(restorationsFor(lineage).size).toBe(0);
    expect(getSessionMessagesFromLineage(lineage).slice(2, 4))
      .toEqual([strippedCall, strippedResults]);
  });

  it.each<[string, (entries: KodaXSessionEntry[]) => void]>([
    ['below the shared anchor', (entries) => {
      entries.push(msg('later_query', 'k_query', newQuery));
    }],
    ['below the retained sibling chain', (entries) => {
      entries.push(msg('later_next', 's_result', next));
    }],
  ])('keeps a proven restoration when a later branch is appended %s', (_label, mutate) => {
    const lineage = fixture(mutate);

    expect([...restorationsFor(lineage).keys()]).toEqual(['d_call', 'y_result']);
    expect(getSessionMessagesFromLineage(lineage).slice(1))
      .toEqual([query, call, results, next, newQuery]);
  });

  it('keeps a path that ends inside the evidence chain raw', () => {
    const lineage = fixture(undefined, 'd_call');

    expect(restorationsFor(lineage).size).toBe(0);
    expect(getSessionMessagesFromLineage(lineage).slice(1)).toEqual([query, strippedCall]);
  });

  it('ignores side-state children when checking that the evidence chain is closed', () => {
    const lineage = fixture((entries) => {
      entries.push({ type: 'label', id: 'l1', parentId: 's_result', timestamp: T, targetId: 's_result' });
    });

    expect([...restorationsFor(lineage).keys()]).toEqual(['d_call', 'y_result']);
  });

  it('does not index the lineage when the path has no damaged candidate', () => {
    const untouchable: LegacyToolPairingLookup = {
      byId: () => { throw new Error('lookup used'); },
      children: () => { throw new Error('lookup used'); },
      appendIndex: () => { throw new Error('lookup used'); },
    };
    const compacted = fixture((entries) => {
      entries.push(msg('k_text', 'k_query', newQuery));
    }, 'k_text');
    const plain: KodaXSessionLineage = {
      version: 2,
      activeEntryId: 'u1',
      entries: [msg('u1', null, call)],
    };

    for (const lineage of [compacted, plain]) {
      expect(findLegacyToolPairingRestorations(getSessionLineagePath(lineage), untouchable).size)
        .toBe(0);
    }
  });

  it('checkpoints while indexing a large lineage', () => {
    const lineage = fixture((entries) => {
      for (let index = 0; index < 600; index += 1) {
        entries.push(msg(`other-${index}`, null, newQuery));
      }
    });
    let checks = 0;

    findLegacyToolPairingRestorations(
      getSessionLineagePath(lineage),
      createLegacyToolPairingLookup(lineage.entries, () => { checks += 1; }),
    );

    expect(checks).toBeGreaterThan(0);
  });

  it('restores damage that a pre-fix compaction copied into its retained region', () => {
    const lineage = recompactedFixture();

    expect([...restorationsFor(lineage).keys()]).toEqual(['z_call', 'z_result']);
    expect(restorationsFor(lineage).get('z_result')).toMatchObject({
      evidenceEntryId: 's_result',
      logicalId: 'p_result',
      message: results,
    });
    const rendered = getSessionMessagesFromLineage(lineage);
    expect(rendered.slice(1)).toEqual([query, call, results, next, newQuery, laterQuery]);
    expect(getSessionMessageEntryId(rendered[2]!)).toBe('z_call');
  });

  it('keeps the traced restoration as the re-compacted path grows', () => {
    const lineage = recompactedFixture((entries) => {
      entries.push(msg('n2_answer', 'n2_query', next));
    }, 'n2_answer');

    expect([...restorationsFor(lineage).keys()]).toEqual(['z_call', 'z_result']);
  });

  it.each<[string, (entries: KodaXSessionEntry[]) => void]>([
    ['a copy hop carries a different logical identity', (entries) => {
      replace(entries, 'z_result', (entry) => ({ ...entry, logicalId: 'unrelated' }));
    }],
    ['the retained region kept the damaged results without their call', (entries) => {
      const index = entries.findIndex((entry) => entry.id === 'z_query');
      entries.splice(index + 1, 1);
      replace(entries, 'z_result', (entry) => ({ ...entry, parentId: 'z_query' }));
    }],
    ['a copy no longer equals its damaged original', (entries) => {
      replace(entries, 'z_result', (entry) => ({ ...entry, message: copy(results) }));
    }],
  ])('fails closed on a re-compacted path when %s', (_label, mutate) => {
    const lineage = recompactedFixture(mutate);

    expect(restorationsFor(lineage).size).toBe(0);
  });

  it('bounds the evidence chain it is willing to follow', () => {
    expect([...restorationsFor(longChainLineage(4)).keys()]).toEqual(['d_call']);
    expect(restorationsFor(longChainLineage(70)).size).toBe(0);
  });
});

const laterQuery: KodaXMessage = { role: 'user', content: 'after the second compaction', timestamp: T };

/** A pre-fix copy: logicalId follows the source's identity, sourceEntryId the source entry. */
function legacyCopy(
  id: string,
  parentId: string,
  message: KodaXMessage,
  logicalId: string,
  sourceEntryId: string,
): KodaXSessionMessageEntry {
  return { type: 'message', id, parentId, timestamp: T, logicalId, sourceEntryId, message: copy(message) };
}

/**
 * The damaged fixture compacted again by a pre-fix build: the stripped path
 * content was copied below c2 with legacy provenance before any restorer ran.
 */
function recompactedFixture(
  mutate?: (entries: KodaXSessionEntry[]) => void,
  activeEntryId = 'n2_query',
): KodaXSessionLineage {
  const entries: KodaXSessionEntry[] = [
    ...fixtureEntries(),
    {
      type: 'compaction',
      id: 'c2',
      parentId: null,
      timestamp: T,
      logicalId: 'c2',
      summary: 'summary 2',
      firstKeptEntryId: 'z_query',
    },
    legacyCopy('z_query', 'c2', query, 'p_query', 'k_query'),
    legacyCopy('z_call', 'z_query', strippedCall, 'd_call', 'd_call'),
    legacyCopy('z_result', 'z_call', strippedResults, 'd_result', 'y_result'),
    legacyCopy('z_next', 'z_result', next, 'd_next', 'y_next'),
    legacyCopy('z_new', 'z_next', newQuery, 'n_new', 'n_new'),
    msg('n2_query', 'z_new', laterQuery),
  ];
  mutate?.(entries);
  return { version: 2, activeEntryId, entries };
}

function longChainLineage(steps: number): KodaXSessionLineage {
  const talk = (index: number): KodaXMessage => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `step ${index}`,
    timestamp: T,
  });
  const entries: KodaXSessionEntry[] = fixtureEntries().slice(3, 7);
  let retainedParent = 's_ctx';
  for (let index = 0; index < steps; index += 1) {
    entries.push(msg(`s_${index}`, retainedParent, talk(index), `p_${index}`));
    retainedParent = `s_${index}`;
  }
  entries.push(msg('d_call', 'k_query', strippedCall), msg('d_ctx', 'd_call', ctx, 's_ctx'));
  let damagedParent = 'd_ctx';
  for (let index = 0; index < steps; index += 1) {
    entries.push(msg(`d_${index}`, damagedParent, talk(index)));
    damagedParent = `d_${index}`;
  }
  return { version: 2, activeEntryId: damagedParent, entries };
}

describe('legacyAdjacentToolPairingProjection', () => {
  it('strips a tool pair that a managed context split', () => {
    expect(legacyAdjacentToolPairingProjection(call, query, ctx)).toEqual(strippedCall);
    expect(legacyAdjacentToolPairingProjection(results, ctx, next)).toEqual(strippedResults);
  });

  it('keeps an adjacent tool pair and plain text unchanged', () => {
    expect(legacyAdjacentToolPairingProjection(call, query, results)).toEqual(call);
    expect(legacyAdjacentToolPairingProjection(results, call, next)).toEqual(results);
    expect(legacyAdjacentToolPairingProjection(ctx, call, results)).toBe(ctx);
  });

  it('holds an assistant slot with an empty text block when nothing substantive survives', () => {
    const toolOnly: KodaXMessage = { role: 'assistant', content: callToolUses, timestamp: T };

    expect(legacyAdjacentToolPairingProjection(toolOnly, query, undefined).content)
      .toEqual([{ type: 'text', text: '' }]);
  });
});
