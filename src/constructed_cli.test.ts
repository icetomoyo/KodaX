/**
 * Unit tests for the constructed-tool CLI surface.
 *
 * Exercises the pure, schema-driven argv → input mapping and the
 * end-to-end dispatch path (which runs activate via the runtime, then
 * `kodax <name>` invocation through executeTool). Tests use a temp cwd
 * so .kodax/constructed/ is hermetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  configureRuntime,
  stage,
  testArtifact,
  activate,
  _resetRuntimeForTesting,
  type ConstructionArtifact,
} from '@kodax/coding';

import {
  parseArgsByInputSchema,
  detectConstructedToolDispatch,
  runConstructedToolDispatch,
} from './constructed_cli.js';

describe('parseArgsByInputSchema', () => {
  it('maps --key=value form with type coercion', () => {
    const out = parseArgsByInputSchema(['--name=x', '--count=42'], {
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['name'],
    });
    expect(out).toEqual({ name: 'x', count: 42 });
  });

  it('maps --key value form (separated by whitespace)', () => {
    const out = parseArgsByInputSchema(['--path', '/tmp/x.txt'], {
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    expect(out).toEqual({ path: '/tmp/x.txt' });
  });

  it('treats a single positional as the first required string field', () => {
    const out = parseArgsByInputSchema(['/tmp/data.csv'], {
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    expect(out).toEqual({ path: '/tmp/data.csv' });
  });

  it('coerces booleans (--flag standalone is true)', () => {
    const out = parseArgsByInputSchema(['--verbose'], {
      properties: { verbose: { type: 'boolean' } },
    });
    expect(out).toEqual({ verbose: true });
  });

  it('coerces booleans (--flag=false)', () => {
    const out = parseArgsByInputSchema(['--verbose=false'], {
      properties: { verbose: { type: 'boolean' } },
    });
    expect(out).toEqual({ verbose: false });
  });

  it('throws on non-numeric integer input', () => {
    expect(() =>
      parseArgsByInputSchema(['--count=banana'], {
        properties: { count: { type: 'integer' } },
      }),
    ).toThrow(/expects an integer/);
  });

  it('throws when more than one positional is supplied', () => {
    expect(() =>
      parseArgsByInputSchema(['/a', '/b'], {
        properties: { path: { type: 'string' } },
        required: ['path'],
      }),
    ).toThrow(/positional arguments/);
  });

  it('parses arrays via JSON-string fallback', () => {
    const out = parseArgsByInputSchema(['--items=["a","b"]'], {
      properties: { items: { type: 'array' } },
    });
    expect(out).toEqual({ items: ['a', 'b'] });
  });
});

describe('detectConstructedToolDispatch + runConstructedToolDispatch', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-cli-cons-'));
    configureRuntime({
      cwd: tmpRoot,
      policy: async () => 'approve',
    });
  });

  afterEach(async () => {
    _resetRuntimeForTesting();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function buildEchoArtifact(): ConstructionArtifact {
    return {
      kind: 'tool',
      name: 'cli_echo',
      version: '1.0.0',
      status: 'staged',
      createdAt: Date.now(),
      content: {
        description: 'Echoes its input.value field.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        capabilities: { tools: [] },
        handler: {
          kind: 'script',
          language: 'javascript',
          code:
            'export async function handler(input, ctx) {\n'
            + '  return "echoed:" + input.value;\n'
            + '}\n',
        },
      },
    };
  }

  it('returns the tool name when argv[0] matches an activated constructed tool', async () => {
    const handle = await stage(buildEchoArtifact());
    await testArtifact(handle);
    await activate(handle);

    const target = await detectConstructedToolDispatch(['cli_echo', 'hello'], tmpRoot);
    expect(target).toBe('cli_echo');
  });

  it('returns null for reserved subcommand names (e.g. tools)', async () => {
    const target = await detectConstructedToolDispatch(['tools', 'list'], tmpRoot);
    expect(target).toBeNull();
  });

  it('returns null for unknown / unactivated names', async () => {
    const target = await detectConstructedToolDispatch(['no_such_tool'], tmpRoot);
    expect(target).toBeNull();
  });

  it('returns null for global flags', async () => {
    const target = await detectConstructedToolDispatch(['--help'], tmpRoot);
    expect(target).toBeNull();
  });

  it('end-to-end: positional argv invokes handler and prints result', async () => {
    const handle = await stage(buildEchoArtifact());
    await testArtifact(handle);
    await activate(handle);

    // Capture stdout for the dispatch run. process.stdout.write has an
    // overloaded signature (string | Uint8Array, optional encoding, optional
    // callback) — the simplest hermetic capture is to install a thin shim
    // and restore it via `as never` to bypass the overload mismatch.
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as never;

    try {
      await runConstructedToolDispatch('cli_echo', ['--value=world'], tmpRoot);
    } finally {
      process.stdout.write = origWrite as never;
    }

    expect(writes.join('')).toContain('echoed:world');
  });
});
