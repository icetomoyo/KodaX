import { staticText } from '../prompts/static-text.js';
import { createHash } from 'node:crypto';

import {
  memoryProposalRevision,
  memoryMutationHandle,
  parseMemoryFile,
  sanitizePromptSafeMemoryClaim,
  type KodaXHandledMemoryOperation,
  type MemoryManagementController,
  type MemoryActionProposal,
  type MemoryItemRef,
  type MemoryLifecycleOperationResult,
  type MemoryRememberInput,
} from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';

export const MEMORY_INTENT_TOOL_NAME = 'memory_intent';

export const MEMORY_INTENT_TOOL_DESCRIPTION = [
  staticText("t12i.tools/memory-intent.block.0"),
].join(' ');

export const MEMORY_INTENT_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    operation: {
      type: 'string' as const,
      enum: ['list', 'remember', 'correct', 'forget', 'decisions', 'show', 'approve', 'reject'],
      description: 'The Memory operation requested by the user.',
    },
    statement: {
      type: 'string' as const,
      description: 'A concise durable claim for remember or correct.',
    },
    targetRefId: {
      type: 'string' as const,
      description: 'One exact ref returned by list/recall; required for correct and forget.',
    },
    claimKind: {
      type: 'string' as const,
      enum: ['fact', 'policy', 'preference', 'procedure'],
      description: 'The durable claim category for remember or correct.',
    },
    claimKey: {
      type: 'string' as const,
      description: 'Stable semantic identity such as project.package_manager or user.preference.editor; required for every new claim.',
    },
    userQuote: {
      type: 'string' as const,
      description: 'An exact quote from the current user message authorizing a mutation.',
    },
    reason: {
      type: 'string' as const,
      description: 'Optional user-supplied rejection reason.',
    },
  },
  required: ['operation'],
};

interface CreateMemoryIntentBindingOptions {
  readonly getCurrentUserTurn: () => {
    readonly text: string;
    readonly turnId: string;
  };
  readonly controlPlane: Pick<
    MemoryManagementController,
    | 'remember'
    | 'listRefs'
    | 'readRef'
    | 'forgetRef'
    | 'listInbox'
    | 'showProposal'
    | 'approveProposal'
    | 'rejectProposal'
  >;
  readonly presentedMemories?: readonly {
    readonly refId: string;
    readonly bodyFingerprint: string;
    readonly searchableText?: string;
  }[];
  readonly presentedDecisionRefIds?: readonly string[];
  readonly getPresentedTargets?: () => {
    readonly memories: readonly {
      readonly refId: string;
      readonly bodyFingerprint: string;
      readonly searchableText?: string;
    }[];
    readonly decisionRefIds: readonly string[];
  };
  readonly onHandledOperation?: (operation: KodaXHandledMemoryOperation) => void;
}

type MemoryIntentBinding = NonNullable<KodaXToolExecutionContext['memoryManagementIntent']>;
type MemoryIntentInput = Parameters<MemoryIntentBinding>[0];
type MemoryIntentReceipt = Awaited<ReturnType<MemoryIntentBinding>>;
type MemoryIntentControlPlane = CreateMemoryIntentBindingOptions['controlPlane'];
type MutationMemoryIntentInput = Omit<MemoryIntentInput, 'operation'> & {
  readonly operation: 'remember' | 'correct' | 'forget' | 'approve' | 'reject';
};
type DecisionMemoryIntentInput = Omit<MemoryIntentInput, 'operation'> & {
  readonly operation: 'approve' | 'reject';
};
type ForgetMemoryIntentInput = Omit<MemoryIntentInput, 'operation'> & {
  readonly operation: 'forget';
};
type RememberMemoryIntentInput = Omit<MemoryIntentInput, 'operation'> & {
  readonly operation: 'remember' | 'correct';
};

interface AuthorizedMemoryIntent {
  readonly currentUserTurn: ReturnType<CreateMemoryIntentBindingOptions['getCurrentUserTurn']>;
  readonly quote: string;
  readonly presentedBodyFingerprint?: string;
}

interface DisplayedMemoryTarget {
  readonly refId: string;
  readonly searchableText: string;
  readonly bodyFingerprint?: string;
}

interface MemoryIntentBindingContext {
  memories: readonly DisplayedMemoryTarget[];
  decisions: readonly DisplayedMemoryTarget[];
  presentedMemories: readonly {
    readonly refId: string;
    readonly bodyFingerprint: string;
    readonly searchableText?: string;
  }[];
  presentedDecisionRefIds: readonly string[];
}

export function activateMemoryIntentTool(
  activeTools: readonly string[],
  enabled: boolean,
): string[] {
  const withoutIntent = activeTools.filter((name) => name !== MEMORY_INTENT_TOOL_NAME);
  return enabled ? [...withoutIntent, MEMORY_INTENT_TOOL_NAME] : withoutIntent;
}

export function extractPresentedMemoryTargetRefs(
  messages: readonly { readonly role: string; readonly content: unknown }[],
): {
  readonly memories: readonly {
    readonly refId: string;
    readonly bodyFingerprint: string;
    readonly searchableText?: string;
  }[];
  readonly decisionRefIds: readonly string[];
} {
  const finalAssistantIndex = findLastMessageIndex(messages, (message) => (
    message.role === 'assistant' && messageText(message.content).trim().length > 0
  ));
  if (finalAssistantIndex < 0) return { memories: [], decisionRefIds: [] };
  const priorUserIndex = findLastMessageIndex(messages, (message, index) => (
    index < finalAssistantIndex && isGenuineUserMessage(message)
  ));
  const finalText = messageText(messages[finalAssistantIndex]?.content).trim();
  const calls = new Map<string, string>();
  let memories: readonly { readonly refId: string; readonly bodyFingerprint: string }[] = [];
  let decisionRefIds: readonly string[] = [];
  for (const message of messages.slice(priorUserIndex + 1, finalAssistantIndex)) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isMemoryPresentationCall(block)) {
        calls.set(block.id, block.input.operation);
        continue;
      }
      if (!isToolResultBlock(block)) continue;
      const operation = calls.get(block.tool_use_id);
      const text = messageText(block.content);
      if (operation === 'list') {
        memories = extractVisibleMemoryReceipts(text, finalText);
      } else if (operation === 'decisions' || operation === 'show') {
        decisionRefIds = extractVisibleDecisionReceipts(text, finalText);
      }
    }
  }
  return { memories, decisionRefIds };
}

