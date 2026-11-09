/**
 * Skill Loader - YAML Frontmatter Parsing and Skill Loading
 *
 * Parses SKILL.md files with YAML frontmatter and loads skill content.
 * Implements fallback sanitization for non-standard YAML formats.
 */

import { readFile, readdir } from 'fs/promises';
import { join, relative } from 'path';
import { emitKodaXDiagnostic } from '../../diagnostics.js';
import type {
  Skill,
  SkillHooks,
  SkillMetadata,
  SkillFile,
  SkillFrontmatter,
  ResolvedSkillSource,
} from './types.js';
import {
  normalizeAllowedToolsString,
  normalizeYamlHookMap,
  parseYamlFrontmatter,
} from './shared/yaml.js';

/**
 * Parse SKILL.md file with YAML frontmatter
 */
export function parseSkillMarkdown(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const [parsedRecord, body] = parseYamlFrontmatter(content, { throwOnMissing: true });
  if (!parsedRecord) {
    throw new Error('Invalid SKILL.md: YAML frontmatter must be an object');
  }

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
    userInvocable: parsedRecord['user-invocable'] !== false,
    allowedTools: normalizeAllowedToolsString(parsedRecord['allowed-tools']),
    context: parsedRecord.context === 'fork' ? 'fork' : undefined,
    agent: typeof parsedRecord.agent === 'string' ? parsedRecord.agent : undefined,
    argumentHint: typeof parsedRecord['argument-hint'] === 'string' ? parsedRecord['argument-hint'] : undefined,
    model: typeof parsedRecord.model === 'string' ? parsedRecord.model : undefined,
    hooks: normalizeYamlHookMap(parsedRecord.hooks) as SkillHooks | undefined,
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
  source: ResolvedSkillSource
): Promise<SkillMetadata | null> {
  const skillFilePath = join(skillDir, 'SKILL.md');

  try {
    const content = await readFile(skillFilePath, 'utf-8');
    const { frontmatter } = parseSkillMarkdown(content);

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      userInvocable: true,
      argumentHint: frontmatter.argumentHint,
      path: skillDir,
      source,
      disableModelInvocation: frontmatter.disableModelInvocation ?? false,
    };
  } catch (error) {
    emitKodaXDiagnostic({
      source: 'agent:skills',
      level: 'error',
      message: `Failed to load skill metadata from ${skillDir}.`,
      detail: error,
    });
    return null;
  }
}

/**
 * Load full skill content
 */
export async function loadFullSkill(
  skillDir: string,
  source: ResolvedSkillSource
): Promise<Skill | null> {
  const skillFilePath = join(skillDir, 'SKILL.md');

  try {
    const rawContent = await readFile(skillFilePath, 'utf-8');
    const { frontmatter, body } = parseSkillMarkdown(rawContent);

    // Load support files. Support both Agent Skills-style folders
    // (`references`, `assets`) and KodaX's older compatibility folders.
    const [scripts, references, assets, templates, resources, otherFiles] = await Promise.all([
      loadSkillFiles(join(skillDir, 'scripts')),
      loadSkillFiles(join(skillDir, 'references')),
      loadSkillFiles(join(skillDir, 'assets')),
      loadSkillFiles(join(skillDir, 'templates')),
      loadSkillFiles(join(skillDir, 'resources')),
      loadOtherSkillFiles(skillDir),
    ]);

    const skill: Skill = {
      ...frontmatter,
      // Keep parsing the legacy frontmatter field, but do not turn it into an
      // execution permission: every enabled Skill supports explicit invocation.
      userInvocable: true,
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
      ...(otherFiles.length > 0 && { otherFiles }),
    };

    return skill;
  } catch (error) {
    emitKodaXDiagnostic({
      source: 'agent:skills',
      level: 'error',
      message: `Failed to load skill from ${skillDir}.`,
      detail: error,
    });
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

const CONVENTIONAL_SUPPORT_FOLDERS = new Set(['scripts', 'references', 'assets', 'templates', 'resources']);

/**
 * Load bundled files outside the conventional folders. Dot entries and
 * `node_modules` are skipped because they are tooling state, not content the
 * skill asks the model to use. Files are listed before subfolders at each level.
 */
async function loadOtherSkillFiles(skillDir: string, dirPath: string = skillDir): Promise<SkillFile[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    // The inventory is best effort; an unreadable folder must not fail the skill.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      emitKodaXDiagnostic({ source: 'agent:skills', level: 'warn',
        message: `Skipped unreadable skill folder ${dirPath}.`, detail: error });
    }
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const isRoot = dirPath === skillDir;
  const visible = entries.filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules'
    && !(isRoot && (entry.name === 'SKILL.md' || CONVENTIONAL_SUPPORT_FOLDERS.has(entry.name))));

  const files: SkillFile[] = visible.filter((entry) => entry.isFile()).map((entry) => {
    const filePath = join(dirPath, entry.name);
    return { name: entry.name, path: filePath, relativePath: relative(skillDir, filePath).replace(/\\/g, '/') };
  });
  for (const entry of visible.filter((item) => item.isDirectory())) {
    files.push(...await loadOtherSkillFiles(skillDir, join(dirPath, entry.name)));
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
