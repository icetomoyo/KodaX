/**
 * KodaX 项目命令处理器
 *
 * 处理 /project 命令组的所有子命令
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { runKodaX, KodaXOptions, KodaXMessage } from '@kodax/coding';
import { ProjectStorage } from './project-storage.js';
import {
  ProjectFeature,
  ProjectStatistics,
  type ProjectAlignment,
  type ProjectBrief,
  type ProjectWorkflowScope,
  type ProjectWorkflowStage,
  type ProjectWorkflowState,
  createProjectAlignment,
  createProjectBrief,
  createProjectWorkflowState,
} from './project-state.js';
import {
  InteractiveContext,
} from './context.js';
import {
  CommandCallbacks,
  CurrentConfig,
} from './commands.js';
import {
  buildProjectQualityReport,
  formatProjectQualityReport,
  type ProjectQualityReport,
} from './project-quality.js';
import {
  buildProjectPlan,
  formatProjectPlan,
} from './project-planner.js';
import {
  appendBrainstormExchange,
  completeBrainstormSession,
  createBrainstormSession,
  formatBrainstormTranscript,
} from './project-brainstorm.js';
import {
  createProjectHarnessAttempt,
  formatProjectHarnessSummary,
  readLatestHarnessRun,
  reverifyProjectHarnessRun,
  recordManualHarnessOverride,
  type ProjectHarnessRunRecord,
  type ProjectHarnessVerificationResult,
} from './project-harness.js';

// ============== 运行时状态管理 ==============

/**
 * 项目运行时状态
 *
 * 用于管理 auto-continue 模式的状态。
 * 设计为模块级单例，因为 REPL 会话中只会有一个自动继续循环。
 */
class ProjectRuntimeState {
  private _autoContinueRunning = false;

  get autoContinueRunning(): boolean {
    return this._autoContinueRunning;
  }

  setAutoContinueRunning(value: boolean): void {
    this._autoContinueRunning = value;
  }

  /** 重置所有状态（用于测试或会话重置） */
  reset(): void {
    this._autoContinueRunning = false;
  }
}

// 模块级单例
export const projectRuntimeState = new ProjectRuntimeState();

// ============== 辅助函数 ==============

/**
 * 创建确认提示函数
 */
function createConfirmFn(rl: readline.Interface): (message: string) => Promise<boolean> {
  return (message: string): Promise<boolean> => {
    return new Promise(resolve => {
      rl.question(`${message} (y/n) `, answer => {
        resolve(answer.trim().toLowerCase().startsWith('y'));
      });
    });
  };
}

async function projectQuality(
  context: InteractiveContext,
  callbacks: CommandCallbacks,
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const snapshot = await loadProjectSnapshot(storage);
  if (!snapshot) {
    console.log(chalk.red('\n[Error] Failed to load project features\n'));
    return;
  }

  const report = buildProjectQualityReport(
    snapshot.features,
    snapshot.progressText,
    snapshot.sessionPlan,
  );

  console.log(chalk.cyan('\n/project quality - Workflow Health\n'));
  printProjectQualitySection(report);

  const options = callbacks.createKodaXOptions?.();
  if (!options) {
    printFallbackGuidedStatus('Assess workflow health and release readiness.', snapshot, report);
    return;
  }

  try {
    const content = await runProjectAnalysis(
      options,
      context,
      buildProjectAnalysisPrompt(
        snapshot,
        report,
        'Assess workflow health and release readiness.',
        'quality',
      ),
    );

    if (content) {
      console.log(chalk.cyan('AI Quality Review'));
      console.log(content);
      console.log();
    } else {
      printFallbackGuidedStatus('Assess workflow health and release readiness.', snapshot, report);
    }
  } catch (error) {
    console.log(chalk.yellow('\n[Warning] AI quality analysis failed, showing fallback summary instead.\n'));
    console.log(chalk.dim(error instanceof Error ? error.message : String(error)));
    console.log();
    printFallbackGuidedStatus('Assess workflow health and release readiness.', snapshot, report);
  }
}

/**
 * 创建问题提示函数
 */
function createQuestionFn(rl: readline.Interface): (prompt: string) => Promise<string> {
  return (prompt: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(prompt, resolve);
    });
  };
}

/**
 * 获取项目存储实例
 */
function getProjectStorage(): ProjectStorage {
  return new ProjectStorage(process.cwd());
}

interface ProjectSnapshot {
  features: ProjectFeature[];
  stats: ProjectStatistics;
  progressText: string;
  sessionPlan: string;
  nextFeature: { feature: ProjectFeature; index: number } | null;
}

async function loadProjectSnapshot(storage: ProjectStorage): Promise<ProjectSnapshot | null> {
  const featureList = await storage.loadFeatures();
  if (!featureList) {
    return null;
  }

  const [stats, progressText, sessionPlan, nextFeature] = await Promise.all([
    storage.getStatistics(),
    storage.readProgress(),
    storage.readSessionPlan(),
    storage.getNextPendingFeature(),
  ]);

  return {
    features: featureList.features,
    stats,
    progressText,
    sessionPlan,
    nextFeature,
  };
}

const OTHER_INPUT_LABEL = 'Other (type my own answer)';

interface DiscoveryQuestion {
  prompt: string;
  options: string[];
  apply: (alignment: ProjectAlignment, answer: string) => ProjectAlignment;
}

const MAX_ALIGNMENT_DERIVED_FEATURES = 6;

function appendAlignmentEntry(
  alignment: ProjectAlignment,
  field: 'confirmedRequirements' | 'constraints' | 'nonGoals' | 'acceptedTradeoffs' | 'successCriteria' | 'openQuestions',
  value: string,
): ProjectAlignment {
  return {
    ...alignment,
    [field]: [...alignment[field], value],
  };
}

const DISCOVERY_QUESTIONS: DiscoveryQuestion[] = [
  {
    prompt: 'Which outcome matters most for the first usable version?',
    options: [
      'Ship the smallest usable version quickly',
      'Reduce implementation risk before scaling',
      'Preserve compatibility with the current workflow',
    ],
    apply: (alignment, answer) => appendAlignmentEntry(alignment, 'confirmedRequirements', answer),
  },
  {
    prompt: 'Which implementation boundary or constraint must we respect?',
    options: [
      'Keep the existing interfaces stable',
      'Avoid large architectural changes',
      'Prioritize correctness over speed of delivery',
    ],
    apply: (alignment, answer) => appendAlignmentEntry(alignment, 'constraints', answer),
  },
  {
    prompt: 'What should stay out of scope for this iteration?',
    options: [
      'Defer advanced configuration and edge-case polish',
      'Defer scalability work beyond the first release',
      'Defer UI/UX refinements unless required for correctness',
    ],
    apply: (alignment, answer) => appendAlignmentEntry(alignment, 'nonGoals', answer),
  },
  {
    prompt: 'How will we know this first version is successful?',
    options: [
      'The core workflow works end to end',
      'Focused tests cover the new behavior',
      'Operators can understand the new flow without extra handholding',
    ],
    apply: (alignment, answer) => appendAlignmentEntry(alignment, 'successCriteria', answer),
  },
];