function extractVisibleMemoryReceipts(
  toolResult: string,
  visibleAssistantText: string,
): readonly {
  readonly refId: string;
  readonly bodyFingerprint: string;
  readonly searchableText?: string;
}[] {
  const lines = toolResult.split(/\r?\n/u);
  const visible: Array<{
    readonly value: {
      readonly refId: string;
      readonly bodyFingerprint: string;
      readonly searchableText?: string;
    };
    readonly position: number;
    readonly ordinal?: number;
  }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^\d+\.\s+(.+?)\s+\((memdir:[^;)]+?\.md); version=([a-z0-9:]+)\)$/iu
      .exec(lines[index]?.trim() ?? '');
    if (header === null) continue;
    const body = lines.slice(index + 1).find((line) => line.trim().length > 0) ?? '';
    const position = visibleAnchorPosition(visibleAssistantText, [header[1]!, body], 1);
    if (position === undefined) continue;
    const searchableText = visibleSearchableAnchors(visibleAssistantText, [header[1]!, body]).join('\n');
    visible.push({
      value: {
        refId: header[2]!,
        bodyFingerprint: header[3]!,
        ...(searchableText.length === 0 ? {} : { searchableText }),
      },
      position,
      ...visibleItemOrdinal(visibleAssistantText, [header[1]!, body]),
    });
  }
  return orderedVisibleReceipts(visible);
}

function extractVisibleDecisionReceipts(
  toolResult: string,
  visibleAssistantText: string,
): readonly string[] {
  const visible: Array<{ readonly value: string; readonly position: number; readonly ordinal?: number }> = [];
  const lines = toolResult.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const header = /^(?:\d+\.\s+)?(.+?)\s+\((memory:[a-z0-9._:-]+@[a-f0-9]{16})\)$/iu
      .exec(line.trim());
    if (header === null) continue;
    const details = lines.slice(index + 1, index + 4)
      .filter((detail) => /^(?:why|proposed):/iu.test(detail.trim()))
      .map((detail) => detail.replace(/^\s*(?:why|proposed):\s*/iu, ''));
    const position = visibleAnchorPosition(
      visibleAssistantText,
      [header[1]!, ...details],
      details.length > 0 ? 2 : 1,
    );
    if (position !== undefined) {
      visible.push({
        value: header[2]!,
        position,
        ...visibleItemOrdinal(visibleAssistantText, [header[1]!]),
      });
    }
  }
  return orderedVisibleReceipts(visible);
}

function visibleAnchorPosition(
  visibleAssistantText: string,
  anchors: readonly string[],
  minimumMatches: number,
): number | undefined {
  const visible = normalizedPresentation(visibleAssistantText).toLocaleLowerCase();
  const positions = anchors.flatMap((anchor) => {
    const normalized = normalizedPresentation(anchor).toLocaleLowerCase();
    if (normalized.length < 4) return [];
    const needle = visible.includes(normalized) ? normalized : normalized.slice(0, 32);
    const first = visible.indexOf(needle);
    if (first < 0) return [];
    return [first];
  });
  return positions.length >= minimumMatches ? Math.min(...positions) : undefined;
}

function visibleSearchableAnchors(
  visibleAssistantText: string,
  anchors: readonly string[],
): readonly string[] {
  const visible = normalizedPresentation(visibleAssistantText).toLocaleLowerCase();
  return anchors.flatMap((anchor) => {
    const trimmed = anchor.trim();
    const normalized = normalizedPresentation(trimmed).toLocaleLowerCase();
    if (normalized.length < 4) return [];
    if (visible.includes(normalized)) return [trimmed];
    const prefix = normalized.slice(0, 32);
    return visible.includes(prefix) ? [trimmed.slice(0, 32)] : [];
  });
}

function orderedVisibleReceipts<T>(
  receipts: readonly { readonly value: T; readonly position: number; readonly ordinal?: number }[],
): readonly T[] {
  if (receipts.length > 1) {
    const ordinals = receipts.map((receipt) => receipt.ordinal);
    if (ordinals.some((ordinal) => ordinal === undefined)
      || new Set(ordinals).size !== receipts.length) return [];
    const sorted = [...receipts].sort((left, right) => left.ordinal! - right.ordinal!);
    if (sorted.some((receipt, index) => receipt.ordinal !== index)) return [];
    return sorted.map((receipt) => receipt.value);
  }
  if (new Set(receipts.map((receipt) => receipt.position)).size !== receipts.length) return [];
  return receipts.map((receipt) => receipt.value);
}

function visibleItemOrdinal(
  visibleAssistantText: string,
  anchors: readonly string[],
): { readonly ordinal: number } | Record<string, never> {
  const normalizedAnchors = anchors
    .map((anchor) => normalizedPresentation(anchor).toLocaleLowerCase())
    .filter((anchor) => anchor.length >= 4);
  const matches = visibleAssistantText.split(/\r?\n/u).flatMap((rawLine) => {
    const line = normalizedPresentation(rawLine);
    const numbered = /^\s*(\d{1,2})[.)、]\s+(.+)$/u.exec(line);
    if (numbered === null) return [];
    const content = numbered[2]!.toLocaleLowerCase();
    const matched = normalizedAnchors.some((anchor) => (
      content.includes(anchor) || content.includes(anchor.slice(0, 32))
    ));
    return matched ? [Number(numbered[1]) - 1] : [];
  });
  const uniqueMatches = [...new Set(matches)];
  return uniqueMatches.length === 1 ? { ordinal: uniqueMatches[0]! } : {};
}

function findLastMessageIndex<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!, index)) return index;
  }
  return -1;
}

function isGenuineUserMessage(message: { readonly role: string; readonly content: unknown }): boolean {
  return message.role === 'user'
    && (!Array.isArray(message.content) || !message.content.some(isToolResultBlock));
}

function normalizedPresentation(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function isMemoryPresentationCall(value: unknown): value is {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: typeof MEMORY_INTENT_TOOL_NAME;
  readonly input: { readonly operation: 'list' | 'decisions' | 'show' };
} {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value) || value.type !== 'tool_use'
    || !('id' in value) || typeof value.id !== 'string'
    || !('name' in value) || value.name !== MEMORY_INTENT_TOOL_NAME
    || !('input' in value) || typeof value.input !== 'object' || value.input === null
    || !('operation' in value.input)) return false;
  return value.input.operation === 'list'
    || value.input.operation === 'decisions'
    || value.input.operation === 'show';
}

