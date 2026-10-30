import { staticText } from './static-text.js';
/**
 * Static EXECUTION GUIDANCE — the harness-LLM-judgment block the agent
 * self-applies INSTEAD of being told its execution mode / harness tier by the
 * keyword router (ADR-043). Shared verbatim by both the AMA Worker
 * (`buildWorkerInstructions`) and the top-level SA path (`capability-sections`)
 * so the two execution paths give the agent the same self-judgment guidance and
 * neither receives the old router `prompt-overlay`.
 *
 * The text is deliberately free of harness-tier / mode labels (ADR-033 §4): it
 * describes how to approach each kind of work as informal use-cases the LLM
 * matches against, not a classification table. Validated against the canonical
 * 5-alias panel for both the Worker (H3) and the SA path (P1.7).
 */
export const TOOL_RECOVERY_GUIDANCE = staticText("t11.prompts/execution-guidance.0");

export const PLAN_BATCH_GUIDANCE = staticText("t11.prompts/execution-guidance.1");

export const EXECUTION_GUIDANCE = [
  'EXECUTION GUIDANCE (match your approach to the kind of work — judge which fits):',
  staticText("t11.prompts/execution-guidance.2"),
  staticText("t11.prompts/execution-guidance.3"),
  staticText("t11.prompts/execution-guidance.4"),
  staticText("t11.prompts/execution-guidance.5"),
  staticText("t11.prompts/execution-guidance.6"),
  `- ${TOOL_RECOVERY_GUIDANCE}`,
  staticText("t11.prompts/execution-guidance.7"),
  '- When you are doing a broad audit: cover correctness, security, performance, and maintainability together, and keep issues you have confirmed separate from lower-confidence risks so the reader can tell which is which.',
  staticText("t11.prompts/execution-guidance.8"),
  '- When the task is design or planning work: reason through architecture, constraints, sequencing, and risks before writing code.',
  '- When the request is genuinely ambiguous: frame the options briefly and make the path you chose explicit before any irreversible edit, so the user can redirect before the cost is sunk.',
].join('\n');
