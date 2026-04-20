/**
 * PasteStore — per-session paste content registry + placeholder ref helpers.
 *
 * Design: see docs/KNOWN_ISSUES.md Issue 121 (三层防御：粘贴拦截 / 输入兜底 / 渲染硬上限).
 * Reference implementation: Claude Code src/history.ts + src/utils/pasteStore.ts.
 *
 * Responsibilities (pure / deterministic where possible):
 * - Format / parse `[Pasted text #N +K lines]` and related refs
 * - Allocate monotonic per-session paste IDs
 * - Store / expand paste content in memory
 * - Find placeholder boundaries adjacent to cursor (for atomic edit)
 *
 * Stateful concerns are confined to the `PasteStore` class. Everything else is
 * pure so rendering and controller code can call them safely.
 */

export type PastedContentType = "text" | "image";

export interface PastedContent {
  id: number;
  type: PastedContentType;
  content: string;
  /** Optional sha256 hash — set when backed by on-disk paste-cache */
  contentHash?: string;
  /** Media type for image pastes; unused for text */
  mediaType?: string;
  /** Optional filename hint for image pastes */
  filename?: string;
}

/**
 * Thresholds — single source of truth. See Issue 121 Layer 1/2/3.
 */
export const PASTE_PLACEHOLDER_CHAR_THRESHOLD = 800;
export const PASTE_PLACEHOLDER_LINE_THRESHOLD = 2;
export const LARGE_INPUT_TRUNCATE_THRESHOLD = 10_000;
export const LARGE_INPUT_PREVIEW_CHARS = 1_000; // 500 + 500

/**
 * Count newlines matching Claude Code semantics: "line1\nline2" → 1 line delta.
 */
export function getPastedTextRefNumLines(text: string): number {
  const matches = text.match(/\r\n|\r|\n/g);
  return matches ? matches.length : 0;
}

/**
 * Build a `[Pasted text #N +K lines]` reference anchor.
 * When numLines === 0 we omit the " +K lines" tail for compactness.
 */
export function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines === 0) {
    return `[Pasted text #${id}]`;
  }
  return `[Pasted text #${id} +${numLines} lines]`;
}

/**
 * Build a `[...Truncated text #N +K lines...]` reference anchor for Layer 2.
 */
export function formatTruncatedTextRef(id: number, numLines: number): string {
  return `[...Truncated text #${id} +${numLines} lines...]`;
}

/**
 * Unified reference pattern matching Pasted/Truncated text refs.
 *
 * Keeps KodaX `[Image #N]` (FEATURE_031) recognition compatible so a single
 * downstream consumer (e.g. future `preExpansionValue` keyword detection) can
 * iterate all three ref kinds with one pass.
 */
export const REFERENCE_PATTERN =
  /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.*)\]/g;

export interface ParsedReference {
  id: number;
  kind: "Pasted text" | "Image" | "...Truncated text";
  match: string;
  index: number;
}

/**
 * Parse all reference anchors in `input` — returns them in source order with
 * absolute match indices. Safe against overlapping regex state by using a
 * fresh matchAll iteration.
 */
export function parseReferences(input: string): ParsedReference[] {
  const out: ParsedReference[] = [];
  const pattern = new RegExp(REFERENCE_PATTERN.source, "g");
  for (const match of input.matchAll(pattern)) {
    const id = Number.parseInt(match[2] ?? "0", 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    out.push({
      id,
      kind: match[1] as ParsedReference["kind"],
      match: match[0],
      index: match.index ?? 0,
    });
  }
  return out;
}

/**
 * Replace `[Pasted text #N]` / `[...Truncated text #N ...]` placeholders with
 * their full stored content. `[Image #N]` refs are LEFT ALONE — they are
 * consumed downstream as structured content blocks, not inlined text.
 *
 * Missing ids pass through as the literal placeholder (keeps user intent when
 * the map was cleared or the content expired on disk).
 *
 * Replaces in reverse offset order so earlier match offsets remain valid after
 * later substitutions.
 */
export function expandPastedTextRefs(
  input: string,
  pastedContents: ReadonlyMap<number, PastedContent> | Record<number, PastedContent>,
): string {
  const refs = parseReferences(input);
  if (refs.length === 0) return input;

  const getContent = (id: number): PastedContent | undefined => {
    if (pastedContents instanceof Map) return pastedContents.get(id);
    return (pastedContents as Record<number, PastedContent>)[id];
  };

  let out = input;
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!;
    if (ref.kind === "Image") continue;
    const content = getContent(ref.id);
    if (!content || content.type !== "text") continue;
    out =
      out.slice(0, ref.index) +
      content.content +
      out.slice(ref.index + ref.match.length);
  }
  return out;
}

