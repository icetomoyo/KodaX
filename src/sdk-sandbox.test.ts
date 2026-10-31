import { describe, expect, it } from 'vitest';

import {
  KODAX_ASRT_VERSION,
  doctorKodaXSandbox,
  getKodaXSandboxCapability,
  getKodaXSandboxSetupGuidance,
  runKodaXSandboxed,
} from './sdk-sandbox.js';

describe('@kodax-ai/kodax/sandbox public surface', () => {
  it('explains a missing JavaScript interpreter without prescribing unrelated Linux packages', () => {
    const diagnostic = 'JavaScript Skill interpreter is unavailable: spawnSync node ENOENT.';
    const guidance = getKodaXSandboxSetupGuidance({
      ready: false, platform: 'linux', version: KODAX_ASRT_VERSION,
      diagnostics: [diagnostic], setupRequired: true,
    }).join('\n');
    expect(guidance).toContain(diagnostic);
    expect(guidance).toContain('KODAX_A2A_NODE');
    expect(guidance).toContain('Electron');
    expect(guidance).toContain('Node.js');
    expect(guidance).toContain('normal permission policy');
    expect(guidance).not.toContain('apt install bubblewrap');
  });

  it.each([
    ['bubblewrap (bwrap) not installed', 'bubblewrap'],
    ['socat not installed', 'socat'],
    ['ripgrep (rg) not found', 'ripgrep'],
  ])('suggests only the backend dependency diagnosed by %s', (diagnostic, dependency) => {
    const guidance = getKodaXSandboxSetupGuidance({
      ready: false, platform: 'linux', version: KODAX_ASRT_VERSION,
      diagnostics: [diagnostic], setupRequired: true,
    }).join('\n');
    expect(guidance).toContain(diagnostic);
    expect(guidance).toContain(`sudo apt install ${dependency}\n`);
    expect(guidance).not.toContain('install Node.js');
  });

  it.each([true, false])('preserves seccomp warnings separately from readiness (%s)', (ready) => {
    const warning = 'seccomp not available - unix socket access not restricted';
    const diagnostics = ready ? [warning] : [warning, 'spawnSync node ENOENT'];
    const guidance = getKodaXSandboxSetupGuidance({
      ready, platform: 'linux', version: KODAX_ASRT_VERSION,
      diagnostics, setupRequired: !ready,
    }).join('\n');
    expect(guidance).toContain(warning);
    expect(guidance).toContain('Warning');
    expect(guidance).toContain('apply-seccomp');
    expect(guidance).not.toContain('apt install');
    if (!ready) expect(guidance).toContain('KODAX_A2A_NODE');
  });

  it('combines interpreter and backend repairs without treating a warning as a missing package', () => {
    const guidance = getKodaXSandboxSetupGuidance({
      ready: false, platform: 'linux', version: KODAX_ASRT_VERSION,
      diagnostics: ['JavaScript Skill interpreter is unavailable: spawnSync node ENOENT.',
        'socat not installed', 'seccomp-helper not available'], setupRequired: true,
    }).join('\n');
    expect(guidance).toContain('KODAX_A2A_NODE');
    expect(guidance).toContain('sudo apt install socat\n');
    expect(guidance).toContain('Warning');
    expect(guidance).not.toContain('install bubblewrap');
  });

  it('preserves unknown launch failures without guessing missing dependencies', () => {
    const diagnostic = 'Sandbox launch probe failed: user namespaces are disabled';
    const guidance = getKodaXSandboxSetupGuidance({
      ready: false, platform: 'linux', version: KODAX_ASRT_VERSION,
      diagnostics: [diagnostic], setupRequired: true,
    }).join('\n');
    expect(guidance).toContain(diagnostic);
    expect(guidance).not.toContain('apt install');
    expect(guidance).toContain('normal permission policy');
  });

  it('does not downgrade a seccomp launch failure into an availability warning', () => {
    const diagnostic = 'Sandbox launch probe failed: seccomp denied target start';
    const guidance = getKodaXSandboxSetupGuidance({
      ready: false, platform: 'linux', version: KODAX_ASRT_VERSION,
      diagnostics: [diagnostic], setupRequired: true,
    }).join('\n');
    expect(guidance).toContain(diagnostic);
    expect(guidance).not.toContain('This warning alone');
  });

  it('exposes generic containment independently from Auto[LLM]', () => {
    const capability = getKodaXSandboxCapability();
    expect(capability).toMatchObject({
      version: 11,
      asrtVersion: KODAX_ASRT_VERSION,
      genericCommandExecution: true,
      ordinaryCallsTriggerSetup: false,
      unavailableBehavior: 'structured-no-execution',
      permissionFallback: 'normal-permission-policy',
      delayedEffectDrainRecovery: 'automatic',
      sameBootAclRecovery: 'sandbox-user-process-probe',
      trustedTextAuthority: 'host-transaction',
      windowsShellAuthority: 'native-token-job-v2',
      commandLifetimeFilesystemLease: false,
    });
    expect(capability.controls).toEqual([
      'filesystem',
      'network',
      'environment',
      'timeout',
      'output',
    ]);
    expect(runKodaXSandboxed).toBeTypeOf('function');
    const doctorWithRefresh: (
      options?: { readonly refresh?: boolean },
    ) => ReturnType<typeof doctorKodaXSandbox> = doctorKodaXSandbox;
    expect(doctorWithRefresh).toBeTypeOf('function');
    expect(getKodaXSandboxSetupGuidance).toBeTypeOf('function');
  });
});
