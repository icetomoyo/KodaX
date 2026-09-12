/** Manual shell syntax is a host tool invocation under the current Session owner. */
export interface ShellExecutorConfig {
  maxBuffer?: number;
  timeout?: number;
  maxOutputLength?: number;
  maxErrorLength?: number;
  cwd?: string;
  execute?: (command: string) => Promise<{ success: boolean; lastText: string; interrupted?: boolean }>;
  onOutput?: (text: string) => void;
}

export async function executeShellCommand(command: string, config: ShellExecutorConfig = {}): Promise<string> {
  const normalized = command.trim();
  if (!normalized) return '[Shell: No command provided]';
  let output: string;
  if (!config.execute) {
    output = '[Blocked] ' + JSON.stringify({ code: 'runtime_execution_unavailable', denialSource: 'runtime_capability',
      retryable: false, remediation: 'Connect the current Session execution owner to manual Shell.' });
  } else {
    try {
      const result = await config.execute(normalized);
      const status = result.interrupted ? 'cancelled' : result.success ? 'executed' : 'failed';
      const limit = result.success ? config.maxOutputLength ?? 8000 : config.maxErrorLength ?? 4000;
      const text = result.lastText.length > limit ? `${result.lastText.slice(0, limit)}\n...[output truncated]` : result.lastText;
      output = `[Shell command ${status}: ${normalized}]\n\n${text || '(no output)'}`;
    } catch (error: unknown) {
      output = `[Shell command failed: ${normalized}]\n\n${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (config.onOutput) config.onOutput(output);
  else process.stdout.write(`\n${output}\n`);
  return output;
}

export async function processSpecialSyntax(input: string, config: ShellExecutorConfig = {}): Promise<string> {
  return input.startsWith('!') ? executeShellCommand(input.slice(1), config) : input;
}

export function isShellCommand(input: string): boolean { return input.trim().startsWith('!'); }
export function isShellCommandSuccess(result: string): boolean {
  return result.startsWith('[Shell command executed:') || result.startsWith('[Shell:');
}
export function isShellCommandHandled(result: string): boolean {
  return /^\[Shell command (?:executed|failed|cancelled):/.test(result)
    || result.startsWith('[Shell:') || result.startsWith('[Blocked]');
}
