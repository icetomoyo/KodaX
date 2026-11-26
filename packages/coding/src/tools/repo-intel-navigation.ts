/**
 * `find_symbol` and `file_outline`: the Host's RepoIntel engine (v2) answering where a name
 * is defined and used, and what a file defines. While the index is still being built they
 * give no results, because a partial answer reads as a complete one: a caller the index has
 * not reached yet would look like no caller at all.
 */

import path from 'node:path';
import type { RepoIntelQuery } from '../repo-intelligence/engine/supervisor.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionCwd, resolveExecutionPath } from '../runtime-paths.js';

const PAGE = 50;
const STALE = ' (changed since indexed; lines may have moved)';

interface Coverage {
  readonly state: string;
  readonly indexed: number;
  readonly notIndexed: Readonly<Record<string, number>>;
}

interface Hit {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly container: string | null;
  readonly line: number;
  readonly endLine?: number;
  readonly stale?: boolean;
  readonly precision?: string;
  readonly signature?: string;
}

interface Page {
  readonly hits: readonly Hit[];
  readonly total: number;
  readonly resolved?: number;
  readonly nextOffset: number | null;
  readonly coverage: Coverage;
}

type Outline =
  | { readonly path: string; readonly indexed: true; readonly language: string; readonly withSyntaxErrors: boolean; readonly definitions: readonly Hit[] }
  | { readonly path: string; readonly indexed: false; readonly reason: string };

/** Repository paths as the model uses them: relative to the folder it works in. */
type Show = (repoPath: string) => string;

export async function toolFindSymbol(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const repo = ctx.repoIntel;
  if (!repo) return unavailable();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return '[Tool Error] find_symbol: `name` is required.';
  const defining = repoPath(input.path, ctx, repo);
  if (defining instanceof Error) return `[Tool Error] find_symbol: ${defining.message}`;
  const offset = Number.isInteger(input.offset) && Number(input.offset) > 0 ? Number(input.offset) : 0;
  const show = shownFrom(ctx, repo);
  try {
    if (input.references !== true) {
      const page = await repo.request<Page>('symbols.definitions', { name, limit: PAGE, offset });
      return notReady(page.coverage) ?? definitions(name, page, show, offset);
    }
    const defined = await repo.request<Page>('symbols.definitions', { name, limit: PAGE, offset: 0 });
    const waiting = notReady(defined.coverage);
    if (waiting) return waiting;
    const owner = defining ?? onlyFile(defined);
    const uses = await repo.request<Page>('symbols.references', { name, ...(owner ? { path: owner } : {}), limit: PAGE, offset });
    const parts = [offset === 0 && defined.total > 0 ? definitions(name, defined, show, 0, false) : '', references(name, owner, defined, uses, show)];
    return parts.filter(Boolean).join('\n\n');
  } catch (error: unknown) {
    return cannotAnswer(error);
  }
}

export async function toolFileOutline(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const repo = ctx.repoIntel;
  if (!repo) return unavailable();
  const file = repoPath(input.path, ctx, repo);
  if (file === undefined) return '[Tool Error] file_outline: `path` is required.';
  if (file instanceof Error) return `[Tool Error] file_outline: ${file.message}`;
  const show = shownFrom(ctx, repo);
  try {
    const outline = await repo.request<Outline>('file.outline', { path: file });
    if (!outline.indexed) return `${show(outline.path)} is not indexed (${outline.reason}). Read it instead.`;
    const count = `${outline.definitions.length} definition${outline.definitions.length === 1 ? '' : 's'}`;
    const broken = outline.withSyntaxErrors ? '; it has syntax errors, so some may be missing' : '';
    const lines = outline.definitions.map(hit => `${hit.container ? '    ' : '  '}${lineRange(hit)} ${hit.signature ?? `${hit.kind} ${hit.name}`}`);
    return [`${show(outline.path)} (${outline.language}, ${count}${broken})`, ...lines].join('\n');
  } catch (error: unknown) {
    return cannotAnswer(error);
  }
}

