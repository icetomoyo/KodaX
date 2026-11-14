/**
 * Cell inputs for the note-line experiment. Arm B is the request production
 * builds today (`buildReflectionRequest`). Arm A is the same request with the
 * reflection prompt and the memory_reflect description swapped back to the
 * frozen pre-change bytes; nothing else differs.
 */
import { buildEvidence } from '@kodax-ai/agent';

import { buildReflectionRequest, REFLECT_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { seedStores, type ReflectCellInput } from '../feature-308-reflect/inputs.js';
import { BASELINE_REFLECT_TOOL_DESCRIPTION, BASELINE_REFLECTION_PROMPT } from './baseline-text.js';
import type { NoteLineCase } from './cases.js';

export type Arm = 'A' | 'B';
export const ARMS: readonly Arm[] = ['A', 'B'];

export async function buildNoteLineInput(item: NoteLineCase, arm: Arm): Promise<ReflectCellInput> {
  const { stores } = await seedStores(`nl-input-${item.id}`, item);
  const notes = [...await stores.project.list(), ...await stores.user.list()];
  const request = buildReflectionRequest(buildEvidence(item.messages), notes);
  if (arm === 'B') return { systemPrompt: request.systemPrompt, userMessage: request.userMessage, tools: request.tools };
  return {
    systemPrompt: BASELINE_REFLECTION_PROMPT,
    userMessage: request.userMessage,
    tools: request.tools.map((tool) => (tool.name === REFLECT_TOOL_NAME ? { ...tool, description: BASELINE_REFLECT_TOOL_DESCRIPTION } : tool)),
  };
}
