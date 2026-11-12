/**
 * FEATURE_306 — the request the background reflection job sends to the model:
 * system prompt, the single `memory_reflect` tool, and the evidence plus the
 * current notes rendered as the user message. The worker holds no other tool,
 * so injected text in the evidence has nothing to act with except a note write,
 * which the host validates against the evidence (see applyReflectionOperation).
 */
import {
  renderEvidence,
  type MemoryNote,
  type ReflectionOpInput,
  type SessionEvidence,
} from '@kodax-ai/agent';
import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { staticText } from '../prompts/static-text.js';

export const REFLECT_TOOL_NAME = 'memory_reflect';

const OPERATIONS = ['write', 'corroborate', 'dispute', 'rewrite'] as const;
const SCOPES = ['project', 'user'] as const;
const TYPES = ['user', 'feedback', 'project', 'reference', 'procedure'] as const;
const NOTE_BODY_CHARS = 1500;

export const REFLECT_TOOL: KodaXToolDefinition = {
  name: REFLECT_TOOL_NAME,
  description: staticText('t13.tools/memory-reflect.0'),
  input_schema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: [...OPERATIONS], description: 'The change to make.' },
      id: { type: 'string', description: 'Short slug naming the note.' },
      scope: { type: 'string', enum: [...SCOPES], description: 'project (default) or user.' },
      type: { type: 'string', enum: [...TYPES], description: 'What kind of note this is.' },
      description: { type: 'string', description: 'One-line index summary.' },
      body: { type: 'string', description: 'The note details.' },
      why: { type: 'string', description: 'The evidence that makes the note true, or the reason for a dispute.' },
      check: { type: 'string', description: 'How to confirm a changing fact is still true.' },
      quote: { type: 'string', description: 'Exact words from a user message or local tool result in the evidence.' },
    },
    required: ['operation', 'id'],
  },
};

export function reflectionSystemPrompt(): string {
  return staticText('t13.prompts/note-reflection.0');
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((candidate) => candidate === value);
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
    scope: oneOf(input.scope, SCOPES),
    type: oneOf(input.type, TYPES),
    description: text(input.description),
    why: text(input.why),
    check: text(input.check),
    body: text(input.body),
    quote: text(input.quote),
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
    tools: [REFLECT_TOOL],
  };
}