function dedupeList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(item => item.trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function normalizeAlignment(alignment: ProjectAlignment, timestamp = new Date().toISOString()): ProjectAlignment {
  return {
    ...alignment,
    confirmedRequirements: dedupeList(alignment.confirmedRequirements),
    constraints: dedupeList(alignment.constraints),
    nonGoals: dedupeList(alignment.nonGoals),
    acceptedTradeoffs: dedupeList(alignment.acceptedTradeoffs),
    successCriteria: dedupeList(alignment.successCriteria),
    openQuestions: dedupeList(alignment.openQuestions),
    updatedAt: timestamp,
  };
}

async function chooseOrInput(
  callbacks: CommandCallbacks,
  title: string,
  options: string[],
  inputPrompt: string,
): Promise<string | undefined> {
  const choice = await callbacks.ui.select(title, [...options, OTHER_INPUT_LABEL]);
  if (!choice) {
    return undefined;
  }
  if (choice === OTHER_INPUT_LABEL) {
    const typed = await callbacks.ui.input(inputPrompt);
    return typed?.trim() || undefined;
  }
  return choice;
}

type AlignmentField =
  | 'confirmedRequirements'
  | 'constraints'
  | 'nonGoals'
  | 'acceptedTradeoffs'
  | 'successCriteria'
  | 'openQuestions';

const ALIGNMENT_FIELD_OPTIONS: Array<{ label: string; field: AlignmentField }> = [
  { label: 'Confirmed requirement', field: 'confirmedRequirements' },
  { label: 'Constraint', field: 'constraints' },
  { label: 'Non-goal', field: 'nonGoals' },
  { label: 'Tradeoff', field: 'acceptedTradeoffs' },
  { label: 'Success criterion', field: 'successCriteria' },
  { label: 'Open question', field: 'openQuestions' },
];

function isRemovalInstruction(guidance: string): boolean {
  return /\b(remove|delete|drop)\b/i.test(guidance) || /(删除|移除|去掉)/.test(guidance);
}

function isAddInstruction(guidance: string): boolean {
  return /\b(add|append|include|record|note|capture|mark|set)\b/i.test(guidance) || /(添加|增加|补充|记录|加入|设为)/.test(guidance);
}

function detectAlignmentField(guidance: string): AlignmentField | null {
  if (/\bconstraint(s)?\b/i.test(guidance) || /约束/.test(guidance)) {
    return 'constraints';
  }
  if (/\bnon[-\s]?goal(s)?\b/i.test(guidance) || /非目标/.test(guidance)) {
    return 'nonGoals';
  }
  if (/\btrade[\s-]?off(s)?\b/i.test(guidance) || /取舍/.test(guidance)) {
    return 'acceptedTradeoffs';
  }
  if (/\bsuccess(\s+criteria|\s+criterion)?\b/i.test(guidance) || /成功标准|成功准则/.test(guidance)) {
    return 'successCriteria';
  }
  if (/\b(open\s+question|question)\b/i.test(guidance) || /问题|待确认/.test(guidance)) {
    return 'openQuestions';
  }
  if (/\brequirement(s)?\b/i.test(guidance) || /需求/.test(guidance)) {
    return 'confirmedRequirements';
  }
  return null;
}

function looksLikeExplicitAlignmentFieldEdit(guidance: string): boolean {
  if (/^(constraint|constraints|约束|non[-\s]?goal|non[-\s]?goals|非目标|trade[\s-]?off|trade[\s-]?offs|取舍|success(\s+criteria|\s+criterion)?|成功标准|success|question|open question|问题|requirement|requirements|需求)\s*[:：-]/i.test(guidance.trim())) {
    return true;
  }
  return detectAlignmentField(guidance) !== null && (isAddInstruction(guidance) || isRemovalInstruction(guidance));
}

function stripAlignmentEditPrefix(guidance: string, field: AlignmentField, mode: 'add' | 'remove'): string {
  const prefixesByField: Record<AlignmentField, string[]> = {
    confirmedRequirements: ['requirement', 'requirements', '需求'],
    constraints: ['constraint', 'constraints', '约束'],
    nonGoals: ['non-goal', 'non-goals', 'non goal', 'non goals', '非目标'],
    acceptedTradeoffs: ['tradeoff', 'tradeoffs', 'trade off', 'trade offs', '取舍'],
    successCriteria: ['success criteria', 'success criterion', 'success', '成功标准', '成功准则'],
    openQuestions: ['open question', 'open questions', 'question', 'questions', '问题', '待确认问题'],
  };

  const escaped = prefixesByField[field]
    .map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const actionPattern = mode === 'add'
    ? '(?:add|append|include|record|note|capture|mark|set|添加|增加|补充|记录|加入|设为)'
    : '(?:remove|delete|drop|删除|移除|去掉)';
  const prefixPattern = new RegExp(
    `^(?:${actionPattern})\\s+(?:an?\\s+|the\\s+)?(?:${escaped})(?:\\s+(?:about|for))?\\s*[:：-]?\\s*`,
    'i',
  );

  const withoutPrefix = guidance.trim().replace(prefixPattern, '');
  return withoutPrefix
    .replace(/^(about|for)\s+/i, '')
    .replace(/^(关于|针对)/, '')
    .trim();
}

function removeAlignmentEntry(
  alignment: ProjectAlignment,
  field: AlignmentField,
  guidance: string,
): { alignment: ProjectAlignment; removed: boolean } {
  const rawTarget = stripAlignmentEditPrefix(guidance, field, 'remove');
  const target = rawTarget
    .replace(/^(the\s+)?/, '')
    .replace(/^(about\s+|for\s+)/i, '')
    .trim();

  if (!target) {
    return { alignment, removed: false };
  }

  const nextItems = alignment[field].filter(item => {
    const normalizedItem = item.toLowerCase();
    const normalizedTarget = target.toLowerCase();
    return !(
      normalizedItem === normalizedTarget
      || normalizedItem.includes(normalizedTarget)
      || normalizedTarget.includes(normalizedItem)
    );
  });

  return {
    alignment: {
      ...alignment,
      [field]: nextItems,
    },
    removed: nextItems.length !== alignment[field].length,
  };
}

async function chooseAlignmentField(
  callbacks: CommandCallbacks,
  guidance: string,
): Promise<AlignmentField | null> {
  const choice = await callbacks.ui.select(
    `Which alignment area should this update? "${guidance}"`,
    ALIGNMENT_FIELD_OPTIONS.map(option => option.label),
  );
  const selected = ALIGNMENT_FIELD_OPTIONS.find(option => option.label === choice);
  return selected?.field ?? null;
}

function ensureWorkflowStateDefaults(
  state: ProjectWorkflowState,
  timestamp = new Date().toISOString(),
): ProjectWorkflowState {
  return {
    ...state,
    scope: state.scope ?? 'project',
    unresolvedQuestionCount: state.unresolvedQuestionCount ?? 0,
    discoveryStepIndex: state.discoveryStepIndex ?? 0,
    lastUpdated: state.lastUpdated ?? timestamp,
  };
}

async function getWorkflowState(storage: ProjectStorage): Promise<ProjectWorkflowState> {
  return ensureWorkflowStateDefaults(await storage.loadOrInferWorkflowState());
}

function getRecommendedNextStep(
  state: ProjectWorkflowState,
  hasFeatures: boolean,
  hasSessionPlan: boolean,
): string {
  if (state.stage === 'bootstrap') {
    return '/project brainstorm';
  }
  if (state.stage === 'discovering') {
    return '/project brainstorm';
  }
  if (state.stage === 'aligned') {
    return '/project plan';
  }
  if (state.stage === 'planned') {
    return '/project next';
  }
  if (state.stage === 'executing') {
    return '/project auto';
  }
  if (state.stage === 'blocked') {
    return '/project verify';
  }
  if (!hasFeatures) {
    return '/project plan';
  }
  return hasSessionPlan ? '/project next' : '/project plan';
}

function isExecutionStage(stage: ProjectWorkflowStage): boolean {
  return stage === 'planned' || stage === 'executing' || stage === 'blocked' || stage === 'completed';
}

function formatStage(stage: ProjectWorkflowStage): string {
  return stage.replace(/_/g, ' ');
}

function extractFeatureIndexFromText(input: string): number | null {
  const direct = input.trim();
  if (/^#?\d+$/.test(direct)) {
    return parseFeatureIndex(direct);
  }

  const englishMatch = direct.match(/\bfeature\s*#?\s*(\d+)\b/i);
  if (englishMatch?.[1]) {
    return parseInt(englishMatch[1], 10);
  }

  const chineseMatch = direct.match(/第\s*(\d+)\s*(个)?\s*(feature|条)/i);
  if (chineseMatch?.[1]) {
    return parseInt(chineseMatch[1], 10);
  }

  return null;
}

function summarizeActiveScope(scope: ProjectWorkflowScope, activeRequestId?: string): string {
  return scope === 'change_request'
    ? `change request${activeRequestId ? ` (${activeRequestId})` : ''}`
    : 'project';
}

function buildFallbackFeatureListFromAlignment(
  alignment: ProjectAlignment,
  existingFeatures: ProjectFeature[],
  scope: ProjectWorkflowScope,
): ProjectFeature[] {
  const baseRequirements = alignment.confirmedRequirements.length > 0
    ? alignment.confirmedRequirements
    : [alignment.sourcePrompt];
  const steps = dedupeList([
    ...alignment.constraints.map(item => `Respect constraint: ${item}`),
    ...alignment.successCriteria.map(item => `Validate success criteria: ${item}`),
  ]);

  const generated = baseRequirements.slice(0, MAX_ALIGNMENT_DERIVED_FEATURES).map((requirement, index) => ({
    description: scope === 'change_request'
      ? `Change request: ${requirement}`
      : requirement,
    steps: steps.length > 0 ? steps : [
      'Implement the aligned behavior',
      'Update focused verification and progress evidence',
    ],
    passes: false,
    notes: index === 0 ? `Derived from alignment: ${alignment.sourcePrompt}` : undefined,
  }));

  if (scope === 'change_request' && existingFeatures.length > 0) {
    return [...existingFeatures, ...generated];
  }

  return generated;
}

async function ensureExecutionSessionPlan(
  storage: ProjectStorage,
  feature: ProjectFeature,
  index: number,
  state: ProjectWorkflowState,
): Promise<void> {
  const currentPlan = await storage.readSessionPlan();
  if (currentPlan.trim()) {
    return;
  }

  const plan = buildProjectPlan({
    title: feature.description || feature.name || `Feature #${index}`,
    steps: feature.steps,
    contextNote: `Auto-generated for feature #${index}.`,
  });
  await storage.writeSessionPlan(formatProjectPlan(plan));
  await storage.saveWorkflowState({
    ...state,
    stage: state.stage === 'aligned' ? 'planned' : state.stage,
    currentFeatureIndex: index,
    lastPlannedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  });
}

function buildProgressBar(percentage: number, length = 20): string {
  const completedBars = Math.round((percentage / 100) * length);
  return `${'#'.repeat(completedBars)}${'-'.repeat(length - completedBars)}`;
}

function printProjectStatusOverview(snapshot: ProjectSnapshot): void {
  console.log(chalk.cyan('\nProject Status'));
  console.log(chalk.dim(`  ${'-'.repeat(28)}`));
  console.log(
    `  ${snapshot.stats.completed}/${snapshot.stats.total} completed (${snapshot.stats.percentage}%)  [${buildProgressBar(snapshot.stats.percentage)}]`,
  );
  console.log(`  ${snapshot.stats.pending} pending, ${snapshot.stats.skipped} skipped`);

  if (snapshot.nextFeature) {
    const desc = snapshot.nextFeature.feature.description || snapshot.nextFeature.feature.name || 'Unnamed';
    console.log(chalk.cyan(`\nNext: #${snapshot.nextFeature.index} - ${desc}`));
  } else if (snapshot.stats.pending === 0) {
    console.log(chalk.green('\nAll features completed or skipped'));
  }

  console.log();
  console.log(chalk.dim('Use --features or --progress for details, or /project quality for workflow health.'));
  console.log();
}

function getPendingFeaturePreview(features: readonly ProjectFeature[]): ProjectFeature[] {
  return features.filter(feature => !feature.passes && !feature.skipped).slice(0, 8);
}

function extractMessageText(message: KodaXMessage | undefined): string {
  if (!message?.content) {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .map(part => ('text' in part ? part.text : '') || '')
    .join('');
}

function buildBrainstormPrompt(topic: string): string {
  return `You are helping a developer brainstorm a new project direction.

Topic:
${topic}

Respond in concise markdown and do all of the following:
1. Reframe the problem in 1 short paragraph
2. Ask 4-6 concrete exploratory questions
3. List 2-3 viable implementation directions with trade-offs
4. End with a short suggestion for what the user should answer next

Do not write code yet. Stay in brainstorming mode.`;
}

function buildBrainstormContinuePrompt(transcript: string, userInput: string): string {
  return `You are continuing an active project brainstorm.

Current transcript:
${transcript}

Latest user input:
${userInput}

Respond in concise markdown and do all of the following:
1. React directly to the new information
2. Ask 2-4 sharper follow-up questions
3. Call out the most important trade-off or risk now visible
4. Suggest the best next answer the user could provide

Stay in brainstorming mode. Do not write code or implementation steps yet.`;
}

async function projectBrainstorm(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
): Promise<void> {
  const storage = getProjectStorage();
  const legacyMode = args[0]?.toLowerCase();
  if (legacyMode === 'continue' || legacyMode === 'done' || legacyMode === 'finish' || legacyMode === 'end') {
    console.log(chalk.yellow('\n[Legacy brainstorm subcommands were removed]'));
    console.log(chalk.dim('Run /project brainstorm and answer the discovery questions in the UI flow instead.\n'));
    return;
  }

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const state = await getWorkflowState(storage);
  const brief = await storage.readProjectBrief();
  const scopePrompt = state.scope === 'change_request' && state.activeRequestId
    ? await storage.readChangeRequestPrompt(state.activeRequestId)
    : brief?.originalPrompt ?? args.join(' ').trim();

  if (!scopePrompt) {
    console.log(chalk.yellow('\n[No discovery source found]'));
    console.log(chalk.dim('Run /project init <task> first so Project Mode has a source prompt.\n'));
    return;
  }

  let alignment = await storage.readAlignment();
  if (!alignment || alignment.sourcePrompt.trim() === '') {
    alignment = createProjectAlignment(scopePrompt);
  }

  let session = await storage.loadActiveBrainstormSession();
  if (!session) {
    session = createBrainstormSession(
      scopePrompt,
      `Let us align "${scopePrompt}" one decision at a time before we generate a plan.`,
    );
  }

  console.log(chalk.cyan('\n/project brainstorm - Discovery Flow\n'));
  console.log(chalk.dim(`Scope: ${summarizeActiveScope(state.scope, state.activeRequestId)}`));
  console.log(chalk.dim(`Source: ${scopePrompt}`));
  console.log();

  let nextStepIndex = Math.max(0, Math.min(state.discoveryStepIndex ?? 0, DISCOVERY_QUESTIONS.length));

  if (nextStepIndex >= DISCOVERY_QUESTIONS.length && alignment.openQuestions.length > 0) {
    const customQuestion = alignment.openQuestions[0]!;
    const customAnswer = await callbacks.ui.input(customQuestion);
    if (!customAnswer?.trim()) {
      await storage.saveBrainstormSession(session, formatBrainstormTranscript(session));
      await storage.writeAlignment(normalizeAlignment(alignment));
      await storage.saveWorkflowState({
        ...state,
        stage: 'discovering',
        unresolvedQuestionCount: alignment.openQuestions.length,
        discoveryStepIndex: DISCOVERY_QUESTIONS.length,
        lastUpdated: new Date().toISOString(),
      });
      console.log(chalk.dim('\nDiscovery paused. Run /project brainstorm again to continue.\n'));
      return;
    }

    alignment = normalizeAlignment({
      ...appendAlignmentEntry(alignment, 'confirmedRequirements', customAnswer.trim()),
      openQuestions: alignment.openQuestions.slice(1),
    });
    session = appendBrainstormExchange(
      session,
      customAnswer.trim(),
      `Captured custom discovery detail: ${customAnswer.trim()}`,
    );
  }

  for (let index = nextStepIndex; index < DISCOVERY_QUESTIONS.length; index += 1) {
    const question = DISCOVERY_QUESTIONS[index]!;
    const answer = await chooseOrInput(
      callbacks,
      question.prompt,
      question.options,
      'Type your answer',
    );

    if (!answer) {
      await storage.saveBrainstormSession(session, formatBrainstormTranscript(session));
      await storage.writeAlignment(normalizeAlignment({
        ...alignment,
        openQuestions: DISCOVERY_QUESTIONS.slice(index).map(item => item.prompt),
      }));
      await storage.saveWorkflowState({
        ...state,
        stage: 'discovering',
        unresolvedQuestionCount: DISCOVERY_QUESTIONS.length - index,
        discoveryStepIndex: index,
        lastUpdated: new Date().toISOString(),
      });
      console.log(chalk.dim('\nDiscovery paused. Run /project brainstorm again to continue.\n'));
      return;
    }

    alignment = question.apply(alignment, answer);
    session = appendBrainstormExchange(
      session,
      answer,
      `Captured for alignment: ${answer}`,
    );
    nextStepIndex = index + 1;
  }

  alignment = normalizeAlignment({
    ...alignment,
    openQuestions: [],
  });
  const completedSession = completeBrainstormSession(session);
  await storage.saveBrainstormSession(completedSession, formatBrainstormTranscript(completedSession));
  await storage.writeAlignment(alignment);
  await storage.saveWorkflowState({
    ...state,
    stage: 'aligned',
    unresolvedQuestionCount: 0,
    discoveryStepIndex: DISCOVERY_QUESTIONS.length,
    lastUpdated: new Date().toISOString(),
  });

  console.log(chalk.green('Discovery is aligned.'));
  console.log(chalk.dim('Next options: /project plan, /project brainstorm, or leave it here for now.\n'));

  const nextAction = await callbacks.ui.select(
    'Discovery is aligned. What would you like to do next?',
    ['Enter planning', 'Keep refining discovery', 'Decide later'],
  );

  if (nextAction === 'Keep refining discovery') {
    const extraDetail = await callbacks.ui.input('What else should we clarify?');
    const nextAlignment = extraDetail?.trim()
      ? normalizeAlignment({
          ...alignment,
          openQuestions: [...alignment.openQuestions, extraDetail.trim()],
        })
      : alignment;
    await storage.writeAlignment(nextAlignment);
    await storage.saveWorkflowState({
      ...state,
      stage: 'discovering',
      unresolvedQuestionCount: extraDetail?.trim() ? nextAlignment.openQuestions.length : 1,
      discoveryStepIndex: DISCOVERY_QUESTIONS.length,
      lastUpdated: new Date().toISOString(),
    });
    console.log(chalk.dim('\nAdded one more discovery thread. Run /project brainstorm again when you are ready.\n'));
    return;
  }

  if (nextAction === 'Enter planning') {
    console.log(chalk.dim('\nAlignment saved. Run /project plan when you want to generate or refresh the plan.\n'));
    return;
  }

  console.log(chalk.dim('\nAlignment saved. You can continue later with /project plan or /project brainstorm.\n'));
}

async function projectPlan(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
): Promise<void> {
  const storage = getProjectStorage();
  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const state = await getWorkflowState(storage);
  const alignment = await storage.readAlignment();
  const featureList = await storage.loadFeatures();
  const rawTarget = args.join(' ').trim();
  const hasFeatureTruth = (featureList?.features.length ?? 0) > 0;
  const explicitFeatureIndex = rawTarget ? extractFeatureIndexFromText(rawTarget) : null;
  const shouldGenerateProjectTruth =
    explicitFeatureIndex === null
    && (
      state.scope === 'change_request'
      || !hasFeatureTruth
      || (state.stage === 'aligned' && !hasFeatureTruth)
    );

  if (state.stage === 'discovering' && state.unresolvedQuestionCount > 0) {
    console.log(chalk.yellow('\n/project plan - Discovery Still Open\n'));
    console.log(chalk.dim(`Unresolved questions: ${state.unresolvedQuestionCount}`));
    if (alignment?.openQuestions.length) {
      alignment.openQuestions.forEach((item, index) => {
        console.log(chalk.dim(`  ${index + 1}. ${item}`));
      });
      console.log();
    }

    const choice = await callbacks.ui.select(
      'Discovery is still open. What should Project Mode do?',
      ['Return to discovery', 'Generate a provisional plan'],
    );

    if (choice !== 'Generate a provisional plan') {
      console.log(chalk.dim('\nRun /project brainstorm to continue discovery.\n'));
      return;
    }
  }
  let planInput: { title: string; steps?: string[]; contextNote?: string } | null = null;
  let targetLabel = '';
  let plannedFeatureIndex: number | undefined;

  if (explicitFeatureIndex !== null) {
    const feature = await storage.getFeatureByIndex(explicitFeatureIndex);
    if (!feature) {
      console.log(chalk.red(`\n[Feature not found: ${rawTarget}]\n`));
      return;
    }

    planInput = {
      title: feature.description || feature.name || `Feature #${explicitFeatureIndex}`,
      steps: feature.steps,
      contextNote: `Generated from feature #${explicitFeatureIndex}.`,
    };
    targetLabel = `feature #${explicitFeatureIndex}`;
    plannedFeatureIndex = explicitFeatureIndex;
  } else if (shouldGenerateProjectTruth) {
    if (!alignment) {
      console.log(chalk.yellow('\n[No alignment found]'));
      console.log(chalk.dim('Run /project brainstorm first, or initialize the project with /project init.\n'));
      return;
    }

    const existingFeatures = featureList?.features ?? [];
    let generatedFeatures = buildFallbackFeatureListFromAlignment(alignment, existingFeatures, state.scope);
    const options = callbacks.createKodaXOptions?.();

    if (options) {
      try {
        const result = await runKodaX(
          {
            ...options,
            session: {
              ...options.session,
              initialMessages: context.messages,
            },
          },
          `You are generating feature_list.json for Project Mode.

Active scope: ${state.scope}
Existing features:
${JSON.stringify(existingFeatures, null, 2)}

Alignment:
${JSON.stringify(alignment, null, 2)}

Return strict JSON only:
{
  "features": [
    {
      "description": "clear testable feature",
      "steps": ["step 1", "step 2"],
      "passes": false
    }
  ]
}

If the active scope is a change request, preserve unrelated existing features and append or adjust only what is necessary.`,
        );

        const content = extractMessageText(result.messages[result.messages.length - 1]).trim();
        const parsed = content.match(/\{[\s\S]*\}/)?.[0];
        if (parsed) {
          try {
            const candidate = JSON.parse(parsed) as { features?: ProjectFeature[] };
            if (candidate.features?.length) {
              generatedFeatures = candidate.features.map(feature => ({
                ...feature,
                passes: feature.passes ?? false,
              }));
            }
          } catch (error) {
            console.log(chalk.yellow('\n[Warning] Failed to parse AI-generated feature list, falling back to deterministic generation.\n'));
            console.log(chalk.dim(error instanceof Error ? error.message : String(error)));
            console.log();
          }
        }
      } catch (error) {
        console.log(chalk.yellow('\n[Warning] AI feature generation failed, using deterministic generation instead.\n'));
        console.log(chalk.dim(error instanceof Error ? error.message : String(error)));
        console.log();
      }
    }

    await storage.saveFeatures({ features: generatedFeatures });

    const pendingIndex = generatedFeatures.findIndex(item => item.passes !== true && item.skipped !== true);
    const firstChangeRequestIndex =
      state.scope === 'change_request' && existingFeatures.length < generatedFeatures.length
        ? generatedFeatures.findIndex((item, index) => index >= existingFeatures.length && item.passes !== true && item.skipped !== true)
        : -1;
    const targetIndex = firstChangeRequestIndex >= 0 ? firstChangeRequestIndex : pendingIndex >= 0 ? pendingIndex : 0;
    const targetFeature = generatedFeatures[targetIndex];
    if (!targetFeature) {
      console.log(chalk.yellow('\n[No features generated]'));
      return;
    }

    planInput = {
      title: targetFeature.description || targetFeature.name || `Feature #${targetIndex}`,
      steps: targetFeature.steps,
      contextNote: state.scope === 'change_request'
        ? `Generated while integrating ${summarizeActiveScope(state.scope, state.activeRequestId)}.`
        : 'Generated from the aligned project brief.',
    };
    targetLabel = state.scope === 'change_request' ? 'change request alignment' : 'project alignment';
    plannedFeatureIndex = targetIndex;

    await storage.saveWorkflowState({
      ...state,
      stage: 'planned',
      scope: 'project',
      activeRequestId: undefined,
      currentFeatureIndex: targetIndex,
      lastPlannedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });
  } else if (!rawTarget) {
    const nextFeature = await storage.getNextPendingFeature();
    if (!nextFeature) {
      console.log(chalk.yellow('\n[No pending feature found]'));
      console.log(chalk.dim('Run /project brainstorm or /project init to create plan truth first.\n'));
      return;
    }

    planInput = {
      title: nextFeature.feature.description || nextFeature.feature.name || `Feature #${nextFeature.index}`,
      steps: nextFeature.feature.steps,
      contextNote: `Generated from feature #${nextFeature.index}.`,
    };
    targetLabel = `feature #${nextFeature.index}`;
    plannedFeatureIndex = nextFeature.index;
  } else {
    planInput = {
      title: rawTarget,
    };
    targetLabel = 'freeform request';
  }

  const plan = buildProjectPlan(planInput!);
  const planText = formatProjectPlan(plan);
  await storage.writeSessionPlan(planText);
  const nextFeature = await storage.getNextPendingFeature();
  await storage.saveWorkflowState({
    ...state,
    stage: 'planned',
    scope: shouldGenerateProjectTruth ? 'project' : state.scope,
    activeRequestId: shouldGenerateProjectTruth ? undefined : state.activeRequestId,
    currentFeatureIndex: plannedFeatureIndex ?? nextFeature?.index,
    lastPlannedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  });

  console.log(chalk.cyan('\n/project plan - Planning View\n'));
  console.log(chalk.dim(`Source: ${targetLabel}`));
  console.log(chalk.dim(`Plan ID: ${plan.id}`));
  console.log();
  console.log(planText);
  console.log();
  console.log(chalk.dim('The latest plan has been written to .agent/project/session_plan.md.'));
  console.log();
}

function printProjectQualitySection(report: ProjectQualityReport): void {
  console.log(formatProjectQualityReport(report));
  console.log();
}

function printFallbackGuidedStatus(
  guidance: string,
  snapshot: ProjectSnapshot,
  report: ProjectQualityReport,
): void {
  console.log(chalk.cyan('Guided Status Summary'));
  console.log(chalk.dim(`Question: ${guidance}`));

  const highIssue = report.issues.find(issue => issue.severity === 'high');
  if (highIssue) {
    console.log(chalk.yellow(`Primary risk: ${highIssue.title}`));
    console.log(chalk.dim(`  ${highIssue.detail}`));
  } else if (snapshot.nextFeature) {
    const nextDesc =
      snapshot.nextFeature.feature.description || snapshot.nextFeature.feature.name || 'Unnamed';
    console.log(chalk.green(`Suggested next move: implement #${snapshot.nextFeature.index} (${nextDesc})`));
  } else {
    console.log(chalk.green('Suggested next move: prepare release validation and documentation.'));
  }

  if (report.phases.test.status === 'pending') {
    console.log(chalk.dim('Test loop: no test evidence is recorded yet, so add or run validation before moving on.'));
  } else if (report.phases.review.status === 'pending') {
    console.log(chalk.dim('Review loop: implementation exists, but review evidence is still missing.'));
  } else {
    console.log(chalk.dim(`Workflow score: ${report.overallScore}/100.`));
  }

  console.log();
}

function buildProjectAnalysisPrompt(
  snapshot: ProjectSnapshot,
  report: ProjectQualityReport,
  guidance: string,
  mode: 'status' | 'quality',
): string {
  const pendingFeatures = getPendingFeaturePreview(snapshot.features);
  const objective =
    mode === 'quality'
      ? 'Assess release readiness and workflow health. Highlight the most important gaps and the next concrete actions.'
      : `Answer the user's project-status question directly: "${guidance}"`;

  return `You are reviewing the state of a software project managed by KodaX.

Objective:
${objective}

Project statistics:
- Total features: ${snapshot.stats.total}
- Completed: ${snapshot.stats.completed} (${snapshot.stats.percentage}%)
- Pending: ${snapshot.stats.pending}
- Skipped: ${snapshot.stats.skipped}

Pending features:
${JSON.stringify(pendingFeatures, null, 2)}

Progress log excerpt:
${snapshot.progressText || '(empty)'}

Session plan:
${snapshot.sessionPlan || '(empty)'}

Deterministic quality report:
${formatProjectQualityReport(report)}

Respond in concise markdown with:
1. Direct assessment
2. Risks or workflow gaps
3. Next actions

Keep it actionable and avoid repeating raw JSON.`;
}

async function runProjectAnalysis(
  options: KodaXOptions,
  context: InteractiveContext,
  prompt: string,
): Promise<string> {
  const result = await runKodaX(
    {
      ...options,
      session: {
        ...options.session,
        initialMessages: context.messages,
      },
    },
    prompt,
  );

  return extractMessageText(result.messages[result.messages.length - 1]);
}

/**
 * 解析 feature index，支持 #<n> 和 <n> 两种格式
 *
 * @param arg - 用户输入的参数（如 "#3" 或 "3"）
 * @returns 解析后的数字，无效输入返回 null
 */
function parseFeatureIndex(arg: string): number | null {
  // 支持 #3 格式
  if (arg.startsWith('#')) {
    const num = parseInt(arg.slice(1), 10);
    return isNaN(num) ? null : num;
  }

  // 支持 3 格式（向后兼容）
  const num = parseInt(arg, 10);
  return isNaN(num) ? null : num;
}

/**
 * 显示功能信息
 */
function displayFeatureInfo(feature: ProjectFeature, index: number): void {
  const desc = feature.description || feature.name || 'Unnamed';
  console.log(chalk.cyan(`\nNext Feature (Index ${index}):`));
  console.log(chalk.white(`  ${desc}`));

  if (feature.steps?.length) {
    console.log(chalk.dim('\n  Planned steps:'));
    feature.steps.forEach((step, i) => {
      console.log(chalk.dim(`    ${i + 1}. ${step}`));
    });
  }
  console.log();
}

/**
 * 构建 feature 执行的提示词
 *
 * @param desc - Feature 描述
 * @param steps - Feature 步骤（可选）
 * @param userPrompt - 用户提供的额外指导（可选）
 */
function buildFeaturePrompt(
  desc: string,
  steps?: string[],
  userPrompt?: string,
  repairPrompt?: string,
): string {
  const stepsSection = steps?.length
    ? `\n\nPlanned steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';

  const userSection = userPrompt
    ? `\n\nAdditional requirements:\n${userPrompt}`
    : '';

  const repairSection = repairPrompt
    ? `\n\nVerifier feedback from the previous attempt:\n${repairPrompt}`
    : '';

  return `Continue implementing the project. Focus on this feature:

${desc}${stepsSection}${userSection}${repairSection}

Rules:
- Work only on this active feature.
- Prefer minimal relevant edits.
- Add or update tests when behavior changes.
- Update PROGRESS.md with evidence and blockers from this attempt.
- Treat planned feature steps and the current session plan as completion checklist items.
- Do NOT edit feature_list.json. The command layer will decide completion after verification.

At the end of the attempt, append exactly one JSON block wrapped in <project-harness> tags:
<project-harness>
{"status":"complete|needs_review|blocked","summary":"short summary","evidence":["proof item"],"tests":["test or check"],"changedFiles":["absolute/or/relative/path"],"blockers":["only when blocked"]}
</project-harness>`;
}

/**
 * 执行单个功能
 */
async function executeSingleFeature(
  feature: ProjectFeature,
  index: number,
  context: InteractiveContext,
  options: KodaXOptions,
  userPrompt?: string,
  repairPrompt?: string,
): Promise<{ success: boolean; messages: KodaXMessage[] }> {
  const desc = feature.description || feature.name || 'Unnamed';
  const prompt = buildFeaturePrompt(desc, feature.steps, userPrompt, repairPrompt);

  const result = await runKodaX(
    {
      ...options,
      session: {
        ...options.session,
        initialMessages: context.messages,
      },
    },
    prompt
  );

  return {
    success: true,
    messages: result.messages,
  };
}

async function runVerifiedFeatureExecution(
  storage: ProjectStorage,
  feature: ProjectFeature,
  index: number,
  mode: 'next' | 'auto',
  context: InteractiveContext,
  options: KodaXOptions,
  userPrompt?: string,
): Promise<ProjectHarnessVerificationResult> {
  let repairPrompt: string | undefined;
  let attempt = 0;

  while (attempt < 2) {
    attempt += 1;
    const harnessAttempt = await createProjectHarnessAttempt(storage, feature, index, mode, attempt);
    const harnessedOptions = harnessAttempt.wrapOptions(options);
    const result = await executeSingleFeature(feature, index, context, harnessedOptions, userPrompt, repairPrompt);
    context.messages = result.messages;

    const verification = await harnessAttempt.verify(result.messages);
    if (verification.decision === 'verified_complete') {
      await storage.updateFeatureStatus(index, {
        passes: true,
        completedAt: new Date().toISOString(),
      });
      return verification;
    }

    if (verification.decision === 'retryable_failure' && attempt < 2 && verification.repairPrompt) {
      repairPrompt = verification.repairPrompt;
      continue;
    }

    return verification;
  }

  throw new Error('project harness verification loop exited unexpectedly');
}

// ============== 命令处理函数 ==============

/**
 * 打印项目帮助（紧凑格式）
 */
export function printProjectHelp(): void {
  console.log(chalk.cyan('\n/project - Project Management\n'));

  console.log(chalk.bold('Commands:'));
  console.log(chalk.cyan('  init') + chalk.dim(' <task> [--overwrite]') + '  Initialize project or record a change request');
  console.log(chalk.cyan('  status') + chalk.dim(' [prompt] [--features|--progress]') + '  View status');
  console.log(chalk.cyan('  plan') + chalk.dim(' [feature reference|topic]') + '  Generate project or feature planning truth');
  console.log(chalk.cyan('  quality') + '                         Review workflow quality and release readiness');
  console.log(chalk.cyan('  brainstorm') + '                      Align the request one question at a time');
  console.log(chalk.cyan('  next') + chalk.dim(' [prompt|#index] [--no-confirm]') + '  Run next/specific feature');
  console.log(chalk.cyan('  auto') + chalk.dim(' [prompt] [--max=N|--confirm]') + '  Auto-run all');
  console.log(chalk.cyan('  pause') + '                           Stop /project auto');
  console.log(chalk.cyan('  verify') + chalk.dim(' [#index|--last]') + '         Rerun deterministic harness verification');
  console.log(chalk.cyan('  edit') + chalk.dim(' <prompt>') + '                 Edit current-stage truth');
  console.log(chalk.cyan('  reset') + chalk.dim(' [--all]') + '  Clear progress or delete files');
  console.log(chalk.cyan('  analyze') + chalk.dim(' [prompt]') + '  AI-powered analysis');
  console.log(chalk.dim('  mark <n> [done|skip]  [deprecated: use edit instead]'));
  console.log(chalk.dim('  list, progress        [deprecated: use status --features/--progress]'));

  console.log();
  console.log(chalk.bold('Current Semantics:'));
  console.log(chalk.dim('  The happy path is init -> brainstorm -> plan -> next/auto.'));
  console.log(chalk.dim('  /project brainstorm is UI-driven and no longer uses continue/done subcommands.'));
  console.log(chalk.dim('  /project next and /project auto include automatic verification internally.'));
  console.log(chalk.dim('  /project verify remains available as a diagnostic command.'));

  console.log();
  console.log(chalk.bold('Edit Command:'));
  console.log(chalk.dim('  Discovery: /project edit "Add a constraint: keep the API stable"'));
  console.log(chalk.dim('  Planning:  /project edit "Give feature 3 a test step"'));
  console.log(chalk.dim('  Planning:  /project edit "Delete feature 2"'));

  console.log();
  console.log(chalk.bold('Reset Command:'));
  console.log(chalk.dim('  /project reset        Clear PROGRESS.md (keep features)'));
  console.log(chalk.dim('  /project reset --all  Delete project truth files and runtime state'));
  console.log(chalk.yellow('  Note: only deletes files created by /project init'));

  console.log();
  console.log(chalk.bold('Feature Index:'));
  console.log(chalk.dim('  Use #<number> to reference features (e.g., #0, #3, #5)'));

  console.log();
  console.log(chalk.bold('Quick Examples:'));
  console.log(chalk.dim('  /p init "Build API" -> /p brainstorm -> /p plan -> /p next'));
  console.log(chalk.dim('  /p init "Add pagination to the current API"'));
  console.log(chalk.dim('  /p plan #1'));
  console.log(chalk.dim('  /p brainstorm'));
  console.log(chalk.dim('  /p quality  |  /p verify --last  |  /p pause'));
  console.log(chalk.dim('  /p status "what is blocking release?"'));
  console.log(chalk.dim('  /p edit "Give feature 3 a test step"'));
  console.log(chalk.dim('  /p analyze  |  /p analyze "risk review"'));

  console.log();
  console.log(chalk.dim('Aliases: /proj, /p  |  See docs/FEATURE_LIST.md for roadmap and docs/features/v0.6.10.md for harness details.'));
  console.log();
  return;
  /*

  console.log(chalk.cyan('\n/project - Project Management\n'));

  console.log(chalk.bold('Commands:'));
  console.log(chalk.cyan('  init') + chalk.dim(' <task> [--append|--overwrite]') + '  Initialize project');
  console.log(chalk.cyan('  status') + chalk.dim(' [prompt] [--features|--progress]') + '  View status');
  console.log(chalk.cyan('  quality') + '                         Review workflow quality and release readiness');
  console.log(chalk.cyan('  next') + chalk.dim(' [prompt|#index] [--no-confirm]') + '  Run next/specific feature');
  console.log(chalk.cyan('  auto') + chalk.dim(' [prompt] [--max=N|--confirm]') + '  Auto-run all');
  console.log(chalk.cyan('  edit') + chalk.dim(' [#index] <prompt>') + '  AI-driven editing');
  console.log(chalk.cyan('  reset') + chalk.dim(' [--all]') + '  Clear progress or delete files');
  console.log(chalk.cyan('  analyze') + chalk.dim(' [prompt]') + '  AI-powered analysis');
  console.log(chalk.dim('  mark <n> [done|skip]  [deprecated: use edit instead]'));
  console.log(chalk.dim('  list, progress        [deprecated: use status --features/--progress]'));

  console.log();
  console.log(chalk.bold('Edit Command:'));
  console.log(chalk.dim('  Single:  /project edit #3 "标记为完成"'));
  console.log(chalk.dim('  Global:  /project edit "删除所有已完成的"'));
  console.log(chalk.dim('  Actions: complete, skip, delete, modify description, add steps'));

  console.log();
  console.log(chalk.bold('Reset Command:'));
  console.log(chalk.dim('  /project reset        Clear PROGRESS.md (keep features)'));
  console.log(chalk.dim('  /project reset --all  Delete project truth files and runtime state'));
  console.log(chalk.yellow('  ⚠️  Only deletes files created by /project init'));

  console.log();
  console.log(chalk.bold('Feature Index:'));
  console.log(chalk.dim('  Use #<number> to reference features (e.g., #0, #3, #5)'));

  console.log();
  console.log(chalk.bold('Quick Examples:'));
  console.log(chalk.dim('  /p init "Build API" → /p status → /p next → /p auto'));
  console.log(chalk.dim('  /p quality  |  /p status "what is blocking release?"'));
  console.log(chalk.dim('  /p edit #3 "标记完成"  |  /p edit "删除已跳过的"'));
  console.log(chalk.dim('  /p analyze  |  /p analyze "风险评估"'));

  console.log();
  console.log(chalk.dim('Aliases: /proj, /p  |  For detailed help, read docs/features/v0.5.20.md'));
  console.log();
  */
}

/**
 * 显示项目状态
 */
async function projectStatus(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  // 解析选项
  const showFeatures = args.includes('--features');
  const showProgress = args.includes('--progress');
  const guidance = args.filter(a => !a.startsWith('--')).join(' ');
  const snapshot = await loadProjectSnapshot(storage);
  const state = await getWorkflowState(storage);
  const alignment = await storage.readAlignment();
  const sessionPlan = await storage.readSessionPlan();
  const stats = snapshot?.stats ?? { total: 0, completed: 0, pending: 0, skipped: 0, percentage: 0 };

  if (guidance && snapshot) {
    const report = buildProjectQualityReport(
      snapshot.features,
      snapshot.progressText,
      snapshot.sessionPlan,
    );

    console.log(chalk.cyan('\n/project status - Guided Analysis\n'));
    printProjectQualitySection(report);

    const options = callbacks.createKodaXOptions?.();
    if (!options) {
      printFallbackGuidedStatus(guidance, snapshot, report);
      return;
    }

    try {
      const content = await runProjectAnalysis(
        options,
        context,
        buildProjectAnalysisPrompt(snapshot, report, guidance, 'status'),
      );

      if (content) {
        console.log(content);
        console.log();
      } else {
        printFallbackGuidedStatus(guidance, snapshot, report);
      }
    } catch (error) {
      console.log(chalk.yellow('\n[Warning] AI status analysis failed, showing fallback summary instead.\n'));
      console.log(chalk.dim(error instanceof Error ? error.message : String(error)));
      console.log();
      printFallbackGuidedStatus(guidance, snapshot, report);
    }
    return;
  }

  console.log(chalk.cyan('\nProject Status\n'));
  console.log(`Stage: ${formatStage(state.stage)}`);
  console.log(`Scope: ${summarizeActiveScope(state.scope, state.activeRequestId)}`);
  console.log(`Unresolved discovery items: ${state.unresolvedQuestionCount}`);
  console.log(`Features: ${stats.completed}/${stats.total} completed (${stats.percentage}%)`);
  console.log(`Session plan: ${sessionPlan.trim() ? 'present' : 'missing'}`);
  console.log(`Next recommended command: ${getRecommendedNextStep(state, stats.total > 0, sessionPlan.trim().length > 0)}`);
  if (alignment?.openQuestions.length) {
    console.log();
    console.log(chalk.dim('Open discovery threads:'));
    alignment.openQuestions.slice(0, 4).forEach((item, index) => {
      console.log(chalk.dim(`  ${index + 1}. ${item}`));
    });
  }
  console.log();

  if (showFeatures) {
    if (!snapshot) {
      console.log(chalk.dim('No feature list has been generated yet.\n'));
      return;
    }
    await projectList();
    if (showProgress) {
      console.log();
      await projectProgress();
    }
    return;
  }

  if (showProgress) {
    await projectProgress();
    return;
  }

  if (snapshot) {
    printProjectStatusOverview(snapshot);
  }
  return;
  /*

  // 默认：显示简洁状态概览
  const stats = await storage.getStatistics();
  const next = await storage.getNextPendingFeature();

  // 状态条
  const barLength = 20;
  const completedBars = Math.round((stats.percentage / 100) * barLength);
  const bar = '█'.repeat(completedBars) + '░'.repeat(barLength - completedBars);

  console.log(chalk.cyan('\n📊 Project Status'));
  console.log(chalk.dim('  ────────────────────────────'));
  console.log(`  ✓ ${stats.completed}/${stats.total} completed (${stats.percentage}%)  [${bar}]`);
  console.log(`  ⏳ ${stats.pending} pending, ${stats.skipped} skipped`);

  if (next) {
    const desc = next!.feature.description || next!.feature.name || 'Unnamed';
    console.log(chalk.cyan(`\nNext: #${next!.index} - ${desc}`));
  } else if (stats.pending === 0) {
    console.log(chalk.green('\n  ✓ All features completed or skipped'));
  }

  console.log();
  console.log(chalk.dim('Use --features or --progress for detailed view'));
  console.log();
  */
}

/**
 * 初始化项目
 */
async function projectInit(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  _currentConfig: CurrentConfig,
  confirm: (message: string) => Promise<boolean>
): Promise<{ projectInitPrompt: string } | void> {
  const storage = getProjectStorage();
  if (args.includes('--append')) {
    console.log(chalk.yellow('\n[--append has been removed]'));
    console.log(chalk.dim('Run /project init "<new request>" and choose a change-request path in the UI.\n'));
    return;
  }

  const hasOverwrite = args.includes('--overwrite');
  const taskArgs = args.filter(a => !a.startsWith('--'));
  const task = taskArgs.join(' ').trim();

  if (!task) {
    console.log(chalk.yellow('\nUsage: /project init <task description>'));
    console.log(chalk.dim('Example: /project init "TypeScript + Express REST API"\n'));
    return;
  }

  const alreadyExists = await storage.exists();
  if (alreadyExists && hasOverwrite) {
    const confirmed = await confirm('Overwrite existing project management artifacts?');
    if (!confirmed) {
      console.log(chalk.dim('\nCancelled\n'));
      return;
    }
    await storage.deleteProjectManagementFiles();
  }

  const timestamp = new Date().toISOString();
  const brief = createProjectBrief(task, timestamp);
  const alignment = createProjectAlignment(task, timestamp);

  if (!alreadyExists || hasOverwrite) {
    await storage.writeProjectBrief(brief);
    await storage.writeAlignment(alignment);

    const initChoice = await callbacks.ui.select(
      'How should Project Mode start this project?',
      ['Start discovery', 'Draft planning input directly', 'Initialize only'],
    );

    const stage: ProjectWorkflowStage =
      initChoice === 'Draft planning input directly'
        ? 'aligned'
        : initChoice === 'Initialize only'
          ? 'bootstrap'
          : 'discovering';

    const initializedAlignment = stage === 'aligned'
      ? normalizeAlignment({
          ...alignment,
          confirmedRequirements: [task],
          openQuestions: [],
        }, timestamp)
      : alignment;

    await storage.writeAlignment(initializedAlignment);
    await storage.saveWorkflowState({
      ...createProjectWorkflowState(stage, timestamp, 'project'),
      unresolvedQuestionCount: stage === 'discovering' ? DISCOVERY_QUESTIONS.length : 0,
      discoveryStepIndex: stage === 'discovering' ? 0 : DISCOVERY_QUESTIONS.length,
      lastUpdated: timestamp,
    });

    console.log(chalk.cyan('\n/project init - Project Initialized\n'));
    console.log(chalk.dim(`Source prompt saved to .agent/project/project_brief.md`));
    console.log(chalk.dim(`Alignment file saved to .agent/project/alignment.md`));
    if (stage === 'discovering') {
      console.log(chalk.dim('\nNext: run /project brainstorm to align the request.\n'));
    } else if (stage === 'aligned') {
      console.log(chalk.dim('\nNext: run /project plan to generate feature truth and a session plan.\n'));
    } else {
      console.log(chalk.dim('\nInitialization complete. Continue with /project brainstorm or /project plan.\n'));
    }
    return;
  }

  const changeRequest = await storage.createChangeRequest(task, timestamp);
  const initChoice = await callbacks.ui.select(
    'Project already exists. How should this new request be handled?',
    ['Explore this new request', 'Draft a change plan', 'Record the request only'],
  );

  if (initChoice === 'Record the request only') {
    console.log(chalk.cyan('\n/project init - Change Request Recorded\n'));
    console.log(chalk.dim(`Saved: ${changeRequest.id}`));
    console.log(chalk.dim('The active project state was left unchanged.\n'));
    return;
  }

  const nextStage: ProjectWorkflowStage =
    initChoice === 'Draft a change plan' ? 'aligned' : 'discovering';
  const nextAlignment = nextStage === 'aligned'
    ? normalizeAlignment({
        ...alignment,
        confirmedRequirements: [task],
        openQuestions: [],
      }, timestamp)
    : alignment;

  await storage.writeAlignment(nextAlignment);
  await storage.saveWorkflowState({
    ...createProjectWorkflowState(nextStage, timestamp, 'change_request'),
    activeRequestId: changeRequest.id,
    unresolvedQuestionCount: nextStage === 'discovering' ? DISCOVERY_QUESTIONS.length : 0,
    discoveryStepIndex: nextStage === 'discovering' ? 0 : DISCOVERY_QUESTIONS.length,
    lastUpdated: timestamp,
  });

  console.log(chalk.cyan('\n/project init - Change Request Activated\n'));
  console.log(chalk.dim(`Request: ${changeRequest.id}`));
  if (nextStage === 'discovering') {
    console.log(chalk.dim('Next: run /project brainstorm to align the new request.\n'));
  } else {
    console.log(chalk.dim('Next: run /project plan to update feature truth for this request.\n'));
  }
}

/**
 * 执行下一个功能
 */
async function projectNext(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  _currentConfig: CurrentConfig,
  confirm: (message: string) => Promise<boolean>
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const state = await getWorkflowState(storage);
  if (!isExecutionStage(state.stage)) {
    console.log(chalk.yellow('\n[Project is not ready for execution]'));
    console.log(chalk.dim(`Current stage: ${formatStage(state.stage)}`));
    console.log(chalk.dim('Use /project plan after discovery before running /project next.\n'));
    return;
  }

  const next = await storage.getNextPendingFeature();
  if (!next) {
    console.log(chalk.green('\n✓ All features completed or skipped\n'));
    return;
  }

  // 解析选项和用户 prompt
  const hasNoConfirm = args.includes('--no-confirm');
  const indexArg = args.find(a => a.startsWith('--index='));

  // 支持 #<n> 语法
  let explicitIndex: number | null = null;
  if (indexArg) {
    explicitIndex = parseInt(indexArg.split('=')[1] ?? '0', 10);
  } else if (args.length > 0 && !args[0]!.startsWith('--')) {
    // 检查第一个参数是否是 #<n> 格式
    const parsed = parseFeatureIndex(args[0]!);
    if (parsed !== null) {
      explicitIndex = parsed;
    }
  }

  // 提取用户 prompt（所有非选项参数，排除 index）
  const userPrompt = args
    .filter(a => !a.startsWith('--') && a !== args.find(arg => parseFeatureIndex(arg!) !== null))
    .join(' ')
    .trim();

  // 如果指定了索引，使用指定的
  const targetIndex = explicitIndex !== null ? explicitIndex : next.index;
  const feature = await storage.getFeatureByIndex(targetIndex);

  if (!feature) {
    console.log(chalk.red(`\n[Error] Feature at index ${targetIndex} not found\n`));
    return;
  }

  await ensureExecutionSessionPlan(storage, feature, targetIndex, state);

  // 显示功能信息
  displayFeatureInfo(feature, targetIndex);

  // 确认执行
  if (!hasNoConfirm) {
    const confirmed = await confirm('Execute this feature?');
    if (!confirmed) {
      console.log(chalk.dim('\nCancelled\n'));
      return;
    }
  }

  console.log(chalk.dim('\n[Executing...]\n'));

  try {
    // 更新开始时间
    await storage.updateFeatureStatus(targetIndex, {
      startedAt: new Date().toISOString(),
    });

    // 获取 KodaX 选项
    const options = callbacks.createKodaXOptions?.();
    if (!options) {
      console.log(chalk.red('\n[Error] KodaX options not available\n'));
      return;
    }

    const verification = await runVerifiedFeatureExecution(
      storage,
      feature,
      targetIndex,
      'next',
      context,
      options,
      userPrompt,
    );

    if (verification.decision === 'verified_complete') {
      console.log(chalk.green('\n✓ Feature completed'));
    } else {
      console.log(chalk.yellow(`\n⚠ Feature requires follow-up (${verification.decision})`));
    }
    console.log(formatProjectHarnessSummary(verification.runRecord));
    console.log();

    // 显示进度
    const stats = await storage.getStatistics();
    await storage.saveWorkflowState({
      ...state,
      stage: stats.pending === 0 ? 'completed' : verification.decision === 'verified_complete' ? 'executing' : 'blocked',
      currentFeatureIndex: (await storage.getNextPendingFeature())?.index,
      latestExecutionSummary: verification.runRecord.completionReport?.summary ?? verification.reasons[0] ?? 'No summary available',
      lastUpdated: new Date().toISOString(),
    });
    console.log(chalk.dim(`Progress: ${stats.completed}/${stats.total} [${stats.percentage}%]\n`));

  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log(chalk.red(`\n[Error] ${err.message}\n`));
  }
}

/**
 * 解析 auto 命令选项
 */
function parseAutoOptions(args: string[]): { hasConfirm: boolean; maxRuns: number } {
  const hasConfirm = args.includes('--confirm');
  const maxArg = args.find(a => a.startsWith('--max='));

  if (maxArg) {
    const parsed = parseInt(maxArg.split('=')[1] ?? '10', 10);
    // 验证：NaN 或负数都视为无限制（0）
    const maxRuns = isNaN(parsed) || parsed < 0 ? 0 : parsed;
    return { hasConfirm, maxRuns };
  }

  return { hasConfirm, maxRuns: 0 }; // 0 = unlimited
}

/**
 * 处理自动继续模式的用户输入
 */
type AutoAction = 'yes' | 'no' | 'skip' | 'quit';

function parseAutoAction(answer: string): AutoAction {
  const action = answer.toLowerCase().trim();
  if (action === 'q' || action === 'quit') return 'quit';
  if (action === 's' || action === 'skip') return 'skip';
  if (action.startsWith('y')) return 'yes';
  return 'no';
}

/**
 * 自动继续模式
 */
async function projectAuto(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  _currentConfig: CurrentConfig,
  confirm: (message: string) => Promise<boolean>,
  question: (prompt: string) => Promise<string>
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const initialState = await getWorkflowState(storage);
  if (!isExecutionStage(initialState.stage)) {
    console.log(chalk.yellow('\n[Project is not ready for auto execution]'));
    console.log(chalk.dim(`Current stage: ${formatStage(initialState.stage)}`));
    console.log(chalk.dim('Use /project plan after discovery before running /project auto.\n'));
    return;
  }

  if (projectRuntimeState.autoContinueRunning) {
    console.log(chalk.yellow('\n[Auto-continue already running]'));
    console.log(chalk.dim('Use /project pause to stop\n'));
    return;
  }

  // 解析选项和用户 prompt
  const { hasConfirm, maxRuns } = parseAutoOptions(args);

  // 提取用户 prompt（所有非选项参数）
  const userPrompt = args
    .filter(arg => !arg.startsWith('--'))
    .join(' ')
    .trim();

  const stats = await storage.getStatistics();
  let runCount = 0;

  console.log(chalk.cyan('\nAuto-Continue Mode'));
  console.log(chalk.dim(`  Max runs: ${maxRuns || 'unlimited'}`));
  console.log(chalk.dim(`  Confirm each: ${hasConfirm ? 'yes' : 'no'}`));
  if (userPrompt) {
    console.log(chalk.dim(`  User guidance: ${userPrompt}`));
  }
  console.log(chalk.dim(`  Remaining: ${stats.pending} features`));
  console.log();

  projectRuntimeState.setAutoContinueRunning(true);

  try {
    while (projectRuntimeState.autoContinueRunning) {
      const next = await storage.getNextPendingFeature();
      if (!next) {
        console.log(chalk.green('\n✓ All features completed\n'));
        break;
      }

      runCount++;
      if (maxRuns > 0 && runCount > maxRuns) {
        console.log(chalk.yellow('\nMax runs reached\n'));
        break;
      }

      const desc = next.feature.description || next.feature.name || 'Unnamed';
      console.log(chalk.cyan(`[${runCount}] ${desc}`));

      // 确认（仅在 --confirm 模式下）
      if (hasConfirm) {
        const answer = await question('Execute? (y/n/s=skip/q=quit) ');
        const action = parseAutoAction(answer);

        if (action === 'quit') {
          console.log(chalk.dim('\nPaused\n'));
          break;
        }
        if (action === 'skip') {
          await storage.updateFeatureStatus(next.index, { skipped: true });
          console.log(chalk.dim('  Skipped\n'));
          continue;
        }
        if (action === 'no') {
          console.log(chalk.dim('  Skipped\n'));
          continue;
        }
      }

      // 执行
      try {
        const options = callbacks.createKodaXOptions?.();
        if (!options) {
          console.log(chalk.red('\n[Error] KodaX options not available\n'));
          break;
        }
        const currentState = await getWorkflowState(storage);
        await ensureExecutionSessionPlan(storage, next.feature, next.index, currentState);
        await storage.updateFeatureStatus(next.index, {
          startedAt: next.feature.startedAt ?? new Date().toISOString(),
        });
        const verification = await runVerifiedFeatureExecution(
          storage,
          next.feature,
          next.index,
          'auto',
          context,
          options,
          userPrompt,
        );

        if (verification.decision === 'verified_complete') {
          console.log(chalk.green('  ✓ Completed'));
          console.log(chalk.dim(`  ${verification.runRecord.evidence.join(' | ')}`));
          const updatedStats = await storage.getStatistics();
          await storage.saveWorkflowState({
            ...currentState,
            stage: updatedStats.pending === 0 ? 'completed' : 'executing',
            currentFeatureIndex: (await storage.getNextPendingFeature())?.index,
            latestExecutionSummary: verification.runRecord.completionReport?.summary ?? 'Feature completed',
            lastUpdated: new Date().toISOString(),
          });
          console.log();
        } else {
          console.log(chalk.yellow(`  ⚠ Paused: ${verification.decision}`));
          console.log(chalk.dim(`  ${verification.reasons.join(' | ') || 'Review the latest harness record.'}`));
          await storage.saveWorkflowState({
            ...currentState,
            stage: 'blocked',
            currentFeatureIndex: next.index,
            latestExecutionSummary: verification.runRecord.completionReport?.summary ?? verification.reasons[0] ?? 'No summary available',
            lastUpdated: new Date().toISOString(),
          });
          console.log();
          break;
        }

      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.log(chalk.red(`  ✗ Error: ${err.message}\n`));

        const continueAfter = await confirm('Continue with next feature?');
        if (!continueAfter) {
          break;
        }
      }
    }
  } finally {
    projectRuntimeState.setAutoContinueRunning(false);
  }
}

/**
 * 暂停自动继续
 */
async function projectPause(): Promise<void> {
  if (projectRuntimeState.autoContinueRunning) {
    projectRuntimeState.setAutoContinueRunning(false);
    console.log(chalk.cyan('\n[Auto-continue paused]\n'));
  } else {
    console.log(chalk.yellow('\n[Auto-continue not running]\n'));
  }
}

/**
 * 列出所有功能
 */
async function projectList(): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]\n'));
    return;
  }

  const features = await storage.listFeatures();
  const stats = await storage.getStatistics();

  console.log(chalk.cyan(`\nFeatures (${stats.total} total):\n`));

  features.forEach((f, i) => {
    const status = f.passes
      ? chalk.green('✓')
      : f.skipped
        ? chalk.dim('⊘')
        : chalk.yellow('○');

    const desc = f.description || f.name || 'Unnamed';

    console.log(`  ${status} ${chalk.dim(`${i}.`)} ${desc}`);
  });

  console.log();
  console.log(chalk.dim(`  Legend: ✓ completed  ○ pending  ⊘ skipped\n`));
}

