import { describe, expect, it } from 'vitest';

import { validateSelfModify } from './self-modify.js';
import type { AgentContent, GuardrailRef } from './types.js';

function buildContent(overrides: Partial<AgentContent> = {}): AgentContent {
  return {
    instructions: overrides.instructions ?? 'You are alpha. Be thorough.',
    ...(overrides.tools ? { tools: overrides.tools } : {}),
    ...(overrides.handoffs ? { handoffs: overrides.handoffs } : {}),
    ...(overrides.reasoning ? { reasoning: overrides.reasoning } : {}),
    ...(overrides.guardrails ? { guardrails: overrides.guardrails } : {}),
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.provider ? { provider: overrides.provider } : {}),
    ...(overrides.outputSchema ? { outputSchema: overrides.outputSchema } : {}),
    ...(overrides.testCases ? { testCases: overrides.testCases } : {}),
    ...(overrides.maxBudget !== undefined ? { maxBudget: overrides.maxBudget } : {}),
    ...(overrides.declaredInvariants ? { declaredInvariants: overrides.declaredInvariants } : {}),
  };
}

function gr(kind: GuardrailRef['kind'], ref: string): GuardrailRef {
  return { kind, ref };
}

describe('validateSelfModify', () => {
  describe('hard rejects in fail-fast order', () => {
    it('rejects on kind change before checking name', () => {
      const result = validateSelfModify({
        prev: buildContent(),
        next: buildContent(),
        prevName: 'alpha',
        nextName: 'beta',
        prevKind: 'agent',
        nextKind: 'tool',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule).toBe('kind-invalid');
      }
    });

    it('rejects when both prev and next kind are not agent (defense in depth)', () => {
      const result = validateSelfModify({
        prev: buildContent(),
        next: buildContent(),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'tool',
        nextKind: 'tool',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule).toBe('kind-invalid');
        expect(result.reason).toContain("kind='agent'");
      }
    });

    it('rejects on name change', () => {
      const result = validateSelfModify({
        prev: buildContent(),
        next: buildContent(),
        prevName: 'alpha',
        nextName: 'beta',
        prevKind: 'agent',
        nextKind: 'agent',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule).toBe('name-changed');
        expect(result.reason).toContain('stage_agent');
      }
    });

    it('rejects when budget is exhausted', () => {
      const result = validateSelfModify({
        prev: buildContent(),
        next: buildContent({ instructions: 'updated' }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        budgetRemaining: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule).toBe('budget-exhausted');
        expect(result.reason).toContain('reset-self-modify-budget alpha');
      }
    });

    it('rejects when budget is negative (defensive)', () => {
      const result = validateSelfModify({
        prev: buildContent(),
        next: buildContent({ instructions: 'updated' }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        budgetRemaining: -1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule).toBe('budget-exhausted');
      }
    });
  });

  describe('guardrail ratchet', () => {
    it('passes when prior guardrails are absent', () => {
      const result = validateSelfModify({
        prev: buildContent(),
        next: buildContent({ guardrails: [gr('input', 'no-secrets')] }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(true);
    });

    it('passes when next guardrails are a strict superset', () => {
      const result = validateSelfModify({
        prev: buildContent({
          guardrails: [gr('input', 'no-secrets'), gr('tool', 'no-rm-rf')],
        }),
        next: buildContent({
          guardrails: [
            gr('input', 'no-secrets'),
            gr('tool', 'no-rm-rf'),
            gr('output', 'no-pii-leak'),
          ],
        }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(true);
    });

    it('passes when next guardrails equal prev (no-op modify)', () => {
      const result = validateSelfModify({
        prev: buildContent({
          guardrails: [gr('input', 'no-secrets'), gr('tool', 'no-rm-rf')],
        }),
        next: buildContent({
          guardrails: [gr('tool', 'no-rm-rf'), gr('input', 'no-secrets')],
        }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(true);
    });

    it('rejects when a guardrail is removed', () => {
      const result = validateSelfModify({
        prev: buildContent({
          guardrails: [gr('input', 'no-secrets'), gr('tool', 'no-rm-rf')],
        }),
        next: buildContent({ guardrails: [gr('input', 'no-secrets')] }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule).toBe('guardrail-ratchet');
        expect(result.reason).toContain('tool:no-rm-rf');
      }
    });

    it('rejects when next guardrails are absent but prev had some', () => {
      const result = validateSelfModify({
        prev: buildContent({ guardrails: [gr('input', 'no-secrets')] }),
        next: buildContent({}),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule).toBe('guardrail-ratchet');
      }
    });

    it('treats different kind as distinct (input vs output with same ref)', () => {
      const result = validateSelfModify({
        prev: buildContent({ guardrails: [gr('input', 'no-secrets')] }),
        next: buildContent({ guardrails: [gr('output', 'no-secrets')] }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule).toBe('guardrail-ratchet');
      }
    });
  });

  describe('reasoning ceiling', () => {
    it('passes when no ceiling is configured', () => {
      const result = validateSelfModify({
        prev: buildContent(),
        next: buildContent({ reasoning: { default: 'balanced', max: 'deep' } }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(true);
    });

    it('passes when next reasoning.max is undefined', () => {
      const result = validateSelfModify({
        prev: buildContent(),
        next: buildContent({ reasoning: { default: 'balanced' } }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        userReasoningCeiling: 'balanced',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(true);
    });

    it('passes when proposed max equals ceiling', () => {
      const result = validateSelfModify({
        prev: buildContent(),
        next: buildContent({ reasoning: { default: 'quick', max: 'balanced' } }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        userReasoningCeiling: 'balanced',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(true);
    });

    it('rejects when proposed max exceeds ceiling', () => {
      const result = validateSelfModify({
        prev: buildContent(),
        next: buildContent({ reasoning: { default: 'balanced', max: 'deep' } }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        userReasoningCeiling: 'balanced',
        budgetRemaining: 3,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule).toBe('reasoning-ceiling');
        expect(result.reason).toContain('deep');
        expect(result.reason).toContain('balanced');
      }
    });
  });

  describe('happy path', () => {
    it('passes when name + kind + budget + ratchet + ceiling all hold', () => {
      const result = validateSelfModify({
        prev: buildContent({
          instructions: 'You are alpha. Verdict: accept | revise.',
          guardrails: [gr('input', 'no-secrets')],
          reasoning: { default: 'balanced' },
        }),
        next: buildContent({
          instructions: 'You are alpha. Read carefully. Verdict: accept | revise | blocked.',
          guardrails: [gr('input', 'no-secrets'), gr('output', 'no-pii-leak')],
          reasoning: { default: 'balanced', max: 'deep' },
        }),
        prevName: 'alpha',
        nextName: 'alpha',
        prevKind: 'agent',
        nextKind: 'agent',
        userReasoningCeiling: 'deep',
        budgetRemaining: 2,
      });
      expect(result.ok).toBe(true);
    });
  });
});
