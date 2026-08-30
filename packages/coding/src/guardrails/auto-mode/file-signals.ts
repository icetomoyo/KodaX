/**
 * File Signal Collector — FEATURE_158 Step 3 (v0.7.39).
 *
 * Produces signals for `write` / `edit` tool calls about the target path's
 * relation to the project + protected zones. Used by the auto-mode
 * classifier as informational input (NOT verdicts — see `signals.ts`
 * invariants).
 *
 * Signal kinds produced:
 *   - protected_path     (path under <projectRoot>/.kodax or ~/.kodax)
 *   - outside_project    (path outside projectRoot AND outside system temp)
 *   - file_modification  (always emitted with target path — coarse-grained
 *                        flag for the classifier to anchor file-edit context)
 *
 * The historical Tier 0 detector for `~/.kodax/` writes is a separate
 * module. In Auto[LLM] both its match and this protected_path signal are
 * facts for the classifier.
 *
 * Purity: deterministic given `call.input.path` + `projectRoot` + stable
 * env (KODAX_HOME, system temp). `getAgentConfigHome()` and `os.tmpdir()`
 * are env-stable per process — acceptable per `signals.ts` purity contract.
 */

import os from 'node:os';
import path from 'node:path';

import {
  getAgentConfigHome,
  isPathInsideDirectory,
  resolveExecutionPath,
} from '@kodax-ai/agent';
import type { RunnerToolCall } from '@kodax-ai/agent';

import type { SignalCollector, ToolCallSignal } from './signals.js';

/**
 * Returns the union of system temp directories that should be considered
 * a "safe scratchpad" for outside-project writes. Includes `os.tmpdir()`
 * plus the major env-vars (TEMP, TMP, TMPDIR) so user-customised temp
 * locations don't get false-positive `outside_project` signals.
 *
 * Env reads happen lazily (each call) since collectors are short-lived
 * and tmpdir() itself reads env on first call; downstream callers benefit
 * from seeing live env changes during tests.
 */
function getSystemTempDirectories(): readonly string[] {
  const dirs = new Set<string>();
  try {
    dirs.add(os.tmpdir());
  } catch {
    // ignore — tmpdir() shouldn't throw, but defensive against weird envs
  }
  for (const env of ['TEMP', 'TMP', 'TMPDIR'] as const) {
    const v = process.env[env];
    if (v && v.length > 0) dirs.add(v);
  }
  return Array.from(dirs);
}

// ============== Collector ==============

const FILE_TOOL_NAMES: ReadonlySet<string> = new Set(['write', 'edit']);

export const fileSignalCollector: SignalCollector = {
  toolNames: FILE_TOOL_NAMES,

  collect(
    call: RunnerToolCall,
    projectRoot: string,
    executionCwd = projectRoot,
  ): readonly ToolCallSignal[] {
    const targetPath = typeof call.input.path === 'string' ? call.input.path : '';
    if (!targetPath) return [];

    const signals: ToolCallSignal[] = [];
    const resolvedTarget = resolveExecutionPath(targetPath, executionCwd);

    // 1. protected_path — ~/.kodax (highest priority; user-creds zone)
    const userKodaxDir = safeGetAgentConfigHome();
    if (userKodaxDir && isPathInsideDirectory(resolvedTarget, userKodaxDir)) {
      signals.push({ kind: 'protected_path', path: targetPath, zone: 'user-kodax' });
    }

    // 2. protected_path — <projectRoot>/.kodax (project-config zone)
    const projectKodaxDir = path.join(path.resolve(projectRoot), '.kodax');
    if (isPathInsideDirectory(resolvedTarget, projectKodaxDir)) {
      signals.push({ kind: 'protected_path', path: targetPath, zone: 'project-kodax' });
    }

    // 3. outside_project — only when NOT in protected zone (avoid double-flag)
    //    AND not in project AND not in system temp
    if (!signals.some((s) => s.kind === 'protected_path')) {
      const resolvedRoot = path.resolve(projectRoot);
      const insideProject = isPathInsideDirectory(resolvedTarget, resolvedRoot);
      if (!insideProject) {
        const tempDirs = getSystemTempDirectories();
        const insideTemp = tempDirs.some((d) => isPathInsideDirectory(resolvedTarget, d));
        if (!insideTemp) {
          signals.push({ kind: 'outside_project', path: targetPath });
        }
      }
    }

    // 4. file_modification — always, as an anchor signal
    signals.push({ kind: 'file_modification', targets: [targetPath] });

    return signals;
  },
};

/**
 * Defensive wrapper — `getAgentConfigHome()` is well-behaved today but
 * collectors must never throw (the guardrail's `beforeTool` continues
 * regardless and we don't want a collector bug to lose all signals).
 */
function safeGetAgentConfigHome(): string | undefined {
  try {
    return getAgentConfigHome();
  } catch {
    return undefined;
  }
}
