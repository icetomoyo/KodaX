/**
 * FEATURE_087/088 + FEATURE_090 (v0.7.32) — REPL construction bootstrap.
 *
 * Validates the wiring contract between the REPL surface and the
 * construction runtime:
 *
 *   1. bindAskUserForConstruction installs the activeAskUser cell so
 *      the REPL ConstructionPolicy + SelfModifyAskUser can promote
 *      the verdict from 'reject' → 'approve'.
 *   2. bootstrapConstructionRuntime registers a SelfModifyAskUser that
 *      surfaces the LLM diff summary, prev/next instructions, severity,
 *      and remaining-after-approve budget through the bound askUser.
 *   3. Without an activeAskUser binding (ACP / single-shot CLI), the
 *      self-modify gate defaults to 'reject' — the same defensive
 *      posture as the regular ConstructionPolicy.
 *
 * The test injects a deterministic askUser stub and drives the runtime
 * via a self-modify scenario built end-to-end on a tmpdir workspace.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  type AgentArtifact,
  _resetRuntimeForTesting,
  configureRuntime,
  activate,
  drainPendingSwaps,
  hasPendingSwap,
  resolveConstructedAgent,
} from '@kodax/coding';

import {
  bindAskUserForConstruction,
  bootstrapConstructionRuntime,
} from './construction-bootstrap.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-repl-bootstrap-'));
});

afterEach(async () => {
  bindAskUserForConstruction(null);
  _resetRuntimeForTesting();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function persistManifest(artifact: AgentArtifact): Promise<void> {
  const dir = path.join(tmpRoot, '.kodax', 'constructed', 'agents', artifact.name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${artifact.version}.json`),
    JSON.stringify(artifact, null, 2),
    'utf8',
  );
}

function buildAgent(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    kind: 'agent',
    name: overrides.name ?? 'alpha',
    version: overrides.version ?? '1.0.0',
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? Date.now(),
    testedAt: overrides.testedAt ?? Date.now(),
    activatedAt: overrides.activatedAt ?? Date.now(),
    sourceAgent: overrides.sourceAgent,
    content: overrides.content ?? { instructions: 'You are alpha.' },
  } as AgentArtifact;
}

describe('bootstrapConstructionRuntime — self-modify ask-user', () => {
  it('rejects self-modify activation when no askUser is bound', async () => {
    await persistManifest(buildAgent({ name: 'alpha', version: '1.0.0' }));
    await bootstrapConstructionRuntime(tmpRoot);

    const next = buildAgent({
      name: 'alpha',
      version: '1.1.0',
      status: 'staged',
      sourceAgent: 'alpha',
      content: { instructions: 'You are alpha (v1.1).' },
    });
    await persistManifest(next);

    await expect(
      activate({ artifact: next, stagedAt: Date.now() }),
    ).rejects.toThrow(/User rejected/);
  });

  it('surfaces prev/next instructions, severity, and budget through the bound askUser', async () => {
    await persistManifest(
      buildAgent({
        name: 'alpha',
        version: '1.0.0',
        content: { instructions: 'PREVIOUS-INSTRUCTIONS-MARKER' },
      }),
    );
    await bootstrapConstructionRuntime(tmpRoot);

    // Stub LlmReviewer so the dialog gets a deterministic summary.
    configureRuntime({
      llmReviewer: async () =>
        JSON.stringify({
          summary: 'STUB-SUMMARY',
          severity: 'minor',
          flaggedConcerns: ['STUB-CONCERN-A', 'STUB-CONCERN-B'],
        }),
    });

    const askUser = vi.fn().mockResolvedValue('approve');
    bindAskUserForConstruction(askUser);

    const next = buildAgent({
      name: 'alpha',
      version: '1.1.0',
      status: 'staged',
      sourceAgent: 'alpha',
      content: { instructions: 'PROPOSED-INSTRUCTIONS-MARKER' },
    });
    await persistManifest(next);

    await activate({ artifact: next, stagedAt: Date.now() });

    expect(askUser).toHaveBeenCalledOnce();
    const dialog = askUser.mock.calls[0]![0];
    expect(dialog.question).toContain('alpha@1.0.0 → 1.1.0');
    expect(dialog.question).toContain('STUB-SUMMARY');
    expect(dialog.question).toContain('severity=minor');
    expect(dialog.question).toContain('STUB-CONCERN-A');
    expect(dialog.question).toContain('STUB-CONCERN-B');
    expect(dialog.question).toContain('PREVIOUS-INSTRUCTIONS-MARKER');
    expect(dialog.question).toContain('PROPOSED-INSTRUCTIONS-MARKER');
    // Budget snapshot: default 3 slots, after-approve = 2.
    expect(dialog.question).toMatch(/Budget remaining \(after approve\): 2\/3/);
    expect(dialog.options).toEqual([
      expect.objectContaining({ value: 'approve' }),
      expect.objectContaining({ value: 'reject' }),
    ]);
  });

  it('rejection at the dialog leaves the prior version active and budget untouched', async () => {
    await persistManifest(buildAgent({ name: 'alpha', version: '1.0.0' }));
    await bootstrapConstructionRuntime(tmpRoot);

    bindAskUserForConstruction(vi.fn().mockResolvedValue('reject'));

    const next = buildAgent({
      name: 'alpha',
      version: '1.1.0',
      status: 'staged',
      sourceAgent: 'alpha',
      content: { instructions: 'rejected' },
    });
    await persistManifest(next);

    await expect(
      activate({ artifact: next, stagedAt: Date.now() }),
    ).rejects.toThrow(/User rejected/);

    // Resolver still resolves the prior version (rehydration loaded it).
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('You are alpha.');
  });
});

describe('drainPendingSwaps — REPL turn-boundary contract', () => {
  it('promotes a deferred self-modify swap so the next run sees the new version', async () => {
    await persistManifest(
      buildAgent({
        name: 'alpha',
        version: '1.0.0',
        content: { instructions: 'OLD' },
      }),
    );
    await bootstrapConstructionRuntime(tmpRoot);
    bindAskUserForConstruction(vi.fn().mockResolvedValue('approve'));

    const next = buildAgent({
      name: 'alpha',
      version: '1.1.0',
      status: 'staged',
      sourceAgent: 'alpha',
      content: { instructions: 'NEW' },
    });
    await persistManifest(next);

    await activate({ artifact: next, stagedAt: Date.now() });

    // Self-modify swap is deferred (G1) — the in-flight reference is
    // still the old version until the next turn boundary.
    expect(hasPendingSwap('alpha')).toBe(true);
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('OLD');

    // REPL drains at runAgentRound's `finally` boundary.
    const drained = drainPendingSwaps();
    expect(drained).toContain('alpha');

    // Subsequent resolves see the new version.
    expect(hasPendingSwap('alpha')).toBe(false);
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('NEW');
  });
});
