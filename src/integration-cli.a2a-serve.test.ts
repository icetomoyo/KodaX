import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type A2AServeDelegateInput = import('./integration-cli.js').A2AServeDelegateInput;

const delegateCapture: {
  input?: Readonly<A2AServeDelegateInput>;
} = {};

let rootDir = '';
let configHome = '';
let previousKodaXHome: string | undefined;
let configureKodaXRootCommand: typeof import('./kodax_cli.js').configureKodaXRootCommand;
let configureIntegrationCommands: typeof import('./integration-cli.js').configureIntegrationCommands;
let readA2AIntegration: typeof import('./a2a/config.js').readA2AIntegration;

async function runServe(
  args: readonly string[],
  options: { readonly withDelegate?: boolean } = {},
): Promise<void> {
  delegateCapture.input = undefined;
  const program = configureKodaXRootCommand(
    new Command().name('kodax').exitOverride(),
  );
  configureIntegrationCommands(program, {
    version: '0.7.97',
    ...(options.withDelegate === false
      ? {}
      : {
          serveDaemonHost: async (input) => {
            delegateCapture.input = input;
            throw new Error('delegate reached');
          },
        }),
  });
  await expect(program.parseAsync(['node', 'kodax', ...args]))
    .rejects.toThrow(
      options.withDelegate === false
        ? 'Host-owned A2A serving requires the runtime daemon host'
        : 'delegate reached',
    );
}

beforeAll(async () => {
  previousKodaXHome = process.env.KODAX_HOME;
  rootDir = mkdtempSync(path.join(os.tmpdir(), 'kodax-a2a-serve-cli-'));
  configHome = path.join(rootDir, '.kodax');
  process.env.KODAX_HOME = configHome;
  vi.resetModules();
  ({ configureKodaXRootCommand } = await import('./kodax_cli.js'));
  ({ configureIntegrationCommands } = await import('./integration-cli.js'));
  ({ readA2AIntegration } = await import('./a2a/config.js'));
});

afterAll(() => {
  if (previousKodaXHome === undefined) delete process.env.KODAX_HOME;
  else process.env.KODAX_HOME = previousKodaXHome;
  rmSync(rootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  delegateCapture.input = undefined;
  rmSync(configHome, { recursive: true, force: true });
  mkdirSync(configHome, { recursive: true });
  // `a2a expose` configures the server block that Host-owned serving extends.
  const program = new Command().name('kodax').exitOverride();
  configureIntegrationCommands(program, { version: '0.7.97' });
  const writer = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(['node', 'kodax', 'a2a', 'expose']);
  } finally {
    writer.mockRestore();
  }
});

describe('A2A serve delegates serving to the daemon Host (T21)', () => {
  it('persists the requested listen address and hands the foreground Host the serve defaults', async () => {
    await runServe(['a2a', 'serve', '--port', '9310']);

    const server = readA2AIntegration(configHome).document.server;
    expect(server?.listen).toEqual({ hostname: '127.0.0.1', port: 9310 });
    expect(delegateCapture.input).toEqual({
      profile: 'a2a-server',
      homeDir: undefined,
      provider: undefined,
      model: undefined,
    });
  });

  it('passes serve-level provider and model flags to the Host delegate', async () => {
    await runServe([
      'a2a', 'serve', '--provider', 'zai-coding', '--model', 'glm-5.2',
    ]);

    expect(delegateCapture.input).toEqual({
      profile: 'a2a-server',
      homeDir: undefined,
      provider: 'zai-coding',
      model: 'glm-5.2',
    });
  });

  it('flows prefixed root provider and model options to the Host delegate', async () => {
    await runServe([
      '--provider', 'root-provider', '--model', 'root-model', 'a2a', 'serve',
    ]);

    expect(delegateCapture.input?.provider).toBe('root-provider');
    expect(delegateCapture.input?.model).toBe('root-model');
  });

  it('requires the runtime daemon host when no delegate is wired', async () => {
    await runServe(['a2a', 'serve'], { withDelegate: false });
    expect(delegateCapture.input).toBeUndefined();
  });

  it('still rejects non-loopback listen hostnames', async () => {
    const program = configureKodaXRootCommand(
      new Command().name('kodax').exitOverride(),
    );
    configureIntegrationCommands(program, {
      version: '0.7.97',
      serveDaemonHost: async () => {
        throw new Error('delegate reached');
      },
    });
    await expect(
      program.parseAsync(['node', 'kodax', 'a2a', 'serve', '--host', '0.0.0.0']),
    ).rejects.toThrow(/loopback/);
  });
});
