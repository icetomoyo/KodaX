import type { KodaXStreamResult } from '../packages/llm/src/index.js';

/** Response evidence for the cold-start probe; never executes returned tools. */
export function captureColdStartResponse(
  result: KodaXStreamResult | undefined,
  redact: (text: string) => string,
) {
  const response = result === undefined
    ? null
    : JSON.parse(redact(JSON.stringify(result))) as KodaXStreamResult;
  return { text: response?.textBlocks.map(block => block.text).join('\n') ?? '', response };
}
