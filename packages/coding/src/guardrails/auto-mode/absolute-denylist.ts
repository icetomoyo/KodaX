/**
 * Historical Tier 0 high-impact pattern detector — FEATURE_158 Step 4.
 *
 * The exported names remain source-compatible with FEATURE_158. Auto[LLM]
 * now treats matches as deterministic facts for the classifier, whose
 * decision is final. The narrow list still identifies high-impact operations
 * worth describing precisely:
 *
 * The detector must not expand into a second Auto[LLM] approval policy.
 *
 * Patterns:
 *
 *   1. rm_rf_root      — `rm -rf /`, `rm -rf ~`, `rm -rf $HOME` (and quoted
 *                        / -fr variants). Excludes `rm -rf /tmp/foo` (which
 *                        is a `dangerous_pattern` signal but reaches LLM).
 *   2. mkfs_or_format  — `mkfs.* /dev/sd*`, `fdisk /dev/sd*`, `format C:`.
 *                        Identifies formatting of a disk device.
 *   3. dd_disk_write   — `dd of=/dev/sd*` (raw-disk write). Excludes
 *                        `dd of=test.bin` (file write — reaches LLM as
 *                        dangerous_pattern signal).
 *   4. fork_bomb       — `:(){ :|:& };:` — denial of service.
 *   5. user_kodax_write — write/edit/bash-write to protected agent-home paths
 *                        under `~/.kodax/`: the home root, Runtime control
 *                        plane, credentials, security config, and generic
 *                        sensitive files. Ordinary working data stays open.
 *
 * Layer note: bash-level `~/.kodax/` writes are detected via AST
 * path-extraction (`collectDeterministicBashWriteTargets`) in
 * `checkUserKodaxBashWrite`, covering both file-tool and bash paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getAgentConfigHome, isPathInsideDirectory, resolveExecutionPath } from '@kodax-ai/agent';
import type { RunnerToolCall } from '@kodax-ai/agent';
import { minimatch } from 'minimatch';
import { parseBashCommand } from '../../permissions/bash-ast.js';
import { collectDeterministicBashWriteTargets } from '../../permissions/permission.js';
import {
  analyzePowerShellMutation,
  isPowerShellMutationCommand,
} from '../../permissions/powershell-mutation.js';
import { isProtectedAgentHomeMutationTarget } from '../../permissions/agent-home-policy.js';
import {
  canonicalizeAutoModePath,
  isAutoWritableKodaxPath,
} from './permission-analyzer.js';

export type TierZeroPatternId =
  | 'rm_rf_root'
  | 'mkfs_or_format'
  | 'dd_disk_write'
  | 'fork_bomb'
  | 'user_kodax_write';

export interface AbsoluteDenyMatch {
  readonly denied: true;
  readonly patternId: TierZeroPatternId;
  readonly reason: string;
}

export interface AbsoluteDenyMiss {
  readonly denied: false;
}

export type AbsoluteDenyResult = AbsoluteDenyMatch | AbsoluteDenyMiss;
export type AbsoluteDenyCheck = (
  call: RunnerToolCall,
  projectRoot: string,
  executionCwd: string,
) => AbsoluteDenyResult;

const MISS: AbsoluteDenyMiss = { denied: false };

// ============== Pattern 1: rm -rf / or ~ or $HOME ==============

/**
 * Matches `rm` with recursive+force flags. Captures common spellings:
 *   -rf / -fr / -r -f / --recursive --force / --force --recursive
 * Plus `r` / `f` bundled into longer flag clusters (e.g. `-rvf`, `-Rf`).
 *
 * Negative match for `-r` alone or `-f` alone — both flags required for
 * Tier 0 (a single flag isn't enough to wipe a directory tree).
 */
function hasRecursiveAndForceFlags(tokens: readonly string[]): boolean {
  let r = false;
  let f = false;
  for (const t of tokens) {
    if (!t.startsWith('-')) continue;
    if (t === '--recursive' || t === '-R') r = true;
    else if (t === '--force') f = true;
    else if (t.startsWith('-') && !t.startsWith('--')) {
      // bundled short flags like -rf / -fr / -Rfv
      if (/r/i.test(t.slice(1))) r = true;
      if (/f/.test(t.slice(1))) f = true;
    }
  }
  return r && f;
}

