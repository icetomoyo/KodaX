/**
 * FEATURE_320 artifact tool-description eval (Layer 2: one response per cell; model-selected tools never run).
 *   node --import tsx benchmark/artifact-temporal-prompt.eval.ts prepare            (zero network; needs KODAX_ARTIFACT_TEST_BROWSER and _FFMPEG)
 *   node --import tsx benchmark/artifact-temporal-prompt.eval.ts run <alias,alias> [samples]
 *   node --import tsx benchmark/artifact-temporal-prompt.eval.ts pack
 * Why not Layer 1: unit tests prove the runtime decodes GIF/WebP/video; only a model call shows whether the
 * rewritten artifact_open/artifact_capture descriptions lead to temporal capture at sensible times, and whether
 * they disturb neighbouring static-image and SVG choices.
 * Arms: candidate = production tool definitions from the working tree; baseline = the same tools with the
 * open/capture descriptions restored from BASELINE_REF. Histories carry real runtime results from the fixtures.
 * Candidate-only cases need the new runtime output (the baseline runtime cannot open GIF or video), so they
 * measure adoption, not lift. T3 is an A/B on the artifact-review skill body instead: both arms use candidate
 * tools and a real ffmpeg timeline; only the loaded SKILL.md differs (baseline from BASELINE_REF).
 * Raw output: <os.tmpdir()>/kodax-eval-dumps/artifact-temporal-prompt/. Review is the main session's blind reading.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import type { KodaXExtensionAPI } from '../packages/coding/src/index.js';
import { expandSkillForLLM, loadFullSkill } from '../packages/agent/src/index.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { registerArtifactTools } from '../packages/artifacts/src/kodax.js';
import { executeArtifactRequest } from '../packages/artifacts/src/runtime.js';
import { runOneShot, runWithProviderConcurrency } from './harness/harness.js';
import type { ModelAlias } from './harness/aliases.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'artifact-temporal-prompt');
const BASELINE_REF = '361c0c0b5';
const LIMITS = { calls: 60, outputTokens: 4096, totalTokens: 1_500_000, timeoutMs: 120_000 };
type Arm = 'baseline' | 'candidate';
interface Input { system: string; messages: KodaXMessage[]; user: string; tools: KodaXToolDefinition[] }
interface Case { id: string; question: string; arms: Partial<Record<Arm, Input>> }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wire = (operation: string, value: object) => JSON.stringify({ ...value, protocol: 'kodax-artifact/1', operation });
const call = (id: string, name: string, input: object, result: string): KodaXMessage[] => [
 { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
 { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] }];

/** Skill tool output for one arm. Both arms report the production skill path so the block does not reveal the arm. */
async function skillBlock(arm: Arm): Promise<string> {
 const dir = path.join(REPO, 'packages/artifacts/skills/artifact-review');
 let loadFrom = dir;
 if (arm === 'baseline') {
  loadFrom = path.join(ROOT, 'baseline-skill', 'artifact-review'); await fs.mkdir(loadFrom, { recursive: true });
  await fs.writeFile(path.join(loadFrom, 'SKILL.md'), execFileSync('git', ['show', `${BASELINE_REF}:packages/artifacts/skills/artifact-review/SKILL.md`], { cwd: REPO, encoding: 'utf8', windowsHide: true }));
 }
 const skill = await loadFullSkill(loadFrom, 'plugin');
 if (!skill) throw new Error('artifact-review skill did not load: ' + arm);
 return (await expandSkillForLLM({ ...skill, path: dir }, '', { workingDirectory: ROOT, projectRoot: ROOT, disableDynamicContext: true })).content;
}

function productionTools(arm: Arm): KodaXToolDefinition[] {
 const tools: KodaXToolDefinition[] = [];
 const api = { registerTool: (tool: KodaXToolDefinition) => { tools.push({ name: tool.name, description: tool.description, input_schema: tool.input_schema }); return () => undefined; },
  registerSkillPath: () => () => undefined } as unknown as KodaXExtensionAPI;
 registerArtifactTools(api, { execute: async () => '', nodeExecutable: process.execPath });
 const bash = getToolDefinition('bash');
 if (!bash || tools.length !== 9) throw new Error('Production tool registration changed; review this experiment.');
 if (arm === 'candidate') return [bash, ...tools];
 const source = execFileSync('git', ['show', `${BASELINE_REF}:packages/artifacts/src/kodax.ts`], { cwd: REPO, encoding: 'utf8', windowsHide: true });
 const old = (operation: string) => new RegExp(`\\b${operation}: \\{ description: '([^']+)'`).exec(source)?.[1] ?? (() => { throw new Error('Baseline text missing: ' + operation); })();
 return [bash, ...tools.map(tool => tool.name === 'artifact_open' ? { ...tool, description: old('open') } : tool.name === 'artifact_capture' ? { ...tool, description: old('capture') } : tool)];
}

