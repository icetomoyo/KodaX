/** Controlled Layer 3 probe of the production helper: exactly diagnosis -> continuation, no tools executed. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KODAX_PROVIDERS } from '../packages/llm/dist/index.js';
import { withPreparedImageHistory, prepareHistoryImages } from '../packages/llm/dist/providers/image-serialization.js';
import { createTextRecoveryState, tryTextRecovery, projectTextRecovery } from '../packages/coding/dist/resilience/text-recovery.js';

assert.equal(process.env.KODAX_TEXT_RECOVERY_LIVE, '1', 'Explicit live opt-in required');
const root = path.resolve('.tmp', 'text-recovery-20260914');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'production-r5-'));
const limits = { maxProviderCalls: 8, maxCallsPerCell: 2, maxRoundsPerCell: 2, maxOutputTokensPerCall: 8192,
  maxTotalTokens: 100000, maxExternalSpendUsd: 10, timeoutMs: 90000 };
let calls = 0, reserved = 0, reportedTokens = 0;
const routes = [
  ['zhipu-coding', 'ZHIPU_CODING_API_KEY', 'glm-5.3-flash', 'https://open.bigmodel.cn/api/anthropic/v1/messages'],
  ['zai-coding', 'ZAI_CODING_API_KEY', 'glm-5.3-flash', 'https://api.z.ai/api/anthropic/v1/messages'],
  ['deepseek', 'DEEPSEEK_API_KEY', 'deepseek-flash', 'https://api.deepseek.com/anthropic/v1/messages'],
  ['kimi-code', 'KIMI_CODE_API_KEY', 'k3-256k', 'https://api.kimi.com/coding/v1/messages'],
];
const bytes = await readFile(new URL('./fixtures/images/valid-png.png', import.meta.url));
const file = path.join(directory, 'header.png'); await writeFile(file, bytes);
const history = [
  { role: 'user', content: '按律所模板准备三项服务的报价。' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'read_header', name: 'read', input: { path: file } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_header', content: [
    { type: 'text', text: '已生成旧报价草稿；这是页眉预览，后续调价尚未执行。' }, { type: 'image', path: file },
  ] }] },
  { role: 'user', content: '报价改成五万元。' },
  { role: 'user', content: '最新要求：总价六万元，三项服务每项两万元，全部在启动前支付。请先给出调整后的文字条款，不操作文件。' },
];
const system = 'You are the document assistant continuing the user task. Never claim a file was edited without tool evidence.';
const original = JSON.stringify(history);
await writeFile(path.join(directory, 'design.json'), JSON.stringify({ limits, history, system,
  question: 'Does the implemented production diagnostic prompt produce an evidence-backed plan and preserve the latest requirements?',
  revision: 'r5: repeat only lost-raw samples after the OS temp evidence directory disappeared during r4; provider errors are not retried.',
  method: 'Layer 3, one controlled image rejection, production helper, fixed two-call graph; no prompt comparison; no tools executed.',
  expected: 'omit only the precisely identified attachment; continuation says total 60000, three items 20000 each, all before starting; no claimed file edits or invented visual details.',
  spending: 'Conservative reservation at $100 per million reserved character/output units, not an estimate of actual provider tariff; stop before $10 or 100000 reserved units.' }, null, 2));
const requested = process.argv.slice(2);
await Promise.all(routes.filter(route => !requested.length || requested.includes(route[0])).map(async ([name, keyEnv, model, endpoint]) => {
  const key = process.env[keyEnv];
  const record = { provider: name, model, endpoint, rounds: [], usage: [] };
  if (!key) record.error = 'credential not configured';
  else await withPreparedImageHistory(async () => {
    const provider = KODAX_PROVIDERS[name]();
    const injected = async request => {
      const locate = (value, address) => {
        if (!value || typeof value !== 'object') return;
        if (value.type === 'image' && value.source?.data) return address;
        for (const [key, child] of Object.entries(value)) {
          const found = locate(child, `${address}${/^\d+$/.test(key) ? `[${key}]` : `.${key}`}`);
          if (found) return found;
        }
      };
      const address = locate(request.messages, 'messages'); assert.ok(address);
      throw Object.assign(new Error(`Invalid image format at ${address}`), { status: 400 });
    };
    Reflect.set(provider, '_client', { messages: { create: injected } });
    await prepareHistoryImages(history);
    let failure;
    try { await provider.complete(history, [], system, false, { modelOverride: model, singleAttempt: true }); }
    catch (error) { failure = error; }
    assert.ok(failure instanceof Error);
    record.injectedError = failure.message;
    Reflect.set(provider, '_client', { messages: { create: async (request, options) => {
      assert.equal(request.stream, undefined);
      assert.equal(options?.maxRetries, 0);
      const body = JSON.stringify(request);
      const reservation = body.length + limits.maxOutputTokensPerCall;
      assert.ok(calls < limits.maxProviderCalls && record.rounds.length < 2
        && reserved + reservation <= limits.maxTotalTokens && (reserved + reservation) * 0.0001 <= limits.maxExternalSpendUsd);
      calls++; reserved += reservation;
      const round = { request, hash: createHash('sha256').update(body).digest('hex') }; record.rounds.push(round);
      const started = Date.now();
      try {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
          'anthropic-version': '2023-06-01', 'x-api-key': key, 'user-agent': 'KodaX', ...options?.headers }, body,
          signal: AbortSignal.any([options?.signal ?? new AbortController().signal, AbortSignal.timeout(limits.timeoutMs)]) });
        round.httpStatus = response.status; round.raw = await response.text();
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        const parsed = JSON.parse(round.raw); round.stopReason = parsed.stop_reason;
        const usage = parsed.usage ?? {};
        reportedTokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        return parsed;
      } finally { round.durationMs = Date.now() - started; }
    } } });
    try {
      const state = createTextRecoveryState();
      record.recovered = await tryTextRecovery({ state, error: failure, messages: history, provider, system, model,
        reasoning: { enabled: true, effort: 'low' }, maxOutputTokens: limits.maxOutputTokensPerCall,
        attempt: 1, maxAttempts: 3, timeoutMs: limits.timeoutMs,
        onStart() {}, onUsage(usage) { record.usage.push(usage); } });
      if (record.recovered) {
        const projected = projectTextRecovery(history, state);
        assert.ok(!JSON.stringify(projected).includes('"type":"image"'));
        record.continuation = await provider.complete(projected, [], system, { enabled: true, effort: 'low' },
          { modelOverride: model, maxOutputTokensOverride: limits.maxOutputTokensPerCall, singleAttempt: true });
      } else record.error = failure.message;
      assert.equal(JSON.stringify(history), original);
      assert.deepEqual(await readFile(file), bytes);
    } catch (error) { record.error = error.message; }
  });
  await writeFile(path.join(directory, `${name}.json`), JSON.stringify(record, null, 2).replaceAll(key ?? '[absent-key]', '[REDACTED]'));
  process.stdout.write(`${name}: recovered=${record.recovered ?? false}, calls=${record.rounds.length}, ${record.error ?? record.continuation?.stopReason}\n`);
}));
await writeFile(path.join(directory, 'budget.json'), JSON.stringify({ limits, calls, reserved, reportedTokens,
  note: 'Reservations include timed-out calls; completed-response usage only. No additional retries.' }, null, 2));
process.stdout.write(`Evidence: ${directory}\n`);
