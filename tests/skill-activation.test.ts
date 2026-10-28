import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Runner, SkillRegistry } from '@kodax-ai/agent';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXToolDefinition,
  type KodaXStreamResult, type KodaXProviderStreamOptions } from '@kodax-ai/llm';
import { runKodaX } from '../packages/coding/src/agent.js';
import { runManagedTask } from '../packages/coding/src/task-engine.js';
import { createDefaultCodingAgent } from '../packages/coding/src/coding-preset.js';
import type { KodaXOptions } from '../packages/coding/src/types.js';

const roots: string[] = [];
let providerNumber = 0;
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-e2e-'));
  roots.push(root);
  const skillDir = path.join(root, '.kodax', 'skills', 'audit-project');
  const child = path.join(root, 'src');
  await mkdir(skillDir, { recursive: true });
  await mkdir(child);
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: audit-project\ndescription: Inspect project code\nallowed-tools: Read\n---\nInspect source before answering.\n');
  return { root, child, skillDir, context: { configHome: path.join(root, 'home'), gitRoot: root,
    executionCwd: root, repoIntelligenceMode: 'off' as const } };
}

type Action = { name: string; input: Record<string, unknown> };
function scriptedProvider(actions: readonly (Action | readonly Action[])[], beforeRequest?: (index: number) => Promise<void>) {
  const name = `skill-fixture-${++providerNumber}`;
  let cursor = 0;
  const requests: { system: string; tools: string[]; model?: string }[] = [];
  vi.stubEnv('KODAX_SKILL_TEST_KEY', 'offline-fixture');
  class Provider extends KodaXBaseProvider {
    readonly name = name;
    readonly config = { name, model: 'fixture', apiKeyEnv: 'KODAX_SKILL_TEST_KEY' };
    async stream(_messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string,
      _reasoning?: Parameters<KodaXBaseProvider['stream']>[3], streamOptions?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
      await beforeRequest?.(cursor);
      requests.push({ system, tools: tools.map(tool => tool.name), model: streamOptions?.modelOverride });
      const action = actions[cursor++];
      const batch: readonly Action[] = action === undefined ? [] : 'name' in action ? [action] : action;
      return { textBlocks: action ? [] : [{ type: 'text', text: 'Done.' }], thinkingBlocks: [],
        toolBlocks: batch.map((call, index) => ({ type: 'tool_use', id: `action-${cursor}-${index}`, ...call })),
        stopReason: action ? 'tool_use' : 'end_turn' };
    }
  }
  registerModelProvider(name, () => new Provider());
  return { provider: name, requests };
}

it('SDK discovers and loads a repository Skill from a subdirectory', async () => {
  const f = await fixture();
  const provider = scriptedProvider([{ name: 'skill', input: { skill: 'audit-project' } }]);
  const results: string[] = [];
  await runKodaX({ provider: provider.provider, maxIter: 3, reasoningMode: 'off',
    context: { ...f.context, executionCwd: f.child },
    events: { onToolResult: result => { results.push(result.content); } } }, 'Inspect project code.');
  expect(provider.requests[0]?.system).toContain('- audit-project:');
  expect(results.join('\n')).toContain('Inspect source before answering.');
});

