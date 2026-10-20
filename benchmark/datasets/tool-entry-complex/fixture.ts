import fs from 'node:fs/promises';
import path from 'node:path';

export const CACHE_TASK = `请修复这个缓存客户端的租户隔离和 TTL 边界问题，并增加有效的回归测试。
以 README 的公开契约为准，保留现有 API 与正常行为。需要同时考虑租户和 key 的编码、并发加载去重、到期瞬间、零 TTL、不缓存加载失败等跨模块约束。
可以修改 src 下实现并在 tests 新增回归文件，保留 README、package.json 和 tests/basic.test.js 原样。不要添加依赖。请运行测试、检查改动并如实说明验证范围；现有测试通过本身不足以证明这些问题已修复。`;

export const CACHE_FILES: Readonly<Record<string, string>> = {
  'package.json': '{"type":"module","scripts":{"test":"node --test"}}\n',
  'README.md': `# Tenant cache client

Public API: cacheKey(tenant, key); createCache({clock}); createClient({cache, load, ttlMs}).
Tenant and key are case-sensitive arbitrary strings, including colons and quotes.
cacheKey returns an opaque stable identifier; distinct (tenant,key) pairs must not collide.
The cache supports get(id), set(id,value,ttlMs = null). undefined means cache miss.
A numeric TTL expires when clock() >= insertion time + TTL. TTL zero is immediately stale.
TTL null never expires. Callers supply a non-negative finite number or null.
Cached false, zero and null are valid values. A loader returns a non-undefined value.
The client exposes async get(tenant,key). Concurrent misses for the SAME pair share one load;
different tenants or keys do not share in-flight work. Load failures must propagate, never
be cached, and must release the in-flight entry so a later call can retry.
No network or third-party packages are needed. Run npm test or node --test.
`,
  'src/keys.js': `// Identifier format is opaque to callers.
export function cacheKey(tenant, key) {
  return tenant + ':' + key;
}
`,
  'src/cache.js': `export function createCache({ clock = Date.now } = {}) {
  const entries = new Map();
  return {
    get(id) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      if (entry.expiresAt !== null && clock() > entry.expiresAt) {
        entries.delete(id);
        return undefined;
      }
      return entry.value;
    },
    set(id, value, ttlMs = null) {
      const expiresAt = ttlMs ? clock() + ttlMs : null;
      entries.set(id, { value, expiresAt });
    },
  };
}
`,
  'src/client.js': `import { cacheKey } from './keys.js';

export function createClient({ cache, load, ttlMs = 50 }) {
  const inFlight = new Map();
  return {
    async get(tenant, key) {
      const id = cacheKey(tenant, key);
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      if (inFlight.has(key)) return inFlight.get(key);
      const pending = Promise.resolve()
        .then(() => load(tenant, key))
        .then(value => { cache.set(id, value, ttlMs); return value; })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  };
}
`,
  'tests/basic.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../src/cache.js';
import { createClient } from '../src/client.js';

test('basic caching and expiry after deadline', async () => {
  let now = 100;
  let loads = 0;
  const cache = createCache({ clock: () => now });
  const client = createClient({ cache, load: async () => ++loads, ttlMs: 10 });
  assert.equal(await client.get('team', 'key'), 1);
  now = 109;
  assert.equal(await client.get('team', 'key'), 1);
  now = 111;
  assert.equal(await client.get('team', 'key'), 2);
});
`,
};

export const CACHE_GOLDEN: Readonly<Record<string, string>> = {
  'src/keys.js': CACHE_FILES['src/keys.js']!.replace("return tenant + ':' + key;", 'return JSON.stringify([tenant, key]);'),
  'src/cache.js': CACHE_FILES['src/cache.js']!
    .replace('clock() > entry.expiresAt', 'clock() >= entry.expiresAt')
    .replace('ttlMs ? clock() + ttlMs : null', 'ttlMs === null ? null : clock() + ttlMs'),
  'src/client.js': CACHE_FILES['src/client.js']!
    .replaceAll('inFlight.has(key)', 'inFlight.has(id)')
    .replaceAll('inFlight.get(key)', 'inFlight.get(id)')
    .replaceAll('inFlight.delete(key)', 'inFlight.delete(id)')
    .replaceAll('inFlight.set(key, pending)', 'inFlight.set(id, pending)'),
};

// Written outside the model workspace. It evaluates semantics, not a preferred patch.
export const CACHE_ORACLE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.env.KODAX_COMPLEX_ORACLE_WORKSPACE;
if (!workspace) throw new Error('Missing oracle workspace');
const { cacheKey } = await import(pathToFileURL(path.join(workspace, 'src/keys.js')));
const { createCache } = await import(pathToFileURL(path.join(workspace, 'src/cache.js')));
const { createClient } = await import(pathToFileURL(path.join(workspace, 'src/client.js')));
test('opaque tenant keys', () => {
  const pairs = [['a:b','c'], ['a','b:c'], ['Team','k'], ['team','k'], ['',':'], [':',''], ['a"','b']];
  const ids = pairs.map(([t,k]) => cacheKey(t,k));
  assert.equal(new Set(ids).size, pairs.length);
  assert.equal(cacheKey('a:b','c'), ids[0]);
});
test('expiry equality and zero TTL', () => {
  let now = 0;
  const cache = createCache({ clock: () => now });
  cache.set('timed', 'value', 10);
  now = 9; assert.equal(cache.get('timed'), 'value');
  now = 10; assert.equal(cache.get('timed'), undefined);
  cache.set('zero', 'stale', 0);
  assert.equal(cache.get('zero'), undefined);
});
test('null TTL and falsy values remain supported', () => {
  let now = 0;
  const cache = createCache({ clock: () => now });
  for (const [key,value] of [['zero',0], ['false',false], ['null',null]]) cache.set(key,value,null);
  now = 100000;
  assert.equal(cache.get('zero'),0); assert.equal(cache.get('false'),false); assert.equal(cache.get('null'),null);
});
test('concurrent tenant isolation and same-pair dedup', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const seen = [];
  const client = createClient({ cache:createCache(), load:async (tenant,key) => { seen.push([tenant,key]); await barrier; return tenant + '/' + key; }, ttlMs:null });
  const a = client.get('alpha','k'); const duplicate = client.get('alpha','k'); const b = client.get('beta','k');
  await Promise.resolve(); await Promise.resolve(); release();
  assert.deepEqual(await Promise.all([a,duplicate,b]), ['alpha/k','alpha/k','beta/k']);
  assert.deepEqual(seen, [['alpha','k'], ['beta','k']]);
});
test('client uses collision-free cache identity', async () => {
  const client = createClient({cache:createCache(), load:async (tenant,key)=>JSON.stringify([tenant,key]), ttlMs:null});
  assert.equal(await client.get('a:b','c'),JSON.stringify(['a:b','c']));
  assert.equal(await client.get('a','b:c'),JSON.stringify(['a','b:c']));
});
test('failed load is released and never cached', async () => {
  let calls=0;
  const client=createClient({cache:createCache(),load:async ()=>{if(++calls===1)throw new Error('transient');return 'ok';},ttlMs:null});
  await assert.rejects(client.get('a','k'),/transient/);
  assert.equal(await client.get('a','k'),'ok'); assert.equal(calls,2);
  assert.equal(await client.get('a','k'),'ok'); assert.equal(calls,2);
});
`;

export async function writeCacheFixture(workspace: string): Promise<void> {
  for (const [relative, content] of Object.entries(CACHE_FILES)) {
    const file = path.join(workspace, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { flag: 'wx' });
  }
}
