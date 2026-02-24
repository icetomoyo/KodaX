/**
 * LoadingIndicator - 加载和思考指示器组件
 *
 * 参考 Gemini CLI 的加载显示架构实现。
 * 提供多种加载状态可视化方式。
 */

import React, { useMemo, useState, useEffect } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";
import type { Theme } from "../types.js";

// === Types ===

export type LoadingIndicatorType = "spinner" | "dots" | "bar" | "simple";

export interface LoadingIndicatorProps {
  /** 主消息 */
  message?: string;
  /** 子消息 */
  subMessage?: string;
  /** 进度 (0-100) */
  progress?: number;
  /** 类型 */
  type?: LoadingIndicatorType;
  /** 紧凑模式 */
  compact?: boolean;
  /** 主题 */
  theme?: Theme;
}

export interface ThinkingIndicatorProps {
  /** 自定义消息 */
  message?: string;
  /** 显示旋转器 */
  showSpinner?: boolean;
  /** 主题 */
  theme?: Theme;
}

export interface SpinnerProps {
  /** 颜色 */
  color?: string;
  /** 主题 */
  theme?: Theme;
}

export interface DotsIndicatorProps {
  /** 标签 */
  label?: string;
  /** 点数量 */
  dotCount?: number;
  /** 主题 */
  theme?: Theme;
}

export interface ProgressIndicatorProps {
  /** 进度 (0-100) */
  progress: number;
  /** 标签 */
  label?: string;
  /** 条宽度 */
  width?: number;
  /** 主题 */
  theme?: Theme;
}

// === Constants ===

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// === Components ===

/**
 * 旋转器组件
 */
export const Spinner: React.FC<SpinnerProps> = ({ color, theme: themeProp }) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => clearInterval(timer);
  }, []);

  const spinnerColor = color ?? theme.colors.accent;

  return (
    <Text color={spinnerColor}>{SPINNER_FRAMES[frame]}</Text>
  );
};

/**
 * 点指示器组件
 */
export const DotsIndicator: React.FC<DotsIndicatorProps> = ({
  label,
  dotCount = 3,
  theme: themeProp,
}) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);
  const [dotPosition, setDotPosition] = useState(1);

  useEffect(() => {
    const timer = setInterval(() => {
      setDotPosition((p) => (p % dotCount) + 1);
    }, 300);

    return () => clearInterval(timer);
  }, [dotCount]);

  const dots = ".".repeat(dotPosition);

  return (
    <Box>
      {label && <Text color={theme.colors.text}>{label}</Text>}
      <Text color={theme.colors.accent}>{dots}</Text>
    </Box>
  );
};

/**
 * 进度指示器组件
 */
export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  progress,
  label,
  width = 20,
  theme: themeProp,
}) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);

  // Clamp progress to 0-100
  const clampedProgress = Math.max(0, Math.min(100, progress));
  const filledWidth = Math.round((clampedProgress / 100) * width);
  const emptyWidth = width - filledWidth;

  const filled = "█".repeat(filledWidth);
  const empty = "░".repeat(emptyWidth);

  return (
    <Box flexDirection="column">
      {label && (
        <Box marginBottom={1}>
          <Text color={theme.colors.text}>{label}</Text>
        </Box>
      )}
      <Box>
        <Text color={theme.colors.primary}>{filled}</Text>
        <Text dimColor>{empty}</Text>
        <Text> {clampedProgress}%</Text>
      </Box>
    </Box>
  );
};

/**
 * 思考指示器组件
 */
export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({
  message,
  showSpinner = false,
  theme: themeProp,
}) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);
  const displayMessage = message ?? "Thinking";

  return (
    <Box>
      {showSpinner && (
        <Box marginRight={1}>
          <Spinner theme={theme} />
        </Box>
      )}
      <Text color={theme.colors.accent}>{displayMessage}…</Text>
    </Box>
  );
};

/**
 * 加载指示器组件
 */
export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  message,
  subMessage,
  progress,
  type = "spinner",
  compact = false,
  theme: themeProp,
}) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);
  const displayMessage = message ?? "Loading";

  // 紧凑模式
  if (compact) {
    return (
      <Box>
        <Spinner theme={theme} />
        <Text color={theme.colors.text}> {displayMessage}…</Text>
      </Box>
    );
  }

  // 进度条模式
  if (type === "bar" && progress !== undefined) {
    return (
      <Box flexDirection="column">
        <ProgressIndicator progress={progress} label={displayMessage} theme={theme} />
        {subMessage && (
          <Box marginTop={1}>
            <Text dimColor>{subMessage}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // 点动画模式
  if (type === "dots") {
    return (
      <Box flexDirection="column">
        <DotsIndicator label={displayMessage} theme={theme} />
        {subMessage && (
          <Box marginTop={1}>
            <Text dimColor>{subMessage}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // 简单模式
  if (type === "simple") {
    return (
      <Box flexDirection="column">
        <Text color={theme.colors.accent}>{displayMessage}…</Text>
        {subMessage && (
          <Box marginTop={1}>
            <Text dimColor>{subMessage}</Text>
          </Box>
        )}
        {progress !== undefined && (
          <Box marginTop={1}>
            <Text dimColor>{progress}%</Text>
          </Box>
        )}
      </Box>
    );
  }

  // 默认旋转器模式
  return (
    <Box flexDirection="column">
      <Box>
        <Spinner theme={theme} />
        <Text color={theme.colors.text}> {displayMessage}…</Text>
        {progress !== undefined && (
          <Text dimColor> ({progress}%)</Text>
        )}
      </Box>
      {subMessage && (
        <Box marginTop={1}>
          <Text dimColor>{subMessage}</Text>
        </Box>
      )}
    </Box>
  );
};

// === Exports ===

export default LoadingIndicator;
