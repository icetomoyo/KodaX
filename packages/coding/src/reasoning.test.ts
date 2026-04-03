import { describe, expect, it, vi } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax/ai';
import { KodaXBaseProvider } from '@kodax/ai';
import {
  buildAmaControllerDecision,
  buildHeuristicAutoRerouteDecision,
  buildFallbackRoutingDecision,
  buildProviderPolicyHintsForDecision,
  createReasoningPlan,
  inferIntentGate,
  inferTaskType,
  maybeCreateAutoReroutePlan,
  type ReasoningPlan,
} from './reasoning.js';
import { evaluateProviderPolicy } from './provider-policy.js';

class ThrowingProvider extends KodaXBaseProvider {
  readonly name = 'test-provider';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
    reasoningCapability: 'prompt-only',
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    throw new Error('router unavailable');
  }
}

class CapturingProvider extends KodaXBaseProvider {
  readonly name = 'capturing-provider';
  readonly supportsThinking = false;
  lastMessages: KodaXMessage[] = [];
  lastSystem = '';

  constructor(private readonly responseText: string) {
    super();
  }

  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
    reasoningCapability: 'prompt-only',
  };

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    this.lastMessages = messages;
    this.lastSystem = system;

    return {
      textBlocks: [{ type: 'text', text: this.responseText }],
      toolBlocks: [],
      thinkingBlocks: [],
    };
  }
}

const CLI_BRIDGE_PROFILE = {
  transport: 'cli-bridge',
  conversationSemantics: 'last-user-message',
  mcpSupport: 'none',
  contextFidelity: 'lossy',
  toolCallingFidelity: 'limited',
  sessionSupport: 'stateless',
  longRunningSupport: 'limited',
  multimodalSupport: 'none',
  evidenceSupport: 'limited',
} as const;

