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
 * Deferred / call-site obligations (cannot be unit-tested at the
 * function level — they live at the call site in `agent.ts` catch block):
 *
 * - CAP-013-002: persisted messages MUST be the post-cleanup variant
 *   (`cleanupIncompleteToolCalls` + `validateAndFixToolHistory` applied)
 *   so that `/resume` sees a valid history. The contract is at the
 *   call site (agent.ts catch branch around the second saveSessionSnapshot
 *   invocation, currently passing `cleanedMessages` not raw `messages`).
 *   A breadcrumb comment was added at that call site to flag the
 *   regression risk. Activating this contract requires either an
 *   integration test of runKodaX with a forced error or a refactor of
 *   the catch block — both out of P2 scope.
 *
 * - CAP-013-003: storage failure during error persistence MUST NOT mask
 *   the original error. Today storage rejection clobbers the caught
 *   error (function does NOT try/catch around `storage.save`). Will be
 *   addressed in P3 when the substrate executor's terminal hook wraps
 *   `saveSessionSnapshot` in best-effort isolation. See `session-snapshot.ts`
 *   docstring "Open contract gap" for full rationale.
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
 * STATUS: ACTIVE since FEATURE_100 P2 for CAP-013-001; remaining
 * obligations stay `it.todo` with explicit deferral notes (NOT
 * placeholders — see prose above).
 */

import type { KodaXSessionData, KodaXSessionStorage } from '@kodax/agent';
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

  it.todo('CAP-013-002: persisted messages on error path are cleaned (CAP-002) — contract is at agent.ts catch-branch call site, not at this function. Breadcrumb added there. Integration test deferred.');
  // BLOCKS-P3.1-ENTRY: per docs/features/v0.7.29.md §P3 R8, the
   // `StepCallbacks.persistSession` wrapper introduced by P3.1 MUST
   // wrap `storage.save` in try/catch and absorb errors. The first
   // P3.1 PR that introduces the wrapper factory must promote this
   // todo to an active `it` and verify the wrapper isolates rejections.
  it.todo('CAP-013-003: storage failure does NOT mask original error — `StepCallbacks.persistSession` MUST wrap storage.save in try/catch (P3.1 entry blocker, see v0.7.29.md §R8).');
  it.todo('CAP-013-004: consecutiveErrors counter increments across runs (loaded from prior errorMetadata, +1 each crash) — integration test territory.');
});
