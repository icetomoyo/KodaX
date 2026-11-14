/**
 * FEATURE_308 guard experiment: the candidate reflection request.
 *
 * Production bytes plus exactly two additions, so any difference from the
 * production arm comes from them:
 *   - one prompt paragraph, inserted after the paragraph about failures, that
 *     defines a guard and asks the job to mark one;
 *   - an optional boolean `guard` on the `memory_reflect` tool.
 *
 * The rule under test (arm G) lives in the runner: a write marked guard whose
 * quote is found in local tool output becomes active at once; everything else
 * keeps the production ladder. If the experiment recommends adoption, these
 * bytes move into static-text.json and note-reflection.ts unchanged.
 */
import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { buildReflectionRequest, REFLECT_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';

/** The production paragraph the candidate paragraph follows. */
const ANCHOR = 'a wrong note of that kind sends every later session around a problem that does not exist.';

export const GUARD_PARAGRAPH = [
  'Sometimes the session\'s own action did damage, and the session found out how.',
  'The lesson is then a guard: the same action, done with the step or option that prevents that damage, such as a flag that skips links or a narrower set of files.',
  'Set guard on such a note.',
  'Its quote is the tool output that shows the damage, because that output is what lets the guard be trusted without a second session.',
  'A guard is used from the next session on without waiting for a second one, because it costs little when it turns out to be unneeded.',
  'A note that replaces what is done, such as another tool, another language or a removed setting, is not a guard, because following it changes the outcome whenever the session misjudged the cause.',
  'A step that itself deletes, stops or overwrites something is not a guard either, because it can do the same kind of damage it is meant to prevent.',
].join(' ');

export const GUARD_FIELD_DESCRIPTION = 'True only for a guard: the same action with a step that prevents damage this session caused.';

type Request = ReturnType<typeof buildReflectionRequest>;

export function candidateRequest(production: Request): Request {
  const parts = production.systemPrompt.split(ANCHOR);
  if (parts.length !== 2) throw new Error('candidate anchor not found exactly once in the production reflection prompt');
  const systemPrompt = `${parts[0]}${ANCHOR}\n\n${GUARD_PARAGRAPH}${parts[1]}`;
  const tools: KodaXToolDefinition[] = production.tools.map((tool) => {
    if (tool.name !== REFLECT_TOOL_NAME) return tool;
    const schema = tool.input_schema as { properties: Record<string, unknown> };
    return {
      ...tool,
      input_schema: {
        ...tool.input_schema,
        properties: { ...schema.properties, guard: { type: 'boolean', description: GUARD_FIELD_DESCRIPTION } },
      },
    };
  });
  return { ...production, systemPrompt, tools };
}

/** True when a recorded `memory_reflect` call marked its note as a guard. */
export function marksGuard(input: unknown): boolean {
  return typeof input === 'object' && input !== null && (input as Record<string, unknown>).guard === true;
}
