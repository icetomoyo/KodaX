import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

test('Script worker and internal client are included in npm and both release archives', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('dist/script-worker.cjs'));
  const workflow = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');
  for (const name of ['script-cell.js', 'script-worker.cjs']) {
    assert.ok(workflow.match(/sidecars=\(([\s\S]*?)\)/)?.[1].includes(name));
    assert.ok(workflow.match(/Compress-Archive -Path ([^\n]+?) -DestinationPath/)?.[1].split(',').includes(name));
  }
});

test('actual npm tarball runs Script in a clean directory and fails explicitly on a missing worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kodax-script-release-'));
  try {
    // npm's CLI is next to the Node installation on release runners; no install or lifecycle scripts.
    const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const packed = await exec(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory],
      { cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const [manifest] = JSON.parse(packed.stdout);
    for (const name of ['dist/script-cell.js', 'dist/script-worker.cjs']) assert.ok(manifest.files.some(file => file.path === name));
    // MSYS GNU tar treats drive-letter arguments (C:/...) as remote tape specs;
    // keep both tar paths relative to the temp directory.
    await exec('tar', ['-xf', manifest.filename, '-C', '.'], { cwd: directory, windowsHide: true, timeout: 60_000 });
    const cwd = join(directory, 'package');
    await writeFile(join(cwd, 'probe.mjs'), `import {runScriptCell} from './dist/script-cell.js';
      const result=await runScriptCell({code:'const r=await tools.read({});return [Number(r.content)+1,typeof process,typeof fetch];',
        toolNames:['read'],limits:{timeoutMs:5000,memoryBytes:16777216,maxCalls:4,maxTransferBytes:131072},invoke:async()=>({content:'41'})});
      process.stdout.write(JSON.stringify(result));`);
    const run = async () => JSON.parse((await exec(process.execPath, ['probe.mjs'], { cwd,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, windowsHide: true, timeout: 15_000 })).stdout);
    const result = await run();
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.value, [42, 'undefined', 'undefined']);
    assert.equal(result.receipts.length, 1);
    // The isolated Worker above needs no npm dependencies. The public SDK uses the
    // declared package dependencies, as an npm installation would; bind only those offline.
    const installed = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    for (const name of Object.keys(installed.dependencies)) {
      const target = join(cwd, 'node_modules', name);
      if (existsSync(target)) continue; // Bundled dependencies are already supplied by the tarball.
      await mkdir(dirname(target), { recursive: true });
      await symlink(join(root, 'node_modules', name), target, process.platform === 'win32' ? 'junction' : 'dir');
    }
    await writeFile(join(cwd, 'mode-probe.mjs'), `import assert from 'node:assert/strict';
      import {assertWorkModeAvailable,runManagedTask,awaitLatestCodingMemoryReviewDrain,KODAX_TOOLS,getToolDefinition} from './dist/sdk-coding.js';
      import {KodaXBaseProvider,registerModelProvider} from './dist/sdk-llm.js';
      import {FileSessionStorage} from './dist/sdk-repl.js';
      import {writeFile} from 'node:fs/promises';
      import path from 'node:path';
      globalThis.fetch=async()=>{throw Error('No external requests');};
      process.env.KODAX_PACK_MODE_KEY='offline'; process.env.KODAX_HOME=path.join(process.cwd(),'home');
      try { await assertWorkModeAvailable({workMode:'script'}); }
      catch(error) { process.stdout.write(JSON.stringify({ready:false,error:String(error)})); process.exit(0); }
      assert.equal(KODAX_TOOLS.find(t=>t.name==='glob').description,'Find files matching a pattern.');
      let calls=0; let nativeCalls=0; let workMode='script'; let scriptShell; let scriptQuestion;
      function schemaStructure(value,properties=false) {
        if(Array.isArray(value)) return value.map(item=>schemaStructure(item));
        if(value && typeof value==='object') return Object.fromEntries(Object.entries(value)
          .filter(([key])=>properties || key!=='description')
          .map(([key,item])=>[key,schemaStructure(item,key==='properties')]));
        return value;
      }
      class Fixture extends KodaXBaseProvider {
        name='packed-script'; supportsThinking=false;
        config={apiKeyEnv:'KODAX_PACK_MODE_KEY',model:'fixture',supportsThinking:false};
        async stream(messages,tools,system) {
          try {
          if(!tools.some(t=>t.name==='todo_update')) { const e=Error('Auxiliary request outside fixture');e.name='AbortError';throw e; }
          if(tools.some(t=>t.name==='spawn_agent')) assert.match(system,/TRUST AND SCOPE/);
          else assert.match(system,/LOCAL EXECUTION: Delegation is unavailable/);
          assert.match(system,/MUTATION DISCIPLINE:/);
          if(workMode!=='script') {
            nativeCalls++;
            assert.equal(tools.find(t=>t.name==='glob').description,'Find file paths by glob.');
            const ask=tools.find(t=>t.name==='ask_user_question');
            const canonicalAsk=getToolDefinition('ask_user_question');
            assert.deepEqual(ask,scriptQuestion);
            assert.deepEqual(schemaStructure(ask.input_schema),schemaStructure(canonicalAsk.input_schema));
            assert.match(ask.description,/Batch custom settings inherit flat settings/);
            assert.ok(!tools.some(t=>t.name==='script_exec'));
            assert.deepEqual(tools.find(t=>t.name==='bash'),scriptShell);
            return {textBlocks:[{type:'text',text:'Native contract verified.'}],thinkingBlocks:[],toolBlocks:[],stopReason:'end_turn'};
          }
          assert.ok(tools.some(t=>t.name==='script_exec')); assert.ok(tools.some(t=>t.name==='undo')); assert.ok(tools.some(t=>t.name==='bash'));
          scriptShell=tools.find(t=>t.name==='bash');
          scriptQuestion=tools.find(t=>t.name==='ask_user_question');
          assert.match(scriptShell.description,/Long commands: run_in_background/);
          assert.equal(scriptShell.input_schema.properties.run_in_background.type,'boolean');
          assert.ok(!tools.some(t=>t.name==='read')); assert.ok(calls<2);
          const first=calls++===0;
          if(!first) {
            const block=messages.flatMap(m=>Array.isArray(m.content)?m.content:[])
              .find(b=>b.type==='tool_result' && b.tool_use_id==='packed-cell');
            const cell=JSON.parse(block.content);
            assert.match(JSON.stringify(cell.receipts),/PACKED_REAL_READ/);
            assert.deepEqual(cell.value,{});
            assert.deepEqual(cell.value_fields_from_receipts,{output:{id:1,field:'content'}});
            assert.match(cell.value_reference_note,/no additional tool call/);
          }
          return {textBlocks:first?[]:[{type:'text',text:'Read verified.'}],thinkingBlocks:[],
            toolBlocks:first?[{type:'tool_use',id:'packed-cell',name:'script_exec',input:{code:"const read=await tools.read({path:'input.txt'});return {output:read.content};"}}]:[],
            stopReason:first?'tool_use':'end_turn'};
          } catch(error) { process.stderr.write(String(error.stack ?? error)); throw error; }
        }
      }
      registerModelProvider('packed-script',()=>new Fixture());
      await writeFile('input.txt','PACKED_REAL_READ '.repeat(80));
      const storage=new FileSessionStorage({sessionsDir:path.join(process.cwd(),'sessions'),configHome:process.env.KODAX_HOME,cwd:process.cwd()});
      const controller=new AbortController();
      const result=await runManagedTask({provider:'packed-script',workMode:'script',reasoningMode:'off',lsp:false,abortSignal:controller.signal,
        session:{storage},context:{executionCwd:process.cwd(),gitRoot:process.cwd(),repoIntelligenceMode:'off'},
        events:{beforeToolExecute:async name=>name==='read'}},'Read input.txt and report.');
      controller.abort(); await awaitLatestCodingMemoryReviewDrain(5000);
      assert.equal(result.success,true); assert.equal(calls,2);
      const saved=await storage.load(result.sessionId);
      assert.equal(saved.extensionRecords.filter(r=>r.type==='call.settled').length,1);
      const settled=saved.extensionRecords.find(r=>r.type==='cell.settled').data.data;
      assert.match(settled.value.output,/PACKED_REAL_READ/);
      assert.equal(settled.value_fields_from_receipts,undefined);
      for(workMode of ['agent','coding']) {
        const nativeController=new AbortController();
        const nativeResult=await runManagedTask({provider:'packed-script',workMode,reasoningMode:'off',lsp:false,
          abortSignal:nativeController.signal,context:{executionCwd:process.cwd(),gitRoot:process.cwd(),repoIntelligenceMode:'off'}},'Report the available mode.');
        nativeController.abort(); await awaitLatestCodingMemoryReviewDrain(5000);
        assert.equal(nativeResult.success,true);
      }
      assert.equal(nativeCalls,2);
      // Exercise the changed Todo receipt through the packed public SDK, not a
      // source import. All modes retain native Todo calls and the same recovery.
      let todoCalls=0;
      class TodoFixture extends KodaXBaseProvider {
        name='packed-todo'; supportsThinking=false;
        config={apiKeyEnv:'KODAX_PACK_MODE_KEY',model:'fixture',supportsThinking:false};
        async stream(messages,tools) {
          if(!tools.some(t=>t.name==='todo_create')) { const e=Error('Auxiliary request outside fixture');e.name='AbortError';throw e; }
          const step=todoCalls++;
          assert.ok(step<3,'Unexpected additional Todo recovery generation');
          if(step>0) {
            const receipt=messages.flatMap(m=>Array.isArray(m.content)?m.content:[])
              .find(b=>b.type==='tool_result' && b.tool_use_id===(step===1?'invalid-todo':'valid-todo'));
            assert.ok(receipt,'Missing original Todo receipt');
            if(step===1) {
              assert.equal(receipt.is_error,true);
              assert.equal(JSON.parse(receipt.content).code,'todo_invalid_input');
              assert.match(JSON.parse(receipt.content).reason,/Invalid status/);
            } else {
              assert.notEqual(receipt.is_error,true);
              assert.deepEqual(JSON.parse(receipt.content),{ok:true,id:'todo_1'});
            }
          }
          return {textBlocks:step===2?[{type:'text',text:'Plan item created; no edits or tests performed.'}]:[],thinkingBlocks:[],
            toolBlocks:step<2?[{type:'tool_use',id:step===0?'invalid-todo':'valid-todo',name:'todo_create',
              input:{subject:'Verify',status:step===0?'completed':'in_progress'}}]:[],stopReason:step<2?'tool_use':'end_turn'};
        }
      }
      registerModelProvider('packed-todo',()=>new TodoFixture());
      for(const mode of ['agent','coding','script']) {
        todoCalls=0;
        const recoveryController=new AbortController();
        try {
          const recovery=await runManagedTask({provider:'packed-todo',workMode:mode,reasoningMode:'off',lsp:false,
            abortSignal:recoveryController.signal,session:{storage},context:{executionCwd:process.cwd(),gitRoot:process.cwd(),repoIntelligenceMode:'off'}},'Create a plan item and report its state.');
          assert.equal(recovery.success,true); assert.equal(todoCalls,3);
        } finally { recoveryController.abort(); await awaitLatestCodingMemoryReviewDrain(5000); }
      }
      process.stdout.write(JSON.stringify({ready:true,calls}));`);
    const mode = async () => {
      try {
        return JSON.parse((await exec(process.execPath, ['mode-probe.mjs'], { cwd,
          env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, windowsHide: true, timeout: 30_000 })).stdout);
      } catch (error) {
        throw new Error(`Packed mode probe failed: ${error.stderr || error.message}`, { cause: error });
      }
    };
    assert.deepEqual(await mode(), { ready: true, calls: 2 });
    await rm(join(cwd, 'dist/script-worker.cjs'));
    const missing = await run();
    assert.equal(missing.status, 'failed');
    assert.match(missing.error, /script-worker\.cjs/);
    assert.deepEqual(missing.receipts, []);
    const unavailable = await mode();
    assert.equal(unavailable.ready, false);
    assert.match(unavailable.error, /Script executor unavailable.*script-worker\.cjs/s);
  } finally {
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('kodax-script-release-')) throw new Error('Unsafe release cleanup');
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
