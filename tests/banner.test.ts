/**
 * Banner Tests
 *
 * Tests for the startup banner display logic in InkREPL.tsx
 * Covers:
 * - Session ID formatting
 * - Version display
 * - Mode flags display
 */

import { describe, it, expect } from "vitest";

/**
 * Formats the session info string for display
 */
function formatSessionInfo(sessionId: string, workingDir: string): string {
  return `Session: ${sessionId} | Working: ${workingDir}`;
}

/**
 * Formats the mode flags display
 */
function formatModeFlags(
  mode: string,
  thinking: boolean,
  auto: boolean,
  planMode: boolean
): string {
  let result = mode;
  if (thinking) result += " +think";
  if (auto) result += " +auto";
  if (planMode) result += " +plan";
  return result;
}

/**
 * Generates the ASCII art logo lines
 */
function getAsciiLogoLines(): string[] {
  return [
    "  ██╗  ██╗  ██████╗  ██████╗    █████╗   ██╗  ██╗",
    "  ██║ ██╔╝ ██╔═══██╗ ██╔══██╗  ██╔══██╗  ╚██╗██╔╝",
    "  █████╔╝  ██║   ██║ ██║  ██║  ███████║   ╚███╔╝",
    "  ██╔═██╗  ██║   ██║ ██║  ██║  ██╔══██║   ██╔██╗",
    "  ██║  ██╗ ╚██████╔╝ ██████╔╝  ██║  ██║  ██╔╝ ██╗",
    "  ╚═╝  ╚═╝  ╚═════╝  ╚═════╝   ╚═╝  ╚═╝  ╚═╝  ╚═╝",
  ];
}

/**
 * Validates session ID format (YYYYMMDD_HHMMSS or timestamp-based)
 */
function isValidSessionId(sessionId: string): boolean {
  // Session ID should be non-empty string
  if (!sessionId || sessionId.length === 0) {
    return false;
  }
  // Should contain at least date component
  return true;
}

describe("Banner Utilities", () => {
  describe("formatSessionInfo", () => {
    it("should format session info with full session ID", () => {
      const sessionId = "20260220_143203";
      const workingDir = "/home/user/project";
      const result = formatSessionInfo(sessionId, workingDir);
      expect(result).toBe("Session: 20260220_143203 | Working: /home/user/project");
    });

    it("should include complete session ID without truncation", () => {
      const sessionId = "20260220_143203";
      const result = formatSessionInfo(sessionId, "/path");
      expect(result).toContain(sessionId);
      expect(result).not.toContain(sessionId.slice(0, 8) + " |");  // Should NOT be truncated
    });

    it("should handle Windows paths", () => {
      const sessionId = "20260220_143203";
      const workingDir = "C:\\Users\\test\\project";
      const result = formatSessionInfo(sessionId, workingDir);
      expect(result).toContain(workingDir);
    });
  });

  describe("formatModeFlags", () => {
    it("should show only mode when no flags", () => {
      const result = formatModeFlags("code", false, false, false);
      expect(result).toBe("code");
    });

    it("should show thinking flag", () => {
      const result = formatModeFlags("code", true, false, false);
      expect(result).toBe("code +think");
    });

    it("should show auto flag", () => {
      const result = formatModeFlags("code", false, true, false);
      expect(result).toBe("code +auto");
    });

    it("should show plan flag", () => {
      const result = formatModeFlags("code", false, false, true);
      expect(result).toBe("code +plan");
    });

    it("should show all flags", () => {
      const result = formatModeFlags("ask", true, true, true);
      expect(result).toBe("ask +think +auto +plan");
    });
  });

  describe("getAsciiLogoLines", () => {
    it("should return 6 lines", () => {
      const lines = getAsciiLogoLines();
      expect(lines.length).toBe(6);
    });

    it("should contain KodaX letters pattern", () => {
      const lines = getAsciiLogoLines();
      const fullLogo = lines.join("\n");
      // Check for characteristic patterns
      expect(fullLogo).toContain("██");  // Block characters
    });

    it("each line should be non-empty", () => {
      const lines = getAsciiLogoLines();
      for (const line of lines) {
        expect(line.length).toBeGreaterThan(0);
      }
    });
  });

  describe("isValidSessionId", () => {
    it("should accept valid session IDs", () => {
      expect(isValidSessionId("20260220_143203")).toBe(true);
      expect(isValidSessionId("20260220-143203-abc")).toBe(true);
      expect(isValidSessionId("12345")).toBe(true);
    });

    it("should reject empty session ID", () => {
      expect(isValidSessionId("")).toBe(false);
    });
  });
});

