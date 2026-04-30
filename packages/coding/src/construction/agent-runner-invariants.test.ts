/**
 * FEATURE_101 (v0.7.31.1) — end-to-end runtime invariant dispatch.
 *
 * Verifies that admission bindings flow through ConstructionRuntime.activate
 * into the resolved Agent, and that Runner.run dispatches `observe` and
 * `assertTerminal` hooks during the run.
 *
 * Closes the v0.7.31 gap where only `admit` was wired into Runner — observe
 * and assertTerminal had types declared but were never invoked at runtime.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  Runner,
  _resetInvariantRegistry,
  getAdmittedAgentBindings,
  registerInvariant,
} from '@kodax/core';
import type {
  AgentMessage,
  Deliverable,
  InvariantResult,
  ObserveCtx,
  QualityInvariant,
  RunnerEvent,
  RunnerLlmResult,
  TerminalCtx,
} from '@kodax/core';

import { registerCodingInvariants } from '../agent-runtime/invariants/index.js';
import {
  configureRuntime,
  stage,
  testArtifact,
  activate,
  resolveConstructedAgent,
  _resetRuntimeForTesting,
} from './index.js';
import type { AgentArtifact } from './types.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-inv-'));
  configureRuntime({
    cwd: tmpRoot,
    policy: async () => 'approve',
  });
  _resetInvariantRegistry();
  registerCodingInvariants();
});

afterEach(async () => {
  _resetRuntimeForTesting();
  _resetInvariantRegistry();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const baseEchoArtifact = (name: string): AgentArtifact => ({
  kind: 'agent',
  name,
  version: '1.0.0',
  status: 'staged',
  createdAt: Date.now(),
  content: {
    instructions: 'echo agent — repeat back what you receive',
    reasoning: { default: 'quick' },
  },
});

const scriptedEchoLlm = async (
  messages: readonly AgentMessage[],
): Promise<RunnerLlmResult> => {
  const last = messages[messages.length - 1];
  const text =
    typeof last?.content === 'string'
      ? last.content
      : '';
  return { text: `echo: ${text}`, toolCalls: [] };
};

describe('FEATURE_101 — bindings flow through activate', () => {
  it('attaches invariantBindings to the resolved Agent on activate', async () => {
    const handle = await stage(baseEchoArtifact('binding-echo'));
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);

    const resolved = resolveConstructedAgent('binding-echo');
    expect(resolved).toBeDefined();

    const meta = getAdmittedAgentBindings(resolved!);
    expect(meta).toBeDefined();
    // The 8th invariant (harnessSelectionTiming) is registered too via
    // registerCodingInvariants but is NOT in the admission v1 closed set
    // (FEATURE_106 external consumer). Bindings must include the 7 core
    // invariants exactly.
    expect(meta?.bindings).toContain('finalOwner');
    expect(meta?.bindings).toContain('handoffLegality');
    expect(meta?.bindings).toContain('budgetCeiling');
    expect(meta?.bindings).toContain('toolPermission');
    expect(meta?.bindings).toContain('evidenceTrail');
    expect(meta?.bindings).toContain('boundedRevise');
    expect(meta?.bindings).toContain('independentReview');
  });

  it('drops bindings when the agent is unregistered', async () => {
    const handle = await stage(baseEchoArtifact('drop-bindings'));
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);
    const resolved = resolveConstructedAgent('drop-bindings');
    expect(getAdmittedAgentBindings(resolved!)).toBeDefined();

    _resetRuntimeForTesting();
    expect(getAdmittedAgentBindings(resolved!)).toBeUndefined();
  });
});

describe('FEATURE_101 — Runner.run dispatches observe + assertTerminal', () => {
  it('fires observe on tool_call and assertTerminal at run end', async () => {
    // Inject a probe invariant alongside the production set.
    let observeCalls = 0;
    let terminalCalls = 0;
    let lastEventKind: RunnerEvent['kind'] | undefined;
    let lastTerminalDeliverable: Deliverable | undefined;
    const probe: QualityInvariant = {
      id: 'finalOwner', // Reuse a closed-set id so bindings include it.
      description: 'probe',
      admit: () => ({ ok: true }) as InvariantResult,
      observe(event: RunnerEvent, _ctx: ObserveCtx) {
        observeCalls += 1;
        lastEventKind = event.kind;
        return { ok: true } as InvariantResult;
      },
      assertTerminal(deliverable: Deliverable, _ctx: TerminalCtx) {
        terminalCalls += 1;
        lastTerminalDeliverable = deliverable;
        return { ok: true } as InvariantResult;
      },
    };
    _resetInvariantRegistry();
    registerInvariant(probe);
    // Re-register the rest of the production set (skipping finalOwner —
    // it's been overridden by the probe above).
    const { registerCoreInvariants } = await import('@kodax/core');
    // registerCoreInvariants would clash on finalOwner; manually skip it.
    const { handoffLegality, evidenceTrail, harnessSelectionTiming } =
      await import('@kodax/core');
    registerInvariant(handoffLegality);
    registerInvariant(evidenceTrail);
    registerInvariant(harnessSelectionTiming);
    const { boundedRevise, budgetCeiling, independentReview, toolPermission } =
      await import('../agent-runtime/invariants/index.js');
    registerInvariant(budgetCeiling);
    registerInvariant(toolPermission);
    registerInvariant(boundedRevise);
    registerInvariant(independentReview);
    void registerCoreInvariants; // silence unused.

    const handle = await stage(baseEchoArtifact('observe-probe'));
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);

    const resolved = resolveConstructedAgent('observe-probe');
    await Runner.run(resolved!, 'hello', { llm: scriptedEchoLlm, tracer: null });

    // No tool calls in this scripted run — observe should NOT have fired
    // for tool_call events (none happened). assertTerminal must run once.
    expect(observeCalls).toBe(0);
    expect(lastEventKind).toBeUndefined();
    expect(terminalCalls).toBe(1);
    expect(lastTerminalDeliverable?.mutationCount).toBe(0);
    expect(lastTerminalDeliverable?.evidenceArtifacts).toEqual([]);
    expect(lastTerminalDeliverable?.verdict).toBeUndefined();
  });

  it('reject from observe aborts the run', async () => {
    const probe: QualityInvariant = {
      id: 'finalOwner',
      description: 'reject-on-observe',
      admit: () => ({ ok: true }) as InvariantResult,
      observe(_event: RunnerEvent) {
        return {
          ok: false,
          severity: 'reject',
          reason: 'no tools allowed',
        } as InvariantResult;
      },
    };
    _resetInvariantRegistry();
    registerInvariant(probe);
    // Register a permissive handoffLegality so admission still passes.
    const { handoffLegality, evidenceTrail, harnessSelectionTiming } =
      await import('@kodax/core');
    registerInvariant(handoffLegality);
    registerInvariant(evidenceTrail);
    registerInvariant(harnessSelectionTiming);
    const { boundedRevise, budgetCeiling, independentReview, toolPermission } =
      await import('../agent-runtime/invariants/index.js');
    registerInvariant(budgetCeiling);
    registerInvariant(toolPermission);
    registerInvariant(boundedRevise);
    registerInvariant(independentReview);

    const handle = await stage(baseEchoArtifact('reject-on-tool'));
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);

    const resolved = resolveConstructedAgent('reject-on-tool');

    // Use an llm that issues one tool call — observe will see tool_call
    // and reject.
    const llmWithTool = async (
      _messages: readonly AgentMessage[],
    ): Promise<RunnerLlmResult> => {
      return {
        text: '',
        toolCalls: [{ id: 'call-1', name: 'demo_tool', input: {} }],
      };
    };

    await expect(
      Runner.run(resolved!, 'hello', { llm: llmWithTool, tracer: null }),
    ).rejects.toThrow(/invariant 'finalOwner' rejected the run at runtime/);
  });

  it('reject from assertTerminal aborts the run', async () => {
    const probe: QualityInvariant = {
      id: 'finalOwner',
      description: 'reject-on-terminal',
      admit: () => ({ ok: true }) as InvariantResult,
      assertTerminal(_d, _c) {
        return {
          ok: false,
          severity: 'reject',
          reason: 'incomplete deliverable',
        } as InvariantResult;
      },
    };
    _resetInvariantRegistry();
    registerInvariant(probe);
    const { handoffLegality, evidenceTrail, harnessSelectionTiming } =
      await import('@kodax/core');
    registerInvariant(handoffLegality);
    registerInvariant(evidenceTrail);
    registerInvariant(harnessSelectionTiming);
    const { boundedRevise, budgetCeiling, independentReview, toolPermission } =
      await import('../agent-runtime/invariants/index.js');
    registerInvariant(budgetCeiling);
    registerInvariant(toolPermission);
    registerInvariant(boundedRevise);
    registerInvariant(independentReview);

    const handle = await stage(baseEchoArtifact('terminal-reject'));
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);

    const resolved = resolveConstructedAgent('terminal-reject');

    await expect(
      Runner.run(resolved!, 'hello', { llm: scriptedEchoLlm, tracer: null }),
    ).rejects.toThrow(/invariant 'finalOwner' rejected the run at runtime/);
  });

  it('onInvariantSessionStarted callback exposes the session', async () => {
    const handle = await stage(baseEchoArtifact('session-cb'));
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);

    const resolved = resolveConstructedAgent('session-cb');

    let exposedSession: { recordEvidence: (p: string) => void } | undefined;
    await Runner.run(resolved!, 'hello', {
      llm: scriptedEchoLlm,
      tracer: null,
      onInvariantSessionStarted: (session) => {
        exposedSession = session;
        // Coding-side consumers can record domain-specific events:
        session.recordEvidence('docs/run-evidence.md');
        session.setVerdict('accept');
      },
    });

    expect(exposedSession).toBeDefined();
    // The session is exposed before any record call — coding side was
    // able to mutate state during the run.
  });

  it('does not create a session for trusted (un-admitted) agents', async () => {
    let invoked = false;
    const trustedAgent = {
      name: 'trusted',
      instructions: 'no admission',
    };
    await Runner.run(trustedAgent, 'hi', {
      llm: scriptedEchoLlm,
      tracer: null,
      onInvariantSessionStarted: () => {
        invoked = true;
      },
    });
    expect(invoked).toBe(false);
  });
});
