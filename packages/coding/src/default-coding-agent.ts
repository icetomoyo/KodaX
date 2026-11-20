/**
 * Public coding preset: `Runner.run(createDefaultCodingAgent(), prompt,
 * { presetOptions })` runs a root Run on the managed Worker, the same engine
 * every other root entry uses (FEATURE_311).
 */

import type { Agent } from '@kodax-ai/agent';

import { createCodingAgent } from './coding-preset.js';
import { runKodaX } from './task-engine.js';

export function createDefaultCodingAgent(
  overrides: Partial<Omit<Agent, 'name' | 'instructions'>> = {},
): Agent {
  return createCodingAgent((options, prompt) => runKodaX(options, prompt), overrides);
}
