import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getActiveAgentHomes, getAgentConfigHome, isPathInsideDirectory } from '@kodax-ai/agent';

const PROTECTED_DIRECTORIES = new Set([
  'runtime', 'mcp-tokens', 'mcp-clients', 'integrations',
  'sandbox-runtime', 'processes', 'learned',
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.agents',
  '.codex', '.claude', '.gemini', '.direnv', '.terraform.d', '.password-store',
]);
const PROTECTED_FILES = new Set([
  'config.json', 'auth.json', 'custom-providers.json', 'trusted-project-rules.json',
  '.env', '.envrc', '.pgpass', '.npmrc', '.pypirc', '.netrc',
  '.git-credentials', 'credentials', 'credentials.json',
  'application_default_credentials.json', 'id_rsa', 'id_ed25519',
  '.gitconfig', '.gitmodules', '.terraformrc', '.condarc', '.bashrc', '.bash_profile',
  '.zshrc', '.zprofile', '.profile', '.bash_history', '.zsh_history',
]);
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

function expandHome(targetPath: string): string {
  let expanded = targetPath === '~'
    ? os.homedir()
    : /^~[\\/]/.test(targetPath)
      ? path.join(os.homedir(), targetPath.slice(2))
      : targetPath;
  return expanded.replace(
    /^(?:\$\{HOME\}|\$HOME|\$env:(?:home|userprofile)|%userprofile%)(?=$|[\\/])/i,
    os.homedir(),
  );
}

/** Resolve symlinks through the deepest existing prefix without trusting a broken link. */
export function canonicalizeAgentHomePolicyPath(
  targetPath: string,
  baseDir = process.cwd(),
): string | undefined {
  if (!targetPath.trim() || targetPath.includes('\0')) return undefined;
  const expanded = expandHome(targetPath);
  if (process.platform === 'win32' && /^[a-z]:[^\\/]/i.test(expanded)) return undefined;
  const suffix: string[] = [];
  let current = path.resolve(baseDir, expanded);
  for (;;) {
    try {
      fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(path.basename(current));
      current = parent;
      continue;
    }
    try {
      return path.join(fs.realpathSync.native(current), ...suffix);
    } catch {
      return undefined;
    }
  }
}

