export interface BenchmarkRun {
  eval_id: string | number;
  run_id: string;
  pass_rate: number;
  passed: number;
  failed: number;
  total: number;
  time_seconds: number;
  tokens: number;
  tool_calls: number;
  errors: number;
  expectations: Array<Record<string, unknown>>;
  notes: string[];
}

export interface StatsSummary {
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export interface BenchmarkDocument {
  skill_name: string;
  generated_at: string;
  workspace: string;
  configs: Record<string, {
    pass_rate: StatsSummary;
    time_seconds: StatsSummary;
    tokens: StatsSummary;
  }>;
  delta: {
    pass_rate: string;
    time_seconds: string;
    tokens: string;
  };
  runs: Record<string, BenchmarkRun[]>;
}

export function loadRunResults(iterationDir: string): Promise<Record<string, BenchmarkRun[]>>;
export function buildBenchmarkDocument(
  iterationDir: string,
  skillName: string,
  configRuns: Record<string, BenchmarkRun[]>
): BenchmarkDocument;
export function renderBenchmarkMarkdown(benchmark: BenchmarkDocument): string;
