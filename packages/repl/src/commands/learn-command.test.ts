import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMemoryControlPlane,
  readLearningProposalStore,
  resolveLearningProposalStore,
  setAgentConfigHome,
  triageProceduralLearning,
  upsertLearningProposal,
  type ReviewableLearningProposal,
} from '@kodax-ai/agent';
import { deriveCodingMemoryIdentityFromRoot } from '@kodax-ai/coding';

import { learnCommand } from './learn-command.js';
import { memoryCommand } from './memory-command.js';
import { workflowCommand } from './workflow-command.js';
import { BUILTIN_COMMANDS } from '../interactive/commands.js';

interface CapturedLog {
  readonly lines: readonly string[];
  contains: (needle: string) => boolean;
}

function captureOutput(): { readonly log: CapturedLog; readonly restore: () => void } {
  const lines: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write);
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((entry) => String(entry)).join(' '));
  });
  return {
    log: {
      lines,
      contains: (needle: string) => lines.some((line) => line.includes(needle)),
    },
    restore: () => {
      stdoutSpy.mockRestore();
      consoleSpy.mockRestore();
    },
  };
}

function buildContext(cwd: string) {
  return {
    messages: [],
    runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
  };
}

function getSkillCommand() {
  const command = BUILTIN_COMMANDS.find((entry) => entry.name === 'skill');
  if (!command) {
    throw new Error('test setup expected /skill command');
  }
  return command;
}

async function invoke(
  args: readonly string[],
  cwd: string,
  callbacks: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  await learnCommand.handler(
    [...args],
    buildContext(cwd) as never,
    callbacks as never,
    {} as never,
  );
}

function requireReviewable(proposal: ReturnType<typeof triageProceduralLearning>): ReviewableLearningProposal {
  if (proposal.destination === 'discard' || proposal.destination === 'trace_only') {
    throw new Error('test setup expected a reviewable proposal');
  }
  return proposal;
}

