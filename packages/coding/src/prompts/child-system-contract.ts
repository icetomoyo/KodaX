import { staticText } from './static-text.js';
import { TOOL_RECOVERY_GUIDANCE } from './execution-guidance.js';

/** Canonical builtin child instructions; write children append project mutation rules. */
export const CHILD_AGENT_SYSTEM_PROMPT = [
  staticText("child.system.intro"),
  `- ${TOOL_RECOVERY_GUIDANCE}`,
  staticText("child.system.rules"),
].join('\n');
