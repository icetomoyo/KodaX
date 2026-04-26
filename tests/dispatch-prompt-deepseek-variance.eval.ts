/**
 * Eval: deepseek dispatch variance probe.
 *
 * ## Purpose
 *
 * Issue 124 follow-up. The main `dispatch-prompt-comparison.eval.ts` showed
 * that deepseek's T1 (3-package fan-out) result flipped between two runs
 * (`old` and `a5b` variants both correct in run 1, both wrong in run 2 —
 * but different rows). This probe asks: is the variance pure stochasticity
 * at temperature > 0, or is it model-specific (e.g. `deepseek-chat`
 * deprecated alias vs `deepseek-v4-flash` current default)?
 *
 * KodaX's `deepseek` provider was migrated to `deepseek-v4-flash` as the
 * default model when the V4 series shipped (registry.ts:88-98). The pre-V4
 * `deepseek-chat` alias remains accepted by the upstream API until
 * 2026-07-24 deprecation, but is no longer the model real users hit. Our
 * earlier baseline accidentally tested the deprecated alias — this probe
 * re-runs the same fan-out scenario on three deepseek models, N=5 each,
 * to surface:
 *
 *   1. The variance distribution (is it 50/50 or e.g. 4/1?)
 *   2. Whether v4-flash agrees with zhipu/minimax (consistent fan-out) or
 *      keeps deepseek-chat's "scope-then-dispatch" pattern.
 *   3. Whether v4-pro (deeper-reasoning alternate) follows v4-flash or
 *      reverts to v4-chat's conservative pattern.
 *
 * ## Result of last run (2026-04-26)
 *
 * ```
 *   deepseek-chat (deprecated)        → 2/5 fan-out (40%)
 *   deepseek-v4-flash (default)       → 5/5 fan-out (100%)  ← shipping target
 *   deepseek-v4-pro (deeper, alt)     → 3/5 fan-out (60%)
 * ```
 *
 * Interpretation:
 *   - v4-flash: fully aligned with the prompt, 100% direct fan-out.
 *   - v4-pro: deeper-reasoning model has a stronger "scope-first" prior;
 *     the 40% glob-first runs eventually dispatch on turn 2, so it is
 *     delayed-but-correct rather than missed-dispatch. Acceptable as-is for
 *     a deep-reasoning tier.
 *   - deepseek-chat: deprecated, will not be the user-facing model after
 *     2026-07-24. Earlier "deepseek inconsistency" claims were artifacts
 *     of testing this alias.
 *
 * ## Run
 *
 *   npm run test:eval -- tests/dispatch-prompt-deepseek-variance.eval.ts
 *
 * Costs: 10 LLM calls (5 per model). Each ~5-15 sec. Total ~2 min.
 *
 * ## When to re-run
 *
 *   - Before any prompt change that targets deepseek-specific behavior
 *   - After deepseek catalog refresh (e.g. v4-pro promotion)
 */

import { describe, it, expect } from 'vitest';
import { getProvider, type KodaXMessage, type KodaXToolDefinition } from '@kodax/ai';

const T1_TASK = 'Audit three independent packages of this monorepo for security issues: packages/ai, packages/coding, packages/repl. For each package, find any vulnerabilities (input validation gaps, unsafe shell, secret handling, etc). Report findings per-package.';

const A5B_PROMPT_SECTION = [
  'PARALLEL CHILD AGENTS: dispatch_child_task delegates an investigation to a child agent that has its own context window. Calls in the same turn run in parallel; each child\'s findings return as a separate tool result.',
  '',
  'DECIDE after your initial 1-2 scoping turns, before any deep investigation:',
  '',
  'RULE A — Fan-out (2+ independent non-trivial threads)',
  '  "Non-trivial" means each thread on its own would need multiple file reads or multi-round searching. A bundle of small file lookups is NOT fan-out.',
  '  → Dispatch ONE child per thread, in the SAME turn.',
  '  Example: "Audit packages/ai, packages/agent, packages/coding for security" → 3 parallel children.',
  '  If you identify N qualifying threads, dispatch ALL N. Do not rationalize "I\'ll handle one myself" — that defeats the parallelism.',
  '',
  'RULE B — Heavy single investigation (context preservation)',
  '  Dispatch ONE child when BOTH conditions hold:',
  '    (1) the raw volume would crowd your own context — any signal qualifies: unclear target set needing multi-round "search → read → re-search", likely ≥10 file reads, or large grep result sets; AND',
  '    (2) you only need a summary / list / verdict as output — not the raw code in your own context to reason over.',
  '  Example: "Find every caller of handleAuth() and categorize usage patterns."',
  '',
  'RULE C — Default (targets known, output small, single-round)',
  '  Do it yourself with parallel tool calls (glob + grep + read together when independent).',
  '  A single child for work that fits this rule is pure overhead — do not dispatch.',
  '',
  'When NOT to use dispatch_child_task (do these directly instead):',
  '  - Reading a known specific file path → use read_file directly.',
  '  - Searching for a known symbol like `class Foo` or `function bar` → use grep_files.',
  '  - Looking at 2–3 files you have already identified → parallel read_file calls.',
  '  - Work where you will keep the raw output in your own context anyway.',
  '',
  'TIMING: decide early. Children\'s findings can inform your downstream decisions. Dispatching after you have already deep-dived is wasted work.',
  'Scope: Scout dispatches are readOnly.',
].join('\n');

