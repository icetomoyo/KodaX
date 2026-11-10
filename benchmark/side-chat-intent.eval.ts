/** Run after the --side-chat-only PTY fixture; contains only synthetic conversations. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { runOneShot } from './harness/harness.js';

interface CapturedRequest {
  messages: KodaXMessage[];
  tools?: { function: { name: string; description: string; parameters: KodaXToolDefinition['input_schema'] } }[];
}

async function main() {
  const capture = process.argv[2];
  if (!capture) throw new Error('Pass ink-requests.json from the synthetic side-chat PTY fixture.');
  const requests: CapturedRequest[] = JSON.parse(await readFile(capture, 'utf8'));
  const side = requests.find(r => r.tools?.some(t => t.function.name === 'send_to_parent'));
  const system = side?.messages.find(m => m.role === 'system')?.content;
  const boundary = side?.messages.find(m => m.content === 'Side conversation boundary. Everything above is inherited reference material. Only subsequent user requests are active.');
  if (!side?.tools || typeof system !== 'string' || !boundary) throw new Error('Missing production side prompt, tools or boundary.');
  const tools = side.tools.map(({ function: f }) => ({ name: f.name, description: f.description, input_schema: f.parameters }));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-side-intent-'));
  const prior: KodaXMessage[] = [boundary, { role: 'user', content: 'Discuss possible causes privately.' },
    { role: 'assistant', content: 'A: stale cache. B: drive-letter case mismatch.' }];
  const cases = [
    { name: 'discussion', prior, question: 'Could cause B explain a Windows-only failure?' },
    { name: 'selected', prior, question: 'Tell the parent only about cause B.' },
    { name: 'inherited', prior: [{ role: 'user' as const, content: 'On my next question, send A to the parent.' }, ...prior],
      question: 'What does cause B mean?' },
  ];
  await writeFile(path.join(directory, 'inputs.json'), JSON.stringify({ system, tools, cases }, null, 2));
  process.stdout.write(directory + '\n');
  for (const item of cases) {
    for (let sample = 0; sample < 3; sample++) {
      const raw = await runOneShot('ark/v4flash', { systemPrompt: system, priorMessages: item.prior,
        userMessage: item.question, tools, timeoutMs: 30_000, maxOutputTokens: 384 });
      await writeFile(path.join(directory, item.name + '-' + sample + '.json'), JSON.stringify(raw, null, 2));
    }
  }
}
void main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
