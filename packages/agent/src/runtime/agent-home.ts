/**
 * v0.7.35.1 FEATURE_145 — Agent config home, 3-tier resolution.
 *
 * Centralizes the user-config directory used to be hardcoded across
 * ~30 sites in 6 packages as `path.join(os.homedir(), '.kodax', ...)`.
 * That pattern had two problems:
 *
 *   1. **Drift**: each new caller in a future feature was a fresh
 *      hardcode site; nothing stopped a caller from using the wrong
 *      string (`'kodax'` instead of `'.kodax'`, etc.).
 *   2. **Substrate consumer coupling**: when `@kodax-ai/agent` is reused
 *      by a downstream agent (e.g. `@kodax-ai/ops-agent`,
 *      `@kodax-ai/data-analysis-agent`), there was no way to redirect the
 *      runtime config dir — every derivative agent was forced to
 *      share the `~/.kodax/` namespace.
 *
 * The helper exposes a 3-tier priority chain:
 *
 *   1. **Programmatic override** via {@link setAgentConfigHome} —
 *      highest priority. Substrate consumers call this once at boot,
 *      before any subsystem reads the path.
 *   2. **`KODAX_HOME` env var** (absolute path only; see
 *      {@link resolveKodaXHome}) — middle priority. Used by shell / CI /
 *      test isolation / multi-tenant shared machines. (Already honored
 *      historically by the llm-layer config helpers; this helper makes it
 *      the canonical path for all packages.)
 *   3. **`~/.kodax/`** — lowest priority. Default for the standalone
 *      kodax CLI. With DI not set + env not set, the resolver returns
 *      the same byte sequence as the prior hardcoded
 *      `path.join(os.homedir(), '.kodax')` calls — so the migration
 *      from hardcoded sites to this helper is byte-equivalent for the
 *      existing user base.
 *
 * Why a process-level singleton (and not per-call DI):
 * the ~30 fs callsites are buried in library helpers (construction /
 * mcp catalog / oauth tokens / paste-cache etc.). Threading a
 * `configHome` parameter through every helper would change ~50
 * function signatures, and every caller would have to remember to
 * thread it — a single forgotten thread silently falls back to
 * default. Singleton matches the `process.env.NODE_ENV` pattern: a
 * process really has a single config home (no legitimate use case
 * for a process to interleave reads/writes against `~/.kodax/` AND
 * `~/.opsagent/` simultaneously).
 *
 * NOT migrated:
 *   - **Project-relative** `.kodax/` paths (e.g. `path.join(projectRoot,
 *     '.kodax', 'AGENTS.md')`) are NOT migrated — those name a
 *     different concept (per-project config) and use a different root.
 *   - **CWD-relative** subpath constants like `path.join('.kodax',
 *     'constructed', '_audit.jsonl')` (joined with a project root by
 *     the caller) are likewise project-scoped and stay as-is.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { join } from 'node:path';

const DEFAULT_DIRNAME = '.kodax';
const ENV_VAR = 'KODAX_HOME';

let _programmaticOverride: string | undefined;

/**
 * Set the agent config home programmatically. Highest priority in
 * {@link getAgentConfigHome}'s 3-tier chain.
 *
 * Substrate consumers (e.g. an agent built on top of `@kodax-ai/agent`)
 * should call this once at process boot, before any subsystem reads
 * the path. Pass `undefined` to reset (used in tests).
 */
export function setAgentConfigHome(path: string | undefined): void {
  _programmaticOverride = path;
}

/**
 * Resolve the agent runtime config home directory.
 *
 * Priority (high → low):
 *   1. Programmatic override via {@link setAgentConfigHome}
 *   2. `KODAX_HOME` env var
 *   3. `~/.kodax` (hardcoded default)
 */
export function getAgentConfigHome(): string {
  if (_programmaticOverride) return _programmaticOverride;
  return resolveKodaXHome().path;
}

export interface ResolvedKodaXHome {
  /** The `.kodax` data root itself (not the directory that owns it). */
  readonly path: string;
  readonly source: 'env' | 'default';
  /** A non-empty `KODAX_HOME` that was not used because it is not an absolute path. */
  readonly ignoredEnv?: string;
}

/**
 * Pure env/default resolution of the data root: no process state is changed and
 * `process.env` is read only when `env` is omitted. `KODAX_HOME` names the
 * `.kodax` directory itself, whereas `homeDir` (like CLI `--home`) names the
 * directory that owns `.kodax`. A relative `KODAX_HOME` would resolve against
 * each process's cwd and split one user's data, so it is ignored and reported.
 */
