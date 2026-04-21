import { describe, expect, it } from 'vitest';
import type {
  KodaXManagedTask,
  KodaXMessage,
  KodaXOptions,
  KodaXResult,
  KodaXTaskStatus,
} from '../../types.js';
import {
  buildUserFacingMessages,
  extractFinalAssistantText,
  isUnconvergedVerdict,
  normalizeLoadedSessionMessages,
  reshapeToUserConversation,
} from './round-boundary.js';

function makeResult(overrides: Partial<KodaXResult> = {}): KodaXResult {
  return {
    success: true,
    lastText: 'the final answer',
    messages: [
      { role: 'user', content: 'You are the Evaluator role...' },
      { role: 'assistant', content: '<verdict>accept</verdict>' },
    ],
    sessionId: 'sess-test',
    ...overrides,
  } as KodaXResult;
}

function makeManagedTask(status: KodaXTaskStatus, summary = 'stub summary'): KodaXManagedTask {
  return {
    contract: {} as KodaXManagedTask['contract'],
    roleAssignments: [],
    workItems: [],
    evidence: {} as KodaXManagedTask['evidence'],
    verdict: {
      status,
      decidedByAssignmentId: 'test',
      summary,
    },
  };
}

function makeOptions(initial: KodaXMessage[] = []): KodaXOptions {
  return {
    session: { initialMessages: initial },
  } as unknown as KodaXOptions;
}

describe('round-boundary/isUnconvergedVerdict', () => {
  it('treats running as unconverged (placeholder path)', () => {
    expect(isUnconvergedVerdict('running')).toBe(true);
  });

  it('treats planned as unconverged (defensive; should not reach round exit)', () => {
    expect(isUnconvergedVerdict('planned')).toBe(true);
  });

  it('treats completed as converged (has a real user-facing answer)', () => {
    expect(isUnconvergedVerdict('completed')).toBe(false);
  });

  it('treats blocked as converged (blocked reason is a valid user answer)', () => {
    expect(isUnconvergedVerdict('blocked')).toBe(false);
  });

  it('treats failed as converged (error message is a valid user answer)', () => {
    expect(isUnconvergedVerdict('failed')).toBe(false);
  });

  it('treats undefined as converged (SA paths have no managedTask)', () => {
    expect(isUnconvergedVerdict(undefined)).toBe(false);
  });
});

describe('round-boundary/extractFinalAssistantText', () => {
  it('prefers non-empty result.lastText', () => {
    const result = {
      lastText: 'the answer',
      messages: [{ role: 'assistant', content: 'ignored' }],
    } as unknown as KodaXResult;
    expect(extractFinalAssistantText(result)).toBe('the answer');
  });

  it('falls back to last message content when lastText is empty', () => {
    const result = {
      lastText: '',
      messages: [{ role: 'assistant', content: 'from message' }],
    } as unknown as KodaXResult;
    expect(extractFinalAssistantText(result)).toBe('from message');
  });

  it('returns empty string when result is undefined', () => {
    expect(extractFinalAssistantText(undefined)).toBe('');
  });

  it('concatenates text blocks from multi-modal content', () => {
    const result = {
      lastText: '',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
      }],
    } as unknown as KodaXResult;
    expect(extractFinalAssistantText(result)).toBe('part one part two');
  });
});

describe('round-boundary/buildUserFacingMessages', () => {
  it('appends {user, assistant} when initial is empty', () => {
    const out = buildUserFacingMessages([], 'hi there', 'hello back');
    expect(out).toEqual([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'hello back' },
    ]);
  });

  it('appends only assistant when initial already ends with matching user prompt (CLI REPL pre-push path)', () => {
    const initial: KodaXMessage[] = [
      { role: 'user', content: 'hi there' },
    ];
    const out = buildUserFacingMessages(initial, 'hi there', 'hello back');
    expect(out).toEqual([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'hello back' },
    ]);
  });

  it('appends both when last initial user does not match prompt', () => {
    const initial: KodaXMessage[] = [
      { role: 'user', content: 'an earlier question' },
      { role: 'assistant', content: 'an earlier answer' },
    ];
    const out = buildUserFacingMessages(initial, 'a new question', 'a new answer');
    expect(out).toEqual([
      { role: 'user', content: 'an earlier question' },
      { role: 'assistant', content: 'an earlier answer' },
      { role: 'user', content: 'a new question' },
      { role: 'assistant', content: 'a new answer' },
    ]);
  });

  it('does not mutate the initial array', () => {
    const initial: KodaXMessage[] = [{ role: 'user', content: 'existing' }];
    const initialLen = initial.length;
    buildUserFacingMessages(initial, 'different prompt', 'answer');
    expect(initial.length).toBe(initialLen);
  });

  it('dedup works against multi-modal user message (text + image blocks)', () => {
    const initial: KodaXMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this screenshot' },
        { type: 'image', path: '/tmp/a.png', mediaType: 'image/png' },
      ],
    }];
    const out = buildUserFacingMessages(initial, 'describe this screenshot', 'it shows X');
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: 'assistant', content: 'it shows X' });
  });

  it('attaches inputArtifacts as image blocks when prompt is new', () => {
    const out = buildUserFacingMessages(
      [],
      'describe this',
      'it shows X',
      [{ kind: 'image', path: '/tmp/pic.png', mediaType: 'image/png', source: 'user-inline' }],
    );
    const userMsg = out[0];
    expect(userMsg.role).toBe('user');
    expect(Array.isArray(userMsg.content)).toBe(true);
  });
});

