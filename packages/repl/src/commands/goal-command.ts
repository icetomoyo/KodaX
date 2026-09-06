/**
 * FEATURE_192 v0.7.44 Phase D — `/goal` slash command.
 *
 * User-facing entry into the persistent goal subsystem. Mirrors
 * Codex `/goal` shape: a single command with subcommands for status
 * management, plus a bare-argument form that creates a new goal.
 *
 * Subcommands:
 *   /goal <objective> [--tokens N]  — create a new goal
 *   /goal status                    — show current goal (alias: /goal)
 *   /goal pause                     — pause an active goal
 *   /goal resume                    — resume a paused goal
 *   /goal clear                     — clear the current goal entirely
 *   /goal help                      — show usage
 *
 * Persistence: FEATURE_298 T34 — when `callbacks.goal` is bound, every
 * mutation and read goes to the Host goal plane (session id + objective
 * only; the Host owns lineage mutation and journal writes, and the local
 * lineage is refreshed from storage afterwards). Unbound, the command
 * mutates `context.lineage` via `appendGoalEntry` from `@kodax-ai/agent`,
 * then calls `callbacks.saveSession()` to flush (standalone capability).
 * When `context.lineage` is undefined (rare — sessions created
 * pre-FEATURE_184), the local path surfaces a clear error rather than
 * silently failing.
 */

import chalk from 'chalk';
import type {
  KodaXGoalEventType,
  KodaXGoalState,
  KodaXSessionLineage,
} from '@kodax-ai/agent';
import {
  appendGoalEntry,
  readLatestGoalState,
} from '@kodax-ai/agent';
import {
  buildCreatedGoal,
  buildPausedGoal,
  buildResumedGoal,
  isValidTokenBudget,
} from '@kodax-ai/coding';

import type { Command, CommandCallbacks } from './types.js';

type GoalContext = { sessionId: string; lineage?: KodaXSessionLineage };
type GoalCallbacks = Pick<CommandCallbacks, 'saveSession' | 'goal' | 'refreshSessionLineage'>;

function printHelp(): void {
  console.log(`
${chalk.bold('/goal')} — persistent session goal

${chalk.bold('Subcommands:')}
  ${chalk.cyan('/goal <objective> [--tokens N]')}  Create a new persistent goal.
  ${chalk.cyan('/goal status')}                    Show current goal (default).
  ${chalk.cyan('/goal pause')}                     Pause an active goal.
  ${chalk.cyan('/goal resume')}                    Resume a paused goal.
  ${chalk.cyan('/goal clear')}                     Clear the current goal.
  ${chalk.cyan('/goal help')}                      Show this help.

${chalk.bold('Notes:')}
  - The agent auto-continues toward an active goal on every Worker turn end.
  - Token budget is optional; set it only when you want a hard ceiling.
  - update_goal({complete}) is verifier-gated; the agent cannot
    self-declare done without runtime confirmation.
`.trim());
}

interface ParsedArgs {
  readonly objective: string;
  readonly tokenBudget: number | null;
}

function parseCreateArgs(args: readonly string[]): ParsedArgs | { readonly error: string } {
  let tokenBudget: number | null = null;
  const objectiveParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--tokens') {
      const next = args[i + 1];
      if (!next) return { error: '--tokens requires a value (e.g. `--tokens 50000`)' };
      const n = Number(next);
      if (!isValidTokenBudget(n)) {
        return { error: '--tokens value must be a positive integer' };
      }
      tokenBudget = n;
      i++;
      continue;
    }
    if (arg.startsWith('--tokens=')) {
      const raw = arg.slice('--tokens='.length);
      const n = Number(raw);
      if (!isValidTokenBudget(n)) {
        return { error: '--tokens value must be a positive integer' };
      }
      tokenBudget = n;
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `unknown flag: ${arg}` };
    }
    objectiveParts.push(arg);
  }
  const objective = objectiveParts.join(' ').trim();
  if (!objective) return { error: 'objective is required' };
  return { objective, tokenBudget };
}

