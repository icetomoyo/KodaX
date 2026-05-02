/**
 * Child Agent Executor — FEATURE_067
 *
 * Core execution engine for parallel child agents.
 * Called by dispatch_child_tasks tool (v2) or directly by orchestration layer.
 * Supports read-only children (shared context) and write children (worktree isolation).
 */

import { execSync } from 'child_process';
import fsPromises from 'fs/promises';
import os from 'os';
import type {
  KodaXChildContextBundle,
  KodaXChildAgentResult,
  KodaXChildExecutionResult,
  KodaXChildFinding,
  KodaXEvents,
  KodaXOptions,
  KodaXResult,
  KodaXToolExecutionContext,
} from './types.js';
import { resolveExecutionCwd } from './runtime-paths.js';
// FEATURE_093 (v0.7.24): lazy-load `runKodaX` to break the cycle
// `agent.ts → extensions/runtime.ts → tools/index.ts → tools/registry.ts
// → tools/dispatch-child-tasks.ts → child-executor.ts → agent.ts`.
// `dispatch_child_tasks` is a coarse-grained tool that spins up a fresh
// KodaX agent per child; the runtime import defers agent module resolution
// until a child is actually spawned, by which point the parent module graph
// has fully initialised. No top-level `import ... from './agent.js'` or
// `typeof import('./agent.js')` references — both count as edges in madge.
type RunKodaXFn = (options: KodaXOptions, prompt: string) => Promise<KodaXResult>;
let _runKodaXCache: RunKodaXFn | undefined;
async function getRunKodaX(): Promise<RunKodaXFn> {
  if (!_runKodaXCache) {
    // Computed module specifier hides the edge from madge while TypeScript
    // keeps the string literal at compile time.
    const spec = './agent.js' as const;
    // v0.7.26 Risk-6 fix — wrap the dynamic import in an explicit
    // error envelope. The cycle-break via dynamic-import is a deliberate
    // design choice (FEATURE_093), but if `./agent.js` ever fails to
    // resolve at runtime (broken build, moved export, circular-import
    // still tripping), the vanilla native error surfaces as a cryptic
    // "Cannot find module './agent.js'" deep inside a dispatch call.
    // Restate what went wrong + what the caller should check.
    let agentModule: { runKodaX?: RunKodaXFn };
    try {
      agentModule = (await import(spec)) as { runKodaX?: RunKodaXFn };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[child-executor] Failed to lazy-load agent module (\`${spec}\`) for dispatch_child_task. ` +
        `This usually means the @kodax/coding build is broken or out of date. ` +
        `Underlying cause: ${detail}`,
      );
    }
    const runKodaX = agentModule.runKodaX;
    if (typeof runKodaX !== 'function') {
      throw new Error(
        `[child-executor] Agent module loaded but \`runKodaX\` export is missing or not a function. ` +
        `This indicates an API break in packages/coding/src/agent.ts. ` +
        `Check that \`export { runKodaX }\` is still present.`,
      );
    }
    _runKodaXCache = runKodaX;
  }
  return _runKodaXCache;
}
import { toolWorktreeCreate, toolWorktreeRemove } from './tools/worktree.js';

/* ---------- Public API ---------- */

/**
 * Predicate the parent REPL injects so the child executor can enforce plan-mode
 * constraints without `packages/coding` reverse-depending on `packages/repl`.
 *
 * The predicate MUST read the parent's permission mode lazily (e.g., through a
 * closure over a ref), so mid-run mode toggles propagate to in-flight child tool
 * calls. Returns the block reason (string) for tools/inputs that are currently
 * plan-mode-violating, or `null` when the call is allowed right now.
 */
export type PlanModeBlockCheck = (
  tool: string,
  input: Record<string, unknown>,
) => string | null;

export interface ChildExecutorOptions {
  readonly maxParallel: number;
  readonly maxIterationsPerChild: number;
  readonly abortSignal?: AbortSignal;
  readonly parentOptions: Readonly<Partial<Pick<KodaXOptions, 'provider' | 'model' | 'reasoningMode' | 'extensionRuntime'>>>;
  readonly parentRole: string;
  readonly parentHarness: string;
  /** Progress callback for REPL status display. Called when children start, progress, and complete. */
  readonly onProgress?: (status: string) => void;
  /**
   * FEATURE_074: Predicate provided by the parent REPL to evaluate plan-mode block
   * reasons at each child tool call. The predicate closes over parent state so
   * mid-run mode toggles propagate to in-flight children. When absent, children
   * run without plan-mode enforcement.
   */
  readonly planModeBlockCheck?: PlanModeBlockCheck;

