import { Buffer } from 'node:buffer';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';

// Bounds apply only to the new Markdown fragments, separately for each scope.
const MAX_RULE_BYTES = 8 * 1024;
const MAX_SCOPE_BYTES = 16 * 1024;

export interface RuleDiagnostic {
  path: string;
  reason: string;
}

export interface RulesLoadOptions {
  assertReadablePath?: (path: string) => void;
  onDiagnostic?: (diagnostic: RuleDiagnostic) => void;
}

interface RuleFile {
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

function report(options: RulesLoadOptions, path: string, reason: string): void {
  const diagnostic = { path, reason };
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
  if (!stat.isFile()) throw new Error('expected a regular file without a symbolic link');
  if (stat.size > MAX_RULE_BYTES) throw new Error(`file exceeds ${MAX_RULE_BYTES} UTF-8 bytes`);
  const stamp = version(stat);
  const cached = contentCache.get(path);
  if (cached?.version === stamp) return cached.content;

  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('file changed while opening, retry loading the rules');
    }
    if (!opened.isFile() || opened.size > MAX_RULE_BYTES) {
      throw new Error(`expected a regular file of at most ${MAX_RULE_BYTES} UTF-8 bytes`);
    }
    const buffer = Buffer.alloc(MAX_RULE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_RULE_BYTES) throw new Error(`file exceeds ${MAX_RULE_BYTES} UTF-8 bytes`);
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
    if (!stat.isDirectory()) throw new Error('expected a rules directory');
    if (!inside(realpathSync(boundary), realpathSync(dir))) {
      throw new Error('rules directory escapes its scope through a link');
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
    report(options, dir, error instanceof Error ? error.message : String(error));
    return [];
  }

  let bytes = 0;
  const files: RuleFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let content: string;
    try {
      options.assertReadablePath?.(path);
      content = readRule(path);
    } catch (error) {
      contentCache.delete(path);
      report(options, path, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!content.trim()) continue;
    // Reserve the source heading and separators too, so tiny fragments cannot
    // turn a small body budget into an unbounded prompt.
    const size = Buffer.byteLength(content, 'utf8') + Buffer.byteLength(path, 'utf8') + 64;
    if (bytes + size > MAX_SCOPE_BYTES) {
      report(options, path, `scope exceeds ${MAX_SCOPE_BYTES} UTF-8 bytes`);
      continue;
    }
    bytes += size;
    files.push({ path, content, scope });
  }
  return files;
}
