/**
 * KodaX TypeScript 版本 CLI 测试
 * 对应 Python 版本 test_tools.py
 *
 * 运行方式: node tests/test_cli.js
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 颜色输出
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

let PASSED = 0;
let FAILED = 0;
let TMPDIR;

function pass(msg) {
  console.log(`  ${colors.green}✓${colors.reset} ${msg}`);
  PASSED++;
}

function fail(msg, detail = '') {
  console.log(`  ${colors.red}✗${colors.reset} ${msg}${detail ? ': ' + detail : ''}`);
  FAILED++;
}

function section(title) {
  console.log('\n' + '='.repeat(50));
  console.log(title);
  console.log('='.repeat(50));
}

function run(cmd, input = '') {
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      input: input,
      cwd: path.resolve(__dirname, '..')
    });
    return { success: true, output: result };
  } catch (e) {
    return { success: false, output: e.stdout || e.stderr || e.message };
  }
}

// ============== 测试用例 ==============

function testCLI() {
  section('Testing CLI basics');

  // 帮助
  const help = run('node dist/kodax.js --help');
  if (help.success && help.output.includes('KodaX')) {
    pass('CLI --help works');
  } else {
    fail('CLI --help works', help.output.slice(0, 100));
  }

  // 版本
  const version = run('node dist/kodax.js --version');
  if (version.success) {
    pass(`CLI --version: ${version.output.trim()}`);
  } else {
    fail('CLI --version');
  }
}

function testProviderRegistry() {
  section('Testing provider registry');

  const error = run('node dist/kodax.js --provider nonexistent "test"');
  const output = error.output.toLowerCase();

  const providers = ['anthropic', 'openai', 'kimi', 'qwen', 'zhipu'];
  for (const provider of providers) {
    if (output.includes(provider)) {
      pass(`${provider} provider registered`);
    } else {
      fail(`${provider} provider registered`);
    }
  }
}

function testOptions() {
  section('Testing CLI options');

  const help = run('node dist/kodax.js --help');
  const output = help.output.toLowerCase();

  const options = [
    ['--provider', 'provider'],
    ['--thinking', 'thinking'],
    ['--confirm', 'confirm'],
    ['--session', 'session'],
    ['--parallel', 'parallel'],
    ['--team', 'team'],
    ['--init', 'init']
  ];

  for (const [opt, keyword] of options) {
    if (output.includes(keyword)) {
      pass(`${opt} option exists`);
    } else {
      fail(`${opt} option exists`);
    }
  }
}

function testPromiseSignals() {
  section('Testing promise signals (Ralph-Loop style)');

  const pattern = /<promise>(COMPLETE|BLOCKED|DECIDE)(?::(.*?))?<\/promise>/is;

  // COMPLETE
  let match = '<promise>COMPLETE</promise>'.match(pattern);
  if (match && match[1].toUpperCase() === 'COMPLETE') {
    pass('COMPLETE signal pattern');
  } else {
    fail('COMPLETE signal pattern');
  }

  // BLOCKED with reason
  match = '<promise>BLOCKED:Need API key</promise>'.match(pattern);
  if (match && match[1].toUpperCase() === 'BLOCKED' && match[2] === 'Need API key') {
    pass('BLOCKED signal with reason');
  } else {
    fail('BLOCKED signal with reason');
  }

  // DECIDE
  match = '<promise>DECIDE:Which framework?</promise>'.match(pattern);
  if (match && match[1].toUpperCase() === 'DECIDE') {
    pass('DECIDE signal with reason');
  } else {
    fail('DECIDE signal with reason');
  }

  // Case insensitive
  match = '<promise>complete</promise>'.match(pattern);
  if (match && match[1].toUpperCase() === 'COMPLETE') {
    pass('Case-insensitive signal detection');
  } else {
    fail('Case-insensitive signal detection');
  }
}

function testBuild() {
  section('Testing build');

  const build = run('npm run build');
  if (build.success) {
    pass('npm run build succeeds');
  } else {
    fail('npm run build', build.output.slice(0, 200));
  }

  // 验证 dist 目录存在
  if (fs.existsSync(path.join(__dirname, '..', 'dist', 'kodax.js'))) {
    pass('dist/kodax.js exists');
  } else {
    fail('dist/kodax.js exists');
  }
}

function testFileStructure() {
  section('Testing file structure');

  const files = [
    ['src/kodax.ts', 'Main source file'],
    ['package.json', 'Package config'],
    ['tsconfig.json', 'TypeScript config'],
  ];

  for (const [file, desc] of files) {
    const filePath = path.join(__dirname, '..', file);
    if (fs.existsSync(filePath)) {
      pass(`${file} exists (${desc})`);
    } else {
      fail(`${file} exists (${desc})`);
    }
  }
}

// ============== 主函数 ==============

async function main() {
  console.log(`${colors.cyan}KodaX TypeScript CLI Test Suite${colors.reset}\n`);

  // 创建临时目录
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-test-'));
  console.log(`Test directory: ${TMPDIR}`);

  try {
    // 运行测试
    testBuild();
    testFileStructure();
    testCLI();
    testProviderRegistry();
    testOptions();
    testPromiseSignals();

    // 总结
    console.log('\n' + '='.repeat(50));
    console.log('Test Summary');
    console.log('='.repeat(50));
    console.log(`  ${colors.green}Passed: ${PASSED}${colors.reset}`);
    console.log(`  ${colors.red}Failed: ${FAILED}${colors.reset}`);

    if (FAILED === 0) {
      console.log(`\n${colors.green}==================================================`);
      console.log('ALL BASIC TESTS PASSED!');
      console.log('==================================================' + colors.reset);
      process.exit(0);
    } else {
      console.log(`\n${colors.red}Some tests failed!${colors.reset}`);
      process.exit(1);
    }
  } finally {
    // 清理
    try {
      fs.rmSync(TMPDIR, { recursive: true, force: true });
    } catch (e) { }
  }
}

main();
