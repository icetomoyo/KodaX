/**
 * Mutation-tool diff display-row builder.
 *
 * The live transcript renders tool results through the flat
 * `TranscriptRow[]` model (FEATURE_172/214), so edit / write /
 * multi_edit / insert_after_anchor diffs are parsed here into display
 * rows — line-number gutter, add/remove classification, and
 * changed-lines-first folding — before `transcript-layout.ts` wraps
 * them into transcript rows.
 *
 * Input shapes (all produced by packages/coding tools, raw
 * `generateDiff` output embedded verbatim):
 *
 *   [active-file-warning banner]        ← optional, prepended lines
 *   File edited: <path> [(N edits[, M replacements])]   ← preamble
 *     (+N lines, -M lines) | (N lines written)          ← summary
 *   --- <path> / +++ <path> / @@ hunks  ← unified diff body (or a
 *                                        headerless `- old\n+ new` body)
 *   [LSP diagnostics block]             ← optional, appended lines
 *
 * Folding (unless `showAll`): when the body exceeds `maxRows`, context
 * rows are shed first so changed rows survive; only when changed rows
 * alone exceed `maxRows` are they head-truncated (reported back via
 * `hiddenRowCount` so the caller can render a "… N more lines" hint).
 *
 * Returns null when the output has no diff body (new-file write,
 * no-change write, unrelated text) — the caller falls back to the
 * generic output path.
 */

export type DiffRowKind = "context" | "add" | "remove" | "note";

export interface DiffRow {
  kind: DiffRowKind;
  /** Full display text including the gutter prefix. */
  text: string;
}

export interface BuildDiffRowsOptions {
  /** Max diff body rows before folding. Default 20. */
  maxRows?: number;
  /** Disable folding entirely (transcript show-all mode). */
  showAll?: boolean;
}

export interface DiffRowsResult {
  rows: DiffRow[];
  /** Rows hidden by truncation (0 when nothing was dropped). */
  hiddenRowCount: number;
}

const DEFAULT_MAX_ROWS = 20;
/** Cap on trailing note rows (LSP diagnostics) — keeps error dumps bounded. */
const TRAILING_NOTE_CAP = 10;

