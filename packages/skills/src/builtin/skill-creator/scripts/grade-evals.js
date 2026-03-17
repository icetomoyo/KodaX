#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computePassSummary,
  ensureDirectory,
  extractJsonObject,
  loadRelativeText,
  readJsonFile,
  truncateText,
} from './utils.js';

function normalizeExpectationText(value) {
  return String(value ?? '').trim();
}

function normalizeExpectedRubric(evalMetadata) {
  const assertions = Array.isArray(evalMetadata?.assertions) ? evalMetadata.assertions : [];
  const items = assertions
    .map((assertion) => {
      if (typeof assertion === 'string') {
        return normalizeExpectationText(assertion);
      }
      if (assertion && typeof assertion === 'object' && typeof assertion.text === 'string') {
        return normalizeExpectationText(assertion.text);
      }
      return '';
    })
    .filter(Boolean);

  if (items.length > 0) {
    return items;
  }

  const expectedOutput = normalizeExpectationText(evalMetadata?.expected_output);
  return expectedOutput ? [expectedOutput] : [];
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function normalizeExpectationEntry(entry, fallbackText) {
  const text = normalizeExpectationText(entry?.text ?? fallbackText);
  return {
    text,
    passed: entry?.passed === true,
    evidence: normalizeExpectationText(entry?.evidence),
  };
}

function normalizeParsedGrading(rawText, rubric) {
  const parsed = extractJsonObject(rawText) ?? {};
  const returnedExpectations = Array.isArray(parsed.expectations) ? parsed.expectations : [];
  const normalizedExpectations = [];
  const consumed = new Set();

  for (const rubricText of rubric) {
    const matchIndex = returnedExpectations.findIndex((entry, index) => {
      if (consumed.has(index)) {
        return false;
      }

      const candidate = normalizeExpectationText(entry?.text);
      return candidate.toLowerCase() === rubricText.toLowerCase();
    });

    if (matchIndex === -1) {
      normalizedExpectations.push({
        text: rubricText,
        passed: false,
        evidence: '',
      });
      continue;
    }

    consumed.add(matchIndex);
    normalizedExpectations.push(normalizeExpectationEntry(returnedExpectations[matchIndex], rubricText));
  }

  if (rubric.length === 0) {
    for (const entry of returnedExpectations) {
      const normalized = normalizeExpectationEntry(entry, '');
      if (normalized.text) {
        normalizedExpectations.push(normalized);
      }
    }
  }

  return {
    overall_summary: normalizeExpectationText(parsed.overall_summary),
    expectations: normalizedExpectations,
    user_notes_summary: {
      uncertainties: normalizeStringArray(parsed.user_notes_summary?.uncertainties),
      needs_review: normalizeStringArray(parsed.user_notes_summary?.needs_review),
      workarounds: normalizeStringArray(parsed.user_notes_summary?.workarounds),
    },
  };
}

async function listDirectories(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function loadRunContext(runDir) {
  const configDir = path.dirname(runDir);
  const evalDir = path.dirname(configDir);
  const configName = path.basename(configDir);
  const runId = path.basename(runDir);
  const outputsDir = path.join(runDir, 'outputs');
  const evalMetadata = await readJsonFile(path.join(evalDir, 'eval_metadata.json'), {});
  const resultText = await readFile(path.join(outputsDir, 'result.md'), 'utf8').catch(() => '');
  const promptText = await readFile(path.join(outputsDir, 'prompt.txt'), 'utf8').catch(() => '');
  const transcript = await readFile(path.join(runDir, 'transcript.md'), 'utf8').catch(() => '');
  const metrics = await readJsonFile(path.join(outputsDir, 'metrics.json'), {});
  const result = await readJsonFile(path.join(runDir, 'result.json'), {});
  const timing = await readJsonFile(path.join(runDir, 'timing.json'), {});

  return {
    evalDir,
    runDir,
    runId,
    configName,
    evalMetadata,
    outputsDir,
    resultText,
    promptText,
    transcript,
    metrics,
    result,
    timing,
  };
}

export function buildGradingPrompt(input) {
  const rubric = normalizeExpectedRubric(input.evalMetadata);
  const rubricText = rubric.length > 0
    ? rubric.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '(No explicit assertions; infer one expectation from expected_output if present.)';

  return `${input.agentInstructions.trim()}

Return JSON with this shape:
{
  "overall_summary": "short summary",
  "expectations": [
    {
      "text": "expectation text",
      "passed": true,
      "evidence": "short evidence grounded in the output"
    }
  ],
  "user_notes_summary": {
    "uncertainties": [],
    "needs_review": [],
    "workarounds": []
  }
}

## Run Metadata
- eval_id: ${input.evalMetadata.eval_id ?? 'unknown'}
- eval_name: ${input.evalMetadata.eval_name ?? 'unknown'}
- config: ${input.configName}
- run_id: ${input.runId}

## Eval Prompt
${truncateText(input.evalMetadata.prompt ?? input.promptText, 4000)}

## Expected Outcome
${truncateText(input.evalMetadata.expected_output ?? '', 2000)}

## Assertions
${rubricText}

## Final Output
${truncateText(input.resultText, 12000)}

## Result Flags
${JSON.stringify({
  success: input.result.success ?? null,
  signal: input.result.signal ?? null,
  interrupted: input.result.interrupted ?? false,
  limit_reached: input.result.limit_reached ?? input.result.limitReached ?? false,
}, null, 2)}

## Execution Metrics
${JSON.stringify({
  total_tool_calls: input.metrics.total_tool_calls ?? input.result.execution_metrics?.total_tool_calls ?? 0,
  errors_encountered: input.metrics.errors_encountered ?? input.result.execution_metrics?.errors_encountered ?? 0,
  output_chars: input.metrics.output_chars ?? input.result.execution_metrics?.output_chars ?? input.resultText.length,
  total_tokens: input.timing.total_tokens ?? 0,
  total_duration_seconds: input.timing.total_duration_seconds ?? 0,
}, null, 2)}

## Transcript Excerpt
${truncateText(input.transcript, 5000)}
`;
}

async function defaultRunJudge(prompt, options) {
  const { runKodaX } = await import('@kodax/coding');
  const result = await runKodaX(
    {
      provider: options.provider ?? 'anthropic',
      model: options.model,
      maxIter: options.maxIter ?? 20,
      reasoningMode: options.reasoningMode ?? 'balanced',
      thinking: options.reasoningMode ? options.reasoningMode !== 'off' : true,
      context: {
        gitRoot: path.resolve(options.cwd ?? options.workspaceDir ?? process.cwd()),
      },
    },
    prompt
  );
  return result.lastText;
}

export async function gradeRun(runDir, options, runner = defaultRunJudge) {
  const run = await loadRunContext(path.resolve(runDir));
  const rubric = normalizeExpectedRubric(run.evalMetadata);
  const agentInstructions = await loadRelativeText(import.meta.url, '../agents/grader.md');
  const prompt = buildGradingPrompt({
    ...run,
    agentInstructions,
  });
  const rawResponse = await runner(prompt, {
    ...options,
    runDir: run.runDir,
    configName: run.configName,
    evalMetadata: run.evalMetadata,
    runId: run.runId,
  });
  const parsed = normalizeParsedGrading(rawResponse, rubric);
  const executionMetrics = {
    total_tool_calls: run.metrics.total_tool_calls ?? run.result.execution_metrics?.total_tool_calls ?? 0,
    errors_encountered: run.metrics.errors_encountered ?? run.result.execution_metrics?.errors_encountered ?? 0,
    output_chars: run.metrics.output_chars ?? run.result.execution_metrics?.output_chars ?? run.resultText.length,
  };

  const grading = {
    summary: computePassSummary(parsed.expectations),
    expectations: parsed.expectations,
    execution_metrics: executionMetrics,
    user_notes_summary: parsed.user_notes_summary,
    overall_summary: parsed.overall_summary,
    timing: {
      total_tokens: run.timing.total_tokens ?? 0,
      total_duration_seconds: run.timing.total_duration_seconds ?? 0,
    },
    meta: {
      generated_at: new Date().toISOString(),
      eval_id: run.evalMetadata.eval_id ?? null,
      eval_name: run.evalMetadata.eval_name ?? null,
      config: run.configName,
      run_id: run.runId,
    },
  };

  await writeFile(
    path.join(run.runDir, 'grading.json'),
    `${JSON.stringify(grading, null, 2)}\n`,
    'utf8'
  );

  return {
    runDir: run.runDir,
    grading,
    prompt,
    rawResponse,
  };
}

export async function gradeWorkspace(options, runner = defaultRunJudge) {
  const workspaceDir = path.resolve(options.workspaceDir);
  await ensureDirectory(workspaceDir);

  const configFilter = new Set(
    (options.configs ?? [])
      .map((item) => String(item).trim())
      .filter(Boolean)
  );
  const processedRuns = [];
  const skippedRuns = [];

  for (const evalDir of await listDirectories(workspaceDir)) {
    if (!path.basename(evalDir).startsWith('eval-')) {
      continue;
    }

    for (const configDir of await listDirectories(evalDir)) {
      const configName = path.basename(configDir);
      if (configFilter.size > 0 && !configFilter.has(configName)) {
        continue;
      }

      for (const runDir of await listDirectories(configDir)) {
        if (!path.basename(runDir).startsWith('run-')) {
          continue;
        }

        const gradingPath = path.join(runDir, 'grading.json');
        const existing = await readJsonFile(gradingPath, null);
        if (existing && options.overwrite !== true) {
          skippedRuns.push(path.relative(workspaceDir, runDir).replace(/\\/g, '/'));
          continue;
        }

        const graded = await gradeRun(runDir, options, runner);
        processedRuns.push({
          run: path.relative(workspaceDir, runDir).replace(/\\/g, '/'),
          summary: graded.grading.summary,
          config: graded.grading.meta.config,
          eval_id: graded.grading.meta.eval_id,
        });
      }
    }
  }

  const summary = {
    workspace: workspaceDir,
    generated_at: new Date().toISOString(),
    processed: processedRuns.length,
    skipped: skippedRuns.length,
    processed_runs: processedRuns,
    skipped_runs: skippedRuns,
  };

  await writeFile(
    path.join(workspaceDir, 'grading-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8'
  );

  return summary;
}

function parseArgs(argv) {
  const args = {
    workspaceDir: argv[2] ?? '',
    provider: 'anthropic',
    model: undefined,
    reasoningMode: 'balanced',
    maxIter: 20,
    cwd: process.cwd(),
    overwrite: false,
    configs: [],
  };

  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--provider' && argv[index + 1]) {
      args.provider = argv[++index];
    } else if (token === '--model' && argv[index + 1]) {
      args.model = argv[++index];
    } else if (token === '--reasoning' && argv[index + 1]) {
      args.reasoningMode = argv[++index];
    } else if (token === '--max-iter' && argv[index + 1]) {
      args.maxIter = Number(argv[++index]);
    } else if (token === '--cwd' && argv[index + 1]) {
      args.cwd = argv[++index];
    } else if (token === '--overwrite') {
      args.overwrite = true;
    } else if (token === '--configs' && argv[index + 1]) {
      args.configs = argv[++index]
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.workspaceDir) {
    console.error('Usage: node scripts/grade-evals.js <workspace> [--provider anthropic] [--configs with_skill,without_skill] [--overwrite]');
    process.exit(1);
  }

  const summary = await gradeWorkspace(args);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