async function prepare(): Promise<void> {
 const browserExecutable = process.env.KODAX_ARTIFACT_TEST_BROWSER;
 const ffmpegExecutable = process.env.KODAX_ARTIFACT_TEST_FFMPEG;
 if (!browserExecutable || !ffmpegExecutable) throw new Error('Provide KODAX_ARTIFACT_TEST_BROWSER and KODAX_ARTIFACT_TEST_FFMPEG; no implicit installation.');
 const workspace = path.join(ROOT, 'workspace');
 await fs.mkdir(workspace, { recursive: true });
 await fs.copyFile(path.join(REPO, 'tests/fixtures/artifacts/animated.gif'), path.join(workspace, 'loading.gif'));
 await fs.copyFile(path.join(REPO, 'tests/fixtures/artifacts/clip.webm'), path.join(workspace, 'intro.webm'));
 const options = { workspaceRoot: workspace, browserExecutable, maxRenderPages: 4 };
 const gif = await executeArtifactRequest({ operation: 'open', input: { path: 'loading.gif' } }, options);
 const video = await executeArtifactRequest({ operation: 'open', input: { path: 'intro.webm' } }, options);
 const videoCapture = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'intro.webm',
  locators: [{ kind: 'temporal', time: 0 }, { kind: 'temporal', time: 2.9 }] } }, options);
 const decoded = await executeArtifactRequest({ operation: 'open', input: { path: 'intro.webm' } }, { ...options, ffmpegExecutable });
 if (!gif.diagnostics.some(item => item.code === 'timeline') || !videoCapture.diagnostics.some(item => item.code === 'ffmpeg-unavailable')
  || !decoded.diagnostics.some(item => item.code === 'timeline')) throw new Error('Runtime fixture output changed.');
 const skillTool = getToolDefinition('skill');
 if (!skillTool) throw new Error('Production skill tool missing; review this experiment.');
 const toolSets = { baseline: productionTools('baseline'), candidate: productionTools('candidate') };
 const input = (arm: Arm, user: string, messages: KodaXMessage[] = []): Input => ({ tools: toolSets[arm], messages, user,
  system: buildWorkerStableInstructions(toolSets[arm].map(tool => tool.name)) + `\nControlled workspace: ${workspace}` });
 const both = (user: string) => ({ baseline: input('baseline', user), candidate: input('candidate', user) });
 const gifTask = 'Review loading.gif before I post it in the release notes. Check that every state of the loop looks right.';
 const videoTask = 'Check intro.webm before I publish it: the title card at the start and the final frame must both look right.';
 const skillInput = async (arm: Arm): Promise<Input> => ({ ...input('candidate', 'Continue.', [{ role: 'user', content: videoTask },
  ...call('skill', 'skill', { skill: 'artifact-review' }, await skillBlock(arm)),
  ...call('open', 'artifact_open', { path: 'intro.webm' }, wire('open', decoded))]), tools: [...toolSets.candidate, skillTool] });
 const cases: Case[] = [
  { id: 'T1-gif-after-open', question: 'Does the next step capture temporal samples whose times reach each distinct frame state from the reported timeline, without treating open as review?',
   arms: { candidate: input('candidate', 'Continue the review.', [{ role: 'user', content: gifTask }, ...call('open', 'artifact_open', { path: 'loading.gif' }, wire('open', gif))]) } },
  { id: 'T2-video-no-ffmpeg', question: 'After ffmpeg is unavailable, does the model keep the video unverified, name the missing decoder, and avoid fabricated frames or unauthorized installation?',
   arms: { candidate: input('candidate', 'Continue.', [{ role: 'user', content: videoTask },
    ...call('open', 'artifact_open', { path: 'intro.webm' }, wire('open', video)),
    ...call('cap', 'artifact_capture', { kind: 'temporal', target: 'intro.webm', locators: [{ kind: 'temporal', time: 0 }, { kind: 'temporal', time: 2.9 }] }, wire('capture', videoCapture))]) } },
  { id: 'T3-skill-video-end', question: 'Does the next capture sample the start and an end time at least one frame interval before the reported duration, so the final frame is actually returned?',
   arms: { baseline: await skillInput('baseline'), candidate: await skillInput('candidate') } },
  { id: 'C1-gif-entry', question: 'For a GIF review from scratch, which arm gets to real frame evidence (open/temporal capture) more directly and honestly?', arms: both(gifTask) },
  { id: 'C2-static-png', question: 'For a static PNG, does the arm still choose static render/capture rather than temporal sampling?', arms: both('Check chart.png for clipped axis labels before I send it to the client.') },
  { id: 'C3-svg-smil', question: 'For an SMIL SVG, does the arm still capture temporal samples at sensible seconds?', arms: both('Review spinner.svg (an SMIL animation, 2s loop): check the start and the half-way point of the spin.') },
 ];
 await fs.writeFile(path.join(ROOT, 'fixture.json'), JSON.stringify({ baselineRef: BASELINE_REF, cases, hash: hash(cases) }, null, 1));
 process.stdout.write(`prepared ${cases.length} cases, hash ${hash(cases).slice(0, 12)}, zero provider calls\n`);
}

async function run(aliases: ModelAlias[], samples: number): Promise<void> {
 const { cases } = JSON.parse(await fs.readFile(path.join(ROOT, 'fixture.json'), 'utf8')) as { cases: Case[] };
 const cells = cases.flatMap(item => aliases.flatMap(alias => Array.from({ length: samples }, (_, sample) =>
  (Object.keys(item.arms) as Arm[]).map(arm => ({ item, alias, sample, arm })))).flat());
 if (cells.length > LIMITS.calls) throw new Error(`Planned ${cells.length} calls exceeds ${LIMITS.calls}.`);
 const out = path.join(ROOT, 'raw'); await fs.mkdir(out, { recursive: true });
 let tokens = 0;
 await runWithProviderConcurrency(cells.map(cell => ({ alias: cell.alias, run: async () => {
  const file = path.join(out, `${cell.item.id}.${cell.alias.replace('/', '_')}.${cell.sample}.${cell.arm}.json`);
  if (await fs.stat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) return cell.item.id;
  if (tokens > LIMITS.totalTokens) throw new Error('Token budget reached; stopping with retained output.');
  const input = cell.item.arms[cell.arm]!;
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
  if (!item.arms.baseline) { review.push({ id: stem, question: item.question, candidate: await read(stem + '.candidate.json') }); continue; }
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
