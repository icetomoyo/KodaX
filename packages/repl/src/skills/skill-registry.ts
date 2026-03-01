/**
 * Skill Registry - Progressive Disclosure and Skill Management
 *
 * Manages skill discovery, loading, and invocation with progressive disclosure:
 * - Level 1: Metadata preloaded at startup (name, description)
 * - Level 2: Full content loaded on invoke
 * - Level 3: Support files loaded on demand
 */

import type {
  Skill,
  SkillMetadata,
  SkillContext,
  SkillResult,
  ISkillRegistry,
  SkillPathsConfig,
} from './types.js';
import { getDefaultSkillPaths } from './types.js';
import { discoverSkills } from './discovery.js';
import { loadFullSkill } from './skill-loader.js';
import { resolveSkillContent } from './skill-resolver.js';

/**
 * Skill Registry implementation
 */
export class SkillRegistry implements ISkillRegistry {
  skills: Map<string, SkillMetadata> = new Map();
  private fullSkills: Map<string, Skill> = new Map();
  private projectRoot?: string;
  private customPaths?: Partial<SkillPathsConfig>;

  constructor(projectRoot?: string, customPaths?: Partial<SkillPathsConfig>) {
    this.projectRoot = projectRoot;
    this.customPaths = customPaths;
  }

  /**
   * Discover skills from all configured paths
   */
  async discover(): Promise<void> {
    const result = await discoverSkills(this.projectRoot, this.customPaths);
    this.skills = result.skills;

    // Log any discovery errors
    if (result.errors.length > 0) {
      for (const { path, error } of result.errors) {
        console.warn(`[Skills] Error scanning ${path}: ${error}`);
      }
    }
  }

  /**
   * Get skill metadata by name
   */
  get(name: string): SkillMetadata | undefined {
    return this.skills.get(name);
  }

  /**
   * Load full skill content
   */
  async loadFull(name: string): Promise<Skill> {
    // Check cache
    const cached = this.fullSkills.get(name);
    if (cached) return cached;

    // Get metadata
    const metadata = this.skills.get(name);
    if (!metadata) {
      throw new Error(`Skill not found: ${name}`);
    }

    // Load full skill
    const skill = await loadFullSkill(metadata.path, metadata.source);
    if (!skill) {
      throw new Error(`Failed to load skill: ${name}`);
    }

    // Cache and return
    this.fullSkills.set(name, skill);
    return skill;
  }

  /**
   * Invoke a skill with arguments
   */
  async invoke(name: string, args: string, context: SkillContext): Promise<SkillResult> {
    try {
      // Load full skill
      const skill = await this.loadFull(name);

      // Check if model invocation is disabled
      if (skill.disableModelInvocation) {
        return {
          success: false,
          content: '',
          error: `Skill "${name}" has model invocation disabled`,
        };
      }

      // Resolve variables in content
      const resolvedContent = await resolveSkillContent(
        skill.content,
        args,
        context
      );

      return {
        success: true,
        content: resolvedContent,
      };
    } catch (error) {
      return {
        success: false,
        content: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Reload skills from disk
   */
  async reload(): Promise<void> {
    // Clear caches
    this.skills.clear();
    this.fullSkills.clear();

    // Re-discover
    await this.discover();
  }

  /**
   * List all available skills
   */
  list(): SkillMetadata[] {
    return Array.from(this.skills.values());
  }

  /**
   * List user-invocable skills (for / menu)
   */
  listUserInvocable(): SkillMetadata[] {
    return this.list().filter((s) => s.userInvocable);
  }

  /**
   * Get skills formatted for system prompt injection
   * Filters out skills with disableModelInvocation=true (Issue 056)
   */
  getSystemPromptSnippet(): string {
    // Filter out skills that disable model invocation
    const visibleSkills = this.list().filter(s => !s.disableModelInvocation);

    if (visibleSkills.length === 0) {
      return '';
    }

    const lines = [
      '## Available Skills',
      '',
      'The following skills are available. Use them by typing `/skill-name [args]` or asking naturally:',
      '',
    ];

    for (const skill of visibleSkills) {
      const hint = skill.argumentHint ? ` ${skill.argumentHint}` : '';
      lines.push(`- \`/${skill.name}${hint}\` - ${skill.description}`);
    }

    lines.push('');
    lines.push('When a skill matches the user request, invoke it for specialized assistance.');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Check if a name is a valid skill
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * Get the count of discovered skills
   */
  get size(): number {
    return this.skills.size;
  }
}

// Singleton instance
let _instance: SkillRegistry | null = null;

/**
 * Get the global skill registry instance
 */
export function getSkillRegistry(
  projectRoot?: string,
  customPaths?: Partial<SkillPathsConfig>
): SkillRegistry {
  if (!_instance) {
    _instance = new SkillRegistry(projectRoot, customPaths);
  }
  return _instance;
}

/**
 * Initialize the skill registry and discover skills
 */
export async function initializeSkillRegistry(
  projectRoot?: string,
  customPaths?: Partial<SkillPathsConfig>
): Promise<SkillRegistry> {
  const registry = getSkillRegistry(projectRoot, customPaths);
  await registry.discover();
  return registry;
}

/**
 * Reset the global registry (for testing or hot reload)
 */
export function resetSkillRegistry(): void {
  _instance = null;
}
