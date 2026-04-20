/**
 * Unit tests for LineageExtension.
 *
 * Scope:
 *   - Entry-type ownership declaration matches the legacy
 *     `KodaXSessionEntry` tagged union (minus the lineage-internal
 *     `activeEntryId` which Session expresses as a `rewind_marker` entry).
 *   - `label` / `attachArtifact` operators append entries with the correct
 *     type+payload shape.
 *   - `buildLineageTree` reducer projects a Session's entry stream to a
 *     tree whose topology matches the legacy lineage's rendering contract
 *     (messages on the spine; sidecar entries as children of the preceding
 *     message).
 *
 * Full byte-level equivalence with `KodaXSessionLineage` is out of scope for
 * v0.7.23 — that migration lands with FEATURE_082 (v0.7.24).
 */

import { describe, expect, it } from 'vitest';

import { createInMemorySession } from '@kodax/core';
import {
  LINEAGE_ENTRY_TYPES,
  LineageExtension,
  type LineageLabelPayload,
  type LineageTreeNode,
} from './lineage.js';

describe('LineageExtension', () => {
  it('declares the expected entry types', () => {
    expect(LineageExtension.name).toBe('lineage');
    expect([...LineageExtension.entryTypes]).toEqual([
      'message',
      'label',
      'compaction',
      'branch_summary',
      'archive_marker',
      'rewind_marker',
      'artifact_ledger',
    ]);
    expect([...LINEAGE_ENTRY_TYPES]).toEqual([...LineageExtension.entryTypes]);
  });

  it('exposes the documented operators and reducers', () => {
    expect(Object.keys(LineageExtension.operators ?? {})).toEqual(
      expect.arrayContaining(['label', 'attachArtifact']),
    );
    expect(Object.keys(LineageExtension.reducers ?? {})).toEqual(
      expect.arrayContaining(['buildLineageTree']),
    );
  });

  describe('label operator', () => {
    it('appends a label entry with targetId + label', async () => {
      const session = createInMemorySession();
      await session.append({ id: 'm1', ts: 0, type: 'message', payload: { role: 'user', content: 'hi' } });
      const labelOp = LineageExtension.operators!.label!;
      const id = await labelOp(session, 'm1', 'checkpoint');
      expect(typeof id).toBe('string');

      const collected: Array<{ id: string; type: string; payload: unknown }> = [];
      for await (const entry of session.entries()) {
        collected.push({ id: entry.id, type: entry.type, payload: entry.payload });
      }
      const labelEntry = collected.find((e) => e.type === 'label');
      expect(labelEntry).toBeDefined();
      expect((labelEntry!.payload as LineageLabelPayload).targetId).toBe('m1');
      expect((labelEntry!.payload as LineageLabelPayload).label).toBe('checkpoint');
    });
  });

  describe('attachArtifact operator', () => {
    it('appends an artifact_ledger entry with ref + summary', async () => {
      const session = createInMemorySession();
      const op = LineageExtension.operators!.attachArtifact!;
      await op(session, 'file://README.md', 'root docs read');
      const collected: Array<{ type: string; payload: unknown }> = [];
      for await (const entry of session.entries()) {
        collected.push({ type: entry.type, payload: entry.payload });
      }
      expect(collected).toHaveLength(1);
      expect(collected[0]!.type).toBe('artifact_ledger');
      expect(collected[0]!.payload).toMatchObject({
        ref: 'file://README.md',
        summary: 'root docs read',
      });
    });
  });

  describe('buildLineageTree reducer', () => {
    const reduce = (entries: Parameters<NonNullable<typeof LineageExtension.reducers>['buildLineageTree']>[0]) =>
      LineageExtension.reducers!.buildLineageTree!(entries) as LineageTreeNode[];

    it('makes messages the spine and sidecar entries children of the preceding message', () => {
      const tree = reduce([
        { id: 'm1', ts: 0, type: 'message', payload: { role: 'user', content: 'q1' } },
        { id: 'm2', ts: 0, type: 'message', payload: { role: 'assistant', content: 'a1' } },
        { id: 'c1', ts: 0, type: 'compaction', payload: { summary: 'recap' } },
        { id: 'm3', ts: 0, type: 'message', payload: { role: 'user', content: 'q2' } },
        { id: 'a1', ts: 0, type: 'artifact_ledger', payload: { ref: 'x' } },
      ]);
      expect(tree).toHaveLength(3);
      expect(tree[0]!.entry.id).toBe('m1');
      expect(tree[1]!.entry.id).toBe('m2');
      expect(tree[1]!.children.map((c) => c.entry.id)).toEqual(['c1']);
      expect(tree[2]!.entry.id).toBe('m3');
      expect(tree[2]!.children.map((c) => c.entry.id)).toEqual(['a1']);
    });

    it('promotes an orphan sidecar to a root when no message precedes it', () => {
      const tree = reduce([
        { id: 'l0', ts: 0, type: 'archive_marker', payload: { archivedEntryCount: 5 } },
        { id: 'm1', ts: 0, type: 'message', payload: { role: 'user', content: 'q' } },
      ]);
      expect(tree).toHaveLength(2);
      expect(tree[0]!.entry.id).toBe('l0');
      expect(tree[1]!.entry.id).toBe('m1');
    });

    it('attaches label to its target message instead of becoming a node', () => {
      const tree = reduce([
        { id: 'm1', ts: 0, type: 'message', payload: { role: 'user', content: 'q' } },
        {
          id: 'l1',
          ts: 0,
          type: 'label',
          payload: { targetId: 'm1', label: 'checkpoint' } satisfies LineageLabelPayload,
        },
        { id: 'm2', ts: 0, type: 'message', payload: { role: 'assistant', content: 'a' } },
      ]);
      expect(tree).toHaveLength(2);
      expect(tree[0]!.label).toBe('checkpoint');
      expect(tree[0]!.children).toEqual([]);
    });

    it('is stable across real Session entry streams', async () => {
      const session = createInMemorySession();
      await session.append({ id: 'm1', ts: 0, type: 'message', payload: { role: 'user', content: 'q1' } });
      await LineageExtension.operators!.label!(session, 'm1', 'start');
      await session.append({ id: 'm2', ts: 0, type: 'message', payload: { role: 'assistant', content: 'a1' } });
      await LineageExtension.operators!.attachArtifact!(session, 'ref-1');

      const entries: Parameters<typeof reduce>[0][number][] = [];
      for await (const entry of session.entries()) entries.push(entry);
      const tree = reduce(entries);

      expect(tree).toHaveLength(2);
      expect(tree[0]!.entry.id).toBe('m1');
      expect(tree[0]!.label).toBe('start');
      expect(tree[1]!.entry.id).toBe('m2');
      expect(tree[1]!.children.map((c) => c.entry.type)).toEqual(['artifact_ledger']);
    });
  });
});
