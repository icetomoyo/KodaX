import fs from 'fs/promises';
import fsSync from 'fs';
import type { KodaXToolExecutionContext } from '../types.js';
import { getFileBackups } from './write.js';
import { generateDiff, countChanges } from './diff.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { formatDiffPreview } from './truncate.js';
import {
  collectAnchorCandidates,
  detectPreferredLineEnding,
  findUniqueNormalizedBlockMatch,
  readResolvedTextFile,
} from './text-anchor.js';
import { findExactMatchPositions, formatLineList } from './multi-edit.js';

export type EditToolErrorCode =
  | 'EDIT_NOT_FOUND'
  | 'EDIT_AMBIGUOUS'
  | 'EDIT_TOO_LARGE';

export interface EditRecoveryDiagnostic {
  code: EditToolErrorCode;
  filePath: string;
  candidates: Array<{
    startLine: number;
    endLine: number;
    preview: string;
    excerpt: string;
  }>;
}

const MAX_SAFE_EDIT_CHARS = 64 * 1024;
const MAX_SAFE_EDIT_LINES = 400;

export async function toolEdit(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const filePath = resolveExecutionPath(input.path as string, ctx);
  if (!fsSync.existsSync(filePath)) {
    return `[Tool Error] edit: File not found: ${filePath}`;
  }

  const oldStr = String(input.old_string ?? '');
  const newStr = String(input.new_string ?? '');
  const replaceAll = input.replace_all === true;
  const sizeCheck = getEditSizeFailure(filePath, oldStr, newStr);
  if (sizeCheck) {
    return sizeCheck;
  }

  const content = await fs.readFile(filePath, 'utf-8');
  const exactMatches = findExactMatchPositions(content, oldStr);
  let replacementPlan: {
    newContent: string;
    diffPreviewMode: 'inline' | 'diff';
    replacementCount: number;
  } | undefined;

  if (exactMatches.length > 0) {
    if (exactMatches.length > 1 && !replaceAll) {
      return formatEditToolError(
        'EDIT_AMBIGUOUS',
        `matched ${exactMatches.length} places (lines ${formatLineList(exactMatches)}). `
        + 'Widen old_string to include nearby unique context '
        + '(a heading, function name, or distinctive comment), '
        + 'or set replace_all=true if all matches should change. '
        + 'Do not just shorten the anchor — shorter anchors match more, not fewer.',
      );
    }

    replacementPlan = {
      newContent: replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr),
      diffPreviewMode: 'inline',
      replacementCount: replaceAll ? exactMatches.length : 1,
    };
  } else {
    const normalized = findUniqueNormalizedBlockMatch(content, oldStr);
    if (normalized.status === 'ambiguous') {
      const blockLocations = normalized.ranges.map((r) => r.startLine);
      return formatEditToolError(
        'EDIT_AMBIGUOUS',
        `matched ${normalized.ranges.length} normalized blocks (lines ${formatLineList(blockLocations)}). `
        + 'Include more surrounding lines so the old_string spans a unique region, '
        + 'or use insert_after_anchor for section appends.',
      );
    }
    if (normalized.status === 'missing') {
      return formatEditToolError(
        'EDIT_NOT_FOUND',
        'old_string not found. '
        + 'Common cause: the anchor was copied from a narrow `read` window and has typos or '
        + 'whitespace drift vs the actual file, OR it was never in the file to begin with. '
        + 'Re-read a wider window where you expect the anchor and copy an exact slice — '
        + 'do not rewrite the whole file.',
      );
    }

    const normalizedReplacement = normalizeReplacementLineEndings(
      newStr,
      detectPreferredLineEnding(content),
    );
    replacementPlan = {
      newContent: `${content.slice(0, normalized.range.start)}${normalizedReplacement}${content.slice(normalized.range.end)}`,
      diffPreviewMode: 'diff',
      replacementCount: 1,
    };
  }

  ctx.backups.set(filePath, content);
  getFileBackups().set(filePath, content);
  await fs.writeFile(filePath, replacementPlan.newContent, 'utf-8');

  const diff = generateDiff(content, replacementPlan.newContent, filePath);
  const changes = countChanges(diff);

  let result = `File edited: ${filePath}`;
  if (replacementPlan.replacementCount > 1) {
    result += ` (${replacementPlan.replacementCount} replacements)`;
  }
  result += `\n  (+${changes.added} lines, -${changes.removed} lines)`;

  const oldStrPreview = oldStr.length > 100 ? `${oldStr.slice(0, 100)}...` : oldStr;
  const newStrPreview = newStr.length > 100 ? `${newStr.slice(0, 100)}...` : newStr;

  if (
    replacementPlan.diffPreviewMode === 'inline'
    && !oldStr.includes('\n')
    && !newStr.includes('\n')
  ) {
    result += `\n\n- ${oldStrPreview}\n+ ${newStrPreview}`;
  } else if (diff) {
    const preview = await formatDiffPreview({ diff, toolName: 'edit', filePath, ctx });
    result += `\n\n${preview}`;
  }

  return result;
}

export function parseEditToolError(result: string): EditToolErrorCode | undefined {
  const match = /^\[Tool Error\] edit: (EDIT_[A-Z_]+):/.exec(result.trim());
  if (!match) {
    return undefined;
  }

  const code = match[1] as EditToolErrorCode;
  return code === 'EDIT_NOT_FOUND' || code === 'EDIT_AMBIGUOUS' || code === 'EDIT_TOO_LARGE'
    ? code
    : undefined;
}

export async function inspectEditFailure(
  pathValue: string,
  oldString: string,
  ctx: KodaXToolExecutionContext,
  windowLines: number,
): Promise<EditRecoveryDiagnostic> {
  const { filePath, content } = await readResolvedTextFile(pathValue, ctx);
  return {
    code: 'EDIT_NOT_FOUND',
    filePath,
    candidates: collectAnchorCandidates(content, oldString, windowLines)
      .map((candidate) => ({
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        preview: candidate.preview,
        excerpt: candidate.excerpt,
      })),
  };
}

function formatEditToolError(code: EditToolErrorCode, detail: string): string {
  return `[Tool Error] edit: ${code}: ${detail}`;
}

function getEditSizeFailure(filePath: string, oldString: string, newString: string): string | undefined {
  const oldLines = oldString.split(/\r\n|\n|\r/).length;
  const newLines = newString.split(/\r\n|\n|\r/).length;
  if (
    oldString.length > MAX_SAFE_EDIT_CHARS
    || newString.length > MAX_SAFE_EDIT_CHARS
    || oldLines > MAX_SAFE_EDIT_LINES
    || newLines > MAX_SAFE_EDIT_LINES
  ) {
    return formatEditToolError(
      'EDIT_TOO_LARGE',
      `Edit payload for ${filePath} is too large for safe exact replacement. Split it into smaller edits or use insert_after_anchor for section appends.`,
    );
  }
  return undefined;
}

function normalizeReplacementLineEndings(content: string, eol: string): string {
  return content.replace(/\r\n|\n|\r/g, eol);
}