function renderStatus(goal: KodaXGoalState | null): string {
  if (!goal) {
    return chalk.dim('No goal set. Use `/goal <objective>` to create one.');
  }
  const lines: string[] = [
    `${chalk.bold('Goal:')} ${goal.objective}`,
    `${chalk.bold('Status:')} ${goal.status}`,
    `${chalk.bold('Tokens used:')} ${goal.tokensUsed}`,
  ];
  if (goal.tokenBudget !== null) {
    const remaining = Math.max(0, goal.tokenBudget - goal.tokensUsed);
    lines.push(`${chalk.bold('Token budget:')} ${goal.tokenBudget} (remaining ${remaining})`);
  } else {
    lines.push(`${chalk.bold('Token budget:')} ${chalk.dim('none')}`);
  }
  lines.push(`${chalk.bold('Elapsed:')} ${goal.timeUsedSeconds}s`);
  if (goal.status === 'blocked' && goal.lastBlockerKind) {
    lines.push(`${chalk.bold('Blocker:')} ${goal.lastBlockerKind}`);
  }
  return lines.join('\n');
}

async function persist(
  context: GoalContext,
  callbacks: GoalCallbacks,
  goal: KodaXGoalState | null,
  event: KodaXGoalEventType,
): Promise<void> {
  if (!context.lineage) {
    throw new Error(
      'session lineage unavailable — open or start a new session before using /goal',
    );
  }
  context.lineage = appendGoalEntry(context.lineage, goal, event);
  await callbacks.saveSession();
}

/** Host goal state when bound, local lineage state otherwise. */
async function readGoalState(
  context: GoalContext,
  callbacks: GoalCallbacks,
): Promise<KodaXGoalState | null> {
  if (callbacks.goal) return callbacks.goal.read(context.sessionId);
  if (!context.lineage) return null;
  return readLatestGoalState(context.lineage);
}

/** Re-read the lineage the Host just wrote (best effort; keeps the local view coherent). */
async function refreshBoundLineage(
  context: GoalContext,
  callbacks: GoalCallbacks,
): Promise<void> {
  const refreshed = await callbacks.refreshSessionLineage?.();
  if (refreshed) context.lineage = refreshed;
}

async function doCreate(
  args: readonly string[],
  context: GoalContext,
  callbacks: GoalCallbacks,
): Promise<void> {
  const binding = callbacks.goal;
  if (!binding && !context.lineage) {
    console.log(chalk.red('[/goal] no active session lineage'));
    return;
  }
  const existing = await readGoalState(context, callbacks);
  if (existing && existing.status !== 'complete') {
    console.log(
      chalk.yellow(
        `[/goal] a goal is already active (status: ${existing.status}). Clear it first with \`/goal clear\` before creating a new one.`,
      ),
    );
    return;
  }
  const parsed = parseCreateArgs(args);
  if ('error' in parsed) {
    console.log(chalk.red(`[/goal] ${parsed.error}`));
    return;
  }
  try {
    if (binding) {
      // Mirror the local complete → cleared → created transition pair so
      // Host-side lineage consumers see the same explicit sequence.
      if (existing && existing.status === 'complete') {
        await binding.clear(context.sessionId);
      }
      const goal = await binding.create({
        sessionId: context.sessionId,
        objective: parsed.objective,
        ...(parsed.tokenBudget !== null ? { tokenBudget: parsed.tokenBudget } : {}),
      });
      await refreshBoundLineage(context, callbacks);
      console.log(chalk.green(`[/goal] created: "${goal.objective}"`));
      if (goal.tokenBudget !== null) {
        console.log(chalk.dim(`        budget: ${goal.tokenBudget} tokens`));
      }
      return;
    }
    // If the prior goal was 'complete', emit an explicit `cleared` event
    // before the new `created` so downstream consumers always see the
    // transition (complete → cleared → created) instead of a bare
    // (complete → created) sequence. Mirrors how labels treat overwrites
    // as a delete-then-add pair rather than an in-place mutation.
    if (existing && existing.status === 'complete') {
      await persist(context, callbacks, null, 'cleared');
    }
    const goal = buildCreatedGoal(parsed.objective, parsed.tokenBudget);
    await persist(context, callbacks, goal, 'created');
    console.log(chalk.green(`[/goal] created: "${goal.objective}"`));
    if (goal.tokenBudget !== null) {
      console.log(chalk.dim(`        budget: ${goal.tokenBudget} tokens`));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`[/goal] ${msg}`));
  }
}

