/**
 * Text Utilities - LRU Cache + Code Point Utilities
 *
 * 提供文本处理相关的工具函数，包括：
 * - LRU 缓存用于缓存计算结果
 * - Unicode code point 处理函数
 * - 视觉宽度计算
 */

// ============================================================================
// LRU Cache
// ============================================================================

/**
 * LRU (Least Recently Used) Cache
 * 用于缓存文本处理结果，避免重复计算
 */
export class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  /**
   * 获取缓存值，并更新 LRU 顺序
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
   * 设置缓存值
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
   * 检查 key 是否存在
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * 删除 key
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取当前大小
   */
  get size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// Code Point Utilities
// ============================================================================

/**
 * 获取字符串的 code point 长度
 * 正确处理 emoji 和其他多字节字符
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
 * 判断字符是否为宽字符（CJK 或 emoji）
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
 * 获取字符串的视觉宽度
 * ASCII = 1, CJK/emoji = 2
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
 * 获取指定 code point 位置的字符（grapheme cluster）
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
 * 按code point 分割字符串
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
 * 按视觉宽度截断字符串
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
// Cache Instances
// ============================================================================

/**
 * 视觉宽度计算缓存
 */
export const visualWidthCache = new LRUCache<string, number>(1000);

/**
 * 缓存版本的视觉宽度计算
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
