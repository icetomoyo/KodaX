import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAgentsFiles, formatAgentsForPrompt, getKodaxGlobalDir } from "./agents-loader.js";

describe("agents-loader", () => {
  // Use OS tmpdir so the parent-directory walk doesn't pick up the repo's
  // own AGENTS.md / CLAUDE.md (added in fb15937 — moving this fixture out
  // of the repo prevents the loader from finding ancestor agent files).
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kodax-agents-loader-"));
  });

  afterEach(() => {
    // Cleanup test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("getKodaxGlobalDir", () => {
    it("should return ~/.kodax directory", () => {
      const globalDir = getKodaxGlobalDir();
      expect(globalDir).toContain(".kodax");
    });
  });

  describe("loadAgentsFiles", () => {
    it("should return empty array when no AGENTS files exist", () => {
      const files = loadAgentsFiles({ cwd: testDir });
      expect(files).toEqual([]);
    });

    it("should load AGENTS.md from current directory", () => {
      writeFileSync(join(testDir, "AGENTS.md"), "# Test Rules");

      const files = loadAgentsFiles({ cwd: testDir });
      expect(files).toHaveLength(1);
      expect(files[0].content).toBe("# Test Rules");
      expect(files[0].scope).toBe("directory");
    });

    it("should prefer AGENTS.md over CLAUDE.md", () => {
      writeFileSync(join(testDir, "AGENTS.md"), "# AGENTS");
      writeFileSync(join(testDir, "CLAUDE.md"), "# CLAUDE");

      const files = loadAgentsFiles({ cwd: testDir });
      expect(files).toHaveLength(1);
      expect(files[0].content).toBe("# AGENTS");
    });

    it("should load CLAUDE.md if AGENTS.md does not exist", () => {
      writeFileSync(join(testDir, "CLAUDE.md"), "# CLAUDE");

      const files = loadAgentsFiles({ cwd: testDir });
      expect(files).toHaveLength(1);
      expect(files[0].content).toBe("# CLAUDE");
    });

    it("should load .kodax/AGENTS.md with project scope", () => {
      mkdirSync(join(testDir, ".kodax"));
      writeFileSync(join(testDir, ".kodax", "AGENTS.md"), "# Project Rules");

      const files = loadAgentsFiles({ cwd: testDir, projectRoot: testDir });
      expect(files).toHaveLength(1);
      expect(files[0].scope).toBe("project");
    });

    it("should load files from parent directories", () => {
      const parentDir = join(testDir, "parent");
      const childDir = join(parentDir, "child");
      mkdirSync(childDir, { recursive: true });

      writeFileSync(join(parentDir, "AGENTS.md"), "# Parent Rules");
      writeFileSync(join(childDir, "AGENTS.md"), "# Child Rules");

      const files = loadAgentsFiles({ cwd: childDir });
      expect(files).toHaveLength(2);
      expect(files[0].content).toBe("# Parent Rules");
      expect(files[1].content).toBe("# Child Rules");
    });

    it("should not duplicate files", () => {
      writeFileSync(join(testDir, "AGENTS.md"), "# Rules");

      const files = loadAgentsFiles({ cwd: testDir, kodaxDir: testDir });
      expect(files).toHaveLength(1);
    });

    it("should handle file read errors gracefully", () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Create a directory with same name as file to cause read error
      const filePath = join(testDir, "AGENTS.md");
      mkdirSync(filePath, { recursive: true });

      const files = loadAgentsFiles({ cwd: testDir });
      expect(files).toHaveLength(0);
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    it("should load global config from kodaxDir", () => {
      const globalDir = join(testDir, "global");
      mkdirSync(globalDir);
      writeFileSync(join(globalDir, "AGENTS.md"), "# Global Rules");

      const files = loadAgentsFiles({ cwd: testDir, kodaxDir: globalDir });
      expect(files).toHaveLength(1);
      expect(files[0].scope).toBe("global");
      expect(files[0].content).toBe("# Global Rules");
    });

    it("should respect priority: global < directory < project", () => {
      const globalDir = join(testDir, "global");
      mkdirSync(globalDir);
      mkdirSync(join(testDir, ".kodax"));

      writeFileSync(join(globalDir, "AGENTS.md"), "# Global");
      writeFileSync(join(testDir, "AGENTS.md"), "# Directory");
      writeFileSync(join(testDir, ".kodax", "AGENTS.md"), "# Project");

      const files = loadAgentsFiles({
        cwd: testDir,
        kodaxDir: globalDir,
        projectRoot: testDir,
      });
      expect(files).toHaveLength(3);
      expect(files[0].scope).toBe("global");
      expect(files[1].scope).toBe("directory");
      expect(files[2].scope).toBe("project");
    });

    it("should keep project-level .kodax rules after nested directory rules", () => {
      const childDir = join(testDir, "packages", "app");
      mkdirSync(join(testDir, ".kodax"), { recursive: true });
      mkdirSync(childDir, { recursive: true });

      writeFileSync(join(testDir, ".kodax", "AGENTS.md"), "# Project Rules");
      writeFileSync(join(childDir, "AGENTS.md"), "# App Rules");

      const files = loadAgentsFiles({ cwd: childDir, projectRoot: testDir });
      expect(files).toHaveLength(2);
      expect(files[0].content).toBe("# App Rules");
      expect(files[1].content).toBe("# Project Rules");
      expect(files[1].scope).toBe("project");
    });

    it("should stop loading directory rules at project root", () => {
      const workspaceDir = join(testDir, "workspace");
      const projectDir = join(workspaceDir, "repo");
      const childDir = join(projectDir, "src");
      mkdirSync(childDir, { recursive: true });

      writeFileSync(join(workspaceDir, "AGENTS.md"), "# Workspace Rules");
      writeFileSync(join(projectDir, "AGENTS.md"), "# Project Dir Rules");
      writeFileSync(join(childDir, "AGENTS.md"), "# Child Rules");

      const files = loadAgentsFiles({ cwd: childDir, projectRoot: projectDir });
      expect(files.map((file) => file.content)).toEqual([
        "# Project Dir Rules",
        "# Child Rules",
      ]);
    });

    it("should only load AGENTS.md from global kodax directory", () => {
      const globalDir = join(testDir, "global");
      mkdirSync(globalDir);
      writeFileSync(join(globalDir, "CLAUDE.md"), "# Global Claude");

      const files = loadAgentsFiles({ cwd: testDir, kodaxDir: globalDir });
      expect(files).toEqual([]);
    });

    it("should only load AGENTS.md from project .kodax directory", () => {
      mkdirSync(join(testDir, ".kodax"));
      writeFileSync(join(testDir, ".kodax", "CLAUDE.md"), "# Project Claude");

      const files = loadAgentsFiles({ cwd: testDir, projectRoot: testDir });
      expect(files).toEqual([]);
    });

    it("should resolve project root boundaries from mixed separators", () => {
      const projectDir = join(testDir, "mixed-root");
      const childDir = join(projectDir, "child");
      mkdirSync(childDir, { recursive: true });

      writeFileSync(join(projectDir, "AGENTS.md"), "# Mixed Project");
      writeFileSync(join(childDir, "AGENTS.md"), "# Mixed Child");

      const mixedProjectRoot = projectDir.replace(/\\/g, "/");
      const files = loadAgentsFiles({ cwd: childDir, projectRoot: mixedProjectRoot });
      expect(files.map((file) => file.content)).toEqual([
        "# Mixed Project",
        "# Mixed Child",
      ]);
    });
  });

  describe("formatAgentsForPrompt", () => {
    it("should return empty string for empty files", () => {
      const result = formatAgentsForPrompt([]);
      expect(result).toBe("");
    });

    it("should format single file correctly", () => {
      const files = [{
        path: "/test/AGENTS.md",
        content: "# Test Rules",
        scope: "directory" as const
      }];

      const result = formatAgentsForPrompt(files);
      expect(result).toContain("# Project Context");
      expect(result).toContain("Directory Rules");
      expect(result).toContain("# Test Rules");
      expect(result).toContain("/test/AGENTS.md");
    });

    it("should format multiple files with separators", () => {
      const files = [
        { path: "/global/AGENTS.md", content: "# Global", scope: "global" as const },
        { path: "/local/AGENTS.md", content: "# Local", scope: "directory" as const }
      ];

      const result = formatAgentsForPrompt(files);
      expect(result).toContain("Global Rules");
      expect(result).toContain("Directory Rules");
      expect(result).toContain("---");
    });

    it("should use correct scope labels", () => {
      const files = [
        { path: "/g", content: "G", scope: "global" as const },
        { path: "/p", content: "P", scope: "project" as const },
        { path: "/d", content: "D", scope: "directory" as const }
      ];

      const result = formatAgentsForPrompt(files);
      expect(result).toContain("Global Rules");
      expect(result).toContain("Project Rules");
      expect(result).toContain("Directory Rules");
    });
  });
});
