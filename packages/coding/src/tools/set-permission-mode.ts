/**
 * KodaX SetPermissionMode Tool
 *
 * Allows the LLM to explicitly switch the session permission mode.
 * Decouples mode switching from ask_user_question — the LLM decides
 * when to switch based on the user's response, not the REPL.
 */

import type { KodaXToolExecutionContext } from '../types.js';

export async function toolSetPermissionMode(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const mode = input.mode as string | undefined;

  if (!mode || typeof mode !== 'string') {
    return '[Tool Error] set_permission_mode: Missing required parameter: mode';
  }

  if (mode !== 'accept-edits') {
    return `[Tool Error] set_permission_mode: Unsupported mode "${mode}". Supported: "accept-edits"`;
  }

  if (!ctx.setPermissionMode) {
    return '[Tool Error] set_permission_mode: Permission mode switching not available (callback not provided)';
  }

  ctx.setPermissionMode(mode);

  return JSON.stringify({
    success: true,
    mode,
    note: 'Permission mode switched to accept-edits. You can now write files, run bash commands, and make edits. Proceed with the implementation.',
  });
}
