import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs, { mkdirSync, writeFileSync, rmSync, mkdtempSync, utimesSync, statSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadAgentsFiles,
  loadInstructionFiles,
  formatAgentsForPrompt,
  getKodaxGlobalDir,
  clearAgentsLoaderCacheForTesting,
} from "./agents-loader.js";

describe("agents-loader", () => {
  // Use OS tmpdir so the parent-directory walk doesn't pick up the repo's
  // own AGENTS.md / CLAUDE.md (added in fb15937 — moving this fixture out
  // of the repo prevents the loader from finding ancestor agent files).
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kodax-agents-loader-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    clearAgentsLoaderCacheForTesting();
    // Cleanup test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("getKodaxGlobalDir", () => {
    it("should return ~/.kodax directory when no config home is set", () => {
      vi.stubEnv("KODAX_HOME", undefined);
      const globalDir = getKodaxGlobalDir();
      expect(globalDir).toBe(join(homedir(), ".kodax"));
    });
  });

  describe("loadAgentsFiles", () => {
    it("keeps the legacy editor list restricted to AGENTS files even when rules exist", () => {
      const globalDir = join(testDir, "global");
      mkdirSync(join(globalDir, "rules"), { recursive: true });
      mkdirSync(join(testDir, ".kodax", "rules"), { recursive: true });
      writeFileSync(join(globalDir, "AGENTS.md"), "global agents");
      writeFileSync(join(testDir, "AGENTS.md"), "project agents");
      writeFileSync(join(globalDir, "rules", "a.md"), "global fragment");
      writeFileSync(join(testDir, ".kodax", "rules", "b.md"), "project fragment");
      const files = loadAgentsFiles({ cwd: testDir, projectRoot: testDir, kodaxDir: globalDir });
      expect(files.map(file => file.content)).toEqual(["global agents", "project agents"]);
      expect(files[0]).toEqual({ path: join(globalDir, "AGENTS.md"), content: 'global agents', scope: 'global' });
    });

    it("bounds provenance overhead when many tiny rule fragments exist", () => {
      const globalDir = join(testDir, "global");
      const rulesDir = join(globalDir, "rules");
      mkdirSync(rulesDir, { recursive: true });
      for (let index = 0; index < 200; index++) {
        writeFileSync(join(rulesDir, `rule-${index.toString().padStart(3, "0")}.md`), "x");
      }
      const onDiagnostic = vi.fn();
      const files = loadInstructionFiles({ cwd: testDir, projectRoot: testDir, kodaxDir: globalDir, onDiagnostic });
      expect(Buffer.byteLength(formatAgentsForPrompt(files), "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect(onDiagnostic).toHaveBeenCalled();
    });

    it("uses cwd for project fragments outside a Git repository and avoids duplicate sources", () => {
      const configDir = join(testDir, ".kodax");
      mkdirSync(join(configDir, "rules"), { recursive: true });
      writeFileSync(join(configDir, "rules", "testing.md"), "one shared source");
      expect(loadInstructionFiles({ cwd: testDir, kodaxDir: join(testDir, "missing") })
        .map(file => file.content)).toEqual(["one shared source"]);
      const files = loadInstructionFiles({ cwd: testDir, projectRoot: testDir, kodaxDir: configDir });
      expect(files.map(file => file.content)).toEqual(["one shared source"]);
      expect(files[0].scope).toBe("global");
    });

    it("rejects a linked rules directory outside its scope while retaining AGENTS", () => {
      const configDir = join(testDir, ".kodax");
      const outside = join(testDir, "other-home");
      const projectRoot = join(testDir, "project");
      mkdirSync(configDir);
      mkdirSync(outside);
      mkdirSync(join(projectRoot, ".kodax"), { recursive: true });
      writeFileSync(join(outside, "private.md"), "external sentinel");
      writeFileSync(join(projectRoot, "AGENTS.md"), "existing instructions");
      symlinkSync(outside, join(projectRoot, ".kodax", "rules"), "junction");
      const onDiagnostic = vi.fn();
      const files = loadInstructionFiles({ cwd: projectRoot, projectRoot, kodaxDir: configDir, onDiagnostic });
      expect(files.map(file => file.content)).toEqual(["existing instructions"]);
      expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        path: join(projectRoot, ".kodax", "rules"), reason: expect.stringContaining("link"),
      }));
    });

    it("reuses directory and content caches but observes adds, changes and removals", () => {
      const rulesDir = join(testDir, ".kodax", "rules");
      mkdirSync(rulesDir, { recursive: true });
      const rulePath = join(rulesDir, "testing.md");
      writeFileSync(rulePath, "first rule");
      const options = { cwd: testDir, projectRoot: testDir, kodaxDir: join(testDir, "home") };
      const listSpy = vi.spyOn(fs, "readdirSync");
      const readSpy = vi.spyOn(fs, "readSync");
      syncBuiltinESMExports();
      expect(loadInstructionFiles(options).map(file => file.content)).toEqual(["first rule"]);
      const listings = listSpy.mock.calls.length;
      const reads = readSpy.mock.calls.length;
      expect(listings).toBe(1);
      expect(reads).toBeGreaterThan(0);
      expect(loadInstructionFiles(options).map(file => file.content)).toEqual(["first rule"]);
      expect(listSpy).toHaveBeenCalledTimes(listings);
      expect(readSpy).toHaveBeenCalledTimes(reads);
      writeFileSync(rulePath, "updated longer rule");
      expect(loadInstructionFiles(options).map(file => file.content)).toEqual(["updated longer rule"]);
      writeFileSync(join(rulesDir, "z.md"), "added");
      expect(loadInstructionFiles(options).map(file => file.content)).toEqual(["updated longer rule", "added"]);
      rmSync(rulePath);
      expect(loadInstructionFiles(options).map(file => file.content)).toEqual(["added"]);
    });

    it("keeps whole UTF-8 files within independent scope budgets and reports skipped paths", () => {
      const globalDir = join(testDir, "global");
      const rulesDir = join(globalDir, "rules");
      const projectRules = join(testDir, ".kodax", "rules");
      mkdirSync(rulesDir, { recursive: true });
      mkdirSync(projectRules, { recursive: true });
      writeFileSync(join(rulesDir, "00-large.md"), "界".repeat(3000));
      writeFileSync(join(rulesDir, "01.md"), "a".repeat(7000));
      writeFileSync(join(rulesDir, "02.md"), "b".repeat(7000));
      writeFileSync(join(rulesDir, "03.md"), "c".repeat(3000));
      writeFileSync(join(projectRules, "testing.md"), "project still fits");
      writeFileSync(join(globalDir, "AGENTS.md"), "existing user agents");
      const onDiagnostic = vi.fn();

      const files = loadInstructionFiles({
        cwd: testDir, kodaxDir: globalDir, projectRoot: testDir, onDiagnostic,
      });
      expect(files.map(file => file.content)).toEqual([
        "a".repeat(7000), "b".repeat(7000), "existing user agents", "project still fits",
      ]);
      expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        path: join(rulesDir, "00-large.md"), code: 'file_too_large', reason: expect.stringContaining("8192"),
      }));
      expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        path: join(rulesDir, "03.md"), code: 'scope_budget_exceeded', reason: expect.stringContaining("16384"),
      }));
    });

    it("preserves exact AGENTS prompt bytes for absent, empty and irrelevant rules directories", () => {
      const globalDir = join(testDir, "global");
      const options = { cwd: testDir, kodaxDir: globalDir, projectRoot: testDir };
      writeFileSync(join(testDir, "AGENTS.md"), "existing rules");
      const baseline = formatAgentsForPrompt(loadInstructionFiles(options));
      mkdirSync(join(globalDir, "rules"), { recursive: true });
      mkdirSync(join(testDir, ".kodax", "rules"), { recursive: true });
      expect(formatAgentsForPrompt(loadInstructionFiles(options))).toBe(baseline);
      writeFileSync(join(globalDir, "rules", "empty.md"), "  \n");
      writeFileSync(join(globalDir, "rules", "commands.rules"), "unrelated policy");
      expect(formatAgentsForPrompt(loadInstructionFiles(options))).toBe(baseline);
    });

    it("loads both rules directories before their AGENTS defaults with stable provenance", () => {
      const globalDir = join(testDir, "global");
      const childDir = join(testDir, "src");
      mkdirSync(join(globalDir, "rules"), { recursive: true });
      mkdirSync(join(testDir, ".kodax", "rules"), { recursive: true });
      mkdirSync(childDir);
      writeFileSync(join(globalDir, "rules", "z.md"), "user last");
      writeFileSync(join(globalDir, "rules", "testing.md"), "user testing");
      writeFileSync(join(globalDir, "AGENTS.md"), "user agents");
      writeFileSync(join(testDir, ".kodax", "rules", "testing.md"), "project testing");
      writeFileSync(join(testDir, "AGENTS.md"), "root agents");
      writeFileSync(join(childDir, "AGENTS.md"), "child agents");
      writeFileSync(join(testDir, ".kodax", "AGENTS.md"), "project agents");

      const files = loadInstructionFiles({ cwd: childDir, kodaxDir: globalDir, projectRoot: testDir });
      expect(files.map(file => file.content)).toEqual([
        "user testing", "user last", "user agents", "project testing",
        "root agents", "child agents", "project agents",
      ]);
      expect(files[0].scope).toBe("global");
      expect(files[3].scope).toBe("project");
      expect(files.map(file => file.kind)).toEqual(["rule", "rule", "agents", "rule", "agents", "agents", "agents"]);
      const prompt = formatAgentsForPrompt(files);
      expect(prompt).toContain(join(globalDir, "rules", "testing.md"));
      expect(prompt).toContain(join(testDir, ".kodax", "rules", "testing.md"));
    });

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

    // v0.7.38 (2026-05-09): KodaX only reads `AGENTS.md`. `CLAUDE.md` is
    // intentionally NOT a fallback — it is Claude Code-specific project
    // guidance and is rejected to prevent semantic mis-injection. See the
    // rationale on `CONTEXT_FILE_CANDIDATES` in agents-loader.ts.
    it("only reads AGENTS.md when both AGENTS.md and CLAUDE.md exist", () => {
      writeFileSync(join(testDir, "AGENTS.md"), "# AGENTS");
      writeFileSync(join(testDir, "CLAUDE.md"), "# CLAUDE");

      const files = loadAgentsFiles({ cwd: testDir });
      expect(files).toHaveLength(1);
      expect(files[0].content).toBe("# AGENTS");
      expect(files[0].path).toMatch(/AGENTS\.md$/);
    });

    it("does NOT fall back to CLAUDE.md when AGENTS.md is missing (v0.7.38 breaking)", () => {
      writeFileSync(join(testDir, "CLAUDE.md"), "# CLAUDE");

      const files = loadAgentsFiles({ cwd: testDir });
      expect(files).toHaveLength(0);
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

    it("should handle file read errors gracefully (silent — CLAUDE.md no-console rule)", () => {
      // FEATURE_149 v0.7.38: previously emitted `console.warn` on read
      // failure-after-stat-success, but the project rule (CLAUDE.md)
      // forbids `console.log/warn` in production code. Treat as absent
      // — same outcome as the pre-FEATURE_149 silent behavior. Pin that
      // no warn fires so a future `console.warn` re-introduction trips
      // this test.
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Create a directory with same name as file to cause read error
      const filePath = join(testDir, "AGENTS.md");
      mkdirSync(filePath, { recursive: true });

      const files = loadAgentsFiles({ cwd: testDir });
      expect(files).toHaveLength(0);
      expect(consoleWarnSpy).not.toHaveBeenCalled();

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

  // FEATURE_149 Phase 1.2 (v0.7.38) — mtime-based cache hit/miss behavior.
  describe("mtime cache", () => {
    beforeEach(() => {
      clearAgentsLoaderCacheForTesting();
    });

    it("returns cached content when mtime is unchanged (no re-read)", () => {
      const filePath = join(testDir, "AGENTS.md");
      // Anchor mtime to a stable past timestamp so both reads see the SAME
      // mtimeMs value regardless of OS clock precision (Windows NTFS sub-ms
      // can otherwise drift during `utimesSync`).
      const anchor = new Date("2024-01-01T00:00:00.000Z");

      writeFileSync(filePath, "cached-bytes");
      utimesSync(filePath, anchor, anchor);

      // Cold load — populates cache with anchor mtime + "cached-bytes".
      const first = loadAgentsFiles({ cwd: testDir, projectRoot: testDir });
      expect(first).toHaveLength(1);
      expect(first[0].content).toBe("cached-bytes");

      // Modify file content but re-pin mtime to the SAME anchor. If the
      // cache is honored, the next read must return the OLD bytes; if the
      // loader re-reads from disk, we'd see the new bytes.
      writeFileSync(filePath, "fresh-bytes-not-cached");
      utimesSync(filePath, anchor, anchor);

      const second = loadAgentsFiles({ cwd: testDir, projectRoot: testDir });
      expect(second[0].content).toBe("cached-bytes");
    });

    it("re-reads the file when its mtime changes", () => {
      const filePath = join(testDir, "AGENTS.md");
      writeFileSync(filePath, "v1");

      const first = loadAgentsFiles({ cwd: testDir, projectRoot: testDir });
      expect(first[0].content).toBe("v1");

      // Mutate the file and bump its mtime forward.
      writeFileSync(filePath, "v2");
      const futureMtime = new Date(Date.now() + 60_000);
      utimesSync(filePath, futureMtime, futureMtime);

      const second = loadAgentsFiles({ cwd: testDir, projectRoot: testDir });
      expect(second[0].content).toBe("v2");
    });

    it("evicts the cache entry when the file is removed", () => {
      const filePath = join(testDir, "AGENTS.md");
      writeFileSync(filePath, "doomed");

      const first = loadAgentsFiles({ cwd: testDir, projectRoot: testDir });
      expect(first).toHaveLength(1);

      rmSync(filePath);

      const second = loadAgentsFiles({ cwd: testDir, projectRoot: testDir });
      expect(second).toHaveLength(0);

      // Recreate with new content; cache must miss and re-read.
      writeFileSync(filePath, "reborn");
      const third = loadAgentsFiles({ cwd: testDir, projectRoot: testDir });
      expect(third).toHaveLength(1);
      expect(third[0].content).toBe("reborn");
    });
  });
});
