/**
 * /new Command - Start a new session
 * /new 命令 - 开始新会话
 *
 * Clears the current conversation and starts a fresh session.
 * This is a core workflow command for managing conversation context.
 */

import type { Command } from './types.js';
import chalk from 'chalk';

/**
 * /new command definition
 * /new 命令定义
 */
export const newCommand: Command = {
  name: 'new',
  description: 'Start a new conversation session',
  usage: '/new',
  handler: async (_args, context, callbacks) => {
    // Check if there are messages to clear
    if (context.messages.length === 0) {
      console.log(chalk.yellow('\nCurrent session is already empty.'));
      console.log(chalk.dim('You can start a new conversation directly.'));
      return;
    }

    // Confirm before clearing (if confirm callback is available)
    if (callbacks.confirm) {
      const shouldClear = await callbacks.confirm(
        'Start a new session? This will clear the current conversation history.'
      );
      if (!shouldClear) {
        console.log(chalk.dim('\nCancelled. Current session preserved.'));
        return;
      }
    }

    // Save current session before clearing (auto-save)
    try {
      await callbacks.saveSession();
      console.log(chalk.dim('\n[Previous session saved]'));
    } catch (error) {
      // Session save failed, but we can still proceed with clearing
      console.log(chalk.yellow('\n[Warning: Failed to save previous session]'));
    }

    // Clear the history
    await callbacks.startNewSession?.();
    context.messages = [];
    callbacks.clearHistory();

    console.log(chalk.green('\n✓ Started new session'));
    console.log(chalk.dim('Conversation history cleared. Ready for a fresh start!'));
  },
  detailedHelp: () => {
    console.log(chalk.bold('\n/new - Start New Session\n'));
    console.log('Usage:');
    console.log(chalk.cyan('  /new') + ' - Clear current session and start fresh\n');
    console.log('Description:');
    console.log('  This command clears the current conversation history and starts a new session.');
    console.log('  It automatically saves the previous session before clearing.');
    console.log('  Useful for switching contexts or starting a new topic.\n');
    console.log('Examples:');
    console.log(chalk.dim('  User: Help me refactor the authentication module'));
    console.log(chalk.dim('  AI: [provides refactoring help]'));
    console.log(chalk.cyan('  /new'));
    console.log(chalk.dim('  ✓ Started new session'));
    console.log(chalk.dim('  User: Now I need help with database optimization'));
    console.log(chalk.dim('  AI: [provides database help]\n'));
    console.log('Notes:');
    console.log('  • Automatically saves previous session before clearing');
    console.log('  • Prompts for confirmation if there are messages in the current session');
    console.log('  • Use /load to resume a previous session');
    console.log('  • Use /sessions to see all saved sessions');
  },
};
