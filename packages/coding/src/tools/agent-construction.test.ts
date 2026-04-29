/**
 * FEATURE_089 — agent-construction tools unit tests.
 *
 * Covers the five tools in the staircase. Each tool returns a string
 * (the LLM-facing surface), so assertions are on the rendered output
 * rather than typed return values. The runtime is configured against
 * a fresh tmp dir per test; admission invariants are registered via
 * `registerCodingInvariants`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import { _resetInvariantRegistry } from '@kodax/core';

import { registerCodingInvariants } from '../agent-runtime/invariants/index.js';
import {
  configureRuntime,
  _resetRuntimeForTesting,
} from '../construction/index.js';
import type { KodaXToolExecutionContext } from '../types.js';

import {
  AGENT_CONSTRUCTION_TOOL_NAMES,
  filterAgentConstructionToolNames,
  isAgentConstructionToolName,
  toolActivateAgent,
  toolScaffoldAgent,
  toolStageAgentConstruction,
  toolTestAgent,
  toolValidateAgent,
} from './agent-construction.js';

const ctx = { backups: new Map() } as KodaXToolExecutionContext;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-agent-tools-'));
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

describe('AGENT_CONSTRUCTION_TOOL_NAMES + gating', () => {
  it('lists the 5 staircase tool names', () => {
    expect([...AGENT_CONSTRUCTION_TOOL_NAMES]).toEqual([
      'scaffold_agent',
      'validate_agent',
      'stage_agent_construction',
      'test_agent',
      'activate_agent',
    ]);
  });

  it('isAgentConstructionToolName recognizes only the staircase names', () => {
    expect(isAgentConstructionToolName('scaffold_agent')).toBe(true);
    expect(isAgentConstructionToolName('validate_agent')).toBe(true);
    expect(isAgentConstructionToolName('read')).toBe(false);
    expect(isAgentConstructionToolName('scaffold_tool')).toBe(false);
  });

  it('filterAgentConstructionToolNames hides the staircase when mode is off', () => {
    const all = ['read', 'write', 'scaffold_agent', 'validate_agent', 'bash'];
    expect(filterAgentConstructionToolNames(all, false)).toEqual(['read', 'write', 'bash']);
    expect(filterAgentConstructionToolNames(all, undefined)).toEqual(['read', 'write', 'bash']);
    expect(filterAgentConstructionToolNames(all, true)).toEqual(all);
  });
});

describe('scaffold_agent', () => {
  it('emits a JSON skeleton with kind=agent + status=staged + reasoning defaults', async () => {
    const out = await toolScaffoldAgent({ name: 'echo', version: '0.1.0' }, ctx);
    expect(out).toContain('"kind": "agent"');
    expect(out).toContain('"name": "echo"');
    expect(out).toContain('"version": "0.1.0"');
    expect(out).toContain('"status": "staged"');
    expect(out).toContain('"default": "balanced"');
  });

  it('falls back to version "0.1.0" when omitted', async () => {
    const out = await toolScaffoldAgent({ name: 'fallback' }, ctx);
    expect(out).toContain('"version": "0.1.0"');
  });

  it('returns a Tool Error string when name is missing', async () => {
    const out = await toolScaffoldAgent({}, ctx);
    expect(out).toMatch(/^\[Tool Error\] scaffold_agent:.*'name' is required/);
  });
});

describe('validate_agent', () => {
  it('admits a minimal valid manifest (ok=true, no warnings)', async () => {
    const artifact = {
      kind: 'agent',
      name: 'minimal',
      version: '0.1.0',
      status: 'staged',
      createdAt: 0,
      content: { instructions: 'do work' },
    };
    const out = await toolValidateAgent(
      { artifact_json: JSON.stringify(artifact) },
      ctx,
    );
    expect(out).toContain('ok=true');
    expect(out).not.toContain('errors:');
  });

  it('rejects a self-loop handoff manifest', async () => {
    const artifact = {
      kind: 'agent',
      name: 'self-loop',
      version: '0.1.0',
      status: 'staged',
      createdAt: 0,
      content: {
        instructions: 'I hand off to myself',
        handoffs: [{ target: { ref: 'self-loop' }, kind: 'continuation' }],
      },
    };
    const out = await toolValidateAgent(
      { artifact_json: JSON.stringify(artifact) },
      ctx,
    );
    expect(out).toContain('ok=false');
    expect(out).toContain('admission');
  });

  it('clamps an over-budget manifest with a warning (ok=true)', async () => {
    const artifact = {
      kind: 'agent',
      name: 'over-budget',
      version: '0.1.0',
      status: 'staged',
      createdAt: 0,
      content: { instructions: 'do work', maxBudget: 999_999 },
    };
    const out = await toolValidateAgent(
      { artifact_json: JSON.stringify(artifact) },
      ctx,
    );
    expect(out).toContain('ok=true');
    expect(out).toContain('warnings:');
    expect(out).toContain('budgetCeiling');
  });

  it('rejects malformed JSON with a Tool Error', async () => {
    const out = await toolValidateAgent({ artifact_json: 'not-json' }, ctx);
    expect(out).toMatch(/^\[Tool Error\] validate_agent: artifact_json failed to parse/);
  });

  it('rejects kind=tool input (mismatched kind)', async () => {
    const artifact = {
      kind: 'tool',
      name: 'wrong',
      version: '0.1.0',
      content: { description: 'x' },
    };
    const out = await toolValidateAgent(
      { artifact_json: JSON.stringify(artifact) },
      ctx,
    );
    expect(out).toMatch(/artifact\.kind must be 'agent'/);
  });
});

describe('stage_agent_construction → test_agent → activate_agent (full staircase)', () => {
  it('walks all three steps and ends in status=active', async () => {
    // 1. stage
    const artifact = {
      kind: 'agent',
      name: 'echo-staircase',
      version: '0.1.0',
      status: 'staged',
      createdAt: Date.now(),
      content: { instructions: 'echo back the input' },
    };
    const stageOut = await toolStageAgentConstruction(
      { artifact_json: JSON.stringify(artifact) },
      ctx,
    );
    expect(stageOut).toContain('staged: echo-staircase@0.1.0');
    expect(stageOut).toContain('kind=agent');

    // 2. test
    const testOut = await toolTestAgent(
      { name: 'echo-staircase', version: '0.1.0' },
      ctx,
    );
    expect(testOut).toContain('ok=true');

    // 3. activate
    const activateOut = await toolActivateAgent(
      { name: 'echo-staircase', version: '0.1.0' },
      ctx,
    );
    expect(activateOut).toContain('activated: echo-staircase@0.1.0');

    // verify on-disk state
    const filePath = path.join(
      tmpRoot, '.kodax', 'constructed', 'agents', 'echo-staircase', '0.1.0.json',
    );
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(persisted.status).toBe('active');
    expect(typeof persisted.contentHash).toBe('string');
  });

  it('test_agent rejects a kind=tool artifact stored on disk (kind discrimination)', async () => {
    // Stage a tool kind via direct file write (simulating cross-tool misuse).
    const toolFile = path.join(tmpRoot, '.kodax', 'constructed', 'tools', 'mistake', '0.1.0.json');
    await fs.mkdir(path.dirname(toolFile), { recursive: true });
    await fs.writeFile(
      toolFile,
      JSON.stringify({
        kind: 'tool',
        name: 'mistake',
        version: '0.1.0',
        status: 'staged',
        createdAt: Date.now(),
        content: {
          description: 't',
          inputSchema: { type: 'object', properties: {} },
          capabilities: { tools: [] },
          handler: { kind: 'script', language: 'javascript', code: 'export async function handler(){return "x"}' },
        },
      }),
    );
    const out = await toolTestAgent({ name: 'mistake', version: '0.1.0' }, ctx);
    expect(out).toContain("kind='tool'");
    expect(out).toContain("expected 'agent'");
  });

  it('activate_agent refuses an artifact that has not passed test_agent', async () => {
    await toolStageAgentConstruction(
      {
        artifact_json: JSON.stringify({
          kind: 'agent',
          name: 'untested',
          version: '0.1.0',
          status: 'staged',
          createdAt: Date.now(),
          content: { instructions: 'i' },
        }),
      },
      ctx,
    );
    const out = await toolActivateAgent({ name: 'untested', version: '0.1.0' }, ctx);
    expect(out).toContain('has not passed test()');
  });
});
