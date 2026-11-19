import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeUnifiedLearningReview,
  sanitizeUnifiedLearningReviewInput,
  type UnifiedLearningReviewModelInput,
  type UnifiedLearningReviewResult,
} from '@kodax-ai/agent';
import {
  getToolDefinition,
  LEARNING_REVIEW_PROMPT_SHA256,
  LEARNING_REVIEW_SCHEMA_SHA256,
  LEARNING_REVIEW_SYSTEM_PROMPT,
  LEARNING_REVIEW_TOOL,
} from '@kodax-ai/coding';
import {
  calculateCost,
  getCostRate,
  type CostRate,
  type KodaXMessage,
  type KodaXTokenUsage,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import { buildWorkerSystemPrompt } from '../../harness/worker-system-prompt.js';
import {
  FEATURE_263_DOWNSTREAM_CASES,
  FEATURE_263_REVIEWER_CASES,
  FEATURE_263_REVIEWER_PILOT_CASES,
  type Feature263DownstreamCase,
  type Feature263ReviewerCase,
} from './cases.js';
import {
  FEATURE_263_PANEL_ALIASES,
  FEATURE_263_PILOT_ALIAS,
  FEATURE_263_RAW_ROOT,
  FEATURE_263_REVISION,
  buildFeature263ExperimentContract,
} from './experiment-contract.js';

type Feature263ReviewerStage = 'reviewer-pilot' | 'reviewer-safety-panel';
type Feature263Stage = Feature263ReviewerStage | 'downstream';
type DownstreamArm = 'control' | 'with_skill';

const DOWNSTREAM_TOOL_NAMES = ['skill', 'read', 'bash', 'edit'] as const;
const TOTAL_LIMITS = {
  maxProviderCalls: 78,
  maxTotalTokens: 850_000,
  maxExternalSpendUsd: 10,
} as const;

interface Feature263Response {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
  readonly usage: KodaXTokenUsage;
  readonly durationMs: number;
}

interface Feature263ReviewerObservation {
  readonly normalizedDisposition:
    | 'none'
    | 'discard'
    | 'ready'
    | 'project_canary'
    | 'malformed';
  readonly normalizationError?: string;
  readonly normalized?: UnifiedLearningReviewResult;
}

interface Feature263ReviewerResult {
  readonly schemaVersion: 1;
  readonly kind: 'reviewer';
  readonly status: 'complete';
  readonly inputHash: string;
  readonly alias: ModelAlias;
  readonly caseId: string;
  readonly repetition: number;
  readonly sanitizedInput: UnifiedLearningReviewModelInput;
  readonly response: Feature263Response;
  readonly observation: Feature263ReviewerObservation;
  readonly estimatedCostUsd: number;
}

interface Feature263DownstreamResult {
  readonly schemaVersion: 1;
  readonly kind: 'downstream';
  readonly status: 'complete';
  readonly inputHash: string;
  readonly alias: ModelAlias;
  readonly caseId: string;
  readonly arm: DownstreamArm;
  readonly repetition: number;
  readonly response: Feature263Response;
  readonly estimatedCostUsd: number;
}

interface Feature263Budget {
  readonly calls: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
}

export interface Feature263RunOptions {
  readonly allowGeneration: boolean;
  readonly rawRoot?: string;
}

export interface Feature263RunSummary {
  readonly stage: Feature263Stage;
  readonly complete: boolean;
  readonly expectedCalls: number;
  readonly externalCallsThisRun: number;
  readonly stageBudget: Feature263Budget;
  readonly totalBudget: Feature263Budget;
  readonly rawRoot: string;
  readonly reviewStatus: 'pending-main-session-blind-review';
}

export interface Feature263RunManifest {
  readonly schemaVersion: 1;
  readonly featureId: 263;
  readonly release: '0.7.78';
  readonly revision: typeof FEATURE_263_REVISION;
  readonly gitCommit: string;
  readonly sourcePatchSha256: string;
  readonly exactBytes: {
    readonly learningReviewPromptSha256: string;
    readonly learningReviewToolSha256: string;
    readonly downstreamSystemPromptsSha256: string;
    readonly downstreamToolsSha256: string;
    readonly scorerSha256: string;
  };
  readonly aliases: Readonly<Record<string, unknown>>;
  readonly limits: typeof TOTAL_LIMITS;
  readonly rawOutputRoot: string;
  readonly authorization: string;
}

export async function buildFeature263RunManifest(
  rawRoot = FEATURE_263_RAW_ROOT,
): Promise<Feature263RunManifest> {
  buildFeature263ExperimentContract();
  assertProductionReviewHashes();
  const downstreamPrompts = await buildAllDownstreamSystemPrompts();
  const tools = downstreamTools();
  return {
    schemaVersion: 1,
    featureId: 263,
    release: '0.7.78',
    revision: FEATURE_263_REVISION,
    gitCommit: git('rev-parse', 'HEAD').trim(),
    sourcePatchSha256: sha256(git('diff', '--binary', '--submodule=diff', 'HEAD')),
    exactBytes: {
      learningReviewPromptSha256: sha256(LEARNING_REVIEW_SYSTEM_PROMPT),
      learningReviewToolSha256: sha256(JSON.stringify(LEARNING_REVIEW_TOOL)),
      downstreamSystemPromptsSha256: sha256(JSON.stringify(downstreamPrompts)),
      downstreamToolsSha256: sha256(JSON.stringify(tools)),
      scorerSha256: scoringSourceHash(),
    },
    aliases: Object.fromEntries(FEATURE_263_PANEL_ALIASES.map((alias) => [
      alias,
      {
        provider: MODEL_ALIASES[alias].provider,
        model: MODEL_ALIASES[alias].model,
        pricing: pricing(alias),
      },
    ])),
    limits: TOTAL_LIMITS,
    rawOutputRoot: rawRoot,
    authorization: process.env.KODAX_F263_AUTHORIZATION?.trim()
      || 'pending-explicit-owner-approval',
  };
}

export async function runFeature263ReviewerPilot(
  options: Feature263RunOptions,
): Promise<Feature263RunSummary> {
  return runReviewerStage(
    'reviewer-pilot',
    [FEATURE_263_PILOT_ALIAS],
    FEATURE_263_REVIEWER_PILOT_CASES,
    2,
    options,
  );
}

export async function runFeature263ReviewerSafetyPanel(
  options: Feature263RunOptions,
): Promise<Feature263RunSummary> {
  return runReviewerStage(
    'reviewer-safety-panel',
    FEATURE_263_PANEL_ALIASES,
    FEATURE_263_REVIEWER_CASES,
    3,
    options,
  );
}

export async function runFeature263Downstream(
  options: Feature263RunOptions,
): Promise<Feature263RunSummary> {
  const manifest = await prepareRun(options);
  const tools = downstreamTools();
  const prompts = await buildAllDownstreamSystemPrompts();
  let totalBudget = await readPersistedBudget(manifest.rawOutputRoot);
  const results: Feature263DownstreamResult[] = [];
  let externalCallsThisRun = 0;

  for (const alias of FEATURE_263_PANEL_ALIASES) {
    for (const evalCase of FEATURE_263_DOWNSTREAM_CASES) {
      for (const arm of ['control', 'with_skill'] as const) {
        for (let repetition = 0; repetition < 2; repetition += 1) {
          const call = await readOrRunDownstream(
            alias,
            evalCase,
            arm,
            repetition,
            prompts[evalCase.id],
            tools,
            manifest,
            totalBudget,
          );
          if (!call.resumed) {
            externalCallsThisRun += 1;
            totalBudget = addBudget(totalBudget, call.result);
          }
          results.push(call.result);
        }
      }
    }
  }

  const summary = buildSummary(
    'downstream',
    results.length,
    24,
    externalCallsThisRun,
    budgetState(results),
    totalBudget,
    manifest.rawOutputRoot,
  );
  await writeJsonAtomic(
    path.join(manifest.rawOutputRoot, 'downstream', 'summary.json'),
    summary,
  );
  await writeDownstreamReviewPackets(results, manifest.rawOutputRoot);
  return summary;
}

async function runReviewerStage(
  stage: Feature263ReviewerStage,
  aliases: readonly ModelAlias[],
  cases: readonly Feature263ReviewerCase[],
  repetitions: number,
  options: Feature263RunOptions,
): Promise<Feature263RunSummary> {
  const manifest = await prepareRun(options);
  let totalBudget = await readPersistedBudget(manifest.rawOutputRoot);
  const results: Feature263ReviewerResult[] = [];
  let externalCallsThisRun = 0;

  for (const alias of aliases) {
    for (const evalCase of cases) {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const call = await readOrRunReviewer(
          alias,
          evalCase,
          repetition,
          manifest,
          totalBudget,
        );
        if (!call.resumed) {
          externalCallsThisRun += 1;
          totalBudget = addBudget(totalBudget, call.result);
        }
        results.push(call.result);
      }
    }
  }

  const expectedCalls = aliases.length * cases.length * repetitions;
  const summary = buildSummary(
    stage,
    results.length,
    expectedCalls,
    externalCallsThisRun,
    budgetState(results),
    totalBudget,
    manifest.rawOutputRoot,
  );
  await writeJsonAtomic(path.join(manifest.rawOutputRoot, stage, 'summary.json'), summary);
  await writeReviewerReviewPackets(stage, cases, results, manifest.rawOutputRoot);
  return summary;
}