const PREAMBLE_REGEX = /^(?:File (?:edited|created|updated|written)|Content inserted)/;
/** `  (+N lines, -M lines)` / `  (N lines written)` — two leading spaces. */
const SUMMARY_LINE_REGEX = /^  \(/;
const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

type Phase = "scanning" | "preamble" | "diff" | "trailing";

interface ParsedDiffLine {
  kind: "context" | "add" | "remove";
  /** Line number for display; null in headerless bodies. Context uses the new side. */
  no: number | null;
  content: string;
}

function isFileHeaderLine(line: string): boolean {
  return line.startsWith("--- ") || line.startsWith("+++ ") || line === "---" || line === "+++";
}

export function buildDiffRows(
  output: string,
  options: BuildDiffRowsOptions = {},
): DiffRowsResult | null {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const showAll = options.showAll ?? false;

  const leadingNotes: string[] = [];
  const trailingNotes: string[] = [];
  const parsed: ParsedDiffLine[] = [];

  let phase: Phase = "scanning";
  // Counters are null until the first @@ header — headerless bodies
  // (single-line edit preview) get no gutter at all, not a bogus "0".
  let oldNo: number | null = null;
  let newNo: number | null = null;

  const applyHunk = (line: string): void => {
    const match = HUNK_HEADER_REGEX.exec(line);
    if (match) {
      oldNo = Number(match[1]);
      newNo = Number(match[3]);
    }
  };

  const pushBodyLine = (line: string): void => {
    const sign = line[0];
    // generateDiff emits `- ${content}` (sign + space); accept the bare
    // git-style `-content` form too. One leading space is the separator,
    // not content — further leading spaces belong to the code line.
    const content = line.length > 1 && line[1] === " " ? line.slice(2) : line.slice(1);
    if (sign === "-") {
      parsed.push({ kind: "remove", no: oldNo, content });
      oldNo = oldNo === null ? null : oldNo + 1;
    } else if (sign === "+") {
      parsed.push({ kind: "add", no: newNo, content });
      newNo = newNo === null ? null : newNo + 1;
    } else {
      parsed.push({ kind: "context", no: newNo, content });
      oldNo = oldNo === null ? null : oldNo + 1;
      newNo = newNo === null ? null : newNo + 1;
    }
  };

  const processDiffLine = (raw: string): void => {
    if (HUNK_HEADER_REGEX.test(raw)) {
      applyHunk(raw);
    } else if (isFileHeaderLine(raw)) {
      // skip --- / +++ headers
    } else if (raw[0] === "+" || raw[0] === "-" || raw[0] === " ") {
      pushBodyLine(raw);
    } else if (raw.trim() !== "") {
      // LSP diagnostics anchor or any non-diff text ends the body.
      phase = "trailing";
      trailingNotes.push(raw);
    }
    // Blank lines end the body too (blank context is "  ", never "").
  };

  for (const raw of output.split(/\r?\n/)) {
    switch (phase) {
      case "scanning": {
        // +/- lines are NOT anchors here — the active-file-warning banner
        // prepends `- pid N …` lines before the preamble, and those must
        // stay notes, not removals.
        if (PREAMBLE_REGEX.test(raw)) {
          phase = "preamble";
        } else if (HUNK_HEADER_REGEX.test(raw) || isFileHeaderLine(raw)) {
          phase = "diff";
        } else if (raw.trim() !== "") {
          leadingNotes.push(raw);
        }
        break;
      }
      case "preamble": {
        if (SUMMARY_LINE_REGEX.test(raw) || raw.trim() === "") {
          break; // consume summary line + blank separators
        }
        if (HUNK_HEADER_REGEX.test(raw) || isFileHeaderLine(raw)) {
          phase = "diff";
          processDiffLine(raw);
        } else if (raw[0] === "+" || raw[0] === "-" || raw[0] === " ") {
          // Headerless single-line edit body (`- old\n+ new`, no @@).
          phase = "diff";
          processDiffLine(raw);
        } else {
          phase = "trailing";
          if (raw.trim() !== "") {
            trailingNotes.push(raw);
          }
        }
        break;
      }
      case "diff": {
        processDiffLine(raw);
        break;
      }
      case "trailing": {
        if (raw.trim() !== "") {
          trailingNotes.push(raw);
        }
        break;
      }
    }
  }

  const hasChanges = parsed.some((l) => l.kind !== "context");
  if (!hasChanges) {
    return null;
  }

  // Fold: shed context first so changed rows survive; head-truncate only
  // when changed rows alone exceed the cap.
  let visible = parsed;
  let hidden = 0;
  if (!showAll) {
    if (visible.length > maxRows) {
      visible = visible.filter((l) => l.kind !== "context");
    }
    if (visible.length > maxRows) {
      hidden = visible.length - maxRows;
      visible = visible.slice(0, maxRows);
    }
  }

  let visibleNotes = trailingNotes;
  if (!showAll && trailingNotes.length > TRAILING_NOTE_CAP) {
    hidden += trailingNotes.length - TRAILING_NOTE_CAP;
    visibleNotes = trailingNotes.slice(0, TRAILING_NOTE_CAP);
  }

  // Uniform gutter width across the whole diff (max displayed line number).
  const gutterWidth = visible.reduce(
    (width, l) => (l.no === null ? width : Math.max(width, String(l.no).length)),
    0,
  );

  const rows: DiffRow[] = [];
  for (const text of leadingNotes) {
    rows.push({ kind: "note", text });
  }
  for (const line of visible) {
    const sign = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
    const gutter = gutterWidth === 0
      ? ""
      : `${(line.no === null ? "" : String(line.no)).padStart(gutterWidth)} │ `;
    rows.push({
      kind: line.kind,
      text: `${gutter}${sign} ${line.content}`.trimEnd(),
    });
  }
  for (const text of visibleNotes) {
    rows.push({ kind: "note", text });
  }

  return { rows, hiddenRowCount: hidden };
}
