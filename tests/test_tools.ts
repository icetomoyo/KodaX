/**
 * KodaX TypeScript 版本测试
 * 对应 Python 版本 test_tools.py
 */

import assert from 'assert';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

// 导入被测试的模块
import {
  executeTool,
  estimateTokens,
  compactMessages,
  generateSessionId,
  saveSession,
  loadSession,
  listSessions,
  loadSkills,
  PROVIDERS,
  getProvider,
  checkPromiseSignal,
} from '../src/kodax';

// ============== 测试工具函数 ==============

let tmpdir: string;

async function setup() {
  tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-test-'));
  console.log(`Test directory: ${tmpdir}`);
}

async function teardown() {
  await fs.rm(tmpdir, { recursive: true, force: true });
}

// ============== 测试用例 ==============

async function testTools() {
  console.log('=' .repeat(50));
  console.log('Testing tools');
  console.log('=' .repeat(50));

  // read/write
  const testFile = path.join(tmpdir, 'test.txt');
  let result = await executeTool('write', { path: testFile, content: 'Hello' }, new Set(), new Map(), false);
  assert.ok(result.toLowerCase().includes('written'), `Expected 'written' in result, got: ${result}`);
  result = await executeTool('read', { path: testFile }, new Set(), new Map(), false);
  assert.ok(result.includes('Hello'), `Expected 'Hello' in result, got: ${result}`);
  console.log('  ✓ read/write');

  // edit
  result = await executeTool('edit', { path: testFile, old_string: 'Hello', new_string: 'World' }, new Set(), new Map(), false);
  assert.ok(result.toLowerCase().includes('edited'), `Expected 'edited' in result, got: ${result}`);
  console.log('  ✓ edit');

  // glob
  result = await executeTool('glob', { pattern: '*.txt', path: tmpdir }, new Set(), new Map(), false);
  assert.ok(result.includes('test.txt'), `Expected 'test.txt' in result, got: ${result}`);
  console.log('  ✓ glob');

  // grep
  result = await executeTool('grep', { pattern: 'World', path: tmpdir }, new Set(), new Map(), false);
  assert.ok(result.includes('World'), `Expected 'World' in result, got: ${result}`);
  console.log('  ✓ grep');

  // bash
  result = await executeTool('bash', { command: 'echo test' }, new Set(), new Map(), false);
  assert.ok(result.includes('test'), `Expected 'test' in result, got: ${result}`);
  console.log('  ✓ bash');

  // undo
  result = await executeTool('undo', {}, new Set(), new Map(), false);
  // undo 应该恢复之前的状态
  console.log('  ✓ undo');
}

async function testToolReturnFormats() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing tool return formats (与 Python 一致)');
  console.log('=' .repeat(50));

  const testFile = path.join(tmpdir, 'format_test.txt');

  // write 返回格式
  let result = await executeTool('write', { path: testFile, content: 'test' }, new Set(), new Map(), false);
  assert.ok(result === `File written: ${testFile}`, `Expected 'File written: ${testFile}', got: ${result}`);
  console.log('  ✓ write return format');

  // edit 返回格式
  result = await executeTool('edit', { path: testFile, old_string: 'test', new_string: 'TEST' }, new Set(), new Map(), false);
  assert.ok(result === `File edited: ${testFile}`, `Expected 'File edited: ${testFile}', got: ${result}`);
  console.log('  ✓ edit return format');
}

async function testErrorFormats() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing error formats');
  console.log('=' .repeat(50));

  // 文件不存在错误
  const result = await executeTool('read', { path: '/nonexistent/file.txt' }, new Set(), new Map(), false);
  assert.ok(result.includes('[Tool Error]'), `Expected '[Tool Error]' in result, got: ${result}`);
  console.log('  ✓ [Tool Error] prefix');

  // old_string 不存在错误
  const testFile = path.join(tmpdir, 'error_test.txt');
  await executeTool('write', { path: testFile, content: 'Hello' }, new Set(), new Map(), false);
  const editResult = await executeTool('edit', { path: testFile, old_string: 'NotExist', new_string: 'Test' }, new Set(), new Map(), false);
  assert.ok(editResult.includes('[Tool Error]'), `Expected '[Tool Error]' in edit result, got: ${editResult}`);
  console.log('  ✓ edit error format');
}

