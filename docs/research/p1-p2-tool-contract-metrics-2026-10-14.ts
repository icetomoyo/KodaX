// Offline normalized tool-text comparison against the frozen component inventory.
// node node_modules/vite-node/vite-node.mjs --config vitest.config.ts docs/research/p1-p2-tool-contract-metrics-2026-10-14.ts
import fs from 'node:fs/promises';
import { countTokens } from '../../packages/agent/src/tokenizer.ts';
import { getActiveToolDefinitions } from '../../packages/coding/src/agent-runtime/tool-resolution.ts';
import { getToolDefinition } from '../../packages/coding/src/tools/registry.ts';

interface Measurement { chars: number; bytes: number; estimatedTokens: number }
interface Row extends Measurement { name: string }
const baseline = JSON.parse(await fs.readFile('docs/research/kodax-controlled-input-inventory-2026-10-14.json', 'utf8')) as {
  commit: string; managed: { tools: { rows: Row[] } };
};
if (baseline.commit !== 'bd4479d59cab3d082f07c2d34681fff198d82fa0') throw new Error('Frozen inventory baseline changed; restore the pinned inventory before comparing');
const names = ['ask_user_question', 'todo_create', 'todo_get', 'todo_list', 'todo_update'];
const measure = (text: string): Measurement => ({ chars: text.length, bytes: Buffer.byteLength(text), estimatedTokens: countTokens(text) });
const rows = names.map((name) => {
  const before = baseline.managed.tools.rows.find((row) => row.name === name);
  const [tool] = getActiveToolDefinitions([name]);
  if (!before || !tool) throw new Error(`Missing comparison tool ${name}`);
  const after = measure(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.input_schema }));
  const raw = getToolDefinition(name);
  if (!raw) throw new Error(`Missing raw tool ${name}`);
  return { name, before: { chars: before.chars, bytes: before.bytes, estimatedTokens: before.estimatedTokens }, after,
    savedEstimate: before.estimatedTokens - after.estimatedTokens,
    rawDescription: measure(raw.description) };
});
const report = { baselineCommit: baseline.commit,
  methodology: 'Same normalized {name,description,parameters} per tool and KodaX countTokens as frozen inventory. Source model projection; not API/BPE usage. No provider calls.',
  rows, totalSavedEstimate: rows.reduce((sum, row) => sum + row.savedEstimate, 0),
  noRunnerManagedRemoval: baseline.managed.tools.rows.find((row) => row.name === 'run_skill_script'),
};
await fs.writeFile('docs/research/p1-p2-tool-contract-metrics-2026-10-14.json', JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
