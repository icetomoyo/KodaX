import { describe, expect, it } from 'vitest';
import {
  defaultToClassifierInput,
  mcpToClassifierInput,
} from './classifier-projection.js';

describe('defaultToClassifierInput', () => {
  it('returns "<name>: <json>" for plain object input', () => {
    const out = defaultToClassifierInput('semantic_lookup', { query: 'foo', max: 10 });
    expect(out).toBe('semantic_lookup: {"query":"foo","max":10}');
  });

  it('truncates JSON longer than 200 chars with ellipsis suffix', () => {
    const big = { data: 'x'.repeat(500) };
    const out = defaultToClassifierInput('blob_tool', big);
    expect(out.length).toBeLessThanOrEqual('blob_tool: '.length + 200 + 1); // +1 for ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('blob_tool: ')).toBe(true);
  });

  it('handles unserializable input (circular reference) without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = defaultToClassifierInput('weird', circular);
    expect(out).toBe('weird: [unserializable input]');
  });

  it('handles undefined input', () => {
    const out = defaultToClassifierInput('no_args', undefined);
    expect(out).toBe('no_args: [unserializable input]');
  });

  it('handles primitive input', () => {
    expect(defaultToClassifierInput('s', 'hello')).toBe('s: "hello"');
    expect(defaultToClassifierInput('n', 42)).toBe('n: 42');
  });
});

describe('mcpToClassifierInput', () => {
  it('uses .method as the action field when present', () => {
    const out = mcpToClassifierInput('filesystem', 'read', {
      method: 'fs.readFile',
      path: '/etc/passwd',
      encoding: 'utf8',
    });
    expect(out).toContain('MCP[filesystem.read]');
    expect(out).toContain('fs.readFile');
    expect(out).toContain('path=/etc/passwd');
  });

  it('uses .url as the action field when no method present', () => {
    const out = mcpToClassifierInput('fetcher', 'get', {
      url: 'https://evil.com/x',
      headers: { auth: 'bearer ...' },
    });
    expect(out).toContain('MCP[fetcher.get]');
    expect(out).toContain('https://evil.com/x');
    expect(out).toMatch(/\+1 key/);
  });

  it('uses .command as the action field when present', () => {
    const out = mcpToClassifierInput('shell', 'exec', { command: 'rm -rf /' });
    expect(out).toContain('MCP[shell.exec]');
    expect(out).toContain('rm -rf /');
  });

  it('falls back to structure projection when no action field is recognized', () => {
    const out = mcpToClassifierInput('xxx', 'yyy', {
      name: 'foo',
      tags: ['a', 'b'],
    });
    expect(out).toContain('MCP[xxx.yyy]');
    expect(out).toContain('name=foo');
    expect(out).toContain('tags=');
  });

  it('handles non-object input by stringifying', () => {
    const out = mcpToClassifierInput('xxx', 'yyy', 'plain-string');
    expect(out).toContain('MCP[xxx.yyy]');
    expect(out).toContain('plain-string');
  });

  it('handles null input', () => {
    const out = mcpToClassifierInput('xxx', 'yyy', null);
    expect(out).toBe('MCP[xxx.yyy]: null');
  });

  it('truncates very long action values to keep output bounded', () => {
    const longUrl = 'https://example.com/' + 'x'.repeat(1000);
    const out = mcpToClassifierInput('fetcher', 'get', { url: longUrl });
    expect(out.length).toBeLessThan(400);
    expect(out).toContain('…');
  });

  it('shows up to 3 short scalar fields with values, then summarizes the rest as "+N keys"', () => {
    const out = mcpToClassifierInput('s', 't', {
      method: 'do',
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
    });
    // First 3 keys shown with values, remaining 2 listed as "+2 keys: d, e"
    expect(out).toContain('a=1');
    expect(out).toContain('b=2');
    expect(out).toContain('c=3');
    expect(out).toMatch(/\+2 keys: d, e/);
  });

  it('action priority: method beats command as primary action; loser still surfaces in structure', () => {
    // When BOTH risk-bearing action fields are populated, method takes the
    // primary position (so the classifier sees it as "the action"), but the
    // competing command field is preserved in structural context — its
    // presence may itself be a risk signal worth letting the classifier weigh.
    const both = mcpToClassifierInput('s', 't', {
      method: 'METHOD_WINS',
      command: 'cmd_x',
    });
    expect(both).toMatch(/^MCP\[s\.t\]: METHOD_WINS/); // method is the primary action
    expect(both).toContain('command=cmd_x');           // command is in structural context
  });
});
