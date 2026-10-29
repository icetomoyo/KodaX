/** Offline Layer-2 input freeze only. This program has no provider/network execution path. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
interface WireRequest extends Record<string, unknown> {
  messages: { role: string; content: unknown }[];
  tools: unknown[];
}
function request(value: unknown): WireRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an actual captured OpenAI request.');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.messages) || !Array.isArray(record.tools) || !record.tools.length
    || record.messages.at(-1)?.role !== 'user') throw new Error('Captured production messages/tools and final user task are required.');
  return structuredClone(record) as WireRequest;
}

export function freezeVisualPilot(input: { baseline: unknown; candidate: unknown; candidateRevision: string; image: Buffer;
  provider?: string; model?: string }) {
  if (!/^[a-f0-9]{40}$/.test(input.candidateRevision)) throw new Error('Freeze the exact candidate commit.');
  const arms = { baseline: request(input.baseline), candidate: request(input.candidate) };
  for (const arm of Object.values(arms)) {
    if (arm.messages.slice(0, -1).some(message => Array.isArray(message.content)
      && message.content.some(item => item && typeof item === 'object' && ['image_url', 'image', 'input_image'].includes(item.type)))) {
      throw new Error('Existing history images require a separately frozen experiment revision. This pilot accepts text-only production prefixes.');
    }
  }
  const imageSha256 = sha256(input.image);
  const observationId = 'obs_00000000-0000-4000-8000-000000000001';
  const cases = [
    { id: 'exact-rgba', task: `历史参考 ${observationId} 的原始 raster 像素 (1,1) 的 alpha 是否恰为 128？如显示色不足以判断，选择所需证据或明确未核实，不要把合成显示色当原 alpha。`,
      rubric: 'Assess whether the next response seeks relevant original-pixel evidence or gives a calibrated unverified answer. A crop can be useful; only requesting the new tool is not a success criterion. This turn cannot establish post-evidence accuracy.' },
    { id: 'irrelevant-image', task: '17 + 25 等于多少？附图是与此问题无关的旧参考。只需回答算术结果。',
      rubric: '42 with no unnecessary visual/history/remote call is useful. Record any wasted inspection and its reason; this case cannot prove the model never overuses tools.' },
  ];
  const cells = cases.flatMap(probe => (['baseline', 'candidate'] as const).map(arm => {
    const original = arms[arm];
    const frozen = { ...original, model: input.model ?? 'UNRESOLVED', max_completion_tokens: 512,
      messages: [...original.messages.slice(0, -1), { role: 'user', content: [
        { type: 'text', text: `${probe.task}\nFrozen historical fixture: ${observationId}; source=pilot:reference; 3x2; sha256=${imageSha256}; historical. This is a controlled history fixture, not a live environment.` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${input.image.toString('base64')}` } },
      ] }] };
    return { caseId: probe.id, arm, imageSha256, initialFrameCount: 1, historySha256: sha256(JSON.stringify(original.messages.slice(0, -1))), requestSha256: sha256(JSON.stringify(frozen)),
      toolsSha256: sha256(JSON.stringify(original.tools)), rubric: probe.rubric, request: frozen };
  }));
  return { revision: 1, status: 'not-executed' as const, layer: 2, externalCalls: 0,
    baselineRevision: '30310e0018b3c0803653a278f451751a00ccc3bc', candidateRevision: input.candidateRevision,
    provider: input.provider ?? 'UNRESOLVED', model: input.model ?? 'UNRESOLVED', protocol: 'openai',
    routeVerified: false, initialImageSha256: imageSha256,
    sourceRequestHashes: { baseline: sha256(JSON.stringify(arms.baseline)), candidate: sha256(JSON.stringify(arms.candidate)) },
    authorizedBudget: { maxProviderCalls: 0, maxTotalTokens: 0, maxExternalSpendUsd: 0 },
    proposedBudget: { maxProviderCalls: 4, maxCallsPerCell: 1, maxRoundsPerCell: 1, maxOutputTokensPerCall: 512,
      maxTotalTokens: 100_000, maxExternalSpendUsd: 1, timeoutMs: 60_000, maxInFlightPerProvider: 1,
      retries: 0, externalJudgeCalls: 0 },
    restrictions: ['No generation until the human authorizes a frozen provider/model/route and a positive budget.',
      'Layer 2 captures only the next response; never execute emitted tools or expand into a loop.',
      'The proposed USD cap is a stop limit, not a price estimate; verify pricing/usage accounting before execution.',
      'Missing usage, unsupported output cap, timeout or exhausted budget stops the run without retries.',
      'Main-session paired review reads blinded raw before reveal; rubric/case changes create a new revision.',
      'Small-detail, temporal-choice and dynamic-unknown probes remain unexecuted; no aggregate intelligence claim.'], cells };
}

export async function writeVisualPilot(input: { baselineFile: string; candidateFile: string; candidateRevision: string; provider?: string; model?: string }): Promise<string> {
  const { baselineFile, candidateFile, candidateRevision, provider, model } = input;
  const { Jimp } = await import('jimp');
  const png = new Jimp({ width: 3, height: 2, color: 0xffffffff });
  const rgba = [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0x00000000, 0x00ffff80, 0xffffffff];
  rgba.forEach((color, index) => png.setPixelColor(color, index % 3, Math.floor(index / 3)));
  const image = await png.getBuffer('image/png');
  const plan = freezeVisualPilot({ baseline: JSON.parse(await readFile(baselineFile, 'utf8')), candidate: JSON.parse(await readFile(candidateFile, 'utf8')),
    candidateRevision, provider, model, image });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-eval-dumps-visual-freeze-'));
  await writeFile(path.join(directory, 'reference.png'), image, { flag: 'wx' });
  for (const cell of plan.cells) await writeFile(path.join(directory, `${cell.caseId}-${cell.arm}.json`), JSON.stringify(cell.request), { flag: 'wx' });
  await writeFile(path.join(directory, 'plan.json'), JSON.stringify({ ...plan, cells: plan.cells.map(({ request: _request, ...cell }) => cell) }, null, 2), { flag: 'wx' });
  await writeFile(path.join(directory, 'review-template.json'), JSON.stringify({ id: randomUUID(), status: 'not-executed',
    taskValidity: null, substantiveLift: null, credibleRegression: null, cause: null, recommendation: null, reasons: [],
    instruction: 'After authorized generation, randomize paired raw labels and keep arm reveal separate until main-session semantic review is saved.' }, null, 2), { flag: 'wx' });
  return directory;
}
async function main() {
  const [, , baselineFile, candidateFile, candidateRevision, provider, model] = process.argv;
  if (!baselineFile || !candidateFile || !candidateRevision) throw new Error('Usage: node --import tsx benchmark/visual-harness/pilot-plan.ts <baseline-request.json> <candidate-request.json> <candidate-commit> [provider] [model]');
  const directory = await writeVisualPilot({ baselineFile, candidateFile, candidateRevision, provider, model });
  process.stdout.write(`Frozen 4 Layer-2 inputs; external calls 0; behavior not executed: ${directory}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
