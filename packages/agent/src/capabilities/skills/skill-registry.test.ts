import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, symlink, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { formatSkillsSystemPrompt, SkillRegistry } from "./skill-registry.js";
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '../../diagnostics.js';
import { createTempDir, removeTempDir } from "./test-utils/temp-dir.js";

const tempDirs: string[] = [];
const io = vi.hoisted(() => ({ afterRead: undefined as ((file: string) => Promise<void>) | undefined }));
vi.mock('fs/promises', async original => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const data = await actual.readFile(...args);
    await io.afterRead?.(String(args[0]));
    return data;
  } };
});

afterEach(async () => {
  io.afterRead = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir)));
});

async function writeSkill(
  rootDir: string,
  sourceDir: string,
  name: string,
  description: string,
  frontmatter = ""
): Promise<void> {
  const skillDir = join(rootDir, sourceDir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
${frontmatter}
---

# ${name}

${description}
`,
    "utf8"
  );
}

describe("SkillRegistry", () => {
  it('discovers project .agents Skills while retaining .kodax precedence', async () => {
    const root = await createTempDir('kodax-skill-compatible-');
    tempDirs.push(root);
    await writeSkill(root, '.agents/skills', 'shared-only', 'Shared project Skill');
    await writeSkill(root, '.agents/skills', 'overridden', 'Shared fallback');
    await writeSkill(root, '.kodax/skills', 'overridden', 'Native project winner');
    const registry = new SkillRegistry(root, { userPaths: [], pluginPaths: [], builtinPath: join(root, 'none') });
    await registry.discover();
    expect(registry.get('shared-only')?.source).toBe('project');
    expect((await registry.loadFull('overridden')).content).toContain('Native project winner');
  });
  it('finds nested Skills without scanning support trees or following directory cycles', async () => {
    const root = await createTempDir('kodax-skill-nested-');
    tempDirs.push(root);
    await writeSkill(root, 'project/group/subgroup', 'nested', 'Nested Skill');
    await writeSkill(root, 'project', 'parent', 'Parent Skill');
    await writeSkill(root, 'project/parent/support', 'private', 'Support content is not a separate Skill');
    await writeSkill(root, 'project/.hidden', 'hidden', 'Hidden content');
    await writeSkill(root, 'project/node_modules', 'dependency', 'Dependency content');
    await symlink(join(root, 'project'), join(root, 'project/group/back'), process.platform === 'win32' ? 'junction' : 'dir');
    const registry = new SkillRegistry(root, { projectPaths: [join(root, 'project')],
      userPaths: [], pluginPaths: [], builtinPath: join(root, 'none') });
    await registry.discover();
    expect(registry.list().map(skill => skill.name)).toEqual(['nested', 'parent']);
    expect(registry.discoveryIncomplete).toBe(false);
  });
  it('reports shadowed Skill paths without treating precedence as incomplete discovery', async () => {
    const root = await createTempDir('kodax-skill-shadowed-');
    tempDirs.push(root);
    await writeSkill(root, 'project', 'same-name', 'Project winner');
    await writeSkill(root, 'user', 'same-name', 'User fallback');
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink(diagnostic => diagnostics.push(diagnostic));
    try {
      const registry = new SkillRegistry(root, { projectPaths: [join(root, 'project')],
        userPaths: [join(root, 'user')], pluginPaths: [], builtinPath: join(root, 'none') });
      await registry.discover();
      expect(registry.discoveryIncomplete).toBe(false);
      expect((await registry.loadFull('same-name')).description).toBe('Project winner');
      expect(diagnostics).toContainEqual(expect.objectContaining({ source: 'agent:skills', level: 'warn',
        detail: { code: 'skill_shadowed', name: 'same-name',
          selectedPath: join(root, 'project/same-name/SKILL.md'),
          shadowedPath: join(root, 'user/same-name/SKILL.md') } }));
    } finally { restore(); }
  });
  it('bounds a large model catalog and reports omissions without disabling explicit invocation', async () => {
    const root = await createTempDir('kodax-skill-catalog-');
    tempDirs.push(root);
    for (let index = 0; index < 40; index++) {
      await writeSkill(root, 'project', `skill-${String(index).padStart(2, '0')}`,
        `Inspect case ${index}: ${'详细说明😀'.repeat(180)}`);
    }
    await writeSkill(root, 'project', 'explicit-only', 'Private trigger', 'disable-model-invocation: true');
    const registry = new SkillRegistry(root, { projectPaths: [join(root, 'project')],
      userPaths: [], pluginPaths: [], builtinPath: join(root, 'none') });
    await registry.discover();
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink(diagnostic => diagnostics.push(diagnostic));
    let snippet: string;
    try { snippet = registry.getSystemPromptSnippet(); }
    finally { restore(); }
    expect(snippet.length).toBeLessThanOrEqual(8_000);
    expect(snippet).toContain('- skill-00: Inspect case 0:');
    expect(snippet).toMatch(/\d+ Skills omitted/);
    expect(snippet).not.toContain('explicit-only');
    expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    const included = snippet.split('\n').filter(line => line.startsWith('- skill-')).length;
    expect(diagnostics).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({
      code: 'skill_catalog_shortened', total: 40, included, omitted: 40 - included,
    }) }));
    expect(registry.size).toBe(41);
    const invocation = await registry.invoke('skill-39', '', { workingDirectory: root, projectRoot: root });
    expect(invocation.success).toBe(true);
    expect(invocation.content).toContain('Inspect case 39:');
  });

  it('renders catalog metadata on one line without letting a long hint consume the catalog', () => {
    const snippet = formatSkillsSystemPrompt([{ name: 'inspect', description: 'Inspect\nsource\tfiles',
      argumentHint: 'arg '.repeat(5_000), path: '/skills/inspect', source: 'project',
      userInvocable: true, disableModelInvocation: false }]);
    expect(snippet.length).toBeLessThanOrEqual(8_000);
    expect(snippet).toContain('Inspect source files');
    expect(snippet).toContain('- inspect:');
  });
  it('does not republish an in-flight body from an older discovery', async () => {
    const root = await createTempDir('kodax-skill-concurrent-');
    tempDirs.push(root);
    await writeSkill(root, 'user', 'refreshable', 'Old body');
    const registry = new SkillRegistry(root, { projectPaths: [join(root, 'project')],
      userPaths: [join(root, 'user')], pluginPaths: [], builtinPath: join(root, 'builtin') });
    await registry.discover();
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    io.afterRead = async file => {
      if (file !== join(root, 'user', 'refreshable', 'SKILL.md')) return;
      io.afterRead = undefined;
      entered();
      await blocked;
    };
    const pending = registry.loadFull('refreshable');
    try {
      await reading;
      await writeSkill(root, 'project', 'refreshable', 'New body', 'disable-model-invocation: true');
      await registry.discover();
    } finally { release(); }
    const loaded = await pending;
    expect(loaded.source).toBe('project');
    expect(loaded.disableModelInvocation).toBe(true);
    expect((await registry.loadFull('refreshable')).content).toContain('New body');
  });
  it('rediscovery replaces cached bodies, invocation flags and source precedence', async () => {
    const root = await createTempDir('kodax-skill-rediscover-');
    tempDirs.push(root);
    await writeSkill(root, 'user', 'refreshable', 'Old body');
    const registry = new SkillRegistry(root, { projectPaths: [join(root, 'project')],
      userPaths: [join(root, 'user')], pluginPaths: [], builtinPath: join(root, 'builtin') });
    await registry.discover();
    expect((await registry.loadFull('refreshable')).content).toContain('Old body');
    await writeSkill(root, 'project', 'refreshable', 'New body', 'disable-model-invocation: true');
    await registry.discover();
    const current = await registry.loadFull('refreshable');
    expect(current.content).toContain('New body');
    expect(current.source).toBe('project');
    expect(current.disableModelInvocation).toBe(true);
    await unlink(join(root, 'project', 'refreshable', 'SKILL.md'));
    await unlink(join(root, 'user', 'refreshable', 'SKILL.md'));
    await registry.discover();
    await expect(registry.loadFull('refreshable')).rejects.toThrow('Skill not found');
  });
  it('retains incomplete discovery without losing valid Skills and clears it after source repair', async () => {
    const root = await createTempDir('kodax-skill-discovery-failure-');
    tempDirs.push(root);
    const unavailable = join(root, 'configured-source');
    await writeFile(unavailable, 'not a directory');
    await writeSkill(root, 'valid', 'available-skill', 'A valid Skill');
    const registry = new SkillRegistry(root, { projectPaths: [unavailable, join(root, 'valid')],
      userPaths: [], pluginPaths: [], builtinPath: join(root, 'absent-builtins') });
    await registry.discover();
    expect(registry.discoveryIncomplete).toBe(true);
    expect(registry.has('available-skill')).toBe(true);
    await expect(registry.loadFull('available-skill')).resolves.toMatchObject({ name: 'available-skill' });
    await unlink(unavailable);
    await mkdir(unavailable);
    await registry.discover();
    expect(registry.discoveryIncomplete).toBe(false);
    expect(registry.has('available-skill')).toBe(true);
  });

  it("discovers skills, exposes read-only list accessors, and caches full skill loads", async () => {
    const rootDir = await createTempDir("kodax-skill-registry-");
    tempDirs.push(rootDir);

    await writeSkill(rootDir, "project", "project-skill", "Project skill");
    await writeSkill(rootDir, "user", "user-skill", "User skill");

    const registry = new SkillRegistry(rootDir, {
      projectPaths: [join(rootDir, "project")],
      userPaths: [join(rootDir, "user")],
      pluginPaths: [],
      builtinPath: join(rootDir, "builtin"),
    });

    await registry.discover();

    expect(registry.size).toBe(2);
    expect(registry.skills.size).toBe(2);
    expect(registry.has("project-skill")).toBe(true);
    expect(registry.list().map((skill) => skill.name)).toEqual([
      "project-skill",
      "user-skill",
    ]);
    expect(registry.listUserInvocable().map((skill) => skill.name)).toEqual([
      "project-skill",
      "user-skill",
    ]);

    const firstLoad = await registry.loadFull("project-skill");
    await writeFile(
      join(rootDir, "project", "project-skill", "SKILL.md"),
      `---
name: project-skill
description: Updated project skill
---

# project-skill

Updated project skill
`,
      "utf8"
    );
    const secondLoad = await registry.loadFull("project-skill");

    expect(secondLoad).toBe(firstLoad);
    expect(secondLoad.description).toBe("Project skill");
  });

  it("reload refreshes changed skills and clears the full skill cache", async () => {
    const rootDir = await createTempDir("kodax-skill-reload-");
    tempDirs.push(rootDir);

    await writeSkill(rootDir, "project", "reload-skill", "Original project skill");

    const registry = new SkillRegistry(rootDir, {
      projectPaths: [join(rootDir, "project")],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(rootDir, "builtin"),
    });

    await registry.discover();
    const firstLoad = await registry.loadFull("reload-skill");

    await writeSkill(
      rootDir,
      "project",
      "reload-skill",
      "Updated project skill with longer text"
    );

    const staleLoad = await registry.loadFull("reload-skill");
    expect(staleLoad).toBe(firstLoad);
    expect(staleLoad.description).toBe("Original project skill");

    await registry.reload();

    expect(registry.get("reload-skill")?.description).toBe(
      "Updated project skill with longer text"
    );

    const secondLoad = await registry.loadFull("reload-skill");
    expect(secondLoad).not.toBe(firstLoad);
    expect(secondLoad.description).toBe("Updated project skill with longer text");
    expect(secondLoad.content).toContain("Updated project skill with longer text");
  });

  it("getSystemPromptSnippet routes skill invocation through the `skill` tool", async () => {
    const rootDir = await createTempDir("kodax-skill-snippet-");
    tempDirs.push(rootDir);
    await writeSkill(rootDir, "project", "agent-browser", "Browser automation");

    const registry = new SkillRegistry(rootDir, {
      projectPaths: [join(rootDir, "project")],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(rootDir, "builtin"),
    });
    await registry.discover();

    const snippet = registry.getSystemPromptSnippet();

    // Tool-of-record is the `skill` tool, not `read SKILL.md`.
    expect(snippet).toContain("`skill` tool");
    expect(snippet).toContain("invoke it via the `skill` tool");
    expect(snippet).toContain("BLOCKING REQUIREMENT");
    expect(snippet).toContain("MUST invoke it via the `skill` tool");
    expect(snippet).toContain('Active skill invocation');
    expect(snippet).toContain('do NOT call the `skill` tool for that Skill again');

    // The legacy "Use the read tool" wording is gone — checking
    // negative direction so a future refactor that re-introduces it
    // trips this test.
    expect(snippet).not.toContain("Use the read tool to load");
    expect(snippet).not.toContain("MUST read the relevant skill's `SKILL.md`");
    // Discovery still surfaces the skill, but without the SKILL.md path
    // hint that would have invited a fallback `read` call.
    expect(snippet).toContain("- agent-browser:");
    expect(snippet).toContain("Browser automation");
    expect(snippet).not.toContain("/SKILL.md");
    expect(snippet).not.toContain("(Location:");
  });

  it("allows an enabled skill to be explicitly invoked when model invocation is disabled", async () => {
    const rootDir = await createTempDir("kodax-skill-explicit-invoke-");
    tempDirs.push(rootDir);
    await writeSkill(
      rootDir,
      "project",
      "explicit-only",
      "Explicit-only skill",
      "disable-model-invocation: true"
    );

    const registry = new SkillRegistry(rootDir, {
      projectPaths: [join(rootDir, "project")],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(rootDir, "builtin"),
    });
    await registry.discover();

    expect(registry.listUserInvocable().map((skill) => skill.name)).toContain(
      "explicit-only"
    );
    expect(registry.getSystemPromptSnippet()).not.toContain("explicit-only");

    const result = await registry.invoke("explicit-only", "review src", {
      workingDirectory: rootDir,
    });

    expect(result).toEqual({
      success: true,
      content: expect.stringContaining("Explicit-only skill"),
    });
  });
});
