/**
 * FEATURE_306 — build the `MEMORY.md` index the model reads. No ranking code:
 * the model sees every listed one-line description and opens what it needs with
 * ordinary file tools. Phase 0 showed the old title-token ranking surfaced the
 * right note 0/5 times at 40 notes.
 *
 * Candidate and archived notes are not listed. Output depends only on the notes
 * (sorted deterministically), so unchanged memory means identical bytes and a
 * stable prompt-cache prefix.
 */
import type { MemoryNote, NoteType } from './record.js';

export const INDEX_TOKEN_BUDGET = 2000;

const MAX_DESCRIPTION_CHARS = 200;
const TYPE_ORDER: readonly NoteType[] = ['user', 'feedback', 'project', 'reference', 'procedure'];
/** Room kept for the overflow footer line. */
const FOOTER_RESERVE_TOKENS = 40;

/** Rough budget estimate: ASCII ~4 chars/token, every other character ~1 token (CJK). */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function line(note: MemoryNote): string {
  const description = Array.from(note.description).slice(0, MAX_DESCRIPTION_CHARS).join('');
  const mark = note.status === 'disputed' ? '(disputed: verify before relying) ' : '';
  return `- [${note.id}](${note.id}.md) — ${mark}${description}`;
}

function displayOrder(left: MemoryNote, right: MemoryNote): number {
  return TYPE_ORDER.indexOf(left.type) - TYPE_ORDER.indexOf(right.type) || compare(left.id, right.id);
}

/** Most used first, then most recently used; id breaks ties so the choice is stable. */
function keepPriority(left: MemoryNote, right: MemoryNote): number {
  return right.used - left.used
    || compare(right.lastUsedAt ?? '', left.lastUsedAt ?? '')
    || compare(left.id, right.id);
}

export function buildIndex(notes: readonly MemoryNote[]): string {
  const listable = notes.filter((note) => note.status === 'active' || note.status === 'disputed');
  if (listable.length === 0) return '';

  const kept: MemoryNote[] = [];
  let tokens = 0;
  for (const note of [...listable].sort(keepPriority)) {
    const cost = estimateTokens(line(note)) + 1;
    if (tokens + cost > INDEX_TOKEN_BUDGET - FOOTER_RESERVE_TOKENS) break;
    kept.push(note);
    tokens += cost;
  }

  const lines = kept.sort(displayOrder).map(line);
  const omitted = listable.length - kept.length;
  if (omitted > 0) {
    lines.push(`- ${omitted} more note${omitted === 1 ? '' : 's'} not listed (least used); list this directory to see them`);
  }
  return `${lines.join('\n')}\n`;
}
