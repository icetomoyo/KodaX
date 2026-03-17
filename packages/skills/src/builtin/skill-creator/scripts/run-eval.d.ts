export interface SkillEvalAssertion {
  text: string;
}

export interface SkillEvalItem {
  id?: string | number;
  name?: string;
  prompt?: string;
  query?: string;
  expected_output?: string;
  files?: string[];
  assertions?: Array<string | SkillEvalAssertion>;
}

export interface SkillEvalExecution {
  result: {
    success: boolean;
    lastText: string;
    signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
    signalReason?: string;
    messages: Array<Record<string, unknown>>;
    sessionId: string;
    interrupted?: boolean;
    limitReached?: boolean;
  };
  totalTokens: number;
  durationMs: number;
}

export interface RunEvalWorkspaceOptions {
  skillPath: string;
  evalsPath: string;
  workspaceDir: string;
  provider?: string;
  model?: string;
  runsPerConfig?: number;
  maxIter?: number;
  reasoningMode?: string;
  cwd?: string;
  configs?: string[];
  output?: string;
}

export function buildEvalPrompt(
  evalItem: SkillEvalItem,
  options: Pick<RunEvalWorkspaceOptions, 'evalsPath' | 'cwd'>
): Promise<string>;

export function runEvalWorkspace(
  options: RunEvalWorkspaceOptions,
  runner?: (
    prompt: string,
    options: RunEvalWorkspaceOptions & {
      configName: string;
      evalItem: SkillEvalItem;
      runIndex: number;
    }
  ) => Promise<SkillEvalExecution>
): Promise<{
  workspace: string;
  skill_name: string;
  eval_count: number;
  configs: string[];
  runs_per_config: number;
  reports: Array<Record<string, unknown>>;
}>;
