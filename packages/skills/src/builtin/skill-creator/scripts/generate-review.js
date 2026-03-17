#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx',
  '.yaml', '.yml', '.html', '.css', '.sql', '.toml', '.xml',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const METADATA_FILES = new Set(['transcript.md', 'metrics.json']);

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectOutputFiles(outputsDir) {
  const entries = await readdir(outputsDir, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || METADATA_FILES.has(entry.name)) {
      continue;
    }

    const filePath = path.join(outputsDir, entry.name);
    const extension = path.extname(entry.name).toLowerCase();

    if (TEXT_EXTENSIONS.has(extension)) {
      files.push({
        name: entry.name,
        kind: 'text',
        content: await readFile(filePath, 'utf8').catch(() => '(Error reading file)'),
      });
      continue;
    }

    const raw = await readFile(filePath).catch(() => null);
    if (!raw) {
      files.push({ name: entry.name, kind: 'error', content: '(Error reading file)' });
      continue;
    }

    const base64 = raw.toString('base64');
    if (IMAGE_EXTENSIONS.has(extension)) {
      const mime = extension === '.svg' ? 'image/svg+xml' : `image/${extension.slice(1)}`;
      files.push({
        name: entry.name,
        kind: 'image',
        dataUri: `data:${mime};base64,${base64}`,
      });
    } else if (extension === '.pdf') {
      files.push({
        name: entry.name,
        kind: 'pdf',
        dataUri: `data:application/pdf;base64,${base64}`,
      });
    } else {
      files.push({
        name: entry.name,
        kind: 'binary',
        dataUri: `data:application/octet-stream;base64,${base64}`,
      });
    }
  }

  return files;
}

