import { staticText } from './static-text.js';
/** FEATURE_260 — governed memory guidance for the Action Agent. */
export function buildMemoryRulesSection(_cwd: string): string {
  return [
    staticText("t12i.prompts/memory-rules.block.0"),
  ].join('\n');
}

export const MEMORY_RULES_SHA256 = `sha256:${createHash('sha256')
  .update(buildMemoryRulesSection('.'), 'utf8')
  .digest('hex')}`;
import { createHash } from 'node:crypto';