function normalizedRelative(target: string, agentHome: string): string | undefined {
  const relative = path.relative(agentHome, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(/[\\/]+/).map((component) => {
    const lower = component.toLowerCase();
    if (process.platform !== 'win32') return lower;
    const stream = lower.indexOf(':');
    return (stream >= 0 ? lower.slice(0, stream) : lower).replace(/[ .]+$/g, '');
  }).join('/');
}

function isProtectedRelativePath(relative: string): boolean {
  const parts = relative.split('/');
  const basename = parts.at(-1) ?? '';
  if (parts.some((part) => PROTECTED_DIRECTORIES.has(part))) return true;
  if (parts.some((part) => PROTECTED_FILES.has(part) || /^\.?auth\.json(?:[.-].*)?$/.test(part))) return true;
  if (!ENV_TEMPLATES.has(basename) && (basename === '.env' || basename.startsWith('.env.'))) {
    return true;
  }
  if (parts.some((part) => /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(part))) return true;
  return parts.some((part, index) => (
    (part === '.git' && ['config', 'config.worktree'].includes(parts[index + 1] ?? ''))
    || (part === '.config' && parts[index + 1] === 'git' && parts[index + 2] === 'config')
    || (part === '.cargo' && parts[index + 1] === 'credentials.toml')
    || (part === '.m2' && ['settings.xml', 'settings-security.xml'].includes(parts[index + 1] ?? ''))
    || (part === '.gradle' && parts[index + 1] === 'gradle.properties')
    || (part === '.nuget' && parts.slice(index + 1).includes('nuget.config'))
    || (part === '.pip' && parts[index + 1] === 'pip.conf')
    || (part === '.huggingface' && parts[index + 1] === 'token')
    || (part === '.cache' && parts[index + 1] === 'huggingface' && parts[index + 2] === 'token')
    || (part === '.config' && ['gcloud', 'gh', 'openai', 'anthropic'].includes(parts[index + 1] ?? ''))
    || (part === '.config' && parts[index + 1] === 'pip' && parts[index + 2] === 'pip.conf')
    || (part === '.config' && parts[index + 1] === 'rclone' && parts[index + 2] === 'rclone.conf')
    || (part === '.config' && parts[index + 1] === 'pypoetry' && parts[index + 2] === 'auth.toml')
    || (part === '.config' && parts[index + 1] === 'fish'
      && ['config.fish', 'fish_variables'].includes(parts[index + 2] ?? ''))
    || (part === '.local' && parts[index + 1] === 'share' && parts[index + 2] === 'keyrings')
    || (part === 'library' && parts[index + 1] === 'keychains')
    || (part === 'appdata' && ['local', 'roaming'].includes(parts[index + 1] ?? '')
      && parts[index + 2] === 'microsoft'
      && ['credentials', 'protect', 'vault'].includes(parts[index + 3] ?? ''))
  ));
}

export function isAutoWritableAgentHomePath(target: string, agentHome: string): boolean {
  const relative = normalizedRelative(target, agentHome);
  return relative !== undefined && !isProtectedRelativePath(relative)
    && !isHardAgentHomeRelativePath(relative)
    && !isGovernedMemoryRelativePath(path.relative(agentHome, target).replaceAll('\\', '/'));
}

function isGovernedMemoryRelativePath(relative: string, destructiveAncestors = false): boolean {
  if (process.platform === 'win32') relative = relative.toLowerCase().split('/').map(part => part.split(':')[0]!.replace(/[ .]+$/u, '')).join('/');
  return relative === 'memory-scopes' || relative.startsWith('memory-scopes/')
    || (destructiveAncestors && /^projects(?:\/[^/]+)?$/u.test(relative)) || /^projects\/[^/]+\/memory(?:\/|$)/u.test(relative)
    // FEATURE_306 note stores: only the `memory` tool may mutate them (secret scan, quote authorization).
    || relative === 'notes' || relative.startsWith('notes/') || /^projects\/[^/]+\/notes(?:\/|$)/u.test(relative);
}

/** Write-only policy: Memory inspection is readable; Control Plane owns mutation. */
export function isGovernedMemoryMutationTarget(targetPath: string, cwd = process.cwd(), agentHome = getAgentConfigHome(), destructiveAncestors = false): boolean {
  const home = path.resolve(agentHome);
  const lexical = path.resolve(cwd, expandHome(targetPath));
  const canonicalHome = canonicalizeAgentHomePolicyPath(home) ?? home;
  const canonicalTarget = canonicalizeAgentHomePolicyPath(targetPath, cwd);
  const candidates: [string, string][] = [[lexical, home]];
  if (canonicalTarget) candidates.push([canonicalTarget, canonicalHome]);
  return candidates.some(([target, root]) => {
    if (destructiveAncestors && isPathInsideDirectory(root, target)) return true;
    if (!isPathInsideDirectory(target, root)) return false;
    return isGovernedMemoryRelativePath(path.relative(root, target).replaceAll('\\', '/'), destructiveAncestors);
  });
}

/** Agent Home reads stay open except for credentials and control-plane data. */
export function isAutoReadableAgentHomePath(target: string, agentHome: string): boolean {
  const relative = normalizedRelative(target, agentHome);
  if (relative === undefined) return false;
  if (relative === 'custom-providers.json') return true;
  if (relative === 'runtime') return false;
  if (
    relative === 'runtime/permission-grants.json'
    || relative.startsWith('runtime/daemon/')
  ) return false;
  const contentRelative = relative.startsWith('runtime/')
    ? relative.slice('runtime/'.length)
    : relative;
  return !isProtectedRelativePath(contentRelative);
}

export function isProtectedAgentHomeReadTarget(
  targetPath: string,
  executionCwd = process.cwd(),
): boolean {
  let agentHome: string;
  try {
    agentHome = getAgentConfigHome();
  } catch {
    return true;
  }
  const lexicalHome = path.resolve(agentHome);
  const resolvedTarget = path.resolve(executionCwd, expandHome(targetPath));
  const canonicalHome = canonicalizeAgentHomePolicyPath(agentHome) ?? lexicalHome;
  const canonicalTarget = canonicalizeAgentHomePolicyPath(targetPath, executionCwd);
  if (canonicalTarget === undefined) {
    return isPathInsideDirectory(resolvedTarget, lexicalHome);
  }
  return isPathInsideDirectory(canonicalTarget, canonicalHome)
    && !isAutoReadableAgentHomePath(canonicalTarget, canonicalHome);
}

export function isProtectedAgentHomeMutationTarget(
  targetPath: string,
  executionCwd = process.cwd(),
): boolean {
  let agentHome: string;
  try {
    agentHome = getAgentConfigHome();
  } catch {
    return false;
  }
  const lexicalHome = path.resolve(agentHome);
  const resolvedTarget = path.resolve(executionCwd, expandHome(targetPath));
  const canonicalHome = canonicalizeAgentHomePolicyPath(agentHome) ?? lexicalHome;
  const canonicalTarget = canonicalizeAgentHomePolicyPath(targetPath, executionCwd);
  if (canonicalTarget === undefined) {
    return isPathInsideDirectory(resolvedTarget, lexicalHome);
  }
  return isPathInsideDirectory(canonicalTarget, canonicalHome)
    && !isAutoWritableAgentHomePath(canonicalTarget, canonicalHome);
}

/** The process agent home and every agent home an open in-process Runtime loads from. */
function activeAgentHomes(): string[] {
  try {
    return getActiveAgentHomes();
  } catch {
    return [];
  }
}

/** Unauthorizable model-side boundary: Agent Home and host-owned control state. */
export function isAgentHomeHardMutationTarget(
  targetPath: string,
  executionCwd = process.cwd(),
): boolean {
  return activeAgentHomes().some((agentHome) => (
    isGovernedMemoryMutationTarget(targetPath, executionCwd, agentHome)
    || isAgentHomeTargetIn(agentHome, targetPath, executionCwd, isHardAgentHomeRelativePath)
  ));
}

/** Code and integrations the Host loads as trusted: no approval lets a model write them. */
export function isAgentHomeHostLoadedTarget(
  targetPath: string,
  executionCwd = process.cwd(),
): boolean {
  return activeAgentHomes().some((agentHome) => (
    isAgentHomeTargetIn(agentHome, targetPath, executionCwd, (relative) => (
      relative !== undefined && isUnderDirectories(relative, HOST_LOADED_AGENT_HOME_DIRECTORIES)
    ))
  ));
}

/** Checks the lexical and canonical target; an unresolvable path inside Agent Home fails closed. */
function isAgentHomeTargetIn(
  agentHome: string,
  targetPath: string,
  executionCwd: string,
  matches: (relative: string | undefined) => boolean,
): boolean {
  const lexicalHome = path.resolve(agentHome);
  const resolvedTarget = path.resolve(executionCwd, expandHome(targetPath));
  if (isPathInsideDirectory(resolvedTarget, lexicalHome)
    && matches(normalizedRelative(resolvedTarget, lexicalHome))) return true;
  const canonicalHome = canonicalizeAgentHomePolicyPath(agentHome) ?? lexicalHome;
  const canonicalTarget = canonicalizeAgentHomePolicyPath(targetPath, executionCwd);
  if (canonicalTarget === undefined) {
    return isPathInsideDirectory(resolvedTarget, lexicalHome);
  }
  return isPathInsideDirectory(canonicalTarget, canonicalHome)
    && matches(normalizedRelative(canonicalTarget, canonicalHome));
}

const HOST_LOADED_AGENT_HOME_DIRECTORIES = ['extensions', 'integrations'];
const HARD_AGENT_HOME_DIRECTORIES = ['runtime', 'processes', 'learned', ...HOST_LOADED_AGENT_HOME_DIRECTORIES];

function isUnderDirectories(relative: string, directories: readonly string[]): boolean {
  return directories.some((directory) => relative === directory || relative.startsWith(`${directory}/`));
}

function isHardAgentHomeRelativePath(relative: string | undefined): boolean {
  return relative === undefined || isUnderDirectories(relative, HARD_AGENT_HOME_DIRECTORIES);
}

/** Removal unlinks a final symlink instead of mutating the symlink target. */
export function isAgentHomeHardRemovalTarget(
  targetPath: string,
  executionCwd = process.cwd(),
): boolean {
  let agentHome: string;
  try {
    agentHome = getAgentConfigHome();
  } catch {
    return false;
  }
  const resolvedTarget = path.resolve(executionCwd, expandHome(targetPath));
  try {
    if (!fs.lstatSync(resolvedTarget).isSymbolicLink()) {
      if (isGovernedMemoryMutationTarget(targetPath, executionCwd, agentHome, true)) return true;
      const lexicalHome = path.resolve(agentHome);
      const canonicalHome = canonicalizeAgentHomePolicyPath(agentHome) ?? lexicalHome;
      const canonicalTarget = canonicalizeAgentHomePolicyPath(resolvedTarget);
      if (isPathInsideDirectory(lexicalHome, resolvedTarget)
        || (canonicalTarget !== undefined
          && isPathInsideDirectory(canonicalHome, canonicalTarget))) return true;
      return isAgentHomeHardMutationTarget(targetPath, executionCwd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    return isAgentHomeHardMutationTarget(targetPath, executionCwd);
  }
  const lexicalHome = path.resolve(agentHome);
  if (!isPathInsideDirectory(resolvedTarget, lexicalHome)) return false;
  const relative = normalizedRelative(resolvedTarget, lexicalHome);
  return isHardAgentHomeRelativePath(relative);
}

export function isProtectedAgentHomeRemovalTarget(
  targetPath: string,
  executionCwd = process.cwd(),
): boolean {
  let agentHome: string;
  try {
    agentHome = getAgentConfigHome();
  } catch {
    return true;
  }
  const lexicalHome = path.resolve(agentHome);
  const canonicalHome = canonicalizeAgentHomePolicyPath(agentHome) ?? lexicalHome;
  const target = path.resolve(executionCwd, expandHome(targetPath));
  const canonicalTarget = canonicalizeAgentHomePolicyPath(target);
  if (isPathInsideDirectory(lexicalHome, target)
    || (canonicalTarget !== undefined && isPathInsideDirectory(canonicalHome, canonicalTarget))) {
    return true;
  }
  if (isProtectedAgentHomeMutationTarget(target, executionCwd)) return true;
  return removalTreeContainsProtectedPath(target, canonicalHome);
}

function removalTreeContainsProtectedPath(target: string, canonicalHome: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const policyTarget = stat.isSymbolicLink()
    ? path.resolve(target)
    : canonicalizeAgentHomePolicyPath(target);
  if (policyTarget === undefined) return true;
  if (isPathInsideDirectory(policyTarget, canonicalHome)
    && !isAutoWritableAgentHomePath(policyTarget, canonicalHome)) return true;
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const pending = [target];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (++visited > 20_000) return true;
      const candidate = path.join(directory, entry.name);
      const policyCandidate = entry.isSymbolicLink()
        ? path.resolve(candidate)
        : canonicalizeAgentHomePolicyPath(candidate);
      if (policyCandidate === undefined) return true;
      if (isPathInsideDirectory(policyCandidate, canonicalHome)
        && !isAutoWritableAgentHomePath(policyCandidate, canonicalHome)) return true;
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return false;
}
