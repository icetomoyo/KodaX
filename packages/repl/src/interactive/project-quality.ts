import type { ProjectFeature } from "./project-state.js";

export type ProjectQualityPhaseStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked";

export interface ProjectQualityPhase {
  name: "coding" | "review" | "test" | "deploy";
  status: ProjectQualityPhaseStatus;
  score?: number;
  details: string;
}

export interface ProjectQualityIssue {
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
}

export interface ProjectQualityMetrics {
  totalFeatures: number;
  completedFeatures: number;
  pendingFeatures: number;
  skippedFeatures: number;
  completionPercent: number;
  startedFeatures: number;
}

export interface ProjectQualityReport {
  phases: {
    coding: ProjectQualityPhase;
    review: ProjectQualityPhase;
    test: ProjectQualityPhase;
    deploy: ProjectQualityPhase;
  };
  overallScore: number;
  issues: ProjectQualityIssue[];
  metrics: ProjectQualityMetrics;
}

interface PhaseSignals {
  reviewMentioned: boolean;
  testMentioned: boolean;
  deployMentioned: boolean;
  blockedMentioned: boolean;
}

function normalizeText(text: string): string {
  return text.toLowerCase();
}

function hasAnyKeyword(text: string, keywords: readonly string[]): boolean {
  const normalized = normalizeText(text);
  return keywords.some((keyword) => normalized.includes(keyword));
}

function collectPhaseSignals(progressText: string, sessionPlan: string): PhaseSignals {
  const combined = `${progressText}\n${sessionPlan}`;
  return {
    reviewMentioned: hasAnyKeyword(combined, [
      "review",
      "code review",
      "审查",
      "reviewed",
    ]),
    testMentioned: hasAnyKeyword(combined, [
      "test",
      "coverage",
      "vitest",
      "pytest",
      "测试",
    ]),
    deployMentioned: hasAnyKeyword(combined, [
      "deploy",
      "release",
      "ship",
      "上线",
      "发布",
    ]),
    blockedMentioned: hasAnyKeyword(combined, [
      "blocked",
      "blocker",
      "stuck",
      "risk",
      "阻塞",
      "卡住",
    ]),
  };
}

function scorePhase(status: ProjectQualityPhaseStatus, baseScore: number): number | undefined {
  switch (status) {
    case "completed":
      return Math.min(100, baseScore);
    case "in_progress":
      return Math.min(95, Math.max(55, baseScore - 10));
    case "blocked":
      return Math.max(25, baseScore - 35);
    case "pending":
    default:
      return undefined;
  }
}

function buildIssues(
  metrics: ProjectQualityMetrics,
  signals: PhaseSignals,
): ProjectQualityIssue[] {
  const issues: ProjectQualityIssue[] = [];

  if (metrics.pendingFeatures > 0 && !signals.reviewMentioned) {
    issues.push({
      severity: "medium",
      title: "Review phase has not started",
      detail: "Pending features remain, but the progress trail does not show any review evidence yet.",
    });
  }

  if (metrics.startedFeatures > 0 && !signals.testMentioned) {
    issues.push({
      severity: "high",
      title: "No test evidence recorded",
      detail: "Implementation has started, but no test or coverage signal was detected in progress logs.",
    });
  }

  if (signals.blockedMentioned) {
    issues.push({
      severity: "high",
      title: "Blocking signals detected",
      detail: "Progress notes mention blockers or risk, so the project may need manual intervention before the next phase.",
    });
  }

  if (metrics.skippedFeatures > 0) {
    issues.push({
      severity: "low",
      title: "Skipped features present",
      detail: `${metrics.skippedFeatures} feature(s) are currently skipped and may need re-triage before release.`,
    });
  }

  return issues;
}

