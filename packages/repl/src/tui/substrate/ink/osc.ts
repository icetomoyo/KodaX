/**
 * OSC 8 hyperlink helpers for the cell-level renderer (FEATURE_057 Track F).
 *
 * Write-only — KodaX does not parse OSC sequences back from the terminal.
 * Architecturally aligned with `claudecode/src/ink/termio/osc.ts:link / LINK_END`.
 */

const ESC = "\x1b";
const BEL = "\x07";
const OSC_PREFIX = ESC + "]";
const OSC_HYPERLINK = "8";

function osc(parts: (string | number)[]): string {
  return `${OSC_PREFIX}${parts.join(";")}${BEL}`;
}

/**
 * Stable id derived from the URL so terminals group wrapped lines of the
 * same link together — without an id each wrapped line is treated as a
 * separate hyperlink (inconsistent hover, partial tooltips).
 */
function osc8Id(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Start a hyperlink (OSC 8). Empty URL closes the hyperlink.
 *
 * Caller-supplied `params` shallow-merge over the auto-generated entries
 * (currently just `id` derived from the URL). Pass `{ id: "..." }` only when
 * the caller specifically needs to override terminal link grouping — the
 * default `id` exists so wrap-line continuations of the same link share the
 * same hover/tooltip on conformant terminals; an accidental `id` key in
 * `params` will silently break that grouping.
 */
export function link(url: string, params?: Record<string, string>): string {
  if (!url) return LINK_END;
  const merged = { id: osc8Id(url), ...(params ?? {}) };
  const paramStr = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join(":");
  return osc([OSC_HYPERLINK, paramStr, url]);
}

/** End a hyperlink (OSC 8 with empty params + empty URL). */
export const LINK_END = osc([OSC_HYPERLINK, "", ""]);
