/**
 * Readline UI Context - Readline UI 上下文实现
 *
 * 为 REPL 模式提供 UI 交互功能，使用 Node.js readline 接口
 */

import type * as readline from 'readline';
import type { UIContext } from './context.js';

/**
 * ReadlineUIContext - 使用 readline 实现的 UI 上下文
 */
export class ReadlineUIContext implements UIContext {
  constructor(private rl: readline.Interface, readonly secret?: UIContext['secret']) {}

  /**
   * Show a selector and return the user's choice
   *
   * @param title - Dialog title
   * @param options - List of options to choose from
   * @returns Selected option, or undefined if cancelled
   */
  async select(title: string, options: string[]): Promise<string | undefined> {
    if (options.length === 0) {
      return undefined;
    }

    // Display options
    console.log(`\n${title}`);
    console.log('─'.repeat(title.length));
    options.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option}`);
    });
    console.log('  0. Cancel');
    console.log('');

    // Prompt for selection
    return new Promise((resolve) => {
      this.rl.question('Enter choice (0 to cancel): ', (answer) => {
        const trimmed = answer.trim();

        // Check for cancel
        if (trimmed === '0' || trimmed === '') {
          resolve(undefined);
          return;
        }

        // Parse selection
        const index = parseInt(trimmed, 10) - 1;
        if (isNaN(index) || index < 0 || index >= options.length) {
          console.log('Invalid choice. Please try again.');
          resolve(undefined);
          return;
        }

        resolve(options[index]);
      });
    });
  }

  /**
   * Show a confirmation dialog
   *
   * @param message - Confirmation message
   * @returns true if confirmed, false if declined
   */
  async confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.rl.question(`${message} (y/N): `, (answer) => {
        const trimmed = answer.trim().toLowerCase();
        resolve(trimmed === 'y' || trimmed === 'yes');
      });
    });
  }

  /**
   * Show a text input dialog
   *
   * @param prompt - Input prompt
   * @param defaultValue - Optional default value
   * @returns Input value, or undefined if cancelled
   */
  async input(prompt: string, defaultValue?: string): Promise<string | undefined> {
    const promptText = defaultValue ? `${prompt} [${defaultValue}]: ` : `${prompt}: `;

    return new Promise((resolve) => {
      this.rl.question(promptText, (answer) => {
        const trimmed = answer.trim();

        // Use default value if empty
        if (trimmed === '' && defaultValue !== undefined) {
          resolve(defaultValue);
          return;
        }

        // Return trimmed value or undefined if empty
        resolve(trimmed || undefined);
      });
    });
  }
}
