/**
 * Inputs for the skill learning value eval (docs/designs/skill-learning-value-eval.md).
 *
 * Reflection: arm S is the production request; arm N is the same request with only
 * `memory_reflect` and without the prompt paragraph about skills.
 * Session 2: the production Worker assembly with note memory on, the real Skill catalog
 * and the `skill` tool in both arms. What session 1 stored is applied through the real host
 * guards into a fixed throwaway home; a skill is written as a `SKILL.md` rendered by
 * `renderDeclarativeSkill`, so the catalog line and the `skill` tool result are production bytes.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyReflectionOperation,
  buildEvidence,
  createNoteStore,
  renderDeclarativeSkill,
  resolveNoteRoot,
  setAgentConfigHome,
  type DeclarativeSkillSpec,
  type MemoryNote,
  type MemoryOpResult,
  type NoteScope,
  type NoteStore,
} from '@kodax-ai/agent';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';

import { expandSkillForLLM } from '../../../packages/agent/src/capabilities/skills/skill-expander.js';
import { formatSkillsSystemPrompt, initializeSkillRegistry, resetSkillRegistry } from '../../../packages/agent/src/capabilities/skills/skill-registry.js';
import {
  buildReflectionRequest,
  parseReflectionCall,
  parseSkillCall,
  REFLECT_TOOL,
  SKILL_TOOL_NAME,
} from '../../../packages/coding/src/memory/note-reflection.js';
import { buildCapabilityContextSections } from '../../../packages/coding/src/prompts/capability-sections.js';
import { toolRead } from '../../../packages/coding/src/tools/read.js';
import { MEMORY_TOOL_NAME } from '../../../packages/coding/src/tools/memory.js';
import { assistantCall, toolResult, user } from '../feature-308-baseline/cases.js';
import { ROOT_TOOLS, assembleReadCell, type CapabilityBlocks } from '../feature-308-baseline/inputs.js';
import type { ValueCase } from './cases.js';

export type Arm = 'N' | 'S';
export const ARMS: readonly Arm[] = ['N', 'S'];

export const VALUE_FIXTURE_ROOT = path.join(os.tmpdir(), 'kodax-eval-fixtures', 'skill-learning-value');
const SKILL_PARAGRAPH_START = 'A session can also end with a multi-step procedure';
const SECTION_IDS = ['self-knowledge-routing', 'memory-notes', 'skills-addendum'];
/** runner-driven.ts splits these ids into the stable system block; the rest ride the run context. */
const STABLE_IDS = ['project-agents', 'self-knowledge-routing', 'memory-rules', 'tool-construction'];
export const SESSION_TOOLS = [...ROOT_TOOLS, MEMORY_TOOL_NAME, 'skill'];
const LOAD_TEXT = 'Loading the saved procedure.';
const STEP_TEXT = 'Running the next step.';

export interface ModelInput {
  readonly systemPrompt: string;
  readonly priorMessages?: readonly KodaXMessage[];
  readonly userMessage?: string;
  readonly tools: readonly KodaXToolDefinition[];
}

export interface RecordedCall {
  readonly name: string;
  readonly input: unknown;
}

// ---------------------------------------------------------------- reflection

/** Arm N's prompt: the production one without the paragraph that introduces skill proposals. */
export function notesOnlyReflectionPrompt(production: string): string {
  const paragraphs = production.split('\n\n');
  const kept = paragraphs.filter((paragraph) => !paragraph.startsWith(SKILL_PARAGRAPH_START));
  if (kept.length !== paragraphs.length - 1) throw new Error('the skill paragraph of the reflection prompt was not found exactly once');
  return kept.join('\n\n');
}

export function reflectInput(item: ValueCase, arm: Arm): ModelInput {
  const request = buildReflectionRequest(buildEvidence(item.sessionOne), []);
  if (arm === 'S') return request;
  return { systemPrompt: notesOnlyReflectionPrompt(request.systemPrompt), userMessage: request.userMessage, tools: [REFLECT_TOOL] };
}

// ---------------------------------------------------------------- stored world

