import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KodaXOptions, KodaXTrustedTextMutationHost } from '@kodax-ai/coding';

const mocks = vi.hoisted(() => ({
  clientOptions: [] as KodaXOptions[],
  createTaskRunner: vi.fn(),
  createDefaultAgent: vi.fn(),
  host: {
    snapshot: vi.fn(),
    commit: vi.fn(),
  } as KodaXTrustedTextMutationHost,
  createHost: vi.fn(),
  managed: vi.fn(),
  run: vi.fn(),
  start: vi.fn(),
  substrate: vi.fn(),
}));

vi.mock('@kodax-ai/coding', () => ({
  KodaXClient: class {
    constructor(options: KodaXOptions) {
      mocks.clientOptions.push(options);
    }
  },
  assertTrustedTextMutationPolicy: vi.fn(),
  createDefaultCodingAgent: mocks.createDefaultAgent,
  createKodaXTaskRunner: mocks.createTaskRunner,
  runKodaX: mocks.run,
  runManagedTask: mocks.managed,
  startKodaX: mocks.start,
}));

vi.mock('./windows-text-transaction.js', () => ({
  createTrustedTextMutationHost: mocks.createHost,
}));

import {
  Client,
  createDefaultCodingAgent,
  createKodaXTaskRunner,
  KodaXClient,
  runKodaX,
  runManagedTask,
  startKodaX,
} from './trusted-coding-entry.js';

function options(context: KodaXOptions['context'] = {}): KodaXOptions {
  return { provider: 'test', context };
}

describe('KodaX direct coding entries', () => {
  beforeEach(() => {
    mocks.clientOptions.length = 0;
    mocks.createHost.mockReset().mockReturnValue(mocks.host);
    mocks.createDefaultAgent.mockReset().mockImplementation((overrides) => ({
      name: 'kodax/coding/default',
      instructions: 'coding',
      substrateExecutor: mocks.substrate,
      ...overrides,
    }));
    mocks.createTaskRunner.mockReset().mockImplementation((runnerOptions) => runnerOptions);
    mocks.managed.mockReset().mockResolvedValue({ success: true });
    mocks.run.mockReset().mockResolvedValue({ success: true });
    mocks.start.mockReset().mockReturnValue({ result: Promise.resolve({ success: true }) });
    mocks.substrate.mockReset().mockResolvedValue({ output: 'done', messages: [] });
  });

  it('binds the native trusted-text host to runKodaX workspace options', async () => {
    await runKodaX(options({ gitRoot: 'C:\\repo', executionCwd: 'C:\\repo\\work' }), 'write');

    expect(mocks.createHost).toHaveBeenCalledOnce();
    const roots = mocks.createHost.mock.calls[0]?.[0] as () => readonly string[];
    expect(roots()).toEqual(['C:\\repo', 'C:\\repo\\work']);
    expect(mocks.run.mock.calls[0]?.[0].context?.trustedTextMutationHost).toBe(mocks.host);
  });

  it('preserves an explicit embedder host without creating a competing authority', async () => {
    const explicit = { snapshot: vi.fn(), commit: vi.fn() } as KodaXTrustedTextMutationHost;
    const input = options({ trustedTextMutationHost: explicit });

    await runKodaX(input, 'write');

    expect(mocks.createHost).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls[0]?.[0]).toBe(input);
  });

  it('reads newly registered workspace roots when each transaction starts', async () => {
    const registered: string[] = [];
    await runKodaX(options({
      executionCwd: 'C:\\repo',
      workspaceSandboxRoots: {
        list: () => registered,
        register: vi.fn(),
        unregister: vi.fn(),
      },
    }), 'write');
    const roots = mocks.createHost.mock.calls[0]?.[0] as () => readonly string[];

    registered.push('C:\\linked-worktree');

    expect(roots()).toEqual(['C:\\repo', 'C:\\repo', 'C:\\linked-worktree']);
  });

  it('binds the same default authority to startKodaX and KodaXClient', () => {
    startKodaX(options({ executionCwd: 'C:\\repo' }), 'write');
    new KodaXClient(options({ executionCwd: 'C:\\repo' }));
    new Client(options({ executionCwd: 'C:\\repo' }));

    expect(mocks.start.mock.calls[0]?.[0].context?.trustedTextMutationHost).toBe(mocks.host);
    expect(mocks.clientOptions[0]?.context?.trustedTextMutationHost).toBe(mocks.host);
    expect(mocks.clientOptions[1]?.context?.trustedTextMutationHost).toBe(mocks.host);
    expect(mocks.createHost).toHaveBeenCalledTimes(3);
  });

  it('binds the native authority to the public managed-task entry', async () => {
    await runManagedTask(options({ executionCwd: 'C:\\repo' }), 'write');

    expect(mocks.managed.mock.calls[0]?.[0].context?.trustedTextMutationHost).toBe(mocks.host);
  });

  it('binds the final per-task options for the public task-runner factory', async () => {
    const customRun = vi.fn().mockResolvedValue({ success: true });
    createKodaXTaskRunner({
      baseOptions: options({ executionCwd: 'C:\\repo' }),
      runAgent: customRun,
      createOptions: (_task, _context, defaults) => ({
        ...defaults,
        context: { executionCwd: 'C:\\linked' },
      }),
    });

    const factoryOptions = mocks.createTaskRunner.mock.calls[0]?.[0];
    expect(factoryOptions.baseOptions.context?.trustedTextMutationHost).toBeUndefined();
    const prepared = factoryOptions.createOptions(
      { id: 'task', title: 'task', prompt: 'write' },
      {},
      factoryOptions.baseOptions,
    );
    expect(prepared.context?.trustedTextMutationHost).toBe(mocks.host);
    const preparedRoots = mocks.createHost.mock.calls[0]?.[0] as () => readonly string[];
    expect(preparedRoots()).toEqual(['C:\\linked', 'C:\\linked']);

    await factoryOptions.runAgent(prepared, 'write');
    expect(customRun.mock.calls[0]?.[0].context?.trustedTextMutationHost).toBe(mocks.host);
    expect(mocks.createHost).toHaveBeenCalledOnce();
  });

  it('binds Runner preset options when the public default coding agent executes', async () => {
    const agent = createDefaultCodingAgent();
    const substrate = agent.substrateExecutor as typeof mocks.substrate;
    await substrate(agent, 'write', {
      presetOptions: options({ executionCwd: 'C:\\repo' }),
    });

    expect(mocks.substrate.mock.calls[0]?.[2].presetOptions.context.trustedTextMutationHost)
      .toBe(mocks.host);
  });
});