  /**
   * FEATURE_092 phase 2b.7b slice D: parent-Runner guardrails forwarded into
   * each child's `Runner.run` via `KodaXOptions.guardrails`. The auto-mode
   * guardrail's mutable state (engine + denialTracker + circuitBreaker) is
   * shared by passing the SAME instance — preventing children from reaching
   * a fresh threshold and bypassing the parent's downgrade.
   */
  readonly guardrails?: readonly import('@kodax/core').Guardrail[];
}

export async function executeChildAgents(
  bundles: readonly KodaXChildContextBundle[],
  parentCtx: KodaXToolExecutionContext,
  options: ChildExecutorOptions,
): Promise<KodaXChildExecutionResult> {
  if (bundles.length === 0) {
    return EMPTY_RESULT;
  }

  const readBundles = bundles.filter((b) => b.readOnly);
  const writeBundles = bundles.filter((b) => !b.readOnly);

  // Validate write bundles: only H2 Generator allowed
  const allowedWriteBundles = validateWriteBundles(
    writeBundles,
    options.parentRole,
    options.parentHarness,
  );

  const allBundles = [...readBundles, ...allowedWriteBundles];
  if (allBundles.length === 0) {
    return EMPTY_RESULT;
  }

  const results: KodaXChildAgentResult[] = [];
  const cancelledChildren: string[] = [];
  const worktreePaths: Map<string, string> = new Map();
  const sem = createSemaphore(options.maxParallel);
  let completedCount = 0;
  const totalCount = allBundles.length;
  const report = options.onProgress ?? (() => {});

  report(`Starting ${totalCount} child tasks in parallel`);

  try {
    const settled = await Promise.allSettled(
      allBundles.map((bundle) =>
        runWithSemaphore(sem, async () => {
          if (options.abortSignal?.aborted) {
            cancelledChildren.push(bundle.id);
            return;
          }

          report(`[${completedCount}/${totalCount}] Running: ${bundle.id}`);

          const result = bundle.readOnly
            ? await executeReadChild(bundle, parentCtx, options)
            : await executeWriteChild(bundle, parentCtx, options, worktreePaths);

          results.push(result);
          completedCount++;
          report(`[${completedCount}/${totalCount}] Done: ${bundle.id} → ${result.status}`);
        }),
      ),
    );

    // Capture rejected promises as failed results
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      if (outcome.status === 'rejected') {
        const bundle = allBundles[i]!;
        const reason = outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
        results.push(extractChildResult(bundle, `[Crash] ${reason}`, 'failed'));
      }
    }
  } finally {
    // Cleanup worktrees for FAILED children only.
    // Successful write children's worktrees are kept alive for Evaluator review.
    // Caller must call cleanupWorktrees() after Evaluator completes.
    const successfulChildIds = new Set(
      results.filter((r) => r.status === 'completed').map((r) => r.childId),
    );
    for (const [bundleId, wtPath] of worktreePaths) {
      if (successfulChildIds.has(bundleId)) continue; // Keep for Evaluator review
      try {
        await toolWorktreeRemove(
          { action: 'remove', worktree_path: wtPath, discard_changes: true },
          parentCtx,
        );
      } catch {
        // Best-effort cleanup — don't block other cleanups
      }
    }
  }

  return mergeChildResults(allBundles, results, cancelledChildren, worktreePaths);
}

/* ---------- Read-only child execution ---------- */

