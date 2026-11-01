/**
 * REPL-side path-aware bash signal collector — FEATURE_158 Step 8 (v0.7.39).
 *
 * Bridges the coding-side `SignalCollector` contract to coding-owned path
 * utilities (`extractPathsFromCommand`, `isAlwaysConfirmPath`,
 * `getBashOutsideProjectWriteRisk`, `collectBashWriteTargets`).
 *
 * This integration collector stays in @kodax/repl because it adds REPL-owned
 * protected-path policy. The shared AST, path extraction, and permission
 * helpers live in @kodax/coding and remain usable by direct SDK consumers.
 *
 * Signal kinds produced (bash-only):
 *   - protected_path        (~/.kodax or <projectRoot>/.kodax)
 *   - outside_project       (paths neither in project nor in temp)
 *   - shell_redirect_outside (`>` / `>>` redirection targets outside project)
 *
 * Out of scope:
 *   - dangerous_pattern / network / package_install / git_write — produced
 *     by the coding-side `bashSignalCollector` (no repl-side path needed).
 *   - file_modification / protected_path for write/edit tools — produced
 *     by the coding-side `fileSignalCollector` (`input.path` is enough).
 *
 * Path extraction is regex/AST-based. Boundary checks share the coding policy's
 * physical identities, including long and short Windows temporary paths.
 */

import path from 'node:path';
import os from 'node:os';

import {
  getAgentConfigHome,
  isPathInsideDirectory,
  resolveExecutionPath,
} from '@kodax-ai/agent';
import type { RunnerToolCall } from '@kodax-ai/agent';
import type {
  AbsoluteDenyCheck,
  SignalCollector,
  ToolCallSignal,
} from '@kodax-ai/coding';

import {
  collectBashWriteTargets,
  collectDeterministicBashWriteTargets,
  extractPathsFromCommand,
  isAlwaysConfirmPath,
} from './permission.js';

function safeGetAgentConfigHome(): string | undefined {
  try {
    return getAgentConfigHome();
  } catch {
    return undefined;
  }
}

function resolveShellWriteTarget(target: string, executionCwd: string): string {
  const homePrefix = process.platform === 'win32'
    ? /^(?:\$\{home\}|\$home|\$env:(?:home|userprofile)|%userprofile%)(?=$|[\\/])/i
    : /^(?:\$\{HOME\}|\$HOME)(?=$|[\\/])/;
  return resolveExecutionPath(target.replace(homePrefix, os.homedir()), executionCwd);
}

/**
 * Resolve which "zone" a path lives in, if any. Returns undefined when the
 * path is not under either kodax config directory.
 */
function resolveProtectedZone(
  candidate: string,
  projectRoot: string,
): 'project-kodax' | 'user-kodax' | undefined {
  const userKodax = safeGetAgentConfigHome();
  if (userKodax && isPathInsideDirectory(candidate, userKodax)) return 'user-kodax';
  const projectKodax = path.join(path.resolve(projectRoot), '.kodax');
  if (isPathInsideDirectory(candidate, projectKodax)) return 'project-kodax';
  return undefined;
}

function getSystemTempDirs(): readonly string[] {
  const dirs = new Set<string>();
  try {
    dirs.add(os.tmpdir());
  } catch {
    /* defensive */
  }
  for (const env of ['TEMP', 'TMP', 'TMPDIR'] as const) {
    const v = process.env[env];
    if (v && v.length > 0) dirs.add(v);
  }
  return Array.from(dirs);
}

const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(['bash']);

/**
 * The collector. Wired into the AutoModeToolGuardrail via the bootstrap's
 * `extraCollectors` config; merged with `bashSignalCollector` from coding.
 */