const ROOT_TARGET_TOKENS: ReadonlySet<string> = new Set([
  '/',
  '~',
  '~/',
  '$HOME',
  '${HOME}',
  '$HOME/',
  '${HOME}/',
]);

function unquote(token: string): string {
  if (token.length < 2) return token;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return token.slice(1, -1);
  }
  return token;
}

function checkRmRfRoot(command: string): AbsoluteDenyResult {
  const trimmed = command.trim();
  if (!/^\s*rm\b/.test(trimmed)) return MISS;
  // Strip leading `rm` and split on whitespace (good enough for Tier 0;
  // we're matching a narrow catastrophic pattern not parsing arbitrary
  // shell).
  const tokens = trimmed.split(/\s+/).slice(1);
  if (!hasRecursiveAndForceFlags(tokens)) return MISS;
  for (const raw of tokens) {
    if (raw.startsWith('-')) continue;
    const unq = unquote(raw);
    // Also catch glob-expanded forms like `/*`, `~/*`, `$HOME/*`
    const canonical = unq.replace(/\/\*+$/, '/').replace(/\/+$/, '/');
    if (ROOT_TARGET_TOKENS.has(unq) || ROOT_TARGET_TOKENS.has(canonical)) {
      return {
        denied: true,
        patternId: 'rm_rf_root',
        reason: `Recursive forced deletion targets the root path (\`${unq}\`) and can remove operating-system or user files.`,
      };
    }
  }
  return MISS;
}

// ============== Pattern 2: mkfs / fdisk / format ==============

