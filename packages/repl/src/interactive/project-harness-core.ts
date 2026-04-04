import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  KodaXEvents,
  KodaXMessage,
  KodaXOptions,
  KodaXTaskCapabilityHint,
  KodaXTaskVerificationCriterion,
  KodaXTaskVerificationContract,
  KodaXRuntimeVerificationContract,
} from '@kodax/coding';
import type { ProjectFeature } from './project-state.js';
import { isRecord, isStringArray } from './json-guards.js';
import { ProjectStorage } from './project-storage.js';
import { buildProjectQualityReport } from './project-quality.js';
import type {
  ProjectHarnessCalibrationCaseRecord,
  ProjectHarnessCalibrationLabel,
  ProjectHarnessCheckConfig,
  ProjectHarnessCheckpointRecord,
  ProjectHarnessCheckResult,
  ProjectHarnessCompletionReport,
  ProjectHarnessConfig,
  ProjectHarnessCriticRecord,
  ProjectHarnessEvidenceRecord,
  ProjectHarnessExceptionConfig,
  ProjectHarnessInvariantConfig,
  ProjectHarnessRepairPlaybookDefinition,
  ProjectHarnessRepairPolicyConfig,
  ProjectHarnessRuleSources,
  ProjectHarnessRunRecord,
  ProjectHarnessScorecard,
  ProjectHarnessSessionNodeRecord,
  ProjectHarnessVerificationResult,
  ProjectHarnessViolation,
} from './project-harness.js';

function isProjectHarnessCompletionReport(value: unknown): value is ProjectHarnessCompletionReport {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.status === 'string'
    && ['complete', 'needs_review', 'blocked'].includes(value.status)
    && typeof value.summary === 'string'
    && (value.evidence === undefined || isStringArray(value.evidence))
    && (value.tests === undefined || isStringArray(value.tests))
    && (value.changedFiles === undefined || isStringArray(value.changedFiles))
    && (value.blockers === undefined || isStringArray(value.blockers));
}

