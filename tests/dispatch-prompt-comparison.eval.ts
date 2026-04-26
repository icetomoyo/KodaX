/**
 * Eval: dispatch_child_task prompt comparison — RULE A/B/C variants.
 *
 * ## Purpose & ownership
 *
 * Persistent regression / experimentation harness for the Scout & Generator
 * `dispatch_child_task` prompt sections in
 * `packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`.
 *
 * Created during Issue 124 (v0.7.28) investigation as the empirical baseline
 * for "does this prompt change actually work across our coding-plan providers,
 * or just on Claude?". Kept in-tree (not deleted) as the regression baseline
 * for any future prompt edits in the same area — running it reproduces the
 * comparison data behind the Issue 124 conclusions.
 *
 * ## What it measures
 *
 * For each (provider × prompt-variant × task) combination, looks at the FIRST
 * response only — which tools did the LLM pick?
 *
 *   T1: 3-package security audit         → expect ≥2 dispatch_child_task (fan-out)
 *   T2: read a known specific file path  → expect first tool = read_file (no dispatch)
 *   T3: find callers + categorize        → expect 1 dispatch_child_task (context preservation),
 *                                           grep+read sequence is acceptable as `partial`
 *
 * Variants:
 *   - `old`: original RULE A/B/C prompt (pre Issue 124 baseline)
 *   - `new`: experimental L1-L4 stance rewrite (REGRESSED on T3 zhipu/minimax — kept as
 *            counter-example to discourage repeating the rewrite without measurement)
 *   - `a5b`: RULE A/B/C + "When NOT to use" negative list (the v0.7.28 shipping form)
 *
 * ## Run
 *
 *   npm run test:eval -- tests/dispatch-prompt-comparison.eval.ts
 *
 * Skips providers whose API key is missing. Total runs ≈ providersAvailable × 9.
 * Each provider call is non-trivial cost (real LLM tokens). One full pass is
 * roughly 2-3 minutes wall-clock + a few cents in token spend.
 *
 * ## When to re-run
 *
 *   - Before/after any change to the dispatch-related prompt sections
 *     (Scout L476-499 or Generator L572-600 in role-prompt.ts)
 *   - After upgrading a coding-plan provider's default model (catalog refresh)
 *   - When debugging "LLM stopped dispatching" reports
 *
 * ## Result of last full run (2026-04-26, Issue 124, deepseek=v4-flash)
 *
 * ```
 * Provider       | Variant | T1 fan-out | T2 no-dispatch | T3 single-child
 * zhipu-coding   | old     | ✅ 3 dispatch | ✅ read_file | ✅ 1 dispatch
 * zhipu-coding   | new     | ✅ 3 dispatch | ✅ read_file | ⚠ grep only (REGRESSED)
 * zhipu-coding   | a5b     | ✅ 3 dispatch | ✅ read_file | ✅ 1 dispatch
 * minimax-coding | old     | ✅ 3 dispatch | ✅ read_file | ⚠ grep only
 * minimax-coding | new     | ✅ 3 dispatch | ✅ read_file | ⚠ grep only
 * minimax-coding | a5b     | ✅ 3 dispatch | ✅ read_file | ✅ 1 dispatch
 * deepseek       | old     | ✅ 3 dispatch | ✅ read_file | ⚠ grep+glob
 * deepseek       | new     | ✅ 3 dispatch | ✅ read_file | ⚠ grep
 * deepseek       | a5b     | ✅ 3 dispatch | ✅ read_file | ⚠ grep
 * ```
 *
 * Key conclusions captured in Issue 124:
 *   1. The `new` (L1-L4 rewrite) variant regressed T3 on zhipu — do NOT
 *      adopt that direction without re-running this eval.
 *   2. The `a5b` (negative-list addition) variant ties or slightly improves
 *      `old` across all providers — chosen as the v0.7.28 shipping form.
 *   3. T3 partial (grep-first) is multi-turn dispatch behavior, NOT a regression.
 *      deepseek's scope-first pattern delays dispatch by one turn but produces
 *      the same eventual fan-out (verified by the variance probe text previews).
 *
 * ## Earlier (incorrect) deepseek baseline
 *
 * Earlier runs hit `deepseek-chat` (the deprecated alias slated for 2026-07-24
 * removal) instead of the current default `deepseek-v4-flash`. The deprecated
 * model showed 40% fan-out variance on T1 — a per-model artifact, not a prompt
 * issue. See `tests/dispatch-prompt-deepseek-variance.eval.ts` for the N=5
 * cross-model variance probe.
 */

