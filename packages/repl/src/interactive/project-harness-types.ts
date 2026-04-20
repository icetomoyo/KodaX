/**
 * Shared type declarations for the project-harness subsystem.
 *
 * FEATURE_093 (v0.7.24): extracted from `project-harness.ts` to break the
 * `project-harness.ts ↔ project-harness-core.ts` cycle. Both the thin
 * facade (`project-harness.ts`) and the runtime implementation
 * (`project-harness-core.ts`) now import their data shapes from this file.
 */

export interface ProjectHarnessCheckConfig {
  id: string;
  command: string;
  required: boolean;
}

export interface ProjectHarnessRuleSources {
  projectAgents: string[];
  architectureDocs: string[];
  adrDocs: string[];
  scriptSources: string[];
  excludedControlPlane: string[];
}

export interface ProjectHarnessInvariantConfig {
  requireTestEvidenceOnComplete: boolean;
  requireDocUpdateOnArchitectureChange: boolean;
  enforcePackageBoundaryImports: boolean;
  requireDeclaredWorkspaceDependencies: boolean;
  requireFeatureChecklistCoverageOnComplete: boolean;
  requireSessionPlanChecklistCoverage: boolean;
  checklistCoverageMinimum: number;
  packageLayerOrder?: string[];
  sourceNotes: string[];
}

export interface ProjectHarnessExceptionConfig {
  allowedImportSpecifiers: string[];
  skipChecklistFeaturePatterns: string[];
}

export interface ProjectHarnessRepairPlaybookDefinition {
  id: string;
  actions: string[];
}

export interface ProjectHarnessRepairPolicyConfig {
  codeOverrides: Record<string, string[]>;
  customPlaybooks: ProjectHarnessRepairPlaybookDefinition[];
}

export interface ProjectHarnessConfig {
  version: 1;
  generatedAt: string;
  protectedArtifacts: string[];
  checks: ProjectHarnessCheckConfig[];
  ruleSources?: ProjectHarnessRuleSources;
  invariants?: ProjectHarnessInvariantConfig;
  exceptions?: ProjectHarnessExceptionConfig;
  repairPolicy?: ProjectHarnessRepairPolicyConfig;
  generatedCheckIds?: string[];
  sourceFingerprint?: string;
  completionRules: {
    requireProgressUpdate: boolean;
    requireChecksPass: boolean;
    requireCompletionReport: boolean;
  };
  advisoryRules: {
    warnOnLargeUnrelatedDiff: boolean;
    warnOnRepeatedFailure: boolean;
  };
}

export interface ProjectHarnessViolation {
  rule: string;
  severity: 'warn' | 'high';
  evidence: string;
}

export interface ProjectHarnessCheckResult {
  id: string;
  command: string;
  required: boolean;
  passed: boolean;
  output: string;
}

export interface ProjectHarnessScorecard {
  legality: number;
  checks: number;
  featureRelevance: number;
  evidenceCompleteness: number;
  qualityDelta: number;
  stallResistance: number;
  costEfficiency: number;
  overall: number;
}

export interface ProjectHarnessCriticRecord {
  runId: string;
  featureIndex: number;
  decision: ProjectHarnessVerificationResult['decision'];
  failureCodes: string[];
  scorecard?: ProjectHarnessScorecard;
  repairPlaybooks: string[];
  summary: string;
  repairHints: string[];
  createdAt: string;
}

export interface ProjectHarnessCompletionReport {
  status: 'complete' | 'needs_review' | 'blocked';
  summary: string;
  evidence?: string[];
  tests?: string[];
  changedFiles?: string[];
  blockers?: string[];
}

export interface ProjectHarnessRunRecord {
  runId: string;
  featureIndex: number;
  mode: 'next' | 'auto' | 'verify' | 'manual';
  attempt: number;
  decision: 'verified_complete' | 'retryable_failure' | 'needs_review' | 'blocked';
  failureCodes?: string[];
  scorecard?: ProjectHarnessScorecard;
  changedFiles: string[];
  checks: ProjectHarnessCheckResult[];
  qualityBefore: number;
  qualityAfter: number;
  violations: ProjectHarnessViolation[];
  repairHints: string[];
  evidence: string[];
  completionReport: ProjectHarnessCompletionReport | null;
  createdAt: string;
}

export interface ProjectHarnessCheckpointRecord {
  id?: string;
  checkpointId: string;
  runId: string;
  featureIndex: number;
  taskId?: string;
  decision: ProjectHarnessRunRecord['decision'];
  gitHead: string | null;
  gitStatus: string[];
  changedFiles: string[];
  qualityAfter: number;
  createdAt: string;
}

export interface ProjectHarnessSessionNodeRecord {
  id?: string;
  nodeId: string;
  taskId?: string;
  runId: string;
  parentId?: string | null;
  parentNodeId: string | null;
  parentRunId: string | null;
  featureIndex: number;
  decision: ProjectHarnessRunRecord['decision'];
  checkpointId: string | null;
  scorecard?: ProjectHarnessScorecard;
  summary?: string;
  createdAt: string;
}

export interface ProjectHarnessEvidenceRecord {
  featureIndex: number;
  status: 'verified_complete' | 'retryable_failure' | 'needs_review' | 'blocked' | 'manual_override';
  changedFiles: string[];
  progressUpdated: boolean;
  checksPassed: boolean;
  qualityDelta: number;
  completionSource: 'auto_verified' | 'verification_failed' | 'manual_override';
  evidenceItems?: string[];
  reportedTests?: string[];
  completionSummary?: string;
  updatedAt: string;
}

export type ProjectHarnessCalibrationLabel = 'false_pass' | 'false_fail';

export interface ProjectHarnessCalibrationCaseRecord {
  id?: string;
  caseId: string;
  runId: string;
  featureIndex: number;
  label: ProjectHarnessCalibrationLabel;
  observedDecision: ProjectHarnessRunRecord['decision'];
  expectedDecision: ProjectHarnessRunRecord['decision'];
  checkpointId: string | null;
  failureCodes: string[];
  summary: string;
  createdAt: string;
}

export interface ProjectHarnessPivotRecord {
  id?: string;
  pivotId: string;
  featureIndex: number;
  fromRunId: string;
  fromCheckpointId: string | null;
  evidenceFeatureIndex: number;
  decision: ProjectHarnessRunRecord['decision'];
  failureCodes: string[];
  reason: string;
  summary: string;
  createdAt: string;
}

export interface ProjectHarnessProfileCount {
  name: string;
  count: number;
}

export interface ProjectHarnessProfileDimension {
  name: Exclude<keyof ProjectHarnessScorecard, 'overall'>;
  score: number;
}

export interface ProjectHarnessProfileSnapshot {
  featureIndex?: number;
  totalRuns: number;
  decisions: Record<ProjectHarnessRunRecord['decision'], number>;
  calibrationCases: number;
  falsePassCases: number;
  falseFailCases: number;
  pivotCount: number;
  checkpointCount: number;
  latestRunId: string | null;
  latestCheckpointId: string | null;
  latestPivotId: string | null;
  averageScorecard: ProjectHarnessScorecard | null;
  weakestDimensions: ProjectHarnessProfileDimension[];
  recurringFailureCodes: ProjectHarnessProfileCount[];
  recurringRepairPlaybooks: ProjectHarnessProfileCount[];
}

export interface ProjectHarnessVerificationResult {
  decision: 'verified_complete' | 'retryable_failure' | 'needs_review' | 'blocked';
  reasons: string[];
  repairPrompt?: string;
  runRecord: ProjectHarnessRunRecord;
  evidenceRecord: ProjectHarnessEvidenceRecord;
}