async function buildRun(workspaceRoot, runDir) {
  const outputsDir = path.join(runDir, 'outputs');
  if (!(await pathExists(outputsDir))) {
    return null;
  }

  const evalMetadata = await readJson(path.join(runDir, 'eval_metadata.json'))
    ?? await readJson(path.join(path.dirname(runDir), 'eval_metadata.json'))
    ?? await readJson(path.join(path.dirname(path.dirname(runDir)), 'eval_metadata.json'), {});

  let prompt = evalMetadata.prompt ?? '';
  if (!prompt) {
    const transcript = await readFile(path.join(runDir, 'transcript.md'), 'utf8').catch(() => '');
    const match = transcript.match(/## Eval Prompt\s+([\s\S]*?)(?:\n##|$)/);
    prompt = match?.[1]?.trim() ?? '(No prompt found)';
  }

  return {
    id: path.relative(workspaceRoot, runDir).replace(/\\/g, '/'),
    evalId: evalMetadata.eval_id ?? null,
    prompt,
    grading: await readJson(path.join(runDir, 'grading.json'), null),
    outputs: await collectOutputFiles(outputsDir),
  };
}

export async function findRuns(workspaceRoot, currentDir = workspaceRoot, runs = []) {
  const outputsDir = path.join(currentDir, 'outputs');
  if (await pathExists(outputsDir)) {
    const run = await buildRun(workspaceRoot, currentDir);
    if (run) {
      runs.push(run);
    }
    return runs;
  }

  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (['node_modules', '.git', '__pycache__', 'inputs'].includes(entry.name)) {
      continue;
    }
    await findRuns(workspaceRoot, path.join(currentDir, entry.name), runs);
  }

  return runs;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderHtml(payload, staticMode) {
  const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(payload.skillName)} Review</title>
  <style>
    :root { color-scheme: light; font-family: "Segoe UI", "IBM Plex Sans", sans-serif; }
    body { margin: 0; background: #f5f1e8; color: #1f2328; }
    header { padding: 24px 28px; background: linear-gradient(135deg, #113946, #bca37f); color: #fffdf7; }
    main { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 100px); }
    nav { border-right: 1px solid #d7d1c7; background: #fffaf1; padding: 20px; overflow: auto; }
    .panel { padding: 24px 28px; overflow: auto; }
    .run-button { display: block; width: 100%; text-align: left; margin: 0 0 10px; padding: 12px; border: 1px solid #d7d1c7; border-radius: 12px; background: #fff; cursor: pointer; }
    .run-button.active { border-color: #113946; box-shadow: 0 0 0 2px rgba(17,57,70,.12); }
    .tabs { display: flex; gap: 12px; margin-bottom: 18px; }
    .tab { border: 0; border-radius: 999px; padding: 10px 16px; background: #e6dccd; cursor: pointer; }
    .tab.active { background: #113946; color: white; }
    .card { background: white; border: 1px solid #d7d1c7; border-radius: 18px; padding: 18px; margin-bottom: 18px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f7f7f8; padding: 14px; border-radius: 12px; }
    textarea { width: 100%; min-height: 180px; border-radius: 12px; border: 1px solid #c8c1b6; padding: 12px; font: inherit; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 18px; overflow: hidden; }
    th, td { padding: 12px; border-bottom: 1px solid #ece7df; text-align: left; }
    .hidden { display: none; }
    .muted { color: #57606a; }
    img, iframe { max-width: 100%; border-radius: 12px; }
    @media (max-width: 920px) {
      main { grid-template-columns: 1fr; }
      nav { border-right: 0; border-bottom: 1px solid #d7d1c7; }
    }
  </style>
</head>
<body>
  <header>
    <div class="muted">KodaX Skill Review</div>
    <h1>${escapeHtml(payload.skillName)}</h1>
    <div>${escapeHtml(payload.workspace)}</div>
  </header>
  <main>
    <nav>
      <div class="tabs">
        <button class="tab active" data-tab="outputs">Outputs</button>
        <button class="tab" data-tab="benchmark">Benchmark</button>
      </div>
      <div id="run-list"></div>
    </nav>
    <section class="panel">
      <div id="outputs-panel"></div>
      <div id="benchmark-panel" class="hidden"></div>
    </section>
  </main>
  <script>
    const payload = ${serialized};
    const feedback = { ...(payload.feedback || {}) };
    let currentRunId = payload.runs[0]?.id || null;

    const runList = document.getElementById('run-list');
    const outputsPanel = document.getElementById('outputs-panel');
    const benchmarkPanel = document.getElementById('benchmark-panel');
    const tabs = Array.from(document.querySelectorAll('.tab'));

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function persistFeedback() {
      if (${staticMode ? 'true' : 'false'}) {
        localStorage.setItem('kodax-skill-review-feedback', JSON.stringify(feedback));
        return Promise.resolve();
      }
      return fetch('/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feedback),
      });
    }

    function renderRunList() {
      runList.innerHTML = '';
      for (const run of payload.runs) {
        const button = document.createElement('button');
        button.className = 'run-button' + (run.id === currentRunId ? ' active' : '');
        button.innerHTML = '<strong>' + run.id + '</strong><div class="muted">' + (run.prompt || '') + '</div>';
        button.onclick = () => {
          currentRunId = run.id;
          renderRunList();
          renderOutputs();
        };
        runList.appendChild(button);
      }
    }

    function renderOutputs() {
      const run = payload.runs.find((item) => item.id === currentRunId);
      if (!run) {
        outputsPanel.innerHTML = '<div class="card">No run selected.</div>';
        return;
      }

      const cards = [];
      cards.push('<div class="card"><h2>Prompt</h2><pre>' + escapeHtml(run.prompt || '(No prompt found)') + '</pre></div>');
      if (run.grading) {
        cards.push('<div class="card"><h2>Grading</h2><pre>' + escapeHtml(JSON.stringify(run.grading, null, 2)) + '</pre></div>');
      }

      for (const output of run.outputs) {
        if (output.kind === 'text') {
          cards.push('<div class="card"><h2>' + escapeHtml(output.name) + '</h2><pre>' + escapeHtml(output.content) + '</pre></div>');
        } else if (output.kind === 'image') {
          cards.push('<div class="card"><h2>' + escapeHtml(output.name) + '</h2><img alt="" src="' + output.dataUri + '"></div>');
        } else if (output.kind === 'pdf') {
          cards.push('<div class="card"><h2>' + escapeHtml(output.name) + '</h2><iframe title="" src="' + output.dataUri + '" style="width:100%;min-height:500px;"></iframe></div>');
        } else {
          cards.push('<div class="card"><h2>' + escapeHtml(output.name) + '</h2><a download="' + escapeHtml(output.name) + '" href="' + output.dataUri + '">Download output</a></div>');
        }
      }

      cards.push('<div class="card"><h2>Feedback</h2><textarea id="feedback-box">' + escapeHtml(feedback[run.id] || '') + '</textarea><div class="muted">Feedback is ' + (${staticMode ? '"saved in localStorage for this browser."' : '"written to feedback.json in the workspace."'}) + '</div></div>');
      outputsPanel.innerHTML = cards.join('');

      const textarea = document.getElementById('feedback-box');
      textarea.addEventListener('input', () => {
        feedback[run.id] = textarea.value;
        persistFeedback();
      });
    }

    function renderBenchmark() {
      const benchmark = payload.benchmark;
      if (!benchmark) {
        benchmarkPanel.innerHTML = '<div class="card">No benchmark.json found.</div>';
        return;
      }

      const rows = Object.entries(benchmark.configs || {}).map(([name, stats]) => (
        '<tr><td>' + escapeHtml(name) + '</td><td>' + stats.pass_rate.mean + ' ± ' + stats.pass_rate.stddev + '</td><td>' + stats.time_seconds.mean + ' ± ' + stats.time_seconds.stddev + '</td><td>' + stats.tokens.mean + ' ± ' + stats.tokens.stddev + '</td></tr>'
      )).join('');

      benchmarkPanel.innerHTML = '<div class="card"><h2>Summary</h2><table><thead><tr><th>Config</th><th>Pass rate</th><th>Time (s)</th><th>Tokens</th></tr></thead><tbody>' + rows + '</tbody></table><p class="muted">Delta: pass rate ' + (benchmark.delta?.pass_rate || 'n/a') + ', time ' + (benchmark.delta?.time_seconds || 'n/a') + ', tokens ' + (benchmark.delta?.tokens || 'n/a') + '</p></div>';
    }

    function setTab(tabName) {
      tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
      outputsPanel.classList.toggle('hidden', tabName !== 'outputs');
      benchmarkPanel.classList.toggle('hidden', tabName !== 'benchmark');
    }

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => setTab(tab.dataset.tab));
    });

    if (${staticMode ? 'true' : 'false'}) {
      try {
        Object.assign(feedback, JSON.parse(localStorage.getItem('kodax-skill-review-feedback') || '{}'));
      } catch {}
    }

    renderRunList();
    renderOutputs();
    renderBenchmark();
  </script>
</body>
</html>`;
}

function parseArgs(argv) {
  const args = {
    workspace: argv[2],
    skillName: 'unknown-skill',
    benchmark: null,
    staticOutput: null,
    port: 4173,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--skill-name' && argv[index + 1]) {
      args.skillName = argv[index + 1];
      index += 1;
    } else if (token === '--benchmark' && argv[index + 1]) {
      args.benchmark = argv[index + 1];
      index += 1;
    } else if (token === '--static' && argv[index + 1]) {
      args.staticOutput = argv[index + 1];
      index += 1;
    } else if (token === '--port' && argv[index + 1]) {
      args.port = Number(argv[index + 1]);
      index += 1;
    }
  }

  return args;
}

export async function buildPayload(workspace, args) {
  const benchmarkPath = args.benchmark ?? path.join(workspace, 'benchmark.json');

  return {
    skillName: args.skillName,
    workspace: path.resolve(workspace),
    benchmark: await readJson(benchmarkPath, null),
    feedback: await readJson(path.join(workspace, 'feedback.json'), {}),
    runs: await findRuns(path.resolve(workspace)),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.workspace) {
    console.error('Usage: node scripts/generate-review.js <workspace> [--skill-name name] [--benchmark file] [--static output.html] [--port 4173]');
    process.exit(1);
  }

  const payload = await buildPayload(args.workspace, args);

  if (args.staticOutput) {
    await writeFile(args.staticOutput, renderHtml(payload, true));
    console.log(`Wrote ${args.staticOutput}`);
    return;
  }

  const server = createServer(async (request, response) => {
    if (!request.url || request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(renderHtml(payload, false));
      return;
    }

    if (request.method === 'POST' && request.url === '/feedback') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', async () => {
        try {
          const parsed = JSON.parse(body);
          payload.feedback = parsed;
          await writeFile(path.join(args.workspace, 'feedback.json'), JSON.stringify(parsed, null, 2));
          response.writeHead(204);
          response.end();
        } catch {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Invalid feedback payload');
        }
      });
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  server.listen(args.port, () => {
    console.log(`Review server running at http://127.0.0.1:${args.port}`);
  });
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
