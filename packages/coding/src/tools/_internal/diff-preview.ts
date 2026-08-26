import type { KodaXToolExecutionContext } from '../../types.js';

export interface DiffPreviewOptions {
  diff: string;
  toolName: string;
  filePath: string;
  ctx: KodaXToolExecutionContext;
  maxLines?: number;
  maxBytes?: number;
}

export async function formatDiffPreview({
  diff,
}: DiffPreviewOptions): Promise<string> {
  return diff;
}
