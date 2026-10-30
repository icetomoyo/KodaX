import { createHash } from 'node:crypto';

import type { KodaXMessage } from '../../../types.js';
import { isManagedRunContextMessage } from './managed-run-context.js';

/** One session-scoped part of the Managed Run Context, keyed by capability section id. */
export interface RetainedContextSection {
  readonly id: string;
  readonly content: string;
}

/** Runtime facts the model has already seen in retained envelopes. */
export interface ManagedRunContextEffectiveState {
  readonly runtimeFingerprint: string | undefined;
  readonly sessionSections: readonly RetainedContextSection[];
}

interface RetainedPlacement {
  /** Number of ordinary messages that precede the managed message. */
  readonly beforeOrdinaryIndex: number;
  readonly message: KodaXMessage;
}

/** What a finished Run leaves behind so the next Run can keep the same wire prefix. */
export interface ManagedRunContextRetentionRecord {
  readonly ordinaryCount: number;
  readonly ordinaryDigest: string;
  readonly placements: readonly RetainedPlacement[];
  readonly effective: ManagedRunContextEffectiveState;
}

/**
 * Facts stay true until the Runtime replaces them, so a missing one must be
 * retracted. Evidence is a point-in-time snapshot that later Runs may not
 * recompute; its absence does not make the earlier snapshot wrong.
 */
const RETAINED_FACT_LABELS: Readonly<Record<string, string>> = {
  'skills-addendum': 'Skills catalog',
  'mcp-capability-context': 'MCP capability context',
  'specialist-agents': 'Specialist agent list',
};
const RETAINED_EVIDENCE_SECTION_IDS = new Set(['git-context', 'project-snapshot', 'repo-intelligence-context']);
// Models seldom look back to an earlier envelope for the file list, so a Run
// that computed the project snapshot restates it even when unchanged.
const ALWAYS_RESTATED_SECTION_ID = 'project-snapshot';

export function isRetainedSessionSection(id: string): boolean {
  return id in RETAINED_FACT_LABELS || RETAINED_EVIDENCE_SECTION_IDS.has(id);
}

function digestOrdinaryMessages(messages: readonly KodaXMessage[]): string {
  const wire = messages.map(({ role, content }) => ({ role, content }));
  return createHash('sha256').update(JSON.stringify(wire)).digest('hex');
}

function copyMessage(message: KodaXMessage): KodaXMessage {
  return structuredClone(message);
}

/** Capture the model-visible transcript of a finished Run, managed envelopes included. */
export function recordManagedRunContext(
  modelView: readonly KodaXMessage[],
  effective: ManagedRunContextEffectiveState,
): ManagedRunContextRetentionRecord {
  const ordinary: KodaXMessage[] = [];
  const placements: RetainedPlacement[] = [];
  for (const message of modelView) {
    if (isManagedRunContextMessage(message)) {
      placements.push({ beforeOrdinaryIndex: ordinary.length, message: copyMessage(message) });
    } else {
      ordinary.push(message);
    }
  }
  return {
    ordinaryCount: ordinary.length,
    ordinaryDigest: digestOrdinaryMessages(ordinary),
    placements,
    effective: {
      runtimeFingerprint: effective.runtimeFingerprint,
      sessionSections: effective.sessionSections.map((section) => ({ ...section })),
    },
  };
}

/**
 * Reinsert retained envelopes when the host history still starts with the
 * retained transcript. `ordinaryHistory` must already exclude managed
 * messages; host-supplied managed messages are never trusted.
 */
export function restoreManagedRunContext(
  record: ManagedRunContextRetentionRecord | undefined,
  ordinaryHistory: readonly KodaXMessage[],
): { readonly messages: KodaXMessage[]; readonly effective: ManagedRunContextEffectiveState } | undefined {
  if (record === undefined || ordinaryHistory.length < record.ordinaryCount) return undefined;
  if (digestOrdinaryMessages(ordinaryHistory.slice(0, record.ordinaryCount)) !== record.ordinaryDigest) {
    return undefined;
  }
  const messages: KodaXMessage[] = [];
  let next = 0;
  ordinaryHistory.forEach((message, index) => {
    while (record.placements[next]?.beforeOrdinaryIndex === index) {
      messages.push(copyMessage(record.placements[next]!.message));
      next += 1;
    }
    messages.push(message);
  });
  while (next < record.placements.length) {
    messages.push(copyMessage(record.placements[next]!.message));
    next += 1;
  }
  return {
    messages,
    effective: {
      runtimeFingerprint: record.effective.runtimeFingerprint,
      sessionSections: record.effective.sessionSections.map((section) => ({ ...section })),
    },
  };
}

/** Select the current Run's session sections an update must restate: new, changed, or the project snapshot. */
export function diffRetainedSessionSections(
  previous: readonly RetainedContextSection[],
  current: readonly RetainedContextSection[],
): {
  readonly restated: readonly RetainedContextSection[];
  readonly retiredLabels: readonly string[];
  readonly effective: readonly RetainedContextSection[];
} {
  const previousById = new Map(previous.map((section) => [section.id, section.content]));
  const currentIds = new Set(current.map((section) => section.id));
  const restated = current.filter((section) => (
    section.id === ALWAYS_RESTATED_SECTION_ID || previousById.get(section.id) !== section.content
  ));
  const missing = previous.filter((section) => !currentIds.has(section.id));
  const keptEvidence = missing.filter((section) => RETAINED_EVIDENCE_SECTION_IDS.has(section.id));
  const retiredLabels = missing.flatMap((section) => {
    const label = RETAINED_FACT_LABELS[section.id];
    return label === undefined ? [] : [label];
  });
  return { restated, retiredLabels, effective: [...current, ...keptEvidence] };
}
