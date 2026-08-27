import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'node:path';
import { createInterface } from 'readline';
import type { KodaXToolResultContentItem } from '@kodax-ai/llm';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { buildReadFileUnchangedStub } from '../multi-instance/read-file-state-cache.js';
import { readTransientTextArtifact } from '../transient-text-artifacts.js';
import {
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  formatSize,
  READ_DEFAULT_LIMIT,
  READ_MAX_LINE_CHARS,
  READ_PREFLIGHT_SIZE_BYTES,
} from './truncate.js';

const BINARY_SAMPLE_BYTES = 4096;

// Image extension → MIME type, used by the multimodal branch (claudecode
// parity, 2026-05-20). When `read` is invoked on one of these extensions
// the tool returns a `tool_result` content array with a text descriptor
// followed by an `image` block whose path the provider serializer reads
// into base64 at wire-send time. Mirrors
// c:/Works/claudecode/src/tools/FileReadTool/FileReadTool.ts:866-891.
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Cap on inline image size. 10 MB is generous for screenshots / diagrams
// and well below most providers' single-request token limits (Anthropic
// estimates ~2000 tokens per image regardless of byte size). Beyond this,
// `read` returns an explanatory text error rather than silently sending
// huge payloads.
const READ_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

interface LineContinuation {
  readonly lineNumber: number;
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly nextOffset: number;
}

function buildReadNotes(options: {
  offset: number;
  linesShown: number;
  limit: number;
  totalLines: number;
  hasMoreLines: boolean;
  preflightNote: string;
  lineContinuation?: LineContinuation;
}): string[] {
  const {
    offset,
    linesShown,
    limit,
    totalLines,
    hasMoreLines,
    preflightNote,
    lineContinuation,
  } = options;
  const notes: string[] = [];

  if (preflightNote) {
    notes.push(preflightNote);
  }
  if (lineContinuation) {
    notes.push(
      `[Line ${lineContinuation.lineNumber} is partial: showing Unicode characters `
      + `${lineContinuation.start}-${lineContinuation.end} of ${lineContinuation.total}. `
      + `Continue with offset=${lineContinuation.lineNumber} limit=1 `
      + `line_offset=${lineContinuation.nextOffset}.]`,
    );
    return notes;
  }
  if (hasMoreLines) {
    const nextOffset = offset + linesShown;
    const shownEnd = Math.max(offset, nextOffset - 1);
    notes.push(`[Showing lines ${offset}-${shownEnd}. Use offset=${nextOffset} limit=${limit} to continue.]`);
  } else {
    notes.push(`[End of file${totalLines > 0 ? ` - ${totalLines} lines total` : ''}]`);
  }

  return notes;
}

function renderReadOutput(lines: string[], notes: string[]): string {
  const content = lines.join('\n');
  if (!content) {
    return notes.join('\n');
  }

  return `${content}\n\n${notes.join('\n')}`;
}

interface TransientTextPage {
  readonly offset: number;
  readonly limit: number;
  readonly totalLines: number;
  readonly lines: string[];
  readonly hasMoreLines: boolean;
  readonly lineContinuation?: LineContinuation;
}

const TRANSIENT_READ_CONTENT_MAX_BYTES = DEFAULT_TOOL_OUTPUT_MAX_BYTES - 4_096;

function getTransientReadWindow(input: Record<string, unknown>): {
  readonly offset: number;
  readonly limit: number;
  readonly lineOffset: number;
} {
  const numeric = (value: unknown, fallback: number): number => (
    Number.isFinite(value) ? Math.floor(Number(value)) : fallback
  );
  return {
    offset: Math.max(1, numeric(input.offset, 1)),
    limit: Math.min(
      READ_DEFAULT_LIMIT,
      Math.max(1, numeric(input.limit, READ_DEFAULT_LIMIT)),
    ),
    lineOffset: Math.max(0, numeric(input.line_offset, 0)),
  };
}