export function buildProjectQualityReport(
  features: readonly ProjectFeature[],
  progressText = "",
  sessionPlan = "",
): ProjectQualityReport {
  const completedFeatures = features.filter((feature) => feature.passes === true).length;
  const skippedFeatures = features.filter((feature) => feature.skipped === true).length;
  const startedFeatures = features.filter((feature) => Boolean(feature.startedAt)).length;
  const totalFeatures = features.length;
  const pendingFeatures = Math.max(0, totalFeatures - completedFeatures - skippedFeatures);
  const completionPercent =
    totalFeatures === 0 ? 0 : Math.round((completedFeatures / totalFeatures) * 100);
  const metrics: ProjectQualityMetrics = {
    totalFeatures,
    completedFeatures,
    pendingFeatures,
    skippedFeatures,
    completionPercent,
    startedFeatures,
  };

  const signals = collectPhaseSignals(progressText, sessionPlan);
  const codingStatus: ProjectQualityPhaseStatus =
    startedFeatures > 0 || completedFeatures > 0 || progressText.trim()
      ? signals.blockedMentioned && pendingFeatures > 0
        ? "blocked"
        : completedFeatures > 0
          ? "completed"
          : "in_progress"
      : "pending";
  const reviewStatus: ProjectQualityPhaseStatus = signals.reviewMentioned
    ? pendingFeatures === 0 && completedFeatures > 0
      ? "completed"
      : signals.blockedMentioned
        ? "blocked"
        : "in_progress"
    : "pending";
  const testStatus: ProjectQualityPhaseStatus = signals.testMentioned
    ? pendingFeatures === 0
      ? "completed"
      : signals.blockedMentioned
        ? "blocked"
        : "in_progress"
    : "pending";
  const deployStatus: ProjectQualityPhaseStatus = signals.deployMentioned
    ? pendingFeatures === 0
      ? "completed"
      : "in_progress"
    : "pending";

  const phases = {
    coding: {
      name: "coding" as const,
      status: codingStatus,
      score: scorePhase(codingStatus, 68 + completionPercent / 3),
      details:
        completedFeatures > 0
          ? `${completedFeatures}/${totalFeatures} feature(s) completed with implementation evidence in the project log.`
          : startedFeatures > 0
            ? `${startedFeatures} feature(s) started; implementation is underway.`
            : "No coding progress has been recorded yet.",
    },
    review: {
      name: "review" as const,
      status: reviewStatus,
      score: scorePhase(reviewStatus, 62 + completionPercent / 4),
      details: signals.reviewMentioned
        ? "Progress notes mention review activity, so the review loop is active."
        : "No explicit review signal found in PROGRESS.md or session plan yet.",
    },
    test: {
      name: "test" as const,
      status: testStatus,
      score: scorePhase(testStatus, 58 + completionPercent / 5),
      details: signals.testMentioned
        ? "Testing or coverage signals were found in project progress artifacts."
        : "No explicit test execution or coverage evidence was detected yet.",
    },
    deploy: {
      name: "deploy" as const,
      status: deployStatus,
      score: scorePhase(deployStatus, 55 + completionPercent / 6),
      details: signals.deployMentioned
        ? "Deployment or release activity appears in the recorded workflow."
        : "No deployment evidence has been recorded yet.",
    },
  };

  const issues = buildIssues(metrics, signals);
  const scoredPhases = Object.values(phases)
    .map((phase) => phase.score)
    .filter((score): score is number => typeof score === "number");
  const averagePhaseScore =
    scoredPhases.length === 0
      ? 40
      : Math.round(scoredPhases.reduce((sum, score) => sum + score, 0) / scoredPhases.length);
  const overallScore = Math.max(15, averagePhaseScore - issues.filter((issue) => issue.severity === "high").length * 8);

  return {
    phases,
    overallScore,
    issues,
    metrics,
  };
}

function formatPhaseLabel(status: ProjectQualityPhaseStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "in_progress":
      return "In Progress";
    case "blocked":
      return "Blocked";
    case "pending":
    default:
      return "Pending";
  }
}

function formatIssueLine(issue: ProjectQualityIssue): string {
  return `- [${issue.severity.toUpperCase()}] ${issue.title}: ${issue.detail}`;
}

export function formatProjectQualityReport(report: ProjectQualityReport): string {
  const lines = [
    "## Project Quality Report",
    "",
    `Overall Score: ${report.overallScore}/100`,
    "",
    "| Phase | Status | Score | Details |",
    "|-------|--------|-------|---------|",
  ];

  for (const phase of Object.values(report.phases)) {
    lines.push(
      `| ${phase.name} | ${formatPhaseLabel(phase.status)} | ${phase.score ?? "-"} | ${phase.details} |`,
    );
  }

  lines.push("");
  lines.push("### Metrics");
  lines.push(`- Features: ${report.metrics.completedFeatures}/${report.metrics.totalFeatures} completed (${report.metrics.completionPercent}%)`);
  lines.push(`- Pending: ${report.metrics.pendingFeatures}`);
  lines.push(`- Skipped: ${report.metrics.skippedFeatures}`);
  lines.push(`- Started: ${report.metrics.startedFeatures}`);

  lines.push("");
  lines.push("### Issues");
  if (report.issues.length === 0) {
    lines.push("- No major workflow issues detected.");
  } else {
    for (const issue of report.issues) {
      lines.push(formatIssueLine(issue));
    }
  }

  return lines.join("\n");
}
