/** Explicit opt-in real-wire smoke: node scripts/openrouter-reasoning-live.mjs --run [pilot|matrix|replay|rejection] [model] */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCustomProvider } from '../packages/llm/dist/index.js';

if (process.argv[2] !== '--run') throw new Error('Real API calls require --run.');
const stage = process.argv[3] ?? 'pilot';
if (!['pilot', 'matrix', 'replay', 'rejection'].includes(stage)) throw new Error('Unknown stage.');
const modelOverride = process.argv[4];
const configFile = path.join(process.env.KODAX_HOME ?? path.join(os.homedir(), '.kodax'), 'config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8')).customProviders
  .find(provider => provider.name.toLowerCase() === 'openrouter');
if (!config || !process.env[config.apiKeyEnv]) throw new Error('Existing OpenRouter configuration/credential unavailable.');
const endpoint = new URL(config.baseUrl);
if (endpoint.origin !== 'https://openrouter.ai') throw new Error('Expected the existing official OpenRouter endpoint.');
const limits = { maxProviderCalls: 16, maxCallsPerCell: 7, maxRoundsPerCell: 2,
  maxOutputTokensPerCall: 2048, maxTotalTokens: 32768, maxExternalSpendUsd: 1, timeoutMs: 60000 };
const stamp = new Date().toISOString().replaceAll(':', '-');
const outputDir = path.join(os.tmpdir(), 'kodax-eval-dumps', 'openrouter-reasoning', `${stamp}-${stage}`);
fs.mkdirSync(outputDir, { recursive: true });
const report = { stage, timestamp: new Date().toISOString(), provider: config.name, model: modelOverride ?? config.model, configuredModel: config.model,
  endpoint: endpoint.origin + endpoint.pathname, limits, interpretation: 'Transport/replay smoke only; no claim of effective reasoning strength.',
  cells: [], calls: [], totalTokens: 0, totalCost: 0 };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const redact = value => String(value).replaceAll(process.env[config.apiKeyEnv], '<REDACTED>');
const save = () => fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
let cell;
let captures = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (report.calls.length >= limits.maxProviderCalls || cell.calls >= limits.maxCallsPerCell
    || report.totalTokens >= limits.maxTotalTokens || report.totalCost >= limits.maxExternalSpendUsd) {
    cell.budgetExhausted = true;
    throw new Error('Frozen live-test budget exhausted.');
  }
  const request = JSON.parse(String(init.body));
  cell.calls++;
  const call = { cell: cell.name, model: request.model, effort: request.reasoning_effort ?? request.reasoning?.effort ?? null,
    stream: request.stream === true, replay: request.messages.filter(message => message.role === 'assistant').map(message => ({
      hasReasoning: typeof message.reasoning === 'string', detailCount: message.reasoning_details?.length ?? 0,
      detailsHash: message.reasoning_details ? hash(message.reasoning_details) : null,
    })) };
  report.calls.push(call);
  const response = await realFetch(url, init);
  call.httpStatus = response.status;
  const capture = response.clone().text().then(raw => {
    // This contains only fixed synthetic prompts and model responses, never headers or credentials.
    fs.writeFileSync(path.join(outputDir, `wire-${report.calls.indexOf(call) + 1}.json`),
      JSON.stringify({ request, status: response.status, response: redact(raw) }, null, 2));
    let decoded = [];
    if (request.stream) {
      decoded = raw.split('\n').filter(line => line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]')
        .map(line => { try { return JSON.parse(line.slice(6)); } catch {
          call.invalidSseFrames = (call.invalidSseFrames ?? 0) + 1;
          return null;
        } }).filter(Boolean);
    } else {
      try { decoded = [JSON.parse(raw)]; } catch { call.invalidJson = true; }
    }
    const usage = decoded.map(item => item.usage).filter(Boolean).at(-1);
    call.usage = usage;
    report.totalTokens += usage?.total_tokens ?? 0;
    report.totalCost += usage?.cost ?? 0;
    const messages = decoded.flatMap(item => item.choices?.map(choice => choice.delta ?? choice.message) ?? []);
    call.reasoningFieldPresence = Object.fromEntries(['reasoning_content', 'reasoning', 'reasoning_details']
      .map(key => [key, { present: messages.filter(message => Object.hasOwn(message, key)).length,
        nonNull: messages.filter(message => message[key] != null).length }]));
    call.reasoningFields = [...new Set(messages.flatMap(message => ['reasoning_content', 'reasoning', 'reasoning_details']
      .filter(key => message[key] != null)))];
    call.detailTypes = [...new Set(messages.flatMap(message => message.reasoning_details?.map(detail => detail.type) ?? []))];
    if (!response.ok) call.error = redact(decoded[0]?.error?.message ?? `HTTP ${response.status}`).slice(0, 1500);
  });
  captures.push(capture);
  return response;
};

