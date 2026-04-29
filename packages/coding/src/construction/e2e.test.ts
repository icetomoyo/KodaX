/**
 * End-to-end integration test for the v0.7.28 construction pipeline.
 *
 * Walks the 8-step path called out in docs/features/v0.7.28.md
 * "集成测试（v0.7.28 必达）" using the SAME ctx + executeTool dispatch
 * path the real agent uses — no synthetic ctx.tools, no `as never` casts.
 *
 * Steps covered (steps 4-5 about provider payload + LLM tool_use are out
 * of scope here — they belong to provider-level integration; this test
 * proves the in-process registry wiring downstream of LLM dispatch):
 *
 *   1. scaffold + fill artifact
 *   2. stage → test → activate (auto-approve policy)
 *   3. listToolDefinitions includes the constructed tool
 *   6. handler invoked via executeTool, calls ctx.tools.<declared>
 *      successfully
 *   7. handler calling ctx.tools.<UNDECLARED> hits CapabilityDeniedError
 *      mapped through executeTool's error wrapper
 *   8. revoke → listToolDefinitions no longer includes the tool;
 *      executeTool returns the unknown-tool error
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  configureRuntime,
  stage,
  testArtifact,
  activate,
  revoke,
  _resetRuntimeForTesting,
  type ConstructionArtifact,
} from './index.js';
import type { ToolArtifact } from './types.js';
import { executeTool, listTools } from '../tools/registry.js';
import type { KodaXToolExecutionContext } from '../types.js';

const ctx = { backups: new Map() } as KodaXToolExecutionContext;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-e2e-'));
  configureRuntime({
    cwd: tmpRoot,
    policy: async () => 'approve',
  });
});

afterEach(async () => {
  _resetRuntimeForTesting();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function buildCountLinesArtifact(): ToolArtifact {
  // A constructed tool that calls ctx.tools.read(...) (declared) and
  // returns the line count of the file content. This is the canonical
  // example from docs/features/v0.7.28.md §"集成测试".
  return {
    kind: 'tool',
    name: 'count_lines',
    version: '1.0.0',
    status: 'staged',
    createdAt: Date.now(),
    content: {
      description: 'Count the number of newline-delimited lines in a file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      capabilities: { tools: ['read'] },
      handler: {
        kind: 'script',
        language: 'javascript',
        code:
          'export async function handler(input, ctx) {\n'
          + '  const content = await ctx.tools.read({ path: input.path });\n'
          + '  const lines = content.split("\\n").length;\n'
          + '  return String(lines);\n'
          + '}\n',
      },
    },
  };
}

function buildEscalatorArtifact(): ToolArtifact {
  // A constructed tool that ATTEMPTS to call ctx.tools.bash, which is
  // NOT declared in capabilities. Used to assert the capability gate.
  return {
    kind: 'tool',
    name: 'escalator',
    version: '1.0.0',
    status: 'staged',
    createdAt: Date.now(),
    content: {
      description: 'Tries to escalate by calling an undeclared tool.',
      inputSchema: { type: 'object', properties: {} },
      capabilities: { tools: ['read'] }, // bash NOT declared
      handler: {
        kind: 'script',
        language: 'javascript',
        code:
          'export async function handler(input, ctx) {\n'
          + '  return await ctx.tools.bash({ command: "echo hi" });\n'
          + '}\n',
      },
    },
  };
}

describe('v0.7.28 end-to-end: stage → activate → executeTool → revoke', () => {
  it('full happy path: constructed tool runs through executeTool and reads via ctx.tools.read', async () => {
    // Prepare a test file the constructed tool will read.
    const targetFile = path.join(tmpRoot, 'sample.txt');
    await fs.writeFile(targetFile, 'line1\nline2\nline3\n', 'utf8');

    // 1. stage
    const handle = await stage(buildCountLinesArtifact());
    expect(handle.artifact.status).toBe('staged');

    // 2. test
    const testRes = await testArtifact(handle);
    expect(testRes.ok).toBe(true);

    // 3. activate
    await activate(handle);

    // 4. listToolDefinitions (registry view) includes the constructed tool.
    expect(listTools()).toContain('count_lines');

    // 5. invoke via the SAME path the agent uses — executeTool.
    //    This is the real seam; no synthetic ctx.tools.
    const out = await executeTool('count_lines', { path: targetFile }, ctx);
    // The constructed handler returns the line count of whatever
    // builtin `read` returned. Builtin `read` appends formatting notes
    // (header / trailer) so the count is non-deterministic in this
    // exact form, but it MUST be a positive integer string — proving
    // the dispatch succeeded end to end.
    expect(out).toMatch(/^\d+$/);
    expect(parseInt(out, 10)).toBeGreaterThan(0);
  });

  it('capability gate: undeclared ctx.tools.<name> surfaces CapabilityDeniedError through executeTool', async () => {
    const handle = await stage(buildEscalatorArtifact());
    const testRes = await testArtifact(handle);
    expect(testRes.ok).toBe(true);
    await activate(handle);

    // executeTool wraps thrown errors as `[Tool Error] <name>: <msg>`.
    // CapabilityDeniedError is exactly the throw we expect.
    const out = await executeTool('escalator', {}, ctx);
    expect(out).toMatch(/\[Tool Error\] escalator/);
    expect(out).toMatch(/capabilities\.tools only declares \[read\]/);
  });

  it('revoke removes the tool from the registry; executeTool returns unknown-tool error afterward', async () => {
    const targetFile = path.join(tmpRoot, 'sample.txt');
    await fs.writeFile(targetFile, 'a\nb\n', 'utf8');

    const handle = await stage(buildCountLinesArtifact());
    await testArtifact(handle);
    await activate(handle);
    expect(listTools()).toContain('count_lines');

    // Use it once before revoke to confirm it works.
    const before = await executeTool('count_lines', { path: targetFile }, ctx);
    expect(before).toMatch(/^\d+$/);
    expect(parseInt(before, 10)).toBeGreaterThan(0);

    // Revoke.
    await revoke('count_lines', '1.0.0');

    expect(listTools()).not.toContain('count_lines');

    // After revoke, executeTool returns the unknown-tool error string.
    const after = await executeTool('count_lines', { path: targetFile }, ctx);
    expect(after).toMatch(/\[Tool Error\] Unknown tool: count_lines/);
  });

  it('constructed tool reuses the SAME builtin pipeline (DD §14.5.3 "complete the chain")', async () => {
    // Prove that ctx.tools.read goes through the SAME builtin code path —
    // a hint we can rely on is that the builtin `read` returns a string
    // including the file content even for a small file. If the proxy
    // shortcut/forked the dispatch, a different return shape would leak.
    const targetFile = path.join(tmpRoot, 'pipeline.txt');
    await fs.writeFile(targetFile, 'pipeline-content', 'utf8');

    const handle = await stage({
      ...buildCountLinesArtifact(),
      name: 'echo_via_read',
      content: {
        ...buildCountLinesArtifact().content,
        description: 'Reads a file via ctx.tools.read and returns the raw content.',
        capabilities: { tools: ['read'] },
        handler: {
          kind: 'script',
          language: 'javascript',
          code:
            'export async function handler(input, ctx) {\n'
            + '  return await ctx.tools.read({ path: input.path });\n'
            + '}\n',
        },
      },
    });
    await testArtifact(handle);
    await activate(handle);

    const out = await executeTool('echo_via_read', { path: targetFile }, ctx);
    // The builtin `read` formats its output with a header line and the
    // file body; the constructed tool returns whatever the builtin
    // returned. We just need it to contain the file content.
    expect(out).toContain('pipeline-content');
  });
});
