/**
 * KodaX Hook Executor
 *
 * Executes command, http, and prompt hooks with timeout and error isolation.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { HookDefinition, CommandHook, HttpHook, PromptHook, HookResult, HookEventContext } from './types.js';
import { interpolateVariables } from './variable-interpolation.js';

const execFileAsync = promisify(execFile);

const DEFAULT_COMMAND_TIMEOUT = 30000;
const DEFAULT_HTTP_TIMEOUT = 10000;
const DEFAULT_PROMPT_TIMEOUT = 60000;

export async function executeHook(
  hook: HookDefinition,
  context: HookEventContext,
): Promise<HookResult> {
  try {
    switch (hook.type) {
      case 'command': return await executeCommandHook(hook, context);
      case 'http': return await executeHttpHook(hook, context);
      case 'prompt': return await executePromptHook(hook, context);
      default: return { action: 'pass', reason: 'Unknown hook type' };
    }
  } catch (err) {
    // Fail-open: hook errors don't block the main flow
    const message = err instanceof Error ? err.message : String(err);
    return { action: 'pass', reason: `Hook execution failed: ${message}` };
  }
}

async function executeCommandHook(hook: CommandHook, context: HookEventContext): Promise<HookResult> {
  // SECURITY: Pass context values as environment variables instead of interpolating
  // into the command string to prevent shell injection.
  const command = hook.command;
  const timeout = hook.timeout ?? DEFAULT_COMMAND_TIMEOUT;
  const shell = hook.shell ?? (process.platform === 'win32' ? 'powershell' : 'bash');
  const shellArgs = shell === 'powershell' ? ['-Command', command] : ['-c', command];

  // SECURITY: Only pass a whitelist of safe environment variables to the hook
  // subprocess.  Spreading the full process.env would leak API keys, tokens,
  // and other secrets that happen to be in the parent environment.
  const safeEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
    LANG: process.env.LANG ?? '',
    TERM: process.env.TERM ?? '',
    ...(process.platform === 'win32'
      ? {
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          COMSPEC: process.env.COMSPEC ?? '',
          PATHEXT: process.env.PATHEXT ?? '',
        }
      : {}),
    KODAX_TOOL_NAME: context.toolName ?? '',
    KODAX_TOOL_INPUT: context.toolInput ? JSON.stringify(context.toolInput) : '',
    KODAX_TOOL_OUTPUT: context.toolOutput ?? '',
    KODAX_SESSION_ID: context.sessionId ?? '',
    KODAX_EVENT_TYPE: context.eventType,
    KODAX_WORKING_DIR: context.workingDir ?? '',
    KODAX_FILE_PATH: extractFilePathFromInput(context.toolInput) ?? '',
  };

  try {
    const { stdout } = await execFileAsync(shell, shellArgs, {
      timeout,
      cwd: context.workingDir,
      env: safeEnv,
    });
    // Exit code 0 = allow
    return { action: 'allow', reason: stdout.trim() || undefined };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      const exitCode = (err as { code: number }).code;
      if (exitCode === 1) {
        // Exit code 1 = deny
        const stderr = 'stderr' in err && typeof (err as Record<string, unknown>).stderr === 'string'
          ? (err as { stderr: string }).stderr.trim()
          : 'Denied by hook';
        return { action: 'deny', reason: stderr };
      }
    }
    // Exit code 2+ or other error = pass (warning)
    return { action: 'pass', reason: `Command hook returned non-zero: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function executeHttpHook(hook: HttpHook, context: HookEventContext): Promise<HookResult> {
  const timeout = hook.timeout ?? DEFAULT_HTTP_TIMEOUT;
  const url = interpolateVariables(hook.url, context);
  const method = hook.method ?? 'POST';

  const body = hook.body
    ? interpolateVariables(hook.body, context)
    : JSON.stringify({
        event: context.eventType,
        toolName: context.toolName,
        sessionId: context.sessionId,
        timestamp: new Date().toISOString(),
      });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...hook.headers },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.ok) {
      return { action: 'allow' };
    }
    return { action: 'pass', reason: `HTTP hook returned ${response.status}` };
  } catch (err) {
    clearTimeout(timer);
    return { action: 'pass', reason: `HTTP hook failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function extractFilePathFromInput(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  return undefined;
}

async function executePromptHook(_hook: PromptHook, _context: HookEventContext): Promise<HookResult> {
  // Prompt hook requires LLM provider integration.
  // For now, return pass — full implementation deferred until provider is available in hook context.
  return { action: 'pass', reason: 'Prompt hook execution deferred (provider not available in hook context)' };
}