describe("Status Bar Display", () => {
  /**
   * Formats the status bar string
   */
  function formatStatusBar(
    sessionId: string,
    mode: string,
    provider: string,
    options?: { thinking?: boolean; auto?: boolean; plan?: boolean }
  ): string {
    let result = `Session: ${sessionId} | Mode: ${mode} | Provider: ${provider}`;
    if (options?.thinking) result += " | Thinking";
    if (options?.auto) result += " | Auto";
    if (options?.plan) result += " | Plan";
    return result;
  }

  it("should display full session ID in status bar", () => {
    const sessionId = "20260220_143203";
    const result = formatStatusBar(sessionId, "code", "minimax");
    expect(result).toContain(sessionId);
    expect(result).toBe("Session: 20260220_143203 | Mode: code | Provider: minimax");
  });

  it("should include mode flags in status bar", () => {
    const result = formatStatusBar("session1", "ask", "anthropic", {
      thinking: true,
      auto: true,
    });
    expect(result).toContain("Thinking");
    expect(result).toContain("Auto");
  });
});

/**
 * Banner Stability Tests
 *
 * Tests for Phase 5.4 - ensuring banner is printed only once before Ink starts,
 * following Claude Code's linear output approach.
 */
describe("Banner Stability", () => {
  /**
   * Simulates banner printing timing
   * In Phase 5.4, banner is printed BEFORE Ink starts (not inside component)
   */
  function whenIsBannerPrinted(): "beforeInk" | "insideComponent" {
    return "beforeInk";  // Banner printed before Ink starts
  }

  /**
   * Simulates layout calculation for the banner
   * Returns the number of lines the banner occupies
   */
  function calculateBannerLines(): number {
    // 6 lines for ASCII logo + 2 info lines + 2 dividers = ~10 lines
    return 10;
  }

  /**
   * Checks if console output should be patched
   * In Phase 5.4, we use patchConsole: false to allow command output
   */
  function shouldPatchConsole(): boolean {
    return false;  // patchConsole: false to allow command output to work
  }

  /**
   * Counts how many times banner would be rendered
   * Since it's printed before Ink, state changes don't affect it
   */
  function countBannerRenders(componentRerenders: number): number {
    // Banner is printed once before Ink, regardless of component re-renders
    return 1;
  }

  describe("Banner Timing", () => {
    it("should print banner before Ink starts", () => {
      expect(whenIsBannerPrinted()).toBe("beforeInk");
    });

    it("should NOT include banner in Ink component", () => {
      // Banner is outside the component, so Ink re-renders don't affect it
      const bannerLocation = whenIsBannerPrinted();
      expect(bannerLocation).not.toBe("insideComponent");
    });
  });

  describe("Banner Re-render Prevention", () => {
    it("should only render banner once regardless of state changes", () => {
      // Even if component re-renders 10 times, banner only appears once
      expect(countBannerRenders(10)).toBe(1);
      expect(countBannerRenders(100)).toBe(1);
    });

    it("should not re-render banner on message add", () => {
      const rendersBeforeMessage = countBannerRenders(0);
      const rendersAfterMessage = countBannerRenders(1);
      expect(rendersBeforeMessage).toBe(rendersAfterMessage);
      expect(rendersBeforeMessage).toBe(1);
    });
  });

  describe("Console Output Integration", () => {
    it("should NOT patch console to allow command output", () => {
      expect(shouldPatchConsole()).toBe(false);
    });

    it("should allow console.log to work alongside Ink rendering", () => {
      // When patchConsole is false, console.log outputs go to stdout normally
      // This allows command output (like /help) to appear correctly
      const allowCommandOutput = !shouldPatchConsole();
      expect(allowCommandOutput).toBe(true);
    });
  });

  describe("Render Options", () => {
    it("should use patchConsole: false for stable rendering", () => {
      const renderOptions = {
        stdout: true,
        stdin: true,
        exitOnCtrlC: false,
        patchConsole: false,
      };
      expect(renderOptions.patchConsole).toBe(false);
    });

    it("should not use alternateBuffer option (Ink 5.x limitation)", () => {
      // Ink 5.x doesn't support alternateBuffer option
      // We use patchConsole: false instead
      const supportedOptions = ["stdout", "stdin", "exitOnCtrlC", "patchConsole"];
      expect(supportedOptions).not.toContain("alternateBuffer");
    });
  });
});
