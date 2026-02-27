/**
 * Dark Theme - Warp-inspired color scheme
 *
 * Inspired by Warp.dev terminal - 参考 Warp.dev 终端配色
 *
 * Key characteristics:
 * - Deep dark background (almost black)
 * - Cyan/teal accent for primary elements
 * - Good contrast, soft on eyes
 */

import type { Theme } from "../types.js";

export const darkTheme: Theme = {
  name: "dark",
  colors: {
    // Warp uses cyan/teal for primary accent - Warp 使用青色/蓝绿色作为主强调色
    primary: "#01A4FF", // Warp cyan - Warp 青色
    secondary: "#8B5CF6", // Purple for variety
    accent: "#F59E0B", // Amber for warnings/highlights
    // Text colors - soft but readable - 文本颜色 - 柔和但可读
    text: "#CCCCCC", // Light gray text - 浅灰色文本
    dim: "#666666", // Dimmed text - 暗淡文本
    success: "#19C37D", // Warp green - Warp 绿色
    warning: "#FF9F43", // Orange-yellow - 橙黄色
    error: "#FF5F56", // Soft red (like macOS buttons) - 柔和红色
    info: "#01A4FF", // Same as primary - 与主色相同
    hint: "#8B5CF6", // Purple hint - 紫色提示
    // Backgrounds - deep dark, not colored - 背景色 - 深色，不带色调
    background: "#0D0D0D", // Almost pure black - 接近纯黑
    inputBackground: "#1A1A1A", // Slightly lighter for input - 稍浅用于输入区
  },
  symbols: {
    prompt: ">",
    success: "✓",
    error: "✗",
    warning: "!",
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  },
};

export const minimalTheme: Theme = {
  name: "minimal",
  colors: {
    primary: "#01A4FF",
    secondary: "#8B5CF6",
    accent: "#F59E0B",
    text: "#CCCCCC",
    dim: "#666666",
    success: "#19C37D",
    warning: "#FF9F43",
    error: "#FF5F56",
    info: "#01A4FF",
    hint: "#8B5CF6",
    background: "#0D0D0D",
    inputBackground: "#1A1A1A",
  },
  symbols: {
    prompt: "$",
    success: "+",
    error: "-",
    warning: "?",
    spinner: ["-", "\\", "|", "/"],
  },
};
