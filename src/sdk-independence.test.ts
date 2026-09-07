import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FEATURE_298 T27 — release acceptance: the low-level workspace packages stay
 * independently importable and runnable through their own package names, and
 * the published package boundary matches the product Client/Host contract
 * (no worker-facade sidecar, no retired subpaths).
 */
describe('low-level package independence and export boundary', () => {
  it('runs @kodax-ai/llm standalone', async () => {
    const llm = await import('@kodax-ai/llm');
    expect(llm.resolveWireEffort({ provider: 'openai', model: 'gpt-5-mini' }))
      .toBeDefined();
    expect(llm.normalizeReasoningEffortValue('high')).toBeDefined();
  });

  it('runs @kodax-ai/agent standalone', async () => {
    const agent = await import('@kodax-ai/agent');
    expect(agent.sanitizeProjectKey('https://github.com/kodax-ai/kodax.git'))
      .toBeTypeOf('string');
    expect(agent.hashCwd(process.cwd())).toBeTypeOf('string');
  });

  it('runs @kodax-ai/coding standalone', async () => {
    const coding = await import('@kodax-ai/coding');
    // Throws on an invalid custom provider; a complete one validates.
    expect(() => coding.validateCustomProviderConfig({
      name: 'independence-relay',
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: 'INDEPENDENCE_KEY',
    } as unknown as Parameters<typeof coding.validateCustomProviderConfig>[0])).toThrow(/requires name, baseUrl/);
    expect(() => coding.validateCustomProviderConfig({
      name: 'independence-relay',
      protocol: 'openai',
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: 'INDEPENDENCE_KEY',
      model: 'independence-model',
    })).not.toThrow();
  });

  it('runs @kodax-ai/repl standalone', async () => {
    const repl = await import('@kodax-ai/repl');
    expect(
      repl.inferWorkflowLocaleFromParts('run', 'completado'),
    ).toBeTypeOf('string');
  });

  it('publishes the product Client/Host boundary without retired sidecars', () => {
    const manifest = JSON.parse(
      readFileSync(resolve('package.json'), 'utf8'),
    ) as {
      readonly exports: Readonly<Record<string, unknown>>;
      readonly files: readonly string[];
    };
    for (const subpath of [
      '.',
      './client',
      './runtime',
      './sandbox',
      './skills',
      './mcp',
      './session',
      './media',
      './a2a',
    ]) {
      expect(manifest.exports[subpath], `exports["${subpath}"]`).toBeDefined();
    }
    expect(manifest.exports['./experimental-memory']).toBeDefined();
    // The Worker-facade sidecar is retired (T27); the constructed-handler and
    // semantic workers stay.
    expect(manifest.files).not.toContain('dist/runtime-worker.js');
    expect(manifest.files).toContain('dist/constructed-handler-worker.js');
    expect(manifest.files).toContain('dist/semantic-worker.js');
  });
});
