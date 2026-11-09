import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { loadFullSkill, parseSkillMarkdown } from './skill-loader.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => removeTempDir(dir))
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
    const skillDir = await createTempDir('kodax-skill-');
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

  it('loads files outside the conventional folders without changing those folders', async () => {
    const skillDir = await createTempDir('kodax-skill-');
    tempDirs.push(skillDir);

    await mkdir(join(skillDir, 'scripts'), { recursive: true });
    await mkdir(join(skillDir, 'agents'), { recursive: true });
    await mkdir(join(skillDir, 'demos', 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(skillDir, '.git'), { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: root-files\ndescription: Root files\n---\n\nSee REFERENCE.md.\n', 'utf8');
    await writeFile(join(skillDir, 'REFERENCE.md'), '# Reference', 'utf8');
    await writeFile(join(skillDir, '.env'), 'SECRET=1', 'utf8');
    await writeFile(join(skillDir, 'agents', 'grader.md'), '# Grader', 'utf8');
    await writeFile(join(skillDir, 'demos', 'index.html'), '<html></html>', 'utf8');
    await writeFile(join(skillDir, 'demos', 'node_modules', 'pkg', 'index.js'), '', 'utf8');
    await writeFile(join(skillDir, '.git', 'HEAD'), 'ref', 'utf8');
    await writeFile(join(skillDir, 'scripts', 'check.js'), '', 'utf8');

    const skill = await loadFullSkill(skillDir, 'user');

    expect(skill?.otherFiles?.map((file) => file.relativePath)).toEqual([
      'REFERENCE.md',
      'agents/grader.md',
      'demos/index.html',
    ]);
    expect(skill?.otherFiles?.[0]?.path).toBe(join(skillDir, 'REFERENCE.md'));
    expect(skill?.scripts?.map((file) => file.relativePath)).toEqual(['check.js']);
  });

  it('omits otherFiles when the skill has only SKILL.md and conventional folders', async () => {
    const skillDir = await createTempDir('kodax-skill-');
    tempDirs.push(skillDir);
    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: plain\ndescription: Plain\n---\n\nBody\n', 'utf8');
    await writeFile(join(skillDir, 'references', 'a.md'), '# A', 'utf8');

    const skill = await loadFullSkill(skillDir, 'user');

    expect(skill).not.toHaveProperty('otherFiles');
  });

  it('treats every loaded skill as explicitly user-invocable', async () => {
    const skillDir = await createTempDir('kodax-explicit-skill-');
    tempDirs.push(skillDir);
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: explicit-skill
description: Explicit skill
user-invocable: false
disable-model-invocation: true
---

Run explicitly.
`,
      'utf8'
    );

    const skill = await loadFullSkill(skillDir, 'project');

    expect(skill?.userInvocable).toBe(true);
    expect(skill?.disableModelInvocation).toBe(true);
  });
});
