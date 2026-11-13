/**
 * FEATURE_306 — the request the background reflection job sends to the model:
 * system prompt, the `memory_reflect` and `skill_propose` tools, and the evidence
 * plus the current notes rendered as the user message. The worker holds no other
 * tool, so injected text in the evidence has nothing to act with except a note
 * write or a skill proposal, which the host validates against the evidence (see
 * applyReflectionOperation).
 */
import {
  NOTE_SCOPES,
  NOTE_TYPES,
  oneOf,
  renderEvidence,
  type MemoryNote,
  type ReflectionOpInput,
  type SessionEvidence,
} from '@kodax-ai/agent';
import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { staticText } from '../prompts/static-text.js';

export const REFLECT_TOOL_NAME = 'memory_reflect';
export const SKILL_TOOL_NAME = 'skill_propose';

const OPERATIONS = ['write', 'corroborate', 'dispute', 'rewrite'] as const;
const NOTE_BODY_CHARS = 1500;

export const REFLECT_TOOL: KodaXToolDefinition = {
  name: REFLECT_TOOL_NAME,
  description: staticText('t13.tools/memory-reflect.0'),
  input_schema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: [...OPERATIONS], description: 'The change to make.' },
      id: { type: 'string', description: 'Short slug naming the note.' },
      scope: { type: 'string', enum: [...NOTE_SCOPES], description: 'project (default) or user.' },
      // Kept short on purpose: spelling out the types here (f306-phase4d-r2) made models
      // file a confirmed multi-step procedure as a `procedure` note instead of a skill.
      type: { type: 'string', enum: [...NOTE_TYPES], description: 'What kind of note this is.' },
      description: { type: 'string', description: 'One-line index summary.' },
      body: { type: 'string', description: 'The note details.' },
      why: { type: 'string', description: 'The evidence that makes the note true, or the reason for a dispute.' },
      check: { type: 'string', description: 'How to confirm a changing fact is still true.' },
      quote: { type: 'string', description: 'Exact words from a user message or local tool result in the evidence.' },
    },
    required: ['operation', 'id'],
  },
};

const stringList = { type: 'array', items: { type: 'string' } } as const;

export const SKILL_TOOL: KodaXToolDefinition = {
  name: SKILL_TOOL_NAME,
  description: staticText('t13.tools/skill-propose.0'),
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short lowercase slug naming the skill.' },
      description: { type: 'string', description: 'One line: what the skill does and when to use it.' },
      purpose: { type: 'string', description: 'What the skill achieves.' },
      triggers: { ...stringList, description: 'Situations in which to use it.' },
      steps: { ...stringList, description: 'The ordered actions.' },
      verification: { ...stringList, description: 'How to confirm the result.' },
      pitfalls: { ...stringList, description: 'Mistakes this session met.' },
      quote: { type: 'string', description: 'Exact words from a user message or local tool result that show the procedure worked.' },
    },
    required: ['name', 'description', 'purpose', 'triggers', 'steps', 'verification', 'quote'],
  },
};

export function reflectionSystemPrompt(): string {
  return staticText('t13.prompts/note-reflection.0');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Returns undefined when the model sent something that is not a usable operation. */
export function parseReflectionCall(input: Record<string, unknown>): ReflectionOpInput | undefined {
  // Some models leave the operation out of a plain write; only a write carries a note body.
  const operation = input.operation === undefined ? 'write' : oneOf(input.operation, OPERATIONS);
  const id = text(input.id);
  if (operation === undefined || id === undefined || id.length === 0) return undefined;
  return {
    operation,
    id,
    scope: oneOf(input.scope, NOTE_SCOPES),
    type: oneOf(input.type, NOTE_TYPES),
    description: text(input.description),
    why: text(input.why),
    check: text(input.check),
    body: text(input.body),
    quote: text(input.quote),
  } satisfies ReflectionOpInput;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

/** Returns undefined when the model sent something that is not a usable skill proposal. */
export function parseSkillCall(input: Record<string, unknown>): ReflectionOpInput | undefined {
  const name = text(input.name);
  const description = text(input.description);
  const purpose = text(input.purpose);
  const triggers = strings(input.triggers);
  const steps = strings(input.steps);
  const verification = strings(input.verification);
  const pitfalls = input.pitfalls === undefined ? [] : strings(input.pitfalls);
  if (name === undefined || description === undefined || purpose === undefined
    || triggers === undefined || steps === undefined || verification === undefined || pitfalls === undefined) return undefined;
  return {
    operation: 'skill',
    id: name,
    quote: text(input.quote),
    skill: { name, description, purpose, triggers, steps, verification, pitfalls },
  } satisfies ReflectionOpInput;
}

function renderNote(note: MemoryNote): string {
  const header = [
    `## ${note.id} (${note.scope}, ${note.type}, ${note.status}, ${note.source ?? 'user'}${note.session === undefined ? '' : `, session ${note.session}`})`,
    `description: ${note.description}`,
    ...(note.why === undefined ? [] : [`why: ${note.why}`]),
    ...(note.check === undefined ? [] : [`check: ${note.check}`]),
  ];
  return `${header.join('\n')}\n${note.body.trim().slice(0, NOTE_BODY_CHARS)}`;
}

export function renderReflectionInput(evidence: SessionEvidence, notes: readonly MemoryNote[]): string {
  const current = notes.length === 0 ? '(no notes yet)' : notes.map(renderNote).join('\n\n');
  return `# Current notes\n${current}\n\n# Session evidence\n${renderEvidence(evidence)}`;
}

export function buildReflectionRequest(evidence: SessionEvidence, notes: readonly MemoryNote[]): {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly tools: readonly KodaXToolDefinition[];
} {
  return {
    systemPrompt: reflectionSystemPrompt(),
    userMessage: renderReflectionInput(evidence, notes),
    tools: [REFLECT_TOOL, SKILL_TOOL],
  };
}
