import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SkillRegistry } from './skill-registry.js';

describe('built-in visual review', () => {
  it('discovers one shared evidence workflow for static, paginated, interactive and time-based results', async () => {
    const registry = new SkillRegistry(undefined, {
      builtinDir: fileURLToPath(new URL('./builtin', import.meta.url)),
    });
    await registry.discover();
    expect(registry.get('visual-review')).toMatchObject({ source: 'builtin' });
    const skill = await registry.loadFull('visual-review');
    expect(skill.content).toContain('creation, modification, and review');
    expect(skill.content).toContain('Static');
    expect(skill.content).toContain('Paginated');
    expect(skill.content).toContain('Interactive');
    expect(skill.content).toContain('Temporal');
    expect(skill.content).toContain('unverified');
    expect(skill.content).toContain('actual image content');
    expect(skill.content).toContain('existing permission');
  });
});
