import fsSync from 'fs';
import path from 'path';
import type {
  KodaXBaseProvider,
  KodaXProviderCapabilityProfile,
  KodaXReasoningCapability,
} from '@kodax/ai';
import { normalizeCapabilityProfile } from '@kodax/ai';
import { KODAX_FEATURES_FILE } from './constants.js';
import {
  isCustomProviderName,
  isProviderName,
  isRuntimeModelProviderName,
} from './providers/index.js';
import { resolveExecutionCwd } from './runtime-paths.js';
import type {
  KodaXContextOptions,
  KodaXExecutionMode,
  KodaXOptions,
  KodaXProviderPolicyHints,
  KodaXReasoningMode,
  KodaXTaskType,
} from './types.js';

export type KodaXProviderSourceKind = 'builtin' | 'runtime' | 'custom' | 'unknown';

export interface KodaXProviderCapabilitySnapshot {
  provider: string;
  model?: string;
  sourceKind: KodaXProviderSourceKind;
  transport: KodaXProviderCapabilityProfile['transport'];
  conversationSemantics: KodaXProviderCapabilityProfile['conversationSemantics'];
  mcpSupport: KodaXProviderCapabilityProfile['mcpSupport'];
  contextFidelity: NonNullable<KodaXProviderCapabilityProfile['contextFidelity']>;
  toolCallingFidelity: NonNullable<KodaXProviderCapabilityProfile['toolCallingFidelity']>;
  sessionSupport: NonNullable<KodaXProviderCapabilityProfile['sessionSupport']>;
  longRunningSupport: NonNullable<KodaXProviderCapabilityProfile['longRunningSupport']>;
  multimodalSupport: NonNullable<KodaXProviderCapabilityProfile['multimodalSupport']>;
  evidenceSupport: NonNullable<KodaXProviderCapabilityProfile['evidenceSupport']>;
  reasoningCapability: KodaXReasoningCapability;
}

export type KodaXProviderPolicyIssueSeverity = 'warn' | 'block';

export interface KodaXProviderPolicyIssue {
  code: string;
  severity: KodaXProviderPolicyIssueSeverity;
  summary: string;
  detail: string;
}

export interface KodaXProviderPolicyDecision {
  status: 'allow' | 'warn' | 'block';
  snapshot: KodaXProviderCapabilitySnapshot;
  issues: KodaXProviderPolicyIssue[];
  routingNotes: string[];
  summary: string;
}

interface EvaluateProviderPolicyOptions {
  providerName: string;
  model?: string;
  provider?: KodaXBaseProvider;
  capabilityProfile?: KodaXProviderCapabilityProfile;
  reasoningCapability?: KodaXReasoningCapability;
  prompt?: string;
  options?: Pick<KodaXOptions, 'context'>;
  context?: KodaXContextOptions;
  hints?: KodaXProviderPolicyHints;
  reasoningMode?: KodaXReasoningMode;
  taskType?: KodaXTaskType;
  executionMode?: KodaXExecutionMode;
}

function detectProviderSourceKind(providerName: string): KodaXProviderSourceKind {
  if (isProviderName(providerName)) {
    return 'builtin';
  }
  if (isRuntimeModelProviderName(providerName)) {
    return 'runtime';
  }
  if (isCustomProviderName(providerName)) {
    return 'custom';
  }
  return 'unknown';
}

function resolveCapabilityProfile(
  provider: KodaXBaseProvider | undefined,
  fallback: KodaXProviderCapabilityProfile | undefined,
): KodaXProviderCapabilityProfile {
  if (provider) {
    return provider.getCapabilityProfile();
  }
  return (
    fallback ?? {
      transport: 'native-api',
      conversationSemantics: 'full-history',
      mcpSupport: 'none',
    }
  );
}

function resolveReasoningCapability(
  provider: KodaXBaseProvider | undefined,
  model: string | undefined,
  fallback: KodaXReasoningCapability | undefined,
): KodaXReasoningCapability {
  if (provider) {
    return provider.getReasoningCapability(model);
  }
  return fallback ?? 'unknown';
}