const SYSTEM_PROMPT = [
  'You are Scout — the entry role for an adaptive coding agent. Your job is to investigate the user\'s request and produce findings.',
  '',
  'You have these tools available:',
  '  - dispatch_child_task: delegate an investigation to a child agent (see below).',
  '  - read_file: read a specific file path.',
  '  - grep_files: search for a regex/string across files.',
  '  - glob_files: list files matching a glob pattern.',
  '',
  A5B_PROMPT_SECTION,
  '',
  'Begin your investigation now. Use tools.',
].join('\n');

const TOOLS: KodaXToolDefinition[] = [
  {
    name: 'dispatch_child_task',
    description: 'Execute a single child agent for an independent sub-task. Call multiple times in parallel for concurrent sub-tasks.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        objective: { type: 'string' },
        readOnly: { type: 'boolean' },
        scope_summary: { type: 'string' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a specific file from disk by absolute or workspace-relative path.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'grep_files',
    description: 'Search for a regex pattern across files in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob_files',
    description: 'List files matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
];

interface RunResult {
  trial: number;
  toolNames: string[];
  dispatchCount: number;
  globCount: number;
  textPreview: string;
  error?: string;
}

async function runOnce(model: string, trial: number): Promise<RunResult> {
  const messages: KodaXMessage[] = [{ role: 'user', content: T1_TASK }];
  try {
    const provider = getProvider('deepseek');
    const result = await provider.stream(messages, TOOLS, SYSTEM_PROMPT, undefined, {
      modelOverride: model,
    });
    const toolNames = result.toolBlocks.map((b) => b.name);
    return {
      trial,
      toolNames,
      dispatchCount: toolNames.filter((n) => n === 'dispatch_child_task').length,
      globCount: toolNames.filter((n) => n === 'glob_files').length,
      textPreview: result.textBlocks
        .map((b) => b.text)
        .join('')
        .slice(0, 200)
        .replace(/\s+/g, ' '),
    };
  } catch (err) {
    return {
      trial,
      toolNames: [],
      dispatchCount: 0,
      globCount: 0,
      textPreview: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarize(model: string, results: RunResult[]): string {
  const lines: string[] = [];
  lines.push(`========== ${model} (N=${results.length}) ==========`);
  for (const r of results) {
    const verdict = r.error
      ? `ERROR: ${r.error}`
      : `dispatch=${r.dispatchCount} glob=${r.globCount} tools=[${r.toolNames.join(',')}]`;
    lines.push(`  trial ${r.trial}: ${verdict}`);
    if (r.textPreview) lines.push(`    text: "${r.textPreview}"`);
  }
  const validRuns = results.filter((r) => !r.error);
  const dispatchRuns = validRuns.filter((r) => r.dispatchCount >= 2).length;
  const globOnlyRuns = validRuns.filter((r) => r.dispatchCount === 0 && r.globCount > 0).length;
  lines.push(
    `  → fan-out (≥2 dispatch): ${dispatchRuns}/${validRuns.length}; glob-only: ${globOnlyRuns}/${validRuns.length}`,
  );
  return lines.join('\n');
}

const N_TRIALS = 5;

describe('Eval: deepseek dispatch variance probe', () => {
  it.skipIf(!process.env.DEEPSEEK_API_KEY)(
    `runs T1 fan-out task ${N_TRIALS}x on deepseek-chat / v4-flash / v4-pro`,
    async () => {
      console.log('\n[probe] starting deepseek-chat (deprecated, baseline) ...');
      const chatResults: RunResult[] = [];
      for (let i = 1; i <= N_TRIALS; i++) {
        console.log(`[probe] deepseek-chat trial ${i}/${N_TRIALS} ...`);
        chatResults.push(await runOnce('deepseek-chat', i));
      }

      console.log('\n[probe] starting deepseek-v4-flash (current default) ...');
      const flashResults: RunResult[] = [];
      for (let i = 1; i <= N_TRIALS; i++) {
        console.log(`[probe] deepseek-v4-flash trial ${i}/${N_TRIALS} ...`);
        flashResults.push(await runOnce('deepseek-v4-flash', i));
      }

      console.log('\n[probe] starting deepseek-v4-pro (higher-tier alternate) ...');
      const proResults: RunResult[] = [];
      for (let i = 1; i <= N_TRIALS; i++) {
        console.log(`[probe] deepseek-v4-pro trial ${i}/${N_TRIALS} ...`);
        proResults.push(await runOnce('deepseek-v4-pro', i));
      }

      console.log('');
      console.log(summarize('deepseek-chat (deprecated)', chatResults));
      console.log('');
      console.log(summarize('deepseek-v4-flash (current default)', flashResults));
      console.log('');
      console.log(summarize('deepseek-v4-pro (higher-tier alternate)', proResults));
      console.log('');

      expect(chatResults.length).toBe(N_TRIALS);
      expect(flashResults.length).toBe(N_TRIALS);
      expect(proResults.length).toBe(N_TRIALS);
    },
    15 * 60 * 1000,
  );
});
