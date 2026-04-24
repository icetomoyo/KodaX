/**
 * Command discovery for user/project markdown commands.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  normalizeAllowedToolsString,
  normalizeYamlHookMap,
  parseYamlFrontmatter,
} from '@kodax/skills/shared/yaml';
import type { CommandRegistry } from './registry.js';
import type { CommandExecutionMetadata, CommandHooks, CommandPriority } from './types.js';

export interface DiscoveredCommand {
  name: string;
  description: string;
  aliases?: string[];
  priority?: CommandPriority;
  content: string;
  location: 'user' | 'project';
  path: string;
  frontmatter?: Record<string, unknown>;
  execution: CommandExecutionMetadata;
}

export interface CommandDiscoveryPath {
  path: string;
  location: 'user' | 'project';
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  aliases?: string[] | string;
  priority?: CommandPriority;
  [key: string]: unknown;
}


function normalizeAliases(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return undefined;
}

function normalizePriority(value: unknown): CommandPriority | undefined {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return undefined;
}

function buildExecutionMetadata(frontmatter: ParsedFrontmatter): CommandExecutionMetadata {
  return {
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
    userInvocable: frontmatter['user-invocable'] !== false,
    allowedTools: normalizeAllowedToolsString(frontmatter['allowed-tools']),
    context: frontmatter.context === 'fork' ? 'fork' : undefined,
    agent: typeof frontmatter.agent === 'string' ? frontmatter.agent : undefined,
    argumentHint: typeof frontmatter['argument-hint'] === 'string' ? frontmatter['argument-hint'] : undefined,
    model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
    hooks: normalizeYamlHookMap(frontmatter.hooks) as CommandHooks | undefined,
    frontmatter,
  };
}

export function parseCommandFile(
  filePath: string,
  location: 'user' | 'project'
): DiscoveredCommand | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const [parsed, body] = parseYamlFrontmatter(content);
    const frontmatter = (parsed ?? {}) as ParsedFrontmatter;

    const fileName = path.basename(filePath, '.md');
    const name = typeof frontmatter.name === 'string' && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : fileName;

    if (!name || body.trim().length === 0) {
      return undefined;
    }

    const description = typeof frontmatter.description === 'string' && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : `Custom command from ${location} level`;

    return {
      name,
      description,
      aliases: normalizeAliases(frontmatter.aliases),
      priority: normalizePriority(frontmatter.priority),
      content: body.trim(),
      location,
      path: filePath,
      frontmatter,
      execution: buildExecutionMetadata(frontmatter),
    };
  } catch (error) {
    console.error(`Error parsing command file ${filePath}:`, error);
    return undefined;
  }
}

export function discoverCommands(
  baseDirs: Array<string | CommandDiscoveryPath>
): DiscoveredCommand[] {
  const commands: DiscoveredCommand[] = [];
  const scannedDirs = new Set<string>();

  for (let i = 0; i < baseDirs.length; i++) {
    const baseDirEntry = baseDirs[i];
    const baseDir = typeof baseDirEntry === 'string' ? baseDirEntry : baseDirEntry.path;
    const location: 'user' | 'project' =
      typeof baseDirEntry === 'string'
        ? (i === 0 ? 'user' : 'project')
        : baseDirEntry.location;

    if (!fs.existsSync(baseDir)) {
      continue;
    }

    let normalizedDir = path.resolve(baseDir);
    try {
      normalizedDir = fs.realpathSync.native?.(baseDir) ?? fs.realpathSync(baseDir);
    } catch {
      normalizedDir = path.resolve(baseDir);
    }

    if (scannedDirs.has(normalizedDir)) {
      continue;
    }
    scannedDirs.add(normalizedDir);

    try {
      const files = fs.readdirSync(baseDir);

      for (const file of files) {
        if (!file.endsWith('.md')) {
          continue;
        }

        const filePath = path.join(baseDir, file);
        const command = parseCommandFile(filePath, location);
        if (command) {
          commands.push(command);
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${baseDir}:`, error);
    }
  }

  return commands;
}

export function registerDiscoveredCommands(
  commands: DiscoveredCommand[],
  registry: CommandRegistry
): void {
  for (const cmd of commands) {
    try {
      registry.register({
        name: cmd.name,
        aliases: cmd.aliases,
        description: cmd.description,
        source: 'extension',
        priority: cmd.priority,
        location: cmd.location,
        path: cmd.path,
        userInvocable: cmd.execution.userInvocable,
        disableModelInvocation: cmd.execution.disableModelInvocation,
        allowedTools: cmd.execution.allowedTools,
        context: cmd.execution.context,
        agent: cmd.execution.agent,
        argumentHint: cmd.execution.argumentHint,
        model: cmd.execution.model,
        hooks: cmd.execution.hooks,
        frontmatter: cmd.frontmatter,
        handler: async () => ({
          success: true,
          invocation: {
            ...cmd.execution,
            prompt: cmd.content,
            source: 'prompt',
            displayName: cmd.name,
            path: cmd.path,
          },
        }),
      });
    } catch (error) {
      console.error(`Error registering command ${cmd.name}:`, error);
    }
  }
}
