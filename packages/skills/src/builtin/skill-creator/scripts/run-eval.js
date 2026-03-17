#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandSkillForLLM } from '../../../skill-expander.js';
import { loadFullSkill } from '../../../skill-loader.js';
import { ensureDirectory } from './utils.js';

function normalizeAssertion(assertion) {
  if (typeof assertion === 'string') {
    return { text: assertion };
  }
  if (assertion && typeof assertion === 'object' && typeof assertion.text === 'string') {
    return { text: assertion.text };
  }
  return null;
}

function countToolCalls(messages) {
  return messages.reduce((total, message) => {
    if (!Array.isArray(message.content)) {
      return total;
    }
    return total + message.content.filter((block) => block?.type === 'tool_use').length;
  }, 0);
}

function countToolErrors(messages) {
  return messages.reduce((total, message) => {
    if (!Array.isArray(message.content)) {
      return total;
    }
    return total + message.content.filter((block) => block?.type === 'tool_result' && block.is_error === true).length;
  }, 0);
}

function renderTranscript(prompt, result) {
  const lines = [
    '# Skill Eval Transcript',
    '',
    '## Eval Prompt',
    '',
    prompt,
    '',
    '## Final Response',
    '',
    result.lastText || '(No final text)',
    '',
    '## Result Flags',
    '',
    `- success: ${result.success}`,
    `- signal: ${result.signal ?? 'none'}`,
    `- interrupted: ${result.interrupted === true}`,
    `- limit_reached: ${result.limitReached === true}`,
  ];

  return `${lines.join('\n')}\n`;
}

