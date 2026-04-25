import { createHash } from 'crypto';

export type KodaXPromptSectionSlot =
  | 'base'
  | 'runtime-context'
  | 'session-context'
  | 'capability-truth'
  | 'base-suffix'
  | 'mode-overlay'
  | 'project-rules'
  | 'skill-addendum'
  | 'specialist';

export type KodaXPromptSectionStability =
  | 'stable'
  | 'dynamic'
  | 'project'
  | 'specialist';

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
  base: 100,
  'runtime-context': 200,
  'session-context': 300,
  'capability-truth': 400,
  'base-suffix': 450,
  'mode-overlay': 500,
  'project-rules': 600,
  'skill-addendum': 700,
  specialist: 800,
};

export const PROMPT_SECTION_REGISTRY: Record<string, KodaXPromptSectionDefinition> = {
  'base-system': {
    id: 'base-system',
    title: 'Base System Prompt',
    owner: 'prompts',
    feature: 'FEATURE_048',
    slot: 'base',
    order: 100,
    stability: 'stable',
  },
  'base-system-suffix': {
    id: 'base-system-suffix',
    title: 'Base System Prompt Suffix',
    owner: 'prompts',
    feature: 'FEATURE_048',
    slot: 'base-suffix',
    order: 200,
    stability: 'stable',
  },
  'environment-context': {
    id: 'environment-context',
    title: 'Environment Context',
    owner: 'prompts',
    feature: 'FEATURE_048',
    slot: 'runtime-context',
    order: 100,
    stability: 'dynamic',
  },
  'runtime-fact': {
    id: 'runtime-fact',
    title: 'Runtime Fact',
    owner: 'prompts',
    feature: 'FEATURE_048',
    slot: 'runtime-context',
    order: 150,
    stability: 'dynamic',
  },
  'working-directory': {
    id: 'working-directory',
    title: 'Working Directory',
    owner: 'prompts',
    feature: 'FEATURE_048',
    slot: 'runtime-context',
    order: 200,
    stability: 'dynamic',
  },
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
  'long-running-context': {
    id: 'long-running-context',
    title: 'Long-Running Context',
    owner: 'prompts',
    feature: 'FEATURE_048',
    slot: 'session-context',
    order: 300,
    stability: 'dynamic',
  },
  'repo-intelligence-context': {
    id: 'repo-intelligence-context',
    title: 'Repository Intelligence Context',
    owner: 'reasoning',
    feature: 'FEATURE_048',
    slot: 'capability-truth',
    order: 100,
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
  'long-running-overlay': {
    id: 'long-running-overlay',
    title: 'Long-Running Overlay',
    owner: 'prompts',
    feature: 'FEATURE_048',
    slot: 'mode-overlay',
    order: 100,
    stability: 'dynamic',
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
  'skills-addendum': {
    id: 'skills-addendum',
    title: 'Skills Addendum',
    owner: 'skills',
    feature: 'FEATURE_048',
    slot: 'skill-addendum',
    order: 100,
    stability: 'dynamic',
  },
};

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
