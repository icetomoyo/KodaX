/**
 * Rendered prompt snapshots: the exact text the model receives for the
 * Worker, the builtin child and the one tool contract source every entry sends.
 *
 * A prompt edit shows up here as a readable text diff.
 * Refactors of prompt storage must leave every file unchanged.
 * Update intentionally with `npx vitest run <this file> -u` and review the diff.
 */
import { describe, expect, it } from 'vitest';
import type { Agent } from '@kodax-ai/agent';
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { createAgentActorController } from '../../../agent/src/actors/index.js';
import { buildRunnerAgentChain } from '../task-engine/_internal/managed-task/agent-chain.js';
import { buildFallbackRoutingDecision } from '../reasoning.js';
import { listToolDefinitions } from '../tools/index.js';
import { filterExcludedTools, getActiveToolDefinitions } from '../agent-runtime/tool-resolution.js';
import { CHILD_AGENT_SYSTEM_PROMPT, CHILD_EXCLUDE_TOOLS_BASE } from '../child-executor.js';
import { buildWorkerStableInstructions, buildWorkerStableSections } from '../agents/worker-role-prompt.js';
import { renderApplicationContextSections } from './prompt-spec.js';
import { createRolePrompt } from '../task-engine/_internal/managed-task/role-prompt.js';

const TASK = 'Review the relevant modules and make the requested change; preserve existing work.';
const expected = (name: string): string => `./expected/${name}`;

type Platform = 'win32' | 'linux' | undefined;

function renderTools(tools: readonly KodaXToolDefinition[]): string {
  return tools.map(({ name, description, input_schema }) => [
    `## ${name}`,
    '',
    description,
    '',
    '```json',
    JSON.stringify(input_schema, null, 2),
    '```',
  ].join('\n')).join('\n\n') + '\n';
}

async function renderWorker(platform: Platform): Promise<{ system: string; tools: string; list: readonly KodaXToolDefinition[] }> {
  const controller = await createAgentActorController({ executor: { execute: async () => ({ output: 'unused' }) } });
  try {
    const context = { backups: new Map(), actorControl: controller.bind('/root'),
      actorTurnRef: { actorPath: '/root', turnId: 'rendered-prompts' } };
    const worker: Agent = buildRunnerAgentChain(context, undefined, undefined, undefined, {
      prompt: TASK,
      decision: buildFallbackRoutingDecision(TASK),
      contextFactory: () => ({
        originalTask: TASK,
        workspace: platform ? { executionCwd: '/fixture', platform } : undefined,
      }),
    }).worker;
    const system = typeof worker.instructions === 'function'
      ? worker.instructions(undefined)
      : worker.instructions ?? '';
    return { system: system + '\n', tools: renderTools(worker.tools!), list: worker.tools! };
  } finally {
    await controller.shutdown('Rendered prompt capture finished');
  }
}

function childTools(readOnly: boolean): readonly KodaXToolDefinition[] {
  const names = filterExcludedTools(listToolDefinitions().map(tool => tool.name), [
    ...CHILD_EXCLUDE_TOOLS_BASE,
    ...(readOnly ? ['write', 'edit', 'multi_edit', 'insert_after_anchor', 'undo'] : []),
  ]);
  return getActiveToolDefinitions(names, 'off');
}

describe('rendered Worker root prompt', () => {
  it.each([
    ['linux', 'linux'],
    ['win32', 'win32'],
    ['no-platform', undefined],
  ] as const)('system, %s', async (label, platform) => {
    const rendered = await renderWorker(platform);
    await expect(rendered.system).toMatchFileSnapshot(expected(`worker.${label}.md`));
  });

  it('tool contracts', async () => {
    const rendered = await renderWorker('linux');
    await expect(rendered.tools).toMatchFileSnapshot(expected('tools.worker.md'));
  });
});

