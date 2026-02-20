/**
 * History Navigation Tests
 *
 * Tests for connected history navigation in multiline input.
 * Behavior:
 * - Up arrow at first line → load previous history
 * - Down arrow at last line end → load next history
 * - Otherwise, move cursor within multiline input
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TextBuffer } from "../src/ui/utils/text-buffer.js";

/**
 * Simulates the navigation decision logic
 * Returns: 'history-up' | 'history-down' | 'cursor-up' | 'cursor-down'
 */
function decideNavigationAction(
  direction: "up" | "down",
  cursorRow: number,
  cursorCol: number,
  lineCount: number,
  currentLineLength: number
): string {
  if (direction === "up") {
    // At first line → load previous history
    if (cursorRow === 0) {
      return "history-up";
    }
    return "cursor-up";
  }

  if (direction === "down") {
    const isLastLine = cursorRow === lineCount - 1;
    const isAtEnd = cursorCol >= currentLineLength;

    // At last line AND at end → load next history
    if (isLastLine && isAtEnd) {
      return "history-down";
    }
    return "cursor-down";
  }

  return `cursor-${direction}`;
}

describe("History Navigation Decision Logic", () => {
  describe("Up Arrow Navigation", () => {
    it("should load previous history when at first line (any column)", () => {
      // Single line, cursor at start
      expect(decideNavigationAction("up", 0, 0, 1, 0)).toBe("history-up");

      // Single line, cursor in middle
      expect(decideNavigationAction("up", 0, 5, 1, 10)).toBe("history-up");

      // Single line, cursor at end
      expect(decideNavigationAction("up", 0, 10, 1, 10)).toBe("history-up");

      // Multi-line, cursor at first line
      expect(decideNavigationAction("up", 0, 3, 3, 5)).toBe("history-up");
    });

    it("should move cursor up when not at first line", () => {
      // Second line of 3 lines
      expect(decideNavigationAction("up", 1, 0, 3, 5)).toBe("cursor-up");

      // Last line of 3 lines
      expect(decideNavigationAction("up", 2, 0, 3, 5)).toBe("cursor-up");
    });
  });

  describe("Down Arrow Navigation", () => {
    it("should load next history when at last line AND at end", () => {
      // Single line, cursor at end
      expect(decideNavigationAction("down", 0, 10, 1, 10)).toBe("history-down");

      // Single line, cursor past end (shouldn't happen but be safe)
      expect(decideNavigationAction("down", 0, 15, 1, 10)).toBe("history-down");

      // Multi-line, cursor at last line end
      expect(decideNavigationAction("down", 2, 5, 3, 5)).toBe("history-down");
    });

    it("should move cursor down when not at last line end", () => {
      // Single line, cursor not at end
      expect(decideNavigationAction("down", 0, 5, 1, 10)).toBe("cursor-down");

      // Multi-line, cursor at first line
      expect(decideNavigationAction("down", 0, 0, 3, 5)).toBe("cursor-down");

      // Multi-line, cursor at second line
      expect(decideNavigationAction("down", 1, 0, 3, 5)).toBe("cursor-down");

      // Last line, cursor not at end
      expect(decideNavigationAction("down", 2, 3, 3, 5)).toBe("cursor-down");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty input", () => {
      // Empty single line
      expect(decideNavigationAction("up", 0, 0, 1, 0)).toBe("history-up");
      expect(decideNavigationAction("down", 0, 0, 1, 0)).toBe("history-down");
    });

    it("should handle single character input", () => {
      expect(decideNavigationAction("up", 0, 0, 1, 1)).toBe("history-up");
      expect(decideNavigationAction("down", 0, 1, 1, 1)).toBe("history-down");
      expect(decideNavigationAction("down", 0, 0, 1, 1)).toBe("cursor-down");
    });
  });
});

describe("TextBuffer History Integration", () => {
  let buffer: TextBuffer;

  beforeEach(() => {
    buffer = new TextBuffer();
  });

  it("should correctly report line count for single line", () => {
    buffer.setText("Hello");
    expect(buffer.lineCount).toBe(1);
  });

  it("should correctly report line count for multiple lines", () => {
    buffer.setText("Line1\nLine2\nLine3");
    expect(buffer.lineCount).toBe(3);
  });

  it("should correctly report cursor position after setText", () => {
    buffer.setText("Hello");
    // setText keeps cursor at start (0, 0)
    expect(buffer.cursor).toEqual({ row: 0, col: 0 });
  });

  it("should move cursor to end of line", () => {
    buffer.setText("Hello");
    buffer.move("end");
    expect(buffer.cursor.col).toBe(5); // "Hello" length
  });

  it("should correctly navigate multi-line text", () => {
    buffer.setText("Line1\nLine2\nLine3");
    // setText keeps cursor at start
    expect(buffer.cursor.row).toBe(0);
    expect(buffer.cursor.col).toBe(0);

    // Move to end
    buffer.move("end"); // End of first line
    expect(buffer.cursor.col).toBe(5);

    // Move down to second line
    buffer.move("down");
    expect(buffer.cursor.row).toBe(1);

    // Move down to third line
    buffer.move("down");
    expect(buffer.cursor.row).toBe(2);

    // Move up
    buffer.move("up");
    expect(buffer.cursor.row).toBe(1);

    // Move up again
    buffer.move("up");
    expect(buffer.cursor.row).toBe(0);

    // Cannot move up from first line (stays at first line)
    buffer.move("up");
    expect(buffer.cursor.row).toBe(0);
  });
});
