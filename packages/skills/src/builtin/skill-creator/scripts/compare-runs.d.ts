export interface CompareWorkspaceOptions {
  workspaceDir: string;
  configA?: string;
  configB?: string;
  outputPath?: string;
  markdownPath?: string;
  provider?: string;
  model?: string;
  reasoningMode?: string;
  maxIter?: number;
  maxPairs?: number;
  cwd?: string;
}

export function buildComparisonPrompt(input: Record<string, unknown>): string;

export interface ComparisonSummary {
  total_pairs: number;
  config_a_wins: number;
  config_b_wins: number;
  ties: number;
  inconclusive: number;
}

export interface ComparisonEntry {
  index: number;
  eval_id: string | number | null;
  eval_name: string | null;
  run_a: string;
  run_b: string;
  presented_as: {
    A: string;
    B: string;
  };
  winner_label: 'A' | 'B' | 'tie' | 'inconclusive';
  winner_config: string;
  confidence: number;
  rationale: string;
  strengths_a: string[];
  strengths_b: string[];
  risks: string[];
}

export interface ComparisonDocument {
  workspace: string;
  generated_at: string;
  config_a: string;
  config_b: string;
  summary: ComparisonSummary;
  comparisons: ComparisonEntry[];
}

export function renderComparisonMarkdown(document: ComparisonDocument): string;

export function compareWorkspace(
  options: CompareWorkspaceOptions,
  runner?: (prompt: string, options: Record<string, unknown>) => Promise<string>
): Promise<{
  document: ComparisonDocument;
  outputPath: string;
  markdownPath: string;
}>;
