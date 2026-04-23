/**
 * multi_edit — P2a (v0.7.26).
 *
 * Apply multiple exact-or-normalized-text replacements to a single file
 * in one tool call. Modelled after Claude Code / opencode's MultiEdit:
 *   - All edits applied sequentially (edit[i+1] sees result of edit[i])
 *   - Atomic — if ANY edit fails to match, NO edits are written to disk
 *   - Same matching semantics as `edit` (exact → normalized fallback)
 *   - Single file read + single file write regardless of edit count
 *
 * Rationale: the "write skeleton + N edits" pattern for large files is
 * only practical if N edits don't cost N tool-call round-trips. With
 * `multi_edit` the LLM batches the skeleton-fill step into one call,
 * making the skeleton + edit workflow cheap enough to be the default
 * rather than a grudging fallback. This is the primary incentive to
 * prevent the "LLM runs Python to generate files" escape pattern.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import type { KodaXToolExecutionContext } from '../types.js';
import { getFileBackups } from './write.js';
import { generateDiff, countChanges } from './diff.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { formatDiffPreview } from './truncate.js';
import {
  detectPreferredLineEnding,
  findUniqueNormalizedBlockMatch,
} from './text-anchor.js';

const MAX_SAFE_EDIT_CHARS = 64 * 1024;
const MAX_SAFE_EDIT_LINES = 400;

interface MultiEditOperation {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export async function toolMultiEdit(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const filePath = resolveExecutionPath(input.path as string, ctx);
  if (!fsSync.existsSync(filePath)) {
    return `[Tool Error] multi_edit: File not found: ${filePath}`;
  }

  const rawEdits = input.edits;
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return '[Tool Error] multi_edit: `edits` must be a non-empty array of { old_string, new_string, replace_all? } objects.';
  }

  const edits: MultiEditOperation[] = [];
  for (let i = 0; i < rawEdits.length; i += 1) {
    const raw = rawEdits[i];
    if (!raw || typeof raw !== 'object') {
      return `[Tool Error] multi_edit: edits[${i}] must be an object with old_string and new_string.`;
    }
    const oldStr = (raw as { old_string?: unknown }).old_string;
    const newStr = (raw as { new_string?: unknown }).new_string;
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
      return `[Tool Error] multi_edit: edits[${i}] requires string old_string and new_string.`;
    }
    if (oldStr.length === 0) {
      return `[Tool Error] multi_edit: edits[${i}].old_string must be non-empty.`;
    }
    if (oldStr === newStr) {
      return `[Tool Error] multi_edit: edits[${i}] has identical old_string and new_string (no-op).`;
    }
    const sizeFail = getSizeFailure(filePath, oldStr, newStr, i);
    if (sizeFail) return sizeFail;
    edits.push({
      old_string: oldStr,
      new_string: newStr,
      replace_all: (raw as { replace_all?: unknown }).replace_all === true,
    });
  }

  const originalContent = await fs.readFile(filePath, 'utf-8');

  // Apply sequentially in memory. Any failure aborts the whole batch
  // with NO disk write — atomicity is the main contract this tool
  // provides beyond N individual `edit` calls.
  let runningContent = originalContent;
  const replacementCounts: number[] = [];
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i]!;
    const applied = applyOneEdit(runningContent, edit, i, originalContent);
    if ('error' in applied) {
      return applied.error;
    }
    runningContent = applied.content;
    replacementCounts.push(applied.replacements);
  }

  if (runningContent === originalContent) {
    return `[Tool Error] multi_edit: all ${edits.length} edits produced no net change. Check old_string / new_string values.`;
  }

  ctx.backups.set(filePath, originalContent);
  getFileBackups().set(filePath, originalContent);
  await fs.writeFile(filePath, runningContent, 'utf-8');

  const diff = generateDiff(originalContent, runningContent, filePath);
  const changes = countChanges(diff);
  const totalReplacements = replacementCounts.reduce((a, b) => a + b, 0);

  let result = `File edited: ${filePath}`;
  result += ` (${edits.length} edits, ${totalReplacements} replacement${totalReplacements === 1 ? '' : 's'})`;
  result += `\n  (+${changes.added} lines, -${changes.removed} lines)`;

  if (diff) {
    const preview = await formatDiffPreview({ diff, toolName: 'multi_edit', filePath, ctx });
    result += `\n\n${preview}`;
  }

  return result;
}

function applyOneEdit(
  content: string,
  edit: MultiEditOperation,
  index: number,
  originalContent: string,
): { content: string; replacements: number } | { error: string } {
  const { old_string: oldStr, new_string: newStr, replace_all: replaceAll } = edit;
  const exactMatches = findExactMatchPositions(content, oldStr);

  if (exactMatches.length > 0) {
    if (exactMatches.length > 1 && !replaceAll) {
      return {
        error:
          `[Tool Error] multi_edit: edits[${index}] matched ${exactMatches.length} places `
          + `(lines ${formatLineList(exactMatches)}). `
          + 'Widen old_string to include nearby unique context '
          + '(a heading, function name, or distinctive comment), '
          + 'or set replace_all=true if all matches should change. '
          + 'Do not just shorten the anchor — shorter anchors match more, not fewer.',
      };
    }
    return {
      content: replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr),
      replacements: replaceAll ? exactMatches.length : 1,
    };
  }

  // Exact match missed — try normalized fallback (same rule as `edit`)
  const normalized = findUniqueNormalizedBlockMatch(content, oldStr);
  if (normalized.status === 'ambiguous') {
    const blockLocations = normalized.ranges.map((r) => r.startLine);
    return {
      error:
        `[Tool Error] multi_edit: edits[${index}] matched ${normalized.ranges.length} normalized blocks `
        + `(lines ${formatLineList(blockLocations)}). `
        + 'Include more surrounding lines so the old_string spans a unique region, '
        + 'or set replace_all=true if all matches should change.',
    };
  }
  if (normalized.status === 'missing') {
    // Anchor-consumed-by-prior-edit diagnostic. When `index > 0` and the
    // anchor is present in the original file but gone from the current
    // running content, the failure is certainly caused by an earlier
    // edit's replacement range covering this anchor. Give the LLM a
    // targeted hint instead of the generic "not found" so the retry
    // doesn't have to guess. This is the "Scout deletes a region that
    // includes a downstream anchor" mistake (observed in Scout +
    // multi_edit slide-deck deletion flows).
    if (index > 0) {
      const presentInOriginal =
        findExactMatchPositions(originalContent, oldStr).length > 0
        || findUniqueNormalizedBlockMatch(originalContent, oldStr).status !== 'missing';
      if (presentInOriginal) {
        const prior = index === 1 ? 'edits[0]' : `edits[0..${index - 1}]`;
        return {
          error:
            `[Tool Error] multi_edit: edits[${index}] old_string is present in the original file but `
            + `was consumed by ${prior}'s replacement region in this batch. `
            + 'Shrink that earlier edit to preserve this anchor, '
            + 'or pick a different anchor still present after it.',
        };
      }
    }
    return {
      error:
        `[Tool Error] multi_edit: edits[${index}] old_string not found. `
        + 'Common cause: the anchor was copied from a narrow `read` window and has typos or '
        + 'whitespace drift vs the actual file, OR it was never in the file to begin with. '
        + 'Re-read a wider window where you expect the anchor and copy an exact slice.',
    };
  }
  const replacement = normalizeReplacementLineEndings(newStr, detectPreferredLineEnding(content));
  return {
    content:
      content.slice(0, normalized.range.start)
      + replacement
      + content.slice(normalized.range.end),
    replacements: 1,
  };
}

function getSizeFailure(
  filePath: string,
  oldString: string,
  newString: string,
  index: number,
): string | undefined {
  const oldLines = oldString.split(/\r\n|\n|\r/).length;
  const newLines = newString.split(/\r\n|\n|\r/).length;
  if (
    oldString.length > MAX_SAFE_EDIT_CHARS
    || newString.length > MAX_SAFE_EDIT_CHARS
    || oldLines > MAX_SAFE_EDIT_LINES
    || newLines > MAX_SAFE_EDIT_LINES
  ) {
    return (
      `[Tool Error] multi_edit: edits[${index}] for ${filePath} is too large for safe exact replacement. `
      + 'Split it into smaller edits.'
    );
  }
  return undefined;
}

/**
 * Find every exact occurrence of `needle` in `content` and return the 1-based
 * line number of each. Empty needle returns []. Used both for the replace
 * arithmetic and for enriching "matched N places" errors with locations so
 * the LLM can see WHY its anchor is ambiguous.
 */
