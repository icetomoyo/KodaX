/**
 * FEATURE_306 — `/memory` over the note memory: see what the agent reads at
 * startup, review the notes it is still unsure about, approve or forget one.
 * Notes are plain markdown files, so editing one by hand works too.
 */

import chalk from 'chalk';

import { NOTE_SCOPES, readMemoryStats, type MemoryNote, type MemoryStatName, type NoteScope, type NoteStore } from '@kodax-ai/agent';
import { noteStoresFor, type NotePlace } from '@kodax-ai/coding';

type Stores = Readonly<Record<NoteScope, NoteStore>>;


const HELP: readonly (readonly [string, string])[] = [
  ['/memory', 'List the notes the agent reads at startup'],
  ['/memory candidates', 'Notes the agent inferred and has not confirmed yet'],
  ['/memory show <id>', 'Show one note'],
  ['/memory approve <id>', 'Confirm a candidate or disputed note so the agent reads it'],
  ['/memory forget <id>', 'Delete one note'],
];

const pending = (note: MemoryNote): boolean => note.status === 'candidate' || note.status === 'disputed';

function printHelp(): void {
  console.log(chalk.cyan('\n[memory] commands'));
  for (const [usage, text] of HELP) console.log(`  ${usage.padEnd(24)} ${chalk.dim(text)}`);
  console.log(chalk.dim('  Ask in conversation to remember or forget something; prefix an id with project: or user: when both scopes have it.\n'));
}

async function listNotes(stores: Stores): Promise<void> {
  for (const scope of NOTE_SCOPES) {
    const notes = await stores[scope].list();
    const active = notes.filter((note) => note.status === 'active');
    console.log(chalk.cyan(`\n[memory] ${scope} notes`) + chalk.dim(`  ${stores[scope].root}`));
    if (active.length === 0) console.log(chalk.dim('  (none yet)'));
    for (const note of active) console.log(`  ${chalk.bold(note.id)}  ${note.description}`);
    const waiting = notes.filter(pending).length;
    if (waiting > 0) console.log(chalk.yellow(`  ${waiting} unconfirmed — /memory candidates`));
  }
  const stats = await readMemoryStats(stores.user.root);
  if (stats !== undefined) {
    const count = (name: MemoryStatName): number => stats[name] ?? 0;
    console.log(chalk.dim(`\n  Since ${stats.since.slice(0, 10)}: ${count('reads')} note reads, ${count('reflections')} reflections, `
      + `${count('write')} notes saved, ${count('corroborate')} confirmed, ${count('dispute')} disputed, ${count('skill')} skills proposed`));
  }
  console.log('');
}

async function listCandidates(stores: Stores): Promise<void> {
  console.log(chalk.cyan('\n[memory] unconfirmed notes (the agent does not read these until you approve them)'));
  let count = 0;
  for (const scope of NOTE_SCOPES) {
    for (const note of (await stores[scope].list()).filter(pending)) {
      count += 1;
      console.log(`  ${chalk.bold(`${scope}:${note.id}`)} ${chalk.dim(`[${note.status}]`)}  ${note.description}`);
      if (note.why !== undefined) console.log(chalk.dim(`      why: ${note.why}`));
    }
  }
  if (count === 0) console.log(chalk.dim('  (none)'));
  console.log('');
}

type Found = { readonly scope: NoteScope; readonly note: MemoryNote } | { readonly error: string };

async function findNote(stores: Stores, ref: string | undefined): Promise<Found> {
  if (ref === undefined || ref.length === 0) return { error: 'name the note id, e.g. /memory show build-cmd' };
  const match = /^(project|user):(.+)$/.exec(ref);
  const scopes = match === null ? NOTE_SCOPES : [match[1] as NoteScope];
  const id = match === null ? ref : match[2]!;
  const hits: { scope: NoteScope; note: MemoryNote }[] = [];
  for (const scope of scopes) {
    const note = (await stores[scope].list()).find((item) => item.id === id);
    if (note !== undefined) hits.push({ scope, note });
  }
  if (hits.length === 0) return { error: `no note named ${ref}` };
  if (hits.length > 1) return { error: `both scopes have ${id}; use project:${id} or user:${id}` };
  return hits[0]!;
}

function showNote(scope: NoteScope, note: MemoryNote): void {
  console.log(chalk.cyan(`\n[memory] ${scope}:${note.id}`) + chalk.dim(`  ${note.type}, ${note.status}${note.source === undefined ? '' : `, from ${note.source}`}, read ${note.used} times`));
  console.log(`  ${note.description}`);
  if (note.why !== undefined) console.log(chalk.dim(`  why: ${note.why}`));
  if (note.check !== undefined) console.log(chalk.dim(`  check: ${note.check}`));
  if (note.body.trim().length > 0) console.log(`\n${note.body.trim()}`);
  console.log('');
}

async function changeNote(stores: Stores, action: 'approve' | 'forget', ref: string | undefined): Promise<void> {
  const found = await findNote(stores, ref);
  if ('error' in found) {
    console.log(chalk.yellow(`\n[memory] ${found.error}\n`));
    return;
  }
  const { scope, note } = found;
  if (action === 'approve' && !pending(note)) {
    console.log(chalk.dim(`\n[memory] ${scope}:${note.id} is already ${note.status}\n`));
    return;
  }
  const result = action === 'approve'
    ? await stores[scope].edit(note.id, { status: 'active', source: 'user' })
    : await stores[scope].remove(note.id);
  console.log(result.ok
    ? chalk.green(`\n[memory] ${action === 'approve' ? 'approved' : 'forgot'} ${scope}:${note.id}\n`)
    : chalk.red(`\n[memory] could not ${action} ${scope}:${note.id}: ${result.detail ?? result.reason}\n`));
}

export async function runNoteMemoryCommand(place: NotePlace, args: readonly string[]): Promise<void> {
  const stores = noteStoresFor(place);
  const sub = (args[0] ?? 'list').toLowerCase();
  if (sub === 'list') return listNotes(stores);
  if (sub === 'candidates' || sub === 'decisions') return listCandidates(stores);
  if (sub === 'approve' || sub === 'forget') return changeNote(stores, sub, args[1]);
  if (sub === 'show') {
    const found = await findNote(stores, args[1]);
    if ('error' in found) console.log(chalk.yellow(`\n[memory] ${found.error}\n`));
    else showNote(found.scope, found.note);
    return;
  }
  if (sub !== 'help' && sub !== '--help' && sub !== '-h') console.log(chalk.yellow(`\n[memory] unknown subcommand: ${sub}`));
  printHelp();
}
