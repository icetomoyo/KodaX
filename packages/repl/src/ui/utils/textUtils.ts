/**
 * Text Utilities - LRU Cache + Code Point Utilities - 文本工具：LRU 缓存 + Code Point 工具
 *
 * Provides text processing utilities including: - 提供文本处理相关的工具函数，包括：
 * - LRU cache for caching computation results - LRU 缓存用于缓存计算结果
 * - Unicode code point processing functions - Unicode code point 处理函数
 * - Visual width calculation - 视觉宽度计算
 */

// ============================================================================
// LRU Cache - LRU 缓存
// ============================================================================

/**
 * LRU (Least Recently Used) Cache - 最近最少使用缓存
 * Used to cache text processing results and avoid repeated computation - 用于缓存文本处理结果，避免重复计算
 */
export class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  /**
   * Get cached value and update LRU order - 获取缓存值，并更新 LRU 顺序
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }
    // Move to end (most recently used)
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * Set cached value - 设置缓存值
   */
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      // Remove existing to update position
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Evict least recently used (first entry)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  /**
   * Check if key exists - 检查 key 是否存在
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Delete key - 删除 key
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear cache - 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current size - 获取当前大小
   */
  get size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// Code Point Utilities - Code Point 工具
// ============================================================================

/**
 * Get code point length of a string - 获取字符串的 code point 长度
 * Properly handles emoji and other multi-byte characters - 正确处理 emoji 和其他多字节字符
 */
export function getCodePointLength(str: string): number {
  if (!str) return 0;

  // Use segmenter for proper grapheme cluster counting
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    return [...segmenter.segment(str)].length;
  }

  // Fallback: use Array.from which handles surrogate pairs but not ZWJ
  return [...str].length;
}

/**
 * Check if a character is a wide character (CJK or emoji) - 判断字符是否为宽字符（CJK 或 emoji）
 */
export function isWideChar(char: string): boolean {
  if (!char) return false;

  // Get first code point
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return false;

  // CJK ranges
  if (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Extension A
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility
    (codePoint >= 0x3040 && codePoint <= 0x309f) || // Hiragana
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) || // Katakana
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // Hangul
    (codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK Symbols
    (codePoint >= 0xff00 && codePoint <= 0xffef)    // Halfwidth/Fullwidth
  ) {
    return true;
  }

  // Emoji ranges (simplified check)
  if (
    (codePoint >= 0x1f600 && codePoint <= 0x1f64f) || // Emoticons
    (codePoint >= 0x1f300 && codePoint <= 0x1f5ff) || // Misc Symbols
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) || // Transport
    (codePoint >= 0x1f1e0 && codePoint <= 0x1f1ff) || // Flags
    (codePoint >= 0x2600 && codePoint <= 0x26ff) ||   // Misc symbols
    (codePoint >= 0x2700 && codePoint <= 0x27bf) ||   // Dingbats
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) || // Supplemental
    (codePoint >= 0x1fa00 && codePoint <= 0x1fa6f) || // Chess
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff)    // Symbols Extended
  ) {
    return true;
  }

  return false;
}

/**
 * Get visual width of a string - 获取字符串的视觉宽度
 * ASCII = 1, CJK/emoji = 2 - ASCII = 1, CJK/emoji = 2
 */
export function getVisualWidth(str: string): number {
  if (!str) return 0;

  let width = 0;

  // Use segmenter for proper grapheme cluster handling
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    for (const segment of segmenter.segment(str)) {
      width += isWideChar(segment.segment) ? 2 : 1;
    }
  } else {
    // Fallback
    for (const char of str) {
      width += isWideChar(char) ? 2 : 1;
    }
  }

  return width;
}

/**
 * Get character at specified code point position (grapheme cluster) - 获取指定 code point 位置的字符（grapheme cluster）
 */
export function getCharAtCodePoint(str: string, index: number): string {
  if (!str || index < 0) return "";

  // Use segmenter for proper grapheme cluster handling
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    const segments = [...segmenter.segment(str)];
    if (index >= segments.length) return "";
    return segments[index]!.segment;
  }

  // Fallback: use Array.from
  const chars = [...str];
  if (index >= chars.length) return "";
  return chars[index]!;
}

/**
 * Split string by code points - 按 code point 分割字符串
 */
export function splitByCodePoints(str: string): string[] {
  if (!str) return [];

  // Use segmenter for proper grapheme cluster handling
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    return [...segmenter.segment(str)].map((s) => s.segment);
  }

  // Fallback: use Array.from
  return [...str];
}

/**
 * Slice string by grapheme index - 按 grapheme 索引切片
 */
