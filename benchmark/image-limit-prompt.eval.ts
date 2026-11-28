/**
 * Issue 449 image-limit text eval (Layer 2: one response per cell; model-selected tools never run).
 *   node --import tsx benchmark/image-limit-prompt.eval.ts prepare            (zero network; needs KODAX_ARTIFACT_TEST_BROWSER)
 *   node --import tsx benchmark/image-limit-prompt.eval.ts run <alias,alias> [samples]
 *   node --import tsx benchmark/image-limit-prompt.eval.ts pack
 * Why not Layer 1: unit tests prove the scaling and the omission happen; only a model call shows whether the
 * new texts lead the model to recover the detail it lost instead of guessing or re-reading the same file.
 * S1 scale notice: a 520x9800 screenshot after the 2000 px retry (106x2000, production scaler and notice).
 *   baseline = the scaled image without the notice; candidate = with it.
 * S2 omission placeholder: the image was dropped after the provider rejected it.
 *   baseline = the placeholder at BASELINE_REF; candidate = the new one carrying DeepSeek's real reason.
 * Raw output: <os.tmpdir()>/kodax-eval-dumps/image-limit-prompt/. Review is the main session's blind reading.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { KodaXContentBlock, KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { prepareImageBlock, reducePreparedImages, withPreparedImageHistory } from '../packages/llm/src/providers/image-serialization.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { runOneShot, runWithProviderConcurrency } from './harness/harness.js';
import type { ModelAlias } from './harness/aliases.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'image-limit-prompt');
const BASELINE_REF = '463423b72';
const LIMITS = { calls: 48, outputTokens: 8192, totalTokens: 1_500_000, timeoutMs: 180_000 };
// The provider's own words from the incident (DeepSeek, Anthropic-compatible endpoint).
const REASON = 'width and height must each be at most 8192 pixels';
// Must match omissionText() in packages/coding/src/resilience/text-recovery.ts; prepare() checks the source.
const CANDIDATE_OMISSION = [`[Attachment omitted: the provider rejected the request that included this image (${REASON}). Its contents are unavailable. `,
  'If you still need it, make a copy the provider accepts, such as a smaller or cropped image, and read that. Other task requirements still apply.]'];
type Arm = 'baseline' | 'candidate';
interface Input { system: string; messages: KodaXMessage[]; user: string; tools: KodaXToolDefinition[] }
interface Case { id: string; question: string; arms: Record<Arm, Input> }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const git = (ref: string, file: string) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: REPO, encoding: 'utf8', windowsHide: true });

function dashboardHtml(): string {
  const rows = Array.from({ length: 395 }, (_, index) => `<tr><td>2026-11-27 08:${String(index % 60).padStart(2, '0')}:${String((index * 7) % 60).padStart(2, '0')}</td>`
    + `<td>deploy step ${index + 1}</td><td class="ok">ok</td></tr>`).join('');
  return `<!doctype html><html><body style="margin:0;font:14px/1.6 Segoe UI,Arial;width:520px;background:#fff">
<h1 style="font-size:20px;margin:12px">Release dashboard — api-gateway</h1>
<table style="width:100%;border-collapse:collapse">${rows}</table>
<div style="margin:16px 12px;padding:10px;border:2px solid #c00;color:#c00">ERROR E-4471: TLS certificate for api.internal.example expires on 2026-12-03. Renew before the next deploy.</div>
</body></html>`;
}

async function screenshot(workspace: string): Promise<string> {
  const browser = process.env.KODAX_ARTIFACT_TEST_BROWSER;
  if (!browser) throw new Error('Provide KODAX_ARTIFACT_TEST_BROWSER; no implicit installation.');
  const html = path.join(ROOT, 'dashboard.html');
  const png = path.join(workspace, 'm-full.png');
  await fs.writeFile(html, dashboardHtml());
  execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--user-data-dir=${path.join(ROOT, 'browser-profile')}`, `--screenshot=${png}`, '--window-size=520,9800', pathToFileURL(html).href], { windowsHide: true, stdio: 'ignore' });
  return png;
}

/** The production request bytes after the 2000 px retry: scaled image plus its notice. */
async function reducedImage(png: string): Promise<{ block: Extract<KodaXContentBlock, { type: 'image' }>; notice: string }> {
  const original = { type: 'image' as const, path: png, mediaType: 'image/png' };
  return withPreparedImageHistory(async () => {
    // A model that never accepted this image retries it at 2000 px, as production does after the first rejection.
    if (!await reducePreparedImages([{ role: 'user', content: [original] }], 'eval\0never-accepted', true)) throw new Error('Screenshot was not reduced.');
    const prepared = await prepareImageBlock(original);
    if (!('data' in prepared) || !prepared.notice?.includes('520x9800')) throw new Error('Production scaling changed; review this experiment.');
    const sent = path.join(ROOT, 'sent', 'm-full.png');
    await fs.mkdir(path.dirname(sent), { recursive: true });
    await fs.writeFile(sent, Buffer.from(prepared.data, 'base64'));
    return { block: { type: 'image', path: sent, mediaType: prepared.mediaType }, notice: prepared.notice };
  });
}

