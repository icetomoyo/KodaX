import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';
import {
  createSessionLineage,
  getSessionMessageEntryId,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
} from './kodax-session-lineage.js';

describe('delivered interrupt identity during ordinary reconciliation', () => {
  it('retains proven identity when an earlier context message changes', () => {
    const initial: KodaXMessage = { role: 'user', content: 'initial' };
    const delivered: KodaXMessage = { role: 'user', content: 'follow-up', turnId: 'queued-turn' };
    const previous = createSessionLineage([initial, delivered]);
    const deliveredEntryId = getSessionMessageEntryId(delivered);
    const changedPrefix: KodaXMessage = { role: 'user', content: 'recovered context', _synthetic: true };
    const reconciled = createSessionLineage([changedPrefix, delivered], previous);
    const active = getSessionLineagePath(reconciled).at(-1);
    expect(active?.logicalId).toBe(deliveredEntryId);
    expect(active?.sourceEntryId).toBe(deliveredEntryId);
  });

  it('retains identity from reloaded lineage messages across a later save', () => {
    const saved = createSessionLineage([{ role: 'user', content: 'initial' },
      { role: 'user', content: 'follow-up', turnId: 'queued-turn' }]);
    const loaded = structuredClone(saved);
    const messages = getSessionMessagesFromLineage(loaded);
    const next = createSessionLineage([{ role: 'user', content: 'runtime context', _synthetic: true },
      ...messages], structuredClone(saved));
    expect(getSessionLineagePath(next).at(-1)?.logicalId).toBe(saved.activeEntryId);
  });

  it('does not infer an alias from equal text, turn or timestamp', () => {
    const original: KodaXMessage = { role: 'user', content: 'repeat', turnId: 'same-turn',
      timestamp: '2026-09-11T02:24:03.231Z' };
    const saved = createSessionLineage([original]);
    const repeated = { ...original };
    const rewritten = createSessionLineage([{ role: 'user', content: 'new context', _synthetic: true },
      repeated], saved);
    const entry = getSessionLineagePath(rewritten).at(-1);
    expect(entry?.logicalId).toBe(entry?.id);
    expect(entry?.logicalId).not.toBe(saved.activeEntryId);
    expect(entry?.sourceEntryId).toBeUndefined();
  });

  it('keeps an intentionally repeated appended query distinct', () => {
    const original: KodaXMessage = { role: 'user', content: 'repeat' };
    const saved = createSessionLineage([original]);
    const extended = createSessionLineage([original, { ...original }], saved);
    const entries = getSessionLineagePath(extended);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.logicalId).not.toBe(entries[1]?.logicalId);
    expect(entries[1]?.sourceEntryId).toBeUndefined();
  });
});
