import type { KodaXToolExecutionContext } from '../types.js';
import { generateDiff, countChanges } from './diff.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { memoryMutationDenial } from './memory-mutation-guard.js';
import { formatDiffPreview } from './_internal/diff-preview.js';
import {
  detectPreferredLineEnding,
  findSingleLineAnchorMatch,
  findUniqueNormalizedBlockMatch,
  findUniqueUnicodeNormalizedBlockMatch,
} from './text-anchor.js';
import { withTextFileMutation, writeTextFileForMutation } from './_internal/text-file-mutation.js';

function formatInsertError(code: 'ANCHOR_NOT_FOUND' | 'ANCHOR_AMBIGUOUS', detail: string): string {
  return `[Tool Error] insert_after_anchor: ${code}: ${detail}`;
}

export async function toolInsertAfterAnchor(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const filePath = resolveExecutionPath(input.path as string, ctx);
  const memoryDenial = memoryMutationDenial(filePath);
  if (memoryDenial !== undefined) return memoryDenial;
  const anchor = String(input.anchor ?? '');
  const contentToInsert = String(input.content ?? '');

  // FEATURE_295: the trusted host commits this insertion under canonical-file CAS.
  return withTextFileMutation(
    filePath,
    'insert_after_anchor',
    input,
    ctx,
    async (snapshot) => {
      if (snapshot.state === 'missing') {
        return `[Tool Error] insert_after_anchor: File not found: ${filePath}`;
      }
      const content = snapshot.content;
      const insertion = resolveAnchorInsertion(content, anchor);

      if (insertion.status === 'missing') {
        return formatInsertError(
          'ANCHOR_NOT_FOUND',
          'Anchor not found. Retry with a unique nearby heading or section marker.',
        );
      }
      if (insertion.status === 'ambiguous') {
        return formatInsertError(
          'ANCHOR_AMBIGUOUS',
          `Anchor matched ${insertion.count} locations. Retry with a more specific anchor.`,
        );
      }

      const prepared = prepareInsertionContent(content, insertion.index, contentToInsert);
      const nextContent = `${content.slice(0, insertion.index)}${prepared}${content.slice(insertion.index)}`;

      await writeTextFileForMutation(snapshot, nextContent, false, ctx, content);
      ctx.contentHashCache?.recordWrite(filePath, nextContent);
      // FEATURE_177 v0.7.42 — drop the read-state cache so the next Read
      // sees the post-insert content.
      ctx.readFileStateCache?.forget(filePath);

      const diff = generateDiff(content, nextContent, filePath);
      const changes = countChanges(diff);
      const preview = diff
        ? await formatDiffPreview({ diff, toolName: 'write', filePath, ctx })
        : '';

      return [
        `Content inserted after anchor in: ${filePath}`,
        `  (+${changes.added} lines, -${changes.removed} lines)`,
        preview ? '' : undefined,
        preview || undefined,
      ].filter((line): line is string => line !== undefined).join('\n');
    },
  );
}

function resolveAnchorInsertion(
  content: string,
  anchor: string,
): { status: 'unique'; index: number } | { status: 'ambiguous'; count: number } | { status: 'missing' } {
  const normalizedBlock = findUniqueNormalizedBlockMatch(content, anchor);
  if (normalizedBlock.status === 'unique') {
    return { status: 'unique', index: normalizedBlock.range.end };
  }
  if (normalizedBlock.status === 'ambiguous') {
    return { status: 'ambiguous', count: normalizedBlock.ranges.length };
  }

  const singleLine = findSingleLineAnchorMatch(content, anchor);
  if (singleLine.status === 'unique') {
    return { status: 'unique', index: singleLine.range.end };
  }
  if (singleLine.status === 'ambiguous') {
    return { status: 'ambiguous', count: singleLine.ranges.length };
  }

  // FEATURE_131 Part B: Unicode-normalized fuzzy fallback. Same
  // ruleset as edit/multi_edit so anchors copy-pasted from rich-text
  // sources (smart quotes, em-dashes, full-width characters) still
  // resolve.
  const unicode = findUniqueUnicodeNormalizedBlockMatch(content, anchor);
  if (unicode.status === 'unique') {
    return { status: 'unique', index: unicode.range.end };
  }
  if (unicode.status === 'ambiguous') {
    return { status: 'ambiguous', count: unicode.ranges.length };
  }

  return { status: 'missing' };
}

function prepareInsertionContent(existingContent: string, insertionIndex: number, contentToInsert: string): string {
  const eol = detectPreferredLineEnding(existingContent);
  let prepared = contentToInsert.replace(/\r\n|\n|\r/g, eol);
  const before = existingContent.slice(0, insertionIndex);
  const after = existingContent.slice(insertionIndex);

  if (!prepared.startsWith(eol) && before.length > 0 && !before.endsWith(eol)) {
    prepared = `${eol}${prepared}`;
  }
  if (!prepared.endsWith(eol) && after.length > 0 && !after.startsWith(eol)) {
    prepared = `${prepared}${eol}`;
  }

  return prepared;
}