const MKFS_OR_FORMAT_RE = /(^|[\s|;&(])(mkfs(?:\.[a-z0-9]+)?|fdisk)\s+(['"]?)(\/dev\/(sd|nvme|hd|vd)[a-z0-9]*|\\\\\.\\PhysicalDrive[0-9]+)/i;
const FORMAT_DRIVE_RE = /(^|[\s|;&(])format(\s+\/[A-Za-z]:?)?(\s+[A-Za-z]:)/;

function checkMkfsOrFormat(command: string): AbsoluteDenyResult {
  if (MKFS_OR_FORMAT_RE.test(command)) {
    return {
      denied: true,
      patternId: 'mkfs_or_format',
      reason: 'The command creates a filesystem on a block device and destroys the device\'s existing filesystem data.',
    };
  }
  if (FORMAT_DRIVE_RE.test(command)) {
    return {
      denied: true,
      patternId: 'mkfs_or_format',
      reason: 'The Windows command formats a drive and destroys its existing filesystem data.',
    };
  }
  return MISS;
}

// ============== Pattern 3: dd if=... of=/dev/sd* ==============

const DD_DISK_WRITE_RE = /(^|[\s|;&(])dd\s+[^\n]*\bof=(['"]?)(\/dev\/(sd|nvme|hd|vd)[a-z0-9]*|\\\\\.\\PhysicalDrive[0-9]+)/i;

function checkDdDiskWrite(command: string): AbsoluteDenyResult {
  if (DD_DISK_WRITE_RE.test(command)) {
    return {
      denied: true,
      patternId: 'dd_disk_write',
      reason: 'The command writes raw bytes to a block device rather than to an ordinary file.',
    };
  }
  return MISS;
}

// ============== Pattern 4: fork bomb ==============

// Classic fork bomb shape; whitespace-tolerant inside the braces but
// requires the structural `:(){...};:` skeleton to match.
const FORK_BOMB_RE = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;\s*:/;

function checkForkBomb(command: string): AbsoluteDenyResult {
  if (FORK_BOMB_RE.test(command)) {
    return {
      denied: true,
      patternId: 'fork_bomb',
      reason: 'The command is a fork-bomb pattern that can exhaust process and CPU resources.',
    };
  }
  return MISS;
}

// ============== Pattern 5: write / edit to ~/.kodax/ ==============

function checkUserKodaxWrite(
  call: RunnerToolCall,
  executionCwd: string,
): AbsoluteDenyResult {
  if (!['write', 'edit', 'multi_edit', 'insert_after_anchor'].includes(call.name)) return MISS;
  const targetPath = typeof call.input.path === 'string' ? call.input.path : '';
  if (!targetPath) return MISS;
  if (isProtectedAgentHomeMutationTarget(targetPath, executionCwd)) {
    return {
      denied: true,
      patternId: 'user_kodax_write',
      reason: `The write targets protected KodaX state \`${targetPath}\` under ~/.kodax/ (home root, Runtime control plane, credentials, or security config).`,
    };
  }
  return MISS;
}

function recursiveRemovalTargets(command: string): readonly string[] {
  const tree = parseBashCommand(command);
  if (tree.unparseable) return [];
  const targets: string[] = [];
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const executable = (stage.argv[0] ?? '').replace(/\\/g, '/').split('/').at(-1)?.toLowerCase();
      if (executable === 'rm') {
        const args = stage.argv.slice(1);
        const recursive = args.some((token) => (
          token === '--recursive' || (/^-[^-]/.test(token) && /[rR]/.test(token.slice(1)))
        ));
        if (!recursive) continue;
        let optionsEnded = false;
        for (const token of args) {
          if (token === '--') {
            optionsEnded = true;
            continue;
          }
          if (!optionsEnded && token.startsWith('-')) continue;
          targets.push(...powerShellPathArrayMembers(token));
        }
        continue;
      }
      if (['remove-item', 'ri', 'rmdir', 'rd', 'del', 'erase'].includes(executable ?? '')) {
        const args = stage.argv.slice(1);
        const recursive = args.some((token) => (
          /^\/s(?::.*)?$/i.test(token)
          || /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(token)
        ));
        if (!recursive) continue;
        for (let index = 0; index < args.length; index += 1) {
          const token = args[index]!;
          if (/^-(?:literal)?path(?::.*)?$/i.test(token)) {
            const separator = token.indexOf(':');
            if (separator >= 0 && token.slice(separator + 1)) {
              targets.push(...powerShellPathArrayMembers(token.slice(separator + 1)));
            } else if (args[index + 1] !== undefined) {
              targets.push(...powerShellPathArrayMembers(args[index + 1]!));
              index += 1;
            }
            continue;
          }
          if (token.startsWith('-') || /^\/[a-z](?::.*)?$/i.test(token)) continue;
          targets.push(...powerShellPathArrayMembers(token));
        }
        continue;
      }
      const analysis = analyzePowerShellMutation(stage.argv);
      for (const operation of analysis.operations) {
        if (operation.kind === 'delete' && operation.options.recursive === true) {
          targets.push(operation.target);
        }
      }
    }
  }
  return targets;
}

function powerShellPathArrayMembers(value: string): readonly string[] {
  return value.split(',').map((member) => member.trim()).filter(Boolean);
}

function parentRemovalTargets(command: string): readonly string[] {
  const tree = parseBashCommand(command);
  if (tree.unparseable) return [];
  const targets: string[] = [];
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const executable = (stage.argv[0] ?? '').replace(/\\/g, '/').split('/').at(-1)?.toLowerCase();
      if (executable !== 'rmdir') continue;
      const args = stage.argv.slice(1);
      if (!args.some((token) => token === '-p' || token === '--parents')) continue;
      targets.push(...args.filter((token) => !token.startsWith('-')));
    }
  }
  return targets;
}

function powerShellRemovalTargets(command: string): readonly string[] {
  const tree = parseBashCommand(command);
  if (tree.unparseable) return [];
  const targets: string[] = [];
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const executable = (stage.argv[0] ?? '').replace(/\\/g, '/').split('/').at(-1)?.toLowerCase();
      if (!['rm', 'remove-item', 'ri', 'rmdir', 'rd', 'del', 'erase'].includes(executable ?? '')) continue;
      const args = stage.argv.slice(1);
      for (let index = 0; index < args.length; index += 1) {
        const token = args[index]!;
        if (/^-(?:literal)?path(?::.*)?$/i.test(token)) {
          const separator = token.indexOf(':');
          const value = separator >= 0 && token.slice(separator + 1)
            ? token.slice(separator + 1)
            : args[index + 1];
          if (value !== undefined) targets.push(...powerShellPathArrayMembers(value));
          if (separator < 0) index += 1;
          continue;
        }
        if (!token.startsWith('-')) targets.push(...powerShellPathArrayMembers(token));
      }
    }
  }
  return targets;
}

function traversedMutationTargets(command: string): readonly string[] {
  const tree = parseBashCommand(command);
  if (tree.unparseable) return [];
  const targets: string[] = [];
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const executable = (stage.argv[0] ?? '').replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
      const args = stage.argv.slice(1);
      const positionals = args.filter((token) => !token.startsWith('-') && !/^\/[a-z]$/i.test(token));
      if (['mv', 'move'].includes(executable) && positionals.length > 1) {
        targets.push(...positionals.slice(0, -1));
        continue;
      }
      if (executable === 'ren' && positionals.length === 2) {
        targets.push(positionals[0]!);
        continue;
      }
      if (['chmod', 'chown'].includes(executable)
        && args.some((token) => token === '--recursive' || /^-[^-]*R/.test(token))) {
        targets.push(...positionals.slice(1));
        continue;
      }
      if (!isPowerShellMutationCommand(executable)) continue;
      const analysis = analyzePowerShellMutation(stage.argv);
      for (const operation of analysis.operations) {
        if (operation.kind === 'move' || operation.kind === 'rename') targets.push(operation.source);
      }
    }
  }
  return targets;
}