export function resolveKodaXHome(
  options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly homeDir?: string } = {},
): ResolvedKodaXHome {
  const value = (options.env ?? process.env)[ENV_VAR];
  const fallback = join(options.homeDir ?? homedir(), DEFAULT_DIRNAME);
  if (value === undefined || value.length === 0) return { path: fallback, source: 'default' };
  if (!isAbsolute(value)) return { path: fallback, source: 'default', ignoredEnv: value };
  return { path: value, source: 'env' };
}

/**
 * Resolve a sub-path under the agent config home.
 *
 * Equivalent to `path.join(getAgentConfigHome(), ...segments)` but
 * shorter at every callsite (which is the entire point of the helper —
 * 30 callsites of `path.join(os.homedir(), '.kodax', x, y)` collapse to
 * 30 callsites of `getAgentConfigPath(x, y)`).
 */
export function getAgentConfigPath(...segments: string[]): string {
  return join(getAgentConfigHome(), ...segments);
}

const runtimeAgentHomes = new Map<string, number>();

/**
 * Register the agent home an in-process Runtime loads extensions, integrations
 * and permission grants from, so model-side write protection covers it while
 * the Runtime is open. Registrations of one path are counted; the returned
 * release is idempotent.
 */
export function registerRuntimeAgentHome(agentHome: string): () => void {
  const key = resolve(agentHome);
  runtimeAgentHomes.set(key, (runtimeAgentHomes.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (runtimeAgentHomes.get(key) ?? 1) - 1;
    if (remaining > 0) runtimeAgentHomes.set(key, remaining);
    else runtimeAgentHomes.delete(key);
  };
}

/** The process agent home first, then every registered Runtime agent home, without duplicates. */
export function getActiveAgentHomes(): string[] {
  const homes = [resolve(getAgentConfigHome())];
  for (const home of runtimeAgentHomes.keys()) {
    if (!homes.some((known) => isPathInsideDirectory(home, known) && isPathInsideDirectory(known, home))) {
      homes.push(home);
    }
  }
  return homes;
}

/**
 * Lexical path containment with the host filesystem's comparison semantics.
 * Windows paths are case-insensitive; segment boundaries prevent sibling
 * prefixes such as `.kodax-backup` from being treated as descendants.
 */
export function isPathInsideDirectory(targetPath: string, directoryPath: string): boolean {
  const comparable = (value: string): string => {
    const normalized = normalize(resolve(value));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const target = comparable(targetPath);
  const directory = comparable(directoryPath);
  const descendantPrefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return target === directory || target.startsWith(descendantPrefix);
}

/** Resolve a tool path from the directory where the tool actually executes. */
export function resolveExecutionPath(targetPath: string, executionCwd: string): string {
  const expanded = targetPath === '~'
    ? homedir()
    : targetPath.startsWith('~/') || targetPath.startsWith('~\\')
      ? join(homedir(), targetPath.slice(2))
      : targetPath;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(executionCwd, expanded);
}

/**
 * v0.7.42 — Namespaced data directory for third-party apps embedding the
 * KodaX SDK (e.g. `KodaX Space` desktop client, IDE extensions).
 *
 * Returns `${getAgentConfigHome()}/apps/<appId>/` and creates the directory
 * if missing. Provides a coordination point so multiple SDK consumers can
 * share `~/.kodax/` without colliding on path conventions.
 *
 * Constraints:
 *   - `appId` must match `^[a-z][a-z0-9-]{1,31}$` (lowercase kebab, 2–32 chars,
 *     no dots, no slashes, no underscores) — keeps the directory name safe
 *     across all filesystems and prevents `../` traversal.
 *   - Reserved prefixes (`kodax`, `kodax-*`) are rejected to leave room
 *     for first-party feature directories that may collide later.
 *
 * The convention is intentionally light — no central registry, no manifest.
 * Apps owning their data dir means SDK upgrades cannot trample on third-party
 * state. Apps are responsible for migration/cleanup within their own subtree.
 */
export function getAppDataDir(appId: string): string {
  if (typeof appId !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(appId)) {
    throw new Error(
      `getAppDataDir: invalid appId ${JSON.stringify(appId)}. ` +
      `Must match /^[a-z][a-z0-9-]{1,31}$/ (lowercase kebab, 2–32 chars).`,
    );
  }
  if (appId === 'kodax' || appId.startsWith('kodax-')) {
    throw new Error(
      `getAppDataDir: appId ${JSON.stringify(appId)} is reserved (the 'kodax' / 'kodax-*' prefix is reserved for first-party use).`,
    );
  }
  const dir = join(getAgentConfigHome(), 'apps', appId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
