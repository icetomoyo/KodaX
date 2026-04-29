import { spawnSync } from "node:child_process";

export type TerminalRenderHost =
  | "native_vt"
  | "xtermjs_host"
  | "degraded_vt"
  | "remote_conpty_host"
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
  promptShell: "virtual" | "main-screen";
  transcriptShell: "virtual" | "main-screen";
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

function isSshSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

// FEATURE_096: Windows + SSH session is the one known host where ConPTY
// silently consumes VT mouse-tracking byte sequences before they reach the
// child process stdin. Any KodaX_FULLSCREEN=1 user override short-circuits
// the auto-downgrade so detect falls back to the original host path.
export function isRemoteConptyHost(
  options: Pick<TerminalHostDetectionOptions, "env" | "platform"> = {},
): boolean {
  const env = options.env ?? process.env;
  if (isTruthyEnv(env.KODAX_FULLSCREEN)) return false;
  const platform = options.platform ?? process.platform;
  return platform === "win32" && isSshSession(env);
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

  if (isRemoteConptyHost(options)) {
    return "remote_conpty_host";
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

// FEATURE_096: KODAX_FULLSCREEN=0 / remote_conpty_host route every host into a
// main-screen policy that hands scroll back to the terminal's native scrollback
// while keeping the spinner alive so users still see the app is working.
//
// streamingPreview is intentionally false here. Historic root cause: Windows
// conhost's cursor-up viewport yank bug (microsoft/terminal#14774). The
// legacy string-level `log-update` factory emitted `cursor up + eraseLines`
// per frame; when that crossed the visible viewport's top edge,
// SetConsoleCursorPosition followed the cursor into scrollback and yanked
// the user's view to the top of the buffer. Track F (v0.7.30) replaced
// `log-update` with the cell-level diff renderer which uses absolute cursor
// positioning (CSI G / CSI ; H rather than relative cursor-up), sidestepping
// the conhost yank entirely. The streamingPreview-disabled guard is kept
// here as a defensive belt-and-suspenders measure for ConPTY edge cases not
// yet validated end-to-end on Windows-SSH; revisit once Track F has burned
// in across the targeted hosts.
//
// Claude Code's `hasCursorUpViewportYankBug` (claudecode/src/ink/terminal.ts)
// gates `showStreamingText` directly on this same condition. KodaX inherits
// the same trade-off here: spinner stays on (single-cell tick has minimal
// cursor-up movement and no yank effect in practice), but live token
// streaming stays suppressed in main-screen paths during the burn-in window.
const KODAX_FULLSCREEN_DISABLE_POLICY: FullscreenPolicy = {
  enabled: false,
  promptShell: "main-screen",
  transcriptShell: "main-screen",
  mouseWheel: false,
  mouseClicks: false,
  streamingPreview: false,
  transcriptSpinnerAnimation: true,
};

export function resolveFullscreenPolicy(
  host: TerminalRenderHost,
  rendererMode: EffectiveTuiRendererMode = "owned",
  options: Pick<TerminalHostDetectionOptions, "env"> = {},
): FullscreenPolicy {
  const env = options.env ?? process.env;
  if (isFalseyEnv(env.KODAX_FULLSCREEN)) {
    return KODAX_FULLSCREEN_DISABLE_POLICY;
  }
  return buildFullscreenPolicy(host, rendererMode);
}

function buildFullscreenPolicy(
  host: TerminalRenderHost,
  rendererMode: EffectiveTuiRendererMode,
): FullscreenPolicy {
  if (rendererMode === "legacy") {
    switch (host) {
      case "native_vt":
        return {
          enabled: false,
          promptShell: "main-screen",
          transcriptShell: "main-screen",
          mouseWheel: false,
          mouseClicks: false,
          streamingPreview: true,
          transcriptSpinnerAnimation: true,
        };
      case "xtermjs_host":
      case "degraded_vt":
      case "remote_conpty_host":
        return {
          enabled: false,
          promptShell: "main-screen",
          transcriptShell: "main-screen",
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
          promptShell: "main-screen",
          transcriptShell: "main-screen",
          mouseWheel: false,
          mouseClicks: false,
          streamingPreview: false,
          transcriptSpinnerAnimation: false,
        };
    }
  }

  switch (host) {
    case "native_vt":
      return {
        enabled: true,
        promptShell: "virtual",
        transcriptShell: "virtual",
        mouseWheel: true,
        mouseClicks: true,
        streamingPreview: true,
        transcriptSpinnerAnimation: true,
      };
    case "xtermjs_host":
      return {
        enabled: true,
        promptShell: "virtual",
        transcriptShell: "virtual",
        mouseWheel: true,
        mouseClicks: true,
        streamingPreview: true,
        transcriptSpinnerAnimation: true,
      };
    case "degraded_vt":
      return {
        enabled: true,
        promptShell: "virtual",
        transcriptShell: "virtual",
        mouseWheel: true,
        mouseClicks: true,
        streamingPreview: true,
        transcriptSpinnerAnimation: true,
      };
    case "remote_conpty_host":
      return KODAX_FULLSCREEN_DISABLE_POLICY;
    case "tmux_control_mode":
    case "unsupported_control_host":
    default:
      return {
        enabled: false,
        promptShell: "main-screen",
        transcriptShell: "main-screen",
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
    env?: NodeJS.ProcessEnv;
  } = {},
): TerminalHostCapabilities {
  const rendererMode = options.rendererMode ?? "owned";
  const policy = resolveFullscreenPolicy(profile, rendererMode, { env: options.env });
  const keyboardSelectionSupported =
    profile !== "unsupported_control_host" && profile !== "tmux_control_mode";

  return {
    profile,
    ownsViewportByDefault: policy.enabled && policy.promptShell === "virtual",
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