export function findExactMatchPositions(content: string, needle: string): number[] {
  if (!needle) return [];
  const positions: number[] = [];
  let index = content.indexOf(needle);
  while (index !== -1) {
    positions.push(charIndexToLineNumber(content, index));
    index = content.indexOf(needle, index + needle.length);
  }
  return positions;
}

function charIndexToLineNumber(content: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10 /* \n */) line += 1;
  }
  return line;
}

/**
 * Format a list of line numbers like `"45 and 234"` or `"3, 8, and 15"`.
 * Caps at 3 listed locations with a `"and N more"` tail so very-high-match
 * errors don't balloon the error string.
 */
export function formatLineList(lineNumbers: readonly number[]): string {
  const MAX_LISTED = 3;
  if (lineNumbers.length === 0) return '';
  if (lineNumbers.length === 1) return String(lineNumbers[0]);
  if (lineNumbers.length === 2) return `${lineNumbers[0]} and ${lineNumbers[1]}`;
  if (lineNumbers.length <= MAX_LISTED) {
    const head = lineNumbers.slice(0, -1).join(', ');
    return `${head}, and ${lineNumbers[lineNumbers.length - 1]}`;
  }
  const head = lineNumbers.slice(0, MAX_LISTED).join(', ');
  return `${head}, and ${lineNumbers.length - MAX_LISTED} more`;
}

function normalizeReplacementLineEndings(content: string, eol: string): string {
  return content.replace(/\r\n|\n|\r/g, eol);
}