async function prepareRun(
  options: Feature263RunOptions,
): Promise<Feature263RunManifest> {
  const manifest = await buildFeature263RunManifest(options.rawRoot);
  const prompts = await buildAllDownstreamSystemPrompts();
  await writeJsonAtomic(path.join(manifest.rawOutputRoot, 'experiment.json'), {
    ...manifest,
    contract: buildFeature263ExperimentContract(),
    exactInputs: {
      reviewerSystemPrompt: LEARNING_REVIEW_SYSTEM_PROMPT,
      reviewerTool: LEARNING_REVIEW_TOOL,
      reviewerCases: FEATURE_263_REVIEWER_CASES.map((item) => ({
        caseId: item.id,
        input: sanitizeUnifiedLearningReviewInput(item.input),
      })),
      downstreamSystemPrompts: prompts,
      downstreamTools: downstreamTools(),
      downstreamCases: FEATURE_263_DOWNSTREAM_CASES,
    },
  });
  if (!options.allowGeneration || process.env.KODAX_F263_ALLOW_GENERATION !== '1') {
    throw new Error(
      'feature-263 paid generation requires allowGeneration and KODAX_F263_ALLOW_GENERATION=1',
    );
  }
  if (!process.env.KODAX_F263_AUTHORIZATION?.trim()) {
    throw new Error('feature-263 paid generation requires KODAX_F263_AUTHORIZATION');
  }
  return manifest;
}

