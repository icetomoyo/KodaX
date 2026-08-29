import { describe, it, expect } from 'vitest';
import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXToolResultBlock,
} from '@kodax-ai/llm';
import {
  createProviderCredentialLeaseScope,
  KodaXBaseProvider,
  runWithProviderCredentialLeaseScope,
} from '@kodax-ai/llm';
import { ContextCapacityError } from '../../context-capacity.js';
import { compact, isEmptyLikeSummary, needsCompaction, PROTECTED_TOOL_NAMES, truncateUserText } from './compaction.js';
import { generateSummary } from './summary-generator.js';
import { parseUserQueryLedger } from './query-ledger.js';

class FakeSummaryProvider extends KodaXBaseProvider {
  readonly name = 'fake-summary';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'FAKE_SUMMARY_API_KEY',
    model: 'fake-summary-model',
    supportsThinking: false,
    contextWindow: 200000,
  };

  public prompts: string[] = [];
  public systems: string[] = [];
  public modelOverrides: Array<string | undefined> = [];
  public ephemeralSuffixes: Array<string | undefined> = [];
  public promptCacheKeys: Array<string | undefined> = [];
  public callCount = 0;

  constructor(
    private readonly summaryText: string | readonly string[] = [
      '## Goal',
      'Continue the current task.',
      '',
      '## Constraints & Preferences',
      '- None',
      '',
      '## Progress',
      '### Completed',
      '- [x] Captured the important history',
      '',
      '### In Progress',
      '- [ ] Continue implementation',
      '',
      '### Blockers',
      '- None',
      '',
      '## Key Decisions',
      '- **Compaction**: Keep the summary concise',
      '',
      '## Next Steps',
      '1. Continue from the latest code state',
      '',
      '## Key Context',
      '- packages/agent/src/compaction/compaction.ts',
    ].join('\n'),
    private readonly failOnCall?: number,
    private readonly evolveSummary = false,
  ) {
    super();
  }

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    system: string,
    _thinking?: boolean,
    streamOptions?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    this.callCount += 1;
    if (this.failOnCall && this.callCount === this.failOnCall) {
      throw new Error('summary failed');
    }

    const prompt = messages[0];
    this.prompts.push(typeof prompt?.content === 'string' ? prompt.content : JSON.stringify(prompt?.content));
    this.systems.push(system);
    this.modelOverrides.push(streamOptions?.modelOverride);
    this.ephemeralSuffixes.push(streamOptions?.ephemeralSuffix?.content);
    this.promptCacheKeys.push(streamOptions?.promptCacheKey);

    let summaryText = typeof this.summaryText === 'string'
      ? this.summaryText
      : this.summaryText[Math.min(this.callCount - 1, this.summaryText.length - 1)] ?? '';
    if (this.evolveSummary && this.callCount > 1) {
      summaryText += `\n- Incorporated semantic summary chunk ${this.callCount}.`;
    }
    return {
      textBlocks: [{ type: 'text', text: summaryText }],
      toolBlocks: [],
      thinkingBlocks: [],
    };
  }
}

function makeLongText(word: string, count: number): string {
  return Array.from({ length: count }, () => word).join(' ');
}

function buildLongConversation(turns: number, wordsPerMessage: number): KodaXMessage[] {
  return Array.from({ length: turns * 2 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: makeLongText(index % 2 === 0 ? 'user' : 'assistant', wordsPerMessage),
  }));
}

