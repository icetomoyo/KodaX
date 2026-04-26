/**
 * Provider payload size estimation + bucketing — CAP-027
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-027-provider-payload-size-estimation--bucketing
 *
 * Pure size estimator used by the resilience layer (`runner-driven.ts:2465`)
 * to decide retry / fallback budgets and by debug telemetry to bucket-tag
 * each provider call. The byte count is JSON-serialised stringification —
 * cheap, deterministic, and approximate enough to drive the small/medium/
 * large/xlarge bucket decision.
 *
 * Migration history: extracted from `agent.ts:1056-1075` (pre-FEATURE_100 baseline)
 * during FEATURE_100 P2.
 */

import type { KodaXMessage } from '@kodax/ai';

export function estimateProviderPayloadBytes(messages: KodaXMessage[], systemPrompt: string): number {
  return Buffer.byteLength(JSON.stringify({
    systemPrompt,
    messages,
  }), 'utf8');
}

export function bucketProviderPayloadSize(bytes: number): string {
  if (bytes < 16 * 1024) {
    return 'small';
  }
  if (bytes < 64 * 1024) {
    return 'medium';
  }
  if (bytes < 192 * 1024) {
    return 'large';
  }
  return 'xlarge';
}
