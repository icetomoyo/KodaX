import { describe, expect, it } from 'vitest';
import { claimBuiltinChildContract, withBuiltinChildContract } from './child-contract-scope.js';

describe('private builtin child contract scope', () => {
  it('allows exactly one matching substrate owner and survives copied options', async () => {
    const source = { agentId: 'child', system: 'canonical' };
    const context = { currentAgentId: 'child', systemPromptOverride: 'canonical' };
    expect(claimBuiltinChildContract(context)).toBeUndefined();
    await withBuiltinChildContract(source, async () => {
      await Promise.resolve();
      expect(claimBuiltinChildContract({ ...context })).toBe(source);
      expect(claimBuiltinChildContract(context)).toBeUndefined();
    });
    expect(claimBuiltinChildContract(context)).toBeUndefined();
  });

  it('isolates concurrent children and explicitly masks an inherited source for specialists', async () => {
    await Promise.all(['a', 'b'].map(agentId => withBuiltinChildContract({ agentId, system: agentId }, async () => {
      await withBuiltinChildContract(undefined, async () => {
        expect(claimBuiltinChildContract({ currentAgentId: agentId, systemPromptOverride: agentId })).toBeUndefined();
      });
      expect(claimBuiltinChildContract({ currentAgentId: agentId, systemPromptOverride: agentId }))
        .toEqual({ agentId, system: agentId });
    })));
  });

  it('rejects mismatched identity, overridden instructions and consumer policy/profile', () => {
    for (const context of [
      { currentAgentId: 'other', systemPromptOverride: 'canonical' },
      { currentAgentId: 'child', systemPromptOverride: 'override' },
      { currentAgentId: 'child', systemPromptOverride: 'canonical', toolVisibilityPolicy: () => true },
      { currentAgentId: 'child', systemPromptOverride: 'canonical', agentProfile: {} },
    ]) withBuiltinChildContract({ agentId: 'child', system: 'canonical' }, () => {
      expect(claimBuiltinChildContract(context)).toBeUndefined();
    });
  });
});
