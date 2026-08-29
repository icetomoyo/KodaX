import { describe, expect, it } from 'vitest';

import {
  createProviderCredentialLeaseScope,
  deriveCurrentProviderCredentialLeaseScope,
  getScopedProviderCredential,
  hasScopedProviderCredentialAuthority,
  redactScopedProviderCredential,
  resolveProviderCredential,
  runWithProviderCredentialLeaseScope,
  runWithProviderCredential,
  runWithoutProviderCredentialScope,
  withProviderRequestCredential,
} from './provider-credential-context.js';
import {
  getProvider,
  isProviderConfigured,
  resetBuiltinProviderCache,
} from './providers/registry.js';
import { KodaXRateLimitError } from './errors.js';

describe('provider credential context', () => {
  it('isolates concurrent run credentials and clears them outside the scope', async () => {
    const [first, second] = await Promise.all([
      runWithProviderCredential('openai', 'first-secret', async () => {
        await Promise.resolve();
        return getScopedProviderCredential('openai');
      }),
      runWithProviderCredential('openai', 'second-secret', async () => {
        await Promise.resolve();
        return getScopedProviderCredential('openai');
      }),
    ]);

    expect(first).toBe('first-secret');
    expect(second).toBe('second-secret');
    expect(getScopedProviderCredential('openai')).toBeUndefined();
  });

  it('never falls back to an ambient credential inside a mismatched run scope', () => {
    expect(resolveProviderCredential('openai', 'ambient-secret')).toBe('ambient-secret');

    const resolved = runWithProviderCredential('anthropic', 'leased-secret', () => ({
      matching: resolveProviderCredential('anthropic', 'ambient-secret'),
      mismatched: resolveProviderCredential('openai', 'ambient-secret'),
    }));

    expect(resolved).toEqual({ matching: 'leased-secret', mismatched: undefined });
  });

  it('satisfies provider configuration checks only inside the matching run scope', () => {
    const previous = process.env.KODAX_OPENAI_API_KEY;
    delete process.env.KODAX_OPENAI_API_KEY;
    resetBuiltinProviderCache();
    try {
      expect(isProviderConfigured('openai')).toBe(false);
      expect(getProvider('openai').isConfigured()).toBe(false);

      runWithProviderCredential('openai', 'leased-secret', () => {
        expect(isProviderConfigured('openai')).toBe(true);
        expect(getProvider('openai').isConfigured()).toBe(true);
      });

      expect(isProviderConfigured('openai')).toBe(false);
      expect(getProvider('openai').isConfigured()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.KODAX_OPENAI_API_KEY;
      } else {
        process.env.KODAX_OPENAI_API_KEY = previous;
      }
      resetBuiltinProviderCache();
    }
  });

  it('redacts nested, cyclic, error, key, and non-plain diagnostic values', () => {
    const credential = 'leased-secret';
    const detail: Record<string, unknown> = {
      [`token-${credential}`]: [credential, new Error(`failed with ${credential}`)],
      url: new URL(`https://example.test/?token=${credential}`),
    };
    detail.self = detail;

    const redacted = runWithProviderCredential('openai', credential, () =>
      redactScopedProviderCredential(detail));

    expect(redacted).not.toBe(detail);
    expect(redacted.self).toBe(redacted);
    const { self: _self, ...serializable } = redacted;
    expect(JSON.stringify(serializable)).not.toContain(credential);
    expect(Object.keys(redacted)).toContain('token-[REDACTED_CREDENTIAL]');
    const entries = redacted['token-[REDACTED_CREDENTIAL]'];
    expect(entries).toBeInstanceOf(Array);
    const error = (entries as unknown[])[1];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('failed with [REDACTED_CREDENTIAL]');
    expect(redacted.url).toEqual({});
    expect(redactScopedProviderCredential(detail)).toBe(detail);
  });

  it('rejects empty credential scopes', () => {
    expect(() => runWithProviderCredential('', 'secret', () => undefined)).toThrow(
      'requires non-empty values',
    );
    expect(() => runWithProviderCredential('openai', '', () => undefined)).toThrow(
      'requires non-empty values',
    );
  });

  it('resolves allowed providers lazily and never falls back to ambient credentials', async () => {
    const acquisitions: string[] = [];
    const scope = createProviderCredentialLeaseScope({
      allowedProviders: ['openai', 'anthropic'],
      async acquire(provider) {
        acquisitions.push(provider);
        return `${provider}-leased-secret`;
      },
    });

    await runWithProviderCredentialLeaseScope(scope, async () => {
      expect(hasScopedProviderCredentialAuthority('openai')).toBe(true);
      expect(hasScopedProviderCredentialAuthority('deepseek')).toBe(false);
      expect(resolveProviderCredential('openai', 'ambient-secret')).toBeUndefined();

      await expect(withProviderRequestCredential(
        'openai',
        'primary',
        undefined,
        async () => getScopedProviderCredential('openai'),
      )).resolves.toBe('openai-leased-secret');
      await expect(withProviderRequestCredential(
        'anthropic',
        'fallback',
        undefined,
        async () => getScopedProviderCredential('anthropic'),
      )).resolves.toBe('anthropic-leased-secret');
      await expect(withProviderRequestCredential(
        'deepseek',
        'fallback',
        undefined,
        async () => 'must-not-run',
      )).rejects.toThrow('does not allow provider deepseek');
    });

    expect(acquisitions).toEqual(['openai', 'anthropic']);
  });

  it('invalidates inherited async resources when a lease scope closes', async () => {
    const scope = createProviderCredentialLeaseScope({
      allowedProviders: ['openai'],
      async acquire() {
        return 'leased-secret';
      },
    });
    let resolveDelayed: (() => void) | undefined;
    const delayed = new Promise<void>((resolve) => {
      resolveDelayed = resolve;
    });
    const inherited = runWithProviderCredentialLeaseScope(scope, async () => {
      await delayed;
      return withProviderRequestCredential(
        'openai',
        'primary',
        undefined,
        async () => getScopedProviderCredential('openai'),
      );
    });

    scope.close('operation completed');
    resolveDelayed?.();

    await expect(inherited).rejects.toThrow('is no longer active');
  });

  it('preserves provider error taxonomy while redacting brokered credentials', async () => {
    const secret = 'brokered-provider-secret';
    const scope = createProviderCredentialLeaseScope({
      allowedProviders: ['openai'],
      async acquire() {
        return secret;
      },
    });

    const failure = await runWithProviderCredentialLeaseScope(scope, () =>
      withProviderRequestCredential(
        'openai',
        'primary',
        undefined,
        async () => {
          throw Object.assign(new Error(`request failed with ${secret}`), {
            code: 'ETIMEDOUT',
            status: 504,
            metadata: { detail: `upstream echoed ${secret}` },
          });
        },
      ).catch((error: unknown) => error));

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: 'ETIMEDOUT',
      status: 504,
      metadata: { detail: 'upstream echoed [REDACTED_CREDENTIAL]' },
    });
    expect(String((failure as Error).message)).not.toContain(secret);
  });

  it('preserves typed Provider errors and non-enumerable causes while redacting', async () => {
    const secret = 'typed-provider-secret';
    const scope = createProviderCredentialLeaseScope({
      allowedProviders: ['openai'],
      async acquire() {
        return secret;
      },
    });
    const original = new KodaXRateLimitError(
      `rate limited with ${secret}`,
      250,
      { upstreamCode: `echo-${secret}` },
    );
    Object.defineProperty(original, 'cause', {
      configurable: true,
      value: new Error(`nested ${secret}`),
    });

    const failure = await runWithProviderCredentialLeaseScope(scope, () =>
      withProviderRequestCredential(
        'openai',
        'primary',
        undefined,
        async () => { throw original; },
      ).catch((error: unknown) => error));

    expect(failure).toBeInstanceOf(KodaXRateLimitError);
    expect(failure).not.toBe(original);
    expect(failure).toMatchObject({
      code: 'RATE_LIMIT_ERROR',
      retryAfter: 250,
      metadata: { upstreamCode: 'echo-[REDACTED_CREDENTIAL]' },
    });
    expect((failure as Error & { cause?: Error }).cause).toBeInstanceOf(Error);
    expect((failure as Error & { cause?: Error }).cause?.message)
      .toBe('nested [REDACTED_CREDENTIAL]');
  });

  it('derives only the concrete provider intersection from the active lease', async () => {
    const attributions: unknown[] = [];
    const scope = createProviderCredentialLeaseScope({
      allowedProviders: ['openai', 'anthropic'],
      async acquire(provider, _purpose, _signal, attribution) {
        attributions.push(attribution);
        return `${provider}-secret`;
      },
    });

    await runWithProviderCredentialLeaseScope(scope, async () => {
      const child = deriveCurrentProviderCredentialLeaseScope(['anthropic'], {
        kind: 'actor_turn',
        actorPath: '/root/reviewer',
        turnId: 'turn-1',
      });
      expect(child?.allowedProviders).toEqual(['anthropic']);
      await runWithProviderCredentialLeaseScope(child!, async () => {
        expect(hasScopedProviderCredentialAuthority('anthropic')).toBe(true);
        expect(hasScopedProviderCredentialAuthority('openai')).toBe(false);
        await withProviderRequestCredential(
          'anthropic',
          'agent',
          undefined,
          () => undefined,
        );
      });
      child?.close();
      expect(() => deriveCurrentProviderCredentialLeaseScope(['deepseek'])).toThrow(
        'does not allow provider deepseek',
      );
    });
    expect(attributions).toEqual([{
      kind: 'actor_turn',
      actorPath: '/root/reviewer',
      turnId: 'turn-1',
    }]);
  });

  it('does not retain scoped credentials in the built-in provider cache', () => {
    const ambientFirst = getProvider('openai');
    const ambientSecond = getProvider('openai');
    expect(ambientSecond).toBe(ambientFirst);

    const scoped = runWithProviderCredential('openai', 'leased-secret', () => [
      getProvider('openai'),
      getProvider('openai'),
    ] as const);

    expect(scoped[0]).not.toBe(ambientFirst);
    expect(scoped[1]).not.toBe(scoped[0]);
    expect(getProvider('openai')).toBe(ambientFirst);
  });

  it('suppresses ambient Provider credentials inside an explicit deny-all scope', () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'ambient-secret-must-not-cross';
    try {
      runWithoutProviderCredentialScope(() => {
        expect(resolveProviderCredential('openai', process.env.OPENAI_API_KEY)).toBeUndefined();
        expect(isProviderConfigured('openai')).toBe(false);
        expect(hasScopedProviderCredentialAuthority('openai')).toBe(false);
      });
      expect(isProviderConfigured('openai')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});