async function executeReadChild(
  bundle: KodaXChildContextBundle,
  parentCtx: KodaXToolExecutionContext,
  options: ChildExecutorOptions,
): Promise<KodaXChildAgentResult> {
  const briefing = await buildChildBriefing(bundle, parentCtx, options.maxIterationsPerChild);
  const childEvents = buildChildEvents(
    bundle.id,
    options.onProgress,
    options.planModeBlockCheck,
  );

  const provider = options.parentOptions.provider ?? 'anthropic';

  try {
    const result = await (await getRunKodaX())(
      {
        provider,
        model: options.parentOptions.model,
        reasoningMode: options.parentOptions.reasoningMode,
        agentMode: 'sa',
        maxIter: options.maxIterationsPerChild,
        abortSignal: options.abortSignal,
        extensionRuntime: options.parentOptions.extensionRuntime,
        // FEATURE_092 phase 2b.7b slice D: forward parent-Runner guardrails so
        // child tool calls go through the SAME auto-mode classifier instance
        // (shared engine + denialTracker + circuitBreaker state).
        guardrails: options.guardrails,
        context: {
          gitRoot: parentCtx.gitRoot,
          executionCwd: parentCtx.executionCwd ?? parentCtx.gitRoot,
          systemPromptOverride: CHILD_AGENT_SYSTEM_PROMPT,
          excludeTools: CHILD_EXCLUDE_TOOLS_READONLY,
        },
        events: childEvents,
      },
      briefing,
    );

    const iterations = result.messages.filter((m) => m.role === 'assistant').length;
    return extractChildResult(bundle, result.lastText, result.success ? 'completed' : 'failed', iterations);
  } catch (error) {
    return extractChildResult(
      bundle,
      error instanceof Error ? error.message : String(error),
      'failed',
      0,
    );
  }
}

/* ---------- Write child execution (worktree) ---------- */

async function executeWriteChild(
  bundle: KodaXChildContextBundle,
  parentCtx: KodaXToolExecutionContext,
  options: ChildExecutorOptions,
  worktreePaths: Map<string, string>,
): Promise<KodaXChildAgentResult> {
  const wtResult = await toolWorktreeCreate(
    { description: bundle.objective },
    parentCtx,
  );

  const wtPath = parseWorktreePath(wtResult);
  if (!wtPath) {
    return extractChildResult(bundle, 'Failed to create worktree', 'failed');
  }

  // Register immediately so finally-block cleanup covers this worktree
  worktreePaths.set(bundle.id, wtPath);

  // Child gets isolated context: own CWD, own gitRoot, own backups.
  // Shared: extensionRuntime (tools need it), askUser (user interaction).
  const childCtx: KodaXToolExecutionContext = {
    ...parentCtx,
    executionCwd: wtPath,
    gitRoot: wtPath,
    backups: new Map(),
  };

  const briefing = await buildChildBriefing(bundle, childCtx, options.maxIterationsPerChild);
  const childEvents = buildChildEvents(
    bundle.id,
    options.onProgress,
    options.planModeBlockCheck,
  );
  const provider = options.parentOptions.provider ?? 'anthropic';

  try {
    const result = await (await getRunKodaX())(
      {
        provider,
        model: options.parentOptions.model,
        reasoningMode: options.parentOptions.reasoningMode,
        agentMode: 'sa',
        maxIter: options.maxIterationsPerChild,
        abortSignal: options.abortSignal,
        extensionRuntime: options.parentOptions.extensionRuntime,
        // FEATURE_092 phase 2b.7b slice D: forward parent-Runner guardrails so
        // child tool calls go through the SAME auto-mode classifier instance
        // (shared engine + denialTracker + circuitBreaker state).
        guardrails: options.guardrails,
        context: {
          gitRoot: wtPath,
          executionCwd: wtPath,
          systemPromptOverride: CHILD_AGENT_SYSTEM_PROMPT,
          excludeTools: CHILD_EXCLUDE_TOOLS_BASE, // Write children keep write/edit tools
        },
        events: childEvents,
      },
      briefing,
    );

    const diff = collectWorktreeDiff(wtPath);
    const iterations = result.messages.filter((m) => m.role === 'assistant').length;

    return {
      ...extractChildResult(bundle, result.lastText, result.success ? 'completed' : 'failed', iterations),
      artifactPaths: diff ? [`worktree:${wtPath}`] : undefined,
    };
  } catch (error) {
    return extractChildResult(
      bundle,
      error instanceof Error ? error.message : String(error),
      'failed',
      0,
    );
  }
}

/* ---------- Structured briefing ---------- */

