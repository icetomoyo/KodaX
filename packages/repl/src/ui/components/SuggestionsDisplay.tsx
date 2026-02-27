/**
 * SuggestionsDisplay - Autocomplete suggestion display component - 自动补全建议显示组件
 *
 * Display autocomplete suggestions list with support for:
 * - Highlight selected item - 高亮选中项
 * - Scroll display (when suggestions exceed max visible) - 滚动显示（当建议数量超过最大可见数）
 * - Description display - 描述显示
 * - Type icons - 类型图标
 */

import React, { useMemo } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../contexts/UIStateContext.js";
import type { Suggestion } from "../types.js";
import { truncateByVisualWidth, getVisualWidth } from "../utils/textUtils.js";

export interface SuggestionsDisplayProps {
  /** Suggestion list - 建议列表 */
  suggestions: Suggestion[];
  /** Current selected index - 当前选中索引 */
  selectedIndex: number;
  /** Whether visible - 是否可见 */
  visible: boolean;
  /** Maximum visible count - 最大可见数量 */
  maxVisible?: number;
  /** Container width - 容器宽度 */
  width?: number;
  /** Whether to show count - 是否显示计数 */
  showCount?: boolean;
}

// Default width - 默认宽度
const DEFAULT_WIDTH = 80;
// Default max visible count - 默认最大可见数量
const DEFAULT_MAX_VISIBLE = 7;

// Type icon mapping - 类型图标映射
const TYPE_ICONS: Record<string, string> = {
  command: ">",
  file: "📄",
  history: "⏱",
  argument: "•",
  snippet: "◇",
};

/**
 * Calculate visible suggestion range (supports scrolling) - 计算可见的建议范围（支持滚动）
 */
function getVisibleRange(
  selectedIndex: number,
  total: number,
  maxVisible: number
): { start: number; end: number } {
  if (total <= maxVisible) {
    return { start: 0, end: total };
  }

  // Try to center selected item - 尽量让选中项在中间
  const halfVisible = Math.floor(maxVisible / 2);
  let start = selectedIndex - halfVisible;
  let end = start + maxVisible;

  // Boundary adjustment - 边界调整
  if (start < 0) {
    start = 0;
    end = maxVisible;
  } else if (end > total) {
    end = total;
    start = total - maxVisible;
  }

  return { start, end };
}

/**
 * Single suggestion item component - 单个建议项组件
 */
function SuggestionItem({
  suggestion,
  isSelected,
  width,
}: {
  suggestion: Suggestion;
  isSelected: boolean;
  width: number;
}) {
  const theme = useTheme();

  // Calculate width for each part - 计算各部分宽度
  const icon = suggestion.icon || (suggestion.type && TYPE_ICONS[suggestion.type]) || "";
  const iconWidth = icon ? getVisualWidth(icon) + 1 : 0;
  const textWidth = getVisualWidth(suggestion.displayText || suggestion.text);
  const descWidth = suggestion.description
    ? getVisualWidth(suggestion.description)
    : 0;

  // Calculate max available width for description - 计算描述最大可用宽度
  const maxTextWidth = Math.min(textWidth, width - iconWidth - 2);
  const remainingWidth = width - iconWidth - maxTextWidth - 3;
  const maxDescWidth = Math.max(0, remainingWidth);

  // Truncate text - 截断文本
  const displayText = truncateByVisualWidth(
    suggestion.displayText || suggestion.text,
    maxTextWidth
  );
  const displayDesc = suggestion.description
    ? truncateByVisualWidth(suggestion.description, maxDescWidth)
    : "";

  return (
    <Box>
      {/* Icon - 图标 */}
      {icon && (
        <Text color={isSelected ? theme.colors.accent : theme.colors.dim}>
          {icon}{" "}
        </Text>
      )}

      {/* Text - 文本 */}
      <Text
        color={isSelected ? theme.colors.primary : theme.colors.text}
        bold={isSelected}
      >
        {displayText}
      </Text>

      {/* Description - 描述 */}
      {displayDesc && (
        <>
          <Text> </Text>
          <Text color={theme.colors.dim}>
            {truncateByVisualWidth(suggestion.description || "", maxDescWidth)}
          </Text>
        </>
      )}

      {/* Selection indicator - 选中指示器 */}
      {isSelected && (
        <Text color={theme.colors.accent}>
          {" "}
          ◀
        </Text>
      )}
    </Box>
  );
}

/**
 * Suggestion display component - 建议显示组件
 */
export function SuggestionsDisplay({
  suggestions,
  selectedIndex,
  visible,
  maxVisible = DEFAULT_MAX_VISIBLE,
  width = DEFAULT_WIDTH,
  showCount = false,
}: SuggestionsDisplayProps): React.ReactElement | null {
  const theme = useTheme();

  // Don't render if not visible or no suggestions - 不可见或无建议时不渲染
  if (!visible || suggestions.length === 0) {
    return null;
  }

  // Calculate visible range - 计算可见范围
  const { start, end } = useMemo(
    () => getVisibleRange(selectedIndex, suggestions.length, maxVisible),
    [selectedIndex, suggestions.length, maxVisible]
  );

  const visibleSuggestions = suggestions.slice(start, end);

  return (
    <Box flexDirection="column" marginLeft={2}>
      {/* Scroll indicator - top - 滚动指示器 - 上方 */}
      {start > 0 && (
        <Text color={theme.colors.dim}>
          {"  "}▲ {start} more...
        </Text>
      )}

      {/* Suggestion list - 建议列表 */}
      {visibleSuggestions.map((suggestion, index) => {
        const actualIndex = start + index;
        const isSelected = actualIndex === selectedIndex;

        return (
          <SuggestionItem
            key={suggestion.id}
            suggestion={suggestion}
            isSelected={isSelected}
            width={width}
          />
        );
      })}

      {/* Scroll indicator - bottom - 滚动指示器 - 下方 */}
      {end < suggestions.length && (
        <Text color={theme.colors.dim}>
          {"  "}▼ {suggestions.length - end} more...
        </Text>
      )}

      {/* Count indicator - 计数指示器 */}
      {showCount && (
        <Text color={theme.colors.dim}>
          {selectedIndex + 1}/{suggestions.length}
        </Text>
      )}
    </Box>
  );
}
