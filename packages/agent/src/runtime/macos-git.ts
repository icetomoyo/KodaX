import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, promises as fs, realpathSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { debuglog } from 'node:util';

export interface GitInstallPromptOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly executable?: string;
}

const SYSTEM_GIT = '/usr/bin/git';
const XCODE_SELECT = '/usr/bin/xcode-select';
const PROBE_TTL_MS = 5_000;
const results = new Map<string, { expiresAt: number; missing: boolean }>();
const pending = new Map<string, Promise<boolean | undefined>>();
// Keep this leaf usable by the lightweight resume entry without loading agent/LLM code.
const debug = debuglog('kodax:macos-git');

function probeKey(options: GitInstallPromptOptions): string {
  const env = options.env ?? process.env;
  return JSON.stringify([options.cwd ?? process.cwd(), env.PATH, env.DEVELOPER_DIR]);
}

function cachedResult(key: string): boolean | undefined {
  const cached = results.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.missing;
  results.delete(key);
  return undefined;
}

function rememberResult(key: string, missing: boolean | undefined): void {
  if (missing === undefined) return; // A failed probe is not evidence that tools are missing.
  if (results.size >= 32) results.clear();
  results.set(key, { missing, expiresAt: Date.now() + PROBE_TTL_MS });
}

function candidates(options: GitInstallPromptOptions): string[] {
  const executable = options.executable ?? 'git';
  const cwd = options.cwd ?? process.cwd();
  if (executable.includes('/')) return [posix.resolve(cwd, executable)];
  return ((options.env ?? process.env).PATH ?? '/usr/bin:/bin')
    .split(':').map((entry) => posix.resolve(cwd, entry, executable));
}

async function selectsSystemGit(options: GitInstallPromptOptions): Promise<boolean> {
  for (const candidate of candidates(options)) {
    try {
      await fs.access(candidate, constants.X_OK);
      if (!(await fs.stat(candidate)).isFile()) continue;
    } catch {
      // Match PATH search: an absent/non-executable entry is not selected.
      continue;
    }
    // Once PATH selected a file, a failed canonicalization must not select a different Git.
    return (await fs.realpath(candidate).catch(() => undefined)) === SYSTEM_GIT;
  }
  return false;
}

function selectsSystemGitSync(options: GitInstallPromptOptions): boolean {
  for (const candidate of candidates(options)) {
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
    } catch {
      // Let the original Git invocation report resolution failures.
      continue;
    }
    try {
      return realpathSync(candidate) === SYSTEM_GIT;
    } catch {
      return false;
    }
  }
  return false;
}

function reportProbeFailure(): void {
  debug('Could not determine macOS developer tools availability; retaining normal Git execution.');
}

function rejectMissingTools(): never {
  throw Object.assign(new Error(
    'macOS command line developer tools are unavailable. Install them to use system Git.',
  ), { code: 'MACOS_GIT_TOOLS_MISSING' });
}

/** Checks only Apple's Git launcher; it never runs Git or changes its environment. */
export async function assertNoGitInstallPrompt(options: GitInstallPromptOptions = {}): Promise<void> {
  if (process.platform !== 'darwin' || !(await selectsSystemGit(options))) return;
  const key = probeKey(options);
  let missing = cachedResult(key);
  if (missing === undefined) {
    let probe = pending.get(key);
    if (!probe) {
      probe = probeAsync(options).then((value) => {
        rememberResult(key, value);
        return value;
      }).finally(() => { pending.delete(key); });
      pending.set(key, probe);
    }
    missing = await probe;
  }
  if (missing) rejectMissingTools();
}

function probeAsync(options: GitInstallPromptOptions): Promise<boolean | undefined> {
  return new Promise<boolean | undefined>((resolve) => {
    execFile(XCODE_SELECT, ['-p'], {
      cwd: options.cwd, env: options.env ?? process.env, timeout: 1_000,
      encoding: 'utf8', windowsHide: true,
    }, (error) => {
      if (error && error.code !== 2) {
        reportProbeFailure();
        resolve(undefined);
      } else resolve(error?.code === 2);
    });
  }).catch(() => {
    reportProbeFailure();
    return undefined;
  });
}

/** Preserves synchronous consumers such as memory identity resolution. */
export function assertNoGitInstallPromptSync(options: GitInstallPromptOptions = {}): void {
  if (process.platform !== 'darwin' || !selectsSystemGitSync(options)) return;
  const key = probeKey(options);
  const cached = cachedResult(key);
  if (cached !== undefined) {
    if (cached) rejectMissingTools();
    return;
  }
  let missing: boolean | undefined = false;
  try {
    execFileSync(XCODE_SELECT, ['-p'], {
      cwd: options.cwd, env: options.env ?? process.env, timeout: 1_000,
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    missing = (error as { status?: number }).status === 2 ? true : undefined;
    if (missing === undefined) reportProbeFailure();
  }
  rememberResult(key, missing);
  if (missing) rejectMissingTools();
}
