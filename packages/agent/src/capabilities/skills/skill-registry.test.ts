import { afterEach, describe, expect, it } from "vitest";
import { mkdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { SkillRegistry } from "./skill-registry.js";
import { createTempDir, removeTempDir } from "./test-utils/temp-dir.js";

const tempDirs: string[] = [];

afterEach(async () => {
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