async function doStatus(context: GoalContext, callbacks: GoalCallbacks): Promise<void> {
  if (!callbacks.goal && !context.lineage) {
    console.log(chalk.red('[/goal] no active session lineage'));
    return;
  }
  const goal = await readGoalState(context, callbacks);
  console.log(renderStatus(goal));
}

async function doPause(
  context: GoalContext,
  callbacks: GoalCallbacks,
): Promise<void> {
  if (!callbacks.goal && !context.lineage) {
    console.log(chalk.red('[/goal] no active session lineage'));
    return;
  }
  const goal = await readGoalState(context, callbacks);
  if (!goal) {
    console.log(chalk.yellow('[/goal] no goal to pause'));
    return;
  }
  if (goal.status !== 'active') {
    console.log(
      chalk.yellow(`[/goal] cannot pause from status '${goal.status}' (only 'active' is pausable)`),
    );
    return;
  }
  if (callbacks.goal) {
    await callbacks.goal.pause(context.sessionId);
    await refreshBoundLineage(context, callbacks);
    console.log(chalk.green('[/goal] paused'));
    return;
  }
  const paused = buildPausedGoal(goal);
  await persist(context, callbacks, paused, 'paused');
  console.log(chalk.green('[/goal] paused'));
}

async function doResume(
  context: GoalContext,
  callbacks: GoalCallbacks,
): Promise<void> {
  if (!callbacks.goal && !context.lineage) {
    console.log(chalk.red('[/goal] no active session lineage'));
    return;
  }
  const goal = await readGoalState(context, callbacks);
  if (!goal) {
    console.log(chalk.yellow('[/goal] no goal to resume'));
    return;
  }
  if (goal.status !== 'paused') {
    console.log(
      chalk.yellow(`[/goal] cannot resume from status '${goal.status}' (only 'paused' is resumable)`),
    );
    return;
  }
  if (callbacks.goal) {
    await callbacks.goal.resume(context.sessionId);
    await refreshBoundLineage(context, callbacks);
    console.log(chalk.green('[/goal] resumed'));
    return;
  }
  const resumed = buildResumedGoal(goal);
  await persist(context, callbacks, resumed, 'resumed');
  console.log(chalk.green('[/goal] resumed'));
}

async function doClear(
  context: GoalContext,
  callbacks: GoalCallbacks,
): Promise<void> {
  if (!callbacks.goal && !context.lineage) {
    console.log(chalk.red('[/goal] no active session lineage'));
    return;
  }
  const goal = await readGoalState(context, callbacks);
  if (!goal) {
    console.log(chalk.yellow('[/goal] no goal to clear'));
    return;
  }
  if (callbacks.goal) {
    await callbacks.goal.clear(context.sessionId);
    await refreshBoundLineage(context, callbacks);
    console.log(chalk.green('[/goal] cleared'));
    return;
  }
  await persist(context, callbacks, null, 'cleared');
  console.log(chalk.green('[/goal] cleared'));
}

export const goalCommand: Command = {
  name: 'goal',
  description: 'Manage a persistent session goal (FEATURE_192)',
  usage: '/goal [<objective> [--tokens N] | status | pause | resume | clear | help]',
  argumentHint: '<objective> | status | pause | resume | clear | help',
  handler: async (args, context, callbacks) => {
    const sub = (args[0] ?? 'status').toLowerCase();
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      printHelp();
      return;
    }
    if (sub === 'status') {
      await doStatus(context, callbacks);
      return;
    }
    if (sub === 'pause') {
      await doPause(context, callbacks);
      return;
    }
    if (sub === 'resume') {
      await doResume(context, callbacks);
      return;
    }
    if (sub === 'clear') {
      await doClear(context, callbacks);
      return;
    }
    // Anything else → create-mode (first arg + rest are the objective).
    await doCreate(args, context, callbacks);
  },
  detailedHelp: printHelp,
};
