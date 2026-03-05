/**
 * Skill Completer - 技能补全器
 *
 * Provides autocomplete for /skill:xxx format (pi-mono style).
 * 提供 /skill:xxx 格式的自动补全（pi-mono 风格）。
 *
 * Trigger: Input starts with /skill: followed by partial skill name
 * 触发条件: 输入以 /skill: 开头，后跟部分技能名称
 *
 * Example: /skill:code -> suggests /skill:code-review, /skill:codebase-analysis
 */

import type { Completer, Completion } from '../autocomplete.js';
import {
  getSkillRegistry,
  initializeSkillRegistry,
  type SkillMetadata,
} from '@kodax/skills';

/**
 * Skill Completer implementation
 * 技能补全器实现
 */
export class SkillCompleter implements Completer {
  private gitRoot?: string;
  private skillsCache: SkillMetadata[] | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 5000; // 5 seconds cache

  constructor(gitRoot?: string) {
    this.gitRoot = gitRoot;
  }

  /**
   * Check if this completer can handle the current input
   * 检查此补全器是否能处理当前输入
   */
  canComplete(input: string, cursorPos: number): boolean {
    const beforeCursor = input.slice(0, cursorPos);

    // Match /skill:xxx pattern (no spaces allowed in skill name)
    // 匹配 /skill:xxx 模式（技能名称中不允许空格）
    return /^\/skill:[^\s]*$/.test(beforeCursor);
  }

  /**
   * Get completion suggestions for the current input
   * 获取当前输入的补全建议
   */
  async getCompletions(input: string, cursorPos: number): Promise<Completion[]> {
    const beforeCursor = input.slice(0, cursorPos);
    const match = beforeCursor.match(/^\/skill:([^\s]*)$/);

    if (!match) {
      return [];
    }

    const partial = (match[1] ?? '').toLowerCase();

    // Get skills list (with caching)
    // 获取技能列表（带缓存）
    const skills = await this.getSkills();

    // Filter skills by partial match
    // 通过部分匹配过滤技能
    return skills
      .filter((skill) => {
        const nameLower = skill.name.toLowerCase();
        // Support both prefix match and fuzzy match
        // 支持前缀匹配和模糊匹配
        return nameLower.includes(partial) || this.fuzzyIncludes(partial, nameLower);
      })
      .map((skill) => ({
        text: `/skill:${skill.name}`,
        display: skill.name,
        description: this.truncateDescription(skill.description),
        type: 'command' as const,
      }))
      .sort((a, b) => {
        // Prefix matches first, then by name length
        // 前缀匹配优先，然后按名称长度排序
        const aIsPrefix = a.display.toLowerCase().startsWith(partial);
        const bIsPrefix = b.display.toLowerCase().startsWith(partial);
        if (aIsPrefix && !bIsPrefix) return -1;
        if (!aIsPrefix && bIsPrefix) return 1;
        return a.display.length - b.display.length;
      });
  }

  /**
   * Update git root (called when changing directories)
   * 更新 git 根目录（切换目录时调用）
   */
  setGitRoot(gitRoot: string | undefined): void {
    if (this.gitRoot !== gitRoot) {
      this.gitRoot = gitRoot;
      this.skillsCache = null; // Invalidate cache
    }
  }

  /**
   * Get available skills (with caching)
   * 获取可用技能（带缓存）
   */
  private async getSkills(): Promise<SkillMetadata[]> {
    const now = Date.now();

    // Return cached skills if still valid
    // 如果缓存仍然有效，返回缓存的技能
    if (this.skillsCache && now - this.cacheTimestamp < this.CACHE_TTL) {
      return this.skillsCache;
    }

    try {
      const registry = getSkillRegistry(this.gitRoot);

      // Ensure skills are discovered
      // 确保技能已被发现
      if (registry.size === 0) {
        await initializeSkillRegistry(this.gitRoot);
      }

      // Get skills that are user-invocable
      // 获取用户可调用的技能
      this.skillsCache = registry.listUserInvocable();
      this.cacheTimestamp = now;

      return this.skillsCache;
    } catch {
      // On error, return empty array
      // 出错时返回空数组
      return [];
    }
  }

  /**
   * Simple fuzzy inclusion check
   * 简单的模糊包含检查
   */
  private fuzzyIncludes(pattern: string, target: string): boolean {
    let patternIndex = 0;

    for (let i = 0; i < target.length && patternIndex < pattern.length; i++) {
      if (target[i] === pattern[patternIndex]) {
        patternIndex++;
      }
    }

    return patternIndex === pattern.length;
  }

  /**
   * Truncate long descriptions for display
   * 截断长描述以便显示
   */
  private truncateDescription(description: string, maxLength: number = 50): string {
    if (description.length <= maxLength) {
      return description;
    }
    return description.slice(0, maxLength - 3) + '...';
  }
}

/**
 * Create a skill completer instance
 * 创建技能补全器实例
 */
export function createSkillCompleter(gitRoot?: string): SkillCompleter {
  return new SkillCompleter(gitRoot);
}
