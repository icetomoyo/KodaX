import type { KodaXToolExecutionContext } from '../types.js';
import {
  getModuleContext,
  renderModuleContext,
} from '../repo-intelligence/runtime.js';
import { readOptionalString } from './internal.js';

export async function toolModuleContext(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const result = await getModuleContext(ctx, {
      module: readOptionalString(input, 'module'),
      targetPath: readOptionalString(input, 'target_path'),
      refresh: input.refresh === true,
    });
    return renderModuleContext(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] module_context: ${message}`;
  }
}
