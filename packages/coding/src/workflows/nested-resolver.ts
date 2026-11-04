/**
 * FEATURE_246 Part E — resolver for one-level nested `wf.workflow(name, args)`.
 *
 * Maps a workflow name to a runnable module for the agent-layer runtime's
 * injected `resolveWorkflowModule` port. Resolution order: built-in registry
 * first (in-memory, trusted), then a saved capsule discovered under the run's
 * `.kodax/workflows` (project) + `<agent home>/workflows` (personal) dirs.
 *
 * Layer: this is the coding-side resolver; the agent runtime only sees the
 * opaque `(name) => module | undefined` port (ADR-021 — agent has no coding
 * dependency). Kept out of `index.ts` to avoid the index → workflow-runner
 * re-export cycle.
 */

import { join } from 'node:path';

import { getAgentConfigPath, type WorkflowModule, type WorkflowModuleResolver } from '@kodax-ai/agent';

import { getBuiltinWorkflow } from './builtin/registry.js';
import {
  discoverSavedWorkflows,
  loadSavedWorkflow,
  type SavedWorkflowDirs,
} from './discovery.js';

/** Default saved-workflow dirs for a run cwd: project `.kodax/workflows` +
 *  personal `<agent home>/workflows`. Mirrors the REPL's `savedWorkflowDirs`. */
export function defaultSavedWorkflowDirs(cwd: string): SavedWorkflowDirs {
  return {
    project: join(cwd, '.kodax', 'workflows'),
    personal: getAgentConfigPath('workflows'),
  };
}

async function resolveSavedByName(
  name: string,
  dirs: SavedWorkflowDirs,
): Promise<WorkflowModule | undefined> {
  const refs = await discoverSavedWorkflows(dirs);
  const ref = refs.find((candidate) => candidate.name === name);
  if (!ref) return undefined;
  return loadSavedWorkflow(ref.path);
}

/**
 * Build a `resolveWorkflowModule` for a run rooted at `cwd`. Built-in names win
 * over saved (a built-in is trusted in-memory code; shadowing it with a saved
 * capsule of the same name would be a surprising trust downgrade). Returns
 * undefined for an unknown name (the runtime turns that into a clear error).
 */
export function createNestedWorkflowResolver(cwd: string): WorkflowModuleResolver {
  const dirs = defaultSavedWorkflowDirs(cwd);
  return async (name: string): Promise<WorkflowModule | undefined> => {
    return getBuiltinWorkflow(name) ?? (await resolveSavedByName(name, dirs));
  };
}