/**
 * Pattern used for atomic-edit adjacency detection. Same family as
 * REFERENCE_PATTERN but anchored at start or end of a string segment.
 */
const PLACEHOLDER_BEFORE_CURSOR =
  /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.*)\]$/;
const PLACEHOLDER_AT_CURSOR =
  /^\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.*)\]/;

export interface PlaceholderBounds {
  start: number;
  end: number;
  id: number;
  kind: ParsedReference["kind"];
}

/**
 * Claude Code-style atomic-edit trigger: only fire when cursor is at a WORD
 * BOUNDARY (next char is whitespace or EOL). Prevents stealing a backspace
 * when the user is deleting text that happens to LOOK like a placeholder
 * suffix but where they are actually editing characters immediately after it.
 *
 * See Claude Code src/utils/Cursor.ts deleteTokenBefore for the original
 * behavior this mirrors.
 */
function isAtWordBoundaryAfter(text: string, offset: number): boolean {
  if (offset >= text.length) return true;
  const nextChar = text[offset];
  return !nextChar || /\s/.test(nextChar);
}

function isAtWordBoundaryBefore(text: string, offset: number): boolean {
  if (offset === 0) return true;
  const prevChar = text[offset - 1];
  return !prevChar || /\s/.test(prevChar);
}

/**
 * Is there a placeholder ending at `cursorOffset` that backspace should eat
 * in one atomic delete? Returns its absolute bounds or null.
 */
export function findPlaceholderBeforeCursor(
  text: string,
  cursorOffset: number,
): PlaceholderBounds | null {
  if (cursorOffset <= 0) return null;
  if (!isAtWordBoundaryAfter(text, cursorOffset)) return null;

  const before = text.slice(0, cursorOffset);
  const match = before.match(PLACEHOLDER_BEFORE_CURSOR);
  if (!match) return null;

  const start = cursorOffset - match[0].length;
  const id = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isFinite(id) || id <= 0) return null;

  return {
    start,
    end: cursorOffset,
    id,
    kind: match[1] as ParsedReference["kind"],
  };
}

/**
 * Is there a placeholder starting at `cursorOffset` that delete-forward
 * should eat in one atomic delete? Returns its absolute bounds or null.
 */
export function findPlaceholderAfterCursor(
  text: string,
  cursorOffset: number,
): PlaceholderBounds | null {
  if (cursorOffset >= text.length) return null;
  if (!isAtWordBoundaryBefore(text, cursorOffset)) return null;

  const after = text.slice(cursorOffset);
  const match = after.match(PLACEHOLDER_AT_CURSOR);
  if (!match) return null;

  const id = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isFinite(id) || id <= 0) return null;

  return {
    start: cursorOffset,
    end: cursorOffset + match[0].length,
    id,
    kind: match[1] as ParsedReference["kind"],
  };
}

/**
 * Decide if an insertion should be replaced by a placeholder. Double-threshold
 * (char count OR logical line count) so narrow terminals still catch line-
 * heavy pastes and dense single-line pastes.
 */
export function shouldReplacePasteWithPlaceholder(text: string): boolean {
  if (text.length > PASTE_PLACEHOLDER_CHAR_THRESHOLD) return true;
  if (getPastedTextRefNumLines(text) > PASTE_PLACEHOLDER_LINE_THRESHOLD) {
    return true;
  }
  return false;
}

/**
 * Truncate a long non-paste input into a head + `[...Truncated text #N +K lines...]`
 * + tail shape. See Layer 2 in Issue 121.
 *
 * Returns the rewritten text plus the extracted middle to be stored in the
 * paste registry. If the input is below threshold, returns { truncatedText: text,
 * placeholderContent: "" } (no-op signal).
 */
export interface MaybeTruncateResult {
  truncatedText: string;
  placeholderContent: string;
}

export function maybeTruncateLongInput(
  text: string,
  nextPasteId: number,
): MaybeTruncateResult {
  if (text.length <= LARGE_INPUT_TRUNCATE_THRESHOLD) {
    return { truncatedText: text, placeholderContent: "" };
  }
  const startLength = Math.floor(LARGE_INPUT_PREVIEW_CHARS / 2);
  const endLength = Math.floor(LARGE_INPUT_PREVIEW_CHARS / 2);
  const startText = text.slice(0, startLength);
  const endText = text.slice(-endLength);
  const placeholderContent = text.slice(startLength, -endLength);
  const truncatedLines = getPastedTextRefNumLines(placeholderContent);
  const ref = formatTruncatedTextRef(nextPasteId, truncatedLines);
  return {
    truncatedText: startText + ref + endText,
    placeholderContent,
  };
}