describe('round-boundary/reshapeToUserConversation', () => {
  it('passes through when result.messages is undefined', () => {
    const result = makeResult({ messages: undefined as unknown as KodaXMessage[] });
    const out = reshapeToUserConversation(result, makeOptions(), 'user prompt');
    expect(out).toBe(result);
  });

  it('reshapes on completed verdict to clean {user, assistant} dialog', () => {
    const result = makeResult({
      managedTask: makeManagedTask('completed', 'done'),
      lastText: 'the answer to your question',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'what is X?');
    expect(out.messages).toEqual([
      { role: 'user', content: 'what is X?' },
      { role: 'assistant', content: 'the answer to your question' },
    ]);
  });

  it('reshapes on blocked verdict (blocked reason IS a valid user answer) — Q1', () => {
    const result = makeResult({
      managedTask: makeManagedTask('blocked', 'need OAuth token'),
      lastText: 'Blocked: please authorize via browser',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'connect the MCP');
    expect(out.messages).toEqual([
      { role: 'user', content: 'connect the MCP' },
      { role: 'assistant', content: 'Blocked: please authorize via browser' },
    ]);
  });

  it('reshapes on failed verdict (error message IS a valid user answer) — Q1', () => {
    const result = makeResult({
      success: false,
      managedTask: makeManagedTask('failed', 'parser failure'),
      lastText: 'Evaluator protocol parse failed after 3 retries',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'refactor X');
    expect(out.messages?.[1].content).toBe(
      'Evaluator protocol parse failed after 3 retries',
    );
  });

  it('falls back on running verdict (unconverged, placeholder) — Q1', () => {
    const result = makeResult({
      managedTask: makeManagedTask('running', 'Task is running...'),
      lastText: 'Task is running...',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'the prompt');
    expect(out).toBe(result);
  });

  it('falls back on planned verdict — Q1', () => {
    const result = makeResult({
      managedTask: makeManagedTask('planned', 'scheduled'),
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'the prompt');
    expect(out).toBe(result);
  });

  it('reshapes when result has no managedTask (SA fast-path) — Q1', () => {
    const result = makeResult({
      lastText: 'direct SA answer',
      managedTask: undefined,
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'direct question');
    expect(out.messages).toEqual([
      { role: 'user', content: 'direct question' },
      { role: 'assistant', content: 'direct SA answer' },
    ]);
  });

  it('falls back when interrupted with no finalText', () => {
    const result = makeResult({
      interrupted: true,
      lastText: '',
      messages: [{ role: 'assistant', content: '' }],
      managedTask: makeManagedTask('completed'),
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'prompt');
    expect(out).toBe(result);
  });

  it('preserves prior user conversation in clean history', () => {
    const priorMessages: KodaXMessage[] = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ];
    const result = makeResult({
      managedTask: makeManagedTask('completed'),
      lastText: 'round 2 answer',
    });
    const out = reshapeToUserConversation(result, makeOptions(priorMessages), 'round 2 Q');
    expect(out.messages).toEqual([
      ...priorMessages,
      { role: 'user', content: 'round 2 Q' },
      { role: 'assistant', content: 'round 2 answer' },
    ]);
  });

  it('pre-extracts artifactLedger onto the reshaped result', () => {
    const messagesWithTool: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tu_1',
          name: 'read_file',
          input: { path: 'foo.ts' },
        }],
      },
    ];
    const result = makeResult({
      messages: messagesWithTool,
      managedTask: makeManagedTask('completed'),
      lastText: 'summary',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'prompt');
    expect(out.artifactLedger).toBeDefined();
  });

  it('recomputes contextTokenSnapshot based on the clean messages (Q2)', () => {
    const result = makeResult({
      managedTask: makeManagedTask('completed'),
      lastText: 'hi',
      contextTokenSnapshot: {
        currentTokens: 9999,
        baselineEstimatedTokens: 9999,
        source: 'api',
        usage: { inputTokens: 9999, outputTokens: 1, totalTokens: 10000 },
      },
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'hi');
    expect(out.contextTokenSnapshot).toBeDefined();
    expect(out.contextTokenSnapshot!.currentTokens).toBeLessThan(100);
    expect(out.contextTokenSnapshot!.usage).toBeUndefined();
  });

  it('preserves result.sessionId / signal / success / lastText after reshape', () => {
    const result = makeResult({
      success: false,
      signal: 'BLOCKED',
      managedTask: makeManagedTask('blocked', 'blocked summary'),
      lastText: 'blocked answer',
      sessionId: 'unique-sess',
    });
    const out = reshapeToUserConversation(result, makeOptions(), 'prompt');
    expect(out.success).toBe(false);
    expect(out.signal).toBe('BLOCKED');
    expect(out.sessionId).toBe('unique-sess');
    expect(out.lastText).toBe('blocked answer');
  });
});

describe('round-boundary/normalizeLoadedSessionMessages (Q4)', () => {
  it('passes clean {user, assistant} dialog through unchanged', () => {
    const clean: KodaXMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'sure' },
    ];
    expect(normalizeLoadedSessionMessages(clean)).toEqual(clean);
  });

  it('drops Evaluator role-prompt worker trace at the tail', () => {
    const polluted: KodaXMessage[] = [
      { role: 'user', content: 'what is X?' },
      { role: 'assistant', content: 'round 1 answer' },
      {
        role: 'user',
        content: 'You are the Evaluator role. Review the Generator output...',
      },
      { role: 'assistant', content: '<kodax-task-verdict>accept</kodax-task-verdict>' },
    ];
    const normalized = normalizeLoadedSessionMessages(polluted);
    expect(normalized).toEqual([
      { role: 'user', content: 'what is X?' },
      { role: 'assistant', content: 'round 1 answer' },
    ]);
  });

  it('drops Scout role-prompt worker trace at the tail', () => {
    const polluted: KodaXMessage[] = [
      { role: 'user', content: 'prior Q' },
      { role: 'assistant', content: 'prior A' },
      {
        role: 'user',
        content: 'You are the Scout role. <original user question wrapped>',
      },
      { role: 'assistant', content: 'summary' },
    ];
    const normalized = normalizeLoadedSessionMessages(polluted);
    expect(normalized).toEqual([
      { role: 'user', content: 'prior Q' },
      { role: 'assistant', content: 'prior A' },
    ]);
  });

  it('drops Planner and Generator role-prompt wrappers too', () => {
    expect(
      normalizeLoadedSessionMessages([
        {
          role: 'user',
          content: 'You are the Planner role. Break down the task.',
        },
        { role: 'assistant', content: '<kodax-task-contract>...' },
      ]),
    ).toEqual([]);

    expect(
      normalizeLoadedSessionMessages([
        {
          role: 'user',
          content: 'You are the Generator role. Execute the plan.',
        },
        { role: 'assistant', content: 'generator output' },
      ]),
    ).toEqual([]);
  });

  it('returns fully polluted sessions as empty (pure worker trace)', () => {
    const fullyPolluted: KodaXMessage[] = [
      {
        role: 'user',
        content: 'You are the Evaluator role. Review the Generator...',
      },
      { role: 'assistant', content: '<verdict>accept</verdict>' },
    ];
    expect(normalizeLoadedSessionMessages(fullyPolluted)).toEqual([]);
  });

  it('handles empty input', () => {
    expect(normalizeLoadedSessionMessages([])).toEqual([]);
  });

  it('does not over-match: "You are..." in normal content is not truncated', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Please explain what "You are amazing" means' },
      { role: 'assistant', content: 'It is a compliment.' },
    ];
    expect(normalizeLoadedSessionMessages(messages)).toEqual(messages);
  });

  it('does not mutate input array', () => {
    const polluted: KodaXMessage[] = [
      { role: 'user', content: 'valid' },
      { role: 'assistant', content: 'valid' },
      { role: 'user', content: 'You are the Evaluator role...' },
      { role: 'assistant', content: 'verdict' },
    ];
    const originalLen = polluted.length;
    normalizeLoadedSessionMessages(polluted);
    expect(polluted.length).toBe(originalLen);
  });
});
