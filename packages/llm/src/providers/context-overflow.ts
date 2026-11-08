import type { KodaXContextOverflowFacts } from '../errors.js';

function tokens(value: string | undefined): number | undefined {
  const parsed = Number(value?.replace(/,/g, ''));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Explicit input-capacity dialects; deliberately excludes generic token limits/TPM. */
export function isContextOverflowMessage(message: string): boolean {
  return /prompt (?:is )?too long|context[_ ]length|context window|context limit|上下文长度/i.test(message)
    || /input token count.*exceeds the maximum|request exceeded model token limit|prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?|request exceeds the available context size|range of input length should be\s*\[1,\s*[\d,]+\]|input is too long for requested model/i.test(message);
}

/** Parse counts without confusing a prompt lower bound with measured usage. */
export function parseContextOverflowFacts(message: string): KodaXContextOverflowFacts {
  const explicit = /input token count\s*\(([\d,]+)\).*maximum number of tokens allowed\s*\(([\d,]+)\)/i.exec(message)
    ?? /prompt has\s*([\d,]+)\s*tokens?, but the configured context size is\s*([\d,]+)\s*tokens?/i.exec(message);
  if (explicit) return { inputTokens: tokens(explicit[1]), contextWindow: tokens(explicit[2]), inputTokensKind: 'exact' };
  const kimi = /request exceeded model token limit:\s*([\d,]+)\s*\(requested:\s*([\d,]+)\)/i.exec(message);
  // "requested" may include output; it is not a measured prompt count.
  if (kimi) return { contextWindow: tokens(kimi[1]), inputTokensKind: 'unknown' };
  const range = /range of input length should be\s*\[1,\s*([\d,]+)\]/i.exec(message);
  if (range) return { contextWindow: tokens(range[1]), inputTokensKind: 'unknown' };
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
