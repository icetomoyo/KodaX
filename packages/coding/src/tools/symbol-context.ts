import type { KodaXToolExecutionContext } from '../types.js';
import {
  getSymbolContext,
  renderSymbolContext,
} from '../repo-intelligence/runtime.js';
import { readOptionalString } from './internal.js';

export async function toolSymbolContext(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const symbol = readOptionalString(input, 'symbol');
    if (!symbol) {
      throw new Error('symbol is required.');
    }

    const result = await getSymbolContext(ctx, {
      symbol,
      module: readOptionalString(input, 'module'),
      targetPath: readOptionalString(input, 'target_path'),
      refresh: input.refresh === true,
    });
    return renderSymbolContext(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] symbol_context: ${message}`;
  }
}