export function sliceByCodePoints(str: string, start: number, end?: number): string {
  return splitByCodePoints(str).slice(start, end).join("");
}

/**
 * Split a string around a visual column - 按视觉列切分字符串
 */
export function splitAtVisualColumn(
  str: string,
  visualCol: number
): { before: string; current: string; after: string } {
  const safeVisualCol = Math.max(0, visualCol);
  const chars = splitByCodePoints(str);

  let cursorIndex = 0;
  let currentWidth = 0;

  while (cursorIndex < chars.length) {
    const charWidth = isWideChar(chars[cursorIndex]!) ? 2 : 1;
    if (currentWidth + charWidth > safeVisualCol) {
      break;
    }

    currentWidth += charWidth;
    cursorIndex++;
  }

  return {
    before: chars.slice(0, cursorIndex).join(""),
    current: chars[cursorIndex] ?? "",
    after: chars.slice(cursorIndex + 1).join(""),
  };
}

/**
 * Truncate string by visual width - 按视觉宽度截断字符串
 */
export function truncateByVisualWidth(
  str: string,
  maxWidth: number,
  addEllipsis: boolean = false
): string {
  if (!str) return "";
  if (maxWidth <= 0) return "";

  const ellipsis = "…";
  const ellipsisWidth = 1;
  const targetWidth = addEllipsis ? maxWidth - ellipsisWidth : maxWidth;

  let result = "";
  let currentWidth = 0;

  const chars = splitByCodePoints(str);

  for (const char of chars) {
    const charWidth = isWideChar(char) ? 2 : 1;

    if (currentWidth + charWidth > targetWidth) {
      break;
    }

    result += char;
    currentWidth += charWidth;
  }

  if (addEllipsis && result.length < str.length) {
    result += ellipsis;
  }

  return result;
}

// ============================================================================
// Cache Instances - 缓存实例
// ============================================================================

/**
 * Visual width calculation cache - 视觉宽度计算缓存
 */
export const visualWidthCache = new LRUCache<string, number>(1000);

/**
 * Cached version of visual width calculation - 缓存版本的视觉宽度计算
 */
export function getVisualWidthCached(str: string): number {
  const cached = visualWidthCache.get(str);
  if (cached !== undefined) {
    return cached;
  }

  const width = getVisualWidth(str);
  visualWidthCache.set(str, width);
  return width;
}

/**
 * Visual layout interface - 视觉布局接口
 * Reference: Gemini CLI text-buffer.ts - VisualLayout
 */
export interface VisualLayout {
  /** All visual lines for rendering - 所有视觉行（用于渲染） */
  visualLines: string[];
  /** For each logical line: [[visualLineIndex, startColInLogical], ...] - 每个逻辑行 -> 视觉行索引 + 起始列的映射 */
  logicalToVisualMap: Array<Array<[number, number]>>;
  /** For each visual line: [logicalLineIndex, startColInLogical] - 每个视觉行 -> 逻辑行 + 起始列的映射 */
  visualToLogicalMap: Array<[number, number]>;
}

/**
 * Calculate visual line wrapping - 计算视觉行换行
 * Reference: Gemini CLI text-buffer.ts - calculateLayout
 *
 * @param logicalLines - Array of logical lines (split by \n) - 逻辑行数组（按 \n 分割）
 * @param viewportWidth - Terminal width for wrapping - 终端宽度（用于换行）
 * @param cursorRow - Current logical cursor row - 当前逻辑光标行
 * @param cursorCol - Current logical cursor column - 当前逻辑光标列
 * @returns VisualLayout with visual lines and coordinate mappings - 视觉布局，包含视觉行和坐标映射
 */
