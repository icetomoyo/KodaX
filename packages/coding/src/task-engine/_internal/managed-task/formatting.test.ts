import { describe, expect, it } from 'vitest';
import { formatSkillInvocationSummary, formatSkillMapSection } from './formatting.js';

describe('managed-task skill formatting', () => {
  it('does not present a Skill allowed-tools declaration as a restriction', () => {
    const invocation = formatSkillInvocationSummary({
      name: 'restricted',
      path: '/skills/restricted/SKILL.md',
      allowedTools: 'Read, Grep',
      expandedContent: 'Do the task.',
    });
    const map = formatSkillMapSection({
      skillSummary: 'Do the task.',
      executionObligations: [],
      verificationObligations: [],
      requiredEvidence: [],
      ambiguities: [],
      projectionConfidence: 'high',
      rawSkillFallbackAllowed: false,
      allowedTools: 'Read, Grep',
    });

    expect(invocation).toContain('- Name: restricted');
    expect(map).toContain('- Summary: Do the task.');
    expect(`${invocation}\n${map}`).not.toMatch(/allowed tools/i);
  });
});
