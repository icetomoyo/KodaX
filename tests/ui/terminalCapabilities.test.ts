/**
 * Tests for terminalCapabilities - Terminal Capability Detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectTerminalCapabilities,
  supportsTrueColor,
  supports256Colors,
  supportsUnicode,
  supportsEmoji,
  getTerminalWidth,
  isScreenReader,
  TerminalCapabilities,
} from "../../src/ui/utils/terminalCapabilities.js";

describe("TerminalCapabilities", () => {
  const originalEnv = process.env;
  const originalStdout = process.stdout;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("detectTerminalCapabilities", () => {
    it("should return TerminalCapabilities object", () => {
      const caps = detectTerminalCapabilities();
      expect(caps).toHaveProperty("trueColor");
      expect(caps).toHaveProperty("colors256");
      expect(caps).toHaveProperty("unicode");
      expect(caps).toHaveProperty("emoji");
      expect(caps).toHaveProperty("tty");
      expect(caps).toHaveProperty("columns");
      expect(caps).toHaveProperty("screenReader");
    });

    it("should detect TTY support", () => {
      const caps = detectTerminalCapabilities();
      // In test environment, typically not a TTY
      expect(typeof caps.tty).toBe("boolean");
    });

    it("should detect terminal width", () => {
      const caps = detectTerminalCapabilities();
      expect(typeof caps.columns).toBe("number");
      expect(caps.columns).toBeGreaterThan(0);
    });
  });

  describe("supportsTrueColor", () => {
    it("should return true for terminals with COLORTERM=truecolor", () => {
      process.env.COLORTERM = "truecolor";
      expect(supportsTrueColor()).toBe(true);
    });

    it("should return true for iTerm2", () => {
      process.env.TERM_PROGRAM = "iTerm.app";
      delete process.env.COLORTERM;
      expect(supportsTrueColor()).toBe(true);
    });

    it("should return true for Windows Terminal", () => {
      process.env.WT_SESSION = "some-session-id";
      delete process.env.COLORTERM;
      delete process.env.TERM_PROGRAM;
      expect(supportsTrueColor()).toBe(true);
    });

    it("should return true for Kitty terminal", () => {
      process.env.TERM = "xterm-kitty";
      delete process.env.COLORTERM;
      delete process.env.TERM_PROGRAM;
      delete process.env.WT_SESSION;
      expect(supportsTrueColor()).toBe(true);
    });

    it("should return false for basic terminals", () => {
      delete process.env.COLORTERM;
      delete process.env.TERM_PROGRAM;
      delete process.env.WT_SESSION;
      process.env.TERM = "xterm";
      expect(supportsTrueColor()).toBe(false);
    });
  });

  describe("supports256Colors", () => {
    it("should return true for xterm-256color", () => {
      process.env.TERM = "xterm-256color";
      expect(supports256Colors()).toBe(true);
    });

    it("should return true for screen-256color", () => {
      process.env.TERM = "screen-256color";
      expect(supports256Colors()).toBe(true);
    });

    it("should return true if true color is supported", () => {
      process.env.COLORTERM = "truecolor";
      process.env.TERM = "xterm";
      expect(supports256Colors()).toBe(true);
    });

    it("should return false for basic xterm", () => {
      process.env.TERM = "xterm";
      delete process.env.COLORTERM;
      expect(supports256Colors()).toBe(false);
    });
  });

  describe("supportsUnicode", () => {
    it("should return true when no LC_ALL/LC_CTYPE/LANG suggests ASCII", () => {
      // In most test environments, this should be true
      process.env.LC_ALL = "en_US.UTF-8";
      expect(supportsUnicode()).toBe(true);
    });

    it("should return false for ASCII-only locale", () => {
      process.env.LC_ALL = "C";
      expect(supportsUnicode()).toBe(false);
    });
  });

  describe("supportsEmoji", () => {
    it("should return true for iTerm2", () => {
      process.env.TERM_PROGRAM = "iTerm.app";
      expect(supportsEmoji()).toBe(true);
    });

    it("should return true for Windows Terminal", () => {
      process.env.WT_SESSION = "session-id";
      delete process.env.TERM_PROGRAM;
      expect(supportsEmoji()).toBe(true);
    });

    it("should return true for Kitty", () => {
      process.env.TERM = "xterm-kitty";
      delete process.env.TERM_PROGRAM;
      delete process.env.WT_SESSION;
      expect(supportsEmoji()).toBe(true);
    });

    it("should return false for generic terminals without emoji support", () => {
      process.env.TERM = "xterm";
      delete process.env.TERM_PROGRAM;
      delete process.env.WT_SESSION;
      delete process.env.COLORTERM;
      expect(supportsEmoji()).toBe(false);
    });
  });

  describe("getTerminalWidth", () => {
    it("should return a positive number", () => {
      const width = getTerminalWidth();
      expect(width).toBeGreaterThan(0);
    });

    it("should return default width when no TTY", () => {
      // Mock stdout.columns to be undefined
      const originalColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: undefined,
        configurable: true,
      });

      const width = getTerminalWidth();
      expect(width).toBe(80); // Default width

      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        configurable: true,
      });
    });

    it("should return stdout.columns when available", () => {
      const originalColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: 120,
        configurable: true,
      });

      const width = getTerminalWidth();
      expect(width).toBe(120);

      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        configurable: true,
      });
    });
  });

  describe("isScreenReader", () => {
    it("should return true when NO_COLOR is set", () => {
      process.env.NO_COLOR = "1";
      expect(isScreenReader()).toBe(true);
    });

    it("should return true when TERM=dumb", () => {
      process.env.TERM = "dumb";
      delete process.env.NO_COLOR;
      expect(isScreenReader()).toBe(true);
    });

    it("should return false for normal terminals", () => {
      delete process.env.NO_COLOR;
      process.env.TERM = "xterm-256color";
      expect(isScreenReader()).toBe(false);
    });
  });
});
