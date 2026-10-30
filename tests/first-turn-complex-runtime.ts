// Bounded eval Runtime reused from the frozen 2026-10-20 closure driver.
// No production defaults, provider inputs or tool parameters are changed here.
import fs from 'node:fs/promises';
import {writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {KodaXBaseProvider,registerModelProvider,runWithProviderRequestAttribution,type KodaXProviderConfig,type KodaXMessage,type KodaXToolDefinition,type KodaXReasoningRequest,type KodaXProviderStreamOptions} from '@kodax-ai/llm';
import {currentProviderRequestAttribution} from '../packages/llm/src/provider-request-observation.js';
import {SkillRegistry,type Guardrail,type ToolGuardrail} from '@kodax-ai/agent';
import {createKodaXRuntime,type KodaXRuntime} from "./runtime-fixture.js";
import {CACHE_FILES,CACHE_TASK,CACHE_ORACLE,writeCacheFixture} from '../benchmark/datasets/search-entry-complex/fixture.js';
import type {FrozenInput} from './first-turn-eval-support.js';
import type {CallEvidence,EditRoute} from './first-turn-edit-eval-support.js';
import {checkComplexTool,createComplexReadBoundary,isRecoverableComplexDenial} from './first-turn-complex-guard.js';
import {resolveToolBridgeTarget} from '../packages/coding/src/tools/tool-bridge.js';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
export async function runComplexRuntime(route:Pick<EditRoute,'id'|'env'|'model'|'provider'>,directory:string,invoke:(input:FrozenInput,signal:AbortSignal,index:number,meta:{reasoning?:boolean|KodaXReasoningRequest;streamOptions?:KodaXProviderStreamOptions;taskSignal?:AbortSignal})=>Promise<CallEvidence>,limits:{calls:number;tools:number;timeoutMs:number;output?:number}={calls:20,tools:40,timeoutMs:480000},collaboration=false,taskPrompt=CACHE_TASK,additionalGuardrails:readonly Guardrail[]=[],workMode:'agent'|'coding'|'script'='coding'){
 const startedAt=Date.now(); const workspace=path.join(directory,'workspace');await writeCacheFixture(workspace);
 await fs.writeFile(path.join(directory,'oracle.mjs'),CACHE_ORACLE);
 execFileSync('git',['init','-q'],{cwd:workspace,windowsHide:true});
 execFileSync('git',['config','core.autocrlf','false'],{cwd:workspace,windowsHide:true});
 await fs.appendFile(path.join(workspace,'.git/info/exclude'),'\n.agent/\n');
 execFileSync('git',['add','--all'],{cwd:workspace,windowsHide:true});
 execFileSync('git',['config','user.name','Eval Fixture'],{cwd:workspace,windowsHide:true});
 execFileSync('git',['config','user.email','eval-fixture@example.invalid'],{cwd:workspace,windowsHide:true});
 const head=spawnSync('git',['rev-parse','--verify','HEAD'],{cwd:workspace,windowsHide:true});
 if(head.status!==0)execFileSync('git',['-c','user.name=Eval Fixture','-c','user.email=eval-fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture baseline'],{cwd:workspace,windowsHide:true});
 const calls:CallEvidence[]=[],events:Array<Record<string,unknown>>=[];
 const precheckedCalls=new Set<string>();
 let nestedToolCount=0;
 let spawnAttempts=0,allowedSpawns=0,toolCount=0,queued=0,maxQueued=0,actual=0,maxActual=0,reviewBypasses=0;
 let error:string|null=null,phase:string|undefined,success=false,finalText='',tree:unknown;
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(new Error('Complex smoke total timeout')),limits.timeoutMs);
 let tail=Promise.resolve();
 function snapshot(){mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,'runtime-live.json'),JSON.stringify({calls,events,spawnAttempts,allowedSpawns,toolCount,nestedToolCount,maxQueued,maxActual,reviewBypasses,error},null,2));}
 function stop(reason:string):never{error??=reason;abort.abort(new Error(reason));snapshot();throw new Error(reason);}
 const policy=async(tool:string,input:Record<string,unknown>,meta:{contextKind:'root'|'child';childAgentId?:string})=>{
  toolCount++;if(toolCount>limits.tools)return stop('budget-censored: actual tool cap');
  const child=meta.contextKind==='child';let denied=checkComplexTool(workspace,tool,input,child);
  if(tool==='spawn_agent'){spawnAttempts++;if(allowedSpawns>=1)denied='At most one child per smoke case.';if(denied===null)allowedSpawns++;}
  events.push({kind:'guard',tool,input,meta,denied});snapshot();return denied;
 };
 // Provider output cannot enumerate dynamically computed Script leaf calls.
 // Apply the same scope policy at execution, counting each nested call once.
 const executionBoundary:ToolGuardrail={kind:'tool',name:'complex-fixture-execution-boundary',beforeTool:async(call,context)=>{
  if(abort.signal.aborted)return{action:'block',reason:'Evaluation already stopped.'};
  const bridge=resolveToolBridgeTarget(call);
  if(bridge&&!bridge.ok)return stop('eval boundary: malformed bridge input');
  const target=bridge?.ok?bridge.call:call;
  const attribution=currentProviderRequestAttribution();
  const child=context.permissionIntent?.readOnly===true||(attribution?.kind==='actor_turn'&&attribution.actorPath!=='/root');
  const counted=precheckedCalls.has(target.id);
  let denied:string|null;
  if(counted)denied=checkComplexTool(workspace,target.name,target.input,child);
  else{
   precheckedCalls.add(target.id);nestedToolCount++;
   denied=await policy(target.name,target.input,{contextKind:child?'child':'root'});
  }
  if(denied!==null&&!isRecoverableComplexDenial(target.name,denied))return stop('isolation-rejected-before-execution: [Tool Error] '+denied);
  return denied===null?{action:'allow'}:{action:'block',reason:denied};
 }};
 const name='complex-runtime-'+randomUUID();
 class Wrapped extends KodaXBaseProvider{
  readonly name=name;readonly supportsThinking=false;
  protected readonly config:KodaXProviderConfig={apiKeyEnv:route.env,model:route.model,contextWindow:128000,supportsThinking:false};
  async stream(messages:KodaXMessage[],tools:KodaXToolDefinition[],system:string,_reasoning?:boolean|KodaXReasoningRequest,_options?:KodaXProviderStreamOptions,signal?:AbortSignal){
   const prior=tail;let release!:()=>void;tail=new Promise<void>(resolve=>{release=resolve;});queued++;maxQueued=Math.max(maxQueued,queued);
   await prior;
   try{
    if(abort.signal.aborted)throw abort.signal.reason;
    if(signal?.aborted){events.push({kind:'cancelled-before-dispatch',toolNames:tools.map(t=>t.name)});snapshot();throw new DOMException('Queued auxiliary request cancelled','AbortError');}
    if(calls.length>=limits.calls){
     events.push({kind:'provider-budget-rejected',contextKind:system.includes('focused sub-agent')?'child':'root',toolNames:tools.map(tool=>tool.name),lastMessage:messages.at(-1)});
     return stop('budget-censored: shared root/child response cap');
    }
    if(tools.length===1&&tools[0]?.name==='commit_episode_learning_review')return stop('eval-invalid: background review reached task wrapper');
    actual++;maxActual=Math.max(maxActual,actual);
    const signal2=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    let evidence:CallEvidence;
    try{evidence=await invoke({messages,tools,system},signal2,calls.length,{reasoning:_reasoning,streamOptions:_options,taskSignal:abort.signal});}finally{actual--;}
    calls.push(evidence);snapshot();
    if(tools.length===1&&tools[0]?.name==='report_stall_judgment'&&evidence.physicalAttempts===0&&evidence.error?.startsWith('local-preflight:'))throw new Error(evidence.error);
    if(evidence.error&&(evidence as CallEvidence & {boundedAuxiliaryCancellation?:boolean}).boundedAuxiliaryCancellation)throw new Error(evidence.error);
    if(evidence.error||!evidence.result)return stop(evidence.error??'Missing response');
    const attribution=currentProviderRequestAttribution();
    const child=attribution?.kind==='actor_turn'&&attribution.actorPath!=='/root';
    for(const block of evidence.result.toolBlocks){
     const bridge=resolveToolBridgeTarget(block);
     if(bridge&&!bridge.ok)return stop('eval boundary: malformed bridge input');
     const bridged=bridge?.ok===true;
     const {name:target,input:args}=bridge?.ok?bridge.call:block;
     if(!args||typeof args!=='object'||Array.isArray(args))return stop('eval boundary: malformed bridge input');
     if(bridged)toolCount++;
     const decision=await policy(target,args,{contextKind:child?'child':'root',...(child?{childAgentId:'provider-child'}:{})});
     precheckedCalls.add(block.id);if(bridge?.ok)precheckedCalls.add(bridge.call.id);
     // The SDK returns recoverable refusals as actual error tool_results.
     // Other isolation violations keep their hard stop.
     if(decision!==null&&!isRecoverableComplexDenial(target,decision))return stop('isolation-rejected-before-execution: [Tool Error] '+decision);
    }
    return evidence.result;
   }finally{queued--;release();}
  }
 }
 const unregister=registerModelProvider(name,()=>new Wrapped());let runtime:KodaXRuntime|undefined;
 try{
  runtime=await createKodaXRuntime({mode:'embedded',homeDir:path.join(directory,'home'),defaultProvider:name,defaultModel:route.model});
  const session=await runtime.sessions.create({projectPath:workspace});await fs.mkdir(path.join(workspace,'.agent/tmp/sessions',session.id),{recursive:true});await runtime.sessions.updateSettings(session.id,{permissionMode:'full-access',executionCwd:workspace});
  // Observational eval label, not a Runtime-owned turn id or permission authority.
  // Real child Actor execution replaces this ALS attribution with its own turn.
  const rootAttribution={kind:'actor_turn' as const,actorPath:'/root',turnId:'eval-root-'+randomUUID()};
  events.push({kind:'eval-root-attribution',attribution:rootAttribution,synthetic:true});
  const activeRuntime=runtime;
  const handle=await runWithProviderRequestAttribution(rootAttribution,()=>activeRuntime.runs.start({sessionId:session.id,mode:'managed_task',prompt:taskPrompt+(collaboration?'\n另外，请派一个只读子 Agent 核对 README 和旧测试中的兼容约束；它只做检查与报告、不修改文件。主 Agent 负责修复、运行测试，并整合其结论。最多创建一个子 Agent，使用继承的模型设置。':'\n可按需要使用至多一个只读子 Agent，使用继承的模型设置；主 Agent 负责实际修复和验证。'),options:{provider:name,model:route.model,agentMode:'ama',reasoningMode:'off',effort:route.provider==='kimi-code'?'low':'none',lsp:false,maxIter:24,maxOutputTokens:limits.output??4096,abortSignal:abort.signal,disablePromptCache:true,
   workMode,guardrails:[executionBoundary,createComplexReadBoundary(workspace),...additionalGuardrails],
   learningReviewer:async()=>{reviewBypasses++;return{memoryPlan:{actions:[],warnings:[]},capabilityDecision:{disposition:'discard',reasonCodes:['eval-isolated']}};},
   context:{executionCwd:workspace,gitRoot:workspace,skillsPrompt:'',skillRegistry:new SkillRegistry(workspace),repoIntelligenceMode:'auto',resolveShellPermissionMode:()=> 'full-access'},
   events:{
    onToolUseStart:(tool,meta)=>{events.push({kind:'start',...tool,meta});snapshot();},
    onToolResult:(result,meta)=>{events.push({kind:'result',...result,meta});snapshot();},
   },
  }}));
  const result=await handle.result;phase=result.phase;success=result.result?.success===true;finalText=result.result?.lastText??'';
  if(result.error)error??=result.error.name+': '+result.error.message;
  tree=await runtime.agents.tree(session.id);
 }catch(cause:unknown){error??=cause instanceof Error?cause.name+': '+cause.message:String(cause);abort.abort(cause);}
 finally{clearTimeout(timer);await runtime?.close();unregister();snapshot();}
 const protectedFiles=Object.keys(CACHE_FILES).filter(p=>!['packages/identity/key.js','packages/cache/store.js','packages/client/request-cache.js'].includes(p));
 const protectedUnchanged=(await Promise.all(protectedFiles.map(async file=>sha(await fs.readFile(path.join(workspace,file),'utf8'))===sha(CACHE_FILES[file]!)))).every(Boolean);
 const sourceFiles:Record<string,string>={};for(const file of ['packages/identity/key.js','packages/cache/store.js','packages/client/request-cache.js'])sourceFiles[file]=await fs.readFile(path.join(workspace,file),'utf8');
 const publicRun=spawnSync(process.execPath,['--test'],{cwd:workspace,encoding:'utf8',windowsHide:true,timeout:15000});
 const heldOut=spawnSync(process.execPath,['--test',path.join(directory,'oracle.mjs')],{cwd:directory,encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,KODAX_COMPLEX_ORACLE_WORKSPACE:workspace}});
 const newTests=(await fs.readdir(path.join(workspace,'tests'))).filter(file=>file!=='basic.test.js');
 const record={wallMs:Date.now()-startedAt,comparison:false,entry:'createKodaXRuntime',source:workMode==='script'?'final-script':'final-native',workMode,route:route.id,collaboration,phase,success,error,finalText,tree,calls,events,counts:{responses:calls.length,toolCount,nestedToolCount,spawnAttempts,allowedSpawns,maxQueued,maxActual,reviewBypasses},
  groundtruth:{protectedUnchanged,commentsPreserved:sourceFiles['packages/identity/key.js']?.includes('// Identifier format is opaque to callers.'),publicTestsPass:publicRun.status===0&&publicRun.stdout.includes('# fail 0'),oraclePass:heldOut.status===0&&heldOut.stdout.includes('# pass 6')&&heldOut.stdout.includes('# fail 0'),newTests,sourceFiles},
  verification:{public:{status:publicRun.status,stdout:publicRun.stdout,stderr:publicRun.stderr,error:publicRun.error?.message},heldOut:{status:heldOut.status,stdout:heldOut.stdout,stderr:heldOut.stderr,error:heldOut.error?.message}}};
 await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(record,null,2),{flag:'wx'});return record;
}
