import chalk from 'chalk';
import type { Command, SessionRecoverStatus } from './types.js';
import { normalizeRecoveryPrompt } from '../session/recovery.js';

export const recoverCommand: Command = {
  name: 'recover',
  aliases: ['handoff'],
  description: 'Create a fresh session from safe memory and continue',
  usage: '/recover [prompt]',
  handler: async (args, _context, callbacks) => {
    if (!callbacks.recoverSession) {
      console.log(chalk.red('\n[Recover is not available in this host]\n'));
      return;
    }

    if (callbacks.confirm) {
      const approved = await callbacks.confirm(
        'Create a new session from a safe summary of this one and continue there?'
      );
      if (!approved) {
        console.log(chalk.dim('\nCancelled. Current session preserved.'));
        return;
      }
    }

    let status: SessionRecoverStatus;
    try {
      status = await callbacks.recoverSession(normalizeRecoveryPrompt(args.join(' ')));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message: `[Recover failed] ${message}` };
    }
    if (status === 'blocked') {
      console.log(chalk.yellow('\n[Recover blocked by the current session transition guard]\n'));
    } else if (status === 'failed') {
      console.log(chalk.red('\n[Recover failed]\n'));
    } else if (status === 'empty') {
      console.log(chalk.yellow('\n[Nothing to recover from this session]\n'));
    }
  },
  detailedHelp: () => {
    console.log(chalk.cyan('\n/recover - Continue in a Fresh Session\n'));
    console.log(chalk.bold('Usage:'));
    console.log(chalk.dim('  /recover                 ') + 'Continue with a safe memory summary');
    console.log(chalk.dim('  /recover <prompt>        ') + 'Continue with a custom first prompt');
    console.log(chalk.dim('  /handoff <prompt>        ') + 'Alias for /recover');
    console.log();
    console.log(chalk.bold('Description:'));
    console.log(chalk.dim('  Saves the current session, creates a new local session,'));
    console.log(chalk.dim('  carries over only a compact memory summary, and runs the'));
    console.log(chalk.dim('  first continuation prompt there. Raw tool calls and provider'));
    console.log(chalk.dim('  history are not replayed to the model.'));
    console.log();
  },
};
