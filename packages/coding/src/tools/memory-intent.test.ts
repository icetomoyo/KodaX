import { describe, expect, it, vi } from 'vitest';

import { memoryProposalRevision, type MemoryManagementController } from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';
import { getBuiltinRegisteredToolDefinition } from './registry.js';
import {
  activateMemoryIntentTool,
  createMemoryIntentBinding,
  extractPresentedMemoryTargetRefs,
  MEMORY_INTENT_TOOL_DESCRIPTION,
  MEMORY_INTENT_TOOL_NAME,
  MEMORY_INTENT_TOOL_SCHEMA,
  toolMemoryIntent,
} from './memory-intent.js';

function controlPlane(overrides: Partial<MemoryManagementController>): MemoryManagementController {
  return overrides as MemoryManagementController;
}

function presentationTranscript(visibleAssistantText: string) {
  return [{ role: 'user', content: 'What do you remember and what needs my decision?' }, {
    role: 'assistant',
    content: [{
      type: 'tool_use', id: 'list-call', name: 'memory_intent', input: { operation: 'list' },
    }, {
      type: 'tool_use', id: 'decisions-call', name: 'memory_intent', input: { operation: 'decisions' },
    }],
  }, {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'list-call',
      content: '[Memory list]\n1. Alpha (memdir:a.md; version=sha256:a)\nAlpha body.\n2. Beta (memdir:b.md; version=sha256:b)\nBeta body.',
    }, {
      type: 'tool_result',
      tool_use_id: 'decisions-call',
      content: '[Memory decisions]\n1. Alpha decision (memory:proposal-a@aaaaaaaaaaaaaaaa)\n2. Beta decision (memory:proposal-b@bbbbbbbbbbbbbbbb)',
    }],
  }, { role: 'assistant', content: visibleAssistantText }, {
    role: 'user', content: 'Handle the first item.',
  }];
}

