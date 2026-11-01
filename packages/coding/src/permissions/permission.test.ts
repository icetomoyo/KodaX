import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentConfigHome } from '@kodax-ai/agent';
import {
  getDirectShellBypassBlockReason,
  getPlanModeBlockReason,
  isAlwaysConfirmPath,
  isBashReadCommand,
  isBashReadCommandAutoAllowed,
  isBashWriteCommand,
  isCommandOnProtectedPath,
  isHelpCommand,
  isPlanModeAllowedPath,
  isToolCallAllowed,
} from './permission.js';
import type { RunScopedToolDefinition } from '../extensions/runtime-contract.js';
import type {
  BashPrefixExtractor,
  BashPrefixResult,
} from '../guardrails/auto-mode/bash-prefix-extractor.js';

function createTempDirSync(prefix: string, parentDir?: string): string {
  return fs.mkdtempSync(path.join(parentDir ?? os.tmpdir(), prefix));
}

function removeTempDirSync(dir: string | undefined): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows may keep a test handle open briefly; the OS reclaims temp files.
  }
}

const createdRoots: string[] = [];

function createProjectRoot(): string {
  const root = createTempDirSync('kodax-plan-mode-', process.cwd());
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    removeTempDirSync(root);
  }
});

describe('plan mode writable path whitelist', () => {
  it('FEATURE_294: run-scoped host tools resolve plan-mode admission through materialized metadata', () => {
    const runScoped = new Map<string, RunScopedToolDefinition>([
      ['space_report_export', {
        name: 'space_report_export',
        description: 'Export the current report.',
        inputSchema: { type: 'object' },
        capabilityId: 'host:lease-1:space_report_export',
        sideEffect: 'readonly',
        planModeAllowed: true,
      }],
      ['space_artifact_create', {
        name: 'space_artifact_create',
        description: 'Create a Space artifact.',
        inputSchema: { type: 'object' },
        capabilityId: 'host:lease-1:space_artifact_create',
        sideEffect: 'mutates-state',
        planModeAllowed: false,
      }],
    ]);
    expect(
      getPlanModeBlockReason('space_report_export', {}, undefined, undefined, runScoped),
    ).toBeNull();
    expect(
      getPlanModeBlockReason('space_artifact_create', {}, undefined, undefined, runScoped),
    ).toMatch(/not permitted in plan mode/);
    // Fail-closed: without the run-scoped map the name is unknown and blocks.
    expect(getPlanModeBlockReason('space_report_export', {})).toMatch(/side effects/);
  });

  it('allows writes to the project plan mode document', () => {
    const projectRoot = createProjectRoot();

    expect(isPlanModeAllowedPath('.agent/plan_mode_doc.md', projectRoot)).toBe(true);
    expect(getPlanModeBlockReason('write', { path: '.agent/plan_mode_doc.md' }, projectRoot)).toBeNull();
    expect(
      getPlanModeBlockReason(
        'edit',
        { path: path.join(projectRoot, '.agent', 'plan_mode_doc.md') },
        projectRoot
      )
    ).toBeNull();
  });

  it('resolves relative plan-mode targets from executionCwd while keeping projectRoot as the boundary', () => {
    const projectRoot = createProjectRoot();
    const executionCwd = path.join(projectRoot, 'packages', 'app');
    const planFromExecutionCwd = path.join('..', '..', '.agent', 'plan_mode_doc.md');

    expect(isPlanModeAllowedPath(planFromExecutionCwd, projectRoot, executionCwd)).toBe(true);
    expect(getPlanModeBlockReason(
      'write',
      { path: planFromExecutionCwd },
      projectRoot,
      executionCwd,
    )).toBeNull();
    expect(getPlanModeBlockReason(
      'write',
      { path: '.agent/plan_mode_doc.md' },
      projectRoot,
      executionCwd,
    )).toContain('Plan mode only allows file modifications');
  });

  it('allows writes in the system temp directory', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-plan-${Date.now()}.txt`);

    expect(isPlanModeAllowedPath(tempFile, projectRoot)).toBe(true);
    expect(getPlanModeBlockReason('write', { path: tempFile }, projectRoot)).toBeNull();
  });

  it('blocks other workspace files and other .agent files', () => {
    const projectRoot = createProjectRoot();

    expect(getPlanModeBlockReason('write', { path: 'README.md' }, projectRoot)).toContain(
      'Plan mode only allows file modifications'
    );
    expect(getPlanModeBlockReason('edit', { path: '.agent/other.md' }, projectRoot)).toContain(
      'Plan mode only allows file modifications'
    );
  });

  it('allows bash writes only when every target stays in the whitelist', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-plan-${Date.now()}.txt`);

    expect(
      getPlanModeBlockReason('bash', { command: 'echo hi > .agent/plan_mode_doc.md' }, projectRoot)
    ).toBeNull();
    expect(
      getPlanModeBlockReason('bash', { command: `echo hi > "${tempFile}"` }, projectRoot)
    ).toBeNull();
  });

  it('blocks bash writes outside the whitelist or without a safe target', () => {
    const projectRoot = createProjectRoot();

    expect(
      getPlanModeBlockReason('bash', { command: 'echo hi > README.md' }, projectRoot)
    ).toContain('Blocked target: README.md');
    expect(
      getPlanModeBlockReason('bash', { command: 'mkdir scratch-output' }, projectRoot)
    ).toContain('Could not determine a safe target');
  });
});

