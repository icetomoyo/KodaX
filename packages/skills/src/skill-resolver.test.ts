import { describe, expect, it } from 'vitest';
import { resolveSkillContent } from './skill-resolver.js';

describe('resolveSkillContent', () => {
  it('blocks unsafe dynamic context commands', async () => {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );

    const resolved = await resolveSkillContent(
      'Context: !`npm install`',
      '',
      {
        sessionId: 'session-1',
        workingDirectory: process.cwd(),
        environment,
      },
    );

    expect(resolved).toContain('Unsafe dynamic context command blocked');
  });
});
