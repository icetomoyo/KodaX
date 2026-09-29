import type { KodaXMessage } from '../../../types.js';

export const MANAGED_RUN_CONTEXT_SOURCE = 'managed-run-context';
export const MANAGED_RUNTIME_CONTEXT_SOURCE = 'managed-runtime-context';

const MANAGED_RUNTIME_CONTEXT_MAX_CHARS = 4_000;
const MANAGED_RUN_CONTEXT_MAX_CHARS = 32_000;

function boundManagedContext(
  content: string,
  maxChars: number,
  truncationNotice: string,
): string {
  if (content.length <= maxChars) return content;
  const trailer = `\n[${truncationNotice}]\n=== End Managed Run Context ===`;
  return `${content.slice(0, maxChars - trailer.length).trimEnd()}${trailer}`;
}

export function isManagedRunContextMessage(message: KodaXMessage): boolean {
  return message._source === MANAGED_RUN_CONTEXT_SOURCE
    || message._source === MANAGED_RUNTIME_CONTEXT_SOURCE;
}

export function createManagedRunContextMessage(
  content: string,
  metadata: Pick<KodaXMessage, 'turnId' | 'timestamp'> = {},
): KodaXMessage {
  return {
    role: 'user',
    content: boundManagedContext(
      content,
      MANAGED_RUN_CONTEXT_MAX_CHARS,
      'Managed run context truncated',
    ),
    _synthetic: true,
    _source: MANAGED_RUN_CONTEXT_SOURCE,
    ...metadata,
  };
}

export function createManagedRuntimeContextMessage(
  content: string,
  metadata: Pick<KodaXMessage, 'turnId' | 'timestamp'> = {},
): KodaXMessage {
  const boundedContent = boundManagedContext(
    content,
    MANAGED_RUNTIME_CONTEXT_MAX_CHARS,
    'Runtime state delta truncated',
  );
  return {
    role: 'user',
    content: boundedContent,
    _synthetic: true,
    _source: MANAGED_RUNTIME_CONTEXT_SOURCE,
    ...metadata,
  };
}

export function stripManagedRunContextMessages(
  messages: readonly KodaXMessage[],
): KodaXMessage[] {
  return messages.filter((message) => !isManagedRunContextMessage(message));
}

function carriesToolResult(message: KodaXMessage): boolean {
  return Array.isArray(message.content)
    && message.content.some((block) => block.type === 'tool_result');
}

/**
 * Reinstall the canonical context immediately before the latest real user
 * instruction. A compacted history that has no retained real user instead
 * receives the context before its synthetic summary checkpoint.
 *
 * A user message that carries tool results is not an instruction: inserting
 * before it would separate those results from the assistant calls they
 * answer, and pairing repair would then discard both.
 */
export function installCanonicalManagedRunContext(
  messages: readonly KodaXMessage[],
  canonical: KodaXMessage,
): KodaXMessage[] {
  const withoutManagedContext = stripManagedRunContextMessages(messages);
  let anchorIndex = -1;
  for (let index = withoutManagedContext.length - 1; index >= 0; index -= 1) {
    const message = withoutManagedContext[index]!;
    if (message.role === 'user' && message._synthetic !== true && !carriesToolResult(message)) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex < 0) {
    anchorIndex = withoutManagedContext.findIndex((message) =>
      message._source === 'compaction-checkpoint');
  }
  const insertionIndex = anchorIndex < 0
    ? withoutManagedContext.length
    : anchorIndex;
  return [
    ...withoutManagedContext.slice(0, insertionIndex),
    canonical,
    ...withoutManagedContext.slice(insertionIndex),
  ];
}
