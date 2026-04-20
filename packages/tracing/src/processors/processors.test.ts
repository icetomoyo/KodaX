/**
 * Tests for the built-in Console and File tracing processors
 * (FEATURE_083 v0.7.24 Slice 7).
 */

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { Tracer } from '../tracer.js';
import { addTracingProcessor, setTracingProcessors } from '../processor.js';
import { ConsoleTracingProcessor } from './console.js';
import { FileTracingProcessor } from './file.js';

describe('ConsoleTracingProcessor', () => {
  afterEach(() => setTracingProcessors([]));

  it('writes one line per span/trace lifecycle event', () => {
    const lines: string[] = [];
    addTracingProcessor(new ConsoleTracingProcessor({ write: (line) => lines.push(line) }));

    const trace = new Tracer({ now: () => 1_000 }).startTrace({ name: 'root' });
    const child = trace.rootSpan.addChild('child', {
      kind: 'tool_call',
      toolName: 'bash',
      status: 'ok',
    });
    child.end();
    trace.end();

    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/\[span:start\] .*name=root kind=agent/);
    expect(lines[1]).toMatch(/\[span:start\] .*name=child kind=tool_call/);
    expect(lines[2]).toMatch(/\[span:end\]   .*name=child kind=tool_call durationMs=0/);
    expect(lines[3]).toMatch(/\[span:end\]   .*name=root kind=agent durationMs=0/);
    expect(lines[4]).toMatch(/\[trace:end\]  .*rootName=root durationMs=0/);
  });

  it('includes error information when span.setError is called', () => {
    const lines: string[] = [];
    addTracingProcessor(new ConsoleTracingProcessor({ write: (line) => lines.push(line) }));

    const trace = new Tracer().startTrace({ name: 'root' });
    const child = trace.rootSpan.addChild('child', {
      kind: 'tool_call',
      toolName: 'bash',
      status: 'error',
    });
    child.setError(new Error('boom'));
    child.end();
    trace.end();

    const endLine = lines.find((l) => l.includes('name=child') && l.startsWith('[span:end]'));
    expect(endLine).toMatch(/error=boom/);
  });
});

describe('FileTracingProcessor', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    setTracingProcessors([]);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes one JSONL file per trace id', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-tracing-'));
    tempDirs.push(tempDir);
    const processor = new FileTracingProcessor({ traceDir: tempDir });
    addTracingProcessor(processor);

    const trace = new Tracer().startTrace({ name: 'file-root' });
    const child = trace.rootSpan.addChild('child', {
      kind: 'generation',
      agentName: 'scout',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    child.end();
    trace.end();

    await processor.shutdown();

    const filePath = path.join(tempDir, `${trace.id}.jsonl`);
    const contents = await readFile(filePath, 'utf8');
    const records = contents.trim().split('\n').map((line) => JSON.parse(line));

    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({ event: 'span:start', name: 'file-root' });
    expect(records[1]).toMatchObject({ event: 'span:start', name: 'child', data: { kind: 'generation' } });
    expect(records[2]).toMatchObject({ event: 'span:end', name: 'child' });
    expect(records[3]).toMatchObject({ event: 'span:end', name: 'file-root' });
    expect(records[4]).toMatchObject({ event: 'trace:end', rootName: 'file-root' });

    const genRecord = records[1];
    expect(genRecord.data.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it('shutdown is safe to call with no pending traces', async () => {
    const processor = new FileTracingProcessor({ traceDir: await mkdtemp(path.join(os.tmpdir(), 'kodax-tracing-empty-')) });
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});
