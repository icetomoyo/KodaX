import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type ProductCaseId = 'tenant-cache' | 'config-precedence' | 'output-retention' | 'skill-discovery' | 'history-replay';
interface ProductCase {
  prompt: string;
  followUp: string;
  files: Readonly<Record<string, string>>;
  entry: string;
  oracle: string;
  partial: Readonly<Record<string, string>>;
  golden: Readonly<Record<string, string>>;
}
const packageFile = JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } });
const historySource = `import { toView } from './view.js';
export function restoreHistory(records) {
  const seen = new Set();
  return records.map(toView).filter(view => {
    if (seen.has(view.text)) return false;
    seen.add(view.text);
    return true;
  });
}
`;
const historyGolden = `import { toView } from './view.js';
function identity(value) {
  const parts = [value?.runId, value?.turnId, value?.taskId];
  return parts.every(part => typeof part === 'string' && part.length > 0) ? JSON.stringify(parts) : undefined;
}
export function restoreHistory(records) {
  const reports = new Set(records.filter(record => record.kind === 'task').map(identity).filter(key => key !== undefined));
  const seen = new Set();
  const views = [];
  for (const record of records) {
    if (record.kind === 'notice') {
      const mirror = identity(record.mirrorOf);
      if (mirror !== undefined && reports.has(mirror)) continue;
    } else {
      const key = identity(record);
      if (key !== undefined) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
    }
    views.push(toView(record));
  }
  return views;
}
`;
const historyViewSource = `export function toView(record) {
  if (record.kind === 'notice') return { kind: 'notice', text: record.text, runId: record.runId, turnId: record.turnId };
  return { kind: 'task', taskId: record.taskId, runId: record.runId, turnId: record.turnId,
    status: record.status === 'running' ? 'running' : 'completed', text: record.text.trim(), format: record.format ?? 'text' };
}
`;
const historyViewGolden = historyViewSource.replace("record.status === 'running' ? 'running' : 'completed'", "['running', 'completed', 'failed', 'cancelled'].includes(record.status) ? record.status : 'unknown'")
  .replace('record.text.trim()', 'record.text');
const oracleHeader = `import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const api = await import(pathToFileURL(path.join(process.env.NATURAL_ORACLE_WORKSPACE, 'src/index.js')).href);
`;
const cacheSource = `export function createClient(load) {
  const entries = new Map();
  return { get(tenant, key) {
    const identity = key;
    if (!entries.has(identity)) entries.set(identity, Promise.resolve().then(() => load(tenant, key)));
    return entries.get(identity);
  } };
}
`;
const cachePartial = cacheSource.replace('const identity = key;', 'const identity = JSON.stringify([tenant, key]);');
const cacheGolden = cachePartial.replace('Promise.resolve().then(() => load(tenant, key))', 'Promise.resolve().then(() => load(tenant, key)).catch(error => { entries.delete(identity); throw error; })');
const configSource = `const defaults = { timeoutMs: 5000, retries: 2, enabled: true };
export function resolveConfig(file = {}, env = {}, cli = {}) {
  const source = { ...defaults, ...cli, ...file };
  if (env.APP_TIMEOUT_MS) source.timeoutMs = Number(env.APP_TIMEOUT_MS);
  if (env.APP_RETRIES) source.retries = Number(env.APP_RETRIES);
  if (env.APP_ENABLED) source.enabled = env.APP_ENABLED !== 'false';
  return { timeoutMs: source.timeoutMs || defaults.timeoutMs,
    retries: source.retries || defaults.retries, enabled: source.enabled || defaults.enabled };
}
`;
const configGolden = `const defaults = { timeoutMs: 5000, retries: 2, enabled: true };
export function resolveConfig(file = {}, env = {}, cli = {}) {
  const result = { ...defaults };
  const environment = {};
  for (const [key, name] of [['timeoutMs', 'APP_TIMEOUT_MS'], ['retries', 'APP_RETRIES']]) {
    if (env[name] !== undefined && env[name] !== '') environment[key] = Number(env[name]);
  }
  if (env.APP_ENABLED !== undefined && env.APP_ENABLED !== '') environment.enabled = env.APP_ENABLED !== 'false';
  for (const source of [file, environment, cli]) {
    for (const key of Object.keys(defaults)) if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}
`;
const outputStoreSource = `import { previewText } from './preview.js';
export function createOutputStore() {
  const values = new Map();
  let sequence = 0;
  return {
    publish(owner, text, limit = 80) {
      const id = 'output-' + ++sequence;
      const preview = previewText(text, limit);
      values.set(id, { owner, text: preview });
      return { id, preview, truncated: text.length > limit };
    },
    read(owner, id) { return values.get(id)?.text; },
    release(owner) { values.clear(); },
  };
}
`;
const outputPartial = outputStoreSource.replace('text: preview', 'text');
const outputGolden = outputPartial.replace('return values.get(id)?.text;', 'const item = values.get(id); return item?.owner === owner ? item.text : undefined;')
  .replace('values.clear();', 'for (const [id, item] of values) if (item.owner === owner) values.delete(id);');
