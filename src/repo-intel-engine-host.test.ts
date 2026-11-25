import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RepoIntelSupervisor } from '@kodax-ai/coding';
import {
  createRepoIntelEngineHost, inspectRepoIntelEngine, locateRepoIntelEngine, relayRunEventToRepoIntel,
} from './repo-intel-engine-host.js';

const program = `kodax-repo-intel${process.platform === 'win32' ? '.exe' : ''}`;
const builtEngine = path.resolve('native', 'repo-intel', 'target', 'release', program);
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'kodax-repo-intel-host-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function place(...segments: string[]): string {
  const file = path.join(scratch, ...segments);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
  return file;
}

const moduleUrl = (): string => pathToFileURL(path.join(scratch, 'dist', 'index.js')).href;

describe('locateRepoIntelEngine', () => {
  it('takes the program the environment names, and reports it missing when it is not there', () => {
    const named = place('elsewhere', program);
    expect(locateRepoIntelEngine({ KODAX_REPO_INTELLIGENCE_ENGINE_PATH: named }, moduleUrl())).toEqual({ path: named, searched: [named] });
    const missing = path.join(scratch, 'nowhere', program);
    expect(locateRepoIntelEngine({ KODAX_REPO_INTELLIGENCE_ENGINE_PATH: missing }, moduleUrl())).toEqual({ searched: [missing] });
  });

  it('finds the program shipped beside the package for this platform', () => {
    const shipped = place('dist', 'native', `${process.platform}-${process.arch}`, program);
    expect(locateRepoIntelEngine({}, moduleUrl()).path).toBe(shipped);
  });

  it('finds a program built in a source checkout', () => {
    const built = place('native', 'repo-intel', 'target', 'release', program);
    expect(locateRepoIntelEngine({}, moduleUrl()).path).toBe(built);
  });

  it('lists every place it looked when there is no program', () => {
    const location = locateRepoIntelEngine({}, moduleUrl());
    expect(location.path).toBeUndefined();
    expect(location.searched).toContain(path.join(scratch, 'dist', 'native', `${process.platform}-${process.arch}`, program));
  });
});

describe('createRepoIntelEngineHost', () => {
  it('stays off unless the switch asks for v2', () => {
    expect(createRepoIntelEngineHost({ configHome: scratch, env: {}, onLog: vi.fn() })).toBeUndefined();
  });

  it('says how to supply the program when the switch is on and the program is missing', () => {
    const onLog = vi.fn();
    const env = { KODAX_REPO_INTELLIGENCE_ENGINE: 'v2', KODAX_REPO_INTELLIGENCE_ENGINE_PATH: path.join(scratch, program) };
    expect(createRepoIntelEngineHost({ configHome: scratch, env, onLog })).toBeUndefined();
    expect(onLog).toHaveBeenCalledWith('warn', expect.stringMatching(/KODAX_REPO_INTELLIGENCE_ENGINE_PATH/));
  });

  it('supervises the program it found, storing indexes under the config home', async () => {
    const env = { KODAX_REPO_INTELLIGENCE_ENGINE: 'v2', KODAX_REPO_INTELLIGENCE_ENGINE_PATH: place(program) };
    const engine = createRepoIntelEngineHost({ configHome: scratch, env, onLog: vi.fn() });
    expect(engine?.status()).toMatchObject({ state: 'idle', roots: [] });
    await engine?.close();
  });
});

describe('inspectRepoIntelEngine', () => {
  it('reports the switch off without looking for the program', async () => {
    await expect(inspectRepoIntelEngine(scratch, {})).resolves.toEqual({ enabled: false });
  });

  it('reports where it looked when the program is missing', async () => {
    const missing = path.join(scratch, program);
    const env = { KODAX_REPO_INTELLIGENCE_ENGINE: 'v2', KODAX_REPO_INTELLIGENCE_ENGINE_PATH: missing };
    await expect(inspectRepoIntelEngine(scratch, env)).resolves.toEqual({ enabled: true, searched: [missing] });
  });

  it('reports a program that does not run', async () => {
    const broken = place(program);
    const env = { KODAX_REPO_INTELLIGENCE_ENGINE: 'v2', KODAX_REPO_INTELLIGENCE_ENGINE_PATH: broken };
    const report = await inspectRepoIntelEngine(scratch, env);
    expect(report).toMatchObject({ enabled: true, program: broken, engine: { error: expect.any(String) } });
  });

  it.skipIf(!existsSync(builtEngine))('starts the program once to read its version, languages and priority', async () => {
    const env = { KODAX_REPO_INTELLIGENCE_ENGINE: 'v2', KODAX_REPO_INTELLIGENCE_ENGINE_PATH: builtEngine };
    const report = await inspectRepoIntelEngine(scratch, env);
    expect(report).toMatchObject({
      enabled: true, program: builtEngine,
      engine: { version: expect.any(String), languages: expect.arrayContaining(['typescript', 'rust']), background: { active: true } },
    });
  });
});

describe('relayRunEventToRepoIntel', () => {
  const root = path.resolve('/work/repo');
  const engine = (): RepoIntelSupervisor & { open: Mock<RepoIntelSupervisor['open']>; changed: Mock<RepoIntelSupervisor['changed']> } => ({
    open: vi.fn<RepoIntelSupervisor['open']>(), changed: vi.fn<RepoIntelSupervisor['changed']>(),
    status: vi.fn<RepoIntelSupervisor['status']>(), close: vi.fn<RepoIntelSupervisor['close']>(),
  });
  const edited = (filePath: string): unknown => ({
    result: { id: 't1', name: 'edit', content: 'ok',
      toolResult: { type: 'tool_result', tool_use_id: 't1', content: 'ok',
        metadata: { fileChange: { path: filePath, added: 1, removed: 0, unified: '' } } } },
  });

  it('opens the repository of a Run as it starts', () => {
    const target = engine();
    relayRunEventToRepoIntel(target, 'run.started', {}, root);
    expect(target.open).toHaveBeenCalledWith(root);
  });

  it('passes on the file an edit changed, relative to the repository', () => {
    const target = engine();
    relayRunEventToRepoIntel(target, 'tool.finished', edited(path.join(root, 'src', 'a.ts')), root);
    relayRunEventToRepoIntel(target, 'tool.finished', edited('src/b.ts'), root);
    expect(target.changed.mock.calls).toEqual([[root, ['src/a.ts']], [root, ['src/b.ts']]]);
  });

  it('keeps the repository in use for any tool, but passes on only files inside it', () => {
    const target = engine();
    relayRunEventToRepoIntel(target, 'tool.finished', { result: { id: 't2', name: 'bash', content: 'text' } }, root);
    relayRunEventToRepoIntel(target, 'tool.finished', edited(path.resolve('/elsewhere/c.ts')), root);
    relayRunEventToRepoIntel(target, 'turn.started', {}, root);
    expect(target.changed).not.toHaveBeenCalled();
    expect(target.open.mock.calls).toEqual([[root], [root]]);
  });
});
