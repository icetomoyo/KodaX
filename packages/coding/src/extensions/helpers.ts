/**
 * Extension API Helpers — exec() and webhook()
 *
 * Convenience utilities for extensions to run shell commands and send HTTP
 * webhooks without reimplementing child_process/fetch boilerplate.
 *
 * Extracted from the former hooks/executor.ts with the same security model:
 * - Shell commands run with a whitelisted environment (no API key leakage)
 * - HTTP webhooks have timeout + abort support
 * - Both are fail-open (errors don't throw, they return error results)
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_COMMAND_TIMEOUT = 30000;
const DEFAULT_HTTP_TIMEOUT = 10000;

// ============== Shell Command Execution ==============

export interface ExecOptions {
  /** Extra environment variables to inject (merged with safe base env). */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Timeout in milliseconds. Defaults to 30000. */
  readonly timeout?: number;
  /** Shell to use. Defaults to 'bash' on Unix, 'powershell' on Windows. */
  readonly shell?: 'bash' | 'powershell';
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a shell command with a sandboxed environment.
 *
 * SECURITY: Only a whitelist of safe environment variables is passed to the
 * subprocess. API keys and tokens from the parent environment are NOT inherited.
 */
export async function exec(
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeout = options.timeout ?? DEFAULT_COMMAND_TIMEOUT;
  const shell = options.shell ?? (process.platform === 'win32' ? 'powershell' : 'bash');
  const shellArgs = shell === 'powershell' ? ['-Command', command] : ['-c', command];

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
    ...options.env,
  };

  try {
    const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
      timeout,
      cwd: options.cwd,
      env: safeEnv,
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const exitCode = err && typeof err === 'object' && 'code' in err
      ? typeof (err as Record<string, unknown>).code === 'number'
        ? (err as { code: number }).code
        : 1
      : 1;
    const stdout = err && typeof err === 'object' && 'stdout' in err
      ? String((err as Record<string, unknown>).stdout ?? '').trim()
      : '';
    const stderr = err && typeof err === 'object' && 'stderr' in err
      ? String((err as Record<string, unknown>).stderr ?? '').trim()
      : (err instanceof Error ? err.message : String(err));
    return { exitCode, stdout, stderr };
  }
}

// ============== HTTP Webhook ==============

export interface WebhookOptions {
  /** HTTP method. Defaults to 'POST'. */
  readonly method?: 'POST' | 'PUT';
  /** Extra HTTP headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Timeout in milliseconds. Defaults to 10000. */
  readonly timeout?: number;
}

export interface WebhookResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: string;
}

/**
 * Send an HTTP webhook with timeout support.
 * Returns a result object instead of throwing on errors.
 */
export async function webhook(
  url: string,
  payload: unknown,
  options: WebhookOptions = {},
): Promise<WebhookResult> {
  const timeout = options.timeout ?? DEFAULT_HTTP_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: options.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await response.text().catch(() => undefined);
    return { ok: response.ok, status: response.status, body };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
    };
  }
}
