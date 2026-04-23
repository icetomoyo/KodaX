export {
  extractArtifactLedger,
  mergeArtifactLedger,
  type CompactionAnchor,
  type CompactionUpdate,
} from '@kodax/agent';

import type { KodaXToolUseBlock } from '@kodax/ai';
import { getRequiredToolParams } from './tools/index.js';

export function checkIncompleteToolCalls(toolBlocks: KodaXToolUseBlock[]): string[] {
  const incomplete: string[] = [];
  for (const tc of toolBlocks) {
    const required = getRequiredToolParams(tc.name);
    const input = (tc.input ?? {}) as Record<string, unknown>;
    for (const param of required) {
      if (input[param] === undefined || input[param] === null || input[param] === '') {
        incomplete.push(`${tc.name}: missing '${param}'`);
      }
    }
  }
  return incomplete;
}