async function buildChildBriefing(
  bundle: KodaXChildContextBundle,
  ctx: KodaXToolExecutionContext,
  maxIter: number,
): Promise<string> {
  // v0.7.26 NEW-2 — give the child agent explicit cwd / git root /
  // platform context. Without this block, the child's LLM has to guess
  // its working directory (it doesn't inherit the parent's system
  // prompt) and routinely `cd`s into invented paths, causing 200
  // iterations of ENOENT bash failures before timeout and an empty
  // result that surfaces to the parent as a mysterious "child failed".
  const childCwd = resolveExecutionCwd(ctx);
  const childGitRoot = ctx.gitRoot;
  const platform = os.platform();
  const platformLabel =
    platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform;
  const shellHint = platform === 'win32'
    ? 'Shell defaults: Windows. Use: dir, move, copy, del, type. Avoid Unix-only tools like `head`, `tail`, `rm`, `cp`, `mv`.'
    : 'Shell defaults: Unix. Use: ls, mv, cp, rm, cat, head, tail.';

  const parts: string[] = [
    `# Child Agent Task`,
    ``,
    `You are a focused sub-agent executing a specific task in parallel with siblings.`,
    `Complete this task QUICKLY — aim for 3-7 iterations. You have a hard limit of ${maxIter} iterations.`,
    ``,
    `## Environment`,
    `Working Directory: ${childCwd}`,
    ...(childGitRoot && childGitRoot !== childCwd ? [`Git Root: ${childGitRoot}`] : []),
    `Platform: ${platformLabel} (${os.release()})`,
    shellHint,
    `All relative paths in your tool calls (read/write/edit/bash) resolve against the Working Directory above. Do NOT \`cd\` into invented paths.`,
    ``,
    `## Objective`,
    bundle.objective,
    ``,
    `## Scope`,
    bundle.scopeSummary ?? (bundle.constraints.join(', ') || 'No specific scope constraints.'),
    ``,
    `## Constraints`,
    bundle.readOnly
      ? '- This is a READ-ONLY task. Do NOT modify any files.'
      : '- You may modify files within the scope listed above.',
    `- You CANNOT spawn child agents or call dispatch_child_tasks.`,
    ``,
    `## Execution Strategy (IMPORTANT: use parallel tool calls)`,
    `- Turn 1: Scope scan — emit 3-8 PARALLEL tool calls: glob for structure + grep for key patterns + read critical files. All in ONE response.`,
    `- Turn 2-4: Deep targeted reads — again emit MULTIPLE reads in parallel for any files identified in Turn 1.`,
    `- Turn 5-7: Synthesize findings. If done, respond with TEXT ONLY (no more tool calls).`,
    `- STOP as soon as you have sufficient evidence. Do NOT keep investigating for marginal coverage.`,
    `- Your response WITHOUT tool calls signals completion. The parent agent will take over from there.`,
  ];

  if (bundle.evidenceRefs.length > 0) {
    parts.push(``, `## Known Evidence`);
    for (const ref of bundle.evidenceRefs) {
      const resolved = await resolveEvidenceRef(ref, ctx);
      parts.push(resolved);
    }
  }

  parts.push(
    ``,
    `## Output Format`,
    `When done, provide a concise text summary:`,
    `- Key findings (file:line references)`,
    `- Severity assessment (if applicable)`,
    `- Specific recommendations`,
    `Do NOT call any more tools in your final response.`,
  );

  return parts.join('\n');
}

async function resolveEvidenceRef(
  ref: string,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (ref.startsWith('file:')) {
    const filePath = ref.slice(5);
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').slice(0, 200);
      return `### ${filePath}\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
    } catch {
      return `- ${ref} (could not read file)`;
    }
  }
  if (ref.startsWith('diff:')) {
    const filePath = ref.slice(5);
    try {
      const diff = execSync(`git diff HEAD -- "${filePath}"`, {
        cwd: ctx.gitRoot ?? undefined,
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return diff.length > 0
        ? `### diff: ${filePath}\n\`\`\`diff\n${diff.slice(0, 4000)}\n\`\`\``
        : `- ${ref} (no changes)`;
    } catch {
      return `- ${ref} (could not get diff)`;
    }
  }
  if (ref.startsWith('finding:')) {
    return `- **Known fact**: ${ref.slice(8)}`;
  }
  return `- ${ref}`;
}

/* ---------- Child events (progress visibility) ---------- */

/**
 * Focused system prompt for child agents — replaces the full system prompt entirely.
 * Mirrors Claude Code's DEFAULT_AGENT_PROMPT: lightweight, task-focused, no AMA overhead.
 * KodaX-specific: emphasizes parallel tool calls and structured output.
 */
