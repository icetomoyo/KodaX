import type {
  KodaXRepoIntelligenceCarrier,
  KodaXRepoIntelligenceTraceEvent,
} from '../types.js';

function formatWarnings(warnings: string[] | undefined): string | undefined {
  if (!warnings || warnings.length === 0) {
    return undefined;
  }
  return warnings.join(' | ');
}

export function buildRepoIntelligenceMetadataLines(
  carrier: KodaXRepoIntelligenceCarrier,
): string[] {
  const lines: string[] = [];
  if (carrier.capability) {
    lines.push(
      `Capability: mode=${carrier.capability.mode} | engine=${carrier.capability.engine} | bridge=${carrier.capability.bridge} | level=${carrier.capability.level} | status=${carrier.capability.status}`,
    );
    const warnings = formatWarnings(carrier.capability.warnings);
    if (warnings) {
      lines.push(`Warnings: ${warnings}`);
    }
  }
  if (carrier.trace) {
    const traceParts = [
      `source=${carrier.trace.source}`,
      carrier.trace.daemonLatencyMs !== undefined ? `daemon_ms=${carrier.trace.daemonLatencyMs}` : undefined,
      carrier.trace.cliLatencyMs !== undefined ? `cli_ms=${carrier.trace.cliLatencyMs}` : undefined,
      carrier.trace.cacheHit !== undefined ? `cache_hit=${carrier.trace.cacheHit ? 'yes' : 'no'}` : undefined,
      carrier.trace.capsuleBytes !== undefined ? `capsule_bytes=${carrier.trace.capsuleBytes}` : undefined,
      carrier.trace.capsuleEstimatedTokens !== undefined ? `capsule_tokens=${carrier.trace.capsuleEstimatedTokens}` : undefined,
    ].filter((value): value is string => Boolean(value));
    if (traceParts.length > 0) {
      lines.push(`Trace: ${traceParts.join(' | ')}`);
    }
  }
  return lines;
}

export function createRepoIntelligenceTraceEvent(
  stage: KodaXRepoIntelligenceTraceEvent['stage'],
  carrier: KodaXRepoIntelligenceCarrier,
  detail?: string,
): KodaXRepoIntelligenceTraceEvent | null {
  if (!carrier.capability && !carrier.trace) {
    return null;
  }

  const parts = [
    `stage=${stage}`,
    carrier.capability
      ? `mode=${carrier.capability.mode}/${carrier.capability.engine}/${carrier.capability.bridge}/${carrier.capability.status}`
      : undefined,
    carrier.trace?.daemonLatencyMs !== undefined ? `daemon_ms=${carrier.trace.daemonLatencyMs}` : undefined,
    carrier.trace?.cliLatencyMs !== undefined ? `cli_ms=${carrier.trace.cliLatencyMs}` : undefined,
    carrier.trace?.cacheHit !== undefined ? `cache_hit=${carrier.trace.cacheHit ? 'yes' : 'no'}` : undefined,
    carrier.trace?.capsuleEstimatedTokens !== undefined ? `capsule_tokens=${carrier.trace.capsuleEstimatedTokens}` : undefined,
    detail,
  ].filter((value): value is string => Boolean(value));

  return {
    stage,
    summary: parts.join(' | '),
    capability: carrier.capability,
    trace: carrier.trace,
  };
}
