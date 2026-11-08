import { expect, it } from 'vitest';

// Cross-process UI and Host projections can settle more than a second late on
// slow serial Windows runners (Issues 387 and 388). A poll without an explicit
// timeout must tolerate that latency instead of failing at vitest's 1s default.
it('default expect.poll budget tolerates projections that settle after one second', async () => {
  const settledAt = Date.now() + 1_500;
  await expect.poll(() => Date.now() >= settledAt).toBe(true);
});
