import {
  exitCodeForOneShotResult,
} from '../one-shot-exit-code.js';
import { type KodaXResult, type KodaXOptions } from '@kodax-ai/coding';
import type { KodaXHostClient } from '../host-protocol/host-client.js';
import type { ReplLeases } from '../repl-host/leases.js';
import { loadOneShotTask } from '../cli-lazy-components.js';

/**
 * FEATURE_298 T35 — shared one-shot process ownership: SIGINT requests a
 * durable Host stop (a second SIGINT forces the conventional 130 exit) and
 * the settled result maps to the process exit code.
 */
async function runOneShotOwnedProcess(
  execute: (abortSignal: AbortSignal) => Promise<KodaXResult>,
): Promise<KodaXResult> {
  const controller = new AbortController();
  const onSigint = (): void => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
  process.on('SIGINT', onSigint);
  try {
    const result = await execute(controller.signal);
    process.exitCode = exitCodeForOneShotResult(result);
    return result;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/** The CLI's one connection to the Host, over v2, and the keys it lends the Host's Runs. */
export interface CliHost {
  readonly client: KodaXHostClient<'local'>;
  readonly leases: ReplLeases;
}

/**
 * One-shot runs, including raw Skill invocations, run on the Host: it owns
 * the Session, the input and the Run; CLI flags become Session settings.
 */
export async function runCliTaskViaClient(
  host: CliHost,
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  const { runOneShotClientTask } = await loadOneShotTask();
  return runOneShotOwnedProcess((abortSignal) => runOneShotClientTask({
    client: host.client,
    leases: host.leases,
    options,
    prompt,
    abortSignal,
  }));
}
