/**
 * KodaX Diff Utility
 *
 * Simple diff display for file changes - 文件变更的简单差异显示
 */

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

  // Find diff hunks - 找出差异块
  const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> = [];

  let oldIdx = 0;
  let newIdx = 0;
  let hunkStart: number | null = null;
  let currentHunkLines: string[] = [];
  let hunkOldStart = 0;
  let hunkNewStart = 0;
  let oldCount = 0;
  let newCount = 0;

  // Simple LCS-based diff - 简单的基于 LCS 的差异算法
  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (oldIdx < oldLines.length && newIdx < newLines.length && oldLines[oldIdx] === newLines[newIdx]) {
      // Lines match - 行匹配
      if (hunkStart !== null) {
        currentHunkLines.push(`  ${oldLines[oldIdx]}`);
        oldCount++;
        newCount++;
      }
      oldIdx++;
      newIdx++;
    } else {
      // Lines differ - 行不同
      if (hunkStart === null) {
        // Start new hunk with context - 开始新的差异块，包含上下文
        hunkStart = Math.max(0, oldIdx - contextLines);
        hunkOldStart = hunkStart + 1; // 1-indexed
        hunkNewStart = Math.max(0, newIdx - contextLines) + 1;
        currentHunkLines = [];
        oldCount = 0;
        newCount = 0;

        // Add context lines before - 添加前面的上下文行
        for (let i = Math.max(0, oldIdx - contextLines); i < oldIdx; i++) {
          currentHunkLines.push(`  ${oldLines[i]}`);
          oldCount++;
          newCount++;
        }
      }

      if (oldIdx < oldLines.length && (newIdx >= newLines.length || oldLines[oldIdx] !== newLines[newIdx])) {
        // Line removed - 行被删除
        currentHunkLines.push(`- ${oldLines[oldIdx]}`);
        oldCount++;
        oldIdx++;
      }

      if (newIdx < newLines.length && (oldIdx >= oldLines.length || oldLines[oldIdx] !== newLines[newIdx])) {
        // Line added - 行被添加
        currentHunkLines.push(`+ ${newLines[newIdx]}`);
        newCount++;
        newIdx++;
      }
    }

    // End hunk if we have enough matching lines after - 如果后面有足够的匹配行，结束差异块
    if (hunkStart !== null) {
      let matchingAfter = 0;
      for (let i = 0; i < contextLines && oldIdx + i < oldLines.length && newIdx + i < newLines.length; i++) {
        if (oldLines[oldIdx + i] === newLines[newIdx + i]) {
          matchingAfter++;
        }
      }

      if (matchingAfter === contextLines || (oldIdx >= oldLines.length && newIdx >= newLines.length)) {
        // Add context lines after - 添加后面的上下文行
        for (let i = 0; i < matchingAfter && oldIdx + i < oldLines.length; i++) {
          currentHunkLines.push(`  ${oldLines[oldIdx + i]}`);
          oldCount++;
          newCount++;
        }

        hunks.push({
          oldStart: hunkOldStart,
          oldCount,
          newStart: hunkNewStart,
          newCount,
          lines: currentHunkLines
        });

        hunkStart = null;
        currentHunkLines = [];
        oldIdx += matchingAfter;
        newIdx += matchingAfter;
      }
    }
  }

  // Handle remaining hunk - 处理剩余的差异块
  if (hunkStart !== null && currentHunkLines.length > 0) {
    hunks.push({
      oldStart: hunkOldStart,
      oldCount,
      newStart: hunkNewStart,
      newCount,
      lines: currentHunkLines
    });
  }

  // Build output - 构建输出
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