describe('natural-language Memory management tool', () => {
  it('exposes ordinary Memory operations and exceptional decision operations', () => {
    const definition = getBuiltinRegisteredToolDefinition(MEMORY_INTENT_TOOL_NAME);

    expect(definition).toMatchObject({
      name: 'memory_intent',
      description: MEMORY_INTENT_TOOL_DESCRIPTION,
      input_schema: MEMORY_INTENT_TOOL_SCHEMA,
      requiredParams: ['operation'],
      sideEffect: 'mutates-state',
    });
    expect(MEMORY_INTENT_TOOL_DESCRIPTION).toContain('Safe requests apply');
    expect(MEMORY_INTENT_TOOL_SCHEMA.properties.operation.enum).toEqual([
      'list',
      'remember',
      'correct',
      'forget',
      'decisions',
      'show',
      'approve',
      'reject',
    ]);
  });

  it('applies an explicit remember request and reports the durable receipt', async () => {
    const remember = vi.fn().mockResolvedValue({
      status: 'remembered',
      changedRefIds: ['memdir:preference.md'],
      proposalIds: ['memory-review-p1'],
      warnings: [],
    });
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({
        text: 'Please remember that I prefer concise answers.',
        turnId: 'turn-remember',
      }),
      controlPlane: controlPlane({ remember }),
    });

    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: 'I prefer concise answers.',
      userQuote: 'Please remember that I prefer concise answers.',
      claimKind: 'preference',
      claimKey: 'user.preference.response-length',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('Memory remembered');
    expect(result).toContain('memdir:preference.md');
    expect(result).not.toContain('captured');
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({
      statement: 'I prefer concise answers.',
      claimKind: 'preference',
      claimKey: 'user.preference.response-length',
      evidenceRef: expect.stringMatching(/^user-intent:[a-f0-9]{24}$/),
    }));
  });

  it.each([
    ['One more thing: please remember that I use Vim.', 'I use Vim.'],
    ['Please remember that I use Vim. Thank you.', 'I use Vim.'],
    ['Remember, I prefer Vim.', 'I prefer Vim.'],
    ["Remember, I don't store build artifacts.", "I don't store build artifacts."],
    ['请记住，我喜欢 Vim。', '我喜欢 Vim'],
    ['我的编辑器偏好是 VS Code，请记住。', '我的编辑器偏好是 VS Code'],
  ])('accepts a natural affirmative claim span: %s', async (text, statement) => {
    const remember = vi.fn().mockResolvedValue({
      status: 'remembered',
      changedRefIds: ['memdir:editor.md'],
      proposalIds: [],
      warnings: [],
    });
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-natural-remember' }),
      controlPlane: controlPlane({ remember }),
    });
    const instruction = text.includes('Thank you')
      ? 'Please remember that I use Vim.'
      : text;

    const result = await toolMemoryIntent({
      operation: 'remember',
      statement,
      userQuote: instruction,
      claimKind: 'preference',
      claimKey: 'user.preference.editor',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('Memory remembered');
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ statement }));
  });

  it('binds the remembered statement to the same affirmative clause', async () => {
    const remember = vi.fn();
    const text = 'Do not remember that our package manager is npm. Please remember that I prefer concise answers.';
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-mixed-remember' }),
      controlPlane: controlPlane({ remember }),
    });

    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: 'our package manager is npm',
      userQuote: 'Please remember that I prefer concise answers.',
      claimKind: 'fact',
      claimKey: 'project.package-manager',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('needs_clarification');
    expect(remember).not.toHaveBeenCalled();
  });

  it('reports a successfully handled explicit claim for episode-review de-duplication', async () => {
    const onHandledOperation = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({
        text: 'Please remember: This project uses npm.',
        turnId: 'turn-handled',
      }),
      controlPlane: controlPlane({
        remember: vi.fn().mockResolvedValue({
          status: 'remembered',
          changedRefIds: ['memdir:package-manager.md'],
          proposalIds: [],
          warnings: [],
        }),
      }),
      onHandledOperation,
    });

    await toolMemoryIntent({
      operation: 'remember',
      statement: 'This project uses npm.',
      userQuote: 'Please remember: This project uses npm.',
      claimKind: 'fact',
      claimKey: 'project.package-manager',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(onHandledOperation).toHaveBeenCalledWith({
      operation: 'remember',
      disposition: 'applied',
      statement: 'This project uses npm.',
      claimKey: 'project.package-manager',
      targetRefIds: ['memdir:package-manager.md'],
    });
  });

  it('rejects a fabricated quote and never upgrades model inference into user authorization', async () => {
    const remember = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({
        text: 'I remember checking the code yesterday.',
        turnId: 'turn-narrative',
      }),
      controlPlane: controlPlane({ remember }),
    });

    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: 'Always inspect code first.',
      userQuote: 'Please remember to inspect code first.',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(result).toContain('current user turn');
    expect(remember).not.toHaveBeenCalled();
  });

  it('rejects a fabricated statement even when a generic authorizing quote is real', async () => {
    const remember = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text: 'Please remember.', turnId: 'turn-generic' }),
      controlPlane: controlPlane({ remember }),
    });

    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: 'The user prefers Vim.',
      userQuote: 'remember',
      claimKind: 'preference',
      claimKey: 'user.preference.editor',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(result).toContain('explicitly authorize');
    expect(remember).not.toHaveBeenCalled();
  });

  it('asks for claim identity instead of storing an unclassified preference', async () => {
    const remember = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({
        text: 'Remember that I prefer Vim.',
        turnId: 'turn-preference',
      }),
      controlPlane: controlPlane({ remember }),
    });

    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: 'I prefer Vim.',
      userQuote: 'Remember that I prefer Vim.',
      claimKind: 'preference',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('needs_clarification');
    expect(result).toContain('claimKey');
    expect(remember).not.toHaveBeenCalled();
  });

  it('returns the durable decision ref when an explicit claim conflicts', async () => {
    const remember = vi.fn().mockResolvedValue({
      status: 'needs_review',
      changedRefIds: [],
      proposalIds: ['memory:editor-conflict'],
      reason: 'The editor preference conflicts with accepted Memory',
      warnings: [],
    });
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({
        text: 'Remember that I prefer Vim.',
        turnId: 'turn-editor-conflict',
      }),
      controlPlane: controlPlane({ remember }),
    });

    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: 'I prefer Vim.',
      userQuote: 'Remember that I prefer Vim.',
      claimKind: 'preference',
      claimKey: 'user.preference.editor',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('needs_review');
    expect(result).toContain('memory:editor-conflict');
  });

  it('lists accepted Memory with useful ref ids and bodies for natural-language follow-up', async () => {
    const ref = {
      kind: 'memdir' as const,
      id: 'memdir:release.md',
      scope: 'project' as const,
      owner: 'project' as const,
      lifecycle: 'active' as const,
      authority: 'approved_write' as const,
      visibility: 'prompt_safe' as const,
      sourceRefs: [],
      relatedRefs: [],
      title: 'Release checks',
    };
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text: 'What do you remember?', turnId: 'turn-list' }),
      controlPlane: controlPlane({
        listRefs: vi.fn().mockResolvedValue([ref]),
        readRef: vi.fn().mockResolvedValue({
          ref,
          body: 'Run focused tests before release.',
          bodyFingerprint: 'sha256:body',
          readAt: '2026-08-10T00:00:00.000Z',
          warnings: [],
        }),
      }),
    });

    const result = await toolMemoryIntent(
      { operation: 'list' },
      { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext,
    );

    expect(result).toContain('memdir:release.md');
    expect(result).toContain('Run focused tests before release.');
  });

  it('forgets only an exact ref backed by a quote from the current user turn', async () => {
    const ref = {
      kind: 'memdir' as const,
      id: 'memdir:release.md',
      scope: 'project' as const,
      owner: 'project' as const,
      lifecycle: 'active' as const,
      authority: 'approved_write' as const,
      visibility: 'prompt_safe' as const,
      sourceRefs: [],
      relatedRefs: [],
      claimKey: 'project.release-check',
    };
    const forgetRef = vi.fn().mockResolvedValue({
      refId: 'memdir:release.md',
      operation: 'forget',
      acknowledged: true,
      residualSourceRefs: [],
      warnings: [],
    });
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({
        text: 'Please forget memdir:release.md.',
        turnId: 'turn-forget',
      }),
      controlPlane: controlPlane({
        listRefs: vi.fn().mockResolvedValue([ref]),
        readRef: vi.fn().mockResolvedValue({
          ref,
          body: 'Run build before release.',
          bodyFingerprint: 'sha256:body',
          readAt: '2026-08-10T00:00:00.000Z',
          warnings: [],
        }),
        forgetRef,
      }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:release.md',
      userQuote: 'Please forget memdir:release.md.',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('Memory forgotten');
    expect(forgetRef).toHaveBeenCalledWith('memdir:release.md', undefined);
  });

  it('binds a destructive target to the same affirmative clause', async () => {
    const forgetRef = vi.fn();
    const text = 'Do not forget memdir:A.md. Forget memdir:B.md.';
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-mixed-forget' }),
      controlPlane: controlPlane({ forgetRef }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:A.md',
      userQuote: 'Forget memdir:B.md.',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(forgetRef).not.toHaveBeenCalled();
  });

  it('resolves a described Memory after listing instead of requiring an opaque ref', async () => {
    const releaseRef = {
      kind: 'memdir' as const,
      id: 'memdir:release.md',
      scope: 'project' as const,
      owner: 'project' as const,
      lifecycle: 'active' as const,
      authority: 'approved_write' as const,
      visibility: 'prompt_safe' as const,
      sourceRefs: [],
      relatedRefs: [],
      title: 'Release checks',
    };
    const editorRef = { ...releaseRef, id: 'memdir:editor.md', title: 'Editor preference' };
    const forgetRef = vi.fn().mockResolvedValue({
      refId: releaseRef.id,
      operation: 'forget',
      acknowledged: true,
      residualSourceRefs: [],
      warnings: [],
    });
    const text = '请忘掉提交前运行 build 这条记忆。';
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-natural-forget' }),
      controlPlane: controlPlane({
        listRefs: vi.fn().mockResolvedValue([releaseRef, editorRef]),
        readRef: vi.fn().mockImplementation(async (ref) => ({
          ref,
          body: ref.id === releaseRef.id ? '提交前运行 build。' : '首选 VSCode。',
          bodyFingerprint: 'sha256:body',
          readAt: '2026-08-10T00:00:00.000Z',
          warnings: [],
        })),
        forgetRef,
      }),
    });

    await memoryIntent({ operation: 'list' });
    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: releaseRef.id,
      userQuote: text,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('Memory forgotten');
    expect(forgetRef).toHaveBeenCalledWith(releaseRef.id, 'sha256:body');
  });

  it('resolves one recently listed Memory for a deictic correction', async () => {
    const ref = {
      kind: 'memdir' as const,
      id: 'memdir:release.md',
      scope: 'project' as const,
      owner: 'project' as const,
      lifecycle: 'active' as const,
      authority: 'approved_write' as const,
      visibility: 'prompt_safe' as const,
      sourceRefs: [],
      relatedRefs: [],
      title: 'Release checks',
    };
    const remember = vi.fn().mockResolvedValue({
      status: 'updated',
      changedRefIds: [ref.id],
      proposalIds: [],
      warnings: [],
    });
    const text = '请把刚才那条改成发布前运行 npm run build。';
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-natural-correct' }),
      controlPlane: controlPlane({
        listRefs: vi.fn().mockResolvedValue([ref]),
        readRef: vi.fn().mockResolvedValue({
          ref,
          body: '发布前运行 build。',
          bodyFingerprint: 'sha256:body',
          readAt: '2026-08-10T00:00:00.000Z',
          warnings: [],
        }),
        remember,
      }),
      presentedMemories: [{ refId: ref.id, bodyFingerprint: 'sha256:body' }],
    });

    await memoryIntent({ operation: 'list' });
    const result = await toolMemoryIntent({
      operation: 'correct',
      targetRefId: ref.id,
      statement: '发布前运行 npm run build。',
      userQuote: text,
      claimKind: 'procedure',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('Memory updated');
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ targetRefId: ref.id }));
  });

  it.each([
    ['Change that memory to: I prefer Vim.', 'I prefer Vim.'],
    ['请把刚才那条改成：我喜欢 Vim。', '我喜欢 Vim'],
  ])('accepts punctuation between a correction instruction and claim: %s', async (text, statement) => {
    const ref = {
      kind: 'memdir' as const,
      id: 'memdir:editor.md',
      scope: 'project' as const,
      owner: 'project' as const,
      lifecycle: 'active' as const,
      authority: 'approved_write' as const,
      visibility: 'prompt_safe' as const,
      sourceRefs: [],
      relatedRefs: [],
      title: 'Editor',
    };
    const remember = vi.fn().mockResolvedValue({
      status: 'updated',
      changedRefIds: [ref.id],
      proposalIds: [],
      warnings: [],
    });
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-punctuated-correct' }),
      controlPlane: controlPlane({
        listRefs: vi.fn().mockResolvedValue([ref]),
        readRef: vi.fn().mockResolvedValue({
          ref,
          body: 'I prefer VSCode.',
          bodyFingerprint: 'sha256:editor',
          readAt: '2026-08-10T00:00:00.000Z',
          warnings: [],
        }),
        remember,
      }),
      presentedMemories: [{ refId: ref.id, bodyFingerprint: 'sha256:editor' }],
    });

    const result = await toolMemoryIntent({
      operation: 'correct',
      targetRefId: ref.id,
      statement,
      userQuote: text,
      claimKind: 'preference',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('Memory updated');
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ statement }));
  });

  it.each(['Please forget this one.', 'Please forget it.', 'Please forget the first memory.'])(
    'does not let a current-turn hidden list authorize a deictic target: %s',
    async (text) => {
      const ref = {
        kind: 'memdir' as const,
        id: 'memdir:package-manager.md',
        scope: 'project' as const,
        owner: 'project' as const,
        lifecycle: 'active' as const,
        authority: 'approved_write' as const,
        visibility: 'prompt_safe' as const,
        sourceRefs: [],
        relatedRefs: [],
        title: 'Package manager',
      };
      const forgetRef = vi.fn();
      const memoryIntent = createMemoryIntentBinding({
        getCurrentUserTurn: () => ({ text, turnId: 'turn-hidden-list' }),
        controlPlane: controlPlane({
          listRefs: vi.fn().mockResolvedValue([ref]),
          readRef: vi.fn().mockResolvedValue({
            ref,
            body: 'This project uses npm.',
            bodyFingerprint: 'sha256:body',
            readAt: '2026-08-10T00:00:00.000Z',
            warnings: [],
          }),
          forgetRef,
        }),
      });
      await memoryIntent({ operation: 'list' });

      const result = await toolMemoryIntent({
        operation: 'forget',
        targetRefId: ref.id,
        userQuote: text,
      }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

      expect(result).toContain('rejected');
      expect(forgetRef).not.toHaveBeenCalled();
    },
  );

  it('rejects an unrelated quote instead of letting the model choose a destructive target', async () => {
    const forgetRef = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text: 'This is unrelated.', turnId: 'turn-unrelated' }),
      controlPlane: controlPlane({ forgetRef }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:release.md',
      userQuote: 'is',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(forgetRef).not.toHaveBeenCalled();
  });

  it.each([
    'Do not forget memdir:release.md.',
    "I don't want you to forget memdir:release.md.",
    'Do not under any circumstances forget memdir:release.md.',
    '不要删除 memdir:release.md。',
    '不要再帮我删除 memdir:release.md。',
  ])('rejects a negated forget instruction: %s', async (text) => {
    const forgetRef = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-negated-forget' }),
      controlPlane: controlPlane({ forgetRef }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:release.md',
      userQuote: text,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(forgetRef).not.toHaveBeenCalled();
  });

  it.each([
    'Forget memdir:release.md only after I confirm.',
    'Would you forget memdir:release.md if I asked?',
    '删除 memdir:release.md 之前先问我。',
  ])('rejects conditional or deferred destructive language: %s', async (text) => {
    const forgetRef = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-deferred-forget' }),
      controlPlane: controlPlane({ forgetRef }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:release.md',
      userQuote: text,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(forgetRef).not.toHaveBeenCalled();
  });

  it('rejects reported speech instead of treating it as a current instruction', async () => {
    const forgetRef = vi.fn();
    const text = 'I said forget memdir:release.md yesterday.';
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-reported-speech' }),
      controlPlane: controlPlane({ forgetRef }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:release.md',
      userQuote: 'forget memdir:release.md',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(forgetRef).not.toHaveBeenCalled();
  });

  it.each([
    'Forgetfulness around memdir:release.md is a known issue.',
    '我想讨论一下是否删除 memdir:release.md。',
  ])('rejects a non-imperative operation mention: %s', async (text) => {
    const forgetRef = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-operation-mention' }),
      controlPlane: controlPlane({ forgetRef }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:release.md',
      userQuote: text,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(forgetRef).not.toHaveBeenCalled();
  });

  it('rejects a quoted example instead of treating it as a destructive instruction', async () => {
    const forgetRef = vi.fn();
    const text = 'For example, "forget memdir:release.md" should not execute.';
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-quoted-example' }),
      controlPlane: controlPlane({ forgetRef }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:release.md',
      userQuote: 'forget memdir:release.md',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(forgetRef).not.toHaveBeenCalled();
  });

  it.each([
    'Forget memdir:release.md? No, keep it.',
    "Forget memdir:release.md; actually, don't.",
    'Forget memdir:release.md. I changed my mind.',
    'Forget memdir:release.md. I withdraw that request.',
  ])('rejects an instruction revoked later in the same user turn: %s', async (text) => {
    const forgetRef = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-revoked-forget' }),
      controlPlane: controlPlane({ forgetRef }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:release.md',
      userQuote: 'Forget memdir:release.md',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(forgetRef).not.toHaveBeenCalled();
  });

  it('rejects an example lead-in regardless of capitalization', async () => {
    const forgetRef = vi.fn();
    const text = 'For example. Forget memdir:release.md.';
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-capitalized-example' }),
      controlPlane: controlPlane({ forgetRef }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:release.md',
      userQuote: text,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(forgetRef).not.toHaveBeenCalled();
  });

  it('rejects a new remember request that smuggles an existing Memory target', async () => {
    const remember = vi.fn();
    const text = 'Remember that this project uses npm.';
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-smuggled-target' }),
      controlPlane: controlPlane({ remember }),
    });

    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: 'this project uses npm.',
      targetRefId: 'memdir:editor.md',
      userQuote: text,
      claimKind: 'fact',
      claimKey: 'project.package-manager',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(remember).not.toHaveBeenCalled();
  });

  it('explains exceptional decisions in natural language and applies an exact user approval', async () => {
    const proposal = {
      id: 'memory:proposal-1',
      action: 'write_memdir' as const,
      targetRefs: [],
      sourceRefs: [],
      expectedFingerprints: { 'memdir:target.md': 'missing' },
      rationale: 'The inferred preference was not backed by authoritative evidence.',
      risk: 'medium' as const,
      preview: {
        summary: 'Remember a possible release preference.',
        changedRefs: [],
        changedPaths: ['memory/release.md'],
        beforeFingerprints: {},
        afterFingerprints: {},
        diff: 'Prefer a short release checklist.',
        warnings: [],
      },
      requiresApproval: true,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    const approveProposal = vi.fn().mockResolvedValue({
      proposalId: proposal.id,
      applied: true,
      changedRefs: [],
      changedPaths: ['memory/release.md'],
      warnings: [],
    });
    let currentTurn = { text: 'What Memory decisions need me?', turnId: 'turn-decisions' };
    const createBinding = () => createMemoryIntentBinding({
      getCurrentUserTurn: () => currentTurn,
      controlPlane: controlPlane({
        listInbox: vi.fn().mockResolvedValue([proposal]),
        showProposal: vi.fn().mockResolvedValue(proposal),
        approveProposal,
      }),
    });

    const decisions = await toolMemoryIntent(
      { operation: 'decisions' },
      { memoryManagementIntent: createBinding() } as unknown as KodaXToolExecutionContext,
    );
    const decisionRef = decisions.match(/\((memory:[^)]+)\)/)?.[1];
    expect(decisionRef).toBeDefined();
    currentTurn = { text: `Approve ${decisionRef}.`, turnId: 'turn-approve' };
    const approved = await toolMemoryIntent({
      operation: 'approve',
      targetRefId: decisionRef,
      userQuote: `Approve ${decisionRef}.`,
    }, { memoryManagementIntent: createBinding() } as unknown as KodaXToolExecutionContext);

    expect(decisions).toContain('Remember a possible release preference.');
    expect(decisions).toContain('not backed by authoritative evidence');
    expect(decisions).toContain('Prefer a short release checklist.');
    expect(approved).toContain('Memory decision approved');
    expect(approveProposal).toHaveBeenCalledWith(
      proposal.id,
      proposal.expectedFingerprints,
      memoryProposalRevision(proposal),
    );
  });

  it('approves the first freshly listed decision without making the user copy its ref', async () => {
    const proposal = {
      id: 'memory:proposal-first',
      action: 'write_memdir' as const,
      targetRefs: [],
      sourceRefs: [],
      expectedFingerprints: { 'memdir:first.md': 'missing' },
      rationale: 'The claim conflicts with accepted Memory.',
      risk: 'medium' as const,
      preview: {
        summary: 'Change the package manager.',
        changedRefs: [],
        changedPaths: [],
        beforeFingerprints: {},
        warnings: [],
      },
      requiresApproval: true,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    const approveProposal = vi.fn().mockResolvedValue({
      proposalId: proposal.id,
      applied: true,
      changedRefs: [],
      changedPaths: [],
      warnings: [],
    });
    const text = '批准第一条。';
    const sharedControlPlane = controlPlane({
      listInbox: vi.fn().mockResolvedValue([proposal]),
      showProposal: vi.fn().mockResolvedValue(proposal),
      approveProposal,
    });
    const previewBinding = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-approve-first' }),
      controlPlane: sharedControlPlane,
    });
    const preview = await previewBinding({ operation: 'decisions' });
    if (preview.status !== 'decisions') throw new Error('expected decisions');
    const [decision] = preview.decisions;
    if (decision === undefined) throw new Error('expected one decision');
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-approve-first' }),
      controlPlane: sharedControlPlane,
      presentedDecisionRefIds: [decision.refId],
    });
    await memoryIntent({ operation: 'decisions' });

    const result = await toolMemoryIntent({
      operation: 'approve',
      targetRefId: decision.refId,
      userQuote: text,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('Memory decision approved');
    expect(approveProposal).toHaveBeenCalledWith(
      proposal.id,
      proposal.expectedFingerprints,
      memoryProposalRevision(proposal),
    );
  });

  it.each([
    ['approve', 'I approve the first decision.'],
    ['approve', '我同意第一条。'],
    ['reject', 'I reject the first decision.'],
    ['reject', '我不同意第一条。'],
  ] as const)('accepts an explicit first-person %s decision: %s', async (operation, text) => {
    const proposal = {
      id: 'memory:proposal-performative',
      action: 'write_memdir' as const,
      targetRefs: [],
      sourceRefs: [],
      expectedFingerprints: { 'memdir:target.md': 'missing' },
      rationale: 'The claim conflicts with accepted Memory.',
      risk: 'medium' as const,
      preview: {
        summary: 'Change one preference.',
        changedRefs: [],
        changedPaths: [],
        beforeFingerprints: {},
        warnings: [],
      },
      requiresApproval: true,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    const decisionRef = `${proposal.id}@${memoryProposalRevision(proposal)}`;
    const approveProposal = vi.fn().mockResolvedValue({
      proposalId: proposal.id,
      applied: true,
      changedRefs: [],
      changedPaths: [],
      warnings: [],
    });
    const rejectProposal = vi.fn().mockResolvedValue({
      proposalId: proposal.id,
      rejected: true,
      warnings: [],
    });
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-performative-decision' }),
      controlPlane: controlPlane({
        showProposal: vi.fn().mockResolvedValue(proposal),
        approveProposal,
        rejectProposal,
      }),
      presentedDecisionRefIds: [decisionRef],
    });

    const result = await toolMemoryIntent({
      operation,
      targetRefId: decisionRef,
      userQuote: text,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain(operation === 'approve' ? 'approved' : 'rejected');
    expect(operation === 'approve' ? approveProposal : rejectProposal).toHaveBeenCalled();
  });

  it('does not let a model-only show call create deictic approval authority', async () => {
    const proposals = ['first', 'second'].map((name) => ({
      id: `memory:proposal-${name}`,
      action: 'write_memdir' as const,
      targetRefs: [],
      sourceRefs: [],
      expectedFingerprints: { [`memdir:${name}.md`]: 'missing' },
      rationale: `${name} rationale`,
      risk: 'medium' as const,
      preview: {
        summary: `${name} decision`,
        changedRefs: [],
        changedPaths: [],
        beforeFingerprints: {},
        warnings: [],
      },
      requiresApproval: true,
      createdAt: '2026-08-10T00:00:00.000Z',
    }));
    const approveProposal = vi.fn();
    const control = controlPlane({
      listInbox: vi.fn().mockResolvedValue(proposals),
      showProposal: vi.fn().mockImplementation(async (id) => proposals.find((item) => item.id === id)),
      approveProposal,
    });
    const previewBinding = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text: 'List decisions.', turnId: 'turn-preview' }),
      controlPlane: control,
    });
    const preview = await previewBinding({ operation: 'decisions' });
    if (preview.status !== 'decisions') throw new Error('expected decisions');
    const firstRef = preview.decisions[0]?.refId;
    const secondRef = preview.decisions[1]?.refId;
    if (firstRef === undefined || secondRef === undefined) throw new Error('expected two decisions');
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text: 'Approve it.', turnId: 'turn-deictic' }),
      controlPlane: control,
      presentedDecisionRefIds: [firstRef],
    });
    await memoryIntent({ operation: 'decisions' });
    await memoryIntent({ operation: 'show', targetRefId: secondRef });

    const result = await toolMemoryIntent({
      operation: 'approve',
      targetRefId: secondRef,
      userQuote: 'Approve it.',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it('extracts only refs that were rendered in the prior assistant turn', () => {
    expect(extractPresentedMemoryTargetRefs([
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'memory-list-call',
          name: 'memory_intent',
          input: { operation: 'list' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'memory-list-call',
          content: '[Memory list: showing 1 of 1]\n1. Editor (memdir:editor.md; version=sha256:editor)\nUses VSCode.',
        }],
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'memory-decisions-call',
          name: 'memory_intent',
          input: { operation: 'decisions' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'memory-decisions-call',
          content: '[Memory decisions]\n1. Change editor (memory:proposal-editor@0123456789abcdef)',
        }],
      },
      {
        role: 'assistant',
        content: [
          'I remember that your editor is VSCode.',
          'Change editor (memory:proposal-editor@0123456789abcdef)',
        ].join('\n'),
      },
      { role: 'user', content: 'Approve the first one.' },
    ])).toEqual({
      memories: [{
        refId: 'memdir:editor.md',
        bodyFingerprint: 'sha256:editor',
        searchableText: 'Editor',
      }],
      decisionRefIds: ['memory:proposal-editor@0123456789abcdef'],
    });
  });

  it('binds ordinals to explicit numbering in the visible assistant response', () => {
    expect(extractPresentedMemoryTargetRefs(presentationTranscript(
      'Intro mentions Alpha body.\n1. Beta — Beta body.\n2. Alpha — Alpha body.\n'
      + '1. Beta decision\n2. Alpha decision',
    ))).toEqual({
      memories: [{
        refId: 'memdir:b.md', bodyFingerprint: 'sha256:b', searchableText: 'Beta\nBeta body.',
      }, {
        refId: 'memdir:a.md', bodyFingerprint: 'sha256:a', searchableText: 'Alpha\nAlpha body.',
      }],
      decisionRefIds: ['memory:proposal-b@bbbbbbbbbbbbbbbb', 'memory:proposal-a@aaaaaaaaaaaaaaaa'],
    });
  });

  it('binds memory ordinals when the numbered line shows only the title', () => {
    expect(extractPresentedMemoryTargetRefs(presentationTranscript(
      '1. Beta\n   Beta body.\n2. Alpha\n   Alpha body.\n'
      + '1. Beta decision\n2. Alpha decision',
    ))).toEqual({
      memories: [{
        refId: 'memdir:b.md', bodyFingerprint: 'sha256:b', searchableText: 'Beta\nBeta body.',
      }, {
        refId: 'memdir:a.md', bodyFingerprint: 'sha256:a', searchableText: 'Alpha\nAlpha body.',
      }],
      decisionRefIds: ['memory:proposal-b@bbbbbbbbbbbbbbbb', 'memory:proposal-a@aaaaaaaaaaaaaaaa'],
    });
  });

  it('does not grant ordinal authority when visible numbering is ambiguous', () => {
    expect(extractPresentedMemoryTargetRefs(presentationTranscript(
      '1. Alpha — Alpha body.\n1. Beta — Beta body.\n'
      + '1. Alpha decision\n1. Beta decision',
    ))).toEqual({ memories: [], decisionRefIds: [] });
  });

  it('uses visible Memory descriptions across bindings without requiring an opaque ref in the user text', async () => {
    const presented = extractPresentedMemoryTargetRefs(presentationTranscript(
      '1. Beta\nBeta body.\n2. Alpha\nAlpha body.\n1. Beta decision\n2. Alpha decision',
    ));
    const baseRef = {
      kind: 'memdir' as const,
      scope: 'project' as const,
      owner: 'project' as const,
      lifecycle: 'active' as const,
      authority: 'approved_write' as const,
      visibility: 'prompt_safe' as const,
      sourceRefs: [],
      relatedRefs: [],
    };
    const alpha = { ...baseRef, id: 'memdir:a.md', title: 'Alpha' };
    const beta = { ...baseRef, id: 'memdir:b.md', title: 'Beta' };
    const forgetRef = vi.fn().mockResolvedValue({
      refId: beta.id,
      operation: 'forget',
      acknowledged: true,
      residualSourceRefs: [],
      warnings: [],
    });
    const text = 'Please forget the Beta body memory.';
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-described-prior-memory' }),
      presentedMemories: presented.memories,
      controlPlane: controlPlane({
        listRefs: vi.fn().mockResolvedValue([alpha, beta]),
        readRef: vi.fn().mockImplementation(async (ref) => ({
          ref,
          body: ref.id === beta.id ? 'Beta body.' : 'Alpha body.',
          bodyFingerprint: ref.id === beta.id ? 'sha256:b' : 'sha256:a',
          readAt: '2026-08-10T00:00:00.000Z',
          warnings: [],
        })),
        forgetRef,
      }),
    });

    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: beta.id,
      userQuote: text,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('Memory forgotten');
    expect(forgetRef).toHaveBeenCalledWith(beta.id, 'sha256:b');
  });

  it('does not treat model-authored assistant prose as a presentation receipt', () => {
    expect(extractPresentedMemoryTargetRefs([{
      role: 'assistant',
      content: 'Approve memory:proposal-editor@0123456789abcdef or forget memdir:editor.md.',
    }])).toEqual({ memories: [], decisionRefIds: [] });
  });

  it('approves only the fingerprints that were actually shown to the user', async () => {
    const shown = {
      id: 'memory:proposal-stale',
      action: 'write_memdir' as const,
      targetRefs: [],
      sourceRefs: [],
      expectedFingerprints: { 'memdir:target.md': 'shown' },
      rationale: 'A conflict requires a decision.',
      risk: 'medium' as const,
      preview: {
        summary: 'Update editor preference.',
        changedRefs: [],
        changedPaths: [],
        beforeFingerprints: {},
        warnings: [],
      },
      requiresApproval: true,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    const latest = { ...shown, expectedFingerprints: { 'memdir:target.md': 'latest' } };
    const approveProposal = vi.fn().mockResolvedValue({
      proposalId: shown.id,
      applied: false,
      changedRefs: [],
      changedPaths: [],
      skippedReason: 'stale proposal fingerprints',
      warnings: [],
    });
    const showProposal = vi.fn()
      .mockResolvedValueOnce(shown)
      .mockResolvedValueOnce(latest);
    let currentTurn = { text: 'Show the decision.', turnId: 'turn-show' };
    const createBinding = () => createMemoryIntentBinding({
      getCurrentUserTurn: () => currentTurn,
      controlPlane: controlPlane({ showProposal, approveProposal }),
    });

    const shownResult = await toolMemoryIntent(
      { operation: 'show', targetRefId: shown.id },
      { memoryManagementIntent: createBinding() } as unknown as KodaXToolExecutionContext,
    );
    const decisionRef = shownResult.match(/\((memory:[^)]+)\)/)?.[1];
    expect(decisionRef).toBeDefined();
    currentTurn = { text: `Approve ${decisionRef}.`, turnId: 'turn-stale' };
    const result = await toolMemoryIntent({
      operation: 'approve',
      targetRefId: decisionRef,
      userQuote: `Approve ${decisionRef}.`,
    }, { memoryManagementIntent: createBinding() } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('needs_clarification');
    expect(result).toContain('current version');
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it.each([
    'For example:\nForget memdir:release.md.',
    'The assistant suggested:\nForget memdir:release.md.',
    'Do not do the following:\nForget memdir:release.md.',
    '例如：\n删除 memdir:release.md。',
    '不要执行下面这条：\n删除 memdir:release.md。',
    'Forget memdir:release.md, but do not actually delete it.',
    "Forget memdir:release.md and don't delete it.",
    "Forget memdir:release.md, don't delete it.",
  ])('rejects non-authorizing context around a destructive instruction: %s', async (text) => {
    const forgetRef = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-context' }),
      controlPlane: controlPlane({ forgetRef }),
    });
    const quote = text.split(/\n/u).at(-1)!;
    const result = await toolMemoryIntent({
      operation: 'forget',
      targetRefId: 'memdir:release.md',
      userQuote: quote,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(forgetRef).not.toHaveBeenCalled();
  });

  it.each([
    'Remember that I use Vim for the next hour.',
    'Remember that I use Vim in this session only.',
    'Remember that I use Vim while we work on this task.',
    '今天先记住我使用 Vim。',
    '请记住接下来一小时我使用 Vim。',
    '本会话请记住我使用 Vim。',
  ])('does not turn temporary context into durable Memory: %s', async (text) => {
    const remember = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-temporary' }),
      controlPlane: controlPlane({ remember }),
    });
    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: text,
      userQuote: text,
      claimKind: 'preference',
      claimKey: 'user.editor',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(remember).not.toHaveBeenCalled();
  });

  it.each([
    ['Remember that I don\'t use npm.', 'use npm'],
    ['Remember deployment is allowed only after tests pass.', 'deployment is allowed'],
  ])('rejects a model-truncated durable claim from %s', async (text, statement) => {
    const remember = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-truncated' }),
      controlPlane: controlPlane({ remember }),
    });
    const result = await toolMemoryIntent({
      operation: 'remember',
      statement,
      userQuote: text,
      claimKind: 'fact',
      claimKey: 'project.package-manager',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).not.toContain('Memory remembered');
    expect(remember).not.toHaveBeenCalled();
  });

  it.each([
    "Please remember that I use pnpm, but don't save it.",
    "Please remember that I use pnpm, but don't store it.",
  ])('rejects a durable remember request withdrawn with generic persistence language: %s', async (text) => {
    const remember = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-generic-persistence-negation' }),
      controlPlane: controlPlane({ remember }),
    });
    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: text.replace(/^Please remember that /u, '').replace(/\.$/u, ''),
      userQuote: text,
      claimKind: 'fact',
      claimKey: 'project.package-manager',
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(remember).not.toHaveBeenCalled();
  });

  it('does not approve a decision after the user says not to execute it', async () => {
    const proposal = {
      id: 'memory:proposal-generic-negation',
      action: 'write_memdir' as const,
      targetRefs: [],
      sourceRefs: [],
      expectedFingerprints: {},
      rationale: 'A conflict needs a decision.',
      risk: 'medium' as const,
      preview: { summary: 'Change package manager', changedRefs: [], changedPaths: [], beforeFingerprints: {}, warnings: [] },
      requiresApproval: true,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    const targetRefId = `${proposal.id}@${memoryProposalRevision(proposal)}`;
    const text = `Approve ${targetRefId}, but don't do it.`;
    const approveProposal = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-generic-execution-negation' }),
      presentedDecisionRefIds: [targetRefId],
      controlPlane: controlPlane({
        showProposal: vi.fn().mockResolvedValue(proposal),
        approveProposal,
      }),
    });

    const result = await toolMemoryIntent({
      operation: 'approve',
      targetRefId,
      userQuote: text,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it.each([
    ['remember', 'Save this config to package.json.', 'Save this config to package.json.'],
    ['approve', 'Please confirm the first decision.', undefined],
  ] as const)('does not confuse ordinary verbs with a Memory %s authorization', async (operation, text, statement) => {
    const remember = vi.fn();
    const approveProposal = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({ text, turnId: 'turn-ambiguous-verb' }),
      controlPlane: controlPlane({ remember, approveProposal }),
      presentedDecisionRefIds: ['memory:proposal@0123456789abcdef'],
    });
    const result = await toolMemoryIntent({
      operation,
      ...(statement === undefined ? {} : { statement, claimKind: 'fact', claimKey: 'project.config' }),
      ...(operation === 'approve' ? { targetRefId: 'memory:proposal@0123456789abcdef' } : {}),
      userQuote: text,
    }, { memoryManagementIntent: memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(remember).not.toHaveBeenCalled();
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it('is hidden without a root Memory control plane and reports unavailable when unbound', async () => {
    expect(activateMemoryIntentTool(['read', 'memory_intent'], false)).toEqual(['read']);
    expect(activateMemoryIntentTool(['read'], true)).toEqual(['read', 'memory_intent']);

    await expect(toolMemoryIntent({ operation: 'list' }, {} as KodaXToolExecutionContext))
      .resolves.toContain('unavailable');
  });
});
