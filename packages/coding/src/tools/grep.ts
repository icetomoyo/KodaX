import fs from 'fs/promises';
import nodePath from 'node:path';
import { glob as globAsync } from 'glob';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPathOrCwd } from '../runtime-paths.js';
import { formatSize, persistToolOutput, truncateHead, truncateLine } from './truncate.js';

/* ---------- Constants ---------- */

const MAX_GREP_PATTERN_LENGTH = 256;
const VALID_OUTPUT_MODES = new Set(['content', 'files_with_matches', 'count']);
const MAX_GREP_FILES = 100;
const MAX_GREP_RESULTS = 200;
const MAX_GREP_OUTPUT_LINES = 400;
const MAX_GREP_OUTPUT_BYTES = 24 * 1024;
const DEFAULT_HEAD_LIMIT = 250;

const FILE_TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  js: ['.js', '.mjs', '.cjs', '.jsx'],
  ts: ['.ts', '.mts', '.cts', '.tsx'],
  py: ['.py', '.pyi'],
  rust: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
  css: ['.css', '.scss', '.sass', '.less'],
  html: ['.html', '.htm'],
  json: ['.json', '.jsonc'],
  yaml: ['.yml', '.yaml'],
  md: ['.md', '.markdown'],
  xml: ['.xml'],
  sql: ['.sql'],
  sh: ['.sh', '.bash', '.zsh'],
  ruby: ['.rb'],
  php: ['.php'],
  swift: ['.swift'],
  kotlin: ['.kt', '.kts'],
  scala: ['.scala'],
  vue: ['.vue'],
  svelte: ['.svelte'],
  toml: ['.toml'],
  ini: ['.ini', '.cfg'],
};

/* ---------- Safety ---------- */

