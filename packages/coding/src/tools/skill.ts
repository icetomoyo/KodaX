/**
 * Skill tool — claudecode-parity invocation path for skills.
 *
 * Before this tool, the `getSystemPromptSnippet()` injected into every
 * AMA worker's system prompt told the model: "Use the read tool to load
 * the skill's `SKILL.md` and follow its instructions." That routed skill
 * invocation through generic `read` on a .md file — the model then had
 * to interpret raw markdown to figure out what to do. For a skill like
 * `agent-browser` whose description mentions "screenshots / data
 * extraction", a model handling a pasted PNG would:
 *
 *   1. Match the skill description → BLOCKING REQUIREMENT to load first
 *   2. Call `read` on `~/.claude/skills/agent-browser/SKILL.md`
 *   3. Read full markdown describing the browser-automation CLI
 *   4. Conclude "I should run `agent-browser open <path>` in the shell"
 *   5. Shell out, fail (image is already inline, not a URL), give up
 *
 * claudecode handles this differently. It has a dedicated `Skill` tool
 * (see `c:/Works/claudecode/src/tools/SkillTool/SkillTool.ts`) that
 * takes a skill name and returns structured skill content as a
 * `tool_result`. The model invokes by name, not by file path; the tool
 * does the loading + variable resolution.
 *
 * KodaX retains this invocation surface and delegates action policies,
 * hooks and model selection to the owning Run. Host authorization remains
 * authoritative; fork execution requires an explicit Host invocation.
 */

import { expandSkillForLLM, getSkillRegistry, initializeSkillRegistry } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';
import { TOOL_CALL_NAME } from './tool-bridge.js';

/** Includes attempted bridge loads even when their inner arguments are invalid. */
export function isSkillToolCall(call: { readonly name: string; readonly input?: Record<string, unknown> }): boolean {
  if (call.name === 'skill') return true;
  const name = call.input?.name ?? call.input?.tool_name;
  return call.name === TOOL_CALL_NAME && typeof name === 'string' && name.trim() === 'skill';
}

export const SKILL_ACTION_DEFERRED = '[Blocked] Task actions were deferred until after Skill loading. Read the Skill result, resolve any activation error, then retry these actions in a separate tool batch.';

function normalizeSkillToolName(rawSkill: string): string {
  const trimmed = rawSkill.trim();
  if (trimmed.startsWith('/skill:')) return trimmed.slice('/skill:'.length);
  if (trimmed.startsWith('skill:')) return trimmed.slice('skill:'.length);
  if (trimmed.startsWith('/')) return trimmed.slice(1);
  return trimmed;
}

export async function toolSkill(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const rawSkill = input.skill;
  if (typeof rawSkill !== 'string' || rawSkill.trim().length === 0) {
    return '[Tool Error] skill: missing required argument `skill` (string).';
  }
  // Strip a leading slash if present — users sometimes type `/commit`
  // out of slash-command muscle memory. Stay forgiving.
  const skillName = normalizeSkillToolName(rawSkill);

  const args = typeof input.args === 'string' ? input.args : '';
  const cwd = ctx.executionCwd ?? process.cwd();
  const projectRoot = ctx.gitRoot ?? cwd;

  const registry = ctx.skillRegistry ?? getSkillRegistry(projectRoot);
  if (registry.size === 0) {
    if (ctx.skillRegistry) await ctx.skillRegistry.discover();
    else await initializeSkillRegistry(projectRoot);
  }

  if (!registry.has(skillName)) {
    const displayName = skillName.length <= 128 ? skillName
      : `${skillName.slice(0, 127).replace(/[\uD800-\uDBFF]$/, '')}…`;
    return `[Tool Error] skill: unknown skill ${JSON.stringify(displayName)}. Use an exact name from the available Skill catalog.`;
  }

  try {
    const fullSkill = await registry.loadFull(skillName);
    if (fullSkill.disableModelInvocation) {
      return `[Tool Error] skill ${skillName}: Skill "${skillName}" has model invocation disabled`;
    }
    if (fullSkill.context === 'fork') {
      return `[Tool Error] skill ${skillName}: context: fork requires explicit invocation so the Host can create its execution boundary.`;
    }
    if (!ctx.activateModelSkill && (fullSkill.allowedTools || fullSkill.hooks || fullSkill.model || fullSkill.agent)) {
      return `[Tool Error] skill ${skillName}: runtime Skill activation is unavailable.`;
    }
    const metadata = registry.get(skillName);
    if (metadata?.source === 'learned') {
      if (metadata.learned === undefined
        || ctx.admitLearnedSkillInvocation === undefined
        || ctx.sessionId === undefined) {
        return `[Tool Error] skill ${skillName}: learned Skill invocation is not admitted by the Runtime owner`;
      }
      await ctx.admitLearnedSkillInvocation({
        sessionId: ctx.sessionId,
        capabilityId: metadata.learned.capabilityId,
        revision: metadata.learned.revision,
        fingerprint: metadata.learned.fingerprint,
      });
    }

    const activation = await ctx.activateModelSkill?.(fullSkill, args, registry);
    const expanded = await expandSkillForLLM(fullSkill, args, {
      workingDirectory: cwd,
      projectRoot,
      // FEATURE_222 skill security — an LLM-auto-triggered skill's `!`cmd``
      // dynamic-context must go through the host's permission policy, not the
      // built-in execSync fallback. Absent policy ⇒ resolver's Tier-3 default
      // (unchanged for the trusted standalone CLI).
      executeDynamicContext: ctx.skillDynamicContext?.execute,
      disableDynamicContext: ctx.skillDynamicContext?.disable,
      assertDynamicContextAllowed: activation?.assertDynamicContextAllowed,
    });

    return [expanded.content, activation?.additionalContext].filter(Boolean).join('\n\n');
  } catch (error) {
    return `[Tool Error] skill ${skillName}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
