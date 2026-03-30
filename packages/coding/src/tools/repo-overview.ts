import type { KodaXToolExecutionContext } from '../types.js';
import {
  getRepoOverview,
  renderRepoOverview,
} from '../repo-intelligence/index.js';
import { readOptionalString } from './internal.js';

export async function toolRepoOverview(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const overview = await getRepoOverview(ctx, {
      targetPath: readOptionalString(input, 'target_path'),
      refresh: input.refresh === true,
    });

    return renderRepoOverview(overview);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] repo_overview: ${message}`;
  }
}
