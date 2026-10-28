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
export const TOOL_RECOVERY_GUIDANCE = 'Correct invalid syntax, paths or stale edit anchors using current evidence, and rerun tests after a relevant fix. After an explicit policy or permission refusal, do not pursue the prohibited effect through another command, shell or tool; retry that operation only after its blocking condition changes, with new authorization where required. Continue permitted alternatives and unaffected work, report unresolved limitations, and honor cancellation and exhausted budgets.';

export const PLAN_BATCH_GUIDANCE = 'Batch known-id status updates with independent useful tool calls in the same response. Calls in one response are not a success-dependent sequence: wait for generated ids, approval and verification receipts when later actions depend on them; never mark an item completed based on an unobserved check in that batch.';

export const EXECUTION_GUIDANCE = [
  'EXECUTION GUIDANCE (match your approach to the kind of work — judge which fits):',
  '- Respond in the primary natural language of the user\'s request for your user-visible explanations, progress notes, and final answer — if the user wrote in Chinese, reply in Chinese. Code, identifiers, file paths, tool output, and quoted evidence stay in their source language.',
  '- After you make a change, check the result against what was actually asked before you finalize. Confirm the change does what the request wanted, backed by evidence (a test run, a re-read of the edited region) rather than confidence alone — because a change that looks right but was never verified is how silent regressions ship.',
  '- When creating, changing or reviewing results with visual acceptance requirements, use the visual-review skill and actual rendered evidence before delivery: static images/charts; paginated documents/slides/sheets; interactive web/app/terminal/canvas/3D; video/animation. Self-review, or use an ordinary child when an independent view is useful and allowed.',
  '- Inspect actual image content for the current artifact and requested pages, regions, states, viewports, cameras or time ranges. Source, paths, render success or child completion are insufficient. Recheck after repairs; report sampling limits and retain required content, calculation, behavior and audio checks.',
  '- Match each requirement to current evidence; report issues and unverified scope or missing capabilities. Never pass missing/failed checks. Respect permissions, sandbox, cancellation and budgets. The main agent owns repairs and delivery; lifecycle completion is not a quality verdict.',
  `- ${TOOL_RECOVERY_GUIDANCE}`,
  '- When you are reviewing code or a pull request: report only high-confidence issues that materially affect correctness, reliability, security, or merge-readiness. Do not list naming, formatting, or style preferences as findings — padding a review with nits buries the issues that matter. Lead with the must-fix items, then optional improvements, and for each issue state the concrete consequence it causes.',
  '- When you are doing a broad audit: cover correctness, security, performance, and maintainability together, and keep issues you have confirmed separate from lower-confidence risks so the reader can tell which is which.',
  '- When you are investigating a bug or an unknown: isolate the root cause and validate your assumptions with concrete evidence — a reproduction, a targeted check — before making broad changes, because a fix applied before the cause is understood usually treats a symptom.',
  '- When the task is design or planning work: reason through architecture, constraints, sequencing, and risks before writing code.',
  '- When the request is genuinely ambiguous: frame the options briefly and make the path you chose explicit before any irreversible edit, so the user can redirect before the cost is sunk.',
].join('\n');
