import fs from 'fs/promises';
import path from 'path';

import { getAgentConfigPath } from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';
import { withFileMutation } from './_internal/file-mutation-queue.js';

export const DEFAULT_TOOL_OUTPUT_MAX_LINES = 2000;
export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_GREP_LINE_MAX_CHARS = 500;
export const READ_DEFAULT_LIMIT = 2000;
export const READ_PREFLIGHT_SIZE_BYTES = 256 * 1024;
export const READ_MAX_LINE_CHARS = 2000;
export const TOOL_OUTPUT_DIR_ENV = 'KODAX_TOOL_OUTPUT_DIR';

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export {
  formatDiffPreview,
  type DiffPreviewOptions,
} from './_internal/diff-preview.js';

function getLimits(options: TruncationOptions): { maxLines: number; maxBytes: number } {
  return {
    maxLines: options.maxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES,
    maxBytes: options.maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const { maxLines, maxBytes } = getLimits(options);
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  const firstLine = lines[0] ?? '';
  if (Buffer.byteLength(firstLine, 'utf-8') > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';

  for (let index = 0; index < lines.length && index < maxLines; index++) {
    const line = lines[index] ?? '';
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (index > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    outputLines.push(line);
    outputBytes += lineBytes;
  }

  if (outputLines.length >= maxLines && outputBytes <= maxBytes) {
    truncatedBy = 'lines';
  }

  const preview = outputLines.join('\n');
  return {
    content: preview,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes: Buffer.byteLength(preview, 'utf-8'),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const { maxLines, maxBytes } = getLimits(options);
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  let lastLinePartial = false;

  for (let index = lines.length - 1; index >= 0 && outputLines.length < maxLines; index--) {
    const line = lines[index] ?? '';
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (outputLines.length > 0 ? 1 : 0);

    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      if (outputLines.length === 0 && line.length > 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
        outputLines.unshift(truncatedLine);
        outputBytes = Buffer.byteLength(truncatedLine, 'utf-8');
        lastLinePartial = true;
      }
      break;
    }

    outputLines.unshift(line);
    outputBytes += lineBytes;
  }

  if (outputLines.length >= maxLines && outputBytes <= maxBytes) {
    truncatedBy = 'lines';
  }

  const preview = outputLines.join('\n');
  return {
    content: preview,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes: Buffer.byteLength(preview, 'utf-8'),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

export function trimBufferStartToUtf8Boundary(buffer: Buffer, start: number): Buffer {
  if (start <= 0) {
    return buffer;
  }

  let safeStart = Math.min(start, buffer.length);
  while (safeStart < buffer.length && (buffer[safeStart] & 0xc0) === 0x80) {
    safeStart++;
  }

  return buffer.subarray(safeStart);
}

function truncateStringToBytesFromEnd(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, 'utf-8');
  if (buffer.length <= maxBytes) {
    return content;
  }

  return trimBufferStartToUtf8Boundary(buffer, buffer.length - maxBytes).toString('utf-8');
}

export function truncateLine(
  line: string,
  maxChars: number = DEFAULT_GREP_LINE_MAX_CHARS,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) {
    return { text: line, wasTruncated: false };
  }

  return {
    text: `${line.slice(0, maxChars)}... [truncated]`,
    wasTruncated: true,
  };
}

export function resolveToolOutputDir(): string {
  return process.env[TOOL_OUTPUT_DIR_ENV] || getAgentConfigPath('tool-results');
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'tool';
}

export async function persistToolOutput(
  toolName: string,
  content: string,
  ctx?: Pick<KodaXToolExecutionContext, 'gitRoot' | 'executionCwd'>,
  outputDirectory?: string,
): Promise<string> {
  const outputDir = outputDirectory ?? resolveToolOutputDir();
  const scope = sanitizePathSegment(
    path.basename(ctx?.gitRoot ?? ctx?.executionCwd ?? 'session'),
  );
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const fileName = `${timestamp}-${scope}-${sanitizePathSegment(toolName)}-${randomSuffix}.txt`;
  const filePath = path.join(outputDir, fileName);

  await withFileMutation(filePath, async () => {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  });

  // Recovery artifacts are canonical evidence referenced by conversation
  // history. Age alone cannot prove that a live/resumable session no longer
  // needs them, so automatic TTL deletion is intentionally disabled. The
  // explicit cleanup helper remains available for operator-controlled sweeps.

  return filePath;
}
