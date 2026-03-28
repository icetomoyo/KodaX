import type { KodaXToolExecutionContext } from '../types.js';
import {
  analyzeChangedScope,
  renderChangedScope,
} from '../repo-intelligence/index.js';
import { readOptionalString } from './internal.js';

const VALID_SCOPES = new Set(['unstaged', 'staged', 'all', 'compare']);

function readScope(
  input: Record<string, unknown>,
): 'unstaged' | 'staged' | 'all' | 'compare' {
  const rawScope = input.scope;
  if (rawScope === undefined || rawScope === null || rawScope === '') {
    return 'all';
  }
  if (typeof rawScope !== 'string' || !VALID_SCOPES.has(rawScope)) {
    throw new Error(`scope must be one of: ${Array.from(VALID_SCOPES).join(', ')}.`);
  }
  return rawScope as 'unstaged' | 'staged' | 'all' | 'compare';
}

export async function toolChangedScope(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const report = await analyzeChangedScope(ctx, {
      targetPath: readOptionalString(input, 'target_path'),
      scope: readScope(input),
      baseRef: readOptionalString(input, 'base_ref'),
      refreshOverview: input.refresh_overview === true,
    });

    return renderChangedScope(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] changed_scope: ${message}`;
  }
}
