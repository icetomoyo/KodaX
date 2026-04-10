import type { KodaXToolExecutionContext } from '../types.js';
import {
  formatSize,
  persistToolOutput,
  truncateHead,
  truncateTail,
} from './truncate.js';

export interface ToolResultPolicy {
  maxLines: number;
  maxBytes: number;
  direction: 'head' | 'tail';
  spillToFile: boolean;
}

export interface GuardedToolResult {
  content: string;
  truncated: boolean;
  outputPath?: string;
  policy: ToolResultPolicy;
}

const DEFAULT_POLICY: ToolResultPolicy = {
  maxLines: 1200,
  maxBytes: 40 * 1024,
  direction: 'head',
  spillToFile: true,
};

const TOOL_RESULT_POLICIES: Record<string, ToolResultPolicy> = {
  read: {
    maxLines: 2000,
    maxBytes: 50 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  bash: {
    maxLines: 600,
    maxBytes: 32 * 1024,
    direction: 'tail',
    spillToFile: true,
  },
  grep: {
    maxLines: 400,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  web_search: {
    maxLines: 240,
    maxBytes: 20 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  web_fetch: {
    maxLines: 320,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  code_search: {
    maxLines: 320,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  semantic_lookup: {
    maxLines: 260,
    maxBytes: 20 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  changed_diff: {
    maxLines: 1400,
    maxBytes: 48 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  changed_diff_bundle: {
    maxLines: 1600,
    maxBytes: 56 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  write: {
    maxLines: 350,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  edit: {
    maxLines: 350,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
};

export function getToolResultPolicy(toolName: string): ToolResultPolicy {
  return TOOL_RESULT_POLICIES[toolName] ?? DEFAULT_POLICY;
}

function buildToolResultHint(toolName: string): string {
  switch (toolName) {
    case 'read':
      return 'Use read with offset/limit or grep to continue with a smaller slice.';
    case 'bash':
      return 'Narrow the command, or redirect output to a file before reading it.';
    case 'grep':
      return 'Narrow the pattern or path, or switch to files_with_matches/count first.';
    case 'web_search':
      return 'Refine the query or fetch a specific result URL for higher-confidence source capture.';
    case 'web_fetch':
      return 'Fetch a narrower page or follow up with read/grep on the saved output file.';
    case 'code_search':
      return 'Narrow the search root or query, or follow up with read on the matched file.';
    case 'semantic_lookup':
      return 'Narrow the query or use symbol_context/module_context for a deeper semantic follow-up.';
    case 'changed_diff':
      return 'Continue with changed_diff offset/limit, or switch to read for current-file context after identifying the relevant patch slice.';
    case 'changed_diff_bundle':
      return 'Use changed_diff_bundle to sweep high-priority files first, then switch to changed_diff or read for a specific suspicious file.';
    case 'write':
    case 'edit':
      return 'Inspect the file with read instead of relying on a huge diff preview.';
    default:
      return 'Use a narrower follow-up tool call to inspect the missing details.';
  }
}

export async function applyToolResultGuardrail(
  toolName: string,
  content: string,
  ctx: KodaXToolExecutionContext,
): Promise<GuardedToolResult> {
  const policy = getToolResultPolicy(toolName);
  const truncation =
    policy.direction === 'tail'
      ? truncateTail(content, policy)
      : truncateHead(content, policy);

  if (!truncation.truncated) {
    return {
      content,
      truncated: false,
      policy,
    };
  }

  let outputPath: string | undefined;
  if (policy.spillToFile) {
    try {
      outputPath = await persistToolOutput(toolName, content, ctx);
    } catch {
      outputPath = undefined;
    }
  }

  const preview =
    truncation.firstLineExceedsLimit && !truncation.content
      ? '[Output preview omitted because the first line alone exceeded the tool-output byte limit.]'
      : truncation.content;

  const prefix =
    policy.direction === 'tail'
      ? 'Tool output truncated to the most recent portion.'
      : 'Tool output truncated.';
  const summary =
    `${prefix} Showing ${truncation.outputLines} of ${truncation.totalLines} lines `
    + `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  const saved =
    outputPath
      ? ` Full output saved to: ${outputPath}.`
      : '';
  const hint = ` ${buildToolResultHint(toolName)}`;
  const guardedContent = `${preview}\n\n[${summary}${saved}${hint}]`;

  if (process.env.KODAX_DEBUG_TOOL_GUARDRAILS) {
    console.error('[ToolGuardrail]', {
      toolName,
      outputPath,
      totalBytes: truncation.totalBytes,
      shownBytes: truncation.outputBytes,
      truncatedBy: truncation.truncatedBy,
    });
  }

  return {
    content: guardedContent,
    truncated: true,
    outputPath,
    policy,
  };
}
