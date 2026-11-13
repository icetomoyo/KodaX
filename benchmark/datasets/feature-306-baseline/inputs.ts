/**
 * Cell input assembly for FEATURE_306 Phase 0, built from production code.
 *
 * Read side: the ordinary-root AMA Worker path. The stable system comes from
 * `resolveRoleInstructions('worker', ..., 'stable')`, the Managed Run Context
 * user message from `resolveRoleRunContext`, capability sections from
 * `buildCapabilityContextSections`, tools from the builtin registry projected
 * with `projectManagedToolContract`, and the compact memory block from
 * `projectManagedSystemContract`. The memory pack comes from the real
 * `createMemoryControlPlane().buildMemoryPack` over a seeded memdir store.
 * Arms A and B differ ONLY in memory pieces: the memory-rules block, the
 * project-memory hint section, and the two memory tools.
 *
 * Write side: the real `prepareEpisodeReview` + `sanitizeUnifiedLearningReviewInput`
 * feed the production reviewer prompt and tool schema.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createMemoryControlPlane,
  sanitizeUnifiedLearningReviewInput,
  type Agent,
  type KodaXMemoryOutcomeDigest,
  type LearningReviewEvidencePacket,
  type MemoryContextIdentity,
  type MemoryManagementController,
  type MemoryPack,
  type UnifiedLearningReviewModelInput,
} from '@kodax-ai/agent';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';

import { WORKER_AGENT_NAME } from '../../../packages/coding/src/agents/task-engine-agents.js';
import {
  LEARNING_REVIEW_SYSTEM_PROMPT,
  LEARNING_REVIEW_TOOL,
} from '../../../packages/coding/src/learning-reviewer.js';
import { buildCapabilityContextSections } from '../../../packages/coding/src/prompts/capability-sections.js';
import { projectManagedSystemContract } from '../../../packages/coding/src/prompts/managed-system-contract.js';
import {
  createManagedRunContextMessage,
} from '../../../packages/coding/src/task-engine/_internal/managed-task/managed-run-context.js';
import type { ManagedRolePromptContext } from '../../../packages/coding/src/task-engine/_internal/managed-task/role-prompt-types.js';
import {
  resolveRoleInstructions,
  resolveRoleRunContext,
} from '../../../packages/coding/src/task-engine/_internal/managed-task/role-prompts.js';
import type { RunnerChainPromptContext } from '../../../packages/coding/src/task-engine/_internal/managed-task/types.js';
import {
  markOrdinaryRootToolContract,
  projectManagedToolContracts,
} from '../../../packages/coding/src/tools/managed-tool-contract.js';
import { markRegistryManagedAgent, projectModelToolDefinition } from '../../../packages/coding/src/tools/model-tool-definition.js';
import { getBuiltinToolDefinition } from '../../../packages/coding/src/tools/registry.js';
import type {
  KodaXTaskRoutingDecision,
  KodaXToolExecutionContext,
} from '../../../packages/coding/src/types.js';
import type { MemorySeed, ReadCase, WriteCase } from './cases.js';

export type Arm = 'A' | 'B';

export const FIXTURE_ROOT = path.join(os.tmpdir(), 'kodax-eval-fixtures', 'feature-306');
export const REVIEW_TOOL_NAME = LEARNING_REVIEW_TOOL.name;

const VIRTUAL_CWD = '/work/project';
const FIXED_NOW = '2026-11-01T09:00:00.000Z';
const MEMORY_SECTION_IDS = ['memory-rules', 'project-memory'];
/** Capability sections an ordinary root contributes in this fixture; everything else is AMA-owned or conditional. */
const CAPABILITY_SECTION_IDS = ['self-knowledge-routing', ...MEMORY_SECTION_IDS];
/** `requiredTools` of managed-system-contract.ts (module-private there). */
export const ROOT_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'glob',
  'todo_create', 'todo_update', 'todo_list', 'spawn_agent', 'wait_agent',
  'send_message', 'followup_task', 'list_agents', 'agent_output', 'interrupt_agent'];
const MEMORY_TOOLS = ['memory_recall', 'memory_intent'];

export const DECISION: KodaXTaskRoutingDecision = {
  primaryTask: 'edit',
  workIntent: 'append',
  complexity: 'moderate',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'implementation',
  recommendedThinkingDepth: 'medium',
  confidence: 0.7,
  reason: 'fixture',
  requiresBrainstorm: false,
};

export interface SeededStore {
  readonly identity: MemoryContextIdentity;
  readonly controller: MemoryManagementController;
  readonly cwd: string;
}

