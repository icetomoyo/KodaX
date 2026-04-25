/**
 * Coding Agent internal tools (FEATURE_087+088, v0.7.28) — unit tests for
 * the scaffold → validate → stage → test → activate staircase.
 *
 * These tests exercise the public tool entry points (handlers) directly
 * rather than going through `executeTool()` so we can assert on the raw
 * string output without involving the registry's error-mapping wrapper.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import { configureRuntime, _resetRuntimeForTesting } from '../construction/index.js';
import { getRegisteredToolDefinition } from './registry.js';
import {
  toolScaffoldTool,
  toolValidateTool,
  toolStageConstruction,
  toolTestTool,
  toolActivateTool,
  CONSTRUCTION_TOOL_NAMES,
  isConstructionToolName,
  filterConstructionToolNames,
} from './construction.js';
import type { KodaXToolExecutionContext } from '../types.js';

const ctx = {
  backups: new Map<string, string>(),
} as KodaXToolExecutionContext;

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-tool-construction-'));
  configureRuntime({
    cwd: tmpRoot,
    policy: async () => 'approve',
  });
});

afterEach(async () => {
  _resetRuntimeForTesting();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const SAFE_HANDLER_CODE =
  'export async function handler(input, ctx) { return JSON.stringify({ echoed: input.value }); }';

function buildArtifactJson(overrides: { name?: string; version?: string; code?: string } = {}): string {
  return JSON.stringify({
    kind: 'tool',
    name: overrides.name ?? 'echo',
    version: overrides.version ?? '1.0.0',
    status: 'staged',
    createdAt: Date.now(),
    content: {
      description: 'Echoes input back',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      capabilities: { tools: [] },
      handler: {
        kind: 'script',
        language: 'javascript',
        code: overrides.code ?? SAFE_HANDLER_CODE,
      },
    },
  });
}

describe('toolScaffoldTool', () => {
  it('emits a fillable artifact skeleton with sensible defaults', async () => {
    const out = await toolScaffoldTool({ name: 'my_tool' }, ctx);
    expect(out).toContain('Scaffolded artifact JSON');
    // The payload must round-trip as JSON.
    const jsonStart = out.indexOf('{');
    const parsed = JSON.parse(out.slice(jsonStart));
    expect(parsed.kind).toBe('tool');
    expect(parsed.name).toBe('my_tool');
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.content.handler.language).toBe('javascript');
    expect(parsed.content.capabilities).toEqual({ tools: [] });
  });

  it('honors caller-supplied capabilities.tools', async () => {
    const out = await toolScaffoldTool(
      { name: 'reader', version: '0.2.0', capabilities: { tools: ['read', 'grep'] } },
      ctx,
    );
    const parsed = JSON.parse(out.slice(out.indexOf('{')));
    expect(parsed.version).toBe('0.2.0');
    expect(parsed.content.capabilities.tools).toEqual(['read', 'grep']);
  });

  it('rejects missing name', async () => {
    const out = await toolScaffoldTool({}, ctx);
    expect(out).toContain('[Tool Error] scaffold_tool');
  });

  it('rejects malformed capabilities.tools', async () => {
    const out = await toolScaffoldTool(
      { name: 'bad', capabilities: { tools: ['ok', 42] } },
      ctx,
    );
    expect(out).toContain('[Tool Error] scaffold_tool');
  });
});

describe('toolValidateTool', () => {
  it('passes a clean artifact', async () => {
    const out = await toolValidateTool({ artifact_json: buildArtifactJson() }, ctx);
    expect(out).toContain('ok=true');
  });

  it('flags eval as an AST violation without writing to disk', async () => {
    const json = buildArtifactJson({
      code: 'export async function handler(input, ctx) { return eval(input.s); }',
    });
    const out = await toolValidateTool({ artifact_json: json }, ctx);
    expect(out).toContain('ok=false');
    expect(out).toContain('no-eval');
    // No disk write — confirm the artifact directory does not exist.
    const dir = path.join(tmpRoot, '.kodax', 'constructed', 'tools', 'echo');
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('flags handler signature requirement', async () => {
    const json = buildArtifactJson({
      code: 'export async function handler() { return "no args"; }',
    });
    const out = await toolValidateTool({ artifact_json: json }, ctx);
    expect(out).toContain('ok=false');
    expect(out).toContain('require-handler-signature');
  });

  it('returns parse error on malformed JSON', async () => {
    const out = await toolValidateTool({ artifact_json: '{not json' }, ctx);
    expect(out).toContain('[Tool Error] validate_tool');
  });
});

describe('toolStageConstruction', () => {
  it('persists the artifact to .kodax/constructed/tools/<name>/<version>.json', async () => {
    const out = await toolStageConstruction({ artifact_json: buildArtifactJson() }, ctx);
    expect(out).toContain('staged: echo@1.0.0');
    const filePath = path.join(tmpRoot, '.kodax', 'constructed', 'tools', 'echo', '1.0.0.json');
    const raw = await fs.readFile(filePath, 'utf8');
    expect(JSON.parse(raw).status).toBe('staged');
  });

  it('refuses to overwrite an active version', async () => {
    // First stage + activate a version.
    await toolStageConstruction({ artifact_json: buildArtifactJson() }, ctx);
    await toolTestTool({ name: 'echo', version: '1.0.0' }, ctx);
    await toolActivateTool({ name: 'echo', version: '1.0.0' }, ctx);

    // Try to re-stage at the same version.
    const out = await toolStageConstruction({ artifact_json: buildArtifactJson() }, ctx);
    expect(out).toContain('[Tool Error] stage_construction');
    expect(out.toLowerCase()).toContain('active');
  });
});

describe('toolTestTool', () => {
  it('returns ok=true on a clean staged artifact', async () => {
    await toolStageConstruction({ artifact_json: buildArtifactJson() }, ctx);
    const out = await toolTestTool({ name: 'echo', version: '1.0.0' }, ctx);
    expect(out).toContain('ok=true');
  });

  it('reports missing artifact', async () => {
    const out = await toolTestTool({ name: 'ghost', version: '0.0.0' }, ctx);
    expect(out).toContain('[Tool Error] test_tool');
    expect(out).toContain('no staged artifact');
  });

  it('requires both name and version', async () => {
    const out = await toolTestTool({ name: 'echo' }, ctx);
    expect(out).toContain('[Tool Error] test_tool');
  });
});

describe('agent-layer gating', () => {
  it('CONSTRUCTION_TOOL_NAMES enumerates exactly the five staircase handlers', () => {
    expect([...CONSTRUCTION_TOOL_NAMES].sort()).toEqual([
      'activate_tool',
      'scaffold_tool',
      'stage_construction',
      'test_tool',
      'validate_tool',
    ]);
  });

  it('isConstructionToolName recognizes the five staircase handlers', () => {
    for (const name of CONSTRUCTION_TOOL_NAMES) {
      expect(isConstructionToolName(name)).toBe(true);
    }
    expect(isConstructionToolName('read')).toBe(false);
    expect(isConstructionToolName('bash')).toBe(false);
  });

  it('filterConstructionToolNames strips construction tools when mode is OFF', () => {
    const all = ['read', 'bash', 'scaffold_tool', 'validate_tool', 'activate_tool'];
    expect(filterConstructionToolNames(all, false)).toEqual(['read', 'bash']);
    expect(filterConstructionToolNames(all, undefined)).toEqual(['read', 'bash']);
  });

  it('filterConstructionToolNames preserves construction tools when mode is ON', () => {
    const all = ['read', 'scaffold_tool', 'activate_tool'];
    expect(filterConstructionToolNames(all, true)).toEqual(all);
  });
});

describe('toolActivateTool — full staircase', () => {
  it('end-to-end: scaffold → fill → validate → stage → test → activate registers a working tool', async () => {
    // 1. scaffold
    const scaffoldOut = await toolScaffoldTool({ name: 'greet', version: '1.0.0' }, ctx);
    const skeleton = JSON.parse(scaffoldOut.slice(scaffoldOut.indexOf('{')));

    // 2. fill (replace handler body and inputSchema with concrete content)
    skeleton.content.description = 'Greet a name';
    skeleton.content.inputSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    skeleton.content.handler.code =
      'export async function handler(input, ctx) { return "hello, " + input.name; }';

    const filledJson = JSON.stringify(skeleton);

    // 3. validate
    const validateOut = await toolValidateTool({ artifact_json: filledJson }, ctx);
    expect(validateOut).toContain('ok=true');

    // 4. stage
    const stageOut = await toolStageConstruction({ artifact_json: filledJson }, ctx);
    expect(stageOut).toContain('staged: greet@1.0.0');

    // 5. test
    const testOut = await toolTestTool({ name: 'greet', version: '1.0.0' }, ctx);
    expect(testOut).toContain('ok=true');

    // 6. activate
    const activateOut = await toolActivateTool({ name: 'greet', version: '1.0.0' }, ctx);
    expect(activateOut).toContain('activated: greet@1.0.0');

    // The handler is now in TOOL_REGISTRY as a constructed tool.
    const reg = getRegisteredToolDefinition('greet');
    expect(reg).toBeDefined();
    expect(reg?.source.kind).toBe('constructed');
    expect(reg?.source.version).toBe('1.0.0');
  });

  it('blocks activation of a non-existent artifact', async () => {
    const out = await toolActivateTool({ name: 'nope', version: '0.0.0' }, ctx);
    expect(out).toContain('[Tool Error] activate_tool');
  });
});
