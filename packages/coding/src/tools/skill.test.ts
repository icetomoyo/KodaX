import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetSkillRegistry, SkillRegistry } from '@kodax-ai/agent';
import { toolSkill } from './skill.js';

// The skill tool reads the global singleton via `getSkillRegistry()`. To
// give the tool a deterministic registry under test we reach into the
// same module and replace the singleton's underlying maps. Importing the
// concrete `SkillRegistry` and constructing one tied to the temp dir is
// the supported way per skill-registry.test.ts.

async function writeSkillMd(
  rootDir: string,
  sourceDir: string,
  name: string,
  description: string,
  body: string,
  dirName = name,
  frontmatter = '',
): Promise<string> {
  const skillDir = path.join(rootDir, sourceDir, dirName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${frontmatter}---\n\n${body}\n`,
    'utf8',
  );
  return skillDir;
}

// The skill tool reaches the registry via getSkillRegistry() (singleton).
// We populate the singleton by constructing a SkillRegistry against a
// scratch project root and then publishing it into the module's
// singleton slot through the registry's public discover() — but the
// singleton slot is private. Instead, we set process.cwd() such that
// the SkillRegistry the global function returns ends up pointing at our
// scratch tree.

describe('toolSkill (claudecode-parity skill invocation)', () => {
  let tempDir = '';
  let originalCwd = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'kodax-skill-tool-'));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    resetSkillRegistry();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('errors when called without a skill argument', async () => {
    const result = await toolSkill({}, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('missing required argument `skill`');
  });

  it('discovers project skills when the registry was not prewarmed', async () => {
    await writeSkillMd(
      tempDir,
      path.join('.kodax', 'skills'),
      'kodax-test-auto-discover',
      'Auto discovered skill',
      'Auto discover body',
    );

    resetSkillRegistry();

    const result = await toolSkill({ skill: 'kodax-test-auto-discover' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Auto discover body');
    expect(result).not.toContain('[Tool Error]');
  });

  it('uses a run-scoped Skill registry without mutating the global singleton', async () => {
    await writeSkillMd(
      tempDir,
      'selected',
      'kodax-selected-only',
      'Selected remote skill',
      'RUN-SCOPED-CONTENT',
    );
    const { SkillRegistry, getSkillRegistry } = await import('@kodax-ai/agent');
    const selected = new SkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'selected')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await selected.discover();

    const result = await toolSkill({ skill: 'kodax-selected-only' }, {
      backups: new Map(),
      executionCwd: tempDir,
      skillRegistry: selected,
    });

    expect(result).toContain('RUN-SCOPED-CONTENT');
    expect(getSkillRegistry().has('kodax-selected-only')).toBe(false);
  });

  it('errors when called with an empty skill name', async () => {
    const result = await toolSkill({ skill: '   ' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('missing required argument `skill`');
  });

  // The remaining tests exercise the full skill-registry singleton path.
  // To keep them isolated from any installed global skills the developer
  // may have, we use a SkillRegistry instance directly (mirroring
  // skill-registry.test.ts) and call the toolSkill handler whose body
  // routes through the same registry. The singleton is reset by the
  // `projectRoot !== _instanceProjectRoot` reset rule in
  // getSkillRegistry — passing our scratch root forces a fresh
  // instance scoped to that directory.

  it('returns the expanded skill content when the skill exists', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-skill-found',
      'Test skill for tool',
      '# Body header\n\nDo X then Y.',
    );

    // Publish into the singleton by constructing + discovering against
    // the scratch root. The singleton's projectRoot must match what
    // toolSkill sees via getSkillRegistry().
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: 'kodax-test-skill-found' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('<skill name="kodax-test-skill-found"');
    expect(result).toContain('Skill root:');
    expect(result).toContain('Body header');
    expect(result).toContain('Do X then Y.');
    expect(result).not.toContain('[Tool Error]');
  });

  it('keeps model tool invocation disabled for an explicit-only skill', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-explicit-only',
      'Explicit-only skill',
      'MODEL-MUST-NOT-LOAD-THIS',
      'kodax-test-explicit-only',
      'disable-model-invocation: true\n',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    await getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    }).discover();

    const result = await toolSkill({ skill: 'kodax-test-explicit-only' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('[Tool Error]');
    expect(result).toContain('model invocation disabled');
    expect(result).not.toContain('MODEL-MUST-NOT-LOAD-THIS');
  });

  it('routes a skill !`cmd` dynamic-context token through the host hook, not execSync (FEATURE_222)', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-dynctx-hook',
      'Dynamic context skill',
      'Result: !`echo hello-from-shell`',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    await getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    }).discover();

    const calls: Array<{ command: string; cwd: string }> = [];
    const result = await toolSkill({ skill: 'kodax-test-dynctx-hook' }, {
      backups: new Map(),
      executionCwd: tempDir,
      skillDynamicContext: {
        execute: async (command, cwd) => {
          calls.push({ command, cwd });
          return 'MEDIATED-BY-HOST';
        },
      },
    });

    // The host hook ran with the raw command; its output replaced the token.
    expect(calls).toEqual([{ command: 'echo hello-from-shell', cwd: tempDir }]);
    expect(result).toContain('MEDIATED-BY-HOST');
    expect(result).not.toContain('[Tool Error]');
  });

  it('refuses skill !`cmd` dynamic-context entirely when the host disables it (FEATURE_222)', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-dynctx-disabled',
      'Dynamic context skill',
      'Result: !`echo hello-from-shell`',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    await getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    }).discover();

    const hook = { called: false };
    const result = await toolSkill({ skill: 'kodax-test-dynctx-disabled' }, {
      backups: new Map(),
      executionCwd: tempDir,
      skillDynamicContext: {
        disable: true,
        // Even with a hook present, disable (Tier 1) short-circuits before it.
        execute: async () => {
          hook.called = true;
          return 'SHOULD-NOT-RUN';
        },
      },
    });

    expect(hook.called).toBe(false);
    expect(result).toContain('[Error: Dynamic context disabled by host.');
    expect(result).not.toContain('SHOULD-NOT-RUN');
  });

  it('returns support file locations for user skills', async () => {
    const skillDir = await writeSkillMd(
      tempDir,
      'user',
      'kodax-test-user-support',
      'User skill with resources',
      'Read references/guide.md and use scripts/check.mjs.',
    );
    await mkdir(path.join(skillDir, 'references'), { recursive: true });
    await mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await writeFile(path.join(skillDir, 'references', 'guide.md'), '# Guide', 'utf8');
    await writeFile(path.join(skillDir, 'scripts', 'check.mjs'), 'export {};', 'utf8');

    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [],
      userPaths: [path.join(tempDir, 'user')],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: 'kodax-test-user-support' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain(`Skill root: ${skillDir.replace(/\\/g, '/')}`);
    expect(result).toContain(
      `references/guide.md: ${path.join(skillDir, 'references', 'guide.md').replace(/\\/g, '/')}`,
    );
    expect(result).toContain(
      `scripts/check.mjs: ${path.join(skillDir, 'scripts', 'check.mjs').replace(/\\/g, '/')}`,
    );
  });

  it('tolerates a leading slash in the skill name', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-skill-slash',
      'Slash-tolerated skill',
      'Slash body',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: '/kodax-test-skill-slash' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(result).toContain('Slash body');
    expect(result).not.toContain('[Tool Error]');
  });

  it('tolerates legacy slash skill tokens in the skill name', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-skill-legacy-token',
      'Legacy-token skill',
      'Legacy token body',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: '/skill:kodax-test-skill-legacy-token' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(result).toContain('Legacy token body');
    expect(result).not.toContain('[Tool Error]');
  });

  it('tolerates legacy namespaced skill tokens in the skill name', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'github:yeet',
      'Namespaced-token skill',
      'Namespaced token body',
      'github-yeet',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: '/skill:github:yeet' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(result).toContain('Namespaced token body');
    expect(result).not.toContain('[Tool Error]');
  });

  it('directs an unknown Skill to the authorized catalog without repeating the registry', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-known',
      'A known skill',
      'body',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: 'does-not-exist' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('unknown skill "does-not-exist"');
    expect(result).toContain('available Skill catalog');
  });

  it('keeps unknown-Skill errors bounded and never discloses disabled names', async () => {
    for (let index = 0; index < 180; index++) {
      await writeSkillMd(tempDir, 'project', `inspect-${String(index).padStart(3, '0')}-${'a'.repeat(42)}`,
        'Inspect evidence', 'Inspect.');
    }
    await writeSkillMd(tempDir, 'project', 'disabled-in-model-catalog', 'Disabled Skill', 'Disabled.',
      'disabled-in-model-catalog', 'disable-model-invocation: true\n');
    const registry = new SkillRegistry(tempDir, { projectPaths: [path.join(tempDir, 'project')],
      userPaths: [], pluginPaths: [], builtinPath: path.join(tempDir, 'none') });
    await registry.discover();
    for (const skill of ['missing', 'missing-😀'.repeat(2_000)]) {
      const result = await toolSkill({ skill }, { backups: new Map(), executionCwd: tempDir, skillRegistry: registry });
      expect(result.length).toBeLessThanOrEqual(8_000);
      expect(result.includes('disabled-in-model-catalog')).toBe(false);
      expect(result).toContain('available Skill catalog');
      expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    }
  });
});