const skillRootSource = `import path from 'node:path';
export async function projectRoot(cwd) { return path.resolve(cwd); }
`;
const skillRootGolden = `import path from 'node:path';
import fs from 'node:fs/promises';
export async function projectRoot(cwd) {
  const start = path.resolve(cwd);
  let current = start;
  for (;;) {
    try { await fs.stat(path.join(current, '.git')); return current; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}
`;
const skillRegistrySource = `import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './root.js';
export function createSkillRegistry() {
  const cache = new Map();
  async function list(cwd) {
    const root = await projectRoot(cwd);
    if (cache.has(root)) return cache.get(root);
    const directory = path.join(root, '.kodax', 'skills');
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(directory, entry.name, 'SKILL.md');
      let content;
      try { content = await fs.readFile(file, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const description = /^description: (.*)$/m.exec(content)?.[1] ?? '';
      skills.push({ name: entry.name, description, path: file });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    cache.set(root, skills);
    return skills;
  }
  return { list, async load(cwd, name) {
    const item = (await list(cwd)).find(skill => skill.name === name);
    return item ? { ...item, content: await fs.readFile(item.path, 'utf8') } : undefined;
  } };
}
`;
const skillRegistryGolden = skillRegistrySource.replace('  const cache = new Map();\n', '')
  .replace('    if (cache.has(root)) return cache.get(root);\n', '').replace('    cache.set(root, skills);\n', '');
