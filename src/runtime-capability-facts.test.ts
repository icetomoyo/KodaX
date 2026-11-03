import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_CLASSIFIER_RETRY_TIMEOUT_MS } from '@kodax-ai/coding';
import { createKodaXRuntime, KODAX_RUNTIME_SDK_CAPABILITIES } from '../tests/runtime-fixture.js';
import { RUNTIME_AUTO_MODE_GUARDRAIL_CAPABILITY } from './runtime-capability-facts.js';

it('keeps current Host facts, SDK facts and historical package metadata consistent', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    kodaxRuntimeContracts: Record<string, number>;
  };
  const sdk: Readonly<Record<string, number>> = KODAX_RUNTIME_SDK_CAPABILITIES;
  for (const [name, version] of Object.entries(pkg.kodaxRuntimeContracts)) {
    if (name === 'integrationConfigResilience') continue; // Historical metadata, not a handshake requirement.
    expect(sdk[name], name).toBe(version);
  }
  expect(RUNTIME_AUTO_MODE_GUARDRAIL_CAPABILITY.retryClassifierTimeoutMs).toBe(DEFAULT_CLASSIFIER_RETRY_TIMEOUT_MS);
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-capability-facts-'));
  const runtime = await createKodaXRuntime({ homeDir: root });
  try {
    expect(runtime.capabilities?.runtimeAutoModeGuardrail).toEqual(RUNTIME_AUTO_MODE_GUARDRAIL_CAPABILITY);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
