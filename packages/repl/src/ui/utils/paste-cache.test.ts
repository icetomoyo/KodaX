import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// vi.hoisted: build the mock reference before imports resolve, so
// `paste-cache.ts`'s `import * as os from "node:os"` gets the mocked homedir.
// Plain `vi.spyOn(os, "homedir")` does NOT work here — ESM namespace imports
// are bound to the module's own copy of `os`, not the test file's.
const { mockHomedir } = vi.hoisted(() => ({
  mockHomedir: vi.fn((): string => os.tmpdir()),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: mockHomedir };
});

// Import AFTER the mock so paste-cache binds to the mocked homedir
const {
  cleanupOldPastes,
  DEFAULT_PASTE_RETENTION_MS,
  hashPastedText,
  retrievePastedText,
  storePastedText,
} = await import("./paste-cache.js");

describe("hashPastedText", () => {
  it("returns a 16-char hex prefix", () => {
    const h = hashPastedText("hello");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for identical content", () => {
    expect(hashPastedText("same")).toBe(hashPastedText("same"));
  });

  it("differs for different content", () => {
    expect(hashPastedText("one")).not.toBe(hashPastedText("two"));
  });
});

// Async I/O tests — point paste-cache at a per-test temp dir so writes land
// somewhere safe to create/delete. Exercises real disk I/O, not mocks, so
// regressions in mkdir / write / unlink / stat paths get caught.
describe("paste-cache disk I/O", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "kodax-paste-cache-"));
    mockHomedir.mockReturnValue(tempHome);
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("storePastedText → retrievePastedText round-trip", async () => {
    const content = "line1\nline2\nline3";
    const hash = hashPastedText(content);

    const stored = await storePastedText(hash, content);
    expect(stored).toBe(true);

    const retrieved = await retrievePastedText(hash);
    expect(retrieved).toBe(content);
  });

  it("storePastedText creates the cache directory if missing", async () => {
    const hash = hashPastedText("bootstrap");
    const cacheDir = path.join(tempHome, ".kodax", "paste-cache");

    await expect(fs.stat(cacheDir)).rejects.toThrow();

    const stored = await storePastedText(hash, "bootstrap");
    expect(stored).toBe(true);

    const stat = await fs.stat(cacheDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("retrievePastedText returns null for an unknown hash", async () => {
    const missing = await retrievePastedText("0000000000000000");
    expect(missing).toBeNull();
  });

  it("retrievePastedText returns null when the cache directory does not exist", async () => {
    const nothing = await retrievePastedText(hashPastedText("never-stored"));
    expect(nothing).toBeNull();
  });

  it("storePastedText is idempotent for the same hash", async () => {
    const hash = hashPastedText("same-body");
    await storePastedText(hash, "same-body");
    const second = await storePastedText(hash, "same-body");
    expect(second).toBe(true);
    expect(await retrievePastedText(hash)).toBe("same-body");
  });

  it("cleanupOldPastes is a no-op when the cache directory does not exist", async () => {
    const result = await cleanupOldPastes();
    expect(result).toEqual({ scanned: 0, removed: 0 });
  });

  it("cleanupOldPastes removes expired files and keeps fresh ones", async () => {
    const freshHash = hashPastedText("fresh");
    const staleHash = hashPastedText("stale");
    await storePastedText(freshHash, "fresh");
    await storePastedText(staleHash, "stale");

    // Backdate the stale file so its mtime is older than the cutoff
    const cacheDir = path.join(tempHome, ".kodax", "paste-cache");
    const staleFile = path.join(cacheDir, `${staleHash}.txt`);
    const longAgo = new Date(Date.now() - DEFAULT_PASTE_RETENTION_MS - 60_000);
    await fs.utimes(staleFile, longAgo, longAgo);

    const result = await cleanupOldPastes();
    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(1);

    expect(await retrievePastedText(freshHash)).toBe("fresh");
    expect(await retrievePastedText(staleHash)).toBeNull();
  });

  it("cleanupOldPastes honors a custom retention window", async () => {
    const hash = hashPastedText("window-test");
    await storePastedText(hash, "window-test");

    // Backdate mtime by 10s so a 5s retention treats the file as expired.
    // Avoids clock-resolution flakiness: using `retentionMs = 0` relies on
    // `mtimeMs < Date.now()` being strictly true, but on Windows mtime can
    // share the same millisecond as `Date.now()` when the test runs fast.
    const cacheDir = path.join(tempHome, ".kodax", "paste-cache");
    const file = path.join(cacheDir, `${hash}.txt`);
    const past = new Date(Date.now() - 10_000);
    await fs.utimes(file, past, past);

    const result = await cleanupOldPastes(5_000);
    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(1);
    expect(await retrievePastedText(hash)).toBeNull();
  });

  it("cleanupOldPastes ignores non-.txt files in the cache dir", async () => {
    await storePastedText(hashPastedText("primer"), "primer");
    const cacheDir = path.join(tempHome, ".kodax", "paste-cache");

    // Drop a foreign file — cleanup must not count or remove it
    const foreign = path.join(cacheDir, "README.md");
    await fs.writeFile(foreign, "not a paste", "utf8");

    const result = await cleanupOldPastes();
    expect(result.scanned).toBe(1);
    await expect(fs.stat(foreign)).resolves.toBeTruthy();
  });
});
