import { randomBytes } from 'node:crypto';

const TRANSIENT_TEXT_ARTIFACT_PREFIX = 'kodax-transient://text/';
const artifacts = new Map<string, string>();
const unread = new Map<string, { offset: number; line_offset: number }>();
const originalInputs = new Set<string>();
const pageBudgets = new Map<string, number>();

/**
 * Stores request-only text in trusted process memory. The opaque capability
 * URI is not enumerable from shell sandboxes and disappears on process death.
 */
export function createTransientTextArtifact(content: string, requireCompleteRead = false, pageTokens?: number): string {
  const artifactPath = `${TRANSIENT_TEXT_ARTIFACT_PREFIX}${randomBytes(32).toString('hex')}`;
  artifacts.set(artifactPath, content);
  if (requireCompleteRead) { unread.set(artifactPath, { offset: 1, line_offset: 0 }); originalInputs.add(artifactPath); }
  if (pageTokens !== undefined) pageBudgets.set(artifactPath, pageTokens);
  return artifactPath;
}

export function isPagedOriginalInput(path: string): boolean { return originalInputs.has(path); }
export function transientPageTokenBudget(path: string): number | undefined { return pageBudgets.get(path); }

/** The memory preparer has inspected every original chunk before generation. */
export function markTransientOriginalPrepared(path: string): void { unread.delete(path); }

export function nextUnreadTransientPage(path: string): { offset: number; line_offset: number } | undefined {
  const value = unread.get(path);
  return value ? { ...value } : undefined;
}

/** Advance only across contiguous text actually returned by the read tool. */
export function recordTransientPageRead(path: string, page: { offset: number; lineOffset: number; lines: number;
  totalLines: number; continuation?: { lineNumber: number; nextOffset: number } }): void {
  const current = unread.get(path);
  if (!current || !page.lines || page.offset > current.offset
    || (page.offset === current.offset && page.lineOffset > current.line_offset)) return;
  const next = page.continuation ? { offset: page.continuation.lineNumber, line_offset: page.continuation.nextOffset }
    : { offset: page.offset + page.lines, line_offset: 0 };
  if (next.offset > page.totalLines) unread.delete(path);
  else if (next.offset > current.offset || (next.offset === current.offset && next.line_offset > current.line_offset)) unread.set(path, next);
}

export function readTransientTextArtifact(artifactPath: string): string | undefined {
  return artifactPath.startsWith(TRANSIENT_TEXT_ARTIFACT_PREFIX)
    ? artifacts.get(artifactPath)
    : undefined;
}

/** Exact capability membership check; never exposes or enumerates capability IDs. */
export function hasTransientTextArtifact(artifactPath: string): boolean {
  return artifactPath.startsWith(TRANSIENT_TEXT_ARTIFACT_PREFIX)
    && artifacts.has(artifactPath);
}

export function deleteTransientTextArtifact(artifactPath: string): void {
  if (artifactPath.startsWith(TRANSIENT_TEXT_ARTIFACT_PREFIX)) {
    artifacts.delete(artifactPath);
    unread.delete(artifactPath);
    originalInputs.delete(artifactPath);
    pageBudgets.delete(artifactPath);
  }
}
