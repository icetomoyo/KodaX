/**
 * @kodax/agent Compaction Summary Generator
 *
 * Generates continuation-oriented summaries for compacted conversations.
 */

import { createHash } from 'crypto';
import type { KodaXBaseProvider, KodaXMessage } from '@kodax/ai';
import type { CompactionDetails } from './types.js';
import type { KodaXCompactMemorySeed } from '../types.js';
import { serializeConversation } from './utils.js';

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization specialist.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Tool calls will be REJECTED and waste your only turn.

Your response must contain two parts:
1. <analysis> — your scratchpad for walking through messages (will be stripped)
2. <summary> — the structured continuation summary

Do not continue the conversation. Do not answer any user requests.`;

const SUMMARY_PROMPT = `Create a structured summary for the conversation below.

This summary will be handed to another coding agent so it can continue the same task with minimal context.
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
- EXACT file paths, function names, and line numbers referenced
- EXACT error messages, HTTP status codes, and exception types
- API endpoints, database tables, env vars, and config values mentioned
- key decisions WITH reasoning (not just the choice)

CRITICAL: Every user REQUEST and DECISION must be preserved verbatim or near-verbatim.
Never reduce "user asked to fix the 401 error on /api/auth/login by switching to JWT"
to "user asked to fix an error".

Keep the summary concise and high-signal. Do not mechanically preserve every historical detail.

First, wrap your analysis in <analysis> tags:
- Walk through messages chronologically
- Note exact file paths, function names, error codes, config values
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

## Files & Changes
- **[exact path]**: [what was done and why]

---

<read-files>
[One path per line, leave empty if none]
</read-files>

<modified-files>
[One path per line, leave empty if none]
</modified-files>

Conversation:
`;

const UPDATE_SUMMARY_PROMPT = `Merge the new conversation content above into <previous-summary>.

Update the structured summary so another coding agent can continue the task immediately.
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
- EXACT file paths, function names, and line numbers
- EXACT error messages, HTTP status codes, and exception types
- API endpoints, database tables, env vars, and config values
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

## Files & Changes
- **[exact path]**: [what was done and why]

---

<read-files>
[One path per line, leave empty if none]
</read-files>

<modified-files>
[One path per line, leave empty if none]
</modified-files>

Keep every section concise.`;

export type KodaXCompactionPromptVariant = 'initial-summary' | 'update-summary';

export interface KodaXCompactionPromptSection {
  id: string;
  title: string;
  owner: 'compaction';
  feature: 'FEATURE_044' | 'FEATURE_050';
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
}): KodaXCompactionPromptSnapshot {
  const {
    messages,
    details,
    customInstructions,
    systemPrompt,
    previousSummary,
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

  const baseInstructions = trimmedPreviousSummary ? UPDATE_SUMMARY_PROMPT : SUMMARY_PROMPT;
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
  previousSummary?: string
): Promise<string> {
  const promptSnapshot = buildCompactionPromptSnapshot({
    messages,
    details,
    customInstructions,
    systemPrompt,
    previousSummary,
  });

  const result = await provider.stream(
    [{ role: 'user', content: promptSnapshot.userPrompt }],
    [],
    promptSnapshot.systemPrompt,
    false,
    undefined,
    undefined
  );

  const rawText = result.textBlocks.map(block => block.text).join('\n');
  return stripAnalysisBlock(rawText);
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