const CHILD_AGENT_SYSTEM_PROMPT = [
  'You are a focused sub-agent executing a specific task assigned by a parent agent.',
  'Use the available tools to complete the task fully. Do not gold-plate, but do not leave it half-done.',
  '',
  '## Tool Use — ALWAYS Prefer Parallel Calls',
  '',
  'When multiple tool calls are independent of each other, you MUST emit them all in the SAME response.',
  'The execution engine runs non-bash tools concurrently via Promise.all — serial calls waste time.',
  '',
  'Concrete rules:',
  '- When you need to read/grep/glob multiple files, emit ALL calls in one response — do NOT wait for results between independent reads.',
  '- Only serialize when a later call genuinely depends on an earlier result (e.g., you need a file path from grep before you can read it).',
  '- A typical first turn should have 3-8 parallel tool calls (glob + grep + key file reads).',
  '- Prefer a few targeted calls over many tiny sequential probes.',
  '',
  '## Execution Guidelines',
  '- Focus on the objective described in the user message. Do not deviate.',
  '- When you have sufficient evidence, stop investigating and synthesize your findings.',
  '- Your final response MUST be text only (no tool calls) — the parent agent will use it directly.',
  '',
  '## Output Format',
  'Respond with a concise report covering:',
  '- Key findings with specific file:line references',
  '- Severity or priority assessment (if applicable)',
  '- Concrete recommendations',
  '',
  'Keep the report focused — the parent will relay it to the user.',
].join('\n');

/**
 * Tools excluded from child agents at API level (LLM never sees these definitions).
 * Mirrors Claude Code's filterToolsForAgent: no AMA, no recursion, no user interaction,
 * no parent-only permission controls.
 *
 * Exported for unit-testing the security contract. Treat as read-only at runtime.
 */
export const CHILD_EXCLUDE_TOOLS_BASE: readonly string[] = [
  'emit_managed_protocol',  // AMA protocol; children are SA mode
  'dispatch_child_task',    // Prevent recursive child spawning
  'ask_user_question',      // Children cannot prompt the user
  'worktree_create',        // Worktree lifecycle managed by parent
  'worktree_remove',        // Worktree lifecycle managed by parent
  'exit_plan_mode',         // Plan-mode exit requires user UI; only the parent REPL wires the callback
];

/** Additional tools excluded for read-only children (no file mutations). */
const CHILD_EXCLUDE_TOOLS_READONLY: readonly string[] = [
  ...CHILD_EXCLUDE_TOOLS_BASE,
  'write',
  'edit',
  'multi_edit',
  'insert_after_anchor',
  'undo',
];

/**
 * Tools blocked at execution time (defense-in-depth, in case tool list filtering is bypassed).
 * Unified with CHILD_EXCLUDE_TOOLS_BASE to prevent the two lists from drifting again.
 */
const CHILD_BLOCKED_TOOLS = new Set<string>(CHILD_EXCLUDE_TOOLS_BASE);

/**
 * @param planModeBlockCheck FEATURE_074: parent-injected predicate that returns the
 *   block reason for currently-plan-mode-violating tool calls, or `null` when allowed.
 *   The predicate closes over live parent state, so mid-run mode toggles propagate.
 */