/** Machine-independent identity so memory ref ids (hashes of tenant/user/project) are stable. */
export async function seedStore(
  name: string,
  seeds: readonly MemorySeed[],
): Promise<SeededStore> {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  // Unique per call: parallel test files and repeated prepares never share a store.
  const root = mkdtempSync(path.join(FIXTURE_ROOT, `${name}-`));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const identity: MemoryContextIdentity = {
    configHome: home,
    tenantId: 'f306-tenant',
    userId: 'f306-user',
    workspaceId: VIRTUAL_CWD,
    agentId: 'kodax-coding',
    projectId: 'f306-project',
    sessionId: 'f306-session',
  };
  const controller = createMemoryControlPlane({
    cwd,
    identity,
    projectDocs: [],
    discoverSkills: false,
    now: () => FIXED_NOW,
  });
  for (const seed of seeds) {
    const result = await controller.remember({ ...seed, evidenceRef: 'user:f306-seed' });
    if (result.status !== 'remembered') {
      throw new Error(`seed ${seed.claimKey} was not remembered: ${result.status} ${result.reason ?? ''}`);
    }
  }
  return { identity, controller, cwd };
}

/** Same call parameters as run-substrate.ts (task = the user prompt, 12 candidates, 5 hints, no snippets). */
export async function buildSeededPack(readCase: ReadCase): Promise<{ pack: MemoryPack; store: SeededStore }> {
  const store = await seedStore(`read-${readCase.id}`, readCase.seeds);
  const pack = await store.controller.buildMemoryPack({
    task: readCase.userMessage,
    identity: store.identity,
    maxCandidates: 12,
    maxHints: 5,
    includeSnippets: false,
  });
  return { pack, store };
}

export interface ReadCellInput {
  readonly systemPrompt: string;
  readonly priorMessages: readonly KodaXMessage[];
  readonly userMessage: string;
  readonly tools: readonly KodaXToolDefinition[];
}

/**
 * Arms A and B are the prompt before the note memory existed. The note memory is
 * on by default now, so the legacy sections only appear with the switch off.
 */
async function withLegacyMemory<T>(build: () => Promise<T>): Promise<T> {
  const previous = process.env.KODAX_MEMORY_NOTES;
  process.env.KODAX_MEMORY_NOTES = '0';
  try {
    return await build();
  } finally {
    if (previous === undefined) delete process.env.KODAX_MEMORY_NOTES;
    else process.env.KODAX_MEMORY_NOTES = previous;
  }
}

async function capabilityBlocks(
  arm: Arm,
  pack: MemoryPack | undefined,
  store: SeededStore | undefined,
  cwd: string,
): Promise<{ stable: string | undefined; dynamic: string | undefined }> {
  const sections = await withLegacyMemory(() => buildCapabilityContextSections({
    provider: 'f306-eval',
    context: {
      executionCwd: cwd,
      ...(pack === undefined ? {} : { memoryPack: pack }),
      ...(store === undefined ? {} : { memoryIdentity: store.identity }),
    },
  }, false, cwd));
  const kept = sections
    .filter((section) => CAPABILITY_SECTION_IDS.includes(section.id))
    .filter((section) => arm === 'B' || !MEMORY_SECTION_IDS.includes(section.id));
  // runner-driven.ts splits these ids into the stable system block; the rest ride the run context.
  const stableIds = ['project-agents', 'self-knowledge-routing', 'memory-rules', 'tool-construction'];
  const join = (items: typeof kept): string | undefined =>
    items.length === 0 ? undefined : items.map((section) => section.content).join('\n\n');
  return {
    stable: join(kept.filter((section) => stableIds.includes(section.id))),
    dynamic: join(kept.filter((section) => !stableIds.includes(section.id))),
  };
}

function rootAgent(toolNames: readonly string[]): Agent {
  const tools = toolNames.map((name) => {
    const builtin = getBuiltinToolDefinition(name);
    if (builtin === undefined) throw new Error(`builtin tool missing: ${name}`);
    return projectModelToolDefinition(builtin, { kind: 'builtin' });
  });
  const agent: Agent = { name: WORKER_AGENT_NAME, instructions: '', tools };
  markRegistryManagedAgent(agent, {} as KodaXToolExecutionContext);
  markOrdinaryRootToolContract(agent);
  return agent;
}

export interface CapabilityBlocks {
  readonly stable: string | undefined;
  readonly dynamic: string | undefined;
}