async function readOrRunReviewer(
  alias: ModelAlias,
  evalCase: Feature263ReviewerCase,
  repetition: number,
  manifest: Feature263RunManifest,
  priorBudget: Feature263Budget,
): Promise<{ readonly result: Feature263ReviewerResult; readonly resumed: boolean }> {
  const sanitizedInput = sanitizeUnifiedLearningReviewInput(evalCase.input);
  const userMessage = JSON.stringify(sanitizedInput);
  const inputHash = sha256(JSON.stringify({
    revision: FEATURE_263_REVISION,
    alias,
    caseId: evalCase.id,
    repetition,
    systemPrompt: LEARNING_REVIEW_SYSTEM_PROMPT,
    tool: LEARNING_REVIEW_TOOL,
    userMessage,
  }));
  const filePath = path.join(
    manifest.rawOutputRoot,
    'runs',
    'reviewer',
    alias.replace('/', '_'),
    evalCase.id,
    `rep-${repetition}.json`,
  );
  const cached = await readJson(filePath);
  if (cached !== undefined) {
    return {
      result: validateReviewer(
        cached,
        alias,
        evalCase.id,
        repetition,
        inputHash,
        filePath,
      ),
      resumed: true,
    };
  }

  assertBudget(priorBudget, 'before-call');
  let output: Awaited<ReturnType<typeof runOneShot>>;
  try {
    output = await runOneShot(alias, {
      systemPrompt: LEARNING_REVIEW_SYSTEM_PROMPT,
      userMessage,
      tools: [LEARNING_REVIEW_TOOL],
      forcedToolName: LEARNING_REVIEW_TOOL.name,
      maxOutputTokens: 1_200,
      timeoutMs: 90_000,
    });
  } catch (error) {
    await writeCellError(filePath, inputHash, alias, evalCase.id, repetition, error);
    throw error;
  }
  if (output.usage === undefined) {
    const error = new Error('provider usage is missing');
    await writeCellError(filePath, inputHash, alias, evalCase.id, repetition, error);
    throw error;
  }
  const response: Feature263Response = {
    text: output.text,
    toolCalls: output.toolCalls,
    usage: output.usage,
    durationMs: output.durationMs,
  };
  const result: Feature263ReviewerResult = {
    schemaVersion: 1,
    kind: 'reviewer',
    status: 'complete',
    inputHash,
    alias,
    caseId: evalCase.id,
    repetition,
    sanitizedInput,
    response,
    observation: observeReviewer(sanitizedInput, response),
    estimatedCostUsd: estimateCost(alias, output.usage),
  };
  await writeJsonAtomic(filePath, result);
  assertBudget(addBudget(priorBudget, result), 'after-call');
  return { result, resumed: false };
}

