import fs from 'fs/promises';
import fsSync from 'fs';
import type { KodaXToolExecutionContext } from '../types.js';
import { getFileBackups } from './write.js';
import { generateDiff, countChanges } from './diff.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { formatDiffPreview } from './truncate.js';
import {
  detectPreferredLineEnding,
  findSingleLineAnchorMatch,
  findUniqueNormalizedBlockMatch,
} from './text-anchor.js';

function formatInsertError(code: 'ANCHOR_NOT_FOUND' | 'ANCHOR_AMBIGUOUS', detail: string): string {
  return `[Tool Error] insert_after_anchor: ${code}: ${detail}`;
}

export async function toolInsertAfterAnchor(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const filePath = resolveExecutionPath(input.path as string, ctx);
  if (!fsSync.existsSync(filePath)) {
    return `[Tool Error] insert_after_anchor: File not found: ${filePath}`;
  }

  const anchor = String(input.anchor ?? '');
  const contentToInsert = String(input.content ?? '');
  const content = await fs.readFile(filePath, 'utf-8');
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

  ctx.backups.set(filePath, content);
  getFileBackups().set(filePath, content);
  await fs.writeFile(filePath, nextContent, 'utf-8');

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
