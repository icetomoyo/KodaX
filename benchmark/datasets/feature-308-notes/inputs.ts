/**
 * Cell input assembly for FEATURE_308 Phase 1b (arm N: the new note memory).
 *
 * Same production Worker assembly as Phase 0 (`assembleReadCell`); the only
 * difference is the memory pieces. With `KODAX_MEMORY_NOTES=1` the production
 * `buildCapabilityContextSections` emits the note rules plus the two MEMORY.md
 * indexes, and the tool list gains the `memory` tool. Notes are seeded through
 * the real note store into a fixed, throwaway agent home so input bytes (and
 * hashes) are reproducible.
 */
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyMemoryOperation,
  createNoteStore,
  resolveNoteRoot,
  setAgentConfigHome,
  type MemoryOpInput,
  type MemoryNote,
  type MemoryOpResult,
  type NoteScope,
  type NoteStore,
  type NoteType,
} from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';

import { buildCapabilityContextSections } from '../../../packages/coding/src/prompts/capability-sections.js';
import { MEMORY_TOOL_NAME } from '../../../packages/coding/src/tools/memory.js';
import type { MemorySeed } from '../feature-308-baseline/cases.js';
import {
  ROOT_TOOLS,
  assembleReadCell,
  type CapabilityBlocks,
  type ReadCellInput,
} from '../feature-308-baseline/inputs.js';

export const NOTES_FIXTURE_ROOT = path.join(os.tmpdir(), 'kodax-eval-fixtures', 'feature-308-notes');
const NOTE_ENV = 'KODAX_MEMORY_NOTES';
const SECTION_IDS = ['self-knowledge-routing', 'project-memory'];
/** runner-driven.ts splits these ids into the stable system block; the rest ride the run context. */
const STABLE_IDS = ['project-agents', 'self-knowledge-routing', 'memory-rules', 'tool-construction'];

const NOTE_TYPE: Readonly<Record<MemorySeed['claimKind'], NoteType>> = {
  preference: 'feedback',
  fact: 'project',
  policy: 'feedback',
  procedure: 'procedure',
};

export interface NotesCaseLike {
  readonly id: string;
  readonly seeds: readonly MemorySeed[];
  readonly history: readonly KodaXMessage[];
  readonly userMessage: string;
}

export interface SeededNotes {
  readonly home: string;
  readonly cwd: string;
  readonly stores: Readonly<Record<NoteScope, NoteStore>>;
}

/** Fresh fixed-path agent home per (name): the prompt shows the note directory, so the path must be stable. */
export async function seedNotes(name: string, seeds: readonly MemorySeed[]): Promise<SeededNotes> {
  const root = path.join(NOTES_FIXTURE_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  setAgentConfigHome(home);
  try {
    const stores = {
      project: createNoteStore(resolveNoteRoot(cwd, 'project'), 'project'),
      user: createNoteStore(resolveNoteRoot(cwd, 'user'), 'user'),
    };
    for (const seed of seeds) {
      const result = await stores.project.write({
        id: seed.claimKey,
        type: NOTE_TYPE[seed.claimKind],
        description: seed.statement,
        body: seed.statement,
        status: 'active',
      });
      if (!result.ok) throw new Error(`seed ${seed.claimKey} was not stored: ${result.reason}`);
    }
    return { home, cwd, stores };
  } finally {
    setAgentConfigHome(undefined);
  }
}

/** Runs `build` with the note switch on and the seeded home active, restoring both afterwards. */
async function withNotesEnvironment<T>(seeded: SeededNotes, build: () => Promise<T>): Promise<T> {
  const previous = process.env[NOTE_ENV];
  process.env[NOTE_ENV] = '1';
  setAgentConfigHome(seeded.home);
  try {
    return await build();
  } finally {
    if (previous === undefined) delete process.env[NOTE_ENV];
    else process.env[NOTE_ENV] = previous;
    setAgentConfigHome(undefined);
  }
}

async function noteBlocks(cwd: string): Promise<CapabilityBlocks> {
  const sections = (await buildCapabilityContextSections({
    provider: 'f306-eval',
    context: { executionCwd: cwd },
  }, false, cwd)).filter((section) => SECTION_IDS.includes(section.id));
  const join = (items: typeof sections): string | undefined =>
    items.length === 0 ? undefined : items.map((section) => section.content).join('\n\n');
  return {
    stable: join(sections.filter((section) => STABLE_IDS.includes(section.id))),
    dynamic: join(sections.filter((section) => !STABLE_IDS.includes(section.id))),
  };
}

/** Session-2 input over a store that already holds whatever notes the caller put there. */
export async function buildNotesCellInputFrom(item: NotesCaseLike, seeded: SeededNotes): Promise<ReadCellInput> {
  return withNotesEnvironment(seeded, async () =>
    assembleReadCell(item, [...ROOT_TOOLS, MEMORY_TOOL_NAME], await noteBlocks(seeded.cwd)));
}

export async function buildNotesCellInput(item: NotesCaseLike): Promise<ReadCellInput> {
  return buildNotesCellInputFrom(item, await seedNotes(`input-${item.id}`, item.seeds));
}

export interface ReplayedCall {
  readonly input: MemoryOpInput;
  readonly result: MemoryOpResult;
}

export interface Replay {
  readonly calls: readonly ReplayedCall[];
  /** Notes in both stores after every call was applied. */
  readonly notes: readonly MemoryNote[];
}

function asOpInput(value: unknown): MemoryOpInput | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.operation !== 'write' && raw.operation !== 'edit' && raw.operation !== 'delete') return undefined;
  if (typeof raw.id !== 'string') return undefined;
  const text = (key: string): string | undefined => (typeof raw[key] === 'string' ? raw[key] : undefined);
  return {
    operation: raw.operation,
    id: raw.id,
    ...(raw.scope === 'user' || raw.scope === 'project' ? { scope: raw.scope } : {}),
    ...(text('type') === undefined ? {} : { type: text('type') as NoteType }),
    ...(text('description') === undefined ? {} : { description: text('description')! }),
    ...(text('why') === undefined ? {} : { why: text('why')! }),
    ...(text('check') === undefined ? {} : { check: text('check')! }),
    ...(text('body') === undefined ? {} : { body: text('body')! }),
    ...(text('userQuote') === undefined ? {} : { userQuote: text('userQuote')! }),
  };
}

/** Replays recorded `memory` calls, in order, through the real operation against a freshly seeded store. */
export async function replayMemoryCalls(
  item: Pick<NotesCaseLike, 'id' | 'seeds' | 'userMessage'>,
  tag: string,
  inputs: readonly unknown[],
): Promise<Replay> {
  const seeded = await seedNotes(`replay-${item.id}-${tag}`, item.seeds);
  const replayed: ReplayedCall[] = [];
  for (const raw of inputs) {
    const input = asOpInput(raw);
    const result = input === undefined
      ? { ok: false, message: 'malformed memory call' }
      : await applyMemoryOperation({ stores: seeded.stores, userMessage: item.userMessage }, input);
    replayed.push({ input: input ?? { operation: 'write', id: '' }, result });
  }
  const notes = [...await seeded.stores.project.list(), ...await seeded.stores.user.list()];
  return { calls: replayed, notes };
}
