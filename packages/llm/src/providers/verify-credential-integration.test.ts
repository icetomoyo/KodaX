/**
 * FEATURE_216 v0.7.45 — Integration tests against real provider HTTP
 * endpoints. SKIPPED by default (CI env doesn't have keys). Run via:
 *
 *   KODAX_INTEGRATION_TEST=1 npm run test:integration -- packages/llm/src/providers/verify-credential-integration.test.ts
 *
 * Each provider tests both branches with the same env-var entry:
 *   - real-key path → ok:true, error undefined, durationMs > 0
 *   - fake-key path → ok:false, error='unauthorized' (or close to it)
 *
 * Fake-key probe is done by temporarily overwriting process.env, running
 * the verify, then restoring. Each provider is `it.skipIf` 'd when its
 * env var is absent so partial-key environments still get useful coverage.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyProviderCredential } from './resolver.js';

const RUN_INTEGRATION = process.env.KODAX_INTEGRATION_TEST === '1';
const FAKE_KEY = 'sk-fake-invalid-key-FEATURE_216-do-not-route';

interface ProviderCase {
  readonly provider: string;
  readonly apiKeyEnv: string;
  readonly expectedStrategy: 'count-tokens' | 'models-list' | 'minimal-message';
}

const CASES: ProviderCase[] = [
  { provider: 'zhipu-coding',   apiKeyEnv: 'ZHIPU_CODING_API_KEY',   expectedStrategy: 'count-tokens' },
  { provider: 'kimi-code',      apiKeyEnv: 'KIMI_CODE_API_KEY',      expectedStrategy: 'count-tokens' },
  { provider: 'minimax-coding', apiKeyEnv: 'MINIMAX_CODING_API_KEY', expectedStrategy: 'count-tokens' },
  { provider: 'ark-coding',     apiKeyEnv: 'ARK_CODING_API_KEY',     expectedStrategy: 'count-tokens' },
  { provider: 'deepseek',       apiKeyEnv: 'DEEPSEEK_API_KEY',       expectedStrategy: 'count-tokens' },
  { provider: 'kimi',           apiKeyEnv: 'KIMI_API_KEY',           expectedStrategy: 'models-list' },
];

describe.skipIf(!RUN_INTEGRATION)('FEATURE_216 integration — real provider HTTP', () => {
  for (const c of CASES) {
    describe(`${c.provider} (${c.apiKeyEnv}, strategy=${c.expectedStrategy})`, () => {
      const hasKey = !!process.env[c.apiKeyEnv];
      const realKey = process.env[c.apiKeyEnv];

      it.skipIf(!hasKey)('real key → ok:true', async () => {
        const r = await verifyProviderCredential(c.provider, { timeoutMs: 15_000 });
        if (!r.ok) {
          // eslint-disable-next-line no-console
          console.error(`[${c.provider}] real-key verify failed:`, r);
        }
        expect(r.ok).toBe(true);
        expect(r.strategy).toBe(c.expectedStrategy);
        expect(r.durationMs).toBeGreaterThan(0);
        // count-tokens / models-list cost 0; minimal-message ~6-7
        if (c.expectedStrategy !== 'minimal-message') {
          expect(r.approxTokensSpent).toBe(0);
        }
      }, 30_000);

      it.skipIf(!hasKey)('fake key → ok:false, error="unauthorized"', async () => {
        process.env[c.apiKeyEnv] = FAKE_KEY;
        try {
          const r = await verifyProviderCredential(c.provider, { timeoutMs: 15_000 });
          expect(r.ok).toBe(false);
          expect(r.error).toBe('unauthorized');
        } finally {
          if (realKey !== undefined) process.env[c.apiKeyEnv] = realKey;
        }
      }, 30_000);
    });
  }
});
