import { describe, expect, it } from 'vitest';
import type { KodaXSessionArtifactLedgerEntry } from '@kodax-ai/agent';

import { collectVerifiedCheckFacts } from './verified-checks.js';

function entry(
  kind: KodaXSessionArtifactLedgerEntry['kind'],
  metadata?: KodaXSessionArtifactLedgerEntry['metadata'],
): KodaXSessionArtifactLedgerEntry {
  return {
    id: `artifact-${kind}`,
    kind,
    target: 'verification',
    timestamp: '2026-07-27T00:00:00.000Z',
    metadata,
  };
}

describe('FEATURE_263 verified terminal check facts', () => {
  it('accepts only explicitly verified host/tool check results', () => {
    expect(collectVerifiedCheckFacts([
      entry('check_result', {
        checkVerdict: 'passed',
        checkEvidenceSource: 'host',
        checkVerified: true,
      }),
      entry('check_result', {
        checkVerdict: 'failed',
        checkEvidenceSource: 'tool',
        checkVerified: true,
      }),
    ])).toEqual([
      {
        ref: 'artifact:artifact-check_result',
        verdict: 'passed',
        source: 'host',
        observedAt: '2026-07-27T00:00:00.000Z',
      },
      {
        ref: 'artifact:artifact-check_result',
        verdict: 'failed',
        source: 'tool',
        observedAt: '2026-07-27T00:00:00.000Z',
      },
    ]);
  });

  it('rejects bare, inferred, cancelled and malformed check records', () => {
    expect(collectVerifiedCheckFacts([
      entry('check_result'),
      entry('check_result', {
        checkVerdict: 'passed',
        checkEvidenceSource: 'agent',
        checkVerified: true,
      }),
      entry('check_result', {
        checkVerdict: 'passed',
        checkEvidenceSource: 'host',
        checkVerified: false,
      }),
      entry('command_scope', {
        checkVerdict: 'passed',
        checkEvidenceSource: 'tool',
        checkVerified: true,
        cancelled: true,
      }),
    ])).toEqual([]);
  });

  it('accepts command facts only when extraction marked a completed verification command', () => {
    expect(collectVerifiedCheckFacts([
      entry('command_scope', {
        exitCode: 0,
        checkVerdict: 'passed',
        checkEvidenceSource: 'tool',
        checkVerified: true,
      }),
      entry('command_scope', { exitCode: 0 }),
    ])).toEqual([{
      ref: 'artifact:artifact-command_scope',
      verdict: 'passed',
      source: 'tool',
      observedAt: '2026-07-27T00:00:00.000Z',
    }]);
  });
});
