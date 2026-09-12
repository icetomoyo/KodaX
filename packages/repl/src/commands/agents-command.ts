import { constants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import chalk from 'chalk';

import type { InteractiveContext } from '../interactive/context.js';
import { clientCommandResult, type Command } from './types.js';
import { randomUUID } from 'node:crypto';

export const KODAX_LEAN_AGENTS_CONTENT = `# KodaX Lean Mode

Before writing code:
1. Do we need to build this at all?
2. Does the codebase already have this?
3. Can stdlib or native platform solve it?
4. Can an existing dependency solve it?
5. Can this be a minimal diff?
6. Only then write code.

Never cut:
- trust-boundary validation
- security checks
- data-loss protection
- accessibility basics
- explicitly requested behavior

After coding:
- explain what was skipped
- say when to add it back
`;

function resolveTargetRoot(context: InteractiveContext): string {
  return (
    context.runtimeInfo?.workspaceRoot ??
    context.runtimeInfo?.executionCwd ??
    context.gitRoot ??
    process.cwd()
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function existingAgentsResult(agentsPath: string): { success: true; message: string } {
  console.log(chalk.dim(`AGENTS.md already exists at ${agentsPath}; left unchanged.`));
  return {
    success: true,
    message: `AGENTS.md already exists and was left unchanged: ${agentsPath}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function initializeAgentsFile(
  agentsPath: string,
  callbacks: { reloadAgentsFiles?: () => Promise<unknown> },
): Promise<{ success: boolean; message: string }> {
  let exists: boolean;
  try {
    exists = await pathExists(agentsPath);
  } catch (error) {
    return {
      success: false,
      message: `/agents init: failed to inspect ${agentsPath}: ${errorMessage(error)}`,
    };
  }

  if (exists) {
    return existingAgentsResult(agentsPath);
  }

  try {
    await writeFile(agentsPath, KODAX_LEAN_AGENTS_CONTENT, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return existingAgentsResult(agentsPath);
    }
    return {
      success: false,
      message: `/agents init: failed to write ${agentsPath}: ${errorMessage(error)}`,
    };
  }
  if (callbacks.reloadAgentsFiles) {
    try {
      await callbacks.reloadAgentsFiles();
    } catch (error) {
      return {
        success: false,
        message: `/agents init: created ${agentsPath} but failed to reload AGENTS.md files: ${errorMessage(error)}`,
      };
    }
  }

  console.log(chalk.green(`Created ${agentsPath}`));
  return {
    success: true,
    message: `Created ${agentsPath}`,
  };
}

export function buildLeanReviewPrompt(agentsPath: string, content: string): string {
  return [
    `Review and update the target project's AGENTS.md at ${agentsPath}.`,
    '',
    'Goal: ensure the project instructions include KodaX Lean Mode guidance, without duplicating equivalent existing guidance.',
    '',
    'Required behavior:',
    '- First inspect the existing AGENTS.md content and decide whether lean/minimal-diff constraints are already present.',
    '- If equivalent guidance already exists, leave the file unchanged and explain that no change was needed.',
    '- If guidance is missing or partial, edit AGENTS.md with the smallest clear diff that merges the Lean Mode ideas into the existing structure.',
    '- Do not add duplicate headings or repeat bullets that already exist with equivalent meaning.',
    '- Preserve existing project-specific instructions and ordering unless a small local insertion is clearly better.',
    '- Never weaken trust-boundary validation, security checks, data-loss protection, accessibility basics, or explicitly requested behavior.',
    '',
    'Lean Mode guidance to merge when missing:',
    '',
    '```markdown',
    KODAX_LEAN_AGENTS_CONTENT.trimEnd(),
    '```',
    '',
    'Current AGENTS.md content:',
    '',
    '```markdown',
    content,
    '```',
  ].join('\n');
}

function printAgentsHelp(): void {
  console.log(chalk.bold('\n/agents - Manage Target Project Instructions\n'));
  console.log('Usage:');
  console.log(chalk.cyan('  /agents init'));
  console.log(chalk.cyan('  /agents lean'));
  console.log();
  console.log('Commands:');
  console.log(chalk.dim('  init    ') + 'Create AGENTS.md in the target project if it is absent');
  console.log(chalk.dim('  lean    ') + 'Initialize or LLM-review AGENTS.md for Lean Mode guidance');
  console.log();
  console.log('Notes:');
  console.log(chalk.dim('  - Existing AGENTS.md files are never overwritten.'));
  console.log(chalk.dim('  - /agents lean asks the LLM to merge missing lean guidance without duplicates.'));
  console.log(chalk.dim('  - The generated file belongs to the target project, not KodaX itself.'));
}

export const agentsCommand: Command = {
  name: 'agents',
  description: 'Initialize target-project AGENTS.md instructions',
  usage: '/agents init | lean',
  argumentHint: 'init | lean',
  detailedHelp: printAgentsHelp,
  handler: async (args, context, callbacks) => {
    const subcommand = args[0]?.toLowerCase() ?? 'help';
    if (subcommand !== 'init' && subcommand !== 'lean') {
      printAgentsHelp();
      return true;
    }

    const root = resolveTargetRoot(context);
    const agentsPath = join(root, 'AGENTS.md');

    if (subcommand === 'init') {
      return await initializeAgentsFile(agentsPath, callbacks);
    }

    let agentsExists: boolean;
    try {
      agentsExists = await pathExists(agentsPath);
    } catch (error) {
      return {
        success: false,
        message: `/agents lean: failed to inspect ${agentsPath}: ${errorMessage(error)}`,
      };
    }

    if (!agentsExists) {
      return await initializeAgentsFile(agentsPath, callbacks);
    }

    if (callbacks?.reviewAgentsLean) {
      const result = await callbacks.reviewAgentsLean({ sessionId: context.sessionId, inputId: randomUUID() });
      return clientCommandResult(result);
    }

    // FEATURE_298 T37 — with a Host binding the AGENTS.md read and prompt
    // build happen Host-side; missing files keep the local init fallback.
    const leanBinding = callbacks?.prepareAgentsLean;
    if (leanBinding !== undefined) {
      const prepared = await leanBinding({ projectRoot: root });
      if (prepared.kind === 'prepared') {
        return { success: true, invocation: prepared.invocation };
      }
      return await initializeAgentsFile(agentsPath, callbacks);
    }

    let content: string;
    try {
      content = await readFile(agentsPath, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message: `/agents lean: failed to read ${agentsPath}: ${message}` };
    }

    return {
      success: true,
      invocation: {
        prompt: buildLeanReviewPrompt(agentsPath, content),
        source: 'prompt',
        displayName: '/agents lean',
      },
    };
  },
};
