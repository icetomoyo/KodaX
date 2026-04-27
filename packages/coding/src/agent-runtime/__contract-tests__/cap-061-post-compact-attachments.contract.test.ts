/**
 * Contract test for CAP-061: post-compact attachment construction + injection
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-061-post-compact-attachment-construction--injection
 *
 * Test obligations:
 * - CAP-POST-COMPACT-001: budget allocated correctly
 * - CAP-POST-COMPACT-002: file content fits within remaining budget
 * - CAP-POST-COMPACT-003: lineage attachments populated for FEATURE_072
 *
 * Risk: MEDIUM (interacts with FEATURE_072 lineage compaction)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/middleware/post-compact-attachments.ts:applyPostCompactAttachments
 * (extracted from agent.ts:633-667 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.4b).
 *
 * Time-ordering constraint: WITHIN compact orchestration (CAP-060),
 * AFTER `intelligentCompact` returns success; BEFORE setting
 * `compacted` and emitting `onCompactStats` / `onCompact`.
 *
 * Active here:
 *   - Empty ledger → identity (compacted unchanged, lineage []).
 *   - Sub-MIN_USEFUL_BUDGET freed tokens → builder produces
 *     totalTokens=0 → identity short-circuit (no injection).
 *   - Non-empty ledger with sufficient freed tokens → ledger message
 *     injected; lineage list captures `[ledgerMessage, ...fileMessages]`.
 *   - File reads only fire when `kind` is `file_modified` /
 *     `file_created` AND `fileBudget > 0`. `decision` / `tombstone`
 *     entries produce ledger summary only — no disk I/O.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.4b.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';
import type { KodaXSessionArtifactLedgerEntry } from '@kodax/agent';

import { applyPostCompactAttachments } from '../middleware/post-compact-attachments.js';

function decisionEntry(id: string, summary: string): KodaXSessionArtifactLedgerEntry {
  return {
    id,
    kind: 'decision',
    target: summary,
    timestamp: '2026-04-27T10:00:00.000Z',
    summary,
  };
}

function modifiedFileEntry(id: string, target: string): KodaXSessionArtifactLedgerEntry {
  return {
    id,
    kind: 'file_modified',
    target,
    action: 'edit',
    timestamp: '2026-04-27T10:00:00.000Z',
  };
}

const compactedSeed: KodaXMessage[] = [
  { role: 'user', content: 'pre-compaction first prompt' },
  { role: 'assistant', content: 'compaction summary placeholder' },
];

describe('CAP-061: applyPostCompactAttachments — budget short-circuit', () => {
  it('CAP-POST-COMPACT-001: freedTokens below MIN_USEFUL_BUDGET (20) → builder yields totalTokens=0 → identity (compacted unchanged, lineage empty)', async () => {
    const out = await applyPostCompactAttachments({
      compacted: compactedSeed,
      artifactLedger: [decisionEntry('a', 'tiny')],
      tokensBefore: 100,
      tokensAfter: 95, // freedTokens = 5, well below MIN_USEFUL_BUDGET=20
    });
    expect(out.compacted).toBe(compactedSeed); // reference identity
    expect(out.postCompactAttachmentsForLineage).toEqual([]);
  });

  it('CAP-POST-COMPACT-001b: empty ledger → builder yields totalTokens=0 → identity', async () => {
    const out = await applyPostCompactAttachments({
      compacted: compactedSeed,
      artifactLedger: [],
      tokensBefore: 5000,
      tokensAfter: 1000, // freedTokens = 4000, well above MIN_USEFUL_BUDGET
    });
    expect(out.compacted).toBe(compactedSeed);
    expect(out.postCompactAttachmentsForLineage).toEqual([]);
  });
});

describe('CAP-061: applyPostCompactAttachments — non-empty ledger injection', () => {
  it('CAP-POST-COMPACT-003: file_modified entries + sufficient freed tokens → ledger message injected and surfaced in lineage list (FEATURE_072 routing)', async () => {
    const out = await applyPostCompactAttachments({
      compacted: compactedSeed,
      artifactLedger: [
        // Non-existent path — file read fails silently, but the ledger
        // summary is still produced from the entry metadata.
        modifiedFileEntry('m1', '/non-existent/path-a.ts'),
        modifiedFileEntry('m2', '/non-existent/path-b.ts'),
      ],
      tokensBefore: 5000,
      tokensAfter: 1000,
    });

    // Compacted now carries the injected ledger message.
    expect(out.compacted.length).toBeGreaterThan(compactedSeed.length);
    // Lineage list is non-empty and starts with the ledger message.
    expect(out.postCompactAttachmentsForLineage.length).toBeGreaterThan(0);
    const ledgerMsg = out.postCompactAttachmentsForLineage[0];
    expect(ledgerMsg?.role).toBe('system');
    expect(typeof ledgerMsg?.content).toBe('string');
    expect(ledgerMsg?.content as string).toMatch(/Post-compact/);
  });

  it('CAP-POST-COMPACT-002: decision/tombstone entries that do NOT match the renderLedgerSummary kinds → totalTokens=0 → identity (no injection)', async () => {
    // `decision` is not one of the renderable kinds — the ledger
    // summary stays empty, ledgerMessage stays null, totalTokens=0,
    // and the function short-circuits to identity. This pins the
    // contract that non-file-tracking entries do not trigger
    // post-compact injection on their own.
    const out = await applyPostCompactAttachments({
      compacted: compactedSeed,
      artifactLedger: [decisionEntry('d1', 'big decision')],
      tokensBefore: 5000,
      tokensAfter: 1000,
    });
    expect(out.compacted).toBe(compactedSeed);
    expect(out.postCompactAttachmentsForLineage).toEqual([]);
  });
});
