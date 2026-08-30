/**
 * Auto-Mode Guardrail Bootstrap — FEATURE_092 phase 2b.7b (v0.7.33).
 *
 * Builds an `AutoModeToolGuardrail` wired to the live REPL's provider
 * registry, tool registry, and compact permission facts. The factory returns
 * a lazy accessor: the guardrail is constructed
 * on first call so REPLs that never enter `auto` mode pay zero cost.
 *
 * What lives in this file (vs. inline in repl.ts):
 *   - The wiring is FEATURE_092-specific and can be unit-tested independently.
 *   - `repl.ts` is already large; keeping the auto-mode plumbing here makes
 *     it greppable and easier to evolve as later phases (settings, subagent
 *     propagation) extend the feature surface.
 *
 * Caller responsibilities (kept minimal — REPL passes down what it owns):
 *   - Legacy permission-mode and confirmation inputs remain accepted for
 *     source compatibility but do not affect Auto review.
 *   - `getCurrentProvider` / `getCurrentModel` are passed as the
 *     `getDefaultProvider` / `getDefaultModel` LIVE getters on the guardrail
 *     config (FEATURE_092 v0.7.34 hotfix-3). They are evaluated on every
 *     classify() call, so mid-session `/model` and `/provider` swaps DO
 *     retarget the classifier without the user re-entering auto mode.
 *   - Permission review receives compact deterministic operation facts and
 *     user-only authority evidence. AGENTS.md, assistant narration, and tool
 *     outputs are intentionally excluded.
 */

import {
  createAutoModeToolGuardrail,
  getBuiltinRegisteredToolDefinition,
  getRegisteredToolDefinition,
  resolveProvider as resolveCodingProvider,
  type AutoModeAskUser,
  type AutoModeGuardrailConfig,
  type AutoModeSharedState,
  type AutoModeToolGuardrail,
  type SignalCollector,
} from '@kodax-ai/coding';
import type { KodaXBaseProvider } from '@kodax-ai/llm';
import type { PermissionMode } from '../permission/types.js';
import { replBashUserKodaxWriteDeny } from '../permission/repl-bash-signals.js';

export interface AutoModeBootstrapDeps {
  /** @deprecated Retained as inert source-compatibility input. */
  readonly askUser?: AutoModeAskUser;
  readonly projectRoot: string;
  /** Directory used to resolve relative tool paths. */
  readonly executionCwd: string;
  /** Whether process environment path aliases equal the executed shell's aliases. */
  readonly trustProcessEnvironmentPathExpansion?: boolean;
  /** Runtime-owned one-shot admission into the workspace shell sandbox. */
  readonly admitWorkspaceSandboxCall?: AutoModeGuardrailConfig['admitWorkspaceSandboxCall'];
  readonly getCurrentProviderName: () => string;
  readonly getCurrentModel: () => string | undefined;
  readonly getCurrentPermissionMode: () => PermissionMode;
  /** Trusted administrator policy supplied by the Runtime host. */
  readonly administratorPolicy?: string;
  /** Guidance supplied by the selected reviewer model/catalog. */
  readonly modelGuidance?: string;
  /**
   * FEATURE_092 phase 2b.7b slice C: resolved settings/env block. The REPL
   * computes this once via `loadAutoModeSettings()` (in
   * `packages/repl/src/common/permission-config.ts`) and threads it here so
   * the bootstrap stays free of file-system I/O and is hermetically testable.
   */
  readonly autoModeSettings: ResolvedAutoModeBootstrapSettings;
  /**
   * Optional structured logger. Defaults to writing yellow warnings + dim
   * info lines to stderr via console (matching REPL conventions).
   */
  readonly log?: (level: 'info' | 'warn', msg: string) => void;
  /** Session-owned denial/breaker state shared by context-specific guardrails. */
  readonly sharedState?: AutoModeSharedState;

  /**
   * FEATURE_158 (v0.7.39): additional signal collectors merged with the
   * coding-side defaults (`bashSignalCollector` + `fileSignalCollector`).
   * The REPL passes `replBashPathSignalCollector` here so bash commands
   * targeting protected paths (~/.kodax / <projectRoot>/.kodax) or
   * redirecting outside the project produce signals. The collector remains a
   * REPL integration, while its shell/path utilities are coding-owned.
   */
  readonly extraCollectors?: readonly SignalCollector[];
}

