import type { KodaXClassificationAnswer, KodaXClassificationQuestion, KodaXClassificationRequest,
  KodaXClassificationResult, KodaXClassifierConnection } from './types.js';
import { object, operationRequest, operationUsage, runOperation } from './request.js';
import { classifyLlama } from './llama-classify.js';
import { admitOperationImage, imageDataUrl } from './images-data.js';

function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid native classification probability.');
  return value;
}
function distribution(value: unknown, labels: string[]): Record<string, number> {
  const values = object(value);
  if (Object.keys(values).length !== labels.length || labels.some(label => !Object.hasOwn(values, label))) throw new Error('Incomplete native classification distribution.');
  const result = Object.fromEntries(labels.map(label => [label, probability(values[label])]));
  if (Math.abs(Object.values(result).reduce((sum, p) => sum + p, 0) - 1) > 0.02) throw new Error('Unnormalized native classification distribution.');
  return result;
}
function answer(question: KodaXClassificationQuestion, value: unknown): KodaXClassificationAnswer {
  const raw = object(value);
  if (raw.type !== (question.type === 'bool' ? 'noul' : question.type)) throw new Error('Native classification answer type mismatch.');
  if (question.type === 'bool') return { type: 'bool', probability: probability(raw.noul) };
  const labels = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
  const probabilities = distribution(raw.probabilities, labels);
  const confidence = raw.confidence === undefined || raw.confidence === null ? undefined : probability(raw.confidence);
  if (question.type === 'choice') {
    if (typeof raw.choice !== 'string' || !labels.includes(raw.choice)) throw new Error('Unknown native classification choice.');
    return { type: 'choice', choice: raw.choice, ...(confidence !== undefined ? { confidence } : {}), probabilities };
  }
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > labels.length - 1) throw new Error('Invalid native classification score.');
  return { type: 'score', score: raw.score, ...(confidence !== undefined ? { confidence } : {}), probabilities };
}
function validateQuestions(request: KodaXClassificationRequest): void {
  const questions = Object.entries(request.questions);
  if (!questions.length || questions.length > 400 || questions.some(([name, q]) => !name.trim() || typeof q.instructions !== 'string'
    || !['bool', 'choice', 'score'].includes(q.type))) throw new Error('Invalid classification questions.');
  for (const [, q] of questions) {
    if (q.type === 'bool') continue;
    const labels = Object.keys(q.criteria);
    if (labels.length < 2 || labels.length > (q.type === 'score' ? 10 : 255) || labels.some(label => !label.trim())
      || Object.values(q.criteria).some(value => typeof value !== 'string')) throw new Error('Invalid classification criteria.');
  }
}
function decisionsQuestions(request: KodaXClassificationRequest): unknown[] {
  return Object.entries(request.questions).map(([name, q]) => ({ name, instructions: q.type === 'bool' && q.criteria
    ? `${q.instructions}\nBoolean criteria:\n${JSON.stringify(q.criteria)}` : q.instructions,
    type: q.type === 'bool' ? 'predicate' : q.type,
    ...(q.type === 'score' ? { levels: q.criteria } : q.type === 'choice'
      ? { choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description })) } : {}) }));
}
function decisionsAnswers(body: Record<string, unknown>, request: KodaXClassificationRequest): Record<string, unknown> {
  if (!Array.isArray(body.answers) || body.answers.length !== Object.keys(request.questions).length) throw new Error('Incomplete native classification answers.');
  const entries = body.answers.map((value, index) => {
    const raw = object(value);
    const name = Object.keys(request.questions)[index]!;
    if (raw.name !== name) throw new Error('Native classification answer order/name mismatch.');
    if (raw.type === 'refusal') return [name, raw] as const;
    if (raw.type === 'predicate') return [name, { type: 'noul', noul: raw.probability }] as const;
    if (!Array.isArray(raw.probabilities)) throw new Error('Missing native classification distribution.');
    const pairs = raw.probabilities.map(value => { const item = object(value); return [String(item.value), item.probability] as const; });
    if (new Set(pairs.map(([key]) => key)).size !== pairs.length) throw new Error('Duplicate native classification labels.');
    return [name, { ...raw, probabilities: Object.fromEntries(pairs) }] as const;
  });
  return Object.fromEntries(entries);
}
function unwrapCloudflare(body: Record<string, unknown>): Record<string, unknown> {
  if (body.success !== true) throw new Error('Cloudflare classification failed.');
  const result = object(body.result);
  if (result.state !== undefined) {
    if (result.state !== 'Completed') throw new Error('Cloudflare classification run is not completed.');
    return object(result.result);
  }
  if (result.status !== undefined) {
    if (result.status !== 'completed') throw new Error('Cloudflare classification run is not completed.');
    return object(result.result);
  }
  return result;
}
async function classifierEvidence(connection: KodaXClassifierConnection, request: KodaXClassificationRequest, headers: Headers, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const evidence: Record<string, unknown> = { state: request.state };
  const images = [];
  for (const [name, image] of Object.entries(request.images ?? {})) {
    if (!name.trim()) throw new Error('Classification images require non-empty names.');
    images.push([name, await admitOperationImage(image, signal)] as const);
  }
  if (!images.length) return evidence;
  if (connection.api === 'openai-decisions') {
    evidence.input = [{ role: 'user', content: [typeof request.state === 'string' ? { type: 'input_text', text: request.state }
      : { type: 'input_json', data: request.state }, ...images.map(([, image]) => ({ type: 'input_image', image_url: imageDataUrl(image), detail: 'auto' }))] }];
  } else if (connection.dialect === 'openrouter-system-one') {
    evidence.state = [...images.map(([, image]) => ({ type: 'image_url', image_url: { url: imageDataUrl(image) } })), request.state];
  } else if (connection.dialect === 'cloudflare-clef') {
    if (images.length > 4) throw new Error('Clef accepts at most four images.');
    let bytes = 0;
    const { imageSize } = await import('image-size');
    for (const [, image] of images) {
      const buffer = Buffer.from(image.data, 'base64'); bytes += buffer.length;
      const size = imageSize(buffer);
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType) || buffer.length > 4 * 1024 * 1024
        || !size.width || !size.height || size.width * size.height > 16_000_000) throw new Error('Clef image exceeds the native format/size limit.');
    }
    if (bytes > 8 * 1024 * 1024) throw new Error('Clef images exceed the native total limit.');
    evidence.images = images.map(([, image]) => imageDataUrl(image));
  } else {
    if (images.some(([, image]) => !['image/png', 'image/jpeg'].includes(image.mediaType))) throw new Error('System One assets require PNG or JPEG.');
    evidence.assets = Object.fromEntries(images.map(([name, image]) => [name, { type: 'image', format: image.mediaType === 'image/png' ? 'png' : 'jpeg', data_base64: image.data }]));
    evidence.state = [...images.map(([name]) => name), request.state];
    if (connection.api === 'typesafe-system-one') headers.set('TypeSafe-Danger-Zone-Images', 'true');
  }
  return evidence;
}
export async function classify(connection: KodaXClassifierConnection, request: KodaXClassificationRequest, signal?: AbortSignal): Promise<KodaXClassificationResult> {
  connection = { ...connection }; request = structuredClone(request);
  validateQuestions(request);
  if (connection.api === 'llama-cpp-classify') {
    if (Object.keys(request.images ?? {}).length) throw new Error('llama-cpp classification does not support image input.');
    return classifyLlama(connection, request, signal);
  }
  if (!['typesafe-system-one', 'cloudflare-workers-ai-system-one', 'openai-decisions'].includes(connection.api)) throw new Error('Unsupported classifier API.');
  if (connection.api === 'cloudflare-workers-ai-system-one' && !['cloudflare-jev', 'cloudflare-clef'].includes(connection.dialect ?? '')) throw new Error('Select an explicit Cloudflare classifier dialect.');
  if (connection.dialect === 'cloudflare-clef' && (!['clef', 'clef-flash'].includes(connection.model)
    || Object.keys(request.questions).length > 64 || Object.keys(request.questions).some(key => !/^[\w.-]{1,100}$/.test(key)))) throw new Error('Invalid Clef model or questions.');
  return runOperation(connection, 'classifier', signal, async (headers, activeSignal) => {
    const questions = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, { ...q, type: q.type === 'bool' ? 'noul' : q.type }]));
    const evidence: Record<string, unknown> = { ...await classifierEvidence(connection, request, headers, activeSignal), questions };
    const decisions = connection.api === 'openai-decisions';
    const path = decisions ? '/decisions' : connection.api === 'cloudflare-workers-ai-system-one'
      ? connection.dialect === 'cloudflare-jev' ? '/ai/run' : `/ai/run/@cf/cloudflare/${connection.model}` : '/systemone';
    const payload = decisions ? { model: connection.model, input: evidence.input ?? (typeof request.state === 'string' ? request.state
      : [{ role: 'user', content: [{ type: 'input_json', data: request.state }] }]), questions: decisionsQuestions(request) }
      : connection.dialect === 'cloudflare-jev' ? { model: connection.model, input: evidence } : { model: connection.model, ...evidence };
    return operationRequest(connection, path, headers, activeSignal, payload, response => {
      const body = connection.api === 'cloudflare-workers-ai-system-one' ? unwrapCloudflare(response) : response;
      const raw = decisions ? decisionsAnswers(body, request) : object(body.answers);
      if (Object.keys(raw).length !== Object.keys(questions).length) throw new Error('Incomplete native classification answers.');
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name,
        decisions && object(raw[name]).type === 'refusal' ? { type: 'refusal' as const } : answer(q, raw[name])]));
      return { model: typeof body.model === 'string' ? body.model : connection.model, answers, usage: operationUsage(body.usage) };
    });
  }, { retry: !request.singleAttempt });
}
