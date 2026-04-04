import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import fs from 'fs/promises';

export interface MatchRange {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

export interface AnchorCandidate {
  startLine: number;
  endLine: number;
  preview: string;
  excerpt: string;
  score: number;
}

interface PhysicalLine {
  text: string;
  start: number;
  end: number;
  lineNumber: number;
}

interface LogicalLine {
  text: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  blank: boolean;
}

const WORD_SPLIT_RE = /[^a-z0-9_/-]+/i;

export function detectPreferredLineEnding(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

export async function readResolvedTextFile(
  pathValue: string,
  ctx: KodaXToolExecutionContext,
): Promise<{ filePath: string; content: string }> {
  const filePath = resolveExecutionPath(pathValue, ctx);
  const content = await fs.readFile(filePath, 'utf-8');
  return { filePath, content };
}

export function findUniqueNormalizedBlockMatch(
  content: string,
  needle: string,
): { status: 'unique'; range: MatchRange } | { status: 'ambiguous'; ranges: MatchRange[] } | { status: 'missing' } {
  const contentLines = buildLogicalLines(content);
  const needleLines = trimBoundaryBlankLogicalLines(buildLogicalLines(needle));
  if (needleLines.length === 0 || contentLines.length === 0) {
    return { status: 'missing' };
  }

  const canonicalNeedle = canonicalizeLogicalBlock(needleLines);
  if (!canonicalNeedle) {
    return { status: 'missing' };
  }

  const ranges: MatchRange[] = [];
  for (let index = 0; index <= contentLines.length - needleLines.length; index++) {
    const window = trimBoundaryBlankLogicalLines(contentLines.slice(index, index + needleLines.length));
    if (window.length !== needleLines.length) {
      continue;
    }
    if (canonicalizeLogicalBlock(window) !== canonicalNeedle) {
      continue;
    }

    ranges.push({
      start: window[0]!.start,
      end: window[window.length - 1]!.end,
      startLine: window[0]!.startLine,
      endLine: window[window.length - 1]!.endLine,
    });
  }

  if (ranges.length === 1) {
    return { status: 'unique', range: ranges[0]! };
  }
  if (ranges.length > 1) {
    return { status: 'ambiguous', ranges };
  }
  return { status: 'missing' };
}

export function collectAnchorCandidates(
  content: string,
  needle: string,
  windowLines: number,
  limit = 3,
): AnchorCandidate[] {
  const physicalLines = buildPhysicalLines(content);
  if (physicalLines.length === 0) {
    return [];
  }

  const needleTargets = buildNeedleTargets(needle);
  if (needleTargets.length === 0) {
    return [];
  }

  const ranked = physicalLines
    .map((line) => {
      const score = needleTargets.reduce((best, target) => Math.max(best, scoreLineMatch(line.text, target)), 0);
      return { line, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.line.lineNumber - right.line.lineNumber);

  const unique = new Map<number, AnchorCandidate>();
  const halfWindow = Math.max(8, Math.floor(windowLines / 2));
  for (const entry of ranked) {
    if (unique.size >= limit) {
      break;
    }
    if (unique.has(entry.line.lineNumber)) {
      continue;
    }

    const startLine = Math.max(1, entry.line.lineNumber - halfWindow);
    const endLine = Math.min(physicalLines.length, entry.line.lineNumber + halfWindow);
    unique.set(entry.line.lineNumber, {
      startLine,
      endLine,
      preview: squashWhitespace(entry.line.text).slice(0, 120),
      excerpt: physicalLines
        .slice(startLine - 1, endLine)
        .map((line) => `${line.lineNumber}: ${line.text}`)
        .join('\n'),
      score: entry.score,
    });
  }

  return [...unique.values()];
}

export function findSingleLineAnchorMatch(
  content: string,
  anchor: string,
): { status: 'unique'; range: MatchRange } | { status: 'ambiguous'; ranges: MatchRange[] } | { status: 'missing' } {
  const normalizedAnchor = normalizeInlineText(anchor);
  if (!normalizedAnchor) {
    return { status: 'missing' };
  }

  const lines = buildPhysicalLines(content);
  const ranges = lines
    .filter((line) => normalizeInlineText(line.text).includes(normalizedAnchor))
    .map((line) => ({
      start: line.start,
      end: line.end,
      startLine: line.lineNumber,
      endLine: line.lineNumber,
    }));

  if (ranges.length === 1) {
    return { status: 'unique', range: ranges[0]! };
  }
  if (ranges.length > 1) {
    return { status: 'ambiguous', ranges };
  }
  return { status: 'missing' };
}

function buildNeedleTargets(needle: string): string[] {
  const logicalLines = trimBoundaryBlankLogicalLines(buildLogicalLines(needle))
    .map((line) => normalizeInlineText(stripCommonIndentFromLine(line.text, 0)))
    .filter((line) => line.length >= 4);

  const unique = Array.from(new Set(logicalLines));
  return unique.slice(0, 4);
}

function scoreLineMatch(line: string, target: string): number {
  const normalizedLine = normalizeInlineText(line);
  if (!normalizedLine || !target) {
    return 0;
  }
  if (normalizedLine.includes(target) || target.includes(normalizedLine)) {
    return 1;
  }

  const lineTokens = tokenize(normalizedLine);
  const targetTokens = tokenize(target);
  if (lineTokens.length === 0 || targetTokens.length === 0) {
    return 0;
  }

  const lineTokenSet = new Set(lineTokens);
  const overlap = targetTokens.filter((token) => lineTokenSet.has(token)).length;
  return overlap / Math.max(lineTokens.length, targetTokens.length);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(WORD_SPLIT_RE)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildPhysicalLines(content: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let start = 0;
  let lineNumber = 1;

  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (char !== '\n' && char !== '\r') {
      continue;
    }

    let end = index + 1;
    if (char === '\r' && content[index + 1] === '\n') {
      end += 1;
      index += 1;
    }

    const text = content.slice(start, end).replace(/\r?\n$/, '');
    lines.push({ text, start, end, lineNumber });
    start = end;
    lineNumber += 1;
  }

  if (start < content.length || content.length === 0) {
    lines.push({
      text: content.slice(start),
      start,
      end: content.length,
      lineNumber,
    });
  }

  return lines;
}

function buildLogicalLines(content: string): LogicalLine[] {
  const physicalLines = buildPhysicalLines(content);
  if (physicalLines.length === 0) {
    return [];
  }

  const logicalLines: LogicalLine[] = [];
  let pendingBlank: LogicalLine | undefined;

  for (const line of physicalLines) {
    const normalizedText = line.text.replace(/\t/g, '  ').trimEnd();
    const blank = normalizedText.trim().length === 0;

    if (blank) {
      if (!pendingBlank) {
        pendingBlank = {
          text: '',
          start: line.start,
          end: line.end,
          startLine: line.lineNumber,
          endLine: line.lineNumber,
          blank: true,
        };
      } else {
        pendingBlank.end = line.end;
        pendingBlank.endLine = line.lineNumber;
      }
      continue;
    }

    if (pendingBlank) {
      logicalLines.push(pendingBlank);
      pendingBlank = undefined;
    }

    logicalLines.push({
      text: normalizedText,
      start: line.start,
      end: line.end,
      startLine: line.lineNumber,
      endLine: line.lineNumber,
      blank: false,
    });
  }

  if (pendingBlank) {
    logicalLines.push(pendingBlank);
  }

  return logicalLines;
}

function trimBoundaryBlankLogicalLines(lines: LogicalLine[]): LogicalLine[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.blank) {
    start += 1;
  }
  while (end > start && lines[end - 1]?.blank) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function canonicalizeLogicalBlock(lines: LogicalLine[]): string {
  const trimmed = trimBoundaryBlankLogicalLines(lines);
  if (trimmed.length === 0) {
    return '';
  }

  return trimmed
    .map((line) => (line.blank ? '' : normalizeLogicalLineForComparison(line.text)))
    .join('\n');
}

function computeCommonIndent(lines: string[]): number {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = /^ */.exec(line);
      return match ? match[0].length : 0;
    });

  return indents.length > 0 ? Math.min(...indents) : 0;
}

function stripCommonIndentFromLine(line: string, indent: number): string {
  if (!indent || line.trim().length === 0) {
    return line;
  }
  return line.startsWith(' '.repeat(indent))
    ? line.slice(indent)
    : line.trimStart();
}

function normalizeLogicalLineForComparison(line: string): string {
  return line.replace(/\t/g, '  ').trim();
}

function normalizeInlineText(value: string): string {
  return squashWhitespace(value.replace(/\t/g, '  ').trim());
}

function squashWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
