export interface GradeWorkspaceOptions {
  workspaceDir: string;
  provider?: string;
  model?: string;
  reasoningMode?: string;
  maxIter?: number;
  cwd?: string;
  overwrite?: boolean;
  configs?: string[];
}

export interface GradedExpectation {
  text: string;
  passed: boolean;
  evidence: string;
}

export interface GradingDocument {
  summary: {
    passed: number;
    failed: number;
    total: number;
    pass_rate: number;
  };
  expectations: GradedExpectation[];
  execution_metrics: {
    total_tool_calls: number;
    errors_encountered: number;
    output_chars: number;
  };
  user_notes_summary: {
    uncertainties: string[];
    needs_review: string[];
    workarounds: string[];
  };
  overall_summary: string;
  timing: {
    total_tokens: number;
    total_duration_seconds: number;
  };
  meta: {
    generated_at: string;
    eval_id: string | number | null;
    eval_name: string | null;
    config: string;
    run_id: string;
  };
}

export function buildGradingPrompt(input: Record<string, unknown>): string;

export function gradeRun(
  runDir: string,
  options: GradeWorkspaceOptions,
  runner?: (prompt: string, options: Record<string, unknown>) => Promise<string>
): Promise<{
  runDir: string;
  grading: GradingDocument;
  prompt: string;
  rawResponse: string;
}>;

export function gradeWorkspace(
  options: GradeWorkspaceOptions,
  runner?: (prompt: string, options: Record<string, unknown>) => Promise<string>
): Promise<{
  workspace: string;
  generated_at: string;
  processed: number;
  skipped: number;
  processed_runs: Array<Record<string, unknown>>;
  skipped_runs: string[];
}>;
