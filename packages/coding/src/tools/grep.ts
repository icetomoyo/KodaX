import fs from 'fs/promises';
import nodePath from 'node:path';
import { glob as globAsync } from 'glob';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPathOrCwd } from '../runtime-paths.js';

/* ---------- Constants ---------- */

const MAX_GREP_PATTERN_LENGTH = 256;
const VALID_OUTPUT_MODES = new Set(['content', 'files_with_matches', 'count']);
const DEFAULT_HEAD_LIMIT = 250;
const MAX_RENDERED_ENTRY_CHARS = 500;
const MAX_RESULT_PAGE_BYTES = 50 * 1024;

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

function createSafeRegex(pattern: string, flags: string, literal = false): RegExp {
  const unsafeReason = literal
    ? (!pattern.trim() ? 'Pattern must not be empty' : pattern.includes('\0') ? 'Pattern must not contain null bytes' : null)
    : getUnsafeRegexReason(pattern);
  if (unsafeReason) {
    throw new Error(`Pattern rejected as potentially unsafe. ${unsafeReason}.`);
  }
  try {
    // Escaped literal text cannot introduce quantifiers, groups or backreferences.
    return new RegExp(literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, flags);
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

function formatContentEntry(
  filePath: string,
  lineNumber: number,
  separator: ':' | '-',
  text: string,
): string {
  const entry = `${filePath}${separator}${lineNumber}${separator} ${text}`;
  const characters = Array.from(entry);
  if (characters.length <= MAX_RENDERED_ENTRY_CHARS) return entry;
  const hint = `… [line clipped; use read offset=${lineNumber}, then its line_offset cursor]`;
  const prefixLength = Math.max(0, MAX_RENDERED_ENTRY_CHARS - Array.from(hint).length);
  return `${characters.slice(0, prefixLength).join('')}${hint}`;
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
      const text = lines[idx]!.trim();
      entries.push(formatContentEntry(filePath, idx + 1, ':', text));
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
      const text = lines[i]!.trim();
      entries.push(formatContentEntry(filePath, i + 1, sep, text));
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
    if (outputMode !== 'count' && matchRanges.length >= remaining) break;
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
      const text = lines[i]!.trim();
      entries.push(formatContentEntry(filePath, i + 1, sep, text));
    }
    lastOutput = end;
  }

  return { entries, matchCount: matchRanges.length };
}

/* ---------- Output ---------- */

function buildReadWarning(errors: readonly string[]): string {
  if (errors.length === 0) return '';
  return `\n\n[SOURCE_INCOMPLETE: ${errors.length} file(s) could not be read: ${errors.join('; ')}.]`;
}

function buildPageMarker(offset: number, resultCount: number, hasMore: boolean): string {
  if (!hasMore) return '';
  return `\n\n[More matches available. Continue with offset=${offset + resultCount}.]`;
}

function fitResultPage(entries: readonly string[]): {
  readonly entries: string[];
  readonly truncated: boolean;
} {
  const result: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(`${result.length > 0 ? '\n' : ''}${entry}`, 'utf8');
    if (result.length > 0 && bytes + entryBytes > MAX_RESULT_PAGE_BYTES) {
      return { entries: result, truncated: true };
    }
    result.push(entry);
    bytes += entryBytes;
  }
  return { entries: result, truncated: false };
}

const MAX_SCAN_FILES_PER_CALL = 512;

function readScanOffset(value: unknown): number | undefined {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
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
  const offset = Math.max(0, Math.floor((input.offset as number) ?? 0));
  const scanOffset = readScanOffset(input.scan_offset);
  if (scanOffset === undefined) {
    return '[Tool Error] grep: scan_offset must be a non-negative finite number.';
  }
  const rawHeadLimit = input.head_limit;
  if (rawHeadLimit !== undefined && (
    typeof rawHeadLimit !== 'number'
    || !Number.isFinite(rawHeadLimit)
    || rawHeadLimit < 0
  )) {
    return '[Tool Error] grep: head_limit must be a non-negative finite number.';
  }
  const headLimit = Math.floor(rawHeadLimit ?? DEFAULT_HEAD_LIMIT);
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
    regex = createSafeRegex(pattern, flags, input.literal === true);
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

  const collectLimit = outputMode === 'count' || headLimit === 0
    ? Number.POSITIVE_INFINITY
    : headLimit + offset + 1;
  const allEntries: string[] = [];
  const readErrors: string[] = [];
  let totalMatchCount = 0;
  let scannedFiles = 0;
  let candidateFiles = 0;
  let policyExcludedFiles = 0;

  const processFile = async (filePath: string): Promise<void> => {
    if (allEntries.length >= collectLimit) return;
    if (typeExtensions && !fileMatchesType(filePath, typeExtensions)) return;
    scannedFiles += 1;
    try {
      ctx.assertReadablePath?.(filePath);
    } catch {
      policyExcludedFiles += 1;
      return;
    }
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      readErrors.push(`${filePath}: ${message}`);
    }
  };

  if (stat.isFile()) {
    candidateFiles = 1;
    if (scanOffset === 0) await processFile(resolvedPath);
  } else {
    const globPattern = fileGlob ?? '**/*';
    const files = await globAsync(globPattern, {
      cwd: resolvedPath,
      nodir: true,
      absolute: true,
      ignore: ['**/node_modules/**', '**/.*'],
    });

    const eligibleFiles = typeExtensions
      ? files.filter((file) => fileMatchesType(file, typeExtensions))
      : files;
    eligibleFiles.sort((left, right) => left.localeCompare(right));
    candidateFiles = eligibleFiles.length;
    for (const file of eligibleFiles.slice(scanOffset, scanOffset + MAX_SCAN_FILES_PER_CALL)) {
      await processFile(file);
      if (allEntries.length >= collectLimit) break;
    }
  }

  const readWarning = buildReadWarning(readErrors);
  const policyWarning = policyExcludedFiles > 0
    ? `\n\n[${policyExcludedFiles} file(s) excluded by the active read policy.]`
    : '';
  const nextScanOffset = scanOffset + scannedFiles;
  const scanWarning = nextScanOffset < candidateFiles
    ? `\n\n[SOURCE_INCOMPLETE: scanned ${scannedFiles} of ${candidateFiles} candidate file(s) from scan_offset=${scanOffset}; continue with scan_offset=${nextScanOffset} or narrow path.]`
    : '';
  const sourceWarning = `${readWarning}${policyWarning}${scanWarning}`;
  if (outputMode === 'count') return `${totalMatchCount} matches${sourceWarning}`;
  if (allEntries.length === 0) return `No matches for "${pattern}"${sourceWarning}`;

  const sliced =
    headLimit === 0
      ? allEntries.slice(offset)
      : allEntries.slice(offset, offset + headLimit);

  if (sliced.length === 0) {
    return `No matches for "${pattern}" in the requested range (offset=${offset})${sourceWarning}`;
  }

  const page = fitResultPage(sliced);
  const hasMore = page.truncated || allEntries.length > offset + page.entries.length;
  return `${page.entries.join('\n')}${buildPageMarker(offset, page.entries.length, hasMore)}${sourceWarning}`;
}
