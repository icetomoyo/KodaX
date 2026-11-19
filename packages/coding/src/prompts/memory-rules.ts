import { staticText } from './static-text.js';
/** FEATURE_260 — governed memory guidance for the Action Agent. */
export function buildMemoryRulesSection(_cwd: string): string {
  return staticText("memory-rules.section");
}

/** The Worker's dense wording, for a Worker that has memory_intent and memory_recall. */
export function buildWorkerMemoryRules(): string {
  return staticText("memory-rules.worker");
}

export const MEMORY_RULES_SHA256 = `sha256:${createHash('sha256')
  .update(buildMemoryRulesSection('.'), 'utf8')
  .digest('hex')}`;
import { createHash } from 'node:crypto';