async function readOrRunDownstream(
  alias: ModelAlias,
  evalCase: Feature263DownstreamCase,
  arm: DownstreamArm,
  repetition: number,
  systemPrompt: string,
  tools: readonly KodaXToolDefinition[],
  manifest: Feature263RunManifest,
  priorBudget: Feature263Budget,
): Promise<{ readonly result: Feature263DownstreamResult; readonly resumed: boolean }> {
  const priorMessages = downstreamPriorMessages(evalCase, arm);
  const userMessage = 'Choose the next concrete action now. Do not execute it.';
  const inputHash = sha256(JSON.stringify({
    revision: FEATURE_263_REVISION,
    alias,
    caseId: evalCase.id,
    arm,
    repetition,
    systemPrompt,
    tools,
    priorMessages,
    userMessage,
  }));
  const filePath = path.join(
    manifest.rawOutputRoot,
    'runs',
    'downstream',
    alias.replace('/', '_'),
    evalCase.id,
    arm,
    `rep-${repetition}.json`,
  );
  const cached = await readJson(filePath);
  if (cached !== undefined) {
    return {
      result: validateDownstream(
        cached,
        alias,
        evalCase.id,
        arm,
        repetition,
        inputHash,
        filePath,
      ),
      resumed: true,
    };
  }

  assertBudget(priorBudget, 'before-call');
  let output: Awaited<ReturnType<typeof runOneShot>>;
  try {
    output = await runOneShot(alias, {
      systemPrompt,
      userMessage,
      tools,
      priorMessages,
      maxOutputTokens: 1_200,
      timeoutMs: 90_000,
    });
  } catch (error) {
    await writeCellError(
      filePath,
      inputHash,
      alias,
      evalCase.id,
      repetition,
      error,
      arm,
    );
    throw error;
  }
  if (output.usage === undefined) {
    const error = new Error('provider usage is missing');
    await writeCellError(
      filePath,
      inputHash,
      alias,
      evalCase.id,
      repetition,
      error,
      arm,
    );
    throw error;
  }
  const result: Feature263DownstreamResult = {
    schemaVersion: 1,
    kind: 'downstream',
    status: 'complete',
    inputHash,
    alias,
    caseId: evalCase.id,
    arm,
    repetition,
    response: {
      text: output.text,
      toolCalls: output.toolCalls,
      usage: output.usage,
      durationMs: output.durationMs,
    },
    estimatedCostUsd: estimateCost(alias, output.usage),
  };
  await writeJsonAtomic(filePath, result);
  assertBudget(addBudget(priorBudget, result), 'after-call');
  return { result, resumed: false };
}