function recursiveRemovalCoversProtectedAgentHome(
  targetPath: string,
  executionCwd: string,
  agentHome: string,
): boolean {
  const lexicalHome = path.resolve(agentHome);
  const canonicalHome = canonicalizeAutoModePath(agentHome) ?? path.resolve(agentHome);
  const resolvedTarget = resolveExecutionPath(targetPath, executionCwd);
  if (!/[*?\[\]{}()!]/.test(resolvedTarget)) {
    return (isPathInsideDirectory(resolvedTarget, canonicalHome)
        && !isAutoWritableKodaxPath(resolvedTarget, canonicalHome))
      || isPathInsideDirectory(lexicalHome, resolvedTarget)
      || isPathInsideDirectory(canonicalHome, resolvedTarget)
      || removalTreeContainsProtectedPath(resolvedTarget, canonicalHome);
  }
  const normalizedPattern = resolvedTarget.replace(/\\/g, '/');
  const protectedCandidates = [
    canonicalHome,
    path.join(canonicalHome, 'runtime'),
    path.join(canonicalHome, 'mcp-tokens'),
    path.join(canonicalHome, 'mcp-clients'),
    path.join(canonicalHome, 'integrations'),
    path.join(canonicalHome, 'config.json'),
    path.join(canonicalHome, 'custom-providers.json'),
    path.join(canonicalHome, 'trusted-project-rules.json'),
    path.join(canonicalHome, '.env'),
    path.join(canonicalHome, 'credentials.json'),
    lexicalHome,
    path.join(lexicalHome, 'runtime'),
    path.join(lexicalHome, 'mcp-tokens'),
    path.join(lexicalHome, 'mcp-clients'),
    path.join(lexicalHome, 'integrations'),
    path.join(lexicalHome, 'config.json'),
    path.join(lexicalHome, 'custom-providers.json'),
    path.join(lexicalHome, 'trusted-project-rules.json'),
    path.join(lexicalHome, '.env'),
    path.join(lexicalHome, 'credentials.json'),
  ];
  if (protectedCandidates.some((candidate) => minimatch(
    candidate.replace(/\\/g, '/'),
    normalizedPattern,
    { dot: true, nocase: process.platform === 'win32' },
  ))) return true;
  return existingRemovalSelectionContainsProtectedPath(
    resolvedTarget,
    canonicalHome,
  );
}

