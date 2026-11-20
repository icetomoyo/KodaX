import { describe, expect, it, vi } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { KodaXBaseProvider } from '@kodax-ai/llm';
import {
  buildFallbackRoutingDecision,
  buildProviderPolicyHintsForDecision,
  createReasoningPlan,
  inferIntentGate,
  inferTaskType,
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
  it('uses heuristic routing in auto mode without calling the LLM router (FEATURE_061)', async () => {
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
    expect(plan.decision.recommendedMode).toBe('investigation');
    // Router prompt-overlay retired (ADR-043): the mode lives on the decision,
    // not in injected prompt text.
    expect(plan.promptOverlay).toBe('');
    expect(plan.decision.routingNotes).toContain(
      'Heuristic routing only — LLM router skipped (FEATURE_061 Phase 1; FEATURE_193 retired post-routing calibration).',
    );

    // LLM router should NOT have been called
    expect(provider.lastMessages).toHaveLength(0);
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

  it('succeeds with a throwing provider since LLM router is bypassed (FEATURE_061)', async () => {
    const provider = new ThrowingProvider();

    const plan = await createReasoningPlan(
      {
        provider: 'openai',
        reasoningMode: 'auto',
      },
      'Investigate why npm test is failing and fix it.',
      provider,
    );

    // Heuristic routing succeeds without calling the provider
    expect(plan.decision.primaryTask).toBe('bugfix');
    expect(plan.decision.routingNotes).toContain(
      'Heuristic routing only — LLM router skipped (FEATURE_061 Phase 1; FEATURE_193 retired post-routing calibration).',
    );
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

  it('collapses topologyCeiling / upgradeCeiling to the single H0_DIRECT tier (ADR-043)', () => {
    // The harness tier retired: deriveTopologyCeiling (read-only/docs → H1,
    // code/system → H2) is gone, so the ceiling fields are now accurate
    // constants. The assurance signal stays on the semantic fields below.
    for (const prompt of [
      'Refactor the monorepo architecture across packages.', // was code → H2
      'Audit this code for security issues and double-check findings.', // was read-only+explicit → H1
      'Write the PRD and ADR docs.', // was docs-only → H0
    ]) {
      const decision = buildFallbackRoutingDecision(prompt);
      expect(decision.topologyCeiling).toBe('H0_DIRECT');
      expect(decision.upgradeCeiling).toBe('H0_DIRECT');
      // Semantic signals that used to feed the ceiling remain queryable:
      expect(decision.mutationSurface).toBeDefined();
      expect(decision.complexity).toBeDefined();
    }
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

  it.each(['Open a PR for this fix', 'Create a pull request for my branch', '帮我开个PR', '帮我提交PR'])(
    'does not read the PR creation request "%s" as a review',
    (prompt) => {
      expect(buildFallbackRoutingDecision(prompt).primaryTask).not.toBe('review');
    },
  );

  it.each(['Check this PR for bugs', 'Please review this PR for merge blockers.'])(
    'still reads "%s" as a review',
    (prompt) => {
      expect(buildFallbackRoutingDecision(prompt).primaryTask).toBe('review');
    },
  );

  it('keeps review complexity on the requested scope instead of the worktree size', () => {
    const decision = buildFallbackRoutingDecision('Review the null check in src/auth.ts', undefined, {
      repoSignals: {
        changedFileCount: 40,
        changedLineCount: 5000,
        addedLineCount: 3000,
        deletedLineCount: 2000,
        touchedModuleCount: 5,
        changedModules: ['a', 'b', 'c', 'd', 'e'],
        crossModule: true,
        riskHints: [],
        suggestedComplexity: 'systemic',
        plannerBias: true,
        investigationBias: false,
        lowConfidence: false,
        reviewScale: 'massive',
      },
    });

    expect(decision.primaryTask).toBe('review');
    expect(decision.complexity).not.toBe('systemic');
    expect(decision.routingNotes?.join('\n') ?? '').not.toContain('elevated task complexity');
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

  it('routes systemic cross-repo refactors to H0 with complexity hints for Scout', () => {
    const decision = buildFallbackRoutingDecision(
      'Refactor the monorepo architecture across packages and coordinate the whole repo migration.',
    );

    expect(decision.complexity).toBe('systemic');
    // FEATURE_061: Pre-Scout harness is always H0; Scout decides actual harness.
    expect(decision.harnessProfile).toBe('H0_DIRECT');
    // The surviving advisory hint is the complexity signal for Scout (the
    // misleading "binding routing decision" note was removed in ADR-043).
    expect(decision.routingNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Complexity hint: systemic'),
      ]),
    );
  });

  // NOTE: the former AMA-controller advisory tests (buildAmaControllerDecision
  // profile/tactics/fanout) were removed in ADR-043 — the advisory became
  // write-only-unread once the overlay was retired and the whole chain was
  // deleted. The live successors are covered elsewhere: child fan-out by the
  // dispatch_child_task tool tests + validateWriteBundles (child-executor),
  // verification by the Sidecar Verifier gate tests, and approach selection by
  // the Worker/SA EXECUTION GUIDANCE prompt tests.

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
    // FEATURE_061: Pre-Scout harness is always H0; Scout decides actual harness.
    expect(decision.harnessProfile).toBe('H0_DIRECT');
    expect(decision.recommendedMode).toBe('planning');
    expect(decision.routingNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Repository intelligence elevated task complexity'),
        expect.stringContaining('cross-module impact'),
      ]),
    );
  });

  it('starts at H0 even on lossy bridge providers because Scout decides harness post-analysis', () => {
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

    // FEATURE_061: Pre-Scout harness is always H0; Scout decides actual harness.
    expect(decision.harnessProfile).toBe('H0_DIRECT');
    expect(decision.routingNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Complexity hint: systemic'),
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

  it('incorporates repo-intelligence signals into heuristic routing without LLM call (FEATURE_061)', async () => {
    const provider = new CapturingProvider(JSON.stringify({
      primaryTask: 'edit',
      confidence: 0.86,
      riskLevel: 'medium',
      recommendedMode: 'implementation',
      recommendedThinkingDepth: 'medium',
      reason: 'Implementation request in a cross-module area.',
    }));

    const plan = await createReasoningPlan(
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

    // Repo signals should influence the heuristic routing decision
    expect(plan.decision.complexity).toBe('complex');
    expect(plan.decision.routingNotes).toContain(
      'Heuristic routing only — LLM router skipped (FEATURE_061 Phase 1; FEATURE_193 retired post-routing calibration).',
    );

    // LLM router should NOT have been called
    expect(provider.lastMessages).toHaveLength(0);
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
    expect(decision.reviewScale).toBe('massive');
  });

  it('classifies a massive review as a read-only surface (no escalation tier exists)', () => {
    const decision = buildFallbackRoutingDecision(
      'Please review this 50 file, 7000 lines change set and call out merge blockers.',
    );

    expect(decision.primaryTask).toBe('review');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
    expect(decision.mutationSurface).toBe('read-only');
    expect(decision.reviewScale).toBe('massive');
  });

  it('allows read-only review to signal explicit-check assurance while keeping H0 for Scout to decide', () => {
    const decision = buildFallbackRoutingDecision(
      'Please review this change set and do a second pass to double-check the important findings.',
    );

    expect(decision.primaryTask).toBe('review');
    expect(decision.mutationSurface).toBe('read-only');
    expect(decision.assuranceIntent).toBe('explicit-check');
    // Harness tier retired (ADR-043): the harness is always H0_DIRECT; the
    // explicit-check signal stays on `assuranceIntent` for downstream use.
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('classifies broad docs work as a docs-only surface', () => {
    const decision = buildFallbackRoutingDecision(
      'Write the PRD, ADR, and design docs for this feature and keep the docs consistent across the repo.',
    );

    expect(decision.mutationSurface).toBe('docs-only');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('lets docs-only work signal explicit-check assurance while keeping H0 for Scout to decide', () => {
    const decision = buildFallbackRoutingDecision(
      'Write the PRD and ADR for this feature, then do a second pass to double-check the docs for gaps.',
    );

    expect(decision.mutationSurface).toBe('docs-only');
    expect(decision.assuranceIntent).toBe('explicit-check');
    // Harness tier retired (ADR-043): the harness is always H0_DIRECT; the
    // explicit-check signal stays on `assuranceIntent` for downstream use.
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('routes pure Chinese review prompts to read-only H0 by default', () => {
    const decision = buildFallbackRoutingDecision('请评审一下当前代码改动，指出关键问题。');

    expect(decision.primaryTask).toBe('review');
    expect(decision.mutationSurface).toBe('read-only');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('routes pure Chinese docs prompts to docs-only H0 by default', () => {
    const decision = buildFallbackRoutingDecision('请写需求文档和设计文档，并整理 README。');

    expect(decision.mutationSurface).toBe('docs-only');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('lets pure Chinese review prompts signal explicit-check while keeping H0 for Scout to decide', () => {
    const decision = buildFallbackRoutingDecision('请评审当前代码改动，并再检查一遍关键结论。');

    expect(decision.primaryTask).toBe('review');
    expect(decision.mutationSurface).toBe('read-only');
    expect(decision.assuranceIntent).toBe('explicit-check');
    // Harness tier retired (ADR-043): the harness is always H0_DIRECT; the
    // explicit-check signal stays on `assuranceIntent` for downstream use.
    expect(decision.harnessProfile).toBe('H0_DIRECT');
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
      requiresRoutingHeuristics: false,
    });
  });

  it('keeps greeting-only prompts conversational', () => {
    expect(inferIntentGate('hello')).toMatchObject({
      taskFamily: 'conversation',
      actionability: 'non_actionable',
      executionPattern: 'direct',
      shouldUseRepoSignals: false,
      requiresRoutingHeuristics: false,
    });
  });

  // FEATURE_067: All actionable tasks now go through model router for accurate harness assessment.
  it('routes pure review prompts to checked-direct with model routing', () => {
    expect(inferIntentGate('Please review the current changes for merge blockers.')).toMatchObject({
      taskFamily: 'review',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      requiresRoutingHeuristics: true,
    });
  });

  it('keeps review priority ahead of implementation when both signals are present', () => {
    expect(inferIntentGate('Please review this bug fix and then update the code if needed.')).toMatchObject({
      taskFamily: 'review',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      requiresRoutingHeuristics: true,
    });
  });

  it('routes pure planning prompts to coordinated execution', () => {
    expect(inferIntentGate('Please plan the rollout for this refactor.')).toMatchObject({
      taskFamily: 'planning',
      executionPattern: 'coordinated',
      shouldUseRepoSignals: true,
      requiresRoutingHeuristics: true,
    });
  });

  it('routes investigation prompts to checked-direct debugging work', () => {
    expect(inferIntentGate('Investigate why the retry loop still fails in production.')).toMatchObject({
      taskFamily: 'investigation',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      requiresRoutingHeuristics: true,
    });
  });

  it('routes pure implementation prompts to checked-direct execution', () => {
    expect(inferIntentGate('Implement the new status bar layout.')).toMatchObject({
      taskFamily: 'implementation',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      requiresRoutingHeuristics: true,
    });
  });

  // FEATURE_067: Ambiguous tasks now go through model router instead of defaulting to H0.
  it('routes ambiguous prompts through model router', () => {
    expect(inferIntentGate('Thoughts on this?')).toMatchObject({
      taskFamily: 'ambiguous',
      actionability: 'ambiguous',
      executionPattern: 'direct',
      shouldUseRepoSignals: false,
      requiresRoutingHeuristics: true,
    });
  });

  it('returns unknown when competing task signals tie without an explicit directive', () => {
    expect(
      inferTaskType('Please review this bug fix.'),
    ).toBe('unknown');
  });

  it('keeps API documentation-only edits on the docs-only path when code changes are forbidden', () => {
    const decision = buildFallbackRoutingDecision(
      'Update API docs and README only. Do not change code.',
    );

    expect(decision.primaryTask).toBe('edit');
    expect(decision.mutationSurface).toBe('docs-only');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('classifies docs-scoped backend/module rewrites as docs-only surface', () => {
    const decision = buildFallbackRoutingDecision(
      'Rewrite the ADR and module documentation only. Do not change code.',
    );

    expect(decision.primaryTask).toBe('edit');
    expect(decision.mutationSurface).toBe('docs-only');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('still treats mixed implementation plus docs requests as code work', () => {
    const decision = buildFallbackRoutingDecision(
      'Update the backend service implementation and refresh the API docs.',
    );

    expect(decision.primaryTask).toBe('edit');
    expect(decision.mutationSurface).toBe('code');
  });

  it('keeps technical documentation edits on docs-only even without an explicit no-code suffix', () => {
    const decision = buildFallbackRoutingDecision(
      'Update backend service docs only.',
    );

    expect(decision.primaryTask).toBe('edit');
    expect(decision.mutationSurface).toBe('docs-only');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('treats migration guides with explicit no-code constraints as docs-only work', () => {
    const decision = buildFallbackRoutingDecision(
      'Only update the migration guide; do not run migrations or change code.',
    );

    expect(decision.primaryTask).toBe('edit');
    expect(decision.mutationSurface).toBe('docs-only');
    expect(decision.harnessProfile).toBe('H0_DIRECT');
    // A "migration guide" with an explicit no-code constraint stays docs-only
    // (the complexity signal lives on decision.complexity; there is no longer a
    // harness ceiling that it lifts — ADR-043).
  });

  it('does not let code-comment edits hide behind README-only phrasing', () => {
    const decision = buildFallbackRoutingDecision(
      'Update code comments and README only.',
    );

    expect(decision.primaryTask).toBe('edit');
    expect(decision.mutationSurface).toBe('code');
  });
});

// NOTE: the former "Phase C: AMA behavior guidance" block tested the
// [AMA Behavior] text emitted by buildPromptOverlay, which was retired in
// ADR-043 (the Worker self-judges from static EXECUTION GUIDANCE). The live
// fanout.admissible signal on buildAmaControllerDecision is covered by the
// "selects managed AMA profile" / "does not expose child-fanout" tests above.