/**
 * 标记功能状态
 */
async function projectMark(args: string[]): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]\n'));
    return;
  }

  const index = parseInt(args[0] ?? '', 10);
  const status = (args[1] ?? '').toLowerCase();

  if (isNaN(index)) {
    console.log(chalk.yellow('\nUsage: /project mark <index> [done|skip]'));
    console.log(chalk.dim('Example: /project mark 3 done\n'));
    return;
  }

  const feature = await storage.getFeatureByIndex(index);
  if (!feature) {
    console.log(chalk.red(`\n[Error] Feature at index ${index} not found\n`));
    return;
  }

  const updates: Partial<ProjectFeature> = {};

  if (status === 'done') {
    updates.passes = true;
    updates.completedAt = new Date().toISOString();
  } else if (status === 'skip') {
    updates.skipped = true;
  } else {
    console.log(chalk.yellow('\nUsage: /project mark <index> [done|skip]'));
    console.log(chalk.dim('Example: /project mark 3 done\n'));
    return;
  }

  await storage.updateFeatureStatus(index, updates);
  await recordManualHarnessOverride(storage, index, status as 'done' | 'skip');

  const desc = feature.description || feature.name || 'Unnamed';
  console.log(chalk.green(`\n✓ Marked feature ${index} as ${status}`));
  console.log(chalk.dim(`  ${desc}\n`));
}

