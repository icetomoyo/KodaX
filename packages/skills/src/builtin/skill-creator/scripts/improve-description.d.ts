export interface ImproveDescriptionOptions {
  skillPath: string;
  evalResultsPath: string;
  provider?: string;
  model?: string;
  output?: string;
  write?: boolean;
  historyPath?: string;
  maxIter?: number;
  reasoningMode?: string;
}

export interface ImproveDescriptionResult {
  description: string;
  rawResponse: string;
  prompt: string;
}

export function extractDescriptionCandidate(text: string): string;
export function improveDescription(
  options: ImproveDescriptionOptions,
  generator?: (prompt: string, options: ImproveDescriptionOptions) => Promise<string>
): Promise<ImproveDescriptionResult>;
