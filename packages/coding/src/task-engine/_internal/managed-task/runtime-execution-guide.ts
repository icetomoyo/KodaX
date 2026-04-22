/**
 * Runtime-execution-guide builder — restored from v0.7.22 task-engine
 * (FEATURE_079 Slice 8). Emits a markdown section describing how a role
 * should drive live verification against the runtime declared on the
 * task's verification contract. Pure function of its input.
 *
 * Re-added v0.7.26 during parity audit: `formatVerificationContract` calls
 * this twice for the "Runtime execution guide" subsection; `createRolePrompt`
 * reaches it only transitively through that formatter.
 */

import type { KodaXTaskVerificationContract } from '../../../types.js';

export function buildRuntimeExecutionGuide(
  verification: KodaXTaskVerificationContract | undefined,
): string | undefined {
  const runtime = verification?.runtime;
  if (!runtime) {
    return undefined;
  }

  const lines = [
    '# Runtime Execution Guide',
    '',
    'Use this guide to drive live verification against the runtime under test.',
    '',
    runtime.cwd ? `- Working directory: ${runtime.cwd}` : undefined,
    runtime.startupCommand ? `- Startup command: ${runtime.startupCommand}` : undefined,
    runtime.readySignal ? `- Ready signal: ${runtime.readySignal}` : undefined,
    runtime.baseUrl ? `- Base URL: ${runtime.baseUrl}` : undefined,
    runtime.env && Object.keys(runtime.env).length > 0
      ? `- Environment keys: ${Object.keys(runtime.env).join(', ')}`
      : undefined,
    '',
    'Execution protocol:',
    runtime.startupCommand
      ? '1. Start or confirm the runtime using the declared startup command before accepting the task.'
      : '1. Confirm the target runtime is available before accepting the task.',
    runtime.readySignal || runtime.baseUrl
      ? '2. Wait until the runtime is ready, using the ready signal or base URL when available.'
      : '2. Confirm runtime readiness using the strongest observable signal you have.',
    runtime.uiFlows?.length
      ? ['3. Execute the declared UI flows:', ...runtime.uiFlows.map((flow, index) => `   ${index + 1}. ${flow}`)].join('\n')
      : '3. Execute the critical user-facing flow when browser verification is required.',
    runtime.apiChecks?.length
      ? ['4. Run the declared API checks:', ...runtime.apiChecks.map((check, index) => `   ${index + 1}. ${check}`)].join('\n')
      : undefined,
    runtime.dbChecks?.length
      ? ['5. Run the declared DB checks:', ...runtime.dbChecks.map((check, index) => `   ${index + 1}. ${check}`)].join('\n')
      : undefined,
    runtime.fixtures?.length
      ? ['6. Account for the declared fixtures:', ...runtime.fixtures.map((fixture, index) => `   ${index + 1}. ${fixture}`)].join('\n')
      : undefined,
    '',
    'Evidence requirements:',
    '- Capture concrete evidence for every hard-threshold criterion before accepting the task.',
    '- Reject completion if the runtime cannot be started, cannot reach readiness, or any declared flow/check fails.',
  ].filter((line): line is string => Boolean(line));

  return `${lines.join('\n')}\n`;
}
