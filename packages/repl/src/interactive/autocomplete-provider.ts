/**
 * Autocomplete Provider - 自动补全提供者
 *
 * Combines all completers with fuzzy matching and debouncing.
 * 组合所有补全器，提供模糊匹配和防抖功能。
 *
 * Features:
 * - Auto-trigger on typing (debounced) - 输入时自动触发（防抖）
 * - Fuzzy matching with scoring - 带评分的模糊匹配
 * - Combined results from multiple completers - 多个补全器的组合结果
 * - Keyboard navigation support - 键盘导航支持
 */

import { FileCompleter, CommandCompleter, type Completer, type Completion } from './autocomplete.js';
import { SkillCompleter } from './completers/skill-completer.js';
import { ArgumentCompleter } from './completers/argument-completer.js';
import { sortCandidatesCombined } from './fuzzy.js';

/**
 * Autocomplete state for UI binding
 * 用于 UI 绑定的自动补全状态
 */
export interface AutocompleteState {
  /** Whether dropdown is visible - 下拉框是否可见 */
  visible: boolean;
  /** Current selected index - 当前选中索引 */
  selectedIndex: number;
  /** Current completions - 当前补全列表 */
  completions: Completion[];
  /** Whether completions are loading - 补全是否正在加载 */
  loading: boolean;
}

/**
 * Options for AutocompleteProvider
 * AutocompleteProvider 的配置选项
 */
export interface AutocompleteProviderOptions {
  /** Working directory for file completion - 文件补全的工作目录 */
  cwd?: string;
  /** Git root for skill discovery - 技能发现的 Git 根目录 */
  gitRoot?: string;
  /** Debounce delay in ms (default: 100) - 防抖延迟（默认：100ms） */
  debounceDelay?: number;
  /** Minimum characters to trigger (default: 1) - 触发的最小字符数（默认：1） */
  minTriggerChars?: number;
  /** Maximum completions to show (default: 10) - 最大显示补全数（默认：10） */
  maxCompletions?: number;
  /** Minimum score threshold for fuzzy match (default: 0) - 模糊匹配的最低评分阈值（默认：0） */
  minScore?: number;
}

/**
 * Default options
 * 默认选项
 */
const DEFAULT_OPTIONS: Required<Omit<AutocompleteProviderOptions, 'cwd' | 'gitRoot'>> = {
  debounceDelay: 100,
  minTriggerChars: 1,
  maxCompletions: 10,
  minScore: 0,
};

/**
 * Debounce function type
 * 防抖函数类型
 */
type DebounceTimer = ReturnType<typeof setTimeout> | null;

/**
 * Internal options type with required defaults
 * 内部选项类型，包含必需的默认值
 */
type InternalOptions = Required<Omit<AutocompleteProviderOptions, 'cwd' | 'gitRoot'>> &
  Pick<AutocompleteProviderOptions, 'cwd' | 'gitRoot'>;

/**
 * Autocomplete Provider - Main orchestrator for autocomplete
 * 自动补全提供者 - 自动补全的主要协调器
 */
export class AutocompleteProvider {
  private completers: Completer[];
  private options: InternalOptions;
  private state: AutocompleteState;
  private listeners: Set<(state: AutocompleteState) => void> = new Set();
  private debounceTimer: DebounceTimer = null;
  private lastInput: string = '';
  private lastCursorPos: number = 0;

  constructor(options: AutocompleteProviderOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };

    // Initialize completers - 初始化补全器
    // Order matters: more specific completers first
    // 顺序很重要：更具体的补全器优先
    this.completers = [
      new SkillCompleter(this.options.gitRoot),
      new ArgumentCompleter(),
      new CommandCompleter(),
      new FileCompleter(this.options.cwd),
    ];

