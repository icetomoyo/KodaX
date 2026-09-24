/**
 * v0.7.35.1 FEATURE_142 Batch E — Capability Context Sections.
 *
 * Single source of truth for the 14 capability-context prompt sections
 * the SA path (`buildSystemPromptSnapshot` in `builder.ts`) assembles.
 * Extracted to dedupe with a future AMA worker integration (Batch F /
 * v0.7.36 FEATURE_143). Each section's id, order, content shape, and
 * inclusion condition is preserved byte-equivalently from
 * builder.ts:32-181 (pre-Batch E).
 *
 * The 14 sections, in order:
 *   1.  base-system               (always)
 *   2.  base-system-suffix        (when SYSTEM_PROMPT has `{context}` marker)
 *   3.  environment-context       (always)
 *   4.  runtime-fact              (when provider or model is set)
 *   5.  working-directory         (always)
 *   6.  session-scratch-directory (when session id is set)
 *   7.  git-context               (when isNewSession AND repo has git output)
 *   8.  project-snapshot          (when isNewSession)
 *   9.  repo-intelligence-context (when context.repoIntelligenceContext)
 *   10. mcp-capability-context    (when extensionRuntime returns mcp ctx)
 *   11. prompt-overlay            (when context.promptOverlay)
 *   12. project-agents            (when AGENTS.md / CLAUDE.md found)
 *   13. skills-addendum           (when context.skillsPrompt)
 *   14. tool-construction         (when toolConstructionMode includes it)
 *
 * Why this lives in `@kodax-ai/coding/src/prompts/` and NOT
 * `@kodax-ai/agent/`:
 *   - All callers (builder.ts SA path + future AMA role-prompt) are
 *     coding-internal. A future `@kodax-ai/data-analysis-agent` would
 *     have its own builder + role-prompt with its own section set
 *     (e.g. `prompt-overlay` is coding-routing-specific). Cross-agent
 *     reuse is at the **pattern** level (each agent has its own
 *     `capability-sections.ts`), not the **content** level.
 *   - Hoisting to `@kodax-ai/agent/` would force `@kodax-ai/agent` →
 *     `@kodax-ai/agent` / `@kodax-ai/agent` cross-package dependencies,
 *     breaking the "agent doesn't depend on application-layer
 *     packages" promise.
 *   - The drift problem this batch solves is "SA / AMA assemble the
 *     same content twice" — a coding-internal duplication, not a
 *     cross-package boundary issue.
 *
 * Behavior contract: the SA path's emitted sections array (and thus
 * `KodaXPromptSnapshot.rendered`) MUST stay byte-equivalent to the
 * pre-Batch E `buildSystemPromptSnapshot` output. `builder.test.ts` is
 * the integration-level guard for this contract.
 */

import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { assertNoGitInstallPrompt, createMemoryControlPlane, type MemoryPack } from '@kodax-ai/agent';

import { emitResilienceDebug } from '../agent-runtime/resilience-debug.js';
import { loadAgentsFiles, formatAgentsForPrompt } from '../context/agents-loader.js';
import { listConstructedAgents, type KodaXAgentScope } from '../construction/agent-resolver.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import { getSessionScratchDir } from '../session-scratch.js';
import type { KodaXOptions } from '../types.js';
import { formatFullSkillSection } from '../skill-invocation-format.js';

import { buildMemoryRulesSection } from './memory-rules.js';
import { createPromptSection, type KodaXPromptSection } from './sections.js';
import { buildSelfKnowledgeRoutingRule } from '../self-knowledge/routing-rule.js';
import { EXECUTION_GUIDANCE } from './execution-guidance.js';
import { SYSTEM_PROMPT } from './system.js';
import {
  TOOL_CONSTRUCTION_PROMPT,
  shouldIncludeToolConstructionSection,
} from './tool-construction.js';

const execAsync = promisify(exec);
const SYSTEM_CONTEXT_MARKER = '{context}';

/**
 * Build the full ordered set of capability-context prompt sections for
 * the given options + session state. The caller is responsible for
 * passing the result to `buildPromptSnapshot()` (or whatever assembler
 * the agent uses); this helper only emits the section list.
 *
 * `executionCwd` is OPTIONAL — when omitted, this helper calls
 * `resolveExecutionCwd(options.context)` internally. Passing it
 * explicitly is supported as a perf shortcut for callers that have
 * already resolved cwd for other purposes (e.g. `builder.ts` uses the
 * same value to populate the snapshot's `executionCwd` field), but
 * **the explicit value MUST equal `resolveExecutionCwd(options.context)`
 * or the `working-directory` section will diverge from the snapshot
 * metadata** — a subtle source of drift if a future caller resolves
 * cwd differently. Prefer the no-arg form unless you have a documented
 * reason to override.
 */
