/** One observed first response: `skill:<name>` for Skill calls, the tool name otherwise. */
export interface TriggerEvalAttempt {
  trigger: boolean;
  tool_calls: string[];
}

export interface ObservedToolCall {
  tool: string;
  input: Record<string, unknown>;
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
    evaluation_kind: 'observed_skill_call';
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
  reasoningMode?: string;
  descriptionOverride?: string;
}

export function scoreFirstTurn(calls: ObservedToolCall[], skillName: string): TriggerEvalAttempt;
export function summarizeTriggerResults(results: TriggerEvalItemResult[]): TriggerEvalSummary;
export function runTriggerEval(
  options: TriggerEvalOptions,
  observe?: (query: string, options: TriggerEvalOptions & { projectRoot: string }) => Promise<ObservedToolCall[]>
): Promise<TriggerEvalReport>;
