/** Coarse legacy fallback when only UTF-16 character counts are available.
 * Host session views provide their multilingual text estimate instead.
 * Neither estimate is Provider usage or a billing quantity.
 */
export function estimateOutputTokens(charCount: number): number {
  return charCount <= 0 ? 0 : Math.round(charCount / 4);
}