async function projectVerify(args: string[]): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]\n'));
    return;
  }

  const explicitIndexArg = args.find(arg => parseFeatureIndex(arg) !== null);
  const explicitIndex = explicitIndexArg ? parseFeatureIndex(explicitIndexArg) : null;
  const runs = await storage.readHarnessRuns<ProjectHarnessRunRecord>();

  if (runs.length === 0) {
    console.log(chalk.yellow('\n[No harness verification records found]\n'));
    return;
  }

  const selectedRun = explicitIndex !== null
    ? [...runs].reverse().find(run => run.featureIndex === explicitIndex) ?? null
    : await readLatestHarnessRun(storage);

  if (!selectedRun) {
    console.log(chalk.yellow('\n[No matching harness verification record found]\n'));
    return;
  }

  const verification = await reverifyProjectHarnessRun(storage, selectedRun);

  console.log(chalk.cyan('\n/project verify - Deterministic Re-check\n'));
  console.log(chalk.dim('This reruns current workspace checks and proof gates. It does not replay the original full action trace.\n'));
  console.log(formatProjectHarnessSummary(verification.runRecord));
  console.log();
}

/**
 * 查看进度文件
 */
async function projectProgress(): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]\n'));
    return;
  }

  const progress = await storage.readProgress();

  if (!progress) {
    console.log(chalk.dim('\n[PROGRESS.md is empty]\n'));
    return;
  }

  console.log(chalk.cyan('\nPROGRESS.md:\n'));
  console.log(chalk.dim('─'.repeat(50)));
  // 只显示最后 50 行
  const lines = progress.split('\n');
  const displayLines = lines.slice(-50);
  console.log(displayLines.join('\n'));
  console.log(chalk.dim('─'.repeat(50)));
  console.log();
}

