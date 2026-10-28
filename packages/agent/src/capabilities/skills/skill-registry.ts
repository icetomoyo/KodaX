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
import { emitKodaXDiagnostic } from '../../diagnostics.js';
import { discoverSkills } from './discovery.js';
import { loadFullSkill } from './skill-loader.js';
import { resolveSkillContent } from './skill-resolver.js';

const SKILL_CATALOG_MAX_CHARS = 8_000;
const SKILL_CATALOG_NOTICE_RESERVE = 160;

function catalogText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= limit ? normalized
    : `${normalized.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/** Format the model-visible Skill catalog from an arbitrary trusted registry. */
export function formatSkillsSystemPrompt(
  skills: readonly SkillMetadata[],
): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return '';

  const lines = [
    '## Available Skills',
    '',
    'When users ask you to perform tasks, check if any of the available skills below match the request. Skills provide specialized capabilities and step-by-step instructions for specific workflows.',
    '',
    'If the current task context already contains an "Active skill invocation" or a host-expanded Skill block for the referenced name, that explicit user invocation is already complete. Follow the expanded instructions and do NOT call the `skill` tool for that Skill again.',
    '',
    'When users reference a "slash command" or "/<something>" (e.g. "/feature-list-tracker", "/skill:foo") and the host has not already expanded it, they are referring to a skill. Invoke it via the `skill` tool with the skill name.',
    '',
    "**BLOCKING REQUIREMENT**: When a model-visible Skill matches the user's request and the host has not already expanded it, you MUST invoke it via the `skill` tool BEFORE generating any other response about the task. Loading the Skill is not optional and not something to defer — it is the FIRST action you take.",
    '',
    'NEVER mention a model-discovered Skill without actually calling the `skill` tool. This rule does not apply to a host-expanded active user invocation, which must not be called again. Do not guess at Skill names — only use Skills listed below. Do NOT call `read` on a `SKILL.md` path to load a Skill — that is the legacy path and bypasses the resolver.',
    '',
  ];
  let used = lines.join('\n').length + 1;
  let included = 0;
  let shortened = 0;
  for (const skill of visibleSkills) {
    const description = catalogText(skill.description, 500);
    const hint = skill.argumentHint ? catalogText(skill.argumentHint, 80) : '';
    const line = `- ${skill.name}:${hint ? ` ${hint}` : ''} ${description}`;
    if (used + line.length + 1 > SKILL_CATALOG_MAX_CHARS - SKILL_CATALOG_NOTICE_RESERVE) continue;
    lines.push(line);
    used += line.length + 1;
    included++;
    if (description !== skill.description || hint !== (skill.argumentHint ?? '')) shortened++;
  }
  const omitted = visibleSkills.length - included;
  if (shortened > 0 || omitted > 0) {
    const notice = `[Skill catalog shortened: ${shortened} entries shortened; ${omitted} Skills omitted. Explicit invocation of registered Skills remains available.]`;
    lines.push('', notice);
    emitKodaXDiagnostic({ source: 'agent:skills', level: 'warn', message: notice,
      detail: { code: 'skill_catalog_shortened', total: visibleSkills.length, included, omitted, shortened } });
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Skill Registry implementation
 */
export class SkillRegistry implements ISkillRegistry {
  private readonly skillsByName = new Map<string, SkillMetadata>();
  private readonly fullSkillsByName = new Map<string, Skill>();
  private incompleteDiscovery = false;
  get discoveryIncomplete(): boolean { return this.incompleteDiscovery; }
  private readonly projectRoot?: string;
  private readonly customPaths?: Readonly<Partial<SkillPathsConfig>>;

  constructor(projectRoot?: string, customPaths?: Partial<SkillPathsConfig>) {
    this.projectRoot = projectRoot;
    this.customPaths = customPaths;
  }

  /**
   * Discover skills from all configured paths
   */
  async discover(): Promise<void> {
    const result = await discoverSkills(this.projectRoot, this.customPaths);
    this.incompleteDiscovery = result.errors.length > 0;
    // A published catalog and its bodies must describe the same discovery.
    this.fullSkillsByName.clear();
    this.skillsByName.clear();
    for (const [name, metadata] of result.skills) {
      this.skillsByName.set(name, metadata);
    }

    // Log any discovery errors
    if (result.errors.length > 0) {
      for (const { path, error } of result.errors) {
        emitKodaXDiagnostic({
          source: 'agent:skills',
          level: 'warn',
          message: `Error scanning ${path}.`,
          detail: error,
        });
      }
    }
  }

  /**
   * Get skill metadata by name
   */
  get skills(): ReadonlyMap<string, SkillMetadata> {
    return this.skillsByName;
  }

  /**
   * Get skill metadata by name
   */
  get(name: string): SkillMetadata | undefined {
    return this.skillsByName.get(name);
  }

  /**
   * Load full skill content
   */
  async loadFull(name: string): Promise<Skill> {
    // Check cache
    const cached = this.fullSkillsByName.get(name);
    if (cached) return cached;

    // Get metadata
    const metadata = this.skillsByName.get(name);
    if (!metadata) {
      throw new Error(`Skill not found: ${name}`);
    }

    // Load full skill
    const skill = await loadFullSkill(metadata.path, metadata.source);
    if (this.skillsByName.get(name) !== metadata) return this.loadFull(name);
    if (!skill) {
      throw new Error(`Failed to load skill: ${name}`);
    }

    // Cache and return
    this.fullSkillsByName.set(name, skill);
    return skill;
  }

  /**
   * Explicitly invoke a skill with arguments. Model tool admission is enforced
   * by the coding-layer `skill` tool before it reaches this SDK primitive.
   */
  async invoke(name: string, args: string, context: SkillContext): Promise<SkillResult> {
    try {
      // Load full skill
      const skill = await this.loadFull(name);

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
    this.skillsByName.clear();
    this.fullSkillsByName.clear();

    // Re-discover
    await this.discover();
  }

  /**
   * List all available skills
   */
  list(): SkillMetadata[] {
    return Array.from(this.skillsByName.values());
  }

  /**
   * List user-invocable skills (for / menu)
   */
  listUserInvocable(): SkillMetadata[] {
    return this.list();
  }

  /**
   * Get skills formatted for system prompt injection.
   *
   * FEATURE_143 (v0.7.36): manifest wording hardened toward Claude
   * Code-style strong constraints. The previous wording ("when a user
   * request matches a skill description, use read to load the skill")
   * was too soft — the LLM treated skill invocation as one option among
   * many and frequently authored its own answer instead of loading the
   * SKILL.md instructions. Aligns with the
   * `c:/Works/claudecode/src/tools/SkillTool/prompt.ts` ruleset:
   * BLOCKING REQUIREMENT to load the relevant skill BEFORE generating
   * any other response when a skill matches.
   *
   * Filters out skills with disableModelInvocation=true (Issue 056).
   */
  getSystemPromptSnippet(): string {
    return formatSkillsSystemPrompt(this.list());
  }

  /**
   * Check if a name is a valid skill
   */
  has(name: string): boolean {
    return this.skillsByName.has(name);
  }

  /**
   * Get the count of discovered skills
   */
  get size(): number {
    return this.skillsByName.size;
  }
}

// Singleton instance and its project root
let _instance: SkillRegistry | null = null;
let _instanceProjectRoot: string | undefined;

/**
 * Get the global skill registry instance
 *
 * IMPORTANT: If projectRoot is undefined, returns existing instance without reset.
 * This prevents accidental singleton reset when called without arguments.
 */
export function getSkillRegistry(
  projectRoot?: string,
  customPaths?: Partial<SkillPathsConfig>
): SkillRegistry {
  // Only reset if projectRoot is explicitly provided AND different from current
  // 只有当 projectRoot 明确提供且与当前不同时才重置
  // This prevents accidental reset when getSkillRegistry() is called without args
  if (_instance && projectRoot !== undefined && _instanceProjectRoot !== projectRoot) {
    _instance = null;
  }

  if (!_instance) {
    _instance = new SkillRegistry(projectRoot, customPaths);
    _instanceProjectRoot = projectRoot;
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