export async function buildCapabilityContextSections(
  options: KodaXOptions,
  isNewSession: boolean,
  executionCwdOverride?: string,
): Promise<KodaXPromptSection[]> {
  const executionCwd = executionCwdOverride ?? resolveExecutionCwd(options.context);
  const sections: KodaXPromptSection[] = [];
  const { prefix: systemPromptPrefix, suffix: systemPromptSuffix } =
    splitSystemPromptTemplate(SYSTEM_PROMPT);

  sections.push(
    createPromptSection(
      'base-system',
      systemPromptPrefix,
      'Always include the stable base identity and safety baseline.',
    ),
  );
  if (systemPromptSuffix) {
    sections.push(
      createPromptSection(
        'base-system-suffix',
        systemPromptSuffix,
        'Preserve any trailing stable base prompt instructions that follow the context placeholder.',
      ),
    );
  }
  sections.push(
    createPromptSection(
      'environment-context',
      getEnvContext(),
      'Always disclose runtime platform details so shell guidance stays accurate.',
    ),
  );
  const runtimeFact = getRuntimeFact(options);
  if (runtimeFact) {
    sections.push(
      createPromptSection(
        'runtime-fact',
        runtimeFact,
        'Always disclose the active provider and model so identity questions can be answered truthfully instead of guessed from pretraining.',
      ),
    );
  }
  sections.push(
    createPromptSection(
      'working-directory',
      `Working Directory: ${executionCwd}`,
      'Always disclose the resolved execution directory for deterministic file operations.',
    ),
  );
  const scratchDir = getSessionScratchDir(options);
  if (scratchDir) {
    sections.push(
      createPromptSection(
        'session-scratch-directory',
        `Session Scratch Directory: ${scratchDir}`,
        'Disclose the per-session scratch directory so temporary helper files never collide across same-directory sessions.',
      ),
    );
  }

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

  if (options.context?.repoIntelligenceContext?.trim()) {
    sections.push(
      createPromptSection(
        'repo-intelligence-context',
        options.context.repoIntelligenceContext,
        'Include repository-intelligence capability truth only when it is active for this runtime.',
      ),
    );
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
  const specialistBlock = buildSpecialistAgentsBlock(options.context?.agentScope);
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

  // Static EXECUTION GUIDANCE replaces the old router `prompt-overlay` section
  // (EXECUTION_MODE / HARNESS_PROFILE overlays + [Task Routing] classification
  // dump) — the SA agent self-judges the kind of work, matching the AMA Worker
  // (ADR-043 P1.7). Shared verbatim via `execution-guidance.ts`. The AMA path
  // excludes this section (it carries EXECUTION_GUIDANCE inside
  // `buildWorkerInstructions`); see `AMA_OWNED_SECTION_IDS` in runner-driven.
  sections.push(
    createPromptSection(
      'execution-guidance',
      EXECUTION_GUIDANCE,
      'Match your approach to the kind of work (review / audit / investigation / planning / ambiguity) by self-judgment, not router assignment.',
    ),
  );

  // `context.promptOverlay` now carries ONLY the SA task-family Direct Path Rule
  // (output-shaping, e.g. "lookup → concise answer with file paths", which the
  // generic EXECUTION GUIDANCE does not cover) and any caller-supplied overlay —
  // NOT the retired router overlay (that lived in `reasoningPlan.promptOverlay`,
  // now always ''). Dropping it with the router overlay in P1.7 was an
  // unintended regression (ADR-043 Phase 3 follow-up); re-emit it so the Direct
  // Path Rule + SDK caller overlay reach the SA prompt again.
  if (options.context?.promptOverlay?.trim()) {
    sections.push(
      createPromptSection(
        'prompt-overlay',
        options.context.promptOverlay,
        'Task-shaping rule for this request plus any caller-supplied context.',
      ),
    );
  }

  const agentsFiles = loadAgentsFiles({
    cwd: executionCwd,
    projectRoot: options.context?.gitRoot ?? undefined,
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

  if (options.context?.skillsPrompt?.trim()) {
    sections.push(
      createPromptSection(
        'skills-addendum',
        options.context.skillsPrompt,
        'Append skill-specific guidance after project rules as a bounded dynamic addendum.',
      ),
    );
  }

  if (options.context?.skillInvocation) {
    sections.push(
      createPromptSection(
        'active-skill-invocation',
        formatFullSkillSection(options.context.skillInvocation),
        'Inject the full content of a trusted explicit user Skill exactly once.',
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

function splitSystemPromptTemplate(template: string): {
  prefix: string;
  suffix: string;
} {
  if (!template.includes(SYSTEM_CONTEXT_MARKER)) {
    return {
      prefix: template.trim(),
      suffix: '',
    };
  }

  const [prefix, ...rest] = template.split(SYSTEM_CONTEXT_MARKER);
  return {
    prefix: prefix.trim(),
    suffix: rest.join(SYSTEM_CONTEXT_MARKER).trim(),
  };
}

function getEnvContext(): string {
  const platform = process.platform;
  const isWindows = platform === 'win32';
  const commandHint = isWindows
    ? 'Use: dir, move, copy, del'
    : 'Use: ls, mv, cp, rm';
  return `Platform: ${
    isWindows ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'
  }\n${commandHint}\nNode: ${process.version}`;
}

function getRuntimeFact(options: KodaXOptions): string | null {
  const provider = options.provider?.trim();
  const model = (options.modelOverride ?? options.model)?.trim();
  if (!provider && !model) {
    return null;
  }
  const parts: string[] = [];
  if (provider) parts.push(`provider=${provider}`);
  if (model) parts.push(`model=${model}`);
  return `[Runtime] ${parts.join('; ')}.`;
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
