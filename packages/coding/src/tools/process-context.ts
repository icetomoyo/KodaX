import type { KodaXToolExecutionContext } from '../types.js';
import {
  getProcessContext,
  renderProcessContext,
} from '../repo-intelligence/query.js';
import { readOptionalString } from './internal.js';

export async function toolProcessContext(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const entry = readOptionalString(input, 'entry');
    const module = readOptionalString(input, 'module');
    const targetPath = readOptionalString(input, 'target_path');
    if (!entry && !module && !targetPath) {
      throw new Error('one of entry, module, or target_path is required.');
    }

    const result = await getProcessContext(ctx, {
      entry,
      module,
      targetPath,
      refresh: input.refresh === true,
    });
    return renderProcessContext(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] process_context: ${message}`;
  }
}
