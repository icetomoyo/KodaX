/**
 * Contract test for CAP-064: provider policy evaluation + system prompt issue injection
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-064-provider-policy-evaluation--system-prompt-issue-injection
 *
 * Test obligations:
 * - CAP-PROVIDER-POLICY-001: block status throws with summary
 * - CAP-PROVIDER-POLICY-002: issues appear in system prompt as notes
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/provider-policy-gate.ts (extracted
 * from agent.ts:766-785 — pre-FEATURE_100 baseline — during FEATURE_100 P3.2b)
 *
 * Time-ordering constraint: AFTER prepare hook; BEFORE stream call.
 *
 * Active here:
 *   - block status throws with `[Provider Policy] {summary}` prefix
 *   - issues.length > 0 → effectiveSystemPrompt = base + '\n\n' + notes
 *   - issues.length === 0 → effectiveSystemPrompt === baseSystemPrompt
 *     (string-equal pass-through; not asserting reference equality
 *     because string operations may produce a fresh string instance)
 *   - decision is exposed on the result for telemetry callers
 *
 * STATUS: ACTIVE since FEATURE_100 P3.2b.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXBaseProvider } from '@kodax/ai';
import type { KodaXOptions } from '../../types.js';

import { applyProviderPolicyGate } from '../provider-policy-gate.js';
import * as providerPolicyModule from '../../provider-policy.js';

function fakeProvider(): KodaXBaseProvider {
  return {
    name: 'anthropic',
    isConfigured: () => true,
    getApiKeyEnv: () => 'ANTHROPIC_API_KEY',
    getModel: () => 'claude-sonnet-4-5',
  } as unknown as KodaXBaseProvider;
}

function fakeInput(): Parameters<typeof applyProviderPolicyGate>[0] {
  return {
    providerName: 'anthropic',
    model: undefined,
    provider: fakeProvider(),
    prompt: 'hello',
    effectiveOptions: {
      provider: 'anthropic',
      context: {},
    } as unknown as KodaXOptions,
    reasoningMode: 'balanced',
    taskType: 'edit',
    executionMode: 'balanced',
    baseSystemPrompt: 'BASE PROMPT',
  };
}

describe('CAP-064: applyProviderPolicyGate — block status', () => {
  it('CAP-PROVIDER-POLICY-001: status "block" throws with [Provider Policy] {summary} prefix', () => {
    const spy = vi.spyOn(providerPolicyModule, 'evaluateProviderPolicy').mockReturnValue({
      status: 'block',
      summary: 'unsupported feature X',
      issues: [],
    } as unknown as ReturnType<typeof providerPolicyModule.evaluateProviderPolicy>);

    try {
      expect(() => applyProviderPolicyGate(fakeInput())).toThrow(
        /\[Provider Policy\] unsupported feature X/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('CAP-064: applyProviderPolicyGate — issue notes', () => {
  it('CAP-PROVIDER-POLICY-002a: issues.length > 0 → effectiveSystemPrompt = base + \\n\\n + notes', () => {
    const spy = vi.spyOn(providerPolicyModule, 'evaluateProviderPolicy').mockReturnValue({
      status: 'warn',
      summary: 'has issues',
      issues: [{ code: 'X', message: 'Mock issue note' }],
    } as unknown as ReturnType<typeof providerPolicyModule.evaluateProviderPolicy>);
    const notesSpy = vi
      .spyOn(providerPolicyModule, 'buildProviderPolicyPromptNotes')
      .mockReturnValue(['NOTE LINE 1', 'NOTE LINE 2']);

    try {
      const result = applyProviderPolicyGate(fakeInput());
      expect(result.effectiveSystemPrompt).toBe('BASE PROMPT\n\nNOTE LINE 1\nNOTE LINE 2');
    } finally {
      spy.mockRestore();
      notesSpy.mockRestore();
    }
  });

  it('CAP-PROVIDER-POLICY-002b: issues.length === 0 → effectiveSystemPrompt is string-equal to baseSystemPrompt', () => {
    const spy = vi.spyOn(providerPolicyModule, 'evaluateProviderPolicy').mockReturnValue({
      status: 'pass',
      summary: 'ok',
      issues: [],
    } as unknown as ReturnType<typeof providerPolicyModule.evaluateProviderPolicy>);

    try {
      const result = applyProviderPolicyGate(fakeInput());
      expect(result.effectiveSystemPrompt).toBe('BASE PROMPT');
    } finally {
      spy.mockRestore();
    }
  });

  it('CAP-PROVIDER-POLICY-DECISION-001: result.decision is the underlying evaluateProviderPolicy return value (passthrough for telemetry)', () => {
    const mockDecision = {
      status: 'warn',
      summary: 'mock',
      issues: [],
    } as unknown as ReturnType<typeof providerPolicyModule.evaluateProviderPolicy>;
    const spy = vi
      .spyOn(providerPolicyModule, 'evaluateProviderPolicy')
      .mockReturnValue(mockDecision);

    try {
      const result = applyProviderPolicyGate(fakeInput());
      expect(result.decision).toBe(mockDecision);
    } finally {
      spy.mockRestore();
    }
  });
});
