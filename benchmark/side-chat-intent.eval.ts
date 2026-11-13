/**
 * Side-chat intent eval (FEATURE_307 R6). Run after the --side-chat-only PTY fixture; contains only synthetic conversations.
 *   tsx benchmark/side-chat-intent.eval.ts <ink-requests.json> [alias,alias,...]   (default alias: ark/v4flash)
 * Budget (pre-registered in docs/designs/side-chat-plan.md §8.1): 1 call per sample, 3 samples per cell,
 * at most 54 calls, maxOutputTokens 384, 30 s timeout, one request in flight.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { SIDE_BOUNDARY_TEXT } from '@kodax-ai/repl';
import { runOneShot } from './harness/harness.js';
import { INTENT_CELLS, scoreCell, type Verdict } from './side-chat-intent.cases.js';

const SAMPLES = 3;
const MAX_CALLS = 54;

interface CapturedRequest {
  messages: KodaXMessage[];
  tools?: { function: { name: string; description: string; parameters: KodaXToolDefinition['input_schema'] } }[];
}

async function main() {
  const capture = process.argv[2];
  if (!capture) throw new Error('Pass ink-requests.json from the synthetic side-chat PTY fixture.');
  const aliases = (process.argv[3] ?? 'ark/v4flash').split(',');
  if (aliases.length * INTENT_CELLS.length * SAMPLES > MAX_CALLS) throw new Error(`Over the ${MAX_CALLS}-call budget.`);
  const requests: CapturedRequest[] = JSON.parse(await readFile(capture, 'utf8'));
  const side = requests.find(r => r.tools?.some(t => t.function.name === 'send_to_parent'));
  const system = side?.messages.find(m => m.role === 'system')?.content;
  const boundaryInCapture = side?.messages.some(m => m.content === SIDE_BOUNDARY_TEXT);
  if (!side?.tools || typeof system !== 'string' || !boundaryInCapture) {
    throw new Error('Missing production side prompt, tools or boundary (boundary text drifted from the capture?).');
  }
  const tools = side.tools.map(({ function: f }) => ({ name: f.name, description: f.description, input_schema: f.parameters }));
  const boundary: KodaXMessage = { role: 'user', content: SIDE_BOUNDARY_TEXT };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-side-intent-'));
  await writeFile(path.join(directory, 'inputs.json'), JSON.stringify({ aliases, system, tools, cells: INTENT_CELLS }, null, 2));
  process.stdout.write(directory + '\n');
  const summary: Record<string, Record<string, Verdict[]>> = {};
  for (const alias of aliases) {
    summary[alias] = {};
    for (const cell of INTENT_CELLS) {
      summary[alias][cell.name] = [];
      for (let sample = 0; sample < SAMPLES; sample++) {
        const raw = await runOneShot(alias, { systemPrompt: system,
          priorMessages: [...(cell.inherited ?? []), boundary, ...cell.prior],
          userMessage: cell.question, tools, timeoutMs: 30_000, maxOutputTokens: 384 });
        const verdict = scoreCell(cell.expect, raw.toolCalls);
        summary[alias][cell.name].push(verdict);
        await writeFile(path.join(directory, `${alias.replace('/', '_')}-${cell.name}-${sample}.json`),
          JSON.stringify({ alias, cell: cell.name, expect: cell.expect, verdict, ...raw }, null, 2));
      }
    }
  }
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary) + '\n');
}
void main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
