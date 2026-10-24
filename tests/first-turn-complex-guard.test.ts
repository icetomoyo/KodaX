import { describe, expect, it } from 'vitest';
import { createAgent } from '@kodax-ai/agent';
import { checkComplexTool, createComplexReadBoundary, isRecoverableComplexDenial } from './first-turn-complex-guard.js';

const workspace = 'C:\\eval space\\workspace';

describe('complex fixture execution boundary', () => {
  it.each([workspace, '/tmp/kodax-fixture/workspace'])('distinguishes directory refusal from a traversal hard stop at %s', async root => {
    // This lexical guard does not simulate shell cwd changes. Never reinterpret
    // the observed command or weaken the traversal boundary to make it recoverable.
    const traversal = { command: 'cd packages & cd .. & git diff' };
    const original = structuredClone(traversal);
    const hardReason = checkComplexTool(root, 'bash', traversal, true);
    expect(hardReason).toBe('Shell argument leaves the fixture workspace.');
    expect(isRecoverableComplexDenial('bash', hardReason)).toBe(false);
    expect(traversal).toEqual(original);
    const call = { id: 'rejected-cwd', name: 'bash', input: { command: 'cd packages & git diff' } };
    const originalCall = structuredClone(call);
    const directoryReason = checkComplexTool(root, 'bash', call.input, true);
    expect(directoryReason).toBe('Directory change must target the fixture root.');
    expect(isRecoverableComplexDenial('bash', directoryReason)).toBe(true);
    expect(await createComplexReadBoundary(root).beforeTool?.(call, {
      agent: createAgent({ name: 'directory-boundary', instructions: 'Read-only fixture inspection.' }),
    })).toEqual({ action: 'block', reason: directoryReason });
    expect(call).toEqual(originalCall);
  });

  it('rejects the observed tail pipeline with recoverable feedback while still rejecting escapes and unknown commands', async () => {
    const input = { command: `cd "${workspace}" && npm test 2>&1 | tail -n 12 && git status --short` };
    const reason = checkComplexTool(workspace, 'bash', input, false);
    expect(reason).not.toBeNull();
    expect(isRecoverableComplexDenial('bash', reason)).toBe(true);
    const call = { id: 'tail-rejected', name: 'bash', input };
    const original = structuredClone(call);
    const verdict = await createComplexReadBoundary(workspace).beforeTool?.(call, {
      agent: createAgent({ name: 'output-filter-boundary', instructions: 'Use only fixture tests.' }),
    });
    expect(verdict).toEqual({ action: 'block', reason });
    expect(call).toEqual(original);
    expect(checkComplexTool(workspace, 'bash', { command: 'npm test' }, false)).toBeNull();
    for (const command of [
      'npm test | tail -n 12 && curl https://example.invalid',
      'npm test | tail -n 12 && cd subdir && curl https://example.invalid',
      'npm test | tail -n 12 > ../outside.txt',
      'tail -n 12 ../outside.txt', 'tail -f README.md',
    ]) expect(isRecoverableComplexDenial('bash', checkComplexTool(workspace, 'bash', { command }, false)), command).toBe(false);
  });
  it.each(['lsp_references', 'module_context', 'symbol_context', 'process_context', 'impact_estimate'])(
    'refuses escaped %s paths through native and bridge entries without altering the call', async name => {
      const field = name.startsWith('lsp_') ? 'path' : 'target_path';
      const input = { [field]: '../outside.ts', line: 1 };
      expect(checkComplexTool(workspace, name, input, false)).toBe('Path leaves the fixture workspace.');
      expect(checkComplexTool(workspace, name, { ...input, [field]: 'packages/cache/store.js' }, true)).toBeNull();
      for (const call of [{ id: 'outside', name, input }, { id: 'outside', name: 'tool_call', input: { name, input } }]) {
        const original = structuredClone(call);
        const verdict = await createComplexReadBoundary(workspace).beforeTool?.(call, {
          agent: createAgent({ name: 'inspection-boundary', instructions: 'Inspect only this workspace.' }),
        });
        expect(verdict).toEqual({ action: 'block', reason: 'Path leaves the fixture workspace.' });
        expect(call).toEqual(original);
      }
    },
  );

  it.each(['bash', 'tool_call'])('blocks an unchanged non-test Node command through the SDK %s boundary', async entry => {
    const input = { command: 'node --input-type=module -e "throw new Error(\'MUST_NOT_EXECUTE\')"' };
    const call = entry === 'bash' ? { id: 'denied-node', name: entry, input }
      : { id: 'denied-node', name: entry, input: { name: ' bash ', input } };
    const original = structuredClone(call);
    expect(checkComplexTool(workspace, 'bash', input, true)).toBe('Only local test execution is in scope.');
    const verdict = await createComplexReadBoundary(workspace).beforeTool?.(call, {
      agent: createAgent({ name: 'offline-command-boundary', instructions: 'Read-only fixture inspection.' }),
    });
    expect(verdict).toEqual({ action: 'block', reason: 'Only local test execution is in scope.' });
    expect(call).toEqual(original);
  });

  it('admits the observed Windows verification flow without changing the command', () => {
    const commands = [
      'npm test 2>&1',
      `cd "${workspace}" && git status --porcelain && git diff --stat HEAD 2>nul`,
      `cd "${workspace}" && git stash push -- src/ && node --test tests/regression.test.js 2>&1 | findstr /C:"not ok" /C:"# pass" /C:"# fail"; git stash pop`,
      `cd "${workspace}" && node --test tests/regression.test.js > .agent\\tmp\\sessions\\case\\neg.txt 2>&1 & type .agent\\tmp\\sessions\\case\\neg.txt | findstr /C:"not ok"`,
      'mkdir ".agent\\tmp\\sessions\\case" 2>nul & git stash pop && npm test',
      'node --test --test-name-pattern="same pair|failure" tests/regression.test.js',
    ];
    for (const command of commands) expect(checkComplexTool(workspace, 'bash', { command }, false), command).toBeNull();
    expect(checkComplexTool(workspace, 'glob', { path: workspace, pattern: 'src/*.js' }, true)).toBeNull();
    expect(checkComplexTool(workspace, 'write', { path: '.agent/tmp/sessions/case/neg.txt', content: '' }, false)).toBeNull();
    expect(checkComplexTool(workspace, 'edit', { path: 'packages/cache/store.js', edits: [] }, false)).toBeNull();
    expect(checkComplexTool(workspace, 'bash', { command: 'npm test' }, true)).toBeNull();
    expect(checkComplexTool(workspace, 'bash', { command: 'node --test tests/basic.test.js' }, true)).toBeNull();
  });

  it('allows bounded scratch setup but rejects escape, protected writes and child mutations', () => {
    expect(checkComplexTool(workspace, 'bash', { command: 'if not exist ".agent/tmp/case" mkdir ".agent/tmp/case"' }, false)).toBeNull();
    for (const [tool, input, readOnly] of [
      ['read', { path: '../outside.txt' }, false],
      ['write', { path: 'README.md', content: '' }, false],
      ['edit', { path: 'tests/basic.test.js', edits: [] }, false],
      ['write', { path: 'src/cache.js', content: '' }, true],
      ['bash', { command: 'git stash pop' }, true],
      ['bash', { command: 'cd packages & cd .. & git diff' }, true],
      ['bash', { command: 'cd .. & git diff' }, false],
      ['bash', { command: 'npm install' }, true],
      ['bash', { command: 'node --test src/../../outside.test.js' }, false],
      ['bash', { command: 'node --test /outside/test.js' }, false],
      ['bash', { command: 'npm test > ../outside.txt' }, false],
      ['bash', { command: 'git status && curl https://example.invalid' }, false],
      ['spawn_agent', { task_name: 'nested' }, true],
      ['spawn_agent', { provider: 'unmetered' }, false],
      ['spawn_agent', { model: 'unmetered' }, false],
      ['run_workflow', {}, false],
    ] as const) expect(checkComplexTool(workspace, tool, input, readOnly), JSON.stringify(input)).not.toBeNull();
    expect(checkComplexTool(workspace, 'read', { path: '..notes/file.js' }, true)).toBeNull();
  });

  it('admits the unchanged readonly review command with literal separators while rejecting expansion and writes', () => {
    const command = 'type src\\cache.js src\\client.js src\\keys.js 2>nul & echo ---- & dir /b src tests packages\\cache packages\\client packages\\identity examples 2>nul & echo ---- & git diff --stat README.md package.json tests/basic.test.js & git status --porcelain README.md package.json tests/basic.test.js src examples';
    expect(checkComplexTool(workspace, 'bash', { command }, true)).toBeNull();
    for (const unsafe of [
      'echo %ZAI_CODING_API_KEY%', 'echo $ZAI_CODING_API_KEY',
      'echo $(node -e "process.exit()")', 'echo ---- > README.md',
      'echo ---- > .agent/tmp/out.txt', 'echo ---- & type ../outside.txt',
      'echo ---- & node -e "process.exit()"',
    ]) expect(checkComplexTool(workspace, 'bash', { command: unsafe }, true), unsafe).not.toBeNull();
  });
});
