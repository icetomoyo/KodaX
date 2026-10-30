import { staticText } from '../prompts/static-text.js';
/**
 * v0.7.35.1 FEATURE_142 (B-R1) — Coding-flavored compaction summary prompts.
 *
 * These are the verbatim v0.7.35 compaction prompts (byte-identical to
 * the prior `SUMMARY_PROMPT` / `UPDATE_SUMMARY_PROMPT` constants in
 * `@kodax-ai/agent/src/compaction/summary-generator.ts`). They
 * remain the empirically best-performing prompts on the coding domain
 * (96.7% recall on the 10-fixture eval; see
 * `tests/compaction-prompt.eval.ts`) AND happen to also be the best on
 * the non-coding domain (97.0% recall) in the same eval — the wording
 * is coding-flavored but the structure generalizes.
 *
 * Why they live here: per ADR-021, @kodax-ai/agent is the
 * generic compaction primitive package and must not enumerate
 * coding-specific language ("coding agent", "file paths, function
 * names", "HTTP status codes", "## Files & Changes") in its public
 * prompt strings. Those strings now live in the @kodax-ai/coding layer
 * and are passed downward via the `summaryPrompt` /
 * `updateSummaryPrompt` parameters of `compact()` /
 * `buildCompactionPromptSnapshot()` / `generateSummary()`.
 *
 * Coding-flow callers (currently `compaction-orchestration.ts` and
 * `repl/.../commands.ts`) pass these constants explicitly so the
 * coding path produces a byte-equivalent prompt to v0.7.35 — preserving
 * the empirically validated 96.7% recall.
 *
 * Generic / non-coding consumers of @kodax-ai/agent get the
 * neutral `DEFAULT_SUMMARY_PROMPT` / `DEFAULT_UPDATE_SUMMARY_PROMPT`
 * (the candidate-a-conservative eval winner) by default — they pay a
 * 2-3pt non-coding recall cost for not knowing they should pass these
 * coding-flavored prompts, but their architectural surface stays clean.
 */

export const CODING_SUMMARY_PROMPT = staticText("t11.agent-runtime/coding-compaction-prompts.0");

export const CODING_UPDATE_SUMMARY_PROMPT = staticText("t11.agent-runtime/coding-compaction-prompts.1");
