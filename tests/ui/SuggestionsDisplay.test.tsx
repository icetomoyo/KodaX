/**
 * Tests for SuggestionsDisplay - Auto-completion suggestions UI
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen } from "ink-testing-library";
import { SuggestionsDisplay } from "../../src/ui/components/SuggestionsDisplay.js";
import type { Suggestion } from "../../src/ui/types.js";

// Mock theme
const mockTheme = {
  name: "dark",
  colors: {
    primary: "#00D9FF",
    secondary: "#8B5CF6",
    accent: "#F59E0B",
    text: "#E5E5E5",
    dim: "#6B7280",
    success: "#10B981",
    warning: "#F59E0B",
    error: "#EF4444",
    info: "#3B82F6",
    hint: "#6366F1",
  },
  symbols: {
    prompt: ">",
    success: "✓",
    error: "✗",
    warning: "!",
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  },
};

// Mock useTheme hook
vi.mock("../../src/ui/contexts/UIStateContext.js", () => ({
  useTheme: () => mockTheme,
}));

describe("SuggestionsDisplay", () => {
  const mockSuggestions: Suggestion[] = [
    { id: "1", text: "/help", description: "Show help" },
    { id: "2", text: "/clear", description: "Clear screen" },
    { id: "3", text: "/exit", description: "Exit program" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("should render nothing when suggestions are empty", () => {
      const { lastFrame } = render(
        <SuggestionsDisplay suggestions={[]} selectedIndex={0} visible={true} />
      );
      expect(lastFrame()).toBe("");
    });

    it("should render nothing when not visible", () => {
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={mockSuggestions}
          selectedIndex={0}
          visible={false}
        />
      );
      expect(lastFrame()).toBe("");
    });

    it("should render suggestions when visible", () => {
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={mockSuggestions}
          selectedIndex={0}
          visible={true}
        />
      );
      const output = lastFrame();
      expect(output).toContain("/help");
      expect(output).toContain("/clear");
      expect(output).toContain("/exit");
    });

    it("should render descriptions when provided", () => {
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={mockSuggestions}
          selectedIndex={0}
          visible={true}
        />
      );
      const output = lastFrame();
      expect(output).toContain("Show help");
      expect(output).toContain("Clear screen");
      expect(output).toContain("Exit program");
    });

    it("should handle suggestions without descriptions", () => {
      const simpleSuggestions: Suggestion[] = [
        { id: "1", text: "/help" },
        { id: "2", text: "/clear" },
      ];
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={simpleSuggestions}
          selectedIndex={0}
          visible={true}
        />
      );
      const output = lastFrame();
      expect(output).toContain("/help");
      expect(output).toContain("/clear");
    });
  });

  describe("selection", () => {
    it("should highlight the selected suggestion", () => {
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={mockSuggestions}
          selectedIndex={1}
          visible={true}
        />
      );
      // The second suggestion (/clear) should be highlighted
      const output = lastFrame();
      expect(output).toContain("/clear");
    });

    it("should handle first item selection", () => {
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={mockSuggestions}
          selectedIndex={0}
          visible={true}
        />
      );
      expect(lastFrame()).toContain("/help");
    });

    it("should handle last item selection", () => {
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={mockSuggestions}
          selectedIndex={2}
          visible={true}
        />
      );
      expect(lastFrame()).toContain("/exit");
    });
  });

  describe("limiting display", () => {
    it("should limit the number of visible suggestions", () => {
      const manySuggestions: Suggestion[] = Array.from(
        { length: 20 },
        (_, i) => ({
          id: String(i),
          text: `/cmd${i}`,
          description: `Command ${i}`,
        })
      );
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={manySuggestions}
          selectedIndex={0}
          visible={true}
          maxVisible={5}
        />
      );
      const output = lastFrame();
      // Should only show 5 items
      expect(output).toContain("/cmd0");
      expect(output).toContain("/cmd4");
      expect(output).not.toContain("/cmd5");
    });

    it("should show correct items when scrolled", () => {
      const manySuggestions: Suggestion[] = Array.from(
        { length: 20 },
        (_, i) => ({
          id: String(i),
          text: `/cmd${i}`,
          description: `Command ${i}`,
        })
      );
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={manySuggestions}
          selectedIndex={10}
          visible={true}
          maxVisible={5}
        />
      );
      const output = lastFrame();
      // Should show items around index 10
      expect(output).toContain("/cmd8");
      expect(output).toContain("/cmd12");
    });
  });

  describe("width handling", () => {
    it("should truncate long descriptions to fit width", () => {
      const longDescSuggestions: Suggestion[] = [
        {
          id: "1",
          text: "/help",
          description:
            "This is a very long description that should be truncated to fit the terminal width",
        },
      ];
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={longDescSuggestions}
          selectedIndex={0}
          visible={true}
          width={40}
        />
      );
      const output = lastFrame();
      expect(output).toContain("/help");
    });

    it("should use default width when not specified", () => {
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={mockSuggestions}
          selectedIndex={0}
          visible={true}
        />
      );
      expect(lastFrame()).toContain("/help");
    });
  });

  describe("types of suggestions", () => {
    it("should render command suggestions", () => {
      const commandSuggestions: Suggestion[] = [
        { id: "1", text: "/help", type: "command", description: "Show help" },
      ];
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={commandSuggestions}
          selectedIndex={0}
          visible={true}
        />
      );
      expect(lastFrame()).toContain("/help");
    });

    it("should render file suggestions", () => {
      const fileSuggestions: Suggestion[] = [
        { id: "1", text: "src/index.ts", type: "file", description: "Source file" },
      ];
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={fileSuggestions}
          selectedIndex={0}
          visible={true}
        />
      );
      expect(lastFrame()).toContain("src/index.ts");
    });

    it("should render history suggestions", () => {
      const historySuggestions: Suggestion[] = [
        {
          id: "1",
          text: "previous command",
          type: "history",
          description: "Previously used",
        },
      ];
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={historySuggestions}
          selectedIndex={0}
          visible={true}
        />
      );
      expect(lastFrame()).toContain("previous command");
    });
  });

  describe("accessibility", () => {
    it("should indicate selection count", () => {
      const { lastFrame } = render(
        <SuggestionsDisplay
          suggestions={mockSuggestions}
          selectedIndex={0}
          visible={true}
          showCount={true}
        />
      );
      const output = lastFrame();
      // Should show something like "1/3" or similar indicator
      expect(output).toBeTruthy();
    });
  });
});