function isToolResultBlock(value: unknown): value is {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: unknown;
} {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'tool_result'
    && 'tool_use_id' in value
    && typeof value.tool_use_id === 'string'
    && 'content' in value;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => (
    typeof block === 'object'
      && block !== null
      && 'type' in block
      && block.type === 'text'
      && 'text' in block
      && typeof block.text === 'string'
      ? [block.text]
      : []
  )).join('\n');
}

export function createMemoryIntentBinding(
  options: CreateMemoryIntentBindingOptions,
): MemoryIntentBinding {
  const context: MemoryIntentBindingContext = {
    memories: [],
    decisions: [],
    presentedMemories: options.presentedMemories ?? [],
    presentedDecisionRefIds: options.presentedDecisionRefIds ?? [],
  };
  return async (input) => {
    const presented = options.getPresentedTargets?.();
    if (presented !== undefined) {
      context.presentedMemories = presented.memories;
      context.presentedDecisionRefIds = presented.decisionRefIds;
    }
    switch (input.operation) {
      case 'list': return listAcceptedMemories(options.controlPlane, context);
      case 'decisions': return listMemoryDecisions(options.controlPlane, context);
      case 'show': return showMemoryDecision(options.controlPlane, input.targetRefId);
      case 'approve':
      case 'reject':
        return handleAuthorizedDecision(
          { ...input, operation: input.operation },
          options,
          context,
        );
      case 'forget':
        return handleAuthorizedForget({ ...input, operation: 'forget' }, options, context);
      case 'remember':
      case 'correct':
        return handleAuthorizedRemember({ ...input, operation: input.operation }, options, context);
    }
  };
}

async function handleAuthorizedDecision(
  input: DecisionMemoryIntentInput,
  options: CreateMemoryIntentBindingOptions,
  context: MemoryIntentBindingContext,
): Promise<MemoryIntentReceipt> {
  const authorization = authorizeMemoryIntent(input, options.getCurrentUserTurn, context);
  if ('receipt' in authorization) return authorization.receipt;
  const reason = input.reason?.trim();
  return handleMemoryDecision(
    input,
    options.controlPlane,
    reason !== undefined && reason.length > 0 && authorization.quote.includes(reason)
      ? reason
      : undefined,
  );
}

async function handleAuthorizedForget(
  input: ForgetMemoryIntentInput,
  options: CreateMemoryIntentBindingOptions,
  context: MemoryIntentBindingContext,
): Promise<MemoryIntentReceipt> {
  const authorization = authorizeMemoryIntent(input, options.getCurrentUserTurn, context);
  if ('receipt' in authorization) return authorization.receipt;
  return forgetMemory(input, authorization, options);
}

async function handleAuthorizedRemember(
  input: RememberMemoryIntentInput,
  options: CreateMemoryIntentBindingOptions,
  context: MemoryIntentBindingContext,
): Promise<MemoryIntentReceipt> {
  const authorization = authorizeMemoryIntent(input, options.getCurrentUserTurn, context);
  if ('receipt' in authorization) return authorization.receipt;
  return rememberMemory(input, authorization, options);
}

async function listAcceptedMemories(
  controlPlane: MemoryIntentControlPlane,
  context: MemoryIntentBindingContext,
): Promise<MemoryIntentReceipt> {
  const refs = await controlPlane.listRefs({ kinds: ['memdir'], lifecycles: ['active', 'trusted'] });
  const snapshots = await Promise.all(refs.slice(0, 20).map((ref) => controlPlane.readRef(ref)));
  const memories = snapshots.map(({ ref, body, bodyFingerprint }) => ({
    refId: memoryMutationHandle(ref),
    title: ref.title ?? ref.id,
    body: parseMemoryFile(body).body.trim().slice(0, 1_024),
    bodyFingerprint,
  }));
  context.memories = memories.map((memory) => ({
    refId: memory.refId,
    searchableText: `${memory.title}\n${memory.body}`,
    bodyFingerprint: memory.bodyFingerprint,
  }));
  return {
    status: 'listed',
    operation: 'list',
    total: refs.length,
    memories,
  };
}

async function listMemoryDecisions(
  controlPlane: MemoryIntentControlPlane,
  context: MemoryIntentBindingContext,
): Promise<MemoryIntentReceipt> {
  const proposals = await controlPlane.listInbox();
  const visible = proposals.slice(0, 20);
  const decisions = visible.map(decisionReceipt);
  context.decisions = decisions.map((decision) => ({
    refId: decision.refId,
    searchableText: [decision.summary, decision.rationale, decision.proposedBody ?? ''].join('\n'),
  }));
  return {
    status: 'decisions',
    operation: 'decisions',
    total: proposals.length,
    decisions,
  };
}

async function showMemoryDecision(
  controlPlane: MemoryIntentControlPlane,
  target: string | undefined,
): Promise<MemoryIntentReceipt> {
  const targetRefId = target?.trim();
  if (targetRefId === undefined || targetRefId.length === 0) {
    return {
      status: 'rejected',
      operation: 'show',
      reason: 'Show requires one exact decision ref from the decisions list',
    };
  }
  const proposal = await controlPlane.showProposal(parseDecisionRef(targetRefId).proposalId);
  if (proposal === undefined) {
    return { status: 'rejected', operation: 'show', reason: `Memory decision not found: ${targetRefId}` };
  }
  const decision = decisionReceipt(proposal);
  return { status: 'shown', operation: 'show', decision };
}

function authorizeMemoryIntent(
  input: MutationMemoryIntentInput,
  getCurrentUserTurn: CreateMemoryIntentBindingOptions['getCurrentUserTurn'],
  context: MemoryIntentBindingContext,
): AuthorizedMemoryIntent | { readonly receipt: MemoryIntentReceipt } {
  const currentUserTurn = getCurrentUserTurn();
  const quote = input.userQuote?.trim() ?? '';
  const targetRefId = input.targetRefId?.trim();
  const authorizedClause = findAuthorizedInstructionClause(
    currentUserTurn.text,
    quote,
    input.operation,
  );
  const boundTarget = authorizedClause === undefined
    ? undefined
    : boundMutationTarget(input, authorizedClause, targetRefId, context);
  if (authorizedClause !== undefined && boundTarget !== undefined) {
    return {
      currentUserTurn,
      quote: authorizedClause,
      ...(boundTarget.bodyFingerprint === undefined
        ? {}
        : { presentedBodyFingerprint: boundTarget.bodyFingerprint }),
    };
  }
  return {
    receipt: {
      status: 'rejected',
      operation: input.operation,
      reason: 'userQuote must explicitly authorize this operation and exact target in the current user turn',
    },
  };
}

