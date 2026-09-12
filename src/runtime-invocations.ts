/**
 * FEATURE_298 T37 — Host-side trusted Skill preparation.
 *
 * The client (REPL/queue) only ever supplies a registered Skill name and
 * argument text; loading, dynamic-context expansion, and metadata assembly
 * happen here inside the Host against the trusted registry, and the
 * enforce-at-runtime policy is minted Host-side so prepared permission
 * strings are re-derived by the executor regardless of transport.
 */
import { join } from "node:path";

import {
  expandSkillForLLM,
  getAgentConfigPath,
  getSkillRegistry,
  initializeSkillRegistry,
  type SkillContext,
  type SkillHooks,
  type Skill,
} from "@kodax-ai/agent";
import type { KodaXSkillInvocationContext } from "@kodax-ai/coding";
import { commandDiscoveryDirs, discoverCommands } from "@kodax-ai/repl";
import type {
  RuntimePreparedAgentsLean,
  RuntimePreparedReview,
  RuntimeReviewPreparationService,
} from "./runtime-review-preparation.js";

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
  readonly hooks?: SkillHooks;
  readonly skillInvocation: Omit<KodaXSkillInvocationContext, "runtimePolicy"> & {
    readonly runtimePolicy: { readonly enforceAtRuntime: true };
  };
}

export type RuntimePreparedSkill =
  | { readonly kind: "prepared"; readonly invocation: RuntimePreparedSkillInvocation }
  | { readonly kind: "unknown" };

/** FEATURE_298 T37 — discovered prompt-command preparation projection. */
export interface RuntimePreparedCommandInvocation {
  readonly prompt: string;
  readonly source: "prompt";
  readonly displayName: string;
  readonly path?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
  readonly allowedTools?: string;
  readonly context?: "fork";
  readonly agent?: string;
  readonly argumentHint?: string;
  readonly model?: string;
  readonly hooks?: SkillHooks;
  readonly frontmatter?: Record<string, unknown>;
}

export type RuntimePreparedCommand =
  | { readonly kind: "prepared"; readonly invocation: RuntimePreparedCommandInvocation }
  /** Registry-known non-prompt commands have no discovered prompt to prepare. */
  | { readonly kind: "local" }
  | { readonly kind: "unknown" };

export interface RuntimeInvocationService {
  prepareSkill(input: {
    readonly projectRoot: string;
    readonly name: string;
    readonly argumentsText?: string;
    readonly sessionId?: string;
  }, options?: { readonly signal?: AbortSignal }): Promise<RuntimePreparedSkill>;
  prepareCommand(input: {
    readonly projectRoot: string;
    readonly name: string;
  }): Promise<RuntimePreparedCommand>;
  /** FEATURE_298 T37 — /review preparation (git capture + packets Host-side). */
  prepareReview(input: {
    readonly projectRoot: string;
    readonly sessionId: string;
    readonly args: readonly string[];
  }): Promise<RuntimePreparedReview>;
  /** FEATURE_298 T37 — /agents lean prompt preparation. */
  prepareAgentsLean(input: {
    readonly projectRoot: string;
  }): Promise<RuntimePreparedAgentsLean>;
}

export function createRuntimeInvocationService(deps: {
  /** Registry listing used to classify non-prompt commands as client-local. */
  readonly listCommands?: (projectRoot?: string) => readonly { readonly name: string }[];
  /** FEATURE_298 T37 slice 3 — /review and /agents lean preparation. */
  readonly reviewPreparation: RuntimeReviewPreparationService;
  /** Supplies the admitted Session context and its Host-mediated executor. */
  readonly resolveSkillContext?: (
    input: Parameters<RuntimeInvocationService['prepareSkill']>[0],
    options?: { readonly signal?: AbortSignal },
  ) => Promise<SkillContext>;
}): RuntimeInvocationService {
  const skillContext = async (
    input: Parameters<RuntimeInvocationService['prepareSkill']>[0],
    options?: { readonly signal?: AbortSignal },
  ): Promise<SkillContext> => {
    const context = await (options === undefined ? deps.resolveSkillContext?.(input) : deps.resolveSkillContext?.(input, options)) ?? {
      workingDirectory: input.projectRoot,
      projectRoot: input.projectRoot,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    };
    return {
      ...context,
      // A missing executor must never fall through to the resolver's execSync.
      disableDynamicContext: context.disableDynamicContext === true
        || context.executeDynamicContext === undefined,
    };
  };

  const prepareCommand: RuntimeInvocationService["prepareCommand"] = async (input) => {
    // Discovery order is owned by commandDiscoveryDirs (shared with the
    // REPL registry); lookups lowercase like the client registry does.
    const wanted = input.name.toLowerCase();
    const discovered = discoverCommands([...commandDiscoveryDirs(input.projectRoot)]);
    const command = discovered.find(
      (candidate) =>
        candidate.name.toLowerCase() === wanted
        || (candidate.aliases ?? []).some((alias) => alias.toLowerCase() === wanted),
    );
    if (command !== undefined) {
      return {
        kind: "prepared",
        invocation: {
          ...command.execution,
          prompt: command.content,
          source: "prompt",
          displayName: command.name,
          ...(command.path !== undefined ? { path: command.path } : {}),
        },
      };
    }
    const known = deps.listCommands?.(input.projectRoot)
      .some((candidate) => candidate.name.toLowerCase() === wanted) ?? false;
    return known ? { kind: "local" } : { kind: "unknown" };
  };

  return {
    prepareCommand,
    prepareReview: deps.reviewPreparation.prepareReview,
    prepareAgentsLean: deps.reviewPreparation.prepareAgentsLean,
    async prepareSkill(input, options) {
      options?.signal?.throwIfAborted();
      const skill = await loadRuntimeSkill(input.projectRoot, input.name);
      if (!skill) return { kind: 'unknown' };
      const result = await expandRuntimeSkill(skill, input, await skillContext(input, options));
      options?.signal?.throwIfAborted();
      return result;
    },
  };
}

/** Pure registry read. Dynamic commands are deferred until the Run owns execution. */
export async function loadRuntimeSkill(projectRoot: string, name: string): Promise<Skill | undefined> {
  let registry = getSkillRegistry(projectRoot);
  if (registry.size === 0) registry = await initializeSkillRegistry(projectRoot);
  return registry.has(name) ? registry.loadFull(name) : undefined;
}

export async function expandRuntimeSkill(
  skill: Skill,
  input: Parameters<RuntimeInvocationService['prepareSkill']>[0],
  context: SkillContext,
): Promise<Extract<RuntimePreparedSkill, { kind: 'prepared' }>> {
  const argumentsText = input.argumentsText ?? "";
  const expanded = await expandSkillForLLM(
    skill,
    argumentsText,
    context,
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
      ...(skill.hooks !== undefined ? { hooks: skill.hooks } : {}),
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
}
