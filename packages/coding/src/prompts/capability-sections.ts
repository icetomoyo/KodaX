/**
 * Capability Context Sections for the managed Worker.
 *
 * Emits the ordered capability-context sections the Worker places in its
 * request context: repository orientation (git context, project snapshot),
 * MCP and specialist catalogs, product self-knowledge routing, caller prompt
 * overlay, project rules, memory, the Skill catalog and tool-construction
 * guidance. Identity, environment, working directory and execution guidance
 * belong to the Worker instructions, so they are not emitted here.
 *
 * This stays in `@kodax-ai/coding/src/prompts/` rather than `@kodax-ai/agent/`
 * because its content is coding-specific; another agent would own its own
 * section set.
 */

import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { assertNoGitInstallPrompt, createMemoryControlPlane, type MemoryPack } from '@kodax-ai/agent';

import { emitResilienceDebug } from '../agent-runtime/resilience-debug.js';
import { loadInstructionFiles, formatAgentsForPrompt } from '../context/agents-loader.js';
import { listConstructedAgents, type KodaXAgentScope } from '../construction/agent-resolver.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import type { KodaXOptions } from '../types.js';
import { isToolDiscoverable } from '../tools/tool-search.js';
import { getModelSkillCatalog } from '../agent-runtime/tool-resolution.js';

import { buildMemoryRulesSection, buildWorkerMemoryRules } from './memory-rules.js';
import { convertLegacyMemory, isNoteMemoryEnabled, renderNoteMemorySection, resolveNotePlace } from '../memory/note-memory.js';
import { createPromptSection, type KodaXPromptSection } from './sections.js';
import { buildSelfKnowledgeRoutingRule, buildWorkerSelfKnowledgeRoutingRule } from '../self-knowledge/routing-rule.js';
import {
  TOOL_CONSTRUCTION_PROMPT,
  shouldIncludeToolConstructionSection,
} from './tool-construction.js';

const execAsync = promisify(exec);

/**
 * Build the full ordered set of capability-context prompt sections for
 * the given options + session state. The caller is responsible for
 * passing the result to `buildPromptSnapshot()` (or whatever assembler
 * the agent uses); this helper only emits the section list.
 *
 * `executionCwd` is OPTIONAL — when omitted, this helper calls
 * `resolveExecutionCwd(options.context)` internally. The managed Worker
 * passes its resolved workspace directory so git context, project snapshot,
 * project rules and memory all read the directory the Worker runs in.
 */
