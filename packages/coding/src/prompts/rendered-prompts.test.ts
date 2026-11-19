/**
 * Rendered prompt snapshots: the exact text the model receives for the
 * Worker (canonical and compact), the builtin child and the tool contracts.
 *
 * A prompt edit shows up here as a readable text diff, and the canonical and
 * compact files sit side by side so one cannot drift from the other unseen.
 * Refactors of prompt storage must leave every file unchanged.
 * Update intentionally with `npx vitest run <this file> -u` and review the diff.
 */
import { describe, expect, it } from 'vitest';
import type { Agent } from '@kodax-ai/agent';
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { createAgentActorController } from '../../../agent/src/actors/index.js';
import { buildRunnerAgentChain } from '../task-engine/_internal/managed-task/agent-chain.js';
import { buildFallbackRoutingDecision } from '../reasoning.js';
import { markOrdinaryRootToolContract, projectManagedToolContracts } from '../tools/managed-tool-contract.js';
import { listToolDefinitions } from '../tools/index.js';
import { filterExcludedTools, getActiveToolDefinitions } from '../agent-runtime/tool-resolution.js';
import { CHILD_AGENT_SYSTEM_PROMPT, CHILD_EXCLUDE_TOOLS_BASE } from '../child-executor.js';
import { buildWorkerStableInstructions, buildWorkerStableSections } from '../agents/worker-role-prompt.js';
import { projectManagedSystemContract } from './managed-system-contract.js';
import { buildCompactChildContractCandidate } from './compact-child-contract.js';

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

async function renderWorker(platform: Platform): Promise<{ canonical: string; compact: string; tools: string }> {
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
    const canonical = typeof worker.instructions === 'function'
      ? worker.instructions(undefined)
      : worker.instructions ?? '';
    markOrdinaryRootToolContract(worker);
    const tools = projectManagedToolContracts(worker, worker.tools!);
    const compact = projectManagedSystemContract(worker, tools, canonical);
    expect(compact, 'the fixture must take the compact projection').not.toBe(canonical);
    return { canonical: canonical + '\n', compact: compact + '\n', tools: renderTools(tools) };
  } finally {
    await controller.shutdown('Rendered prompt capture finished');
  }
}

function childContract(readOnly: boolean) {
  const names = filterExcludedTools(listToolDefinitions().map(tool => tool.name), [
    ...CHILD_EXCLUDE_TOOLS_BASE,
    ...(readOnly ? ['write', 'edit', 'multi_edit', 'insert_after_anchor', 'undo'] : []),
  ]);
  const canonical = {
    system: CHILD_AGENT_SYSTEM_PROMPT,
    tools: getActiveToolDefinitions(names, 'off')
      .map(({ name, description, input_schema }) => ({ name, description, input_schema })),
  };
  return { compact: buildCompactChildContractCandidate(canonical, { source: 'builtin-child' }) };
}

describe('rendered Worker root prompt', () => {
  it.each([
    ['linux', 'linux'],
    ['win32', 'win32'],
    ['no-platform', undefined],
  ] as const)('canonical and compact system, %s', async (label, platform) => {
    const rendered = await renderWorker(platform);
    await expect(rendered.canonical).toMatchFileSnapshot(expected(`worker.canonical.${label}.md`));
    await expect(rendered.compact).toMatchFileSnapshot(expected(`worker.compact.${label}.md`));
  });

  it('compact tool contracts', async () => {
    const rendered = await renderWorker('linux');
    await expect(rendered.tools).toMatchFileSnapshot(expected('tools.worker-compact.md'));
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
          "context-trust:contract",
          "parallel-work:guidance",
          "plan-first:guidance",
          "plan-list-hygiene:guidance",
          "scope-commitment:guidance",
          "mutation-discipline:guidance",
          "repo-intelligence-tools:capability",
          "agent-collaboration:capability",
          "agent-steering:capability",
          "execution-guidance:guidance",
          "termination:contract",
        ],
        "none": [
          "context-trust:contract",
          "parallel-work:guidance",
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
          "parallel-work:guidance",
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

describe('rendered builtin child prompt', () => {
  // Both lanes share the canonical base; write children append project rules at run time.
  it('canonical base', async () => {
    await expect(`${CHILD_AGENT_SYSTEM_PROMPT}\n`).toMatchFileSnapshot(expected('child.canonical.md'));
  });

  it.each([['read', true], ['write', false]] as const)('%s lane, compact', async (lane, readOnly) => {
    const { compact } = childContract(readOnly);
    await expect(`${compact.system}\n`).toMatchFileSnapshot(expected(`child.${lane}.compact.md`));
    await expect(renderTools(compact.tools)).toMatchFileSnapshot(expected(`tools.child-${lane}-compact.md`));
  });
});

describe('rendered canonical tool contracts', () => {
  it('every builtin tool', async () => {
    await expect(renderTools(listToolDefinitions())).toMatchFileSnapshot(expected('tools.canonical.md'));
  });
});