function sliceTransientUnicodeLine(input: {
  readonly content: string;
  readonly start: number;
  readonly end: number;
  readonly lineNumber: number;
  readonly lineOffset: number;
}): { readonly text: string; readonly continuation?: LineContinuation } | { readonly error: string } {
  const visible: string[] = [];
  let character = 0;
  for (let cursor = input.start; cursor < input.end;) {
    const codePoint = input.content.codePointAt(cursor)!;
    if (character >= input.lineOffset && visible.length < READ_MAX_LINE_CHARS) {
      visible.push(String.fromCodePoint(codePoint));
    }
    character += 1;
    cursor += codePoint > 0xFFFF ? 2 : 1;
  }
  if (input.lineOffset > character) {
    return {
      error: `[Tool Error] line_offset ${input.lineOffset} is beyond end of line `
        + `${input.lineNumber} (${character} Unicode characters total)`,
    };
  }
  const nextOffset = input.lineOffset + visible.length;
  return {
    text: visible.join(''),
    ...(nextOffset < character
      ? {
          continuation: {
            lineNumber: input.lineNumber,
            start: input.lineOffset,
            end: nextOffset - 1,
            total: character,
            nextOffset,
          },
        }
      : {}),
  };
}

function selectTransientTextPage(
  content: string,
  input: Record<string, unknown>,
): TransientTextPage | { readonly error: string } {
  const { offset, limit, lineOffset } = getTransientReadWindow(input);
  const selected: string[] = [];
  let lineContinuation: LineContinuation | undefined;
  let selectedBytes = 0;
  let stoppedByByteLimit = false;
  let totalLines = 1;
  let lineNumber = 1;
  let lineStart = 0;
  while (lineStart <= content.length) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? content.length : newline;
    if (lineNumber >= offset && selected.length < limit && !stoppedByByteLimit) {
      const slice = sliceTransientUnicodeLine({
        content, start: lineStart, end: lineEnd, lineNumber,
        lineOffset: lineNumber === offset ? lineOffset : 0,
      });
      if ('error' in slice) return slice;
      const nextBytes = Buffer.byteLength(slice.text, 'utf-8') + (selected.length > 0 ? 1 : 0);
      if (selectedBytes + nextBytes > TRANSIENT_READ_CONTENT_MAX_BYTES) {
        stoppedByByteLimit = true;
      } else {
        selected.push(slice.text);
        selectedBytes += nextBytes;
        lineContinuation = slice.continuation;
        if (lineContinuation !== undefined) stoppedByByteLimit = true;
      }
    }
    if (newline < 0) break;
    totalLines += 1;
    lineNumber += 1;
    lineStart = newline + 1;
  }
  if (offset > totalLines) {
    return { error: `[Tool Error] Offset ${offset} is beyond end of file (${totalLines} lines total)` };
  }
  return {
    offset,
    limit,
    totalLines,
    lines: selected,
    hasMoreLines: stoppedByByteLimit || offset - 1 + selected.length < totalLines,
    ...(lineContinuation === undefined ? {} : { lineContinuation }),
  };
}

function renderTransientTextPage(page: TransientTextPage): string {
  return renderReadOutput(page.lines, buildReadNotes({
    offset: page.offset,
    linesShown: page.lines.length,
    limit: page.limit,
    totalLines: page.totalLines,
    hasMoreLines: page.hasMoreLines,
    preflightNote: '',
    lineContinuation: page.lineContinuation,
  }));
}

function readTransientText(content: string, input: Record<string, unknown>): string {
  const page = selectTransientTextPage(content, input);
  return 'error' in page ? page.error : renderTransientTextPage(page);
}

