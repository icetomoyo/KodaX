/**
 * Side-chat intent eval (FEATURE_307 R6). Run after the --side-chat-only PTY fixture; contains only synthetic conversations.
 *   tsx benchmark/side-chat-intent.eval.ts <ink-requests.json> <revision> [alias,alias,...] [cell,cell,...] [samples]
 * Defaults: alias ark/v4flash, every cell, 3 samples. Budget pre-registered (FEATURE_307 test guide):
 * 1 call per sample, at most 54 calls and 500k tokens per invocation, 8192 output tokens, 120 s timeout,
 * one request in flight per alias with aliases in parallel.
 * Raw output goes to <os.tmpdir()>/kodax-eval-dumps/feature-307-side-chat-intent/<revision>/.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { SIDE_BOUNDARY_TEXT } from '@kodax-ai/repl';
import { runOneShot } from './harness/harness.js';
import type { ModelAlias } from './harness/aliases.js';
import { INTENT_CELLS, scoreCell, type IntentCell, type Verdict } from './side-chat-intent.cases.js';

const MAX_CALLS = 54;
const MAX_TOTAL_TOKENS = 500_000;

interface CapturedRequest {
  messages: KodaXMessage[];
  tools?: { function: { name: string; description: string; parameters: KodaXToolDefinition['input_schema'] } }[];
}

interface Inputs { system: string; tools: KodaXToolDefinition[]; boundary: KodaXMessage }

async function loadInputs(capture: string): Promise<Inputs> {
  const requests: CapturedRequest[] = JSON.parse(await readFile(capture, 'utf8'));
  const side = requests.find(r => r.tools?.some(t => t.function.name === 'send_to_parent'));
  const system = side?.messages.find(m => m.role === 'system')?.content;
  const boundaryInCapture = side?.messages.some(m => m.content === SIDE_BOUNDARY_TEXT);
  if (!side?.tools || typeof system !== 'string' || !boundaryInCapture) {
    throw new Error('Missing production side prompt, tools or boundary (boundary text drifted from the capture?).');
  }
  const tools = side.tools.map(({ function: f }) => ({ name: f.name, description: f.description, input_schema: f.parameters }));
  return { system, tools, boundary: { role: 'user', content: SIDE_BOUNDARY_TEXT } };
}

/** One alias's lane: cells and samples in order, one request in flight; stops when the shared token ledger is spent. */
async function runLane(alias: string, cells: IntentCell[], samples: number, inputs: Inputs, directory: string, ledger: { tokens: number }) {
  const lane: Record<string, Verdict[]> = {};
  for (const cell of cells) {
    lane[cell.name] = [];
    for (let sample = 0; sample < samples; sample++) {
      if (ledger.tokens >= MAX_TOTAL_TOKENS) throw new Error(`Token budget ${MAX_TOTAL_TOKENS} spent; completed raw output is kept.`);
      const raw = await runOneShot(alias as ModelAlias, { systemPrompt: inputs.system,
        priorMessages: [...(cell.inherited ?? []), inputs.boundary, ...cell.prior],
        userMessage: cell.question, tools: inputs.tools, timeoutMs: 120_000, maxOutputTokens: 8192 });
      ledger.tokens += raw.usage?.totalTokens ?? 8192 + 2000;
      const verdict = scoreCell(cell, raw.toolCalls);
      lane[cell.name].push(verdict);
      await writeFile(path.join(directory, `${alias.replace('/', '_')}-${cell.name}-${sample}.json`),
        JSON.stringify({ ...raw, cell: cell.name, accept: cell.accept, expectWake: cell.wake === true, verdict }, null, 2));
    }
  }
  return lane;
}

async function main() {
  const [capture, revision, aliasArg, cellArg, samplesArg] = process.argv.slice(2);
  if (!capture || !revision) throw new Error('Pass ink-requests.json from the side-chat PTY fixture and a revision name.');
  const aliases = (aliasArg ?? 'ark/v4flash').split(',');
  const cells = cellArg ? INTENT_CELLS.filter(c => cellArg.split(',').includes(c.name)) : INTENT_CELLS;
  const samples = Number(samplesArg ?? 3);
  if (cells.length === 0) throw new Error(`No cell matches ${cellArg}.`);
  if (aliases.length * cells.length * samples > MAX_CALLS) throw new Error(`Over the ${MAX_CALLS}-call budget.`);
  const inputs = await loadInputs(capture);
  const directory = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-307-side-chat-intent', revision);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'inputs.json'), JSON.stringify({ aliases, samples, ...inputs, cells }, null, 2));
  process.stdout.write(directory + '\n');
  const ledger = { tokens: 0 };
  const lanes = await Promise.all(aliases.map(alias => runLane(alias, cells, samples, inputs, directory, ledger)));
  const summary = Object.fromEntries(aliases.map((alias, i) => [alias, lanes[i]]));
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ tokens: ledger.tokens, summary }, null, 2));
  process.stdout.write(JSON.stringify({ tokens: ledger.tokens, summary }) + '\n');
}
void main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