function boundMutationTarget(
  input: MutationMemoryIntentInput,
  quote: string,
  targetRefId: string | undefined,
  context: MemoryIntentBindingContext,
): { readonly bodyFingerprint?: string } | undefined {
  if (input.operation === 'remember') return targetRefId === undefined ? {} : undefined;
  if (targetRefId === undefined) return undefined;
  if (quote.toLocaleLowerCase().includes(targetRefId.toLocaleLowerCase())) return {};
  const targets = input.operation === 'correct' || input.operation === 'forget'
    ? context.memories
    : context.decisions;
  const presentedTargets = input.operation === 'correct' || input.operation === 'forget'
    ? context.presentedMemories
    : context.presentedDecisionRefIds.map((refId) => ({ refId }));
  const selected = naturallySelectedTarget(
    quote,
    targets,
    presentedTargets,
    input.operation === 'correct' || input.operation === 'forget',
  );
  return selected?.refId === targetRefId
    ? (selected.bodyFingerprint === undefined ? {} : { bodyFingerprint: selected.bodyFingerprint })
    : undefined;
}

function naturallySelectedTarget(
  quote: string,
  targets: readonly DisplayedMemoryTarget[],
  presented: readonly {
    readonly refId: string;
    readonly bodyFingerprint?: string;
    readonly searchableText?: string;
  }[],
  allowCurrentDescription: boolean,
): DisplayedMemoryTarget | undefined {
  const presentedTargets = presented.map((receipt) => ({
    refId: receipt.refId,
    searchableText: receipt.searchableText ?? '',
    ...(receipt.bodyFingerprint === undefined ? {} : { bodyFingerprint: receipt.bodyFingerprint }),
  }));
  const ordinal = referencedOrdinal(quote);
  if (ordinal !== undefined) return presentedTargets[ordinal];
  const descriptionTargets = mergeDisplayedTargets(presentedTargets, targets);
  if (allowCurrentDescription && hasSubstantiveDescription(quote)) {
    const match = uniqueDescriptionMatch(quote, descriptionTargets);
    if (match !== undefined) return match;
  }
  if (hasDeicticReference(quote)) {
    return presentedTargets.length === 1 ? presentedTargets[0] : undefined;
  }
  if (!allowCurrentDescription) return undefined;
  return uniqueDescriptionMatch(quote, descriptionTargets);
}

function mergeDisplayedTargets(
  presented: readonly DisplayedMemoryTarget[],
  current: readonly DisplayedMemoryTarget[],
): readonly DisplayedMemoryTarget[] {
  const targets = new Map<string, DisplayedMemoryTarget>();
  for (const target of [...presented, ...current]) {
    if (target.searchableText.trim().length > 0) targets.set(target.refId, target);
  }
  return [...targets.values()];
}

function uniqueDescriptionMatch(
  quote: string,
  targets: readonly DisplayedMemoryTarget[],
): DisplayedMemoryTarget | undefined {
  const matches = targets.filter((target) => descriptionMatchesTarget(quote, target.searchableText));
  return matches.length === 1 ? matches[0] : undefined;
}

function hasSubstantiveDescription(value: string): boolean {
  return meaningfulEnglishWords(value).length >= 2
    || (/\p{Script=Han}/u.test(value) && compactDescription(value).length >= 4);
}

function referencedOrdinal(text: string): number | undefined {
  const normalized = text.toLocaleLowerCase();
  const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];
  const chineseIndex = chinese.findIndex((name) => normalized.includes(`第${name}条`));
  if (chineseIndex >= 0) return chineseIndex;
  const numeric = /(?:\b([1-9]|1\d|20)(?:st|nd|rd|th)\b|第([1-9]|1\d|20)条)/u.exec(normalized);
  if (numeric !== null) return Number(numeric[1] ?? numeric[2]) - 1;
  const names = [
    'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
    'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
    'eighteenth', 'nineteenth', 'twentieth',
  ];
  const index = names.findIndex((name) => new RegExp(`\\b${name}\\b`, 'u').test(normalized));
  return index < 0 ? undefined : index;
}

function hasDeicticReference(text: string): boolean {
  const normalized = text.toLocaleLowerCase();
  return /\b(?:that memory|this memory|that one|the one|it)\b/iu.test(normalized)
    || ['刚才那条', '这条', '那条', '该记忆'].some((marker) => normalized.includes(marker));
}

function descriptionMatchesTarget(quote: string, searchableText: string): boolean {
  const queryWords = meaningfulEnglishWords(quote);
  const targetWords = new Set(meaningfulEnglishWords(searchableText));
  if (queryWords.filter((word) => targetWords.has(word)).length >= 2) return true;
  if (!/\p{Script=Han}/u.test(quote)) return false;
  const compactQuery = compactDescription(quote);
  const compactTarget = compactDescription(searchableText);
  for (let index = 0; index <= compactQuery.length - 4; index += 1) {
    if (compactTarget.includes(compactQuery.slice(index, index + 4))) return true;
  }
  return false;
}

function meaningfulEnglishWords(value: string): readonly string[] {
  const ignored = new Set([
    'approve', 'change', 'correct', 'delete', 'forget', 'memory', 'remember', 'remove', 'replace',
    'that', 'the', 'this', 'update', 'with', 'please', 'first', 'second', 'third',
  ]);
  return value.toLocaleLowerCase().match(/[a-z0-9_-]{3,}/gu)
    ?.filter((word) => !ignored.has(word)) ?? [];
}