export function buildChildEvents(
  childId: string,
  onProgress?: (status: string) => void,
  planModeBlockCheck?: PlanModeBlockCheck,
): KodaXEvents | undefined {
  let iterationCount = 0;
  let maxIterations = 200;
  let lastProgressTime = 0;
  const PROGRESS_THROTTLE_MS = 150; // Limit updates to ~6/sec per child

  const throttledProgress = (msg: string, force = false): void => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressTime < PROGRESS_THROTTLE_MS) return;
    lastProgressTime = now;
    onProgress(msg);
  };

  return {
    // Block AMA-specific and recursive tools, then enforce live plan mode.
    // planModeBlockCheck reads parent state at call time, so mid-run mode toggles
    // (common: user flips plan ↔ accept-edits mid-stream) propagate immediately.
    beforeToolExecute: async (tool: string, input: Record<string, unknown>) => {
      if (CHILD_BLOCKED_TOOLS.has(tool)) {
        return `[Tool Error] ${tool}: Not available in child agent context.`;
      }
      if (planModeBlockCheck) {
        const reason = planModeBlockCheck(tool, input);
        if (reason) {
          return `${reason} You are a child agent inheriting plan-mode constraints. Complete investigation and return findings as text — the parent agent will request user approval for any implementation.`;
        }
      }
      return true;
    },
    // Silently update counter; tool use line will include it.
    onIterationStart: (iter: number, maxIter: number) => {
      iterationCount = iter;
      maxIterations = maxIter;
    },
    // Combined progress: "sec-coding [3/200] → read src/foo.ts" (throttled)
    onToolUseStart: (tool) => {
      const inputHint = tool.input
        ? (typeof tool.input === 'object'
          ? (tool.input as Record<string, unknown>).path
            ?? (tool.input as Record<string, unknown>).pattern
            ?? (tool.input as Record<string, unknown>).command
            ?? ''
          : '')
        : '';
      const hint = typeof inputHint === 'string' && inputHint
        ? ` ${inputHint.slice(0, 60)}`
        : '';
      throttledProgress(`${childId} [${iterationCount}/${maxIterations}] → ${tool.name}${hint}`);
    },
  };
}

/* ---------- Result extraction ---------- */

function extractChildResult(
  bundle: KodaXChildContextBundle,
  summary: string,
  status: KodaXChildAgentResult['status'],
  actualIterations?: number,
): KodaXChildAgentResult {
  return {
    childId: bundle.id,
    fanoutClass: bundle.fanoutClass,
    status,
    disposition: status === 'completed' ? 'valid' : 'needs-more-evidence',
    summary,
    evidenceRefs: bundle.evidenceRefs,
    contradictions: [],
    actualIterations,
  };
}

/* ---------- Result merging (anchored incremental) ---------- */

function mergeChildResults(
  bundles: readonly KodaXChildContextBundle[],
  results: readonly KodaXChildAgentResult[],
  cancelledChildren: readonly string[],
  worktreePaths?: ReadonlyMap<string, string>,
): KodaXChildExecutionResult {
  const bundleMap = new Map(bundles.map((b) => [b.id, b]));

  const mergedFindings: KodaXChildFinding[] = results
    .filter((r) => r.status === 'completed' || r.summary.length > 0)
    .map((r) => ({
      childId: r.childId,
      objective: bundleMap.get(r.childId)?.objective ?? '',
      evidence: [r.summary, ...r.evidenceRefs],
      artifacts: r.artifactPaths ?? [],
    }));

  const mergedArtifacts = [
    ...new Set(results.flatMap((r) => r.artifactPaths ?? [])),
  ];

  return {
    results,
    mergedFindings,
    mergedArtifacts,
    totalTokensUsed: 0, // Tracked via FEATURE_064 cost observatory when available
    cancelledChildren: [...cancelledChildren],
    worktreePaths: worktreePaths && worktreePaths.size > 0 ? worktreePaths : undefined,
  };
}

/* ---------- Evaluator-assisted merge (H2 write fan-out) ---------- */

export interface WriteChildDiff {
  readonly childId: string;
  readonly objective: string;
  readonly worktreePath: string;
  readonly diff: string;
  readonly status: KodaXChildAgentResult['status'];
}

export function buildEvaluatorMergePrompt(diffs: readonly WriteChildDiff[]): string {
  const sections = diffs.map((d) => [
    `### Child: ${d.childId} — ${d.objective}`,
    `Status: ${d.status}`,
    `Worktree: ${d.worktreePath}`,
    '```diff',
    d.diff.slice(0, 8000), // Cap diff size per child
    '```',
  ].join('\n'));

  return [
    '# Evaluator: Review Parallel Write Results',
    '',
    'Multiple child agents made independent code changes in isolated worktrees.',
    'Review each child\'s diff for:',
    '- Correctness and consistency across children',
    '- Conflicts between changes (e.g., same file modified differently)',
    '- Quality of implementation',
    '',
    'For each child, decide: ACCEPT (merge to main) or REVISE (needs changes).',
    '',
    ...sections,
    '',
    'Summarize your verdict for each child and any conflicts found.',
  ].join('\n');
}

