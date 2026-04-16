/**
 * KodaX Parallel Task Dispatch
 *
 * Enables Scout to dispatch independent subtasks in parallel via runOrchestration.
 * This is the minimal viable slice of #92 (Team Agent).
 */

export interface ParallelSubtask {
  readonly id: string;
  readonly description: string;
  readonly prompt: string;
}

export interface ParallelDispatchDirective {
  readonly type: 'parallel_dispatch';
  readonly subtasks: readonly ParallelSubtask[];
  readonly reason: string;
}

export interface ParallelDispatchResult {
  readonly tasks: readonly {
    readonly id: string;
    readonly description: string;
    readonly status: 'completed' | 'failed';
    readonly summary: string;
    readonly durationMs: number;
  }[];
  readonly overallSummary: string;
  readonly totalDurationMs: number;
}

/**
 * Check if a Scout directive indicates parallel dispatch.
 */
export function isParallelDispatchDirective(
  directive: unknown,
): directive is ParallelDispatchDirective {
  if (typeof directive !== 'object' || directive === null) return false;
  const d = directive as Record<string, unknown>;
  return d.type === 'parallel_dispatch' && Array.isArray(d.subtasks) && d.subtasks.length >= 2;
}

/**
 * Format parallel dispatch results into a user-facing summary.
 */
export function formatParallelDispatchResult(result: ParallelDispatchResult): string {
  const lines: string[] = [];
  lines.push(
    `Parallel execution completed: ${result.tasks.length} subtasks (${(result.totalDurationMs / 1000).toFixed(1)}s total)`
  );
  lines.push('');

  for (const task of result.tasks) {
    const status = task.status === 'completed' ? '[OK]' : '[FAIL]';
    lines.push(`${status} ${task.description} (${(task.durationMs / 1000).toFixed(1)}s)`);
    if (task.summary) {
      // Indent summary lines
      const summaryLines = task.summary.split('\n').slice(0, 5);
      for (const sl of summaryLines) {
        lines.push(`    ${sl}`);
      }
    }
  }

  if (result.overallSummary) {
    lines.push('');
    lines.push(result.overallSummary);
  }

  return lines.join('\n');
}

/**
 * Validate that subtasks are independent (basic heuristic check).
 * Returns null if valid, or an error message if not.
 */
export function validateSubtaskIndependence(subtasks: readonly ParallelSubtask[]): string | null {
  if (subtasks.length < 2) {
    return 'Parallel dispatch requires at least 2 subtasks';
  }
  if (subtasks.length > 10) {
    return 'Parallel dispatch limited to 10 subtasks maximum';
  }
  // Check for duplicate IDs
  const ids = new Set<string>();
  for (const task of subtasks) {
    if (ids.has(task.id)) {
      return `Duplicate subtask ID: ${task.id}`;
    }
    ids.add(task.id);
  }
  return null;
}
