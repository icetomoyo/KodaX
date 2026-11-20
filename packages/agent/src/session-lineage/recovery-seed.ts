import type {
  KodaXMessage,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLineage,
} from '../types.js';

const DEFAULT_RECOVERY_PROMPT = 'Continue.';
const MAX_SECTION_ITEMS = 4;
const MAX_ITEM_LENGTH = 320;
const MAX_SUMMARY_LENGTH = 6000;

export interface RecoverySeedInput {
  sourceSessionId: string;
  messages: readonly KodaXMessage[];
  lineage?: KodaXSessionLineage;
  artifactLedger?: readonly KodaXSessionArtifactLedgerEntry[];
  reason?: string;
}

export interface RecoverySeed {
  messages: KodaXMessage[];
  title: string;
  summary: string;
}

export function normalizeRecoveryPrompt(prompt?: string): string {
  const trimmed = prompt?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_RECOVERY_PROMPT;
}

export function buildRecoverySeed(input: RecoverySeedInput): RecoverySeed {
  const priorSummaries = collectPriorSummaries(input.lineage);
  const objective = firstTextForRole(input.messages, 'user') ?? 'Continue the previous KodaX session.';
  const recentUser = recentTextsForRole(input.messages, 'user', MAX_SECTION_ITEMS);
  const recentAssistant = recentTextsForRole(input.messages, 'assistant', MAX_SECTION_ITEMS);
  const artifactLines = summarizeArtifacts(input.artifactLedger ?? []);
  const toolLines = summarizeToolUses(input.messages);

  const sections = [
    `Source session: ${input.sourceSessionId}`,
    input.reason ? `Recovery reason: ${input.reason}` : undefined,
    'This is a compact local recovery memory, not raw chat history. Do not assume omitted tool calls or hidden reasoning are still available.',
    formatSection('Objective', [objective]),
    formatSection('Prior summaries', priorSummaries),
    formatSection('Recent user requests', recentUser),
    formatSection('Recent assistant progress', recentAssistant),
    formatSection('Files and tools touched', [...artifactLines, ...toolLines]),
    formatSection('How to continue', [
      'Continue from this memory in the new session. Ask for clarification if a missing detail matters.',
    ]),
  ].filter((section): section is string => typeof section === 'string' && section.trim().length > 0);

  const summary = truncateText(sections.join('\n\n'), MAX_SUMMARY_LENGTH);
  return {
    title: `Recovered from ${input.sourceSessionId.slice(-8)}`,
    summary,
    messages: [{
      role: 'system',
      content: `[Recovered session memory]\n\n${summary}`,
      _synthetic: true,
    }],
  };
}

function collectPriorSummaries(lineage?: KodaXSessionLineage): string[] {
  if (!lineage) {
    return [];
  }

  return lineage.entries
    .filter((entry) => entry.type === 'compaction' || entry.type === 'branch_summary')
    .slice(-2)
    .map((entry) => truncateText(entry.summary.replace(/\s+/g, ' ').trim(), MAX_ITEM_LENGTH))
    .filter((text) => text.length > 0);
}

function firstTextForRole(
  messages: readonly KodaXMessage[],
  role: KodaXMessage['role'],
): string | undefined {
  for (const message of messages) {
    if (message.role !== role) continue;
    const text = messageText(message);
    if (text) return truncateText(text, MAX_ITEM_LENGTH);
  }
  return undefined;
}

function recentTextsForRole(
  messages: readonly KodaXMessage[],
  role: KodaXMessage['role'],
  limit: number,
): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== role) continue;
    const text = messageText(message);
    if (text) out.push(truncateText(text, MAX_ITEM_LENGTH));
  }
  return out.reverse();
}

function messageText(message: KodaXMessage): string {
  if (typeof message.content === 'string') {
    return message.content.replace(/\s+/g, ' ').trim();
  }

  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeArtifacts(
  artifactLedger: readonly KodaXSessionArtifactLedgerEntry[],
): string[] {
  return artifactLedger.slice(-MAX_SECTION_ITEMS).map((entry) => {
    const detail = entry.summary ? ` - ${entry.summary}` : '';
    return `${entry.kind}: ${entry.displayTarget ?? entry.target}${detail}`;
  });
}

function summarizeToolUses(messages: readonly KodaXMessage[]): string[] {
  const tools: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const target = summarizeToolInput(block.input);
      tools.push(target ? `${block.name}: ${target}` : block.name);
    }
  }
  return tools.slice(-MAX_SECTION_ITEMS);
}

function summarizeToolInput(input: Record<string, unknown>): string {
  const candidates = ['path', 'file', 'filePath', 'pattern', 'command'];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return truncateText(value.replace(/\s+/g, ' ').trim(), 120);
    }
  }
  return '';
}

function formatSection(title: string, items: readonly string[]): string | undefined {
  const clean = items
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (clean.length === 0) {
    return undefined;
  }
  return `## ${title}\n${clean.map((item) => `- ${item}`).join('\n')}`;
}

function truncateText(text: string, maxLength: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

