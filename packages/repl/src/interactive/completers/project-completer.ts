/**
 * Project Completer - Project 命令补全器
 *
 * Provides dynamic autocomplete for /project commands.
 * 为 /project 命令提供动态自动补全。
 *
 * Features:
 * - Feature index completion: /project edit # → #0, #1, #2...
 * - Option completion: /project status -- → --features, --progress
 * - Smart context-aware suggestions
 */

import type { Completer, Completion } from '../autocomplete.js';
import { ProjectStorage } from '../project-storage.js';

/**
 * Project Completer implementation
 * Project 补全器实现
 */
export class ProjectCompleter implements Completer {
  private featuresCache: { index: number; desc: string }[] | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 3000; // 3 seconds cache

  /**
   * Check if this completer can handle the current input
   * 检查此补全器是否能处理当前输入
   */
  canComplete(input: string, cursorPos: number): boolean {
    const beforeCursor = input.slice(0, cursorPos);

    // Match patterns:
    // 1. /project edit #
    // 2. /project next #
    // 3. /project verify #
    // 4. /project plan #
    // 5. /project status --
    // 6. /project init --
    // 7. /project auto --
    // 8. /project reset --
    const projectPattern = /\/(?:project|proj|p)\s+/;
    if (!projectPattern.test(beforeCursor)) return false;

    // Check for # (feature index) completion
    if (/\/(?:project|proj|p)\s+(?:edit|next|verify|plan)\s+#?\w*$/.test(beforeCursor)) {
      return true;
    }

    // Check for -- (option) completion
    if (/\/(?:project|proj|p)\s+\w+\s+--?\w*$/.test(beforeCursor)) {
      return true;
    }

    return false;
  }

  /**
   * Get completion suggestions for the current input
   * 获取当前输入的补全建议
   */
  async getCompletions(input: string, cursorPos: number): Promise<Completion[]> {
    const beforeCursor = input.slice(0, cursorPos);

    // Pattern 1: Feature index completion (#0, #1, #2...)
    const indexMatch = beforeCursor.match(/\/(?:project|proj|p)\s+(?:edit|next|verify|plan)\s+#?(\d*)$/);
    if (indexMatch) {
      return await this.getFeatureIndexCompletions(indexMatch[1] ?? '');
    }

    // Pattern 2: Option completion (--features, --progress, etc.)
    const optionMatch = beforeCursor.match(/\/(?:project|proj|p)\s+(\w+)\s+--?(\w*)$/);
    if (optionMatch) {
      const subCommand = optionMatch[1] ?? '';
      const partial = optionMatch[2] ?? '';
      return this.getOptionCompletions(subCommand, partial);
    }

    return [];
  }

  /**
   * Get feature index completions (#0, #1, #2...)
   */
  private async getFeatureIndexCompletions(partial: string): Promise<Completion[]> {
    const features = await this.getFeatures();

    return features
      .filter((f) => partial === '' || f.index.toString().startsWith(partial))
      .map((f) => ({
        text: `#${f.index}`,
        display: `#${f.index}`,
        description: this.truncate(f.desc, 50),
        type: 'argument' as const,
      }))
      .slice(0, 20); // Limit to 20 suggestions
  }

  /**
   * Get option completions based on subcommand
   */
  private getOptionCompletions(subCommand: string, partial: string): Completion[] {
    const options = this.getOptionsForCommand(subCommand);

    return options
      .filter((opt) => opt.startsWith(`--${partial}`))
      .map((opt) => ({
        text: opt,
        display: opt,
        description: this.getOptionDescription(opt),
        type: 'argument' as const,
      }));
  }

  /**
   * Get available options for a command
   */
  private getOptionsForCommand(subCommand: string): string[] {
    const optionMap: Record<string, string[]> = {
      'init': ['--overwrite'],
      'status': ['--features', '--progress'],
      'next': ['--no-confirm'],
      'auto': ['--max=', '--confirm'],
      'verify': ['--last'],
      'reset': ['--all'],
    };

    return optionMap[subCommand] ?? [];
  }

  /**
   * Get description for an option
   */
  private getOptionDescription(option: string): string {
    const descriptions: Record<string, string> = {
      '--overwrite': 'Overwrite existing feature list',
      '--features': 'Show detailed feature list',
      '--progress': 'Show detailed progress log',
      '--no-confirm': 'Skip confirmation prompts',
      '--max=': 'Maximum number of auto-runs',
      '--confirm': 'Confirm each feature before execution',
      '--last': 'Show the latest harness verification record',
      '--all': 'Delete all project management files',
    };

    return descriptions[option] ?? '';
  }

  /**
   * Get features from feature_list.json (with caching)
   */
  private async getFeatures(): Promise<{ index: number; desc: string }[]> {
    const now = Date.now();

    // Return cached features if still valid
    if (this.featuresCache && now - this.cacheTimestamp < this.CACHE_TTL) {
      return this.featuresCache;
    }

    // Load features from disk
    try {
      const storage = new ProjectStorage(process.cwd());
      const data = await storage.loadFeatures();

      if (!data || !data.features.length) {
        return [];
      }

      this.featuresCache = data.features.map((f, i) => ({
        index: i,
        desc: f.description || f.name || 'Unnamed',
      }));

      this.cacheTimestamp = now;
      return this.featuresCache;
    } catch (error) {
      // Silently fail - completer should not throw errors
      return [];
    }
  }

  /**
   * Truncate text with ellipsis
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }
}
