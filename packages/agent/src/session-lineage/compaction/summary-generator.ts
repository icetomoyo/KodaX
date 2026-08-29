/**
 * ../../index.js Compaction Summary Generator
 *
 * Generates continuation-oriented summaries for compacted conversations.
 */

import { createHash } from 'crypto';
import type {
  KodaXBaseProvider,
  KodaXEphemeralSuffix,
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXTokenUsage,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { withProviderRequestCredential } from '@kodax-ai/llm';
import type { CompactionDetails } from './types.js';
import type { KodaXCompactMemorySeed } from '../../index.js';
import { serializeConversation } from './utils.js';

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization specialist.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Tool calls will be REJECTED and waste your only turn.

Your response must contain two parts:
1. <analysis> — your scratchpad for walking through messages (will be stripped)
2. <summary> — the structured continuation summary

Do not continue the conversation. Do not answer any user requests.`;

/**
 * Default neutral compaction summary prompts (v0.7.35.1 FEATURE_142 B-R1).
 *
 * These are the *generic* defaults shipped with @kodax-ai/session-lineage.
 * They are the "candidate-a-conservative" winner from the prompt eval
 * (`tests/compaction-prompt.eval.ts`, 150 cells over 5 aliases × 10
 * fixtures × 3 candidates) — schema-stable and high-recall on both
 * coding and non-coding fixtures, with domain-neutral wording.
 *
 * The prior coding-flavored prompts (referencing "coding agent",
 * "file paths, function names", "HTTP status codes", "## Files & Changes")
 * have moved to `@kodax-ai/coding` as `CODING_SUMMARY_PROMPT` /
 * `CODING_UPDATE_SUMMARY_PROMPT`. Coding callers pass them via the
 * `summaryPrompt` / `updateSummaryPrompt` parameters of
 * `buildCompactionPromptSnapshot()` and `generateSummary()` / `compact()`
 * to preserve the v0.7.35 behavior byte-equivalent on the coding path.
 *
 * Why this split (per ADR-021): @kodax-ai/session-lineage is the generic
 * compaction primitive package. Its public surface must not assume the
 * caller is a coding agent — domain-specific prompt language belongs
 * one layer up.
 */
export const DEFAULT_SUMMARY_PROMPT = `Create a structured summary for the conversation below.

This summary will be handed to another agent so it can continue the same task with minimal context.
Keep only information that is still useful for continuing the work.

You may drop:
- completed low-value micro-steps
- repetitive thinking
- stale intermediate plans
- verbose tool output details

You must keep:
- the current goal
- user constraints and preferences
- current progress and unfinished work
- blockers or unresolved questions
- the most important next steps
- EXACT identifiers, references, and concrete locations the agent operated on or referenced
- EXACT error messages, status codes, and exception types
- EXACT configuration values, parameter values, and external resource names mentioned
- key decisions WITH reasoning (not just the choice)

CRITICAL: Every user REQUEST and DECISION must be preserved verbatim or near-verbatim.
Never reduce "user asked to upgrade dependency X to v3.4 to resolve incompatibility with system Y"
to "user asked to fix an issue".

Keep the summary concise and high-signal. Do not mechanically preserve every historical detail.

First, wrap your analysis in <analysis> tags:
- Walk through messages chronologically
- Note exact identifiers, references, error codes, configuration values
- Identify user's explicit requests vs inferred intent
- Flag technical details that MUST survive compression

Then output the structured summary in <summary> tags.

Output format (strict markdown, inside <summary> tags):

## Goal
[1-2 sentences describing the active goal]

## Constraints & Preferences
- [One item per line]
- [Write "None" if there are no explicit constraints]

## Progress
### Completed
- [x] [Completed work that still matters for context]

### In Progress
- [ ] [Current work that is actively underway]

### Blockers
- [Current blockers, or "None"]

## Key Decisions
- **[Decision]**: [Short reason]

## Next Steps
1. [Highest-priority next action]

## Key Context
- [Critical context needed to continue]

---

<read-files>
[One reference per line — file paths, URLs, IDs, or other locations the agent read; leave empty if none]
</read-files>

<modified-files>
[One reference per line — locations the agent modified; leave empty if none]
</modified-files>

Conversation:
`;

export const DEFAULT_UPDATE_SUMMARY_PROMPT = `Merge the new conversation content above into <previous-summary>.

Update the structured summary so another agent can continue the task immediately.
Keep only the information needed to continue the work.

You may remove:
- repetitive or superseded plans
- completed low-value steps
- outdated blockers
- noisy tool output details

You must preserve or update:
- the current goal
- user constraints and preferences
- current progress and unfinished work
- blockers that still matter
- next steps based on the latest state
- EXACT identifiers, references, and concrete locations
- EXACT error messages, status codes, and exception types
- EXACT configuration values, parameter values, and external resource names
- key decisions WITH reasoning

CRITICAL: Every user REQUEST and DECISION must be preserved verbatim or near-verbatim.

Do not accumulate every past detail. Compress aggressively while keeping continuation-critical context.

First, wrap your analysis in <analysis> tags, then output the summary in <summary> tags.

Output format (strict markdown, inside <summary> tags):

## Goal
[Updated goal]

## Constraints & Preferences
- [Relevant constraints only]

## Progress
### Completed
- [x] [Completed work that still matters]

### In Progress
- [ ] [Active work in the latest state]

### Blockers
- [Current blockers, or "None"]

## Key Decisions
- **[Decision]**: [Short reason]

## Next Steps
1. [Most relevant next action]

## Key Context
- [Critical context needed to continue]

---

<read-files>
[One reference per line — file paths, URLs, IDs, or other locations the agent read; leave empty if none]
</read-files>

<modified-files>
[One reference per line — locations the agent modified; leave empty if none]
</modified-files>

Keep every section concise.`;

export type KodaXCompactionPromptVariant = 'initial-summary' | 'update-summary';

export interface KodaXCompactionPromptSection {
  id: string;
  title: string;
  owner: 'compaction';
  /**
   * Provenance label — opaque string identifying which feature ticket
   * authored this section, used by debug tooling and prompt-eval
   * provenance traces. v0.7.35.1 FEATURE_142: widened from coding-side
   * `'FEATURE_044' | 'FEATURE_050'` literal union per ADR-021 — the
   * session-lineage package is generic and must not enumerate coding
   * feature IDs in its public type surface.
   */
  feature: string;
  slot: 'conversation' | 'history' | 'instructions' | 'tracking';
  order: number;
  stability: 'stable' | 'dynamic' | 'specialist';
  inclusionReason: string;
  content: string;
}

export interface KodaXCompactionPromptSnapshot {
  kind: 'specialist';
  specialist: 'compaction-summary';
  variant: KodaXCompactionPromptVariant;
  systemPrompt: string;
  userPrompt: string;
  sections: KodaXCompactionPromptSection[];
  hash: string;
}

export interface CompactionCacheContext {
  readonly tools: readonly KodaXToolDefinition[];
  readonly reasoning?: boolean | KodaXReasoningRequest;
  /** Opaque Provider cache-routing key inherited from the logical context. */
  readonly promptCacheKey?: string;
  /** Raw tail already present in the cached prefix but excluded from this summary. */
  readonly protectedTailMessageCount?: number;
  /** Optional diagnostics observer; failures never affect the compaction request. */
  readonly observer?: CompactionProviderObserver;
}

export interface CompactionProviderRequest {
  readonly messages: readonly KodaXMessage[];
  readonly tools: readonly KodaXToolDefinition[];
  readonly system: string;
  readonly reasoning?: boolean | KodaXReasoningRequest;
  readonly modelOverride?: string;
  readonly ephemeralSuffix?: KodaXEphemeralSuffix;
  readonly promptCacheKey?: string;
}

export interface CompactionProviderObserver {
  readonly onRequest?: (request: CompactionProviderRequest) => void;
  readonly onResponse?: (
    request: CompactionProviderRequest,
    usage: KodaXTokenUsage | undefined,
  ) => void;
}

/** Routing-only metadata applied to every physical summary request. */
export interface CompactionProviderRouting {
  readonly promptCacheKey?: string;
}

export function buildCompactionCacheInstruction(
  promptSnapshot: KodaXCompactionPromptSnapshot,
  protectedTailMessageCount = 0,
): string {
  const coverageInstruction = protectedTailMessageCount > 0
    ? `Summarize only the messages before the final ${protectedTailMessageCount} message${
        protectedTailMessageCount === 1 ? '' : 's'
      }; that final raw tail remains verbatim and must not be duplicated in the summary.`
    : 'Summarize the complete conversation prefix above; do not continue or answer it.';
  return [
    'CRITICAL COMPACTION MODE: Respond with TEXT ONLY. Do NOT call any tools.',
    coverageInstruction,
    renderCompactionPromptSections(
      promptSnapshot.sections.filter((section) => section.id !== 'conversation'),
    ),
  ].join('\n\n');
}

function createCompactionPromptSection(
  section: Omit<KodaXCompactionPromptSection, 'owner'>,
): KodaXCompactionPromptSection {
  return {
    ...section,
    owner: 'compaction',
    content: section.content.trim(),
  };
}

function renderCompactionPromptSections(
  sections: KodaXCompactionPromptSection[],
): string {
  return [...sections]
    .sort((left, right) => left.order - right.order)
    .map((section) => section.content.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function buildCompactionPromptSnapshot(args: {
  messages: KodaXMessage[];
  details: CompactionDetails;
  customInstructions?: string;
  systemPrompt?: string;
  previousSummary?: string;
  /**
   * Override the initial-summary instructions. When omitted, falls back
   * to {@link DEFAULT_SUMMARY_PROMPT}. Coding callers pass
   * `CODING_SUMMARY_PROMPT` (from @kodax-ai/coding) here to preserve the
   * v0.7.35 byte-equivalent prompt on the coding path.
   */
  summaryPrompt?: string;
  /**
   * Override the update-summary instructions. When omitted, falls back
   * to {@link DEFAULT_UPDATE_SUMMARY_PROMPT}. Coding callers pass
   * `CODING_UPDATE_SUMMARY_PROMPT` (from @kodax-ai/coding) here.
   */
  updateSummaryPrompt?: string;
}): KodaXCompactionPromptSnapshot {
  const {
    messages,
    details,
    customInstructions,
    systemPrompt,
    previousSummary,
    summaryPrompt,
    updateSummaryPrompt,
  } = args;
  const trimmedCustomInstructions = customInstructions?.trim();
  const trimmedPreviousSummary = previousSummary?.trim();

  const sections: KodaXCompactionPromptSection[] = [
    createCompactionPromptSection({
      id: 'conversation',
      title: 'Conversation Transcript',
      feature: 'FEATURE_050',
      slot: 'conversation',
      order: 100,
      stability: 'dynamic',
      inclusionReason:
        'Always include the bounded conversation transcript so the specialist prompt summarizes concrete state instead of memory.',
      content: `<conversation>\n${serializeConversation(messages)}\n</conversation>`,
    }),
  ];

  if (trimmedPreviousSummary) {
    sections.push(
      createCompactionPromptSection({
        id: 'previous-summary',
        title: 'Previous Summary',
        feature: 'FEATURE_050',
        slot: 'history',
        order: 200,
        stability: 'dynamic',
        inclusionReason:
          'Include the prior compact summary when merging new history into an existing continuation anchor.',
        content: `<previous-summary>\n${trimmedPreviousSummary}\n</previous-summary>`,
      }),
    );
  }

  const baseInstructions = trimmedPreviousSummary
    ? (updateSummaryPrompt ?? DEFAULT_UPDATE_SUMMARY_PROMPT)
    : (summaryPrompt ?? DEFAULT_SUMMARY_PROMPT);
  sections.push(
    createCompactionPromptSection({
      id: trimmedPreviousSummary ? 'update-instructions' : 'summary-instructions',
      title: trimmedPreviousSummary ? 'Update Summary Instructions' : 'Summary Instructions',
      feature: 'FEATURE_044',
      slot: 'instructions',
      order: 300,
      stability: 'specialist',
      inclusionReason:
        'Always include the continuation-oriented compaction instructions so summary quality remains aligned with recall and continuation goals.',
      content: baseInstructions,
    }),
  );

  if (trimmedCustomInstructions) {
    sections.push(
      createCompactionPromptSection({
        id: 'custom-instructions',
        title: 'Custom Instructions',
        feature: 'FEATURE_050',
        slot: 'instructions',
        order: 350,
        stability: 'dynamic',
        inclusionReason:
          'Include explicit custom guidance only when the caller adds compaction-specific instructions.',
        content: `Additional instructions: ${trimmedCustomInstructions}`,
      }),
    );
  }

  sections.push(
    createCompactionPromptSection({
      id: 'file-tracking',
      title: 'File Tracking',
      feature: 'FEATURE_044',
      slot: 'tracking',
      order: 400,
      stability: 'dynamic',
      inclusionReason:
        'Always include file tracking so compact summaries preserve continuation-critical read and modified targets.',
      content: [
        '---',
        'File tracking:',
        `Read files: ${
          details.readFiles.length > 0 ? details.readFiles.join(', ') : 'None'
        }`,
        `Modified files: ${
          details.modifiedFiles.length > 0
            ? details.modifiedFiles.join(', ')
            : 'None'
        }`,
      ].join('\n'),
    }),
  );

  const userPrompt = renderCompactionPromptSections(sections);
  const resolvedSystemPrompt = systemPrompt || SUMMARIZATION_SYSTEM_PROMPT;
  const variant: KodaXCompactionPromptVariant = trimmedPreviousSummary
    ? 'update-summary'
    : 'initial-summary';
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'specialist',
        specialist: 'compaction-summary',
        variant,
        systemPrompt: resolvedSystemPrompt,
        sections,
      }),
    )
    .digest('hex');

  return {
    kind: 'specialist',
    specialist: 'compaction-summary',
    variant,
    systemPrompt: resolvedSystemPrompt,
    userPrompt,
    sections,
    hash,
  };
}

export async function generateSummary(
  messages: KodaXMessage[],
  provider: KodaXBaseProvider,
  details: CompactionDetails,
  customInstructions?: string,
  systemPrompt?: string,
  previousSummary?: string,
  summaryPrompt?: string,
  updateSummaryPrompt?: string,
  modelOverride?: string,
  cacheContext?: CompactionCacheContext,
  observer?: CompactionProviderObserver,
  routing?: CompactionProviderRouting,
): Promise<string> {
  const promptSnapshot = buildCompactionPromptSnapshot({
    messages,
    details,
    customInstructions,
    systemPrompt,
    previousSummary,
    summaryPrompt,
    updateSummaryPrompt,
  });

  const cacheInstruction = buildCompactionCacheInstruction(
    promptSnapshot,
    cacheContext?.protectedTailMessageCount,
  );
  const promptCacheKey = routing?.promptCacheKey ?? cacheContext?.promptCacheKey;
  const request: CompactionProviderRequest = cacheContext
    ? {
        messages,
        tools: cacheContext.tools,
        system: promptSnapshot.systemPrompt,
        reasoning: cacheContext.reasoning,
        ...(modelOverride ? { modelOverride } : {}),
        ...(promptCacheKey
          ? { promptCacheKey }
          : {}),
        ephemeralSuffix: { content: cacheInstruction },
      }
    : {
        messages: [{ role: 'user', content: promptSnapshot.userPrompt }],
        tools: [],
        system: promptSnapshot.systemPrompt,
        reasoning: false,
        ...(modelOverride ? { modelOverride } : {}),
        ...(promptCacheKey ? { promptCacheKey } : {}),
      };
  try {
    (cacheContext?.observer ?? observer)?.onRequest?.(request);
  } catch {
    // Diagnostics are fail-open and must never block compaction.
  }
  const result = await withProviderRequestCredential(
    provider.name,
    'compaction',
    undefined,
    (credentialSignal) => provider.stream(
      [...request.messages],
      [...request.tools],
      request.system,
      request.reasoning,
      request.modelOverride || request.ephemeralSuffix || request.promptCacheKey
        ? {
            ...(request.modelOverride ? { modelOverride: request.modelOverride } : {}),
            ...(request.ephemeralSuffix ? { ephemeralSuffix: request.ephemeralSuffix } : {}),
            ...(request.promptCacheKey ? { promptCacheKey: request.promptCacheKey } : {}),
          }
        : undefined,
      credentialSignal,
    ),
  );
  try {
    (cacheContext?.observer ?? observer)?.onResponse?.(request, result.usage);
  } catch {
    // Diagnostics are fail-open and must never change a successful summary.
  }

  if (result.toolBlocks.length > 0) {
    throw new Error(
      `Compaction summary returned ${result.toolBlocks.length} tool_use block(s); text-only output is required`,
    );
  }

  const rawText = result.textBlocks.map(block => block.text).join('\n');
  const cleaned = stripAnalysisBlock(rawText);

  // Mirror Claude Code's behavior (compact.ts:499-515): a summary response
  // with no usable text is a failure, not an empty success. Throwing here
  // lets the compaction caller trip its circuit breaker and fall back to
  // graceful degradation, instead of silently producing a blank summary
  // that the partial-success path would treat as "compacted".
  if (!cleaned.trim()) {
    throw new Error('Compaction summary response did not contain valid text content');
  }

  return cleaned;
}

/**
 * Strip <analysis>...</analysis> scratchpad from LLM output.
 * Also strips <summary> wrapper tags, keeping only the content.
 */
function stripAnalysisBlock(text: string): string {
  let cleaned = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  cleaned = cleaned.replace(/<\/?summary>/gi, '').trim();
  return cleaned;
}

function parseListSection(section: string): string[] {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || /^\d+\.\s/.test(line))
    .map((line) => line.replace(/^-\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== 'none');
}

function parseTaggedLines(summary: string, tagName: string): string[] {
  const match = summary.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'i'));
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readSection(summary: string, heading: string, nextHeadings: string[]): string {
  const headingPattern = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nextHeadingPattern = nextHeadings
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const regex = new RegExp(
    `${headingPattern}\\s*([\\s\\S]*?)(?=\\n(?:${nextHeadingPattern})\\b|\\n---|$)`,
    'i',
  );
  return summary.match(regex)?.[1]?.trim() ?? '';
}

function readSingleParagraph(section: string): string | undefined {
  const cleaned = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return cleaned || undefined;
}

export function extractCompactMemorySeed(
  summary: string,
  details: CompactionDetails,
): KodaXCompactMemorySeed {
  const constraints = parseListSection(
    readSection(summary, '## Constraints & Preferences', ['## Progress']),
  );
  const completed = parseListSection(
    readSection(summary, '### Completed', ['### In Progress', '### Blockers']),
  );
  const inProgress = parseListSection(
    readSection(summary, '### In Progress', ['### Blockers', '## Key Decisions']),
  );
  const blockers = parseListSection(
    readSection(summary, '### Blockers', ['## Key Decisions']),
  );
  const keyDecisions = parseListSection(
    readSection(summary, '## Key Decisions', ['## Next Steps']),
  );
  const nextSteps = parseListSection(
    readSection(summary, '## Next Steps', ['## Key Context']),
  );
  const keyContext = parseListSection(
    readSection(summary, '## Key Context', ['<read-files>', '<modified-files>']),
  );
  const importantTargets = Array.from(new Set([
    ...parseTaggedLines(summary, 'read-files'),
    ...parseTaggedLines(summary, 'modified-files'),
    ...details.readFiles,
    ...details.modifiedFiles,
  ]));

  return {
    objective: readSingleParagraph(readSection(summary, '## Goal', ['## Constraints & Preferences'])),
    constraints,
    progress: {
      completed,
      inProgress,
      blockers,
    },
    keyDecisions,
    nextSteps,
    keyContext,
    importantTargets,
    tombstones: blockers.filter((entry) => /skip|avoid|won't|wont|abandon|failed/i.test(entry)),
  };
}
