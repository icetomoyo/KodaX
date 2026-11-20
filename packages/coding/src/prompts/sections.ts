import { createHash } from 'crypto';

export type KodaXPromptSectionSlot =
  | 'session-context'
  | 'capability-truth'
  | 'mode-overlay'
  | 'project-rules'
  | 'skill-addendum'
  | 'specialist';

export type KodaXPromptSectionStability =
  | 'stable'
  | 'dynamic'
  | 'project'
  | 'specialist';

/**
 * What a prompt section is for: `contract` is text the runtime protocol depends on,
 * `capability` teaches an available tool, and `guidance` is KodaX's default way of working.
 */
export type KodaXPromptSectionTag = 'contract' | 'capability' | 'guidance';

export interface KodaXPromptSectionDefinition {
  id: string;
  title: string;
  owner: 'prompts' | 'reasoning' | 'project' | 'skills' | 'agent';
  feature: string;
  slot: KodaXPromptSectionSlot;
  order: number;
  stability: KodaXPromptSectionStability;
}

export interface KodaXPromptSection extends KodaXPromptSectionDefinition {
  inclusionReason: string;
  content: string;
}

export interface KodaXPromptSnapshotMetadata {
  isNewSession: boolean;
  executionCwd: string;
  projectRoot: string;
  longRunning: boolean;
}

export interface KodaXPromptSnapshot {
  kind: 'system';
  sections: KodaXPromptSection[];
  rendered: string;
  hash: string;
  metadata: KodaXPromptSnapshotMetadata;
}

const PROMPT_SLOT_ORDER: Record<KodaXPromptSectionSlot, number> = {
  'session-context': 300,
  'capability-truth': 400,
  'mode-overlay': 500,
  'project-rules': 600,
  'skill-addendum': 700,
  specialist: 800,
};

// Frozen: a mutated registry would let any importer rewrite the managed Worker's capability context.
export const PROMPT_SECTION_REGISTRY: Readonly<Record<string, Readonly<KodaXPromptSectionDefinition>>> = Object.freeze({
  'git-context': {
    id: 'git-context',
    title: 'Git Context',
    owner: 'prompts',
    feature: 'FEATURE_048',
    slot: 'session-context',
    order: 100,
    stability: 'dynamic',
  },
  'project-snapshot': {
    id: 'project-snapshot',
    title: 'Project Snapshot',
    owner: 'prompts',
    feature: 'FEATURE_048',
    slot: 'session-context',
    order: 200,
    stability: 'dynamic',
  },
  'mcp-capability-context': {
    id: 'mcp-capability-context',
    title: 'MCP Capability Context',
    owner: 'reasoning',
    feature: 'FEATURE_035',
    slot: 'capability-truth',
    order: 200,
    stability: 'dynamic',
  },
  'specialist-agents': {
    id: 'specialist-agents',
    title: 'Specialist Agents',
    owner: 'agent',
    feature: 'FEATURE_191',
    slot: 'capability-truth',
    order: 300,
    stability: 'dynamic',
  },
  'self-knowledge-routing': {
    id: 'self-knowledge-routing',
    title: 'KodaX Self-Knowledge',
    owner: 'prompts',
    feature: 'FEATURE_218',
    slot: 'capability-truth',
    order: 350,
    stability: 'stable',
  },
  'prompt-overlay': {
    id: 'prompt-overlay',
    title: 'Prompt Overlay',
    owner: 'reasoning',
    feature: 'FEATURE_048',
    slot: 'mode-overlay',
    order: 200,
    stability: 'dynamic',
  },
  'project-agents': {
    id: 'project-agents',
    title: 'Project Rules',
    owner: 'project',
    feature: 'FEATURE_048',
    slot: 'project-rules',
    order: 100,
    stability: 'project',
  },
  'memory-rules': {
    id: 'memory-rules',
    title: 'Memory Rules',
    owner: 'project',
    feature: 'FEATURE_124',
    slot: 'project-rules',
    order: 150,
    stability: 'project',
  },
  'project-memory': {
    id: 'project-memory',
    title: 'Persistent Memory Index',
    owner: 'project',
    feature: 'FEATURE_124',
    slot: 'project-rules',
    order: 200,
    stability: 'project',
  },
  'memory-notes': {
    id: 'memory-notes',
    title: 'Memory Notes',
    owner: 'project',
    feature: 'FEATURE_308',
    slot: 'project-rules',
    order: 200,
    stability: 'project',
  },
  'skills-addendum': {
    id: 'skills-addendum',
    title: 'Skills Addendum',
    owner: 'skills',
    feature: 'FEATURE_048',
    slot: 'skill-addendum',
    order: 100,
    stability: 'dynamic',
  },
  'tool-construction': {
    id: 'tool-construction',
    title: 'Tool Construction Mode',
    owner: 'agent',
    feature: 'FEATURE_087',
    slot: 'specialist',
    order: 100,
    stability: 'specialist',
  },
});

export function createPromptSection(
  id: keyof typeof PROMPT_SECTION_REGISTRY,
  content: string,
  inclusionReason: string,
): KodaXPromptSection {
  const definition = PROMPT_SECTION_REGISTRY[id];
  if (!definition) {
    throw new Error(`Unknown prompt section: ${id}`);
  }

  return {
    ...definition,
    inclusionReason,
    content: content.trim(),
  };
}

export function orderPromptSections(
  sections: KodaXPromptSection[],
): KodaXPromptSection[] {
  return [...sections].sort((left, right) => {
    const slotOrder =
      PROMPT_SLOT_ORDER[left.slot] - PROMPT_SLOT_ORDER[right.slot];
    if (slotOrder !== 0) {
      return slotOrder;
    }
    return left.order - right.order;
  });
}

export function renderPromptSections(
  sections: KodaXPromptSection[],
): string {
  return orderPromptSections(sections)
    .map((section) => section.content.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function buildPromptSnapshot(
  sections: KodaXPromptSection[],
  metadata: KodaXPromptSnapshotMetadata,
): KodaXPromptSnapshot {
  const ordered = orderPromptSections(sections);
  const rendered = renderPromptSections(ordered);
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'system',
        metadata,
        sections: ordered.map((section) => ({
          id: section.id,
          title: section.title,
          slot: section.slot,
          order: section.order,
          owner: section.owner,
          feature: section.feature,
          stability: section.stability,
          inclusionReason: section.inclusionReason,
          content: section.content,
        })),
      }),
    )
    .digest('hex');

  return {
    kind: 'system',
    sections: ordered,
    rendered,
    hash,
    metadata,
  };
}
