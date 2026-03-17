import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadFullSkill, parseSkillMarkdown } from './skill-loader.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe('parseSkillMarkdown', () => {
  it('parses Claude-style frontmatter with hooks and nested metadata', () => {
    const content = `---
name: review-helper
description: "Review code: focus on safety"
user-invocable: false
allowed-tools:
  - Read
  - Grep
context: fork
agent: explorer
model: sonnet
hooks:
  UserPromptSubmit:
    - command: echo prompt-hook
metadata:
  short-description: Review helper
---

# Review Helper

Use this skill to review code.
`;

    const parsed = parseSkillMarkdown(content);

    expect(parsed.frontmatter.name).toBe('review-helper');
    expect(parsed.frontmatter.description).toBe('Review code: focus on safety');
    expect(parsed.frontmatter.userInvocable).toBe(false);
    expect(parsed.frontmatter.allowedTools).toBe('Read, Grep');
    expect(parsed.frontmatter.context).toBe('fork');
    expect(parsed.frontmatter.agent).toBe('explorer');
    expect(parsed.frontmatter.model).toBe('sonnet');
    expect(parsed.frontmatter.hooks?.UserPromptSubmit?.[0]?.command).toBe('echo prompt-hook');
    expect(parsed.frontmatter.metadata?.['short-description']).toBe('Review helper');
    expect(parsed.body).toContain('# Review Helper');
  });

  it('sanitizes unquoted colons in string values', () => {
    const content = `---
name: start-next-feature
description: Implement a workflow: plan, test, ship
---

Body
`;

    const parsed = parseSkillMarkdown(content);
    expect(parsed.frontmatter.description).toBe('Implement a workflow: plan, test, ship');
  });

  it('loads support files from references/assets recursively', async () => {
    const skillDir = await mkdtemp(join(tmpdir(), 'kodax-skill-'));
    tempDirs.push(skillDir);

    await mkdir(join(skillDir, 'scripts'), { recursive: true });
    await mkdir(join(skillDir, 'references', 'frameworks'), { recursive: true });
    await mkdir(join(skillDir, 'assets'), { recursive: true });

    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: example-skill
description: Example skill for tests
---

# Example Skill

Use this skill for tests.
`,
      'utf8'
    );
    await writeFile(join(skillDir, 'scripts', 'check.js'), 'console.log("ok");', 'utf8');
    await writeFile(
      join(skillDir, 'references', 'frameworks', 'react.md'),
      '# React reference',
      'utf8'
    );
    await writeFile(join(skillDir, 'assets', 'template.md'), '# Template', 'utf8');

    const skill = await loadFullSkill(skillDir, 'project');

    expect(skill?.scripts?.map((file) => file.relativePath)).toEqual(['check.js']);
    expect(skill?.references?.map((file) => file.relativePath)).toEqual([
      'frameworks/react.md',
    ]);
    expect(skill?.assets?.map((file) => file.relativePath)).toEqual(['template.md']);
  });
});
