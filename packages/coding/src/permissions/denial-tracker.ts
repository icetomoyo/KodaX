/**
 * KodaX Denial Tracker - Immutable session-scoped tool denial tracking
 *
 * Tracks user permission denials to avoid re-prompting for the same operation.
 * Provides denial context for injection into agent messages.
 */

export interface DenialRecord {
  readonly toolName: string;
  readonly inputSignature: string;
  readonly timestamp: number;
  readonly reason?: string;
}

export interface DenialTracker {
  readonly records: readonly DenialRecord[];
}

export function createDenialTracker(): DenialTracker {
  return { records: [] };
}

/**
 * Compute a normalized signature for a tool input.
 * - bash: first 3 tokens of the command
 * - edit/write/read: file path
 * - other: tool name + hash prefix
 */
export function computeInputSignature(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    const tokens = cmd.trim().split(/\s+/).slice(0, 3);
    return `bash:${tokens.join(' ')}`;
  }

  if (toolName === 'edit' || toolName === 'write' || toolName === 'read') {
    const filePath =
      typeof input.file_path === 'string' ? input.file_path : '';
    return `${toolName}:${filePath}`;
  }

  // Generic: tool name + simple hash of input
  const inputStr = JSON.stringify(input);
  let hash = 0;
  for (let i = 0; i < inputStr.length; i++) {
    hash = ((hash << 5) - hash + inputStr.charCodeAt(i)) | 0;
  }
  return `${toolName}:${(hash >>> 0).toString(16).slice(0, 8)}`;
}

export function recordDenial(
  tracker: DenialTracker,
  toolName: string,
  input: Record<string, unknown>,
  reason?: string,
): DenialTracker {
  const signature = computeInputSignature(toolName, input);
  const record: DenialRecord = {
    toolName,
    inputSignature: signature,
    timestamp: Date.now(),
    reason,
  };
  return { records: [...tracker.records, record] };
}

export function isDeniedRecently(
  tracker: DenialTracker,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const signature = computeInputSignature(toolName, input);
  return tracker.records.some((r) => r.inputSignature === signature);
}

/**
 * Generate a denial context string for injection into agent messages.
 * Tells the LLM what was denied so it can adjust its strategy.
 */
export function getDenialContext(tracker: DenialTracker): string {
  if (tracker.records.length === 0) return '';

  const unique = new Map<string, DenialRecord>();
  for (const r of tracker.records) {
    unique.set(r.inputSignature, r);
  }

  const lines = [
    'The user has denied the following operations in this session:',
  ];
  for (const [sig, record] of unique) {
    const reason = record.reason ? ` (reason: ${record.reason})` : '';
    lines.push(`- ${sig}${reason}`);
  }
  lines.push('Do not retry these operations. Find an alternative approach.');
  return lines.join('\n');
}
