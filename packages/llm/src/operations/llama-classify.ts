import type { KodaXClassificationAnswer, KodaXClassificationQuestion, KodaXClassificationRequest,
  KodaXClassificationResult, KodaXClassifierConnection } from './types.js';
import { object, operationJson, operationRequest, operationUsage, runOperation } from './request.js';

function tokenIds(body: Record<string, unknown>): number[] {
  if (!Array.isArray(body.tokens)) throw new Error('llama-server did not return token IDs.');
  return body.tokens.map(value => {
    const id = typeof value === 'number' ? value : object(value).id;
    if (!Number.isSafeInteger(id) || (id as number) < 0) throw new Error('Invalid llama-server token ID.');
    return id as number;
  });
}
async function labelTokens(connection: KodaXClassifierConnection, labels: string[], headers: Headers, signal?: AbortSignal): Promise<number[]> {
  const tokenize = async (content: string) => tokenIds(await operationJson(connection, '/tokenize', headers, signal,
    { model: connection.model, content, add_special: false, parse_special: false }));
  const prefix = await tokenize('\n');
  const ids: number[] = [];
  for (const label of labels) {
    const tokens = await tokenize(`\n${label}`);
    if (tokens.length !== prefix.length + 1 || prefix.some((id, i) => tokens[i] !== id) || ids.includes(tokens.at(-1)!)) {
      throw new Error('Classifier labels require distinct single tokens after the prompt boundary.');
    }
    ids.push(tokens.at(-1)!);
  }
  return ids;
}
function nextLogprobs(body: Record<string, unknown>, ids: number[]): Array<number | undefined> {
  const rows = body.completion_probabilities ?? body.probs;
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('llama-server did not return one native token distribution.');
  const first = object(rows[0]);
  if (!Array.isArray(first.top_logprobs)) throw new Error('llama-server did not return pre-sampling log-probabilities.');
  const values = new Map<number, number>();
  for (const value of first.top_logprobs) {
    const entry = object(value);
    if (!Number.isSafeInteger(entry.id) || typeof entry.logprob !== 'number' || !Number.isFinite(entry.logprob)
      || entry.logprob > 0 || values.has(entry.id as number)) throw new Error('Invalid llama-server token log-probability.');
    values.set(entry.id as number, entry.logprob);
  }
  return ids.map(id => values.get(id));
}
function labelAnswer(question: KodaXClassificationQuestion, keys: string[], scores: number[]): KodaXClassificationAnswer {
  const max = Math.max(...scores);
  const weights = scores.map(value => Math.exp(value - max));
  const total = weights.reduce((sum, p) => sum + p, 0);
  const probabilities = Object.fromEntries(keys.map((key, i) => [key, weights[i]! / total]));
  if (question.type === 'bool') return { type: 'bool', probability: probabilities.true! };
  const confidence = Math.max(...Object.values(probabilities));
  if (question.type === 'score') return { type: 'score', score: keys.reduce((sum, key) => sum + Number(key) * probabilities[key]!, 0), confidence, probabilities };
  return { type: 'choice', choice: keys[weights.indexOf(Math.max(...weights))]!, confidence, probabilities };
}
export function classifyLlama(connection: KodaXClassifierConnection, request: KodaXClassificationRequest, signal?: AbortSignal): Promise<KodaXClassificationResult> {
  return runOperation(connection, 'classifier', signal, async (headers, activeSignal) => {
    const answers: Record<string, KodaXClassificationAnswer> = {};
    let inputTokens = 0, outputTokens = 0, observedUsage = false;
    for (const [name, question] of Object.entries(request.questions)) {
      const keys = question.type === 'bool' ? ['false', 'true'] : Object.keys(question.criteria);
      const labels = keys.map((_, i) => String(i));
      const ids = await labelTokens(connection, labels, headers, activeSignal);
      const options = Object.fromEntries(labels.map((label, i) => [label, question.type === 'bool' ? question.criteria?.[keys[i] as 'true' | 'false'] ?? keys[i]
        : question.type === 'choice' ? { value: keys[i], description: question.criteria[keys[i]!] } : question.criteria[i]]));
      const rendered = await operationJson(connection, '/apply-template', headers, activeSignal, { model: connection.model, add_generation_prompt: true,
        messages: [{ role: 'system', content: 'Evaluate the supplied evidence. Select exactly one numeric option. Reply with its number only.' },
          { role: 'user', content: JSON.stringify({ state: request.state, instructions: question.instructions, options }) }] });
      if (typeof rendered.prompt !== 'string') throw new Error('llama-server did not return a rendered prompt.');
      let scores: Array<number | undefined> = [];
      for (const depth of [Math.max(32, keys.length * 4), 512, 4096]) {
        const readout = await operationRequest(connection, '/completion', headers, activeSignal,
          { model: connection.model, prompt: `${rendered.prompt}\n`, n_predict: 1, n_probs: depth, post_sampling_probs: false, temperature: 0, cache_prompt: true },
          body => ({ body, usage: operationUsage({ input_tokens: body.tokens_evaluated, output_tokens: body.tokens_predicted }) }));
        if (readout.usage) { observedUsage = true; inputTokens += readout.usage.inputTokens; outputTokens += readout.usage.outputTokens; }
        scores = nextLogprobs(readout.body, ids);
        if (scores.every(value => value !== undefined)) break;
      }
      if (scores.some(value => value === undefined)) throw new Error('llama-server did not rank every classification label within the bounded readout.');
      answers[name] = labelAnswer(question, keys, scores as number[]);
    }
    return { model: connection.model, answers, ...(observedUsage ? { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } } : {}) };
  }, { anonymous: true, retry: !request.singleAttempt });
}
