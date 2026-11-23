/**
 * A file change as a person reviews it: before approving a file tool, and in
 * the transcript once the tool has run.
 */
import { generateDiff } from './diff.js';

/** `unified` holds standard unified-diff hunks, without the file header lines. */
export interface ProposedFileChange {
  /** The file on the Host the tool changes. */
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly unified: string;
  /** The hunks were cut at a line to stay within the cap; the counts are for the whole change. */
  readonly truncated?: true;
}

/** Larger files are not diffed; the change goes without one. */
export const MAX_FILE_CHANGE_BYTES = 4 * 1024 * 1024;
/** How much of the hunks a change carries. */
const MAX_UNIFIED_CHARS = 64 * 1024;

/**
 * The change from `before` to `after` of `filePath`; `before` is undefined for a
 * new file. Undefined when nothing changed, or a side is too large to diff.
 */
export function describeFileChange(filePath: string, before: string | undefined, after: string): ProposedFileChange | undefined {
  if (after === before || Math.max(before?.length ?? 0, after.length) > MAX_FILE_CHANGE_BYTES) return undefined;
  return describeHunks(filePath, before === undefined ? newFileHunks(after) : changedHunks(before, after));
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

function describeHunks(filePath: string, hunks: readonly string[]): ProposedFileChange {
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
