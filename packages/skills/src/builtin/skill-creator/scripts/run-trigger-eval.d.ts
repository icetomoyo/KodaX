export interface TriggerEvalAttempt {
  trigger: boolean;
  reason: string;
}

export interface TriggerEvalItemResult {
  query: string;
  should_trigger: boolean;
  triggers: number;
  runs: number;
  trigger_rate: number;
  predicted_trigger: boolean;
  pass: boolean;
  attempts: TriggerEvalAttempt[];
}

export interface TriggerEvalSummary {
  passed: number;
  failed: number;
  total: number;
  pass_rate: number;
  precision: number;
  recall: number;
}

export interface TriggerEvalReport {
  skill_name: string;
  description: string;
  results: TriggerEvalItemResult[];
  summary: TriggerEvalSummary;
  meta: {
    provider?: string;
    model?: string | null;
    runs_per_query: number;
    trigger_threshold: number;
    note: string;
  };
}

export interface TriggerEvalOptions {
  skillPath: string;
  evalsPath: string;
  provider?: string;
  model?: string;
  output?: string;
  runsPerQuery?: number;
  triggerThreshold?: number;
  maxIter?: number;
  reasoningMode?: string;
  descriptionOverride?: string;
}

export function parseTriggerDecision(text: string): TriggerEvalAttempt;
export function summarizeTriggerResults(results: TriggerEvalItemResult[]): TriggerEvalSummary;
export function runTriggerEval(
  options: TriggerEvalOptions,
  runner?: (prompt: string, options: TriggerEvalOptions) => Promise<string>
): Promise<TriggerEvalReport>;
