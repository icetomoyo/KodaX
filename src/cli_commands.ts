import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'node:url';
import { emitKodaXDiagnostic, getAgentConfigPath } from '@kodax-ai/agent';
import type { KodaXResult } from '@kodax-ai/coding';

/** Commands directory frozen at module load. Use getDefaultCommandDir() to honor a later setAgentConfigHome(). */
export const KODAX_COMMANDS_DIR = getAgentConfigPath('commands');

export interface KodaXCommand {
  name: string;
  description: string;
  content: string;
  type: 'prompt' | 'programmable';
  execute?: (context: KodaXCommandContext) => Promise<string>;
}

export interface KodaXCommandContext {
  args?: string;
  runAgent: (prompt: string) => Promise<KodaXResult>;
}

export function getDefaultCommandDir(): string {
  return getAgentConfigPath('commands');
}

export function resolveProgrammableCommandModuleUrl(
  modulePath: string,
): URL {
  const extension = path.extname(modulePath);
  if (extension !== '.js' && extension !== '.ts') {
    throw new Error(`Unsupported programmable command module extension: ${extension || '<none>'}.`);
  }
  return pathToFileURL(path.resolve(modulePath));
}

export async function loadCommands(
  commandDir?: string,
): Promise<Map<string, KodaXCommand>> {
  const commands = new Map<string, KodaXCommand>();
  const dir = commandDir ?? getDefaultCommandDir();

  try {
    await fs.mkdir(dir, { recursive: true });
    const files = await fs.readdir(dir);

    for (const fileName of files) {
      const extension = path.extname(fileName);
      const commandName = fileName.replace(extension, '');

      if (extension === '.md') {
        try {
          const content = await fs.readFile(path.join(dir, fileName), 'utf-8');
          const firstLine = content.split('\n')[0]?.replace(/^#\s*/, '').trim() ?? '';
          const description = firstLine.slice(0, 60) || '(prompt command)';
          commands.set(commandName, {
            name: commandName,
            description,
            content,
            type: 'prompt',
          });
        } catch {
          // Ignore malformed prompt command files so one bad file does not break discovery.
        }
        continue;
      }

      if (extension === '.js' || extension === '.ts') {
        const modulePath = path.join(dir, fileName);
        try {
          const moduleUrl = resolveProgrammableCommandModuleUrl(modulePath);
          const mod = await import(moduleUrl.href);
          for (const [key, value] of Object.entries(mod)) {
            if (key.startsWith('command_') && typeof value === 'function') {
              const functionName = key.replace('command_', '');
              const description = (value as { description?: unknown }).description ?? functionName;
              commands.set(functionName, {
                name: functionName,
                description: String(description).slice(0, 60),
                content: `[Programmable command: ${functionName}]`,
                type: 'programmable',
                execute: value as (context: KodaXCommandContext) => Promise<string>,
              });
            }
          }
        } catch (error: unknown) {
          emitKodaXDiagnostic({
            source: 'cli:commands',
            level: 'warn',
            message: extension === '.ts'
              ? `Failed to load TypeScript programmable command ${modulePath}; enable a TypeScript loader or compile it to .js.`
              : `Failed to load programmable command module ${modulePath}.`,
            detail: error,
          });
        }
      }
    }
  } catch {
    // Treat unreadable command directories as empty to preserve CLI startup behavior.
  }

  return commands;
}

export async function processCommandCall(
  commandName: string,
  args: string | undefined,
  commands: Map<string, KodaXCommand>,
  runAgent: (prompt: string) => Promise<KodaXResult>,
): Promise<string | null> {
  const command = commands.get(commandName);
  if (!command) {
    return null;
  }

  if (command.type === 'prompt') {
    return args ? command.content.replace(/{args}/g, args) : command.content;
  }

  if (command.type === 'programmable' && command.execute) {
    return command.execute({
      args,
      runAgent,
    });
  }

  return null;
}

export function parseCommandCall(input: string): [string, string?] | null {
  if (!input.startsWith('/')) {
    return null;
  }

  const body = input.slice(1).trim();
  if (!body) {
    return null;
  }

  const firstSpace = body.search(/\s/);
  if (firstSpace === -1) {
    return [body];
  }

  const commandName = body.slice(0, firstSpace);
  const args = body.slice(firstSpace).trim();
  return args ? [commandName, args] : [commandName];
}