import { describe, it, expect } from 'vitest';
import { getProvider, type KodaXMessage, type KodaXToolDefinition } from '@kodax/ai';

/* ---------- Provider/model matrix ---------- */

interface ProviderTarget {
  name: string;
  model: string;
  apiKeyEnv: string;
}

const PROVIDERS: ProviderTarget[] = [
  { name: 'zhipu-coding', model: 'glm-5.1', apiKeyEnv: 'ZHIPU_API_KEY' },
  { name: 'minimax-coding', model: 'MiniMax-M2.7', apiKeyEnv: 'MINIMAX_API_KEY' },
  // kimi: KIMI_API_KEY in env returns 401 — endpoint mismatch, skip
  // deepseek: model pinned to current default (v4-flash). Earlier runs used
  // the deprecated `deepseek-chat` alias (slated for 2026-07-24 removal) and
  // saw 40% fan-out variance. Variance probe at
  // tests/dispatch-prompt-deepseek-variance.eval.ts confirmed v4-flash is
  // 100% stable on the same task.
  { name: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
];

/* ---------- Prompt variants ---------- */

const OLD_PROMPT_SECTION = [
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
  'TIMING: decide early. Children\'s findings can inform your downstream decisions. Dispatching after you have already deep-dived is wasted work.',
  'Scope: Scout dispatches are readOnly.',
].join('\n');

// A5b candidate: OLD prompt + an explicit "When NOT to use" negative list
// appended after RULE C. Goal: provide concrete bumpers that the negative
// case (T2-style) lands on without disturbing the RULE A/B/C structure
// that empirical results showed already works.
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

const NEW_PROMPT_SECTION = [
  'PARALLEL CHILD AGENTS — dispatch_child_task delegates an investigation to a child agent with its own context window. Multiple calls in the same response run in parallel; each child\'s findings return as a separate tool result.',
  '',
  'Parallelism is your superpower. When the work splits into independent threads, run them concurrently. Sequential investigation when parallel is possible is wasted wall-clock time and crowds your own context with raw data you don\'t need.',
  '',
  'Default: when you identify N independent non-trivial threads, dispatch N children in the SAME response — one tool call per thread. Do not handle one yourself "to save a child" — that defeats the parallelism. Children also preserve your context: delegate raw-volume investigation (large greps, multi-round search→read→re-search, unfamiliar areas you only need a verdict on) and keep your own context focused on reasoning.',
  '',
  'Do NOT use a child for:',
  '  - Reading a known file path → use read_file directly.',
  '  - Searching for a known symbol like `class Foo` or `function bar` → use grep_files.',
  '  - Looking at 2–3 files you\'ve already identified → parallel read_file calls.',
  '  - Work where you\'ll keep the raw output in context anyway → do it yourself.',
  '',
  'The criterion is qualitative: "Will I need the raw output in my context to reason, or only a summary / list / verdict?" If only a summary, dispatch. "Could these threads make progress in parallel?" If yes, dispatch all of them concurrently.',
  '',
  'Scope: Scout dispatches must be readOnly.',
].join('\n');

function buildSystemPrompt(promptSection: string): string {
  return [
    'You are Scout — the entry role for an adaptive coding agent. Your job is to investigate the user\'s request and produce findings.',
    '',
    'You have these tools available:',
    '  - dispatch_child_task: delegate an investigation to a child agent (see below).',
    '  - read_file: read a specific file path.',
    '  - grep_files: search for a regex/string across files.',
    '  - glob_files: list files matching a glob pattern.',
    '',
    promptSection,
    '',
    'Begin your investigation now. Use tools.',
  ].join('\n');
}

/* ---------- Tool definitions (subset, just for the test) ---------- */

const TOOLS: KodaXToolDefinition[] = [
  {
    name: 'dispatch_child_task',
    description: 'Execute a single child agent for an independent sub-task. The child runs its own multi-turn investigation loop and returns findings. Call multiple times in parallel for concurrent sub-tasks — each call appears as a separate tool with its own status in the transcript.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique child task identifier' },
        objective: { type: 'string', description: 'Detailed multi-step goal for this child agent' },
        readOnly: { type: 'boolean', description: 'true=investigation only (default), false=code changes (Generator only)' },
        scope_summary: { type: 'string', description: 'Optional scope hint (e.g. "packages/ai/src/")' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a specific file from disk by absolute or workspace-relative path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep_files',
    description: 'Search for a regex pattern across files in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'Directory or file scope' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob_files',
    description: 'List files matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
      },
      required: ['pattern'],
    },
  },
];