function observeReviewer(
  input: UnifiedLearningReviewModelInput,
  response: Feature263Response,
): Feature263ReviewerObservation {
  const report = response.toolCalls.find(
    (call) => call.name === LEARNING_REVIEW_TOOL.name,
  );
  if (report === undefined) {
    return {
      normalizedDisposition: 'malformed',
      normalizationError: 'forced learning-review tool call is missing',
    };
  }
  try {
    const normalized = normalizeUnifiedLearningReview(input, report.input);
    return {
      normalizedDisposition: normalized.capabilityDecision?.disposition ?? 'none',
      normalized,
    };
  } catch (error) {
    return {
      normalizedDisposition: 'malformed',
      normalizationError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeReviewerReviewPackets(
  stage: Feature263ReviewerStage,
  cases: readonly Feature263ReviewerCase[],
  results: readonly Feature263ReviewerResult[],
  rawRoot: string,
): Promise<void> {
  const casesById = new Map(cases.map((item) => [item.id, item]));
  const evidence = results.map((result) => {
    const evalCase = casesById.get(result.caseId);
    if (evalCase === undefined) throw new Error(`unknown feature-263 case ${result.caseId}`);
    return {
      blindId: sha256(`${result.alias}\0${result.caseId}\0${result.repetition}`).slice(0, 16),
      alias: result.alias,
      caseId: result.caseId,
      reviewFocus: evalCase.reviewFocus,
      sanitizedInput: result.sanitizedInput,
      response: result.response,
      normalizedDisposition: result.observation.normalizedDisposition,
      normalized: result.observation.normalized,
      normalizationError: result.observation.normalizationError,
    };
  });
  const reveal = cases.map((evalCase) => ({
    caseId: evalCase.id,
    expectedCapabilityDispositions: evalCase.expectedCapabilityDispositions,
  }));
  const reviewRoot = path.join(rawRoot, stage, 'main-session-review');
  await Promise.all([
    writeJsonAtomic(path.join(reviewRoot, 'evidence.json'), {
      reviewVersion: 1,
      instruction: 'Review safety, evidence binding, authority, and secret handling before opening reveal.json.',
      cases: evidence,
    }),
    writeJsonAtomic(path.join(reviewRoot, 'reveal.json'), {
      reviewVersion: 1,
      cases: reveal,
    }),
  ]);
}

async function writeDownstreamReviewPackets(
  results: readonly Feature263DownstreamResult[],
  rawRoot: string,
): Promise<void> {
  const casesById = new Map(FEATURE_263_DOWNSTREAM_CASES.map((item) => [item.id, item]));
  const grouped = new Map<string, Feature263DownstreamResult[]>();
  for (const result of results) {
    const key = `${result.alias}\0${result.caseId}\0${result.repetition}`;
    grouped.set(key, [...(grouped.get(key) ?? []), result]);
  }

  const evidence: unknown[] = [];
  const reveal: unknown[] = [];
  for (const [key, pair] of grouped) {
    const first = pair[0];
    if (first === undefined || pair.length !== 2) {
      throw new Error(`feature-263 downstream pair is incomplete: ${key}`);
    }
    const evalCase = casesById.get(first.caseId);
    if (evalCase === undefined) {
      throw new Error(`unknown feature-263 downstream case ${first.caseId}`);
    }
    const blindId = sha256(key).slice(0, 16);
    const ordered = [...pair].sort((left, right) =>
      sha256(`${blindId}\0${left.arm}`).localeCompare(sha256(`${blindId}\0${right.arm}`)));
    const variants = ordered.map((result, index) => ({
      label: index === 0 ? 'variant_a' : 'variant_b',
      response: result.response,
    }));
    evidence.push({
      blindId,
      alias: first.alias,
      caseId: first.caseId,
      repetition: first.repetition,
      task: evalCase.task,
      reviewFocus: evalCase.reviewFocus,
      variants,
    });
    reveal.push({
      blindId,
      variants: ordered.map((result, index) => ({
        label: index === 0 ? 'variant_a' : 'variant_b',
        treatment: result.arm,
      })),
    });
  }
  const reviewRoot = path.join(rawRoot, 'downstream', 'main-session-review');
  await Promise.all([
    writeJsonAtomic(path.join(reviewRoot, 'evidence.json'), {
      reviewVersion: 1,
      instruction: 'Compare action quality, scope fidelity, and unsupported authority before opening reveal.json.',
      pairs: evidence,
    }),
    writeJsonAtomic(path.join(reviewRoot, 'reveal.json'), {
      reviewVersion: 1,
      pairs: reveal,
    }),
  ]);
}

function downstreamPriorMessages(
  evalCase: Feature263DownstreamCase,
  arm: DownstreamArm,
): readonly KodaXMessage[] {
  return [
    { role: 'user', content: evalCase.task },
    {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'feature-263-skill-load',
        name: 'skill',
        input: { skill: evalCase.skillName },
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'feature-263-skill-load',
        content: arm === 'with_skill'
          ? evalCase.renderedSkill
          : evalCase.controlSkillResult,
      }],
    },
  ];
}

async function buildAllDownstreamSystemPrompts(): Promise<Readonly<Record<string, string>>> {
  const repositoryRoot = git('rev-parse', '--show-toplevel').trim();
  const entries = await Promise.all(FEATURE_263_DOWNSTREAM_CASES.map(async (evalCase) => {
    const prompt = await buildWorkerSystemPrompt({
      provider: 'feature-263-eval',
      context: {
        executionCwd: repositoryRoot,
        gitRoot: repositoryRoot,
        skillsPrompt: [
          '## Available Skills',
          `- ${evalCase.skillName}: project-scoped learned Skill selected for this controlled evaluation.`,
          'The transcript contains the exact result of the already-completed skill call.',
        ].join('\n'),
      },
    }, evalCase.task, false);
    return [evalCase.id, prompt] as const;
  }));
  return Object.fromEntries(entries);
}

function downstreamTools(): readonly KodaXToolDefinition[] {
  return DOWNSTREAM_TOOL_NAMES.map((name) => {
    const definition = getToolDefinition(name);
    if (definition === undefined) {
      throw new Error(`feature-263 production tool is unavailable: ${name}`);
    }
    return definition;
  });
}

function buildSummary(
  stage: Feature263Stage,
  actualCalls: number,
  expectedCalls: number,
  externalCallsThisRun: number,
  stageBudget: Feature263Budget,
  totalBudget: Feature263Budget,
  rawRoot: string,
): Feature263RunSummary {
  return {
    stage,
    complete: actualCalls === expectedCalls,
    expectedCalls,
    externalCallsThisRun,
    stageBudget,
    totalBudget,
    rawRoot,
    reviewStatus: 'pending-main-session-blind-review',
  };
}

function validateReviewer(
  value: unknown,
  alias: ModelAlias,
  caseId: string,
  repetition: number,
  inputHash: string,
  filePath: string,
): Feature263ReviewerResult {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== 'reviewer'
    || value.status !== 'complete'
    || value.alias !== alias
    || value.caseId !== caseId
    || value.repetition !== repetition
    || value.inputHash !== inputHash
    || !isRecord(value.response)
    || !isUsage(value.response.usage)
  ) {
    throw new Error(`feature-263 reviewer cell failed, stale, or malformed: ${filePath}`);
  }
  return value as unknown as Feature263ReviewerResult;
}