describe('FEATURE_224 /learn command', () => {
  let tempHome: string;
  let cwd: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-learn-cmd-home-'));
    setAgentConfigHome(tempHome);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-learn-cmd-cwd-'));
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('reports every control unavailable without a Learning Center binding and never touches the proposal store', async () => {
    // FEATURE_298 T23 — /learn is Learning-Center-only: without a binding it
    // reports unavailable for every subcommand and never falls back to the
    // cwd proposal store (the standalone domain functions stay in the agent
    // package, tested there).
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-fallback',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:fallback'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'Repeated completed sessions used the same checklist.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Add checklist.',
      },
    }));
    const storePath = resolveLearningProposalStore(cwd);
    await upsertLearningProposal(storePath, proposal);
    const before = fs.readFileSync(storePath, 'utf-8');

    for (const args of [
      ['pending'], ['list'], ['ready'],
      ['show', 'p-fallback'], ['diff', 'p-fallback'],
      ['approve', 'p-fallback'], ['reject', 'p-fallback', 'not wanted'],
      ['trust', 'p-fallback'], ['disable', 'p-fallback'], ['rollback', 'p-fallback'],
      ['promote', 'p-fallback'],
    ]) {
      const { log, restore } = captureOutput();
      try {
        await invoke(args, cwd);
      } finally {
        restore();
      }
      expect(log.contains('Learning Center controls are unavailable in this runtime')).toBe(true);
    }

    expect(fs.readFileSync(storePath, 'utf-8')).toBe(before);
    expect(
      (await readLearningProposalStore(storePath)).proposals
        .find((entry) => entry.proposalId === 'p-fallback')?.status,
    ).toBe('pending');
  });

  it('shows skill suggestions through /skill pending', async () => {
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-skill-filter',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:skill-filter'],
      candidate: {
        kind: 'skill_patch',
        skillName: 'release-notes',
        whyDurable: 'Repeated completed sessions used the same checklist.',
        trigger: 'When drafting release notes.',
        changeSummary: 'Add checklist.',
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal);

    const { log, restore } = captureOutput();
    try {
      await getSkillCommand().handler(['pending'], buildContext(cwd) as never, {} as never, {} as never);
    } finally {
      restore();
    }

    expect(log.contains('pending method guides')).toBe(true);
    expect(log.contains('p-skill-filter')).toBe(true);
  });

  it('shows workflow suggestions through /workflow pending', async () => {
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-workflow-filter',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:workflow-filter'],
      candidate: {
        kind: 'workflow_handoff',
        workflowRunId: 'wf-filter',
        workflowStatus: 'completed',
        suggestedAction: 'save_from_run',
        whyWorkflowNotSkill: 'The learning is a repeatable phase graph.',
        requiredWorkflowEvidence: ['completed run'],
        risk: 'low',
        consumerImpact: {
          workflowCapsules: [],
          savedWorkflows: [],
          constructedAgents: [],
          promptReferences: [],
          action: 'none',
        },
      },
    }));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), proposal);

    const { log, restore } = captureOutput();
    try {
      await workflowCommand.handler(['pending'], buildContext(cwd) as never, {} as never, {} as never);
    } finally {
      restore();
    }

    expect(log.contains('pending runnable workflows')).toBe(true);
    expect(log.contains('p-workflow-filter')).toBe(true);
  });

  it('shows exceptional memory decisions through the legacy /memory pending alias', async () => {
    const proposal = requireReviewable(triageProceduralLearning({
      proposalId: 'p-memory-filter',
      origin: 'background_learning',
      completedTurn: true,
      sourceRefs: ['turn:memory-filter'],
      candidate: {
        kind: 'memdir_handoff',
        memoryKind: 'project',
        body: 'This project tracks feature designs in docs/features.',
        metadata: {
          writeOrigin: 'background_learning',
          executionContext: 'primary',
          sessionId: 's-memory',
          sourceRefs: ['turn:memory-filter'],
          completedTurn: true,
        },
      },
    }));
    // FEATURE_298 T36 — /memory pending rides the Host plane; seed the store
    // the Host identity actually reads (configHome-rebased).
    const plane = {
      controller: createMemoryControlPlane({
        cwd,
        identity: deriveCodingMemoryIdentityFromRoot(tempHome, cwd),
      }),
      memoryRoot: '',
      entrypointPath: '',
      async listReviews() { return []; },
      reviewerProviderConfigured: () => false,
      async rebuild() {
        return { status: 'no-topics', memoryRoot: '', entrypointPath: '', entryCount: 0, malformedFiles: [], warnings: [] };
      },
      async ensureOpenTarget(targetPath: string) { return targetPath; },
    };
    await upsertLearningProposal(resolveLearningProposalStore(cwd, tempHome), proposal);

    const { log, restore } = captureOutput();
    try {
      await memoryCommand.handler(['pending'], buildContext(cwd) as never, { memory: () => plane } as never, {} as never);
    } finally {
      restore();
    }

    expect(log.contains('decisions that need you')).toBe(true);
    expect(log.contains('p-memory-filter')).toBe(true);
  });

  it.each([
    ['promote', '--help'],
    ['promote', '-h'],
    ['promote', 'help'],
  ])('shows dedicated promote help for /learn %s %s', async (...args) => {
    const { log, restore } = captureOutput();
    try {
      await invoke(args, cwd);
    } finally {
      restore();
    }

    expect(log.contains('/learn promote <name|slug|capability-id> [--scope user]')).toBe(true);
    expect(log.contains('testing -> active_learned')).toBe(true);
    expect(log.contains('ready or active_learned -> promoted_user')).toBe(true);
    expect(log.contains('never overwrites different formal Skill content')).toBe(true);
  });

  it('routes /help learn promote to the dedicated promote help', async () => {
    const help = BUILTIN_COMMANDS.find((entry) => entry.name === 'help');
    if (!help) throw new Error('test setup expected /help command');

    const { log, restore } = captureOutput();
    try {
      await help.handler(['learn', 'promote'], buildContext(cwd) as never, {} as never, {} as never);
    } finally {
      restore();
    }

    expect(log.contains('/learn promote <name|slug|capability-id> [--scope user]')).toBe(true);
    expect(log.contains('Promote is an explicit ownership transfer')).toBe(true);
  });

  it('routes /learn help promote to the dedicated promote help', async () => {
    const { log, restore } = captureOutput();
    try {
      await invoke(['help', 'promote'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('/learn promote <name|slug|capability-id> [--scope user]')).toBe(true);
  });

  it.each([
    [['promote', 'release-check', '--scope', 'project'], 'unsupported promote scope: project'],
    [['promote', 'release-check', '--scope'], 'missing value for --scope'],
    [['promote', 'release-check', '--scope', 'user', '--scope=user'], 'duplicate --scope option'],
    [['promote', 'release-check', '--unknown'], 'unknown promote option: --unknown'],
    [['promote', 'release-check', 'extra'], 'unexpected promote argument: extra'],
  ] as const)('rejects invalid promote arguments without changing the user catalog', async (args, message) => {
    const promote = vi.fn(async () => undefined);
    const { log, restore } = captureOutput();
    try {
      await invoke(args, cwd, {
        learning: {
          get: vi.fn(async (nameOrSlug: string) => ({ slug: nameOrSlug })),
          list: vi.fn(async () => ({ items: [], revision: 0 })),
          promote,
        },
      });
    } finally {
      restore();
    }

    expect(log.contains(message)).toBe(true);
    expect(promote).not.toHaveBeenCalled();
  });

  it.each([
    ['without an explicit flag', ['promote', 'release-check']],
    ['with a separated scope flag', ['promote', 'release-check', '--scope', 'user']],
    ['with an inline scope flag', ['promote', 'release-check', '--scope=user']],
  ])('dispatches promote to the exact user scope %s', async (_label, args) => {
    const promote = vi.fn(async () => undefined);
    const get = vi.fn(async () => ({
      capabilityId: 'lc-release-check',
      slug: 'release-check',
    }));
    const { log, restore } = captureOutput();
    try {
      await invoke(args, cwd, {
        learning: {
          get,
          list: vi.fn(async () => ({ items: [], revision: 0 })),
          promote,
        },
      });
    } finally {
      restore();
    }

    expect(get).toHaveBeenCalledWith('release-check');
    expect(promote).toHaveBeenCalledWith('lc-release-check', 'user');
    expect(log.contains('promoted release-check to the formal user Skill catalog')).toBe(true);
  });

  it('preserves an exact capability ID when duplicate slugs need disambiguation', async () => {
    const promote = vi.fn(async () => undefined);
    const get = vi.fn(async (capabilityId: string) => ({
      capabilityId,
      slug: 'duplicate-release-check',
    }));
    const exactId = 'lc-project-b-release-check';

    await invoke(['promote', exactId], cwd, {
      learning: {
        get,
        list: vi.fn(async () => ({
          items: [
            { capabilityId: 'lc-project-a-release-check', slug: 'duplicate-release-check' },
            { capabilityId: exactId, slug: 'duplicate-release-check' },
          ],
          revision: 2,
        })),
        promote,
      },
    });

    expect(get).toHaveBeenCalledWith(exactId);
    expect(promote).toHaveBeenCalledWith(exactId, 'user');
  });

  it('shows exact capability IDs when list results contain duplicate slugs', async () => {
    const { log, restore } = captureOutput();
    try {
      await invoke(['list'], cwd, {
        learning: {
          list: vi.fn(async () => ({
            items: [
              {
                capabilityId: 'lc-project-a-release-check',
                slug: 'duplicate-release-check',
                carrier: 'skill',
                lifecycle: 'ready',
                displayName: 'Project A release check',
              },
              {
                capabilityId: 'lc-project-b-release-check',
                slug: 'duplicate-release-check',
                carrier: 'skill',
                lifecycle: 'active_learned',
                displayName: 'Project B release check',
              },
            ],
            revision: 2,
          })),
        },
      });
    } finally {
      restore();
    }

    expect(log.contains('id=lc-project-a-release-check')).toBe(true);
    expect(log.contains('id=lc-project-b-release-check')).toBe(true);
  });

  it('routes Learning Center text through the Ink-captured console channel', async () => {
    const consoleLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(' '));
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    try {
      await invoke(['list'], cwd, {
        learning: {
          list: vi.fn(async () => ({ items: [], revision: 0 })),
        },
      });
    } finally {
      consoleSpy.mockRestore();
      stdoutSpy.mockRestore();
    }

    expect(consoleLines.some((line) => line.includes('[learn] Learning Center'))).toBe(true);
    expect(consoleLines.some((line) => line.includes('(none)'))).toBe(true);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('prints an explicit empty state instead of opening an empty Learning Center', async () => {
    const openLearningCenter = vi.fn(async () => undefined);
    const { log, restore } = captureOutput();
    try {
      await invoke([], cwd, {
        learning: {
          list: vi.fn(async () => ({ items: [], revision: 0 })),
        },
        openLearningCenter,
      });
    } finally {
      restore();
    }

    expect(openLearningCenter).not.toHaveBeenCalled();
    expect(log.contains('Learning Center has no learned capabilities')).toBe(true);
  });

  it('uses ready as the explicit lifecycle command and explains the pending alias', async () => {
    const list = vi.fn(async () => ({ items: [], revision: 0 }));
    const { log, restore } = captureOutput();
    try {
      await invoke(['ready'], cwd, { learning: { list } });
      await invoke(['pending'], cwd, { learning: { list } });
    } finally {
      restore();
    }

    expect(list).toHaveBeenNthCalledWith(1, expect.objectContaining({ lifecycle: 'ready' }));
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ lifecycle: 'ready' }));
    expect(log.contains('compatibility alias for /learn ready')).toBe(true);
    expect(log.contains('Memory pipeline health: /memory doctor')).toBe(true);
  });

});
