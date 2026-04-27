/**
 * Managed protocol auto-continue fallback — CAP-075
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-075-managed-protocol-auto-continue-fallback
 *
 * Class 1 (substrate). Single-shot per session. When the model
 * stops with `stopReason === 'end_turn'` and `lastText` is non-empty
 * but the required managed-protocol block is missing, push a synthetic
 * user message that demands ONLY the protocol emission (no other text)
 * and continue the turn. The flag prevents oscillation: if the model
 * fails to emit the protocol on the next turn either, we accept the
 * end_turn outcome rather than looping forever.
 *
 * The gate has 7 conjunctive conditions:
 *   1. NOT already attempted in this session (`!continueAttempted`)
 *   2. `stopReason === 'end_turn'`
 *   3. `result.toolBlocks.length === 0` (any tool call satisfies the
 *      protocol naturally)
 *   4. `lastText` non-empty (otherwise managed-protocol-empty has its
 *      own handler upstream)
 *   5. Managed-protocol emission is enabled in `options.context`
 *   6. NOT optional (Scout with full tools is opt-in only — the
 *      protocol is required only on escalation)
 *   7. `blockName` is defined for the role AND no protocol block has
 *      been recorded AND `lastText` does NOT contain the fenced
 *      block (model may have inlined it without calling the tool)
 *
 * Time-ordering constraint: AFTER L5 max-tokens continuation gate
 * (CAP-074); BEFORE the tool-blocks-empty terminal branch.
 *
 * Migration history: extracted from `agent.ts:996-1027` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.5b. The
 * `managedProtocolContinueAttempted` latch is folded into the
 * helper's input/output round-trip.
 */

import type { KodaXMessage, KodaXStreamResult } from '@kodax/ai';

import type {
  KodaXContextTokenSnapshot,
  KodaXManagedProtocolPayload,
  KodaXOptions,
} from '../types.js';
import {
  MANAGED_PROTOCOL_TOOL_NAME,
  getManagedBlockNameForRole,
  hasManagedProtocolForRole,
  textContainsManagedBlock,
} from '../managed-protocol.js';
import { rebaseContextTokenSnapshot } from '../token-accounting.js';

export interface ManagedProtocolContinueInput {
  readonly result: KodaXStreamResult;
  readonly lastText: string;
  /** Live message buffer — mutated when the gate fires. */
  readonly messages: KodaXMessage[];
  readonly continueAttempted: boolean;
  readonly options: KodaXOptions;
  /** Undefined when managed-protocol emission is disabled at session start. */
  readonly emittedManagedProtocolPayload: KodaXManagedProtocolPayload | undefined;
  readonly completedTurnTokenSnapshot: KodaXContextTokenSnapshot;
}

export type ManagedProtocolContinueOutcome =
  /** Gate condition not met; caller proceeds to next branch. Latch unchanged. */
  | { readonly outcome: 'no_op'; readonly nextContinueAttempted: boolean }
  /** Synthetic continuation pushed; caller MUST `continue` the turn loop. */
  | {
      readonly outcome: 'continue';
      readonly nextContinueAttempted: true;
      readonly nextContextTokenSnapshot: KodaXContextTokenSnapshot;
    };

/**
 * CAP-075: managed-protocol auto-continue. Mutates `messages` only on
 * the `continue` branch. Returns the next-turn latch and (when
 * applicable) the rebased token snapshot.
 */
export function maybeAutoContinueManagedProtocol(
  input: ManagedProtocolContinueInput,
): ManagedProtocolContinueOutcome {
  const {
    result,
    lastText,
    messages,
    continueAttempted,
    options,
    emittedManagedProtocolPayload,
    completedTurnTokenSnapshot,
  } = input;

  const emission = options.context?.managedProtocolEmission;
  if (
    continueAttempted
    || result.stopReason !== 'end_turn'
    || result.toolBlocks.length !== 0
    || !lastText
    || !emission?.enabled
    || emission.optional
  ) {
    return { outcome: 'no_op', nextContinueAttempted: continueAttempted };
  }

  const role = emission.role;
  const blockName = getManagedBlockNameForRole(role);
  if (
    !blockName
    || hasManagedProtocolForRole(emittedManagedProtocolPayload, role)
    || textContainsManagedBlock(lastText, blockName)
  ) {
    return { outcome: 'no_op', nextContinueAttempted: continueAttempted };
  }

  messages.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Your response is complete but the required protocol was not emitted. Do NOT output any text — ONLY call the "${MANAGED_PROTOCOL_TOOL_NAME}" tool now, or append a \`\`\`${blockName}\`\`\` fenced block. No other output.`,
      },
    ],
    _synthetic: true,
  });
  const nextContextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
  return {
    outcome: 'continue',
    nextContinueAttempted: true,
    nextContextTokenSnapshot,
  };
}