describe('rendered Worker contract for reduced tool sets', () => {
  // Hosts that hide tools get a Worker contract that only teaches what is callable.
  it.each([
    ['none', []],
    ['read-only', ['read', 'grep', 'glob', 'todo_list']],
    ['no-collaboration', ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'todo_create', 'todo_update', 'todo_list']],
    ['legacy-edit', ['read', 'write', 'multi_edit', 'bash', 'grep', 'glob', 'changed_diff_bundle', 'spawn_agent', 'wait_agent']],
  ] as const)('%s', async (label, names) => {
    await expect(buildWorkerStableInstructions(names) + '\n')
      .toMatchFileSnapshot(expected(`worker.stable.${label}.md`));
  });

  // Tags decide what an embedder can omit, so a retag needs the same review as a text change.
  it('pins the block tags for every tool set', () => {
    const tags = (names?: readonly string[]) => buildWorkerStableSections(names).map(({ id, tag }) => `${id}:${tag}`);
    expect({ all: tags(), none: tags([]), readOnly: tags(['read', 'grep', 'glob', 'todo_list']) }).toMatchInlineSnapshot(`
      {
        "all": [
          "trust-and-scope:contract",
          "task-and-plan:guidance",
          "parallel-work:capability",
          "specialist-routing:capability",
          "repo-intelligence-tools:capability",
          "execution-and-delivery:contract",
        ],
        "none": [
          "context-trust:contract",
          "parallel-work:capability",
          "plan-first:guidance",
          "scope-commitment:guidance",
          "mutation-discipline:guidance",
          "repo-intelligence-tools:capability",
          "agent-collaboration:capability",
          "execution-guidance:guidance",
          "termination:contract",
        ],
        "readOnly": [
          "context-trust:contract",
          "parallel-work:capability",
          "plan-first:guidance",
          "scope-commitment:guidance",
          "mutation-discipline:guidance",
          "repo-intelligence-tools:capability",
          "agent-collaboration:capability",
          "execution-guidance:guidance",
          "termination:contract",
        ],
      }
    `);
  });
});

describe('rendered Worker with an application prompt spec', () => {
  // An application persona drops KodaX guidance but keeps contracts, tool teaching and its own entries.
  const spec = {
    kodaxGuidance: 'omit',
    context: [
      { key: 'house-style', kind: 'rule', text: 'Answer in British English.' },
      { key: 'product-faq', kind: 'reference', text: 'Refunds take five working days.' },
    ],
  } as const;
  const sections = renderApplicationContextSections(spec);
  const join = (kind: 'rule' | 'reference') =>
    sections.filter(section => section.kind === kind).map(section => section.content).join('\n\n');
  const render = (mode: 'stable' | 'context') => createRolePrompt(
    'worker', TASK, buildFallbackRoutingDecision(TASK), undefined, undefined, 'kodax/role/worker', undefined,
    {
      originalTask: TASK,
      workspace: { executionCwd: '/fixture', platform: 'linux' },
      omitKodaxGuidance: true,
      applicationRules: join('rule'),
      applicationReferences: join('reference'),
    },
    undefined, false, mode,
  ) + '\n';

  it.each(['stable', 'context'] as const)('%s', async (mode) => {
    await expect(render(mode)).toMatchFileSnapshot(expected(`worker.omit.${mode}.md`));
  });

  // When to fan out belongs to the Agent tools: it stays while spawn_agent is offered.
  it('keeps when-to-dispatch exactly while spawn_agent is available', () => {
    const dispatch = 'With 2+ substantive independent lanes and available slots';
    const stable = render('stable');
    expect(stable).toContain('PARALLEL WORK');
    expect(stable).toContain(dispatch);
    expect(stable).toContain('Use sub-agents when parallel work would materially improve speed or quality.');
    expect(buildWorkerStableInstructions(['read', 'grep', 'spawn_agent', 'wait_agent'], true)).toContain('PARALLEL-FIRST COLLABORATION');
    const solo = buildWorkerStableInstructions(['read', 'grep'], true);
    expect(solo).toContain('Delegation is unavailable in this run');
    expect(solo).not.toContain('PARALLEL-FIRST');
  });
});

describe('rendered builtin child prompt', () => {
  // Both lanes share the canonical base; write children append project rules at run time.
  it('canonical base', async () => {
    await expect(`${CHILD_AGENT_SYSTEM_PROMPT}\n`).toMatchFileSnapshot(expected('child.canonical.md'));
  });

  it.each([['read', true], ['write', false]] as const)('%s lane sends the same tool text as the Worker', async (_lane, readOnly) => {
    const worker = (await renderWorker('linux')).list;
    const tools = childTools(readOnly);
    expect(tools.some(tool => tool.name === 'edit')).toBe(!readOnly);
    // Inventories differ by role; shared tools must carry identical text.
    const shared = tools.filter(tool => worker.some(item => item.name === tool.name));
    expect(shared.map(tool => tool.name)).toEqual(expect.arrayContaining(['read', 'grep', 'glob', 'spawn_agent', 'todo_update']));
    for (const tool of shared) {
      const expectedTool = worker.find(item => item.name === tool.name);
      expect({ description: tool.description, input_schema: tool.input_schema }, tool.name)
        .toEqual({ description: expectedTool!.description, input_schema: expectedTool!.input_schema });
    }
  });
});

describe('rendered builtin tool contracts', () => {
  it('every builtin tool', async () => {
    await expect(renderTools(listToolDefinitions())).toMatchFileSnapshot(expected('tools.builtin.md'));
  });
});