/**
 * AI 驱动的万能编辑命令
 *
 * 支持两种模式：
 * 1. 单个 feature 编辑：/project edit #3 "修改描述为 xxx"
 * 2. 全局编辑：/project edit "重新按优先级排序"
 */
async function projectEdit(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  confirm: (message: string) => Promise<boolean>
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  if (args.length === 0) {
    console.log(chalk.yellow('\nUsage: /project edit <instruction>'));
    console.log(chalk.dim('\nExamples:'));
    console.log(chalk.dim('  Discovery stage: /project edit "Add a constraint: keep the current API stable"'));
    console.log(chalk.dim('  Planning stage:  /project edit "Give feature 3 a test step"'));
    console.log(chalk.dim('  Planning stage:  /project edit "Delete feature 2"\n'));
    return;
  }

  const state = await getWorkflowState(storage);
  const guidance = args.join(' ').trim();

  if (state.stage === 'discovering' || state.stage === 'aligned' || state.stage === 'bootstrap') {
    await editAlignment(guidance, storage, callbacks);
    return;
  }

  if (state.stage !== 'planned' && state.stage !== 'executing' && state.stage !== 'blocked' && state.stage !== 'completed') {
    console.log(chalk.yellow('\n[Edit is not available in the current stage]'));
    console.log(chalk.dim(`Current stage: ${formatStage(state.stage)}\n`));
    return;
  }

  const index = extractFeatureIndexFromText(guidance);
  if (index !== null) {
    await editSingleFeature(index, guidance, storage, context, callbacks, confirm);
    return;
  }

  await editGlobal(guidance, storage, context, callbacks, confirm);
}

