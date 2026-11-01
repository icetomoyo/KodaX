import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { SkillRegistry } from '@kodax-ai/agent';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { runToolInvocation } from './tool-invocation.js';
import type { KodaXMessage } from '@kodax-ai/llm';
import { withHostInvocation } from './host-invocation.js';

it('restores durable history before allowing invocation hooks to execute', async () => {
  const beforeToolExecute = vi.fn(async () => '[Blocked] test authorization');
  const execute = vi.fn();
  await expect(withHostInvocation({ provider: 'unconfigured-provider',
    session: { id: 'unreadable', storage: { save: async () => {}, load: async () => { throw new Error('retained history unavailable'); } } },
    context: { commandInvocation: { name: 'inspect', source: 'extension', runtimePolicy: { enforceAtRuntime: true },
      hooks: { SessionStart: [{ command: 'must-not-execute' }] } } },
    events: { beforeToolExecute },
  }, 'inspect', execute)).rejects.toThrow('retained history unavailable');
  expect(beforeToolExecute).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it('activates a policy-bearing Skill and settles its hooks without a model request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-direct-skill-'));
  try {
    const directory = path.join(root, '.kodax', 'skills', 'inspect');
    await mkdir(directory, { recursive: true });
    const marker = path.join(root, 'hooks.txt');
    const command = (text: string) => `"${process.execPath}" -e "require('fs').appendFileSync('hooks.txt','${text}')"`;
    await writeFile(path.join(directory, 'SKILL.md'), [
      '---', 'name: inspect', 'description: Inspect evidence', 'allowed-tools: Read, Bash',
      'hooks:', '  SessionStart:', `    - command: ${JSON.stringify(command('start;'))}`,
      '  PostToolUse:', '    - matcher: skill', `      command: ${JSON.stringify(command('post;'))}`,
      '  Stop:', `    - command: ${JSON.stringify(command('stop;'))}`, '---', 'Inspect the evidence.',
    ].join('\n'));
    const registry = new SkillRegistry(root, { projectPaths: [path.dirname(directory)], userPaths: [], pluginPaths: [] });
    await registry.discover();
    const authorize = vi.fn(async () => true);
    const result = await runToolInvocation({ provider: 'unconfigured-provider',
      context: { executionCwd: root, configHome: path.join(root, 'home'), skillRegistry: registry,
        resolveShellPermissionMode: () => 'full-access', authorizeShellHostExecution: authorize },
      events: { beforeToolExecute: async () => true },
    }, { name: 'skill', input: { skill: 'inspect' } });
    expect(result).toMatchObject({ success: true, lastText: expect.stringContaining('Inspect the evidence.') });
    expect(await readFile(marker, 'utf8')).toBe('start;post;stop;');
    expect(authorize).toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});

it('preserves the Host accepted input identity and emits the canonical denied tool result', async () => {
  const accepted: KodaXMessage = { role: 'user', content: '!denied', inputId: 'input-tool', timestamp: '2026-11-01T00:00:00.000Z' };
  const onToolResult = vi.fn();
  const denied = JSON.stringify({ code: 'exec_policy_forbidden', denialSource: 'explicit_rule', retryable: false });
  const result = await runToolInvocation({ provider: 'unconfigured-provider',
    session: { id: 'tool-session', initialMessages: [accepted] },
    events: { beforeToolExecute: async () => denied, onToolResult },
  }, { name: 'bash', input: { command: 'denied' } }, '!denied');
  expect(result.messages.filter(message => message.content === '!denied')).toEqual([accepted]);
  expect(result.success).toBe(false);
  expect(onToolResult).toHaveBeenLastCalledWith(expect.objectContaining({ toolResult: expect.objectContaining({ is_error: true }) }));
});

it('executes an explicit host tool without an LLM request and retains tool permission checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-direct-tool-'));
  await writeFile(path.join(root, 'read.txt'), 'direct tool content');
  try {
    const beforeToolExecute = vi.fn(async (name: string) => name === 'write' ? '[Blocked] explicit user policy' : true);
    const options = { provider: 'unconfigured-provider', context: { executionCwd: root }, events: { beforeToolExecute } };
    await expect(runToolInvocation(options, { name: 'read', input: { path: 'read.txt' } }))
      .resolves.toMatchObject({ success: true, lastText: expect.stringContaining('direct tool content') });
    await expect(runToolInvocation(options, { name: 'write', input: { path: 'denied.txt', content: 'x' } }))
      .resolves.toMatchObject({ success: false, lastText: '[Blocked] explicit user policy' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['node -e "process.exit(7)"', 'kodax_nonexistent_command_299'])('fails closed without an admitted Shell boundary: %s', async (command) => {
  const result = await runToolInvocation({ provider: 'unconfigured-provider' }, { name: 'bash', input: { command } });
  expect(result.success).toBe(false);
});

it.each([0, 7])('preserves natural Shell exit %i when abort arrives after execution ends', async (exitCode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-completion-'));
  vi.stubEnv('KODAX_HOME', root);
  const controller = new AbortController();
  try {
    const result = await runToolInvocation({ provider: 'unconfigured-provider',
      abortSignal: controller.signal,
      context: { executionCwd: root, resolveShellPermissionMode: () => 'full-access',
        authorizeShellHostExecution: async () => true },
      events: { onToolExecutionEnd: () => controller.abort(new Error('late stop')) },
    }, { name: 'bash', input: { command: `node -e "process.exit(${exitCode})"` } });
    expect(controller.signal.aborted).toBe(true);
    expect(result.lastText).toContain(`Exit: ${exitCode}`);
    expect(result).toMatchObject({ interrupted: false, success: exitCode === 0 });
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it('keeps a Shell cancellation interrupted when no natural outcome was reported', async () => {
  const controller = new AbortController();
  const result = await runToolInvocation({ provider: 'unconfigured-provider', abortSignal: controller.signal,
    events: { beforeToolExecute: async () => { controller.abort(new Error('stop before execution')); return false; } },
  }, { name: 'bash', input: { command: 'node -e "process.exit(0)"' } });
  expect(result).toMatchObject({ interrupted: true, success: false, lastText: expect.stringContaining('[Cancelled]') });
});
