/** Bound even empty control frames on both sides before enqueueing work. */
export function createScriptControlBudget(limits: { maxCalls: number; maxTransferBytes: number }) {
  let events = 0;
  let bytes = 0;
  const maximum = Math.min(1024, Math.max(128, limits.maxCalls * 4));
  return (payloadBytes: number): void => {
    if (++events > maximum || (bytes += 32 + payloadBytes) > limits.maxTransferBytes) {
      throw new Error('Script control event or byte limit exceeded.');
    }
  };
}
