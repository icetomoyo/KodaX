/**
 * Skill Executor - Execution Engine
 *
 * Handles skill execution with support for:
 * - Inline execution (default)
 * - Fork execution (sub-agent)
 * - Tool restrictions
 */

import type { Skill, SkillContext, SkillResult } from './types.js';
import { getSkillRegistry } from './skill-registry.js';
import { resolveSkillContent } from './skill-resolver.js';

/**
 * Execution mode
 */
export type ExecutionMode = 'inline' | 'fork';

/**
 * Execution options
 */
export interface ExecutionOptions {
  /** Force a specific execution mode */
  mode?: ExecutionMode;
  /** Override model */
  model?: 'haiku' | 'sonnet' | 'opus';
  /** Override agent type (for fork mode) */
  agent?: string;
  /** Override allowed tools */
  allowedTools?: string[];
  /** Callback for inline execution */
  onExecute?: (content: string, skill: Skill) => Promise<string>;
}

/**
 * Skill executor class
 */
export class SkillExecutor {
  private context: SkillContext;

  constructor(context: SkillContext) {
    this.context = context;
  }

  /**
   * Execute a skill
   */
  async execute(
    skillName: string,
    args: string,
    options?: ExecutionOptions
  ): Promise<SkillResult> {
    const registry = getSkillRegistry();

    // Check if skill exists
    if (!registry.has(skillName)) {
      return {
        success: false,
        content: '',
        error: `Skill not found: ${skillName}`,
      };
    }

    try {
      // Load skill
      const skill = await registry.loadFull(skillName);

      // Determine execution mode
      const mode = options?.mode ?? (skill.context === 'fork' ? 'fork' : 'inline');

      // Resolve content
      const resolvedContent = await resolveSkillContent(
        skill.content,
        args,
        this.context
      );

      // Execute based on mode
      if (mode === 'fork') {
        return this.executeFork(skill, resolvedContent, options);
      } else {
        return this.executeInline(skill, resolvedContent, options);
      }
    } catch (error) {
      return {
        success: false,
        content: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute skill inline (in current context)
   */
  private async executeInline(
    skill: Skill,
    resolvedContent: string,
    options?: ExecutionOptions
  ): Promise<SkillResult> {
    // Build the prompt with skill context
    const prompt = this.buildPrompt(skill, resolvedContent);

    // If callback provided, use it
    if (options?.onExecute) {
      try {
        const result = await options.onExecute(prompt, skill);
        return {
          success: true,
          content: result,
        };
      } catch (error) {
        return {
          success: false,
          content: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    // Default: return the prompt for the caller to handle
    return {
      success: true,
      content: prompt,
    };
  }

  /**
   * Execute skill in fork mode (sub-agent)
   */
  private async executeFork(
    skill: Skill,
    resolvedContent: string,
    options?: ExecutionOptions
  ): Promise<SkillResult> {
    // Build the prompt for sub-agent
    const prompt = this.buildPrompt(skill, resolvedContent);

    // For now, return the prompt with fork instructions
    // The actual sub-agent execution would be handled by the caller
    return {
      success: true,
      content: prompt,
      artifacts: [
        {
          type: 'text',
          name: 'fork-config',
          content: JSON.stringify({
            agent: options?.agent ?? skill.agent ?? 'general-purpose',
            model: options?.model ?? skill.model ?? 'haiku',
            allowedTools: options?.allowedTools ?? this.parseAllowedTools(skill.allowedTools),
          }),
        },
      ],
    };
  }

  /**
   * Build the execution prompt
   */
  private buildPrompt(skill: Skill, resolvedContent: string): string {
    const lines: string[] = [];

    // Add skill context header
    lines.push(`[Using Skill: ${skill.name}]`);
    lines.push('');

    // Add allowed tools restriction if specified
    if (skill.allowedTools) {
      lines.push(`**Allowed Tools**: ${skill.allowedTools}`);
      lines.push('');
    }

    // Add the skill content
    lines.push(resolvedContent);

    return lines.join('\n');
  }

  /**
   * Parse allowed tools string into array
   */
  private parseAllowedTools(allowedTools?: string): string[] {
    if (!allowedTools) return [];

    return allowedTools
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
}

/**
 * Create a skill executor
 */
export function createExecutor(context: SkillContext): SkillExecutor {
  return new SkillExecutor(context);
}

/**
 * Execute a skill with default context
 */
export async function executeSkill(
  skillName: string,
  args: string,
  context: SkillContext,
  options?: ExecutionOptions
): Promise<SkillResult> {
  const executor = new SkillExecutor(context);
  return executor.execute(skillName, args, options);
}
