import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('bundled standalone Shell drains detached descendants and releases recovery records', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-bundle-cleanup-'));
  const home = path.join(directory, 'home');
  const { toolBash } = await import('../dist/sdk-coding.js');
  const { cleanupRegisteredManagedChildren } = await import('../dist/sdk-agent.js');
  try {
    await writeFile(path.join(directory, 'fixture.cjs'), `
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      require('node:fs').writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
      process.stdout.write('bundled-cleanup-output');
      process.exit(7);
    `);
    const result = await toolBash({ command: 'node fixture.cjs' }, {
      backups: new Map(), executionCwd: directory, configHome: home,
      shellExecution: { version: 1, shell: { kind: 'cmd', profile: 'none' } },
    });
    assert.match(result, /Exit: 7/);
    assert.match(result, /bundled-cleanup-output/);
    for (const pid of JSON.parse(await readFile(path.join(directory, 'pids.json'), 'utf8'))) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    const cleanup = await cleanupRegisteredManagedChildren({
      configHome: home, includeCurrentOwner: true, requireCurrentOwnerCleanup: true,
    });
    assert.equal(cleanup.skipped, 0);
    assert.deepEqual(await readdir(path.join(home, 'runtime/processes/children')), []);
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    throw new Error(`Bundled cleanup failed; retained evidence in ${directory}`, { cause: error });
  }
});
