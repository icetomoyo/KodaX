import { describe, expect, it } from "vitest";
import type { ProjectFeature } from "./project-state.js";
import {
  buildProjectQualityReport,
  formatProjectQualityReport,
} from "./project-quality.js";

function makeFeature(overrides: Partial<ProjectFeature> = {}): ProjectFeature {
  return {
    description: "Feature",
    ...overrides,
  };
}

describe("project-quality", () => {
  it("builds a pending report when no feature work exists", () => {
    const report = buildProjectQualityReport([]);

    expect(report.metrics.totalFeatures).toBe(0);
    expect(report.metrics.pendingFeatures).toBe(0);
    expect(report.phases.coding.status).toBe("pending");
    expect(report.phases.review.status).toBe("pending");
    expect(report.phases.test.status).toBe("pending");
    expect(report.phases.deploy.status).toBe("pending");
    expect(report.overallScore).toBeGreaterThanOrEqual(15);
  });

  it("detects review, test, and deploy signals from progress artifacts", () => {
    const report = buildProjectQualityReport(
      [
        makeFeature({ description: "Core API", passes: true, startedAt: "2026-03-17T08:00:00.000Z" }),
        makeFeature({ description: "CLI polish", startedAt: "2026-03-17T09:00:00.000Z" }),
      ],
      "Completed code review and added vitest coverage before release.",
      "Next: deploy after final review.",
    );

    expect(report.phases.coding.status).toBe("completed");
    expect(report.phases.review.status).toBe("in_progress");
    expect(report.phases.test.status).toBe("in_progress");
    expect(report.phases.deploy.status).toBe("in_progress");
    expect(report.issues.some((issue) => issue.title === "No test evidence recorded")).toBe(false);
  });

  it("surfaces blocking and missing-test issues when work is underway", () => {
    const report = buildProjectQualityReport(
      [
        makeFeature({ description: "Streaming queue", startedAt: "2026-03-17T08:00:00.000Z" }),
        makeFeature({ description: "History restore", skipped: true }),
      ],
      "We are currently blocked by an API mismatch risk.",
      "",
    );

    expect(report.phases.coding.status).toBe("blocked");
    expect(report.phases.review.status).toBe("pending");
    expect(report.phases.test.status).toBe("pending");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "No test evidence recorded", severity: "high" }),
        expect.objectContaining({ title: "Blocking signals detected", severity: "high" }),
        expect.objectContaining({ title: "Skipped features present", severity: "low" }),
      ]),
    );
  });

  it("formats a readable report with metrics and issues", () => {
    const report = buildProjectQualityReport(
      [makeFeature({ description: "Project workflow", passes: true, startedAt: "2026-03-17T08:00:00.000Z" })],
      "review done, tests passed",
      "",
    );

    const text = formatProjectQualityReport(report);

    expect(text).toContain("## Project Quality Report");
    expect(text).toContain("| coding | Completed |");
    expect(text).toContain("### Metrics");
    expect(text).toContain("- Features: 1/1 completed (100%)");
    expect(text).toContain("### Issues");
  });
});
