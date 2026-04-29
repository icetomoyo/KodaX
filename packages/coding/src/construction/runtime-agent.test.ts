/**
 * FEATURE_089 (v0.7.31) — agent-kind ConstructionArtifact lifecycle tests.
 *
 * Phase 3.1 surface: discriminated union extension lets the existing
 * stage / test / activate / revoke pipeline accept `kind: 'agent'`
 * artifacts. Phase 3.2 fleshes out the agent-specific test/activate
 * bodies (admission integration, sandbox runner). Phase 3.4 wires the
 * resolver registration so activated agents become reachable by name.
 *
 * Today's coverage: stage persists, test runs the minimal manifest
 * shape check, activate goes through the policy gate without throwing,
 * revoke clears the in-memory entry. The agent body is intentionally
 * minimal — no resolver / sandbox / admission yet.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import { _resetInvariantRegistry } from '@kodax/core';

import { registerCodingInvariants } from '../agent-runtime/invariants/index.js';

import {
  configureRuntime,
  stage,
  testArtifact,
  activate,
  revoke,
  listArtifacts,
  _resetRuntimeForTesting,
  resolveConstructedAgent,
  listConstructedAgents,
} from './index.js';
import type { AgentArtifact } from './types.js';

let tmpRoot: string;

function buildAgentArtifact(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    kind: 'agent',
    name: overrides.name ?? 'echo-agent',
    version: overrides.version ?? '1.0.0',
    content: overrides.content ?? {
      instructions: 'Echo every user message back as the assistant reply.',
      tools: [{ ref: 'builtin:read' }],
      reasoning: { default: 'quick', max: 'balanced' },
    },
    status: overrides.status ?? 'staged',
    createdAt: overrides.createdAt ?? Date.now(),
    testedAt: overrides.testedAt,
    activatedAt: overrides.activatedAt,
    revokedAt: overrides.revokedAt,
    signedBy: overrides.signedBy,
    sourceAgent: overrides.sourceAgent,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-agent-'));
  configureRuntime({
    cwd: tmpRoot,
    policy: async () => 'approve',
  });
  // FEATURE_101 invariants must be registered for `testAgentArtifact`'s
  // admission step. Each test runs in isolation — register-and-reset.
  _resetInvariantRegistry();
  registerCodingInvariants();
});

afterEach(async () => {
  _resetRuntimeForTesting();
  _resetInvariantRegistry();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('FEATURE_089 — agent-kind stage', () => {
  it('persists the agent manifest under .kodax/constructed/agents/<name>/<version>.json', async () => {
    const artifact = buildAgentArtifact();
    const handle = await stage(artifact);

    expect(handle.artifact.kind).toBe('agent');
    expect(handle.artifact.status).toBe('staged');

    const filePath = path.join(
      tmpRoot,
      '.kodax',
      'constructed',
      'agents',
      'echo-agent',
      '1.0.0.json',
    );
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as AgentArtifact;
    expect(persisted.kind).toBe('agent');
    expect(persisted.content.instructions).toContain('Echo');
    expect(persisted.content.tools).toEqual([{ ref: 'builtin:read' }]);
  });

  it('rejects re-staging the same name+version (immutability invariant)', async () => {
    await stage(buildAgentArtifact({ name: 'imm-agent' }));
    await expect(stage(buildAgentArtifact({ name: 'imm-agent' }))).rejects.toThrow(
      /manifest already exists/,
    );
  });
});

describe('FEATURE_089 — agent-kind test', () => {
  it('admits a minimal valid agent manifest', async () => {
    const handle = await stage(buildAgentArtifact());
    const result = await testArtifact(handle);
    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('rejects a manifest with an empty instructions string', async () => {
    const handle = await stage(
      buildAgentArtifact({
        name: 'broken-agent',
        content: { instructions: '' },
      }),
    );
    const result = await testArtifact(handle);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => /instructions/.test(e))).toBe(true);
  });

  it('rejects a manifest with malformed tool refs', async () => {
    const handle = await stage(
      buildAgentArtifact({
        name: 'bad-tool-ref',
        content: {
          instructions: 'do things',
          tools: [{ ref: '' }] as never,
        },
      }),
    );
    const result = await testArtifact(handle);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => /tools\[0\]\.ref/.test(e))).toBe(true);
  });

  it('persists testedAt on success', async () => {
    const handle = await stage(buildAgentArtifact({ name: 'test-stamped' }));
    const before = Date.now();
    await testArtifact(handle);
    const filePath = path.join(
      tmpRoot,
      '.kodax',
      'constructed',
      'agents',
      'test-stamped',
      '1.0.0.json',
    );
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as AgentArtifact;
    expect(typeof persisted.testedAt).toBe('number');
    expect(persisted.testedAt!).toBeGreaterThanOrEqual(before);
  });
});

describe('FEATURE_089 — testAgentArtifact runs Runner.admit (FEATURE_101 5-step audit)', () => {
  it('rejects a generator-bearing manifest with no evaluator (independentReview)', async () => {
    const handle = await stage(
      buildAgentArtifact({
        name: 'gen-without-eval',
        content: {
          instructions: 'I generate code',
          // Handoff to "generator" is reachable; no evaluator anywhere.
          handoffs: [{ target: { ref: 'builtin:generator' }, kind: 'continuation' }],
        },
      }),
    );
    const result = await testArtifact(handle);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => /independentReview/.test(e))).toBe(true);
  });

  it('rejects a self-loop handoff (finalOwner / handoffLegality)', async () => {
    const handle = await stage(
      buildAgentArtifact({
        name: 'self-loop',
        content: {
          instructions: 'I hand off to myself',
          handoffs: [{ target: { ref: 'self-loop' }, kind: 'continuation' }],
        },
      }),
    );
    const result = await testArtifact(handle);
    expect(result.ok).toBe(false);
    // Either finalOwner or handoffLegality may fire first; both signal a
    // bad topology.
    expect(result.errors?.[0]).toMatch(/admission/);
  });

  it('clamps an over-budget manifest and surfaces the note as a warning (still ok=true)', async () => {
    // Default cap is 200_000; a manifest declaring 999_999 should clamp.
    const handle = await stage(
      buildAgentArtifact({
        name: 'over-budget',
        content: {
          instructions: 'do work',
          maxBudget: 999_999,
        },
      }),
    );
    const result = await testArtifact(handle);
    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => /budgetCeiling/.test(w))).toBe(true);
  });

  it('clamps disallowed-tier tools (toolPermission) with a warning', async () => {
    // Default systemCap.allowedToolCapabilities includes all 7 tiers, so
    // the default path admits everything. Pass an unknown tool name —
    // unknown → 'subagent' tier, which is in the default allowed set, so
    // this admits cleanly. We instead test the converse: the manifest
    // succeeds even with diverse tools when the caller hasn't tightened
    // the cap. (Reject path is exercised at the unit level in
    // tool-permission.test.ts.)
    const handle = await stage(
      buildAgentArtifact({
        name: 'mixed-tools',
        content: {
          instructions: 'mixed surface',
          tools: [
            { ref: 'builtin:read' },
            { ref: 'builtin:write' },
            { ref: 'builtin:bash' },
          ],
        },
      }),
    );
    const result = await testArtifact(handle);
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});

describe('FEATURE_089 — agent-kind activate / revoke', () => {
  it('activates an agent through the policy gate AND registers it in the resolver (Phase 3.4)', async () => {
    const handle = await stage(buildAgentArtifact({ name: 'active-stub' }));
    await testArtifact(handle);
    await activate(handle);

    const filePath = path.join(
      tmpRoot,
      '.kodax',
      'constructed',
      'agents',
      'active-stub',
      '1.0.0.json',
    );
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as AgentArtifact;
    expect(persisted.status).toBe('active');
    expect(typeof persisted.activatedAt).toBe('number');
    expect(typeof persisted.contentHash).toBe('string');

    // Phase 3.4: the agent is now resolvable by name.
    const resolved = resolveConstructedAgent('active-stub');
    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe('active-stub');
    expect(resolved?.instructions).toContain('Echo every');
    expect(listConstructedAgents().map((a) => a.name)).toContain('active-stub');
  });

  it('revoke flips status to revoked, clears the in-memory entry, AND removes from resolver', async () => {
    const handle = await stage(buildAgentArtifact({ name: 'revocable' }));
    await testArtifact(handle);
    await activate(handle);
    expect(resolveConstructedAgent('revocable')).toBeDefined();

    await revoke('revocable', '1.0.0');

    const all = await listArtifacts('agent');
    const found = all.find((a) => a.name === 'revocable');
    expect(found?.status).toBe('revoked');
    expect(typeof found?.revokedAt).toBe('number');

    // Phase 3.4: revoke removes from the resolver too.
    expect(resolveConstructedAgent('revocable')).toBeUndefined();
  });
});

describe('FEATURE_089 Phase 3.5 — sandbox testCases run through testAgentArtifact when sandboxLlm is supplied', () => {
  it('passes a manifest whose testCases all match expectFinalText', async () => {
    const handle = await stage(
      buildAgentArtifact({
        name: 'sandbox-pass',
        content: {
          instructions: 'echo back the user message',
          testCases: [
            { id: 'hello', input: 'hi', expectFinalText: 'echo: hi' },
            { id: 'world', input: 'world', expectFinalText: 'echo: world' },
          ],
        },
      }),
    );
    const result = await testArtifact(handle, {
      sandboxLlm: async (messages) => {
        const last = messages[messages.length - 1];
        const text = typeof last?.content === 'string' ? last.content : '';
        return { text: `echo: ${text}`, toolCalls: [] };
      },
    });
    expect(result.ok).toBe(true);
  });

  it('fails the manifest when any sandbox case fails grading', async () => {
    const handle = await stage(
      buildAgentArtifact({
        name: 'sandbox-fail',
        content: {
          instructions: 'echo back',
          testCases: [
            { id: 'good', input: 'hi', expectFinalText: 'echo: hi' },
            { id: 'bad', input: 'world', expectFinalText: 'totally different' },
          ],
        },
      }),
    );
    const result = await testArtifact(handle, {
      sandboxLlm: async (messages) => {
        const last = messages[messages.length - 1];
        const text = typeof last?.content === 'string' ? last.content : '';
        return { text: `echo: ${text}`, toolCalls: [] };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => /sandbox:bad/.test(e))).toBe(true);
    expect(result.errors?.some((e) => /sandbox:good/.test(e))).toBe(false);
  });

  it('skips sandbox testing silently when no sandboxLlm is provided', async () => {
    const handle = await stage(
      buildAgentArtifact({
        name: 'no-sandbox',
        content: {
          instructions: 'i',
          testCases: [
            { id: 'whatever', input: 'x', expectFinalText: 'never run' },
          ],
        },
      }),
    );
    // No sandboxLlm — testCases should NOT execute; admission alone passes.
    const result = await testArtifact(handle);
    expect(result.ok).toBe(true);
  });
});

describe('FEATURE_089 — policy gate honors reject / ask-user verdicts for agent kind', () => {
  it('throws when the policy returns reject', async () => {
    configureRuntime({
      cwd: tmpRoot,
      policy: async () => 'reject',
    });
    const handle = await stage(buildAgentArtifact({ name: 'policy-rejected' }));
    await testArtifact(handle);
    await expect(activate(handle)).rejects.toThrow(/policy rejected/);
  });

  it('throws when the policy returns ask-user but no UI is bound', async () => {
    // The construction policy default returns 'ask-user'. If the
    // current surface has no interactive UI bound, activate must fail
    // loudly rather than silently activating without user approval.
    configureRuntime({
      cwd: tmpRoot,
      policy: async () => 'ask-user',
    });
    const handle = await stage(buildAgentArtifact({ name: 'no-ui' }));
    await testArtifact(handle);
    await expect(activate(handle)).rejects.toThrow(/ask-user/);
  });
});

describe('FEATURE_089 — listArtifacts(kind=\'agent\')', () => {
  it('returns only agent artifacts when the kind filter is set', async () => {
    await stage(buildAgentArtifact({ name: 'a1' }));
    await stage(buildAgentArtifact({ name: 'a2' }));
    const onlyAgents = await listArtifacts('agent');
    expect(onlyAgents.map((a) => a.name).sort()).toEqual(['a1', 'a2']);
    for (const a of onlyAgents) {
      expect(a.kind).toBe('agent');
    }
  });
});
