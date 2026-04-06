import { afterEach, describe, expect, it } from "vitest";
import {
  detectTerminalHostProfile,
  getTerminalHostCapabilities,
  hasCursorUpViewportYankRisk,
  hasMainScreenRenderScrollRisk,
  resolveConfiguredTuiRendererMode,
  resolveEffectiveTuiRendererMode,
  resolveFullscreenPolicy,
  resolveInteractiveSurfacePreference,
  resetTmuxControlModeProbeForTesting,
} from "./terminal-host-profile.js";

describe("terminal-host-profile", () => {
  afterEach(() => {
    resetTmuxControlModeProbeForTesting();
  });

  it("detects VS Code terminals as xtermjs hosts", () => {
    expect(detectTerminalHostProfile({
      env: {
        TERM_PROGRAM: "vscode",
      } as NodeJS.ProcessEnv,
      platform: "win32",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("xtermjs_host");
  });

  it("treats legacy Windows terminals without WT_SESSION as degraded", () => {
    expect(detectTerminalHostProfile({
      env: {} as NodeJS.ProcessEnv,
      platform: "win32",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("degraded_vt");
  });

  it("treats Windows Terminal backed sessions as degraded even outside win32", () => {
    expect(detectTerminalHostProfile({
      env: {
        WT_SESSION: "1",
      } as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("degraded_vt");
  });

  it("keeps VS Code terminals on the xtermjs path before applying WT risk fallback", () => {
    expect(detectTerminalHostProfile({
      env: {
        TERM_PROGRAM: "vscode",
        WT_SESSION: "1",
      } as NodeJS.ProcessEnv,
      platform: "win32",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("xtermjs_host");
  });

  it("detects cursor-up viewport yank risk for Windows-backed native terminals", () => {
    expect(hasCursorUpViewportYankRisk({
      env: {} as NodeJS.ProcessEnv,
      platform: "win32",
    })).toBe(true);

    expect(hasCursorUpViewportYankRisk({
      env: {
        WT_SESSION: "1",
      } as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe(true);

    expect(hasCursorUpViewportYankRisk({
      env: {} as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe(false);
  });

  it("treats VS Code terminals as main-screen render scroll risk even outside Windows", () => {
    expect(hasMainScreenRenderScrollRisk({
      env: {
        TERM_PROGRAM: "vscode",
      } as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe(true);
  });

  it("keeps risky-but-supported terminal hosts on the TUI surface by default", () => {
    expect(resolveInteractiveSurfacePreference({
      env: {
        TERM_PROGRAM: "vscode",
      } as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("ink");

    expect(resolveInteractiveSurfacePreference({
      env: {} as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("ink");
  });

  it("lets explicit environment overrides force the interactive surface", () => {
    expect(resolveInteractiveSurfacePreference({
      env: {
        KODAX_FORCE_CLASSIC_REPL: "1",
      } as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("classic");

    expect(resolveInteractiveSurfacePreference({
      env: {
        TMUX: "/tmp/tmux-1000/default,1234,0",
        KODAX_FORCE_INK: "1",
      } as NodeJS.ProcessEnv,
      platform: "darwin",
      isTTY: true,
      rawModeSupported: true,
      tmuxControlMode: true,
    })).toBe("ink");

    expect(resolveInteractiveSurfacePreference({
      env: {
        KODAX_TUI_RENDERER: "owned",
      } as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: false,
      rawModeSupported: false,
    })).toBe("ink");
  });

  it("routes tmux control mode to the classic surface", () => {
    expect(detectTerminalHostProfile({
      env: {
        TMUX: "/tmp/tmux-1000/default,1234,0",
        TERM_PROGRAM: "iTerm.app",
        TERM: "xterm-256color",
      } as NodeJS.ProcessEnv,
      platform: "darwin",
      isTTY: true,
      rawModeSupported: true,
      tmuxControlMode: true,
    })).toBe("tmux_control_mode");

    expect(resolveInteractiveSurfacePreference({
      env: {
        TMUX: "/tmp/tmux-1000/default,1234,0",
      } as NodeJS.ProcessEnv,
      platform: "darwin",
      isTTY: true,
      rawModeSupported: true,
      tmuxControlMode: true,
    })).toBe("classic");
  });

  it("resolves renderer burn-in mode from environment", () => {
    expect(resolveConfiguredTuiRendererMode({
      env: {
        KODAX_TUI_RENDERER: "owned",
      } as NodeJS.ProcessEnv,
    })).toBe("owned");

    expect(resolveConfiguredTuiRendererMode({
      env: {
        KODAX_FORCE_INK: "1",
      } as NodeJS.ProcessEnv,
    })).toBe("legacy");

    expect(resolveEffectiveTuiRendererMode({
      env: {
        TERM_PROGRAM: "vscode",
      } as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("owned");
  });

  it("falls back to unsupported control hosts when tty control is unavailable", () => {
    expect(detectTerminalHostProfile({
      env: {} as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: false,
      rawModeSupported: false,
    })).toBe("unsupported_control_host");
  });

  it("assigns owned viewport capabilities to native VT hosts", () => {
    expect(getTerminalHostCapabilities("native_vt")).toEqual({
      profile: "native_vt",
      ownsViewportByDefault: true,
      supportsMouseTracking: true,
      bufferingMode: "live",
      supportsFullscreenLayout: true,
      supportsOverlaySurface: true,
      supportsSelection: true,
      supportsCopyOnSelect: false,
      supportsWheelHistory: true,
      supportsViewportChrome: true,
      supportsSearchViewport: true,
      supportsStickyPrompt: true,
    });
  });

  it("keeps xtermjs hosts on the native main-screen path by default", () => {
    expect(getTerminalHostCapabilities("xtermjs_host")).toEqual({
      profile: "xtermjs_host",
      ownsViewportByDefault: false,
      supportsMouseTracking: false,
      bufferingMode: "live",
      supportsFullscreenLayout: false,
      supportsOverlaySurface: false,
      supportsSelection: true,
      supportsCopyOnSelect: false,
      supportsWheelHistory: false,
      supportsViewportChrome: false,
      supportsSearchViewport: false,
      supportsStickyPrompt: false,
    });
  });

  it("keeps degraded hosts on native main-screen while preserving live streaming preview", () => {
    expect(getTerminalHostCapabilities("degraded_vt")).toEqual({
      profile: "degraded_vt",
      ownsViewportByDefault: false,
      supportsMouseTracking: false,
      bufferingMode: "live",
      supportsFullscreenLayout: false,
      supportsOverlaySurface: false,
      supportsSelection: true,
      supportsCopyOnSelect: false,
      supportsWheelHistory: false,
      supportsViewportChrome: false,
      supportsSearchViewport: false,
      supportsStickyPrompt: false,
    });
  });

  it("builds fullscreen policies for owned and legacy renderer modes", () => {
    expect(resolveFullscreenPolicy("degraded_vt", "owned")).toEqual({
      enabled: false,
      promptShell: "main-screen",
      mouseWheel: false,
      mouseClicks: false,
      streamingPreview: true,
      transcriptSpinnerAnimation: true,
    });

    expect(resolveFullscreenPolicy("xtermjs_host", "owned")).toEqual({
      enabled: false,
      promptShell: "main-screen",
      mouseWheel: false,
      mouseClicks: false,
      streamingPreview: true,
      transcriptSpinnerAnimation: true,
    });

    expect(resolveFullscreenPolicy("native_vt", "legacy")).toEqual({
      enabled: false,
      promptShell: "main-screen",
      mouseWheel: false,
      mouseClicks: false,
      streamingPreview: true,
      transcriptSpinnerAnimation: true,
    });
  });
});
