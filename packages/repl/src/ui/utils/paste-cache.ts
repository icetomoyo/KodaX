/**
 * PasteCache — content-addressable on-disk store for pasted text blobs.
 *
 * Design: see docs/KNOWN_ISSUES.md Issue 121 (跨 session paste-cache 要求).
 * Reference: Claude Code src/utils/pasteStore.ts.
 *
 * Storage layout:  `~/.kodax/paste-cache/{sha256[0..15]}.txt`  (16-char prefix
 * — same width as Claude Code; collision probability at realistic paste
 * volumes is negligible).
 *
 * All disk I/O is async + best-effort. Failures log & degrade (no exceptions
 * bubble up). This matches Claude Code's fire-and-forget pattern for paste
 * persistence — stale reads return null, writes do not block submit.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PASTE_CACHE_DIRNAME = "paste-cache";

/**
 * Default retention window for `cleanupOldPastes` when no explicit cutoff is
 * provided. 30 days is long enough for a reasonable ↑ history horizon while
 * still bounding disk growth.
 */
export const DEFAULT_PASTE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function getPasteCacheDir(): string {
  return path.join(os.homedir(), ".kodax", PASTE_CACHE_DIRNAME);
}

function getPastePath(hash: string): string {
  return path.join(getPasteCacheDir(), `${hash}.txt`);
}

/**
 * Compute a 16-char hex prefix of sha256(content). Synchronous so callers can
 * stamp the hash reference into a history entry before the disk write fires.
 */
export function hashPastedText(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Store `content` addressed by `hash`. Safe to call concurrently with the
 * same hash — writes are content-equivalent so overwriting is a no-op from a
 * correctness standpoint.
 *
 * Returns true on success, false on best-effort failure (never throws).
 */
export async function storePastedText(hash: string, content: string): Promise<boolean> {
  try {
    const dir = getPasteCacheDir();
    await mkdir(dir, { recursive: true });
    await writeFile(getPastePath(hash), content, {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch {
    // Paste persistence is best-effort. Don't fail the parent submit.
    return false;
  }
}

/**
 * Retrieve content by hash. Returns null if the file is missing or unreadable.
 */
export async function retrievePastedText(hash: string): Promise<string | null> {
  try {
    return await readFile(getPastePath(hash), { encoding: "utf8" });
  } catch {
    return null;
  }
}

/**
 * Delete paste files older than `cutoffMs` milliseconds.
 *
 * Invoked once on REPL startup to bound disk growth from accumulated pastes.
 * Uses mtime so re-accessed pastes (via Up-arrow recall) stay alive longer
 * than untouched ones if callers choose to `touch` on read.
 */
export async function cleanupOldPastes(
  retentionMs: number = DEFAULT_PASTE_RETENTION_MS,
): Promise<{ scanned: number; removed: number }> {
  const dir = getPasteCacheDir();
  const cutoff = Date.now() - retentionMs;
  let scanned = 0;
  let removed = 0;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist — no-op is correct.
    return { scanned, removed };
  }

  for (const entry of entries) {
    if (!entry.endsWith(".txt")) continue;
    scanned += 1;
    const filePath = path.join(dir, entry);
    try {
      const stats = await stat(filePath);
      if (stats.mtimeMs < cutoff) {
        await unlink(filePath);
        removed += 1;
      }
    } catch {
      // Skip files that can't be stat'd / unlinked. Don't abort the sweep.
    }
  }

  return { scanned, removed };
}
