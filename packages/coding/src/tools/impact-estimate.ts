import type { KodaXToolExecutionContext } from '../types.js';
import {
  getImpactEstimate,
  renderImpactEstimate,
} from '../repo-intelligence/query.js';
import { readOptionalString } from './internal.js';

export async function toolImpactEstimate(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const symbol = readOptionalString(input, 'symbol');
    const module = readOptionalString(input, 'module');
    const filePath = readOptionalString(input, 'path');
    if (!symbol && !module && !filePath) {
      throw new Error('one of symbol, module, or path is required.');
    }

    const result = await getImpactEstimate(ctx, {
      symbol,
      module,
      path: filePath,
      targetPath: readOptionalString(input, 'target_path'),
      refresh: input.refresh === true,
    });
    return renderImpactEstimate(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] impact_estimate: ${message}`;
  }
}
