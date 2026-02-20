/**
 * LoadingIndicator Tests
 *
 * Tests for the loading and thinking indicators.
 * Following Gemini CLI's loading display architecture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import {
  LoadingIndicator,
  ThinkingIndicator,
  Spinner,
  DotsIndicator,
  ProgressIndicator,
} from "../../src/ui/components/LoadingIndicator.js";

// === Tests ===

describe("Spinner", () => {
  it("should render spinner frame", () => {
    const { lastFrame } = render(<Spinner />);

    expect(lastFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it("should render with custom color", () => {
    const { lastFrame } = render(<Spinner color="green" />);

    expect(lastFrame()).toBeDefined();
  });
});

describe("DotsIndicator", () => {
  it("should render dots", () => {
    const { lastFrame } = render(<DotsIndicator />);

    expect(lastFrame()).toMatch(/\.+/);
  });

  it("should render with label", () => {
    const { lastFrame } = render(<DotsIndicator label="Loading" />);

    expect(lastFrame()).toContain("Loading");
  });

  it("should render with custom dot count", () => {
    const { lastFrame } = render(<DotsIndicator dotCount={5} />);

    expect(lastFrame()).toBeDefined();
  });
});

describe("ProgressIndicator", () => {
  it("should render progress bar", () => {
    const { lastFrame } = render(<ProgressIndicator progress={50} />);

    expect(lastFrame()).toContain("50%");
  });

  it("should render with label", () => {
    const { lastFrame } = render(<ProgressIndicator progress={30} label="Processing" />);

    expect(lastFrame()).toContain("Processing");
    expect(lastFrame()).toContain("30%");
  });

  it("should handle 0% progress", () => {
    const { lastFrame } = render(<ProgressIndicator progress={0} />);

    expect(lastFrame()).toContain("0%");
  });

  it("should handle 100% progress", () => {
    const { lastFrame } = render(<ProgressIndicator progress={100} />);

    expect(lastFrame()).toContain("100%");
  });

  it("should clamp negative progress", () => {
    const { lastFrame } = render(<ProgressIndicator progress={-50} />);

    expect(lastFrame()).toContain("0%");
  });

  it("should clamp progress > 100", () => {
    const { lastFrame } = render(<ProgressIndicator progress={150} />);

    expect(lastFrame()).toContain("100%");
  });
});

describe("ThinkingIndicator", () => {
  it("should render thinking text", () => {
    const { lastFrame } = render(<ThinkingIndicator />);

    expect(lastFrame()).toMatch(/Thinking|…/);
  });

  it("should render with custom message", () => {
    const { lastFrame } = render(<ThinkingIndicator message="Processing your request" />);

    expect(lastFrame()).toContain("Processing your request");
  });

  it("should render with spinner", () => {
    const { lastFrame } = render(<ThinkingIndicator showSpinner />);

    expect(lastFrame()).toBeDefined();
  });
});

describe("LoadingIndicator", () => {
  it("should render default loading state", () => {
    const { lastFrame } = render(<LoadingIndicator />);

    expect(lastFrame()).toMatch(/Loading|…/);
  });

  it("should render with custom message", () => {
    const { lastFrame } = render(<LoadingIndicator message="Please wait" />);

    expect(lastFrame()).toContain("Please wait");
  });

  it("should render with progress", () => {
    const { lastFrame } = render(<LoadingIndicator progress={75} />);

    expect(lastFrame()).toContain("75%");
  });

  it("should render with spinner type", () => {
    const { lastFrame } = render(<LoadingIndicator type="spinner" />);

    expect(lastFrame()).toBeDefined();
  });

  it("should render with dots type", () => {
    const { lastFrame } = render(<LoadingIndicator type="dots" />);

    expect(lastFrame()).toBeDefined();
  });

  it("should render with bar type", () => {
    const { lastFrame } = render(<LoadingIndicator type="bar" progress={50} />);

    expect(lastFrame()).toContain("50%");
  });

  it("should render with sub-message", () => {
    const { lastFrame } = render(
      <LoadingIndicator message="Loading" subMessage="This may take a moment" />
    );

    expect(lastFrame()).toContain("Loading");
    expect(lastFrame()).toContain("This may take a moment");
  });

  it("should render compact mode", () => {
    const { lastFrame } = render(<LoadingIndicator compact />);

    expect(lastFrame()).toBeDefined();
  });
});
