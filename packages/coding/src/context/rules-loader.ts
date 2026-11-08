import { Buffer } from 'node:buffer';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';

// Bounds apply only to the new Markdown fragments, separately for each scope.
const MAX_RULE_BYTES = 8 * 1024;
const MAX_SCOPE_BYTES = 16 * 1024;

export interface RuleDiagnostic {
  path: string;
  code: RuleDiagnosticCode;
  reason: string;
}

export type RuleDiagnosticCode = 'not_regular_file' | 'file_too_large' | 'source_changed'
  | 'scope_escape' | 'directory_unavailable' | 'read_failed' | 'access_denied' | 'scope_budget_exceeded' | 'empty';

class RuleLoadError extends Error {
  constructor(readonly code: RuleDiagnosticCode, message: string) { super(message); }
}

export interface RulesLoadOptions {
  assertReadablePath?: (path: string) => void;
  onDiagnostic?: (diagnostic: RuleDiagnostic) => void;
}

interface RuleFile {
  readonly kind: 'rule';
  path: string;
  content: string;
  scope: 'global' | 'project';
}

const directoryCache = new Map<string, { version: string; names: string[] }>();
const contentCache = new Map<string, { version: string; content: string }>();

export function clearRulesLoaderCache(): void {
  directoryCache.clear();
  contentCache.clear();
}

function evictDirectory(dir: string): void {
  for (const name of directoryCache.get(dir)?.names ?? []) contentCache.delete(join(dir, name));
  directoryCache.delete(dir);
}

function report(options: RulesLoadOptions, path: string, reason: string, code: RuleDiagnosticCode): void {
  const diagnostic = { path, code, reason };
  if (options.onDiagnostic) options.onDiagnostic(diagnostic);
  else emitKodaXDiagnostic({
    source: 'coding:rules', level: 'warn', message: 'Skipped Markdown rule', detail: diagnostic,
  });
}

function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
}

function version(stat: { mtimeMs: number; ctimeMs: number; size: number; ino: number }): string {
  return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
}

function readRule(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new RuleLoadError('not_regular_file', 'expected a regular file without a symbolic link');
  if (stat.size > MAX_RULE_BYTES) throw new RuleLoadError('file_too_large', `file exceeds ${MAX_RULE_BYTES} UTF-8 bytes`);
  const stamp = version(stat);
  const cached = contentCache.get(path);
  if (cached?.version === stamp) return cached.content;

  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new RuleLoadError('source_changed', 'file changed while opening, retry loading the rules');
    }
    if (!opened.isFile() || opened.size > MAX_RULE_BYTES) {
      throw new RuleLoadError(opened.isFile() ? 'file_too_large' : 'not_regular_file', `expected a regular file of at most ${MAX_RULE_BYTES} UTF-8 bytes`);
    }
    const buffer = Buffer.alloc(MAX_RULE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_RULE_BYTES) throw new RuleLoadError('file_too_large', `file exceeds ${MAX_RULE_BYTES} UTF-8 bytes`);
    const content = buffer.subarray(0, length).toString('utf8');
    contentCache.set(path, { version: version(opened), content });
    return content;
  } finally {
    closeSync(fd);
  }
}

/** Direct Markdown children only. Missing directories add no model-visible text. */
export function loadRulesFiles(
  dir: string,
  boundary: string,
  scope: 'global' | 'project',
  options: RulesLoadOptions,
): RuleFile[] {
  dir = resolve(dir);
  let names: string[];
  try {
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (!stat) {
      evictDirectory(dir);
      return [];
    }
    if (!stat.isDirectory()) throw new RuleLoadError('directory_unavailable', 'expected a rules directory');
    if (!inside(realpathSync(boundary), realpathSync(dir))) {
      throw new RuleLoadError('scope_escape', 'rules directory escapes its scope through a link');
    }
    const stamp = version(stat);
    const cached = directoryCache.get(dir);
    if (cached?.version === stamp) names = cached.names;
    else {
      names = readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.name.endsWith('.md') && !entry.isDirectory())
        .map(entry => entry.name).sort();
      const retained = new Set(names);
      for (const name of cached?.names ?? []) {
        if (!retained.has(name)) contentCache.delete(join(dir, name));
      }
      directoryCache.set(dir, { version: stamp, names });
    }
  } catch (error) {
    evictDirectory(dir);
    report(options, dir, error instanceof Error ? error.message : String(error), error instanceof RuleLoadError ? error.code : 'directory_unavailable');
    return [];
  }

  let bytes = 0;
  const files: RuleFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let content: string;
    try { options.assertReadablePath?.(path); }
    catch (error) {
      contentCache.delete(path);
      report(options, path, error instanceof Error ? error.message : String(error), 'access_denied');
      continue;
    }
    try {
      content = readRule(path);
    } catch (error) {
      contentCache.delete(path);
      report(options, path, error instanceof Error ? error.message : String(error), error instanceof RuleLoadError ? error.code : 'read_failed');
      continue;
    }
    if (!content.trim()) {
      report(options, path, 'empty Markdown rule', 'empty');
      continue;
    }
    // Reserve the source heading and separators too, so tiny fragments cannot
    // turn a small body budget into an unbounded prompt.
    const size = Buffer.byteLength(content, 'utf8') + Buffer.byteLength(path, 'utf8') + 64;
    if (bytes + size > MAX_SCOPE_BYTES) {
      report(options, path, `scope exceeds ${MAX_SCOPE_BYTES} UTF-8 bytes`, 'scope_budget_exceeded');
      continue;
    }
    bytes += size;
    files.push({ kind: 'rule', path, content, scope });
  }
  return files;
}
