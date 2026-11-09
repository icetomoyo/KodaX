import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { expandSkillForLLM } from './skill-expander.js';
import { loadFullSkill } from './skill-loader.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir)));
});

function displayPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

describe('expandSkillForLLM', () => {
  it('includes the skill root and support file paths for user skills', async () => {
    const rootDir = await createTempDir('kodax-skill-expander-');
    tempDirs.push(rootDir);
    const skillDir = join(rootDir, 'agents-skills', 'design-skill');

    await mkdir(join(skillDir, 'references'), { recursive: true });
    await mkdir(join(skillDir, 'assets'), { recursive: true });
    await mkdir(join(skillDir, 'scripts'), { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: design-skill
description: Test design skill
---

Read references/animation-best-practices.md and use assets/animations.jsx.
`,
      'utf8',
    );
    await writeFile(
      join(skillDir, 'references', 'animation-best-practices.md'),
      '# Animation best practices',
      'utf8',
    );
    await writeFile(join(skillDir, 'assets', 'animations.jsx'), 'export const Stage = {};', 'utf8');
    await writeFile(join(skillDir, 'scripts', 'render.mjs'), 'export {};', 'utf8');

    const skill = await loadFullSkill(skillDir, 'user');
    if (!skill) {
      throw new Error('Expected test skill to load');
    }

    const expanded = await expandSkillForLLM(skill, '', {
      workingDirectory: rootDir,
      projectRoot: rootDir,
    });

    expect(expanded.content).toContain(`Skill root: ${displayPath(skillDir)}`);
    expect(expanded.content).toContain('Support roots:');
    expect(expanded.content).toContain(
      `references/animation-best-practices.md: ${displayPath(join(skillDir, 'references', 'animation-best-practices.md'))}`,
    );
    expect(expanded.content).toContain(
      `assets/animations.jsx: ${displayPath(join(skillDir, 'assets', 'animations.jsx'))}`,
    );
    expect(expanded.content).toContain(
      `scripts/render.mjs: ${displayPath(join(skillDir, 'scripts', 'render.mjs'))}`,
    );
  });

  it('keeps project work paths separate from project skill support paths', async () => {
    const rootDir = await createTempDir('kodax-project-skill-expander-');
    tempDirs.push(rootDir);
    const skillDir = join(rootDir, '.kodax', 'skills', 'project-skill');

    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: project-skill
description: Test project skill
---

Read references/project-patterns.md before editing src/index.ts.
`,
      'utf8',
    );
    await writeFile(
      join(skillDir, 'references', 'project-patterns.md'),
      '# Project patterns',
      'utf8',
    );

    const skill = await loadFullSkill(skillDir, 'project');
    if (!skill) {
      throw new Error('Expected test skill to load');
    }

    const expanded = await expandSkillForLLM(skill, '', {
      workingDirectory: rootDir,
      projectRoot: rootDir,
    });

    expect(expanded.content).toContain(
      'Project work paths are relative to the project root; skill support files are relative to the skill root above.',
    );
    expect(expanded.content).not.toContain('References are relative to the project root.');
    expect(expanded.content).toContain(
      `references/project-patterns.md: ${displayPath(join(skillDir, 'references', 'project-patterns.md'))}`,
    );
  });

  it('lists root-level and non-conventional support files with absolute paths', async () => {
    const rootDir = await createTempDir('kodax-skill-expander-');
    tempDirs.push(rootDir);
    const skillDir = join(rootDir, 'skills', 'feature-manager');
    await mkdir(join(skillDir, 'agents'), { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'),
      '---\nname: feature-manager\ndescription: Track features\n---\n\nFEATURE_LIST.md structure: see `REFERENCE.md`. Grade with agents/grader.md.\n', 'utf8');
    await writeFile(join(skillDir, 'REFERENCE.md'), '# Reference', 'utf8');
    await writeFile(join(skillDir, 'agents', 'grader.md'), '# Grader', 'utf8');

    const skill = await loadFullSkill(skillDir, 'user');
    if (!skill) throw new Error('Expected test skill to load');
    const expanded = await expandSkillForLLM(skill, '', { workingDirectory: rootDir, projectRoot: rootDir });

    expect(expanded.content).toContain(`- REFERENCE.md: ${displayPath(join(skillDir, 'REFERENCE.md'))}`);
    expect(expanded.content).toContain(`- agents/grader.md: ${displayPath(join(skillDir, 'agents', 'grader.md'))}`);
    expect(expanded.content).toContain(`- agents/: ${displayPath(skillDir)}/agents (1 files)`);
    expect(expanded.content).toContain('use the listed absolute path');
    expect(expanded.content).not.toContain('`references/...`, `assets/...`');
  });

  it('adds no support section when the skill bundles no files', async () => {
    const rootDir = await createTempDir('kodax-skill-expander-');
    tempDirs.push(rootDir);
    const skillDir = join(rootDir, 'skills', 'bare');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: bare\ndescription: Bare\n---\n\nEdit FEATURE_LIST.md.\n', 'utf8');

    const skill = await loadFullSkill(skillDir, 'user');
    if (!skill) throw new Error('Expected test skill to load');
    const expanded = await expandSkillForLLM(skill, '', { workingDirectory: rootDir, projectRoot: rootDir });

    expect(expanded.content).not.toContain('Support file inventory');
    expect(expanded.content).not.toContain('Skill support files');
  });

  it('substitutes the skill directory variables with a forward-slash path', async () => {
    const rootDir = await createTempDir('kodax-skill-expander-');
    tempDirs.push(rootDir);
    const skillDir = join(rootDir, 'skills', 'runner');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'),
      '---\nname: runner\ndescription: Runner\n---\n\nRun `node ${CLAUDE_SKILL_DIR}/scripts/a.js` or `node ${KODAX_SKILL_DIR}/scripts/b.js`.\n', 'utf8');

    const skill = await loadFullSkill(skillDir, 'user');
    if (!skill) throw new Error('Expected test skill to load');
    const expanded = await expandSkillForLLM(skill, '', { workingDirectory: rootDir, projectRoot: rootDir });

    expect(expanded.content).toContain(`node ${displayPath(skillDir)}/scripts/a.js`);
    expect(expanded.content).toContain(`node ${displayPath(skillDir)}/scripts/b.js`);
  });
});

describe('builtin skills', () => {
  const builtinRoot = join(dirname(fileURLToPath(import.meta.url)), 'builtin');
  const SUPPORT_PATH = /(?<![\w./-])((?:references|scripts|assets|templates|resources|agents)\/[\w./-]*\w)/g;

  it.each(readdirSync(builtinRoot))('lists every support file %s mentions', async (name) => {
    const skillDir = join(builtinRoot, name);
    const skill = await loadFullSkill(skillDir, 'builtin');
    if (!skill) throw new Error(`Expected builtin skill ${name} to load`);
    const expanded = await expandSkillForLLM(skill, '', {
      workingDirectory: skillDir, projectRoot: skillDir, disableDynamicContext: true,
    });

    const mentioned = [...new Set([...skill.content.matchAll(SUPPORT_PATH)].map((match) => match[1]!))]
      .filter((path) => !path.endsWith('/'));
    for (const relativePath of mentioned) {
      expect(expanded.content, `${name} mentions ${relativePath}`).toContain(
        `- ${relativePath}: ${displayPath(join(skillDir, ...relativePath.split('/')))}`,
      );
    }
  });
});