export interface StoredWorld {
  readonly home: string;
  readonly cwd: string;
  /** Notes session 1 wrote, after promotion to active. */
  readonly notes: readonly (MemoryNote & { readonly file: string })[];
  readonly skills: readonly DeclarativeSkillSpec[];
  readonly trace: readonly string[];
}

/** The fixture path shows in the prompt, so both arms use the same one and building is serial. */
let fixtureLock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = fixtureLock.then(work, work);
  fixtureLock = next.catch(() => undefined);
  return next;
}

async function applyStored(item: ValueCase, arm: Arm, calls: readonly RecordedCall[], stores: Readonly<Record<NoteScope, NoteStore>>): Promise<{ skills: DeclarativeSkillSpec[]; trace: string[] }> {
  const evidence = buildEvidence(item.sessionOne);
  const skills: DeclarativeSkillSpec[] = [];
  const trace: string[] = [];
  const sink = async (spec: DeclarativeSkillSpec): Promise<MemoryOpResult> => {
    try {
      renderDeclarativeSkill(spec); // the production stager's validation
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    skills.push(spec);
    return { ok: true, message: `skill ${spec.name} accepted` };
  };
  for (const call of calls) {
    const raw = typeof call.input === 'object' && call.input !== null ? call.input as Record<string, unknown> : undefined;
    // Arm N never offered skill_propose; a call to it anyway is refused like any unknown tool.
    const parse = call.name === SKILL_TOOL_NAME ? (arm === 'S' ? parseSkillCall : undefined) : parseReflectionCall;
    const op = raw === undefined || parse === undefined ? undefined : parse(raw);
    const outcome = op === undefined
      ? { ok: false, message: `unusable ${call.name} call` }
      : await applyReflectionOperation({ stores, evidence, sessionId: `session-one-${item.id}`, ...(arm === 'S' ? { skills: sink } : {}) }, op);
    trace.push(`${call.name} ${op?.operation ?? '?'} ${op?.id ?? '?'}: ${outcome.message}`);
  }
  return { skills, trace };
}

/** Steady state after a later session confirms: every note session 1 wrote is active in both arms. */
async function promoteNotes(stores: Readonly<Record<NoteScope, NoteStore>>): Promise<void> {
  for (const store of Object.values(stores)) {
    for (const note of await store.list()) {
      if (note.status === 'candidate') {
        const result = await store.edit(note.id, { status: 'active' });
        if (!result.ok) throw new Error(`could not promote ${note.id}: ${result.reason}`);
      }
    }
  }
}

async function storeWorld(item: ValueCase, arm: Arm, calls: readonly RecordedCall[]): Promise<StoredWorld> {
  const root = path.join(VALUE_FIXTURE_ROOT, `chain-${item.id}`);
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
    const { skills, trace } = await applyStored(item, arm, calls, stores);
    await promoteNotes(stores);
    for (const spec of skills) {
      const dir = path.join(home, 'skills', spec.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'SKILL.md'), renderDeclarativeSkill(spec), 'utf8');
    }
    const notes = (await Promise.all(Object.values(stores).map(async (store) =>
      (await store.list()).map((note) => ({ ...note, file: path.join(store.root, `${note.id}.md`) }))))).flat();
    return { home, cwd, notes, skills, trace };
  } finally {
    setAgentConfigHome(undefined);
  }
}

// ---------------------------------------------------------------- session 2

export interface SessionTwo {
  readonly world: StoredWorld;
  readonly skillsPrompt: string;
  /** Probe D: a fresh session with the task only. */
  readonly discovery: ModelInput;
  /** Probe P: one input per checkpoint, in case order. */
  readonly checkpoints: readonly ModelInput[];
}

async function withSessionEnvironment<T>(home: string, build: () => Promise<T>): Promise<T> {
  const previous = process.env.KODAX_MEMORY_NOTES;
  process.env.KODAX_MEMORY_NOTES = '1';
  setAgentConfigHome(home);
  resetSkillRegistry();
  try {
    return await build();
  } finally {
    if (previous === undefined) delete process.env.KODAX_MEMORY_NOTES;
    else process.env.KODAX_MEMORY_NOTES = previous;
    setAgentConfigHome(undefined);
    resetSkillRegistry();
  }
}

