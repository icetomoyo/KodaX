import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createMcpCatalogRevision,
  createMcpCapabilityId,
  getMcpCachePaths,
  normalizeMcpCapabilityId,
  parseMcpCapabilityId,
  sanitizeMcpIcons,
  searchMcpCatalog,
  summarizeMcpArgsSignature,
  summarizeMcpServerPurpose,
  type McpCatalogItem,
} from './catalog.js';

function catalogItem(
  serverId: string,
  name: string,
  summary: string,
): McpCatalogItem {
  return {
    id: createMcpCapabilityId(serverId, 'tool', name),
    serverId,
    kind: 'tool',
    name,
    summary,
    cachedAt: '2026-07-15T00:00:00.000Z',
  };
}

describe('MCP capability ids', () => {
  it('creates and parses canonical mcp:<server>:<kind>:<name> ids', () => {
    const id = createMcpCapabilityId('git-nexus', 'tool', 'list_branches');

    expect(id).toBe('mcp:git-nexus:tool:list_branches');
    expect(parseMcpCapabilityId(id)).toEqual({
      serverId: 'git-nexus',
      kind: 'tool',
      name: 'list_branches',
    });
  });

  it('normalizes the common missing-scheme form from model tool calls', () => {
    const id = 'git-nexus:tool:list_branches';

    expect(normalizeMcpCapabilityId(id)).toBe('mcp:git-nexus:tool:list_branches');
    expect(parseMcpCapabilityId(id)).toEqual({
      serverId: 'git-nexus',
      kind: 'tool',
      name: 'list_branches',
    });
  });

  it('normalizes legacy mcp:// URI capability ids', () => {
    const id = 'mcp://git-nexus/resource/memory%3A%2F%2Fguide';

    expect(normalizeMcpCapabilityId(id)).toBe('mcp:git-nexus:resource:memory%3A%2F%2Fguide');
    expect(parseMcpCapabilityId(id)).toEqual({
      serverId: 'git-nexus',
      kind: 'resource',
      name: 'memory://guide',
    });
  });

  it('preserves embedded colons in the capability name segment', () => {
    const rawColonId = 'mcp:srv:tool:tool:read';
    const encodedColonId = createMcpCapabilityId('srv', 'tool', 'tool:read');

    expect(normalizeMcpCapabilityId(rawColonId)).toBe(rawColonId);
    expect(parseMcpCapabilityId(rawColonId)).toEqual({
      serverId: 'srv',
      kind: 'tool',
      name: 'tool:read',
    });
    expect(encodedColonId).toBe('mcp:srv:tool:tool%3Aread');
    expect(parseMcpCapabilityId(encodedColonId).name).toBe('tool:read');
  });

  it('does not reinterpret malformed mcp-prefixed short ids as server ids', () => {
    const malformed = 'mcp:tool:something';

    expect(normalizeMcpCapabilityId(malformed)).toBe(malformed);
    expect(() => parseMcpCapabilityId(malformed)).toThrow(
      'Invalid MCP capability id: mcp:tool:something',
    );
  });

  it('normalizes idempotently across accepted input shapes', () => {
    const ids = [
      'mcp:git-nexus:tool:list_branches',
      'git-nexus:tool:list_branches',
      'mcp://git-nexus/resource/memory%3A%2F%2Fguide',
      'mcp:srv:tool:tool:read',
      '  git-nexus:tool:x  ',
      'mcp:tool:something',
    ];

    for (const id of ids) {
      const once = normalizeMcpCapabilityId(id);
      expect(normalizeMcpCapabilityId(once)).toBe(once);
    }
  });
});

describe('summarizeMcpServerPurpose', () => {
  it('takes the first prose sentence of instructions, skipping headings', () => {
    expect(summarizeMcpServerPurpose({
      instructions: '# GitHub MCP\n\nManage repositories and issues. Use search before writing.',
      serverInfo: { name: 'github', title: 'GitHub' },
    })).toBe('Manage repositories and issues.');
    expect(summarizeMcpServerPurpose({ instructions: '查询内部知识库。写入需要审批。' })).toBe('查询内部知识库。');
  });

  it('falls back to serverInfo description, then title, and caps the length', () => {
    expect(summarizeMcpServerPurpose({ instructions: '  ', serverInfo: { description: 'Query the warehouse.', title: 'DB' } }))
      .toBe('Query the warehouse.');
    expect(summarizeMcpServerPurpose({ serverInfo: { name: 'db', title: 'Analytics DB' } })).toBe('Analytics DB');
    expect(summarizeMcpServerPurpose({ serverInfo: { name: 'db' } })).toBeUndefined();
    const long = summarizeMcpServerPurpose({ instructions: 'word '.repeat(60) });
    expect(long).toHaveLength(100);
    expect(long?.endsWith('…')).toBe(true);
  });
});

describe('summarizeMcpArgsSignature', () => {
  it('lists schema properties in order and marks optional ones', () => {
    expect(summarizeMcpArgsSignature({
      type: 'object',
      properties: { owner: {}, repo: {}, body: {} },
      required: ['owner', 'repo'],
    })).toBe('(owner, repo, body?)');
    expect(summarizeMcpArgsSignature({ type: 'object' })).toBe('()');
    expect(summarizeMcpArgsSignature(undefined)).toBeUndefined();
  });

  it('reads prompt argument arrays and truncates long lists', () => {
    expect(summarizeMcpArgsSignature([{ name: 'pr', required: true }, { name: 'focus' }, { bogus: 1 }])).toBe('(pr, focus?)');
    const properties = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`a${index}`, {}]));
    expect(summarizeMcpArgsSignature({ type: 'object', properties })).toBe('(a0?, a1?, a2?, a3?, a4?, a5?, a6?, a7?, …)');
  });
});

