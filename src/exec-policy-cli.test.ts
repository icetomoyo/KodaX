import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { configureKodaXExecPolicyCommand } from './exec-policy-cli.js';
import { configureKodaXRootCommand } from './cli/root.js';

describe('FEATURE_297 execpolicy CLI', () => {
  it('checks Full Access without the bundled fallback and reports the selected mode', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-execpolicy-full-'));
    let output = '';
    const program = new Command().name('kodax').exitOverride();
    configureKodaXExecPolicyCommand(program, {
      configHome, findProjectRoot: async () => null,
      writeOutput: (text) => { output = text; },
    });
    await program.parseAsync([
      'node', 'kodax', 'execpolicy', 'check', '--json', '--permission-mode', 'full-access', '--', 'rm -f generated.txt',
    ]);
    expect(JSON.parse(output)).toMatchObject({
      permissionMode: 'full-access', decision: 'unmatched', criticalFallback: false,
      matchedRules: [],
    });
  });

  it('takes the permission profile under the kodax root, whose --mode means output mode', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-execpolicy-root-'));
    let output = '';
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());
    configureKodaXExecPolicyCommand(program, {
      configHome, findProjectRoot: async () => null,
      writeOutput: (text) => { output = text; },
    });
    await program.parseAsync([
      'node', 'kodax', 'execpolicy', 'check', '--json', '--permission-mode', 'full-access', '--', 'git status',
    ]);
    expect(JSON.parse(output)).toMatchObject({ permissionMode: 'full-access' });
  });

  it('prints the decision and the matched rules as text by default', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-execpolicy-text-'));
    await writeFile(join(configHome, 'exec-policy.jsonc'), JSON.stringify({
      rules: [{ prefix: ['git', 'push'], decision: 'forbidden', justification: 'Publishing is disabled' }],
    }));
    const outputs: string[] = [];
    const program = new Command().name('kodax').exitOverride();
    configureKodaXExecPolicyCommand(program, {
      configHome, findProjectRoot: async () => null,
      writeOutput: (text) => { outputs.push(text); },
    });
    await program.parseAsync(['node', 'kodax', 'execpolicy', 'check', '--', 'git', 'push']);
    await program.parseAsync(['node', 'kodax', 'execpolicy', 'check', '--', 'git', 'status']);
    expect(outputs[0]).toBe(`Decision: forbidden\nMatched rules:\n  forbidden  user ${join(configHome, 'exec-policy.jsonc')}: Publishing is disabled\n`);
    expect(outputs[1]).toMatch(/^Decision: unmatched/);
  });

  it.each([
    ['bash -c "git push"'],
    ['bash', '-c', 'git push'],
  ])('keeps explicit wrapper restrictions for command arguments %j', async (...command) => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-execpolicy-wrapper-'));
    await writeFile(join(configHome, 'exec-policy.jsonc'), JSON.stringify({
      rules: [{ prefix: ['git', 'push'], decision: 'forbidden', justification: 'Publishing is disabled' }],
    }));
    let output = '';
    const program = new Command().name('kodax').exitOverride();
    configureKodaXExecPolicyCommand(program, {
      configHome, findProjectRoot: async () => null,
      writeOutput: (text) => { output = text; },
    });
    await program.parseAsync(['node', 'kodax', 'execpolicy', 'check', '--json', '--permission-mode', 'full-access', '--', ...command]);
    expect(JSON.parse(output)).toMatchObject({
      permissionMode: 'full-access', decision: 'forbidden',
      matchedRules: [expect.objectContaining({ source: 'user' })],
    });
  });

  it('reports the effective rule without executing the checked command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-execpolicy-cli-'));
    const configHome = join(root, 'home');
    const marker = join(root, 'must-not-exist');
    await mkdir(configHome, { recursive: true });
    await writeFile(join(configHome, 'exec-policy.jsonc'), JSON.stringify({
      rules: [{
        prefix: ['node', '-e'],
        decision: 'forbidden',
        justification: 'Test commands are inspected only',
      }],
    }));

    let output = '';
    const program = new Command().name('kodax').exitOverride();
    configureKodaXExecPolicyCommand(program, {
      configHome,
      findProjectRoot: async () => null,
      writeOutput: (text) => { output += text; },
    });
    await program.parseAsync([
      'node',
      'kodax',
      'execpolicy',
      'check',
      '--json',
      'node',
      '-e',
      `require('node:fs').writeFileSync('${marker}', 'executed')`,
    ]);

    expect(JSON.parse(output)).toMatchObject({
      command: ['node', '-e', expect.any(String)],
      decision: 'forbidden',
      matchedRules: [{
        source: 'user',
        sourcePath: join(configHome, 'exec-policy.jsonc'),
        decision: 'forbidden',
        justification: 'Test commands are inspected only',
      }],
    });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the runtime shell evaluator for an explicitly quoted compound command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-execpolicy-compound-'));
    const configHome = join(root, 'home');
    await mkdir(configHome, { recursive: true });
    let output = '';
    const program = new Command().name('kodax').exitOverride();
    configureKodaXExecPolicyCommand(program, {
      configHome,
      findProjectRoot: async () => null,
      writeOutput: (text) => { output += text; },
    });

    await program.parseAsync([
      'node', 'kodax', 'execpolicy', 'check', '--pretty', 'git status && rm -rf /',
    ]);

    expect(JSON.parse(output)).toMatchObject({
      decision: 'forbidden',
      criticalFallback: true,
    });
  });

  it('matches network and host-executable qualifiers for ordinary command tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-execpolicy-qualifiers-'));
    const configHome = join(root, 'home');
    await mkdir(configHome, { recursive: true });
    await writeFile(join(configHome, 'exec-policy.jsonc'), JSON.stringify({
      rules: [{
        prefix: ['curl'],
        decision: 'forbidden',
        justification: 'The exact host route may not call this service',
        hostExecutable: ['cmd.exe'],
        network: ['api.example.com'],
        compound: false,
      }],
    }));
    let output = '';
    const program = new Command().name('kodax').exitOverride();
    configureKodaXExecPolicyCommand(program, {
      configHome,
      findProjectRoot: async () => null,
      writeOutput: (text) => { output += text; },
    });

    await program.parseAsync([
      'node',
      'kodax',
      'execpolicy',
      'check',
      '--json',
      '--host-executable',
      'cmd.exe',
      'curl',
      'https://api.example.com/v1',
    ]);

    expect(JSON.parse(output)).toMatchObject({
      command: ['curl', 'https://api.example.com/v1'],
      decision: 'forbidden',
      matchedRules: [{
        justification: 'The exact host route may not call this service',
        hostExecutable: ['cmd.exe'],
        network: ['api.example.com'],
        compound: false,
      }],
    });
  });
});
