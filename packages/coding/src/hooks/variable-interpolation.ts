/**
 * KodaX Hook Variable Interpolation
 *
 * Replaces $VARIABLE placeholders in hook strings with context values.
 * Pure function, no side effects.
 */
import type { HookEventContext } from './types.js';

const VARIABLE_PATTERN = /\$([A-Z_]+)/g;

export function interpolateVariables(template: string, context: HookEventContext): string {
  const variables: Record<string, string> = {
    TOOL_NAME: context.toolName ?? '',
    TOOL_INPUT: context.toolInput ? JSON.stringify(context.toolInput) : '',
    TOOL_OUTPUT: context.toolOutput ?? '',
    SESSION_ID: context.sessionId ?? '',
    WORKING_DIR: context.workingDir ?? '',
    FILE_PATH: extractFilePath(context.toolInput) ?? '',
    EVENT_TYPE: context.eventType,
  };

  return template.replace(VARIABLE_PATTERN, (match, varName: string) => {
    return variables[varName] ?? match;
  });
}

function extractFilePath(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  return undefined;
}
