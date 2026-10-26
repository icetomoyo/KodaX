/** Explicit manual launcher, skipped by every ordinary/offline test run.
 * Vitest's existing source aliases keep Runtime registries/ALS in one module graph.
 * No SDK/fetch mock: live calls still use the frozen eval's single-attempt budget.
 */
import { it } from 'vitest';

it.skipIf(process.env.KODAX_CONTRACT_COMPLEX_LIVE !== 'authorized')('manual frozen compact-contract complex evaluation', async () => {
  const phase = process.env.KODAX_CONTRACT_COMPLEX_PHASE;
  if (!phase || !['prepare', 'glm', 'kimi'].includes(phase)) throw new Error('Explicit frozen experiment phase required');
  const prior = process.argv;
  process.argv = [...prior, '--contract', phase];
  try { await import('./first-turn-compact-complex.eval.js'); }
  finally { process.argv = prior; }
}, 1_900_000);
