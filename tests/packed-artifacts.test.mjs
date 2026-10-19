import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditRuntimeTarball } from '../scripts/audit-runtime-tarball.mjs';
const run = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url));
// Match the existing packed-native gate: Windows bundles npm beside node;
// Unix distributions place it under the installation prefix's lib directory.
const npmCli = [
 process.env.npm_execpath?.trim(),
 path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
 path.join(path.dirname(path.dirname(process.execPath)), 'lib/node_modules/npm/bin/npm-cli.js'),
].find(candidate => candidate !== undefined && candidate !== '' && existsSync(candidate));
if (!npmCli) throw new Error('The packed Artifact SDK gate requires the npm CLI JavaScript entry.');

test('one packed KodaX package delivers Artifact entries, resources, pixels and browser-free root types', { timeout: 180_000 }, async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-artifact-consumer-'));
 try {
  const pkg = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
  await assert.rejects(run(process.execPath, [path.join(repo, 'scripts/release.mjs'), '--artifacts', '--pack-only'], { cwd: repo }), error => /Artifact SDK ships inside @kodax-ai\/kodax/.test(error.stderr));
  for (const entry of ['./artifacts', './artifacts/client', './artifacts/runtime', './artifacts/kodax']) assert.ok(pkg.exports[entry], `Main package is missing ${entry}`);
  const workspace = JSON.parse(await fs.readFile(path.join(repo, 'packages/artifacts/package.json'), 'utf8'));
  assert.equal(workspace.private, true);
  const filename = `kodax-ai-kodax-${pkg.version}.tgz`;
  const released = await run(process.execPath, [path.join(repo, 'scripts/release.mjs'), '--skip-build', '--pack-only'], { cwd: repo, timeout: 90_000 });
  assert.ok(released.stdout.includes(`Tarball produced: ${filename}`));
  await fs.copyFile(path.join(repo, filename), path.join(root, filename));
  const entries = (await run('tar', ['-tf', filename], { cwd: root })).stdout.split(/\r?\n/);
  for (const entry of ['dist/runtime-entry.js', 'dist/docx.browser.js', 'skills/artifact-review/SKILL.md', 'LICENSE']) {
   assert.ok(entries.includes(`package/dist/artifacts/${entry}`), `Missing packed resource: ${entry}`);
  }
  for (const key of ['./artifacts', './artifacts/client', './artifacts/runtime', './artifacts/kodax']) {
   const entry = pkg.exports[key];
   for (const target of Object.values(entry)) assert.ok(entries.includes(`package/${target.slice(2)}`), `Missing export: ${target}`);
  }
  const extracted = path.join(root, 'audit');
  await fs.mkdir(extracted);
  // MSYS GNU tar treats drive-letter arguments (C:/...) as remote tape specs;
  // keep every tar argument relative so GNU and bsdtar behave identically.
  await run('tar', ['-xf', filename, '-C', path.relative(root, extracted)], { cwd: root });
  await fs.unlink(path.join(extracted, 'package/dist/artifacts/dist/docx.browser.js'));
  await run('tar', ['-czf', 'broken.tgz', '-C', path.relative(root, extracted), 'package'], { cwd: root });
  assert.throws(() => auditRuntimeTarball(path.join(root, 'broken.tgz')), /missing required entry:.*docx.browser.js/i);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  await run(process.execPath, [npmCli, 'install', path.join(root, filename), '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'], { cwd: root, timeout: 90_000 });
  await assert.rejects(fs.access(path.join(root, 'node_modules/@kodax-ai/artifacts')));
  const loader = path.join(root, 'no-startup-renderers.mjs');
  await fs.writeFile(loader, `export async function resolve(id,context,next){
if(['@aiden0z/pptx-renderer','docx-renderer','pdfjs-dist','playwright-core','pptxgenjs'].some(name=>id===name||id.startsWith(name+'/')))throw new Error('Core startup loaded renderer: '+id);
return next(id,context);}`);
  await run(process.execPath, ['--loader', pathToFileURL(loader).href, '--input-type=module', '-e',
   "await import('@kodax-ai/kodax/client'); await import('@kodax-ai/kodax/artifacts');"], { cwd: root, timeout: 30_000 });
  await fs.copyFile(path.join(repo, 'tests/fixtures/images/valid-png.png'), path.join(root, 'source.png'));
  await fs.copyFile(path.join(repo, 'tests/fixtures/artifacts/mixed-pages.pdf'), path.join(root, 'source.pdf'));
  await fs.copyFile(path.join(repo, 'tests/fixtures/artifacts/automatic-pagination.docx'), path.join(root, 'source.docx'));
  await fs.writeFile(path.join(root, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createArtifactSdk,validateVisualEvidence} from '@kodax-ai/kodax/artifacts';
import {createNodeArtifactPort} from '@kodax-ai/kodax/artifacts/runtime';
import {createKodaXArtifactPort} from '@kodax-ai/kodax/artifacts/client';
import {registerArtifactTools} from '@kodax-ai/kodax/artifacts/kodax';
assert.equal(typeof createKodaXArtifactPort,'function');
const tools=[], skillPaths=[];
const dispose=registerArtifactTools({registerSkillPath:p=>{skillPaths.push(p);return ()=>{};},registerTool:t=>{tools.push(t);return ()=>{};}},
 {nodeExecutable:process.execPath,execute:async()=>{throw new Error('Registration must not execute a tool.');}});
assert.equal(tools.length,9);assert.equal(skillPaths.length,1);dispose();
assert.ok((await fs.readFile(skillPaths[0]+'/artifact-review/SKILL.md','utf8')).includes('artifact'));
for(const dependency of ['@aiden0z/pptx-renderer/browser','pdfjs-dist/build/pdf.mjs','pdfjs-dist/build/pdf.worker.mjs','playwright-core/package.json']) assert.ok(import.meta.resolve(dependency));
const manifestPath='.artifact-request-'+randomUUID()+'.json';
const manifest=JSON.stringify({request:{operation:'open',input:{path:'source.png'}},options:{workspaceRoot:process.cwd()}});
await fs.writeFile(manifestPath,manifest);
const worker=fileURLToPath(new URL('./runtime-entry.js',import.meta.resolve('@kodax-ai/kodax/artifacts/runtime')));
const workerResult=await promisify(execFile)(process.execPath,[worker,manifestPath,createHash('sha256').update(manifest).digest('hex')]);
assert.equal(JSON.parse(workerResult.stdout.trim().slice('ARTIFACT_RESULT:'.length)).status,'ready');
const sdk=createArtifactSdk(createNodeArtifactPort({workspaceRoot:process.cwd(),browserExecutable:process.env.KODAX_ARTIFACT_TEST_BROWSER}));
const opened=await sdk.open({path:'source.png'}); assert.equal(opened.status,'ready');
const rendered=await sdk.render({path:'source.png',expectedSourceHash:opened.artifact.sourceHash});
assert.equal(rendered.status,'ready');
const image=await sdk.readEvidence({source:rendered.evidence.source,raster:rendered.evidence.evidence[0]});
assert.equal(image.status,'ready'); assert.equal(image.image.width,160);
assert.equal(validateVisualEvidence(rendered.evidence,{source:rendered.evidence.source,kind:'static'}).status,'ready');
assert.equal((await sdk.capabilities()).status,'ready');
if(process.env.KODAX_ARTIFACT_TEST_BROWSER){
 assert.equal((await sdk.prepare()).status,'ready');
 assert.equal((await sdk.create({output:'source.pptx',slides:[{elements:[{type:'text',text:'Packed pixels',x:1,y:1,width:8,height:1}]}]})).status,'ready');
 for(const path of ['source.pptx','source.pdf','source.docx']){
  const result=await sdk.render({path,pages:[1]});assert.equal(result.status,path.endsWith('.docx')?'unverified':'ready');
  const raster=result.evidence.evidence[0];
  const pixels=await sdk.readEvidence({source:result.evidence.source,raster});
  assert.equal(pixels.status,'ready');assert.ok(pixels.image.width>0);assert.ok(pixels.image.height>0);
 }
}
const {ensureKodaXRuntime,waitForRuntimeDaemonShutdown}=await import('@kodax-ai/kodax/runtime');
const {connectKodaXClient}=await import('@kodax-ai/kodax/client');
const home=path.join(process.cwd(),'host-home');
await fs.mkdir(path.join(home,'.kodax','extensions'),{recursive:true});
await fs.writeFile(path.join(home,'.kodax','extensions','artifacts.mjs'),
 'import{registerArtifactTools}from '+JSON.stringify(import.meta.resolve('@kodax-ai/kodax/artifacts/kodax'))+';'+
 'import{executeManagedProcess}from '+JSON.stringify(import.meta.resolve('@kodax-ai/kodax/coding'))+';'+
 'export default api=>registerArtifactTools(api,{execute:executeManagedProcess,nodeExecutable:'+JSON.stringify(process.execPath)+'});');
const runtime=await ensureKodaXRuntime({homeDir:home,defaultProvider:'openai',daemonStartupTimeoutMs:30000});
const owner=(await runtime.daemon.inspect()).owner;
let client;
try{
 client=await connectKodaXClient({homeDir:home});
 const session=await client.sessions.create({projectPath:process.cwd()});
 await client.sessions.updateSettings(session.id,{permissionMode:'full-access'});
 const remote=createArtifactSdk(createKodaXArtifactPort(client,session.id));
 const rendered=await remote.render({path:'source.png'});assert.equal(rendered.status,'ready');
 const read=await remote.readEvidence({source:rendered.evidence.source,raster:rendered.evidence.evidence[0]});
 assert.equal(read.status,'ready');assert.deepEqual(Buffer.from(read.image.dataBase64,'base64'),await fs.readFile('source.png'));
}finally{
 await client?.disconnect();
 try{await runtime.daemon.shutdown();}finally{await runtime.close();}
 assert.equal((await waitForRuntimeDaemonShutdown({configHome:path.join(home,'.kodax'),owner})).status,'succeeded');
}
`);
  await run(process.execPath, [path.join(root, 'consumer.mjs')], { cwd: root, timeout: 60_000 });
  await fs.writeFile(path.join(root, 'consumer.ts'), `
import type {ArtifactRef,ArtifactResults,ArtifactExecutionPort} from '@kodax-ai/kodax/artifacts';
import {createArtifactSdk} from '@kodax-ai/kodax/artifacts';
import {createKodaXArtifactPort} from '@kodax-ai/kodax/artifacts/client';
import type {KodaXProductClient} from '@kodax-ai/kodax/client';
// @ts-expect-error ready evidence must contain actual image data
const missing:ArtifactResults['readEvidence']={status:'ready',diagnostics:[]};
// @ts-expect-error DOCX has no intrinsic page count
const invented:ArtifactRef={format:'docx',path:'a.docx',sourceHash:'a'.repeat(64),pages:1};
declare const port:ArtifactExecutionPort;
declare const client:KodaXProductClient;
createKodaXArtifactPort(client,'existing-session');
const sdk=createArtifactSdk(port);
async function consumer(){const opened=await sdk.open({path:'a.pdf'});if(opened.status==='ready')opened.artifact.sourceHash;const prepared=await sdk.prepare();if(prepared.status==='ready')prepared.engine.name;}
`);
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, types: [], lib: ['ES2022', 'DOM'], noEmit: true }, files: ['consumer.ts'] }));
  await run(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json')], { cwd: root, timeout: 30_000 });
 } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
