import type { KodaXContextOverflowFacts } from '../errors.js';

function tokens(value: string | undefined): number | undefined {
  const parsed = Number(value?.replace(/,/g, ''));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse counts without confusing a prompt lower bound with measured usage. */
export function parseContextOverflowFacts(message: string): KodaXContextOverflowFacts {
  const windowFirst = /maximum context length is\s*(\d[\d,]*)\s*tokens/i.exec(message);
  const prompt = /your prompt contains\s+(at least\s+)?(\d[\d,]*)\s+input tokens/i.exec(message);
  if (windowFirst && prompt) {
    return { contextWindow: tokens(windowFirst[1]), inputTokens: tokens(prompt[2]),
      inputTokensKind: prompt[1] ? 'lower_bound' : 'exact' };
  }
  // Character prechecks describe an input allowance, not the prompt's token count.
  if (/upper bound|at least/i.test(message)) {
    return { contextWindow: tokens(windowFirst?.[1]), inputTokensKind: 'unknown' };
  }
  const inputFirst = /Input length\s*\((\d[\d,]*)\).*?maximum context length\s*\((\d[\d,]*)\)/i.exec(message)
    ?? /prompt (?:is )?too long:\s*(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i.exec(message)
    ?? /exceeds?\s+(\d[\d,]*)\s*tokens?\s*上限\s*(\d[\d,]*)/i.exec(message);
  if (inputFirst) {
    return { inputTokens: tokens(inputFirst[1]), contextWindow: tokens(inputFirst[2]), inputTokensKind: 'exact' };
  }
  const openaiPrompt = /\((\d[\d,]*)\s+in (?:your|the) (?:prompt|messages)/i.exec(message);
  return { contextWindow: tokens(windowFirst?.[1]), inputTokens: tokens(openaiPrompt?.[1]),
    inputTokensKind: openaiPrompt ? 'exact' : 'unknown' };
}
