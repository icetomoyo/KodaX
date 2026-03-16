import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunKodaX } = vi.hoisted(() => ({
  mockRunKodaX: vi.fn(),
}));

vi.mock('@kodax/coding', async () => {
  const actual = await vi.importActual<typeof import('@kodax/coding')>('@kodax/coding');
  return {
    ...actual,
    runKodaX: mockRunKodaX,
  };
});

import { createInteractiveContext } from './context.js';
import { handleProjectCommand } from './project-commands.js';
import { ProjectStorage } from './project-storage.js';
import type { CommandCallbacks, CurrentConfig } from './commands.js';

function createCallbacks(overrides: Partial<CommandCallbacks> = {}): CommandCallbacks {
  return {
    exit: () => {},
    saveSession: async () => {},
    loadSession: async () => false,
    listSessions: async () => {},
    clearHistory: () => {},
    printHistory: () => {},
    ui: {
      select: async () => undefined,
      confirm: async () => true,
      input: async () => undefined,
    },
    ...overrides,
  };
}

const currentConfig: CurrentConfig = {
  provider: 'zhipu-coding',
  thinking: true,
  reasoningMode: 'auto',
  permissionMode: 'default' as never,
};

describe('project commands', () => {
  const originalCwd = process.cwd();
  let tempDir = '';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-project-commands-'));
    process.chdir(tempDir);

    const storage = new ProjectStorage(tempDir);
    await storage.saveFeatures({
      features: [
        {
          description: 'Implement project quality report',
          passes: true,
          startedAt: '2026-03-17T08:00:00.000Z',
        },
        {
          description: 'Wire guided project status analysis',
          startedAt: '2026-03-17T09:00:00.000Z',
        },
      ],
    });
    await storage.appendProgress('Completed review. Added vitest coverage. Release pending.');
    await storage.writeSessionPlan('- Finish release validation\n- Deploy after checks');

    mockRunKodaX.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('shows a deterministic quality report without AI options', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['quality'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('/project quality - Workflow Health');
    expect(output).toContain('## Project Quality Report');
    expect(output).toContain('Guided Status Summary');
    expect(output).toContain('Suggested next move');
  });

  it('uses AI for guided status questions when model execution is available', async () => {
    mockRunKodaX.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          content: '## Direct assessment\nRelease looks close, but validate the pending feature first.',
        },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['status', 'what', 'is', 'blocking', 'release?'],
      context,
      createCallbacks({
        createKodaXOptions: () =>
          ({
            session: {},
          }) as never,
      }),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    expect(output).toContain('/project status - Guided Analysis');
    expect(output).toContain('## Project Quality Report');
    expect(output).toContain('Release looks close, but validate the pending feature first.');
  });

  it('replaces the old placeholder with a fallback guided summary when AI is unavailable', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['status', 'what', 'is', 'blocking', 'release?'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('AI analysis coming in future release');
    expect(output).toContain('Guided Status Summary');
  });
});
