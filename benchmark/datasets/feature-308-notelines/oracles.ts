/**
 * Mechanical diagnostics for the note-line experiment. They describe what the
 * replayed store looks like; the A/B conclusion comes from the blind main-session
 * review of the pack (EVAL_GUIDELINES). Reflect cases keep their own oracle.
 */
import type { MemoryNote } from '@kodax-ai/agent';

import type { ModelOutput, Scored } from '../feature-308-baseline/oracles.js';
import type { ReflectReplay } from '../feature-308-reflect/inputs.js';
import { scoreReflectCell } from '../feature-308-reflect/oracles.js';
import type { NoteLineCase } from './cases.js';

const mentions = (note: MemoryNote, terms: readonly string[]): boolean => {
  const haystack = JSON.stringify({ description: note.description, body: note.body, why: note.why }).toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
};

/** A line that reports what is absent or broken; diagnostic only, the review decides. */
const ABSENCE = /\b(?:not installed|not available|is missing|command not found|does not exist|not on (?:the )?path|unavailable)\b|未安装|不存在|找不到/i;

function addedNotes(replay: ReflectReplay): readonly MemoryNote[] {
  const known = new Set(replay.before.map((note) => note.id));
  return replay.after.filter((note) => !known.has(note.id));
}

/** Index lines of the notes this response added, for the review pack. */
export function addedLines(replay: ReflectReplay): readonly string[] {
  return addedNotes(replay).map((note) => `[${note.status}] ${note.description}`);
}

export function scoreNoteLineCell(item: NoteLineCase, output: ModelOutput, replay: ReflectReplay): Scored {
  const added = addedNotes(replay);
  const diagnostics = {
    newNotes: added.length,
    absenceLines: added.filter((note) => ABSENCE.test(note.description)).length,
  };
  if (item.reflectCase !== undefined) {
    const scored = scoreReflectCell(item.reflectCase, output, replay);
    return { ...scored, diagnostics: { ...scored.diagnostics, ...diagnostics } };
  }
  const expect = item.expect;
  const result = (verdict: Scored['verdict'], reason: string): Scored => ({ verdict, reasons: [reason], diagnostics });
  switch (expect.kind) {
    case 'lesson':
      return added.some((note) => mentions(note, expect.terms)) ? result('pass', 'a note carries the lesson') : result('fail', 'no note carries the lesson');
    case 'user-rule':
      return added.some((note) => note.status === 'active' && mentions(note, expect.terms))
        ? result('pass', 'an active note carries the rule')
        : result('fail', 'no active note carries the rule');
    case 'nothing':
      return added.length === 0 ? result('pass', 'no note') : result('needs_review', `${added.length} note(s) written from a one-off failure`);
    case 'misread':
      if (added.some((note) => expect.wrong.some((term) => note.description.toLowerCase().includes(term)))) return result('fail', 'an index line keeps the wrong conclusion');
      return added.length === 0 ? result('pass', 'no note') : result('needs_review', 'a note was written');
    case 'reflect':
      return result('needs_review', 'reflect expectation without a reflect case');
  }
}
