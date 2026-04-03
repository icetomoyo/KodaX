/**
 * KodaX Prompt Builder
 *
 * Builds effective prompts through an explicit section registry so prompt
 * truth can be snapshotted, attributed, and regression-tested.
 */

import fsSync from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { KODAX_FEATURES_FILE, KODAX_PROGRESS_FILE } from '../constants.js';
import { loadAgentsFiles, formatAgentsForPrompt } from '../context/agents-loader.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import type { KodaXOptions } from '../types.js';
import { LONG_RUNNING_PROMPT } from './long-running.js';
import {
  buildPromptSnapshot,
  createPromptSection,
  type KodaXPromptSection,
  type KodaXPromptSnapshot,
} from './sections.js';
import { SYSTEM_PROMPT } from './system.js';

const execAsync = promisify(exec);
const SYSTEM_CONTEXT_MARKER = '{context}';

/**
 * Build a sectionized snapshot of the effective system prompt.
 */
export async function buildSystemPromptSnapshot(
  options: KodaXOptions,
  isNewSession: boolean,
): Promise<KodaXPromptSnapshot> {
  const sections: KodaXPromptSection[] = [];
  const executionCwd = resolveExecutionCwd(options.context);
  const projectRoot = options.context?.gitRoot
    ? path.resolve(options.context.gitRoot)
    : executionCwd;
  const isLongRunning =
    fsSync.existsSync(path.resolve(projectRoot, KODAX_FEATURES_FILE)) &&
    !options.context?.longRunning;
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
  sections.push(
    createPromptSection(
      'working-directory',
      `Working Directory: ${executionCwd}`,
      'Always disclose the resolved execution directory for deterministic file operations.',
    ),
  );

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

  if (isLongRunning) {
    const longRunningContext = await getLongRunningContext(projectRoot);
    if (longRunningContext) {
      sections.push(
        createPromptSection(
          'long-running-context',
          longRunningContext,
          'Include tracked feature and progress context when long-running project files are present.',
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

  if (isLongRunning) {
    sections.push(
      createPromptSection(
        'long-running-overlay',
        LONG_RUNNING_PROMPT,
        'Activate the long-running overlay when feature tracking files are present.',
      ),
    );
  }

  if (options.context?.promptOverlay?.trim()) {
    sections.push(
      createPromptSection(
        'prompt-overlay',
        options.context.promptOverlay,
        'Append runtime harness, routing, and provider truth for the current execution plan.',
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

  if (options.context?.skillsPrompt?.trim()) {
    sections.push(
      createPromptSection(
        'skills-addendum',
        options.context.skillsPrompt,
        'Append skill-specific guidance after project rules as a bounded dynamic addendum.',
      ),
    );
  }

  return buildPromptSnapshot(sections, {
    isNewSession,
    executionCwd,
    projectRoot,
    longRunning: isLongRunning,
  });
}

/**
 * Build the rendered system prompt used for provider calls.
 */
export async function buildSystemPrompt(
  options: KodaXOptions,
  isNewSession: boolean,
): Promise<string> {
  return (await buildSystemPromptSnapshot(options, isNewSession)).rendered;
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

async function getGitContext(cwd: string): Promise<string> {
  try {
    const { stdout: check } = await execAsync(
      'git rev-parse --is-inside-work-tree',
      { cwd },
    );
    if (!check.trim()) {
      return '';
    }

    const lines: string[] = [];

    try {
      const { stdout: branch } = await execAsync('git branch --show-current', {
        cwd,
      });
      if (branch.trim()) {
        lines.push(`Git Branch: ${branch.trim()}`);
      }
    } catch {
      // Ignore git branch lookup failures in non-standard worktrees.
    }

    try {
      const { stdout: status } = await execAsync('git status --short', { cwd });
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

async function getLongRunningContext(cwd: string): Promise<string> {
  const fs = await import('fs/promises');
  const parts: string[] = [];
  const featuresPath = path.resolve(cwd, KODAX_FEATURES_FILE);
  if (fsSync.existsSync(featuresPath)) {
    try {
      const features = JSON.parse(await fs.readFile(featuresPath, 'utf-8'));
      parts.push('## Feature List (from feature_list.json)\n');
      for (const feature of features.features ?? []) {
        const status = feature.passes ? '[x]' : '[ ]';
        const description = feature.description ?? feature.name ?? 'Unknown';
        parts.push(`- ${status} ${description}`);
      }
    } catch {
      // Ignore malformed feature tracking state in prompt assembly.
    }
  }

  const progressPath = path.resolve(cwd, KODAX_PROGRESS_FILE);
  if (fsSync.existsSync(progressPath)) {
    try {
      const progress = await fs.readFile(progressPath, 'utf-8');
      if (progress.trim()) {
        parts.push(
          `\n## Last Session Progress (from PROGRESS.md)\n\n${progress.slice(0, 1500)}`,
        );
      }
    } catch {
      // Ignore malformed progress logs in prompt assembly.
    }
  }

  return parts.join('\n');
}
