/**
 * UI Context Interface - UI 交互上下文接口
 *
 * 通用 UI 交互接口，可用于：
 * - Command handlers (命令处理器)
 * - Skills execution (技能执行)
 * - LLM tool calls (LLM 工具调用)
 * - Agent workflows (Agent 工作流)
 */

/**
 * UIContext - 通用 UI 交互接口
 *
 * @example
 * ```typescript
 * // Command handler 中使用
 * const selected = await callbacks.ui.select("Choose an option", ["A", "B", "C"]);
 * const confirmed = await callbacks.ui.confirm("Delete all sessions?");
 * const value = await callbacks.ui.input("Enter your name", "John");
 * ```
 */
export interface UIContext {
  /**
   * Show a selector and return the user's choice
   * 显示选择对话框，返回用户的选择
   *
   * @param title - Dialog title
   * @param options - List of options to choose from
   * @returns Selected option, or undefined if cancelled
   */
  select(title: string, options: string[]): Promise<string | undefined>;

  /**
   * Show a confirmation dialog
   * 显示确认对话框
   *
   * @param message - Confirmation message
   * @returns true if confirmed, false if declined
   */
  confirm(message: string): Promise<boolean>;

  /**
   * Show a text input dialog
   * 显示文本输入对话框
   *
   * @param prompt - Input prompt
   * @param defaultValue - Optional default value
   * @returns Input value, or undefined if cancelled
   */
  input(prompt: string, defaultValue?: string): Promise<string | undefined>;
  /** Local credentials only: never render or append the original input to history. */
  secret?(prompt: string): Promise<string | undefined>;
}
