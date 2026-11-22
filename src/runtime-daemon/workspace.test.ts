import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHostWorkspace } from './workspace.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** A workspace with `app/api` and a file `notes.txt`, next to a directory outside it. */
async function makeWorkspace(): Promise<{ root: string; outside: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'kodax-workspace-')));
  tempDirs.push(base);
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'app', 'api'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, 'notes.txt'), 'notes');
  return { root, outside };
}

describe('the Host workspace', () => {
  it('names a directory inside it by a relative path and back', async () => {
    const { root } = await makeWorkspace();
    const workspace = createHostWorkspace(root);

    expect(await workspace.resolve('.')).toBe(root);
    expect(await workspace.resolve('app/api')).toBe(path.join(root, 'app', 'api'));
    expect(await workspace.relative(root)).toBe('.');
    expect(await workspace.relative(path.join(root, 'app', 'api'))).toBe('app/api');
  });

  it('has no name for a directory outside it', async () => {
    const { root, outside } = await makeWorkspace();
    const workspace = createHostWorkspace(root);

    expect(await workspace.relative(outside)).toBeUndefined();
    expect(await workspace.relative(`${root}-sibling`)).toBeUndefined();
  });

  it.each(['../outside', 'app/../../outside', '/etc', 'app\\api'])('refuses %s', async (project) => {
    const { root } = await makeWorkspace();
    await expect(createHostWorkspace(root).resolve(project)).rejects.toMatchObject({
      kodaxCode: 'invalid_params', reason: 'project_outside_workspace',
    });
  });

  it('refuses the absolute path of a directory outside it', async () => {
    const { root, outside } = await makeWorkspace();
    await expect(createHostWorkspace(root).resolve(outside)).rejects.toMatchObject({
      kodaxCode: 'invalid_params', reason: 'project_outside_workspace',
    });
  });

  it('refuses a link that leads outside it', async () => {
    const { root, outside } = await makeWorkspace();
    try {
      await symlink(outside, path.join(root, 'escape'), 'junction');
    } catch {
      return; // This machine does not let the test make a link.
    }
    await expect(createHostWorkspace(root).resolve('escape')).rejects.toMatchObject({
      kodaxCode: 'invalid_params', reason: 'project_outside_workspace',
    });
  });

  it('refuses what is missing or not a directory', async () => {
    const { root } = await makeWorkspace();
    const workspace = createHostWorkspace(root);
    await expect(workspace.resolve('missing')).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'project_not_found' });
    await expect(workspace.resolve('notes.txt')).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'project_not_found' });
  });

  it('reports a workspace directory that is gone as the Host being unavailable', async () => {
    const { root } = await makeWorkspace();
    await expect(createHostWorkspace(path.join(root, 'gone')).resolve('.')).rejects.toMatchObject({
      kodaxCode: 'unavailable', reason: 'workspace_unavailable',
    });
  });
});
