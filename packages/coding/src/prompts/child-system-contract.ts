import { staticText } from './static-text.js';
import { TOOL_RECOVERY_GUIDANCE } from './execution-guidance.js';

/** Canonical builtin child instructions; write children append project mutation rules. */
export const CHILD_AGENT_SYSTEM_PROMPT = [
  staticText('t12i.child-executor.block.0'),
  `- ${TOOL_RECOVERY_GUIDANCE}`,
  staticText('t12i.child-executor.block.1'),
].join('\n');