async function testTokenEstimation() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing token estimation');
  console.log('=' .repeat(50));

  // 简单消息
  const messages = [{ role: 'user' as const, content: 'x'.repeat(100) }];
  const tokens = estimateTokens(messages);
  assert.strictEqual(tokens, 25, `Expected 25 tokens, got: ${tokens}`); // 100 / 4
  console.log(`  Simple message: ${tokens} tokens ✓`);

  // 复杂消息
  const complexMessages = [
    { role: 'user' as const, content: 'Hello' },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Hi there' }] }
  ];
  const complexTokens = estimateTokens(complexMessages);
  console.log(`  Complex message: ${complexTokens} tokens ✓`);
}

async function testCompact() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing context compaction');
  console.log('=' .repeat(50));

  // 创建大量消息
  const messages = Array(20).fill(null).map(() => ({ role: 'user' as const, content: 'x'.repeat(10000) }));
  const originalTokens = estimateTokens(messages);
  console.log(`  Before: ${originalTokens} tokens`);

  const compressed = compactMessages(messages);
  const compressedTokens = estimateTokens(compressed);
  console.log(`  After: ${compressedTokens} tokens`);

  assert.ok(compressedTokens < originalTokens, 'Compressed tokens should be less than original');
  console.log('  ✓ Compaction works');

  // 验证摘要格式
  if (compressed[0] && typeof compressed[0].content === 'string') {
    assert.ok(compressed[0].content.includes('[对话历史摘要]'), 'Should use [对话历史摘要] format');
    console.log('  ✓ Summary format is [对话历史摘要]');
  }
}

async function testPromiseSignals() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing promise signals (Ralph-Loop style)');
  console.log('=' .repeat(50));

  // 测试 COMPLETE 信号
  let [signal, reason] = checkPromiseSignal('Great work! <promise>COMPLETE</promise>');
  assert.strictEqual(signal, 'COMPLETE');
  assert.strictEqual(reason, '');
  console.log('  ✓ COMPLETE signal detected');

  // 测试 BLOCKED 信号带原因
  [signal, reason] = checkPromiseSignal("I'm stuck: <promise>BLOCKED:Need API key</promise>");
  assert.strictEqual(signal, 'BLOCKED');
  assert.strictEqual(reason, 'Need API key');
  console.log('  ✓ BLOCKED signal with reason detected');

  // 测试 DECIDE 信号
  [signal, reason] = checkPromiseSignal('<promise>DECIDE:Which framework to use?</promise>');
  assert.strictEqual(signal, 'DECIDE');
  assert.strictEqual(reason, 'Which framework to use?');
  console.log('  ✓ DECIDE signal with reason detected');

  // 测试无信号
  [signal, reason] = checkPromiseSignal('This is normal output without any promise');
  assert.strictEqual(signal, '');
  assert.strictEqual(reason, '');
  console.log('  ✓ No signal in normal text');

  // 测试大小写不敏感
  [signal, reason] = checkPromiseSignal('<promise>complete</promise>');
  assert.strictEqual(signal, 'COMPLETE');
  console.log('  ✓ Case-insensitive detection');
}

async function testProviders() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing provider registry');
  console.log('=' .repeat(50));

  const expected = ['anthropic', 'openai', 'kimi', 'kimi-code', 'qwen', 'zhipu', 'zhipu-coding'];
  const actual = Object.keys(PROVIDERS);

  for (const provider of expected) {
    assert.ok(actual.includes(provider), `Missing provider: ${provider}`);
  }
  console.log(`  Available providers: ${actual.join(', ')}`);
  console.log('  ✓ All providers registered');
}

async function testSkills() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing skill system');
  console.log('=' .repeat(50));

  const skills = await loadSkills();
  console.log(`  Loaded skills: ${Object.keys(skills).length > 0 ? Object.keys(skills).join(', ') : '(none)'}`);
  console.log('  ✓ Skill loading works');
}

