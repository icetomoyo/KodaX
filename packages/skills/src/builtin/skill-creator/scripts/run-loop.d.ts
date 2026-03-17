import type { ImproveDescriptionOptions, ImproveDescriptionResult } from './improve-description.js';
import type { TriggerEvalOptions, TriggerEvalReport } from './run-trigger-eval.js';

export interface DescriptionLoopRecord {
  iteration: number;
  description: string;
  score: string;
  train: TriggerEvalReport['summary'];
  test: TriggerEvalReport['summary'] | null;
  train_results: TriggerEvalReport['results'];
  test_results: TriggerEvalReport['results'];
}

export interface DescriptionLoopReport {
  skill_name: string;
  original_description: string;
  final_description: string;
  best_description: string;
  history: DescriptionLoopRecord[];
  train_size: number;
  test_size: number;
}

export interface DescriptionLoopOptions extends TriggerEvalOptions {
  workspaceDir: string;
  maxIterations: number;
  holdout?: number;
  seed?: number;
  writeBest?: boolean;
}

export function splitEvalSet(
  evals: Array<Record<string, unknown> & { should_trigger?: boolean }>,
  holdout?: number,
  seed?: number
): {
  train: Array<Record<string, unknown> & { should_trigger?: boolean }>;
  test: Array<Record<string, unknown> & { should_trigger?: boolean }>;
};

export function runDescriptionLoop(
  options: DescriptionLoopOptions,
  dependencies?: {
    runTriggerEvalFn?: (options: TriggerEvalOptions) => Promise<TriggerEvalReport>;
    improveDescriptionFn?: (
      options: ImproveDescriptionOptions
    ) => Promise<ImproveDescriptionResult>;
  }
): Promise<DescriptionLoopReport>;
