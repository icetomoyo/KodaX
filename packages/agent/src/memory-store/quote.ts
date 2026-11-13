/**
 * FEATURE_308 — how a quote is compared with the text it claims to come from.
 * Shared by the `memory` tool (current user message) and the reflection job (session evidence).
 */

export function normalizeQuote(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

const WIDE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Non-space characters, where a CJK character counts double because it carries
 * about as much as a short word. Lets one threshold fit English and Chinese quotes.
 */
export function quoteWeight(text: string): number {
  let weight = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    weight += WIDE_CHAR.test(char) ? 2 : 1;
  }
  return weight;
}