async function testGrepOutputFormat() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing grep output format');
  console.log('=' .repeat(50));

  const testFile = path.join(tmpdir, 'grep_test.txt');
  await executeTool('write', { path: testFile, content: 'Hello World\nFoo Bar\nTest Line' }, new Set(), new Map(), false);

  const result = await executeTool('grep', { pattern: 'World', path: testFile }, new Set(), new Map(), false);

  // 验证格式: file:line: content (空格分隔)
  assert.ok(result.includes(': 1: '), 'Should have format file:line: content with space');
  console.log('  ✓ grep output format is file:line: content');
}

async function testGlobOutputFormat() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing glob output format');
  console.log('=' .repeat(50));

  // 创建测试文件
  await executeTool('write', { path: path.join(tmpdir, 'a.txt'), content: 'a' }, new Set(), new Map(), false);
  await executeTool('write', { path: path.join(tmpdir, 'b.txt'), content: 'b' }, new Set(), new Map(), false);

  const result = await executeTool('glob', { pattern: '*.txt', path: tmpdir }, new Set(), new Map(), false);

  // 验证不包含 "Found X files:" 前缀
  assert.ok(!result.includes('Found'), 'Should not include "Found X files:" prefix');
  assert.ok(result.includes('a.txt'), 'Should include a.txt');
  assert.ok(result.includes('b.txt'), 'Should include b.txt');
  console.log('  ✓ glob output format is simple file list');
}

async function testReadWithLineNumbers() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing read with line numbers (TS improvement)');
  console.log('=' .repeat(50));

  const testFile = path.join(tmpdir, 'lines.txt');
  await executeTool('write', { path: testFile, content: 'Line 1\nLine 2\nLine 3' }, new Set(), new Map(), false);

  const result = await executeTool('read', { path: testFile }, new Set(), new Map(), false);

  // TS 版本有行号
  assert.ok(result.includes('1\t'), 'Should have line number 1');
  assert.ok(result.includes('2\t'), 'Should have line number 2');
  console.log('  ✓ read includes line numbers');

  // 测试 offset 和 limit
  const partialResult = await executeTool('read', { path: testFile, offset: 2, limit: 1 }, new Set(), new Map(), false);
  assert.ok(partialResult.includes('Line 2'), 'Should include Line 2');
  console.log('  ✓ read with offset/limit works');
}

async function testEditReplaceAll() {
  console.log('\n' + '='.repeat(50));
  console.log('Testing edit replace_all (TS improvement)');
  console.log('=' .repeat(50));

  const testFile = path.join(tmpdir, 'replace_test.txt');
  await executeTool('write', { path: testFile, content: 'foo foo foo' }, new Set(), new Map(), false);

  // 不使用 replace_all 应该报错（多个匹配）
  const errorResult = await executeTool('edit', { path: testFile, old_string: 'foo', new_string: 'bar' }, new Set(), new Map(), false);
  assert.ok(errorResult.includes('[Tool Error]'), 'Should error on multiple matches without replace_all');
  console.log('  ✓ error on multiple matches without replace_all');

  // 使用 replace_all
  const result = await executeTool('edit', { path: testFile, old_string: 'foo', new_string: 'bar', replace_all: true }, new Set(), new Map(), false);
  assert.ok(result.includes('edited'), 'Should edit successfully with replace_all');
  console.log('  ✓ replace_all works');
}

// ============== 主函数 ==============

async function main() {
  console.log('KodaX TypeScript Test Suite\n');

  try {
    await setup();

    // 运行所有测试
    await testTools();
    await testToolReturnFormats();
    await testErrorFormats();
    await testTokenEstimation();
    await testCompact();
    await testPromiseSignals();
    await testProviders();
    await testSkills();
    await testGrepOutputFormat();
    await testGlobOutputFormat();
    await testReadWithLineNumbers();
    await testEditReplaceAll();

    console.log('\n' + '='.repeat(50));
    console.log('ALL TESTS PASSED!');
    console.log('=' .repeat(50));

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  } finally {
    await teardown();
  }
}

main();
