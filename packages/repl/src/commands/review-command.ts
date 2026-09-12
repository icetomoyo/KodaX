import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import chalk from 'chalk';
import { writeReviewPackets, type ReviewPacketMetadata } from '@kodax-ai/coding';

import { clientCommandResult, type Command } from './types.js';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 100_000;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function detectBaseBranch(cwd: string): Promise<string> {
  for (const branch of ['main', 'master', 'develop']) {
    try {
      await git(['rev-parse', '--verify', branch], cwd);
      return branch;
    } catch {
      // Try the next candidate.
    }
  }
  return 'HEAD';
}

interface CapturedReviewDiff {
  readonly diff: string;
  readonly label: string;
  readonly scope: 'all' | 'compare' | 'commit';
  readonly baseRef?: string;
  readonly headRef?: string;
}

async function resolveRef(ref: string, cwd: string): Promise<string> {
  return (await git(['rev-parse', ref], cwd)).trim();
}

async function tryResolveRef(ref: string, cwd: string): Promise<string | undefined> {
  try {
    return await resolveRef(ref, cwd);
  } catch {
    return undefined;
  }
}

async function getDiff(args: readonly string[], cwd: string): Promise<CapturedReviewDiff> {
  const sub = args[0];
  if (sub === 'base') {
    const base = await detectBaseBranch(cwd);
    return {
      diff: await git(['diff', `${base}...HEAD`], cwd),
      label: `changes against ${base}`,
      scope: 'compare',
      baseRef: await resolveRef(base, cwd),
      headRef: await resolveRef('HEAD', cwd),
    };
  }
  if (sub === 'sha' && args[1]) {
    const baseRef = await tryResolveRef(`${args[1]}^`, cwd);
    return {
      diff: await git(['show', args[1]], cwd),
      label: `commit ${args[1]}`,
      scope: 'commit',
      ...(baseRef ? { baseRef } : {}),
      headRef: await resolveRef(args[1], cwd),
    };
  }
  if (sub === 'sha') {
    throw new Error('missing commit hash for sha scope; use /review sha <hash>');
  }
  return {
    diff: await git(['diff', 'HEAD'], cwd),
    label: 'uncommitted changes',
    scope: 'all',
    headRef: await resolveRef('HEAD', cwd),
  };
}

export interface ReviewInvocation {
  readonly workflow: boolean;
  readonly lean: boolean;
  readonly diffArgs: string[];
  readonly prompt?: string;
  readonly error?: string;
}

export function parseReviewInvocation(args: readonly string[]): ReviewInvocation {
  let workflow = false;
  let lean = false;
  let scopeConsumed = false;
  let promptMode = false;
  const diffArgs: string[] = [];
  const promptArgs: string[] = [];

  const applyModeArg = (arg: string): boolean => {
    if (arg === '--workflow' || arg === 'workflow') {
      workflow = true;
      return true;
    }
    if (arg === '--lean' || arg === 'lean') {
      lean = true;
      return true;
    }
    return false;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }

    if (promptMode) {
      promptArgs.push(arg);
      continue;
    }

    if (arg === '--') {
      promptMode = true;
      continue;
    }

    if (applyModeArg(arg)) {
      continue;
    }

    if (!scopeConsumed && arg === 'base') {
      diffArgs.push('base');
      scopeConsumed = true;
      continue;
    }

    if (!scopeConsumed && arg === 'sha') {
      diffArgs.push('sha');
      scopeConsumed = true;
      while (i + 1 < args.length) {
        const next = args[i + 1];
        if (next === undefined) {
          break;
        }
        if (next === '--') {
          promptMode = true;
          i += 1;
          break;
        }
        if (applyModeArg(next)) {
          i += 1;
          continue;
        }
        diffArgs.push(next);
        i += 1;
        break;
      }
      continue;
    }

    promptArgs.push(arg);
  }

  const prompt = promptArgs.join(' ').trim();
  const error = diffArgs[0] === 'sha' && !diffArgs[1]
    ? 'missing commit hash for sha scope; use /review sha <hash>'
    : undefined;
  return {
    workflow,
    lean,
    diffArgs,
    prompt: prompt.length > 0 ? prompt : undefined,
    ...(error ? { error } : {}),
  };
}

