/**
 * KodaX UI - Ink-based 终端 UI 组件库
 *
 * 提供多行输入、消息列表、状态栏等组件
 */

// 根组件
export { App, SimpleApp } from "./App.js";
export type { AppHandle } from "./App.js";

// Ink REPL 适配器
export { runInkInteractiveMode } from "./InkREPL.js";
export type { InkREPLOptions } from "./InkREPL.js";

// 组件
export * from "./components/index.js";

// Hooks
export * from "./hooks/index.js";

// Utils
export * from "./utils/index.js";

// Themes
export * from "./themes/index.js";

// Types
export * from "./types.js";