async function readInputFiles(files, options) {
  const baseDir = path.dirname(path.resolve(options.evalsPath));
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const sections = [];

  for (const filePath of files ?? []) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(baseDir, filePath);
    const fallback = path.resolve(cwd, filePath);
    let content = null;
    let usedPath = resolved;

    try {
      content = await readFile(resolved, 'utf8');
    } catch {
      content = await readFile(fallback, 'utf8').catch(() => null);
      usedPath = fallback;
    }

    if (content == null) {
      throw new Error(`Input file not found for eval: ${filePath}`);
    }

    sections.push(`### ${filePath}\n\`\`\`\n${content}\n\`\`\`\n(Resolved from ${usedPath})`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `## Input Files\n\n${sections.join('\n\n')}\n\n`;
}

export async function buildEvalPrompt(evalItem, options) {
  const prompt = String(evalItem.prompt ?? evalItem.query ?? '').trim();
  const fileSection = await readInputFiles(evalItem.files, options);
  return `${fileSection}${prompt}`.trim();
}

async function defaultRunAgent(prompt, options) {
  const { runKodaX, estimateTokens } = await import('@kodax/coding');
  const startedAt = Date.now();
  const result = await runKodaX(
    {
      provider: options.provider ?? 'anthropic',
      model: options.model,
      maxIter: options.maxIter ?? 30,
      reasoningMode: options.reasoningMode ?? 'off',
      thinking: options.reasoningMode ? options.reasoningMode !== 'off' : false,
      context: {
        gitRoot: path.resolve(options.cwd ?? process.cwd()),
      },
    },
    prompt
  );

  return {
    result,
    totalTokens: estimateTokens(result.messages),
    durationMs: Date.now() - startedAt,
  };
}

async function prepareConfigPrompt(configName, skill, taskPrompt, options) {
  if (configName === 'with_skill') {
    const expanded = await expandSkillForLLM(
      skill,
      taskPrompt,
      {
        workingDirectory: path.resolve(options.cwd ?? process.cwd()),
        projectRoot: path.resolve(options.cwd ?? process.cwd()),
        sessionId: 'skill-eval',
        environment: {},
      }
    );
    return expanded.content;
  }

  return taskPrompt;
}

async function writeRunArtifacts(runDir, configName, evalItem, prompt, execution) {
  const outputsDir = path.join(runDir, 'outputs');
  await ensureDirectory(outputsDir);

  const executionMetrics = {
    total_tool_calls: countToolCalls(execution.result.messages),
    errors_encountered: countToolErrors(execution.result.messages),
    output_chars: execution.result.lastText.length,
  };

  await writeFile(path.join(outputsDir, 'result.md'), `${execution.result.lastText}\n`, 'utf8');
  await writeFile(path.join(outputsDir, 'prompt.txt'), `${prompt}\n`, 'utf8');
  await writeFile(path.join(runDir, 'transcript.md'), renderTranscript(prompt, execution.result), 'utf8');
  await writeFile(
    path.join(outputsDir, 'metrics.json'),
    `${JSON.stringify({
      config: configName,
      eval_id: evalItem.id ?? null,
      session_id: execution.result.sessionId,
      ...executionMetrics,
    }, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    path.join(outputsDir, 'messages.json'),
    `${JSON.stringify(execution.result.messages, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    path.join(runDir, 'timing.json'),
    `${JSON.stringify({
      total_tokens: execution.totalTokens,
      duration_ms: execution.durationMs,
      total_duration_seconds: Number((execution.durationMs / 1000).toFixed(4)),
    }, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    path.join(runDir, 'result.json'),
    `${JSON.stringify({
      success: execution.result.success,
      signal: execution.result.signal ?? null,
      signal_reason: execution.result.signalReason ?? null,
      interrupted: execution.result.interrupted === true,
      limit_reached: execution.result.limitReached === true,
      session_id: execution.result.sessionId,
      execution_metrics: executionMetrics,
    }, null, 2)}\n`,
    'utf8'
  );
}

export async function runEvalWorkspace(
  options,
  runner = defaultRunAgent
) {
  const skill = await loadFullSkill(path.resolve(options.skillPath), 'user');
  if (!skill) {
    throw new Error(`Failed to load skill from ${options.skillPath}`);
  }

  const workspaceDir = path.resolve(options.workspaceDir);
  await ensureDirectory(workspaceDir);

  const evalDocument = JSON.parse(await readFile(options.evalsPath, 'utf8'));
  const evals = Array.isArray(evalDocument.evals) ? evalDocument.evals : [];
  const configs = options.configs?.length ? options.configs : ['with_skill', 'without_skill'];
  const runsPerConfig = Number.isFinite(options.runsPerConfig) && options.runsPerConfig > 0
    ? Math.floor(options.runsPerConfig)
    : 1;
  const reports = [];

  for (let evalIndex = 0; evalIndex < evals.length; evalIndex += 1) {
    const evalItem = evals[evalIndex];
    const evalDir = path.join(workspaceDir, `eval-${evalIndex}`);
    await ensureDirectory(evalDir);
    await writeFile(
      path.join(evalDir, 'eval_metadata.json'),
      `${JSON.stringify({
        eval_id: evalItem.id ?? evalIndex,
        eval_name: evalItem.name ?? `eval-${evalIndex}`,
        prompt: evalItem.prompt ?? evalItem.query ?? '',
        expected_output: evalItem.expected_output ?? '',
        assertions: (Array.isArray(evalItem.assertions) ? evalItem.assertions : [])
          .map(normalizeAssertion)
          .filter(Boolean),
      }, null, 2)}\n`,
      'utf8'
    );

    const taskPrompt = await buildEvalPrompt(evalItem, options);
    const configReports = {};

    for (const configName of configs) {
      const configDir = path.join(evalDir, configName);
      await ensureDirectory(configDir);
      configReports[configName] = [];

      for (let runIndex = 1; runIndex <= runsPerConfig; runIndex += 1) {
        const runDir = path.join(configDir, `run-${runIndex}`);
        await ensureDirectory(runDir);

        const prompt = await prepareConfigPrompt(configName, skill, taskPrompt, options);
        const execution = await runner(prompt, {
          ...options,
          configName,
          evalItem,
          runIndex,
        });
        await writeRunArtifacts(runDir, configName, evalItem, prompt, execution);

        configReports[configName].push({
          run_id: `run-${runIndex}`,
          session_id: execution.result.sessionId,
          success: execution.result.success,
          total_tokens: execution.totalTokens,
          duration_ms: execution.durationMs,
          output_chars: execution.result.lastText.length,
        });
      }
    }

    reports.push({
      eval_id: evalItem.id ?? evalIndex,
      prompt: evalItem.prompt ?? evalItem.query ?? '',
      configs: configReports,
    });
  }

  return {
    workspace: workspaceDir,
    skill_name: skill.name,
    eval_count: evals.length,
    configs,
    runs_per_config: runsPerConfig,
    reports,
  };
}

function parseArgs(argv) {
  const args = {
    skillPath: '',
    evalsPath: '',
    workspaceDir: '',
    provider: 'anthropic',
    model: undefined,
    runsPerConfig: 1,
    maxIter: 30,
    reasoningMode: 'off',
    cwd: process.cwd(),
    configs: ['with_skill', 'without_skill'],
    output: undefined,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--skill-path' && argv[index + 1]) {
      args.skillPath = argv[++index];
    } else if (token === '--evals' && argv[index + 1]) {
      args.evalsPath = argv[++index];
    } else if (token === '--workspace' && argv[index + 1]) {
      args.workspaceDir = argv[++index];
    } else if (token === '--provider' && argv[index + 1]) {
      args.provider = argv[++index];
    } else if (token === '--model' && argv[index + 1]) {
      args.model = argv[++index];
    } else if (token === '--runs' && argv[index + 1]) {
      args.runsPerConfig = Number(argv[++index]);
    } else if (token === '--max-iter' && argv[index + 1]) {
      args.maxIter = Number(argv[++index]);
    } else if (token === '--reasoning' && argv[index + 1]) {
      args.reasoningMode = argv[++index];
    } else if (token === '--cwd' && argv[index + 1]) {
      args.cwd = argv[++index];
    } else if (token === '--configs' && argv[index + 1]) {
      args.configs = argv[++index]
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (token === '--output' && argv[index + 1]) {
      args.output = argv[++index];
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.skillPath || !args.evalsPath || !args.workspaceDir) {
    console.error('Usage: node scripts/run-eval.js --skill-path <dir> --evals <evals.json> --workspace <dir> [--provider anthropic] [--runs 1]');
    process.exit(1);
  }

  const report = await runEvalWorkspace(args);
  const outputText = `${JSON.stringify(report, null, 2)}\n`;

  if (args.output) {
    await writeFile(args.output, outputText, 'utf8');
    console.log(`Wrote ${path.resolve(args.output)}`);
  } else {
    process.stdout.write(outputText);
  }
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
