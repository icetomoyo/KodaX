/**
 * Skill Loader - YAML Frontmatter Parsing and Skill Loading
 *
 * Parses SKILL.md files with YAML frontmatter and loads skill content.
 * Implements fallback sanitization for non-standard YAML formats.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import type {
  Skill,
  SkillMetadata,
  SkillFile,
  SkillFrontmatter,
  SkillSource,
} from './types.js';

// === YAML Frontmatter Parsing ===

/**
 * Simple YAML parser for frontmatter
 * Handles basic YAML structures used in skill definitions
 */
function parseSimpleYaml(yamlStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;
  let inMetadata = false;
  let metadataIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Handle nested metadata block
    if (inMetadata) {
      const indent = line.search(/\S/);
      if (indent > metadataIndent && currentKey === 'metadata') {
        // Still inside metadata block - for now, just store as string
        continue;
      }
      inMetadata = false;
    }

    // Key: Value pattern
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim();
      let value = trimmed.slice(colonIndex + 1).trim();

      // Handle array values [item1, item2]
      if (value.startsWith('[') && value.endsWith(']')) {
        const arrayContent = value.slice(1, -1);
        result[key] = arrayContent
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        continue;
      }

      // Handle boolean
      if (value === 'true') {
        result[key] = true;
        continue;
      }
      if (value === 'false') {
        result[key] = false;
        continue;
      }

      // Handle quoted strings
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        result[key] = value.slice(1, -1);
        continue;
      }

      // Handle empty value (might be nested block)
      if (!value) {
        currentKey = key;
        // Check if next line starts an array
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1]!;
          if (nextLine.trim().startsWith('- ')) {
            currentArray = [];
            result[key] = currentArray;
          }
        }
        // Handle metadata block
        if (key === 'metadata') {
          result[key] = {};
          inMetadata = true;
          metadataIndent = line.search(/\S/);
        }
        continue;
      }

      // Plain string value
      result[key] = value;
      currentKey = null;
      currentArray = null;
      continue;
    }

    // Array item
    if (trimmed.startsWith('- ') && currentArray !== null) {
      const item = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
      currentArray.push(item);
      continue;
    }
  }

  return result;
}

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
  let parsed: Record<string, unknown>;
  try {
    parsed = parseSimpleYaml(yamlContent);
  } catch {
    // Try with sanitized content
    const sanitized = sanitizeYaml(yamlContent);
    parsed = parseSimpleYaml(sanitized);
  }

  // Validate required fields
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error('Invalid SKILL.md: missing required "name" field');
  }
  if (!parsed.description || typeof parsed.description !== 'string') {
    throw new Error('Invalid SKILL.md: missing required "description" field');
  }

  // Build frontmatter
  const frontmatter: SkillFrontmatter = {
    name: parsed.name,
    description: parsed.description,
    disableModelInvocation: parsed['disable-model-invocation'] === true,
    userInvocable: parsed['user-invocable'] !== false, // Default true
    allowedTools: parsed['allowed-tools'] as string | undefined,
    context: parsed.context as 'fork' | undefined,
    agent: parsed.agent as string | undefined,
    argumentHint: parsed['argument-hint'] as string | undefined,
    model: parsed.model as 'haiku' | 'sonnet' | 'opus' | undefined,
    license: parsed.license as string | undefined,
    compatibility: parsed.compatibility as string | undefined,
    metadata: parsed.metadata as Record<string, unknown> | undefined,
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

    // Load support files
    const [scripts, templates, resources] = await Promise.all([
      loadSkillFiles(join(skillDir, 'scripts')),
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
async function loadSkillFiles(dirPath: string): Promise<SkillFile[]> {
  const files: SkillFile[] = [];

  try {
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) return files;

    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const filePath = join(dirPath, entry);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.isFile()) {
          files.push({
            name: entry,
            path: filePath,
            relativePath: `${basename(dirPath)}/${entry}`,
            // Content loaded on demand
          });
        }
      } catch {
        // Skip files we can't access
      }
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
