/**
 * FEATURE_207 (v0.7.45) — recent-file source for the `@` picker.
 *
 * "Recent" = the current git working set (modified + untracked files). These
 * are the files you're actively changing, which is overwhelmingly what you'll
 * `@`-mention next. Chosen over a session @-MRU (empty at cold-start) or an
 * agent-touched-files feed (cross-layer plumbing) because it is useful on the
 * very first `@`, self-contained (one cached git call, no cross-layer
 * coupling), and surfaces nested files without navigating into them.
 *
 * Paths are returned relative to `cwd` (POSIX-style), so they drop straight
 * into an `@<path>` replacement. Non-git workspaces (or any git error) yield an
 * empty list — the picker simply falls back to its normal directory listing.
 */
import { exec } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { assertNoGitInstallPrompt } from '@kodax-ai/agent';

const execAsync = promisify(exec);

/** Parse one `git status --porcelain=v1` line into its path (handles renames + quoting). */
function pathFromPorcelainLine(line: string): string | undefined {
  // Format: `XY <path>` — XY is a 2-char status code, then a space. Renames
  // appear as `R  old -> new`; we want the new path.
  const body = line.slice(3);
  if (!body) return undefined;
  const arrow = body.indexOf(' -> ');
  const raw = arrow === -1 ? body : body.slice(arrow + 4);
  // git quotes paths containing special chars; strip the wrapping quotes.
  return raw.replace(/^"(.*)"$/, '$1').trim() || undefined;
}

/**
 * Return the git working-set files (modified + untracked), most-recent-first as
 * git reports them, relative to `cwd`. Capped at `limit`. Empty on any failure.
 */
export async function getRecentWorkingSetFiles(cwd: string, limit = 10): Promise<string[]> {
  try {
    await assertNoGitInstallPrompt({ cwd });
    const [{ stdout: rootOut }, { stdout: statusOut }] = await Promise.all([
      execAsync('git rev-parse --show-toplevel', { cwd, windowsHide: true }),
      execAsync('git status --porcelain=v1 -uall', { cwd, windowsHide: true }),
    ]);
    const root = rootOut.trim();
    const out: string[] = [];
    const seen = new Set<string>();
    for (const line of statusOut.split('\n')) {
      if (!line.trim()) continue;
      const repoRel = pathFromPorcelainLine(line);
      if (!repoRel) continue;
      const abs = path.resolve(root, repoRel);
      const rel = path.relative(cwd, abs).split(path.sep).join('/');
      // Skip files outside the completer's cwd and de-dupe.
      if (!rel || rel.startsWith('..') || seen.has(rel)) continue;
      seen.add(rel);
      out.push(rel);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}