async function sessionBlocks(cwd: string, skillsPrompt: string): Promise<CapabilityBlocks> {
  const sections = (await buildCapabilityContextSections({
    provider: 'f306-eval',
    context: { executionCwd: cwd, skillsPrompt },
  }, false, cwd)).filter((section) => SECTION_IDS.includes(section.id));
  const join = (items: typeof sections): string | undefined =>
    items.length === 0 ? undefined : items.map((section) => section.content).join('\n\n');
  return {
    stable: join(sections.filter((section) => STABLE_IDS.includes(section.id))),
    dynamic: join(sections.filter((section) => !STABLE_IDS.includes(section.id))),
  };
}

/** The arm loading what session 1 stored: the skill when there is one, otherwise every stored note. */
async function loadMessages(world: StoredWorld, registry: Awaited<ReturnType<typeof initializeSkillRegistry>>): Promise<KodaXMessage[]> {
  const skill = world.skills[0];
  if (skill !== undefined) {
    // Production loads it from the learned area as source 'learned', which adds no source line.
    const full = { ...await registry.loadFull(skill.name), source: 'learned' as const };
    const expanded = await expandSkillForLLM(full, '', { workingDirectory: world.cwd, projectRoot: world.cwd });
    return [assistantCall(LOAD_TEXT, 'toolu_load_1', 'skill', { skill: skill.name }), toolResult('toolu_load_1', expanded.content)];
  }
  const messages: KodaXMessage[] = [];
  for (const [index, note] of world.notes.entries()) {
    const id = `toolu_load_${index + 1}`;
    const content = await toolRead({ path: note.file }, { backups: new Map(), executionCwd: world.cwd, gitRoot: world.cwd });
    if (typeof content !== 'string') throw new Error(`note ${note.id} did not read as text`);
    messages.push(assistantCall(LOAD_TEXT, id, 'read', { path: note.file }), toolResult(id, content));
  }
  return messages;
}

function stepMessages(item: ValueCase, upTo: number): KodaXMessage[] {
  return item.steps.slice(0, upTo).flatMap((step, index) => [
    assistantCall(STEP_TEXT, `toolu_step_${index + 1}`, step.tool, step.input),
    toolResult(`toolu_step_${index + 1}`, step.result),
  ]);
}

export function buildSessionTwo(item: ValueCase, arm: Arm, calls: readonly RecordedCall[]): Promise<SessionTwo> {
  return exclusive(async () => {
    const world = await storeWorld(item, arm, calls);
    return withSessionEnvironment(world.home, async () => {
      // Only the fixture home's skills: the real ~/.agents/skills must not leak into the catalog.
      const registry = await initializeSkillRegistry(world.cwd, { userPaths: [path.join(world.home, 'skills')], pluginPaths: [] });
      // Learned skills come after the formal ones in the composite registry (runtime-agent-binding.ts).
      const stored = new Set(world.skills.map((skill) => skill.name));
      const listed = registry.list();
      const skillsPrompt = formatSkillsSystemPrompt([
        ...listed.filter((skill) => !stored.has(skill.name)),
        ...listed.filter((skill) => stored.has(skill.name)).map((skill) => ({ ...skill, source: 'learned' as const })),
      ]);
      if (!skillsPrompt.includes('## Available Skills')) throw new Error('session 2 must carry a model-visible Skill catalog');
      const discovery = assembleReadCell({ history: [], userMessage: item.task }, SESSION_TOOLS, await sessionBlocks(world.cwd, skillsPrompt));
      const load = await loadMessages(world, registry);
      const checkpoints = item.checkpoints.map((checkpoint) => ({
        systemPrompt: discovery.systemPrompt,
        priorMessages: [...discovery.priorMessages, user(item.task), ...load, ...stepMessages(item, checkpoint.step)],
        tools: discovery.tools,
      }));
      return { world, skillsPrompt, discovery, checkpoints };
    });
  });
}
