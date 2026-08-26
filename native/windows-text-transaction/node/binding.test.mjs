import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TrustedTextTransactionRoot, textTransactionProtocol } from './index.mjs';

assert.equal(textTransactionProtocol, 4);

if (process.env.KODAX_NATIVE_TEXT_SMOKE_WORKER === '1') {
  const root = new TrustedTextTransactionRoot(
    process.env.KODAX_NATIVE_TEXT_SMOKE_ROOT,
    process.platform === 'win32' ? undefined : process.env.KODAX_NATIVE_TEXT_SMOKE_STATE,
  );
  const outcome = await root.commit(
    process.env.KODAX_NATIVE_TEXT_SMOKE_TARGET,
    process.env.KODAX_NATIVE_TEXT_SMOKE_REVISION,
    process.env.KODAX_NATIVE_TEXT_SMOKE_CONTENT,
    false,
    10_000,
  );
  await writeFile(process.env.KODAX_NATIVE_TEXT_SMOKE_RESULT, outcome.status);
} else {
  await runSmoke();
}

async function runSmoke() {

const rootPath = await mkdtemp(join(tmpdir(), 'kodax-native-text-'));
const statePath = process.platform === 'win32'
  ? undefined
  : await mkdtemp(join(tmpdir(), 'kodax-native-text-state-'));
try {
  const root = new TrustedTextTransactionRoot(rootPath, statePath);
  const target = join(rootPath, 'hello.md');
  const before = await root.snapshot(target);
  assert.equal(before.state, 'missing');
  const created = await root.commit(target, before.revision, 'hello\n', false, 5_000);
  assert.equal(created.status, 'written');
  assert.equal(created.slotId, before.slotId);
  assert.equal(await readFile(target, 'utf8'), 'hello\n');
  assert.equal((await root.commit(target, before.revision, 'lost\n', false, 5_000)).status, 'stale');
  const present = await root.snapshot(target);
  const replaced = await root.commit(target, present.revision, 'again\n', false, 5_000);
  assert.equal(replaced.status, 'written');
  assert.equal(replaced.slotId, present.slotId);
  assert.equal((await root.snapshot(target)).slotId, present.slotId);
  await crossProcessCas(root, rootPath, statePath);
} finally {
  await rm(rootPath, { recursive: true, force: true });
  if (statePath !== undefined) await rm(statePath, { recursive: true, force: true });
}
}

async function crossProcessCas(root, rootPath, statePath) {
  const target = join(rootPath, 'cross-process.md');
  await writeFile(target, 'before');
  const observed = await root.snapshot(target);
  const results = [join(rootPath, 'result-a'), join(rootPath, 'result-b')];
  const children = results.map((result, index) => spawn(process.execPath, [process.argv[1]], {
    env: {
      ...process.env,
      KODAX_HOME: join(rootPath, `home-${index}`),
      TMPDIR: join(rootPath, `tmp-${index}`),
      KODAX_NATIVE_TEXT_SMOKE_WORKER: '1',
      KODAX_NATIVE_TEXT_SMOKE_ROOT: rootPath,
      KODAX_NATIVE_TEXT_SMOKE_STATE: statePath,
      KODAX_NATIVE_TEXT_SMOKE_TARGET: target,
      KODAX_NATIVE_TEXT_SMOKE_REVISION: observed.revision,
      KODAX_NATIVE_TEXT_SMOKE_CONTENT: `after-${index}`,
      KODAX_NATIVE_TEXT_SMOKE_RESULT: result,
    },
    stdio: 'inherit',
    windowsHide: true,
  }));
  const statuses = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve(undefined)
      : reject(new Error(`native smoke worker exited ${code}`)));
  })));
  assert.equal(statuses.length, 2);
  const outcomes = (await Promise.all(results.map((result) => readFile(result, 'utf8')))).sort();
  assert.deepEqual(outcomes, ['stale', 'written']);
}
