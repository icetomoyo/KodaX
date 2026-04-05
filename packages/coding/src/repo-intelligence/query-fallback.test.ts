import fsPromises from 'node:fs/promises';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getRepoIntelligenceIndex } from './query.js';

function createIncrementalFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));
  writeFileSync(
    join(workspaceRoot, 'packages', 'app', 'src', 'helper.ts'),
    [
      'export function formatName(name: string): string {',
      '  return name.trim().toUpperCase();',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(workspaceRoot, 'packages', 'app', 'src', 'index.ts'),
    [
      "import { formatName } from './helper';",
      '',
      'export function runApp(name: string): string {',
      '  return formatName(name);',
      '}',
      '',
    ].join('\n'),
  );
}

function createJavaCppFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'java', 'com', 'demo'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'cpp'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(
    join(workspaceRoot, 'java', 'com', 'demo', 'Controller.java'),
    [
      'package com.demo;',
      '',
      'public interface ServiceContract {',
      '  String run();',
      '}',
      '',
      'public enum ExecutionMode {',
      '  FAST,',
      '  SAFE,',
      '}',
      '',
      'public class Controller {',
      '  public String execute(ServiceContract service) {',
      '    return service.run();',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(workspaceRoot, 'cpp', 'worker.h'),
    [
      '#pragma once',
      '',
      'struct WorkerConfig {',
      '  int retries;',
      '};',
      '',
      'enum class RunMode {',
      '  Fast,',
      '  Safe,',
      '};',
      '',
      'class Worker {',
      'public:',
      '  int run();',
      '};',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(workspaceRoot, 'cpp', 'worker.cpp'),
    [
      '#include "worker.h"',
      '',
      'int Worker::run() {',
      '  return helper();',
      '}',
      '',
      'int helper() {',
      '  return 1;',
      '}',
      '',
    ].join('\n'),
  );
}

describe('fallback repo-intelligence index', () => {
  let tempDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('reuses cached file analyses for unchanged source files during incremental refresh', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-ri-incremental-'));
    createIncrementalFixture(tempDir);

    await getRepoIntelligenceIndex({ executionCwd: tempDir }, { refresh: true });

    writeFileSync(
      join(tempDir, 'packages', 'app', 'src', 'index.ts'),
      [
        "import { formatName } from './helper';",
        '',
        'export function runApp(name: string): string {',
        "  return `hello ${formatName(name)}`;",
        '}',
        '',
      ].join('\n'),
    );

    const readSpy = vi.spyOn(fsPromises, 'readFile');
    const index = await getRepoIntelligenceIndex({ executionCwd: tempDir }, { refresh: false });
    const sourceReads = readSpy.mock.calls
      .map(([filePath]) => String(filePath).replace(/\\/g, '/'))
      .filter((filePath) =>
        filePath.endsWith('/packages/app/src/index.ts')
        || filePath.endsWith('/packages/app/src/helper.ts'),
      );

    expect(index.symbols.some((symbol) => symbol.name === 'runApp')).toBe(true);
    expect(sourceReads.some((filePath) => filePath.endsWith('/packages/app/src/index.ts'))).toBe(true);
    expect(sourceReads.some((filePath) => filePath.endsWith('/packages/app/src/helper.ts'))).toBe(false);
  }, 15000);

  it('extracts richer Java/C++ structural semantics through the existing intelligence surface', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-ri-java-cpp-'));
    createJavaCppFixture(tempDir);

    const index = await getRepoIntelligenceIndex({ executionCwd: tempDir }, { refresh: true });
    const picked = index.symbols.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.language}`);

    expect(picked).toEqual(expect.arrayContaining([
      'interface:ServiceContract:java',
      'enum:ExecutionMode:java',
      'class:Controller:java',
      'struct:WorkerConfig:cpp',
      'enum:RunMode:cpp',
      'class:Worker:cpp',
      'method:run:cpp',
      'function:helper:cpp',
    ]));
    expect(index.languages).toEqual(expect.arrayContaining([
      expect.objectContaining({ language: 'java', capabilityTier: 'medium' }),
      expect.objectContaining({ language: 'cpp', capabilityTier: 'low' }),
    ]));
  }, 15000);
});