describe('sanitizeMcpIcons', () => {
  it('keeps http(s) and data URIs and normalizes optional fields', () => {
    const icons = sanitizeMcpIcons([
      { src: 'https://example.com/a.png', mimeType: 'image/png', sizes: ['48x48', ''], theme: 'dark' },
      { src: 'data:image/svg+xml;base64,AAAA' },
    ]);
    expect(icons).toEqual([
      { src: 'https://example.com/a.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'dark' },
      { src: 'data:image/svg+xml;base64,AAAA' },
    ]);
  });

  it('drops unsafe-scheme, relative, and malformed icons', () => {
    expect(sanitizeMcpIcons([
      { src: 'javascript:alert(1)' },
      { src: 'file:///etc/passwd' },
      { src: 'ftp://host/x.png' },
      { src: 'ws://host/x.png' },
      { src: '/relative/icon.png' },
      { src: '' },
      { nope: true },
      42,
      null,
    ])).toBeUndefined();
  });

  it('returns undefined for non-array input', () => {
    expect(sanitizeMcpIcons(undefined)).toBeUndefined();
    expect(sanitizeMcpIcons({ src: 'https://x/y.png' })).toBeUndefined();
  });

  it('ignores invalid theme and non-string sizes', () => {
    expect(sanitizeMcpIcons([
      { src: 'https://x/y.png', theme: 'rainbow', sizes: ['16x16', 5, null] },
    ])).toEqual([{ src: 'https://x/y.png', sizes: ['16x16'] }]);
  });
});

describe('MCP catalog discovery', () => {
  const items = [
    catalogItem('github', 'list_pull_requests', 'List pull requests in a repository.'),
    catalogItem('github', 'issue_write', 'Create or update a repository issue.'),
    catalogItem('other', 'github_status', 'Read a service status page.'),
  ];

  it('ranks exact names first and matches multi-token queries across fields', () => {
    expect(searchMcpCatalog(items, 'issue_write').map((item) => item.name)).toEqual([
      'issue_write',
    ]);
    expect(searchMcpCatalog(items, 'github issue').map((item) => item.name)).toEqual([
      'issue_write',
      'github_status',
      'list_pull_requests',
    ]);
  });

  it('always ranks complete-token matches ahead of stronger partial matches', () => {
    const terms = Array.from({ length: 20 }, (_, index) => `term${index}`);
    const complete = catalogItem('demo', 'complete_candidate', terms.join(' '));
    const partial = catalogItem('demo', terms.slice(0, -1).join('_'), 'Partial match only.');

    expect(searchMcpCatalog([partial, complete], terms.join(' ')).map((item) => item.name))
      .toEqual([complete.name, partial.name]);
  });

  it('segments compact CJK queries so same-language catalog metadata remains searchable', () => {
    const chineseItems = [
      catalogItem('demo', 'create_issue', '创建一个新的项目问题。'),
      catalogItem('demo', 'list_issues', '列出项目中的已有问题。'),
    ];

    expect(searchMcpCatalog(chineseItems, '创建问题').map((item) => item.name)).toEqual([
      'create_issue',
      'list_issues',
    ]);
  });

  it('returns a stable complete inventory when no limit is provided', () => {
    expect(searchMcpCatalog([...items].reverse(), '').map((item) => item.id)).toEqual(
      [...items].map((item) => item.id).sort((left, right) => left.localeCompare(right)),
    );
  });

  it('uses catalog content rather than refresh time for revisions', () => {
    const sameContentNewTimestamp = items.map((item) => ({
      ...item,
      cachedAt: '2026-07-16T00:00:00.000Z',
    }));
    expect(createMcpCatalogRevision(sameContentNewTimestamp)).toBe(
      createMcpCatalogRevision(items),
    );
    expect(createMcpCatalogRevision([
      ...items,
      catalogItem('github', 'new_tool', 'A newly published tool.'),
    ])).not.toBe(createMcpCatalogRevision(items));
  });
});

describe('getMcpCachePaths', () => {
  it('keeps ordinary server ids readable', () => {
    const paths = getMcpCachePaths('/cache', 'github-server_1.2');
    expect(path.basename(paths.indexPath)).toBe('github-server_1.2.index.json');
  });

  it('keeps hostile or Windows-invalid server ids inside the catalog directory', () => {
    for (const serverId of ['../evil', 'a:b*?', '..', 'x/y\\z', '.hidden']) {
      const paths = getMcpCachePaths('/cache', serverId);
      for (const file of [paths.indexPath, paths.itemsPath]) {
        expect(path.dirname(file)).toBe(paths.catalogDir);
        expect(path.basename(file)).not.toMatch(/[<>:"/\\|?*]/);
        expect(path.basename(file).startsWith('.')).toBe(false);
      }
    }
  });

  it('keeps distinct server ids in distinct files', () => {
    expect(getMcpCachePaths('/cache', 'a:b').indexPath)
      .not.toBe(getMcpCachePaths('/cache', 'a%3Ab').indexPath);
  });
});
