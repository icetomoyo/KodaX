/**
 * Contract test for CAP-031: transient provider retry description
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-031-transient-provider-retry-description
 *
 * Test obligations:
 * - CAP-PROVIDER-RETRY-DESC-001: network / 5xx / timeout produce expected strings
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/provider-retry-policy.ts (extracted from
 * agent.ts:287-315 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: in provider retry policy chain.
 *
 * Active here: the priority-ordered classification truth-table. The
 * priority order matters — a generic `timed out` substring must NOT
 * outrank a specific `hard timeout` match, otherwise the banner
 * regresses ("Provider request timed out" instead of "Provider response
 * timed out"). The tests pin both the labels AND the ordering.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import { describeTransientProviderRetry } from '../provider-retry-policy.js';

function err(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('CAP-031: describeTransientProviderRetry — priority-ordered classification', () => {
  it('CAP-PROVIDER-RETRY-DESC-001a: StreamIncompleteError name → "Stream interrupted before completion" (priority 1: name match wins regardless of message)', () => {
    expect(describeTransientProviderRetry(err('StreamIncompleteError', 'whatever'))).toBe(
      'Stream interrupted before completion',
    );
    expect(describeTransientProviderRetry(err('Error', 'stream incomplete: unknown'))).toBe(
      'Stream interrupted before completion',
    );
  });

  it('CAP-PROVIDER-RETRY-DESC-001b: stalled-stream substrings → "Stream stalled"', () => {
    expect(describeTransientProviderRetry(err('Error', 'stream stalled at chunk 3'))).toBe('Stream stalled');
    expect(describeTransientProviderRetry(err('Error', 'delayed response from provider'))).toBe('Stream stalled');
    expect(describeTransientProviderRetry(err('Error', '60s idle timeout exceeded'))).toBe('Stream stalled');
  });

  it('CAP-PROVIDER-RETRY-DESC-001c: hard-timeout substrings → "Provider response timed out" (priority 3 — must outrank generic timeout class)', () => {
    expect(describeTransientProviderRetry(err('Error', 'hard timeout reached'))).toBe(
      'Provider response timed out',
    );
    expect(describeTransientProviderRetry(err('Error', 'request exceeded 10 minutes'))).toBe(
      'Provider response timed out',
    );
  });

  it('CAP-PROVIDER-RETRY-DESC-001d: network-class substrings → "Provider connection error"', () => {
    for (const msg of [
      'socket hang up',
      'connection error received',
      'ECONNREFUSED 127.0.0.1:443',
      'ENOTFOUND api.example.com',
      'fetch failed',
      'network unreachable',
    ]) {
      expect(describeTransientProviderRetry(err('Error', msg))).toBe('Provider connection error');
    }
  });

  it('CAP-PROVIDER-RETRY-DESC-001e: generic timeout substrings → "Provider request timed out"', () => {
    for (const msg of ['request timed out', 'timeout exceeded', 'ETIMEDOUT 30s']) {
      expect(describeTransientProviderRetry(err('Error', msg))).toBe('Provider request timed out');
    }
  });

  it('CAP-PROVIDER-RETRY-DESC-001f: aborted substring → "Provider stream aborted"', () => {
    expect(describeTransientProviderRetry(err('Error', 'request aborted by signal'))).toBe(
      'Provider stream aborted',
    );
  });

  it('CAP-PROVIDER-RETRY-DESC-001g: unknown error → fallthrough "Transient provider error"', () => {
    expect(describeTransientProviderRetry(err('Error', 'something exotic'))).toBe('Transient provider error');
    expect(describeTransientProviderRetry(err('Error', ''))).toBe('Transient provider error');
  });

  it('CAP-PROVIDER-RETRY-DESC-001h: classification is case-insensitive (message is lowercased before matching)', () => {
    expect(describeTransientProviderRetry(err('Error', 'SOCKET HANG UP'))).toBe('Provider connection error');
    expect(describeTransientProviderRetry(err('Error', 'Stream Stalled'))).toBe('Stream stalled');
  });
});
