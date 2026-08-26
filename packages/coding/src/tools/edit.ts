import type { KodaXToolExecutionContext } from '../types.js';
import { generateDiff, countChanges } from './diff.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { formatDiffPreview } from './_internal/diff-preview.js';
import {
  collectAnchorCandidates,
  detectPreferredLineEnding,
  findUniqueNormalizedBlockMatch,
  findUniqueUnicodeNormalizedBlockMatch,
  readResolvedTextFile,
} from './text-anchor.js';
import { findExactMatchPositions, formatLineList } from './multi-edit.js';
import { appendLspDiagnostics } from './_internal/lsp-reflux.js';
import { buildStaleWriteReason } from '../multi-instance/content-hash-cache.js';
import { memoryMutationDenial } from './memory-mutation-guard.js';
import { formatActiveFileWarning } from '../multi-instance/active-file-warning.js';
import {
  withTextFileMutation,
  writeTextFileForMutation,
  type TextFileMutationSnapshot,
} from './_internal/text-file-mutation.js';

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
  const memoryDenial = memoryMutationDenial(filePath);
  if (memoryDenial !== undefined) return memoryDenial;
  const oldStr = String(input.old_string ?? '');
  const newStr = String(input.new_string ?? '');
  const replaceAll = input.replace_all === true;
  const sizeCheck = getEditSizeFailure(filePath, oldStr, newStr);
  if (sizeCheck) {
    return sizeCheck;
  }

  // FEATURE_295: the trusted host uses a canonical file lock plus CAS at
  // commit. Different files proceed independently; stale same-file peers fail.
  const result = await withTextFileMutation(filePath, 'edit', input, ctx, async (snapshot) => {
    if (snapshot.state === 'missing') {
      return `[Tool Error] edit: File not found: ${filePath}`;
    }
    return await runEditOnce(filePath, oldStr, newStr, replaceAll, snapshot, ctx);
  });
  // FEATURE_132 v0.7.47 — reflux LSP diagnostics OUTSIDE the mutation lock so
  // a concurrent same-file writer isn't blocked during the diagnostics wait.
  if (result.startsWith('[Tool Error]')) return result;
  return result + (await appendLspDiagnostics(filePath, ctx));
}

async function runEditOnce(
  filePath: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
  snapshot: TextFileMutationSnapshot,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  // FEATURE_125 v0.7.41 — Layer 4 hard gate. If the LLM read this file
  // earlier in the task and a peer (or the user in an external editor)
  // has since modified it, refuse the edit. Returning a [Tool Error]
  // here mirrors the existing edit error envelope so the tool-result
  // policy and error parsers treat it identically to a NOT_FOUND case.
  if (ctx.contentHashCache) {
    const stale = ctx.contentHashCache.checkStaleContent(filePath, snapshot.content);
    if (stale.stale) {
      return `[Tool Error] edit: ${buildStaleWriteReason(filePath, stale)}`;
    }
  }
  const content = snapshot.content;
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
    let matchedRange: { start: number; end: number } | undefined;
    let ambiguousBlocks: { startLine: number }[] | undefined;

    const normalized = findUniqueNormalizedBlockMatch(content, oldStr);
    if (normalized.status === 'ambiguous') {
      ambiguousBlocks = normalized.ranges;
    } else if (normalized.status === 'unique') {
      matchedRange = normalized.range;
    } else {
      // FEATURE_131 Part B: Unicode-normalized fuzzy fallback. Smart
      // quotes / em-dash / 全角 input characters typically slip
      // through both byte-exact and whitespace-tolerant comparison;
      // try once more with NFKC + typographic-character normalization
      // before giving up. Writes still use the caller's `new_string`
      // bytes so user files keep their original typography.
      const unicode = findUniqueUnicodeNormalizedBlockMatch(content, oldStr);
      if (unicode.status === 'ambiguous') {
        ambiguousBlocks = unicode.ranges;
      } else if (unicode.status === 'unique') {
        matchedRange = unicode.range;
      }
    }

    if (ambiguousBlocks) {
      const blockLocations = ambiguousBlocks.map((r) => r.startLine);
      return formatEditToolError(
        'EDIT_AMBIGUOUS',
        `matched ${ambiguousBlocks.length} normalized blocks (lines ${formatLineList(blockLocations)}). `
        + 'Include more surrounding lines so the old_string spans a unique region, '
        + 'or use insert_after_anchor for section appends.',
      );
    }
    if (!matchedRange) {
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
      newContent: `${content.slice(0, matchedRange.start)}${normalizedReplacement}${content.slice(matchedRange.end)}`,
      diffPreviewMode: 'diff',
      replacementCount: 1,
    };
  }

  await writeTextFileForMutation(snapshot, replacementPlan.newContent, false, ctx, content);

  // FEATURE_125 v0.7.41 — update content-hash cache with the post-edit
  // content so the LLM's own subsequent edit on this file does not
  // false-alarm against the changes it just applied.
  ctx.contentHashCache?.recordWrite(filePath, replacementPlan.newContent);
  // FEATURE_177 v0.7.42 — drop the read-state cache for this file so
  // the next Read returns real content (the LLM needs to see the
  // post-edit lines, not the pre-edit stub). The mtime check would
  // catch this already, but explicit forget is cheap insurance against
  // any FS-driver case where mtime doesn't tick (e.g., same-second
  // write on a filesystem with 1s mtime resolution).
  ctx.readFileStateCache?.forget(filePath);

  const diff = generateDiff(content, replacementPlan.newContent, filePath);
  const changes = countChanges(diff);

  let result = `File edited: ${filePath}`;
  if (replacementPlan.replacementCount > 1) {
    result += ` (${replacementPlan.replacementCount} replacements)`;
  }
  result += `\n  (+${changes.added} lines, -${changes.removed} lines)`;

  if (
    replacementPlan.diffPreviewMode === 'inline'
    && !oldStr.includes('\n')
    && !newStr.includes('\n')
  ) {
    result += `\n\n- ${oldStr}\n+ ${newStr}`;
  } else if (diff) {
    const preview = await formatDiffPreview({ diff, toolName: 'edit', filePath, ctx });
    result += `\n\n${preview}`;
  }

  // FEATURE_125 v0.7.41 — Layer 3 soft warning prepended to the
  // successful edit result when another session is editing the same
  // path. Does not block — the edit already applied; the banner tells
  // the LLM to consider re-reading next round.
  const warningBanner = ctx.siblingSnapshot
    ? formatActiveFileWarning(filePath, ctx.siblingSnapshot)
    : null;
  return warningBanner ? `${warningBanner}\n\n${result}` : result;
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