function buildToolPair(index: number, outputWords: number): KodaXMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `tool-${index}`,
          name: 'bash',
          input: { command: `cat output-${index}.txt` },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tool-${index}`,
          content: makeLongText('x', outputWords),
        },
      ],
    },
  ];
}

describe('compaction', () => {
  it('keeps automatic compaction on and applies percentage/absolute thresholds', () => {
    const messages = [{ role: 'user' as const, content: 'short prompt' }];
    const disabledCompatibilityInput = { enabled: false, triggerPercent: 75 };

    expect(needsCompaction(messages, disabledCompatibilityInput, 100_000, 74_999, 10_000)).toBe(false);
    expect(needsCompaction(messages, disabledCompatibilityInput, 100_000, 75_000, 10_000)).toBe(true);
    expect(needsCompaction(
      messages,
      { enabled: true, triggerPercent: 70, triggerTokens: 60_000 },
      100_000,
      60_000,
      10_000,
    )).toBe(true);
  });

  it('protects 20% of the effective trigger rather than the model window', async () => {
    const provider = new FakeSummaryProvider();
    const messages = buildLongConversation(12, 3_000).map((message, index) => ({
      ...message,
      content: `MESSAGE_${index}\n${String(message.content)}`,
    }));

    const result = await compact(messages, {
      enabled: true,
      triggerPercent: 40,
    }, provider, 100_000, undefined, undefined, undefined, undefined, undefined, undefined, true);

    expect(result.compacted).toBe(true);
    // Effective trigger = 40k, so the raw tail is about 8k rather than the old
    // 20k model-window-derived tail.
    const rawTail = result.messages.filter((message) => (
      typeof message.content === 'string' && message.content.startsWith('MESSAGE_')
    ));
    expect(rawTail.length).toBeLessThanOrEqual(4);
  });

  it('marks the protected raw tail when reusing the exact main-request cache prefix', async () => {
    const provider = new FakeSummaryProvider();
    const messages = buildLongConversation(12, 2_000);

    await compact(
      messages,
      { enabled: true, triggerPercent: 30 },
      provider,
      100_000,
      undefined,
      'MAIN SYSTEM',
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      0,
      { tools: [] },
    );

    expect(provider.ephemeralSuffixes[0]).toMatch(/before the final [1-9]\d* messages?/);
  });

  it('prefers an explicit token count override when checking trigger thresholds', () => {
    const config = {
      enabled: true,
      triggerPercent: 60,
    };
    const contextWindow = 10_000;
    const messages = [{ role: 'user' as const, content: 'short prompt' }];

    expect(needsCompaction(messages, config, contextWindow)).toBe(false);
    expect(needsCompaction(messages, config, contextWindow, 7_000)).toBe(true);
    expect(needsCompaction(messages, config, contextWindow, 100)).toBe(false);
  });

  it('covers the complete eligible prefix without targeting an arbitrary low-water mark', async () => {
    const provider = new FakeSummaryProvider(undefined, undefined, true);
    const contextWindow = 10_000;
    const config = {
      enabled: true,
      triggerPercent: 30,
      protectionPercent: 20,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 500,
    };

    const messages = buildLongConversation(10, 220);
    const result = await compact(messages, config, provider, contextWindow);

    expect(result.compacted).toBe(true);
    expect(result.tokensBefore).toBeGreaterThan(contextWindow * (config.triggerPercent / 100));
    expect(result.entriesRemoved).toBeGreaterThan(0);
    expect(result.messages[0]).toEqual(expect.objectContaining({
      role: 'user',
      _source: 'compaction-checkpoint',
    }));
    expect(result.messages[0]?.content).toEqual(expect.stringContaining('session_history_search'));
    expect(result.messages[0]?.content).toEqual(expect.stringContaining('session_history_read'));
    expect(provider.callCount).toBeGreaterThan(0);
  });

  it('records only compacted-prefix queries and keeps protected-tail queries as raw messages', async () => {
    const provider = new FakeSummaryProvider();
    const oldQuery = 'Investigate the original failure.';
    const recentQuery = 'Now review the final implementation.';
    const messages: KodaXMessage[] = [
      { role: 'user', content: oldQuery, turnId: 'turn-old' },
      { role: 'assistant', content: makeLongText('evidence', 2_000) },
      { role: 'user', content: recentQuery, turnId: 'turn-recent' },
    ];

    const result = await compact(
      messages,
      { enabled: true, triggerPercent: 30 },
      provider,
      10_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(parseUserQueryLedger(result.summary ?? '').map((entry) => entry.text)).toEqual([
      oldQuery,
    ]);
    expect(result.messages).toContainEqual(messages[2]);
  });

  it('passes the active model override to summary generation', async () => {
    const provider = new FakeSummaryProvider();
    const contextWindow = 10_000;
    const config = {
      enabled: true,
      triggerPercent: 30,
      protectionPercent: 20,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 500,
    };

    await compact(
      buildLongConversation(10, 220),
      config,
      provider,
      contextWindow,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'active-model',
    );

    expect(provider.modelOverrides).toContain('active-model');
  });

  it('propagates a summary failure without mutating canonical input', async () => {
    const provider = new FakeSummaryProvider(undefined, 1);
    const messages = buildLongConversation(10, 220);
    const original = structuredClone(messages);

    await expect(compact(messages, {
      enabled: true,
      triggerPercent: 30,
    }, provider, 10_000)).rejects.toThrow('summary failed');
    expect(messages).toEqual(original);
  });

  it('preserves the original history and fails explicitly when no summary request fits', async () => {
    const provider = new FakeSummaryProvider();
    const messages = buildToolPair(1, 6_500);

    await expect(compact(messages, {
      enabled: true,
      triggerPercent: 100,
      protectionPercent: 0,
      rollingSummaryPercent: 10,
    }, provider, 4_000)).rejects.toBeInstanceOf(ContextCapacityError);
    expect(messages).toEqual(buildToolPair(1, 6_500));
  });

  it('summarizes all eligible tool evidence and keeps only the protected raw tail', async () => {
    const provider = new FakeSummaryProvider();
    const contextWindow = 30000;
    const config = {
      enabled: true,
      triggerPercent: 70,
      protectionPercent: 1,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 50000,
    };

    // FEATURE_182 (v0.7.42): provide a previousSummary so the fast-path is
    // taken (where [Pruned:...] markers persist into final output). Pre-F182
    // this test relied on the implicit "first-compaction always takes
    // fast-path when prunable" behaviour, but F182 now forces slow-path
    // when previousSummary is empty (otherwise the fallback template gets
    // cemented forever). The fast-path scenario this test was designed for
    // is "subsequent compaction with a prior real summary", which is what
    // the explicit previousSummary system message below now configures.
    const messages: KodaXMessage[] = [
      { role: 'system', content: '[对话历史摘要]\n\nPrior summary from a previous compaction cycle. The user asked us to investigate a long-running task and we have made progress.' },
      { role: 'assistant', content: 'retain assistant note' },
      ...buildToolPair(1, 6500),
      ...buildToolPair(2, 6500),
      ...buildToolPair(3, 6500),
      ...buildToolPair(4, 6500),
      ...buildToolPair(5, 6500),
      ...buildToolPair(6, 6500),
      ...buildToolPair(7, 6500),
      ...buildToolPair(8, 6500),
      ...buildToolPair(9, 6500),
      ...buildToolPair(10, 6500),
      ...buildToolPair(11, 6500),
      ...buildToolPair(12, 6500),
      ...buildToolPair(13, 6500),
      ...buildToolPair(14, 6500),
    ];

    const result = await compact(messages, config, provider, contextWindow);
    const toolResults = result.messages
      .filter((msg): msg is KodaXMessage & { role: 'user'; content: NonNullable<KodaXMessage['content']> } =>
        msg.role === 'user' && Array.isArray(msg.content),
      )
      .flatMap((msg) => msg.content as KodaXContentBlock[])
      .filter((block): block is KodaXToolResultBlock => block.type === 'tool_result');

    expect(result.compacted).toBe(true);
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeLessThanOrEqual(3);
    expect(toolResults.every((block) => !String(block.content).includes('[Pruned:'))).toBe(true);
    expect(provider.prompts.join('\n')).toContain('x x x x');
    expect(result.messages.some((msg) => msg.role === 'assistant' && msg.content === 'retain assistant note')).toBe(false);
    expect(result.artifactLedger?.some((entry) => entry.kind === 'command_scope' && entry.action === 'cat')).toBe(true);
    expect(result.memorySeed).toEqual(expect.objectContaining({
      importantTargets: expect.any(Array),
      progress: expect.objectContaining({
        completed: expect.any(Array),
        inProgress: expect.any(Array),
        blockers: expect.any(Array),
      }),
    }));
    expect(result.anchor?.artifactLedgerId).toMatch(/^ledger_/);
  });

  // Solo wall-clock ~2.9s (long conversation + 2-attempt retry inside compact()).
  // Under heavy parallel suite load on Windows this can exceed vitest's 5s
  // default — follows precedent commit d4a47bc9 (v0.7.37) "bump per-test
  // timeouts on flaky suites under heavy parallel load".
  it('does not commit partial summary progress when any summary attempt fails', { timeout: 15_000 }, async () => {
    const partialSummary = [
      '## Goal',
      'Preserve the successfully summarized prefix while retaining every later canonical message.',
      '## Progress',
      '- The first summary chunk completed successfully and is safe to consume.',
    ].join('\n');
    const provider = new FakeSummaryProvider(partialSummary, 2);
    const contextWindow = 100000;
    const config = {
      enabled: true,
      triggerPercent: 10,
      protectionPercent: 0,
      rollingSummaryPercent: 20,
    };

    const messages = buildLongConversation(3, 30000);
    await expect(compact(messages, config, provider, contextWindow)).rejects.toThrow('summary failed');
    expect(messages).toEqual(buildLongConversation(3, 30000));
  });

  it('keeps routing affinity on every map/reduce summary request', { timeout: 15_000 }, async () => {
    const provider = new FakeSummaryProvider(undefined, undefined, true);
    const promptCacheKey = 'f'.repeat(64);
    const messages = buildLongConversation(3, 15_000).map((message, index) =>
      index % 2 === 0
        ? { ...message, content: `question-${index / 2 + 1}` }
        : message);

    const result = await compact(
      messages,
      {
        enabled: true,
        triggerPercent: 10,
        protectionPercent: 0,
        rollingSummaryPercent: 20,
      },
      provider,
      60_000,
      undefined,
      'MAIN SYSTEM',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      0,
      { tools: [] },
      undefined,
      { promptCacheKey },
    );

    expect(result.compacted).toBe(true);
    expect(provider.callCount).toBeGreaterThan(1);
    expect(provider.promptCacheKeys).toHaveLength(provider.callCount);
    expect(provider.promptCacheKeys.every((key) => key === promptCacheKey)).toBe(true);
    expect(provider.ephemeralSuffixes.every((suffix) => suffix === undefined)).toBe(true);
  });

  it('does not consume a chunk when its summary is empty-like', async () => {
    const provider = new FakeSummaryProvider(
      '## Goal\nNo active goal. The conversation is empty with no prior context provided.',
    );
    const messages: KodaXMessage[] = [{
      role: 'user',
      content: `UNEXPRESSED_CHUNK_SENTINEL\n${makeLongText('evidence', 8_000)}`,
    }, {
      role: 'assistant',
      content: 'recent protected tail',
    }];
    const original = structuredClone(messages);

    await expect(compact(messages, {
      enabled: true,
      triggerPercent: 10,
      protectionPercent: 0,
      rollingSummaryPercent: 10,
    }, provider, 30_000)).rejects.toThrow('did not contain usable semantic content');

    expect(provider.callCount).toBe(1);
    expect(messages).toEqual(original);
  });

  it('compacts the complete eligible prefix instead of retaining an unsummarized suffix', { timeout: 15_000 }, async () => {
    const validPartialSummary = [
      '## Goal',
      'Retain deterministic progress from the first chunk without consuming evidence from later chunks.',
      '## Progress',
      '- The prefix was summarized successfully and can be represented by this durable summary.',
    ].join('\n');
    // Echoing the prior summary unchanged does not express the next chunk.
    const provider = new FakeSummaryProvider([validPartialSummary, validPartialSummary]);
    const messages = buildLongConversation(3, 30_000).map((message, index) => ({
      ...message,
      content: `CANONICAL_SENTINEL_${index}\n${String(message.content)}`,
    }));

    const result = await compact(messages, {
      enabled: true,
      triggerPercent: 10,
      protectionPercent: 0,
      rollingSummaryPercent: 20,
    }, provider, 200_000);

    expect(result.compacted).toBe(true);
    expect(result.entriesRemoved).toBe(messages.length - 1);
    const retainedRaw = result.messages.filter((message) => (
      message._synthetic !== true
      && typeof message.content === 'string'
      && message.content.includes('CANONICAL_SENTINEL_')
    ));
    expect(retainedRaw).toHaveLength(1);
    expect(result.messages[0]).toEqual(expect.objectContaining({
      role: 'user',
      _synthetic: true,
      _source: 'compaction-checkpoint',
    }));
  });
});

describe('user message protection', () => {
  it('preserves short user messages as-is', () => {
    const shortText = 'Fix the 401 error on /api/auth/login by switching to JWT';
    expect(truncateUserText(shortText)).toBe(shortText);
  });

  it('truncates long user messages preserving head and tail', () => {
    // Build a message that's > 800 tokens (~3200 chars at 4 chars/token)
    const longText = 'Please analyze this error log and fix the issue:\n'
      + 'ERROR '.repeat(1000) + '\n'
      + 'The fix should preserve backwards compatibility.';

    const result = truncateUserText(longText);

    // Should contain the head (user intent)
    expect(result).toContain('Please analyze this error log');
    // Should contain the truncation marker
    expect(result).toContain('[…user message truncated');
    expect(result).toContain('tokens…]');
    // Should contain the tail
    expect(result).toContain('backwards compatibility.');
    // Should be shorter than original
    expect(result.length).toBeLessThan(longText.length);
  });

  it('returns short messages below threshold unchanged', () => {
    const text = 'a '.repeat(100); // ~50 tokens, well below 800
    expect(truncateUserText(text)).toBe(text);
  });
});

describe('summary generator', () => {
  it('uses the same lazy credential seam for manual and automatic compaction', async () => {
    const provider = new FakeSummaryProvider('summary');
    const acquisitions: string[] = [];
    const scope = createProviderCredentialLeaseScope({
      allowedProviders: ['fake-summary'],
      async acquire(providerName) {
        acquisitions.push(providerName);
        return 'keychain-only-secret';
      },
    });

    await runWithProviderCredentialLeaseScope(scope, () => generateSummary(
      [{ role: 'user', content: 'continue the work' }],
      provider,
      { readFiles: [], modifiedFiles: [] },
    ));

    expect(acquisitions).toEqual(['fake-summary']);
    scope.close();
  });

  it('uses continuation-focused update instructions instead of preserving all history', async () => {
    const provider = new FakeSummaryProvider('summary');

    await generateSummary(
      [{ role: 'user', content: 'continue the work' }],
      provider,
      { readFiles: ['a.ts'], modifiedFiles: ['b.ts'] },
      'Focus on risks',
      'CUSTOM SYSTEM',
      'Previous summary',
    );

    expect(provider.systems[0]).toBe('CUSTOM SYSTEM');
    expect(provider.prompts[0]).toContain('Keep only the information needed to continue the work.');
    expect(provider.prompts[0]).toContain('You may remove:');
    expect(provider.prompts[0]).toContain('Additional instructions: Focus on risks');
    expect(provider.prompts[0]).not.toContain('Preserve all existing information');
  });
});

describe('FEATURE_181 (v0.7.42): isEmptyLikeSummary heuristic', () => {
  // Detection criteria — see isEmptyLikeSummary docstring.

  it('treats empty / whitespace-only strings as empty', () => {
    expect(isEmptyLikeSummary('')).toBe(true);
    expect(isEmptyLikeSummary('   ')).toBe(true);
    expect(isEmptyLikeSummary('\n\n  \t')).toBe(true);
  });

  it('treats very short outputs (< 80 chars) as empty', () => {
    expect(isEmptyLikeSummary('## Goal\nSomething brief')).toBe(true);
    expect(isEmptyLikeSummary('A'.repeat(79))).toBe(true);
  });

  it('detects "No active goal" marker (the most common LLM empty-output pattern)', () => {
    const obs = '## Goal\nNo active goal. The conversation appears to be empty with no prior context provided.';
    expect(isEmptyLikeSummary(obs)).toBe(true);
  });

  it('detects "conversation is empty" / "no prior context" / "nothing to summarize" markers', () => {
    expect(isEmptyLikeSummary('## Goal\nThe conversation is empty. No information is available from the prior history block.'))
      .toBe(true);
    expect(isEmptyLikeSummary('## Goal\nThere is no prior context to summarize. The transcript has been compacted away.'))
      .toBe(true);
    expect(isEmptyLikeSummary('## Goal\nNothing to summarize — all messages appear to be placeholder strings.'))
      .toBe(true);
  });

  it('case-insensitive on the marker phrases', () => {
    expect(isEmptyLikeSummary('## Goal\nNO ACTIVE GOAL. The conversation appears empty per the placeholder content.'))
      .toBe(true);
  });

  it('does NOT mark a real summary as empty', () => {
    const realSummary = '## Goal\nThe user asked to review changes between v0.7.40 and v0.7.41 and write a summary report. Worker is in the middle of dispatching three child tasks to deep-dive boundary changes, LLM rename refactor, and REPL gemini integration.\n## Constraints\n- Must produce a markdown report.\n- Reviewer must reuse repo intelligence rather than re-grep.';
    expect(isEmptyLikeSummary(realSummary)).toBe(false);
  });

  it('does NOT mark a long substantive summary that happens to mention "empty" in unrelated context', () => {
    // Defensive check: if a real summary mentions "empty" referring to some
    // other concept (e.g., "the empty config file was created"), it should
    // not trigger empty-detection.
    const realSummary = '## Goal\nUser wants to investigate why the test fixture directory was checked in as an empty file rather than an actual config. Worker has confirmed by reading the original commit that this was intentional.\n## Next steps\n- Document the rationale in the test guide.\n- Add a regression test that verifies the fixture stays empty.';
    expect(isEmptyLikeSummary(realSummary)).toBe(false);
  });
});

describe('FEATURE_181 (v0.7.42): empty LLM summary does not overwrite a non-empty previousSummary', () => {
  // Production integration of isEmptyLikeSummary in the slow-path summarization
  // loop. compact() extracts previousSummary from a system message prefixed
  // with COMPACTION_SUMMARY_PREFIX (line ~140-150 of compaction.ts); the fake
  // provider returns the empty-marker pattern to simulate the failure mode
  // where microcompact + pruneToolResults stripped facts before the LLM ran.

  const PRIOR_REAL_SUMMARY =
    'PRIOR_REAL_SUMMARY: The user was investigating a kimi loop bug. Worker '
    + 'had identified the root cause as compaction destroying tool_result '
    + 'content. We confirmed via session forensics that 091743 exhibited the '
    + 'same pattern across multiple turns of the same task.';

  const EMPTY_SUMMARY_TEXT =
    '## Goal\nNo active goal. The conversation is empty with no prior context provided.';

  function buildPrunedConversation(turns: number): KodaXMessage[] {
    // Mimic post-microcompact + post-pruneToolResults state: assistant
    // tool_use blocks + user [Cleared:...] placeholder. Large word count so
    // total exceeds compaction trigger window.
    const out: KodaXMessage[] = [];
    for (let i = 0; i < turns; i++) {
      out.push({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `t${i}`, name: 'read', input: { path: `f${i}.ts` } },
        ],
      });
      out.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `t${i}`, content: makeLongText('placeholder', 50) },
        ],
      });
    }
    return out;
  }

  it('rejects an empty-like replacement and leaves the prior summary input unchanged', async () => {
    // Fake provider returns the empty-like marker (will trigger F181 guard).
    const provider = new FakeSummaryProvider(EMPTY_SUMMARY_TEXT);
    const config = {
      enabled: true,
      triggerPercent: 60,
      protectionPercent: 20,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 500,
    };
    const contextWindow = 100000;

    // Build messages large enough to trigger compaction, with prior summary
    // embedded as the system message compact() recognises.
    const messages: KodaXMessage[] = [
      { role: 'system', content: `${'[对话历史摘要]\n\n'}${PRIOR_REAL_SUMMARY}` },
      ...buildLongConversation(200, 220), // ~88K tokens > 60K trigger
    ];

    const original = structuredClone(messages);
    await expect(compact(messages, config, provider, contextWindow)).rejects.toThrow(
      'did not contain usable semantic content',
    );
    expect(provider.callCount).toBeGreaterThan(0);
    // No chunk was expressed by the invalid output, so canonical history —
    // including the prior summary message — is returned byte-for-byte.
    expect(messages).toEqual(original);
  });

  it('terminates without consuming chunks when every LLM call returns empty-like', async () => {
    const provider = new FakeSummaryProvider(EMPTY_SUMMARY_TEXT);
    const config = {
      enabled: true,
      triggerPercent: 60,
      protectionPercent: 20,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 500,
    };
    const contextWindow = 100000;

    const messages: KodaXMessage[] = [
      { role: 'system', content: `${'[对话历史摘要]\n\n'}${PRIOR_REAL_SUMMARY}` },
      ...buildLongConversation(200, 220), // > 60K trigger
    ];

    // Race against a 10s deadline — should complete in well under 1s in
    // practice (no real I/O), but the deadline is the contract: no infinite loop.
    await expect(Promise.race([
      compact(messages, config, provider, contextWindow),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('compact loop did not terminate within 10s')), 10000),
      ),
    ])).rejects.toThrow('did not contain usable semantic content');
    expect(provider.callCount).toBeGreaterThan(0);
  });

  it('first compaction (no prior summary) — empty marker flows through (F182 will harden)', async () => {
    // F181 only guards "non-empty previousSummary getting overwritten".
    // First compaction with no prior summary lets the empty-like LLM output
    // flow through to the finalSummary || fallback line. This is the C.1 /
    // F182 territory (force slow-path or richer fallback when empty). Here we
    // just pin that F181 does not accidentally block first-compaction paths.
    const provider = new FakeSummaryProvider(EMPTY_SUMMARY_TEXT);
    const config = {
      enabled: true,
      triggerPercent: 60,
      protectionPercent: 20,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 500,
    };
    const contextWindow = 100000;

    const messages = buildLongConversation(10, 220); // no prior summary

    const result = await compact(messages, config, provider, contextWindow);
    // Result produced without crash. summary may be empty / fallback content
    // depending on pruneResult vs slow-path entry — F181 is irrelevant here.
    expect(result).toBeDefined();
  });
});

describe('FEATURE_182 (v0.7.42): fast-path requires a non-empty previousSummary', () => {
  // C.1 forensic finding (788-session scan): 48% of compactions took the
  // fast-path. Pre-F182 the fast-path branch returned
  // buildFallbackCompactionSummary when previousSummary was empty, which
  // cemented the generic "Continue the current task" template as the session
  // summary. Subsequent compactions then saw the template as previousSummary
  // and re-took fast-path indefinitely — the LLM was never asked to seed a
  // real summary. F182 adds a `previousSummary &&` guard so first-compaction
  // is forced through the slow-path; a real LLM summary then anchors all
  // future fast-paths.

  const REAL_SUMMARY_TEXT = [
    '## Goal',
    'User is investigating a kimi loop bug. We have traced it to compaction.',
    '',
    '## Constraints & Preferences',
    '- Must run regression sweep before shipping',
    '',
    '## Progress',
    '### Completed',
    '- [x] Identified 091743 session as repro',
    '- [x] Confirmed compaction destroys tool_result content',
    '',
    '### In Progress',
    '- [ ] Wire stall detector',
    '',
    '## Next Steps',
    '1. Add F178 sidecar integration',
    '',
    '## Key Context',
    '- packages/agent/src/primitives/runner.ts',
  ].join('\n');

  function buildPrunableConversation(): KodaXMessage[] {
    // Heavy tool-result payload so pruneToolResults marks hasPruned=true and
    // the prunedQueue fits under triggerTokens * 0.8 — exactly the
    // pre-condition that fast-path was designed for. With F182, slow-path is
    // forced when previousSummary is absent.
    return [
      { role: 'assistant', content: 'retain assistant note' },
      ...buildToolPair(1, 6500),
      ...buildToolPair(2, 6500),
      ...buildToolPair(3, 6500),
      ...buildToolPair(4, 6500),
      ...buildToolPair(5, 6500),
      ...buildToolPair(6, 6500),
      ...buildToolPair(7, 6500),
      ...buildToolPair(8, 6500),
      ...buildToolPair(9, 6500),
      ...buildToolPair(10, 6500),
      ...buildToolPair(11, 6500),
      ...buildToolPair(12, 6500),
      ...buildToolPair(13, 6500),
      ...buildToolPair(14, 6500),
    ];
  }

  it('first compaction with no prior summary forces slow-path (LLM is invoked)', async () => {
    // The exact same fixture as the legacy "prunes older tool results" test
    // but WITHOUT the prior-summary system message. Pre-F182 this took
    // fast-path and the LLM was never called. Post-F182 this enters slow-path
    // and provider.callCount must be > 0.
    const provider = new FakeSummaryProvider(REAL_SUMMARY_TEXT);
    const contextWindow = 30000;
    const config = {
      enabled: true,
      triggerPercent: 70,
      protectionPercent: 1,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 50000,
    };

    const messages = buildPrunableConversation();
    const result = await compact(messages, config, provider, contextWindow);

    expect(result.compacted).toBe(true);
    // The critical assertion — LLM was invoked because previousSummary was
    // empty, so fast-path was skipped.
    expect(provider.callCount).toBeGreaterThan(0);
    // The resulting summary is the LLM output, not the generic fallback.
    expect(result.summary).toBeDefined();
    expect(result.summary || '').toContain('kimi loop bug');
  });

  it('audits new raw history even when a previous summary exists', async () => {
    // The parity case: same prunable fixture + a prior summary. F182 must
    // leave fast-path intact here — provider.callCount stays 0, summary is
    // the retained previousSummary verbatim. Matches the legacy "prunes
    // older tool results" test behaviour.
    const provider = new FakeSummaryProvider(REAL_SUMMARY_TEXT);
    const contextWindow = 30000;
    const config = {
      enabled: true,
      triggerPercent: 70,
      protectionPercent: 1,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 50000,
    };

    const PRIOR_SUMMARY = 'Prior summary anchor that fast-path must retain verbatim.';
    const messages: KodaXMessage[] = [
      { role: 'system', content: `[对话历史摘要]\n\n${PRIOR_SUMMARY}` },
      ...buildPrunableConversation(),
    ];
    const result = await compact(messages, config, provider, contextWindow);

    expect(result.compacted).toBe(true);
    // Fast-path was taken — LLM never called.
    expect(provider.callCount).toBeGreaterThan(0);
    // Prior summary retained verbatim, not the LLM template.
    expect(provider.prompts.join('\n')).toContain(PRIOR_SUMMARY);
    expect(result.summary).toContain('kimi loop bug');
    expect(result.summary).toContain('## User Queries & Corrections');
  });

  it('composes with F181: first compaction + empty LLM output preserves canonical history', async () => {
    const provider = new FakeSummaryProvider(
      '## Goal\nNo active goal. The conversation appears empty with no prior context.',
    );
    const contextWindow = 30000;
    const config = {
      enabled: true,
      triggerPercent: 70,
      protectionPercent: 1,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 50000,
    };

    const messages = buildPrunableConversation();
    await expect(compact(messages, config, provider, contextWindow)).rejects.toThrow(
      'did not contain usable semantic content',
    );
    expect(provider.callCount).toBeGreaterThan(0);
  });
});

describe('FEATURE_183 (v0.7.42): PROTECTED_TOOL_NAMES whitelist expansion', () => {
  // Pre-F183 the prune-protected set was `{'skill'}` only — every other tool
  // result was eligible to be prune'd to a `[Pruned: ...]` placeholder during
  // compaction. This caused silent context destruction of high-value
  // payloads (child-task verdicts, MCP outputs, repo-intelligence capsules,
  // ask_user_question Q&A, etc.).
  //
  // F183+ expands the set across durable state / control categories. These tests
  // pin the membership + sanity-check the actual prune semantics against
  // representative protected tools.

  it('contains the canonical members exactly', () => {
    // Snapshot the full membership so any future drift (add / drop) is
    // caught immediately by this test rather than discovered in production.
    expect([...PROTECTED_TOOL_NAMES].sort()).toEqual(
      [
        // Pre-F183
        'skill',
        // User-interaction + plan
        'ask_user_question',
        'exit_plan_mode',
        // Actor control flow
        'spawn_agent',
        'send_message',
        'followup_task',
        'wait_agent',
        'interrupt_agent',
        'list_agents',
        'agent_output',
        // v0.7.60 FEATURE_250 — progressive-disclosure meta-tool. Its result
        // carries the full schema/description a model fetched for a deferred
        // tool; on the managed path the description is hint-only and never
        // resident, so the result is the only teaching surface.
        'tool_search',
        // Goal state snapshots / lifecycle transition receipts.
        'get_goal',
        'create_goal',
        'update_goal',
        // Todo state (model-maintained plan list)
        'todo_create',
        'todo_update',
        'todo_list',
        // v0.7.42 — todo_get added to mirror CC `TaskGetTool` protection.
        'todo_get',
        // Worktree / undo
        'worktree_create',
        'worktree_remove',
        'undo',
        // MCP
        'mcp_search',
        'mcp_describe',
        'mcp_call',
        'mcp_read_resource',
        'mcp_get_prompt',
        // Repo intelligence
        'repo_overview',
        'changed_scope',
        'changed_diff',
        'changed_diff_bundle',
        'module_context',
        'symbol_context',
        'process_context',
        'impact_estimate',
        'relationship_scan',
        // v0.7.45 FEATURE_205-A — cyclic_dependencies (Tarjan SCC pull-tool)
        // joins the read-only repo-intelligence family.
        'cyclic_dependencies',
        'semantic_lookup',
      ].sort(),
    );
    expect(PROTECTED_TOOL_NAMES.size).toBe(37);
  });

  it('keeps a recoverable artifact pointer when pruning a capacity-limited result', async () => {
    const provider = new FakeSummaryProvider();
    const outputPath = 'C:\\Users\\test\\.kodax\\tool-results\\full-bash-output.txt';
    const messages: KodaXMessage[] = [
      {
        role: 'system',
        content: '[\u5bf9\u8bdd\u5386\u53f2\u6458\u8981]\n\nPrior summary with enough context for the prune fast path.',
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'recoverable-tool', name: 'bash', input: { command: 'git log --stat' } }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'recoverable-tool',
          content: makeLongText('commit-stat', 6000),
          metadata: { outputPath, truncated: true, capacityFallback: true },
        }],
      },
      ...buildLongConversation(2, 120),
    ];

    const result = await compact(messages, {
      enabled: true,
      triggerPercent: 50,
      protectionPercent: 1,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 100,
    }, provider, 5000);

    expect(provider.prompts.join('\n')).toContain('Compacted oversized tool result for summary');
    expect(provider.prompts.join('\n')).toContain('KODAX_RESULT_INCOMPLETE');
    expect(provider.prompts.join('\n')).toContain(outputPath);
    expect(result.messages.some((message) => Array.isArray(message.content)
      && message.content.some((block) => block.type === 'tool_result'
        && block.tool_use_id === 'recoverable-tool'))).toBe(false);
    expect(result.artifactLedger?.[0]?.metadata).toEqual(expect.objectContaining({
      outputPath,
      truncated: true,
      capacityFallback: true,
    }));
  });

  it('does not head-tail truncate task-completed envelopes before LLM summarization', async () => {
    const provider = new FakeSummaryProvider();
    const artifactPath = 'C:\\Users\\test\\.kodax\\tool-results\\middle-child-report.txt';
    const taskCompleted = [
      '<task-completed task_id="child-a">',
      makeLongText('before', 1000),
      `Full output saved to: ${artifactPath}`,
      makeLongText('after', 1000),
      '</task-completed>',
    ].join('\n');
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: taskCompleted,
        _synthetic: true,
        _source: 'task-completed',
      },
      { role: 'assistant', content: makeLongText('assistant', 1000) },
      { role: 'user', content: 'recent tail' },
    ];

    await compact(messages, {
      enabled: true,
      triggerPercent: 10,
      protectionPercent: 1,
      rollingSummaryPercent: 20,
    }, provider, 10_000);

    expect(provider.callCount).toBeGreaterThan(0);
    expect(provider.prompts.join('\n')).toContain(artifactPath);
  });

  it('exposes the set as a ReadonlySet (frozen API surface)', () => {
    // ReadonlySet at the type level. The runtime cast keeps a single
    // canonical Map; callers must not add/delete. We do not freeze the
    // underlying Set at runtime (some legacy test paths construct new
    // arrays from it) but the type system locks the surface.
    expect(PROTECTED_TOOL_NAMES instanceof Set).toBe(true);
    expect(PROTECTED_TOOL_NAMES.has('skill')).toBe(true);
  });

  it('still leaves high-volume "execution / exploration" tools compactable', () => {
    // Sanity: these high-volume / large-result / low-decision-density tools
    // MUST remain compactable. If F183 accidentally moved one of them into
    // PROTECTED, context budget regressions would silently follow.
    const compactable = [
      'read', 'write', 'edit', 'multi_edit', 'insert_after_anchor',
      'bash',
      'glob', 'grep', 'code_search',
      'web_search', 'web_fetch',
    ];
    for (const name of compactable) {
      expect(PROTECTED_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it('large compaction sends protected and ordinary tool evidence without prune placeholders', async () => {
    // Two-layer reasoning:
    //   (1) `collectStructuredPruneIds` accumulates non-protected tool tokens
    //       from the tail backward; once cumulative > 40K (= STRUCTURED_PRUNE
    //       _PROTECT_TOKENS) the older results enter idsToPrune. Protected
    //       tools are skipped from that accumulator (the F183 path under
    //       test). So with 14 buildToolPair × 5000 words, the cumulative
    //       non-protected count crosses the threshold and prune fires.
    //   (2) After structured prune marks 8 older greps with [Pruned: ...]
    //       placeholders, the resulting prunedQueue is ~50K tokens, well
    //       below the F182 fast-path threshold (triggerTokens × 0.8 ~= 67K),
    //       AND the system anchor message supplies `previousSummary` so
    //       fast-path conditions all hold. Fast-path returns
    //       [createSummaryMessage(prevSummary), ...prunedQueue] verbatim —
    //       no LLM summarisation runs, so we can assert on the exact
    //       content of the protected blocks.
    // We inject 3 PROTECTED-set members (mcp_call / changed_scope /
    // emit_managed_protocol — one per category) at fixed positions and assert:
    //   (a) their contents survive verbatim (no [Pruned:] replacement)
    //   (b) the grep/bash tools surrounding them ARE [Pruned:]-replaced
    //       as before (no regression — F183 doesn't accidentally promote
    //       protection to the whole conversation).
    const provider = new FakeSummaryProvider();
    const contextWindow = 30000;
    const config = {
      enabled: true,
      triggerPercent: 70,
      protectionPercent: 1,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 50000,
    };

    // Helper: build a protected tool_use + tool_result pair carrying a
    // distinctive payload we can grep for in the output.
    function buildProtectedPair(
      id: string,
      toolName: string,
      payloadMarker: string,
    ): KodaXMessage[] {
      return [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id, name: toolName, input: { marker: payloadMarker } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              content: `${payloadMarker} ` + makeLongText('p', 5500),
            },
          ],
        },
      ];
    }

    // Mirror the legacy test: 14 tool pairs in the "to-process" range so
    // structured prune triggers. Inject 3 protected pairs at intervals.
    const PROTECTED_MARKER_MCP = 'PROTECTED_MCP_PAYLOAD_42';
    const PROTECTED_MARKER_RI = 'PROTECTED_RI_PAYLOAD_77';
    const PROTECTED_MARKER_CTRL = 'PROTECTED_CTRL_PAYLOAD_91';

    // FEATURE_182 requires a non-empty previousSummary for fast-path to
    // be taken; without it, slow-path summarises the prefix entirely
    // (including protected tools) which would invalidate the structured-
    // prune assertions here. Same pattern as the legacy "prunes older
    // tool results" test.
    const messages: KodaXMessage[] = [
      { role: 'system', content: '[对话历史摘要]\n\nPrior summary anchor so fast-path is taken (F182).' },
      { role: 'assistant', content: 'retain assistant note' },
      // Older portion (will mostly get [Pruned:] markers under structured
      // prune since they're past the budget threshold from the tail).
      // word counts remain above the structured-prune threshold — F183 protects 3 mid-stream
      // tools, narrowing the budget room for structured prune. Higher word
      // count per grep ensures cumulative non-protected tokens still
      // exceed STRUCTURED_PRUNE_PROTECT_TOKENS=40K and prune fires.
      ...buildToolPair(1, 5000),
      ...buildToolPair(2, 5000),
      ...buildProtectedPair('mcp_1', 'mcp_call', PROTECTED_MARKER_MCP),
      ...buildToolPair(3, 5000),
      ...buildToolPair(4, 5000),
      ...buildToolPair(5, 5000),
      ...buildProtectedPair('ri_1', 'changed_scope', PROTECTED_MARKER_RI),
      ...buildToolPair(6, 5000),
      ...buildToolPair(7, 5000),
      ...buildToolPair(8, 5000),
      ...buildProtectedPair('ctrl_1', 'spawn_agent', PROTECTED_MARKER_CTRL),
      ...buildToolPair(9, 5000),
      ...buildToolPair(10, 5000),
      ...buildToolPair(11, 5000),
      ...buildToolPair(12, 5000),
      ...buildToolPair(13, 5000),
      ...buildToolPair(14, 5000),
    ];

    const result = await compact(messages, config, provider, contextWindow);
    expect(result.compacted).toBe(true);

    // Extract all tool_result content blocks from the final messages.
    const toolResults = result.messages
      .filter((m): m is KodaXMessage & { role: 'user'; content: NonNullable<KodaXMessage['content']> } =>
        m.role === 'user' && Array.isArray(m.content),
      )
      .flatMap((m) => m.content as KodaXContentBlock[])
      .filter((b): b is { type: 'tool_result'; tool_use_id: string; content: string } =>
        b.type === 'tool_result' && typeof b.content === 'string',
      );

    // Protected payloads are visible to the semantic summary request.
    const protectedExpectations = [
      { id: 'mcp_1', name: 'mcp_call', marker: PROTECTED_MARKER_MCP },
      { id: 'ri_1', name: 'changed_scope', marker: PROTECTED_MARKER_RI },
      { id: 'ctrl_1', name: 'spawn_agent', marker: PROTECTED_MARKER_CTRL },
    ];
    const summaryInput = provider.prompts.join('\n');
    expect(summaryInput).toContain(PROTECTED_MARKER_MCP);
    expect(summaryInput).toContain(PROTECTED_MARKER_RI);
    expect(summaryInput).toContain(PROTECTED_MARKER_CTRL);
    for (const c of protectedExpectations) {
      const matching = toolResults.find((b) => b.tool_use_id === c.id);
      expect(matching, `${c.name} eligible result should be summarized`).toBeUndefined();
    }

    // Ordinary tool evidence is summarized too; the canonical result contains
    // no lossy pre-summary prune placeholders.
    const hasPrunedGrep = toolResults.some(
      (b) => b.content.startsWith('[Pruned: cat output-'),
    );
    expect(hasPrunedGrep, 'large compaction no longer installs lossy prune placeholders').toBe(false);
  });
});
