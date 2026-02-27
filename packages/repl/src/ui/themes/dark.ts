/**
 * Dark Theme - Default Theme - 暗色主题 - 默认主题
 */

import type { Theme } from "../types.js";

export const darkTheme: Theme = {
  name: "dark",
  colors: {
    primary: "#00D9FF", // Cyan
    secondary: "#8B5CF6", // Purple
    accent: "#F59E0B", // Amber
    text: "#E5E5E5", // Light gray
    dim: "#6B7280", // Gray
    success: "#10B981", // Green
    warning: "#F59E0B", // Amber
    error: "#EF4444", // Red
    info: "#3B82F6", // Blue
    hint: "#6366F1", // Indigo
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
    primary: "#FFFFFF",
    secondary: "#888888",
    accent: "#AAAAAA",
    text: "#CCCCCC",
    dim: "#666666",
    success: "#00FF00",
    warning: "#FFFF00",
    error: "#FF0000",
    info: "#0088FF", // Blue
    hint: "#8800FF", // Purple
  },
  symbols: {
    prompt: "$",
    success: "+",
    error: "-",
    warning: "?",
    spinner: ["-", "\\", "|", "/"],
  },
};
