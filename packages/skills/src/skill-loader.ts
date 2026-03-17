/**
 * Skill Loader - YAML Frontmatter Parsing and Skill Loading
 *
 * Parses SKILL.md files with YAML frontmatter and loads skill content.
 * Implements fallback sanitization for non-standard YAML formats.
 */

import { readFile, readdir } from 'fs/promises';
import { join, relative } from 'path';
import YAML from 'yaml';
import type {
  Skill,
  SkillHook,
  SkillHooks,
  SkillMetadata,
  SkillFile,
  SkillFrontmatter,
  SkillSource,
} from './types.js';

// === YAML Frontmatter Parsing ===

/**
 * Sanitize YAML content that may contain non-standard formats
 * E.g., unquoted strings with colons
 */
function sanitizeYaml(content: string): string {
  // Handle description fields that may contain colons
  // Convert inline colons to block scalar format
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();

      // Check if value contains unquoted colons
      if (
        value.includes(':') &&
        !value.startsWith('"') &&
        !value.startsWith("'") &&
        !value.startsWith('[') &&
        !value.startsWith('|') &&
        !value.startsWith('>')
      ) {
        // Convert to block scalar format
        result.push(`${key}: |-`);
        result.push(`  ${value}`);
        continue;
      }
    }
    result.push(line);
  }

  return result.join('\n');
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

