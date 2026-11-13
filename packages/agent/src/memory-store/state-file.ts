/** FEATURE_308 — reading the reflection job's small JSON state files (budget, cursor). */
import { emitKodaXDiagnostic } from '../diagnostics.js';

/**
 * Parses a state file. A corrupt file is reported and read as empty: blocking
 * the job on it forever would be worse than starting that state over.
 */
export function parseStateFile(file: string, raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    emitKodaXDiagnostic({
      source: 'agent:note-reflection',
      level: 'warn',
      message: `The reflection state file ${file} is not valid JSON; it starts over.`,
    });
    return undefined;
  }
}
