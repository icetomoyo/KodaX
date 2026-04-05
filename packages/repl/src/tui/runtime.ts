import { spawnSync } from "node:child_process";

export type TerminalRenderHost =
  | "native_vt"
  | "xtermjs_host"
  | "degraded_vt"
  | "unsupported_control_host"
  | "tmux_control_mode";

export type TerminalHostProfile = TerminalRenderHost;

export type TuiRendererMode = "auto" | "legacy" | "owned";
export type EffectiveTuiRendererMode = Exclude<TuiRendererMode, "auto">;
export type InteractiveSurfacePreference = "ink" | "classic";

export interface TerminalHostDetectionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isTTY?: boolean;
  rawModeSupported?: boolean;
  tmuxControlMode?: boolean;
}

export interface TerminalHostCapabilities {
  profile: TerminalRenderHost;
  ownsViewportByDefault: boolean;
  supportsMouseTracking: boolean;
  bufferingMode: "live" | "buffered-fallback";
  supportsFullscreenLayout: boolean;
  supportsOverlaySurface: boolean;
  supportsSelection: boolean;
  supportsCopyOnSelect: boolean;
  supportsWheelHistory: boolean;
  supportsViewportChrome: boolean;
  supportsSearchViewport: boolean;
  supportsStickyPrompt: boolean;
}

export interface FullscreenPolicy {
  enabled: boolean;
  mouseWheel: boolean;
  mouseClicks: boolean;
  streamingPreview: boolean;
  transcriptSpinnerAnimation: boolean;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function isFalseyEnv(value: string | undefined): boolean {
  return value === "0" || value?.toLowerCase() === "false";
}

export function isVsCodeTerminalHostEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.TERM_PROGRAM?.toLowerCase() === "vscode"
    || Boolean(env.VSCODE_GIT_IPC_HANDLE)
    || Boolean(env.VSCODE_INJECTION)
  );
}

export function hasCursorUpViewportYankRisk(
  options: Pick<TerminalHostDetectionOptions, "env" | "platform"> = {},
): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  return platform === "win32" || Boolean(env.WT_SESSION);
}

export function hasMainScreenRenderScrollRisk(
  options: Pick<TerminalHostDetectionOptions, "env" | "platform"> = {},
): boolean {
  const env = options.env ?? process.env;

  return hasCursorUpViewportYankRisk(options) || isVsCodeTerminalHostEnv(env);
}

function isTmuxControlModeEnvHeuristic(env: NodeJS.ProcessEnv): boolean {
  if (!env.TMUX) {
    return false;
  }

  if (env.TERM_PROGRAM !== "iTerm.app") {
    return false;
  }

  const term = env.TERM ?? "";
  return !term.startsWith("screen") && !term.startsWith("tmux");
}

let cachedTmuxProbe: boolean | undefined;

export function isTmuxControlMode(
  options: Pick<TerminalHostDetectionOptions, "env" | "platform" | "tmuxControlMode"> = {},
): boolean {
  if (typeof options.tmuxControlMode === "boolean") {
    return options.tmuxControlMode;
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    return false;
  }

  if (isTmuxControlModeEnvHeuristic(env)) {
    return true;
  }

  const usingProcessEnv = env === process.env && platform === process.platform;
  if (!usingProcessEnv) {
    return false;
  }

  if (cachedTmuxProbe !== undefined) {
    return cachedTmuxProbe;
  }

  cachedTmuxProbe = false;
  if (!env.TMUX) {
    return cachedTmuxProbe;
  }

  if (env.TERM_PROGRAM && env.TERM_PROGRAM !== "iTerm.app") {
    return cachedTmuxProbe;
  }

  try {
    const result = spawnSync(
      "tmux",
      ["display-message", "-p", "#{client_control_mode}"],
      {
        encoding: "utf8",
        timeout: 2000,
      },
    );

    if (result.status === 0) {
      cachedTmuxProbe = result.stdout.trim() === "1";
    }
  } catch {
    cachedTmuxProbe = false;
  }

  return cachedTmuxProbe;
}

export function resetTmuxControlModeProbeForTesting(): void {
  cachedTmuxProbe = undefined;
}

export function detectTerminalRenderHost(
  options: TerminalHostDetectionOptions = {},
): TerminalRenderHost {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? (process.stdout.isTTY === true);
  const rawModeSupported = options.rawModeSupported
    ?? (process.stdin.isTTY === true && typeof process.stdin.setRawMode === "function");

  if (!isTTY || !rawModeSupported || env.TERM === "dumb" || env.CI === "true") {
    return "unsupported_control_host";
  }

  if (isTmuxControlMode(options)) {
    return "tmux_control_mode";
  }

  if (isVsCodeTerminalHostEnv(env)) {
    return "xtermjs_host";
  }

  if (hasCursorUpViewportYankRisk(options)) {
    return "degraded_vt";
  }

  return "native_vt";
}

