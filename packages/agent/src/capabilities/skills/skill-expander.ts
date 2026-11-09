/**
 * Skill Expander - Expand skill commands for LLM context injection
 *
 * Takes a skill invocation and produces content that can be injected
 * into the user message for LLM execution.
 *
 * Design based on pi-mono's _expandSkillCommand:
 * - Wraps content in XML blocks for clear context
 * - Includes skill metadata (name, location)
 * - Resolves all variables ($ARGUMENTS, $0, etc.)
 * - Handles dynamic context (!`command`)
 */

import type { Skill, SkillContext, SkillFile } from './types.js';
import { resolveSkillContent } from './skill-resolver.js';

/**
 * Result of skill expansion
 */
export interface SkillExpansionResult {
  /** The expanded skill content ready for LLM injection */
  content: string;
  /** Whether the skill has model invocation disabled */
  disableModelInvocation: boolean;
  /** Original skill metadata */
  skill: Skill;
}

/**
 * Escape special XML characters to prevent injection
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const SUPPORT_FILE_LINE_LIMIT = 120;

function formatDisplayPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/** Support files as `[path relative to the skill root, file]`, in inventory order. */
function collectSupportFiles(skill: Skill): Array<[string, SkillFile]> {
  const inFolder = (folder: string, files: SkillFile[] | undefined) =>
    (files ?? []).map((file): [string, SkillFile] => [`${folder}/${file.relativePath}`, file]);
  return [
    ...inFolder('references', skill.references),
    ...inFolder('scripts', skill.scripts),
    ...(skill.otherFiles ?? []).map((file): [string, SkillFile] => [file.relativePath, file]),
    ...inFolder('assets', skill.assets),
    ...inFolder('templates', skill.templates),
    ...inFolder('resources', skill.resources),
  ];
}

function countFilesByTopFolder(supportFiles: Array<[string, SkillFile]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [relativePath] of supportFiles) {
    const slash = relativePath.indexOf('/');
    if (slash > 0) {
      const folder = relativePath.slice(0, slash);
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  return counts;
}

function buildSupportFileContext(skill: Skill): string[] {
  const supportFiles = collectSupportFiles(skill);
  if (supportFiles.length === 0) {
    return [];
  }

  const lines = [
    'Skill support files are rooted at the skill root above.',
    'When the skill mentions a file listed below by a relative path, use the listed absolute path, because tool calls resolve relative paths against the project working directory.',
  ];

  const folderCounts = countFilesByTopFolder(supportFiles);
  if (folderCounts.size > 0) {
    lines.push('', 'Support roots:');
    for (const [folder, count] of folderCounts) {
      lines.push(`- ${folder}/: ${formatDisplayPath(`${skill.path}/${folder}`)} (${count} files)`);
    }
  }

  lines.push('', 'Support file inventory:');
  for (const [relativePath, file] of supportFiles.slice(0, SUPPORT_FILE_LINE_LIMIT)) {
    lines.push(`- ${relativePath}: ${formatDisplayPath(file.path)}`);
  }

  if (supportFiles.length > SUPPORT_FILE_LINE_LIMIT) {
    lines.push(`- ... ${supportFiles.length - SUPPORT_FILE_LINE_LIMIT} more files under ${formatDisplayPath(skill.path)}`);
  }

  return lines;
}

/**
 * Build the skill block in XML format
 *
 * Format inspired by pi-mono:
 * ```xml
 * <skill name="skill-name" location="/path/to/skill">
 * References are relative to /project/root.
 *
 * [skill content]
 * </skill>
 * ```
 */
function buildSkillBlock(skill: Skill, content: string, args: string): string {
  const lines: string[] = [];

  // Opening tag with metadata
  lines.push(`<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.path)}">`);
  lines.push('');
  lines.push(`Skill root: ${formatDisplayPath(skill.path)}`);

  // Add context reference information
  if (skill.source === 'builtin') {
    lines.push('This is a built-in KodaX skill.');
  } else if (skill.source === 'project') {
    lines.push('This is a project-defined skill. Project work paths are relative to the project root; skill support files are relative to the skill root above.');
  } else if (skill.source === 'user') {
    lines.push(`This is a user-defined skill.`);
  }

  lines.push('');
  const supportContext = buildSupportFileContext(skill);
  if (supportContext.length > 0) {
    lines.push(...supportContext);
    lines.push('');
  }

  // Add skill content (already resolved)
  lines.push(content);

  // If there are arguments, append them
  if (args.trim()) {
    lines.push('');
    lines.push(`User provided arguments: ${args}`);
  }

  lines.push('');
  lines.push('</skill>');

  return lines.join('\n');
}

/**
 * Expand a skill into LLM-ready content
 *
 * This function:
 * 1. Resolves all variables in the skill content ($ARGUMENTS, $0, $1, etc.)
 * 2. Executes dynamic context commands (!`command`)
 * 3. Wraps the content in an XML block for clear context boundaries
 *
 * @param skill - The full skill object with content
 * @param args - Raw arguments string from user input
 * @param context - Execution context (working directory, session ID, etc.)
 * @returns Expansion result with content ready for LLM injection
 */
export async function expandSkillForLLM(
  skill: Skill,
  args: string,
  context: SkillContext
): Promise<SkillExpansionResult> {
  // Resolve variables in skill content
  const resolvedContent = await resolveSkillContent(skill.content, args, { ...context, skillDir: skill.path });

  // Create skill block with metadata
  const skillBlock = buildSkillBlock(skill, resolvedContent, args);

  return {
    content: skillBlock,
    disableModelInvocation: skill.disableModelInvocation ?? false,
    skill,
  };
}

/**
 * Format skill activation message for user display
 */
export function formatSkillActivationMessage(skillName: string, args: string): string {
  let message = `Skill activated: ${skillName}`;
  if (args.trim()) {
    message += ` with arguments: ${args}`;
  }
  return message;
}
