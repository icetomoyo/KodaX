/**
 * FEATURE_308 — the single `memory` tool (write / edit / delete) over the note store.
 * The host binds `ctx.memoryNotes` with the CURRENT user message, so the model
 * can only authorize a change by quoting that message.
 */
import { NOTE_SCOPES, NOTE_TYPES, oneOf, type MemoryOpInput } from '@kodax-ai/agent';

import { staticText } from '../prompts/static-text.js';
import type { KodaXToolExecutionContext } from '../types.js';

export const MEMORY_TOOL_NAME = 'memory';

export const MEMORY_TOOL_DESCRIPTION = staticText('t13.tools/memory.0');

export const MEMORY_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    operation: { type: 'string' as const, enum: ['write', 'edit', 'delete'], description: 'Create, change or remove a note.' },
    id: { type: 'string' as const, description: 'Short slug naming the note, e.g. test-command.' },
    scope: { type: 'string' as const, enum: [...NOTE_SCOPES], description: 'project (default) or user.' },
    type: { type: 'string' as const, enum: [...NOTE_TYPES], description: staticText('t13.tools/note-type.0') },
    description: { type: 'string' as const, description: 'One-line index summary.' },
    body: { type: 'string' as const, description: 'The note details.' },
    why: { type: 'string' as const, description: 'The reason or incident behind the note.' },
    check: { type: 'string' as const, description: 'How to confirm the note is still true.' },
    userQuote: { type: 'string' as const, description: 'Exact quote from the current user message authorizing this change.' },
  },
  required: ['operation', 'id'],
};

const OPERATIONS = ['write', 'edit', 'delete'] as const;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function activateMemoryTool(activeTools: readonly string[], enabled: boolean): string[] {
  const without = activeTools.filter((name) => name !== MEMORY_TOOL_NAME);
  return enabled ? [...without, MEMORY_TOOL_NAME] : without;
}

export async function toolMemory(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const operation = oneOf(input.operation, OPERATIONS);
  const id = text(input.id);
  if (operation === undefined) return '[Memory rejected: operation must be write, edit or delete]';
  if (id === undefined || id.length === 0) return '[Memory rejected: id is required]';
  if (ctx.memoryNotes === undefined) return '[Memory is not available in this session]';
  const result = await ctx.memoryNotes({
    operation,
    id,
    scope: oneOf(input.scope, NOTE_SCOPES),
    type: oneOf(input.type, NOTE_TYPES),
    description: text(input.description),
    why: text(input.why),
    check: text(input.check),
    body: text(input.body),
    userQuote: text(input.userQuote),
  } satisfies MemoryOpInput);
  return result.ok ? result.message : `[Memory rejected: ${result.message}]`;
}
