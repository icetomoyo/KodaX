/**
 * KodaX Grep Tool
 *
 * 文本搜索工具
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import { glob as globAsync } from 'glob';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPathOrCwd } from '../runtime-paths.js';

const MAX_GREP_PATTERN_LENGTH = 256;
const INVALID_OUTPUT_MODES = new Set(['content', 'files_with_matches', 'count']);

function getUnsafeRegexReason(pattern: string): string | null {
  if (!pattern.trim()) {
    return 'Pattern must not be empty';
  }

  if (pattern.length > MAX_GREP_PATTERN_LENGTH) {
    return `Pattern exceeds the ${MAX_GREP_PATTERN_LENGTH}-character safety limit`;
  }

  if (pattern.includes('\0')) {
    return 'Pattern must not contain null bytes';
  }

  if (/\\[1-9]/.test(pattern)) {
    return 'Backreferences are not allowed';
  }

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

function createSafeRegex(pattern: string, ignoreCase: boolean): RegExp {
  const unsafeReason = getUnsafeRegexReason(pattern);
  if (unsafeReason) {
    throw new Error(`Pattern rejected as potentially unsafe. ${unsafeReason}.`);
  }

  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex pattern. ${message}`);
  }
}

export async function toolGrep(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) ?? ctx.executionCwd ?? ctx.gitRoot;
  const ignoreCase = (input.ignore_case as boolean) ?? false;
  const outputMode = (input.output_mode as string) ?? 'content';
  const resolvedPath = resolveExecutionPathOrCwd(searchPath, ctx);
  const results: string[] = [];
  let regex: RegExp;

  if (!INVALID_OUTPUT_MODES.has(outputMode)) {
    return `[Tool Error] grep: Unsupported output mode "${outputMode}"`;
  }

  try {
    regex = createSafeRegex(pattern, ignoreCase);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] grep: ${message}`;
  }

  const stat = fsSync.existsSync(resolvedPath) ? fsSync.statSync(resolvedPath) : null;
  if (!stat) {
    return `[Tool Error] grep: Path not found: ${searchPath}`;
  }

  if (stat?.isFile()) {
    try {
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < 200; i++) {
        if (regex.test(lines[i]!)) {
          if (outputMode === 'files_with_matches') { results.push(resolvedPath); break; }
          else results.push(`${resolvedPath}:${i + 1}: ${lines[i]!.trim()}`);
        }
      }
    } catch {
      // Skip unreadable files and continue with a best-effort search result.
    }
  } else {
    const files = (await globAsync('**/*', { cwd: resolvedPath, nodir: true, absolute: true, ignore: ['**/node_modules/**', '**/.*'] })).slice(0, 100);
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < 200; i++) {
          if (regex.test(lines[i]!)) {
            if (outputMode === 'files_with_matches') { results.push(file); break; }
            else results.push(`${file}:${i + 1}: ${lines[i]!.trim()}`);
          }
        }
      } catch {
        // Skip unreadable files and continue with a best-effort search result.
      }
    }
  }
  if (outputMode === 'count') return `${results.length} matches`;
  return results.length ? results.join('\n') : `No matches for "${pattern}"`;
}