async function isProbablyBinary(filePath: string, fileSize: number): Promise<boolean> {
  if (fileSize === 0) {
    return false;
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const sampleSize = Math.min(BINARY_SAMPLE_BYTES, fileSize);
    const sample = Buffer.alloc(sampleSize);
    const { bytesRead } = await handle.read(sample, 0, sampleSize, 0);
    if (bytesRead === 0) {
      return false;
    }

    let nonPrintable = 0;
    for (let index = 0; index < bytesRead; index++) {
      const value = sample[index];
      if (value === 0) {
        return true;
      }
      if (value < 9 || (value > 13 && value < 32)) {
        nonPrintable++;
      }
    }

    return nonPrintable / bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}

/**
 * FEATURE_125 (v0.7.41) — record the on-disk content hash for the
 * Team Mode safety net. Called AFTER a successful tool result is
 * formed so an error in hash recording never affects the tool's
 * primary contract. The hash captures the bytes on disk at this
 * moment; a future Edit/Write tool's `checkStale` compares against
 * this snapshot to detect cross-session races.
 *
 * Swallow all errors: a transient read failure here just means the
 * safety net doesn't engage for this file in this task (the worst
 * case is the next edit proceeds as it would have pre-FEATURE_125).
 * Bounded by READ_HASH_MAX_BYTES to keep one extra full-file read
 * cheap; files above the cap are not hashed (Edit on huge files is
 * rare and the cost outweighs the benefit).
 */
const READ_HASH_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

async function maybeRecordContentHash(
  ctx: KodaXToolExecutionContext,
  filePath: string,
  fileSizeBytes: number,
): Promise<void> {
  if (!ctx.contentHashCache) return;
  if (fileSizeBytes > READ_HASH_MAX_BYTES) return;
  try {
    const fullContent = await fs.readFile(filePath, 'utf-8');
    ctx.contentHashCache.recordRead(filePath, fullContent);
  } catch {
    // Swallow — see JSDoc.
  }
}

export async function toolRead(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string | readonly KodaXToolResultContentItem[]> {
  const requestedPath = input.path as string;
  const transientContent = readTransientTextArtifact(requestedPath);
  if (transientContent !== undefined) {
    if (ctx.toolCallId) {
      ctx.recordToolResultArtifact?.(ctx.toolCallId, requestedPath);
    }
    return readTransientText(transientContent, input);
  }
  const filePath = resolveExecutionPath(requestedPath, ctx);
  try {
    ctx.assertReadablePath?.(filePath);
  } catch {
    return '[Tool Error] File is unavailable under the active read policy.';
  }
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return `[Tool Error] File not found: ${filePath}`;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] Unable to access file: ${filePath}. ${message}`;
  }

  if (!stat.isFile()) {
    return `[Tool Error] Path is not a file: ${filePath}`;
  }

  // Image branch — claudecode parity. Return a tool_result content array
  // so the provider serializer can lower the image into a vision block
  // the model perceives natively. Anthropic providers (Anthropic SDK +
  // kimi-for-coding) carry the image inline in tool_result; OpenAI-compat
  // providers downgrade gracefully to a text placeholder. This sits
  // BEFORE `isProbablyBinary` because PNG/JPEG bytes always trigger the
  // binary detector — the whole point of this branch is to route them
  // out of the text-only error path.
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    return [
      `[Tool Error] PDF files are not parsed by the built-in read tool: ${filePath}.`,
      'If the read_pdf tool is available in this session, call read_pdf with this path to extract page-marked text and OCR scanned pages when configured.',
      'If read_pdf is unavailable, ask the user to install or enable the read_pdf extension.',
    ].join(' ');
  }

  const imageMimeType = IMAGE_MIME_TYPES[ext];
  if (imageMimeType) {
    if (stat.size > READ_IMAGE_MAX_BYTES) {
      return `[Tool Error] Image too large to inline (${formatSize(stat.size)} > ${formatSize(READ_IMAGE_MAX_BYTES)}): ${filePath}. Resize before reading.`;
    }
    return [
      {
        type: 'text',
        text: `[Read image: ${filePath} (${formatSize(stat.size)}, ${imageMimeType})] — image content delivered as inline vision below; describe what you see in your next response.`,
      },
      { type: 'image', path: filePath, mediaType: imageMimeType },
    ];
  }

  if (await isProbablyBinary(filePath, stat.size)) {
    return `[Tool Error] Binary file not supported by read: ${filePath}`;
  }

  const rawOffset = Number.isFinite(input.offset) ? Number(input.offset) : 1;
  const rawLimit = Number.isFinite(input.limit) ? Number(input.limit) : READ_DEFAULT_LIMIT;
  const rawLineOffset = Number.isFinite(input.line_offset) ? Number(input.line_offset) : 0;
  const offset = Math.max(1, Math.floor(rawOffset));
  const limit = Math.max(1, Math.floor(rawLimit));
  const lineOffset = Math.max(0, Math.floor(rawLineOffset));
  const startLine = offset - 1;

  // FEATURE_177 v0.7.42 — anti-loop dedup. When the LLM re-reads the
  // same (file, offset, limit) and the file hasn't been touched since,
  // return a short stub instead of the full content. Breaks the
  // `narrate-then-re-read` loop observed on models with structural
  // decoder floors (kimi-code 2026-05). The cache is per-managed-task
  // (created in `runner-driven.ts`); when undefined the lookup is
  // skipped and disk read proceeds normally. Killswitch:
  // `KODAX_READ_DEDUP_KILLSWITCH=1`.
  if (ctx.readFileStateCache && lineOffset === 0) {
    const cached = ctx.readFileStateCache.lookup(filePath, offset, limit);
    if (cached.kind === 'hit') {
      return buildReadFileUnchangedStub(filePath, offset, limit);
    }
  }

  const lines: string[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let totalLines = 0;
  let outputBytes = 0;
  let hasMoreLines = false;
  let lineContinuation: LineContinuation | undefined;
  let lineOffsetError: string | undefined;

  try {
    for await (const rawLine of reader) {
      totalLines++;
      if (totalLines <= startLine) {
        continue;
      }

      if (lines.length >= limit) {
        hasMoreLines = true;
        break;
      }

      const lineNumber = offset + lines.length;
      const characters = Array.from(rawLine);
      const currentLineOffset = lineNumber === offset ? lineOffset : 0;
      if (currentLineOffset > characters.length) {
        lineOffsetError =
          `[Tool Error] line_offset ${currentLineOffset} is beyond end of line `
          + `${lineNumber} (${characters.length} Unicode characters total)`;
        break;
      }
      const visibleCharacters = characters.slice(
        currentLineOffset,
        currentLineOffset + READ_MAX_LINE_CHARS,
      );
      const displayLine = visibleCharacters.join('');
      const nextLineOffset = currentLineOffset + visibleCharacters.length;
      const nextLineContinuation = nextLineOffset < characters.length
        ? {
            lineNumber,
            start: currentLineOffset,
            end: nextLineOffset - 1,
            total: characters.length,
            nextOffset: nextLineOffset,
          }
        : undefined;
      const numberedLine = `${lineNumber.toString().padStart(6)}\t${displayLine}`;
      const lineBytes = Buffer.byteLength(numberedLine, 'utf-8') + (lines.length > 0 ? 1 : 0);

      if (outputBytes + lineBytes > DEFAULT_TOOL_OUTPUT_MAX_BYTES) {
        hasMoreLines = true;
        break;
      }

      lines.push(numberedLine);
      outputBytes += lineBytes;
      if (nextLineContinuation) {
        lineContinuation = nextLineContinuation;
        hasMoreLines = true;
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  if (lineOffsetError) {
    return lineOffsetError;
  }

  if (totalLines < offset && !(totalLines === 0 && offset === 1)) {
    return `[Tool Error] Offset ${offset} is beyond end of file (${totalLines} lines total)`;
  }

  const preflightNote =
    input.limit === undefined && stat.size > READ_PREFLIGHT_SIZE_BYTES
      ? `[Large file: ${formatSize(stat.size)}. Read returns at most ${READ_DEFAULT_LIMIT} lines or ${formatSize(DEFAULT_TOOL_OUTPUT_MAX_BYTES)} per call. Use offset/limit or grep to narrow the scope.]`
      : '';
  let effectiveLines = [...lines];
  let effectiveHasMoreLines = hasMoreLines;
  let effectiveLineContinuation = lineContinuation;

  while (true) {
    const notes = buildReadNotes({
      offset,
      linesShown: effectiveLines.length,
      limit,
      totalLines,
      hasMoreLines: effectiveHasMoreLines,
      preflightNote,
      lineContinuation: effectiveLineContinuation,
    });
    const output = renderReadOutput(effectiveLines, notes);
    if (
      Buffer.byteLength(output, 'utf-8') <= DEFAULT_TOOL_OUTPUT_MAX_BYTES ||
      effectiveLines.length === 0
    ) {
      // FEATURE_125 v0.7.41 — record content hash for the Team Mode
      // safety net. Best-effort, awaited (synchronous to the caller's
      // perspective) so the next Edit/Write tool call in the same
      // turn sees the recorded hash. Errors swallowed inside the
      // helper; never affects tool output.
      await maybeRecordContentHash(ctx, filePath, stat.size);
      // FEATURE_177 v0.7.42 — record (filePath, offset, limit, mtime)
      // for the anti-loop dedup. The next re-read with these same
      // params + unchanged mtime returns a stub instead of paying disk
      // I/O and re-flooding the conversation with identical content.
      if (lineOffset === 0) {
        ctx.readFileStateCache?.record(filePath, offset, limit, stat.mtimeMs);
      }
      return output;
    }

    effectiveLines.pop();
    effectiveHasMoreLines = true;
    if (effectiveLineContinuation && effectiveLines.length < lines.length) {
      effectiveLineContinuation = undefined;
    }
  }
}