/**
 * Session-scoped stateful registry. One instance per REPL session (not per
 * paste). Lives as long as the composer. IDs are monotonic and never recycled
 * so undo/redo never collides with a fresh paste that reused an id.
 */
export class PasteStore {
  private readonly contents = new Map<number, PastedContent>();
  private nextId = 1;

  /**
   * Register text content, returns the allocated id + the placeholder string
   * to insert into the buffer in place of the raw content.
   */
  registerText(content: string): { id: number; placeholder: string; numLines: number } {
    const id = this.nextId++;
    const numLines = getPastedTextRefNumLines(content);
    this.contents.set(id, { id, type: "text", content });
    return { id, placeholder: formatPastedTextRef(id, numLines), numLines };
  }

  /**
   * Register pre-computed Layer 2 truncation output. Caller is responsible
   * for constructing the truncated text; this just stores the middle chunk.
   */
  registerTruncatedText(content: string): { id: number; numLines: number } {
    const id = this.nextId++;
    const numLines = getPastedTextRefNumLines(content);
    this.contents.set(id, { id, type: "text", content });
    return { id, numLines };
  }

  /**
   * Adopt a pre-allocated id + content (e.g. when restoring from disk-backed
   * input history).
   */
  adopt(entry: PastedContent): void {
    this.contents.set(entry.id, entry);
    if (entry.id >= this.nextId) {
      this.nextId = entry.id + 1;
    }
  }

  /** Allocate the NEXT id without registering anything yet. */
  peekNextId(): number {
    return this.nextId;
  }

  get(id: number): PastedContent | undefined {
    return this.contents.get(id);
  }

  /** Expand all placeholders in `input` using this store's contents. */
  expand(input: string): string {
    return expandPastedTextRefs(input, this.contents);
  }

  /**
   * Snapshot the current contents map. Returned map is a COPY — mutation does
   * not leak back. Used by undo buffer snapshots.
   */
  snapshot(): Map<number, PastedContent> {
    return new Map(this.contents);
  }

  /** Replace contents from a snapshot. Used by undo. `nextId` preserved. */
  restore(snapshot: ReadonlyMap<number, PastedContent>): void {
    this.contents.clear();
    for (const [k, v] of snapshot) {
      this.contents.set(k, v);
    }
    // Keep nextId monotonic — never reallocate ids even after restore.
    for (const id of snapshot.keys()) {
      if (id >= this.nextId) this.nextId = id + 1;
    }
  }

  /**
   * Session-level reset. Called on `/clear`, start-new-session, etc.
   * Does NOT clear on per-submit since Up-arrow navigation re-submits may
   * reuse stored refs.
   */
  reset(): void {
    this.contents.clear();
    this.nextId = 1;
  }

  size(): number {
    return this.contents.size;
  }

  /** Export contents for persistence (input history serialization). */
  export(): PastedContent[] {
    return Array.from(this.contents.values());
  }
}

/**
 * Module-scoped PasteStore singleton. Lives at module scope (not per hook
 * instance) so it survives PromptComposer unmount+remount — same rationale
 * as FEATURE_077's module-scoped `historyStore` in useInputHistory.
 *
 * Without this, Ctrl+O transcript toggle (which unmounts the composer) would
 * reset `nextId` to 1, causing fresh pastes to collide with old history
 * entries that reference the same id.
 *
 * Slash-command handlers (e.g. `/paste show <id>`) access it via
 * `getActivePasteStore()`. Tests use `__resetPasteStoreForTesting()` to
 * isolate state.
 */
let moduleStore: PasteStore | null = null;

/**
 * Return the process-wide PasteStore, creating it on first access.
 */
export function getOrCreateModulePasteStore(): PasteStore {
  if (moduleStore === null) {
    moduleStore = new PasteStore();
  }
  return moduleStore;
}

/**
 * Slash-command accessor. Returns the module-scoped store if a composer has
 * ever mounted in this process, or undefined for pure non-REPL entry points
 * (tests that never touched useTextBuffer).
 */
export function getActivePasteStore(): PasteStore | undefined {
  return moduleStore ?? undefined;
}

/** Test-only helper — drops the module singleton between tests. */
export function __resetPasteStoreForTesting(): void {
  moduleStore = null;
}