async function editAlignment(
  guidance: string,
  storage: ProjectStorage,
  callbacks: CommandCallbacks,
): Promise<void> {
  let alignment = (await storage.readAlignment()) ?? createProjectAlignment('Unspecified project');
  const trimmedGuidance = guidance.trim();
  const detectedField = looksLikeExplicitAlignmentFieldEdit(trimmedGuidance)
    ? detectAlignmentField(trimmedGuidance)
    : null;
  const targetField = detectedField ?? await chooseAlignmentField(callbacks, trimmedGuidance);

  if (!targetField) {
    console.log(chalk.dim('\nNo alignment update was applied.\n'));
    return;
  }

  if (isRemovalInstruction(trimmedGuidance)) {
    const removal = removeAlignmentEntry(alignment, targetField, trimmedGuidance);
    alignment = removal.alignment;
    if (!removal.removed) {
      console.log(chalk.yellow('\n[No matching alignment entry found to remove]'));
      console.log(chalk.dim('Please use a more specific phrase, for example: "Remove the constraint: keep the API stable".\n'));
      return;
    }
  } else {
    const entry = stripAlignmentEditPrefix(trimmedGuidance, targetField, 'add') || trimmedGuidance;
    alignment = appendAlignmentEntry(alignment, targetField, entry);
  }

  await storage.writeAlignment(normalizeAlignment(alignment));
  const state = await getWorkflowState(storage);
  await storage.saveWorkflowState({
    ...state,
    stage: state.stage === 'bootstrap' ? 'discovering' : state.stage,
    lastUpdated: new Date().toISOString(),
  });

  console.log(chalk.cyan('\n/project edit - Alignment Updated\n'));
  console.log(chalk.dim('The active alignment truth has been updated.\n'));
  return;
  /*

  if (lower.includes('constraint') || guidance.includes('约束')) {
    alignment = appendAlignmentEntry(alignment, 'constraints', guidance);
  } else if (lower.includes('non-goal') || guidance.includes('非目标')) {
    alignment = appendAlignmentEntry(alignment, 'nonGoals', guidance);
  } else if (lower.includes('success') || guidance.includes('成功')) {
    alignment = appendAlignmentEntry(alignment, 'successCriteria', guidance);
  } else if (lower.includes('tradeoff') || guidance.includes('取舍')) {
    alignment = appendAlignmentEntry(alignment, 'acceptedTradeoffs', guidance);
  } else {
    alignment = appendAlignmentEntry(alignment, 'confirmedRequirements', guidance);
  }

  await storage.writeAlignment(normalizeAlignment(alignment));
  const state = await getWorkflowState(storage);
  await storage.saveWorkflowState({
    ...state,
    stage: state.stage === 'bootstrap' ? 'discovering' : state.stage,
    lastUpdated: new Date().toISOString(),
  });

  console.log(chalk.cyan('\n/project edit - Alignment Updated\n'));
  console.log(chalk.dim('The active alignment truth has been updated.\n'));
  */
}

