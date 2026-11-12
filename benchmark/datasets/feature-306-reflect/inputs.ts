/**
 * Cell input assembly and replay for FEATURE_306 Phase 2b (reflection job).
 *
 * The request is built by production code (`buildReflectionRequest`) from the
 * seeded notes and the bounded session evidence. Replay applies the recorded
 * `memory_reflect` calls, in order, through the real `applyReflectionOperation`
 * against a freshly seeded throwaway store.
 */
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyReflectionOperation,
  type DeclarativeSkillSpec,
  buildEvidence,
  createNoteStore,
  type MemoryNote,
  type MemoryOpResult,
  type NoteScope,
  type NoteStore,
  type ReflectionOpInput,
  type SessionEvidence,
} from '@kodax-ai/agent';

import {
  buildReflectionRequest,
  parseReflectionCall,
  parseSkillCall,
  SKILL_TOOL_NAME,
} from '../../../packages/coding/src/memory/note-reflection.js';
import type { ReflectCase } from './cases.js';

export const REFLECT_FIXTURE_ROOT = path.join(os.tmpdir(), 'kodax-eval-fixtures', 'feature-306-reflect');
export const CURRENT_SESSION = 's_current';

export interface SeededStores {
  readonly stores: Readonly<Record<NoteScope, NoteStore>>;
}

/** Notes are rendered into the prompt without paths, so the store location does not affect input bytes. */
export async function seedStores(name: string, item: Pick<ReflectCase, 'seeds'>): Promise<SeededStores> {
  const root = path.join(REFLECT_FIXTURE_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const stores = {
    project: createNoteStore(path.join(root, 'project'), 'project'),
    user: createNoteStore(path.join(root, 'user'), 'user'),
  };
  for (const seed of item.seeds) {
    const result = await stores.project.write({
      id: seed.id,
      type: seed.type,
      description: seed.description,
      body: seed.body,
      status: seed.status,
      source: seed.source,
      ...(seed.session === undefined ? {} : { session: seed.session }),
    });
    if (!result.ok) throw new Error(`seed ${seed.id} was not stored: ${result.reason}`);
  }
  return { stores };
}

async function allNotes(stores: SeededStores['stores']): Promise<readonly MemoryNote[]> {
  return [...await stores.project.list(), ...await stores.user.list()];
}

export interface ReflectCellInput {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly tools: ReturnType<typeof buildReflectionRequest>['tools'];
}

export async function buildReflectCellInput(item: ReflectCase): Promise<ReflectCellInput> {
  const { stores } = await seedStores(`input-${item.id}`, item);
  const request = buildReflectionRequest(buildEvidence(item.messages), await allNotes(stores));
  return { systemPrompt: request.systemPrompt, userMessage: request.userMessage, tools: request.tools };
}

export interface ReplayedCall {
  readonly input: ReflectionOpInput | undefined;
  readonly result: MemoryOpResult;
}

export interface ReflectReplay {
  readonly calls: readonly ReplayedCall[];
  readonly before: readonly MemoryNote[];
  readonly after: readonly MemoryNote[];
  /** Skills the host guards accepted and handed to the learned-skill sink. */
  readonly skills: readonly DeclarativeSkillSpec[];
}

export function evidenceOf(item: Pick<ReflectCase, 'messages'>): SessionEvidence {
  return buildEvidence(item.messages);
}

export async function replayReflectCalls(
  item: ReflectCase,
  tag: string,
  recorded: readonly { readonly name: string; readonly input: unknown }[],
): Promise<ReflectReplay> {
  const { stores } = await seedStores(`replay-${item.id}-${tag}`, item);
  const before = await allNotes(stores);
  const evidence = evidenceOf(item);
  const calls: ReplayedCall[] = [];
  const skills: DeclarativeSkillSpec[] = [];
  const sink = async (spec: DeclarativeSkillSpec): Promise<MemoryOpResult> => {
    skills.push(spec);
    return { ok: true, message: `skill ${spec.name} accepted` };
  };
  for (const { name, input: raw } of recorded) {
    const parse = name === SKILL_TOOL_NAME ? parseSkillCall : parseReflectionCall;
    const input = typeof raw === 'object' && raw !== null ? parse(raw as Record<string, unknown>) : undefined;
    const result = input === undefined
      ? { ok: false, message: 'malformed memory_reflect call' }
      : await applyReflectionOperation({ stores, evidence, sessionId: CURRENT_SESSION, skills: sink }, input);
    calls.push({ input, result });
  }
  return { calls, before, after: await allNotes(stores), skills };
}