/**
 * Subset of `ResolvedAutoModeSettings` the bootstrap actually needs. Imported
 * via structural typing so bootstrap doesn't pull a dependency on
 * `permission-config.ts` (which would create a cycle through the REPL barrel).
 */
export interface ResolvedAutoModeBootstrapSettings {
  readonly classifierModel?: string;
  readonly classifierModelEnv?: string;
  /** Optional fixed reviewer policy from config.json#autoReview.policy. */
  readonly reviewPolicy?: string;
}

export interface AutoModeBootstrapResult {
  /**
   * Lazy accessor — constructs the guardrail on first call. Subsequent
   * calls return the same instance so tracker state is shared
   * across turns within a session.
   */
  readonly getGuardrail: () => AutoModeToolGuardrail;
  /** Reset only current-turn denial thresholds; stays lazy outside Auto. */
  readonly resetTurn: () => void;
}

/** Build a lazy Auto reviewer without reading legacy auto-rules files. */
export async function bootstrapAutoMode(
  deps: AutoModeBootstrapDeps,
): Promise<AutoModeBootstrapResult> {
  let guardrail: AutoModeToolGuardrail | undefined;

  const getGuardrail = (): AutoModeToolGuardrail => {
    if (guardrail) return guardrail;
    const reviewer = createAutoModeToolGuardrail({
      getToolProjection: (toolName) => {
        const def =
          getRegisteredToolDefinition(toolName)
          ?? getBuiltinRegisteredToolDefinition(toolName);
        return def?.toClassifierInput;
      },
      getToolSideEffect: (toolName) => (
        getRegisteredToolDefinition(toolName)
        ?? getBuiltinRegisteredToolDefinition(toolName)
      )?.sideEffect,
      resolveProvider: (name): KodaXBaseProvider | undefined => {
        try {
          return resolveCodingProvider(name);
        } catch {
          return undefined;
        }
      },
      // Static fallback values (still required by the config interface for
      // SDK consumers that don't supply getters). Snapshotted at first
      // getGuardrail() call.
      defaultProvider: deps.getCurrentProviderName(),
      defaultModel: deps.getCurrentModel() ?? '',
      // FEATURE_092 v0.7.34 hotfix-3: live getters re-read provider/model on
      // every classify() so `/model` + `/provider` mid-session swaps retarget
      // the classifier. The common guardrail owns the final non-empty-model
      // check, so an empty live value becomes a local configuration block
      // before provider, approval, breaker, or fallback work.
      getDefaultProvider: deps.getCurrentProviderName,
      getDefaultModel: () => deps.getCurrentModel() ?? '',
      // Compatibility callers may still supply askUser, but Auto reviewer
      // concerns now block the exact attempt and return guidance to the Agent.
      admitWorkspaceSandboxCall: deps.admitWorkspaceSandboxCall,
      log: deps.log,
      sharedState: deps.sharedState,
      // FEATURE_158: thread projectRoot to signal collectors + Tier 0;
      // path-aware bash collector merges with coding-side defaults.
      projectRoot: deps.projectRoot,
      executionCwd: deps.executionCwd,
      trustProcessEnvironmentPathExpansion:
        deps.trustProcessEnvironmentPathExpansion !== false,
      extraCollectors: deps.extraCollectors,
      extraAbsoluteDenyChecks: [replBashUserKodaxWriteDeny],
      // FEATURE_092 phase 2b.7b slice C: classifier model override.
      // `userSettings` is layer 4 of `resolveClassifierModel`;
      // `envVar` is layer 2 (cli flag and session-override remain unset until
      // phase 2b.8 surfaces them via `/auto-model`).
      userSettings: deps.autoModeSettings.classifierModel,
      envVar: deps.autoModeSettings.classifierModelEnv,
      administratorPolicy: deps.administratorPolicy,
      reviewPolicy: deps.autoModeSettings.reviewPolicy,
      modelGuidance: deps.modelGuidance,
    });
    guardrail = {
      ...reviewer,
      async beforeTool(call, context) {
        const verdict = await reviewer.beforeTool!(call, context);
        return verdict.action === 'escalate'
          ? { action: 'block', reason: `[auto_review_denied] ${verdict.reason}` }
          : verdict;
      },
    };
    return guardrail;
  };

  return {
    getGuardrail,
    resetTurn: () => guardrail?.resetTurn(),
  };
}