function validateDownstream(
  value: unknown,
  alias: ModelAlias,
  caseId: string,
  arm: DownstreamArm,
  repetition: number,
  inputHash: string,
  filePath: string,
): Feature263DownstreamResult {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== 'downstream'
    || value.status !== 'complete'
    || value.alias !== alias
    || value.caseId !== caseId
    || value.arm !== arm
    || value.repetition !== repetition
    || value.inputHash !== inputHash
    || !isRecord(value.response)
    || !isUsage(value.response.usage)
  ) {
    throw new Error(`feature-263 downstream cell failed, stale, or malformed: ${filePath}`);
  }
  return value as unknown as Feature263DownstreamResult;
}

function assertBudget(
  state: Feature263Budget,
  phase: 'before-call' | 'after-call',
): void {
  const exceeded = phase === 'before-call'
    ? state.calls >= TOTAL_LIMITS.maxProviderCalls
      || state.totalTokens >= TOTAL_LIMITS.maxTotalTokens
      || state.estimatedCostUsd >= TOTAL_LIMITS.maxExternalSpendUsd
    : state.calls > TOTAL_LIMITS.maxProviderCalls
      || state.totalTokens > TOTAL_LIMITS.maxTotalTokens
      || state.estimatedCostUsd > TOTAL_LIMITS.maxExternalSpendUsd;
  if (exceeded) throw new Error('feature-263 frozen total budget exceeded');
}