function getUnsafeRegexReason(pattern: string): string | null {
  if (!pattern.trim()) return 'Pattern must not be empty';
  if (pattern.length > MAX_GREP_PATTERN_LENGTH) {
    return `Pattern exceeds the ${MAX_GREP_PATTERN_LENGTH}-character safety limit`;
  }
  if (pattern.includes('\0')) return 'Pattern must not contain null bytes';
  if (/\\[1-9]/.test(pattern)) return 'Backreferences are not allowed';
  if (/\(\?<([=!])/.test(pattern) || /\(\?[=!]/.test(pattern)) {
    return 'Lookaround assertions are not allowed';
  }
  if (/\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) {
    return 'Nested quantifiers are not allowed';
  }
  if (/\{(?:\d{4,}|\d+,\d{4,}|\d{4,},\d*)\}/.test(pattern)) {
    return 'Large repetition ranges are not allowed';
  }
  return null;
}

function createSafeRegex(pattern: string, flags: string): RegExp {
  const unsafeReason = getUnsafeRegexReason(pattern);
  if (unsafeReason) {
    throw new Error(`Pattern rejected as potentially unsafe. ${unsafeReason}.`);
  }
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex pattern. ${message}`);
  }
}

async function getPathStat(
  targetPath: string,
): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/* ---------- File type helpers ---------- */

function getFileTypeExtensions(type: string): readonly string[] | null {
  return FILE_TYPE_EXTENSIONS[type.toLowerCase()] ?? null;
}

function fileMatchesType(
  filePath: string,
  extensions: readonly string[],
): boolean {
  return extensions.includes(nodePath.extname(filePath).toLowerCase());
}

/* ---------- Multiline offset helpers ---------- */

function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function offsetToLine(offsets: number[], charOffset: number): number {
  const clamped = Math.max(0, Math.min(charOffset, offsets[offsets.length - 1]!));
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (offsets[mid]! <= clamped) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, offsets.length - 1);
}

/* ---------- Single-file matching ---------- */

interface MatchResult {
  readonly entries: string[];
  readonly matchCount: number;
}

function matchFileLines(
  lines: string[],
  regex: RegExp,
  filePath: string,
  outputMode: string,
  beforeCtx: number,
  afterCtx: number,
  remaining: number,
): MatchResult {
  if (outputMode === 'files_with_matches') {
    for (const line of lines) {
      if (regex.test(line)) return { entries: [filePath], matchCount: 1 };
    }
    return { entries: [], matchCount: 0 };
  }

  const matchIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]!)) matchIndices.push(i);
  }

  if (outputMode === 'count' || matchIndices.length === 0) {
    return { entries: [], matchCount: matchIndices.length };
  }

  const entries: string[] = [];
  const hasContext = beforeCtx > 0 || afterCtx > 0;

  if (!hasContext) {
    for (const idx of matchIndices) {
      if (entries.length >= remaining) break;
      const text = truncateLine(lines[idx]!.trim()).text;
      entries.push(`${filePath}:${idx + 1}: ${text}`);
    }
    return { entries, matchCount: matchIndices.length };
  }

  // Context lines — use Set for O(1) match lookup
  const matchSet = new Set(matchIndices);
  let lastOutput = -2;

  for (const idx of matchIndices) {
    if (entries.length >= remaining) break;
    const start = Math.max(0, idx - beforeCtx);
    const end = Math.min(lines.length - 1, idx + afterCtx);

    if (lastOutput >= 0 && start > lastOutput + 1) {
      entries.push('--');
    }

    for (let i = start; i <= end; i++) {
      if (i <= lastOutput) continue;
      const sep = matchSet.has(i) ? ':' : '-';
      const text = truncateLine(lines[i]!.trim()).text;
      entries.push(`${filePath}${sep}${i + 1}${sep} ${text}`);
    }
    lastOutput = end;
  }

  return { entries, matchCount: matchIndices.length };
}

function matchFileMultiline(
  content: string,
  lines: string[],
  regex: RegExp,
  filePath: string,
  outputMode: string,
  beforeCtx: number,
  afterCtx: number,
  remaining: number,
): MatchResult {
  if (outputMode === 'files_with_matches') {
    if (regex.test(content)) return { entries: [filePath], matchCount: 1 };
    return { entries: [], matchCount: 0 };
  }

  const globalRegex = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : `${regex.flags}g`,
  );
  const lineOffsets = buildLineOffsets(content);
  const matchRanges: Array<{ startLine: number; endLine: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = globalRegex.exec(content)) !== null) {
    const startLine = offsetToLine(lineOffsets, match.index);
    const endOffset = match.index + Math.max(match[0].length - 1, 0);
    const endLine = offsetToLine(lineOffsets, endOffset);
    matchRanges.push({ startLine, endLine });
    if (matchRanges.length >= MAX_GREP_RESULTS) break;
    if (match[0].length === 0) globalRegex.lastIndex++;
  }

  if (outputMode === 'count' || matchRanges.length === 0) {
    return { entries: [], matchCount: matchRanges.length };
  }

  const matchLineSet = new Set<number>();
  for (const range of matchRanges) {
    for (let i = range.startLine; i <= range.endLine; i++) {
      matchLineSet.add(i);
    }
  }

  const entries: string[] = [];
  let lastOutput = -2;

  for (const range of matchRanges) {
    if (entries.length >= remaining) break;
    const start = Math.max(0, range.startLine - beforeCtx);
    const end = Math.min(lines.length - 1, range.endLine + afterCtx);

    if (lastOutput >= 0 && start > lastOutput + 1) {
      entries.push('--');
    }

    for (let i = start; i <= end; i++) {
      if (i <= lastOutput) continue;
      const sep = matchLineSet.has(i) ? ':' : '-';
      const text = truncateLine(lines[i]!.trim()).text;
      entries.push(`${filePath}${sep}${i + 1}${sep} ${text}`);
    }
    lastOutput = end;
  }

  return { entries, matchCount: matchRanges.length };
}

/* ---------- Output ---------- */

async function finalizeGrepResults(
  results: string[],
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const joined = results.join('\n');
  const preview = truncateHead(joined, {
    maxLines: MAX_GREP_OUTPUT_LINES,
    maxBytes: MAX_GREP_OUTPUT_BYTES,
  });

  if (!preview.truncated) return joined;

  let outputPath: string | undefined;
  try {
    outputPath = await persistToolOutput('grep', joined, ctx);
  } catch {
    outputPath = undefined;
  }

  const saved = outputPath ? ` Full output saved to: ${outputPath}.` : '';
  return `${preview.content}\n\n[Grep output truncated: showing ${preview.outputLines} of ${preview.totalLines} lines (${formatSize(preview.outputBytes)} of ${formatSize(preview.totalBytes)}).${saved} Narrow the pattern or path, or switch to files_with_matches/count first.]`;
}

/* ---------- Main handler ---------- */

export async function toolGrep(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) ?? ctx.executionCwd ?? ctx.gitRoot;
  const ignoreCase =
    (input.ignore_case as boolean) ?? (input['-i'] as boolean) ?? false;
  const outputMode = (input.output_mode as string) ?? 'content';
  const multiline = (input.multiline as boolean) ?? false;
  const fileType = input.type as string | undefined;
  const fileGlob = input.glob as string | undefined;
  const offset = Math.max(0, (input.offset as number) ?? 0);
  const headLimit = (input.head_limit as number) ?? DEFAULT_HEAD_LIMIT;
  const contextValue =
    (input.context as number) ?? (input['-C'] as number) ?? 0;
  const beforeCtx = Math.max(
    0,
    (input['-B'] as number) ?? contextValue,
  );
  const afterCtx = Math.max(
    0,
    (input['-A'] as number) ?? contextValue,
  );

  const resolvedPath = resolveExecutionPathOrCwd(searchPath, ctx);

  if (!VALID_OUTPUT_MODES.has(outputMode)) {
    return `[Tool Error] grep: Unsupported output mode "${outputMode}"`;
  }

  let typeExtensions: readonly string[] | null = null;
  if (fileType) {
    typeExtensions = getFileTypeExtensions(fileType);
    if (!typeExtensions) {
      return `[Tool Error] grep: Unknown file type "${fileType}". Known types: ${Object.keys(FILE_TYPE_EXTENSIONS).join(', ')}`;
    }
  }

  let regex: RegExp;
  try {
    let flags = ignoreCase ? 'i' : '';
    if (multiline) flags += 's';
    regex = createSafeRegex(pattern, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] grep: ${message}`;
  }

  let stat;
  try {
    stat = await getPathStat(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] grep: Unable to access "${searchPath}". ${message}`;
  }
  if (!stat) return `[Tool Error] grep: Path not found: ${searchPath}`;

  const collectLimit =
    headLimit === 0 ? MAX_GREP_RESULTS * 10 : headLimit + offset;
  const allEntries: string[] = [];
  let totalMatchCount = 0;

  const processFile = async (filePath: string): Promise<void> => {
    if (allEntries.length >= collectLimit) return;
    if (typeExtensions && !fileMatchesType(filePath, typeExtensions)) return;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const remaining = collectLimit - allEntries.length;
      const result = multiline
        ? matchFileMultiline(
            content,
            lines,
            regex,
            filePath,
            outputMode,
            beforeCtx,
            afterCtx,
            remaining,
          )
        : matchFileLines(
            lines,
            regex,
            filePath,
            outputMode,
            beforeCtx,
            afterCtx,
            remaining,
          );
      allEntries.push(...result.entries);
      totalMatchCount += result.matchCount;
    } catch {
      // Skip unreadable files and continue with a best-effort search result.
    }
  };

  if (stat.isFile()) {
    await processFile(resolvedPath);
  } else {
    const globPattern = fileGlob ?? '**/*';
    const files = (
      await globAsync(globPattern, {
        cwd: resolvedPath,
        nodir: true,
        absolute: true,
        ignore: ['**/node_modules/**', '**/.*'],
      })
    ).slice(0, MAX_GREP_FILES);

    for (const file of files) {
      await processFile(file);
      if (allEntries.length >= collectLimit) break;
    }
  }

  if (outputMode === 'count') return `${totalMatchCount} matches`;
  if (allEntries.length === 0) return `No matches for "${pattern}"`;

  const sliced =
    headLimit === 0
      ? allEntries.slice(offset)
      : allEntries.slice(offset, offset + headLimit);

  if (sliced.length === 0) {
    return `No matches for "${pattern}" in the requested range (offset=${offset})`;
  }

  return finalizeGrepResults(sliced, ctx);
}