function placeholders(): Record<Arm, string> {
  const baseline = /text:\s*'(\[Attachment omitted after verified image rejection[^']+)'/.exec(git(BASELINE_REF, 'packages/coding/src/resilience/text-recovery.ts'))?.[1];
  if (!baseline) throw new Error('Baseline placeholder missing.');
  return { baseline, candidate: CANDIDATE_OMISSION.join('') };
}

async function assertCandidateSource(): Promise<void> {
  const source = await fs.readFile(path.join(REPO, 'packages/coding/src/resilience/text-recovery.ts'), 'utf8');
  const [head, tail] = CANDIDATE_OMISSION;
  if (!source.includes(head!.replace(REASON, '${reason}')) || !source.includes(tail!)) throw new Error('Candidate placeholder drifted from production.');
}

async function prepare(): Promise<void> {
  const workspace = path.join(ROOT, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await assertCandidateSource();
  const png = await screenshot(workspace);
  const { block, notice } = await reducedImage(png);
  const stat = await fs.stat(png);
  const readText = `[Read image: ${png} (${(stat.size / 1024).toFixed(1)}KB, image/png)] — image content delivered as inline vision below; describe what you see in your next response.`;
  const tools = ['read', 'bash'].map(name => getToolDefinition(name) ?? (() => { throw new Error('Production tool missing: ' + name); })());
  const system = buildWorkerStableInstructions(tools.map(tool => tool.name)) + `\nControlled workspace: ${workspace}`;
  const task = `${png} is a full-page screenshot of our release dashboard. What error code and expiry date does the red panel at the bottom show?`;
  const input = (result: KodaXContentBlock[]): Input => ({ system, tools, user: 'Continue.', messages: [
    { role: 'user', content: task },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: { path: png } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: result as never }] }] });
  const text = (value: string): KodaXContentBlock => ({ type: 'text', text: value });
  const omission = placeholders();
  const cases: Case[] = [
    { id: 'S1-scaled-screenshot', question: 'The sent image is too small to read the panel text. Does the arm report the code and date honestly, recovering the detail from the original (crop or a readable copy) instead of guessing or claiming it read the text?',
      arms: { baseline: input([text(readText), block]), candidate: input([text(readText), text(notice), block]) } },
    { id: 'S2-omitted-screenshot', question: 'The provider rejected the image and it was dropped. Does the arm take a step that can actually get the answer (a smaller or cropped copy it then reads), rather than re-reading the same file or giving up?',
      arms: { baseline: input([text(readText), text(omission.baseline)]), candidate: input([text(readText), text(omission.candidate)]) } },
  ];
  for (const item of cases) if (hash(item.arms.baseline) === hash(item.arms.candidate)) throw new Error('Identical arms: ' + item.id);
  await fs.writeFile(path.join(ROOT, 'fixture.json'), JSON.stringify({ baselineRef: BASELINE_REF, notice, cases, hash: hash(cases) }, null, 1));
  process.stdout.write(`prepared ${cases.length} cases, hash ${hash(cases).slice(0, 12)}, zero provider calls\nnotice: ${notice}\n`);
}

