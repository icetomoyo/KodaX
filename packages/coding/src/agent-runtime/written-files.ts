import path from 'node:path';
import type { KodaXWrittenFile } from '../types.js';
import type { ToolResult } from '../tools/types.js';
import { toolResultText } from '../tools/tool-result-content.js';
import { isToolResultErrorContent } from './tool-result-classify.js';

function skillOutputPaths(input: Record<string, unknown>, content: ToolResult, cwd: string): string[] {
  if (!Array.isArray(input.outputs)) return [];
  const declared = new Set(input.outputs.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || !('target' in item) || typeof item.target !== 'string') return [];
    return item.target.trim() ? [path.resolve(cwd, item.target.trim())] : [];
  }));
  let value: unknown;
  try { value = JSON.parse(toolResultText(content)); }
  catch { return []; } // Malformed output is not evidence of a promoted file.
  if (!value || typeof value !== 'object' || !('outputs' in value) || !Array.isArray(value.outputs)) return [];
  return value.outputs.flatMap((target: unknown) => {
    if (typeof target !== 'string' || !target.trim()) return [];
    const absolute = path.resolve(cwd, target);
    return declared.has(absolute) ? [absolute] : [];
  });
}

/** Record execution facts before transcript compaction; publication remains host-owned. */
export function recordWrittenFile(
  files: Map<string, KodaXWrittenFile> | undefined,
  call: { readonly name: string; readonly input?: Record<string, unknown> },
  content: ToolResult,
  cwd: string,
): void {
  if (!files || !call.input || isToolResultErrorContent(content)) return;
  const name = call.name;
  if (name === 'run_skill_script') {
    for (const target of skillOutputPaths(call.input, content, cwd)) {
      files.set(target, { path: target, sourceTool: name });
    }
    return;
  }
  if (name !== 'write' && name !== 'edit' && name !== 'multi_edit' && name !== 'insert_after_anchor') return;
  if (typeof call.input.path !== 'string' || !call.input.path.trim()) return;
  const target = path.resolve(cwd, call.input.path);
  if (files.get(target)?.sourceTool !== 'run_skill_script') {
    files.set(target, { path: target, sourceTool: name });
  }
}
