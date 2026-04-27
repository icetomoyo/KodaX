/**
 * Contract test for CAP-042: provider configuration check
 * (entry + per-turn re-validation)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-042-provider-configuration-check-entry--per-turn-re-validation
 *
 * Test obligations:
 * - CAP-PROVIDER-CONFIG-001: unconfigured provider throws an error
 *   that includes the API-key env-var name hint
 * - CAP-PROVIDER-CONFIG-002: configured provider passes silently
 *   (no throw, no return value)
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/provider-config-check.ts:32
 * (extracted from agent.ts:388-391, 694-698 during FEATURE_100 P3.6n).
 *
 * Time-ordering constraint: BEFORE first provider call; re-validation
 * BEFORE each provider.stream and after every prepare-hook switch.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6n.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXBaseProvider } from '@kodax/ai';
import { assertProviderConfigured } from '../provider-config-check.js';

function makeProvider(opts: {
  configured: boolean;
  apiKeyEnv: string;
}): Pick<KodaXBaseProvider, 'isConfigured' | 'getApiKeyEnv'> {
  return {
    isConfigured: () => opts.configured,
    getApiKeyEnv: () => opts.apiKeyEnv,
  };
}

describe('CAP-042: provider configuration check contract', () => {
  it('CAP-PROVIDER-CONFIG-001: unconfigured provider throws Error containing the provider name AND the API-key env-var hint', () => {
    const provider = makeProvider({
      configured: false,
      apiKeyEnv: 'KODAX_TEST_API_KEY',
    });
    expect(() => assertProviderConfigured(provider, 'test-provider')).toThrow(
      /Provider "test-provider" not configured\. Set KODAX_TEST_API_KEY/,
    );
  });

  it('CAP-PROVIDER-CONFIG-001b: error message exactly matches the documented format', () => {
    const provider = makeProvider({
      configured: false,
      apiKeyEnv: 'KODAX_OPENAI_API_KEY',
    });
    expect(() => assertProviderConfigured(provider, 'openai')).toThrow(
      'Provider "openai" not configured. Set KODAX_OPENAI_API_KEY',
    );
  });

  it('CAP-PROVIDER-CONFIG-002: configured provider passes silently — no throw, no return value', () => {
    const provider = makeProvider({
      configured: true,
      apiKeyEnv: 'KODAX_TEST_API_KEY',
    });
    expect(() => assertProviderConfigured(provider, 'configured-provider')).not.toThrow();
    // Function returns void; verify undefined return.
    expect(assertProviderConfigured(provider, 'configured-provider')).toBeUndefined();
  });
});