export function calculateVisualLayout(
  logicalLines: string[],
  viewportWidth: number,
  cursorRow: number,
  cursorCol: number
): VisualLayout {
  void cursorRow;
  void cursorCol;

  const visualLines: string[] = [];
  const logicalToVisualMap: Array<Array<[number, number]>> = [];
  const visualToLogicalMap: Array<[number, number]> = [];

  // Calculate for each logical line - 为每个逻辑行计算
  for (let logIndex = 0; logIndex < logicalLines.length; logIndex++) {
    const logicalLine = logicalLines[logIndex] || '';
    logicalToVisualMap[logIndex] = [];

    if (logicalLine.length === 0) {
      // Empty line becomes one empty visual line - 空行变成一个空视觉行
      visualLines.push('');
      const visualLineIndex = visualLines.length - 1;
      logicalToVisualMap[logIndex].push([visualLineIndex, 0]);
      visualToLogicalMap.push([logIndex, 0]);
      continue;
    }

    // Non-empty line: build visual lines - 非空行：构建视觉行
    let currentPosInLogical = 0;
    const chars = splitByCodePoints(logicalLine);

    while (currentPosInLogical < chars.length) {
      let currentChunk = '';
      let currentChunkVisualWidth = 0;
      let chunkEndInLogical = currentPosInLogical;
      let lastWordBreakPoint = -1; // Record space position for soft break - 记录空格位置用于软换行

      // Build current visual line (chunk) - 构建当前视觉行（块）
      for (let i = currentPosInLogical; i < chars.length; i++) {
        const char = chars[i]!;
        const charVisualWidth = isWideChar(char) ? 2 : 1;

        if (currentChunkVisualWidth + charVisualWidth > viewportWidth) {
          // Character would exceed viewport width - 字符会超出视口宽度
          if (
            lastWordBreakPoint >= 0 &&
            i - currentPosInLogical > 0
          ) {
            // Prefer soft break at word boundary - 优先在词边界软换行
            currentChunk = chars.slice(currentPosInLogical, lastWordBreakPoint).join('');
            currentChunkVisualWidth = chars.slice(currentPosInLogical, lastWordBreakPoint).reduce((sum, c) => sum + (isWideChar(c) ? 2 : 1), 0);
            chunkEndInLogical = lastWordBreakPoint;
          } else {
            // Hard break: take characters up to viewport width - 硬换行：取字符直到视口宽度
            // Or just current char if it alone exceeds viewport - 或者如果单个字符超宽也取它
            if (
              currentChunk.length === 0 &&
              charVisualWidth > viewportWidth
            ) {
              currentChunk = char;
              currentChunkVisualWidth = charVisualWidth;
              chunkEndInLogical = i + 1;
            }
          }
          break; // Break from inner loop to finalize this chunk - 退出内层循环完成此块
        }

        currentChunk += char;
        currentChunkVisualWidth += charVisualWidth;
        chunkEndInLogical = i + 1;

        // Check for word break opportunity (space) - 检查词边界机会（空格）
        if (char === ' ') {
          lastWordBreakPoint = i + 1; // Store position AFTER the space - 存储空格后的位置
        }
      }

      if (currentChunk.length > 0 || visualLines.length === 0) {
        // Save this visual line and its mappings - 保存此视觉行及其映射
        const logicalStartCol = currentPosInLogical;
        const visualLineIndex = visualLines.length;
        visualLines.push(currentChunk);
        logicalToVisualMap[logIndex].push([visualLineIndex, logicalStartCol]);
        visualToLogicalMap.push([logIndex, logicalStartCol]);
      }

      currentPosInLogical = chunkEndInLogical;
    }
  }

  return {
    visualLines,
    logicalToVisualMap,
    visualToLogicalMap,
  };
}

/**
 * Calculate visual cursor position from layout - 从布局计算视觉光标位置
 * Reference: Gemini CLI text-buffer.ts - calculateVisualCursorFromLayout
 *
 * @param layout - Visual layout to use for calculation - 用于计算的视觉布局
 * @param logicalCursor - [logicalRow, logicalCol] - 逻辑光标 [行, 列]
 * @returns [visualRow, visualCol] - Visual cursor [行, 列]
 */
export function calculateVisualCursorFromLayout(
  layout: VisualLayout,
  logicalCursor: [number, number]
): [number, number] {
  const { logicalToVisualMap, visualLines } = layout;

  // Handle empty text case - 处理空文本情况
  if (visualLines.length === 0) {
    return [0, 0];
  }

  const [cursorRow, cursorCol] = logicalCursor;
  const logicalLineMaps = logicalToVisualMap[cursorRow];

  if (!logicalLineMaps || logicalLineMaps.length === 0) {
    // Cursor on empty or non-existent line - 光标在空行或不存在的行
    return [0, 0];
  }

  // Find the visual line containing current logical column - 找到包含当前逻辑列的视觉行
  let bestMatch: [number, number] | undefined;
  for (const [visualIdx, startLogCol] of logicalLineMaps) {
    if (startLogCol <= cursorCol) {
      bestMatch = [visualIdx, startLogCol];
    } else {
      break; // Column is beyond current position - 列超出当前位置，停止
    }
  }

  const [visualLineIdx, startLogCol] = bestMatch ?? logicalLineMaps[0];
  const visualLine = visualLines[visualLineIdx] ?? '';

  // Visual column should be relative to the wrapped visual segment.
  const relativeLogicalCol = Math.max(0, cursorCol - startLogCol);
  const visualCol = getVisualWidth(sliceByCodePoints(visualLine, 0, relativeLogicalCol));

  return [visualLineIdx, visualCol];
}
