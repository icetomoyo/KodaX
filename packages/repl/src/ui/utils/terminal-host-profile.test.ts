import { describe, expect, it } from "vitest";
import {
  detectTerminalHostProfile,
  getTerminalHostCapabilities,
} from "./terminal-host-profile.js";

describe("terminal-host-profile", () => {
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
    });
  });
});