const provider = createCustomProvider(config);
const system = 'Follow the request exactly. Keep your final answer short.';
const prompt = 'Reply with exactly OK.';
async function run(name, method, reasoning, messages = [{ role: 'user', content: prompt }], tools = [], extra = {}) {
  cell = { name, method, intent: reasoning?.effort ?? 'auto', calls: 0, rejections: [], started: new Date().toISOString() };
  report.cells.push(cell);
  captures = [];
  const start = Date.now();
  let result;
  try {
    result = await provider[method](messages, tools, system, reasoning, {
      ...extra, modelOverride, maxOutputTokensOverride: limits.maxOutputTokensPerCall,
      onReasoningEffortRejected: event => cell.rejections.push(event),
      onReasoningResolved: event => { cell.resolution = event; },
    }, AbortSignal.timeout(limits.timeoutMs));
    cell.text = result.textBlocks.map(block => block.text).join('');
    cell.stopReason = result.stopReason;
    cell.toolCalls = result.toolBlocks;
    cell.thinkingChars = result.thinkingBlocks.reduce((count, block) => count + (block.thinking?.length ?? 0), 0);
    const details = result.thinkingBlocks.flatMap(block => block.openaiReasoning?.details ?? []);
    cell.detailCount = details.length;
    cell.detailsHash = details.length ? hash(details) : null;
    cell.completed = true;
    fs.writeFileSync(path.join(outputDir, `${name}-result.json`), JSON.stringify(result, null, 2));
  } catch (error) {
    cell.completed = false;
    cell.error = cell.budgetExhausted ? 'Frozen live-test budget exhausted.' : redact(error.message).slice(0, 1500);
  }
  await Promise.all(captures);
  cell.durationMs = Date.now() - start;
  save();
  process.stdout.write(JSON.stringify(cell) + '\n');
  return result;
}

try {
  if (stage === 'pilot') await run('default-complete', 'complete');
  if (stage === 'matrix') {
    await run('default-stream', 'stream');
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      await run(`explicit-${effort}`, 'stream', { effort });
    }
    await run('max-second-turn', 'complete', { effort: 'max' });
  }
  if (stage === 'rejection') {
    await run('invalid-effort-first', 'complete', { effort: 'invalid-e2e-effort' });
    await run('invalid-effort-second', 'complete', { effort: 'invalid-e2e-effort' });
  }
  if (stage === 'replay') {
    const { KODAX_TOOLS } = await import('../packages/coding/dist/index.js');
    const read = KODAX_TOOLS.find(tool => tool.name === 'read');
    if (!read) throw new Error('Production read tool unavailable.');
    const firstPrompt = 'Call read for /virtual/live-test.txt. After its result, reply with the exact value of the token field and nothing else.';
    const history = [{ role: 'user', content: firstPrompt }];
    const first = await run('tool-first', 'stream', { effort: 'high' }, history, [read], { forcedToolName: 'read' });
    if (first?.toolBlocks.length === 1 && first.toolBlocks[0].name === 'read') {
      history.push({ role: 'assistant', content: JSON.parse(JSON.stringify([...first.thinkingBlocks, ...first.textBlocks, ...first.toolBlocks])) });
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: first.toolBlocks[0].id, content: '{"token":"OPENROUTER_REPLAY_OK"}' }] });
      const second = await run('tool-replay', 'complete', { effort: 'high' }, history, [read]);
      report.replayAnswerMatches = second?.textBlocks.map(block => block.text).join('').trim() === 'OPENROUTER_REPLAY_OK';
    } else report.replayBlocked = 'Expected one production read tool call.';
  }
} finally {
  globalThis.fetch = realFetch;
  save();
  if (report.cells.some(item => !item.completed) || report.replayBlocked || report.replayAnswerMatches === false) {
    process.exitCode = 1;
  }
  process.stdout.write(JSON.stringify({ outputDir, calls: report.calls.length, totalTokens: report.totalTokens, totalCost: report.totalCost }) + '\n');
}
