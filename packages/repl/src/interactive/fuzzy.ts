/**
 * Fuzzy Matching Algorithm - 模糊匹配算法
 *
 * Provides fuzzy string matching with scoring for autocomplete ranking.
 * 为自动补全提供带评分的模糊字符串匹配。
 *
 * Scoring rules:
 * - Consecutive match: +10 points/char
 * - First character match: +5 points
 * - Case exact match: +2 points
 * - Skip penalty: -1 point/skipped char
 */

/**
 * Fuzzy match result - 模糊匹配结果
 */
export interface FuzzyMatchResult {
  /** Whether the pattern matched - 是否匹配 */
  matched: boolean;
  /** Match score (0-100+) - 匹配评分 */
  score: number;
  /** Highlight positions (indices in target) - 高亮位置（目标字符串中的索引） */
  highlights: number[];
}

/**
 * Perform fuzzy matching between pattern and target
 * 执行模式和目标之间的模糊匹配
 *
 * @param pattern - Search pattern (user input) - 搜索模式（用户输入）
 * @param target - Target string to match against - 目标字符串
 * @returns Match result with score and highlights - 带评分和高亮的匹配结果
 *
 * @example
 * ```typescript
 * fuzzyMatch('hw', 'hello world')  // { matched: true, score: 15, highlights: [0, 6] }
 * fuzzyMatch('hwl', 'hello world') // { matched: true, score: 24, highlights: [0, 6, 7] }
 * fuzzyMatch('xyz', 'hello world') // { matched: false, score: 0, highlights: [] }
 * ```
 */
export function fuzzyMatch(pattern: string, target: string): FuzzyMatchResult {
  // Empty pattern matches everything with score 0 - 空模式匹配所有，评分为 0
  if (!pattern) {
    return { matched: true, score: 0, highlights: [] };
  }

  // Pattern longer than target can't match - 模式比目标长则无法匹配
  if (pattern.length > target.length) {
    return { matched: false, score: 0, highlights: [] };
  }

  const patternLower = pattern.toLowerCase();
  const targetLower = target.toLowerCase();

  let score = 0;
  let lastIndex = -1;
  const highlights: number[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const char = patternLower[i];
    if (char === undefined) continue;

    // Find character in target, starting after last match position
    // 从上次匹配位置之后开始查找字符
    const index = targetLower.indexOf(char, lastIndex + 1);

    if (index === -1) {
      // Character not found - pattern doesn't match
      // 字符未找到 - 模式不匹配
      return { matched: false, score: 0, highlights: [] };
    }

    // Scoring logic - 评分逻辑
    if (index === lastIndex + 1) {
      // Consecutive match (e.g., 'he' in 'hello') - 连续匹配
      score += 10;
    } else if (index === 0) {
      // First character match - 首字符匹配
      score += 5;
    } else {
      // Skipped characters penalty - 跳过字符惩罚
      score -= 1;
    }

    // Case exact match bonus - 大小写精确匹配奖励
    if (target[index] === pattern[i]) {
      score += 2;
    }

    highlights.push(index);
    lastIndex = index;
  }

  // Bonus for matching start of word boundaries - 单词边界匹配奖励
  const wordBoundaryBonus = calculateWordBoundaryBonus(target, highlights);
  score += wordBoundaryBonus;

  return { matched: true, score, highlights };
}

/**
 * Calculate bonus for matches at word boundaries
 * 计算单词边界匹配的奖励
 *
 * Word boundaries include: start of string, after space, after hyphen, after underscore
 * 单词边界包括：字符串开头、空格后、连字符后、下划线后
 */
function calculateWordBoundaryBonus(target: string, highlights: number[]): number {
  let bonus = 0;

  for (const pos of highlights) {
    if (pos === 0) {
      // Start of string - 字符串开头
      bonus += 3;
    } else if (pos > 0) {
      const prevChar = target[pos - 1];
      if (prevChar === ' ' || prevChar === '-' || prevChar === '_') {
        // After word boundary - 单词边界后
        bonus += 2;
      }
    }
  }

  return bonus;
}

/**
 * Candidate item with text property for sorting
 * 带有 text 属性的候选项，用于排序
 */