/* ---------- Test tasks ---------- */

interface TestTask {
  id: string;
  prompt: string;
  expectation: string;
  scoreFirstResponse: (toolNames: string[]) => 'correct' | 'partial' | 'wrong';
}

const TASKS: TestTask[] = [
  {
    id: 'T1',
    prompt: 'Audit three independent packages of this monorepo for security issues: packages/ai, packages/coding, packages/repl. For each package, find any vulnerabilities (input validation gaps, unsafe shell, secret handling, etc). Report findings per-package.',
    expectation: 'parallel fan-out: ≥2 dispatch_child_task calls in same response',
    scoreFirstResponse: (toolNames) => {
      const dispatchCount = toolNames.filter((n) => n === 'dispatch_child_task').length;
      if (dispatchCount >= 2) return 'correct';
      if (dispatchCount === 1) return 'partial';
      return 'wrong';
    },
  },
  {
    id: 'T2',
    prompt: 'Read packages/coding/src/agent.ts and tell me what the runKodaX function does. The file path is exact and known.',
    expectation: 'direct read_file, NO dispatch',
    scoreFirstResponse: (toolNames) => {
      const first = toolNames[0];
      if (first === 'read_file') return 'correct';
      if (first === 'dispatch_child_task') return 'wrong';
      return 'partial';
    },
  },
  {
    id: 'T3',
    prompt: 'Find every caller of the function `runManagedTask` across this codebase and categorize the usage patterns into 2-4 groups. I just want a categorized summary, not the raw code.',
    expectation: '1 dispatch_child_task (context preservation), OR direct grep+read is acceptable',
    scoreFirstResponse: (toolNames) => {
      const dispatchCount = toolNames.filter((n) => n === 'dispatch_child_task').length;
      const hasGrep = toolNames.includes('grep_files');
      if (dispatchCount === 1) return 'correct';
      if (dispatchCount === 0 && hasGrep) return 'partial'; // direct path is acceptable
      if (dispatchCount >= 2) return 'wrong'; // over-fan-out for single thread
      return 'wrong';
    },
  },
];

/* ---------- Eval driver ---------- */

interface RunResult {
  provider: string;
  model: string;
  promptVariant: 'old' | 'new' | 'a5b';
  taskId: string;
  toolNames: string[];
  toolInputs: unknown[];
  textPreview: string;
  score: 'correct' | 'partial' | 'wrong';
  error?: string;
}

