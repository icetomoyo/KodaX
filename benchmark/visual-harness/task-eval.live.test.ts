/** Explicit entrypoint only; normal test runs never contact a provider. */
import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runTaskCell, type ProposedMessage } from './task-cell.js';
import { assertTaskDumpDirectory, createTaskTransport } from './task-transport.js';
import { evaluateConfigTask } from './task-workspace.js';

interface Cell {
  id: string; caseId: 'A' | 'B' | 'D'; workspace: string; home: string;
  prompt: string; images: string[]; history?: { text: string; image: string }[];
  files: Record<string, string>;
}
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const directory = process.env.KODAX_VISUAL_TASK_DUMP;
it.skipIf(!directory)('runs one explicitly frozen historical task cell', async () => {
  const root = await assertTaskDumpDirectory(directory!);
  const cell = JSON.parse(await readFile(path.join(root, `${process.env.KODAX_VISUAL_TASK_CELL}.input.json`), 'utf8')) as Cell;
  const online = process.env.KODAX_VISUAL_TASK_MODE === 'online';
  const plan = JSON.parse(await readFile(path.join(root, 'plan.json'), 'utf8')) as { authorization: string; baseline: string; candidate: string };
  for (const [file, sha] of Object.entries(cell.files)) expect(digest(await readFile(path.join(cell.workspace, file)))).toBe(sha);
  const requests: Record<string, unknown>[] = [];
  const transport = online ? await createTaskTransport({ directory: root, cell: cell.id, caseId: cell.caseId,
    authorization: plan.authorization, apiKey: process.env.KIMI_CODE_API_KEY ?? '' }) : undefined;
  let primary = 0;
  let toolSerial = 0;
  const result = await runTaskCell({ ...cell, respond: async (request, signal) => {
    requests.push(request);
    if (transport) return transport.respond(request, signal);
    const tools = JSON.stringify(request.tools) ?? '';
    if (!tools.includes('todo_update')) return { content: '## Goal\nKeep the three supplied console screenshots for a later investigation. They belong to the before-upgrade, immediate-after-upgrade, and later-operation stages.\n## Progress\nRoutine queue health checks completed. The original screenshots remain available in the workspace.\n## Next Steps\nAwait the concrete user question and consult original evidence before drawing conclusions.' };
    primary++;
    const call = (name: string, args: Record<string, unknown>): NonNullable<ProposedMessage['tool_calls']>[number] =>
      ({ id: `offline-${++toolSerial}-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    if (cell.caseId === 'A' && primary === 1) return { content: '', tool_calls: [call('read', { path: 'wiring.png' })] };
    if (cell.caseId === 'B' && primary === 1) return { content: '', tool_calls: tools.includes('visual_history')
      ? [call('visual_history', {})] : [call('read', { path: 'before.png' }), call('read', { path: 'after.png' })] };
    if (cell.caseId === 'B' && primary === 2 && tools.includes('visual_history')) {
      const observations = [...JSON.stringify(request.messages).matchAll(/obs_[a-f0-9-]{36}/g)].map(match => match[0]);
      expect(observations.length).toBeGreaterThan(0);
      return { content: '', tool_calls: [call('visual_inspect', { question: 'Compare the retained console frames.',
        views: [...new Set(observations)].slice(-3).map((observationId, index) => ({ observationId, label: `frame-${index}` })) })] };
    }
    if (cell.caseId === 'D' && primary === 1) return { content: '', tool_calls: [call('read', { path: 'config.mjs' }), call('read', { path: 'config.test.mjs' })] };
    if (cell.caseId === 'D' && primary === 2) return { content: '', tool_calls: [call('bash', { command:
      'node -e "const fs=require(\'fs\');const p=\'config.mjs\';fs.writeFileSync(p,fs.readFileSync(p,\'utf8\').replace(\'JSON.parse(text)\',\'JSON.parse(text.trim() || \\\'{}\\\')\'))"; node --test config.test.mjs', timeout: 10 })] };
    return { content: 'Offline transport fixture completed. This is not a model behavior result.' };
  } });
  const stem = `${cell.id}.${online ? 'online' : 'offline'}`;
  const codeEvidence = cell.caseId === 'D' ? await evaluateConfigTask(path.join(root, 'inputs', 'D'), cell.workspace) : undefined;
  await writeFile(path.join(root, `${stem}.result.json`), JSON.stringify({ ...result, ...codeEvidence }, null, 2), { flag: 'wx' });
  if (transport?.stopped) throw new Error('Global provider/token/spend stop; outcome preserved, remaining cells not executed.');
  if (!online) {
    for (const [index, request] of requests.entries()) await writeFile(path.join(root, `${stem}.${index + 1}.json`), JSON.stringify(request), { flag: 'wx' });
    expect(result.result.phase).toBe('completed');
    expect(result.tools.every(tool => !tool.content.startsWith('[Tool Error]'))).toBe(true);
    expect(result.backgroundSettled).toBe(true);
    if (cell.caseId !== 'D') {
      const afterTools = requests.filter(request => (JSON.stringify(request.tools) ?? '').includes('todo_update')).slice(1);
      for (const file of cell.caseId === 'A' ? ['wiring.png'] : ['before.png', 'after.png']) {
        const original = await readFile(path.join(cell.workspace, file));
        expect(afterTools.some(request => JSON.stringify(request.messages).includes(original.toString('base64'))), `${file} must reach a subsequent serialized request`).toBe(true);
      }
    }
    if (cell.caseId === 'D') expect(codeEvidence?.codeValidation.passed).toBe(true);
    expect(requests.length).toBeLessThanOrEqual(cell.caseId === 'B' ? 5 : 4);
  }
}, 370_000);
