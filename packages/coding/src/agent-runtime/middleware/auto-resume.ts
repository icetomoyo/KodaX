/**
 * Auto-resume / session-continuation middleware — CAP-008 + CAP-046
 *
 * Capability inventory:
 * - docs/features/v0.7.29-capability-inventory.md#cap-008-initialmessages-session-continuation
 * - docs/features/v0.7.29-capability-inventory.md#cap-046-duplicate-user-message-detection
 *
 * Three concerns colocated here because they are all triggered at frame
 * entry and consume the same `KodaXOptions.session` field:
 *
 *   1. **`extractPromptComparableText` / `extractComparableUserMessageText`**
 *      — canonicalise text content for the duplicate-message check
 *      (returns string for primitive content, joined text-block content
 *      otherwise). Re-exported from `../../input-artifacts.ts` to preserve
 *      the public API path.
 *
 *   2. **`resolveInitialMessages`** (CAP-008) — at frame entry, picks ONE
 *      of three source paths and returns the resolved transcript bundle:
 *        a. `options.session.initialMessages` provided (REPL multi-turn,
 *           plan-mode replay) → clone + extract title from messages.
 *        b. `options.session.storage` + `sessionId` provided → load and
 *           normalise via `normalizeLoadedSessionMessages` (FEATURE_076
 *           Q4 worker-trace shape repair).
 *        c. neither → returns empty messages, no title, no metadata.
 *
 *   3. **`appendPromptIfNotDuplicate`** (CAP-046) — pushes a fresh
 *      `user` message UNLESS the last message of the transcript is
 *      already that prompt (canonical compare). Prevents double-push
 *      when REPL re-feeds the same prompt to a mid-flight `runKodaX`.
 *
 * Migration history:
 *   - `extractPromptComparableText` + `extractComparableUserMessageText`
 *     moved here from `input-artifacts.ts:11-32` (deferred from CAP-009
 *     extraction in earlier P2 batches).
 *   - `resolveInitialMessages` extracted from `agent.ts:1485-1503` (the
 *     `if (options.session?.initialMessages...)` block — pre-FEATURE_100
 *     baseline).
 *   - `appendPromptIfNotDuplicate` extracted from `agent.ts:1503-1511`
 *     (the duplicate-detection + push block — pre-FEATURE_100 baseline).
 *
 * All extractions during FEATURE_100 P2.
 */

import type {
  KodaXContentBlock,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXOptions,
  SessionErrorMetadata,
} from '../../types.js';
import type { KodaXMessage } from '@kodax/ai';
import type { KodaXInputArtifact } from '../../types.js';
import { extractTitleFromMessages } from '../../session.js';
import { normalizeLoadedSessionMessages } from '../../task-engine/_internal/round-boundary.js';
import { buildPromptMessageContent } from '../prompt-content.js';

export function extractPromptComparableText(
  content: string | readonly KodaXContentBlock[],
): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((block): block is Extract<KodaXContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export function extractComparableUserMessageText(
  message: KodaXMessage | undefined,
): string | undefined {
  if (!message || message.role !== 'user') {
    return undefined;
  }

  return extractPromptComparableText(message.content);
}

export interface ResolvedInitialMessages {
  messages: KodaXMessage[];
  title: string;
  errorMetadata?: SessionErrorMetadata;
  loadedExtensionState?: KodaXExtensionSessionState;
  loadedExtensionRecords?: KodaXExtensionSessionRecord[];
}

/**
 * Resolve initial transcript at frame entry. Precedence:
 *   1. `options.session.initialMessages` (interactive multi-turn / plan-mode replay)
 *   2. `options.session.storage.load(sessionId)` (resume from disk)
 *   3. neither → `{ messages: [], title: '' }`
 *
 * Behaviour preserved verbatim from `agent.ts:1485-1503` baseline,
 * including the FEATURE_076 Q4 worker-trace normalization on the load
 * branch.
 */
export async function resolveInitialMessages(
  options: KodaXOptions,
  sessionId: string | undefined,
): Promise<ResolvedInitialMessages> {
  if (options.session?.initialMessages && options.session.initialMessages.length > 0) {
    const messages = [...options.session.initialMessages];
    return {
      messages,
      title: extractTitleFromMessages(messages),
    };
  }

  if (options.session?.storage && sessionId) {
    const loaded = await options.session.storage.load(sessionId);
    if (loaded) {
      return {
        messages: normalizeLoadedSessionMessages(loaded.messages),
        title: loaded.title,
        errorMetadata: loaded.errorMetadata,
        loadedExtensionState: loaded.extensionState,
        loadedExtensionRecords: loaded.extensionRecords,
      };
    }
  }

  return { messages: [], title: '' };
}

/**
 * Push a user message for `prompt` UNLESS the last message in `messages`
 * is already that prompt (canonical text equality). Returns a NEW array
 * either way — input is never mutated.
 *
 * Behaviour preserved verbatim from `agent.ts:1503-1511` baseline.
 */
export function appendPromptIfNotDuplicate(
  messages: KodaXMessage[],
  prompt: string,
  inputArtifacts: readonly KodaXInputArtifact[] | undefined,
): KodaXMessage[] {
  const lastMsg = messages[messages.length - 1];
  if (extractComparableUserMessageText(lastMsg) === prompt) {
    return messages;
  }
  return [
    ...messages,
    {
      role: 'user',
      content: buildPromptMessageContent(prompt, inputArtifacts),
    },
  ];
}