function removalTreeContainsProtectedPath(
  target: string,
  canonicalHome: string,
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const policyTarget = stat.isSymbolicLink()
    ? path.resolve(target)
    : canonicalizeAutoModePath(target) ?? path.resolve(target);
  if (isPathInsideDirectory(policyTarget, canonicalHome)
    && !isAutoWritableKodaxPath(policyTarget, canonicalHome)) return true;
  // Recursive rm unlinks a directory symlink; it does not traverse the target.
  if (stat.isSymbolicLink()) return false;
  if (!stat.isDirectory()) return false;
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
      visited += 1;
      if (visited > 20_000) return true;
      const candidate = path.join(directory, entry.name);
      const policyCandidate = entry.isSymbolicLink()
        ? path.resolve(candidate)
        : canonicalizeAutoModePath(candidate);
      if (policyCandidate === undefined) return true;
      if (isPathInsideDirectory(policyCandidate, canonicalHome)
        && !isAutoWritableKodaxPath(policyCandidate, canonicalHome)) return true;
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return false;
}

function existingRemovalSelectionContainsProtectedPath(
  resolvedPattern: string,
  canonicalHome: string,
): boolean {
  const parsed = path.parse(resolvedPattern);
  const relativeSegments = resolvedPattern.slice(parsed.root.length).split(/[\\/]+/);
  const firstGlob = relativeSegments.findIndex((segment) => /[*?\[\]{}()!]/.test(segment));
  if (firstGlob < 0) return false;
  const staticRoot = path.join(parsed.root, ...relativeSegments.slice(0, firstGlob));
  if (!fs.existsSync(staticRoot)) return false;
  const normalizedPattern = resolvedPattern.replace(/\\/g, '/');
  const pending = [staticRoot];
  const followedDirectories = new Set<string>();
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
      visited += 1;
      if (visited > 20_000) return true;
      const candidate = path.join(directory, entry.name);
      if (minimatch(candidate.replace(/\\/g, '/'), normalizedPattern, {
        dot: true,
        nocase: process.platform === 'win32',
      }) && removalTreeContainsProtectedPath(candidate, canonicalHome)) return true;
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      try {
        if (!fs.statSync(candidate).isDirectory()) continue;
        const canonicalDirectory = fs.realpathSync.native(candidate);
        if (followedDirectories.has(canonicalDirectory)) continue;
        followedDirectories.add(canonicalDirectory);
        pending.push(candidate);
      } catch {
        return true;
      }
    }
  }
  return false;
}

