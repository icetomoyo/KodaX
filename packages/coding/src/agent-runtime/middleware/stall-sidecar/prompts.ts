import { staticText } from '../../../prompts/static-text.js';
/**
 * FEATURE_178 (v0.7.42) — sidecar prompt assets pinned by the eval contract.
 *
 * `SIDECAR_SYSTEM_PROMPT`, `REPORT_TOOL`, `renderTranscript` and
 * `buildSidecarUserMessage` were originally authored inline in the
 * F178 eval `cases.ts` (`benchmark/datasets/feature-178-stall-sidecar/`)
 * and validated end-to-end at SHIP-SIDECAR-ALL (149/150 PASS, 0% audit
 * disagreement). When the production sidecar invoker landed, this file
 * became their canonical home so production code does not import from
 * the `benchmark/` test-fixture tree. The eval re-exports from here so
 * the eval contract is grounded in production strings — any future
 * drift breaks both at once.
 *
 * **Do not edit casually**. The SHIP-SIDECAR-ALL verdict is pinned to
 * this exact wording. Material changes invalidate the eval's evidence
 * for SHIP and would require re-running the canonical 5-alias panel.
 *
 * **FEATURE_190 (v0.7.43) exception**: the `suggestedTool` enum was
 * narrowed from 9 to 8 entries (removed `emit_handoff` — the tool is
 * being deleted in F190 Phase 3). The F178 eval's isStuck accuracy
 * does NOT depend on `emit_handoff` being a recommendable nudge target
 * (the eval probes the isStuck=true/false judgment, not the
 * `suggestedTool` field semantics), so SHIP-SIDECAR-ALL evidence
 * transfers. Future enum SHRINKS that follow the same rule (removing
 * a tool that no longer exists) do not require re-running the panel;
 * any other change (wording, isStuck criteria, transcript framing,
 * or ENUM EXPANSION introducing a new recommended tool) does.
 *
 * Pure data + pure-function — no side effects, no I/O.
 */

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';

/**
 * Sidecar SYSTEM_PROMPT — pinned by the FEATURE_178 eval. Establishes
 * (a) role separation (sidecar is reading, not authoring), (b) the
 * decision criteria (isStuck=true / isStuck=false), and (c) the output
 * format (single forced tool call, no narration).
 */
export const SIDECAR_SYSTEM_PROMPT: string = [
  staticText("t12.agent-runtime/middleware/stall-sidecar/prompts.0"),
  '',
  '# IMPORTANT — role separation',
  '',
  staticText("t12.agent-runtime/middleware/stall-sidecar/prompts.1"),
  '',
  '# Decision criteria',
  '',
  'Classify the repetition as **isStuck=true** ONLY when the main agent has made no real progress between the repeated calls:',
  '- Same tool + same input args repeatedly invoked',
  '- No new information gathered between calls (tool_results are identical or stub-served)',
  '- No other tool was called between the repeated invocations',
  '- No substantive textual reasoning that indicates a forward step',
  '- The cache may have already served a "[Read Cache] unchanged" stub — if the model continues calling read on that target after the stub, that is a strong stall signal',
  '',
  'Classify as **isStuck=false** when the repetition is part of a legitimate iterative workflow:',
  '- The model called other distinct tools between the repeats (progressing on other axes)',
  '- The repeated call follows a substantive textual reasoning step ("now verifying that the edit landed", "let me re-check after my batch of changes")',
  '- The model is updating todo items in batches — re-marking the same todo as completed alongside new ones is wasteful but not stuck',
  '- The model is performing legitimate verification (read same file after an edit it just made)',
  '',
  '# Output format',
  '',
  'Call the `report_stall_judgment` tool exactly once. Do not narrate. Do not call any other tool.',
  '',
  staticText("t12.agent-runtime/middleware/stall-sidecar/prompts.2"),
  '',
  'If isStuck=false, leave nudge empty.',
].join('\n');

/**
 * `report_stall_judgment` tool definition — pinned by the FEATURE_178
 * eval. Forces a structured output: `isStuck` boolean + reason +
 * suggestedTool + nudge.
 */
