/**
 * Contract test for CAP-044: session id generation fallback
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-044-session-id-generation-fallback
 *
 * Test obligations:
 * - CAP-SESSION-ID-001: returns an RFC 9562 UUIDv7 string. New sessions
 *   moved from `YYYYMMDD_HHMMSS_<suffix>` to UUIDv7 when the id started
 *   travelling to providers as `X-Session-Id`; the readable local date no
 *   longer belongs in a wire identifier. Stored legacy ids stay valid.
 * - CAP-SESSION-ID-002: retired with the date-prefixed format. Creation
 *   order is kept by the UUIDv7 millisecond timestamp prefix.
 * - CAP-SESSION-ID-003: ids are globally unique even within one millisecond
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: packages/agent/src/session-lineage/session.ts
 * (re-exported via packages/coding/src/session.ts; called from the run
 * substrate after auto-resume discovery / explicit id resolution).
 *
 * Time-ordering constraint: AFTER autoResume discovery; BEFORE session
 * loading.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6k.
 */

import { describe, expect, it } from 'vitest';

import { generateSessionId } from '../../session.js';

describe('CAP-044: session id generation fallback contract', () => {
  it('CAP-SESSION-ID-001: returns a UUIDv7 string', async () => {
    const id = await generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('CAP-SESSION-ID-003: generates globally unique ids within the same millisecond', async () => {
    const ids = await Promise.all(Array.from({ length: 100 }, () => generateSessionId()));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
