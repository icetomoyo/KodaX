/**
 * Command discovery for user/project markdown commands.
 */

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import type { CommandRegistry } from './registry.js';
import type { CommandExecutionMetadata, CommandHook, CommandHooks, CommandPriority } from './types.js';

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

function normalizeAllowedTools(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
    return normalized.length > 0 ? normalized.join(', ') : undefined;
  }

  return undefined;
}

function normalizeHook(value: unknown): CommandHook | undefined {
  if (typeof value === 'string') {
    const command = value.trim();
    return command ? { command } : undefined;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (!command) {
      return undefined;
    }

    const matcher = typeof record.matcher === 'string' && record.matcher.trim()
      ? record.matcher.trim()
      : undefined;

    return { command, matcher };
  }

  return undefined;
}

function normalizeHookList(value: unknown): CommandHook[] | undefined {
  if (value == null) {
    return undefined;
  }

  const items = Array.isArray(value) ? value : [value];
  const normalized = items
    .map((item) => normalizeHook(item))
    .filter((item): item is CommandHook => item !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeHooks(value: unknown): CommandHooks | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const hooks: CommandHooks = {};

  for (const eventName of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification'] as const) {
    const normalized = normalizeHookList(record[eventName]);
    if (normalized) {
      hooks[eventName] = normalized;
    }
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function sanitizeYaml(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();

      if (
        value.includes(':') &&
        !value.startsWith('"') &&
        !value.startsWith("'") &&
        !value.startsWith('[') &&
        !value.startsWith('|') &&
        !value.startsWith('>')
      ) {
        result.push(`${key}: |-`);
        result.push(`  ${value}`);
        continue;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

function parseFrontmatter(content: string): [ParsedFrontmatter, string] {
  const normalizedContent = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimStart();

  if (!normalizedContent.startsWith('---\n')) {
    return [{}, content];
  }

  let closeIndex = normalizedContent.indexOf('\n---\n', 4);
  if (closeIndex === -1) {
    const endMarkerIndex = normalizedContent.indexOf('\n---', 4);
    if (endMarkerIndex !== -1 && endMarkerIndex === normalizedContent.length - 4) {
      closeIndex = endMarkerIndex;
    }
  }

  if (closeIndex === -1) {
    return [{}, content];
  }

  const frontmatterText = normalizedContent.slice(4, closeIndex);
  const body = normalizedContent.slice(closeIndex + 5);

  let parsed: unknown;
  try {
    parsed = YAML.parse(frontmatterText) ?? {};
  } catch {
    parsed = YAML.parse(sanitizeYaml(frontmatterText)) ?? {};
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [{}, body];
  }

  return [parsed as ParsedFrontmatter, body];
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
    allowedTools: normalizeAllowedTools(frontmatter['allowed-tools']),
    context: frontmatter.context === 'fork' ? 'fork' : undefined,
    agent: typeof frontmatter.agent === 'string' ? frontmatter.agent : undefined,
    argumentHint: typeof frontmatter['argument-hint'] === 'string' ? frontmatter['argument-hint'] : undefined,
    model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
    hooks: normalizeHooks(frontmatter.hooks),
    frontmatter,
  };
}

export function parseCommandFile(
  filePath: string,
  location: 'user' | 'project'
): DiscoveredCommand | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const [frontmatter, body] = parseFrontmatter(content);

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
