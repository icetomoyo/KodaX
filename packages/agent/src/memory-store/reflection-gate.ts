/**
 * FEATURE_308 — cheap, language-independent gate in front of the reflection
 * LLM call. A session qualifies when the user steered it (more than one user
 * turn) or a tool failure was later followed by a success of the same tool.
 * Everything else is skipped without a model call.
 */
import type { KodaXMessage } from '@kodax-ai/llm';

import { collectSegments, type EvidenceSegment } from './evidence.js';

export interface ReflectionSignals {
  readonly userTurns: number;
  readonly recoveredFailure: boolean;
}

export function signalsOf(segments: readonly EvidenceSegment[]): ReflectionSignals {
  const failedTools = new Set<string>();
  let recoveredFailure = false;
  for (const segment of segments) {
    if (segment.tool === undefined) continue;
    if (segment.isError) failedTools.add(segment.tool);
    else if (failedTools.has(segment.tool)) recoveredFailure = true;
  }
  return { userTurns: segments.filter((segment) => segment.source === 'user').length, recoveredFailure };
}

export function shouldReflect(messages: readonly KodaXMessage[]): boolean {
  const signals = signalsOf(collectSegments(messages));
  return signals.userTurns >= 2 || signals.recoveredFailure;
}