export async function buildCapabilityContextSections(
  options: KodaXOptions,
  isNewSession: boolean,
  executionCwdOverride?: string,
): Promise<KodaXPromptSection[]> {
  const executionCwd = executionCwdOverride ?? resolveExecutionCwd(options.context);
  const sections: KodaXPromptSection[] = [];
  if (isNewSession) {
    const gitContext = await getGitContext(executionCwd);
    if (gitContext) {
      sections.push(
        createPromptSection(
          'git-context',
          gitContext,
          'Include repository state when the session starts so the agent can orient itself quickly.',
        ),
      );
    }

    const projectSnapshot = await getProjectSnapshot(executionCwd);
    if (projectSnapshot) {
      sections.push(
        createPromptSection(
          'project-snapshot',
          projectSnapshot,
          'Include a lightweight project snapshot at the start of a session.',
        ),
      );
    }
  }

  const mcpCapabilityContext = await options.extensionRuntime?.getCapabilityPromptContext('mcp');
  if (mcpCapabilityContext?.trim()) {
    sections.push(
      createPromptSection(
        'mcp-capability-context',
        mcpCapabilityContext,
        'Include runtime-owned MCP capability truth only when active MCP servers are configured.',
      ),
    );
  }

  // FEATURE_191 — registered specialist agents available for
  // `spawn_agent(agent_id=<name>)` routing. Conditional
  // include matches the mcp-capability-context pattern: empty registry
  // → not injected (saves tokens + keeps prompt cache stable for
  // single-user runs that never register a specialist). When non-empty,
  // surfaces each agent's name + description so the Worker LLM can
  // choose a specialist whose curated instructions / tool whitelist
  // fits the task.
  const specialistBlock = isToolDiscoverable('spawn_agent', {
    ...options.context,
  }) ? buildSpecialistAgentsBlock(options.context?.agentScope) : null;
  if (specialistBlock) {
    sections.push(
      createPromptSection(
        'specialist-agents',
        specialistBlock,
        'List registered specialist executors the Worker can select with spawn_agent(agent_id) so curated prompts and tool whitelists get reused instead of duplicated.',
      ),
    );
  }

  // FEATURE_218 — always route KodaX product/usage/config questions to the
  // kodax_manual tool instead of pretraining (which mixes in Claude Code /
  // Codex CLI knowledge). Bounded routing rule only; the manual content is
  // read on demand via the tool, never injected here (keeps prompt cache stable).
  sections.push(
    createPromptSection(
      'self-knowledge-routing',
      // FEATURE_221: re-brand the routing rule for SDK consumers (productName).
      buildSelfKnowledgeRoutingRule(options.selfManual?.productName),
      'Route product usage/config/troubleshooting questions to the kodax_manual tool as the version-bound product source of truth.',
    ),
  );

  // `context.promptOverlay` carries only caller-supplied overlay (SDK, Skill or
  // command invocation), NOT the retired router overlay (that lived in
  // `reasoningPlan.promptOverlay`, now always ''). Dropping it with the router
  // overlay in P1.7 was an unintended regression (ADR-043 Phase 3 follow-up);
  // re-emit it so the caller overlay reaches the Worker request context.
  if (options.context?.promptOverlay?.trim()) {
    sections.push(
      createPromptSection(
        'prompt-overlay',
        options.context.promptOverlay,
        'Caller-supplied overlay for this request (SDK, Skill or command invocation).',
      ),
    );
  }

  const agentsFiles = loadInstructionFiles({
    cwd: executionCwd,
    projectRoot: options.context?.gitRoot ?? undefined,
    assertReadablePath: options.context?.assertReadablePath,
    projectRulesRoot: options.context?.projectRulesRoot,
  });
  const agentsContent = formatAgentsForPrompt(agentsFiles);
  if (agentsContent) {
    sections.push(
      createPromptSection(
        'project-agents',
        agentsContent,
        'Append project-scoped AI rules after runtime truth so local constraints keep higher precedence than skills.',
      ),
    );
  }

  // FEATURE_124 (v0.7.43) Phase C — `memory-rules` LLM teaching text.
  // Sits between AGENTS.md (project-agents, order 100) and the MEMORY.md
  // index (project-memory, order 200) in the project-rules slot so the
  // LLM reads "what to save / how to save / when to access" BEFORE it
  // sees the current index content. Always emitted — the teaching text
  // is path-stable so prompt cache remains valid across sessions.
  //
  // NOTE: a condensed-stub gate (emit full text only after MEMORY.md exists)
  // was trialed to save ~3.1K tokens/turn but eval-driven DEFERRED — kimi went
  // 3/3 write → 0/3 write (read instead) and ds/v4flash regressed on first-save
  // correctness. The claudecode-derived wording is load-bearing; keep full text.
  if (isNoteMemoryEnabled()) {
    // FEATURE_308: note-store rules + MEMORY.md indexes replace the legacy memory sections.
    const notePlace = resolveNotePlace(options, executionCwd);
    await convertLegacyMemory(notePlace);
    sections.push(
      createPromptSection(
        'memory-notes',
        renderNoteMemorySection(notePlace),
        'Teach note-memory use and expose the saved-note indexes so later sessions read relevant notes on demand.',
      ),
    );
  } else {
    sections.push(
      createPromptSection(
        'memory-rules',
        buildMemoryRulesSection(executionCwd),
        'Teach the agent the 4-type memory taxonomy, save procedure, and recall etiquette so writes are consistent across sessions and providers.',
      ),
    );

    // FEATURE_124 (v0.7.43) Phase B — `project-memory` section.
    // MEMORY.md index injected after the teaching text so the agent has
    // the rules in hand when it reads the current entries. Section is
    // ALWAYS emitted — fallback "currently empty" text tells the LLM the
    // subsystem is active even when no entries exist yet.
    const memoryPack = options.context?.memoryPack ?? await buildTaskMemoryPack(
      executionCwd,
      options.context?.rawUserInput,
      options.context?.memoryIdentity,
    );
    sections.push(
      createPromptSection(
        'project-memory',
        renderTaskMemoryPack(memoryPack),
        'Inject applicability-filtered memory hints without exposing raw memory indexes.',
      ),
    );
  }

  const skillsCatalog = getModelSkillCatalog(options);
  if (skillsCatalog) {
    sections.push(
      createPromptSection(
        'skills-addendum',
        skillsCatalog,
        'Append skill-specific guidance after project rules as a bounded dynamic addendum.',
      ),
    );
  }

  if (shouldIncludeToolConstructionSection(options.context?.toolConstructionMode)) {
    sections.push(
      createPromptSection(
        'tool-construction',
        TOOL_CONSTRUCTION_PROMPT,
        'Append the tool-construction staircase guidance only when self-construction is authorized for this session.',
      ),
    );
  }

  return sections;
}