export function buildProviderCapabilitySnapshot(
  options: {
    providerName: string;
    model?: string;
    provider?: KodaXBaseProvider;
    capabilityProfile?: KodaXProviderCapabilityProfile;
    reasoningCapability?: KodaXReasoningCapability;
  },
): KodaXProviderCapabilitySnapshot {
  const profile = normalizeCapabilityProfile(
    resolveCapabilityProfile(options.provider, options.capabilityProfile),
  );

  return {
    provider: options.providerName,
    model: options.model,
    sourceKind: detectProviderSourceKind(options.providerName),
    transport: profile.transport,
    conversationSemantics: profile.conversationSemantics,
    mcpSupport: profile.mcpSupport,
    contextFidelity: profile.contextFidelity,
    toolCallingFidelity: profile.toolCallingFidelity,
    sessionSupport: profile.sessionSupport,
    longRunningSupport: profile.longRunningSupport,
    multimodalSupport: profile.multimodalSupport,
    evidenceSupport: profile.evidenceSupport,
    reasoningCapability: resolveReasoningCapability(
      options.provider,
      options.model,
      options.reasoningCapability,
    ),
  };
}

function detectLongRunningProjectContext(context?: KodaXContextOptions): boolean {
  if (!context) {
    return false;
  }

  const candidates = [
    resolveExecutionCwd(context),
    context.gitRoot ? path.resolve(context.gitRoot) : null,
  ].filter((entry): entry is string => typeof entry === 'string');

  return candidates.some((dir) =>
    fsSync.existsSync(path.resolve(dir, KODAX_FEATURES_FILE)),
  );
}

function inferPromptPolicyHints(prompt?: string): KodaXProviderPolicyHints {
  if (!prompt) {
    return {};
  }

  const normalized = prompt.toLowerCase();
  const usesProjectHarness = normalized.includes('<project-harness>');
  const evidenceHeavy =
    usesProjectHarness ||
    /merge blocker|review|strict audit|runtime error|stack trace|stderr|failing test|evidence/.test(
      normalized,
    );

  // Hard-gate semantics should come from structured signals rather than
  // free-form user keywords. Mentions such as "project mode", "MCP", or
  // "screenshot support" must not block by themselves, so prompt inference
  // is limited to protocol markers and warn-level evidence cues.
  return {
    longRunning: usesProjectHarness ? true : undefined,
    harness: usesProjectHarness ? 'project' : undefined,
    evidenceHeavy: evidenceHeavy ? true : undefined,
  };
}

function pickBoolean(...values: Array<boolean | undefined>): boolean | undefined {
  return values.find((value) => value !== undefined);
}

function resolveProviderPolicyHints(
  options: Pick<EvaluateProviderPolicyOptions, 'context' | 'options' | 'prompt' | 'hints'>,
): KodaXProviderPolicyHints {
  const context = options.context ?? options.options?.context;
  const promptHints = inferPromptPolicyHints(options.prompt);
  const autoLongRunning = detectLongRunningProjectContext(context);

  return {
    longRunning: pickBoolean(
      options.hints?.longRunning,
      context?.providerPolicyHints?.longRunning,
      promptHints.longRunning,
      autoLongRunning,
    ),
    harness:
      options.hints?.harness
      ?? context?.providerPolicyHints?.harness
      ?? promptHints.harness,
    harnessProfile:
      options.hints?.harnessProfile
      ?? context?.providerPolicyHints?.harnessProfile,
    evidenceHeavy: pickBoolean(
      options.hints?.evidenceHeavy,
      context?.providerPolicyHints?.evidenceHeavy,
      promptHints.evidenceHeavy,
    ),
    multimodal: pickBoolean(
      options.hints?.multimodal,
      context?.providerPolicyHints?.multimodal,
      promptHints.multimodal,
    ),
    capabilityRuntime: pickBoolean(
      options.hints?.capabilityRuntime,
      context?.providerPolicyHints?.capabilityRuntime,
      promptHints.capabilityRuntime,
    ),
    mcpRequired: pickBoolean(
      options.hints?.mcpRequired,
      context?.providerPolicyHints?.mcpRequired,
      promptHints.mcpRequired,
    ),
    brainstorm: pickBoolean(
      options.hints?.brainstorm,
      context?.providerPolicyHints?.brainstorm,
      promptHints.brainstorm,
    ),
    workIntent:
      options.hints?.workIntent
      ?? context?.providerPolicyHints?.workIntent
      ?? promptHints.workIntent,
  };
}

