import * as coding from '@kodax-ai/coding';
import { describe, expect, it } from 'vitest';

describe('coding public API', () => {
  it('does not expose filesystem leases that cannot coordinate execution', () => {
    expect(coding).not.toHaveProperty('acquireFileSystemMutationLease');
    expect(coding).not.toHaveProperty('acquireExclusiveFileSystemEffectLease');
  });

  it('does not expose the retired speculative Auto review window', () => {
    expect(coding).not.toHaveProperty('speculativeRace');
    expect(coding).not.toHaveProperty('readSpeculativeWindowFromEnv');
    expect(coding).not.toHaveProperty('DEFAULT_SPECULATIVE_WINDOW_MS');
  });
});
