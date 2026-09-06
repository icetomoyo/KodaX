/**
 * FEATURE_298 T37 — Host-side trusted Skill preparation.
 *
 * The client (REPL/queue) only ever supplies a registered Skill name and
 * argument text; loading, dynamic-context expansion, and metadata assembly
 * happen here inside the Host against the trusted registry, and the
 * enforce-at-runtime policy is minted Host-side so prepared permission
 * strings are re-derived by the executor regardless of transport.
 */
import {
  expandSkillForLLM,
  getSkillRegistry,
  initializeSkillRegistry,
  type SkillContext,
  type SkillDynamicContextExecutor,
} from "@kodax-ai/agent";
import type { KodaXSkillInvocationContext } from "@kodax-ai/coding";

export interface RuntimePreparedSkillInvocation {
  readonly prompt: string;
  readonly source: "skill";
  readonly displayName: string;
  readonly path: string;
  readonly disableModelInvocation?: boolean;
  readonly allowedTools?: string;
  readonly context?: "fork";
  readonly agent?: string;
  readonly argumentHint?: string;
  readonly model?: string;
  readonly hooks?: Readonly<Record<string, readonly string[]>>;
  readonly skillInvocation: Omit<KodaXSkillInvocationContext, "runtimePolicy"> & {
    readonly runtimePolicy: { readonly enforceAtRuntime: true };
  };
}

export type RuntimePreparedSkill =
  | { readonly kind: "prepared"; readonly invocation: RuntimePreparedSkillInvocation }
  | { readonly kind: "unknown" };

export interface RuntimeInvocationService {
  prepareSkill(input: {
    readonly projectRoot: string;
    readonly name: string;
    readonly argumentsText?: string;
    readonly sessionId?: string;
  }): Promise<RuntimePreparedSkill>;
}

export function createRuntimeInvocationService(deps: {
  /**
   * Host-mediated executor for Skill `!`cmd`` dynamic context. When absent,
   * dynamic context is hard-disabled — the resolver's legacy execSync path
   * never runs inside the Host unmediated (same policy as buildRunOptions).
   */
  readonly executeDynamicContext?: SkillDynamicContextExecutor;
}): RuntimeInvocationService {
  const skillContext = (input: {
    readonly projectRoot: string;
    readonly sessionId?: string;
  }): SkillContext => ({
    workingDirectory: input.projectRoot,
    projectRoot: input.projectRoot,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(deps.executeDynamicContext !== undefined
      ? { executeDynamicContext: deps.executeDynamicContext }
      : { disableDynamicContext: true }),
  });

  return {
    async prepareSkill(input) {
      let registry = getSkillRegistry(input.projectRoot);
      if (registry.size === 0) {
        registry = await initializeSkillRegistry(input.projectRoot);
      }
      if (!registry.has(input.name)) return { kind: "unknown" };

      const skill = await registry.loadFull(input.name);
      const argumentsText = input.argumentsText ?? "";
      const expanded = await expandSkillForLLM(
        skill,
        argumentsText,
        skillContext(input),
      );
      const hookEvents = skill.hooks
        ? Object.entries(skill.hooks)
          .filter(([, hooks]) => Array.isArray(hooks) && hooks.length > 0)
          .map(([eventName]) => eventName)
        : undefined;
      return {
        kind: "prepared",
        invocation: {
          prompt: expanded.content,
          source: "skill",
          displayName: input.name,
          path: skill.skillFilePath,
          ...(skill.disableModelInvocation !== undefined
            ? { disableModelInvocation: skill.disableModelInvocation }
            : {}),
          ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
          ...(skill.context !== undefined ? { context: skill.context } : {}),
          ...(skill.agent !== undefined ? { agent: skill.agent } : {}),
          ...(skill.argumentHint !== undefined ? { argumentHint: skill.argumentHint } : {}),
          ...(skill.model !== undefined ? { model: skill.model } : {}),
          ...(skill.hooks !== undefined
            ? { hooks: skill.hooks as Readonly<Record<string, readonly string[]>> }
            : {}),
          skillInvocation: {
            name: input.name,
            path: skill.skillFilePath,
            ...(skill.description !== undefined ? { description: skill.description } : {}),
            ...(argumentsText.length > 0 ? { arguments: argumentsText } : {}),
            ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
            ...(skill.context !== undefined ? { context: skill.context } : {}),
            ...(skill.agent !== undefined ? { agent: skill.agent } : {}),
            ...(skill.argumentHint !== undefined ? { argumentHint: skill.argumentHint } : {}),
            ...(skill.model !== undefined ? { model: skill.model } : {}),
            ...(hookEvents !== undefined ? { hookEvents } : {}),
            expandedContent: expanded.content,
            runtimePolicy: { enforceAtRuntime: true },
          },
        },
      };
    },
  };
}