// v0.7.42 — metadata-driven plan-mode gate. Pre-v0.7.42 getPlanModeBlockReason
// hardcoded {write, edit, undo, bash} as the only gated tools, silently
// permitting multi_edit, insert_after_anchor, worktree_*, dispatch_child_task,
// web_fetch, mcp_call, send_message, construction-staircase, etc. The
// metadata-driven gate (sideEffect + planModeAllowed) closes that gap.
describe('plan mode — metadata-driven gating (v0.7.42 gap 2)', () => {
  it('readonly tools permitted without explicit annotation', () => {
    const projectRoot = createProjectRoot();
    // No `planModeAllowed: true` needed — sideEffect: 'readonly' is enough.
    expect(getPlanModeBlockReason('read', { path: 'src/foo.ts' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('glob', { pattern: '**/*.ts' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('grep', { pattern: 'export' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('code_search', { query: 'TODO' }, projectRoot)).toBeNull();
  });

  it('plan-loop tools (planModeAllowed:true) permitted regardless of sideEffect', () => {
    const projectRoot = createProjectRoot();
    expect(getPlanModeBlockReason('exit_plan_mode', { plan: 'x' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('todo_update', { id: 'todo_1', status: 'completed' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('todo_create', { subject: 'Audit auth' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('interrupt_agent', { target: '/root/child' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('ask_user_question', { question: 'X?' }, projectRoot)).toBeNull();
  });

  it('network-query tools (web_search / mcp_search etc.) permitted for research-during-plan', () => {
    const projectRoot = createProjectRoot();
    expect(getPlanModeBlockReason('web_search', { query: 'rust async' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('mcp_search', { query: 'github' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('mcp_describe', { id: 'gh.search' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('mcp_read_resource', { id: 'gh.issue' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('mcp_get_prompt', { id: 'gh.review' }, projectRoot)).toBeNull();
  });

  it('multi_edit / insert_after_anchor honor path-aware escape (newly gated in v0.7.42)', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-multi-edit-${Date.now()}.txt`);

    // Permitted via plan-doc escape:
    expect(
      getPlanModeBlockReason(
        'multi_edit',
        { path: '.agent/plan_mode_doc.md', edits: [] },
        projectRoot,
      ),
    ).toBeNull();

    // Permitted via system-temp escape:
    expect(
      getPlanModeBlockReason('multi_edit', { path: tempFile, edits: [] }, projectRoot),
    ).toBeNull();

    // Blocked when path is outside escape:
    expect(
      getPlanModeBlockReason('multi_edit', { path: 'src/foo.ts', edits: [] }, projectRoot),
    ).toContain('Plan mode only allows file modifications');

    expect(
      getPlanModeBlockReason('insert_after_anchor', { path: 'src/foo.ts', anchor: 'X', content: 'Y' }, projectRoot),
    ).toContain('Plan mode only allows file modifications');
  });

  it('worktree_create / worktree_remove block outright (no path-aware escape; newly gated)', () => {
    const projectRoot = createProjectRoot();
    const reason = getPlanModeBlockReason('worktree_create', { branch_name: 'feat-x' }, projectRoot);
    expect(reason).toContain("Tool 'worktree_create'");
    expect(reason).toContain('side effects');

    const reason2 = getPlanModeBlockReason(
      'worktree_remove',
      { action: 'remove', worktree_path: '/tmp/wt' },
      projectRoot,
    );
    expect(reason2).toContain("Tool 'worktree_remove'");
  });

  it('spawn_agent / send_message block outright as state mutations', () => {
    const projectRoot = createProjectRoot();
    expect(
      getPlanModeBlockReason('spawn_agent', { objective: 'investigate' }, projectRoot),
    ).toContain("Tool 'spawn_agent'");
    expect(
      getPlanModeBlockReason('send_message', { to: 't_1', content: 'hi' }, projectRoot),
    ).toContain("Tool 'send_message'");
  });

  it('blocks durable Memory mutations in plan mode', () => {
    const projectRoot = createProjectRoot();
    expect(getPlanModeBlockReason('memory_intent', {
      operation: 'remember',
      statement: 'This project uses npm.',
    }, projectRoot)).toContain("Tool 'memory_intent'");
    expect(getPlanModeBlockReason('memory_intent', {
      operation: 'forget',
      targetRefId: 'memdir:project:handle:package-manager.md',
    }, projectRoot)).toContain("Tool 'memory_intent'");
  });

  it('web_fetch / mcp_call block in plan mode through their explicit plan policy', () => {
    const projectRoot = createProjectRoot();
    expect(getPlanModeBlockReason('web_fetch', { url: 'https://x' }, projectRoot)).toContain(
      "Tool 'web_fetch'",
    );
    expect(getPlanModeBlockReason('mcp_call', { id: 'gh.create_issue', args: {} }, projectRoot)).toContain(
      "Tool 'mcp_call'",
    );
  });

  it('construction-staircase WRITE/activate steps block in plan mode (scaffold is a readonly draft)', () => {
    const projectRoot = createProjectRoot();
    // scaffold_tool / scaffold_agent only return a fillable JSON skeleton (no
    // disk write) — relabeled 'readonly' (ADR-043), so drafting a design during
    // planning is permitted. The steps that actually persist / activate the
    // artifact remain blocked.
    expect(getPlanModeBlockReason('scaffold_tool', { name: 'foo' }, projectRoot)).toBeNull();
    expect(getPlanModeBlockReason('scaffold_agent', { name: 'foo' }, projectRoot)).toBeNull();
    expect(
      getPlanModeBlockReason('stage_construction', { artifact_json: '{}' }, projectRoot),
    ).toContain("Tool 'stage_construction'");
    expect(getPlanModeBlockReason('activate_tool', { name: 'foo', version: '0.1.0' }, projectRoot)).toContain(
      "Tool 'activate_tool'",
    );
  });

  it('undo still blocks with a meaningful reason', () => {
    const projectRoot = createProjectRoot();
    const reason = getPlanModeBlockReason('undo', {}, projectRoot);
    expect(reason).toBeTruthy();
    expect(reason).toContain("Tool 'undo'");
  });

  it('unknown tool defaults to fail-closed (blocked)', () => {
    const projectRoot = createProjectRoot();
    const reason = getPlanModeBlockReason('totally_unknown_tool', {}, projectRoot);
    expect(reason).toBeTruthy();
    expect(reason).toContain('side effects');
  });
});

describe('isAlwaysConfirmPath — system temp as safe scratchpad', () => {
  const windowsIt = process.platform === 'win32' ? it : it.skip;

  it('does NOT require confirmation for paths inside the system temp directory', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-test-${Date.now()}.txt`);
    expect(isAlwaysConfirmPath(tempFile, projectRoot)).toBe(false);
  });

  windowsIt('does NOT require confirmation for system temp paths reached through an 8.3 alias ancestor', () => {
    const projectRoot = createProjectRoot();
    const longRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-short-alias-'));
    try {
      const result = spawnSync(
        'cmd',
        ['/d', '/c', `for %I in ("${longRoot}") do @echo %~sI`],
        { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true },
      );
      expect(result.status).toBe(0);
      const short = result.stdout.trim();
      expect(fs.realpathSync.native(short).toLowerCase()).toBe(fs.realpathSync.native(longRoot).toLowerCase());
      // Volumes without short-name generation keep the long form; the guard
      // only applies where an 8.3 alias actually exists (GitHub runners do).
      if (short.toLowerCase() === longRoot.toLowerCase()) return;
      expect(isAlwaysConfirmPath(path.join(short, 'scratch.txt'), projectRoot)).toBe(false);
    } finally {
      fs.rmSync(longRoot, { recursive: true, force: true });
    }
  });

  it('does NOT require confirmation for paths inside the project root', () => {
    const projectRoot = createProjectRoot();
    const projectFile = path.join(projectRoot, 'src', 'example.ts');
    expect(isAlwaysConfirmPath(projectFile, projectRoot)).toBe(false);
  });

  it('DOES require confirmation for paths outside both project and system temp', () => {
    const projectRoot = createProjectRoot();
    const homeFile = path.join(os.homedir(), 'Documents', 'other-project-file.ts');
    expect(isAlwaysConfirmPath(homeFile, projectRoot)).toBe(true);
  });

  it('DOES require confirmation for .kodax/ project config even inside project root', () => {
    const projectRoot = createProjectRoot();
    const kodaxFile = path.join(projectRoot, '.kodax', 'config.json');
    expect(isAlwaysConfirmPath(kodaxFile, projectRoot)).toBe(true);
  });

  it('protects lexical project config reached through a directory alias', () => {
    const projectRoot = createProjectRoot();
    const ordinary = path.join(projectRoot, 'ordinary');
    fs.mkdirSync(ordinary);
    fs.symlinkSync(ordinary, path.join(projectRoot, '.kodax'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(isAlwaysConfirmPath(path.join(projectRoot, '.kodax', 'config.json'), projectRoot)).toBe(true);
    expect(isAlwaysConfirmPath(path.join(ordinary, 'config.json'), projectRoot)).toBe(true);
  });

  it('keeps confirmation required when an ordinary target cannot be canonicalized', () => {
    const projectRoot = createProjectRoot();
    const probe = vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => {
      throw Object.assign(new Error('Fixture access denied.'), { code: 'EACCES' });
    });
    try {
      expect(isAlwaysConfirmPath(path.join(projectRoot, 'file.txt'), projectRoot)).toBe(true);
    } finally { probe.mockRestore(); }
  });

  it('DOES require confirmation for ~/.kodax user config', () => {
    const projectRoot = createProjectRoot();
    const userKodaxFile = path.join(os.homedir(), '.kodax', 'auth.json');
    expect(isAlwaysConfirmPath(userKodaxFile, projectRoot)).toBe(true);
  });

  it('bash commands writing to system temp are not flagged as protected', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-bash-${Date.now()}.txt`);
    // extractPathsFromCommand needs patterns it recognizes — use absolute path in arg
    expect(isCommandOnProtectedPath(`echo hi > "${tempFile}"`, projectRoot)).toBe(false);
  });

  it('bash commands writing outside project+temp are still flagged as protected', () => {
    const projectRoot = createProjectRoot();
    const outsideFile = path.join(os.homedir(), 'Documents', 'unrelated.txt');
    expect(isCommandOnProtectedPath(`echo hi > "${outsideFile}"`, projectRoot)).toBe(true);
  });
});

describe('direct shell syntax guardrails', () => {
  it('allows safe read-only exploration commands', () => {
    expect(getDirectShellBypassBlockReason('git status --short')).toBeNull();
    expect(getDirectShellBypassBlockReason('cd src && pwd')).toBeNull();
  });

  it('blocks write or shell-chaining commands outside the safe whitelist', () => {
    expect(getDirectShellBypassBlockReason('npm install')).toContain('safe read-only commands');
    expect(getDirectShellBypassBlockReason('echo hi > out.txt')).toContain('safe read-only commands');
  });
});

// Issue 129: pure read-only commands containing 2>NUL / 2>/dev/null fd-redirects,
// pipes between safe-read stages, or Windows-native search tools were misclassified
// as "Modify files" and forced confirmation in auto mode.
describe('isBashWriteCommand — fd-redirect to null device is not a write (Issue 129)', () => {
  it('does not flag stderr-discard 2>NUL (Windows null device)', () => {
    expect(isBashWriteCommand('findstr foo bar 2>NUL')).toBe(false);
    expect(isBashWriteCommand('findstr foo bar 2>nul')).toBe(false);
  });

  it('does not flag stderr-discard 2>/dev/null (POSIX null device)', () => {
    expect(isBashWriteCommand('ls 2>/dev/null')).toBe(false);
    expect(isBashWriteCommand('grep foo file 2>>/dev/null')).toBe(false);
  });

  it('does not flag combined-stream discard &>/dev/null', () => {
    expect(isBashWriteCommand('grep foo bar &>/dev/null')).toBe(false);
  });

  it('still flags real file writes (regression guard)', () => {
    expect(isBashWriteCommand('echo hi > out.txt')).toBe(true);
    expect(isBashWriteCommand('echo hi >> out.txt')).toBe(true);
    expect(isBashWriteCommand('cat foo > /tmp/x')).toBe(true);
  });

  it('still flags real writes that also contain a null-device redirect', () => {
    // 2>NUL stripped, but the > out.txt write must still be detected.
    expect(isBashWriteCommand('cmd 2>NUL > out.txt')).toBe(true);
  });
});

describe('isBashReadCommand — Windows search tools and pipe chains (Issue 129)', () => {
  it('treats findstr as a safe read command', () => {
    expect(isBashReadCommand('findstr foo file.txt')).toBe(true);
  });

  it.each([
    'git -C C:\\repo show --stat HEAD',
    'git --no-pager -C C:\\repo log -5',
    'git --git-dir=C:\\repo\\.git --work-tree=C:\\repo diff --stat',
    'git -C C:\\repo show --stat HEAD | head -60',
    'git branch --list feature/*',
    'git branch --contains HEAD',
    'git tag -- -v',
    'git stash show stash@{0}',
    'git grep pattern -- -O',
    'git grep pattern -- --ext-grep',
    'git diff -- --output',
    'git grep -iefoo .env',
    'git grep -eTOKEN README.md',
    'git config get user.email',
    'git config list --name-only',
    'git tag -v v0.7.78',
    'git tag --verify v0.7.78',
    'git show --show-signature HEAD',
    'git log --format=%G? -1',
    'git branch --format="%(signature:grade)" --list',
    'git tag --format="%(*signature:grade)" --list',
  ])('recognizes read-only git commands after benign global options: %s', (command) => {
    expect(isBashReadCommand(command)).toBe(true);
  });

  it.each([
    'git -c core.pager=evil show HEAD',
    'git --config-env=core.pager=PAGER show HEAD',
    'git -C C:\\repo reset --hard HEAD',
    'git -C C:\\repo branch new-branch',
    'git -C C:\\repo remote add origin https://example.com/repo.git',
    'git config set get value',
    'git config unset get',
    'git grep -O less transcriptSearch',
    'git grep -Oless transcriptSearch',
    'git grep -inOless transcriptSearch',
    'git grep --ext-grep transcriptSearch',
    'git branch -uxyz',
    'git branch -t',
    'git branch -ld',
    'git tag -ld',
  ])('does not treat effectful git options or subcommands as read-only: %s', (command) => {
    expect(isBashReadCommand(command)).toBe(false);
  });

  it('validates every newline-delimited command before allowing a compound read', () => {
    expect(isBashReadCommand('echo safe\npwd')).toBe(true);
    expect(isBashReadCommand('echo safe\nnode --version')).toBe(false);
    expect(isBashReadCommand('echo safe\r\nnode script.js')).toBe(false);
    expect(isBashReadCommand('echo safe\rrm -rf .')).toBe(false);
    expect(isBashReadCommand('echo safe # "comment\nnode script.js')).toBe(false);
    expect(isBashReadCommand('echo "safe\ntext"')).toBe(true);
    expect(isBashReadCommand('echo "safe\n$(node script.js)"')).toBe(false);
    expect(isBashReadCommand("echo 'safe\n$(node script.js)'")).toBe(true);
    expect(isBashReadCommand('echo safe\\ #$(node script.js)')).toBe(false);
    expect(isBashReadCommand('echo safe\\\n#$(node script.js)')).toBe(false);
  });

  it('requires an explicit Windows where.exe and leaves ambiguous commands to review', () => {
    expect(isBashReadCommand('fc a.txt b.txt')).toBe(false);
    expect(isBashReadCommand('fc -s')).toBe(false);
    expect(isBashReadCommand('where node')).toBe(false);
    expect(isBashReadCommand('where.exe node')).toBe(true);
  });

  it('allows pipe chains where every stage is a safe-read command', () => {
    expect(isBashReadCommand('findstr foo a.txt | findstr bar')).toBe(true);
    expect(isBashReadCommand('grep foo file | grep bar | wc -l')).toBe(true);
  });

  it('allows null-device fd-redirects inside read chains', () => {
    expect(isBashReadCommand('findstr foo a.txt 2>NUL | findstr bar')).toBe(true);
    expect(isBashReadCommand('grep foo file 2>/dev/null')).toBe(true);
  });

  it('allows the original Issue 129 reproduction command', () => {
    expect(
      isBashReadCommand(
        'cd C:\\Works\\claudecode && findstr /S /I /N "todos" src\\bootstrap\\state.ts 2>NUL | findstr /V "node_modules"',
      ),
    ).toBe(true);
  });

  it('rejects pipe chains where any stage is a write command (regression guard)', () => {
    expect(isBashReadCommand('ls | rm -rf /')).toBe(false);
    expect(isBashReadCommand('cat file | tee out.txt')).toBe(false);
  });

  it('rejects redirects to real files even with a read-only base command', () => {
    expect(isBashReadCommand('grep foo file > out.txt')).toBe(false);
  });
});

describe('Agent Home permission narrowing', () => {
  it('allows ordinary descendants while keeping sensitive reads reviewable', () => {
    const projectRoot = createProjectRoot();
    const agentHome = createTempDirSync('kodax-agent-home-');
    createdRoots.push(agentHome);
    fs.mkdirSync(path.join(agentHome, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(agentHome, 'mcp-tokens'), { recursive: true });
    setAgentConfigHome(agentHome);
    try {
      const agentFile = path.join(agentHome, 'agents', 'reviewer.md');
      const tokenFile = path.join(agentHome, 'mcp-tokens', 'token.json');
      expect(isAlwaysConfirmPath(agentFile, projectRoot)).toBe(false);
      expect(isAlwaysConfirmPath(path.join(agentHome, 'config.json'), projectRoot)).toBe(true);
      expect(isAlwaysConfirmPath(
        path.join(agentHome, 'processes', 'children', 'forged.json'),
        projectRoot,
      )).toBe(true);
      expect(isBashReadCommandAutoAllowed(`type "${agentFile}"`, projectRoot)).toBe(true);
      expect(isBashReadCommandAutoAllowed(`type "${tokenFile}"`, projectRoot)).toBe(false);
    } finally {
      setAgentConfigHome(undefined);
    }
  });
});

describe('isBashReadCommand — PowerShell read-only inspection', () => {
  const environmentInspection = [
    "echo '=== where.exe rg now ==='",
    'where.exe rg 2>&1',
    "echo '=== WinGet Links on PATH? ==='",
    "$env:PATH -split ';' | Where-Object { $_ -like '*WinGet*' }",
    "echo '=== rg version ==='",
    'rg --version 2>&1 | Select-Object -First 2',
  ].join('; ');

  it('allows the reported multi-statement PowerShell environment inspection', () => {
    expect(isBashReadCommand(environmentInspection)).toBe(true);
  });

  it.each([
    'where.exe rg',
    'rg --version 2>&1 | Select-Object -First 2',
    "$env:PATH -split ';' | Where-Object { $_ -like '*WinGet*' }",
  ])('recognizes the safe read-only stage: %s', (command) => {
    expect(isBashReadCommand(command)).toBe(true);
  });

  it.each([
    "$env:AWS_SECRET_ACCESS_KEY | Select-Object -First 1",
    "Get-ChildItem | Where-Object { Remove-Item $_.FullName }",
    "Get-ChildItem | Select-Object @{Name='x';Expression={Remove-Item $_.FullName}}",
    'rg --pre malicious-helper pattern .',
    "& 'C:\\tools\\dsh.cmd' --version",
  ])('does not deterministically allow PowerShell with unproved effects: %s', (command) => {
    expect(isBashReadCommand(command)).toBe(false);
  });

  it.each([
    "& 'C:\\tmp\\rg.exe' --version",
    "& 'C:\\tmp\\where.exe' rg",
    '/tmp/rg --version',
    '.\\rg.exe --version',
  ])('does not trust a path-qualified executable by whitelist basename: %s', (command) => {
    expect(isBashReadCommand(command)).toBe(false);
  });

  it.each([
    `awk 'BEGIN { system("touch pwned") }' package.json`,
    `sed -n '1e touch pwned' package.json`,
    `awk '{ print $1 }' package.json`,
    `sed -n '1p' package.json`,
  ])('routes shell DSL interpreters through review: %s', (command) => {
    expect(isBashReadCommand(command)).toBe(false);
  });

  it.each([
    'find . -delete',
    'find . -exec touch pwned ;',
    'find . -fprintf report.txt %p',
    'find . -fprint report.txt',
  ])('does not treat effectful find actions as static reads: %s', (command) => {
    expect(isBashReadCommand(command)).toBe(false);
  });

  it('does not allow variables in a PowerShell comparison literal', () => {
    expect(isBashReadCommand(
      'echo candidate | Where-Object { $_ -eq $env:AWS_SECRET_ACCESS_KEY }',
    )).toBe(false);
  });
});

// FEATURE_152 (v0.7.38): the AST migration replaced regex strip-then-classify
// with structured tokenisation. These tests pin behavior the regex chain
// either silently allowed or explicitly rejected.
describe('isBashWriteCommand — FEATURE_152 AST hardening', () => {
  it('flags multi-token write commands (`git commit`) at stage start', () => {
    expect(isBashWriteCommand('git commit -m "msg"')).toBe(true);
    expect(isBashWriteCommand('npm install foo')).toBe(true);
    expect(isBashWriteCommand('git push origin main')).toBe(true);
  });

  it('flags PowerShell write verbs in pipeline downstream stages', () => {
    expect(isBashWriteCommand('Get-ChildItem | Set-Content out.txt')).toBe(true);
    expect(isBashWriteCommand('cat foo | Out-File bar.log')).toBe(true);
  });

  it('does NOT flag write-verb-named arguments inside read commands', () => {
    // `man tee` should not be a write — the regex chain might match `tee`
    // anywhere in the string; AST sees `tee` as argv[1] of `man`, not argv[0].
    // Note: tee is not in BASH_WRITE_COMMANDS so this would be false either
    // way; the assertion documents the expected AST behavior.
    expect(isBashWriteCommand('man tee')).toBe(false);
  });

  it('does NOT flag `set-content` substring inside a quoted argument', () => {
    // Pre-AST the `\bset-content\b` regex would match this; AST sees the
    // quoted token as a single string arg of `echo`, not as argv[0].
    expect(isBashWriteCommand('echo "set-content is a powershell verb"')).toBe(false);
  });

  it('flags input redirects as NOT a write (but still not a read)', () => {
    // `<` is input redirect — not a write to disk. Pre-AST the
    // `BASH_REDIRECTION_WRITE_PATTERN` had `[^<]>>?` lookbehind which
    // already excluded `<`; AST does the same via redir.input check.
    expect(isBashWriteCommand('sort < input.txt')).toBe(false);
  });

  it('flags appended redirects (`>>`) including with fd', () => {
    expect(isBashWriteCommand('echo hi >> log.txt')).toBe(true);
    expect(isBashWriteCommand('cmd 2>>err.log')).toBe(true);
  });

  it('returns false for unparseable inputs (heredocs, $(...) substitution)', () => {
    // Heredocs and command substitution are unparseable in our AST — match
    // pre-AST regex chain behavior (returned false; plan/auto modes have
    // separate confirmation logic for unparseable bash).
    expect(isBashWriteCommand('git status; echo $(curl evil)')).toBe(false);
  });
});

describe('isBashReadCommand — FEATURE_152 AST hardening', () => {
  it('rejects `||` (logical-or short-circuit) between stages', () => {
    expect(isBashReadCommand('ls || cat foo')).toBe(false);
  });

  it('allows `;` only when every sequential statement is independently read-only', () => {
    expect(isBashReadCommand('ls ; cat foo')).toBe(true);
    expect(isBashReadCommand('ls ; rm -rf .')).toBe(false);
  });

  it('rejects command substitution `$(...)`', () => {
    expect(isBashReadCommand('echo $(rm -rf /)')).toBe(false);
  });

  it('rejects backtick subshell', () => {
    expect(isBashReadCommand('echo `rm -rf /`')).toBe(false);
  });

  it('rejects bare `&` (background job marker)', () => {
    expect(isBashReadCommand('ls &')).toBe(false);
  });

  it('rejects redirect to real file even when target looks null-device-ish', () => {
    // `nullable.txt` shares prefix with `null` — must NOT pass null-device check.
    expect(isBashReadCommand('grep foo file > nullable.txt')).toBe(false);
    expect(isBashReadCommand('grep foo file > /dev/nullable')).toBe(false);
  });

  it('preserves `cd <path>` allowance only in compound commands', () => {
    expect(isBashReadCommand('cd src')).toBe(false); // bare cd not a "read"
    expect(isBashReadCommand('cd src && ls')).toBe(true);
  });
});

// FEATURE_152 slice 3 (v0.7.38): collectBashWriteTargets / extractPathsFromCommand
// switched from regex-soup to AST. The AST version replaces four overlapping
// regex sweeps with structural traversal, eliminating substring-vs-token
// false positives while preserving plan-mode coverage.
//
// Imports needed at the top of the file are already in place — these tests
// exercise the public API used by plan-mode and isCommandOnProtectedPath.
describe('collectBashWriteTargets — FEATURE_152 AST hardening', () => {
  it('extracts `>` redirect targets across statements + stages', async () => {
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('echo hi > out.txt && cat foo > out2.txt');
    expect(targets).toContain('out.txt');
    expect(targets).toContain('out2.txt');
  });

  it('extracts tee target from pipeline stage 2', async () => {
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('cat foo | tee /tmp/out');
    expect(targets).toContain('/tmp/out');
  });

  it('does NOT match `tee` as a substring inside another argv token', async () => {
    // Pre-AST `\btee\b` regex would match `committee.txt`-ish tokens at word
    // boundaries in some inputs. AST sees argv[0]='cat', argv[1]='committee.txt'
    // so the tee branch is never taken.
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('cat committee.txt');
    expect(targets).not.toContain('committee.txt');
  });

  it('extracts PowerShell `Set-Content -Path` value', async () => {
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('Set-Content -Path C:\\out.txt -Value foo');
    expect(targets).toContain('C:\\out.txt');
  });

  it('extracts PowerShell positional arg when -Path absent', async () => {
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('Out-File foo.txt');
    expect(targets).toContain('foo.txt');
  });

  it.each([
    ['Copy-Item inside.txt outside.txt', ['outside.txt'], ['inside.txt']],
    ['Move-Item -Force inside.txt outside.txt', ['inside.txt', 'outside.txt'], []],
    ['Set-Content -Value data outside.txt', ['outside.txt'], ['data']],
    ['Out-File -InputObject data -FilePath outside.txt', ['outside.txt'], ['data']],
    ['New-Item -ItemType File outside.txt', ['outside.txt'], ['File']],
    ['Remove-Item -Filter harmless.txt outside.txt', ['outside.txt'], ['harmless.txt']],
  ] as const)(
    'binds PowerShell mutation targets by command semantics: %s',
    async (command, included, excluded) => {
      const { collectDeterministicBashWriteTargets } = await import('./permission.js');
      const targets = collectDeterministicBashWriteTargets(command);
      for (const target of included) expect(targets).toContain(target);
      for (const value of excluded) expect(targets).not.toContain(value);
    },
  );

  it.each([
    ['move /Y src/a.txt build/a.txt', ['src/a.txt', 'build/a.txt'], ['/Y']],
    ['copy /Y src/a.txt build/a.txt', ['build/a.txt'], ['/Y', 'src/a.txt']],
    ['del /Q /A:H build/old.txt', ['build/old.txt'], ['/Q', '/A:H']],
    ['rd /S /Q build/old', ['build/old'], ['/S', '/Q']],
  ] as const)(
    'does not treat cmd mutation switches as write targets: %s',
    async (command, included, excluded) => {
      const { collectDeterministicBashWriteTargets } = await import('./permission.js');
      const targets = collectDeterministicBashWriteTargets(command);
      for (const target of included) expect(targets).toContain(target);
      for (const value of excluded) expect(targets).not.toContain(value);
    },
  );

  it('returns paths-only on unparseable input (fallback safety)', async () => {
    // `$(...)` makes AST unparseable, so the AST pass in
    // extractPathsFromCommand contributes nothing. The legacy regex pass
    // runs but its `pathPattern` doesn't match bare POSIX absolute paths
    // (`/tmp/out`) — only `./*`, `../*`, `C:\*`, `~/*`, `.x/*` forms.
    // Net result: empty array. Plan-mode treats "no targets" as
    // "could not determine target" → blocked. No silent auto-allow.
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('echo $(curl evil) > /tmp/out');
    expect(targets).toEqual([]);
  });

  it('keeps null-device targets in the set (plan-mode lets caller filter)', async () => {
    // Pre-AST regex picked up `/dev/null` too via `>>?\s*([^\s;|&]+)`.
    // AST does the same. Higher-level plan-mode code knows /dev/null is
    // safe; collectBashWriteTargets is intentionally inclusive.
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('cmd > /dev/null');
    expect(targets).toContain('/dev/null');
  });
});

describe('extractPathsFromCommand — FEATURE_152 AST hardening', () => {
  it('extracts quoted paths via AST quote-stripping', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('rm "/tmp/file with spaces.txt"');
    expect(paths).toContain('/tmp/file with spaces.txt');
  });

  it('extracts Windows drive-letter paths', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('rm C:\\Users\\foo\\bar.txt');
    expect(paths.some((p) => p.startsWith('C:\\Users'))).toBe(true);
  });

  it.each([
    ['git -C %USERPROFILE%\\.ssh status', '%USERPROFILE%\\.ssh'],
    ['git -CC:\\Users\\alice\\.ssh status', 'C:\\Users\\alice\\.ssh'],
    ['git --git-dir=/home/alice/.ssh/repo.git show HEAD', '/home/alice/.ssh/repo.git'],
    ['git --git-dir /home/alice/.ssh/repo.git show HEAD', '/home/alice/.ssh/repo.git'],
    ['git --work-tree=~/.ssh diff --stat', '~/.ssh'],
  ])('extracts Git global path options: %s', async (command, expected) => {
    const { extractPathsFromCommand } = await import('./permission.js');
    expect(extractPathsFromCommand(command)).toContain(expected);
  });

  it.each([
    ['git grep -f .env', '.env'],
    ['git grep -if%USERPROFILE%\\.ssh\\patterns', '%USERPROFILE%\\.ssh\\patterns'],
    ['git grep -if %USERPROFILE%\\.ssh\\patterns', '%USERPROFILE%\\.ssh\\patterns'],
    ['git grep --file=%USERPROFILE%\\.ssh\\patterns', '%USERPROFILE%\\.ssh\\patterns'],
    ['tree --fromfile .env', '.env'],
    ['tree --fromfile=.env', '.env'],
    ['tree --fromtabfile %USERPROFILE%\\.ssh\\patterns', '%USERPROFILE%\\.ssh\\patterns'],
    [
      'git config --file=%USERPROFILE%\\.aws\\credentials --list',
      '%USERPROFILE%\\.aws\\credentials',
    ],
    ['git config -f %USERPROFILE%\\.ssh\\config --get user.name', '%USERPROFILE%\\.ssh\\config'],
    ['git config get -f%USERPROFILE%\\.ssh\\config user.name', '%USERPROFILE%\\.ssh\\config'],
    ['git config --file /home/alice/.ssh/config --list', '/home/alice/.ssh/config'],
    ['git config --blob=HEAD:.env --list', 'HEAD:.env'],
    [
      'git diff --no-index %USERPROFILE%\\.ssh\\config README.md',
      '%USERPROFILE%\\.ssh\\config',
    ],
    [
      'git grep --no-index foo %USERPROFILE%\\.ssh\\config',
      '%USERPROFILE%\\.ssh\\config',
    ],
  ])('extracts Git subcommand path-valued options: %s', async (command, expected) => {
    const { extractPathsFromCommand } = await import('./permission.js');
    expect(extractPathsFromCommand(command)).toContain(expected);
  });

  it('extracts tree file-list inputs without treating intervening option values as paths', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand(
      'tree --fromfile -L 2 --charset utf-8 README.md .env',
    );
    expect(paths).toEqual(expect.arrayContaining(['README.md', '.env']));
    expect(paths).not.toEqual(expect.arrayContaining(['-L', '2', '--charset', 'utf-8']));
  });

  it.each([
    ['git diff -- .env*', '.env*'],
    ['git diff -- .en[v]', '.en[v]'],
    ['git diff -- .env{,.local}', '.env{,.local}'],
    ['git grep token -- .e?v', '.e?v'],
    ['rg token .en[v]', '.en[v]'],
  ])('extracts dynamic path operands for sensitive-read review: %s', async (command, expected) => {
    const { extractPathsFromCommand } = await import('./permission.js');
    expect(extractPathsFromCommand(command)).toContain(expected);
  });

  it('extracts redirect targets too', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('echo hi > /tmp/out.log');
    expect(paths).toContain('/tmp/out.log');
  });

  it('does NOT pick up flag tokens as paths', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('grep -rn pattern /etc/');
    expect(paths).not.toContain('-rn');
    expect(paths).toContain('/etc/');
  });

  it('returns empty array for unparseable input', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('echo `rm -rf /`');
    expect(paths).toEqual([]);
  });

  it('does not treat quoted Python source as a file path', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand(
      'python -c "import sys; print(sys.executable); print(sys.version)"',
    );
    expect(paths).toEqual([]);
  });

  it('does not recover path-looking literals nested inside inline source', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand(
      `python -c "import re; print('/outside/file.txt'); re.search(r'../secret', 'x')"`,
    );
    expect(paths).toEqual([]);
  });

  it('does not treat a quoted search expression as a file path', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('findstr /R "v[0-9]" file.txt');
    expect(paths).not.toContain('v[0-9]');
  });

  it('does not treat a slash-prefixed regex argument as an absolute path', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand(
      'rg "/api/v[0-9]+/" "C:\\outside project\\request.log"',
    );
    expect(paths).not.toContain('/api/v[0-9]+/');
    expect(paths).toContain('C:\\outside project\\request.log');
  });

  it('does not treat slash-prefixed inline Python source as an absolute path', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('python -c "/api/v[0-9]+/"');
    expect(paths).not.toContain('/api/v[0-9]+/');
  });

  it('masks raw Windows paths in regex source while retaining identical file operands', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const sourceOnly = extractPathsFromCommand('rg -e C:\\outside\\request.log');
    const sourceAndFile = extractPathsFromCommand(
      'rg -e C:\\outside\\request.log C:\\outside\\request.log',
    );
    expect(sourceOnly).not.toContain('C:\\outside\\request.log');
    expect(sourceAndFile).toContain('C:\\outside\\request.log');
    expect(
      extractPathsFromCommand('printf \u{1F600} | python -c "print(\'C:\\outside\\request.log\')"'),
    ).not.toContain('C:\\outside\\request.log');
  });

  it('keeps attached findstr pattern files as raw Windows paths', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand(
      'findstr /G:C:\\outside\\patterns.txt C:\\outside\\input.txt',
    );
    expect(paths).toEqual(expect.arrayContaining([
      'C:\\outside\\patterns.txt',
      'C:\\outside\\input.txt',
    ]));
    expect(paths.some((candidate) => candidate.startsWith('/G:'))).toBe(false);
  });

  it('keeps regex source files as paths while skipping inline expressions', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand(
      'rg -f "/outside/patterns.txt" "/outside/request.log"',
    );
    expect(paths).toContain('/outside/patterns.txt');
    expect(paths).toContain('/outside/request.log');
  });

  it.each([
    ['rg -e/api/v[0-9]+/ "/outside/request.log"', ['/outside/request.log']],
    ['grep --regexp=needle "/outside/request.log"', ['/outside/request.log']],
    ['sed -es/value/replacement/ "/outside/input.txt"', ['/outside/input.txt']],
    ['awk -f/outside/program.awk "/outside/input.txt"', ['/outside/program.awk', '/outside/input.txt']],
    ['rg --file=/outside/patterns.txt "/outside/input.txt"', ['/outside/patterns.txt', '/outside/input.txt']],
  ])('decodes attached source options without discarding file operands: %s', async (command, expected) => {
    const { extractPathsFromCommand } = await import('./permission.js');
    expect(extractPathsFromCommand(command)).toEqual(expect.arrayContaining(expected));
  });

  it.each([
    [
      'awk -v "endpoint=/api/v1" "{ print $1 }" "/outside/input.txt"',
      ['endpoint=/api/v1', '{ print $1 }'],
    ],
    [
      'grep --include "*.ts" "/api/v[0-9]+/" "/outside/input.txt"',
      ['*.ts', '/api/v[0-9]+/'],
    ],
    [
      'Select-String -InputObject "/api/v1" -Pattern "needle"',
      ['/api/v1', 'needle'],
    ],
  ])('does not promote regex option values or expressions to paths: %s', async (command, excluded) => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand(command);
    for (const value of excluded) expect(paths).not.toContain(value);
  });

  it.each([
    ['rg --ignore-file "/outside/ignore" needle "/outside/input.txt"', ['/outside/ignore', '/outside/input.txt']],
    ['grep --exclude-from=/outside/excludes needle "/outside/input.txt"', ['/outside/excludes', '/outside/input.txt']],
    ['Select-String -Pattern needle -Path "/outside/input.txt"', ['/outside/input.txt']],
  ])('keeps path-valued regex options as paths: %s', async (command, expected) => {
    const { extractPathsFromCommand } = await import('./permission.js');
    expect(extractPathsFromCommand(command)).toEqual(expect.arrayContaining(expected));
  });

  it.each([
    ["Select-String -EA Ignore '.env' README.md", ['README.md'], ['.env', 'Ignore']],
    ["Select-String -Context 1,2 '.env' README.md", ['README.md'], ['.env', '1,2']],
    ["Select-String -Encoding UTF8 '.env' README.md", ['README.md'], ['.env', 'UTF8']],
    ["Select-String -InputObject README.md '.env'", [], ['.env', 'README.md']],
  ])('keeps Select-String non-path values out of extracted paths: %s', async (
    command,
    expected,
    excluded,
  ) => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand(command);
    expect(paths).toEqual(expect.arrayContaining(expected));
    for (const value of excluded) expect(paths).not.toContain(value);
  });

  it.each([
    'Select-String token .env',
    'Select-String -EA Ignore token .env',
    'Select-String -Context 1,2 token .env',
    'sls -Encoding UTF8 token .env',
    'Select-String -Pattern token -PSPath:.env',
  ])('retains the actual Select-String path after parameter binding: %s', async (command) => {
    const { extractPathsFromCommand } = await import('./permission.js');
    expect(extractPathsFromCommand(command)).toContain('.env');
  });

  it('resolves ordinary-prefix traversal candidates after argument classification', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    expect(extractPathsFromCommand('cat "subdir/../../outside.txt"')).toContain(
      'subdir/../../outside.txt',
    );
  });

  it('keeps quoted path-shaped values with spaces', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('python "C:\\outside project\\inspect.py"');
    expect(paths).toContain('C:\\outside project\\inspect.py');
  });

  it('does not report quoted Python source as protected when daemon cwd differs', () => {
    const projectRoot = createProjectRoot();
    expect(
      isCommandOnProtectedPath(
        'python -c "import sys; print(sys.executable); print(sys.version)"',
        projectRoot,
      ),
    ).toBe(false);
  });
});

// FEATURE_152 slice 4 (v0.7.38): attack-surface hardening. The pre-AST regex
// chain had documented blind spots around quoting, comments, and operator
// fusion that the AST migration closed. These tests pin closed-state
// behavior so future regressions are caught.
describe('isBashReadCommand — FEATURE_152 attack-surface hardening', () => {
  it('rejects nested command substitution `$(echo $(rm))`', () => {
    expect(isBashReadCommand('echo $(echo $(rm -rf /))')).toBe(false);
  });

  it('rejects backticks inside quoted strings', () => {
    // Backticks inside double-quoted strings still expand in bash. AST
    // pre-tokenisation guard catches this regardless of quoting.
    expect(isBashReadCommand('echo "test `whoami`"')).toBe(false);
  });

  it('rejects append-redirect to real files', () => {
    expect(isBashReadCommand('grep foo file >> log.txt')).toBe(false);
  });

  it('rejects fd-redirect to real files', () => {
    expect(isBashReadCommand('grep foo file 2>err.log')).toBe(false);
  });

  it('retains an attached findstr file list for diagnostics', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    expect(extractPathsFromCommand(
      'findstr /F:C:\\outside\\files.txt token',
    )).toContain('C:\\outside\\files.txt');
  });

  it('allows descriptor duplication/close but rejects `>&` file targets', () => {
    expect(isBashReadCommand('rg --version 2>&1')).toBe(true);
    expect(isBashReadCommand('rg --version 3>&-')).toBe(true);
    expect(isBashReadCommand('rg --version 2>&errors.log')).toBe(false);
    expect(isBashReadCommand('rg --version >&output.log')).toBe(false);
  });

  it('treats `&>` real file redirect as not-read', () => {
    expect(isBashReadCommand('cmd &> output.log')).toBe(false);
  });

  it('rejects herestring `<<<`', () => {
    // Herestring is an input redirect form; rejected as input.
    expect(isBashReadCommand('cat <<< "string"')).toBe(false);
  });

  it('preserves Issue 129 reproduction command exactly', () => {
    expect(
      isBashReadCommand(
        'cd C:\\Works\\claudecode && findstr /S /I /N "todos" src\\bootstrap\\state.ts 2>NUL | findstr /V "node_modules"',
      ),
    ).toBe(true);
  });
});

describe('isBashWriteCommand — FEATURE_152 attack-surface hardening', () => {
  it('flags rm even buried inside a compound', () => {
    // `cmd && rm foo` — rm is argv[0] of stage 2 of statement 2.
    expect(isBashWriteCommand('echo hi && rm foo.txt')).toBe(true);
  });

  it('flags pipeline-downstream rm', () => {
    // `cat foo | rm bar` — rm is argv[0] of stage 2 even though pipeline
    // semantically doesn't reach rm. AST treats every stage uniformly,
    // which is conservative + correct.
    expect(isBashWriteCommand('cat foo | rm bar')).toBe(true);
  });

  it('does NOT flag rm-as-argument (`man rm`)', () => {
    // Pre-AST regex `(^|[|&;><])rm(\s|$)` would NOT match here either
    // (rm is preceded by a space, not a separator). AST sees argv[0]=man.
    // Pin the behavior either way.
    expect(isBashWriteCommand('man rm')).toBe(false);
  });

  it('does NOT flag write verb inside double-quoted argument', () => {
    expect(isBashWriteCommand('echo "I will rm everything"')).toBe(false);
  });

  it('does NOT flag write verb inside single-quoted argument', () => {
    expect(isBashWriteCommand("echo 'rm bar'")).toBe(false);
  });

  it('flags Remove-Item appearing as stage 2 of a pipeline', () => {
    // PowerShell pipeline form. Remove-Item is in POWERSHELL_WRITE_TOKENS.
    expect(isBashWriteCommand('Get-ChildItem | Remove-Item')).toBe(true);
  });

  it('flags Out-File even when invoked with -FilePath instead of -Path', () => {
    // -FilePath is bound by the command-specific Out-File parameter model.
    // The write-detection itself only needs argv[0] match → still flags.
    expect(isBashWriteCommand('Get-Content foo | Out-File -FilePath bar.txt')).toBe(true);
  });

  it('does NOT flag path-qualified custom executables (`~/myrm foo`) — known gap, delegated to LLM classifier', () => {
    // Documents an acknowledged limitation: BASH_WRITE_COMMANDS is keyed on
    // bare verb names (`rm`, `git commit`, etc.). A path-qualified executable
    // (`~/myrm`, `./scripts/delete-everything.sh`, `/usr/local/bin/myrm`) is
    // not recognised as a write at this layer.
    //
    // Why this is acceptable: KodaX is a single-user CLI (trust boundary
    // user↔agent), the agent generates command text programmatically, and
    // the FEATURE_092 auto-mode LLM classifier is the upstream gate that
    // sees the full command string with semantic context. This rule-layer
    // function is "known write patterns", not "anything that could write".
    //
    // If this becomes a real issue (3+ user reports of path-qualified write
    // tools sneaking past), revisit by adding `path.basename(argv[0])` to
    // the BASH_WRITE_COMMANDS lookup. Don't add ad-hoc patches before then.
    expect(isBashWriteCommand('~/myrm foo')).toBe(false);
    expect(isBashWriteCommand('./scripts/delete-everything.sh')).toBe(false);
    expect(isBashWriteCommand('/usr/local/bin/myrm bar')).toBe(false);
  });
});

// FEATURE_154: universal `--help` fast-path (parity with Claude Code
// `commands.ts:isHelpCommand`). Pre-FEATURE_154 KodaX only allowed `--help`
// for ~12 hard-coded language tools; this generalises to any command name
// to bypass the LLM classifier on unconditionally safe help queries.
describe('isHelpCommand — universal --help fast-path (FEATURE_154)', () => {
  it('accepts simple `cmd --help` for arbitrary commands', () => {
    expect(isHelpCommand('python --help')).toBe(true);
    expect(isHelpCommand('node --help')).toBe(true);
    expect(isHelpCommand('docker --help')).toBe(true);
    expect(isHelpCommand('kubectl --help')).toBe(true);
    expect(isHelpCommand('terraform --help')).toBe(true);
  });

  it('accepts `cmd subcmd ... --help` patterns with multiple alphanumeric tokens', () => {
    expect(isHelpCommand('git log --help')).toBe(true);
    expect(isHelpCommand('npm run --help')).toBe(true);
    expect(isHelpCommand('docker container ls --help')).toBe(true);
    expect(isHelpCommand('kubectl get pods --help')).toBe(true);
  });

  it('handles surrounding and inter-token whitespace', () => {
    expect(isHelpCommand('  python --help  ')).toBe(true);
    expect(isHelpCommand('python  --help')).toBe(true);
    expect(isHelpCommand('\tpython\t--help\n')).toBe(true);
  });

  it('rejects commands containing quotes (potential injection bypass)', () => {
    expect(isHelpCommand("python -c 'evil()' --help")).toBe(false);
    expect(isHelpCommand('node -e "evil" --help')).toBe(false);
    expect(isHelpCommand('echo "hi" --help')).toBe(false);
  });

  it('rejects flags other than --help', () => {
    expect(isHelpCommand('python --help --version')).toBe(false);
    expect(isHelpCommand('python -c script --help')).toBe(false);
    expect(isHelpCommand('node --no-warnings --help')).toBe(false);
    expect(isHelpCommand('git -C /repo log --help')).toBe(false);
  });

  it('rejects non-alphanumeric non-flag tokens (paths, dotted, env vars, shell ops)', () => {
    expect(isHelpCommand('./bin/foo --help')).toBe(false);
    expect(isHelpCommand('/usr/bin/python --help')).toBe(false);
    expect(isHelpCommand('python script.js --help')).toBe(false);
    expect(isHelpCommand('foo $VAR --help')).toBe(false);
    expect(isHelpCommand('foo bar* --help')).toBe(false);
    expect(isHelpCommand('python --help && rm')).toBe(false);
  });

  it('rejects commands not ending with --help', () => {
    expect(isHelpCommand('python -h')).toBe(false);
    expect(isHelpCommand('python --version')).toBe(false);
    expect(isHelpCommand('python --help && ls')).toBe(false);
    expect(isHelpCommand('python --help | grep usage')).toBe(false);
    expect(isHelpCommand('--help python')).toBe(false);
  });

  it('rejects empty / whitespace-only input', () => {
    expect(isHelpCommand('')).toBe(false);
    expect(isHelpCommand('   ')).toBe(false);
    expect(isHelpCommand('--help')).toBe(true); // bare `--help` allowed (matches CC)
  });

  it('does not use help syntax as proof that an arbitrary executable is safe', () => {
    expect(isBashReadCommand('docker --help')).toBe(false);
    expect(isBashReadCommand('kubectl --help')).toBe(false);
    expect(isBashReadCommand('terraform --help')).toBe(false);
    expect(isBashReadCommand('git status --help')).toBe(false);
  });

  it('routes runtime-starting help commands through semantic review', () => {
    expect(isBashReadCommand('python --help')).toBe(false);
    expect(isBashReadCommand('node --help')).toBe(false);
    expect(isBashReadCommand('npm --help')).toBe(true);
  });

  it('preserves language-tools script-execution blocking (no regression)', () => {
    // Whitelisted toolchains accept only version/help flags; non-whitelisted
    // runtimes continue to fail closed before this branch.
    expect(isBashReadCommand('node script.js')).toBe(false);
    expect(isBashReadCommand('npm install foo')).toBe(false);
    expect(isBashReadCommand('python -c "print(1)"')).toBe(false);
  });
});

// ============== FEATURE_153 isToolCallAllowed ==============
//
// Asserts the LLM-extractor path: allowlist patterns are matched against the
// extracted SAFE PREFIX (exact equality), not the raw command via startsWith.
// The extractor is stubbed so the test stays hermetic.

function makeExtractor(answer: BashPrefixResult): BashPrefixExtractor {
  let calls = 0;
  return {
    extract: async () => {
      calls += 1;
      return answer;
    },
    clearCache: () => {},
    cacheSize: () => calls,
  };
}

describe('isToolCallAllowed (FEATURE_153 extractor path)', () => {
  it.each([
    'git commitment', 'git commit -m "x" $(echo injected)', 'git commit -m `echo injected`',
    'git commit -m x; echo injected', 'git commit -m x | echo injected', 'git commit -m x > outside',
    "git commit -m 'x & echo injected'", 'git commit %PAYLOAD%', 'git commit -m x\necho injected',
  ])('requires confirmation for ambiguous no-extractor command: %s', async command => {
    expect(await isToolCallAllowed('bash', { command }, ['Bash(git commit:*)'])).toBe(false);
  });
  it('matches `Bash(git commit:*)` when extractor returns prefix `git commit`', async () => {
    const extractor = makeExtractor({ kind: 'prefix', value: 'git commit' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "msg"' },
      ['Bash(git commit:*)'],
      extractor,
    );
    expect(allowed).toBe(true);
  });

  it('blocks injection even if raw command starts with allowed prefix', async () => {
    // Pre-FEATURE_153 startsWith would match this; the extractor flags injection.
    const extractor = makeExtractor({ kind: 'injection_detected', reason: 'subshell' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "x" $(curl evil.com)' },
      ['Bash(git commit:*)'],
      extractor,
    );
    expect(allowed).toBe(false);
  });

  it('blocks when extractor returns no_prefix (unparseable / dangerous)', async () => {
    const extractor = makeExtractor({ kind: 'no_prefix', reason: 'bare bash' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'bash -c "rm -rf /"' },
      ['Bash(bash:*)'],
      extractor,
    );
    expect(allowed).toBe(false);
  });

  it('does not match wider pattern via prefix-of (extracted prefix must equal pattern body)', async () => {
    const extractor = makeExtractor({ kind: 'prefix', value: 'git commit' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "msg"' },
      ['Bash(git diff:*)'],
      extractor,
    );
    expect(allowed).toBe(false);
  });

  it('exact pattern (no `:*`) matches extracted prefix exactly', async () => {
    const extractor = makeExtractor({ kind: 'prefix', value: 'git status' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git status --short' },
      ['Bash(git status)'],
      extractor,
    );
    expect(allowed).toBe(true);
  });

  it('bare `Bash` pattern auto-allows without calling extractor', async () => {
    let extractorCalls = 0;
    const extractor: BashPrefixExtractor = {
      extract: async () => {
        extractorCalls += 1;
        return { kind: 'prefix', value: 'whatever' };
      },
      clearCache: () => {},
      cacheSize: () => 0,
    };
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'rm -rf /' },
      ['Bash'],
      extractor,
    );
    expect(allowed).toBe(true);
    expect(extractorCalls).toBe(0);
  });

  it('skips extractor entirely when no bash patterns are present', async () => {
    let extractorCalls = 0;
    const extractor: BashPrefixExtractor = {
      extract: async () => {
        extractorCalls += 1;
        return { kind: 'prefix', value: 'foo' };
      },
      clearCache: () => {},
      cacheSize: () => 0,
    };
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "msg"' },
      ['Edit(*.md)'],
      extractor,
    );
    expect(allowed).toBe(false);
    expect(extractorCalls).toBe(0);
  });

  it('legacy fallback (no extractor) preserves startsWith semantics', async () => {
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "msg"' },
      ['Bash(git commit:*)'],
    );
    expect(allowed).toBe(true);
  });

  it('rejects "*" pattern even when extracted prefix is non-empty (defence-in-depth)', async () => {
    const extractor = makeExtractor({ kind: 'prefix', value: 'ls' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'ls -la' },
      ['Bash(*)'],
      extractor,
    );
    expect(allowed).toBe(false);
  });

  it('fails closed on extractor throw (timeout / network / abort) — falls through to confirmation', async () => {
    // The extractor module throws on transient failures so its LRU cache
    // can evict the failed slot. isToolCallAllowed must catch and return
    // false so the caller falls through to the user confirmation prompt
    // instead of letting the rejection bubble into the tool-exec loop.
    const throwingExtractor: BashPrefixExtractor = {
      extract: async () => {
        throw new Error('extractCommandPrefix timeout (8000ms)');
      },
      clearCache: () => {},
      cacheSize: () => 0,
    };
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "msg"' },
      ['Bash(git commit:*)'],
      throwingExtractor,
    );
    expect(allowed).toBe(false);
  });
});

// ============== FEATURE_158 — Issue 131 structural fix ==============
//
// Issue 131: Windows cmd.exe flag tokens like `/R`, `/B`, `/Y`, `/A:H`
// were misclassified by looksLikePath as POSIX absolute paths,
// causing path.resolve('/R') → 'C:\R' (an outside-project, non-temp
// path) which triggered isAlwaysConfirmPath → "Protected path" confirm.
//
// Fix: process.platform === 'win32' branch in looksLikePath rejects
// tokens shaped `/[A-Za-z][A-Za-z0-9]*(:[A-Za-z0-9]+)?` with no further
// `/` or `\` separators. POSIX behavior unchanged.
//
// Also: expanded BASH_SAFE_READ_COMMANDS with `git tag` / `git stash list`
// / `git describe` / `git config --get` so the original repro
// (`git tag --sort=-creatordate | findstr /R "v[0-9]"`) takes the
// bash-read fast-path instead of any later guardrail step.

describe('FEATURE_158 — Issue 131 Windows-flag false-positive regression', () => {
  it.runIf(process.platform === 'win32')(
    'does NOT extract `/R` as a path on Windows (findstr flag)',
    async () => {
      const { extractPathsFromCommand } = await import('./permission.js');
      const paths = extractPathsFromCommand('findstr /R "v[0-9]" file.txt');
      expect(paths).not.toContain('/R');
    },
  );

  it.runIf(process.platform === 'win32').each([
    ['dir /B', '/B'],
    ['xcopy src dst /Y', '/Y'],
    ['where /R . node.exe', '/R'],
    ['fc /B a.bin b.bin', '/B'],
    ['robocopy src dst /MIR', '/MIR'],
    ['findstr /A:H pattern file', '/A:H'],
    ['findstr /I /S "needle" *.ts', '/I'],
  ])('does NOT extract flag-shape token from %s', async (cmd, flag) => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand(cmd);
    expect(paths).not.toContain(flag);
  });

  it.runIf(process.platform === 'win32')(
    'still extracts real POSIX-style paths even on Windows (e.g. `/etc/hosts`)',
    async () => {
      const { extractPathsFromCommand } = await import('./permission.js');
      // Real path with further separators after leading `/` — not a flag shape.
      const paths = extractPathsFromCommand('grep -r pattern /etc/hosts');
      expect(paths).toContain('/etc/hosts');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'POSIX behavior unchanged: `/R` still treated as path on Linux/macOS',
    async () => {
      const { extractPathsFromCommand } = await import('./permission.js');
      // On POSIX, `/R` is a valid (if unusual) absolute path token.
      // Behavior must remain identical to pre-FEATURE_158.
      const paths = extractPathsFromCommand('findstr /R "v[0-9]" file.txt');
      expect(paths).toContain('/R');
    },
  );

  it.runIf(process.platform === 'win32')(
    'isCommandOnProtectedPath returns false for the original Issue 131 repro (when cwd === projectRoot)',
    async () => {
      // The original Issue 131 reproduction runs from the user's project
      // root, so the relative token `v[0-9]` (extracted from quoted
      // `"v[0-9]"` by legacyRegexPathScan) resolves INSIDE the project
      // root via path.resolve. With the looksLikePath /R fix, the only
      // remaining candidate is the quoted regex pattern — which is in
      // project and therefore not protected.
      const root = process.cwd();
      const cmd = 'git tag --sort=-creatordate | findstr /R "v[0-9]"';
      expect(isCommandOnProtectedPath(cmd, root)).toBe(false);
    },
  );

  it.runIf(process.platform === 'win32')(
    'isCommandOnProtectedPath: `/R` alone (the headline bug) no longer triggers',
    async () => {
      // Strip the quoted regex pattern that legacyRegexPathScan over-eagerly
      // captures; this verifies the actual looksLikePath fix in isolation.
      const root = process.cwd();
      const cmd = 'findstr /R needle file.txt';
      expect(isCommandOnProtectedPath(cmd, root)).toBe(false);
    },
  );
});

describe('FEATURE_158 — BASH_SAFE_READ_COMMANDS expansion', () => {
  it.each([
    ['git tag', true],
    ['git tag --sort=-creatordate', true],
    ['git stash list', true],
    ['git stash list --pretty=format:%gd', true],
    ['git describe', true],
    ['git describe --tags HEAD', true],
    ['git config --get user.email', true],
    ['git config --get-all user.email', true],
    ['git stash pop', false], // write
    ['git stash push', false], // write
    ['git config user.email "x@y"', false], // bare git config is write-capable
    ['git tag -a v1.0 -m msg', false],
  ])('isBashReadCommand("%s") = %s', (cmd, expected) => {
    // Parse Git subcommands after global options so read variants can take
    // the fast path without misclassifying tag/branch mutations as reads.
    expect(isBashReadCommand(cmd)).toBe(expected);
  });

  it('git tag piped to findstr (Issue 131 user-reported command) takes bash-read fast-path', () => {
    // This is the exact command from the user-reported regression.
    // Result: fast-path bypass — no guardrail step ever runs.
    expect(isBashReadCommand('git tag --sort=-creatordate | findstr /R "v[0-9]"')).toBe(true);
  });

  it.each([
    ['where.exe rg', true],
    ['where rg', false],
    ['where { $_.Name -eq README }', true],
    ['where { Remove-Item ../outside.txt }', false],
    ['Get-ChildItem | where { Set-Content ../outside.txt x }', false],
    ['less README.md', false],
    ['less -o ../outside.log README.md', false],
    ['less -O../outside.log README.md', false],
    ['less --log-file=../outside.log README.md', false],
    ['less --LOG-FILE ../outside.log README.md', false],
    ['less -Xo ../outside.log README.md', false],
    ['less -Xo../outside.log README.md', false],
    ['less --log-f=../outside.log README.md', false],
    ['less -Pprompt README.md', false],
    ['tree .', true],
    ['tree -o ../outside.txt .', false],
    ['tree -o../outside.txt .', false],
    ['tree --output=../outside.txt .', false],
    ['tree -dfo ../outside.txt .', false],
    ['tree -dfo../outside.txt .', false],
    ['tree --out=../outside.txt .', false],
    ['tree -Pfoo .', true],
    ['date', true],
    ['date /T', true],
    ['date +%F', true],
    ['date -d tomorrow', true],
    ['date -s 2026-08-03', false],
    ['date --set=2026-08-03', false],
    ['date 08-03-2026', false],
  ])('validates effectful flags and shell aliases for "%s": %s', (command, expected) => {
    expect(isBashReadCommand(command)).toBe(expected);
  });
});
