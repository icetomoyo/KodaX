import { staticText } from '../prompts/static-text.js';
/**
 * FEATURE_217 (v0.7.49) Phase J — small reusable workflow pattern templates.
 *
 * These are examples, not a new abstraction layer. They give the generator
 * and users concrete Claude-style workflow shapes without forcing every task
 * through a static harness.
 */

import {
  createRestrictedWorkflowModule,
  validateWorkflowScriptManifest,
  type WorkflowModule,
  type WorkflowPatternId,
  type WorkflowScriptManifest,
} from '@kodax-ai/agent';
import { getCollaborationPatternDefinition } from '../orchestration/pattern-catalog.js';

export interface WorkflowPatternTemplate {
  readonly name: string;
  readonly pattern: WorkflowPatternId;
  readonly description: string;
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
}

const FAN_OUT_AND_SYNTHESIZE_SOURCE = staticText("t11.workflows/pattern-templates.0").trim();

const ADVERSARIAL_VERIFICATION_SOURCE = staticText("t11.workflows/pattern-templates.1").trim();

const TOURNAMENT_SOURCE = staticText("t11.workflows/pattern-templates.2").trim();

const LOOP_UNTIL_DONE_SOURCE = staticText("t11.workflows/pattern-templates.3").trim();

const GENERATE_AND_FILTER_SOURCE = staticText("t11.workflows/pattern-templates.4").trim();

const CLASSIFY_AND_ACT_SOURCE = staticText("t11.workflows/pattern-templates.5").trim();

function manifest(
  name: string,
  description: string,
  patterns: readonly WorkflowPatternId[],
  phases: readonly string[],
  maxAgents: number,
  readOnly: boolean,
): WorkflowScriptManifest {
  return validateWorkflowScriptManifest({
    name,
    description,
    phases,
    readOnly,
    maxAgents,
    maxConcurrency: Math.min(4, maxAgents),
    tokenBudget: 20000,
    mayUseWorktree: !readOnly,
    patterns,
  });
}

const TEMPLATES: readonly WorkflowPatternTemplate[] = [
  {
    name: 'fan-out-and-synthesize',
    pattern: 'fan-out-and-synthesize',
    description: getCollaborationPatternDefinition('fan-out-and-synthesize').purpose,
    manifest: manifest(
      'fan-out-and-synthesize-template',
      'Parallel workers followed by a synthesis barrier.',
      ['fan-out-and-synthesize'],
      ['fan-out', 'synthesize'],
      5,
      true,
    ),
    source: FAN_OUT_AND_SYNTHESIZE_SOURCE,
  },
  {
    name: 'adversarial-verification',
    pattern: 'adversarial-verification',
    description: getCollaborationPatternDefinition('adversarial-verification').purpose,
    manifest: manifest(
      'adversarial-verification-template',
      'Candidate worker plus adversarial verifier.',
      ['adversarial-verification'],
      ['adversarial-verification', 'synthesize'],
      3,
      true,
    ),
    source: ADVERSARIAL_VERIFICATION_SOURCE,
  },
  {
    name: 'tournament',
    pattern: 'tournament',
    description: getCollaborationPatternDefinition('tournament').purpose,
    manifest: manifest(
      'tournament-template',
      'Competing agents judged by synthesis.',
      ['tournament'],
      ['contest', 'judge'],
      4,
      true,
    ),
    source: TOURNAMENT_SOURCE,
  },
  {
    name: 'loop-until-done',
    pattern: 'loop-until-done',
    description: getCollaborationPatternDefinition('loop-until-done').purpose,
    manifest: manifest(
      'loop-until-done-template',
      'Bounded investigation loop with a stop phrase.',
      ['loop-until-done'],
      ['iterate', 'synthesize'],
      4,
      true,
    ),
    source: LOOP_UNTIL_DONE_SOURCE,
  },
  {
    name: 'generate-and-filter',
    pattern: 'generate-and-filter',
    description: getCollaborationPatternDefinition('generate-and-filter').purpose,
    manifest: manifest(
      'generate-and-filter-template',
      'Parallel generators with a filter pass.',
      ['generate-and-filter', 'fan-out-and-synthesize'],
      ['generate', 'filter', 'synthesize'],
      6,
      true,
    ),
    source: GENERATE_AND_FILTER_SOURCE,
  },
  {
    name: 'classify-and-act',
    pattern: 'classify-and-act',
    description: getCollaborationPatternDefinition('classify-and-act').purpose,
    manifest: manifest(
      'classify-and-act-template',
      'Classifier-routed worker workflow.',
      ['classify-and-act'],
      ['classify', 'act', 'synthesize'],
      3,
      true,
    ),
    source: CLASSIFY_AND_ACT_SOURCE,
  },
];

export function listWorkflowPatternTemplates(): readonly WorkflowPatternTemplate[] {
  return TEMPLATES;
}

export function getWorkflowPatternTemplate(name: string): WorkflowPatternTemplate | undefined {
  return TEMPLATES.find((template) => template.name === name);
}

export function createWorkflowPatternTemplateModule(name: string): WorkflowModule {
  const template = getWorkflowPatternTemplate(name);
  if (!template) {
    throw new Error(`unknown workflow pattern template: ${name}`);
  }
  return createRestrictedWorkflowModule({
    manifest: template.manifest,
    source: template.source,
  });
}
