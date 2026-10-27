import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NATURAL_CASES, type NaturalCaseId } from './cases.js';

const RETURN_RESULT = `  return { readyToStart: safe, nextAction: safe ? 'start' : 'recheck', receipt };\n}\n`;
export const RECOVERY_GOLDEN = `export function recoverShutdown(receipt, observation) {
  const process = observation?.process;
  const safe = Number.isInteger(receipt?.process?.pid) && typeof receipt.process.startedAt === 'string'
    && receipt.process.startedAt.length > 0 && process?.pid === receipt.process.pid
    && process.startedAt === receipt.process.startedAt && process.state === 'exited'
    && observation.treeState === 'exited' && observation.resourcesState === 'released';
${RETURN_RESULT}`;
const RECOVERY_PARTIAL = `export function recoverShutdown(receipt, observation) {
  const safe = observation?.process?.state === 'exited'
    && observation.treeState === 'exited' && observation.resourcesState === 'released';
${RETURN_RESULT}`;
const RECOVERY_BUGGY = RECOVERY_PARTIAL.replace(
  "const safe = observation?.process?.state === 'exited'",
  "const safe = receipt.cleanup.state === 'complete' && observation?.process?.state === 'exited'",
);

export const RECOVERY_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'shutdown-recovery-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'README.md': `# Shutdown recovery SDK sample

This module is a pure decision function. It does not kill processes or remove records.
recoverShutdown(receipt, observation) returns readyToStart, nextAction, and the original receipt.
Historical taskOutcome and cleanup are evidence about the previous shutdown; they must not be rewritten.
Restart requires current evidence about the exact old process identity, its whole process tree, and released resources.
Unknown, live or unrelated evidence is insufficient. Repeated attempts do not constitute evidence.
Process identity is the pair pid + startedAt; operating systems may reuse pids.
The host supplies observations; this repository does not implement OS observation itself.

Run public tests: node --test
Run the reported restart scenario: node examples/restart.mjs
Review scope: base..HEAD and uncommitted changes. Changes after a previous review are compared against its reviewed revision.
`,
  'src/recovery.js': RECOVERY_BUGGY,
  'test/recovery.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverShutdown } from '../src/recovery.js';
const receipt = { process: { pid: 41, startedAt: 'session-a' }, taskOutcome: 'unknown', cleanup: { state: 'complete' } };
const observation = { process: { ...receipt.process, state: 'exited' }, treeState: 'exited', resourcesState: 'released' };
test('completed cleanup with verified exit permits restart', () => {
  const result = recoverShutdown(receipt, observation);
  assert.equal(result.readyToStart, true);
  assert.equal(result.nextAction, 'start');
  assert.equal(result.receipt, receipt);
});
test('a running process blocks restart', () => {
  assert.equal(recoverShutdown(receipt, { ...observation, process: { ...observation.process, state: 'running' } }).readyToStart, false);
});
`,
  'examples/restart.mjs': `import { recoverShutdown } from '../src/recovery.js';
const receipt = { process: { pid: 41, startedAt: 'session-a' }, taskOutcome: 'unknown', cleanup: { state: 'unknown' } };
const observation = { process: { ...receipt.process, state: 'exited' }, treeState: 'exited', resourcesState: 'released' };
process.stdout.write(JSON.stringify(recoverShutdown(receipt, observation)) + '\\n');
`,
};