export const REPORT_TOOL: KodaXToolDefinition = {
  name: 'report_stall_judgment',
  description:
    'Report your second-pass judgment of whether the main agent is in a real stall.',
  input_schema: {
    type: 'object',
    properties: {
      isStuck: {
        type: 'boolean',
        description:
          'true = main agent has lost progress and needs a nudge; false = repetition is part of a legitimate flow.',
      },
      reason: {
        type: 'string',
        description:
          'A brief one-sentence rationale citing the specific evidence in the recent history.',
      },
      suggestedTool: {
        type: 'string',
        description:
          staticText("t12.agent-runtime/middleware/stall-sidecar/prompts.3"),
      },
      nudge: {
        type: 'string',
        description:
          'A single concrete instruction the main agent will see as a synthetic user message. Reference suggestedTool by name. Required when isStuck=true; pass empty string when isStuck=false.',
      },
    },
    required: ['isStuck', 'reason', 'suggestedTool', 'nudge'],
  },
};

/**
 * Render a main-agent transcript as third-person text. Embedding the
 * transcript in the user message (instead of as priorMessages) is
 * critical: if assistant-role messages are passed via priorMessages,
 * the sidecar interprets them as ITS OWN past actions ("I read the
 * file") and mis-attributes the stall behaviour. Rendering as text
 * makes the judge/judged separation unambiguous.
 *
 * Output starts with `=== MAIN AGENT TRANSCRIPT (...) ===` header and
 * ends with `=== END TRANSCRIPT ===` so the sidecar can spot the
 * delimiters. Assistant turns are 1-indexed so the sidecar can refer
 * to them by ordinal in `reason`.
 */
export function renderTranscript(
  messages: readonly KodaXMessage[],
): string {
  const lines: string[] = [
    '=== MAIN AGENT TRANSCRIPT (you are reading, not authoring) ===',
  ];
  let assistantTurnIdx = 0;
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string'
        ? m.content
        : m.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
      lines.push('', `[SYSTEM]`, text);
      continue;
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        lines.push('', `[USER → MAIN AGENT]`, m.content);
      } else {
        const toolResults = m.content.filter((b) => b.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            const trBlock = tr as { tool_use_id: string; content: string };
            lines.push('', `[TOOL_RESULT for ${trBlock.tool_use_id}]`, trBlock.content);
          }
        } else {
          const text = m.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          if (text) lines.push('', `[USER → MAIN AGENT]`, text);
        }
      }
      continue;
    }
    if (m.role === 'assistant') {
      assistantTurnIdx++;
      lines.push('', `[MAIN AGENT — assistant turn ${assistantTurnIdx}]`);
      if (typeof m.content === 'string') {
        lines.push(`text: ${m.content}`);
        continue;
      }
      for (const b of m.content) {
        if (b.type === 'text') {
          lines.push(`text: ${b.text}`);
        } else if (b.type === 'tool_use') {
          const useBlock = b as { id: string; name: string; input: unknown };
          lines.push(
            `tool_use: ${useBlock.name}(${JSON.stringify(useBlock.input)}) [id=${useBlock.id}]`,
          );
        }
      }
    }
  }
  lines.push('', '=== END TRANSCRIPT ===');
  return lines.join('\n');
}

/**
 * Build the final user-message body the sidecar invocation will see.
 * The body order is fixed (envelope → transcript → action prompt) so
 * the sidecar's attention pattern stays consistent with the eval.
 *
 * Production callers (and the eval driver) both go through this
 * helper. The eval's `buildSidecarUserMessage(StallCase)` wraps this
 * to keep its fixture-type ergonomics.
 */
export function buildSidecarUserMessage(params: {
  /** Pre-rendered L1 signal envelope (see stall-detector.ts). */
  readonly signalEnvelope: string;
  /** Recent main-agent messages to render as the transcript. */
  readonly recentMessages: readonly KodaXMessage[];
}): string {
  return [
    params.signalEnvelope,
    '',
    renderTranscript(params.recentMessages),
    '',
    'Judge whether the main agent in the transcript above is in a real stall. Call report_stall_judgment exactly once.',
  ].join('\n');
}