function pushIssue(
  issues: KodaXProviderPolicyIssue[],
  issue: KodaXProviderPolicyIssue,
): void {
  if (issues.some((existing) => existing.code === issue.code)) {
    return;
  }
  issues.push(issue);
}

function buildRoutingNotes(
  snapshot: KodaXProviderCapabilitySnapshot,
  issues: KodaXProviderPolicyIssue[],
): string[] {
  const notes = new Set<string>();

  if (snapshot.transport === 'cli-bridge') {
    notes.add(
      'Provider uses a CLI bridge rather than a native API, so semantic parity should not be assumed.',
    );
  }

  if (snapshot.conversationSemantics === 'last-user-message') {
    notes.add(
      'Provider forwards only the latest user message instead of preserving full-history semantics.',
    );
  }

  for (const issue of issues) {
    notes.add(issue.detail);
  }

  return Array.from(notes);
}

function summarizeIssues(issues: KodaXProviderPolicyIssue[]): string {
  if (issues.length === 0) {
    return 'No provider-policy constraints detected.';
  }

  return issues
    .map((issue) => `${issue.severity.toUpperCase()}: ${issue.summary}`)
    .join(' | ');
}

export function buildProviderPolicyPromptNotes(
  decision: KodaXProviderPolicyDecision,
): string[] {
  const header = [
    `[Provider Policy] provider=${decision.snapshot.provider}${decision.snapshot.model ? ` model=${decision.snapshot.model}` : ''}; status=${decision.status}.`,
    `[Provider Semantics] transport=${decision.snapshot.transport}; context=${decision.snapshot.contextFidelity}; toolCalling=${decision.snapshot.toolCallingFidelity}; session=${decision.snapshot.sessionSupport}; longRunning=${decision.snapshot.longRunningSupport}; multimodal=${decision.snapshot.multimodalSupport}; evidence=${decision.snapshot.evidenceSupport}; mcp=${decision.snapshot.mcpSupport}; reasoning=${decision.snapshot.reasoningCapability}.`,
  ];

  return [
    ...header,
    ...decision.issues.map(
      (issue) =>
        `[Provider Constraint] ${issue.severity.toUpperCase()}: ${issue.detail}`,
    ),
  ];
}

