import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const required = ['provider-capabilities.json', 'manual-topics.json', 'static-text.json', 'windows-native-scripts.json', 'generated-config-templates.json'];

test('the real tar release inventory includes every runtime data sidecar', async () => {
  const names = workflow.match(/sidecars=\(([\s\S]*?)\n\s*\)/)?.[1].trim().split(/\s+/);
  assert.ok(names);
  await verifyArchive(names, false);
});

test('the real Windows zip release inventory includes every runtime data sidecar', { skip: process.platform !== 'win32' }, async () => {
  const names = workflow.match(/Compress-Archive -Path ([\w.,/-]+) -DestinationPath/)?.[1].split(',');
  assert.ok(names);
  await verifyArchive(names, true);
});

async function verifyArchive(names, zip) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-release-sidecars-'));
  try {
    for (const name of new Set([...names, ...required])) {
      assert.match(name, /^[\w.-]+$/);
      if (path.extname(name)) await writeFile(path.join(root, name), 'inert release fixture');
      else { await mkdir(path.join(root, name)); await writeFile(path.join(root, name, 'fixture.txt'), 'inert fixture'); }
    }
    let entries;
    if (zip) {
      const script = '$items=$env:KODAX_RELEASE_FIXTURE_ITEMS.Split(","); Compress-Archive -LiteralPath $items -DestinationPath fixture.zip -Force; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead((Join-Path (Get-Location) "fixture.zip")); try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }';
      entries = (await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { cwd: root, windowsHide: true, env: { ...process.env, KODAX_RELEASE_FIXTURE_ITEMS: names.join(',') } })).stdout.split(/\r?\n/);
    } else {
      await exec('tar', ['-czf', 'fixture.tar.gz', ...names], { cwd: root, windowsHide: true });
      entries = (await exec('tar', ['-tf', 'fixture.tar.gz'], { cwd: root, windowsHide: true })).stdout.split(/\r?\n/);
    }
    for (const name of required) assert.ok(entries.includes(name), `Release archive omitted ${name}`);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}
