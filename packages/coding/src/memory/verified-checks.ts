import type { KodaXSessionArtifactLedgerEntry } from '@kodax-ai/agent';

export type VerifiedCheckVerdict = 'passed' | 'failed';

export interface VerifiedCheckFact {
  readonly ref: string;
  readonly verdict: VerifiedCheckVerdict;
  readonly source: 'host' | 'tool';
  readonly observedAt: string;
}

/**
 * Reads only terminal facts whose producer explicitly asserted both its
 * authority and verdict. A bare `check_result`, a model statement, or a
 * command that merely exists in the ledger is not verification.
 */
export function collectVerifiedCheckFacts(
  ledger: readonly KodaXSessionArtifactLedgerEntry[],
): readonly VerifiedCheckFact[] {
  return ledger.flatMap((entry): readonly VerifiedCheckFact[] => {
    if (entry.kind !== 'check_result' && entry.kind !== 'command_scope') return [];
    const metadata = entry.metadata;
    if (metadata?.checkVerified !== true
      || (metadata.checkVerdict !== 'passed' && metadata.checkVerdict !== 'failed')
      || (metadata.checkEvidenceSource !== 'host' && metadata.checkEvidenceSource !== 'tool')
      || metadata.cancelled === true
      || metadata.timedOut === true) return [];
    if (entry.kind === 'command_scope') {
      if (!Number.isSafeInteger(metadata.exitCode)) return [];
      const expected = metadata.exitCode === 0 ? 'passed' : 'failed';
      if (metadata.checkVerdict !== expected) return [];
    }
    return [{
      ref: `artifact:${entry.id}`,
      verdict: metadata.checkVerdict,
      source: metadata.checkEvidenceSource,
      observedAt: entry.timestamp,
    }];
  });
}
