/**
 * Natural-language-first `/memory` escape-hatch tests.
 *
 * Covers product-state listing, direct ordinary operations, exceptional
 * decisions, external opening, and hidden repair compatibility. Uses a per-test `tempHome` +
 * `setAgentConfigHome` override so the assertions never touch the real
 * `~/.kodax/projects/.../memory/` tree.
 *
 * `MEMORY.md` is tested only as a derived storage artifact; normal list and
 * natural-language paths use the Memory control plane as source of truth.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimEpisodeReview,
  failEpisodeReviewAttempt,
  persistPendingEpisodeReview,
  setAgentConfigHome,
  resolveLearningProposalStore,
  resolveMemoryRoot,
  resolveMemoryEntrypoint,
  readLearningProposalStore,
  upsertLearningProposal,
  type KodaXSessionLineage,
  type MemoryLearningHandoff,
  type MemoryReviewModelInput,
  createMemoryControlPlane,
  resolveScopedMemoryRoot,
  listPendingEpisodeReviewSummaries,
  type PendingEpisodeReviewSummary,
} from '@kodax-ai/agent';
import { deriveCodingMemoryIdentityFromRoot } from '@kodax-ai/coding';

import type { MemoryCommandPlane } from './types.js';
import { externalOpenInvocation, memoryCommand } from './memory-command.js';

interface CapturedLog {
  lines: string[];
  contains: (needle: string) => boolean;
}

function captureConsole(): { log: CapturedLog; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  return {
    log: {
      lines,
      contains: (needle: string) => lines.some((l) => l.includes(needle)),
    },
    restore: () => spy.mockRestore(),
  };
}

function buildContext(cwd: string) {
  return {
    messages: [],
    runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
  };
}

type MemoryCommandCallbacks = Parameters<typeof memoryCommand.handler>[2];

async function invoke(
  args: string[],
  cwd: string,
  callbacks: Partial<MemoryCommandCallbacks> = {},
) {
  // Bind the minimal interactive context and optional host callbacks used by
  // each command case; currentConfig is unused by this command.
  const merged = {
    memory: (root: string) => buildMemoryPlane(activeTempHome, root),
    ...callbacks,
  } as MemoryCommandCallbacks;
  await memoryCommand.handler(
    args,
    buildContext(cwd) as never,
    merged,
    {} as never,
  );
}

// FEATURE_298 T36 — tests drive the command through the same structural
// plane the Host provides: a real control plane with the Host identity
// derivation, plus local mirrors of the Host-owned rebuild/open-target
// behavior (the deep contracts live in agent memory-control tests and the
// runtime S1).
let activePlane: MemoryCommandPlane | undefined;
// Current describe's temp config home — the per-root plane factory derives
// Host identities from it.
let activeTempHome: string;

function buildMemoryPlane(
  configHome: string,
  projectRoot: string,
  memoryReviewer?: NonNullable<KodaXOptions['memoryReviewer']>,
): MemoryCommandPlane {
  const identity = deriveCodingMemoryIdentityFromRoot(configHome, projectRoot);
  const memoryRoot = resolveScopedMemoryRoot(identity, 'project');
  const controller = createMemoryControlPlane({
    cwd: projectRoot,
    identity,
    ...(memoryReviewer === undefined ? {} : { memoryReviewer }),
  });
  return {
    controller,
    memoryRoot,
    entrypointPath: path.join(memoryRoot, 'MEMORY.md'),
    async listReviews() {
      const localProjectId = `local:${path.resolve(projectRoot).toLowerCase()}`;
      const ownerIdentities = identity.projectId === localProjectId
        ? [identity]
        : [identity, { ...identity, projectId: localProjectId }];
      const pages = await Promise.all(ownerIdentities.map((owner) => (
        listPendingEpisodeReviewSummaries({
          configHome: owner.configHome,
          tenantId: owner.tenantId,
          agentId: owner.agentId,
          projectId: owner.projectId ?? null,
        })
      )));
      const unique = new Map<string, PendingEpisodeReviewSummary>();
      for (const review of pages.flat()) {
        const dedupeKey = review.jobId ?? `${review.ownerSessionRef}:${review.reviewKey}`;
        if (!unique.has(dedupeKey)) unique.set(dedupeKey, review);
      }
      return [...unique.values()].sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.reviewKey.localeCompare(right.reviewKey)
      ));
    },
    reviewerProviderConfigured: () => false,
    async rebuild() {
      let dirExists = false;
      try {
        dirExists = fs.statSync(memoryRoot).isDirectory();
      } catch {
        dirExists = false;
      }
      const entrypointPath = path.join(memoryRoot, 'MEMORY.md');
      if (!dirExists) {
        return { status: 'missing-dir', memoryRoot, entrypointPath, entryCount: 0, malformedFiles: [], warnings: [] };
      }
      const topics: { filename: string; mtimeMs: number; title: string; description: string; parseOk: boolean }[] = [];
      for (const entry of fs.readdirSync(memoryRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'MEMORY.md') continue;
        const raw = fs.readFileSync(path.join(memoryRoot, entry.name), 'utf-8');
        const mtimeMs = fs.statSync(path.join(memoryRoot, entry.name)).mtimeMs;
        const fm = /(?:^|\n)name:\s*(.+)/.exec(raw);
        const fd = /(?:^|\n)description:\s*(.+)/.exec(raw);
        const ftype = /(?:^|\n)type:\s*(.+)/.exec(raw);
        const baseTitle = path.basename(entry.name, '.md');
        topics.push({
          filename: entry.name,
          mtimeMs,
          title: fm?.[1]?.trim() ?? baseTitle,
          description: fd?.[1]?.trim() ?? baseTitle,
          parseOk: fm !== null || fd !== null || ftype !== null,
        });
      }
      if (topics.length === 0) {
        return { status: 'no-topics', memoryRoot, entrypointPath, entryCount: 0, malformedFiles: [], warnings: [] };
      }
      const sorted = [...topics].sort((a, b) => b.mtimeMs - a.mtimeMs);
      fs.writeFileSync(
        entrypointPath,
        sorted.map((f) => `- [${f.title}](${f.filename}) — ${f.description}`).join('\n') + '\n',
        'utf-8',
      );
      return {
        status: 'rebuilt',
        memoryRoot,
        entrypointPath,
        entryCount: sorted.length,
        malformedFiles: sorted.filter((f) => !f.parseOk).map((f) => f.filename),
        warnings: [],
      };
    },
    async ensureOpenTarget(targetPath: string) {
      if (path.resolve(targetPath) === path.resolve(memoryRoot) && !fs.existsSync(memoryRoot)) {
        fs.mkdirSync(memoryRoot, { recursive: true });
      }
      const probe = fs.existsSync(targetPath) ? targetPath : path.dirname(targetPath);
      const resolvedTarget = fs.realpathSync(probe);
      const resolvedRoot = fs.existsSync(memoryRoot) ? fs.realpathSync(memoryRoot) : memoryRoot;
      if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Memory open target escapes the project memory root: ${targetPath}`);
      }
      return targetPath;
    },
  };
}

describe('FEATURE_124 Phase D — /memory command', () => {
  let tempHome: string;
  let cwd: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-cmd-home-'));
    setAgentConfigHome(tempHome);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-cmd-cwd-'));
    activeTempHome = tempHome;
    activePlane = buildMemoryPlane(tempHome, cwd);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('list with no accepted Memory reports the product state instead of a missing index file', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['list'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('No accepted memories yet')).toBe(true);
    expect(log.contains('MEMORY.md does not exist yet')).toBe(false);
    expect(log.contains('LLM will create')).toBe(false);
  });

  it('list reads accepted topic content without treating MEMORY.md as source of truth', async () => {
    // FEATURE_298 T36 — accepted Memory comes from the Host plane's remember
    // path; a bare MEMORY.md index is never the source of truth.
    await activePlane!.controller.remember({
      statement: 'Senior backend engineer body.',
      claimKind: 'fact',
      claimKey: 'user_role',
      evidenceRef: 'user-command:test',
    });

    const { log, restore } = captureConsole();
    try {
      await invoke([], cwd);
    } finally {
      restore();
    }

    expect(log.contains('Senior backend engineer body.')).toBe(true);
    expect(log.contains('1 accepted across 1 storage scope')).toBe(true);
  });

  it('remember stores an ordinary explicit Memory immediately and list shows its body', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke([
        'remember',
        '--kind',
        'procedure',
        '--key',
        'project.release.focused-tests',
        'Use',
        'focused',
        'tests',
        'before',
        'release.',
      ], cwd);
      await invoke(['list'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('Memory remembered')).toBe(true);
    expect(log.contains('Use focused tests before release.')).toBe(true);
    expect(log.contains('pending memory proposals')).toBe(false);
  });

  it('requires the stable displayed handle before forgetting accepted Memory', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke([
        'remember',
        '--kind',
        'preference',
        '--key',
        'user.release-notes.length',
        'Prefer',
        'short',
        'release',
        'notes.',
      ], cwd);
      await invoke(['list'], cwd);
      const handle = log.lines.join('\n').match(/ref: (memdir:[^\s]+\.md)/u)?.[1];
      expect(handle).toBeDefined();
      await invoke(['forget', handle!], cwd);
      await invoke(['list'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('Memory forgotten')).toBe(true);
    expect(log.contains('No accepted memories yet')).toBe(true);
  });

  it('requires an explicit semantic key for slash remember and preserves fact conflicts', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['remember', 'This', 'project', 'uses', 'npm.'], cwd);
      await invoke([
        'remember',
        '--kind',
        'fact',
        '--key',
        'project.package-manager',
        'This',
        'project',
        'uses',
        'npm.',
      ], cwd);
      await invoke([
        'remember',
        '--kind',
        'fact',
        '--key',
        'project.package-manager',
        'This',
        'project',
        'uses',
        'pnpm.',
      ], cwd);
      await invoke(['decisions'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('requires --key')).toBe(true);
    expect(log.contains('Memory remembered')).toBe(true);
    expect(log.contains('needs your decision')).toBe(true);
    expect(log.contains('This project uses pnpm.')).toBe(true);
  });

  it('rebuild writes MEMORY.md sorted by mtime descending', async () => {
    const memoryDir = activePlane!.memoryRoot;
    fs.mkdirSync(memoryDir, { recursive: true });

    const olderPath = path.join(memoryDir, 'feedback_old.md');
    const newerPath = path.join(memoryDir, 'user_new.md');
    fs.writeFileSync(
      olderPath,
      '---\nname: Old feedback\ndescription: Older entry\ntype: feedback\n---\nBody.',
      'utf-8',
    );
    fs.writeFileSync(
      newerPath,
      '---\nname: New user note\ndescription: Newer entry\ntype: user\n---\nBody.',
      'utf-8',
    );
    // Force a deterministic mtime ordering (newer entry must rank
    // higher than older). Use stable absolute timestamps so the test
    // does not race the filesystem's mtime resolution.
    const baseTime = new Date('2026-05-01T00:00:00Z');
    fs.utimesSync(olderPath, baseTime, new Date('2026-05-01T00:00:00Z'));
    fs.utimesSync(newerPath, baseTime, new Date('2026-05-02T00:00:00Z'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['rebuild'], cwd);
    } finally {
      restore();
    }

    const entrypointPath = activePlane!.entrypointPath;
    const raw = fs.readFileSync(entrypointPath, 'utf-8');
    const lines = raw.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('- [New user note](user_new.md) — Newer entry');
    expect(lines[1]).toBe('- [Old feedback](feedback_old.md) — Older entry');
    expect(log.contains('rebuilt MEMORY.md with 2 entries')).toBe(true);
  });

  it('rebuild reports malformed frontmatter as fallback line + warning', async () => {
    const memoryDir = activePlane!.memoryRoot;
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'no_frontmatter.md'), 'just body, no frontmatter', 'utf-8');

    const { log, restore } = captureConsole();
    try {
      await invoke(['rebuild'], cwd);
    } finally {
      restore();
    }

    const raw = fs.readFileSync(activePlane!.entrypointPath, 'utf-8');
    expect(raw).toContain('- [no_frontmatter](no_frontmatter.md) — no_frontmatter');
    expect(log.contains('no parsable frontmatter')).toBe(true);
  });

  it('rebuild is a no-op when the directory is empty', async () => {
    const memoryDir = activePlane!.memoryRoot;
    fs.mkdirSync(memoryDir, { recursive: true });

    const { log, restore } = captureConsole();
    try {
      await invoke(['rebuild'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('no topic files found')).toBe(true);
    // MEMORY.md must NOT be created when there's nothing to index.
    expect(fs.existsSync(activePlane!.entrypointPath)).toBe(false);
  });

  it('open launches the storage artifact in an external editor without rewriting it', async () => {
    await invoke([
      'remember',
      '--kind',
      'procedure',
      '--key',
      'project.testing.focused',
      'Use',
      'focused',
      'tests.',
    ], cwd);
    const before = fs.readFileSync(activePlane!.entrypointPath, 'utf8');
    const openExternalPath = vi.fn().mockResolvedValue(undefined);
    const { log, restore } = captureConsole();
    try {
      await invoke(['open'], cwd, { openExternalPath });
    } finally {
      restore();
    }

    expect(log.contains('opened in your external editor/file browser')).toBe(true);
    expect(log.contains(activePlane!.entrypointPath)).toBe(true);
    expect(openExternalPath).toHaveBeenCalledWith(activePlane!.entrypointPath);
    expect(fs.readFileSync(activePlane!.entrypointPath, 'utf8')).toBe(before);
  });

  it('open launches the current external Memory directory even before the first memory exists', async () => {
    const openExternalPath = vi.fn().mockResolvedValue(undefined);

    await invoke(['open'], cwd, { openExternalPath });

    expect(openExternalPath).toHaveBeenCalledWith(activePlane!.memoryRoot);
    expect(fs.statSync(activePlane!.memoryRoot).isDirectory()).toBe(true);
  });

  it('builds a Windows external-open invocation without PowerShell argument ambiguity', () => {
    const target = 'C:\\Users\\ADMIN\\.kodax\\projects\\project with spaces\\memory\\MEMORY.md';
    const invocation = externalOpenInvocation('win32', target);

    expect(invocation.executable.toLowerCase().replaceAll('\\', '/')).toMatch(/\/explorer\.exe$/);
    expect(invocation.args).toEqual([target]);
  });

  it('unknown subcommand prints help and does not throw', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['frobnicate'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('unknown subcommand: frobnicate')).toBe(true);
    expect(log.contains('View and manage durable Memory')).toBe(true);
  });

  it('help subcommand prints usage', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['help'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('/memory remember')).toBe(true);
    expect(log.contains('/memory rebuild')).toBe(false);
    expect(log.contains('/memory open')).toBe(true);
  });

  it('pending/show/approve use the memory control plane over the F224 store', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-memory-command'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['pending'], cwd);
      await invoke(['show', 'memory:p-memory-command'], cwd);
      await invoke(['approve', 'memory:p-memory-command'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('decisions that need you')).toBe(true);
    expect(log.contains('memory:p-memory-command')).toBe(true);
    expect(log.contains('approved and applied memory:p-memory-command')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('approved');
    expect(fs.readFileSync(activePlane!.entrypointPath, 'utf8')).toContain('Memory command stores project facts.');
  });

  it('requires a shown preview before approving a memory proposal', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-direct-approve'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['approve', 'memory:p-direct-approve'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('preview required before approve')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('pending');
  });

  it('expires shown preview fingerprints before approving a memory proposal', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-expired-preview'));
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    const { log, restore } = captureConsole();
    try {
      await invoke(['show', 'memory:p-expired-preview'], cwd);
      nowSpy.mockReturnValue(1_000 + 16 * 60 * 1000);
      await invoke(['approve', 'memory:p-expired-preview'], cwd);
    } finally {
      restore();
      nowSpy.mockRestore();
    }

    expect(log.contains('preview required before approve')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('pending');
  });

  it('fails closed when MEMORY.md changes after the shown preview', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-stale-preview'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['show', 'memory:p-stale-preview'], cwd);
      const memoryDir = activePlane!.memoryRoot;
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(
        activePlane!.entrypointPath,
        '- [Changed](changed.md) - changed after preview\n',
        'utf8',
      );
      await invoke(['approve', 'memory:p-stale-preview'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('was not applied')).toBe(true);
    expect(log.contains('changed after preview')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    expect(store.proposals[0]?.status).toBe('pending');
  });

  it('passes rejection feedback through the plane controller reviewer', async () => {
    // FEATURE_298 T36 — the reviewer is Host-side; the command still routes
    // feedback through the plane controller, which notifies the reviewer.
    let received: Parameters<NonNullable<KodaXOptions['memoryReviewer']>>[0] | undefined;
    activePlane = buildMemoryPlane(tempHome, cwd, async (input) => {
      received = input;
      return {
        trigger: input.trigger,
        createdAt: '2026-07-06T00:00:00.000Z',
        sourceRefs: input.sourceRefs,
        candidateRefs: input.candidateRefs,
        actions: [],
        warnings: input.warnings,
      };
    });

    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-review-reject'));

    const { log, restore } = captureConsole();
    try {
      const reviewerCallbacks = { memory: () => activePlane };
      await invoke(['show', 'memory:p-review-reject'], cwd, reviewerCallbacks);
      await invoke(['reject', 'memory:p-review-reject', 'wrong', 'memory'], cwd, reviewerCallbacks);
    } finally {
      restore();
    }

    expect(log.contains('rejected memory:p-review-reject')).toBe(true);
    expect(log.contains('review actions: 0')).toBe(true);
    expect(received?.trigger).toBe('proposal_rejected');
    expect(received?.userFeedback).toBe('wrong memory');
  });

  it('manual acceptance path covers pending, show, reject, and approve', async () => {
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-accept-apply'));
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-accept-reject'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['pending'], cwd);
      await invoke(['show', 'memory:p-accept-apply'], cwd);
      await invoke(['show', 'memory:p-accept-reject'], cwd);
      await invoke(['reject', 'memory:p-accept-reject', 'not', 'useful'], cwd);
      await invoke(['approve', 'memory:p-accept-apply'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('decisions that need you')).toBe(true);
    expect(log.contains('memory:p-accept-apply')).toBe(true);
    expect(log.contains('rejected memory:p-accept-reject')).toBe(true);
    expect(log.contains('approved and applied memory:p-accept-apply')).toBe(true);
    const store = await readLearningProposalStore(resolveLearningProposalStore(cwd));
    const statuses = new Map(store.proposals.map((proposal) => [proposal.proposalId, proposal.status]));
    expect(statuses.get('p-accept-apply')).toBe('approved');
    expect(statuses.get('p-accept-reject')).toBe('rejected');
  });

  it('keeps accepted Memory and decision number namespaces unambiguous', async () => {
    await invoke([
      'remember',
      '--kind',
      'preference',
      '--key',
      'user.release-notes.length',
      'Prefer',
      'compact',
      'release',
      'notes.',
    ], cwd);
    await upsertLearningProposal(resolveLearningProposalStore(cwd), memoryProposal('p-number-space'));

    const { log, restore } = captureConsole();
    try {
      await invoke(['show', '1'], cwd);
      await invoke(['show', 'memory:1'], cwd);
      await invoke(['show', 'decision:1'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('Memory or decision not found: 1')).toBe(true);
    expect(log.contains('Prefer compact release notes.')).toBe(true);
    expect(log.contains('memory:p-number-space')).toBe(true);
  });
});

describe('FEATURE_289 §3.5 — /memory status', () => {
  let tempHome: string;
  let cwd: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-status-home-'));
    setAgentConfigHome(tempHome);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-status-cwd-'));
    activeTempHome = tempHome;
    activePlane = buildMemoryPlane(tempHome, cwd);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function invokeStatus(
    contextOverrides: Record<string, unknown>,
    callbacks: Partial<MemoryCommandCallbacks>,
  ) {
    const context = {
      messages: [],
      runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
      sessionId: 'session-status-test',
      ...contextOverrides,
    };
    await memoryCommand.handler(
      ['status'],
      context as never,
      { memory: (root) => buildMemoryPlane(activeTempHome, root), ...callbacks } as MemoryCommandCallbacks,
      {} as never,
    );
  }

  const configuredCallbacks: Partial<MemoryCommandCallbacks> = {
    createKodaXOptions: () => ({
      provider: 'anthropic',
      memoryReviewer: async (input: MemoryReviewModelInput) => ({
        trigger: input.trigger,
        createdAt: '2026-08-01T00:00:00.000Z',
        sourceRefs: input.sourceRefs,
        candidateRefs: input.candidateRefs,
        actions: [],
        warnings: input.warnings,
      }),
    } as KodaXOptions),
  };

  it('renders zero values on an empty project without throwing', async () => {
    const { log, restore } = captureConsole();
    try {
      await invokeStatus({}, configuredCallbacks);
    } finally {
      restore();
    }

    expect(log.contains('per-project memory directory')).toBe(true);
    expect(log.contains('this-session pipeline')).toBe(true);
    expect(log.contains('outcome digests : 0')).toBe(true);
    expect(log.contains('review receipts : 0')).toBe(true);
    expect(log.contains('client notices  : 0')).toBe(true);
    expect(log.contains('pending: 0')).toBe(true);
    expect(log.contains('configured (custom reviewer bound)')).toBe(true);
    // digests == 0 => capture segment diagnosis.
    expect(log.contains('capture segment')).toBe(true);
  });

  it('flags the review segment when digests exist but no review completed', async () => {
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: null,
      entries: [
        {
          id: 'digest-1',
          parentId: null,
          timestamp: '2026-08-01T00:00:00.000Z',
          type: 'memory_outcome_digest',
          digest: {
            id: 'digest-1',
            reviewKey: 'review:digest-1',
            sessionId: 'session-status-test',
            branchId: 'main',
            sequence: 1,
            objective: 'objective',
            approach: 'approach',
            outcome: 'succeeded',
            summary: 'summary',
            evidenceRefs: [],
            visibility: 'prompt_safe',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        },
        {
          id: 'notice-1',
          parentId: null,
          timestamp: '2026-08-01T00:00:00.000Z',
          type: 'client_notice',
          source: 'memory-agent',
          content: 'Memory updated: x',
        },
        {
          id: 'notice-2',
          parentId: null,
          timestamp: '2026-08-01T00:00:00.000Z',
          type: 'client_notice',
          source: 'other-agent',
          content: 'not a memory notice',
        },
      ],
    };

    const { log, restore } = captureConsole();
    try {
      await invokeStatus({ lineage }, configuredCallbacks);
    } finally {
      restore();
    }

    expect(log.contains('outcome digests : 1')).toBe(true);
    expect(log.contains('review receipts : 0')).toBe(true);
    // Only client_notice entries with source 'memory-agent' are counted.
    expect(log.contains('client notices  : 1')).toBe(true);
    expect(log.contains('review segment: digests captured but no review completed')).toBe(true);
    expect(log.contains('capture segment')).toBe(false);
  });

  it('diagnoses a previous-session backlog as a review problem', async () => {
    const options = configuredCallbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    const previousIdentity = { ...deriveCodingMemoryIdentityFromRoot(tempHome, cwd), sessionId: 'previous-session' };
    await persistPendingEpisodeReview(previousIdentity, {
      id: 'digest-previous-session',
      reviewKey: 'review:previous-session',
      sessionId: previousIdentity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'diagnose a cross-session backlog',
      approach: 'persist before opening a new session',
      outcome: 'succeeded',
      summary: 'waiting for review',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const { log, restore } = captureConsole();
    try {
      await invokeStatus({}, configuredCallbacks);
    } finally {
      restore();
    }

    expect(log.contains('pending: 1')).toBe(true);
    expect(log.contains('review segment: pending reviews from earlier sessions are waiting')).toBe(true);
    expect(log.contains('capture segment')).toBe(false);
  });

  it('does not claim that no review completed when a receipt exists beside a backlog', async () => {
    const options = configuredCallbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    const previousIdentity = { ...deriveCodingMemoryIdentityFromRoot(tempHome, cwd), sessionId: 'pending-sibling-session' };
    await persistPendingEpisodeReview(previousIdentity, {
      id: 'digest-pending-sibling',
      reviewKey: 'review:pending-sibling',
      sessionId: previousIdentity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'retain a separate pending review',
      approach: 'persist in a sibling session',
      outcome: 'succeeded',
      summary: 'still waiting',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: null,
      entries: [{
        id: 'digest-completed',
        parentId: null,
        timestamp: '2026-08-01T01:00:00.000Z',
        type: 'memory_outcome_digest',
        digest: {
          id: 'digest-completed',
          reviewKey: 'review:completed',
          sessionId: 'session-status-test',
          branchId: 'main',
          sequence: 1,
          objective: 'complete a review',
          approach: 'review it',
          outcome: 'succeeded',
          summary: 'completed',
          evidenceRefs: [],
          visibility: 'prompt_safe',
          createdAt: '2026-08-01T01:00:00.000Z',
        },
      }, {
        id: 'receipt-completed',
        parentId: null,
        timestamp: '2026-08-01T01:01:00.000Z',
        type: 'memory_review_receipt',
        reviewKey: 'review:completed',
        proposalIds: [],
        status: 'no_action',
        completedAt: '2026-08-01T01:01:00.000Z',
      }],
    };

    const { log, restore } = captureConsole();
    try {
      await invokeStatus({ lineage }, configuredCallbacks);
    } finally {
      restore();
    }

    expect(log.contains('review receipts : 1')).toBe(true);
    expect(log.contains('review segment: pending reviews are still waiting')).toBe(true);
    expect(log.contains('no review ever completed')).toBe(false);
  });

  it('reports a missing reviewer when the provider is not configured', async () => {
    const callbacks: Partial<MemoryCommandCallbacks> = {
      // An unresolvable provider name is deterministically unconfigured.
      createKodaXOptions: () => ({ provider: 'definitely-unconfigured-provider' } as KodaXOptions),
    };

    const { log, restore } = captureConsole();
    try {
      await invokeStatus({}, callbacks);
    } finally {
      restore();
    }

    expect(log.contains('MISSING — Host reviewer provider is not configured')).toBe(true);
    expect(log.contains('reviewer missing')).toBe(true);
  });

  it('renders the Host-backed status even when KodaX options are not bound', async () => {
    // FEATURE_298 T36 — status no longer depends on UI-bound options; the
    // Host plane answers with zero values instead of an unavailable note.
    const { log, restore } = captureConsole();
    try {
      await invokeStatus({}, {});
    } finally {
      restore();
    }

    expect(log.contains('per-project memory directory')).toBe(true);
    expect(log.contains('this-session pipeline')).toBe(true);
    expect(log.contains('unavailable — KodaX options are not bound in this session')).toBe(false);
  });
  it('lists persisted episode-review jobs separately from memory proposals', async () => {
    const options = configuredCallbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    for (const [sequence, sessionId] of [[1, 'review-session-a'], [2, 'review-session-b']] as const) {
      const identity = { ...deriveCodingMemoryIdentityFromRoot(tempHome, cwd), sessionId };
      await persistPendingEpisodeReview(identity, {
        id: `digest-${sequence}`,
        reviewKey: `review:digest-${sequence}`,
        sessionId,
        branchId: 'main',
        sequence,
        objective: 'inspect the memory backlog',
        approach: 'persist an episode review',
        outcome: 'succeeded',
        summary: `pending review ${sequence}`,
        evidenceRefs: [],
        visibility: 'prompt_safe',
        createdAt: `2026-08-0${sequence}T00:00:00.000Z`,
      });
    }

    const context = {
      messages: [],
      runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
      sessionId: 'session-status-test',
    };
    const { log, restore } = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews', '1'],
        context as never,
        { memory: (root) => buildMemoryPlane(activeTempHome, root), ...configuredCallbacks } as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      restore();
    }

    expect(log.contains('[memory] episode-review jobs')).toBe(true);
    expect(log.contains('showing 1 of 2')).toBe(true);
    expect(log.contains('review:digest-1')).toBe(true);
    expect(log.contains('review:digest-2')).toBe(false);
    expect(log.contains('kodax memory review-drain')).toBe(true);
  });

  it('separates attention jobs from the automatic review queue', async () => {
    const options = configuredCallbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    const identity = { ...deriveCodingMemoryIdentityFromRoot(tempHome, cwd), sessionId: 'attention-session' };
    const persisted = await persistPendingEpisodeReview(identity, {
      id: 'digest-attention',
      reviewKey: 'review:attention',
      sessionId: identity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'surface an exhausted review',
      approach: 'exhaust provider retries',
      outcome: 'failed',
      summary: 'operator intervention required',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    for (const minute of [1, 2, 7, 37]) {
      const now = new Date(`2026-08-01T00:${String(minute).padStart(2, '0')}:00.000Z`);
      const claim = await claimEpisodeReview(identity, persisted.entry.jobId, { now });
      if (claim === undefined) throw new Error('test setup expected a claim');
      await failEpisodeReviewAttempt(identity, claim, {
        kind: 'provider_error',
        message: 'review provider failed',
      }, now);
    }

    const statusOutput = captureConsole();
    try {
      await invokeStatus({}, configuredCallbacks);
    } finally {
      statusOutput.restore();
    }
    expect(statusOutput.log.contains('pending: 1')).toBe(true);
    expect(statusOutput.log.contains('automatic queue: 0')).toBe(true);
    expect(statusOutput.log.contains('needs attention: 1')).toBe(true);
    expect(statusOutput.log.contains('cannot be processed by review-drain')).toBe(true);
    expect(statusOutput.log.contains('Run `kodax memory review-drain`')).toBe(false);

    const reviewsOutput = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews'],
        {
          messages: [],
          runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
          sessionId: 'session-status-test',
        } as never,
        { memory: (root: string) => buildMemoryPlane(activeTempHome, root), ...configuredCallbacks } as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      reviewsOutput.restore();
    }
    expect(reviewsOutput.log.contains('needs attention: 1')).toBe(true);
    expect(reviewsOutput.log.contains('Process this queue with')).toBe(false);
  });

  it('does not recommend a current-project drain for another project backlog', async () => {
    const options = configuredCallbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    const currentIdentity = { ...deriveCodingMemoryIdentityFromRoot(tempHome, cwd), sessionId: 'foreign-project-session' };
    await persistPendingEpisodeReview({
      ...currentIdentity,
      projectId: 'remote:foreign.example/other-project',
    }, {
      id: 'digest-foreign-project',
      reviewKey: 'review:foreign-project',
      sessionId: currentIdentity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'belong to another project',
      approach: 'persist under a foreign project identity',
      outcome: 'succeeded',
      summary: 'must not be advertised as locally drainable',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const statusOutput = captureConsole();
    try {
      await invokeStatus({}, configuredCallbacks);
    } finally {
      statusOutput.restore();
    }
    expect(statusOutput.log.contains('pending: 0')).toBe(true);
    expect(statusOutput.log.contains('Run `kodax memory review-drain`')).toBe(false);

    const reviewsOutput = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews'],
        {
          messages: [],
          runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
          sessionId: 'session-status-test',
        } as never,
        { memory: (root: string) => buildMemoryPlane(activeTempHome, root), ...configuredCallbacks } as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      reviewsOutput.restore();
    }
    expect(reviewsOutput.log.contains('showing 0 of 0')).toBe(true);
    expect(reviewsOutput.log.contains('(none)')).toBe(true);
    expect(reviewsOutput.log.contains('review:foreign-project')).toBe(false);
  });

  it('uses the production execution cwd for local review ownership', async () => {
    const executionCwd = path.join(cwd, 'nested-execution-cwd');
    fs.mkdirSync(executionCwd, { recursive: true });
    const callbacks: Partial<MemoryCommandCallbacks> = {
      createKodaXOptions: () => ({
        provider: 'anthropic',
        context: { executionCwd },
        memoryReviewer: configuredCallbacks.createKodaXOptions?.().memoryReviewer,
      } as KodaXOptions),
    };
    const options = callbacks.createKodaXOptions?.();
    if (options === undefined) throw new Error('test setup expected KodaX options');
    const owner = { ...deriveCodingMemoryIdentityFromRoot(tempHome, executionCwd), sessionId: 'nested-session' };
    await persistPendingEpisodeReview(owner, {
      id: 'digest-nested-cwd',
      reviewKey: 'review:nested-cwd',
      sessionId: owner.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'retain local ownership from a nested cwd',
      approach: 'persist with the production execution cwd',
      outcome: 'succeeded',
      summary: 'visible from the matching review drain',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const output = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews'],
        {
          messages: [],
          runtimeInfo: { workspaceRoot: cwd, executionCwd },
          sessionId: 'session-status-test',
        } as never,
        { memory: (root: string) => buildMemoryPlane(activeTempHome, root), ...callbacks } as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      output.restore();
    }

    expect(output.log.contains('showing 1 of 1')).toBe(true);
    expect(output.log.contains('review:nested-cwd')).toBe(true);
  });

  it('ignores a caller-supplied memory identity — the Host derives it', async () => {
    const customIdentity = {
      configHome: tempHome,
      tenantId: 'tenant-host-bound',
      userId: 'user-host-bound',
      workspaceId: 'workspace-host-bound',
      agentId: 'agent-host-bound',
      projectId: 'remote:host.example/project',
      sessionId: 'session-host-bound',
    } as const;
    const callbacks: Partial<MemoryCommandCallbacks> = {
      createKodaXOptions: () => ({
        provider: 'anthropic',
        context: { executionCwd: cwd, memoryIdentity: customIdentity },
      } as KodaXOptions),
    };
    await persistPendingEpisodeReview(customIdentity, {
      id: 'digest-host-bound',
      reviewKey: 'review:host-bound',
      sessionId: customIdentity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'use a host-provided owner identity',
      approach: 'persist under the production owner',
      outcome: 'succeeded',
      summary: 'visible to the matching embedded REPL',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const output = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews'],
        {
          messages: [],
          runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
          sessionId: 'different-repl-session',
        } as never,
        { memory: (root: string) => buildMemoryPlane(activeTempHome, root), ...callbacks } as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      output.restore();
    }

    expect(output.log.contains('showing 0 of 0')).toBe(true);
    expect(output.log.contains('review:host-bound')).toBe(false);
  });

  it('keeps a caller-supplied project-less identity out of Host-derived reviews', async () => {
    const projectlessIdentity = {
      configHome: tempHome,
      tenantId: 'tenant-host-projectless',
      agentId: 'agent-host-projectless',
      sessionId: 'session-host-projectless',
    } as const;
    const foreignIdentity = {
      ...projectlessIdentity,
      projectId: 'remote:host.example/foreign-project',
    } as const;
    const callbacks: Partial<MemoryCommandCallbacks> = {
      createKodaXOptions: () => ({
        provider: 'anthropic',
        context: { executionCwd: cwd, memoryIdentity: projectlessIdentity },
      } as KodaXOptions),
    };
    await persistPendingEpisodeReview(projectlessIdentity, {
      id: 'digest-host-projectless',
      reviewKey: 'review:host-projectless',
      sessionId: projectlessIdentity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'query only ownerless reviews',
      approach: 'use the host-provided owner identity',
      outcome: 'succeeded',
      summary: 'visible to the matching embedded REPL',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await persistPendingEpisodeReview(foreignIdentity, {
      id: 'digest-host-foreign-project',
      reviewKey: 'review:host-foreign-project',
      sessionId: foreignIdentity.sessionId,
      branchId: 'main',
      sequence: 2,
      objective: 'keep another project private',
      approach: 'persist under a project-owned identity',
      outcome: 'failed',
      summary: 'must not appear in the project-less REPL',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-01T00:01:00.000Z',
    });

    const output = captureConsole();
    try {
      await memoryCommand.handler(
        ['reviews'],
        {
          messages: [],
          runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
          sessionId: 'different-repl-session',
        } as never,
        { memory: (root: string) => buildMemoryPlane(activeTempHome, root), ...callbacks } as MemoryCommandCallbacks,
        {} as never,
      );
    } finally {
      output.restore();
    }

    expect(output.log.contains('showing 0 of 0')).toBe(true);
    expect(output.log.contains('review:host-projectless')).toBe(false);
    expect(output.log.contains('review:host-foreign-project')).toBe(false);
  });

  it('labels pending as the proposal compatibility alias', async () => {
    const { log, restore } = captureConsole();
    try {
      await invoke(['pending'], cwd);
    } finally {
      restore();
    }

    expect(log.contains('compatibility alias for /memory decisions')).toBe(true);
    expect(log.contains('episode-review jobs: /memory reviews')).toBe(false);
    expect(log.contains('decisions that need you')).toBe(true);
  });
});

function memoryProposal(proposalId: string): MemoryLearningHandoff {  return {
    destination: 'memdir_handoff',
    proposalId,
    origin: 'background_learning',
    userLabel: 'context_note',
    memoryKind: 'project',
    body: 'Memory command stores project facts.',
    metadata: {
      writeOrigin: 'background_learning',
      executionContext: 'primary',
      sessionId: 'session-memory-command',
      sourceRefs: ['turn:memory-command'],
      completedTurn: true,
    },
  };
}
