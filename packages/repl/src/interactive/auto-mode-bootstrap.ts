/**
 * Auto-Mode Guardrail Bootstrap — FEATURE_092 phase 2b.7b (v0.7.33).
 *
 * Builds an `AutoModeToolGuardrail` wired to the live REPL's provider
 * registry, tool registry, AGENTS.md content, and confirm-dialog askUser
 * surface. The factory returns a lazy accessor: the guardrail is constructed
 * on first call so REPLs that never enter `auto` mode pay zero cost.
 *
 * What lives in this file (vs. inline in repl.ts):
 *   - The wiring is FEATURE_092-specific and can be unit-tested independently.
 *   - `repl.ts` is already large; keeping the auto-mode plumbing here makes
 *     it greppable and easier to evolve as later phases (settings, subagent
 *     propagation, slash-command engine toggle) extend the feature surface.
 *
 * Caller responsibilities (kept minimal — REPL passes down what it owns):
 *   - `getCurrentPermissionMode` is read by `askUser` so the confirm dialog
 *     copy reflects the user's actual mode (the guardrail itself doesn't
 *     care about permission mode beyond "we're in auto").
 *   - `getCurrentProvider` / `getCurrentModel` are passed as the
 *     `getDefaultProvider` / `getDefaultModel` LIVE getters on the guardrail
 *     config (FEATURE_092 v0.7.34 hotfix-3). They are evaluated on every
 *     classify() call, so mid-session `/model` and `/provider` swaps DO
 *     retarget the classifier without the user re-entering auto mode.
 *     `claudeMd` and `rules` remain captured-at-init by design (CLAUDE.md
 *     and `~/.kodax/auto-rules.jsonc` mid-session edits are rare; restart
 *     applies them).
 */

import {
  createAutoModeToolGuardrail,
  formatAgentsForPrompt,
  getBuiltinRegisteredToolDefinition,
  getKodaxGlobalDir,
  getRegisteredToolDefinition,
  loadAutoRules,
  resolveProvider as resolveCodingProvider,
  type AgentsFile,
  type AutoModeAskUser,
  type AutoModeToolGuardrail,
  type RulesLoadResult,
} from '@kodax/coding';
import type { KodaXBaseProvider } from '@kodax/ai';
import type { PermissionMode } from '../permission/types.js';

export interface AutoModeBootstrapDeps {
  /**
   * Surface-specific user-confirmation callback. Readline REPL wraps
   * `confirmToolExecution(rl, ...)`; Ink REPL wraps `showConfirmDialog`.
   * Bootstrap stays surface-agnostic so the same factory can wire both
   * UIs without depending on readline.
   */
  readonly askUser: AutoModeAskUser;
  readonly projectRoot: string;
  readonly getAgentsFiles: () => AgentsFile[];
  readonly getCurrentProviderName: () => string;
  readonly getCurrentModel: () => string | undefined;
  readonly getCurrentPermissionMode: () => PermissionMode;
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
  /**
   * Fired whenever the guardrail's classifier engine changes — both on
   * automatic downgrades (denial threshold / circuit breaker) and on
   * manual `setEngine` calls. The REPL surfaces this into status-bar
   * state so the engine indicator stays accurate without requiring a
   * mode toggle to refresh.
   */
  readonly onEngineChange?: (engine: 'llm' | 'rules') => void;
}

/**
 * Subset of `ResolvedAutoModeSettings` the bootstrap actually needs. Imported
 * via structural typing so bootstrap doesn't pull a dependency on
 * `permission-config.ts` (which would create a cycle through the REPL barrel).
 */
export interface ResolvedAutoModeBootstrapSettings {
  readonly engine: 'llm' | 'rules';
  readonly classifierModel?: string;
  readonly classifierModelEnv?: string;
  readonly timeoutMs?: number;
}

export interface AutoModeBootstrapResult {
  /**
   * Lazy accessor — constructs the guardrail on first call. Subsequent
   * calls return the same instance so engine + tracker state is shared
   * across turns within a session.
   */
  readonly getGuardrail: () => AutoModeToolGuardrail;
  /**
   * The rules-load result from `loadAutoRules`. Surfaced so the REPL can
   * print sources/skipped/errors in the startup banner (phase 2b.8 will
   * surface this via `/auto-engine`; v1 just exposes the data).
   */
  readonly rulesLoadResult: RulesLoadResult;
}

/**
 * Async because `loadAutoRules` reads disk. Call once at REPL startup
 * after AGENTS.md has been loaded; the returned `getGuardrail` is sync.
 */
export async function bootstrapAutoMode(
  deps: AutoModeBootstrapDeps,
): Promise<AutoModeBootstrapResult> {
  const rulesLoadResult = await loadAutoRules({
    userKodaxDir: getKodaxGlobalDir(),
    projectRoot: deps.projectRoot,
  });

  let guardrail: AutoModeToolGuardrail | undefined;

  const getGuardrail = (): AutoModeToolGuardrail => {
    if (guardrail) return guardrail;
    guardrail = createAutoModeToolGuardrail({
      rules: rulesLoadResult.merged,
      claudeMd: formatAgentsForPrompt(deps.getAgentsFiles()),
      getToolProjection: (toolName) => {
        const def =
          getRegisteredToolDefinition(toolName)
          ?? getBuiltinRegisteredToolDefinition(toolName);
        return def?.toClassifierInput;
      },
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
      // the classifier. The empty-model warn surfaces a misconfiguration
      // (main session has no model set) instead of failing silently inside
      // sideQuery.
      getDefaultProvider: deps.getCurrentProviderName,
      getDefaultModel: () => {
        const m = deps.getCurrentModel();
        if (!m) {
          deps.log?.(
            'warn',
            '[auto-mode] classifier defaultModel is empty; main session has no model set — classifier will likely fail',
          );
          return '';
        }
        return m;
      },
      askUser: deps.askUser,
      log: deps.log,
      onEngineChange: deps.onEngineChange,
      // FEATURE_092 phase 2b.7b slice C: starting engine + timeout + classifier
      // model overrides. `userSettings` is layer 4 of `resolveClassifierModel`;
      // `envVar` is layer 2 (cli flag and session-override remain unset until
      // phase 2b.8 surfaces them via `/auto-model`).
      initialEngine: deps.autoModeSettings.engine,
      timeoutMs: deps.autoModeSettings.timeoutMs,
      userSettings: deps.autoModeSettings.classifierModel,
      envVar: deps.autoModeSettings.classifierModelEnv,
    });
    return guardrail;
  };

  return { getGuardrail, rulesLoadResult };
}
