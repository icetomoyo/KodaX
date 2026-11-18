/**
 * KodaX Prompt Builder
 *
 * Builds effective prompts through an explicit section registry so prompt
 * truth can be snapshotted, attributed, and regression-tested.
 *
 * v0.7.35.1 FEATURE_142 Batch E: the 13 capability-context sections
 * formerly inlined here have been hoisted to
 * `./capability-sections.ts:buildCapabilityContextSections`. This file
 * keeps the direct-engine orchestration (cwd resolution, snapshot assembly)
 * and delegates section construction to the shared helper. Its output
 * is byte-equivalent to the pre-Batch E rendering — `builder.test.ts`
 * is the integration-level guard for that contract.
 */

import path from 'path';
import { resolveExecutionCwd } from '../runtime-paths.js';
import type { KodaXOptions } from '../types.js';
import {
  buildPromptSnapshot,
  type KodaXPromptSnapshot,
} from './sections.js';
import { buildCapabilityContextSections } from './capability-sections.js';

/**
 * Build a sectionized snapshot of the effective system prompt.
 */
export async function buildSystemPromptSnapshot(
  options: KodaXOptions,
  isNewSession: boolean,
): Promise<KodaXPromptSnapshot> {
  const executionCwd = resolveExecutionCwd(options.context);
  const projectRoot = options.context?.gitRoot
    ? path.resolve(options.context.gitRoot)
    : executionCwd;

  const sections = await buildCapabilityContextSections(
    options,
    isNewSession,
    executionCwd,
  );

  return buildPromptSnapshot(sections, {
    isNewSession,
    executionCwd,
    projectRoot,
    longRunning: false,
  });
}

/**
 * Build the rendered system prompt used for provider calls.
 */
export async function buildSystemPrompt(
  options: KodaXOptions,
  isNewSession: boolean,
): Promise<string> {
  return (await buildSystemPromptSnapshot(options, isNewSession)).rendered;
}