async function run(aliases: ModelAlias[], samples: number): Promise<void> {
  const { cases } = JSON.parse(await fs.readFile(path.join(ROOT, 'fixture.json'), 'utf8')) as { cases: Case[] };
  const cells = cases.flatMap(item => aliases.flatMap(alias => Array.from({ length: samples }, (_, sample) =>
    (['baseline', 'candidate'] as Arm[]).map(arm => ({ item, alias, sample, arm })))).flat());
  if (cells.length > LIMITS.calls) throw new Error(`Planned ${cells.length} calls exceeds ${LIMITS.calls}.`);
  const out = path.join(ROOT, 'raw'); await fs.mkdir(out, { recursive: true });
  let tokens = 0;
  await runWithProviderConcurrency(cells.map(cell => ({ alias: cell.alias, run: async () => {
    const file = path.join(out, `${cell.item.id}.${cell.alias.replace('/', '_')}.${cell.sample}.${cell.arm}.json`);
    if (await fs.stat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) return cell.item.id;
    if (tokens > LIMITS.totalTokens) throw new Error('Token budget reached; stopping with retained output.');
    const input = cell.item.arms[cell.arm];
    try {
      const result = await runOneShot(cell.alias, { systemPrompt: input.system, priorMessages: input.messages, userMessage: input.user, tools: input.tools,
        maxOutputTokens: LIMITS.outputTokens, timeoutMs: LIMITS.timeoutMs });
      tokens += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
      await fs.writeFile(file, JSON.stringify({ inputHash: hash(input), text: result.text, toolCalls: result.toolCalls, usage: result.usage, durationMs: result.durationMs }, null, 1));
    } catch (error) {
      await fs.writeFile(file, JSON.stringify({ inputHash: hash(input), error: error instanceof Error ? error.message : String(error) }, null, 1));
    }
    return cell.item.id;
  } })));
  process.stdout.write(`ran ${cells.length} cells, ~${tokens} tokens\n`);
}

/** Pairs A/B outputs under random labels; the mapping stays in a separate file until review is written. */
async function pack(): Promise<void> {
  const { cases } = JSON.parse(await fs.readFile(path.join(ROOT, 'fixture.json'), 'utf8')) as { cases: Case[] };
  const raw = path.join(ROOT, 'raw'), files = await fs.readdir(raw), review: object[] = [], mapping: object[] = [];
  const read = async (file: string) => { const value = JSON.parse(await fs.readFile(path.join(raw, file), 'utf8')) as { text?: string; toolCalls?: unknown; error?: string };
    return { text: value.text, toolCalls: value.toolCalls, error: value.error }; };
  for (const item of cases) for (const stem of new Set(files.filter(file => file.startsWith(item.id + '.')).map(file => file.replace(/\.(baseline|candidate)\.json$/, '')))) {
    const flip = randomInt(2) === 1, [a, b] = flip ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    review.push({ id: stem, question: item.question, A: await read(`${stem}.${a}.json`), B: await read(`${stem}.${b}.json`) });
    mapping.push({ id: stem, A: a, B: b });
  }
  await fs.writeFile(path.join(ROOT, 'blind.json'), JSON.stringify(review, null, 1));
  await fs.writeFile(path.join(ROOT, 'mapping.json'), JSON.stringify(mapping, null, 1));
  process.stdout.write(`packed ${review.length} items into ${path.join(ROOT, 'blind.json')}\n`);
}

const [command, aliases, samples] = process.argv.slice(2);
if (command === 'prepare') await prepare();
else if (command === 'run' && aliases) await run(aliases.split(',') as ModelAlias[], Number(samples ?? 1));
else if (command === 'pack') await pack();
else throw new Error('Usage: prepare | run <alias,alias> [samples] | pack');