it.each(['explicit', 'model'] as const)('public Runner installs and settles the %s Skill policy', async activation => {
  const f = await fixture();
  const marker = path.join(f.root, 'raw-runner-stop.txt');
  const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'settled')`;
  const command = `node -e "eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString())"`;
  await writeFile(path.join(f.skillDir, 'SKILL.md'), `---\nname: audit-project\ndescription: Inspect project code\nallowed-tools: "Read, Bash"\nhooks:\n  Stop:\n    - command: ${JSON.stringify(command)}\n---\nInspect source before answering.\n`);
  const registry = new SkillRegistry(f.root, { userPaths: [], pluginPaths: [], builtinPath: path.join(f.root, 'none') });
  await registry.discover();
  const skill = await registry.loadFull('audit-project');
  const provider = scriptedProvider([
    ...(activation === 'model' ? [{ name: 'skill', input: { skill: skill.name } }] : []),
    { name: 'glob', input: { pattern: '**/SKILL.md' } },
  ]);
  const results: string[] = [];
  const completed = vi.fn(() => existsSync(marker));
  const presetOptions: KodaXOptions = { provider: provider.provider, maxIter: 4, reasoningMode: 'off',
    context: { ...f.context, skillRegistry: registry, skillsPrompt: registry.getSystemPromptSnippet(),
      ...(activation === 'explicit' ? { skillInvocation: { name: skill.name, path: skill.skillFilePath,
        expandedContent: skill.content, runtimePolicy: { enforceAtRuntime: true } } } : {}),
    }, events: { beforeToolExecute: async () => true,
      onToolResult: result => { results.push(result.content); }, onComplete: completed } };
  await Runner.run(createDefaultCodingAgent(), 'Inspect project code.', { presetOptions });
  expect(results.join('\n')).not.toContain('runtime Skill activation is unavailable');
  expect(results.join('\n')).toContain("Tool 'glob' is not allowed by audit-project");
  expect(completed).toHaveBeenCalledOnce();
  expect(completed.mock.results[0]?.value).toBe(true);
  expect(await readFile(marker, 'utf8')).toBe('settled');
});

it('rediscovery updates model loads and refuses a newly disabled Skill', async () => {
  const f = await fixture();
  const registry = new SkillRegistry(f.root, { userPaths: [], pluginPaths: [], builtinPath: path.join(f.root, 'none') });
  await registry.discover();
  await registry.loadFull('audit-project');
  const provider = scriptedProvider([
    { name: 'skill', input: { skill: 'audit-project' } },
    { name: 'skill', input: { skill: 'audit-project' } },
  ], async index => {
    if (index > 1) return;
    await writeFile(path.join(f.skillDir, 'SKILL.md'), `---\nname: audit-project\ndescription: Updated project inspection\n${index === 1 ? 'disable-model-invocation: true\n' : ''}---\nUPDATED_BODY\n`);
    await registry.discover();
  });
  const results: string[] = [];
  await runKodaX({ provider: provider.provider, maxIter: 4, reasoningMode: 'off',
    context: { ...f.context, skillRegistry: registry, skillsPrompt: registry.getSystemPromptSnippet() },
    events: { onToolResult: result => { results.push(result.content); } } }, 'Inspect project code.');
  expect(results[0]).toContain('UPDATED_BODY');
  expect(results[0]).not.toContain('Inspect source before answering.');
  expect(results[1]).toContain('model invocation disabled');
});

it.each(['skill', 'tool_call'] as const)('applies a %s activation before sibling tools in the same Provider batch', async loader => {
  const f = await fixture();
  const provider = scriptedProvider([[
    { name: 'glob', input: { pattern: '**/SKILL.md' } },
    { name: loader, input: loader === 'skill' ? { skill: 'audit-project' }
      : { name: 'skill', input: { skill: 'audit-project' } } },
  ], { name: 'glob', input: { pattern: '**/SKILL.md' } }]);
  const authorize = vi.fn(async () => true);
  const results: string[] = [];
  await runKodaX({ provider: provider.provider, maxIter: 3, reasoningMode: 'off', context: f.context,
    events: { beforeToolExecute: authorize, onToolResult: result => { results.push(result.content); } } }, 'Inspect project code.');
  expect(results.join('\n')).toContain("Tool 'glob' is not allowed by audit-project");
  expect(results[0]).toContain('deferred until after Skill loading');
  expect(authorize.mock.calls).toHaveLength(1);
});

it.each(['explicit', 'model'] as const)('settles lifecycle hooks and applies model preference for %s activation', async activation => {
  const f = await fixture();
  const marker = path.join(f.root, 'hooks.txt');
  const hook = (event: string) => {
    const source = `require('node:fs').appendFileSync(${JSON.stringify(marker)},'${event}\\n')`;
    return `node -e "eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString())"`;
  };
  await writeFile(path.join(f.skillDir, 'SKILL.md'), [
    '---', 'name: audit-project', 'description: Inspect project code', 'allowed-tools: "Read, Bash"',
    'model: selected-skill-model', 'hooks:',
    '  SessionStart:', `    - command: ${JSON.stringify(hook('start'))}`,
    '  UserPromptSubmit:', `    - command: ${JSON.stringify(hook('submit'))}`,
    '  PreToolUse:', '    - matcher: read', `      command: ${JSON.stringify(hook('before'))}`,
    '  PostToolUse:', '    - matcher: read', `      command: ${JSON.stringify(hook('after'))}`,
    '  Stop:', `    - command: ${JSON.stringify(hook('stop'))}`, '---', 'Read project code.',
  ].join('\n'));
  const registry = new SkillRegistry(f.root, { userPaths: [], pluginPaths: [], builtinPath: path.join(f.root, 'none') });
  await registry.discover();
  const skill = await registry.loadFull('audit-project');
  const provider = scriptedProvider([
    ...(activation === 'model' ? [{ name: 'skill', input: { skill: 'audit-project' } }] : []),
    ...(activation === 'model' ? [{ name: 'skill', input: { skill: 'audit-project' } }] : []),
    { name: 'read', input: { path: skill.skillFilePath } },
  ]);
  const completed = vi.fn();
  await runKodaX({ provider: provider.provider, maxIter: 4, reasoningMode: 'off', context: {
    ...f.context, skillRegistry: registry, skillsPrompt: registry.getSystemPromptSnippet(),
    ...(activation === 'explicit' ? { skillInvocation: { name: skill.name, path: skill.skillFilePath,
      expandedContent: skill.content, runtimePolicy: { enforceAtRuntime: true } } } : {}),
  }, events: { beforeToolExecute: async () => true, onComplete: completed } }, 'Inspect project code.');
  expect(await readFile(marker, 'utf8')).toBe('start\nsubmit\nbefore\nafter\nstop\n');
  expect(completed).toHaveBeenCalledOnce();
  expect(provider.requests.at(-1)?.model).toBe('selected-skill-model');
}, 60_000);

it('refuses a model fork before expanding dynamic context', async () => {
  const f = await fixture();
  await writeFile(path.join(f.skillDir, 'SKILL.md'), '---\nname: audit-project\ndescription: Inspect project code\ncontext: fork\n---\n!`node --version`\n');
  const execute = vi.fn(async () => 'expanded');
  const provider = scriptedProvider([{ name: 'skill', input: { skill: 'audit-project' } }]);
  const results: string[] = [];
  await runKodaX({ provider: provider.provider, maxIter: 3, reasoningMode: 'off', context: f.context,
    skillDynamicContext: { execute }, events: { onToolResult: result => { results.push(result.content); } } }, 'Inspect project code.');
  expect(results[0]).toContain('context: fork requires explicit invocation');
  expect(execute).not.toHaveBeenCalled();
});

it('loads multiple and repeated Skills while intersecting their action policies', async () => {
  const f = await fixture();
  const secondDir = path.join(f.root, '.kodax', 'skills', 'second-skill');
  await mkdir(secondDir);
  await writeFile(path.join(secondDir, 'SKILL.md'), '---\nname: second-skill\ndescription: Inspect more code\nallowed-tools: "Read, Glob"\n---\nSECOND_BODY\n!`node --version`\n');
  const execute = vi.fn(async () => 'SHOULD_NOT_EXECUTE');
  const provider = scriptedProvider([
    { name: 'skill', input: { skill: 'audit-project' } },
    { name: 'skill', input: { skill: 'second-skill' } },
    { name: 'skill', input: { skill: 'audit-project' } },
    { name: 'glob', input: { pattern: '**/SKILL.md' } },
  ]);
  const results: string[] = [];
  const authorize = vi.fn(async () => true);
  await runKodaX({ provider: provider.provider, maxIter: 6, reasoningMode: 'off', context: f.context,
    skillDynamicContext: { execute }, events: { beforeToolExecute: authorize,
      onToolResult: result => { results.push(result.content); } } }, 'Inspect project code.');
  expect(results[1]).toContain('SECOND_BODY');
  expect(results[1]).toContain('Dynamic context command is not allowed');
  expect(results[2]).toContain('Inspect source before answering.');
  expect(results[3]).toContain("Tool 'glob' is not allowed by audit-project");
  expect(execute).not.toHaveBeenCalled();
  expect(authorize).toHaveBeenCalledTimes(3);
});

it('checks substituted dynamic commands before invoking the Host executor', async () => {
  const f = await fixture();
  await writeFile(path.join(f.skillDir, 'SKILL.md'), '---\nname: audit-project\ndescription: Inspect project code\nallowed-tools: "Bash(node --version)"\n---\n!`node $ARGUMENTS`\n');
  const execute = vi.fn(async () => 'HOST_CONTEXT');
  const provider = scriptedProvider([
    { name: 'skill', input: { skill: 'audit-project', args: '--version' } },
    { name: 'skill', input: { skill: 'audit-project', args: '--version && echo extra' } },
  ]);
  const results: string[] = [];
  await runKodaX({ provider: provider.provider, maxIter: 4, reasoningMode: 'off', context: f.context,
    skillDynamicContext: { execute }, events: { onToolResult: result => { results.push(result.content); } } }, 'Inspect project code.');
  expect(results[0]).toContain('HOST_CONTEXT');
  expect(results[1]).toContain('Dynamic context command is not allowed');
  expect(execute).toHaveBeenCalledExactlyOnceWith('node --version', f.root);
});

it('returns Skill-specific guidance without copying the Host prompt overlay into tool output', async () => {
  const f = await fixture();
  await writeFile(path.join(f.skillDir, 'SKILL.md'), '---\nname: audit-project\ndescription: Inspect project code\nallowed-tools: Read\nagent: scoped-auditor\n---\nInspect source before answering.\n');
  const provider = scriptedProvider([{ name: 'skill', input: { skill: 'audit-project' } }]);
  const results: string[] = [];
  await runKodaX({ provider: provider.provider, maxIter: 3, reasoningMode: 'off',
    context: { ...f.context, promptOverlay: 'PRIVATE_HOST_OVERLAY' },
    events: { onToolResult: result => { results.push(result.content); } } }, 'Inspect project code.');
  expect(provider.requests[0]?.system).toContain('PRIVATE_HOST_OVERLAY');
  expect(results[0]).toContain('Preferred agent: scoped-auditor');
  expect(results[0]).not.toContain('PRIVATE_HOST_OVERLAY');
});

it('refuses a changed policy for an already active Skill instead of loading it under older permissions', async () => {
  const f = await fixture();
  const file = path.join(f.skillDir, 'SKILL.md');
  await writeFile(file, '---\nname: audit-project\ndescription: Inspect project code\nallowed-tools: "Read, Glob"\n---\nOLD_BODY\n');
  const registry = new SkillRegistry(f.root, { userPaths: [], pluginPaths: [], builtinPath: path.join(f.root, 'none') });
  await registry.discover();
  const provider = scriptedProvider([
    { name: 'skill', input: { skill: 'audit-project' } },
    { name: 'skill', input: { skill: 'audit-project' } },
  ], async index => {
    if (index !== 1) return;
    await writeFile(file, '---\nname: audit-project\ndescription: Inspect project code\nallowed-tools: Read\n---\nNEW_POLICY_BODY\n');
    await registry.discover();
  });
  const results: string[] = [];
  await runKodaX({ provider: provider.provider, maxIter: 4, reasoningMode: 'off',
    context: { ...f.context, skillRegistry: registry, skillsPrompt: registry.getSystemPromptSnippet() },
    events: { onToolResult: result => { results.push(result.content); } } }, 'Inspect project code.');
  expect(results[1]).toContain('changed after activation');
  expect(results[1]).not.toContain('NEW_POLICY_BODY');
});

it.each(['host', 'bridge', 'guardrail', 'hook', 'cancel'] as const)('defers sibling actions after %s refuses Skill activation', async refusal => {
  for (const agentMode of ['sa', 'ama'] as const) {
    const f = await fixture();
    if (refusal === 'hook') {
      await writeFile(path.join(f.skillDir, 'SKILL.md'), '---\nname: audit-project\ndescription: Inspect project code\nallowed-tools: "Read, Bash"\nhooks:\n  SessionStart:\n    - command: node --version\n---\nInspect code.\n');
    }
    const provider = scriptedProvider([[
      { name: refusal === 'bridge' ? 'tool_call' : 'skill', input: refusal === 'bridge'
        ? { name: 'skill', input: { skill: 'audit-project' } } : { skill: 'audit-project' } },
      { name: 'glob', input: { pattern: '**/SKILL.md' } },
    ]]);
    const authorize = vi.fn(async (name: string) => {
      if (refusal === 'hook' ? name === 'bash' : name === 'skill' && refusal !== 'guardrail') {
        return refusal === 'cancel' ? false : '[Blocked] Host refused activation.';
      }
      return true;
    });
    const results: string[] = [];
    await runManagedTask({ provider: provider.provider, agentMode, maxIter: 3, reasoningMode: 'off', context: f.context,
      ...(refusal === 'guardrail' ? { guardrails: [{ kind: 'tool' as const, name: 'refuse-skill',
        beforeTool: async (call: { name: string }) => call.name === 'skill'
          ? { action: 'block' as const, reason: 'Skill denied by guardrail' } : { action: 'pass' as const } }] } : {}),
      events: { beforeToolExecute: authorize, onToolResult: result => { results.push(result.content); } } }, 'Inspect project code.');
    expect(authorize.mock.calls.some(([name]) => name === 'glob')).toBe(false);
    expect(results[1]).toMatch(/Skill.*activat|cancelled/i);
  }
});

it.each(['exclude', 'policy'] as const)('SDK omits the Skill catalog when the loader is denied by %s', async reason => {
  const f = await fixture();
  const provider = scriptedProvider([]);
  await runKodaX({ provider: provider.provider, maxIter: 2, reasoningMode: 'off', context: {
    ...f.context, ...(reason === 'exclude' ? { excludeTools: ['skill'] }
      : { toolVisibilityPolicy: ({ name }: { name: string }) => name !== 'skill' }),
  } }, 'Inspect project code.');
  expect(provider.requests[0]?.tools).not.toContain('skill');
  expect(provider.requests[0]?.system).not.toContain('- audit-project:');
});

it.each(['sa', 'ama'] as const)('respects Runtime loader availability in %s execution', async agentMode => {
  const f = await fixture();
  const provider = scriptedProvider([]);
  await runManagedTask({ provider: provider.provider, agentMode, maxIter: 2, reasoningMode: 'off',
    context: f.context, extensionRuntime: {
      getDefaults: () => ({ activeTools: ['read'], modelSelection: {} }),
      getCapabilityPromptContext: async () => undefined,
    } as KodaXOptions['extensionRuntime'] }, 'Inspect project code.');
  expect(provider.requests.length).toBeGreaterThan(0);
  expect(provider.requests.every(request => !request.tools.includes('skill'))).toBe(true);
  expect(provider.requests.every(request => !request.system.includes('- audit-project:'))).toBe(true);
});

it.each(['explicit', 'model'] as const)('enforces Skill tool restrictions for %s activation and retains Host authority', async activation => {
  const f = await fixture();
  const registry = new SkillRegistry(f.root, { userPaths: [], pluginPaths: [], builtinPath: path.join(f.root, 'none') });
  await registry.discover();
  const skill = await registry.loadFull('audit-project');
  const provider = scriptedProvider([
    ...(activation === 'model' ? [{ name: 'skill', input: { skill: 'audit-project' } }] : []),
    { name: 'read', input: { path: skill.skillFilePath } },
    { name: 'glob', input: { pattern: '**/SKILL.md' } },
  ]);
  const authorize = vi.fn(async (name: string) => name === 'read' ? '[Blocked] Host denied read.' : true);
  const results: string[] = [];
  const options: KodaXOptions = { provider: provider.provider, maxIter: 5, reasoningMode: 'off', context: {
    ...f.context, skillRegistry: registry, skillsPrompt: registry.getSystemPromptSnippet(),
    ...(activation === 'explicit' ? { skillInvocation: { name: skill.name, path: skill.skillFilePath,
      expandedContent: skill.content, runtimePolicy: { enforceAtRuntime: true } } } : {}),
  }, events: { beforeToolExecute: authorize, onToolResult: result => { results.push(result.content); } } };
  await runKodaX(options, 'Inspect project code.');
  expect(results.join('\n')).toContain('[Blocked] Host denied read.');
  expect(results.join('\n')).toContain("Tool 'glob' is not allowed by audit-project");
  expect(authorize.mock.calls.some(([name]) => name === 'glob')).toBe(false);
});
