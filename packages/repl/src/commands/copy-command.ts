/**
 * /copy Command - Copy last message to clipboard
 *
 * Copies the last assistant message to the system clipboard.
 * This is a high-frequency utility command for quickly sharing
 * or saving AI responses.
 */

import type { Command } from './types.js';
import chalk from 'chalk';
import { copyTextToClipboard } from '../common/clipboard.js';
import { extractLastAssistantText } from '../ui/utils/message-utils.js';

/**
 * /copy command definition
 */
export const copyCommand: Command = {
  name: 'copy',
  description: 'Copy last assistant message to clipboard',
  usage: '/copy',
  handler: async (_args, context) => {
    const lastMessage = extractLastAssistantText(context.messages as never);

    if (!lastMessage) {
      console.log(chalk.yellow('\nNo assistant message found to copy.'));
      console.log(chalk.dim('The assistant needs to respond first before you can copy its message.'));
      return;
    }

    try {
      await copyTextToClipboard(lastMessage);
      const preview = lastMessage.length > 50 ? lastMessage.slice(0, 50) + '...' : lastMessage;
      console.log(chalk.green('\nCopied to clipboard!'));
      console.log(chalk.dim(`Preview: ${preview}`));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`\nFailed to copy to clipboard: ${errorMessage}`));
      console.log(chalk.dim('You may need to check clipboard permissions or manually copy the message.'));
    }
  },
  detailedHelp: () => {
    console.log(chalk.bold('\n/copy - Copy Last Assistant Message\n'));
    console.log('Usage:');
    console.log(chalk.cyan('  /copy') + ' - Copy the last assistant message to clipboard\n');
    console.log('Description:');
    console.log('  This command copies the most recent assistant response to your system clipboard.');
    console.log('  Useful for quickly sharing or saving AI responses.\n');
    console.log('Examples:');
    console.log(chalk.dim('  User: Explain how async/await works'));
    console.log(chalk.dim('  AI: [responds with explanation]'));
    console.log(chalk.cyan('  /copy') + chalk.dim(' - Copies the explanation to clipboard\n'));
    console.log('Notes:');
    console.log('  - Only copies assistant messages, not user messages');
    console.log('  - Works with both plain text and formatted responses');
    console.log('  - Requires clipboard permissions on some systems');
  },
};