function definitions(name: string, page: Page, show: Show, offset: number, paged = true): string {
  if (page.total === 0) return `No definition of \`${name}\` in the index of ${page.coverage.indexed} files.${skipped(page.coverage)}`;
  const heading = `${page.total} definition${page.total === 1 ? '' : 's'} of \`${name}\`:`;
  const body = byFile(page.hits).flatMap(([file, hits]) => [
    `${show(file)}${hits.some(hit => hit.stale) ? STALE : ''}`,
    ...hits.map(hit => `  ${lineRange(hit)} ${hit.kind} ${hit.container ? `${hit.container}.` : ''}${hit.name}`),
  ]);
  return [heading, ...body, ...(paged ? more(page, offset) : [])].join('\n');
}

function references(name: string, owner: string | undefined, defined: Page, uses: Page, show: Show): string {
  if (owner === undefined) {
    const where = defined.total === 0
      ? `No definition of \`${name}\` is in the index (it may come from a library).`
      : `\`${name}\` has ${defined.total} definitions in different files; give \`path\` to resolve its uses through imports.`;
    return [`${where} ${uses.total} uses matched by name only:`, ...lineLists(uses.hits, show), ...more(uses)].join('\n');
  }
  const resolved = uses.resolved ?? 0;
  const sections: string[] = [`${uses.total} uses of \`${name}\` defined in ${show(owner)}:`];
  const syntactic = uses.hits.filter(hit => hit.precision === 'syntactic');
  const byName = uses.hits.filter(hit => hit.precision !== 'syntactic');
  if (syntactic.length > 0) sections.push(`Resolved through imports (${resolved}):`, ...lineLists(syntactic, show));
  if (byName.length > 0) sections.push(`Matched by name only, so possibly another \`${name}\` (${uses.total - resolved}):`, ...lineLists(byName, show));
  return [...sections, ...more(uses)].join('\n');
}

/** One line per file: `path: 4, 19`. */
function lineLists(hits: readonly Hit[], show: Show): string[] {
  return byFile(hits).map(([file, inFile]) =>
    `${show(file)}${inFile.some(hit => hit.stale) ? STALE : ''}: ${inFile.map(hit => hit.line).join(', ')}`);
}

function byFile(hits: readonly Hit[]): Array<[string, Hit[]]> {
  const files = new Map<string, Hit[]>();
  for (const hit of hits) files.set(hit.path, [...(files.get(hit.path) ?? []), hit]);
  return [...files];
}

function lineRange(hit: Hit): string {
  return hit.endLine !== undefined && hit.endLine !== hit.line ? `${hit.line}-${hit.endLine}` : `${hit.line}`;
}

function more(page: Page, offset = 0): string[] {
  return page.nextOffset === null || page.nextOffset <= offset ? [] : [`More: call again with offset ${page.nextOffset}.`];
}

/** The one file defining the name, when there is exactly one. */
function onlyFile(page: Page): string | undefined {
  const files = new Set(page.hits.map(hit => hit.path));
  return page.total > 0 && page.nextOffset === null && files.size === 1 ? [...files][0] : undefined;
}

function notReady(coverage: Coverage): string | undefined {
  if (coverage.state === 'ready') return undefined;
  if (coverage.state === 'indexing') {
    return `The repository index is still being built (${coverage.indexed} files so far). Its answers would be incomplete, `
      + 'so it gives none yet. Use grep and read instead.';
  }
  return `The repository index is not usable now (${coverage.state}). Use grep and read instead.`;
}

function skipped(coverage: Coverage): string {
  const reasons = Object.entries(coverage.notIndexed).filter(([, count]) => count > 0);
  return reasons.length === 0 ? '' : ` Not indexed: ${reasons.map(([reason, count]) => `${reason} ${count}`).join(', ')}; grep reaches those.`;
}

function cannotAnswer(error: unknown): string {
  return `The repository index cannot answer now (${error instanceof Error ? error.message : String(error)}). Use grep and read instead.`;
}

function unavailable(): string {
  return 'The repository index is not available in this session. Use grep and read instead.';
}

/** A path the model gave, as a path in the repository; undefined when none was given. */
function repoPath(value: unknown, ctx: KodaXToolExecutionContext, repo: RepoIntelQuery): string | Error | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const relative = path.relative(repo.root, resolveExecutionPath(value.trim(), ctx));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return new Error(`${value} is outside the repository ${repo.root}.`);
  }
  return relative.split(path.sep).join('/');
}

function shownFrom(ctx: KodaXToolExecutionContext, repo: RepoIntelQuery): Show {
  const cwd = resolveExecutionCwd(ctx);
  return repoPathname => path.relative(cwd, path.join(repo.root, repoPathname)).split(path.sep).join('/');
}