export const replBashPathSignalCollector: SignalCollector = {
  toolNames: BASH_TOOL_NAMES,

  collect(
    call: RunnerToolCall,
    projectRoot: string,
    executionCwd = projectRoot,
  ): readonly ToolCallSignal[] {
    const command = typeof call.input.command === 'string' ? call.input.command : '';
    if (!command || !projectRoot) return [];

    const signals: ToolCallSignal[] = [];
    const emittedProtectedPaths = new Set<string>();
    const emittedOutsideTargets = new Set<string>();
    const tempDirs = getSystemTempDirs();
    const resolvedRoot = path.resolve(projectRoot);

    // Pass 1: protected_path / outside_project for any path-shaped token in argv
    for (const candidate of extractPathsFromCommand(command)) {
      let resolved: string;
      try {
        resolved = resolveShellWriteTarget(candidate, executionCwd);
      } catch {
        continue;
      }
      const zone = resolveProtectedZone(resolved, projectRoot);
      if (zone) {
        if (!emittedProtectedPaths.has(resolved)) {
          emittedProtectedPaths.add(resolved);
          signals.push({ kind: 'protected_path', path: candidate, zone });
        }
        continue; // skip outside_project for the same path (avoid double-flag)
      }
      if (isAlwaysConfirmPath(resolved, projectRoot)) {
        // isAlwaysConfirmPath returns true when path is outside-project AND
        // outside system temp. Treat as outside_project signal.
        const insideTemp = tempDirs.some((d) => isPathInsideDirectory(resolved, d));
        const insideProject = isPathInsideDirectory(resolved, resolvedRoot);
        if (!insideTemp && !insideProject && !emittedOutsideTargets.has(resolved)) {
          emittedOutsideTargets.add(resolved);
          signals.push({ kind: 'outside_project', path: candidate });
        }
      }
    }

    // Pass 2: shell_redirect_outside for write targets (`>`, `>>`, tee, etc.)
    //   collectBashWriteTargets returns the targets a write command would
    //   write to. We flag targets that are outside project AND outside temp.
    for (const target of collectBashWriteTargets(command)) {
      let resolved: string;
      try {
        resolved = resolveShellWriteTarget(target, executionCwd);
      } catch {
        continue;
      }
      // Don't duplicate a protected_path signal as shell_redirect_outside.
      if (resolveProtectedZone(resolved, projectRoot)) continue;
      const insideProject = isPathInsideDirectory(resolved, resolvedRoot);
      if (insideProject) continue;
      const insideTemp = tempDirs.some((d) => isPathInsideDirectory(resolved, d));
      // Use the same fresh physical boundary as argv paths for either 8.3 spelling.
      if (insideTemp || !isAlwaysConfirmPath(resolved, projectRoot)) continue;
      // Outside project + outside temp = redirect-to-elsewhere.
      signals.push({ kind: 'shell_redirect_outside', target });
    }

    return signals;
  },
};

/**
 * Deterministic REPL-layer Tier-0 check for shell writes into the user
 * credential zone. Parsed write targets are used so quoted Python and regex
 * source is never reinterpreted as a path.
 */
export const replBashUserKodaxWriteDeny: AbsoluteDenyCheck = (
  call,
  _projectRoot,
  executionCwd,
) => {
  if (call.name !== 'bash') return { denied: false };
  const command = typeof call.input.command === 'string' ? call.input.command : '';
  const protectedHomes = new Set<string>([path.join(os.homedir(), '.kodax')]);
  const configuredHome = safeGetAgentConfigHome();
  if (configuredHome) protectedHomes.add(configuredHome);
  for (const target of collectDeterministicBashWriteTargets(command)) {
    const resolved = resolveShellWriteTarget(target, executionCwd);
    if ([...protectedHomes].some((home) => isPathInsideDirectory(resolved, home))) {
      return {
        denied: true,
        patternId: 'user_kodax_write',
        reason: `Shell write to credential-zone path \`${target}\` (under ~/.kodax/) is permanently denied. KodaX config edits must use the \`kodax config\` CLI or SDK config API.`,
      };
    }
  }
  return { denied: false };
};
