/**
 * KodaX UI - Ink-based Terminal UI Component Library - Ink-based 终端 UI 组件库
 *
 * Provides multiline input, message list, status bar and other components - 提供多行输入、消息列表、状态栏等组件
 */

// Root component - 根组件
export { App, SimpleApp } from "./App.js";
export type { AppHandle } from "./App.js";

// Ink REPL adapter - Ink REPL 适配器
export { runInkInteractiveMode } from "./InkREPL.js";
export type { InkREPLOptions } from "./InkREPL.js";

// CLI event handler - CLI 事件处理器
export { createCliEvents } from "./cli-events.js";

// Components - 组件
export * from "./components/index.js";

// Hooks
export * from "./hooks/index.js";

// Utils
export * from "./utils/index.js";

// Themes
export * from "./themes/index.js";

// Types
export * from "./types.js";
