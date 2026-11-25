import { describe, expect, it } from 'vitest';

import {
  createRuntimePermissionMatcher,
  hasDynamicShellExpansion,
  parseRuntimePermissionMatcher,
  runtimePermissionMatcherMatches,
} from './runtime-permission-scope.js';

describe('Runtime permission scope normalization', () => {
  it('creates a stable POSIX command fingerprint from the concrete command and cwd', () => {
    const first = createRuntimePermissionMatcher({
      toolName: 'bash',
      toolInput: { command: '  git commit -m "hello world"\r\n' },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    });
    const second = createRuntimePermissionMatcher({
      toolName: 'bash',
      toolInput: { command: 'git commit -m "hello world"' },
      executionCwd: '/workspace/repo/.',
      platform: 'posix',
    });

    expect(first).toMatchObject({
      kind: 'exact-command',
      shell: 'posix',
      cwd: '/workspace/repo',
      executable: 'git',
      commandFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      argvFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      background: false,
    });
    expect(second).toEqual(first);
  });

  it('normalizes Windows cwd case and separators without rewriting command semantics', () => {
    const matcher = createRuntimePermissionMatcher({
      toolName: 'bash',
      toolInput: { command: 'python -c "print(1)"' },
      executionCwd: 'C:/Works/Repo',
      platform: 'win32',
    });

    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'bash',
      toolInput: { command: 'python -c "print(1)"' },
      executionCwd: 'c:\\works\\repo\\.',
      platform: 'win32',
    })).toBe(true);
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'bash',
      toolInput: { command: "python -c 'print(1)'" },
      executionCwd: 'C:/Works/Repo',
      platform: 'win32',
    })).toBe(false);
  });

  it('keeps Windows cmd and PowerShell wrappers and quoting inside the exact fingerprint', () => {
    const cmd = createRuntimePermissionMatcher({
      toolName: 'bash',
      toolInput: { command: 'cmd /d /s /c "type C:\\Temp\\report.txt"' },
      executionCwd: 'C:\\Works\\Repo',
      platform: 'win32',
    });
    expect(runtimePermissionMatcherMatches(cmd, {
      toolName: 'bash',
      toolInput: { command: 'powershell -NoProfile -Command "Get-Content C:\\Temp\\report.txt"' },
      executionCwd: 'C:\\Works\\Repo',
      platform: 'win32',
    })).toBe(false);
    expect(runtimePermissionMatcherMatches(cmd, {
      toolName: 'bash',
      toolInput: { command: "cmd /d /s /c 'type C:\\Temp\\report.txt'" },
      executionCwd: 'C:\\Works\\Repo',
      platform: 'win32',
    })).toBe(false);
  });

  it('keeps shell wrappers, background execution, and cwd in the match boundary', () => {
    const matcher = createRuntimePermissionMatcher({
      toolName: 'bash',
      toolInput: { command: 'bash -c "npm test"' },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    });

    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'bash',
      toolInput: { command: 'sh -c "npm test"' },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    })).toBe(false);
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'bash',
      toolInput: { command: 'bash -c "npm test"', run_in_background: true },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    })).toBe(false);
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'bash',
      toolInput: { command: 'bash -c "npm test"' },
      executionCwd: '/workspace/other',
      platform: 'posix',
    })).toBe(false);
  });

  it('binds exact command grants to the configured interpreter contract', () => {
    const contractA = 'a'.repeat(64);
    const contractB = 'b'.repeat(64);
    const matcher = createRuntimePermissionMatcher({
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      executionCwd: 'C:\\workspace',
      platform: 'win32',
      shell: 'powershell',
      shellContractFingerprint: contractA,
    });

    expect(matcher).toMatchObject({
      kind: 'exact-command',
      shell: 'powershell',
      shellContractFingerprint: contractA,
    });
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      executionCwd: 'C:\\workspace',
      platform: 'win32',
      shell: 'powershell',
      shellContractFingerprint: contractA,
    })).toBe(true);
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      executionCwd: 'C:\\workspace',
      platform: 'win32',
      shell: 'cmd',
      shellContractFingerprint: contractB,
    })).toBe(false);
    expect(parseRuntimePermissionMatcher(matcher)).toEqual(matcher);
  });

  it('normalizes relative file paths against the effective execution cwd', () => {
    const matcher = createRuntimePermissionMatcher({
      toolName: 'edit',
      toolInput: { path: 'src/index.ts', old_string: 'a', new_string: 'b' },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    });

    expect(matcher).toMatchObject({
      kind: 'exact-path',
      toolName: 'edit',
      path: '/workspace/repo/src/index.ts',
    });
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'edit',
      toolInput: { path: '/workspace/repo/src/index.ts', old_string: 'other', new_string: 'content' },
      executionCwd: '/tmp',
      platform: 'posix',
    })).toBe(true);
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'write',
      toolInput: { path: '/workspace/repo/src/index.ts', content: 'x' },
      executionCwd: '/tmp',
      platform: 'posix',
    })).toBe(false);
  });

  it('keeps POSIX backslashes as filename characters instead of path separators', () => {
    const backslashName = createRuntimePermissionMatcher({
      toolName: 'write',
      toolInput: { path: String.raw`docs\report.md`, content: 'first' },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    });
    const nestedPath = createRuntimePermissionMatcher({
      toolName: 'write',
      toolInput: { path: 'docs/report.md', content: 'second' },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    });

    expect(backslashName).toMatchObject({
      kind: 'exact-path',
      path: String.raw`/workspace/repo/docs\report.md`,
    });
    expect(backslashName.fingerprint).not.toBe(nestedPath.fingerprint);
  });

  it('normalizes Windows relative paths, separators, and case to one path scope', () => {
    const matcher = createRuntimePermissionMatcher({
      toolName: 'write',
      toolInput: { path: 'Docs/Report.md', content: 'first' },
      executionCwd: 'C:\\Works\\Repo',
      platform: 'win32',
    });

    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'write',
      toolInput: { path: 'c:/works/repo/docs/report.md', content: 'second' },
      executionCwd: 'D:\\Other',
      platform: 'win32',
    })).toBe(true);
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'write',
      toolInput: { path: 'C:\\Works\\Repo\\Docs\\Other.md', content: 'second' },
      executionCwd: 'D:\\Other',
      platform: 'win32',
    })).toBe(false);
  });

  it('keeps the effective cwd in generic tool-call scopes', () => {
    const matcher = createRuntimePermissionMatcher({
      toolName: 'repo_search',
      toolInput: { query: 'RuntimePermissionScope', target_path: 'src' },
      executionCwd: '/workspace/repo-a',
      platform: 'posix',
    });
    expect(matcher).toMatchObject({ kind: 'exact-call', cwd: '/workspace/repo-a' });
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'repo_search',
      toolInput: { query: 'RuntimePermissionScope', target_path: 'src' },
      executionCwd: '/workspace/repo-b',
      platform: 'posix',
    })).toBe(false);
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'repo_search',
      toolInput: {
        query: 'RuntimePermissionScope',
        target_path: 'src',
        description: 'different concrete request',
      },
      executionCwd: '/workspace/repo-a',
      platform: 'posix',
    })).toBe(false);
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'repo_search',
      toolInput: {
        query: 'RuntimePermissionScope',
        target_path: 'src',
        _runtime_option: true,
      },
      executionCwd: '/workspace/repo-a',
      platform: 'posix',
    })).toBe(false);
  });

  it('scopes an mcp_call grant to the MCP tool, not to its arguments', () => {
    const matcher = createRuntimePermissionMatcher({
      toolName: 'mcp_call',
      toolInput: { id: 'mcp:docs:tool:search', args: { query: 'first' } },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    });
    const matches = (toolInput: Record<string, unknown>) => runtimePermissionMatcherMatches(matcher, {
      toolName: 'mcp_call', toolInput, executionCwd: '/workspace/repo', platform: 'posix',
    });
    expect(matches({ id: 'mcp:docs:tool:search', args: { query: 'second' } })).toBe(true);
    expect(matches({ id: 'mcp:docs:tool:delete', args: { query: 'first' } })).toBe(false);
  });

  it('does not infer a path-wide grant for an arbitrary extension tool', () => {
    const matcher = createRuntimePermissionMatcher({
      toolName: 'extension_publish',
      toolInput: {
        path: 'dist/package.tgz',
        destination: 'production',
        force: false,
      },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    });

    expect(matcher).toMatchObject({ kind: 'exact-call', toolName: 'extension_publish' });
    expect(runtimePermissionMatcherMatches(matcher, {
      toolName: 'extension_publish',
      toolInput: {
        path: 'dist/package.tgz',
        destination: 'production',
        force: true,
      },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    })).toBe(false);
  });

  it('detects shell environment expansion instead of freezing its current value into a grant', () => {
    expect(hasDynamicShellExpansion('echo $HOME', 'posix')).toBe(true);
    expect(hasDynamicShellExpansion('echo ${HOME}/tmp', 'posix')).toBe(true);
    expect(hasDynamicShellExpansion('echo %USERPROFILE%', 'win32')).toBe(true);
    expect(hasDynamicShellExpansion('echo !TEMP!', 'win32')).toBe(true);
    expect(hasDynamicShellExpansion('echo %1 %*', 'win32')).toBe(true);
    expect(hasDynamicShellExpansion('for %A in (*) do echo %A', 'win32')).toBe(true);
    expect(hasDynamicShellExpansion('powershell -Command "$env:TEMP"', 'win32')).toBe(true);
    expect(hasDynamicShellExpansion('powershell -Command "$HOME\\report.txt"', 'win32')).toBe(true);
    expect(hasDynamicShellExpansion('pwsh -Command "Get-Content $PWD\\report.txt"', 'win32')).toBe(true);
    expect(hasDynamicShellExpansion('pwsh -Command "Get-Content $target"', 'win32')).toBe(true);
    expect(hasDynamicShellExpansion('pwsh -Command "$(Get-Location)"', 'win32')).toBe(true);
    expect(hasDynamicShellExpansion('echo "$? $$ $1 $@"', 'posix')).toBe(true);
    expect(hasDynamicShellExpansion('echo C:\\Users\\fixed', 'win32')).toBe(false);
  });

  it('rejects a persisted matcher whose visible scope was changed without its fingerprint', () => {
    const matcher = createRuntimePermissionMatcher({
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      executionCwd: '/workspace/repo',
      platform: 'posix',
    });
    expect(() => parseRuntimePermissionMatcher({
      ...matcher,
      cwd: '/workspace/other',
    })).toThrow(/fingerprint/i);
    expect(() => parseRuntimePermissionMatcher({
      ...matcher,
      executable: 'node',
    })).toThrow(/fingerprint/i);
  });
});