    // Initial state - 初始状态
    this.state = {
      visible: false,
      selectedIndex: 0,
      completions: [],
      loading: false,
    };
  }

  /**
   * Get current options
   * 获取当前选项
   */
  getOptions(): InternalOptions {
    return { ...this.options };
  }

  /**
   * Get current state
   * 获取当前状态
   */
  getState(): AutocompleteState {
    return { ...this.state };
  }

  /**
   * Subscribe to state changes
   * 订阅状态变化
   */
  subscribe(listener: (state: AutocompleteState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Update options (e.g., when changing directories)
   * 更新选项（如切换目录时）
   */
  updateOptions(options: Partial<AutocompleteProviderOptions>): void {
    const gitRootChanged = options.gitRoot !== undefined && options.gitRoot !== this.options.gitRoot;
    const cwdChanged = options.cwd !== undefined && options.cwd !== this.options.cwd;

    this.options = {
      ...this.options,
      ...options,
    };

    // Update skill completer's git root if changed
    // 如果 git 根目录变化，更新技能补全器
    if (gitRootChanged) {
      const skillCompleter = this.completers.find((c) => c instanceof SkillCompleter) as SkillCompleter | undefined;
      skillCompleter?.setGitRoot(this.options.gitRoot);
    }

    // Recreate file completer if cwd changed
    // 如果 cwd 变化，重建文件补全器
    if (cwdChanged) {
      const fileIndex = this.completers.findIndex((c) => c instanceof FileCompleter);
      if (fileIndex !== -1) {
        this.completers[fileIndex] = new FileCompleter(this.options.cwd);
      }
    }
  }

  /**
   * Handle input change (auto-trigger with debounce)
   * 处理输入变化（带防抖的自动触发）
   */
  handleInput(input: string, cursorPos: number): void {
    this.lastInput = input;
    this.lastCursorPos = cursorPos;

    // Clear pending debounce - 清除待处理的防抖
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Check if we should trigger - 检查是否应该触发
    const shouldTrigger = this.shouldTrigger(input, cursorPos);

    if (!shouldTrigger) {
      // Hide dropdown if not triggering - 如果不触发则隐藏下拉框
      if (this.state.visible) {
        this.updateState({ visible: false, completions: [], selectedIndex: 0 });
      }
      return;
    }

    // Debounce the fetch - 防抖获取
    this.debounceTimer = setTimeout(() => {
      this.fetchCompletions(input, cursorPos);
    }, this.options.debounceDelay);
  }

  /**
   * Immediately fetch completions (for Tab key)
   * 立即获取补全（用于 Tab 键）
   */
  async fetchImmediate(input: string, cursorPos: number): Promise<Completion[]> {
    return this.fetchCompletionsInternal(input, cursorPos);
  }

  /**
   * Move selection up
   * 向上移动选择
   */
  selectPrevious(): void {
    if (!this.state.visible || this.state.completions.length === 0) return;

    const newIndex =
      this.state.selectedIndex > 0
        ? this.state.selectedIndex - 1
        : this.state.completions.length - 1;

    this.updateState({ selectedIndex: newIndex });
  }

  /**
   * Move selection down
   * 向下移动选择
   */
  selectNext(): void {
    if (!this.state.visible || this.state.completions.length === 0) return;

    const newIndex =
      this.state.selectedIndex < this.state.completions.length - 1
        ? this.state.selectedIndex + 1
        : 0;

    this.updateState({ selectedIndex: newIndex });
  }

  /**
   * Get currently selected completion
   * 获取当前选中的补全
   */
  getSelectedCompletion(): Completion | null {
    if (!this.state.visible || this.state.completions.length === 0) return null;
    return this.state.completions[this.state.selectedIndex] ?? null;
  }

  /**
   * Accept selected completion (returns replacement text)
   * 接受选中的补全（返回替换文本）
   */
  acceptCompletion(): string | null {
    const selected = this.getSelectedCompletion();
    if (!selected) return null;

    // Hide dropdown - 隐藏下拉框
    this.updateState({ visible: false, completions: [], selectedIndex: 0 });

    return selected.text;
  }

  /**
   * Cancel/hide autocomplete
   * 取消/隐藏自动补全
   */
  cancel(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.state.visible) {
      this.updateState({ visible: false, completions: [], selectedIndex: 0 });
    }
  }

  /**
   * Check if autocomplete should trigger
   * 检查自动补全是否应该触发
   */
  private shouldTrigger(input: string, cursorPos: number): boolean {
    if (input.length < this.options.minTriggerChars) return false;

    const beforeCursor = input.slice(0, cursorPos);

    // Check trigger conditions - 检查触发条件
    // 1. Starts with / (command or skill)
    // 2. Contains @ (file path)
    // 3. After command with space (arguments)
    return (
      beforeCursor.startsWith('/') ||
      beforeCursor.includes('@') ||
      /^\/\w+\s/.test(beforeCursor)
    );
  }

  /**
   * Fetch completions (debounced handler)
   * 获取补全（防抖处理器）
   */
  private fetchCompletions(input: string, cursorPos: number): void {
    this.updateState({ loading: true });

    this.fetchCompletionsInternal(input, cursorPos)
      .then((completions) => {
        if (completions.length > 0) {
          this.updateState({
            visible: true,
            completions: completions.slice(0, this.options.maxCompletions),
            selectedIndex: 0,
            loading: false,
          });
        } else {
          this.updateState({
            visible: false,
            completions: [],
            selectedIndex: 0,
            loading: false,
          });
        }
      })
      .catch(() => {
        this.updateState({ loading: false });
      });
  }

  /**
   * Internal completion fetching logic
   * 内部补全获取逻辑
   */
  private async fetchCompletionsInternal(
    input: string,
    cursorPos: number
  ): Promise<Completion[]> {
    // Find active completers - 查找活动的补全器
    const activeCompleters = this.completers.filter((c) =>
      c.canComplete(input, cursorPos)
    );

    if (activeCompleters.length === 0) {
      return [];
    }

    // Fetch completions from all active completers
    // 从所有活动的补全器获取补全
    const allCompletions: Completion[] = [];

    for (const completer of activeCompleters) {
      try {
        const completions = await completer.getCompletions(input, cursorPos);
        allCompletions.push(...completions);
      } catch (error) {
        // Log error but continue with other completers
        // 记录错误但继续使用其他补全器
        console.error('[Autocomplete] Completer error:', error);
      }
    }

    // Extract search pattern for fuzzy matching
    // 提取搜索模式用于模糊匹配
    const pattern = this.extractPattern(input, cursorPos);

    // Sort by fuzzy match score - 按模糊匹配评分排序
    const scoredCompletions = sortCandidatesCombined(
      pattern,
      allCompletions.map((c) => ({ ...c, text: c.display })),
      this.options.minScore
    );

    // Return original completion objects with scores
    // 返回带评分的原始补全对象
    return scoredCompletions.map((scored) => {
      const original = allCompletions.find((c) => c.display === scored.text);
      return original ?? { text: scored.text, display: scored.text, type: 'file' as const };
    });
  }

  /**
   * Extract search pattern from input
   * 从输入中提取搜索模式
   */
  private extractPattern(input: string, cursorPos: number): string {
    const beforeCursor = input.slice(0, cursorPos);

    // For commands starting with /
    // 对于以 / 开头的命令
    if (beforeCursor.startsWith('/')) {
      // For skill: extract text after /skill: (check this FIRST before generic command match)
      // 对于技能：提取 /skill: 后的文本（在通用命令匹配之前先检查这个）
      const skillMatch = beforeCursor.match(/^\/skill:(\S*)$/);
      if (skillMatch) return skillMatch[1] ?? '';

      // For generic commands: extract text after /
      // 对于通用命令：提取 / 后的文本
      const match = beforeCursor.match(/^\/(\S*)$/);
      if (match) return match[1] ?? '';

      // For arguments: extract last word
      // 对于参数：提取最后一个词
      const parts = beforeCursor.split(/\s+/);
      return (parts[parts.length - 1] ?? '').toLowerCase();
    }

    // For files: extract text after last @
    // 对于文件：提取最后一个 @ 后的文本
    const lastAtIndex = beforeCursor.lastIndexOf('@');
    if (lastAtIndex !== -1) {
      const afterAt = beforeCursor.slice(lastAtIndex + 1);
      // Get the last path segment - 获取最后的路径段
      const lastSlash = afterAt.lastIndexOf('/');
      return lastSlash === -1 ? afterAt : afterAt.slice(lastSlash + 1);
    }

    // Default: last word - 默认：最后一个词
    const match = beforeCursor.match(/(\S+)$/);
    return match ? (match[1] ?? '') : '';
  }

  /**
   * Update state and notify listeners
   * 更新状态并通知监听器
   */
  private updateState(updates: Partial<AutocompleteState>): void {
    this.state = { ...this.state, ...updates };

    // Notify listeners - 通知监听器
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        console.error('[Autocomplete] Listener error:', error);
      }
    }
  }
}

/**
 * Create an autocomplete provider instance
 * 创建自动补全提供者实例
 */
export function createAutocompleteProvider(
  options?: AutocompleteProviderOptions
): AutocompleteProvider {
  return new AutocompleteProvider(options);
}
