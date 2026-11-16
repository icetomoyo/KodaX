import { describe, expect, it, vi } from 'vitest';
import type { Skill } from './types.js';
import { createExecutor } from './executor.js';

const skill = {
  name: 'restricted',
  description: 'Declares allowed-tools.',
  allowedTools: 'Read, Grep',
  path: '/skills/restricted',
  skillFilePath: '/skills/restricted/SKILL.md',
  source: 'user',
  content: 'Do the task.',
} as Skill;

vi.mock('./skill-registry.js', () => ({
  getSkillRegistry: () => ({ has: () => true, loadFull: async () => skill }),
}));

describe('SkillExecutor', () => {
  it.each(['inline', 'fork'] as const)('ignores allowed-tools in %s mode', async mode => {
    const result = await createExecutor({ workingDirectory: '/work' }).execute('restricted', '', { mode });

    expect(result.content).toBe('[Using Skill: restricted]\n\nDo the task.');
    const config = result.artifacts?.find(artifact => artifact.name === 'fork-config');
    if (config) expect(JSON.parse(config.content)).not.toHaveProperty('allowedTools');
  });

  it('keeps an explicit caller allowedTools override in the fork config', async () => {
    const result = await createExecutor({ workingDirectory: '/work' }).execute('restricted', '', {
      mode: 'fork',
      allowedTools: ['Read'],
    });

    const config = result.artifacts?.find(artifact => artifact.name === 'fork-config');
    expect(JSON.parse(config?.content ?? '{}')).toMatchObject({ allowedTools: ['Read'] });
  });
});
