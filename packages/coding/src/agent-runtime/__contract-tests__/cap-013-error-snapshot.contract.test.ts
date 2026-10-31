/**
 * Contract test for CAP-013: error snapshot persistence on crash
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-013-error-snapshot-persistence-on-crash
 *
 * Test obligations:
 * - CAP-013-001: error path persists snapshot WITH errorMetadata
 *   — Implemented here as a function-level smoke test against
 *     `saveSessionSnapshot`. Identical in spirit to
 *     `CAP-SESSION-SNAPSHOT-002` in cap-011-session-snapshot.contract.test.ts;
 *     activated separately in this file so each capability gets a green
 *     check rather than relying on cross-file coverage attribution.
 *
 * Call-site obligations (covered by CAP-082 and the published cold-process
 * runKodaX recovery tests):
 *
 * - CAP-013-002: persisted messages MUST be the post-cleanup variant
 *   (`cleanupIncompleteToolCalls` + `validateAndFixToolHistory` applied)
 *   so that `/resume` sees a valid history. The contract is at the
 *   call site (agent.ts catch branch around the second saveSessionSnapshot
 *   invocation, currently passing `cleanedMessages` not raw `messages`).
 *
 * - CAP-013-003: storage failure during error persistence MUST NOT mask
 *   the original error. `saveSessionSnapshot` absorbs storage failures and emits a
 *   diagnostic; the active CAP-013-003 test below pins that isolation.
 *
 * - CAP-013-004: consecutiveErrors counter increments across runs.
 *   Tested at integration level (auto-resume tests) — function-level
 *   coverage is just `errorMetadata` passthrough, which CAP-013-001
 *   covers.
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:3722-3728` parity-restore evidence:
 * "Legacy does the same at agent.ts:2824. Best-effort."
 *
 * Verified location: agent-runtime/middleware/session-snapshot.ts (extracted from
 * agent.ts:844-872 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * STATUS: ACTIVE. CAP-082 and the published cold-process crash/recovery suite
 * cover cleanup and counter accumulation through real file storage.
 */

import {
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
  type KodaXSessionData,
  type KodaXSessionStorage,
} from '@kodax-ai/agent';
import { describe, expect, it, vi } from 'vitest';

import type { KodaXOptions, SessionErrorMetadata } from '../../types.js';
import { saveSessionSnapshot } from '../middleware/session-snapshot.js';

describe('CAP-013: error snapshot persistence contract', () => {
  it('CAP-013-001: errorMetadata is forwarded verbatim into the persisted snapshot', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const options = {
      session: { storage: { save, load: vi.fn() } as KodaXSessionStorage },
    } as KodaXOptions;
    const errorMetadata: SessionErrorMetadata = {
      lastError: 'API rate limit exceeded after 3 retries',
      lastErrorTime: 1714123456789,
      consecutiveErrors: 3,
    };

    await saveSessionSnapshot(options, 'sid-err', {
      messages: [{ role: 'user', content: 'hi' }],
      title: 'Errored Session',
      gitRoot: '/repo',
      errorMetadata,
    });

    expect(save).toHaveBeenCalledTimes(1);
    const persisted = save.mock.calls[0]![1] as KodaXSessionData;
    expect(persisted.errorMetadata).toEqual(errorMetadata);
    // No mutation of the input — caller-side retains identity
    expect(persisted.errorMetadata).toBe(errorMetadata);
  });

  // CAP-013-002: CAP-082 validates catch cleanup. The published runKodaX ->
  // FileSessionStorage -> independent-process resume boundary is exercised by
  // tests/bundled-session-crash-recovery.test.mjs (legacy orphan, real crashes).

  it('CAP-013-003: storage failure does NOT mask original error — saveSessionSnapshot absorbs storage.save rejections internally (closed in FEATURE_100 P3.6a)', async () => {
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    const options = {
      session: { storage: { save, load: vi.fn() } as KodaXSessionStorage },
    } as KodaXOptions;
    const errorMetadata: SessionErrorMetadata = {
      lastError: 'API rate limit exceeded after 3 retries',
      lastErrorTime: 1714123456789,
      consecutiveErrors: 3,
    };

    // The original `error` (caller's) must NOT be replaced by the storage
    // rejection — `saveSessionSnapshot` returns normally and logs the
    // storage failure rather than propagating.
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    try {
      await expect(
        saveSessionSnapshot(options, 'sid-err', {
          messages: [{ role: 'user', content: 'hi' }],
          title: 'Errored Session',
          gitRoot: '/repo',
          errorMetadata,
        }),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }

    expect(save).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: 'coding:session-snapshot',
        level: 'error',
        message: expect.stringContaining('storage.save failed'),
      }),
    ]);
  });

  // CAP-013-004: bundled-session-crash-recovery.test.mjs checks two independent
  // crash processes. Legacy history repair resets the old counter once; clean
  // crash snapshots subsequently increment it. CAP-082 covers helper accounting.
});
