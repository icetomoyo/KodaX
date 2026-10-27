import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCustomProvider } from '@kodax-ai/llm';
import { assertProbeSettled, originalVersionCheckpoints } from './original-version-probe.eval.js';
import { measureModelFields } from './first-turn-uniform-costs.js';
import type { FrozenInput } from './first-turn-eval-support.js';

it('tolerates settled USD subtraction roundoff without forgiving pending calls or unknown charges', () => {
  const state = { calls: 4, chargedTokens: 72247, reservedTokens: 0, chargedUsd: 0.00204347,
    reservedUsd: 8.673617379884035e-19, unknownUsageCalls: 0 };
  expect(() => assertProbeSettled(state)).not.toThrow();
  expect(() => assertProbeSettled({ ...state, reservedTokens: 1 })).toThrow();
  expect(() => assertProbeSettled({ ...state, reservedUsd: 0.000001 })).toThrow();
  expect(() => assertProbeSettled({ ...state, unknownUsageCalls: 1 })).toThrow();
});

it('requires both real native checkpoints and rejects duplicate or Script inputs', () => {
  const input = { system: 'production', messages: [], tools: [{ name: 'read', description: 'read', input_schema: {} }] };
  const checkpoints = ['coding-symptom-repair', 'coding-verification-followup'].map(id => ({ id, input }));
  expect(originalVersionCheckpoints({ externalCalls: 0, checkpoints })).toHaveLength(2);
  expect(() => originalVersionCheckpoints({ externalCalls: 1, checkpoints })).toThrow();
  expect(() => originalVersionCheckpoints({ externalCalls: 0, checkpoints: [checkpoints[0], checkpoints[0]] })).toThrow();
  expect(() => originalVersionCheckpoints({ externalCalls: 0, checkpoints: checkpoints.map(row => ({ ...row,
    input: { ...input, tools: [{ name: 'script_exec', description: 'script', input_schema: {} }] } })) })).toThrow();
});

it.skipIf(!process.env.KODAX_ORIGINAL_PAIRED_CAPTURE)('serializes the same frozen first/second-turn histories with the actual SDK without network', async () => {
  const directory = path.resolve(process.env.KODAX_ORIGINAL_PAIRED_CAPTURE!);
  const relative = path.relative(os.tmpdir(), directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Use the explicit OS Temp capture');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-original-history-wire-'));
  const rows: unknown[] = [];
  let wire: unknown;
  let fetches = 0;
  vi.stubEnv('KODAX_HISTORY_FIXTURE_KEY', 'synthetic-only');
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://history-fixture.invalid/')) throw new Error('No external network allowed');
    const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    if (typeof body !== 'string') throw new Error('Expected serialized JSON');
    wire = JSON.parse(body) as unknown; fetches++;
    return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"offline"},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const provider = createCustomProvider({ name: 'history-fixture', protocol: 'openai', model: 'fixture-model',
      baseUrl: 'https://history-fixture.invalid/v1', apiKeyEnv: 'KODAX_HISTORY_FIXTURE_KEY' });
    for (const version of ['old', 'current']) {
      const capture = JSON.parse(await fs.readFile(path.join(directory, `${version}-capture.json`), 'utf8')) as {
        externalCalls: number; checkpoints: { id: string; input: FrozenInput }[];
      };
      originalVersionCheckpoints(capture);
      for (const checkpoint of capture.checkpoints) {
        wire = undefined;
        await provider.stream([...checkpoint.input.messages], [...checkpoint.input.tools], checkpoint.input.system,
          false, { singleAttempt: true });
        expect(wire).toBeDefined();
        const metrics = measureModelFields(wire);
        rows.push({ version, checkpoint: checkpoint.id, ...metrics });
        await fs.writeFile(path.join(root, `${version}-${checkpoint.id}.json`), JSON.stringify(wire, null, 2), { flag: 'wx' });
      }
    }
    expect(fetches).toBe(6);
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ externalCalls: 0,
      scope: 'Current OpenAI SDK transport, frozen original/current Runtime histories. Sum of requests is fixed-trace input, not completed-task usage.', rows }, null, 2), { flag: 'wx' });
    process.stdout.write(`Original/current history SDK wire: ${root}\n`);
  } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
}, 30000);