const skillOracleSetup = `import fs from 'node:fs/promises';
import os from 'node:os';
async function fixture(work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-contract-'));
  try {
    await fs.mkdir(path.join(root, '.git'));
    await fs.mkdir(path.join(root, 'packages', 'client'), { recursive: true });
    await work(root, path.join(root, 'packages', 'client'));
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('skill-contract-')) throw Error('Unsafe cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function skill(root, name, description) {
  const directory = path.join(root, '.kodax', 'skills', name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), '---\\ndescription: ' + description + '\\n---\\nBody: ' + description);
}
`;
export const PRODUCT_CASES: Readonly<Record<ProductCaseId, ProductCase>> = {
  'history-replay': {
    prompt: '恢复历史后，有些内容相同但来源不同的通知消失了。请修复去重，确实重复的任务报告仍然只显示一次，保持现有接口并加回归测试。',
    followUp: '再核对任务报告的失败、取消和旧记录缺失状态，以及 Markdown、代码块和首尾空白的恢复。不能把未知状态说成成功，正文也不能丢。请验证后说明结果。',
    entry: 'src/history.js',
    files: {
      'package.json': packageFile,
      'README.md': `# History replay view
restoreHistory(records) in src/index.js is a pure synchronous projection. It returns views in source order, without mutating inputs. No transport, filesystem, live status updates or external dependencies are involved.
Records are kind=notice or kind=task, with text as an exact string. Task records may carry runId, turnId, taskId, status and format. Notices may carry runId, turnId and mirrorOf={runId,turnId,taskId}.
Only three nonempty string identifiers together prove task identity; arbitrary strings are valid identifiers. Keep the first task record for each complete identity. Different identities, or incomplete identities, remain independent even if their text matches.
A notice is a redundant legacy mirror only if its complete mirrorOf identity matches a task record anywhere in the same input. Drop only that proven mirror. Without proof, keep the notice. Equal text is not identity; partial or absent identities must never be guessed. Stable order is the order of retained source records.
Task views contain kind, taskId, runId, turnId, status, text, format. Preserve known statuses running/completed/failed/cancelled; absent or unrecognized status becomes unknown. Preserve text exactly, including Markdown, code, escapes, newlines and surrounding whitespace; preserve format, defaulting only absent format to text. Notice views contain kind, text, runId, turnId. Missing identifier fields remain undefined. Do not infer status from body text.
Run node --test. Existing public tests and README are reference inputs; add regressions under tests/.
`,
      'src/index.js': "export { restoreHistory } from './history.js';\n",
      'src/history.js': historySource,
      'src/view.js': historyViewSource,
      'tests/basic.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreHistory } from '../src/index.js';
test('projects a plain completed report and a notice', () => {
  const records=[{kind:'task',runId:'r',turnId:'t',taskId:'a',status:'completed',text:'done'}, {kind:'notice',text:'other'}];
  const views=restoreHistory(records);
  assert.equal(views.length,2); assert.equal(views[0].status,'completed'); assert.equal(views[0].text,'done');
  assert.equal(views[1].kind,'notice'); assert.equal(views[1].text,'other');
});
`,
    },
    partial: { 'src/history.js': historyGolden },
    golden: { 'src/history.js': historyGolden, 'src/view.js': historyViewGolden },
    oracle: oracleHeader + `
const task=(taskId,extra={})=>({kind:'task',runId:'run',turnId:'turn',taskId,status:'completed',text:'Task completed',...extra});
test('preserves independent same-text notices and tasks, only removes proven mirrors',()=>{
  const a=task('a'); const b=task('b');
  const early={kind:'notice',text:'old wrapper',mirrorOf:{runId:'run',turnId:'turn',taskId:'a'}};
  const independent={kind:'notice',text:a.text,runId:'another',turnId:'turn'};
  const unknown={kind:'notice',text:a.text,mirrorOf:{runId:'run',turnId:'turn',taskId:'absent'}};
  const partial={kind:'notice',text:a.text,mirrorOf:{taskId:'a'}};
  const views=api.restoreHistory([early,independent,a,b,{...a},unknown,partial,{kind:'notice',text:a.text}]);
  assert.deepEqual(views.map(v=>[v.kind,v.taskId,v.text]),[
    ['notice',undefined,a.text],['task','a',a.text],['task','b',a.text],
    ['notice',undefined,a.text],['notice',undefined,a.text],['notice',undefined,a.text]]);
});
test('identity needs all fields and cannot collide through delimiters',()=>{
  const records=[task('x',{runId:'a|b',turnId:'c'}),task('x',{runId:'a',turnId:'b|c'}),
    task('x',{runId:'a',turnId:'different'}),task(undefined),task(undefined),task('x',{runId:''}),task('x',{runId:''})];
  assert.equal(api.restoreHistory(records).length,records.length);
  assert.equal(api.restoreHistory([records[0],{...records[0],text:'second snapshot'}])[0].text,'Task completed');
});
test('retains status meaning, exact body and format without mutation',()=>{
  const body='  # Report\\n\\n~~~js\\nconst s = "<tag>&\\\\n";\\n~~~\\n  ';
  const statuses=['running','completed','failed','cancelled',undefined,'future'];
  const records=statuses.map((status,i)=>Object.freeze(task(String(i),{status,text:body,format:'markdown'})));
  const before=JSON.stringify(records); const result=api.restoreHistory(Object.freeze(records));
  assert.deepEqual(result.map(v=>v.status),['running','completed','failed','cancelled','unknown','unknown']);
  assert.ok(result.every(v=>v.text===body&&v.format==='markdown'));
  assert.equal(JSON.stringify(records),before);
  assert.equal(api.restoreHistory([task('plain',{text:'',status:undefined})])[0].format,'text');
  assert.equal(api.restoreHistory([task('plain',{text:'success!',status:undefined})])[0].status,'unknown');
});
`,
  },
  'output-retention': {
    prompt: 'SDK 返回的长结果在预览截断后，按引用读取也拿不到全文。请定位并修复，保持现有接口，补上回归测试。',
    followUp: '再检查多个会话同时使用时的隔离和清理。释放一个会话的结果，不能影响另一个会话；读错归属也不能拿到别人的内容。请一起验证。',
    entry: 'src/store.js',
    files: {
      'package.json': packageFile,
      'README.md': `# Recoverable SDK output
The public createOutputStore API is exported from src/index.js. publish(owner, text, limit=80) accepts string owners and text, and a nonnegative integer preview limit.
It returns {id, preview, truncated}. Only the preview is shortened; read(owner,id) must return the exact original text, including Unicode, whitespace and empty strings.
The limit counts JavaScript string code units. A zero limit is valid. Short outputs retain a reference too.
References belong to their publishing owner. Missing, released or wrong-owner references read as undefined.
release(owner) is idempotent and affects only that owner's references. Future publish calls still work.
Run node --test. Existing public tests and documentation are reference inputs; add new tests under tests/.
`,
      'src/index.js': "export { createOutputStore } from './store.js';\n",
      'src/preview.js': 'export function previewText(text, limit) { return text.slice(0, limit); }\n',
      'src/store.js': outputStoreSource,
      'tests/basic.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {createOutputStore} from '../src/index.js';\ntest('short result reference',()=>{const store=createOutputStore();const result=store.publish('one','hello');assert.equal(result.preview,'hello');assert.equal(result.truncated,false);assert.equal(store.read('one',result.id),'hello');});\n",
    },
    partial: { 'src/store.js': outputPartial },
    golden: { 'src/store.js': outputGolden },
    oracle: oracleHeader + `
test('preview does not replace exact SDK output', () => {
  const store = api.createOutputStore();
  for (const text of ['', '短😀\\n', JSON.stringify({records: Array.from({length: 30}, (_, i) => ({id: i, result: '末尾'}))})]) {
    for (const limit of [0, 3, 80]) {
      const result = store.publish('one', text, limit);
      assert.equal(result.preview, text.slice(0, limit)); assert.equal(result.truncated, text.length > limit);
      assert.equal(store.read('one', result.id), text);
    }
  }
});
test('ownership, cleanup and future writes remain independent', () => {
  const store = api.createOutputStore();
  const a = store.publish('one', 'first'); const b = store.publish('two', 'second');
  assert.equal(store.read('two', a.id), undefined); assert.equal(store.read('one', b.id), undefined);
  assert.equal(store.read('one', 'missing'), undefined);
  store.release('one'); store.release('one');
  assert.equal(store.read('one', a.id), undefined); assert.equal(store.read('two', b.id), 'second');
  const next = store.publish('one', 'new'); assert.equal(store.read('one', next.id), 'new');
  assert.notEqual(next.id, a.id);
});
`,
  },
  'skill-discovery': {
    prompt: '从项目子目录通过 SDK 启动时，技能列表是空的，但项目根目录确实有技能。请修复发现路径，保持现有 API，并加回归测试。',
    followUp: '再检查同一进程里新增、修改和删除技能后的表现。列表和按名称读取必须及时保持一致，也不能串到别的项目；请验证并修好。',
    entry: 'src/registry.js',
    files: {
      'package.json': packageFile,
      'README.md': `# Project skill registry
createSkillRegistry() exposes async list(cwd) and load(cwd,name) through src/index.js.
The nearest ancestor containing a .git marker (directory or file) is the project root. Without a marker, use the supplied cwd. Never consult global user skills.
Skills are direct directories under <root>/.kodax/skills, each with SKILL.md; the directory name is the skill name. Missing skill files are ignored; other I/O errors propagate.
list returns name-sorted {name,description,path} entries. This fixture's frontmatter uses one description: line.
load returns the same metadata plus full content, or undefined for a missing skill. Every call observes edits made before the call; discovery and loading must agree across SDK cwd values and projects. No watcher API is required.
Run node --test. Existing public tests and documentation are reference inputs; add new tests under tests/.
`,
      'src/index.js': "export { createSkillRegistry } from './registry.js';\n",
      'src/root.js': skillRootSource,
      'src/registry.js': skillRegistrySource,
      'tests/basic.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs/promises';\nimport os from 'node:os';\nimport path from 'node:path';\nimport {createSkillRegistry} from '../src/index.js';\ntest('empty directory has no skills',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'public-skill-'));try{assert.deepEqual(await createSkillRegistry().list(root),[]);}finally{await fs.rm(root,{recursive:true,force:true});}});\n",
    },
    partial: { 'src/root.js': skillRootGolden },
    golden: { 'src/root.js': skillRootGolden, 'src/registry.js': skillRegistryGolden },
    oracle: oracleHeader + skillOracleSetup + `
test('discovers from nested cwd and supports worktree marker files', async () => fixture(async (root, child) => {
  await skill(root, 'review', 'Review code');
  const registry = api.createSkillRegistry();
  assert.deepEqual((await registry.list(child)).map(x => x.name), ['review']);
  const loaded = await registry.load(child, 'review'); assert.equal(loaded.description, 'Review code');
  assert.match(loaded.content, /Body: Review code/);
  await fs.rmdir(path.join(root, '.git')); await fs.writeFile(path.join(root, '.git'), 'gitdir: elsewhere');
  assert.equal((await registry.list(child))[0].name, 'review');
}));
test('refreshes additions, edits and deletions without leaking projects', async () => fixture(async (root, child) => {
  const registry = api.createSkillRegistry();
  await skill(root, 'zeta', 'old'); await registry.list(child);
  await skill(root, 'alpha', 'added'); await skill(root, 'zeta', 'updated');
  const fresh = await registry.list(root); assert.deepEqual(fresh.map(x => [x.name, x.description]), [['alpha','added'], ['zeta','updated']]);
  assert.match((await registry.load(child, 'zeta')).content, /updated/);
  await fs.unlink(path.join(root, '.kodax', 'skills', 'zeta', 'SKILL.md'));
  assert.deepEqual((await registry.list(child)).map(x => x.name), ['alpha']);
  assert.equal(await registry.load(child, 'zeta'), undefined);
  await fixture(async (other, nested) => {
    await skill(other, 'other', 'independent');
    assert.deepEqual((await registry.list(nested)).map(x => x.name), ['other']);
    assert.equal(await registry.load(nested, 'alpha'), undefined);
  });
}));
`,
  },
  'tenant-cache': {
    prompt: '缓存客户端在切换租户后偶尔读到别人的结果。请定位并修复，加上回归测试，保持现有 API。',
    followUp: '再检查一下上游请求失败后能不能正常重试，以及并发请求会不会重复加载。有问题就一起修好并验证。',
    entry: 'src/client.js',
    files: {
      'package.json': packageFile,
      'README.md': `# Tenant cache client
Public API: createClient(load).get(tenant, key), exported from src/index.js.
tenant and key are arbitrary strings; identity is the exact ordered pair.
Concurrent requests for the same pair share one load. Different pairs never share results.
Successful values, including null, false and zero, are cached for this client's lifetime.
A failed load is returned to its callers unchanged, then evicted so a later request can retry.
Synchronous loader exceptions have the same rejection semantics. No TTL is provided.
Run tests with node --test. Existing public tests and documentation are reference inputs; add new tests under tests/.
`,
      'src/index.js': "export { createClient } from './client.js';\n",
      'src/client.js': cacheSource,
      'tests/basic.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/index.js';
test('reuses a successful result', async () => {
  let loads = 0; const client = createClient(async () => ++loads);
  assert.equal(await client.get('one', 'key'), 1);
  assert.equal(await client.get('one', 'key'), 1);
});
`,
    },
    partial: { 'src/client.js': cachePartial }, golden: { 'src/client.js': cacheGolden },
    oracle: oracleHeader + `
test('isolates tenants and collision-prone pairs through the public entry', async () => {
  const client = api.createClient(async (tenant, key) => [tenant, key]);
  for (const [tenant, key] of [['a','x'],['b','x'],['a:b','c'],['a','b:c'],['','x'],['x',''],['a\\u0000b','c'],['a','b\\u0000c']]) {
    assert.deepEqual(await client.get(tenant, key), [tenant, key]);
  }
  for (const separator of ['', ' ', ':', '|', '/', '::', '\\u0000']) {
    for (const [tenant, key] of [['a' + separator + 'b', 'c'], ['a', 'b' + separator + 'c']]) {
      assert.deepEqual(await client.get(tenant, key), [tenant, key]);
    }
  }
});
test('shares in-flight and fulfilled values without losing falsy values', async () => {
  for (const value of [null, false, 0]) {
    let calls = 0; const client = api.createClient(async () => { calls++; return value; });
    assert.deepEqual(await Promise.all([client.get('a','x'), client.get('a','x')]), [value, value]);
    assert.equal(await client.get('a','x'), value); assert.equal(calls, 1);
  }
});
test('failed shared load is retryable and retains the exact error', async () => {
  const reason = new Error('upstream'); let calls = 0;
  const client = api.createClient(async () => { if (++calls === 1) throw reason; return 'ok'; });
  const results = await Promise.allSettled([client.get('a','x'), client.get('a','x')]);
  for (const result of results) { assert.equal(result.status, 'rejected'); assert.equal(result.reason, reason); }
  assert.equal(calls, 1); assert.equal(await client.get('a','x'), 'ok'); assert.equal(calls, 2);
});
test('synchronous loader failure also recovers', async () => {
  const reason = new Error('sync'); let calls = 0;
  const client = api.createClient(() => { if (++calls === 1) throw reason; return 0; });
  await assert.rejects(client.get('a','x'), error => error === reason);
  assert.equal(await client.get('a','x'), 0); assert.equal(calls, 2);
});
`,
  },
  'config-precedence': {
    prompt: '命令行传了超时配置，实际运行却还是用了环境变量里的值。请修复配置优先级并补测试，不改变公开接口。',
    followUp: '我们还需要用 0 关闭超时和重试、用 false 禁用功能。请检查这些设置，以及未提供参数时的兼容行为，补齐验证。',
    entry: 'src/config.js',
    files: {
      'package.json': packageFile,
      'README.md': `# Configuration resolver
Public API: resolveConfig(file = {}, env = {}, cli = {}), exported from src/index.js.
Each setting resolves independently: CLI > environment > file > defaults.
Defaults: timeoutMs=5000, retries=2, enabled=true.
Environment names: APP_TIMEOUT_MS, APP_RETRIES, APP_ENABLED. Numeric values are parsed as numbers; 'false' disables enabled.
Valid inputs are non-negative finite numbers and booleans; environment uses their string forms.
Zero and false are explicit settings, not missing values. Undefined object values and empty environment strings mean absent.
Ignore unrelated keys; never mutate the input objects. Invalid-value validation is outside this API's scope.
Run tests with node --test. Existing public tests and documentation are reference inputs; add new tests under tests/.
`,
      'src/index.js': "export { resolveConfig } from './config.js';\n",
      'src/config.js': configSource,
      'tests/basic.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/index.js';
test('returns defaults', () => assert.deepEqual(resolveConfig(), { timeoutMs: 5000, retries: 2, enabled: true }));
test('accepts a file timeout', () => assert.equal(resolveConfig({ timeoutMs: 900 }).timeoutMs, 900));
`,
    },
    partial: { 'src/config.js': configGolden.replace('source[key] !== undefined', 'Boolean(source[key])') },
    golden: { 'src/config.js': configGolden },
    oracle: oracleHeader + `
test('resolves each setting by precedence', () => {
  assert.deepEqual(api.resolveConfig({timeoutMs: 100, retries: 1, enabled: false}, {APP_TIMEOUT_MS: '200', APP_RETRIES: '3'}, {timeoutMs: 300}), {timeoutMs: 300, retries: 3, enabled: false});
});
test('preserves explicit zero and false at each layer', () => {
  for (const args of [[{timeoutMs:0,retries:0,enabled:false}], [{}, {APP_TIMEOUT_MS:'0',APP_RETRIES:'0',APP_ENABLED:'false'}], [{timeoutMs:99,retries:9}, {APP_ENABLED:'true'}, {timeoutMs:0,retries:0,enabled:false}]]) {
    assert.deepEqual(api.resolveConfig(...args), {timeoutMs:0,retries:0,enabled:false});
  }
});
test('absent values fall through independently', () => {
  assert.deepEqual(api.resolveConfig({timeoutMs:100,retries:0,enabled:false}, {APP_TIMEOUT_MS:'',APP_RETRIES:undefined}, {timeoutMs:undefined,retries:undefined,enabled:undefined}), {timeoutMs:100,retries:0,enabled:false});
  assert.deepEqual(api.resolveConfig(), {timeoutMs:5000,retries:2,enabled:true});
});
test('does not mutate or leak input keys', () => {
  const file = Object.freeze({timeoutMs:10,extra:'ignore'});
  const env = Object.freeze({APP_TIMEOUT_MS:'20'}); const cli = Object.freeze({retries:0});
  assert.deepEqual(api.resolveConfig(file, env, cli), {timeoutMs:20,retries:0,enabled:true});
  assert.equal(file.timeoutMs,10); assert.equal(env.APP_TIMEOUT_MS,'20');
});
`,
  },
};

export async function prepareProductCase(directory: string, id: ProductCaseId) {
  const definition = PRODUCT_CASES[id];
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace);
  for (const [relative, content] of Object.entries(definition.files)) {
    const target = path.join(workspace, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { flag: 'wx' });
  }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/disabled-hooks', '-c', 'commit.gpgsign=false', ...args], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' },
  }).trim();
  git('init', '--template=', '--initial-branch=main', '--object-format=sha1');
  git('add', '.'); git('commit', '-m', 'Introduce public client implementation'); git('tag', 'base');
  const head = git('rev-parse', 'HEAD');
  return { workspace, id, prompt: definition.prompt, base: head, head, status: '', delta: '', priorContext: '', receipts: [] };
}
