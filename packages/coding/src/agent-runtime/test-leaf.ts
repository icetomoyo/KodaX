/**
 * Test fixture for the internal leaf executor. Every production leaf caller
 * supplies its own system prompt, so tests that exercise leaf machinery supply
 * a stand-in prompt and run the same path.
 */

import { runLeafAgent } from '../agent.js';
import type { KodaXOptions } from '../types.js';
import { runSubstrate } from './run-substrate.js';

export const TEST_LEAF_PROMPT = 'You are a KodaX test leaf.';

function withTestLeafPrompt(options: KodaXOptions): KodaXOptions {
  if (options.context?.systemPromptOverride !== undefined || options.context?.agentProfile?.instructions) {
    return options;
  }
  return { ...options, context: { ...options.context, systemPromptOverride: TEST_LEAF_PROMPT } };
}

export const runTestLeaf: typeof runLeafAgent = (options, prompt) =>
  runLeafAgent(withTestLeafPrompt(options), prompt);

export const runTestSubstrate: typeof runSubstrate = (options, prompt, agent) =>
  runSubstrate(withTestLeafPrompt(options), prompt, agent);
