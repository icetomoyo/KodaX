export interface AnalyzeBenchmarkOptions {
  workspaceDir: string;
  benchmarkPath?: string;
  outputPath?: string;
  markdownPath?: string;
  skillName?: string;
  provider?: string;
  model?: string;
  reasoningMode?: string;
  maxIter?: number;
  cwd?: string;
}

export interface BenchmarkAnalysis {
  skill_name: string;
  generated_at: string;
  workspace: string;
  verdict: 'improves' | 'regresses' | 'mixed' | 'inconclusive';
  release_readiness: 'ready' | 'needs_iteration' | 'needs_manual_review';
  recommendation: string;
  key_findings: string[];
  variance_hotspots: string[];
  suggested_actions: string[];
  watchouts: string[];
  supporting_metrics: {
    pass_rate_delta: string;
    time_seconds_delta: string;
    tokens_delta: string;
  };
  failure_clusters: Record<string, unknown>;
}

export function buildAnalysisPrompt(input: Record<string, unknown>): string;

export function renderAnalysisMarkdown(analysis: Record<string, any>): string;

export function analyzeBenchmark(
  options: AnalyzeBenchmarkOptions,
  runner?: (prompt: string, options: Record<string, unknown>) => Promise<string>
): Promise<{
  analysis: BenchmarkAnalysis;
  prompt: string;
  rawResponse: string;
  analysisJsonPath: string;
  analysisMdPath: string;
}>;