describe('reasoning reroute', () => {
  const basePlan: ReasoningPlan = {
    mode: 'auto',
    depth: 'low',
    decision: {
      primaryTask: 'review',
      confidence: 0.9,
      riskLevel: 'medium',
      recommendedMode: 'pr-review',
      recommendedThinkingDepth: 'low',
      complexity: 'moderate',
      workIntent: 'new',
      requiresBrainstorm: false,
      harnessProfile: 'H1_EXECUTE_EVAL',
      reason: 'Initial routing selected review.',
    },
    amaControllerDecision: buildAmaControllerDecision({
      primaryTask: 'review',
      confidence: 0.9,
      riskLevel: 'medium',
      recommendedMode: 'pr-review',
      recommendedThinkingDepth: 'low',
      complexity: 'moderate',
      workIntent: 'new',
      requiresBrainstorm: false,
      harnessProfile: 'H1_EXECUTE_EVAL',
      reason: 'Initial routing selected review.',
    }),
    promptOverlay: '[Execution Mode: pr-review]',
  };

  it('switches review into investigation when runtime evidence appears', () => {
    const decision = buildHeuristicAutoRerouteDecision(
      basePlan,
      'The diff also shows a failing test and a runtime error in stderr.',
    );

    expect(decision.shouldReroute).toBe(true);
    expect(decision.nextRecommendedMode).toBe('investigation');
    expect(decision.nextPrimaryTask).toBe('bugfix');
    expect(decision.nextThinkingDepth).toBe('medium');
  });

  it('does not reroute review into investigation on timeout-only evidence', () => {
    const decision = buildHeuristicAutoRerouteDecision(
      basePlan,
      'The command hit a timeout and the stream stalled before any concrete failure evidence was collected.',
    );

    expect(decision.shouldReroute).toBe(false);
    expect(decision.reason).toContain('retried before rerouting');
  });

  it('escalates low-value review output into a stricter second pass', () => {
    const decision = buildHeuristicAutoRerouteDecision(
      basePlan,
      'Optional improvements: naming consistency, style cleanup, and a minor readability nit.',
    );

    expect(decision.shouldReroute).toBe(true);
    expect(decision.nextRecommendedMode).toBe('pr-review');
    expect(decision.nextThinkingDepth).toBe('medium');
  });

  it('uses structured router output and includes runtime evidence in the routing prompt', async () => {
    const provider = new CapturingProvider(JSON.stringify({
      primaryTask: 'bugfix',
      confidence: 0.91,
      riskLevel: 'high',
      recommendedMode: 'debug',
      recommendedThinkingDepth: 'medium',
      reason: 'Bugfix request with failing tests.',
    }));

    const plan = await createReasoningPlan(
      {
        provider: 'openai',
        reasoningMode: 'auto',
      },
      'Please investigate why npm test is failing and fix it.',
      provider,
      {
        recentMessages: [
          { role: 'assistant', content: '[stderr] failing test with stack trace' },
        ],
        sessionErrorMetadata: {
          lastError: 'npm test failed',
          consecutiveErrors: 1,
        },
        additionalSignals: ['Exit: 1 from npm test'],
      },
    );

    expect(plan.decision.primaryTask).toBe('bugfix');
    expect(['medium', 'high']).toContain(plan.decision.riskLevel);
    expect(plan.decision.recommendedMode).toBe('investigation');
    expect(plan.decision.mutationSurface).toBe('code');
    expect(plan.promptOverlay).toContain('[Execution Mode: investigation]');
    expect(plan.amaControllerDecision.profile).toBe('tactical');
    expect(plan.amaControllerDecision.fanout.admissible).toBe(false);
    expect(plan.amaControllerDecision.tactics).not.toContain('child-fanout');

    const routerPrompt = String(provider.lastMessages[0]?.content ?? '');
    expect(routerPrompt).toContain('- git: unavailable');
    expect(routerPrompt).toContain('recent session error');
    expect(routerPrompt).toContain('recent message evidence');
    expect(routerPrompt).toContain('runtime evidence');
    expect(routerPrompt).toContain('- provider semantics: capturing-provider');
    expect(routerPrompt).toContain('transport=native-api');
  });

  it('keeps timeout-only routing evidence out of the router prompt', async () => {
    const provider = new CapturingProvider(JSON.stringify({
      primaryTask: 'review',
      confidence: 0.6,
      riskLevel: 'medium',
      recommendedMode: 'pr-review',
      recommendedThinkingDepth: 'low',
      reason: 'Timeout alone should not change routing.',
    }));

    await createReasoningPlan(
      {
        provider: 'openai',
        reasoningMode: 'auto',
      },
      'Please review this PR for merge blockers.',
      provider,
      {
        recentMessages: [
          { role: 'assistant', content: 'The stream timed out before the response finished.' },
        ],
        sessionErrorMetadata: {
          lastError: 'timeout after 60s',
          consecutiveErrors: 1,
        },
        additionalSignals: ['timeout after 60s'],
      },
    );

    const routerPrompt = String(provider.lastMessages[0]?.content ?? '');
    expect(routerPrompt).not.toContain('recent message evidence');
    expect(routerPrompt).not.toContain('recent session error');
    expect(routerPrompt).not.toContain('runtime evidence');
  });

  it('falls back to heuristic routing when router output is not valid JSON', async () => {
    const provider = new CapturingProvider('not json at all');

    const plan = await createReasoningPlan(
      {
        provider: 'openai',
        reasoningMode: 'auto',
      },
      'Please improve this prompt for release notes.',
      provider,
    );

    expect(plan.decision.primaryTask).toBe('unknown');
    expect(plan.decision.recommendedThinkingDepth).toBe('medium');
    expect(plan.decision.recommendedMode).toBe('implementation');
  });

  it('logs router fallback failures when routing debug is enabled', async () => {
    const provider = new ThrowingProvider();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.env.KODAX_DEBUG_ROUTING;
    process.env.KODAX_DEBUG_ROUTING = '1';

    try {
      await createReasoningPlan(
        {
          provider: 'openai',
          reasoningMode: 'auto',
        },
        'Investigate why npm test is failing and fix it.',
        provider,
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[Routing] task router failed:',
        expect.any(Error),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.KODAX_DEBUG_ROUTING;
      } else {
        process.env.KODAX_DEBUG_ROUTING = previous;
      }
      errorSpy.mockRestore();
    }
  });

  it('falls back to heuristic reroute when the judge call fails', async () => {
    const provider = new ThrowingProvider();

    const reroutedPlan = await maybeCreateAutoReroutePlan(
      provider,
      {
        provider: 'openai',
        reasoningMode: 'auto',
      },
      'Review this PR for merge blockers.',
      basePlan,
      'Optional improvements: naming consistency and style cleanup.',
      {
        allowDepthEscalation: true,
        allowTaskReroute: true,
      },
    );

    expect(reroutedPlan).not.toBeNull();
    expect(reroutedPlan?.decision.recommendedMode).toBe('pr-review');
    expect(reroutedPlan?.decision.recommendedThinkingDepth).toBe('medium');
    expect(reroutedPlan?.kind).toBe('depth-escalation');
    expect(reroutedPlan?.promptOverlay).toContain('[Auto Depth Escalation]');
  });


  it('logs reroute judge failures when routing debug is enabled', async () => {
    const provider = new ThrowingProvider();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.env.KODAX_DEBUG_ROUTING;
    process.env.KODAX_DEBUG_ROUTING = '1';

    try {
      await maybeCreateAutoReroutePlan(
        provider,
        {
          provider: 'openai',
          reasoningMode: 'auto',
        },
        'Review this PR for merge blockers.',
        basePlan,
        'Optional improvements: naming consistency and style cleanup.',
        {
          allowDepthEscalation: true,
          allowTaskReroute: true,
        },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[Routing] reroute judge failed:',
        expect.any(Error),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.KODAX_DEBUG_ROUTING;
      } else {
        process.env.KODAX_DEBUG_ROUTING = previous;
      }
      errorSpy.mockRestore();
    }
  });

  it('uses LLM reroute output when the judge returns valid structured JSON', async () => {
    const provider = new CapturingProvider(JSON.stringify({
      shouldReroute: true,
      nextPrimaryTask: 'bugfix',
      nextRecommendedMode: 'investigation',
      nextThinkingDepth: 'high',
      reason: 'Tool evidence points to a runtime failure instead of a pure review issue.',
    }));

    const reroutedPlan = await maybeCreateAutoReroutePlan(
      provider,
      {
        provider: 'openai',
        reasoningMode: 'auto',
      },
      'Review this PR for merge blockers.',
      basePlan,
      'I am not fully sure yet.',
      {
        allowDepthEscalation: true,
        allowTaskReroute: true,
      },
      {
        toolEvidence: '- bash: Command: npm test Exit: 1 [stderr] runtime error',
      },
    );

    expect(reroutedPlan).not.toBeNull();
    expect(reroutedPlan?.kind).toBe('task-reroute');
    expect(reroutedPlan?.decision.primaryTask).toBe('bugfix');
    expect(reroutedPlan?.decision.recommendedMode).toBe('investigation');
    expect(reroutedPlan?.decision.recommendedThinkingDepth).toBe('high');

    const judgePrompt = String(provider.lastMessages[0]?.content ?? '');
    expect(judgePrompt).toContain('Tool evidence:');
    expect(judgePrompt).toContain('runtime error');
  });

  it('ignores timeout-only review evidence before consulting the reroute judge', async () => {
    const provider = new CapturingProvider(JSON.stringify({
      shouldReroute: true,
      nextPrimaryTask: 'bugfix',
      nextRecommendedMode: 'investigation',
      nextThinkingDepth: 'high',
      reason: 'Timeouts suggest the task should switch into investigation.',
    }));

    const reroutedPlan = await maybeCreateAutoReroutePlan(
      provider,
      {
        provider: 'openai',
        reasoningMode: 'auto',
      },
      'Review this PR for merge blockers.',
      basePlan,
      'The run timed out before producing a stable answer.',
      {
        allowDepthEscalation: true,
        allowTaskReroute: true,
      },
      {
        toolEvidence: '- bash: timeout after 60s with delayed response and no other failure evidence',
      },
    );

    expect(reroutedPlan).toBeNull();
    expect(provider.lastMessages).toEqual([]);
  });

  it('treats ambiguous fallback routing as unknown and keeps the initial path direct', () => {
    const decision = buildFallbackRoutingDecision(
      'Take a look at this area and help me think through the safest way to handle it.',
    );

    expect(decision.primaryTask).toBe('unknown');
    expect(decision.recommendedThinkingDepth).toBe('medium');
    expect(decision.recommendedMode).toBe('implementation');
    expect(decision.requiresBrainstorm).toBe(true);
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('supports task inference across review, bugfix, and planning prompts', () => {
    expect(inferTaskType('Please review this PR change set.')).toBe('review');
    expect(inferTaskType('This endpoint is throwing an exception, please fix it.')).toBe('bugfix');
    expect(inferTaskType('Give me a migration plan first, do not change code yet.')).toBe('plan');
  });

  it('does not mistake prompt-related requests for PR review', () => {
    expect(inferTaskType('Please improve this prompt for release notes.')).toBe('unknown');
    expect(buildFallbackRoutingDecision('Please improve this prompt for release notes.').primaryTask).toBe('unknown');
  });

  it('infers append intent while keeping the initial fallback path direct for careful extensions', () => {
    const decision = buildFallbackRoutingDecision(
      'Continue the existing onboarding flow, but brainstorm the safest approach before changing the current logic.',
    );

    expect(decision.workIntent).toBe('append');
    expect(decision.requiresBrainstorm).toBe(true);
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('infers overwrite intent when the prompt explicitly asks for replacement work', () => {
    const decision = buildFallbackRoutingDecision(
      'Rewrite the current onboarding flow from scratch and replace the existing implementation.',
    );

    expect(decision.workIntent).toBe('overwrite');
  });

  it('does not treat generic command-line options wording as a brainstorm trigger', () => {
    const decision = buildFallbackRoutingDecision(
      'Update the docs with the supported command line options for this CLI command.',
    );

    expect(decision.requiresBrainstorm).toBe(false);
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('does not treat generic flow wording as enough to escalate complexity on its own', () => {
    const decision = buildFallbackRoutingDecision(
      'Explain the control flow in this helper.',
    );

    expect(decision.complexity).toBe('simple');
  });

  it('routes systemic cross-repo refactors into H2 coordinated execution', () => {
    const decision = buildFallbackRoutingDecision(
      'Refactor the monorepo architecture across packages and coordinate the whole repo migration.',
    );

    expect(decision.complexity).toBe('systemic');
    expect(decision.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
  });

  it('selects managed AMA profile only when heavier coordination remains load-bearing', () => {
    const tactical = buildAmaControllerDecision(
      buildFallbackRoutingDecision('Please review this change set for merge blockers.'),
    );
    const managed = buildAmaControllerDecision(
      buildFallbackRoutingDecision('Refactor the monorepo architecture across packages and coordinate the whole repo migration.'),
    );

    expect(tactical.profile).toBe('tactical');
    expect(tactical.fanout.admissible).toBe(true);
    expect(tactical.fanout.class).toBe('finding-validation');
    expect(managed.profile).toBe('managed');
    expect(managed.tactics).toEqual(
      expect.arrayContaining(['planning-pass', 'verification-pass', 'repair-loop']),
    );
  });

  it('does not expose child-fanout when fanout is inadmissible on a direct mutation task', () => {
    const decision = buildAmaControllerDecision(
      {
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'direct',
        recommendedMode: 'investigation',
        recommendedThinkingDepth: 'low',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'code',
        confidence: 0.92,
        workIntent: 'new',
        requiresBrainstorm: false,
        reason: 'Small mutation investigation should stay direct.',
      },
    );

    expect(decision.profile).toBe('tactical');
    expect(decision.fanout.admissible).toBe(false);
    expect(decision.tactics).not.toContain('child-fanout');
  });

  it('exposes read-only investigation evidence-scan fan-out once the tactical runtime lands', () => {
    const decision = buildAmaControllerDecision(
      {
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'investigation',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        confidence: 0.88,
        workIntent: 'new',
        requiresBrainstorm: false,
        reason: 'Read-only investigation can use bounded evidence fan-out.',
      },
    );

    expect(decision.profile).toBe('tactical');
    expect(decision.fanout.admissible).toBe(true);
    expect(decision.fanout.class).toBe('evidence-scan');
    expect(decision.fanout.reason).toContain('Investigation work benefits from bounded evidence shards');
    expect(decision.tactics).toContain('child-fanout');
    expect(decision.tactics).not.toContain('planning-pass');
  });

  it('keeps managed-profile investigation evidence-scan fan-out inactive in this rollout', () => {
    const decision = buildAmaControllerDecision(
      {
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'investigation',
        recommendedThinkingDepth: 'medium',
        complexity: 'systemic',
        riskLevel: 'high',
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        mutationSurface: 'read-only',
        confidence: 0.88,
        workIntent: 'new',
        requiresBrainstorm: false,
        reason: 'Managed investigation should not activate read-only fan-out in this rollout.',
      },
    );

    expect(decision.profile).toBe('managed');
    expect(decision.fanout.admissible).toBe(false);
    expect(decision.fanout.class).toBeUndefined();
    expect(decision.tactics).not.toContain('child-fanout');
  });

  it('exposes read-only lookup module-triage fan-out once the tactical runtime lands', () => {
    const decision = buildAmaControllerDecision(
      {
        primaryTask: 'lookup',
        taskFamily: 'lookup',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'lookup',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        riskLevel: 'low',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        confidence: 0.84,
        workIntent: 'new',
        requiresBrainstorm: false,
        reason: 'Read-only lookup can shard module triage once the tactical runtime lands.',
      },
    );

    expect(decision.profile).toBe('tactical');
    expect(decision.fanout.admissible).toBe(true);
    expect(decision.fanout.class).toBe('module-triage');
    expect(decision.fanout.reason).toContain('Lookup work can shard module triage');
    expect(decision.tactics).toContain('child-fanout');
  });

  it('keeps direct lookup work on the non-fanout path in this rollout', () => {
    const decision = buildAmaControllerDecision(
      {
        primaryTask: 'lookup',
        taskFamily: 'lookup',
        actionability: 'actionable',
        executionPattern: 'direct',
        recommendedMode: 'lookup',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        riskLevel: 'low',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        confidence: 0.84,
        workIntent: 'new',
        requiresBrainstorm: false,
        reason: 'Direct lookup should stay lightweight and avoid hidden child fan-out.',
      },
    );

    expect(decision.profile).toBe('tactical');
    expect(decision.fanout.admissible).toBe(false);
    expect(decision.fanout.class).toBeUndefined();
    expect(decision.fanout.reason).toContain('Module-triage shards only activate for tactical H0 read-only lookup');
    expect(decision.tactics).not.toContain('child-fanout');
  });

  it('lets repo-intelligence signals raise routing complexity and planning bias', () => {
    const decision = buildFallbackRoutingDecision(
      'Update the service implementation.',
      undefined,
      {
        repoSignals: {
          changedFileCount: 9,
          changedLineCount: 1480,
          addedLineCount: 910,
          deletedLineCount: 570,
          touchedModuleCount: 3,
          changedModules: ['packages/app', 'packages/shared', 'packages/core'],
          crossModule: true,
          riskHints: ['Multiple package boundaries are changing together.'],
          activeModuleId: 'packages/app',
          activeModuleConfidence: 0.88,
          activeImpactConfidence: 0.8,
          impactedModuleCount: 4,
          impactedSymbolCount: 7,
          predominantCapabilityTier: 'high',
          suggestedComplexity: 'complex',
          plannerBias: true,
          investigationBias: false,
          lowConfidence: false,
        },
      },
    );

    expect(decision.complexity).toBe('complex');
    expect(decision.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(decision.recommendedMode).toBe('planning');
    expect(decision.routingNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Repository intelligence elevated task complexity'),
        expect.stringContaining('cross-module impact'),
      ]),
    );
  });

  it('downgrades H2 routing to H1 on lossy bridge providers and records the reason', () => {
    const providerPolicy = evaluateProviderPolicy({
      providerName: 'gemini-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
      hints: {},
      reasoningMode: 'balanced',
    });

    const decision = buildFallbackRoutingDecision(
      'Refactor the monorepo architecture across packages and coordinate the whole repo migration.',
      providerPolicy,
    );

    expect(decision.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(decision.routingNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Downgraded from H2 to H1'),
      ]),
    );
  });

  it('builds provider-policy hints that stay scoped to evidence-heavy tasks', () => {
    expect(buildProviderPolicyHintsForDecision({
      primaryTask: 'review',
      confidence: 0.9,
      riskLevel: 'medium',
      recommendedMode: 'pr-review',
      recommendedThinkingDepth: 'medium',
      complexity: 'moderate',
      workIntent: 'new',
      requiresBrainstorm: false,
      harnessProfile: 'H1_EXECUTE_EVAL',
      reason: 'review task',
    })).toEqual({
      harnessProfile: 'H1_EXECUTE_EVAL',
      evidenceHeavy: true,
      brainstorm: false,
      workIntent: 'new',
    });

    expect(buildProviderPolicyHintsForDecision({
      primaryTask: 'edit',
      confidence: 0.9,
      riskLevel: 'medium',
      recommendedMode: 'implementation',
      recommendedThinkingDepth: 'medium',
      complexity: 'complex',
      workIntent: 'overwrite',
      requiresBrainstorm: true,
      harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
      reason: 'implementation task',
    })).toEqual({
      harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
      evidenceHeavy: false,
      brainstorm: true,
      workIntent: 'overwrite',
    });
  });

  it('includes repo-intelligence signals in the router prompt', async () => {
    const provider = new CapturingProvider(JSON.stringify({
      primaryTask: 'edit',
      confidence: 0.86,
      riskLevel: 'medium',
      recommendedMode: 'implementation',
      recommendedThinkingDepth: 'medium',
      reason: 'Implementation request in a cross-module area.',
    }));

    await createReasoningPlan(
      {
        provider: 'openai',
        reasoningMode: 'auto',
      },
      'Update the service implementation.',
      provider,
      {
        repoSignals: {
          changedFileCount: 6,
          changedLineCount: 1320,
          addedLineCount: 740,
          deletedLineCount: 580,
          touchedModuleCount: 2,
          changedModules: ['packages/app', 'packages/shared'],
          crossModule: true,
          riskHints: ['Changed scope crosses package boundaries.'],
          activeModuleId: 'packages/app',
          activeModuleConfidence: 0.7,
          activeImpactConfidence: 0.68,
          impactedModuleCount: 3,
          impactedSymbolCount: 5,
          predominantCapabilityTier: 'high',
          suggestedComplexity: 'complex',
          plannerBias: true,
          investigationBias: true,
          lowConfidence: true,
        },
      },
    );

    const routerPrompt = String(provider.lastMessages[0]?.content ?? '');
    expect(routerPrompt).toContain('repo intelligence: changedFiles=6');
    expect(routerPrompt).toContain('crossModule=yes');
    expect(routerPrompt).toContain('active module: packages/app');
    expect(routerPrompt).toContain('repo risk hint: Changed scope crosses package boundaries.');
  });

  it('keeps massive reviews on the direct path and records their scale for evidence strategy', () => {
    const decision = buildFallbackRoutingDecision(
      'Please review this change set for merge blockers.',
      undefined,
      {
        repoSignals: {
          changedFileCount: 52,
          changedLineCount: 7241,
          addedLineCount: 4810,
          deletedLineCount: 2431,
          touchedModuleCount: 4,
          changedModules: ['packages/app', 'packages/shared', 'packages/repl', 'src'],
          crossModule: false,
          riskHints: ['Large review surface.'],
          activeModuleId: 'packages/app',
          activeModuleConfidence: 0.64,
          activeImpactConfidence: 0.61,
          impactedModuleCount: 4,
          impactedSymbolCount: 21,
          predominantCapabilityTier: 'high',
          suggestedComplexity: 'complex',
          plannerBias: true,
          investigationBias: false,
          lowConfidence: false,
          reviewScale: 'massive',
        },
      },
    );

    expect(decision.primaryTask).toBe('review');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
    expect(decision.mutationSurface).toBe('read-only');
    expect(decision.needsIndependentQA).toBe(false);
    expect(decision.topologyCeiling).toBe('H0_DIRECT');
    expect(decision.reviewScale).toBe('massive');
  });

  it('does not let prompt-declared massive review scope force H2', () => {
    const decision = buildFallbackRoutingDecision(
      'Please review this 50 file, 7000 lines change set and call out merge blockers.',
    );

    expect(decision.primaryTask).toBe('review');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
    expect(decision.mutationSurface).toBe('read-only');
    expect(decision.topologyCeiling).toBe('H0_DIRECT');
    expect(decision.reviewScale).toBe('massive');
  });

  it('allows read-only review to opt into H1 only when the user explicitly asks for a second pass', () => {
    const decision = buildFallbackRoutingDecision(
      'Please review this change set and do a second pass to double-check the important findings.',
    );

    expect(decision.primaryTask).toBe('review');
    expect(decision.mutationSurface).toBe('read-only');
    expect(decision.assuranceIntent).toBe('explicit-check');
    expect(decision.needsIndependentQA).toBe(true);
    expect(decision.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(decision.topologyCeiling).toBe('H1_EXECUTE_EVAL');
  });

  it('keeps docs-only work out of H2 even when the request is broad', () => {
    const decision = buildFallbackRoutingDecision(
      'Write the PRD, ADR, and design docs for this feature and keep the docs consistent across the repo.',
    );

    expect(decision.mutationSurface).toBe('docs-only');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
    expect(decision.topologyCeiling).toBe('H0_DIRECT');
  });

  it('lets docs-only work opt into H1 when the user explicitly asks for a second pass', () => {
    const decision = buildFallbackRoutingDecision(
      'Write the PRD and ADR for this feature, then do a second pass to double-check the docs for gaps.',
    );

    expect(decision.mutationSurface).toBe('docs-only');
    expect(decision.assuranceIntent).toBe('explicit-check');
    expect(decision.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(decision.topologyCeiling).toBe('H1_EXECUTE_EVAL');
  });

  it('routes pure Chinese review prompts to read-only H0 by default', () => {
    const decision = buildFallbackRoutingDecision('请评审一下当前代码改动，指出关键问题。');

    expect(decision.primaryTask).toBe('review');
    expect(decision.mutationSurface).toBe('read-only');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
    expect(decision.topologyCeiling).toBe('H0_DIRECT');
  });

  it('routes pure Chinese docs prompts to docs-only H0 by default', () => {
    const decision = buildFallbackRoutingDecision('请写需求文档和设计文档，并整理 README。');

    expect(decision.mutationSurface).toBe('docs-only');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
    expect(decision.topologyCeiling).toBe('H0_DIRECT');
  });

  it('lets pure Chinese review prompts opt into H1 only with explicit stronger-check language', () => {
    const decision = buildFallbackRoutingDecision('请评审当前代码改动，并再检查一遍关键结论。');

    expect(decision.primaryTask).toBe('review');
    expect(decision.mutationSurface).toBe('read-only');
    expect(decision.assuranceIntent).toBe('explicit-check');
    expect(decision.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(decision.topologyCeiling).toBe('H1_EXECUTE_EVAL');
  });

  it('prefers explicit review language when review and planning signals are tied', () => {
    expect(
      inferTaskType('Please review the design.'),
    ).toBe('review');
  });

  it('does not short-circuit mixed lookup plus implementation prompts onto the lookup path', () => {
    expect(
      inferIntentGate('先告诉我状态栏在哪个文件，然后改一下它'),
    ).toMatchObject({
      taskFamily: 'implementation',
      executionPattern: 'checked-direct',
    });
  });

  it('keeps pure lookup prompts on the direct lookup path', () => {
    expect(
      inferIntentGate('现在状态栏是在哪个文件管理的？'),
    ).toMatchObject({
      taskFamily: 'lookup',
      executionPattern: 'direct',
      shouldUseRepoSignals: false,
    });
  });

  it('treats empty input as lightweight conversation with no repo or model work', () => {
    expect(inferIntentGate('   ')).toMatchObject({
      taskFamily: 'conversation',
      actionability: 'non_actionable',
      executionPattern: 'direct',
      shouldUseRepoSignals: false,
      shouldUseModelRouter: false,
    });
  });

  it('keeps greeting-only prompts conversational', () => {
    expect(inferIntentGate('hello')).toMatchObject({
      taskFamily: 'conversation',
      actionability: 'non_actionable',
      executionPattern: 'direct',
      shouldUseRepoSignals: false,
      shouldUseModelRouter: false,
    });
  });

  it('routes pure review prompts to checked-direct without model routing', () => {
    expect(inferIntentGate('Please review the current changes for merge blockers.')).toMatchObject({
      taskFamily: 'review',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      shouldUseModelRouter: false,
    });
  });

  it('keeps review priority ahead of implementation when both signals are present', () => {
    expect(inferIntentGate('Please review this bug fix and then update the code if needed.')).toMatchObject({
      taskFamily: 'review',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      shouldUseModelRouter: false,
    });
  });

  it('routes pure planning prompts to coordinated execution', () => {
    expect(inferIntentGate('Please plan the rollout for this refactor.')).toMatchObject({
      taskFamily: 'planning',
      executionPattern: 'coordinated',
      shouldUseRepoSignals: true,
      shouldUseModelRouter: true,
    });
  });

  it('routes investigation prompts to checked-direct debugging work', () => {
    expect(inferIntentGate('Investigate why the retry loop still fails in production.')).toMatchObject({
      taskFamily: 'investigation',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      shouldUseModelRouter: true,
    });
  });

  it('routes pure implementation prompts to checked-direct execution', () => {
    expect(inferIntentGate('Implement the new status bar layout.')).toMatchObject({
      taskFamily: 'implementation',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      shouldUseModelRouter: true,
    });
  });

  it('keeps ambiguous prompts on the direct path', () => {
    expect(inferIntentGate('Thoughts on this?')).toMatchObject({
      taskFamily: 'ambiguous',
      actionability: 'ambiguous',
      executionPattern: 'direct',
      shouldUseRepoSignals: false,
      shouldUseModelRouter: false,
    });
  });

  it('returns unknown when competing task signals tie without an explicit directive', () => {
    expect(
      inferTaskType('Please review this bug fix.'),
    ).toBe('unknown');
  });

  it('can spend one depth escalation without consuming task reroute capability', async () => {
    const provider = new ThrowingProvider();

    const escalationPlan = await maybeCreateAutoReroutePlan(
      provider,
      {
        provider: 'openai',
        reasoningMode: 'auto',
      },
      'Review this PR for merge blockers.',
      basePlan,
      'This is unclear and I may need more context before making a final call.',
      {
        allowDepthEscalation: true,
        allowTaskReroute: false,
      },
    );

    expect(escalationPlan).not.toBeNull();
    expect(escalationPlan?.kind).toBe('depth-escalation');
    expect(escalationPlan?.decision.primaryTask).toBe('review');
    expect(escalationPlan?.decision.recommendedThinkingDepth).toBe('medium');
  });

  it('can reroute from tool evidence even when the assistant text is empty', async () => {
    const provider = new ThrowingProvider();

    const reroutedPlan = await maybeCreateAutoReroutePlan(
      provider,
      {
        provider: 'openai',
        reasoningMode: 'auto',
      },
      'Review this PR for merge blockers.',
      basePlan,
      '',
      {
        allowDepthEscalation: true,
        allowTaskReroute: true,
      },
      {
        toolEvidence: '- bash: Command: npm test Exit: 1 [stderr] failing test stack trace',
      },
    );

    expect(reroutedPlan).not.toBeNull();
    expect(reroutedPlan?.kind).toBe('task-reroute');
    expect(reroutedPlan?.decision.primaryTask).toBe('bugfix');
    expect(reroutedPlan?.decision.recommendedMode).toBe('investigation');
  });
});
