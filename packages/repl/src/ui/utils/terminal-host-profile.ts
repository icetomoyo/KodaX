export type TerminalHostProfile =
  | "native_vt"
  | "xtermjs_host"
  | "degraded_vt"
  | "unsupported_control_host";

export interface TerminalHostDetectionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isTTY?: boolean;
  rawModeSupported?: boolean;
}

export interface TerminalHostCapabilities {
  profile: TerminalHostProfile;
  ownsViewportByDefault: boolean;
  supportsMouseTracking: boolean;
  bufferingMode: "live" | "buffered-fallback";
}

export function detectTerminalHostProfile(
  options: TerminalHostDetectionOptions = {},
): TerminalHostProfile {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isTTY = options.isTTY ?? (process.stdout.isTTY === true);
  const rawModeSupported = options.rawModeSupported
    ?? (process.stdin.isTTY === true && typeof process.stdin.setRawMode === "function");

  if (!isTTY || !rawModeSupported || env.TERM === "dumb" || env.CI === "true") {
    return "unsupported_control_host";
  }

  if (
    env.TERM_PROGRAM?.toLowerCase() === "vscode"
    || Boolean(env.VSCODE_GIT_IPC_HANDLE)
    || Boolean(env.VSCODE_INJECTION)
  ) {
    return "xtermjs_host";
  }

  if (platform === "win32" && !env.WT_SESSION) {
    return "degraded_vt";
  }

  return "native_vt";
}

export function getTerminalHostCapabilities(
  profile: TerminalHostProfile,
): TerminalHostCapabilities {
  switch (profile) {
    case "xtermjs_host":
      return {
        profile,
        ownsViewportByDefault: true,
        supportsMouseTracking: true,
        bufferingMode: "live",
      };
    case "native_vt":
      return {
        profile,
        ownsViewportByDefault: true,
        supportsMouseTracking: true,
        bufferingMode: "live",
      };
    case "degraded_vt":
      return {
        profile,
        ownsViewportByDefault: false,
        supportsMouseTracking: false,
        bufferingMode: "buffered-fallback",
      };
    case "unsupported_control_host":
    default:
      return {
        profile,
        ownsViewportByDefault: false,
        supportsMouseTracking: false,
        bufferingMode: "buffered-fallback",
      };
  }
}
