import fs from 'node:fs/promises';
import path from 'node:path';
import { CACHE_FILES as BASE_FILES, CACHE_GOLDEN as BASE_GOLDEN, CACHE_ORACLE } from '../tool-entry-complex/fixture.js';

export { CACHE_ORACLE };
export const CACHE_TASK = `请修复这个跨包缓存客户端的租户隔离和 TTL 边界问题，并增加有效回归测试。
以 README 的公开契约为准，保留现有 API、重导出和正常行为。先定位真正被公开入口使用的实现；仓库中还有同名的旧示例，不要误改。
考虑 tenant/key 任意字符串编码、同一 pair 的并发去重、不同租户隔离、到期瞬间、零 TTL、null/false/0 缓存值，以及加载失败后重试。
只修改 packages 下实现并在 tests 新增回归；保留 README、package.json、src 公共入口、examples 和 tests/basic.test.js 原样，不添加依赖。
请运行测试、检查改动并如实说明验证范围；旧测试通过本身不足以证明这些问题已修复。`;

function clientSource(source: string): string {
  return source.replace("import { cacheKey } from './keys.js';", "import { pairIdentity as cacheKey } from '../identity/index.js';");
}

export const CACHE_FILES: Readonly<Record<string, string>> = {
  'README.md': BASE_FILES['README.md']! + '\nStable public entry points in src re-export the packages implementation. Examples are historical, unused by this API and must stay unchanged.\n',
  'package.json': BASE_FILES['package.json']!,
  'tests/basic.test.js': BASE_FILES['tests/basic.test.js']!,
  'src/keys.js': "export { pairIdentity as cacheKey } from '../packages/identity/index.js';\n",
  'src/cache.js': "export { createCache } from '../packages/cache/store.js';\n",
  'src/client.js': "export { createClient } from '../packages/client/index.js';\n",
  'packages/identity/index.js': "export { cacheKey as pairIdentity } from './key.js';\n",
  'packages/identity/key.js': BASE_FILES['src/keys.js']!,
  'packages/cache/store.js': BASE_FILES['src/cache.js']!,
  'packages/client/index.js': "export { createClient } from './request-cache.js';\n",
  'packages/client/request-cache.js': clientSource(BASE_FILES['src/client.js']!),
  'examples/legacy-key.js': BASE_FILES['src/keys.js']!,
  'examples/legacy-cache.js': BASE_FILES['src/cache.js']!,
};

export const CACHE_GOLDEN: Readonly<Record<string, string>> = {
  'packages/identity/key.js': BASE_GOLDEN['src/keys.js']!,
  'packages/cache/store.js': BASE_GOLDEN['src/cache.js']!,
  'packages/client/request-cache.js': clientSource(BASE_GOLDEN['src/client.js']!),
};

export async function writeCacheFixture(workspace: string): Promise<void> {
  for (const [relative, content] of Object.entries(CACHE_FILES)) {
    const file = path.join(workspace, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { flag: 'wx' });
  }
}
