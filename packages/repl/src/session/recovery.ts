import type {
  RecoverySeed,
  RecoverySeedInput,
} from '@kodax-ai/agent';
import {
  buildRecoverySeed,
  normalizeRecoveryPrompt,
} from '@kodax-ai/agent';
import { isSessionRecoveryCandidateError } from '@kodax-ai/coding';

export type {
  RecoverySeed,
  RecoverySeedInput,
};
export {
  buildRecoverySeed,
  normalizeRecoveryPrompt,
};

export const SESSION_RECOVERY_CONFIRM_MESSAGE =
  'The provider may be rejecting the current session history. Create a new session from a safe summary and continue there?';

export const SESSION_RECOVERY_HINT_MESSAGE =
  'The current LLM API may be rejecting this session history. Run /recover [prompt] to continue in a fresh session from safe memory.';

export interface SessionRecoveryOfferInput {
  error: Error;
  /** The conversation's size, from whoever keeps it: the Host for a bound client, else the local cache. */
  countMessages: () => number | undefined | Promise<number | undefined>;
}

/** Only an error that could come from a rejected history asks for the count, so an ordinary failure costs no Host read. */
export async function shouldOfferSessionRecovery(input: SessionRecoveryOfferInput): Promise<boolean> {
  if (!isSessionRecoveryCandidateError(input.error, 1)) return false;
  return isSessionRecoveryCandidateError(input.error, await input.countMessages() ?? 0);
}
