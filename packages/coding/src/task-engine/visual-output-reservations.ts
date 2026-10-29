import type { KodaXMessage } from '@kodax-ai/llm';
import type { VisualOutputReservation } from '@kodax-ai/agent/media';
import { getToolResultAdmissionLimits } from '../tools/tool-result-policy.js';

/** One managed Run's generation/batch scope. Exact message occurrence, never provider call ID. */
export function createVisualOutputReservations() {
  const batches = new WeakMap<readonly KodaXMessage[], { used: number }>();
  return {
    reserve(transcript: readonly KodaXMessage[], capacity: number, tokens: number): VisualOutputReservation {
      let batch = batches.get(transcript);
      if (!batch) { batch = { used: 0 }; batches.set(transcript, batch); }
      const available = Math.min(capacity, getToolResultAdmissionLimits('visual_read_pixels').batchTokens);
      if (tokens > Math.max(0, available - batch.used)) throw new Error('Visual output capacity unavailable; request a smaller view or inspect in a later batch.');
      batch.used += tokens;
      let active = true;
      return { cancel() { if (active) { active = false; batch.used -= tokens; } } };
    },
    settle(transcript: readonly KodaXMessage[]) { batches.delete(transcript); },
  };
}