export const detectTerminalHostProfile = detectTerminalRenderHost;

export function resolveConfiguredTuiRendererMode(
  options: Pick<TerminalHostDetectionOptions, "env"> = {},
): TuiRendererMode {
  const env = options.env ?? process.env;

  if (isTruthyEnv(env.KODAX_FORCE_INK)) {
    return "legacy";
  }

  const configured = env.KODAX_TUI_RENDERER?.trim().toLowerCase();
  if (configured === "legacy" || configured === "owned" || configured === "auto") {
    return configured;
  }

  return "auto";
}

export function resolveEffectiveTuiRendererMode(
  options: TerminalHostDetectionOptions = {},
): EffectiveTuiRendererMode {
  const configuredMode = resolveConfiguredTuiRendererMode(options);
  if (configuredMode === "legacy" || configuredMode === "owned") {
    return configuredMode;
  }

  const host = detectTerminalRenderHost(options);
  return host === "unsupported_control_host" || host === "tmux_control_mode"
    ? "legacy"
    : "owned";
}

export function resolveInteractiveSurfacePreference(
  options: TerminalHostDetectionOptions = {},
): InteractiveSurfacePreference {
  const env = options.env ?? process.env;

  if (isTruthyEnv(env.KODAX_FORCE_CLASSIC_REPL)) {
    return "classic";
  }

  const configuredMode = resolveConfiguredTuiRendererMode({ env });
  if (configuredMode === "legacy" || configuredMode === "owned") {
    return "ink";
  }

  const host = detectTerminalRenderHost(options);
  return host === "unsupported_control_host" || host === "tmux_control_mode"
    ? "classic"
    : "ink";
}

export function resolveFullscreenPolicy(
  host: TerminalRenderHost,
  rendererMode: EffectiveTuiRendererMode = "owned",
): FullscreenPolicy {
  if (rendererMode === "legacy") {
    switch (host) {
      case "native_vt":
        return {
          enabled: false,
          mouseWheel: false,
          mouseClicks: false,
          streamingPreview: true,
          transcriptSpinnerAnimation: true,
        };
      case "xtermjs_host":
      case "degraded_vt":
        return {
          enabled: false,
          mouseWheel: false,
          mouseClicks: false,
          streamingPreview: false,
          transcriptSpinnerAnimation: false,
        };
      case "tmux_control_mode":
      case "unsupported_control_host":
      default:
        return {
          enabled: false,
          mouseWheel: false,
          mouseClicks: false,
          streamingPreview: false,
          transcriptSpinnerAnimation: false,
        };
    }
  }

  switch (host) {
    case "native_vt":
    case "xtermjs_host":
      return {
        enabled: true,
        mouseWheel: true,
        mouseClicks: false,
        streamingPreview: true,
        transcriptSpinnerAnimation: true,
      };
    case "degraded_vt":
      return {
        enabled: true,
        mouseWheel: true,
        mouseClicks: false,
        streamingPreview: false,
        transcriptSpinnerAnimation: false,
      };
    case "tmux_control_mode":
    case "unsupported_control_host":
    default:
      return {
        enabled: false,
        mouseWheel: false,
        mouseClicks: false,
        streamingPreview: false,
        transcriptSpinnerAnimation: false,
      };
  }
}

export function getTerminalHostCapabilities(
  profile: TerminalRenderHost,
  options: {
    rendererMode?: EffectiveTuiRendererMode;
  } = {},
): TerminalHostCapabilities {
  const rendererMode = options.rendererMode ?? "owned";
  const policy = resolveFullscreenPolicy(profile, rendererMode);
  const keyboardSelectionSupported =
    profile !== "unsupported_control_host" && profile !== "tmux_control_mode";

  return {
    profile,
    ownsViewportByDefault: policy.enabled,
    supportsMouseTracking: policy.mouseWheel || policy.mouseClicks,
    bufferingMode: policy.streamingPreview ? "live" : "buffered-fallback",
    supportsFullscreenLayout: policy.enabled,
    supportsOverlaySurface: policy.enabled,
    supportsSelection: keyboardSelectionSupported,
    supportsCopyOnSelect: false,
    supportsWheelHistory: policy.mouseWheel,
    supportsViewportChrome: policy.enabled,
    supportsSearchViewport: policy.enabled,
    supportsStickyPrompt: policy.enabled,
  };
}

export function isOwnedRendererPreferred(
  options: TerminalHostDetectionOptions = {},
): boolean {
  return resolveEffectiveTuiRendererMode(options) === "owned";
}

export function isClassicReplForced(
  options: Pick<TerminalHostDetectionOptions, "env"> = {},
): boolean {
  const env = options.env ?? process.env;
  return isTruthyEnv(env.KODAX_FORCE_CLASSIC_REPL) && !isFalseyEnv(env.KODAX_FORCE_CLASSIC_REPL);
}
