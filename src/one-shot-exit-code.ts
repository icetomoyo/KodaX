import type { KodaXResult } from '@kodax-ai/coding';

/** Success 0, interrupted 130 (SIGINT), failed or unconfirmed 1. */
export function exitCodeForOneShotResult(result: KodaXResult): number {
  if (result.success) return 0;
  return result.interrupted ? 130 : 1;
}
