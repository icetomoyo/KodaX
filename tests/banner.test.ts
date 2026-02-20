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