function normalizeHook(value: unknown): SkillHook | undefined {
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

function normalizeHookList(value: unknown): SkillHook[] | undefined {
  if (value == null) {
    return undefined;
  }

  const items = Array.isArray(value) ? value : [value];
  const normalized = items
    .map((item) => normalizeHook(item))
    .filter((item): item is SkillHook => item !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeHooks(value: unknown): SkillHooks | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const hooks: SkillHooks = {};

  for (const eventName of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification'] as const) {
    const normalized = normalizeHookList(record[eventName]);
    if (normalized) {
      hooks[eventName] = normalized;
    }
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

/**
 * Parse SKILL.md file with YAML frontmatter
 */
export function parseSkillMarkdown(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  // Remove BOM and normalize line endings to LF - 移除 BOM 并统一换行符为 LF
  const normalizedContent = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')  // CRLF → LF (Windows)
    .replace(/\r/g, '\n')    // CR → LF (old Mac)
    .trimStart();

  // Check for frontmatter markers
  if (!normalizedContent.startsWith('---\n')) {
    throw new Error('Invalid SKILL.md: missing YAML frontmatter');
  }

  // Find closing marker (handle both \n---\n and \n---$ at end of file)
  let closeIndex = normalizedContent.indexOf('\n---\n', 4);
  if (closeIndex === -1) {
    // Try end of file marker
    const endMarkerIndex = normalizedContent.indexOf('\n---', 4);
    if (endMarkerIndex !== -1 && endMarkerIndex === normalizedContent.length - 4) {
      closeIndex = endMarkerIndex;
    }
  }
  if (closeIndex === -1) {
    throw new Error('Invalid SKILL.md: unclosed YAML frontmatter');
  }

  const yamlContent = normalizedContent.slice(4, closeIndex);
  const body = normalizedContent.slice(closeIndex + 5).trim();

  // Try parsing with original content first
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlContent) ?? {};
  } catch {
    // Try with sanitized content
    parsed = YAML.parse(sanitizeYaml(yamlContent)) ?? {};
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid SKILL.md: YAML frontmatter must be an object');
  }

  const parsedRecord = parsed as Record<string, unknown>;

  // Validate required fields
  if (!parsedRecord.name || typeof parsedRecord.name !== 'string') {
    throw new Error('Invalid SKILL.md: missing required "name" field');
  }
  if (!parsedRecord.description || typeof parsedRecord.description !== 'string') {
    throw new Error('Invalid SKILL.md: missing required "description" field');
  }

  // Build frontmatter
  const frontmatter: SkillFrontmatter = {
    name: parsedRecord.name,
    description: parsedRecord.description,
    disableModelInvocation: parsedRecord['disable-model-invocation'] === true,
    userInvocable: parsedRecord['user-invocable'] !== false, // Default true
    allowedTools: normalizeAllowedTools(parsedRecord['allowed-tools']),
    context: parsedRecord.context === 'fork' ? 'fork' : undefined,
    agent: typeof parsedRecord.agent === 'string' ? parsedRecord.agent : undefined,
    argumentHint: typeof parsedRecord['argument-hint'] === 'string' ? parsedRecord['argument-hint'] : undefined,
    model: typeof parsedRecord.model === 'string' ? parsedRecord.model : undefined,
    hooks: normalizeHooks(parsedRecord.hooks),
    license: typeof parsedRecord.license === 'string' ? parsedRecord.license : undefined,
    compatibility: typeof parsedRecord.compatibility === 'string' ? parsedRecord.compatibility : undefined,
    metadata: parsedRecord.metadata && typeof parsedRecord.metadata === 'object' && !Array.isArray(parsedRecord.metadata)
      ? parsedRecord.metadata as Record<string, unknown>
      : undefined,
  };

  return { frontmatter, body };
}

// === Skill Loading ===

/**
 * Load skill metadata from SKILL.md file
 */
export async function loadSkillMetadata(
  skillDir: string,
  source: SkillSource
): Promise<SkillMetadata | null> {
  const skillFilePath = join(skillDir, 'SKILL.md');

  try {
    const content = await readFile(skillFilePath, 'utf-8');
    const { frontmatter } = parseSkillMarkdown(content);

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      userInvocable: frontmatter.userInvocable ?? true,
      argumentHint: frontmatter.argumentHint,
      path: skillDir,
      source,
      disableModelInvocation: frontmatter.disableModelInvocation ?? false,
    };
  } catch (error) {
    console.error(`Failed to load skill metadata from ${skillDir}:`, error);
    return null;
  }
}

/**
 * Load full skill content
 */
export async function loadFullSkill(
  skillDir: string,
  source: SkillSource
): Promise<Skill | null> {
  const skillFilePath = join(skillDir, 'SKILL.md');

  try {
    const rawContent = await readFile(skillFilePath, 'utf-8');
    const { frontmatter, body } = parseSkillMarkdown(rawContent);

    // Load support files. Support both Agent Skills-style folders
    // (`references`, `assets`) and KodaX's older compatibility folders.
    const [scripts, references, assets, templates, resources] = await Promise.all([
      loadSkillFiles(join(skillDir, 'scripts')),
      loadSkillFiles(join(skillDir, 'references')),
      loadSkillFiles(join(skillDir, 'assets')),
      loadSkillFiles(join(skillDir, 'templates')),
      loadSkillFiles(join(skillDir, 'resources')),
    ]);

    const skill: Skill = {
      ...frontmatter,
      path: skillDir,
      skillFilePath,
      content: body,
      rawContent: body,
      loaded: true,
      source,
      ...(scripts.length > 0 && { scripts }),
      ...(references.length > 0 && { references }),
      ...(assets.length > 0 && { assets }),
      ...(templates.length > 0 && { templates }),
      ...(resources.length > 0 && { resources }),
    };

    return skill;
  } catch (error) {
    console.error(`Failed to load skill from ${skillDir}:`, error);
    return null;
  }
}

/**
 * Load files from a skill subdirectory
 */
async function loadSkillFiles(
  dirPath: string,
  rootDir: string = dirPath
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const filePath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        files.push(...await loadSkillFiles(filePath, rootDir));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      files.push({
        name: entry.name,
        path: filePath,
        relativePath: relative(rootDir, filePath).replace(/\\/g, '/'),
        // Content loaded on demand
      });
    }
  } catch {
    // Directory doesn't exist, return empty
  }

  return files;
}

/**
 * Load a specific support file's content
 */
export async function loadSkillFileContent(file: SkillFile): Promise<string> {
  if (file.content) return file.content;

  const content = await readFile(file.path, 'utf-8');
  file.content = content;
  return content;
}