function dedupeCapabilityHints(hints: KodaXTaskCapabilityHint[]): KodaXTaskCapabilityHint[] {
  const seen = new Set<string>();
  const result: KodaXTaskCapabilityHint[] = [];
  for (const hint of hints) {
    const key = `${hint.kind}:${hint.name}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(hint);
  }
  return result;
}

const execAsync = promisify(execCallback);
const TEST_EVIDENCE_PATTERNS = [
  /tdd first/i,
  /test[- ]first/i,
  /write tests? before implementation/i,
  /tests? before implementation/i,
  /test requirements/i,
] as const;
const DOC_UPDATE_PATTERNS = [
  /doc first/i,
  /update docs? before coding/i,
  /architecture decisions?/i,
  /\badr\b/i,
  /feature design/i,
] as const;
const ARCHITECTURE_CHANGE_CLAIM_PATTERN = /\b(architecture|architectural|boundary|layer|refactor|interface|contract|dependency)\b/i;
const LAYER_INDEPENDENCE_PATTERNS = [
  /layer independence/i,
  /no circular dependencies/i,
  /monorepo structure/i,
  /package dependenc/i,
] as const;
const DEFAULT_PACKAGE_LAYER_ORDER = ['ai', 'agent', 'skills', 'coding', 'repl', 'cli'] as const;
const FRONTEND_VERIFICATION_PATTERN = /\b(frontend|front-end|ui|browser|page|screen|playwright|e2e|webapp|visual)\b/i;
const REPAIR_PLAYBOOKS: Array<{
  id: string;
  matches: Array<string | RegExp>;
  actions: string[];
}> = [
  {
    id: 'completion-proof',
    matches: ['missing_completion_report', 'missing_changed_files', 'missing_implementation_evidence'],
    actions: [
      'Finish with a valid <project-harness> JSON block.',
      'List concrete changedFiles and evidence items before asking for completion.',
    ],
  },
  {
    id: 'test-proof',
    matches: ['missing_test_evidence', /^required_check_failed:/],
    actions: [
      'Run the relevant project checks locally and report them in the completion report.',
      'Add or update tests before retrying.',
    ],
  },
  {
    id: 'architecture-boundary',
    matches: ['missing_doc_evidence', 'layer_direction_violation', 'cross_package_relative_import', 'package_internal_import'],
    actions: [
      'Keep imports within package boundaries and declared layer directions.',
      'Update docs or ADR evidence if the change is truly architectural.',
    ],
  },
  {
    id: 'stall-recovery',
    matches: ['stall_repeated_failure', 'unrelated_diff', 'reported_needs_review'],
    actions: [
      'Reduce scope to the active feature and stop broad cleanup edits.',
      'Pause and revise the plan before retrying.',
    ],
  },
];

function buildVerificationCapabilityHints(
  feature: ProjectFeature,
  config: ProjectHarnessConfig,
): KodaXTaskCapabilityHint[] {
  const hints: KodaXTaskCapabilityHint[] = [];
  const combinedText = [
    feature.name,
    feature.description,
    ...(feature.steps ?? []),
  ].filter(Boolean).join(' ');

  if (FRONTEND_VERIFICATION_PATTERN.test(combinedText)) {
    hints.push(
      {
        kind: 'skill',
        name: 'agent-browser',
        details: 'Use browser automation when the evaluator needs to inspect the real frontend flow.',
      },
      {
        kind: 'tool',
        name: 'playwright',
        details: 'Preferred browser runner for end-to-end evaluator verification.',
      },
      {
        kind: 'workflow',
        name: 'frontend-verification',
        details: 'Open the app, exercise the critical path, and reject completion on visible or console failures.',
      },
    );
  }

  for (const check of config.checks) {
    hints.push({
      kind: 'command',
      name: check.id,
      details: check.command,
    });

    if (/playwright|cypress|e2e/i.test(check.command)) {
      hints.push(
        {
          kind: 'skill',
          name: 'agent-browser',
          details: `Support the "${check.id}" check with browser automation evidence.`,
        },
        {
          kind: 'tool',
          name: 'playwright',
          details: `Run or inspect the browser suite required by "${check.id}".`,
        },
      );
    }
  }

  return dedupeCapabilityHints(hints);
}

const FEATURE_KEYWORD_STOP_WORDS = new Set([
  'add',
  'build',
  'feature',
  'project',
  'implement',
  'implementation',
  'support',
  'mode',
  'with',
  'into',
  'from',
  'that',
  'this',
  'have',
  'will',
  'should',
  'after',
  'before',
  'using',
  'update',
]);
const FEATURE_CJK_STOP_WORDS = new Set([
  '实现',
  '添加',
  '新增',
  '更新',
  '支持',
  '功能',
  '项目',
  '模式',
  '当前',
  '相关',
  '进行',
  '用于',
]);

interface HarnessAttemptSnapshot {
  progressText: string;
  qualityScore: number;
}

interface EvaluateHarnessRunOptions {
  storage: ProjectStorage;
  featureIndex: number;
  mode: 'next' | 'auto' | 'verify';
  attempt: number;
  config: ProjectHarnessConfig;
  completionReport: ProjectHarnessCompletionReport | null;
  touchedFiles: string[];
  violations: ProjectHarnessViolation[];
  qualityBefore: number;
  progressBeforeText?: string;
  requireFreshProgressDelta: boolean;
  persist: boolean;
}

function getProjectRoot(storage: ProjectStorage): string {
  return path.dirname(storage.getPaths().features);
}

function buildRunId(featureIndex: number, attempt: number): string {
  return `feature-${featureIndex}-${Date.now()}-attempt-${attempt}`;
}

function buildCheckpointId(runId: string): string {
  return `${runId}-checkpoint`;
}

function buildSessionNodeId(runId: string): string {
  return `${runId}-node`;
}

function buildCalibrationCaseId(runId: string, label: ProjectHarnessCalibrationLabel): string {
  return `${runId}-${label}`;
}

function getCalibrationExpectedDecision(label: ProjectHarnessCalibrationLabel): ProjectHarnessRunRecord['decision'] {
  return label === 'false_fail' ? 'verified_complete' : 'needs_review';
}

function formatCalibrationSummary(
  run: ProjectHarnessRunRecord,
  label: ProjectHarnessCalibrationLabel,
  summary?: string,
): string {
  if (summary && summary.trim().length > 0) {
    return summary.trim();
  }

  return label === 'false_fail'
    ? `Manual review accepted feature #${run.featureIndex} after harness returned ${run.decision}.`
    : `Manual review rejected a previously verified completion for feature #${run.featureIndex}.`;
}

function extractAssistantText(messages: KodaXMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant' || !message.content) {
      continue;
    }

    if (typeof message.content === 'string') {
      return message.content;
    }

    return message.content
      .map(part => ('text' in part ? part.text : '') || '')
      .join('');
  }

  return '';
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function resolveProjectPath(projectRoot: string, value: string): string {
  return path.isAbsolute(value)
    ? normalizePath(value)
    : normalizePath(path.join(projectRoot, value));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

async function getGitSnapshot(projectRoot: string): Promise<{
  gitHead: string | null;
  gitStatus: string[];
}> {
  try {
    const { stdout: headStdout } = await execAsync('git rev-parse HEAD', {
      cwd: projectRoot,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const gitHead = headStdout.trim() || null;

    let gitStatus: string[] = [];
    try {
      const { stdout: statusStdout } = await execAsync('git status --short', {
        cwd: projectRoot,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      gitStatus = statusStdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    } catch {
      gitStatus = [];
    }

    return { gitHead, gitStatus };
  } catch {
    return {
      gitHead: null,
      gitStatus: [],
    };
  }
}

function getWriteTarget(tool: string, input: Record<string, unknown>): string | null {
  if (tool !== 'write' && tool !== 'edit') {
    return null;
  }

  const rawPath = input.path;
  return typeof rawPath === 'string' && rawPath.trim().length > 0
    ? normalizePath(rawPath)
    : null;
}

function normalizeCommandForMatching(command: string): string {
  return command.replace(/\\/g, '/').toLowerCase();
}

function tokenReferencesProtectedTarget(token: string, targetVariants: string[]): boolean {
  const cleaned = token
    .replace(/^['"]|['"]$/g, '')
    .replace(/^[.][/]/, '')
    .replace(/[;|&]+$/g, '');

  return targetVariants.some(variant =>
    cleaned === variant
    || cleaned.startsWith(`${variant}/`)
    || cleaned.endsWith(`/${variant}`)
    || cleaned.includes(`/${variant}/`),
  );
}

function shellCommandRedirectsToTarget(command: string, targetVariants: string[]): boolean {
  if (targetVariants.length === 0) {
    return false;
  }

  const normalized = normalizeCommandForMatching(command);
  let activeQuote: '"' | '\'' | null = null;

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];

    if (activeQuote) {
      if (char === activeQuote && normalized[i - 1] !== '\\') {
        activeQuote = null;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      activeQuote = char;
      continue;
    }

    if (char !== '>') {
      continue;
    }

    if (normalized[i + 1] === '=') {
      continue;
    }

    let cursor = i + (normalized[i + 1] === '>' ? 2 : 1);
    while (/\s/.test(normalized[cursor] ?? '')) {
      cursor += 1;
    }

    const quote = normalized[cursor] === '"' || normalized[cursor] === '\''
      ? normalized[cursor] as '"' | '\''
      : null;
    if (quote) {
      cursor += 1;
    }

    const start = cursor;
    while (cursor < normalized.length) {
      const current = normalized[cursor] ?? '';
      if (quote) {
        if (current === quote && normalized[cursor - 1] !== '\\') {
          break;
        }
      } else if (/\s|[;|&]/.test(current)) {
        break;
      }
      cursor += 1;
    }

    const token = normalized.slice(start, cursor);
    if (tokenReferencesProtectedTarget(token, targetVariants)) {
      return true;
    }
  }

  return false;
}

function shellCommandLooksMutating(command: string, targetVariants: string[] = []): boolean {
  const normalized = normalizeCommandForMatching(command);
  return (
    /(^|\s)(set-content|add-content|out-file|copy-item|move-item|remove-item|ren|rename-item|ni|new-item|sc|ac|cp|copy|mv|move|rm|del|tee|touch)(\s|$)/.test(normalized)
    || /\b(writefilesync|writefile|appendfile|appendfilesync|createwritestream|writesync|truncate|copyfilesync|copyfile|rename|renamesync|unlink|unlinksync|mkdir|mkdirsync|rm|rmsync)\b/.test(normalized)
    || shellCommandRedirectsToTarget(command, targetVariants)
    || /\bsed\s+-i\b/.test(normalized)
  );
}

function shellCommandLooksReadOnly(command: string): boolean {
  const normalized = normalizeCommandForMatching(command).trim();
  if (shellCommandLooksMutating(normalized)) {
    return false;
  }

  return /^(cat|type|get-content|gc|ls|dir|rg|grep|findstr|more|head|tail|wc|stat)\b/.test(normalized);
}

function getProtectedShellTarget(
  command: string,
  projectRoot: string,
  protectedTargets: string[],
): string | null {
  const normalizedCommand = normalizeCommandForMatching(command);
  for (const target of protectedTargets) {
    const relativeTarget = path.relative(projectRoot, target).split(path.sep).join('/').toLowerCase().replace(/^\.\//, '');
    const absoluteTarget = target.replace(/\\/g, '/').toLowerCase();
    const targetVariants = [relativeTarget, absoluteTarget].filter(Boolean);
    if (targetVariants.length === 0) {
      continue;
    }

    if (targetVariants.some(variant => normalizedCommand.includes(variant))) {
      if (shellCommandLooksMutating(command, targetVariants)) {
        return target;
      }

      if (shellCommandLooksReadOnly(command)) {
        return null;
      }

      return null;
    }
  }

  return null;
}

function parseCompletionReport(messages: KodaXMessage[]): ProjectHarnessCompletionReport | null {
  const text = extractAssistantText(messages);
  const match = text.match(/<project-harness>\s*([\s\S]*?)\s*<\/project-harness>/i);
  if (!match?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]);
    return isProjectHarnessCompletionReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildScriptCommand(packageManager: string, script: string): string {
  switch (packageManager) {
    case 'pnpm':
      return `pnpm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    default:
      return `npm run ${script}`;
  }
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function toWorkspaceRelativePath(projectRoot: string, candidatePath: string): string {
  return path.relative(projectRoot, candidatePath).split(path.sep).join('/');
}

function stripChecklistLeadWords(value: string): string {
  return value
    .replace(/^(?:add|implement|update|support|create|write|introduce|document|record|ensure|fix)\b[\s:：-]*/iu, '')
    .replace(/^(?:添加|新增|实现|更新|支持|编写|补充|完善|修复|记录|确保)[\s:：-]*/u, '');
}

function normalizeChecklistMatchText(value: string): string {
  return stripChecklistLeadWords(normalizeChecklistItem(value))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Script=Han}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractKeywords(text: string): string[] {
  const normalized = normalizeChecklistMatchText(text);
  const latinTokens = (normalized.match(/[a-z][a-z0-9_-]{2,}/g) ?? [])
    .filter(token => !FEATURE_KEYWORD_STOP_WORDS.has(token));
  const cjkTokens = (normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [])
    .filter(token => !FEATURE_CJK_STOP_WORDS.has(token));

  return Array.from(
    new Set(
      [...latinTokens, ...cjkTokens],
    ),
  );
}

function normalizeChecklistItem(value: string): string {
  return value
    .replace(/^\s*-\s*\[[^\]]*\]\s*/, '')
    .replace(/^\s*-\s*/, '')
    .replace(/^[a-z]+-\d+:\s*/i, '')
    .replace(/\s+\([^)]*\)\s*$/u, '')
    .trim();
}

function parseSessionPlanChecklist(sessionPlanText: string): string[] {
  if (!sessionPlanText.trim()) {
    return [];
  }

  const lines = sessionPlanText.replace(/\r\n/g, '\n').split('\n');
  const allowedSections = new Set(['implementation', 'validation']);
  let currentSection = '';
  const checklist: string[] = [];

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.+?)\s*(?:\(|$)/);
    if (sectionMatch?.[1]) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      continue;
    }

    if (!allowedSections.has(currentSection)) {
      continue;
    }

    if (/^\s*-\s*\[[^\]]*\]\s+/.test(line)) {
      const item = normalizeChecklistItem(line);
      if (item) {
        checklist.push(item);
      }
    }
  }

  return checklist;
}

function checklistItemMatched(item: string, haystack: string): boolean {
  const normalizedItem = normalizeChecklistMatchText(item);
  const normalizedHaystack = normalizeChecklistMatchText(haystack);
  if (!normalizedItem || !normalizedHaystack) {
    return false;
  }

  if (normalizedHaystack.includes(normalizedItem)) {
    return true;
  }

  const keywords = extractKeywords(normalizedItem);
  if (keywords.length === 0) {
    return normalizedHaystack.includes(normalizedItem);
  }

  const matchedCount = keywords.filter(keyword => normalizedHaystack.includes(keyword)).length;
  const requiredMatches = keywords.length <= 2
    ? keywords.length
    : Math.max(2, Math.ceil(keywords.length * 0.75));
  return matchedCount >= Math.min(requiredMatches, keywords.length);
}

function evaluateChecklistCoverage(
  checklist: string[],
  haystack: string,
): { matched: string[]; missing: string[] } {
  const matched: string[] = [];
  const missing: string[] = [];

  for (const item of checklist.map(normalizeChecklistItem).filter(Boolean)) {
    if (checklistItemMatched(item, haystack)) {
      matched.push(item);
    } else {
      missing.push(item);
    }
  }

  return { matched, missing };
}

function matchesConfiguredPattern(input: string, patterns: string[]): boolean {
  const normalized = input.toLowerCase();
  return patterns.some(pattern => normalized.includes(pattern.toLowerCase()));
}

function mergeInvariantConfig(
  existing: ProjectHarnessInvariantConfig | undefined,
  discovered: ProjectHarnessInvariantConfig,
): ProjectHarnessInvariantConfig {
  return {
    ...discovered,
    ...existing,
    packageLayerOrder: existing?.packageLayerOrder ?? discovered.packageLayerOrder,
    sourceNotes: Array.from(new Set([
      ...discovered.sourceNotes,
      ...(existing?.sourceNotes ?? []),
    ])),
  };
}

function mergeExceptionConfig(
  existing: ProjectHarnessExceptionConfig | undefined,
  discovered: ProjectHarnessExceptionConfig,
): ProjectHarnessExceptionConfig {
  return {
    allowedImportSpecifiers: existing?.allowedImportSpecifiers ?? discovered.allowedImportSpecifiers,
    skipChecklistFeaturePatterns: existing?.skipChecklistFeaturePatterns ?? discovered.skipChecklistFeaturePatterns,
  };
}

function mergeRepairPolicyConfig(
  existing: ProjectHarnessRepairPolicyConfig | undefined,
  discovered: ProjectHarnessRepairPolicyConfig,
): ProjectHarnessRepairPolicyConfig {
  return {
    codeOverrides: existing?.codeOverrides ?? discovered.codeOverrides,
    customPlaybooks: existing?.customPlaybooks ?? discovered.customPlaybooks,
  };
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function addFailure(
  failureCodes: string[],
  reasons: string[],
  repairHints: string[],
  code: string,
  reason: string,
  repairHint?: string,
): void {
  if (!failureCodes.includes(code)) {
    failureCodes.push(code);
  }
  reasons.push(reason);
  if (repairHint && !repairHints.includes(repairHint)) {
    repairHints.push(repairHint);
  }
}

function extractImportSpecifiers(fileContent: string): string[] {
  const matches = [
    ...fileContent.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...fileContent.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
    ...fileContent.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
  ];

  return Array.from(new Set(matches.map(match => match[1] ?? '').filter(Boolean)));
}

function getWorkspacePackageInfo(projectRoot: string, filePath: string): {
  packageName: string;
  packageRoot: string;
} | null {
  const normalized = normalizePath(filePath);
  const match = normalized.match(/[\\/]+packages[\\/]+([^\\/]+)[\\/]+/i);
  if (!match?.[1]) {
    return null;
  }

  return {
    packageName: match[1],
    packageRoot: path.join(projectRoot, 'packages', match[1]),
  };
}

async function readWorkspacePackageDependencySet(packageRoot: string): Promise<Set<string> | null> {
  try {
    const content = await fs.readFile(path.join(packageRoot, 'package.json'), 'utf-8');
    const manifest = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    return new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);
  } catch {
    return null;
  }
}

async function findPackageBoundaryViolations(
  projectRoot: string,
  changedFiles: string[],
  invariants?: ProjectHarnessInvariantConfig,
  exceptions?: ProjectHarnessExceptionConfig,
): Promise<Array<{ code: string; message: string }>> {
  if (!invariants?.enforcePackageBoundaryImports) {
    return [];
  }

  const layerOrder = new Map((invariants.packageLayerOrder ?? []).map((name, index) => [name, index]));
  const violations: Array<{ code: string; message: string }> = [];
  const seenViolations = new Set<string>();
  const dependencyCache = new Map<string, Set<string> | null>();

  for (const changedFile of changedFiles) {
    const packageInfo = getWorkspacePackageInfo(projectRoot, changedFile);
    if (!packageInfo) {
      continue;
    }

    let content = '';
    try {
      content = await fs.readFile(changedFile, 'utf-8');
    } catch {
      continue;
    }

    const specifiers = extractImportSpecifiers(content);
    for (const specifier of specifiers) {
      if (exceptions?.allowedImportSpecifiers.includes(specifier)) {
        continue;
      }

      if (specifier.startsWith('.')) {
        const resolvedTarget = path.resolve(path.dirname(changedFile), specifier);
        const normalizedTarget = normalizePath(resolvedTarget);
        if (
          normalizedTarget.includes(`${path.sep}packages${path.sep}`)
          && !normalizedTarget.startsWith(normalizePath(packageInfo.packageRoot))
        ) {
          violations.push({
            code: 'cross_package_relative_import',
            message: `${toWorkspaceRelativePath(projectRoot, changedFile)} imports another package via relative path: ${specifier}`,
          });
        }
        continue;
      }

      if (!specifier.startsWith('@kodax/')) {
        continue;
      }

      const [, importedPackageName, subpath] = specifier.split('/');
      if (!importedPackageName || importedPackageName === packageInfo.packageName) {
        continue;
      }

      if (invariants.requireDeclaredWorkspaceDependencies) {
        let declaredDependencies = dependencyCache.get(packageInfo.packageRoot);
        if (declaredDependencies === undefined) {
          declaredDependencies = await readWorkspacePackageDependencySet(packageInfo.packageRoot);
          dependencyCache.set(packageInfo.packageRoot, declaredDependencies);
        }
        const importedWorkspacePackage = `@kodax/${importedPackageName}`;
        if (declaredDependencies && !declaredDependencies.has(importedWorkspacePackage)) {
          const key = `${changedFile}:undeclared_workspace_dependency:${importedWorkspacePackage}`;
          if (!seenViolations.has(key)) {
            seenViolations.add(key);
            violations.push({
              code: 'undeclared_workspace_dependency',
              message: `${toWorkspaceRelativePath(projectRoot, changedFile)} imports ${importedWorkspacePackage} without declaring it in ${toWorkspaceRelativePath(projectRoot, path.join(packageInfo.packageRoot, 'package.json'))}`,
            });
          }
        }
      }

      if (subpath === 'src') {
        const key = `${changedFile}:package_internal_import:${specifier}`;
        if (!seenViolations.has(key)) {
          seenViolations.add(key);
          violations.push({
            code: 'package_internal_import',
            message: `${toWorkspaceRelativePath(projectRoot, changedFile)} imports package internals directly: ${specifier}`,
          });
        }
      }

      const currentRank = layerOrder.get(packageInfo.packageName);
      const importedRank = layerOrder.get(importedPackageName);
      if (
        currentRank !== undefined
        && importedRank !== undefined
        && importedRank > currentRank
      ) {
        const key = `${changedFile}:layer_direction_violation:${specifier}`;
        if (!seenViolations.has(key)) {
          seenViolations.add(key);
          violations.push({
            code: 'layer_direction_violation',
            message: `${toWorkspaceRelativePath(projectRoot, changedFile)} imports higher-layer package ${specifier}`,
          });
        }
      }
    }
  }

  return violations;
}

function buildScorecard(input: {
  decision: ProjectHarnessVerificationResult['decision'];
  violations: ProjectHarnessViolation[];
  checks: ProjectHarnessCheckResult[];
  featureKeywords: string[];
  matchedFeatureKeywords: string[];
  progressUpdated: boolean;
  completionReport: ProjectHarnessCompletionReport | null;
  changedFiles: string[];
  qualityDelta: number;
  recentFeatureFailures: number;
  attempt: number;
}): ProjectHarnessScorecard {
  const requiredChecks = input.checks.filter(check => check.required);
  const passedRequiredChecks = requiredChecks.filter(check => check.passed);
  const checksScore = requiredChecks.length === 0
    ? 75
    : (passedRequiredChecks.length / requiredChecks.length) * 100;
  const featureRelevance = input.featureKeywords.length === 0
    ? 70
    : (input.matchedFeatureKeywords.length / input.featureKeywords.length) * 100;
  const evidenceSignals = [
    input.progressUpdated,
    Boolean(input.completionReport?.summary),
    input.changedFiles.length > 0,
    (input.completionReport?.tests?.length ?? 0) > 0,
    (input.completionReport?.evidence?.length ?? 0) > 0,
  ].filter(Boolean).length;
  const evidenceCompleteness = (evidenceSignals / 5) * 100;
  const legality = input.violations.length > 0 || input.decision === 'blocked' ? 0 : 100;
  const qualityDelta = clampScore(50 + input.qualityDelta * 8);
  const stallResistance = clampScore(100 - input.recentFeatureFailures * 35 - (input.decision === 'needs_review' ? 20 : 0));
  const costEfficiency = clampScore(100 - (input.attempt - 1) * 20 - Math.max(0, input.changedFiles.length - 4) * 5);
  const overall = clampScore(
    legality * 0.2
    + checksScore * 0.2
    + featureRelevance * 0.15
    + evidenceCompleteness * 0.15
    + qualityDelta * 0.1
    + stallResistance * 0.1
    + costEfficiency * 0.1
  );

  return {
    legality,
    checks: clampScore(checksScore),
    featureRelevance: clampScore(featureRelevance),
    evidenceCompleteness: clampScore(evidenceCompleteness),
    qualityDelta,
    stallResistance,
    costEfficiency,
    overall,
  };
}

function resolveRepairPlaybooks(
  failureCodes: string[],
  config: ProjectHarnessConfig,
): string[] {
  const defaultPlaybooks = REPAIR_PLAYBOOKS
    .filter(playbook => playbook.matches.some((matcher) => (
      typeof matcher === 'string'
        ? failureCodes.includes(matcher)
        : failureCodes.some(code => matcher.test(code))
    )))
    .map(playbook => playbook.id);

  const overridePlaybooks = Object.entries(config.repairPolicy?.codeOverrides ?? {})
    .filter(([failureCode]) => failureCodes.includes(failureCode))
    .flatMap(([, playbooks]) => playbooks);

  return Array.from(new Set([...defaultPlaybooks, ...overridePlaybooks]));
}

function resolveRepairActions(playbookIds: string[], config: ProjectHarnessConfig): string[] {
  const playbookCatalog = [
    ...REPAIR_PLAYBOOKS.map(playbook => ({
      id: playbook.id,
      actions: playbook.actions,
    })),
    ...(config.repairPolicy?.customPlaybooks ?? []),
  ];

  return Array.from(
    new Set(
      playbookCatalog
        .filter(playbook => playbookIds.includes(playbook.id))
        .flatMap(playbook => playbook.actions),
    ),
  );
}

async function findMarkdownFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...await findMarkdownFiles(fullPath));
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }

    return files.sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function discoverRuleSources(
  projectRoot: string,
  scripts: Record<string, string>,
): Promise<ProjectHarnessRuleSources> {
  const projectAgentsCandidates = [
    path.join(projectRoot, 'AGENTS.md'),
    path.join(projectRoot, 'docs', 'AGENTS.md'),
  ];
  const hldPath = path.join(projectRoot, 'docs', 'HLD.md');
  const adrRootPath = path.join(projectRoot, 'docs', 'ADR');
  const adrIndexPath = path.join(projectRoot, 'docs', 'ADR.md');
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const projectAgents = (
    await Promise.all(
      projectAgentsCandidates.map(async candidate => (
        await pathExists(candidate) ? toWorkspaceRelativePath(projectRoot, candidate) : null
      )),
    )
  ).filter((candidate): candidate is string => candidate !== null);
  const architectureDocs = await pathExists(hldPath)
    ? [toWorkspaceRelativePath(projectRoot, hldPath)]
    : [];
  const adrDocs = [
    ...(await pathExists(adrIndexPath) ? [toWorkspaceRelativePath(projectRoot, adrIndexPath)] : []),
    ...(await findMarkdownFiles(adrRootPath))
      .map(filePath => toWorkspaceRelativePath(projectRoot, filePath)),
  ];
  const scriptSources = (await pathExists(packageJsonPath))
    ? [
        toWorkspaceRelativePath(projectRoot, packageJsonPath),
        ...Object.keys(scripts)
          .sort((left, right) => left.localeCompare(right))
          .map(scriptName => `package.json#scripts.${scriptName}`),
      ]
    : [];

  return {
    projectAgents,
    architectureDocs,
    adrDocs,
    scriptSources,
    excludedControlPlane: ['.kodax/**'],
  };
}

async function compileInvariantConfig(
  projectRoot: string,
  ruleSources: ProjectHarnessRuleSources,
): Promise<ProjectHarnessInvariantConfig> {
  const candidateFiles = Array.from(
    new Set([
      ...ruleSources.projectAgents,
      ...ruleSources.architectureDocs,
      ...ruleSources.adrDocs,
    ]),
  );

  let requireTestEvidenceOnComplete = false;
  let requireDocUpdateOnArchitectureChange = false;
  let enforcePackageBoundaryImports = false;
  const sourceNotes: string[] = [];

  for (const relativePath of candidateFiles) {
    try {
      const content = await fs.readFile(path.join(projectRoot, relativePath), 'utf-8');

      if (!requireTestEvidenceOnComplete && TEST_EVIDENCE_PATTERNS.some(pattern => pattern.test(content))) {
        requireTestEvidenceOnComplete = true;
        sourceNotes.push(`${relativePath}: requires explicit test evidence`);
      }

      if (!requireDocUpdateOnArchitectureChange && DOC_UPDATE_PATTERNS.some(pattern => pattern.test(content))) {
        requireDocUpdateOnArchitectureChange = true;
        sourceNotes.push(`${relativePath}: requires doc or ADR evidence for architecture-level changes`);
      }

      if (!enforcePackageBoundaryImports && LAYER_INDEPENDENCE_PATTERNS.some(pattern => pattern.test(content))) {
        enforcePackageBoundaryImports = true;
        sourceNotes.push(`${relativePath}: enforces package boundary and layer-direction imports`);
      }
    } catch {
      // Ignore disappearing files during discovery; fingerprint refresh will reconcile later.
    }
  }

  return {
    requireTestEvidenceOnComplete,
    requireDocUpdateOnArchitectureChange,
    enforcePackageBoundaryImports,
    requireDeclaredWorkspaceDependencies: true,
    requireFeatureChecklistCoverageOnComplete: true,
    requireSessionPlanChecklistCoverage: true,
    checklistCoverageMinimum: 0.5,
    packageLayerOrder: enforcePackageBoundaryImports ? [...DEFAULT_PACKAGE_LAYER_ORDER] : undefined,
    sourceNotes: [
      ...sourceNotes,
      'workspace package imports should be declared in the importing package manifest',
      'feature steps are treated as proof-carrying completion checklist items',
      'session plan Implementation/Validation tasks can be used as completion checklist evidence',
    ],
  };
}

async function readPackageScripts(projectRoot: string): Promise<Record<string, string>> {
  const packageJsonPath = path.join(projectRoot, 'package.json');

  try {
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content) as { scripts?: Record<string, string> };
    return packageJson.scripts ?? {};
  } catch {
    return {};
  }
}

async function collectRuleSourceFiles(projectRoot: string): Promise<string[]> {
  const sourceFiles: string[] = [];
  const agentsPaths = [
    path.join(projectRoot, 'AGENTS.md'),
    path.join(projectRoot, 'docs', 'AGENTS.md'),
  ];
  const hldPath = path.join(projectRoot, 'docs', 'HLD.md');
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const adrRootPath = path.join(projectRoot, 'docs', 'ADR');
  const adrIndexPath = path.join(projectRoot, 'docs', 'ADR.md');

  for (const agentsPath of agentsPaths) {
    if (await pathExists(agentsPath)) {
      sourceFiles.push(agentsPath);
    }
  }
  if (await pathExists(hldPath)) {
    sourceFiles.push(hldPath);
  }
  if (await pathExists(packageJsonPath)) {
    sourceFiles.push(packageJsonPath);
  }
  if (await pathExists(adrIndexPath)) {
    sourceFiles.push(adrIndexPath);
  }
  sourceFiles.push(...await findMarkdownFiles(adrRootPath));

  return sourceFiles.sort((left, right) => left.localeCompare(right));
}

async function buildSourceFingerprint(projectRoot: string): Promise<string> {
  const files = await collectRuleSourceFiles(projectRoot);
  const descriptor: Array<{ path: string; size: number; mtimeMs: number }> = [];

  for (const filePath of files) {
    const stats = await fs.stat(filePath);
    descriptor.push({
      path: toWorkspaceRelativePath(projectRoot, filePath),
      size: stats.size,
      mtimeMs: Math.trunc(stats.mtimeMs),
    });
  }

  return createHash('sha256')
    .update(JSON.stringify(descriptor))
    .digest('hex');
}

async function detectPackageManager(projectRoot: string): Promise<string> {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  try {
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content) as { packageManager?: string };
    if (packageJson.packageManager?.startsWith('pnpm@')) {
      return 'pnpm';
    }
    if (packageJson.packageManager?.startsWith('yarn@')) {
      return 'yarn';
    }
  } catch {
    // Fall through to lock-file detection.
  }

  const lockFiles = [
    { file: 'pnpm-lock.yaml', manager: 'pnpm' },
    { file: 'yarn.lock', manager: 'yarn' },
    { file: 'package-lock.json', manager: 'npm' },
  ];

  for (const candidate of lockFiles) {
    try {
      await fs.access(path.join(projectRoot, candidate.file));
      return candidate.manager;
    } catch {
      // Keep searching.
    }
  }

  return 'npm';
}

async function discoverHarnessConfig(projectRoot: string): Promise<ProjectHarnessConfig> {
  const scripts = await readPackageScripts(projectRoot);

  const packageManager = await detectPackageManager(projectRoot);
  const ruleSources = await discoverRuleSources(projectRoot, scripts);
  const invariants = await compileInvariantConfig(projectRoot, ruleSources);
  const knownScripts = ['test', 'typecheck', 'lint', 'build'];
  const checks = knownScripts
    .filter(script => typeof scripts[script] === 'string')
    .map<ProjectHarnessCheckConfig>(script => ({
      id: script,
      command: buildScriptCommand(packageManager, script),
      required: script === 'test' || script === 'build',
    }));
  const generatedCheckIds = checks.map(check => check.id);
  const sourceFingerprint = await buildSourceFingerprint(projectRoot);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    protectedArtifacts: ['feature_list.json', '.agent/project/harness'],
    checks,
    ruleSources,
    invariants,
    exceptions: {
      allowedImportSpecifiers: [],
      skipChecklistFeaturePatterns: [],
    },
    repairPolicy: {
      codeOverrides: {},
      customPlaybooks: [],
    },
    generatedCheckIds,
    sourceFingerprint,
    completionRules: {
      requireProgressUpdate: true,
      requireChecksPass: true,
      requireCompletionReport: true,
    },
    advisoryRules: {
      warnOnLargeUnrelatedDiff: true,
      warnOnRepeatedFailure: true,
    },
  };
}

async function calculateQualityScore(storage: ProjectStorage): Promise<number> {
  const featureList = await storage.loadFeatures();
  if (!featureList) {
    return 0;
  }

  const report = buildProjectQualityReport(
    featureList.features,
    await storage.readProgress(),
    await storage.readSessionPlan(),
  );
  return report.overallScore;
}

async function runHarnessChecks(
  projectRoot: string,
  checks: ProjectHarnessCheckConfig[],
): Promise<ProjectHarnessCheckResult[]> {
  const results: ProjectHarnessCheckResult[] = [];

  for (const check of checks) {
    try {
      const { stdout, stderr } = await execAsync(check.command, {
        cwd: projectRoot,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 10,
      });
      results.push({
        id: check.id,
        command: check.command,
        required: check.required,
        passed: true,
        output: `${stdout}${stderr}`.trim(),
      });
    } catch (error) {
      const execError = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      results.push({
        id: check.id,
        command: check.command,
        required: check.required,
        passed: false,
        output: `${execError.stdout ?? ''}${execError.stderr ?? ''}${execError.message ?? ''}`.trim(),
      });
    }
  }

  return results;
}

async function resolveProjectHarnessConfig(
  storage: ProjectStorage,
  options: { persist: boolean },
): Promise<ProjectHarnessConfig> {
  const existing = await storage.readHarnessConfig<ProjectHarnessConfig>();
  if (existing?.version === 1) {
    const projectRoot = getProjectRoot(storage);
    const discovered = await discoverHarnessConfig(projectRoot);
    const needsInvariantBackfill =
      existing.invariants?.requireDeclaredWorkspaceDependencies === undefined
      || existing.invariants?.requireFeatureChecklistCoverageOnComplete === undefined
      || existing.invariants?.requireSessionPlanChecklistCoverage === undefined
      || existing.invariants?.checklistCoverageMinimum === undefined;

    if (!existing.ruleSources || !existing.sourceFingerprint || !existing.exceptions || !existing.repairPolicy || needsInvariantBackfill) {
      const updatedConfig: ProjectHarnessConfig = {
        ...existing,
        ruleSources: discovered.ruleSources,
        invariants: mergeInvariantConfig(existing.invariants, discovered.invariants!),
        exceptions: mergeExceptionConfig(existing.exceptions, discovered.exceptions!),
        repairPolicy: mergeRepairPolicyConfig(existing.repairPolicy, discovered.repairPolicy!),
        generatedCheckIds: existing.generatedCheckIds ?? discovered.generatedCheckIds,
        sourceFingerprint: discovered.sourceFingerprint,
      };
      if (options.persist) {
        await storage.writeHarnessConfig(updatedConfig);
      }
      return updatedConfig;
    }

    if (existing.sourceFingerprint !== discovered.sourceFingerprint) {
      const generatedIds = new Set(existing.generatedCheckIds ?? ['test', 'typecheck', 'lint', 'build']);
      const preservedChecks = existing.checks.filter(check => !generatedIds.has(check.id));
      const updatedConfig: ProjectHarnessConfig = {
        ...existing,
        generatedAt: new Date().toISOString(),
        checks: [...preservedChecks, ...discovered.checks],
        ruleSources: discovered.ruleSources,
        invariants: mergeInvariantConfig(existing.invariants, discovered.invariants!),
        exceptions: mergeExceptionConfig(existing.exceptions, discovered.exceptions!),
        repairPolicy: mergeRepairPolicyConfig(existing.repairPolicy, discovered.repairPolicy!),
        generatedCheckIds: discovered.generatedCheckIds,
        sourceFingerprint: discovered.sourceFingerprint,
      };
      if (options.persist) {
        await storage.writeHarnessConfig(updatedConfig);
      }
      return updatedConfig;
    }

    return {
      ...existing,
      invariants: mergeInvariantConfig(existing.invariants, discovered.invariants!),
      exceptions: mergeExceptionConfig(existing.exceptions, discovered.exceptions!),
      repairPolicy: mergeRepairPolicyConfig(existing.repairPolicy, discovered.repairPolicy!),
    };
  }

  const config = await discoverHarnessConfig(getProjectRoot(storage));
  if (options.persist) {
    await storage.writeHarnessConfig(config);
  }
  return config;
}

export async function loadOrCreateProjectHarnessConfig(storage: ProjectStorage): Promise<ProjectHarnessConfig> {
  return resolveProjectHarnessConfig(storage, { persist: true });
}

export class ProjectHarnessAttempt {
  private touchedFiles = new Set<string>();
  private violations: ProjectHarnessViolation[] = [];

  constructor(
    private readonly storage: ProjectStorage,
    private readonly feature: ProjectFeature,
    private readonly featureIndex: number,
    private readonly mode: 'next' | 'auto' | 'verify',
    private readonly config: ProjectHarnessConfig,
    private readonly before: HarnessAttemptSnapshot,
    private readonly attempt: number,
  ) {}

  wrapOptions(options: KodaXOptions): KodaXOptions {
    const baseEvents = options.events;

    const wrappedEvents: KodaXEvents = {
      ...baseEvents,
      beforeToolExecute: async (tool, input) => {
        const targetPath = getWriteTarget(tool, input);
        const featuresPath = normalizePath(this.storage.getPaths().features);
        const harnessRoot = normalizePath(this.storage.getPaths().harnessRoot);
        const protectedTargets = [featuresPath, harnessRoot];

        if (targetPath) {
          this.touchedFiles.add(targetPath);

          if (targetPath === featuresPath) {
            this.violations.push({
              rule: 'protected-artifact',
              severity: 'high',
              evidence: 'feature_list.json can only be updated by the project harness after verification',
            });
            return '[Blocked by Project Harness] Do not edit feature_list.json during /project next or /project auto. The command layer updates it after verification.';
          }

          if (targetPath.startsWith(harnessRoot)) {
            this.violations.push({
              rule: 'protected-artifact',
              severity: 'high',
              evidence: '.agent/project/harness/** is reserved for verifier-owned artifacts',
            });
            return '[Blocked by Project Harness] Do not edit .agent/project/harness artifacts directly.';
          }
        }

        if (tool === 'bash' && typeof input.command === 'string') {
          const protectedShellTarget = getProtectedShellTarget(
            input.command,
            getProjectRoot(this.storage),
            protectedTargets,
          );

          if (protectedShellTarget === featuresPath) {
            this.violations.push({
              rule: 'protected-artifact',
              severity: 'high',
              evidence: 'shell command attempted to modify feature_list.json directly',
            });
            return '[Blocked by Project Harness] Shell commands must not modify feature_list.json during /project next or /project auto.';
          }

          if (protectedShellTarget && protectedShellTarget.startsWith(harnessRoot)) {
            this.violations.push({
              rule: 'protected-artifact',
              severity: 'high',
              evidence: 'shell command attempted to modify .agent/project/harness/** directly',
            });
            return '[Blocked by Project Harness] Shell commands must not modify .agent/project/harness artifacts directly.';
          }
        }

        return baseEvents?.beforeToolExecute
          ? await baseEvents.beforeToolExecute(tool, input)
          : true;
      },
    };

    return {
      ...options,
      events: wrappedEvents,
    };
  }

  describeVerificationContract(): KodaXTaskVerificationContract {
    const requiredEvidence = [
      'Return a valid <project-harness>{...}</project-harness> completion block.',
      'Provide concrete changedFiles and evidence items for the completed work.',
    ];
    if (this.config.completionRules.requireProgressUpdate) {
      requiredEvidence.push('Update PROGRESS.md with fresh execution evidence.');
    }
    if (this.config.invariants?.requireTestEvidenceOnComplete) {
      requiredEvidence.push('Report the exact tests, checks, or browser validation that were executed.');
    }
    if (this.config.invariants?.requireDocUpdateOnArchitectureChange) {
      requiredEvidence.push('Include doc or ADR evidence when the change affects architecture or boundaries.');
    }

    const requiredChecks = this.config.checks
      .filter(check => check.required)
      .map(check => `${check.id}: ${check.command}`);
    const criteria: KodaXTaskVerificationCriterion[] = this.config.checks
      .filter(check => check.required)
      .map((check, index) => ({
        id: check.id,
        label: check.id,
        description: `Required project harness check: ${check.command}`,
        threshold: 75,
        weight: index === 0 ? 0.4 : 0.2,
        requiredEvidence: [
          `Report execution evidence for check ${check.id}.`,
        ],
      }));
    const runtime: KodaXRuntimeVerificationContract = {
      cwd: getProjectRoot(this.storage),
      uiFlows: buildVerificationCapabilityHints(this.feature, this.config)
        .some((hint) => /agent-browser|playwright/i.test(hint.name))
        ? [
          `Exercise the critical flow for feature #${this.featureIndex} and reject completion on visible or console failures.`,
        ]
        : undefined,
      apiChecks: requiredChecks.filter(check => /api|http|endpoint|curl/i.test(check)),
      dbChecks: requiredChecks.filter(check => /\bdb\b|database|sql/i.test(check)),
    };

    return {
      summary: `Project Harness verification for feature #${this.featureIndex} in ${this.mode} mode.`,
      instructions: [
        'The evaluator must independently verify the result instead of trusting generator claims.',
        'Reject completion if any required evidence or deterministic check is missing.',
        'Do not edit feature_list.json or .agent/project/harness/** directly during verification.',
      ],
      requiredEvidence,
      requiredChecks,
      rubricFamily: buildVerificationCapabilityHints(this.feature, this.config)
        .some((hint) => /agent-browser|playwright/i.test(hint.name))
        ? 'frontend'
        : 'functionality',
      criteria,
      runtime,
      capabilityHints: buildVerificationCapabilityHints(this.feature, this.config),
    };
  }

  async verify(messages: KodaXMessage[]): Promise<ProjectHarnessVerificationResult> {
    const completionReport = parseCompletionReport(messages);
    return evaluateHarnessRun({
      storage: this.storage,
      featureIndex: this.featureIndex,
      mode: this.mode,
      attempt: this.attempt,
      config: this.config,
      completionReport,
      touchedFiles: Array.from(this.touchedFiles),
      violations: [...this.violations],
      qualityBefore: this.before.qualityScore,
      progressBeforeText: this.before.progressText,
      requireFreshProgressDelta: true,
      persist: true,
    });
  }
}

export async function createProjectHarnessAttempt(
  storage: ProjectStorage,
  feature: ProjectFeature,
  featureIndex: number,
  mode: 'next' | 'auto' | 'verify',
  attempt: number,
): Promise<ProjectHarnessAttempt> {
  const config = await loadOrCreateProjectHarnessConfig(storage);
  const before: HarnessAttemptSnapshot = {
    progressText: await storage.readProgress(),
    qualityScore: await calculateQualityScore(storage),
  };

  return new ProjectHarnessAttempt(storage, feature, featureIndex, mode, config, before, attempt);
}

export async function readLatestHarnessRun(
  storage: ProjectStorage,
): Promise<ProjectHarnessRunRecord | null> {
  const runs = await storage.readHarnessRuns<ProjectHarnessRunRecord>();
  return runs.length > 0 ? runs[runs.length - 1] ?? null : null;
}

export async function readLatestHarnessCheckpoint(
  storage: ProjectStorage,
  featureIndex?: number,
): Promise<ProjectHarnessCheckpointRecord | null> {
  const checkpoints = await storage.readLineageCheckpoints<ProjectHarnessCheckpointRecord>();
  const filtered = featureIndex === undefined
    ? checkpoints
    : checkpoints.filter(checkpoint => checkpoint.featureIndex === featureIndex);
  return filtered.length > 0 ? filtered[filtered.length - 1] ?? null : null;
}

export function formatProjectHarnessCheckpointSummary(
  checkpoint: ProjectHarnessCheckpointRecord,
): string {
  const lines = [
    '## Project Harness Safe Checkpoint',
    `- Checkpoint: ${checkpoint.checkpointId}`,
    `- Feature: #${checkpoint.featureIndex}`,
    `- Decision: ${checkpoint.decision}`,
    `- Git HEAD: ${checkpoint.gitHead ?? 'unknown'}`,
  ];

  if (checkpoint.changedFiles.length > 0) {
    lines.push(`- Changed files: ${checkpoint.changedFiles.join(', ')}`);
  }

  if (checkpoint.gitStatus.length > 0) {
    lines.push(`- Git status: ${checkpoint.gitStatus.join(' | ')}`);
  }

  return lines.join('\n');
}

export async function recordHarnessCalibrationCase(
  storage: ProjectStorage,
  run: ProjectHarnessRunRecord,
  options: {
    label: ProjectHarnessCalibrationLabel;
    summary?: string;
  },
): Promise<ProjectHarnessCalibrationCaseRecord> {
  const caseId = buildCalibrationCaseId(run.runId, options.label);
  const existingCases = await storage.readHarnessCalibrationCases<ProjectHarnessCalibrationCaseRecord>();
  const existing = existingCases.find(item => item.caseId === caseId);
  if (existing) {
    return existing;
  }

  const checkpoints = await storage.readLineageCheckpoints<ProjectHarnessCheckpointRecord>();
  const checkpoint = [...checkpoints].reverse().find(item => item.runId === run.runId) ?? null;
  const createdAt = new Date().toISOString();
  const record: ProjectHarnessCalibrationCaseRecord = {
    id: caseId,
    caseId,
    runId: run.runId,
    featureIndex: run.featureIndex,
    label: options.label,
    observedDecision: run.decision,
    expectedDecision: getCalibrationExpectedDecision(options.label),
    checkpointId: checkpoint?.checkpointId ?? null,
    failureCodes: [...(run.failureCodes ?? [])],
    summary: formatCalibrationSummary(run, options.label, options.summary),
    createdAt,
  };

  await storage.appendHarnessCalibrationCase(record);
  return record;
}

export async function reverifyProjectHarnessRun(
  storage: ProjectStorage,
  run: ProjectHarnessRunRecord,
): Promise<ProjectHarnessVerificationResult> {
  const config = await resolveProjectHarnessConfig(storage, { persist: false });
  return evaluateHarnessRun({
    storage,
    featureIndex: run.featureIndex,
    mode: 'verify',
    attempt: run.attempt,
    config,
    completionReport: run.completionReport,
    touchedFiles: run.changedFiles,
    violations: run.violations,
    qualityBefore: run.qualityBefore,
    requireFreshProgressDelta: false,
    persist: false,
  });
}

export async function replayHarnessCalibrationCase(
  storage: ProjectStorage,
  caseRecord: ProjectHarnessCalibrationCaseRecord,
): Promise<ProjectHarnessVerificationResult> {
  const runs = await storage.readHarnessRuns<ProjectHarnessRunRecord>();
  const run = runs.find(item => item.runId === caseRecord.runId);
  if (!run) {
    throw new Error(`Harness calibration case ${caseRecord.caseId} points to missing run ${caseRecord.runId}.`);
  }

  return reverifyProjectHarnessRun(storage, run);
}

export async function recordManualHarnessOverride(
  storage: ProjectStorage,
  featureIndex: number,
  status: 'done' | 'skip',
): Promise<void> {
  const now = new Date().toISOString();
  await storage.writeHarnessEvidence(featureIndex, {
    featureIndex,
    status: 'manual_override',
    changedFiles: [],
    progressUpdated: false,
    checksPassed: false,
    qualityDelta: 0,
    completionSource: 'manual_override',
    updatedAt: now,
    overrideStatus: status,
  });

  const runs = await storage.readHarnessRuns<ProjectHarnessRunRecord>();
  const latestRun = [...runs].reverse().find(run => run.featureIndex === featureIndex) ?? null;
  if (!latestRun) {
    return;
  }

  if (status === 'done' && latestRun.decision !== 'verified_complete') {
    await recordHarnessCalibrationCase(storage, latestRun, {
      label: 'false_fail',
      summary: `Manual override marked feature #${featureIndex} as done after harness returned ${latestRun.decision}.`,
    });
  }

  if (status === 'skip' && latestRun.decision === 'verified_complete') {
    await recordHarnessCalibrationCase(storage, latestRun, {
      label: 'false_pass',
      summary: `Manual override rejected a previously verified completion for feature #${featureIndex}.`,
    });
  }
}

export function formatProjectHarnessSummary(run: ProjectHarnessRunRecord): string {
  const evidenceCompleteness =
    run.completionReport?.status === 'complete'
      ? run.changedFiles.length > 0 && run.evidence.length > 0
        ? 'complete'
        : 'partial'
      : run.completionReport
        ? 'reported'
        : 'missing';

  const lines = [
    '## Project Harness Verification',
    `- Decision: ${run.decision}`,
    `- Feature: #${run.featureIndex}`,
    `- Attempt: ${run.attempt}`,
    `- Quality: ${run.qualityBefore} -> ${run.qualityAfter}`,
    `- Evidence completeness: ${evidenceCompleteness}`,
  ];

  if (run.scorecard) {
    lines.push(
      `- Score: ${run.scorecard.overall} (legality ${run.scorecard.legality}, checks ${run.scorecard.checks}, relevance ${run.scorecard.featureRelevance}, evidence ${run.scorecard.evidenceCompleteness}, quality ${run.scorecard.qualityDelta}, stall ${run.scorecard.stallResistance}, cost ${run.scorecard.costEfficiency})`,
    );
  }

  if (run.changedFiles.length > 0) {
    lines.push(`- Changed files: ${run.changedFiles.join(', ')}`);
  }

  if ((run.failureCodes?.length ?? 0) > 0) {
    lines.push(`- Failure codes: ${run.failureCodes!.join(', ')}`);
  }

  if (run.completionReport?.summary) {
    lines.push(`- Completion summary: ${run.completionReport.summary}`);
  }

  if (run.checks.length > 0) {
    const checkSummary = run.checks
      .map(check => `${check.id}:${check.passed ? 'pass' : 'fail'}`)
      .join(', ');
    lines.push(`- Checks: ${checkSummary}`);
  }

  if ((run.completionReport?.tests?.length ?? 0) > 0) {
    lines.push(`- Reported tests: ${run.completionReport!.tests!.join(', ')}`);
  }

  if (run.evidence.length > 0) {
    lines.push(`- Evidence: ${run.evidence.join(' | ')}`);
  }

  if (run.violations.length > 0) {
    lines.push(`- Violations: ${run.violations.map(violation => violation.evidence).join(' | ')}`);
  }

  if (run.decision !== 'verified_complete') {
    const followUp = [
      ...run.violations.map(violation => `${violation.rule}: ${violation.evidence}`),
      ...run.repairHints,
    ];
    if (followUp.length > 0) {
      lines.push(`- Follow-up: ${followUp.join(' | ')}`);
    }
  }

  if (run.repairHints.length > 0) {
    lines.push(`- Repair hints: ${run.repairHints.join(' | ')}`);
  }

  return lines.join('\n');
}

async function evaluateHarnessRun(
  options: EvaluateHarnessRunOptions,
): Promise<ProjectHarnessVerificationResult> {
  const projectRoot = getProjectRoot(options.storage);
  const progressAfter = await options.storage.readProgress();
  const sessionPlanText = await options.storage.readSessionPlan();
  const feature = await options.storage.getFeatureByIndex(options.featureIndex);
  const progressUpdated = options.requireFreshProgressDelta
    ? normalizeText(progressAfter) !== normalizeText(options.progressBeforeText ?? '')
    : normalizeText(progressAfter).length > 0;
  const qualityAfter = await calculateQualityScore(options.storage);
  const checks = await runHarnessChecks(getProjectRoot(options.storage), options.config.checks);
  const requiredCheckFailures = checks.filter(check => check.required && !check.passed);

  const changedFiles = Array.from(
    new Set([
      ...options.touchedFiles.map(file => normalizePath(file)),
      ...(options.completionReport?.changedFiles ?? [])
        .map(file => resolveProjectPath(projectRoot, file)),
    ]),
  );

  const reasons: string[] = [];
  const repairHints: string[] = [];
  const evidence: string[] = [];
  const failureCodes: string[] = [];
  const relativeChangedFiles = changedFiles
    .map(file => toWorkspaceRelativePath(projectRoot, file))
    .map(file => file.replace(/^\.\//, ''));
  const hasDocChange = relativeChangedFiles.some(file => /^docs\/.+\.md$/i.test(file));
  const completionNarrative = [
    options.completionReport?.summary ?? '',
    ...(options.completionReport?.evidence ?? []),
  ].join(' ');
  const completionHaystack = [
    completionNarrative,
    ...(options.completionReport?.tests ?? []),
    progressAfter,
    ...relativeChangedFiles,
  ].join(' ').toLowerCase();
  const featureKeywords = extractKeywords([
    feature?.name ?? '',
    feature?.description ?? '',
    ...(feature?.steps ?? []),
  ].join(' '));
  const relevanceHaystack = [
    ...relativeChangedFiles,
    completionNarrative.toLowerCase(),
  ].join(' ').toLowerCase();
  const matchedFeatureKeywords = featureKeywords.filter(keyword => relevanceHaystack.includes(keyword));
  const historicalRuns = await options.storage.readHarnessRuns<ProjectHarnessRunRecord>();
  const recentFeatureFailures = historicalRuns
    .filter(run => run.featureIndex === options.featureIndex && run.mode !== 'verify' && run.decision !== 'verified_complete')
    .slice(-2);
  const packageBoundaryViolations = await findPackageBoundaryViolations(
    projectRoot,
    changedFiles,
    options.config.invariants,
    options.config.exceptions,
  );
  const featureLabel = [feature?.name ?? '', feature?.description ?? ''].join(' ').trim();
  const skipChecklistCoverage = matchesConfiguredPattern(
    featureLabel,
    options.config.exceptions?.skipChecklistFeaturePatterns ?? [],
  );
  const featureChecklist = (feature?.steps ?? []).map(normalizeChecklistItem).filter(Boolean);
  const featureChecklistCoverage = evaluateChecklistCoverage(featureChecklist, completionHaystack);
  const sessionPlanChecklist = parseSessionPlanChecklist(sessionPlanText);
  const sessionPlanRelevant =
    featureKeywords.length === 0
      ? sessionPlanChecklist.length > 0
      : featureKeywords.some(keyword => sessionPlanText.toLowerCase().includes(keyword));
  const sessionPlanCoverage = evaluateChecklistCoverage(
    sessionPlanRelevant ? sessionPlanChecklist : [],
    completionHaystack,
  );

  if (options.completionReport?.summary) {
    evidence.push(options.completionReport.summary);
  }
  if (options.completionReport?.evidence?.length) {
    evidence.push(...options.completionReport.evidence);
  }
  if (progressUpdated) {
    evidence.push('PROGRESS.md contains verification evidence.');
  }
  if (checks.length > 0) {
    evidence.push(`Executed ${checks.length} project check(s).`);
  }
  if (featureChecklistCoverage.matched.length > 0) {
    evidence.push(`Matched feature checklist items: ${featureChecklistCoverage.matched.join(' | ')}`);
  }
  if (sessionPlanCoverage.matched.length > 0) {
    evidence.push(`Matched session-plan checklist items: ${sessionPlanCoverage.matched.join(' | ')}`);
  }

  let decision: ProjectHarnessVerificationResult['decision'] = 'verified_complete';

  if (options.violations.length > 0) {
    for (const violation of options.violations) {
      addFailure(
        failureCodes,
        reasons,
        repairHints,
        violation.rule === 'protected-artifact' ? 'protected_artifact_write' : violation.rule,
        `${violation.rule}: ${violation.evidence}`,
        'Stop editing protected artifacts directly; let the command layer own completion and harness files.',
      );
    }
    decision = 'retryable_failure';
  }

  if (options.config.completionRules.requireCompletionReport && !options.completionReport) {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      'missing_completion_report',
      'Missing <project-harness> completion report in the final assistant response.',
      'End the attempt with a valid <project-harness>{...}</project-harness> JSON report.',
    );
    decision = 'retryable_failure';
  }

  if (options.completionReport?.status === 'blocked') {
    reasons.push(...(options.completionReport.blockers?.length
      ? options.completionReport.blockers
      : ['The implementation attempt reported a blocked state.']));
    if (!failureCodes.includes('reported_blocked')) {
      failureCodes.push('reported_blocked');
    }
    decision = 'blocked';
  } else if (options.completionReport?.status === 'needs_review') {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      'reported_needs_review',
      options.completionReport.summary || 'The implementation requested human review.',
    );
    decision = 'needs_review';
  }

  if (options.completionReport?.status === 'complete' && changedFiles.length === 0) {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      'missing_changed_files',
      'Completion report did not include any changed files.',
      'List the files you changed in changedFiles before asking the command layer to complete the feature.',
    );
    decision = decision === 'verified_complete' ? 'retryable_failure' : decision;
  }

  if (
    options.completionReport?.status === 'complete' &&
    !progressUpdated &&
    (options.completionReport.evidence?.length ?? 0) === 0
  ) {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      'missing_implementation_evidence',
      'Completion report does not carry concrete implementation evidence.',
      'Include at least one concrete proof item in evidence or update PROGRESS.md with the attempt summary.',
    );
    decision = decision === 'verified_complete' ? 'retryable_failure' : decision;
  }

  if (
    options.config.completionRules.requireProgressUpdate &&
    options.completionReport?.status === 'complete' &&
    !progressUpdated
  ) {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      'missing_progress_update',
      'PROGRESS.md does not currently contain verification evidence.',
      'Append an attempt summary to PROGRESS.md before finishing.',
    );
    decision = decision === 'verified_complete' ? 'retryable_failure' : decision;
  }

  if (
    options.config.completionRules.requireChecksPass &&
    options.completionReport?.status === 'complete' &&
    requiredCheckFailures.length > 0
  ) {
    for (const check of requiredCheckFailures) {
      addFailure(
        failureCodes,
        reasons,
        repairHints,
        `required_check_failed:${check.id}`,
        `Required check failed: ${check.id}`,
        'Fix the failing required checks before asking the command layer to complete the feature.',
      );
    }
    decision = 'retryable_failure';
  }

  if (
    options.config.invariants?.requireTestEvidenceOnComplete &&
    options.completionReport?.status === 'complete' &&
    (options.completionReport.tests?.length ?? 0) === 0
  ) {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      'missing_test_evidence',
      'Project rules require explicit test evidence before a feature can be marked complete.',
      'Report the tests or checks you added or ran in the completion report before finishing.',
    );
    decision = decision === 'verified_complete' ? 'retryable_failure' : decision;
  }

  if (
    options.config.invariants?.requireDocUpdateOnArchitectureChange &&
    options.completionReport?.status === 'complete' &&
    ARCHITECTURE_CHANGE_CLAIM_PATTERN.test(completionNarrative) &&
    !hasDocChange
  ) {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      'missing_doc_evidence',
      'Project rules require docs or ADR evidence when the attempt reports architecture or boundary changes.',
      'Update the relevant docs/ADR artifact or clarify that no architecture-level change was made.',
    );
    decision = decision === 'verified_complete' ? 'retryable_failure' : decision;
  }

  if (
    options.config.invariants?.requireFeatureChecklistCoverageOnComplete &&
    options.completionReport?.status === 'complete' &&
    featureChecklist.length > 0 &&
    !skipChecklistCoverage
  ) {
    const minimumMatches = Math.max(
      1,
      Math.ceil(featureChecklist.length * options.config.invariants.checklistCoverageMinimum),
    );
    if (featureChecklistCoverage.matched.length < minimumMatches) {
      addFailure(
        failureCodes,
        reasons,
        repairHints,
        'missing_feature_checklist_coverage',
        `Completion evidence only matched ${featureChecklistCoverage.matched.length}/${featureChecklist.length} planned feature step(s).`,
        `Cover more planned steps explicitly before completion. Missing items: ${featureChecklistCoverage.missing.slice(0, 3).join(' | ')}`,
      );
      decision = decision === 'verified_complete' ? 'retryable_failure' : decision;
    }
  }

  if (
    options.config.invariants?.requireSessionPlanChecklistCoverage &&
    options.completionReport?.status === 'complete' &&
    featureChecklist.length === 0 &&
    !skipChecklistCoverage &&
    sessionPlanRelevant &&
    sessionPlanChecklist.length > 0 &&
    sessionPlanCoverage.matched.length === 0
  ) {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      'missing_plan_checklist_coverage',
      'Completion evidence does not cover the current session plan checkpoints.',
      `Reference the current session plan tasks in the completion evidence. Missing items: ${sessionPlanCoverage.missing.slice(0, 3).join(' | ')}`,
    );
    decision = decision === 'verified_complete' ? 'retryable_failure' : decision;
  }

  for (const violation of packageBoundaryViolations) {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      violation.code,
      violation.message,
      'Keep package imports within declared layer boundaries and avoid cross-package relative imports.',
    );
    decision = decision === 'verified_complete' ? 'retryable_failure' : decision;
  }

  if (
    options.completionReport?.status === 'complete' &&
    featureKeywords.length > 0 &&
    matchedFeatureKeywords.length === 0 &&
    changedFiles.length >= 5 &&
    options.config.advisoryRules.warnOnLargeUnrelatedDiff
  ) {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      'unrelated_diff',
      'Changed files do not appear related to the active feature, so the attempt does not count as reliable feature progress.',
      'Reduce the diff to files relevant to the active feature or explain the linkage clearly in the completion report.',
    );
    decision = decision === 'verified_complete' ? 'retryable_failure' : decision;
  }

  if (
    decision !== 'verified_complete' &&
    options.config.advisoryRules.warnOnRepeatedFailure &&
    recentFeatureFailures.length >= 2
  ) {
    addFailure(
      failureCodes,
      reasons,
      repairHints,
      'stall_repeated_failure',
      'Repeated verification failures were detected across recent attempts for this feature.',
      'Pause and review the current implementation strategy before retrying again.',
    );
    decision = decision === 'retryable_failure' ? 'needs_review' : decision;
  }

  if (options.completionReport?.status === 'complete' && decision === 'verified_complete') {
    reasons.push('Completion report present, progress evidence recorded, and required checks passed.');
  }

  const scorecard = buildScorecard({
    decision,
    violations: options.violations,
    checks,
    featureKeywords,
    matchedFeatureKeywords,
    progressUpdated,
    completionReport: options.completionReport,
    changedFiles,
    qualityDelta: qualityAfter - options.qualityBefore,
    recentFeatureFailures: recentFeatureFailures.length,
    attempt: options.attempt,
  });
  const repairPlaybooks = resolveRepairPlaybooks(failureCodes, options.config);
  const playbookActions = resolveRepairActions(repairPlaybooks, options.config);
  const createdAt = new Date().toISOString();

  const runRecord: ProjectHarnessRunRecord = {
    runId: buildRunId(options.featureIndex, options.attempt),
    featureIndex: options.featureIndex,
    mode: options.mode,
    attempt: options.attempt,
    decision,
    failureCodes,
    scorecard,
    changedFiles,
    checks,
    qualityBefore: options.qualityBefore,
    qualityAfter,
    violations: [...options.violations],
    repairHints,
    evidence,
    completionReport: options.completionReport,
    createdAt,
  };

  const evidenceRecord: ProjectHarnessEvidenceRecord = {
    featureIndex: options.featureIndex,
    status: decision,
    changedFiles,
    progressUpdated,
    checksPassed: requiredCheckFailures.length === 0,
    qualityDelta: qualityAfter - options.qualityBefore,
    completionSource: decision === 'verified_complete' ? 'auto_verified' : 'verification_failed',
    evidenceItems: options.completionReport?.evidence ?? [],
    reportedTests: options.completionReport?.tests ?? [],
    completionSummary: options.completionReport?.summary,
    updatedAt: createdAt,
  };

  if (options.persist) {
    const gitSnapshot = await getGitSnapshot(projectRoot);
    const historicalNodes = await options.storage.readLineageSessionNodes<ProjectHarnessSessionNodeRecord>();
    const parentNode = [...historicalNodes]
      .reverse()
      .find(node => node.featureIndex === options.featureIndex)
      ?? historicalNodes[historicalNodes.length - 1]
      ?? null;
    const checkpointRecord: ProjectHarnessCheckpointRecord = {
      id: buildCheckpointId(runRecord.runId),
      checkpointId: buildCheckpointId(runRecord.runId),
      runId: runRecord.runId,
      featureIndex: runRecord.featureIndex,
      taskId: `feature-${runRecord.featureIndex}`,
      decision,
      gitHead: gitSnapshot.gitHead,
      gitStatus: gitSnapshot.gitStatus,
      changedFiles,
      qualityAfter,
      createdAt,
    };
    const sessionNodeRecord: ProjectHarnessSessionNodeRecord = {
      id: buildSessionNodeId(runRecord.runId),
      nodeId: buildSessionNodeId(runRecord.runId),
      taskId: `feature-${runRecord.featureIndex}`,
      runId: runRecord.runId,
      parentId: parentNode?.nodeId ?? null,
      parentNodeId: parentNode?.nodeId ?? null,
      parentRunId: parentNode?.runId ?? null,
      featureIndex: runRecord.featureIndex,
      decision,
      checkpointId: checkpointRecord.checkpointId,
      scorecard,
      summary: options.completionReport?.summary,
      createdAt,
    };
    await options.storage.appendHarnessRun(runRecord);
    await options.storage.appendLineageCheckpoint(checkpointRecord);
    await options.storage.appendLineageSessionNode(sessionNodeRecord);
    if (decision !== 'verified_complete') {
      const criticRecord: ProjectHarnessCriticRecord = {
        runId: runRecord.runId,
        featureIndex: runRecord.featureIndex,
        decision,
        failureCodes,
        scorecard,
        repairPlaybooks,
        summary: reasons[0] ?? 'Project harness rejected the attempt.',
        repairHints: [...repairHints, ...playbookActions],
        createdAt,
      };
      await options.storage.appendHarnessCritic(criticRecord);
    }
    await options.storage.writeHarnessEvidence(options.featureIndex, evidenceRecord);
  }

  return {
    decision,
    reasons,
    repairPrompt: repairHints.length > 0 || reasons.length > 0
      ? [
          'The previous attempt did not satisfy the project harness.',
          ...(failureCodes.length > 0 ? [`Failure codes: ${failureCodes.join(', ')}`] : []),
          ...(repairPlaybooks.length > 0 ? [`Repair playbooks: ${repairPlaybooks.join(', ')}`] : []),
          ...reasons.map(reason => `- ${reason}`),
          ...repairHints.map(hint => `- ${hint}`),
          ...playbookActions.map(action => `- ${action}`),
          'Retry the same feature with the verifier feedback above and end with a valid <project-harness> JSON report.',
        ].join('\n')
      : undefined,
    runRecord,
    evidenceRecord,
  };
}
