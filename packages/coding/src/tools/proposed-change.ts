/**
 * What a file tool would change, worked out before it runs so a person can see
 * it when asked to approve. It plans with the tools' own matching rules, so the
 * approval shows the change the tool then makes to the same file.
 */
import fs from 'node:fs/promises';

import { resolveExecutionPath } from '../runtime-paths.js';
import { describeFileChange, MAX_FILE_CHANGE_BYTES, type ProposedFileChange } from './file-change.js';
import { prepareInsertionContent, resolveAnchorInsertion } from './insert-after-anchor.js';
import { applyOneEdit } from './multi-edit.js';

export type { ProposedFileChange } from './file-change.js';

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
  return after === undefined ? undefined : describeFileChange(filePath, before, after);
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
    if (!stat.isFile() || stat.size > MAX_FILE_CHANGE_BYTES) return undefined;
    return { exists: true, content: await fs.readFile(filePath, 'utf8') };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}
