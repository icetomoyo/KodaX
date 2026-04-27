/**
 * Contract test for CAP-044: session id generation fallback
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-044-session-id-generation-fallback
 *
 * Test obligations:
 * - CAP-SESSION-ID-001: returns a non-empty string in the
 *   `YYYYMMDD_HHMMSS` timestamp format
 * - CAP-SESSION-ID-002: encodes the current local date as the leading
 *   8 digits of the id
 *
 * Note on the original P1 stub: the obligation text said "crypto-random
 * string" but the actual implementation
 * (`packages/agent/src/session.ts:50`) is a timestamp-derived format
 * (`YYYYMMDD_HHMMSS`). The reformulated obligations match the
 * function's real contract.
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: packages/agent/src/session.ts:50
 * (re-exported via packages/coding/src/session.ts; called from agent.ts
 * after auto-resume discovery / explicit id resolution).
 *
 * Time-ordering constraint: AFTER autoResume discovery; BEFORE session
 * loading.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6k.
 */

import { describe, expect, it } from 'vitest';

import { generateSessionId } from '../../session.js';

describe('CAP-044: session id generation fallback contract', () => {
  it('CAP-SESSION-ID-001: returns a non-empty string in the YYYYMMDD_HHMMSS format', async () => {
    const id = await generateSessionId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^\d{8}_\d{6}$/);
    expect(id.length).toBe(15); // 8 digits + '_' + 6 digits
  });

  it('CAP-SESSION-ID-002: encodes the current local date as the leading 8 digits (YYYYMMDD)', async () => {
    // Snapshot `now` BEFORE generating the id so a midnight rollover
    // between `generateSessionId()` and `expectedDatePrefix` cannot
    // cause a flaky mismatch — verify the id's prefix is one of the
    // two adjacent dates that `now` could represent.
    const beforeNow = new Date();
    const id = await generateSessionId();
    const afterNow = new Date();

    const datePrefix = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

    const idPrefix = id.slice(0, 8);
    expect([datePrefix(beforeNow), datePrefix(afterNow)]).toContain(idPrefix);
  });
});