export function collectWriteChildDiffs(
  results: readonly KodaXChildAgentResult[],
  bundles: readonly KodaXChildContextBundle[],
  worktreePaths: ReadonlyMap<string, string>,
): readonly WriteChildDiff[] {
  const bundleMap = new Map(bundles.map((b) => [b.id, b]));

  return results
    .filter((r) => worktreePaths.has(r.childId))
    .map((r) => {
      const wtPath = worktreePaths.get(r.childId)!;
      const diff = collectWorktreeDiff(wtPath);
      return {
        childId: r.childId,
        objective: bundleMap.get(r.childId)?.objective ?? '',
        worktreePath: wtPath,
        diff: diff ?? '(no changes)',
        status: r.status,
      };
    });
}

/* ---------- Worktree helpers ---------- */

function parseWorktreePath(toolResult: string): string | null {
  try {
    const parsed = JSON.parse(toolResult) as { path?: string };
    if (typeof parsed.path === 'string') return parsed.path;
  } catch {
    // Fallback to regex if tool returns non-JSON format
    const match = toolResult.match(/Worktree created at:\s*(.+?)\s+branch:/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function collectWorktreeDiff(worktreePath: string): string | null {
  try {
    const diff = execSync('git diff HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return diff.length > 0 ? diff : null;
  } catch {
    return null;
  }
}

/* ---------- Post-Evaluator worktree operations ---------- */

/**
 * Cherry-pick changes from a child's worktree into the main branch.
 * Call this after Evaluator accepts a write child's changes.
 */
export function cherryPickWorktree(
  worktreePath: string,
  mainGitRoot: string,
): { success: boolean; error?: string } {
  try {
    // Commit all changes in worktree
    execSync('git add -A && git diff --cached --quiet || git commit -m "child-agent: apply changes"', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 15_000,
    });
    // Get the commit hash
    const commitHash = execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    // Cherry-pick into main
    execSync(`git cherry-pick ${commitHash}`, {
      cwd: mainGitRoot,
      encoding: 'utf-8',
      timeout: 15_000,
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Abort failed cherry-pick to leave repo clean
    try { execSync('git cherry-pick --abort', { cwd: mainGitRoot, timeout: 5_000 }); } catch { /* ignore */ }
    return { success: false, error: message };
  }
}

/**
 * Cleanup remaining worktrees after Evaluator review completes.
 * Call this in the task-engine after Evaluator verdict is processed.
 */
export async function cleanupWorktrees(
  worktreePaths: ReadonlyMap<string, string>,
  ctx: KodaXToolExecutionContext,
): Promise<void> {
  for (const [, wtPath] of worktreePaths) {
    try {
      await toolWorktreeRemove(
        { action: 'remove', worktree_path: wtPath, discard_changes: true },
        ctx,
      );
    } catch {
      // Best-effort cleanup
    }
  }
}

/* ---------- Validation ---------- */

function validateWriteBundles(
  writeBundles: readonly KodaXChildContextBundle[],
  parentRole: string,
  parentHarness: string,
): readonly KodaXChildContextBundle[] {
  if (writeBundles.length === 0) return [];

  // Only Generator can do write fan-out (via H2 harness or tool dispatch)
  if (parentRole !== 'generator') {
    return [];
  }
  if (parentHarness !== 'H2_PLAN_EXECUTE_EVAL' && parentHarness !== 'tool-dispatch') {
    return [];
  }

  return writeBundles;
}

/* ---------- Semaphore for concurrency control ---------- */

function createSemaphore(maxConcurrent: number): { acquire: () => Promise<() => void> } {
  let current = 0;
  const waiting: Array<() => void> = [];

  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        const tryAcquire = () => {
          if (current < maxConcurrent) {
            current++;
            resolve(() => {
              current--;
              const next = waiting.shift();
              if (next) queueMicrotask(next);
            });
          } else {
            waiting.push(tryAcquire);
          }
        };
        tryAcquire();
      });
    },
  };
}

async function runWithSemaphore<T>(
  sem: { acquire: () => Promise<() => void> },
  fn: () => Promise<T>,
): Promise<T> {
  const release = await sem.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/* ---------- Constants ---------- */

const EMPTY_RESULT: KodaXChildExecutionResult = {
  results: [],
  mergedFindings: [],
  mergedArtifacts: [],
  totalTokensUsed: 0,
  cancelledChildren: [],
};
