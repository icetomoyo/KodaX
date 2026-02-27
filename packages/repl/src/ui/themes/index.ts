/**
 * Theme System - 主题系统
 */

import type { Theme } from "../types.js";
import { darkTheme, minimalTheme } from "./dark.js";

export { darkTheme, minimalTheme };

export const themes: Record<string, Theme> = {
  dark: darkTheme,
  minimal: minimalTheme,
};

/**
 * Get theme - 获取主题
 */
export function getTheme(name: string = "dark"): Theme {
  return themes[name] ?? darkTheme;
}

/**
 * Get all theme names - 获取所有主题名称
 */
export function getThemeNames(): string[] {
  return Object.keys(themes);
}