export interface ReviewWorkflowRequestOptions {
  readonly lean?: boolean;
  readonly customPrompt?: string;
  readonly packets?: readonly ReviewPacketMetadata[];
}

export function buildReviewWorkflowRequest(
  label: string,
  options: ReviewWorkflowRequestOptions = {},
): string {
  const lines = [
    `Review ${label} with KodaX's built-in scoped-review workflow.`,
    'Use the captured immutable review packets as the sole review input.',
    'The built-in gives each ordinary packet one primary with both specVerdict and qualityVerdict, adds a second primary only for routing-high, sends only candidate findings to a fresh independent verifier, and performs capable final synthesis.',
    'Final output must lead with verified findings, cite files or diff hunks, and state when no issues are found.',
  ];

  if (options.lean === true) {
    lines.splice(
      2,
      0,
      'Add one lean/minimal-diff reviewer: find code that can be deleted or replaced by existing repo code, stdlib/native platform features, or already-installed dependencies.',
      'Lean review must not recommend cutting trust-boundary validation, security checks, data-loss protection, accessibility basics, or explicitly requested behavior.',
    );
  }

  if (options.customPrompt) {
    lines.push(`User review focus: ${options.customPrompt}`);
  }

  if (options.packets && options.packets.length > 0) {
    lines.push(
      `Captured packets: ${options.packets.length}.`,
      'Do not call changed_scope or recapture Git: these packets are the sole immutable review input.',
    );
  }

  return lines.join('\n');
}