export interface FixtureExecutionReceipt {
  source: 'actual-fixture-execution';
  command: string;
  revision: string;
  files: Record<string, string>;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PreparedNaturalCase {
  workspace: string;
  id: NaturalCaseId;
  prompt: string;
  base: string;
  head: string;
  reviewedRevision?: string;
  status: string;
  delta: string;
  priorContext: string;
  receipts: FixtureExecutionReceipt[];
}

// Git identity/dates/line endings and hook configuration are local to the fixture.
function git(workspace: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    '-c', 'core.hooksPath=.git/disabled-hooks', '-c', 'commit.gpgsign=false', ...args], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

async function capture(workspace: string, args: string[]): Promise<FixtureExecutionReceipt> {
  const files: Record<string, string> = {};
  for (const file of Object.keys(RECOVERY_FILES)) files[file] = createHash('sha256').update(await fs.readFile(path.join(workspace, file))).digest('hex');
  const result = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`Fixture command terminated by ${result.signal ?? 'unknown signal'}`);
  return { source: 'actual-fixture-execution', command: `node ${args.join(' ')}`, revision: git(workspace, 'rev-parse', 'HEAD'),
    files, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** No model calls. Only model-visible sample files go in workspace; oracle stays outside. */
export async function prepareNaturalCase(directory: string, id: NaturalCaseId): Promise<PreparedNaturalCase> {
  const definition = NATURAL_CASES.find(item => item.id === id);
  if (!definition) throw new Error(`Unknown natural case: ${id}`);
  const workspace = path.join(path.resolve(directory), 'workspace');
  await fs.mkdir(workspace); // Refuse to overwrite an existing workspace.
  for (const [file, content] of Object.entries(RECOVERY_FILES)) {
    const target = path.join(workspace, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  // The old SDK had no observation-based recovery. Do not hide the reference
  // repair in an earlier Git revision where the model could simply copy it.
  await fs.writeFile(path.join(workspace, 'src/recovery.js'),
    "export function recoverShutdown(receipt) {\n  return { readyToStart: false, nextAction: 'recheck', receipt };\n}\n");
  await fs.writeFile(path.join(workspace, 'test/recovery.test.js'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { recoverShutdown } from '../src/recovery.js';\ntest('unverified shutdown remains blocked', () => { assert.equal(recoverShutdown({cleanup:{state:'unknown'}}).readyToStart, false); });\n");
  git(workspace, 'init', '--template=', '--initial-branch=main', '--object-format=sha1');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', 'Introduce shutdown recovery decisions');
  const base = git(workspace, 'rev-parse', 'HEAD');
  git(workspace, 'tag', 'base');
  await fs.writeFile(path.join(workspace, 'src/recovery.js'), RECOVERY_BUGGY);
  await fs.writeFile(path.join(workspace, 'test/recovery.test.js'), RECOVERY_FILES['test/recovery.test.js']!);
  git(workspace, 'add', 'src/recovery.js', 'test/recovery.test.js');
  git(workspace, 'commit', '-m', 'Add observation-based shutdown recovery');
  let reviewedRevision: string | undefined;
  let priorContext = '';
  let receipts: FixtureExecutionReceipt[] = [];
  if (id === 'incremental-review') {
    reviewedRevision = git(workspace, 'rev-parse', 'HEAD');
    receipts = [await capture(workspace, ['--test']), await capture(workspace, ['examples/restart.mjs'])];
    priorContext = `以下为明确生成的隔离 fixture 执行前文，不是原项目会话或模型轨迹。\n先前请求：请评审 base..${reviewedRevision} 的 SDK 退出恢复改动。\n先前复核范围：src/recovery.js、README.md、公共测试、示例；公共测试通过，但示例在已确认退出时仍输出 readyToStart=false，旧 cleanup unknown 导致继续阻塞。尚未检查之后的修改。\n真实回执：\n${JSON.stringify(receipts, null, 2)}\n`;
    await fs.writeFile(path.join(workspace, 'src/recovery.js'), RECOVERY_PARTIAL);
    git(workspace, 'add', 'src/recovery.js');
    git(workspace, 'commit', '-m', 'Use current observations for restart readiness');
  } else if (id === 'verification-followup') {
    await fs.writeFile(path.join(workspace, 'src/recovery.js'), RECOVERY_GOLDEN);
    git(workspace, 'add', 'src/recovery.js');
    git(workspace, 'commit', '-m', 'Restore identity-checked current recovery evidence');
    receipts = [await capture(workspace, ['--test']), await capture(workspace, ['examples/restart.mjs'])];
    priorContext = `以下为明确生成的隔离 fixture 执行前文，不是原项目会话或模型轨迹。\n先前请求：修复退出恢复阻塞并验证。修复已提交，下列命令真实执行完成，之后未修改文件。公共测试只有两项，另执行了报告症状的示例。没有实测操作系统进程、真实 Host 或跨平台集成；不能据此声称所有场景均已验证。\n真实回执：\n${JSON.stringify(receipts, null, 2)}\n`;
  }
  if (id === 'review') await fs.appendFile(path.join(workspace, 'README.md'), '\nThe public sample has no external dependencies.\n');
  return { workspace, id, prompt: definition.prompt, base, head: git(workspace, 'rev-parse', 'HEAD'), reviewedRevision,
    status: git(workspace, 'status', '--porcelain'), delta: git(workspace, 'diff', reviewedRevision ?? base), priorContext, receipts };
}
