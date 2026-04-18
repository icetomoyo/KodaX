import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirSync, removeTempDirSync } from '../test-utils/temp-dir.js';
import {
  getDirectShellBypassBlockReason,
  getPlanModeBlockReason,
  isAlwaysConfirmPath,
  isCommandOnProtectedPath,
  isPlanModeAllowedPath,
} from './permission.js';

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

describe('isAlwaysConfirmPath — system temp as safe scratchpad', () => {
  it('does NOT require confirmation for paths inside the system temp directory', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-test-${Date.now()}.txt`);
    expect(isAlwaysConfirmPath(tempFile, projectRoot)).toBe(false);
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