export interface BuildReviewPromptOptions {
  readonly label: string;
  readonly diff: string;
  readonly lean?: boolean;
  readonly customPrompt?: string;
}

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) {
    return diff;
  }
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated to ${MAX_DIFF_CHARS} chars - review the rest with a narrower scope]`;
}

export function buildReviewPrompt(options: BuildReviewPromptOptions): string {
  const body = truncateDiff(options.diff);
  const lines = [
    `Review the following ${options.label} as a third-party reviewer (not the author).`,
    'Look for bugs (logic errors, null/undefined handling, off-by-one, races),',
    'security (injection, secret exposure, auth bypass), performance hotpaths,',
    'and design (over-engineering vs missing abstraction).',
    'Cite specific diff lines. For each finding, note whether it is verifiable by',
    'tsc / lint / test / build. If the diff is small or risk-free, say so briefly.',
  ];

  if (options.lean === true) {
    lines.push(
      '',
      'Lean pass:',
      '- After correctness/security findings, look for unnecessary code introduced by the diff.',
      '- Prefer deletion or replacement with existing repo code, stdlib/native platform features, or already-installed dependencies when that is verifiably simpler.',
      '- Do not recommend cutting trust-boundary validation, security checks, data-loss protection, accessibility basics, or explicitly requested behavior.',
      '- For each lean suggestion, say what was skipped or can be removed, and when it should be added back.',
    );
  }

  if (options.customPrompt) {
    lines.push('', `User review focus: ${options.customPrompt}`);
  }

  lines.push('', '```diff', body, '```');
  return lines.join('\n');
}

export function buildDisplayName(invocation: ReviewInvocation): string {
  const flags = [
    invocation.workflow ? '--workflow' : undefined,
    invocation.lean ? '--lean' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  return flags.length > 0 ? `/review ${flags.join(' ')}` : '/review';
}

function printReviewHelp(): void {
  console.log(chalk.bold('\n/review - Review Git Changes\n'));
  console.log('Usage:');
  console.log(chalk.cyan('  /review [--lean] [--workflow] [base | sha <hash>] [prompt...]'));
  console.log();
  console.log('Scopes:');
  console.log(chalk.dim('  default       ') + 'Review uncommitted changes against HEAD');
  console.log(chalk.dim('  base          ') + 'Review changes against the detected base branch');
  console.log(chalk.dim('  sha <hash>    ') + 'Review a specific commit');
  console.log();
  console.log('Options:');
  console.log(chalk.dim('  --lean        ') + 'Add a minimal-diff/YAGNI review pass');
  console.log(chalk.dim('  --workflow    ') + 'Run the deterministic scoped-review workflow');
  console.log();
  console.log('Examples:');
  console.log(chalk.dim('  /review --lean'));
  console.log(chalk.dim('  /review base focus on auth and data loss'));
  console.log(chalk.dim('  /review sha abc123 --lean -- check for native platform replacements'));
}

export const reviewCommand: Command = {
  name: 'review',
  description: 'Review git changes for bugs, security, performance, design, and optional lean diffs',
  usage: '/review [--lean] [--workflow] [base | sha <hash>] [prompt...]',
  argumentHint: '[--lean] [--workflow] [base | sha <hash>] [prompt...]',
  detailedHelp: printReviewHelp,
  handler: async (args, context, callbacks) => {
    if (callbacks?.startReview) {
      const result = await callbacks.startReview({ sessionId: context.sessionId, inputId: randomUUID(), args });
      return clientCommandResult(result);
    }
    const cwd = context.gitRoot ?? process.cwd();
    // FEATURE_298 T37 — with a Host binding the git capture and packet
    // writing happen Host-side; the client sends only the parsed flags.
    const reviewBinding = callbacks?.prepareReview;
    if (reviewBinding !== undefined) {
      const prepared = await reviewBinding.prepare({
        projectRoot: cwd,
        sessionId: context.sessionId,
        args,
      });
      if (prepared.kind === 'prepared') {
        return { success: true, invocation: prepared.invocation };
      }
      if (prepared.kind === 'workflow') {
        return {
          success: true,
          workflow: {
            request: prepared.workflow.request,
            source: 'command',
            displayName: prepared.workflow.displayName,
            processSource: 'review',
            builtin: {
              name: prepared.workflow.builtinName,
              args: prepared.workflow.builtinArgs,
            },
          },
        };
      }
      if (prepared.kind === 'empty') {
        return { success: true, message: 'No changes to review.' };
      }
      return { success: false, message: prepared.message };
    }
    const invocation = parseReviewInvocation(args);
    if (invocation.error) {
      return { success: false, message: `/review: ${invocation.error}` };
    }
    let captured: CapturedReviewDiff;
    try {
      captured = await getDiff(invocation.diffArgs, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message: `/review: git failed - ${message}` };
    }

    if (!captured.diff.trim()) {
      return { success: true, message: 'No changes to review.' };
    }

    if (invocation.workflow) {
      let packets: Awaited<ReturnType<typeof writeReviewPackets>>;
      try {
        packets = await writeReviewPackets({
          cwd,
          sessionId: context.sessionId,
          label: captured.label,
          diff: captured.diff,
          scope: captured.scope,
          ...(captured.baseRef ? { baseRef: captured.baseRef } : {}),
          ...(captured.headRef ? { headRef: captured.headRef } : {}),
          customPrompt: invocation.prompt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, message: `/review: could not create review packet - ${message}` };
      }
      return {
        success: true,
        workflow: {
          request: buildReviewWorkflowRequest(captured.label, {
            lean: invocation.lean,
            customPrompt: invocation.prompt,
            packets,
          }),
          source: 'command',
          displayName: buildDisplayName(invocation),
          processSource: 'review',
          builtin: {
            name: 'scoped-review',
            args: {
              packets,
              ...(invocation.lean ? { lean: true } : {}),
              ...(invocation.prompt ? { reviewFocus: invocation.prompt } : {}),
            },
          },
        },
      };
    }

    return {
      success: true,
      invocation: {
        prompt: buildReviewPrompt({
          label: captured.label,
          diff: captured.diff,
          lean: invocation.lean,
          customPrompt: invocation.prompt,
        }),
        source: 'prompt',
        displayName: buildDisplayName(invocation),
      },
    };
  },
};