export interface ScoredCandidate {
  text: string;
  /** Internal score field (added during sorting) - 内部评分字段（排序时添加） */
  _fuzzyScore?: number;
  /** Internal highlights field (added during sorting) - 内部高亮字段（排序时添加） */
  _fuzzyHighlights?: number[];
}

/**
 * Sort candidates by fuzzy match score (highest first)
 * 按模糊匹配评分排序候选项（从高到低）
 *
 * @param pattern - Search pattern - 搜索模式
 * @param candidates - Array of candidates to sort - 候选项数组
 * @param minScore - Minimum score threshold (default: 0) - 最低评分阈值
 * @returns Sorted and filtered candidates - 排序并过滤后的候选项
 *
 * @example
 * ```typescript
 * const candidates = [
 *   { text: 'help' },
 *   { text: 'history' },
 *   { text: 'hello' },
 * ];
 * const sorted = sortCandidates('he', candidates);
 * // Returns candidates sorted by score, with _fuzzyScore added
 * ```
 */
export function sortCandidates<T extends ScoredCandidate>(
  pattern: string,
  candidates: T[],
  minScore: number = 0
): T[] {
  if (!pattern) {
    // No pattern: return all candidates without score (prefix match mode)
    // 无模式：返回所有候选项，不添加评分（前缀匹配模式）
    return candidates;
  }

  return candidates
    .map((c) => {
      const result = fuzzyMatch(pattern, c.text);
      return {
        ...c,
        _fuzzyScore: result.matched ? result.score : -1, // -1 for non-matches
        _fuzzyHighlights: result.highlights,
      };
    })
    .filter((c) => (c._fuzzyScore ?? -1) >= minScore)
    .sort((a, b) => (b._fuzzyScore ?? 0) - (a._fuzzyScore ?? 0));
}

/**
 * Apply prefix matching (simple startsWith check)
 * 应用前缀匹配（简单的 startsWith 检查）
 *
 * Used as fallback when fuzzy matching is disabled or for exact prefix matches.
 * 当模糊匹配禁用或用于精确前缀匹配时作为回退。
 */
export function prefixMatch(pattern: string, target: string): boolean {
  if (!pattern) return true;
  return target.toLowerCase().startsWith(pattern.toLowerCase());
}

/**
 * Filter candidates by prefix match
 * 通过前缀匹配过滤候选项
 */
export function filterByPrefix<T extends { text: string }>(
  pattern: string,
  candidates: T[]
): T[] {
  if (!pattern) return candidates;

  const patternLower = pattern.toLowerCase();
  return candidates.filter((c) =>
    c.text.toLowerCase().startsWith(patternLower)
  );
}

/**
 * Combined matching: try prefix first, then fuzzy
 * 组合匹配：先尝试前缀匹配，再尝试模糊匹配
 *
 * Prefix matches get higher priority than fuzzy matches.
 * 前缀匹配比模糊匹配有更高的优先级。
 */
export function combinedMatch(pattern: string, target: string): FuzzyMatchResult & { isPrefix: boolean } {
  const isPrefix = prefixMatch(pattern, target);

  if (isPrefix) {
    // Prefix match gets bonus score - 前缀匹配获得奖励评分
    const highlights = pattern
      ? Array.from({ length: pattern.length }, (_, i) => i)
      : [];
    return {
      matched: true,
      score: 100 + pattern.length * 10, // High score for prefix match
      highlights,
      isPrefix: true,
    };
  }

  const fuzzyResult = fuzzyMatch(pattern, target);
  return { ...fuzzyResult, isPrefix: false };
}

/**
 * Sort with combined matching (prefix priority)
 * 使用组合匹配排序（前缀优先）
 */
export function sortCandidatesCombined<T extends ScoredCandidate>(
  pattern: string,
  candidates: T[],
  minScore: number = 0
): T[] {
  if (!pattern) return candidates;

  return candidates
    .map((c) => {
      const result = combinedMatch(pattern, c.text);
      return {
        ...c,
        _fuzzyScore: result.matched ? result.score : -1, // -1 for non-matches
        _fuzzyHighlights: result.highlights,
      };
    })
    .filter((c) => (c._fuzzyScore ?? -1) >= minScore)
    .sort((a, b) => {
      const scoreDiff = (b._fuzzyScore ?? 0) - (a._fuzzyScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      // Tie-breaker: shorter text first - 同分时：较短文本优先
      return a.text.length - b.text.length;
    });
}
