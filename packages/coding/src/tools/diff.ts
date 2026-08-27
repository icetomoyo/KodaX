/**
 * KodaX Diff Utility
 *
 * Simple diff display for file changes - 文件变更的简单差异显示
 */

/** Single aligned operation between the two line sequences. */
interface DiffOp {
  kind: 'equal' | 'remove' | 'add';
  line: string;
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Upper bound on old×new cells for the exact LCS table (~4 MB of Uint32).
 * Above it, the middle falls back to block replacement: every old line is
 * removed, then every new line added — still grouped, just not matched.
 */
const MIDDLE_LCS_CELL_CAP = 1_000_000;

/**
 * Matched (oldIdx, newIdx) pairs inside the trimmed middle via DP LCS.
 * Returns [] when either side is empty or the pair budget is exceeded.
 */
function matchedPairs(oldMid: string[], newMid: string[]): Array<[number, number]> {
  const n = oldMid.length;
  const m = newMid.length;
  if (n === 0 || m === 0 || n * m > MIDDLE_LCS_CELL_CAP) {
    return [];
  }

  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Uint32Array(m + 1));
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldMid[i] === newMid[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Full op alignment: common prefix/suffix are anchors, the middle goes
 * through LCS. Within each gap between consecutive matches, all removals
 * precede all additions — the git/codex display convention.
 */
function alignOps(oldLines: string[], newLines: string[]): DiffOp[] {
  let prefix = 0;
  while (
    prefix < oldLines.length && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > prefix && newEnd > prefix
    && oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  const ops: DiffOp[] = [];
  for (let k = 0; k < prefix; k++) {
    ops.push({ kind: 'equal', line: oldLines[k] });
  }

  const oldMid = oldLines.slice(prefix, oldEnd);
  const newMid = newLines.slice(prefix, newEnd);
  let oi = 0;
  let ni = 0;
  for (const [pi, pj] of matchedPairs(oldMid, newMid)) {
    while (oi < pi) {
      ops.push({ kind: 'remove', line: oldMid[oi++] });
    }
    while (ni < pj) {
      ops.push({ kind: 'add', line: newMid[ni++] });
    }
    ops.push({ kind: 'equal', line: oldMid[pi] });
    oi++;
    ni++;
  }
  while (oi < oldMid.length) {
    ops.push({ kind: 'remove', line: oldMid[oi++] });
  }
  while (ni < newMid.length) {
    ops.push({ kind: 'add', line: newMid[ni++] });
  }

  for (let k = oldEnd; k < oldLines.length; k++) {
    ops.push({ kind: 'equal', line: oldLines[k] });
  }
  return ops;
}

/**
 * Window ops into hunks with at most `contextLines` context on each side
 * of a change; regions separated by ≥ contextLines equal lines become
 * separate hunks. Mirrors the header/count semantics of the previous
 * greedy implementation.
 */
function buildHunks(ops: DiffOp[], contextLines: number): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let pendingContext: string[] = [];
  let equalRun = 0;
  let oldNo = 0;
  let newNo = 0;

  for (const op of ops) {
    if (op.kind === 'equal') {
      if (hunk) {
        if (contextLines === 0) {
          hunks.push(hunk);
          hunk = null;
          pendingContext = [];
        } else {
          hunk.lines.push(`  ${op.line}`);
          hunk.oldCount++;
          hunk.newCount++;
          equalRun++;
          if (equalRun >= contextLines) {
            hunks.push(hunk);
            hunk = null;
            pendingContext = [];
          }
        }
      } else {
        pendingContext.push(`  ${op.line}`);
        if (pendingContext.length > contextLines) {
          pendingContext.shift();
        }
      }
      oldNo++;
      newNo++;
    } else {
      if (!hunk) {
        const lead = pendingContext.length;
        hunk = {
          oldStart: oldNo - lead + 1,
          oldCount: lead,
          newStart: newNo - lead + 1,
          newCount: lead,
          lines: [...pendingContext],
        };
        pendingContext = [];
        equalRun = 0;
      } else {
        equalRun = 0;
      }
      if (op.kind === 'remove') {
        hunk.lines.push(`- ${op.line}`);
        hunk.oldCount++;
        oldNo++;
      } else {
        hunk.lines.push(`+ ${op.line}`);
        hunk.newCount++;
        newNo++;
      }
    }
  }
  if (hunk) {
    hunks.push(hunk);
  }
  return hunks;
}

/**
 * Generate a unified diff-like output - 生成类似 unified diff 的输出
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  contextLines: number = 3
): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const normalizedContextLines = Math.max(0, Math.floor(contextLines));
  const hunks = buildHunks(alignOps(oldLines, newLines), normalizedContextLines);
  if (hunks.length === 0) {
    return ''; // No changes - 无变更
  }

  const lines: string[] = [];
  lines.push(`--- ${filePath}`);
  lines.push(`+++ ${filePath}`);

  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    lines.push(...hunk.lines);
  }

  return lines.join('\n');
}

/**
 * Generate a simple summary diff for small changes - 为小变更生成简单摘要
 */
export function generateSimpleDiff(
  oldStr: string,
  newStr: string,
  maxLines: number = 20
): { removed: string[]; added: string[] } {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // For very small changes, show exact diff - 对于非常小的变更，显示精确差异
  if (oldLines.length <= maxLines && newLines.length <= maxLines) {
    return {
      removed: oldLines,
      added: newLines
    };
  }

  // For larger changes, show summary - 对于较大的变更，显示摘要
  return {
    removed: [`(${oldLines.length} lines)`],
    added: [`(${newLines.length} lines)`]
  };
}

/**
 * Format diff for display - 格式化差异用于显示
 */
export function formatDiffOutput(diff: string): string {
  if (!diff) return '';

  const lines = diff.split('\n');
  const formatted = lines.map(line => {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
      return `\x1b[36m${line}\x1b[0m`; // Cyan for headers - 标题用青色
    } else if (line.startsWith('-')) {
      return `\x1b[31m${line}\x1b[0m`; // Red for removed - 删除用红色
    } else if (line.startsWith('+')) {
      return `\x1b[32m${line}\x1b[0m`; // Green for added - 添加用绿色
    }
    return line;
  });

  return formatted.join('\n');
}

/**
 * Count lines changed - 统计变更行数
 */
export function countChanges(diff: string): { added: number; removed: number } {
  const lines = diff.split('\n');
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('++')) {
      added++;
    } else if (line.startsWith('-') && !line.startsWith('--')) {
      removed++;
    }
  }

  return { added, removed };
}
