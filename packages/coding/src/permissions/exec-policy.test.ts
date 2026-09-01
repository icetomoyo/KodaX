import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateExecPolicy,
  evaluateShellExecPolicy,
  loadExecPolicy,
  parseExecPolicy,
  tokenizeShellCommand,
  type ExecPolicyRule,
} from './exec-policy.js';

describe('FEATURE_297 Exec Policy', () => {
  it('parses JSONC prefix rules with finite token unions and trailing commas', () => {
    const parsed = parseExecPolicy(`{
      // Codex-shaped deterministic host policy
      "rules": [{
        "prefix": [["npm", "pnpm"], "publish"],
        "decision": "prompt",
        "justification": "Publishing changes an external registry",
      }],
    }`, 'memory');

    expect(parsed).toEqual({
      ok: true,
      rules: [{
        prefix: [['npm', 'pnpm'], 'publish'],
        decision: 'prompt',
        justification: 'Publishing changes an external registry',
        source: 'user',
        sourcePath: 'memory',
      }],
    });
  });

  it('rejects an empty justification and malformed match examples', () => {
    expect(parseExecPolicy(JSON.stringify({
      rules: [{ prefix: ['git', 'push'], decision: 'allow', justification: '' }],
    }), 'memory')).toMatchObject({ ok: false });

    expect(parseExecPolicy(JSON.stringify({
      rules: [{
        prefix: ['git', 'push'],
        decision: 'allow',
        justification: 'Expected deployment target',
        match: ['npm publish'],
      }],
    }), 'memory')).toMatchObject({ ok: false });
  });

  it('rejects unknown policy fields instead of silently weakening a typo', () => {
    expect(parseExecPolicy(JSON.stringify({
      rules: [{
        prefix: ['git', 'push'],
        decision: 'forbidden',
        justification: 'External repository mutation',
        decison: 'allow',
      }],
    }), 'memory')).toMatchObject({
      ok: false,
      error: expect.stringContaining('decison'),
    });
  });

  it('rejects an unterminated JSONC block comment', () => {
    expect(parseExecPolicy('{"rules": []} /* unterminated', 'memory'))
      .toMatchObject({ ok: false });
  });

  it('uses the strictest explicit matching decision', () => {
    const rules: ExecPolicyRule[] = [
      rule(['git'], 'allow'),
      rule(['git', 'push'], 'prompt'),
      rule(['git', 'push', '--force'], 'forbidden'),
    ];

    expect(evaluateExecPolicy({ tokens: ['git', 'status'] }, rules).decision).toBe('allow');
    expect(evaluateExecPolicy({ tokens: ['git', 'push', 'origin'] }, rules).decision).toBe('prompt');
    expect(evaluateExecPolicy({
      tokens: ['git', 'push', '--force'],
    }, rules).decision).toBe('forbidden');
  });

  it('honors executable/network qualifiers and compound-shell facts', () => {
    const rules: ExecPolicyRule[] = [{
      ...rule(['curl'], 'allow'),
      hostExecutable: ['curl.exe'],
      network: ['api.example.com'],
      compound: false,
    }];

    expect(evaluateExecPolicy({
      tokens: ['curl', 'https://api.example.com/v1'],
      hostExecutable: 'curl.exe',
      network: ['api.example.com'],
      compound: false,
    }, rules).decision).toBe('allow');
    expect(evaluateExecPolicy({
      tokens: ['curl', 'https://api.example.com/v1'],
      hostExecutable: 'curl.exe',
      network: ['api.example.com'],
      compound: true,
    }, rules).matched).toHaveLength(0);
    expect(evaluateExecPolicy({
      tokens: ['curl', 'https://api.example.com/v1', 'https://evil.example/v1'],
      hostExecutable: 'curl.exe',
      network: ['api.example.com', 'evil.example'],
      compound: false,
    }, rules).matched).toHaveLength(0);
  });

  it('supplies proven shell facts to qualified rules', () => {
    const rules: ExecPolicyRule[] = [{
      ...rule(['curl'], 'forbidden'),
      hostExecutable: ['cmd.exe'],
      network: ['api.example.com'],
    }];

    expect(evaluateShellExecPolicy(
      'curl https://api.example.com/v1',
      rules,
      { hostExecutable: 'cmd.exe' },
    ).decision).toBe('forbidden');
  });

  it('evaluates every compound-shell stage instead of flattening later commands', () => {
    const result = evaluateShellExecPolicy(
      'git status && rm -rf /',
      [rule(['git'], 'allow')],
    );

    expect(result.decision).toBe('forbidden');
    expect(result.criticalFallback).toBe(true);
  });

  it('applies a narrow critical fallback unless an exact explicit allow matches', () => {
    const operation = { tokens: ['rm', '-rf', '/'] } as const;
    expect(evaluateExecPolicy(operation, []).decision).toBe('forbidden');
    expect(evaluateExecPolicy(operation, [rule(['rm', '-rf'], 'allow')]).decision)
      .toBe('forbidden');
    expect(evaluateExecPolicy(operation, [rule(['rm', '-rf', '/'], 'allow')]).decision)
      .toBe('allow');
  });

  it.each([
    ['rm -fr "$HOME"', 'rm_rf_root'],
    ['rm -rf /*', 'rm_rf_root'],
    ['bash -c "rm -rf /"', 'rm_rf_root'],
    ['mkfs.ext4 /dev/sda1', 'mkfs_or_format'],
    ['fdisk /dev/nvme0n1', 'mkfs_or_format'],
    ['format C:', 'mkfs_or_format'],
    ['cmd /c "fo^rmat C:"', 'mkfs_or_format'],
    ['dd if=image.bin of=/dev/sdb', 'dd_disk_write'],
    [':(){ :|:& };:', 'fork_bomb'],
    ['sudo rm -rf /', 'rm_rf_root'],
    ['sudo -u root rm -rf /', 'rm_rf_root'],
    ['doas -u root rm -rf /', 'rm_rf_root'],
    ['command -- rm -rf /', 'rm_rf_root'],
    ['FOO=x rm -rf /', 'rm_rf_root'],
    ['env FOO=x rm -rf /', 'rm_rf_root'],
    ['env -i -- rm -rf /', 'rm_rf_root'],
    ['env -S "rm -rf /"', 'rm_rf_root'],
    ['nice -n 5 rm -rf /', 'rm_rf_root'],
    ['nohup rm -rf /', 'rm_rf_root'],
    ['time -p rm -rf /', 'rm_rf_root'],
    ['setsid -f rm -rf /', 'rm_rf_root'],
    ['stdbuf -oL rm -rf /', 'rm_rf_root'],
    ['timeout --signal=KILL 5s rm -rf /', 'rm_rf_root'],
    ['busybox env rm -rf /', 'rm_rf_root'],
    ['sudo sudo sudo sudo sudo rm -rf /', 'rm_rf_root'],
    ['echo $(rm -rf /)', 'rm_rf_root'],
  ])('applies the critical fallback to %s (%s)', (command, pattern) => {
    const result = evaluateShellExecPolicy(command, []);

    expect(result.decision).toBe('forbidden');
    expect(result.criticalFallback).toBe(true);
    expect(result.matched[0]?.sourcePath).toBe(`builtin:critical-effects/${pattern}`);
  });

  it('does not let unsupported syntax hide an administrator forbidden prefix', () => {
    const adminForbid = {
      ...rule(['rm', '-rf', '/'], 'forbidden'),
      source: 'admin' as const,
    };

    expect(evaluateShellExecPolicy('echo $(rm -rf /)', [adminForbid]).decision)
      .toBe('forbidden');
  });

  it('administrator forbidden remains absolute', () => {
    const userAllow = rule(['git', 'push'], 'allow');
    const adminForbid = {
      ...rule(['git', 'push'], 'forbidden'),
      source: 'admin' as const,
    };
    const result = evaluateExecPolicy({ tokens: ['git', 'push'] }, [userAllow, adminForbid]);
    expect(result.decision).toBe('forbidden');
    expect(result.matched[0]?.source).toBe('admin');
  });

  it('applies administrator forbidden rules to commands behind privilege wrappers', () => {
    const adminForbid = {
      ...rule(['git', 'push'], 'forbidden'),
      source: 'admin' as const,
    };

    expect(evaluateShellExecPolicy('sudo git push', [adminForbid])).toMatchObject({
      decision: 'forbidden',
      matched: [expect.objectContaining({ source: 'admin' })],
    });
  });

  it.each([
    'sudo -u root git push',
    'doas -u root git push',
    'command -- git push',
    'FOO=x git push',
    'env FOO=x git push',
    'env -u TOKEN git push',
    'nice -10 git push',
    'nohup git push',
    'time -f %E git push',
    'setsid git push',
    'stdbuf --output=L git push',
    'timeout 5s git push',
    'busybox env git push',
    'sudo sudo sudo sudo sudo git push',
    'bash -c "git push"',
    'cmd /c "git push"',
    'cmd /k "git push"',
    'cmd /d /s /K git push',
    'cmd /cgit push',
    'cmd /c "g^it push"',
    'cmd /c "call g^it push"',
    'cmd /c "start \"\" /wait g^it push"',
    'powershell -Command "git push"',
    'powershell -c git push',
    'powershell -co git push',
    'powershell -com git push',
    'powershell -comm git push',
    'powershell -comma git push',
    'powershell -comman git push',
    'pwsh -CommandWithArgs git push',
    'pwsh -cwa git push',
    'bash -c "git push" $(echo ignored)',
  ])('recursively applies administrator forbidden rules to %s', (command) => {
    const adminForbid = {
      ...rule(['git', 'push'], 'forbidden'),
      source: 'admin' as const,
    };

    expect(evaluateShellExecPolicy(command, [adminForbid]).decision).toBe('forbidden');
  });

  it.each([
    '-e',
    '-en',
    '-enc',
    '-enco',
    '-encod',
    '-encode',
    '-encoded',
    '-encodedc',
    '-encodedco',
    '-encodedcom',
    '-encodedcomm',
    '-encodedcomma',
    '-encodedcomman',
    '-EncodedCommand',
  ])(
    'decodes PowerShell %s payloads before administrator policy evaluation',
    (selector) => {
      const adminForbid = {
        ...rule(['git', 'push'], 'forbidden'),
        source: 'admin' as const,
      };
      const encoded = Buffer.from('git push', 'utf16le').toString('base64');

      expect(evaluateShellExecPolicy(
        `powershell ${selector} ${encoded}`,
        [adminForbid],
      ).decision).toBe('forbidden');
    },
  );

  it('applies critical-effect fallback inside an encoded PowerShell command', () => {
    const encoded = Buffer.from('format C:', 'utf16le').toString('base64');

    expect(evaluateShellExecPolicy(`powershell -enc ${encoded}`, [])).toMatchObject({
      decision: 'forbidden',
      criticalFallback: true,
      matched: [expect.objectContaining({
        sourcePath: 'builtin:critical-effects/mkfs_or_format',
      })],
    });
  });

  it.each([
    'cmd /c',
    'cmd /k',
    'powershell -Command',
    'powershell -EncodedCommand !!!',
    'powershell -enc',
  ])('keeps an invalid nested shell shape opaque for normal host review: %s', (command) => {
    expect(evaluateShellExecPolicy(command, [])).toEqual({
      decision: 'unmatched',
      matched: [],
      criticalFallback: false,
    });
  });

  it('keeps malformed or oversized PowerShell encodings opaque', () => {
    const unpairedSurrogate = Buffer.from([0x00, 0xd8]).toString('base64');
    const nonCanonical = 'QQB=';
    const oversized = 'A'.repeat(128 * 1024 + 4);
    const exactAllow = rule(['powershell', '-enc', unpairedSurrogate], 'allow');

    expect(evaluateShellExecPolicy(
      `powershell -enc ${unpairedSurrogate}`,
      [exactAllow],
    ).decision).toBe('allow');
    expect(evaluateShellExecPolicy(`powershell -enc ${nonCanonical}`, []).decision)
      .toBe('unmatched');
    expect(evaluateShellExecPolicy(`powershell -enc ${oversized}`, []).decision)
      .toBe('unmatched');
  });

  it('honors an exact outer rule when a nested command body stays opaque', () => {
    const command = 'powershell -Command g`it push';
    const exactAllow = rule(['powershell', '-Command', 'g`it', 'push'], 'allow');

    expect(evaluateShellExecPolicy(command, [exactAllow])).toMatchObject({
      decision: 'allow',
      criticalFallback: false,
    });
  });

  it('keeps an unlowerable PowerShell command opaque for normal host review', () => {
    const command = [
      'powershell -NoProfile -Command',
      '"Write-Output (\'BG_IDENTITY: \' + (whoami));',
      'Write-Output (\'BG_TOKEN: \' + ((whoami /groups | Select-String \'S-1-15-2-\')) )"',
    ].join(' ');

    expect(evaluateShellExecPolicy(command, [])).toEqual({
      decision: 'unmatched',
      matched: [],
      criticalFallback: false,
    });
  });

  it('does not apply an unrelated administrator forbid to an opaque PowerShell script', () => {
    const adminForbid = {
      ...rule(['git', 'push'], 'forbidden'),
      source: 'admin' as const,
    };
    const encoded = Buffer.from('git push', 'utf16le').toString('base64');

    expect(evaluateShellExecPolicy('pwsh -File script.ps1', [adminForbid]).decision)
      .toBe('unmatched');
    expect(evaluateShellExecPolicy('pwsh script.ps1', [adminForbid]).decision)
      .toBe('unmatched');
    expect(evaluateShellExecPolicy(`pwsh -ec ${encoded}`, [adminForbid]).decision)
      .toBe('unmatched');
    expect(evaluateShellExecPolicy('pwsh -File script.ps1', [{
      ...rule(['pwsh'], 'forbidden'),
      source: 'admin' as const,
    }]).decision).toBe('forbidden');
  });

  it('does not treat ordinary wrapper-looking arguments as nested commands', () => {
    const adminForbid = {
      ...rule(['git', 'push'], 'forbidden'),
      source: 'admin' as const,
    };

    expect(evaluateShellExecPolicy('echo git push', [adminForbid]).decision)
      .toBe('unmatched');
    expect(evaluateShellExecPolicy('echo cmd /k git push', [adminForbid]).decision)
      .toBe('unmatched');
    expect(evaluateShellExecPolicy('cmd /q', [adminForbid]).decision)
      .toBe('unmatched');
    expect(evaluateShellExecPolicy('printf "rm -rf /"', []).decision)
      .toBe('unmatched');
  });

  it('normalizes cmd.exe caret escapes before policy and critical-effect evaluation', () => {
    const result = evaluateShellExecPolicy(
      'fo^rmat C:',
      [],
      { hostExecutable: 'C:\\Windows\\System32\\cmd.exe' },
    );

    expect(result).toMatchObject({
      decision: 'forbidden',
      criticalFallback: true,
      matched: [expect.objectContaining({
        sourcePath: 'builtin:critical-effects/mkfs_or_format',
      })],
    });
    expect(evaluateShellExecPolicy(
      'fo^rmat C:',
      [],
      { hostExecutable: '/bin/bash' },
    ).decision).toBe('unmatched');

    const adminForbid = {
      ...rule(['git', 'push'], 'forbidden'),
      source: 'admin' as const,
    };
    expect(evaluateShellExecPolicy(
      'g^it push',
      [adminForbid],
      { hostExecutable: 'cmd.exe' },
    ).matched[0]?.source).toBe('admin');
    expect(evaluateShellExecPolicy(
      'call fo^rmat C:',
      [],
      { hostExecutable: 'cmd.exe' },
    )).toMatchObject({ decision: 'forbidden', criticalFallback: true });
    expect(evaluateShellExecPolicy(
      'start "" /wait fo^rmat C:',
      [],
      { hostExecutable: 'cmd.exe' },
    )).toMatchObject({ decision: 'forbidden', criticalFallback: true });
  });

  it('reports a wrapped administrator forbid ahead of the critical fallback', () => {
    const adminForbid = {
      ...rule(['rm', '-rf', '/'], 'forbidden'),
      source: 'admin' as const,
    };

    const result = evaluateShellExecPolicy('sudo rm -rf /', [adminForbid]);
    expect(result.decision).toBe('forbidden');
    expect(result.matched[0]?.source).toBe('admin');
    expect(result.criticalFallback).toBe(true);
  });

  it('does not lose the critical fallback through deeply nested shells', () => {
    let command = 'rm -rf /';
    for (let depth = 0; depth < 5; depth += 1) {
      command = `bash -c ${JSON.stringify(command)}`;
    }

    expect(evaluateShellExecPolicy(command, [])).toMatchObject({
      decision: 'forbidden',
      criticalFallback: true,
    });
  });

  it('preserves compound-shell facts for effective nested commands', () => {
    const adminForbid = {
      ...rule(['git', 'push'], 'forbidden'),
      source: 'admin' as const,
      compound: true,
    };

    expect(evaluateShellExecPolicy(
      'echo ready && bash -c "git push"',
      [adminForbid],
    ).decision).toBe('forbidden');
  });

  it('reports equally strict matches in administrator, user, then project order', () => {
    const result = evaluateExecPolicy({ tokens: ['git', 'push'] }, [
      { ...rule(['git'], 'prompt'), source: 'project' },
      { ...rule(['git'], 'prompt'), source: 'user' },
      { ...rule(['git'], 'prompt'), source: 'admin' },
    ]);

    expect(result.matched.map((matched) => matched.source))
      .toEqual(['admin', 'user', 'project']);
  });

  it('loads user and explicitly trusted project files; absent files are empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-exec-policy-'));
    const home = join(root, 'home');
    const project = join(root, 'project');
    await mkdir(join(project, '.kodax'), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'exec-policy.jsonc'), JSON.stringify({
      rules: [{ prefix: ['git', 'status'], decision: 'allow', justification: 'Read status' }],
    }));
    await writeFile(join(project, '.kodax', 'exec-policy.jsonc'), JSON.stringify({
      rules: [{ prefix: ['git', 'push'], decision: 'prompt', justification: 'External effect' }],
    }));

    const untrusted = await loadExecPolicy({ userConfigDir: home, projectRoot: project });
    expect(untrusted.rules).toHaveLength(1);
    const trusted = await loadExecPolicy({
      userConfigDir: home,
      projectRoot: project,
      trustProjectPolicy: true,
    });
    expect(trusted.rules).toHaveLength(2);
    expect(trusted.errors).toEqual([]);

    const absent = await loadExecPolicy({
      userConfigDir: join(root, 'absent-home'),
      projectRoot: join(root, 'absent-project'),
      trustProjectPolicy: true,
    });
    expect(absent).toEqual({ rules: [], errors: [] });
  });

  it('marks host-injected rules as administrator policy', async () => {
    const loaded = await loadExecPolicy({
      userConfigDir: join(tmpdir(), 'kodax-absent-exec-policy-home'),
      adminRules: [rule(['git', 'push'], 'forbidden')],
    });

    expect(loaded.rules[0]?.source).toBe('admin');
    expect(loaded.rules[0]?.sourcePath).toBe('host:admin');
  });

  it('reports malformed host-injected administrator rules', async () => {
    const malformed = {
      prefix: [],
      decision: 'forbidden',
      justification: 'Malformed empty prefix',
      source: 'user',
      sourcePath: 'managed:exec-policy',
    } as unknown as ExecPolicyRule;
    const loaded = await loadExecPolicy({
      userConfigDir: join(tmpdir(), 'kodax-absent-exec-policy-home'),
      adminRules: [malformed],
    });

    expect(loaded.rules).toEqual([]);
    expect(loaded.errors).toEqual([{
      path: 'host:admin',
      message: expect.stringContaining('prefix'),
    }]);
  });

  it('tokenizes quoted Windows/POSIX arguments and detects compound commands', () => {
    expect(tokenizeShellCommand('git commit -m "hello world"')).toEqual({
      tokens: ['git', 'commit', '-m', 'hello world'],
      compound: false,
    });
    expect(tokenizeShellCommand('git status && git push')).toMatchObject({ compound: true });
    expect(tokenizeShellCommand('powershell -Command "Get-Item C:\\Users"').tokens)
      .toEqual(['powershell', '-Command', 'Get-Item C:\\Users']);
  });
});

function rule(
  prefix: readonly (string | readonly string[])[],
  decision: ExecPolicyRule['decision'],
): ExecPolicyRule {
  return {
    prefix,
    decision,
    justification: `${decision} test rule`,
    source: 'user',
    sourcePath: 'memory',
  };
}
