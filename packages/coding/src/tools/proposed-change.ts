/**
 * What a file tool would change, worked out before it runs so a person can see
 * it when asked to approve. It plans with the tools' own matching rules, so the
 * approval shows the change the tool then makes to the same file.
 */
import fs from 'node:fs/promises';

import { resolveExecutionPath } from '../runtime-paths.js';
import { generateDiff } from './diff.js';
import { prepareInsertionContent, resolveAnchorInsertion } from './insert-after-anchor.js';
import { applyOneEdit } from './multi-edit.js';

/** A file change as a person reviews it. `unified` holds standard unified-diff hunks, without the file header lines. */
export interface ProposedFileChange {
  /** The file on the Host the tool would change. */
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly unified: string;
  /** The hunks were cut at a line to stay within the cap; the counts are for the whole change. */
  readonly truncated?: true;
}

/** Larger files are not read just to show a diff; the approval goes without one. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** How much of the hunks an approval carries. */
const MAX_UNIFIED_CHARS = 64 * 1024;

/**
 * The change `toolName` would make with `input`, relative paths resolved against
 * `executionCwd`. Undefined when the tool changes no file, or when it would
 * refuse; the tool reports why once it runs.
 */
export async function proposeFileChange(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  executionCwd: string,
): Promise<ProposedFileChange | undefined> {
  if (!PLANNERS.has(toolName) || typeof input.path !== 'string' || input.path.length === 0) return undefined;
  const filePath = resolveExecutionPath(input.path, { executionCwd });
  const file = await readForPlanning(filePath);
  if (file === undefined) return undefined;
  const before = file.exists ? file.content : undefined;
  const after = PLANNERS.get(toolName)!(before, input);
  if (after === undefined || after === before) return undefined;
  return describeChange(filePath, before === undefined ? newFileHunks(after) : changedHunks(before, after));
}

/** The file's next content, or undefined when the tool would refuse. `before` is undefined for a missing file. */
type Planner = (before: string | undefined, input: Readonly<Record<string, unknown>>) => string | undefined;

const planEdits: Planner = (before, input) => {
  if (before === undefined) return undefined;
  const edits = Array.isArray(input.edits) ? input.edits as unknown[] : [input];
  if (edits.length === 0) return undefined;
  let content = before;
  for (const [index, edit] of edits.entries()) {
    if (edit === null || typeof edit !== 'object') return undefined;
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } = edit as Record<string, unknown>;
    if (typeof oldString !== 'string' || typeof newString !== 'string' || oldString.length === 0) return undefined;
    const applied = applyOneEdit(content, { old_string: oldString, new_string: newString, replace_all: replaceAll === true }, index, before, 'multi_edit');
    if ('error' in applied) return undefined;
    content = applied.content;
  }
  return content;
};

const PLANNERS: ReadonlyMap<string, Planner> = new Map<string, Planner>([
  ['edit', planEdits],
  ['multi_edit', planEdits],
  ['write', (_before, input) => (typeof input.content === 'string' ? input.content : undefined)],
  ['insert_after_anchor', (before, input) => {
    if (before === undefined || typeof input.anchor !== 'string' || typeof input.content !== 'string') return undefined;
    const insertion = resolveAnchorInsertion(before, input.anchor);
    if (insertion.status !== 'unique') return undefined;
    return before.slice(0, insertion.index) + prepareInsertionContent(before, insertion.index, input.content) + before.slice(insertion.index);
  }],
]);

/** The file as a plan starts from. Undefined when it is no regular file or too large to read for a diff. */
async function readForPlanning(filePath: string): Promise<{ readonly exists: false } | { readonly exists: true; readonly content: string } | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    return { exists: true, content: await fs.readFile(filePath, 'utf8') };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

/** A new file is all added lines. */
function newFileHunks(content: string): string[] {
  const lines = (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n');
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)];
}

function changedHunks(before: string, after: string): string[] {
  // The newline that ends both files is no line of its own.
  const [from, to] = before.endsWith('\n') && after.endsWith('\n') ? [before.slice(0, -1), after.slice(0, -1)] : [before, after];
  // generateDiff starts with the `---` and `+++` lines, which the path replaces, and puts
  // a space after each line's sign; standard hunks have none.
  return generateDiff(from, to, '').split('\n').slice(2).map(line => (line.startsWith('@@') ? line : line[0] + line.slice(2)));
}

function describeChange(filePath: string, hunks: readonly string[]): ProposedFileChange {
  let added = 0;
  let removed = 0;
  for (const line of hunks) {
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  const unified = hunks.join('\n');
  if (unified.length <= MAX_UNIFIED_CHARS) return { path: filePath, added, removed, unified };
  const cut = unified.lastIndexOf('\n', MAX_UNIFIED_CHARS);
  return { path: filePath, added, removed, unified: unified.slice(0, Math.max(cut, 0)), truncated: true };
}
