import { describe, expect, it } from 'vitest';
import { formatSkillInvocationSummary } from './formatting.js';

describe('managed-task skill formatting', () => {
  it('does not present a Skill allowed-tools declaration as a restriction', () => {
    const invocation = formatSkillInvocationSummary({
      name: 'restricted',
      path: '/skills/restricted/SKILL.md',
      allowedTools: 'Read, Grep',
      expandedContent: 'Do the task.',
    });

    expect(invocation).toContain('- Name: restricted');
    expect(invocation).not.toMatch(/allowed tools/i);
  });
});
