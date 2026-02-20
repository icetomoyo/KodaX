/**
 * SessionHistory Component Tests
 *
 * Tests the utility functions and logic for displaying session history.
 */

import { describe, it, expect } from "vitest";

/**
 * Truncates text to a maximum length with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Extracts string content from various message content types
 */
function extractContent(content: string | unknown[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    // Extract text from content blocks
    return content
      .filter((block): block is { type: string; text: string } =>
        block && typeof block === "object" && block.type === "text"
      )
      .map((block) => block.text)
      .join("");
  }
  return "[复杂内容]";
}

/**
 * Formats a single message for display
 */
function formatMessage(
  message: { role: string; content: string | unknown[] },
  maxLength: number
): { role: string; content: string } {
  const contentStr = extractContent(message.content);
  return {
    role: message.role,
    content: truncateText(contentStr, maxLength),
  };
}

/**
 * Gets the last N messages for display
 */
function getRecentMessages(
  messages: Array<{ role: string; content: string | unknown[] }>,
  maxDisplay: number
): Array<{ role: string; content: string | unknown[] }> {
  return messages.slice(-maxDisplay);
}

describe("SessionHistory Utilities", () => {
  describe("truncateText", () => {
    it("should return text as-is if under max length", () => {
      expect(truncateText("Hello", 100)).toBe("Hello");
    });

    it("should truncate and add ellipsis if over max length", () => {
      const longText = "A".repeat(100);
      const result = truncateText(longText, 50);
      expect(result.length).toBe(50);
      expect(result.endsWith("...")).toBe(true);
    });

    it("should handle empty string", () => {
      expect(truncateText("", 50)).toBe("");
    });

    it("should handle text exactly at max length", () => {
      const text = "A".repeat(50);
      expect(truncateText(text, 50)).toBe(text);
    });

    it("should handle text one char over max length", () => {
      const text = "A".repeat(51);
      const result = truncateText(text, 50);
      expect(result.length).toBe(50);
      expect(result.endsWith("...")).toBe(true);
    });
  });

  describe("extractContent", () => {
    it("should return string content as-is", () => {
      expect(extractContent("Hello world")).toBe("Hello world");
    });

    it("should extract text from content blocks", () => {
      const content = [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ];
      expect(extractContent(content)).toBe("Hello world");
    });

    it("should ignore non-text blocks", () => {
      const content = [
        { type: "text", text: "Hello" },
        { type: "tool_use", name: "read" },
        { type: "text", text: " world" },
      ];
      expect(extractContent(content)).toBe("Hello world");
    });

    it("should return placeholder for unknown types", () => {
      expect(extractContent(123 as unknown[])).toBe("[复杂内容]");
    });
  });

  describe("formatMessage", () => {
    it("should format user message with string content", () => {
      const message = { role: "user", content: "Hello" };
      const result = formatMessage(message, 100);
      expect(result).toEqual({ role: "user", content: "Hello" });
    });

    it("should format assistant message with content blocks", () => {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      };
      const result = formatMessage(message, 100);
      expect(result).toEqual({ role: "assistant", content: "Hi there!" });
    });

    it("should truncate long messages", () => {
      const message = { role: "user", content: "A".repeat(200) };
      const result = formatMessage(message, 50);
      expect(result.content.length).toBe(50);
      expect(result.content.endsWith("...")).toBe(true);
    });
  });

  describe("getRecentMessages", () => {
    it("should return all messages if under max", () => {
      const messages = [
        { role: "user", content: "A" },
        { role: "assistant", content: "B" },
      ];
      const result = getRecentMessages(messages, 5);
      expect(result.length).toBe(2);
    });

    it("should return last N messages", () => {
      const messages = [
        { role: "user", content: "1" },
        { role: "assistant", content: "2" },
        { role: "user", content: "3" },
        { role: "assistant", content: "4" },
        { role: "user", content: "5" },
      ];
      const result = getRecentMessages(messages, 3);
      expect(result.length).toBe(3);
      expect(result[0]).toEqual({ role: "user", content: "3" });
      expect(result[2]).toEqual({ role: "user", content: "5" });
    });

    it("should handle empty messages", () => {
      const result = getRecentMessages([], 5);
      expect(result.length).toBe(0);
    });
  });
});
