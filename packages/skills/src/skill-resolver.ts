/**
 * Skill Resolver - Variable Replacement System
 *
 * Handles variable replacement in skill content:
 * - $ARGUMENTS - All arguments
 * - $0, $1, $2... - Positional arguments
 * - ${VAR_NAME} - Environment variables
 * - !`command` - Dynamic context injection
 */

import { execSync } from 'child_process';
import path from 'path';
import type { SkillContext, IVariableResolver } from './types.js';

const SAFE_DYNAMIC_CONTEXT_COMMANDS = new Set([
  'ls', 'cat', 'pwd', 'echo', 'whoami', 'date', 'which', 'whereis', 'tree',
  'dir', 'type', 'get-childitem', 'get-content', 'select-string', 'get-location',
  'grep', 'find', 'awk', 'sed', 'head', 'tail', 'less', 'more', 'wc',
  'git status', 'git diff', 'git log', 'git show', 'git branch',
  'git remote', 'git ls-files', 'git rev-parse', 'git grep',
  'node', 'npm', 'yarn', 'pnpm', 'tsc', 'python', 'pip', 'go', 'cargo', 'rustc',
]);

function isSingleSafeDynamicContextCommand(command: string): boolean {
  if (!command || !command.trim()) {
    return false;
  }

  const normalizedCommand = command.trim().replace(/\s+/g, ' ').toLowerCase();

  for (const safeCmd of SAFE_DYNAMIC_CONTEXT_COMMANDS) {
    if (normalizedCommand === safeCmd || normalizedCommand.startsWith(`${safeCmd} `)) {
      if (safeCmd === 'sed') {
        const parts = normalizedCommand.split(/\s+/);
        if (parts.some(part => part.startsWith('-i') || part === '--in-place')) {
          return false;
        }
      }

      if (safeCmd === 'awk') {
        const parts = normalizedCommand.split(/\s+/);
        if (parts.includes('-f') || parts.includes('--file')) {
          return false;
        }
      }

      const languageTools = ['node', 'npm', 'yarn', 'pnpm', 'tsc', 'python', 'pip', 'go', 'cargo', 'rustc'];
      if (languageTools.includes(safeCmd)) {
        const parts = normalizedCommand.split(/\s+/).slice(1);
        if (parts.length > 0 && !parts.every(part => /^(-v|--version|-h|--help)$/.test(part))) {
          return false;
        }
      }

      return true;
    }
  }

  return false;
}

