import { execFileSync } from 'node:child_process';

export function initGitRepo(workspaceRoot: string): void {
  execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'KodaX Test'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'kodax-test@example.com'], { cwd: workspaceRoot, stdio: 'ignore' });
}

export function commitAll(workspaceRoot: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message], { cwd: workspaceRoot, stdio: 'ignore' });
}