export function evaluateProviderPolicy(
  options: EvaluateProviderPolicyOptions,
): KodaXProviderPolicyDecision {
  const snapshot = buildProviderCapabilitySnapshot({
    providerName: options.providerName,
    model: options.model,
    provider: options.provider,
    capabilityProfile: options.capabilityProfile,
    reasoningCapability: options.reasoningCapability,
  });
  const hints = resolveProviderPolicyHints(options);
  const issues: KodaXProviderPolicyIssue[] = [];

  if (hints.multimodal && snapshot.multimodalSupport === 'none') {
    pushIssue(issues, {
      code: 'multimodal-unsupported',
      severity: 'block',
      summary: 'multimodal requests are unsupported on this provider',
      detail:
        'This flow requests multimodal or image semantics, but the selected provider only exposes text-only behavior.',
    });
  }

  if (hints.mcpRequired && snapshot.mcpSupport === 'none') {
    pushIssue(issues, {
      code: 'mcp-required',
      severity: 'block',
      summary: 'native MCP semantics are unavailable on this provider',
      detail:
        'This flow explicitly requires MCP-native behavior, but the selected provider reports no native MCP support.',
    });
  } else if (hints.capabilityRuntime && snapshot.mcpSupport === 'none') {
    pushIssue(issues, {
      code: 'capability-runtime-limited',
      severity: 'warn',
      summary: 'capability-oriented flows are constrained by provider semantics',
      detail:
        'Capability or MCP-oriented workflows may lose parity because the provider does not expose native MCP semantics.',
    });
  }

  if (hints.longRunning) {
    if (
      snapshot.longRunningSupport === 'none' ||
      snapshot.sessionSupport === 'stateless' ||
      snapshot.contextFidelity === 'lossy'
    ) {
      pushIssue(issues, {
        code: 'long-running-blocked',
        severity: 'block',
        summary: 'long-running execution is unsafe on this provider',
        detail:
          'Long-running flows require durable session semantics and reliable context fidelity, but this provider reports lossy or stateless behavior.',
      });
    } else if (
      snapshot.longRunningSupport === 'limited' ||
      snapshot.sessionSupport === 'limited'
    ) {
      pushIssue(issues, {
        code: 'long-running-limited',
        severity: 'warn',
        summary: 'long-running execution is degraded on this provider',
        detail:
          'Long-running flows may behave inconsistently because this provider only offers limited session or long-running support.',
      });
    }
  }

  if (hints.harness === 'project') {
    if (
      snapshot.contextFidelity === 'lossy' ||
      snapshot.sessionSupport === 'stateless' ||
      snapshot.toolCallingFidelity === 'none' ||
      snapshot.evidenceSupport === 'none'
    ) {
      pushIssue(issues, {
        code: 'project-harness-blocked',
        severity: 'block',
        summary: 'project harness verification is unsafe on this provider',
        detail:
          'Project harness flows require reliable multi-turn context, tool execution, and evidence handling, but this provider cannot guarantee those semantics.',
      });
    } else if (
      snapshot.toolCallingFidelity === 'limited' ||
      snapshot.evidenceSupport === 'limited'
    ) {
      pushIssue(issues, {
        code: 'project-harness-limited',
        severity: 'warn',
        summary: 'project harness verification is constrained on this provider',
        detail:
          'Project harness flows may lose evidence fidelity because this provider only offers limited tool-calling or evidence support.',
      });
    }
  }

  if (hints.harnessProfile === 'H2_PLAN_EXECUTE_EVAL') {
    if (
      snapshot.toolCallingFidelity === 'none' ||
      snapshot.evidenceSupport === 'none'
    ) {
      pushIssue(issues, {
        code: 'plan-execute-eval-limited',
        severity: 'warn',
        summary: 'plan-execute-eval routing is constrained on this provider',
        detail:
          'H2 routing remains available, but the provider cannot fully preserve execution or evidence semantics for the evaluation step.',
      });
    } else if (
      snapshot.transport === 'cli-bridge' ||
      snapshot.contextFidelity === 'lossy'
    ) {
      pushIssue(issues, {
        code: 'plan-execute-eval-bridge',
        severity: 'warn',
        summary: 'plan-execute-eval routing may lose fidelity on bridge providers',
        detail:
          'H2 routing should stay inspectable, but bridge-backed providers can lose context or semantic parity across the planning and evaluation phases.',
      });
    }
  }

  const needsReliableEvidence =
    hints.evidenceHeavy === true ||
    options.taskType === 'review' ||
    options.taskType === 'bugfix' ||
    options.executionMode === 'pr-review' ||
    options.executionMode === 'strict-audit' ||
    options.executionMode === 'investigation';

  if (needsReliableEvidence) {
    if (snapshot.contextFidelity === 'lossy') {
      pushIssue(issues, {
        code: 'evidence-context-loss',
        severity: 'warn',
        summary: 'evidence-heavy work is constrained by lossy context semantics',
        detail:
          'Evidence-heavy routing remains available, but this provider can lose prior-turn context and should not be treated as equivalent to full-history providers.',
      });
    }

    if (snapshot.evidenceSupport === 'limited') {
      pushIssue(issues, {
        code: 'evidence-support-limited',
        severity: 'warn',
        summary: 'evidence-heavy work may lose fidelity on this provider',
        detail:
          'This provider only reports limited evidence support, so review and investigation flows may need extra caution.',
      });
    }
  }

  if (
    options.reasoningMode !== 'off' &&
    (snapshot.reasoningCapability === 'prompt-only' ||
      snapshot.reasoningCapability === 'none')
  ) {
    pushIssue(issues, {
      code: 'reasoning-control-limited',
      severity: 'warn',
      summary: 'native reasoning control is unavailable on this provider',
      detail:
        'Reasoning remains usable, but the provider cannot enforce native reasoning controls beyond prompt-level guidance.',
    });
  }

  const status = issues.some((issue) => issue.severity === 'block')
    ? 'block'
    : issues.length > 0
      ? 'warn'
      : 'allow';

  return {
    status,
    snapshot,
    issues,
    routingNotes: buildRoutingNotes(snapshot, issues),
    summary: summarizeIssues(issues),
  };
}