async function buildTaskMemoryPack(
  cwd: string,
  rawUserInput: string | undefined,
  identity: NonNullable<KodaXOptions['context']>['memoryIdentity'],
): Promise<MemoryPack | undefined> {
  const task = rawUserInput?.trim();
  if (task === undefined || task.length === 0) return undefined;
  try {
    return await createMemoryControlPlane({
      cwd,
      ...(identity !== undefined ? { identity } : {}),
      projectDocs: [],
      discoverSkills: false,
    }).buildMemoryPack({
      task,
      ...(identity !== undefined ? { identity } : {}),
      maxCandidates: 12,
      maxHints: 5,
      includeSnippets: false,
    });
  } catch (error) {
    emitResilienceDebug('[memory:pack:error]', {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Task-relevant MemoryPack renderer.
 * Appends task-relevant MemoryPack hints to the bounded project-memory section.
 *
 * Emits ref ids and short hooks only; topic bodies stay on disk and are
 * read on demand when the task actually needs details.
 *
 * This is a read-only recall path; memory maintenance and semantic review run elsewhere.
 */
function renderTaskMemoryPack(pack: MemoryPack | undefined): string {
  const empty = 'Task-relevant memory hints: currently empty.';
  if (pack === undefined) return empty;
  if (pack.traceMetadata.suppressed) {
    return 'Task-relevant memory hints: suppressed by user request.';
  }
  if (pack.promptHints.length === 0) return empty;

  return [
    'Task-relevant memory hints (bounded):',
    ...pack.promptHints.map(formatTaskMemoryHint),
    '',
    'Use these as pointers, not authority. If a hint matters, read the referenced memory file before relying on details. Current repository files override memory.',
  ].join('\n');
}

function formatTaskMemoryHint(hint: MemoryPack['promptHints'][number]): string {
  return `- ${compactPromptLine(hint.hook)} [${hint.ref.id}]: ${compactPromptLine(hint.reason)}`;
}

function compactPromptLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}

/**
 * FEATURE_191 A.3 — render the `specialist-agents` section content from
 * the constructed-agent registry, or null when the registry is empty.
 */
function buildSpecialistAgentsBlock(agentScope: KodaXAgentScope | undefined): string | null {
  const agents = listConstructedAgents(agentScope);
  if (agents.length === 0) {
    return null;
  }
  const lines = agents
    .map((agent) => {
      // Agent.description propagated from AgentContent.description by
      // buildAgentFromContent. Falls back to a placeholder so the line
      // shape stays consistent for legacy FEATURE_089 minimal-agent
      // fixtures that pre-date the description field.
      return `- ${agent.name}: ${agent.description?.trim() || '(no description)'}`;
    })
    .join('\n');
  return [
    '=== Available specialist agents ===',
    lines,
    '',
    'Start one with spawn_agent(agent_id="<name>"); list_dispatchable_agents returns the equivalent canonical id.',
  ].join('\n');
}

async function getGitContext(cwd: string): Promise<string> {
  try {
    await assertNoGitInstallPrompt({ cwd });
    const { stdout: check } = await execAsync(
      'git rev-parse --is-inside-work-tree',
      { cwd, windowsHide: true },
    );
    if (!check.trim()) {
      return '';
    }

    const lines: string[] = [];

    try {
      const { stdout: branch } = await execAsync('git branch --show-current', {
        cwd,
        windowsHide: true,
      });
      if (branch.trim()) {
        lines.push(`Git Branch: ${branch.trim()}`);
      }
    } catch {
      // Ignore git branch lookup failures in non-standard worktrees.
    }

    try {
      const { stdout: status } = await execAsync('git status --short', {
        cwd,
        windowsHide: true,
      });
      if (status.trim()) {
        const statusLines = status.trim().split('\n').slice(0, 10);
        lines.push(
          `Git Status:\n${statusLines.map((line) => `  ${line}`).join('\n')}`,
        );
        const totalLines = status.trim().split('\n').length;
        if (totalLines > 10) {
          lines.push('  ... (more changes)');
        }
      }
    } catch {
      // Ignore git status failures so the prompt can still build.
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}

async function getProjectSnapshot(
  cwd: string,
  maxDepth = 2,
  maxFiles = 50,
): Promise<string> {
  const fs = await import('fs/promises');
  const ignoreDirs = new Set([
    '.git',
    '__pycache__',
    'node_modules',
    '.venv',
    'venv',
    'dist',
    'build',
    '.idea',
    '.vscode',
  ]);
  const ignoreExts = new Set(['.pyc', '.pyo', '.so', '.dll', '.exe', '.bin']);
  const lines = [`Project: ${path.basename(cwd)}`];
  let fileCount = 0;

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || fileCount >= maxFiles) {
      return;
    }

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs: string[] = [];
      const files: string[] = [];

      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !ignoreDirs.has(entry.name) &&
          !entry.name.startsWith('.')
        ) {
          dirs.push(entry.name);
        } else if (
          entry.isFile() &&
          !ignoreExts.has(path.extname(entry.name))
        ) {
          files.push(entry.name);
        }
      }

      const indent = '  '.repeat(depth);
      const relative = path.relative(cwd, dir);
      if (relative && relative !== '.') {
        lines.push(`${indent}${relative}/`);
      }

      for (const file of files.sort().slice(0, 20)) {
        lines.push(`${indent}  ${file}`);
        fileCount += 1;
        if (fileCount >= maxFiles) {
          lines.push('  ... (more files)');
          return;
        }
      }

      for (const childDir of dirs.sort()) {
        await walk(path.join(dir, childDir), depth + 1);
      }
    } catch {
      // Ignore unreadable directories in best-effort project snapshots.
    }
  }

  await walk(cwd, 0);
  return lines.join('\n');
}

/**
 * The Worker states the memory and manual rules densely once their tools are on its menu:
 * the tool descriptions carry the call details, so the section keeps only the decisions.
 */
export function workerStableCapabilityContent(
  section: Pick<KodaXPromptSection, 'id' | 'content'>,
  toolNames: readonly string[],
  productName?: string,
): string {
  if (section.id === 'memory-rules' && toolNames.includes('memory_intent') && toolNames.includes('memory_recall')) {
    return buildWorkerMemoryRules();
  }
  if (section.id === 'self-knowledge-routing' && toolNames.includes('kodax_manual')) {
    return buildWorkerSelfKnowledgeRoutingRule(productName);
  }
  return section.content;
}
