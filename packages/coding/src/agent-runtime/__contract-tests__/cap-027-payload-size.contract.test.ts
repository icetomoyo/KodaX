/**
 * Contract test for CAP-027: provider payload size estimation + bucketing
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-027-provider-payload-size-estimation--bucketing
 *
 * Test obligations:
 * - CAP-PAYLOAD-SIZE-001: bucket boundary correct
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/provider-payload.ts (extracted from
 * agent.ts:1056-1075 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER history cleanup; BEFORE provider call (used
 * for context-overflow protection and telemetry).
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import {
  bucketProviderPayloadSize,
  estimateProviderPayloadBytes,
} from '../provider-payload.js';

describe('CAP-027: provider payload size estimation contract', () => {
  it('CAP-PAYLOAD-SIZE-001a: bucket boundaries map to small/medium/large/xlarge as documented', () => {
    expect(bucketProviderPayloadSize(0)).toBe('small');
    expect(bucketProviderPayloadSize(16 * 1024 - 1)).toBe('small');
    expect(bucketProviderPayloadSize(16 * 1024)).toBe('medium');
    expect(bucketProviderPayloadSize(64 * 1024 - 1)).toBe('medium');
    expect(bucketProviderPayloadSize(64 * 1024)).toBe('large');
    expect(bucketProviderPayloadSize(192 * 1024 - 1)).toBe('large');
    expect(bucketProviderPayloadSize(192 * 1024)).toBe('xlarge');
    expect(bucketProviderPayloadSize(10 * 1024 * 1024)).toBe('xlarge');
  });

  it('CAP-PAYLOAD-SIZE-001b: estimator counts UTF-8 byte length of JSON-stringified {systemPrompt, messages}', () => {
    const messages = [{ role: 'user', content: 'hi' }] as never;
    const systemPrompt = 'You are a helpful assistant.';
    const expected = Buffer.byteLength(JSON.stringify({ systemPrompt, messages }), 'utf8');
    expect(estimateProviderPayloadBytes(messages, systemPrompt)).toBe(expected);
  });

  it('CAP-PAYLOAD-SIZE-001c: multi-byte UTF-8 characters counted in bytes, not code points', () => {
    // "你好" in UTF-8 is 6 bytes (3 per char), proving we use Buffer.byteLength
    // rather than .length (which would give 2).
    const messages = [{ role: 'user', content: '你好' }] as never;
    const bytes = estimateProviderPayloadBytes(messages, '');
    const stringified = JSON.stringify({ systemPrompt: '', messages });
    expect(bytes).toBe(Buffer.byteLength(stringified, 'utf8'));
    // sanity: byteLength > .length when multi-byte chars are present
    expect(bytes).toBeGreaterThan(stringified.length);
  });
});