function checkUserKodaxBashWrite(
  command: string,
  executionCwd: string,
): AbsoluteDenyResult {
  if (!command) return MISS;
  let userKodax: string;
  try {
    userKodax = getAgentConfigHome();
  } catch {
    return MISS;
  }
  const recursiveTargets = recursiveRemovalTargets(command);
  const recursiveResolvedTargets = new Set(recursiveTargets.map((target) => (
    resolveExecutionPath(target, executionCwd)
  )));
  const removalTargets = powerShellRemovalTargets(command);
  const removalResolvedTargets = new Set(removalTargets.map((target) => (
    resolveExecutionPath(target, executionCwd)
  )));
  for (const target of recursiveTargets) {
    if (recursiveRemovalCoversProtectedAgentHome(target, executionCwd, userKodax)) {
      return {
        denied: true,
        patternId: 'user_kodax_write',
        reason: `The bash command recursively removes protected KodaX state through \`${target}\`.`,
      };
    }
  }
  const lexicalHome = path.resolve(userKodax);
  const canonicalHome = canonicalizeAutoModePath(userKodax) ?? lexicalHome;
  for (const target of parentRemovalTargets(command)) {
    const resolved = resolveExecutionPath(target, executionCwd);
    const canonical = canonicalizeAutoModePath(target, executionCwd) ?? resolved;
    if (isPathInsideDirectory(resolved, lexicalHome)
      || isPathInsideDirectory(canonical, canonicalHome)) {
      return {
        denied: true,
        patternId: 'user_kodax_write',
        reason: `The bash command can remove the protected KodaX home through parent cleanup from \`${target}\`.`,
      };
    }
  }
  for (const target of traversedMutationTargets(command)) {
    if (recursiveRemovalCoversProtectedAgentHome(target, executionCwd, userKodax)) {
      return {
        denied: true,
        patternId: 'user_kodax_write',
        reason: `The bash command traverses protected KodaX state through \`${target}\`.`,
      };
    }
  }
  const targets = [
    ...collectDeterministicBashWriteTargets(command),
    ...removalTargets,
  ];
  for (const target of targets) {
    const resolved = resolveExecutionPath(target, executionCwd);
    if (recursiveResolvedTargets.has(resolved)) continue;
    if (/[*?\[\]{}()!]/.test(resolved)
      && recursiveRemovalCoversProtectedAgentHome(target, executionCwd, userKodax)) {
      return {
        denied: true,
        patternId: 'user_kodax_write',
        reason: `The bash command selector includes protected KodaX state through \`${target}\`.`,
      };
    }
    if (removalResolvedTargets.has(resolved)) {
      let finalSymlink = false;
      try {
        finalSymlink = fs.lstatSync(resolved).isSymbolicLink();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return {
            denied: true,
            patternId: 'user_kodax_write',
            reason: `The bash command removal target could not be checked safely: \`${target}\`.`,
          };
        }
      }
      if (finalSymlink && (!isPathInsideDirectory(resolved, userKodax)
        || isAutoWritableKodaxPath(resolved, userKodax))) continue;
    }
    if (!isPathInsideDirectory(resolved, userKodax)) continue;
    const canonicalTarget = canonicalizeAutoModePath(target, executionCwd);
    if (canonicalTarget === undefined
      || (isPathInsideDirectory(canonicalTarget, canonicalHome)
        && !isAutoWritableKodaxPath(canonicalTarget, canonicalHome))) {
      return {
        denied: true,
        patternId: 'user_kodax_write',
        reason: `The bash command writes to protected KodaX state \`${target}\` under ~/.kodax/ (home root, Runtime control plane, credentials, or security config).`,
      };
    }
  }
  return MISS;
}

// ============== Public entrypoint ==============

/**
 * Check a tool call against the historical Tier 0 pattern list. Returns the
 * first matching pattern, or `{ denied: false }` if no pattern fires. A match
 * is classifier evidence in Auto[LLM].
 *
 * Order is deterministic — patterns checked in the order defined above.
 * Multiple matches would be possible (e.g. `rm -rf / ; :(){...};:`) but
 * we return the first hit because one precise fact is sufficient for the
 * classifier and the reason string is one-shot.
 *
 * **Pure**: deterministic given (call, projectRoot, stable env).
 * **Fast**: ~5 regex tests + 1-2 string ops (file-tools); bash calls add
 * AST path-extraction. Safe to run on every non-Tier-1 call.
 */
export function checkAbsoluteDeny(
  call: RunnerToolCall,
  projectRoot: string,
  executionCwd = projectRoot,
): AbsoluteDenyResult {
  // File-tool path (write/edit to ~/.kodax/)
  const kodaxWrite = checkUserKodaxWrite(call, executionCwd);
  if (kodaxWrite.denied) return kodaxWrite;

  // Bash command-string patterns
  if (call.name !== 'bash') return MISS;
  const command = typeof call.input.command === 'string' ? call.input.command : '';
  if (!command) return MISS;

  const rmRoot = checkRmRfRoot(command);
  if (rmRoot.denied) return rmRoot;

  // Bash path-aware: credential ~/.kodax/ writes (echo >, tee, etc.)
  const kodaxBashWrite = checkUserKodaxBashWrite(command, executionCwd);
  if (kodaxBashWrite.denied) return kodaxBashWrite;

  const mkfs = checkMkfsOrFormat(command);
  if (mkfs.denied) return mkfs;

  const dd = checkDdDiskWrite(command);
  if (dd.denied) return dd;

  const forkBomb = checkForkBomb(command);
  if (forkBomb.denied) return forkBomb;

  return MISS;
}
