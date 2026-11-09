import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runKodaX, toolBash } from '../dist/sdk-coding.js';
import { createCustomProvider, registerModelProvider, clearRuntimeModelProviders,
  createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope } from '../dist/sdk-llm.js';

test('bundled SA and credential broker share exact attachment evidence through diagnosis and retry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-bundled-recovery-'));
  const priorHome = process.env.KODAX_HOME;
  process.env.KODAX_HOME = directory;
  const provider = createCustomProvider({ name: 'bundle-recovery', protocol: 'openai', model: 'vision',
    imageInput: true, baseUrl: 'https://unused.invalid', apiKeyEnv: 'UNUSED' });
  const scope = createProviderCredentialLeaseScope({ allowedProviders: [provider.name], acquire: async () => 'synthetic-broker-key' });
  try {
    const file = path.join(directory, 'header.png');
    await writeFile(file, await readFile(new URL('./fixtures/images/valid-png.png', import.meta.url)));
    const history = [{ role: 'user', content: [{ type: 'image', path: file }] }];
    const original = JSON.stringify(history);
    let requests = 0;
    const client = { chat: { completions: { create: async (request, options) => {
      requests++;
      if (requests === 1) {
        const m = request.messages.findIndex(message => JSON.stringify(message).includes('image_url'));
        const b = request.messages[m].content.findIndex(block => block.type === 'image_url');
        throw Object.assign(new Error(`Invalid image format at messages[${m}].content[${b}].image_url.url`), { status: 400 });
      }
      assert.equal(options.maxRetries, 0);
      assert.ok(!JSON.stringify(request).includes('data:image/'));
      if (!request.stream) {
        const id = JSON.stringify(request).match(/m\d+\/b\d+(?:\/i\d+)?/)?.[0];
        assert.ok(id);
        return { choices: [{ message: { content: JSON.stringify({ action: 'omit_attachment', attachmentId: id,
          reason: 'Exact rejected payload.' }) }, finish_reason: 'stop' }] };
      }
      return (async function* () { yield { choices: [{ delta: { content: 'Recovered without editing files.' }, finish_reason: 'stop' }] }; })();
    } } } };
    Reflect.set(provider, 'buildClient', async () => client);
    registerModelProvider(provider.name, () => provider);
    const result = await runWithProviderCredentialLeaseScope(scope, () => runKodaX({ provider: provider.name,
      reasoningMode: 'off', lsp: false, maxIter: 1, context: { executionCwd: directory },
      session: { initialMessages: history } }, 'Continue the text response.'));
    assert.equal(result.success, true);
    assert.equal(requests, 3);
    assert.equal(JSON.stringify(history), original);
  } finally {
    scope.close(); clearRuntimeModelProviders();
    if (priorHome === undefined) delete process.env.KODAX_HOME;
    else process.env.KODAX_HOME = priorHome;
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

for (const mode of ['artifact-registration-failed', 'recovery-unavailable']) {
  test(`bundled Bash keeps oversized output bounded when ${mode}`, { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kodax-bundled-bash-output-'));
    const priorOutput = process.env.KODAX_TOOL_OUTPUT_DIR;
    const recovery = path.join(directory, 'recovery');
    let registrations = 0;
    try {
      if (mode === 'recovery-unavailable') await writeFile(recovery, 'This is an ordinary file.');
      process.env.KODAX_TOOL_OUTPUT_DIR = recovery;
      await writeFile(path.join(directory, 'fixture.cjs'), `
        require('node:fs').appendFileSync('executions.txt', 'x');
        process.stdout.write('BUNDLE_STDOUT_START' + 'x'.repeat(614400) + 'BUNDLE_STDOUT_END');
        process.stderr.write('BUNDLE_STDERR_SENTINEL');
      `);
      const output = await toolBash({ command: 'node fixture.cjs' }, {
        backups: new Map(), executionCwd: directory, configHome: path.join(directory, 'home'),
        ...(process.platform === 'win32'
          ? { shellExecution: { version: 1, shell: { kind: 'cmd', profile: 'none' } } } : {}),
        toolCallId: 'bundled-bounded-output',
        recordToolResultArtifact: () => {
          registrations++;
          throw new Error('Controlled bundled artifact registration failure.');
        },
      });
      assert.ok(output.length < 4096, `Expected bounded receipt, got ${output.length} characters.`);
      assert.match(output, /Exit: 0/);
      assert.match(output, /KODAX_RESULT_INCOMPLETE/);
      assert.doesNotMatch(output, /\[Unknown\] Shell cleanup/);
      assert.equal(await readFile(path.join(directory, 'executions.txt'), 'utf8'), 'x');
      if (mode === 'recovery-unavailable') {
        assert.equal(registrations, 0);
        assert.match(output, /stdout recovery unavailable:/);
        assert.match(output, /stderr recovery unavailable:/);
        assert.doesNotMatch(output, /(?:stdout|stderr) recovery: |KODAX_CAPTURE_COMPLETE/);
      } else {
        assert.equal(registrations, 1);
        assert.match(output, /recovery artifact registration failed/);
        for (const [stream, sentinels] of [
          ['stdout', ['BUNDLE_STDOUT_START', 'BUNDLE_STDOUT_END']],
          ['stderr', ['BUNDLE_STDERR_SENTINEL']],
        ]) {
          const file = output.match(new RegExp(`${stream} recovery: ([^\\r\\n]+)`))?.[1];
          assert.ok(file, `Missing ${stream} reference in receipt: ${output}`);
          assert.equal(path.dirname(path.resolve(file)), recovery);
          const captured = await readFile(file, 'utf8');
          for (const sentinel of sentinels) assert.ok(captured.includes(sentinel));
          assert.match(captured, /KODAX_CAPTURE_COMPLETE/);
        }
      }
    } finally {
      if (priorOutput === undefined) delete process.env.KODAX_TOOL_OUTPUT_DIR;
      else process.env.KODAX_TOOL_OUTPUT_DIR = priorOutput;
      assert.equal(path.dirname(directory), path.resolve(tmpdir()));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}
