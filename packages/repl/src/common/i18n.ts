/**
 * i18n - Lightweight internationalization for KodaX UI strings
 *
 * Locale resolution order:
 *   1. config.json "locale" field (e.g. "zh", "en")
 *   2. System environment (LANG, LC_ALL)
 *   3. Default: "en"
 *
 * Usage:
 *   import { t, setLocale } from "../common/i18n.js";
 *   t("confirm.prefix")              // "[Confirm]" or "[确认]"
 *   t("tool.generic.title", { tool }) // "Execute search?" or "执行 search？"
 */

export type Locale = "en" | "zh";

let currentLocale: Locale = "en";

// === Locale detection ===

function detectSystemLocale(): Locale {
  const raw = (
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ""
  ).toLowerCase();
  if (raw.startsWith("zh")) return "zh";
  return "en";
}

export function setLocale(locale: string | undefined): void {
  if (!locale || locale === "auto") {
    currentLocale = detectSystemLocale();
    return;
  }
  const normalized = locale.toLowerCase().replace(/[-_].*/, "");
  currentLocale = normalized === "zh" ? "zh" : "en";
}

export function getLocale(): Locale {
  return currentLocale;
}

// === Translation dictionary ===

const translations = {
  en: {
    // Dialog prefixes
    "dialog.confirm": "[Confirm]",
    "dialog.select": "[Select]",
    "dialog.input": "[Input]",

    // Confirmation instructions
    "confirm.instruction.basic": "Press (y) yes, (n) no",
    "confirm.instruction.always": "Press (y) yes, (a) always yes for this tool, (n) no",
    "confirm.instruction.protected": "Press (y) to confirm, (n) to cancel (protected path)",

    // Confirmation result (for history)
    "confirm.result.approved": "Approved",
    "confirm.result.approved_always": "Approved (always)",
    "confirm.result.denied": "Denied",

    // Tool confirmation titles
    "tool.bash.title": "Execute bash command?",
    "tool.shell.title": "Execute shell command?",
    "tool.write.title": "Write to file?",
    "tool.edit.title": "Edit file?",
    "tool.generic.title": "Execute {tool}?",

    // Field labels
    "field.reason": "Reason",
    "field.intent": "Intent",
    "field.target": "Target",
    "field.scope": "Scope",
    "field.risk": "Risk",
    "field.summary": "Summary",

    // Shell intents
    "intent.read": "Read project files",
    "intent.delete": "Delete files",
    "intent.deps": "Modify dependencies or environment",
    "intent.modify": "Modify files",
    "intent.execute": "Execute command",
    "intent.write_file": "Write file",
    "intent.edit_file": "Edit file",
    "intent.use_tool": "Use {tool}",

    // Shell risks
    "risk.destructive": "Destructive change",
    "risk.deps": "May change dependencies or local tools",
    "risk.modify": "May modify files",
    "risk.unknown": "Command effects depend on its arguments",
    "risk.network": "May access network",

    // Scope
    "scope.outside": "Outside project",
    "scope.protected": "Protected path",

    // Surface liveness / waiting
    "waiting.confirm": "Waiting: approval required",
    "waiting.select": "Waiting: choose an option",
    "waiting.input": "Waiting: answer the prompt",

    // Prompt placeholder
    "placeholder.confirm": "Respond to the approval prompt above...",
    "placeholder.select": "Choose an option above...",
    "placeholder.input": "Answer the prompt above...",
    "placeholder.busy": "Agent is busy...",
    "placeholder.queue": "Queue a follow-up for the next round...",
    "placeholder.idle": "Type a message...",

    // Select dialog
    "select.choice": "Choice:",
    "select.type_number": "(type a number)",
    "select.more": "{count} more choices...",
    "select.more_above": "\u2191 {count} more above",
    "select.more_below": "\u2193 {count} more below",
    "select.confirm_hint": "Press Enter to confirm, Esc to cancel",
    "select.navigate_hint": "Use \u2191\u2193 to navigate, Enter to confirm, Esc to cancel",
    "select.multiselect_hint": "Use \u2191\u2193 to navigate, Space to toggle, Enter to confirm, Esc to cancel",
    "select.multiselect_empty": "Select at least one option with Space before confirming.",
    "select.back_prev": "\u2190 Back to previous question",

    // Input dialog
    "input.default": "Default:",
    "input.value": "Value:",
    "input.type_response": "(type your response)",

    // Managed task completion
    "managed.completed": "Task completed",
    "managed.completed.blocked": "Task blocked",
    "managed.completed.continuation": "Task needs continuation",

    // Cancellation
    "cancelled": "[Cancelled] Operation cancelled by user",
  },

  zh: {
    "dialog.confirm": "[确认]",
    "dialog.select": "[选择]",
    "dialog.input": "[输入]",

    "confirm.instruction.basic": "按 (y) 确认, (n) 拒绝",
    "confirm.instruction.always": "按 (y) 确认, (a) 始终允许此工具, (n) 拒绝",
    "confirm.instruction.protected": "按 (y) 确认, (n) 取消 (受保护路径)",

    "confirm.result.approved": "已批准",
    "confirm.result.approved_always": "已批准 (始终允许)",
    "confirm.result.denied": "已拒绝",

    "tool.bash.title": "执行 bash 命令？",
    "tool.shell.title": "执行 shell 命令？",
    "tool.write.title": "写入文件？",
    "tool.edit.title": "编辑文件？",
    "tool.generic.title": "执行 {tool}？",

    "field.reason": "原因",
    "field.intent": "意图",
    "field.target": "目标",
    "field.scope": "范围",
    "field.risk": "风险",
    "field.summary": "摘要",

    "intent.read": "读取项目文件",
    "intent.delete": "删除文件",
    "intent.deps": "修改依赖或环境",
    "intent.modify": "修改文件",
    "intent.execute": "执行命令",
    "intent.write_file": "写入文件",
    "intent.edit_file": "编辑文件",
    "intent.use_tool": "使用 {tool}",

    "risk.destructive": "破坏性变更",
    "risk.deps": "可能修改依赖或本地工具",
    "risk.modify": "可能修改文件",
    "risk.unknown": "命令效果取决于参数",
    "risk.network": "可能访问网络",

    "scope.outside": "项目外部",
    "scope.protected": "受保护路径",

    "waiting.confirm": "等待中：需要审批",
    "waiting.select": "等待中：请选择",
    "waiting.input": "等待中：请回答",

    "placeholder.confirm": "请回应上方的审批提示...",
    "placeholder.select": "请在上方选择一个选项...",
    "placeholder.input": "请回答上方的提示...",
    "placeholder.busy": "代理正在工作中...",
    "placeholder.queue": "排队等待下一轮跟进...",
    "placeholder.idle": "输入消息...",

    "select.choice": "选项：",
    "select.type_number": "(输入编号)",
    "select.more": "还有 {count} 个选项...",
    "select.more_above": "\u2191 上方还有 {count} 个",
    "select.more_below": "\u2193 下方还有 {count} 个",
    "select.confirm_hint": "按 Enter 确认，Esc 取消",
    "select.navigate_hint": "使用 \u2191\u2193 导航，Enter 确认，Esc 取消",
    "select.multiselect_hint": "使用 \u2191\u2193 导航，空格 切换选中，Enter 确认，Esc 取消",
    "select.multiselect_empty": "请先使用空格选择至少一个选项。",
    "select.back_prev": "\u2190 返回上一题",

    "input.default": "默认值：",
    "input.value": "值：",
    "input.type_response": "(输入你的回答)",

    // 管理任务完成
    "managed.completed": "任务完成",
    "managed.completed.blocked": "任务受阻",
    "managed.completed.continuation": "任务需要继续",

    "cancelled": "[已取消] 操作已被用户取消",
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

/**
 * Translate a key, with optional variable interpolation.
 *
 * @example
 *   t("tool.generic.title", { tool: "mcp_search" })
 *   // en → "Execute mcp_search?"
 *   // zh → "执行 mcp_search？"
 */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const dict = translations[currentLocale];
  let text: string = dict[key] ?? translations.en[key] ?? key;

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }

  return text;
}