async function runOnce(
  target: ProviderTarget,
  variant: 'old' | 'new' | 'a5b',
  task: TestTask,
): Promise<RunResult> {
  const promptSection = variant === 'old'
    ? OLD_PROMPT_SECTION
    : variant === 'a5b'
      ? A5B_PROMPT_SECTION
      : NEW_PROMPT_SECTION;
  const systemPrompt = buildSystemPrompt(promptSection);
  const messages: KodaXMessage[] = [{ role: 'user', content: task.prompt }];

  try {
    const provider = getProvider(target.name as Parameters<typeof getProvider>[0]);
    const result = await provider.stream(messages, TOOLS, systemPrompt, undefined, {
      modelOverride: target.model,
    });
    const toolNames = result.toolBlocks.map((b) => b.name);
    const toolInputs = result.toolBlocks.map((b) => b.input);
    const textPreview = result.textBlocks
      .map((b) => b.text)
      .join('')
      .slice(0, 300)
      .replace(/\s+/g, ' ');
    return {
      provider: target.name,
      model: target.model,
      promptVariant: variant,
      taskId: task.id,
      toolNames,
      toolInputs,
      textPreview,
      score: task.scoreFirstResponse(toolNames),
    };
  } catch (err) {
    return {
      provider: target.name,
      model: target.model,
      promptVariant: variant,
      taskId: task.id,
      toolNames: [],
      toolInputs: [],
      textPreview: '',
      score: 'wrong',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarize(results: RunResult[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('========== RESULTS TABLE ==========');
  lines.push('| Provider          | Variant | T1 fan-out | T2 no-dispatch | T3 single-child |');
  lines.push('|-------------------|---------|------------|----------------|-----------------|');
  const byProvider = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = `${r.provider}__${r.promptVariant}`;
    const arr = byProvider.get(key) ?? [];
    arr.push(r);
    byProvider.set(key, arr);
  }
  for (const [key, arr] of byProvider) {
    const [provider, variant] = key.split('__');
    const t1 = arr.find((r) => r.taskId === 'T1');
    const t2 = arr.find((r) => r.taskId === 'T2');
    const t3 = arr.find((r) => r.taskId === 'T3');
    const cell = (r: RunResult | undefined): string => {
      if (!r) return 'n/a';
      const tools = r.toolNames.length === 0 ? '(none)' : r.toolNames.join(',');
      return `${r.score} [${tools}]`;
    };
    lines.push(
      `| ${provider.padEnd(17)} | ${variant.padEnd(7)} | ${cell(t1).padEnd(10)} | ${cell(t2).padEnd(14)} | ${cell(t3).padEnd(15)} |`,
    );
  }
  lines.push('');
  lines.push('========== DETAILED TEXT PREVIEWS ==========');
  for (const r of results) {
    if (r.textPreview) {
      lines.push(`[${r.provider}/${r.promptVariant}/${r.taskId}] "${r.textPreview}"`);
    }
    if (r.error) {
      lines.push(`[${r.provider}/${r.promptVariant}/${r.taskId}] ERROR: ${r.error}`);
    }
  }
  return lines.join('\n');
}

/* ---------- Test ---------- */

describe('Eval: dispatch_child_task prompt redesign', () => {
  const availableProviders = PROVIDERS.filter((p) => process.env[p.apiKeyEnv]);

  if (availableProviders.length === 0) {
    it('skips: no provider API keys in env', () => {
      console.warn('[eval] No provider API keys found. Set ZHIPU_API_KEY/MINIMAX_API_KEY/KIMI_API_KEY/DEEPSEEK_API_KEY.');
      expect(true).toBe(true);
    });
    return;
  }

  it(
    `runs old vs new prompt across ${availableProviders.length} providers × 3 tasks`,
    async () => {
      console.log('');
      console.log(`[eval] Available providers: ${availableProviders.map((p) => p.name).join(', ')}`);
      console.log(`[eval] Total runs: ${availableProviders.length} × 3 variants × 3 tasks = ${availableProviders.length * 9}`);

      const results: RunResult[] = [];
      for (const target of availableProviders) {
        for (const variant of ['old', 'new', 'a5b'] as const) {
          for (const task of TASKS) {
            console.log(`[eval] running ${target.name} | ${variant} | ${task.id} ...`);
            const r = await runOnce(target, variant, task);
            results.push(r);
            console.log(
              `       → score=${r.score} tools=[${r.toolNames.join(',')}] ${r.error ? 'ERROR=' + r.error : ''}`,
            );
          }
        }
      }

      console.log(summarize(results));

      // No hard assertion — this is exploratory. Just ensure we ran something.
      expect(results.length).toBe(availableProviders.length * 9);
    },
    20 * 60 * 1000, // 20 min timeout for full matrix
  );
});