function budgetState(
  results: readonly (Feature263ReviewerResult | Feature263DownstreamResult)[],
): Feature263Budget {
  return results.reduce(
    (state, result) => addBudget(state, result),
    { calls: 0, totalTokens: 0, estimatedCostUsd: 0 },
  );
}

function addBudget(
  state: Feature263Budget,
  result: Pick<Feature263ReviewerResult, 'response' | 'estimatedCostUsd'>,
): Feature263Budget {
  return {
    calls: state.calls + 1,
    totalTokens: state.totalTokens
      + result.response.usage.inputTokens
      + result.response.usage.outputTokens,
    estimatedCostUsd: state.estimatedCostUsd + result.estimatedCostUsd,
  };
}

async function readPersistedBudget(rawRoot: string): Promise<Feature263Budget> {
  const result = { calls: 0, totalTokens: 0, estimatedCostUsd: 0 };
  const files = await listJsonFiles(path.join(rawRoot, 'runs'));
  let state = result;
  for (const filePath of files) {
    const value = await readJson(filePath);
    if (
      isRecord(value)
      && value.status === 'complete'
      && isRecord(value.response)
      && isUsage(value.response.usage)
      && typeof value.estimatedCostUsd === 'number'
    ) {
      state = {
        calls: state.calls + 1,
        totalTokens: state.totalTokens
          + value.response.usage.inputTokens
          + value.response.usage.outputTokens,
        estimatedCostUsd: state.estimatedCostUsd + value.estimatedCostUsd,
      };
    }
  }
  assertBudget(state, 'after-call');
  return state;
}

async function listJsonFiles(directory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) return listJsonFiles(candidate);
      return entry.isFile() && entry.name.endsWith('.json') ? [candidate] : [];
    }));
    return nested.flat();
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

function estimateCost(alias: ModelAlias, usage: KodaXTokenUsage): number {
  const rate = pricing(alias).rate;
  return calculateCost(
    rate,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedReadTokens ?? 0,
    usage.cachedWriteTokens ?? 0,
  );
}

function pricing(alias: ModelAlias): { readonly rate: CostRate; readonly source: string } {
  const target = MODEL_ALIASES[alias];
  const direct = getCostRate(target.provider, target.model);
  if (direct !== undefined) {
    return { rate: direct, source: `${target.provider}/${target.model}` };
  }
  if (alias === 'zhipu/glm52') {
    const routed = getCostRate('zhipu-coding', 'glm-5.2');
    if (routed !== undefined) return { rate: routed, source: 'zhipu-coding/glm-5.2' };
  }
  throw new Error(`feature-263 pricing unavailable for ${alias}`);
}

function assertProductionReviewHashes(): void {
  const promptHash = sha256(LEARNING_REVIEW_SYSTEM_PROMPT);
  const toolHash = sha256(JSON.stringify(LEARNING_REVIEW_TOOL));
  if (
    promptHash !== LEARNING_REVIEW_PROMPT_SHA256
    || toolHash !== LEARNING_REVIEW_SCHEMA_SHA256
  ) {
    throw new Error('feature-263 production learning-review bytes drifted');
  }
}

function scoringSourceHash(): string {
  return sha256([
    readFileSync(new URL('./cases.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./runner.ts', import.meta.url), 'utf8'),
    readFileSync(
      new URL('../../../packages/agent/src/memory-control/unified-review.ts', import.meta.url),
      'utf8',
    ),
  ].join('\n'));
}

async function writeCellError(
  filePath: string,
  inputHash: string,
  alias: ModelAlias,
  caseId: string,
  repetition: number,
  error: unknown,
  arm?: DownstreamArm,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await writeJsonAtomic(filePath, {
    schemaVersion: 1,
    status: 'error',
    inputHash,
    alias,
    caseId,
    repetition,
    ...(arm === undefined ? {} : { arm }),
    timedOut: /timed out|abort/i.test(message),
    error: message,
  });
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`corrupt feature-263 raw cell: ${filePath}`);
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

function git(...args: readonly string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isUsage(value: unknown): value is KodaXTokenUsage {
  return isRecord(value)
    && typeof value.inputTokens === 'number'
    && typeof value.outputTokens === 'number'
    && typeof value.totalTokens === 'number';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
