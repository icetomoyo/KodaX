export interface ReviewOutput {
  name: string;
  kind: string;
  content?: string;
  dataUri?: string;
}

export interface ReviewRun {
  id: string;
  evalId: string | number | null;
  prompt: string;
  grading: Record<string, unknown> | null;
  outputs: ReviewOutput[];
}

export interface ReviewPayload {
  skillName: string;
  workspace: string;
  benchmark: Record<string, unknown> | null;
  feedback: Record<string, string>;
  runs: ReviewRun[];
}

export function findRuns(
  workspaceRoot: string,
  currentDir?: string,
  runs?: ReviewRun[]
): Promise<ReviewRun[]>;
export function buildPayload(
  workspace: string,
  args: { skillName: string; benchmark?: string | null }
): Promise<ReviewPayload>;
export function renderHtml(payload: ReviewPayload, staticMode: boolean): string;
