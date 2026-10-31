import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { createHash } from 'node:crypto';
import { formatSkillsSystemPrompt, SKILL_CATALOG_INSTRUCTIONS, SkillRegistry } from "./skill-registry.js";
import { SKILL_CATALOG_INSTRUCTIONS as publicCatalogInstructions } from './index.js';
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
  it('exposes the canonical catalog instructions without changing default SDK bytes or visibility', () => {
    const skill = { name: 'fixture', description: 'Match fixture tasks.', userInvocable: true,
      argumentHint: '[target]', path: '/fixture/SKILL.md', source: 'builtin' as const, disableModelInvocation: false };
    const formatted = formatSkillsSystemPrompt([skill, { ...skill, name: 'explicit-only', disableModelInvocation: true }]);
    expect(typeof SKILL_CATALOG_INSTRUCTIONS).toBe('string');
    expect(publicCatalogInstructions).toBe(SKILL_CATALOG_INSTRUCTIONS);
    expect(formatted.startsWith(SKILL_CATALOG_INSTRUCTIONS)).toBe(true);
    expect(createHash('sha256').update(formatted).digest('hex')).toBe('428b950a19f66c07f820b6cc0f1e739f65b15ab7e2a237c676d630f20582e598');
    expect(formatted).toContain('- fixture: [target] Match fixture tasks.');
    expect(formatted).not.toContain('explicit-only');
    expect(formatSkillsSystemPrompt([])).toBe('');
    expect(formatSkillsSystemPrompt([{ ...skill, disableModelInvocation: true }])).toBe('');
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