function compactDescription(value: string): string {
  return value.toLocaleLowerCase()
    .replace(/(?:请|请你|麻烦你|帮我|把|记忆|这条|那条|刚才|忘掉|忘记|删除|移除|清除|修正|更正|修改|改成|批准|同意|拒绝)/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

async function handleMemoryDecision(
  input: DecisionMemoryIntentInput,
  controlPlane: MemoryIntentControlPlane,
  authorizedReason: string | undefined,
): Promise<MemoryIntentReceipt> {
  const targetRefId = input.targetRefId?.trim();
  if (targetRefId === undefined || targetRefId.length === 0) {
    return {
      status: 'rejected',
      operation: input.operation,
      reason: `${input.operation} requires one exact Memory decision ref`,
    };
  }
  const parsedTarget = parseDecisionRef(targetRefId);
  const proposal = await controlPlane.showProposal(parsedTarget.proposalId);
  if (proposal === undefined) {
    return {
      status: 'rejected',
      operation: input.operation,
      reason: `Memory decision not found: ${targetRefId}`,
    };
  }
  if (parsedTarget.revision === undefined
    || parsedTarget.revision !== memoryProposalRevision(proposal)) {
    return {
      status: 'needs_clarification',
      operation: input.operation,
      reason: 'Review the current version of this decision before changing it',
    };
  }
  if (input.operation === 'reject') {
    return rejectMemoryDecision(controlPlane, proposal, parsedTarget.revision, authorizedReason);
  }
  return approveMemoryDecision(controlPlane, proposal, parsedTarget.revision);
}

async function rejectMemoryDecision(
  controlPlane: MemoryIntentControlPlane,
  proposal: MemoryActionProposal,
  revision: string,
  reason: string | undefined,
): Promise<MemoryIntentReceipt> {
  const result = await controlPlane.rejectProposal(proposal.id, reason, revision);
  return result.rejected
    ? { status: 'decision_rejected', operation: 'reject', changedRefIds: [] }
    : {
        status: 'rejected',
        operation: 'reject',
        reason: result.skippedReason ?? 'Memory decision was not rejected',
      };
}

async function approveMemoryDecision(
  controlPlane: MemoryIntentControlPlane,
  proposal: MemoryActionProposal,
  revision: string,
): Promise<MemoryIntentReceipt> {
  const result = await controlPlane.approveProposal(
    proposal.id,
    proposal.expectedFingerprints,
    revision,
  );
  return result.applied
    ? {
        status: 'approved',
        operation: 'approve',
        changedRefIds: result.changedRefs.map((ref) => ref.id),
      }
    : {
        status: 'rejected',
        operation: 'approve',
        reason: result.skippedReason ?? 'Memory decision was not applied',
      };
}

async function forgetMemory(
  input: ForgetMemoryIntentInput,
  authorization: AuthorizedMemoryIntent,
  options: CreateMemoryIntentBindingOptions,
): Promise<MemoryIntentReceipt> {
  const targetRefId = input.targetRefId?.trim();
  if (targetRefId === undefined || targetRefId.length === 0) {
    return {
      status: 'needs_clarification',
      operation: 'forget',
      reason: 'Forget requires one exact Memory ref; list memories and disambiguate first',
    };
  }
  const matches = (await options.controlPlane.listRefs({ kinds: ['memdir'], includePrivate: true }))
    .filter((ref) => memoryMutationHandle(ref) === targetRefId || ref.id === targetRefId);
  if (matches.length !== 1) {
    return unresolvedForgetReceipt(options, targetRefId, matches.length);
  }
  const target = matches[0]!;
  const snapshot = await options.controlPlane.readRef(target);
  const result = await options.controlPlane.forgetRef(
    targetRefId,
    authorization.presentedBodyFingerprint,
  );
  recordForgetDisposition(options, target, snapshot.body, result);
  return result.acknowledged
    ? { status: 'forgotten', operation: 'forget', changedRefIds: [targetRefId] }
    : {
        status: 'needs_clarification',
        operation: 'forget',
        reason: result.warnings[0] ?? `Memory ref not found: ${targetRefId}`,
      };
}

function unresolvedForgetReceipt(
  options: CreateMemoryIntentBindingOptions,
  targetRefId: string,
  matchCount: number,
): MemoryIntentReceipt {
  options.onHandledOperation?.({
    operation: 'forget',
    disposition: 'blocked',
    targetRefIds: [targetRefId],
  });
  return {
    status: 'needs_clarification',
    operation: 'forget',
    reason: matchCount === 0
      ? `Memory ref not found: ${targetRefId}`
      : `Memory ref is ambiguous across scopes: ${targetRefId}`,
  };
}

function recordForgetDisposition(
  options: CreateMemoryIntentBindingOptions,
  target: MemoryItemRef,
  body: string,
  result: MemoryLifecycleOperationResult,
): void {
  options.onHandledOperation?.({
    operation: 'forget',
    disposition: result.acknowledged ? 'applied' : 'blocked',
    ...(result.acknowledged ? { statement: parseMemoryFile(body).body } : {}),
    ...(target.claimKey === undefined ? {} : { claimKey: target.claimKey }),
    targetRefIds: [target.id],
  });
}

async function rememberMemory(
  input: RememberMemoryIntentInput,
  authorization: AuthorizedMemoryIntent,
  options: CreateMemoryIntentBindingOptions,
): Promise<MemoryIntentReceipt> {
  const prepared = prepareRememberInput(input, authorization);
  if ('receipt' in prepared) {
    const safeStatement = input.statement === undefined
      || !authorization.quote.includes(input.statement.trim())
      ? undefined
      : sanitizePromptSafeMemoryClaim(input.statement.trim(), 1_024);
    const targetRefIds = input.targetRefId === undefined ? [] : [input.targetRefId];
    if (safeStatement !== undefined || targetRefIds.length > 0) {
      options.onHandledOperation?.({
        operation: input.operation,
        disposition: 'blocked',
        ...(safeStatement === undefined ? {} : { statement: safeStatement }),
        targetRefIds,
      });
    }
    return prepared.receipt;
  }
  const handledTargetRefIds = await resolveHandledTargetRefIds(options.controlPlane, prepared.input.targetRefId);
  const result = await options.controlPlane.remember(prepared.input);
  if (result.status === 'needs_clarification'
    || result.status === 'needs_review'
    || result.status === 'rejected') {
    options.onHandledOperation?.({
      operation: input.operation,
      disposition: result.status === 'needs_review' ? 'decision' : 'blocked',
      statement: prepared.input.statement,
      ...(prepared.input.claimKey === undefined ? {} : { claimKey: prepared.input.claimKey }),
      targetRefIds: handledTargetRefIds,
    });
    return {
      status: result.status,
      operation: input.operation,
      reason: result.reason ?? 'Memory was not changed',
      ...(result.status === 'needs_review' ? { decisionRefIds: result.proposalIds } : {}),
    };
  }
  options.onHandledOperation?.({
    operation: input.operation,
    disposition: 'applied',
    statement: prepared.input.statement,
    ...(prepared.input.claimKey === undefined ? {} : { claimKey: prepared.input.claimKey }),
    targetRefIds: result.changedRefIds,
  });
  return { status: result.status, operation: input.operation, changedRefIds: result.changedRefIds };
}

async function resolveHandledTargetRefIds(
  controlPlane: MemoryIntentControlPlane,
  targetRefId: string | undefined,
): Promise<readonly string[]> {
  if (targetRefId === undefined) return [];
  const matches = (await controlPlane.listRefs({ kinds: ['memdir'], includePrivate: true }))
    .filter((ref) => ref.id === targetRefId || memoryMutationHandle(ref) === targetRefId);
  return matches.length === 1 ? [matches[0]!.id] : [targetRefId];
}

function prepareRememberInput(
  input: RememberMemoryIntentInput,
  authorization: AuthorizedMemoryIntent,
): { readonly input: MemoryRememberInput } | { readonly receipt: MemoryIntentReceipt } {
  const rawStatement = input.statement?.trim() ?? '';
  const invalidReason = validateRememberStatement(input, rawStatement, authorization.quote);
  if (invalidReason !== undefined) {
    return {
      receipt: { status: 'needs_clarification', operation: input.operation, reason: invalidReason },
    };
  }
  const statement = sanitizePromptSafeMemoryClaim(rawStatement, 1_024);
  const userQuote = sanitizePromptSafeMemoryClaim(authorization.quote, 512);
  if (statement === undefined || userQuote === undefined) {
    return {
      receipt: {
        status: 'rejected',
        operation: input.operation,
        reason: 'The requested Memory is empty, sensitive, or restricted and was not stored automatically',
      },
    };
  }
  const evidenceRef = createIntentEvidenceRef(input, authorization);
  return {
    input: {
      operation: input.operation,
      statement,
      evidenceRef,
      ...(input.targetRefId === undefined ? {} : { targetRefId: input.targetRefId }),
      ...(authorization.presentedBodyFingerprint === undefined
        ? {}
        : { expectedTargetFingerprint: authorization.presentedBodyFingerprint }),
      ...(input.claimKind === undefined ? {} : { claimKind: input.claimKind }),
      ...(input.claimKey === undefined ? {} : { claimKey: input.claimKey }),
    },
  };
}

function validateRememberStatement(
  input: RememberMemoryIntentInput,
  statement: string,
  currentUserText: string,
): string | undefined {
  if (statement.length === 0 || !currentUserText.includes(statement)) {
    return 'The durable statement must be an exact claim from the current user message';
  }
  if (!statementCoversAuthorizedClaim(input.operation, statement, currentUserText)) {
    return 'The durable statement must include the complete claim and all qualifiers from the authorized clause';
  }
  if (statement.length > 1_024) return 'The requested Memory is too broad; ask the user to narrow it to one claim';
  if (input.operation === 'remember' && input.claimKind === undefined) {
    return 'Classify the exact claim as a fact, policy, preference, or procedure';
  }
  if (input.operation === 'remember' && !isStableClaimKey(input.claimKey)) {
    return 'A stable semantic claimKey is required for every new Memory claim';
  }
  return undefined;
}

function statementCoversAuthorizedClaim(
  operation: RememberMemoryIntentInput['operation'],
  statement: string,
  clause: string,
): boolean {
  const first = clause.indexOf(statement);
  if (first < 0 || clause.indexOf(statement, first + statement.length) >= 0) return false;
  const prefix = clause.slice(0, first).trim();
  const suffix = clause.slice(first + statement.length).trim();
  const marker = operation === 'remember'
    ? '(?:remember|memorize|记住|记下)'
    : '(?:correct|update|replace|change|修正|更正|修改|改成)';
  const englishLead = staticText("t12.tools/memory-intent.0");
  const cjkLead = '(?:请|请你|麻烦|麻烦你|劳烦|帮我|请帮我|我要你|我想让你|我希望你)?';
  const rememberPrefix = new RegExp(`^(?:${englishLead}${marker}(?:\\s+(?:that|to))?\\s*[,，:：]?|${cjkLead}${marker}\\s*[,，:：]?)$`, 'iu');
  const correctionPrefix = new RegExp(
    `^(?:${englishLead}${marker}(?:\\s+.+?)?\\s+(?:to|as)\\s*[,，:：]?|${cjkLead}(?:把.+)?${marker}\\s*[,，:：]?)$`,
    'iu',
  );
  const suffixPattern = new RegExp(`^[,，]?\\s*(?:(?:please\\s+)?${marker}|(?:请|请你)?${marker})[.。]?$`, 'iu');
  const emptyFraming = (value: string) => /^[\s,，:：.。]*$/u.test(value);
  return ((operation === 'remember' ? rememberPrefix : correctionPrefix).test(prefix)
      && emptyFraming(suffix))
    || (emptyFraming(prefix) && suffixPattern.test(suffix));
}

function createIntentEvidenceRef(
  input: RememberMemoryIntentInput,
  authorization: AuthorizedMemoryIntent,
): string {
  return `user-intent:${createHash('sha256')
    .update([
      authorization.currentUserTurn.turnId,
      input.operation,
      authorization.quote,
    ].join('\0'))
    .digest('hex')
    .slice(0, 24)}`;
}

export async function toolMemoryIntent(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const operation = memoryIntentOperation(input.operation);
  if (operation === undefined) return '[Memory operation rejected: operation is required]';
  if (ctx.memoryManagementIntent === undefined) {
    return runLegacyMemoryIntent(operation, input, ctx);
  }
  const receipt = await ctx.memoryManagementIntent(memoryIntentInput(operation, input));
  return formatMemoryIntentReceipt(receipt);
}

function memoryIntentOperation(value: unknown): MemoryIntentInput['operation'] | undefined {
  return value === 'list' || value === 'remember' || value === 'correct' || value === 'forget'
    || value === 'decisions' || value === 'show' || value === 'approve' || value === 'reject'
    ? value
    : undefined;
}

async function runLegacyMemoryIntent(
  operation: MemoryIntentInput['operation'],
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if ((operation !== 'remember' && operation !== 'correct') || ctx.memoryIntent === undefined) {
    return '[Memory management unavailable: no root Memory control plane is bound]';
  }
  const statement = typeof input.statement === 'string' ? input.statement : '';
  const userQuote = typeof input.userQuote === 'string' ? input.userQuote : '';
  if (statement.trim().length === 0 || userQuote.trim().length === 0) {
    return '[Memory intent rejected: operation, statement, and userQuote are required]';
  }
  const legacy = await ctx.memoryIntent({ operation, statement, userQuote });
  return legacy.status === 'captured'
    ? `[Memory intent captured for end-of-episode governed submission: ${legacy.operation}; no durable review job exists yet and Memory is not persisted or applied]`
    : `[Memory intent rejected: ${legacy.reason}]`;
}

function memoryIntentInput(
  operation: MemoryIntentInput['operation'],
  input: Record<string, unknown>,
): MemoryIntentInput {
  const claimKind = input.claimKind === 'fact' || input.claimKind === 'policy'
    || input.claimKind === 'preference' || input.claimKind === 'procedure'
    ? input.claimKind
    : undefined;
  return {
    operation,
    ...(typeof input.statement === 'string' ? { statement: input.statement } : {}),
    ...(typeof input.targetRefId === 'string' ? { targetRefId: input.targetRefId } : {}),
    ...(claimKind === undefined ? {} : { claimKind }),
    ...(typeof input.claimKey === 'string' ? { claimKey: input.claimKey } : {}),
    ...(typeof input.userQuote === 'string' ? { userQuote: input.userQuote } : {}),
    ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
  };
}

function formatMemoryIntentReceipt(receipt: MemoryIntentReceipt): string {
  if (receipt.status === 'listed') {
    return formatListedMemoryReceipt(receipt);
  }
  if (receipt.status === 'remembered') return `[Memory remembered: ${receipt.changedRefIds.join(', ')}]`;
  if (receipt.status === 'updated') return `[Memory updated: ${receipt.changedRefIds.join(', ')}]`;
  if (receipt.status === 'already_known') return `[Memory already known: ${receipt.changedRefIds.join(', ')}]`;
  if (receipt.status === 'forgotten') return `[Memory forgotten: ${receipt.changedRefIds.join(', ')}]`;
  if (receipt.status === 'decisions') {
    return formatDecisionListReceipt(receipt);
  }
  if (receipt.status === 'shown') return `[Memory decision]\n${formatDecision(receipt.decision)}`;
  if (receipt.status === 'approved') return `[Memory decision approved: ${receipt.changedRefIds.join(', ') || 'applied'}]`;
  if (receipt.status === 'decision_rejected') return '[Memory decision rejected]';
  if (receipt.status === 'needs_clarification'
    || receipt.status === 'needs_review'
    || receipt.status === 'rejected') {
    const decisions = receipt.decisionRefIds?.length
      ? `; decisions: ${receipt.decisionRefIds.join(', ')}`
      : '';
    return `[Memory ${receipt.status}: ${receipt.reason}${decisions}]`;
  }
  return '[Memory operation rejected: invalid host receipt]';
}

function formatListedMemoryReceipt(receipt: Extract<MemoryIntentReceipt, { readonly status: 'listed' }>): string {
  if (receipt.memories.length === 0) return '[Memory list: no accepted memories yet]';
  return [
    `[Memory list: showing ${receipt.memories.length} of ${receipt.total}]`,
    ...receipt.memories.map((memory, index) => (
      `${index + 1}. ${memory.title} (${memory.refId}; version=${memory.bodyFingerprint})\n${memory.body}`
    )),
  ].join('\n');
}

function formatDecisionListReceipt(
  receipt: Extract<MemoryIntentReceipt, { readonly status: 'decisions' }>,
): string {
  if (receipt.decisions.length === 0) return '[Memory decisions: none need your attention]';
  return [
    `[Memory decisions: showing ${receipt.decisions.length} of ${receipt.total}]`,
    ...receipt.decisions.map((decision, index) => formatDecision(decision, index + 1)),
  ].join('\n');
}

function isStableClaimKey(value: string | undefined): boolean {
  return value !== undefined && /^[a-z0-9._:-]{1,160}$/i.test(value.trim());
}

function decisionReceipt(proposal: MemoryActionProposal) {
  const proposedBody = proposal.preview.diff === undefined
    ? undefined
    : parseMemoryFile(proposal.preview.diff).body.trim().replace(/\s+/g, ' ').slice(0, 1_024);
  return {
    refId: `${proposal.id}@${memoryProposalRevision(proposal)}`,
    summary: proposal.preview.summary,
    rationale: proposal.rationale,
    risk: proposal.risk,
    ...(proposedBody === undefined || proposedBody.length === 0 ? {} : { proposedBody }),
  };
}

function parseDecisionRef(value: string): { readonly proposalId: string; readonly revision?: string } {
  const separator = value.lastIndexOf('@');
  return separator <= 0
    ? { proposalId: value }
    : { proposalId: value.slice(0, separator), revision: value.slice(separator + 1) };
}

function findAuthorizedInstructionClause(
  currentUserText: string,
  quote: string,
  operation: MutationMemoryIntentInput['operation'],
): string | undefined {
  if (quote.length === 0 || !currentUserText.includes(quote)) {
    return undefined;
  }
  const markers: Readonly<Record<MutationMemoryIntentInput['operation'], readonly string[]>> = {
    remember: ['remember', 'memorize', '记住', '记下'],
    correct: ['correct', 'update', 'replace', 'change', '修正', '更正', '修改', '改成'],
    forget: ['forget', 'remove', 'delete', 'erase', '忘掉', '忘记', '删除', '移除', '清除'],
    approve: ['approve', 'accept', 'apply', '批准', '同意', '接受', '应用'],
    reject: ['reject', 'decline', 'dismiss', '拒绝', '否决', '不同意'],
  };
  const clauses = instructionClauses(currentUserText);
  const quoteClause = normalizeInstructionClause(quote);
  const matching = clauses
    .map((clause, index) => ({ clause, index }))
    .filter(({ clause }) => clause === quoteClause);
  if (matching.length !== 1) return undefined;
  const selected = matching[0]!;
  if (selected.index > 0 && hasNonAuthorizingLeadIn(clauses[selected.index - 1]!)) {
    return undefined;
  }
  if (clauses.slice(selected.index + 1).some(isInstructionRevocation)) {
    return undefined;
  }
  if (hasExampleContext(selected.clause)
    || hasDeferredMutationContext(selected.clause)
    || hasContradictoryMutationContext(selected.clause, operation)
    || (!markers[operation].some((marker) => isAffirmativeCommand(selected.clause, marker))
      && !isDecisionPerformative(selected.clause, operation))) {
    return undefined;
  }
  return quote.trim();
}

function isDecisionPerformative(
  clause: string,
  operation: MutationMemoryIntentInput['operation'],
): boolean {
  if (operation === 'approve') {
    return /^i\s+(?:approve|accept)\b/iu.test(clause)
      || /^我(?:批准|同意|接受)/u.test(clause);
  }
  if (operation === 'reject') {
    return /^i\s+(?:reject|decline)\b/iu.test(clause)
      || /^我(?:拒绝|不同意|否决)/u.test(clause);
  }
  return false;
}

function hasDeferredMutationContext(clause: string): boolean {
  return /\b(?:only\s+after|if\s+i\s+(?:ask|asked|confirm)|when\s+i\s+confirm|wait\s+until)\b/iu.test(clause)
    || /\b(?:for\s+now|just\s+this\s+once|for\s+this\s+task|in\s+this\s+(?:conversation|session)(?:\s+only)?|for\s+the\s+next\s+\S+(?:\s+\S+)?|while\s+we\s+work\s+on\s+this\s+task|during\s+this\s+(?:task|session)|until\s+\S+|only\s+this\s+(?:turn|time)|temporarily)\b/iu.test(clause)
    || /(?:如果|等我.+后|确认后再|之前先(?:问|确认)|先别|暂时|临时|仅限本轮|只(?:在|用于)这次|直到.+为止|今天先|接下来(?:一|1)小时|本会话|本次会话|在本任务期间)/u.test(clause);
}

function hasContradictoryMutationContext(
  clause: string,
  operation: MutationMemoryIntentInput['operation'],
): boolean {
  const englishTerms = {
    remember: 'remember|memorize',
    correct: 'change|correct|update|replace',
    forget: 'delete|remove|erase|forget',
    approve: 'apply|approve|accept',
    reject: 'reject|decline|dismiss',
  }[operation];
  const chineseTerms = {
    remember: '记住|记下',
    correct: '修改|修正|更正|改成',
    forget: '删除|移除|清除|忘掉|忘记',
    approve: '批准|同意|接受|应用',
    reject: '拒绝|否决|不同意',
  }[operation];
  const englishConnector = '(?:\\b(?:but|however|actually|and|yet|though)\\b[^.?!;]*|[,—–]\\s*)';
  const english = new RegExp(
    englishConnector
      + `(?:(?:do\\s+not|don't)\\s+(?:actually\\s+)?|not\\s+)(?:${englishTerms})\\b`,
    'iu',
  );
  const chinese = new RegExp(
    `(?:但是|但|不过|其实|并且|而且|也|[，、])[^。！？；]*(?:不要|别|不)(?:${chineseTerms})`,
    'u',
  );
  const genericEnglish = new RegExp(
    `${englishConnector}(?:(?:do\\s+not|don't)\\s+|not\\s+)`
      + '(?:do|execute|perform|save|store|persist|record)\\b',
    'iu',
  );
  const genericChinese = /(?:但是|但|不过|其实|并且|而且|也|[，、])[^。！？；]*(?:不要|别)(?:做|执行|保存|存储|持久化|记录)/u;
  return english.test(clause)
    || chinese.test(clause)
    || genericEnglish.test(clause)
    || genericChinese.test(clause)
    || /(?:仅限|只限)(?:本轮|这次|临时)/u.test(clause);
}

function isAffirmativeCommand(text: string, marker: string): boolean {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (/^[\x00-\x7f]+$/u.test(marker)) {
    const lead = staticText("t12.tools/memory-intent.1");
    return new RegExp(`^${lead}${escapedMarker}\\b`, 'iu').test(text);
  }
  const lead = '(?:请|请你|麻烦|麻烦你|劳烦|帮我|请帮我|我要你|我想让你|我希望你)?';
  const verbFirst = new RegExp(`^${lead}${escapedMarker}`, 'u');
  const objectFirst = new RegExp(`^(?:请|请你|麻烦|麻烦你|劳烦|帮我|请帮我)把[^。！？]+${escapedMarker}`, 'u');
  const suffix = new RegExp(`^[^。！？]+[，,]\\s*(?:请|请你)?${escapedMarker}$`, 'u');
  return verbFirst.test(text) || objectFirst.test(text) || suffix.test(text);
}

function instructionClauses(text: string): readonly string[] {
  return text.split(/(?:[?!。！？;；\n]+|\.+(?=\s|$))/u)
    .map(normalizeInstructionClause)
    .filter((clause) => clause.length > 0);
}

function isInstructionRevocation(clause: string): boolean {
  return /^(?:(?:but|however|actually)[,:]?\s*)?(?:no\b|cancel\b|never\s+mind\b|i\s+(?:changed\s+my\s+mind|withdraw\s+that\s+request)|(?:do\s+not|don't)\b|keep\s+it\b)/iu.test(clause)
    || /^(?:不(?:要|用了)|算了|取消|别|我(?:改变主意|撤回)|保留)/u.test(clause);
}

function hasNonAuthorizingLeadIn(clause: string): boolean {
  return /(?:for\s+example|example|the\s+assistant\s+(?:said|suggested)|do\s+not\s+(?:do|execute|follow)\s+the\s+following|quoted?|hypothetical)\s*:?$/iu.test(clause)
    || /(?:例如|比如|示例|假设|助手(?:说|建议)|不要执行(?:下面|以下)(?:这条)?|不要照做)\s*[:：]?$/u.test(clause);
}

function hasExampleContext(segment: string): boolean {
  const normalized = segment.toLocaleLowerCase();
  return ['for example', 'example:', 'e.g.', 'quoted example', '例如', '比如', '示例', '假设']
    .some((marker) => normalized.includes(marker));
}

function normalizeInstructionClause(value: string): string {
  return value.toLocaleLowerCase()
    .trim()
    .replace(/[.?!。！？;；]+$/u, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

function formatDecision(
  decision: {
    readonly refId: string;
    readonly summary: string;
    readonly rationale: string;
    readonly risk: 'low' | 'medium' | 'high';
    readonly proposedBody?: string;
  },
  index?: number,
): string {
  return [
    `${index === undefined ? '' : `${index}. `}${decision.summary} (${decision.refId})`,
    `why: ${decision.rationale}; risk: ${decision.risk}`,
    ...(decision.proposedBody === undefined ? [] : [`proposed: ${decision.proposedBody}`]),
  ].join('\n');
}
