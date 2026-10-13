import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const run = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url));
const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

test('packed Artifact SDK works independently and its root types need no Node ambient declarations', { timeout: 120_000 }, async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact standalone '));
 try {
  const packed = JSON.parse((await run(process.execPath, [npmCli, 'pack', path.join(repo, 'packages/artifacts'), '--ignore-scripts', '--json', '--pack-destination', root], { cwd: repo })).stdout)[0];
  assert.ok(packed.files.some(file => file.path === 'dist/docx.browser.js'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  await run(process.execPath, [npmCli, 'install', path.join(root, packed.filename), '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--fetch-retries=0'], { cwd: root, timeout: 90_000 });
  await assert.rejects(fs.access(path.join(root, 'node_modules/@kodax-ai/kodax')));
  await fs.copyFile(path.join(repo, 'tests/fixtures/images/valid-png.png'), path.join(root, 'source.png'));
  await fs.writeFile(path.join(root, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import {createArtifactSdk,validateVisualEvidence} from '@kodax-ai/artifacts';
import {createNodeArtifactPort} from '@kodax-ai/artifacts/runtime';
const sdk=createArtifactSdk(createNodeArtifactPort({workspaceRoot:process.cwd()}));
const opened=await sdk.open({path:'source.png'}); assert.equal(opened.status,'ready');
const rendered=await sdk.render({path:'source.png',expectedSourceHash:opened.artifact.sourceHash});
assert.equal(rendered.status,'ready');
const image=await sdk.readEvidence({source:rendered.evidence.source,raster:rendered.evidence.evidence[0]});
assert.equal(image.status,'ready'); assert.equal(image.image.width,160);
assert.equal(validateVisualEvidence(rendered.evidence,{source:rendered.evidence.source,kind:'static'}).status,'ready');
assert.equal((await sdk.capabilities()).status,'ready');
`);
  await run(process.execPath, [path.join(root, 'consumer.mjs')], { cwd: root, timeout: 30_000 });
  await fs.writeFile(path.join(root, 'consumer.ts'), `
import type {ArtifactRef,ArtifactResults,ArtifactExecutionPort} from '@kodax-ai/artifacts';
import {createArtifactSdk} from '@kodax-ai/artifacts';
// @ts-expect-error ready evidence must contain actual image data
const missing:ArtifactResults['readEvidence']={status:'ready',diagnostics:[]};
// @ts-expect-error DOCX has no intrinsic page count
const invented:ArtifactRef={format:'docx',path:'a.docx',sourceHash:'a'.repeat(64),pages:1};
declare const port:ArtifactExecutionPort;
const sdk=createArtifactSdk(port);
async function consumer(){const opened=await sdk.open({path:'a.pdf'});if(opened.status==='ready')opened.artifact.sourceHash;const prepared=await sdk.prepare();if(prepared.status==='ready')prepared.engine.name;}
`);
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, types: [], lib: ['ES2022', 'DOM'], noEmit: true }, files: ['consumer.ts'] }));
  await run(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json')], { cwd: root, timeout: 30_000 });
 } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