/**
 * 编辑单个 feature
 */
async function editSingleFeature(
  index: number,
  guidance: string,
  storage: ProjectStorage,
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  confirm: (message: string) => Promise<boolean>
): Promise<void> {
  const feature = await storage.getFeatureByIndex(index);
  if (!feature) {
    console.log(chalk.red(`\n[Error] Feature #${index} not found\n`));
    return;
  }

  console.log(chalk.cyan(`\n/project edit #${index}`));
  console.log(chalk.dim(`Current: ${feature.description || feature.name || 'Unnamed'}`));
  console.log(chalk.dim(`Instruction: "${guidance}"`));
  console.log();

  // 简单的意图识别（基于关键词）
  const lowerGuidance = guidance.toLowerCase();

  // 1. 删除操作
  if (lowerGuidance.includes('删除') || lowerGuidance.includes('delete')) {
    const confirmed = await confirm(`Delete feature #${index}?`);
    if (confirmed) {
      const data = await storage.loadFeatures();
      if (data) {
        data.features.splice(index, 1);
        await storage.saveFeatures(data);
        console.log(chalk.green(`✓ Deleted feature #${index}\n`));
      }
    } else {
      console.log(chalk.dim('\nCancelled.\n'));
    }
    return;
  }

  // 2. 通用修改（使用 AI 辅助 + 智能确认）
  // 移除所有预设关键词匹配，统一由 LLM 理解语义
  // 这样可以避免关键词误判，充分发挥 LLM 的语义理解能力
  console.log(chalk.cyan('Processing with AI assistance...\n'));

  // 对于复杂的修改请求，调用 AI 来理解意图并生成建议的更改
  const options = callbacks.createKodaXOptions?.();
  if (!options) {
    console.log(chalk.yellow('\n[Error] AI options not available'));
    console.log(chalk.dim('Please edit feature_list.json manually.\n'));
    return;
  }

  const prompt = `You are analyzing a feature edit request to suggest what fields should be changed.

**Current Feature #${index}:**
${JSON.stringify(feature, null, 2)}

**User Instruction:** "${guidance}"

---

**Your Task:**
1. Understand the user's intent semantically (not just keyword matching)
2. Decide what fields should change based on common sense and context
3. Determine if you need user confirmation

**Guidelines for Semantic Understanding:**
- "加个测试" / "add a test" → Add test step (NOT mark as completed)
- "标记完成" / "mark done" → Set passes=true (confirm completion)
- "改描述为xxx" → Update description field
- "加个测试环节" → Add test step (same as "add a test")
- "完成这个功能" → Could mean: mark as done OR just finish implementation (ambiguous!)

**When to set needsConfirmation=true:**
- The instruction has multiple possible interpretations
- The changes are significant or irreversible
- You're genuinely uncertain about user intent
- Missing critical information (e.g., "改描述" without new description)

**When to set needsConfirmation=false:**
- The intent is clear from context
- Simple additive changes (adding steps, updating fields)
- You're confident you understood correctly

---

**Response Format (JSON):**
{
  "analysis": "Brief explanation of user intent",
  "changes": {
    "field1": "value1"
  },
  "needsConfirmation": true/false
}

**Examples:**

User: "加个测试"
→ {
  "analysis": "User wants to add a test step",
  "changes": {"steps": [...existing, "Add comprehensive tests"]},
  "needsConfirmation": false
}

User: "标记完成"
→ {
  "analysis": "User wants to mark feature as completed",
  "changes": {"passes": true, "completedAt": "${new Date().toISOString()}"},
  "needsConfirmation": false
}

User: "完成这个"
→ {
  "analysis": "Ambiguous: could mean 'mark done' or 'finish implementation'",
  "changes": {"passes": true},
  "needsConfirmation": true
}

User: "改描述"
→ {
  "analysis": "User wants to change description but didn't provide new one",
  "changes": {},
  "needsConfirmation": true
}

Only include fields that should change. Omit unchanged fields. Think semantically, not literally.`;

    try {
      const result = await runKodaX(
        {
          ...options,
          session: {
            ...options.session,
            initialMessages: context.messages,
          },
        },
        prompt
      );

      // Extract AI response
      const lastMessage = result.messages[result.messages.length - 1];
      if (!lastMessage?.content) {
        console.log(chalk.yellow('\n[Warning] AI analysis failed - no response'));
        console.log(chalk.dim('Please edit feature_list.json manually.\n'));
        return;
      }

      const content = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : lastMessage.content.map(c => ('text' in c ? c.text : '') || '').join('');

      // Parse JSON from AI response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log(chalk.yellow('\n[Warning] AI analysis failed - invalid response format'));
        console.log(chalk.dim('AI response:'));
        console.log(chalk.dim(content));
        console.log(chalk.dim('\nPlease edit feature_list.json manually.\n'));
        return;
      }

      const aiResponse = JSON.parse(jsonMatch[0]);

      // Display analysis
      console.log(chalk.cyan('AI Analysis:'));
      console.log(chalk.dim(aiResponse.analysis));
      console.log();

      // Display proposed changes
      if (Object.keys(aiResponse.changes).length === 0) {
        console.log(chalk.yellow('No changes suggested.\n'));
        return;
      }

      console.log(chalk.cyan('Proposed changes:'));
      const changesEntries = Object.entries(aiResponse.changes);
      changesEntries.forEach(([field, value]) => {
        const oldValue = JSON.stringify((feature as any)[field]);
        const newValue = JSON.stringify(value);
        console.log(chalk.dim(`  ${field}: ${oldValue} → ${newValue}`));
      });
      console.log();

      // Check if AI thinks confirmation is needed
      const shouldConfirm = aiResponse.needsConfirmation === true;

      // Track whether changes were applied for context saving
      let changesApplied = false;

      if (shouldConfirm) {
        // Use ask_user_question tool for ambiguous/significant changes
        const askUser = options.events?.askUser;
        if (!askUser) {
          console.log(chalk.yellow('[Warning] Interactive mode not available'));
          console.log(chalk.dim('Please edit feature_list.json manually.\n'));
          return;
        }

        const userChoice = await askUser({
          question: 'The instruction may be ambiguous. How would you like to proceed?',
          options: [
            {
              label: 'Apply changes',
              description: 'Apply the proposed changes to feature_list.json',
              value: 'apply',
            },
            {
              label: 'Manual edit',
              description: 'Open feature_list.json in your editor',
              value: 'manual',
            },
            {
              label: 'Cancel',
              description: 'Discard the proposed changes',
              value: 'cancel',
            },
          ],
        });

        if (userChoice === 'apply') {
          // Apply changes
          const updateData: any = {};
          changesEntries.forEach(([field, value]) => {
            updateData[field] = value;
          });

          await storage.updateFeatureStatus(index, updateData);
          console.log(chalk.green('\n✅ Changes applied successfully!\n'));
          changesApplied = true;
        } else if (userChoice === 'manual') {
          console.log(chalk.dim('\nPlease edit feature_list.json manually.\n'));
          // TODO: Could open editor here in the future
        } else {
          console.log(chalk.dim('\n✗ Changes cancelled.\n'));
        }
      } else {
        // AI is confident - apply changes directly
        const updateData: any = {};
        changesEntries.forEach(([field, value]) => {
          updateData[field] = value;
        });

        await storage.updateFeatureStatus(index, updateData);
        console.log(chalk.green('✅ Changes applied successfully!\n'));
        changesApplied = true;
      }

      // Save friendly summary to context for subsequent conversation
      // Replace the raw JSON response with human-readable summary
      if (changesApplied) {
        const changesSummary = changesEntries
          .map(([field, value]) => {
            const oldValue = JSON.stringify((feature as any)[field]);
            const newValue = JSON.stringify(value);
            return `  - ${field}: ${oldValue} → ${newValue}`;
          })
          .join('\n');

        const friendlySummary = `已处理 /project edit #${index} 请求：
- 用户指令：${guidance}
- 意图分析：${aiResponse.analysis}
- 应用的更改：
${changesSummary}`;

        // Replace the last assistant message with friendly summary
        const newMessages = [...result.messages];
        const lastIdx = newMessages.length - 1;
        if (newMessages[lastIdx]?.role === 'assistant') {
          newMessages[lastIdx] = {
            ...newMessages[lastIdx],
            content: friendlySummary,
          };
        }
        context.messages = newMessages;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(chalk.yellow(`\n[Warning] AI analysis failed: ${errorMsg}`));
      console.log(chalk.dim('Please edit feature_list.json manually.\n'));
    }
}

/**
 * 全局编辑（AI 驱动）
 */