function isSafeDynamicContextCommand(command: string): boolean {
  if (!command || !command.trim()) {
    return false;
  }

  let normalizedCommand = command.trim().replace(/\\\r?\n/g, ' ');

  const baseIllegalSyntax = /[<>|;`]|\$\(|(?<!&)&(?!&)/;
  if (baseIllegalSyntax.test(normalizedCommand)) {
    return false;
  }

  if (normalizedCommand.includes('\\')) {
    if (path.sep !== '\\') {
      const withoutEscapedSpaces = normalizedCommand.replace(/\\ /g, '');
      if (withoutEscapedSpaces.includes('\\')) {
        return false;
      }
    }
  }

  const subCommands = normalizedCommand.split(/\s*&&\s*/);
  if (subCommands.length === 1) {
    return isSingleSafeDynamicContextCommand(subCommands[0]!);
  }

  for (const subCommand of subCommands) {
    const trimmed = subCommand?.trim();
    if (!trimmed) {
      continue;
    }

    if (/^cd\s+/.test(trimmed.toLowerCase())) {
      continue;
    }

    if (!isSingleSafeDynamicContextCommand(trimmed)) {
      return false;
    }
  }

  return true;
}

/**
 * Split arguments string into positional arguments
 * Handles quoted strings correctly
 */
export function parseArguments(args: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < args.length; i++) {
    const char = args[i]!;

    if (inQuotes) {
      if (char === quoteChar) {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuotes = true;
      quoteChar = char;
    } else if (char === ' ') {
      if (current) {
        result.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    result.push(current);
  }

  return result;
}

/**
 * Variable resolver implementation
 */
export class VariableResolver implements IVariableResolver {
  private context: SkillContext;

  constructor(context: SkillContext) {
    this.context = context;
  }

  /**
   * Resolve all variables in content
   */
  async resolve(content: string, args: string): Promise<string> {
    let resolved = content;

    // Resolve positional arguments first
    const positionalArgs = parseArguments(args);

    // $0, $1, $2, etc.
    resolved = this.resolvePositionalArgs(resolved, positionalArgs);

    // $ARGUMENTS - all arguments
    resolved = this.resolveArguments(resolved, args);

    // ${VAR_NAME} - environment variables
    resolved = this.resolveEnvVars(resolved);

    // !`command` - dynamic context
    resolved = await this.resolveDynamicContext(resolved);

    return resolved;
  }

  /**
   * Replace $0, $1, $2... with positional arguments
   */
  private resolvePositionalArgs(content: string, args: string[]): string {
    // Match $0, $1, $2, etc. (not followed by alphanumeric)
    return content.replace(/\$(\d+)(?![a-zA-Z0-9_])/g, (match, indexStr) => {
      const index = parseInt(indexStr, 10);
      return args[index] ?? '';
    });
  }

  /**
   * Replace $ARGUMENTS with all arguments
   */
  private resolveArguments(content: string, args: string): string {
    return content.replace(/\$ARGUMENTS/g, args);
  }

  /**
   * Replace ${VAR_NAME} with environment variables
   */
  private resolveEnvVars(content: string): string {
    const env: Record<string, string | undefined> = {
      ...this.context.environment,
      CLAUDE_SESSION_ID: this.context.sessionId,
      KODAX_SESSION_ID: this.context.sessionId,
      KODAX_WORKING_DIR: this.context.workingDirectory,
    };

    return content.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, varName: string) => {
      return env[varName] ?? match;
    });
  }

  /**
   * Replace !`command` with command output (dynamic context)
   */
  private async resolveDynamicContext(content: string): Promise<string> {
    const dynamicPattern = /!`([^`]+)`/g;
    const matches: Array<{ match: string; command: string }> = [];

    let match;
    while ((match = dynamicPattern.exec(content)) !== null) {
      matches.push({ match: match[0], command: match[1]! });
    }

    if (matches.length === 0) {
      return content;
    }

    // Execute commands and replace
    let resolved = content;
    for (const { match, command } of matches) {
      try {
        const output = this.executeDynamicCommand(command);
        resolved = resolved.replace(match, output);
      } catch (error) {
        // On error, replace with error message
        const errorMsg = error instanceof Error ? error.message : String(error);
        resolved = resolved.replace(match, `[Error: ${errorMsg}]`);
      }
    }

    return resolved;
  }

  /**
   * Execute a dynamic context command
   */
  private executeDynamicCommand(command: string): string {
    if (!isSafeDynamicContextCommand(command)) {
      throw new Error(
        'Unsafe dynamic context command blocked. Only simple read-only commands are allowed in !`...` blocks.'
      );
    }

    try {
      const output = execSync(command, {
        cwd: this.context.workingDirectory,
        encoding: 'utf-8',
        timeout: 5000, // 5 second timeout
        maxBuffer: 1024 * 1024, // 1MB max output
        windowsHide: true,
      });
      return output.trim();
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Command failed: ${error.message}`);
      }
      throw error;
    }
  }
}

/**
 * Create a variable resolver for a given context
 */
export function createResolver(context: SkillContext): IVariableResolver {
  return new VariableResolver(context);
}

/**
 * Resolve skill content with arguments and context
 */
export async function resolveSkillContent(
  content: string,
  args: string,
  context: SkillContext
): Promise<string> {
  const resolver = new VariableResolver(context);
  return resolver.resolve(content, args);
}
