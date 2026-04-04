import { describe, expect, it } from "vitest";
import {
  buildAmaSummaryViewModel,
  buildAmaWorkStripFromStatus,
} from "./ama-summary.js";

describe("ama-summary view model", () => {
  it("keeps AMA child fan-out in summary-only work strip text", () => {
    expect(buildAmaWorkStripFromStatus({
      agentMode: "ama",
      childFanoutClass: "finding-validation",
      childFanoutCount: 3,
    }, true)).toBe("Validating 3 findings");
  });

  it("derives the background task bar from managed status without exposing topology", () => {
    const viewModel = buildAmaSummaryViewModel({
      status: {
        agentMode: "ama",
        activeWorkerTitle: "Planner",
        phase: "worker",
        childFanoutClass: "module-triage",
        childFanoutCount: 2,
      },
      isLoading: true,
      agentMode: "ama",
    });

    expect(viewModel.workStripText).toBe("Scanning 2 modules");
    expect(viewModel.backgroundTask.items).toEqual([
      {
        id: "primary-worker",
        label: "Planner active",
        accent: true,
        selected: true,
      },
      {
        id: "parallel",
        label: "Scanning 2 modules",
      },
    ]);
  });
});
