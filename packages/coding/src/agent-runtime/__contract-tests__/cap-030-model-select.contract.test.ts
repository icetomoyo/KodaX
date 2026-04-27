/**
 * Contract test for CAP-030: runtime model selection normalization
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-030-runtime-model-selection-normalization
 *
 * Test obligations:
 * - CAP-MODEL-SELECT-001: trims whitespace from provider/model strings
 * - CAP-MODEL-SELECT-002: drops empty / whitespace-only fields
 * - CAP-MODEL-SELECT-003: drops missing fields
 *
 * Note on the original P1 stub: the obligation text said "provider:model
 * parses to canonical { provider, model } tuple", but the actual function
 * `normalizeRuntimeModelSelection` does NOT parse colon-separated strings
 * — it takes `{ provider, model }` already separated and just trims +
 * drops empty fields. The reformulated obligations above match the
 * function's actual contract.
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/runtime-session-state.ts:154
 * (extracted from agent.ts:274-288 during FEATURE_100 P2 CAP-020 batch).
 *
 * Time-ordering constraint: in provider prepare hook (CAP-023) chain.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6j.
 */

import { describe, expect, it } from 'vitest';

import { normalizeRuntimeModelSelection } from '../runtime-session-state.js';

describe('CAP-030: runtime model selection normalization contract', () => {
  it('CAP-MODEL-SELECT-001: trims whitespace from provider and model strings', () => {
    const out = normalizeRuntimeModelSelection({
      provider: '  anthropic  ',
      model: '\t claude-sonnet-4-6 \n',
    });
    expect(out).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('CAP-MODEL-SELECT-002: drops whitespace-only / empty-string provider and model fields', () => {
    expect(normalizeRuntimeModelSelection({ provider: '', model: 'gpt-4' })).toEqual({ model: 'gpt-4' });
    expect(normalizeRuntimeModelSelection({ provider: 'anthropic', model: '   ' })).toEqual({ provider: 'anthropic' });
    expect(normalizeRuntimeModelSelection({ provider: '   ', model: '\t' })).toEqual({});
  });

  it('CAP-MODEL-SELECT-003: drops missing fields entirely (the result has no `provider` / `model` keys when input is undefined)', () => {
    const out = normalizeRuntimeModelSelection({});
    expect(out).toEqual({});
    expect('provider' in out).toBe(false);
    expect('model' in out).toBe(false);
  });
});