/** Production Worker assembly shared by every arm; arms differ only in tool names and capability blocks. */
export function assembleReadCell(
  readCase: Pick<ReadCase, 'history' | 'userMessage'>,
  toolNames: readonly string[],
  blocks: CapabilityBlocks,
): ReadCellInput {
  const agent = rootAgent(toolNames);
  const tools = projectManagedToolContracts(agent, agent.tools ?? []);
  const availableToolNames = (agent.tools ?? []).map((tool) => tool.name);
  const rolePromptContext: ManagedRolePromptContext = {
    originalTask: readCase.userMessage,
    availableToolNames,
    workspace: { executionCwd: VIRTUAL_CWD, platform: 'linux' },
    ...(blocks.dynamic === undefined ? {} : { capabilityContextBlock: blocks.dynamic }),
    ...(blocks.stable === undefined ? {} : { stableCapabilityContextBlock: blocks.stable }),
  };
  const promptContext: RunnerChainPromptContext = {
    prompt: readCase.userMessage,
    decision: DECISION,
    contextFactory: () => rolePromptContext,
  };
  const stable = resolveRoleInstructions(
    'worker', WORKER_AGENT_NAME, '', promptContext, undefined, undefined, availableToolNames,
  );
  const systemPrompt = projectManagedSystemContract(agent, tools, stable);
  const context = resolveRoleRunContext(
    'worker', WORKER_AGENT_NAME, promptContext, undefined, rolePromptContext,
  );
  return {
    systemPrompt,
    priorMessages: [
      ...readCase.history,
      ...(context === undefined ? [] : [createManagedRunContextMessage(context)]),
    ],
    userMessage: readCase.userMessage,
    tools,
  };
}

export async function buildReadCellInput(readCase: ReadCase, arm: Arm): Promise<ReadCellInput> {
  const seeded = arm === 'B' ? await buildSeededPack(readCase) : undefined;
  const cwd = seeded?.store.cwd ?? path.join(FIXTURE_ROOT, `read-${readCase.id}`, 'cwd');
  mkdirSync(cwd, { recursive: true });
  const blocks = await capabilityBlocks(arm, seeded?.pack, seeded?.store, cwd);
  return assembleReadCell(readCase, arm === 'B' ? [...ROOT_TOOLS, ...MEMORY_TOOLS] : ROOT_TOOLS, blocks);
}

export interface HintObservation {
  readonly surfaced: boolean;
  readonly hintCount: number;
  readonly hooks: readonly string[];
  /** The decisive detail (command, path) appears in the title-only hook the model sees. */
  readonly decisiveDetailInHook: boolean;
  readonly hookMaxChars: number;
}

/** Layer 1 (deterministic, $0): does the pack surface the seeded memory and carry its detail? */
export function observeHint(readCase: ReadCase, pack: MemoryPack): HintObservation {
  const hooks = pack.promptHints.map((hint) => hint.hook);
  return {
    surfaced: pack.promptHints.length > 0 && !pack.traceMetadata.suppressed,
    hintCount: pack.promptHints.length,
    hooks,
    decisiveDetailInHook: hooks.some((hook) => hook.includes(readCase.decisiveDetail)),
    hookMaxChars: Math.max(0, ...hooks.map((hook) => hook.length)),
  };
}

export interface WriteCellInput {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly tools: readonly KodaXToolDefinition[];
  readonly forcedToolName: string;
  readonly reviewerInput: UnifiedLearningReviewModelInput;
}

/** Offline replica of the private `buildUnifiedReviewInput` (memory-runtime.ts) for a fixed digest. */
export async function buildReviewerInput(
  digest: KodaXMemoryOutcomeDigest,
  controller: MemoryManagementController,
): Promise<UnifiedLearningReviewModelInput> {
  if (controller.prepareEpisodeReview === undefined) throw new Error('controller lacks prepareEpisodeReview');
  const memory = await controller.prepareEpisodeReview(digest);
  const packet: LearningReviewEvidencePacket = {
    outcomeDigest: digest,
    exactInvokedSkill: null,
    verifierFacts: [],
    priorDigests: [],
    qualification: {
      reusableMethodEvidence: false,
      explicitSkillPreservation: false,
      independentEpisodeCount: 1,
      verifiedOutcome: false,
      exactSkillInvoked: false,
      failedWithLesson: false,
    },
  };
  return sanitizeUnifiedLearningReviewInput({ cacheDomain: 'learning-review', memory, evidence: packet });
}

/** The reviewer's wire request: system prompt, forced tool and `JSON.stringify(input)` as in learning-reviewer.ts. */
export async function buildWriteCellInput(writeCase: WriteCase): Promise<WriteCellInput> {
  const store = await seedStore(`write-${writeCase.id}`, []);
  const reviewerInput = await buildReviewerInput(writeCase.digest, store.controller);
  return {
    systemPrompt: LEARNING_REVIEW_SYSTEM_PROMPT,
    userMessage: JSON.stringify(reviewerInput),
    tools: [LEARNING_REVIEW_TOOL],
    forcedToolName: REVIEW_TOOL_NAME,
    reviewerInput,
  };
}
