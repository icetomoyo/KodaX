import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type ProductCaseId = 'tenant-cache' | 'config-precedence';
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
export const PRODUCT_CASES: Readonly<Record<ProductCaseId, ProductCase>> = {
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
