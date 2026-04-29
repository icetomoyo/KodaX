import { describe, it, expect } from "vitest";
import {
  CURSOR_HOME,
  CURSOR_LEFT,
  cursorBack,
  cursorDown,
  cursorForward,
  cursorMove,
  cursorTo,
  cursorUp,
  ERASE_LINE,
  eraseLines,
  RESET_SCROLL_REGION,
} from "./csi.js";

describe("substrate/ink/csi (FEATURE_057 Track F Phase 1)", () => {
  describe("cursor movement primitives", () => {
    it("returns empty string when n is 0 (no-op moves cost zero bytes)", () => {
      expect(cursorUp(0)).toBe("");
      expect(cursorDown(0)).toBe("");
      expect(cursorForward(0)).toBe("");
      expect(cursorBack(0)).toBe("");
    });

    it("emits CSI n A/B/C/D for non-zero counts", () => {
      expect(cursorUp(3)).toBe("\x1b[3A");
      expect(cursorDown(2)).toBe("\x1b[2B");
      expect(cursorForward(5)).toBe("\x1b[5C");
      expect(cursorBack(7)).toBe("\x1b[7D");
    });

    it("defaults n to 1", () => {
      expect(cursorUp()).toBe("\x1b[1A");
      expect(cursorDown()).toBe("\x1b[1B");
      expect(cursorForward()).toBe("\x1b[1C");
      expect(cursorBack()).toBe("\x1b[1D");
    });
  });

  describe("cursorTo / CURSOR_LEFT / CURSOR_HOME", () => {
    it("cursorTo emits CSI col G (1-indexed)", () => {
      expect(cursorTo(1)).toBe("\x1b[1G");
      expect(cursorTo(80)).toBe("\x1b[80G");
    });

    it("CURSOR_LEFT is the bareform CSI G (column 1)", () => {
      expect(CURSOR_LEFT).toBe("\x1b[G");
    });

    it("CURSOR_HOME is the bareform CSI H (row 1, col 1)", () => {
      expect(CURSOR_HOME).toBe("\x1b[H");
    });
  });

  describe("cursorMove (relative)", () => {
    it("emits horizontal-then-vertical, matching ansi-escapes ordering", () => {
      expect(cursorMove(3, -2)).toBe("\x1b[3C\x1b[2A");
      expect(cursorMove(-3, 2)).toBe("\x1b[3D\x1b[2B");
    });

    it("skips zero components", () => {
      expect(cursorMove(0, -2)).toBe("\x1b[2A");
      expect(cursorMove(3, 0)).toBe("\x1b[3C");
      expect(cursorMove(0, 0)).toBe("");
    });
  });

  describe("eraseLines", () => {
    it("returns empty string for n <= 0", () => {
      expect(eraseLines(0)).toBe("");
      expect(eraseLines(-1)).toBe("");
    });

    it("emits ERASE_LINE once + CURSOR_LEFT for n=1", () => {
      expect(eraseLines(1)).toBe(ERASE_LINE + CURSOR_LEFT);
    });

    it("emits ERASE_LINE then cursorUp(1) interleaved + final CURSOR_LEFT for n>1", () => {
      const result = eraseLines(3);
      expect(result).toBe(
        ERASE_LINE + "\x1b[1A" +
        ERASE_LINE + "\x1b[1A" +
        ERASE_LINE + CURSOR_LEFT,
      );
    });
  });

  describe("scroll region reset", () => {
    it("RESET_SCROLL_REGION is bareform CSI r", () => {
      expect(RESET_SCROLL_REGION).toBe("\x1b[r");
    });
  });
});