async function editGlobal(
  guidance: string,
  storage: ProjectStorage,
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  confirm: (message: string) => Promise<boolean>
): Promise<void> {
  console.log(chalk.cyan('\n/project edit - Global Edit'));
  console.log(chalk.dim(`Instruction: "${guidance}"`));
  console.log();

  const features = await storage.loadFeatures();
  if (!features) {
    console.log(chalk.red('\n[Error] Failed to load features\n'));
    return;
  }

  // 使用 AI 辅助处理所有全局编辑请求
  // 移除所有预设关键词匹配，统一由 LLM 理解语义
  console.log(chalk.cyan('Processing with AI assistance...'));

  const options = callbacks.createKodaXOptions?.();
  if (options) {
    const prompt = `Analyze this global feature list edit request:

Current features (${features.features.length} total):
${JSON.stringify(features.features, null, 2)}

User instruction: "${guidance}"

Please analyze what changes are needed and provide:
1. A brief explanation of your understanding
2. What specific changes you recommend
3. Any potential issues or considerations

Note: Complex operations like reordering, merging, or splitting features require manual editing of feature_list.json.`;

    try {
      const result = await runKodaX(
        {
          ...options,
          session: {
            ...options.session,
            initialMessages: context.messages,
          },
        },
        prompt
      );

      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage?.content) {
        const content = typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.content.map(c => ('text' in c ? c.text : '') || '').join('');

        console.log(chalk.dim('\nAI Analysis:'));
        console.log(chalk.dim(content));
        console.log(chalk.yellow('\nNote: Global edits are complex and require manual feature_list.json editing.'));
        console.log(chalk.dim('Automated operations: delete completed, delete skipped.\n'));

        // Save friendly summary to context for subsequent conversation
        const friendlySummary = `已处理 /project edit 全局编辑请求：
- 用户指令：${guidance}
- AI 分析：
${content}

注：全局编辑操作复杂，需要手动编辑 feature_list.json`;

        const newMessages = [...result.messages];
        const lastIdx = newMessages.length - 1;
        if (newMessages[lastIdx]?.role === 'assistant') {
          newMessages[lastIdx] = {
            ...newMessages[lastIdx],
            content: friendlySummary,
          };
        }
        context.messages = newMessages;
      } else {
        console.log(chalk.yellow('\n[Warning] AI analysis failed - no response'));
        console.log(chalk.dim('Please edit feature_list.json manually.\n'));
      }
    } catch (error) {
      console.log(chalk.yellow('\n[Warning] AI analysis failed'));
      console.log(chalk.dim('Please edit feature_list.json manually.\n'));
    }
  } else {
    console.log(chalk.yellow('\n[Error] AI options not available'));
    console.log(chalk.dim('Please edit feature_list.json manually.\n'));
  }
}

/**
 * AI 驱动的项目分析
 */
async function projectAnalyze(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const guidance = args.join(' ').trim();
  const stats = await storage.getStatistics();
  const features = await storage.loadFeatures();

  if (!features) {
    console.log(chalk.red('\n[Error] Failed to load features\n'));
    return;
  }

  console.log(chalk.cyan('\n/project analyze - AI-Powered Project Analysis'));
  console.log(chalk.dim('─'.repeat(50)));
  console.log(chalk.dim(`Total: ${stats.total} | Completed: ${stats.completed} | Pending: ${stats.pending} | Skipped: ${stats.skipped}`));
  console.log(chalk.dim(`Progress: ${stats.percentage}%`));
  console.log();

  // 如果没有 AI 选项，显示基本分析
  const options = callbacks.createKodaXOptions?.();
  if (!options) {
    console.log(chalk.yellow('[Warning] AI analysis not available in current mode'));
    console.log(chalk.dim('\nBasic Analysis:'));
    console.log(chalk.dim(`  • ${stats.pending} features remaining`));

    if (stats.percentage > 75) {
      console.log(chalk.green('  • Project is nearly complete!'));
    } else if (stats.percentage > 50) {
      console.log(chalk.cyan('  • Good progress, keep going!'));
    } else if (stats.percentage > 25) {
      console.log(chalk.yellow('  • Steady progress, continue working'));
    } else {
      console.log(chalk.yellow('  • Project is in early stages'));
    }

    console.log();
    return;
  }

  // 默认分析（无 guidance）
  if (!guidance) {
    console.log(chalk.cyan('Running comprehensive project analysis...'));
    console.log();

    const prompt = `Analyze this software project and provide insights:

Project Statistics:
- Total features: ${stats.total}
- Completed: ${stats.completed} (${stats.percentage}%)
- Pending: ${stats.pending}
- Skipped: ${stats.skipped}

Pending features:
${JSON.stringify(features.features.filter(f => !f.passes && !f.skipped).slice(0, 10), null, 2)}

Please provide:
1. **Progress Assessment**: Overall project health and momentum
2. **Risk Analysis**: Potential blockers or risky features
3. **Priority Recommendations**: Which features should be tackled next
4. **Time Estimation**: Rough estimate of remaining work (based on feature complexity)
5. **Quality Check**: Any patterns or issues you notice

Keep your analysis concise and actionable.`;

    try {
      const result = await runKodaX(
        {
          ...options,
          session: {
            ...options.session,
            initialMessages: context.messages,
          },
        },
        prompt
      );

      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage?.content) {
        const content = typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.content.map(c => ('text' in c ? c.text : '') || '').join('');
        console.log(content);
      }

      console.log();
      console.log(chalk.dim('─'.repeat(50)));
      console.log(chalk.dim('Use /project analyze "your question" for custom analysis'));
      console.log();
    } catch (error) {
      console.log(chalk.red('\n[Error] Analysis failed'));
      console.log(chalk.dim(error instanceof Error ? error.message : String(error)));
      console.log();
    }
    return;
  }

  // 自定义分析（有 guidance）
  console.log(chalk.cyan(`Custom Analysis: "${guidance}"`));
  console.log();

  const prompt = `Analyze this software project based on the user's specific question:

Project Statistics:
- Total features: ${stats.total}
- Completed: ${stats.completed} (${stats.percentage}%)
- Pending: ${stats.pending}
- Skipped: ${stats.skipped}

All features:
${JSON.stringify(features.features, null, 2)}

User's question: "${guidance}"

Please provide a detailed and helpful analysis addressing the user's specific question.`;

  try {
    const result = await runKodaX(
      {
        ...options,
        session: {
          ...options.session,
          initialMessages: context.messages,
        },
      },
      prompt
    );

    const lastMessage = result.messages[result.messages.length - 1];
    if (lastMessage?.content) {
      const content = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : lastMessage.content.map(c => ('text' in c ? c.text : '') || '').join('');
      console.log(content);
    }

    console.log();
  } catch (error) {
    console.log(chalk.red('\n[Error] Analysis failed'));
    console.log(chalk.dim(error instanceof Error ? error.message : String(error)));
    console.log();
  }
}

/**
 * 重置项目（安全删除）
 */
async function projectReset(
  args: string[],
  confirm: (message: string) => Promise<boolean>
): Promise<void> {
  const storage = getProjectStorage();
  const isAll = args.includes('--all');

  if (isAll) {
    console.log(chalk.yellow('\n⚠️  This will DELETE all project management files:'));
    console.log();
    console.log(chalk.cyan('Files to be deleted:'));
    console.log(chalk.dim('  📄 feature_list.json'));
    console.log(chalk.dim('  📄 PROGRESS.md'));
    console.log(chalk.dim('  📁 .agent/project/ (session plan, brainstorm, harness records)'));
    console.log();
    console.log(chalk.green('✓ Safe: .kodax/ folder and other control-plane files are preserved'));
    console.log(chalk.green('✓ Your project code is SAFE (src/, package.json, etc.)'));
    console.log(chalk.red('✗ This action cannot be undone!'));
    console.log();

    const confirmed = await confirm('Delete all project management files?');
    if (confirmed) {
      const result = await storage.deleteProjectManagementFiles();

      console.log();
      if (result.deleted > 0) {
        console.log(chalk.green(`✓ Deleted ${result.deleted} project management file(s)`));
      }
      if (result.failed > 0) {
        console.log(chalk.red(`✗ Failed to delete ${result.failed} file(s)`));
      }
      console.log();
      console.log(chalk.dim('Use /project init to start a new project'));
      console.log();
    } else {
      console.log(chalk.dim('\nCancelled.\n'));
    }
  } else {
    // 默认：只清空 PROGRESS.md
    console.log(chalk.cyan('\nThis will clear the progress log (PROGRESS.md).'));
    console.log(chalk.dim('  ✓ feature_list.json will be preserved'));
    console.log(chalk.dim('  ✓ .agent/project/* runtime artifacts will be preserved'));
    console.log(chalk.dim('  ✓ All features will remain intact'));
    console.log();

    const confirmed = await confirm('Clear progress log?');
    if (confirmed) {
      await storage.clearProgress();
      console.log(chalk.green('\n✓ Progress log cleared'));
      console.log(chalk.dim('Use /project status to continue tracking progress'));
      console.log();
    } else {
      console.log(chalk.dim('\nCancelled.\n'));
    }
  }
}

/**
 * 主入口：处理 /project 命令
 */
export async function handleProjectCommand(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
): Promise<{ projectInitPrompt: string } | void> {
  const subCommand = args[0]?.toLowerCase();

  // 确定确认函数的来源
  // 优先使用 callbacks.confirm (Ink UI)，其次使用 readline (传统 REPL)
  const rl = callbacks.readline;
  const hasConfirm = !!callbacks.confirm;

  // 对于需要交互的命令，检查是否有确认能力
  if (['init', 'next', 'auto', 'edit', 'reset'].includes(subCommand ?? '')) {
    if (!hasConfirm && !rl) {
      console.log(chalk.red(`\n[Error] /project ${subCommand} is not available in the current UI mode`));
      console.log(chalk.dim('This command requires interactive input which is not supported.\n'));
      return;
    }
  }

  // 创建辅助函数 - 优先使用 callbacks.confirm
  const confirm: (message: string) => Promise<boolean> = hasConfirm
    ? callbacks.confirm!
    : rl
      ? createConfirmFn(rl)
      : async () => false;
  const question = rl ? createQuestionFn(rl) : async () => '';

  switch (subCommand) {
    case 'init':
    case 'i':
      return await projectInit(args.slice(1), context, callbacks, currentConfig, confirm);

    case 'status':
    case 'st':
    case 'info':
      await projectStatus(args.slice(1), context, callbacks);
      break;

    case 'plan':
      await projectPlan(args.slice(1), context, callbacks);
      break;

    case 'quality':
    case 'q':
      await projectQuality(context, callbacks);
      break;

    case 'brainstorm':
    case 'bs':
      await projectBrainstorm(args.slice(1), context, callbacks);
      break;

    case 'next':
    case 'n':
      await projectNext(args.slice(1), context, callbacks, currentConfig, confirm);
      break;

    case 'auto':
    case 'a':
      await projectAuto(args.slice(1), context, callbacks, currentConfig, confirm, question);
      break;

    case 'verify':
    case 'v':
      await projectVerify(args.slice(1));
      break;

    case 'pause':
      await projectPause();
      break;

    case 'edit':
    case 'e':
      await projectEdit(args.slice(1), context, callbacks, confirm);
      break;

    case 'reset':
      await projectReset(args.slice(1), confirm);
      break;

    case 'list':
    case 'l':
      console.log(chalk.dim('\n[Deprecated] Use /project status --features instead\n'));
      await projectList();
      break;

    case 'mark':
    case 'm':
      await projectMark(args.slice(1));
      break;

    case 'progress':
    case 'p':
      console.log(chalk.dim('\n[Deprecated] Use /project status --progress instead\n'));
      await projectProgress();
      break;

    case 'analyze':
      await projectAnalyze(args.slice(1), context, callbacks);
      break;

    default:
      printProjectHelp();
  }
}

/**
 * 检测并显示项目提示
 */
export async function detectAndShowProjectHint(): Promise<boolean> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    return false;
  }

  const state = await getWorkflowState(storage);
  const stats = await storage.getStatistics();
  const hasSessionPlan = (await storage.readSessionPlan()).trim().length > 0;
  const nextStep = getRecommendedNextStep(state, stats.total > 0, hasSessionPlan);

  console.log(chalk.cyan('  📁 Long-running project detected'));
  console.log(chalk.dim(`    ${stats.completed}/${stats.total} features completed [${stats.percentage}%]`));
  console.log(chalk.dim(`    Stage: ${formatStage(state.stage)}`));
  console.log(chalk.dim('    Use /project status to view progress'));
  console.log(chalk.dim(`    Recommended next step: ${nextStep}`));
  console.log(chalk.dim('    Use /project quality or /project verify when you need diagnostic help'));
  console.log();

  return true;
}
