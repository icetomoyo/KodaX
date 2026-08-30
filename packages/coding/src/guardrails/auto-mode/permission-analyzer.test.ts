import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setAgentConfigHome } from '@kodax-ai/agent';
import type { GuardrailContext, RunnerToolCall } from '@kodax-ai/agent';
import {
  createAutoModeToolGuardrail,
  type AutoModePermissionOperation,
  type AutoModePermissionReview,
  type AutoModePermissionTarget,
  type AutoModeRulesDecision,
  type AutoModeRulesContext,
} from './guardrail.js';
import {
  KodaXBaseProvider,
  type KodaXMessage,
  type KodaXProviderConfig,
  type KodaXProviderStreamOptions,
  type KodaXReasoningRequest,
  type KodaXStreamResult,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  analyzeAutoModeCall,
} from './permission-analyzer.js';
import { isBashReadCommand } from '../../permissions/permission.js';

function createTempDirSync(prefix: string, parentDir?: string): string {
  return fs.mkdtempSync(path.join(parentDir ?? os.tmpdir(), prefix));
}

function removeTempDirSync(dir: string | undefined): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows may keep a test handle open briefly; the OS reclaims temp files.
  }
}

const createdRoots: string[] = [];
const GIT_AVAILABLE = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

class ClassifierProbeProvider extends KodaXBaseProvider {
  readonly name = 'classifier-probe';
  readonly supportsThinking = false;
  readonly calls: KodaXMessage[][] = [];
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'CLASSIFIER_PROBE_API_KEY',
    model: 'classifier-probe',
    supportsThinking: false,
    reasoningCapability: 'none',
  };

  constructor(private readonly output = (
    '<decision>allow</decision><hazard>none</hazard><reason>reviewed</reason>'
  )) {
    super();
  }

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    this.calls.push(messages);
    return {
      textBlocks: [{
        type: 'text',
        text: this.output,
      }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      stopReason: 'end_turn',
    };
  }
}

function createRoot(prefix: string): string {
  const root = createTempDirSync(prefix, process.cwd());
  createdRoots.push(root);
  return root;
}

function call(name: string, input: Readonly<Record<string, unknown>>): RunnerToolCall {
  return { id: `${name}-call`, name, input };
}

function context(
  projectRoot: string,
  executionCwd = projectRoot,
  signals: AutoModeRulesContext['signals'] = [],
): AutoModeRulesContext {
  return { projectRoot, executionCwd, signals };
}

function legacyOperationAllowed(operation: AutoModePermissionOperation): boolean {
  const writable = (target: AutoModePermissionTarget): boolean => (
    target.boundary === 'workspace'
    || target.boundary === 'system-temp'
    || target.boundary === 'agent-home'
  );
  if (operation.options?.whatIf === true) return true;
  if (operation.kind === 'execute') {
    return operation.options?.readOnly === true || operation.options?.contained === true;
  }
  if (operation.kind === 'unknown') return false;
  if (operation.kind === 'read') {
    return operation.target.boundary !== 'protected'
      && operation.target.boundary !== 'unresolved';
  }
  if ('target' in operation) return writable(operation.target);
  if (!('source' in operation)) return false;
  if (operation.kind === 'copy') {
    return writable(operation.destination)
      && operation.source.boundary !== 'protected'
      && operation.source.boundary !== 'unresolved';
  }
  return writable(operation.source) && writable(operation.destination);
}

function legacyDecision(review: AutoModePermissionReview): AutoModeRulesDecision {
  const reviewOnlyRisks = new Set([
    'high_risk_pattern',
    'sensitive_environment_read',
    'sensitive_process_data_read',
    'protected_descendant',
  ]);
  const allowed = review.analysis.status === 'complete'
    && !review.risks.some((risk) => reviewOnlyRisks.has(risk))
    && review.operations.length > 0
    && review.operations.every(legacyOperationAllowed);
  return allowed
    ? { action: 'allow' }
    : { action: 'escalate', reason: review.analysis.reason ?? 'review required' };
}

function assessAutoModeCall(
  toolCall: RunnerToolCall,
  rulesContext: AutoModeRulesContext,
): { readonly decision: AutoModeRulesDecision; readonly review: AutoModePermissionReview } {
  const review = analyzeAutoModeCall(toolCall, rulesContext);
  return { review, decision: legacyDecision(review) };
}

function evaluateAutoRulesCall(
  toolCall: RunnerToolCall,
  rulesContext: AutoModeRulesContext,
): AutoModeRulesDecision {
  return legacyDecision(analyzeAutoModeCall(toolCall, rulesContext));
}

afterEach(() => {
  while (createdRoots.length > 0) removeTempDirSync(createdRoots.pop());
});

describe('Auto[rules] deterministic Tier 2', () => {
  it.each(['write', 'edit', 'multi_edit'] as const)(
    'allows %s when its normalized target stays inside the Runtime workspace',
    (toolName) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const executionCwd = path.join(projectRoot, 'packages', 'app');
      fs.mkdirSync(executionCwd, { recursive: true });

      const decision = evaluateAutoRulesCall(
        call(toolName, { path: path.join('..', '..', 'src', 'inside.ts') }),
        context(projectRoot, executionCwd),
      );

      expect(decision.action).toBe('allow');
    },
  );

  it('allows insert_after_anchor under the same known file-tool policy', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('insert_after_anchor', { path: 'src/inside.ts' }),
      context(projectRoot),
    );
    expect(decision.action).toBe('allow');
  });

  it.each(['write', 'edit', 'multi_edit'] as const)(
    'allows %s in a system temp directory',
    (toolName) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const target = path.join(os.tmpdir(), `kodax-auto-rules-${toolName}-${Date.now()}.txt`);
      const decision = evaluateAutoRulesCall(call(toolName, { path: target }), context(projectRoot));
      expect(decision.action).toBe('allow');
    },
  );

  it.each(['write', 'edit', 'multi_edit'] as const)(
    'escalates %s when .. resolves outside the workspace and temp boundaries',
    (toolName) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const decision = evaluateAutoRulesCall(
        call(toolName, { path: path.join('..', 'outside.txt') }),
        context(projectRoot),
      );
      expect(decision).toMatchObject({ action: 'escalate' });
    },
  );

  it('escalates protected project configuration even though it is in the workspace', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('write', { path: '.kodax/config.json' }),
      context(projectRoot),
    );
    expect(decision).toMatchObject({ action: 'escalate' });
  });

  it('escalates missing or non-string file targets', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('edit', {}), context(projectRoot)).action).toBe('escalate');
    expect(evaluateAutoRulesCall(call('edit', { path: 42 }), context(projectRoot)).action)
      .toBe('escalate');
  });

  it('marks a dynamic file-tool target incomplete instead of claiming exact analysis', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const result = assessAutoModeCall(
      call('write', { path: '$DYNAMIC_ROOT/file.txt' }),
      context(projectRoot),
    );

    expect(result.decision.action).toBe('escalate');
    expect(result.review).toMatchObject({
      analysis: { status: 'incomplete', binding: 'partial' },
      operations: [{ target: { boundary: 'unresolved' } }],
      risks: ['target_unresolved'],
    });
  });

  it('escalates when the Runtime project boundary cannot be resolved to an existing directory', () => {
    const missingRoot = path.join(process.cwd(), `missing-auto-rules-${Date.now()}`);
    const decision = evaluateAutoRulesCall(
      call('write', { path: 'src/inside.ts' }),
      context(missingRoot),
    );
    expect(decision.action).toBe('escalate');
  });

  it.each(['write', 'edit', 'multi_edit'] as const)(
    'escalates %s when an in-workspace junction or symlink resolves outside',
    (toolName) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const outsideRoot = createRoot('kodax-auto-rules-outside-');
      const link = path.join(projectRoot, 'linked-outside');
      fs.symlinkSync(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');

      const decision = evaluateAutoRulesCall(
        call(toolName, { path: path.join(link, 'escaped.ts') }),
        context(projectRoot),
      );
      expect(decision).toMatchObject({ action: 'escalate' });
    },
  );

  it('escalates a broken in-workspace junction or symlink instead of falling back to lexical containment', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const outsideRoot = createRoot('kodax-auto-rules-broken-target-');
    const link = path.join(projectRoot, 'broken-link');
    fs.symlinkSync(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    removeTempDirSync(outsideRoot);

    const decision = evaluateAutoRulesCall(
      call('write', { path: path.join(link, 'escaped.ts') }),
      context(projectRoot),
    );
    expect(decision).toMatchObject({ action: 'escalate' });
  });

  it.each([
    '.env',
    '.env.local',
    '.ssh/id_ed25519',
    '.aws/credentials',
    'credentials/service-account.json',
  ])(
    'escalates protected credential/config target %s inside the workspace',
    (target) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const decision = evaluateAutoRulesCall(call('write', { path: target }), context(projectRoot));
      expect(decision).toMatchObject({ action: 'escalate' });
    },
  );

  it.runIf(process.platform === 'win32')(
    'handles Windows path casing and mixed separators without a false outside-workspace result',
    () => {
      const projectRoot = createRoot('kodax-auto-rules-case-');
      const mixedTarget = path.join(projectRoot.toUpperCase(), 'src', 'inside.ts')
        .replaceAll('\\', '/');
      const decision = evaluateAutoRulesCall(
        call('multi_edit', { path: mixedTarget }),
        context(projectRoot.toLowerCase()),
      );
      expect(decision.action).toBe('allow');
    },
  );

  it('allows read-only bash commands even when they read outside the workspace', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const outsideRoot = createRoot('kodax-auto-rules-outside-');
    const decision = evaluateAutoRulesCall(
      call('bash', { command: `cat "${path.join(outsideRoot, 'notes.txt')}"` }),
      context(projectRoot),
    );
    expect(decision.action).toBe('allow');
  });

  it.each(['read', 'grep', 'glob'] as const)(
    'models a safe %s call as an exact read operation',
    (toolName) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const assessment = assessAutoModeCall(
        call(toolName, { path: path.join(projectRoot, 'src') }),
        context(projectRoot),
      );

      expect(assessment.decision.action).toBe('allow');
      expect(assessment.review).toMatchObject({
        analysis: { status: 'complete', binding: 'exact' },
        operations: [{ kind: 'read', target: { boundary: 'workspace' } }],
        risks: [],
      });
    },
  );

  it.each([
    ['read', '.ssh/id_ed25519'],
    ['grep', '.aws/credentials'],
    ['glob', '.config/gh/hosts.yml'],
    ['read', '.codex/auth.json'],
    ['read', '.claude/.credentials.json'],
    ['read', '.gemini/settings.json'],
    ['read', '.config/openai/auth.json'],
    ['read', '.config/anthropic/credentials.json'],
    ['read', '.envrc'],
    ['read', '.pgpass'],
    ['read', '.direnv/allow/secret'],
    ['read', '.terraform.d/credentials.tfrc.json'],
    ['read', '~/.cargo/credentials.toml'],
    ['read', '~/.m2/settings.xml'],
    ['read', '~/.m2/settings-security.xml'],
    ['read', '~/.gradle/gradle.properties'],
    ['read', '~/.nuget/NuGet/NuGet.Config'],
    ['read', '~/.pip/pip.conf'],
    ['read', '~/.config/pip/pip.conf'],
    ['read', '~/.cache/huggingface/token'],
    ['read', '~/.huggingface/token'],
    ['read', '~/.config/rclone/rclone.conf'],
    ['read', '~/.local/share/keyrings/login.keyring'],
    ['read', '~/Library/Keychains/login.keychain-db'],
    ['read', '~/AppData/Roaming/Microsoft/Credentials/credential'],
    ['read', '~/AppData/Local/Microsoft/Vault/vault.vpol'],
    ['read', '~/.password-store/example.gpg'],
    ['read', '/proc/self/environ'],
  ] as const)('escalates %s access to sensitive path %s', (toolName, target) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call(toolName, { path: target }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review).toMatchObject({
      operations: [{ kind: 'read', target: { boundary: 'protected' } }],
    });
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('escalates a grep filter that expands into a sensitive directory', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('grep', { path: projectRoot, glob: '**/.aws/**', pattern: 'token' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('keeps documented environment templates readable without confirmation', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('read', { path: '.env.example' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it('keeps an ordinary project auth.json readable outside a protected CLI home', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('read', { path: 'fixtures/auth.json' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it('keeps an ordinary project credentials.toml readable outside the Cargo home', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('read', { path: 'fixtures/credentials.toml' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it('resolves a workspace junction to a protected CLI home before allowing a read', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const protectedRoot = path.join(createRoot('kodax-auto-rules-outside-'), '.codex');
    fs.mkdirSync(protectedRoot);
    const link = path.join(projectRoot, 'linked-cli-home');
    fs.symlinkSync(protectedRoot, link, process.platform === 'win32' ? 'junction' : 'dir');

    const assessment = assessAutoModeCall(
      call('read', { path: path.join(link, 'auth.json') }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'protected' }),
    }));
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('does not let an environment-template filename exempt a sensitive directory', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('read', { path: '.ssh/.env.example' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('models git show as deterministic read-only shell execution', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'git show 1bbae03c --stat --format=fuller' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review).toMatchObject({
      analysis: { status: 'complete', binding: 'exact' },
      operations: [{ kind: 'execute', options: { readOnly: true } }],
      risks: [],
    });
  });

  it('requires confirmation before a read-only shell command accesses a secret path', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'cat ~/.ssh/id_ed25519' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'protected' }),
    }));
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.each([
    ['grep', { path: '.', glob: '**/.aws/**', pattern: 'token' }],
    ['grep', { path: '.', glob: '**/.k?be/**', pattern: 'token' }],
    ['grep', { path: '.', glob: '**/.s[s]h/**', pattern: 'token' }],
    ['glob', { path: '.', pattern: '**/.npmrc' }],
    ['glob', { path: '.', pattern: '**/.c?dex/**' }],
    ['glob', { path: '.', pattern: '**/{.aws,.azure}/**' }],
    ['glob', { path: '.', pattern: '!(README).env' }],
    ['glob', { path: '.', pattern: '!(README|notes).env' }],
    ['glob', { path: '.', pattern: '@(credentials.json|README.md)' }],
  ] as const)('escalates %s when a search filter can select protected files', (toolName, input) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call(toolName, input), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks.some((risk) => (
      risk === 'sensitive_read' || risk === 'target_unresolved'
    ))).toBe(true);
  });

  it.each([
    ['grep', { path: 'src/sdk-runtime.ts', glob: '*.ts', pattern: 'token' }],
    ['grep', { path: '.', glob: '*.json', pattern: 'token' }],
    ['grep', { path: '.', glob: '*.ts', pattern: 'token' }],
    ['glob', { path: '.', pattern: '**/*.md' }],
    ['glob', { path: '.', pattern: '!(README).json' }],
  ] as const)('allows an ordinary %s selector without treating the pattern as a target', (toolName, input) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'sdk-runtime.ts'), 'export const token = true;');
    const assessment = assessAutoModeCall(call(toolName, input), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.analysis).toMatchObject({ status: 'complete', binding: 'exact' });
    expect(assessment.review.risks).toEqual([]);
  });

  it('models a structured grep directory as its actual read boundary', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('grep', {
      path: projectRoot,
      pattern: 'token',
    }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'workspace' }),
    }));
    expect(assessment.review.risks).toEqual([]);
  });

  it('models a structured grep default as a workspace read', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('grep', {
      pattern: 'token',
    }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it('models the reported PowerShell environment inspection as an exact read', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const command = [
      "echo '=== where.exe rg now ==='",
      'where.exe rg 2>&1',
      "echo '=== WinGet Links on PATH? ==='",
      "$env:PATH -split ';' | Where-Object { $_ -like '*WinGet*' }",
      "echo '=== rg version ==='",
      'rg --version 2>&1 | Select-Object -First 2',
    ].join('; ');

    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review).toMatchObject({
      analysis: { status: 'complete', binding: 'exact', shell: 'powershell' },
      operations: [{ kind: 'execute', options: { readOnly: true } }],
      risks: [],
    });
  });

  it('keeps arbitrary PowerShell-invoked scripts in LLM review with an execute fact', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const command = `& '${path.join(projectRoot, 'bin', 'dsh.cmd')}' --version 2>&1`;

    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis).toMatchObject({
      status: 'incomplete', shell: 'powershell', binding: 'partial',
    });
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'execute',
    }));
    expect(assessment.review.operations).not.toContainEqual(expect.objectContaining({
      kind: 'unknown',
    }));
  });

  it('does not fast-path a sensitive PowerShell environment read', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: '$env:AWS_SECRET_ACCESS_KEY | Select-Object -First 1' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_environment_read');
  });

  it('does not model a path-qualified whitelist lookalike as a deterministic read', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: "& 'C:\\tmp\\rg.exe' --version" }),
      context(projectRoot),
    );

    expect(assessment.review.analysis).toMatchObject({
      status: 'incomplete', binding: 'partial',
    });
    expect(assessment.review.operations).toEqual([expect.objectContaining({
      kind: 'execute', options: { readOnly: false },
    })]);
  });

  it.each([
    `awk 'BEGIN { system("touch pwned") }' package.json`,
    `sed -n '1e touch pwned' package.json`,
    'fc -s',
    'find . -fprintf report.txt %p',
    'where { Remove-Item ../outside.txt }',
    'Get-ChildItem | where { Set-Content ../outside.txt x }',
    'date -s 2026-08-03',
    'date --set=2026-08-03',
    'date 08-03-2026',
  ])('keeps effectful or ambiguous read syntax in LLM review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command }),
      context(projectRoot),
    );

    expect(assessment.review.analysis.status).toBe('incomplete');
    expect(assessment.review.operations).toEqual([expect.objectContaining({
      kind: 'execute', options: { readOnly: false },
    })]);
  });

  it.each([
    ['less -o ../outside.log README.md', '../outside.log'],
    ['less -O../outside.log README.md', '../outside.log'],
    ['less --log-file=../outside.log README.md', '../outside.log'],
    ['less --LOG-FILE ../outside.log README.md', '../outside.log'],
    ['less -Xo ../outside.log README.md', '../outside.log'],
    ['less -Xo../outside.log README.md', '../outside.log'],
    ['less --log-f=../outside.log README.md', '../outside.log'],
    ['tree -o ../outside.txt .', '../outside.txt'],
    ['tree -o../outside.txt .', '../outside.txt'],
    ['tree --output=../outside.txt .', '../outside.txt'],
    ['tree -dfo ../outside.txt .', '../outside.txt'],
    ['tree -dfo../outside.txt .', '../outside.txt'],
    ['tree --out=../outside.txt .', '../outside.txt'],
  ])('models output flags on otherwise read-oriented commands: %s', (command, target) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('incomplete');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'write', target: expect.objectContaining({ path: target }),
    }));
  });

  it.each([
    'less --tag-file=.env README.md',
    'less --tag-file .env README.md',
    'less -T.env README.md',
    'less -T .env README.md',
    'less -XT.env README.md',
    'less -XT .env README.md',
    'less --tag-f=.env README.md',
  ])('reviews a protected less tag file: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('keeps explicit where.exe lookup deterministic', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(assessAutoModeCall(
      call('bash', { command: 'where.exe rg' }),
      context(projectRoot),
    ).decision.action).toBe('allow');
  });

  it.each([
    'git -C %USERPROFILE%\\.ssh status',
    'git --git-dir=%USERPROFILE%\\.ssh\\repo.git show HEAD',
    'git --git-dir=/home/alice/.ssh/repo.git show HEAD',
    'git --work-tree ~/.ssh diff --stat',
    'git -C C:\\workspace diff .env',
    'git -C C:\\workspace grep token .env',
    'git diff --no-index %USERPROFILE%\\.ssh\\config README.md',
    'git grep --no-index foo %USERPROFILE%\\.ssh\\config',
    'git grep -f .env',
    'git grep --file=%USERPROFILE%\\.ssh\\patterns',
    'git grep -e token .env',
    'git grep -etoken .env',
    'git grep -iefoo .env',
    'git grep -if.env',
    'git grep -if%USERPROFILE%\\.ssh\\patterns',
    'git grep -if %USERPROFILE%\\.ssh\\patterns',
    'git grep token -- .env',
    'git config --file=%USERPROFILE%\\.aws\\credentials --list',
    'git config --file /home/alice/.ssh/config --list',
    'git config -f %USERPROFILE%\\.ssh\\config --get user.name',
    'git config get -f%USERPROFILE%\\.ssh\\config user.name',
    'git config --blob=HEAD:.env --list',
    'git show .env',
    'git show --stat .env',
    'git log -p .env',
    'git -C C:\\workspace log --follow .env',
  ])('requires review when a Git global path option targets protected data: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'protected' }),
    }));
  });

  it.each([
    'cat .env',
    'Get-Content .env',
    'git diff HEAD -- .env',
    'git show HEAD:.env',
    'git show HEAD:.ssh/id_ed25519',
    'cat .env > reports/copy.txt',
    'cat .env | tee reports/copy.txt',
    'Get-Content .env | Set-Content reports/copy.txt',
    'grep secret .env > reports/matches.txt',
    'sed -n p .env > reports/copy.txt',
    "awk '{print}' .env > reports/copy.txt",
    'Select-String -Pattern secret -Path .env | Set-Content reports/matches.txt',
  ])('requires confirmation for a sensitive bare or git-object read: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'protected' }),
    }));
  });

  it.each([
    'type .npmrc.',
    'type ".npmrc "',
    "Get-Content -LiteralPath '.npmrc.'",
    "Get-Content -LiteralPath '.npmrc '",
    'type .npmrc::$DATA',
  ])('normalizes a Windows sensitive path alias before admission: %s', (command) => {
    if (process.platform !== 'win32') return;
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.runIf(process.platform === 'win32').each([
    'copy README.md PRN',
    'copy README.md LPT1.txt',
    'copy README.md build/COM1.log',
    'echo hello > AUX',
    'type CON',
    'type "reports/PRN.txt"',
    'type CONIN$',
  ])('routes a Windows DOS device target through review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('target_unresolved');
  });

  it.runIf(process.platform === 'win32')('keeps the Windows null device deterministic', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'echo hello > NUL' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
  });

  it.each([
    '/proc/thread-self/environ',
    '/proc/self/task/1/environ',
    '/proc/123/task/456/environ',
    '/proc/thread-self/cmdline',
    '/proc/123/task/456/cmdline',
    '/proc/self/mem',
    '/proc/self/auxv',
    '/proc/123/maps',
    '/proc/self/fd/3',
    '/proc/thread-self/fd/1',
    '/proc/123/fdinfo/4',
    '/proc/self/task/1/fd/2',
    '/proc/123/task/456/fdinfo/7',
  ])('protects an equivalent Linux process-data entry: %s', (target) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: `cat ${target}` }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.each([
    'git show --stat HEAD 2>/dev/null',
    'echo hello >/dev/null',
  ])('does not treat the POSIX null device as an outside-workspace write: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.operations).not.toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ path: '/dev/null' }),
    }));
    expect(assessment.review.risks).toEqual([]);
  });

  it('canonicalizes an existing Windows 8.3 sensitive-file alias before admission', () => {
    if (process.platform !== 'win32'
      || !fs.existsSync(path.join(process.cwd(), 'NPMRC~1'))) return;
    const assessment = assessAutoModeCall(
      call('bash', { command: 'type NPMRC~1' }),
      context(process.cwd()),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.each([
    'cat .env*',
    'cat .e?v',
    'cat .en[v]',
    'cat .k?be/config',
    'cat .c?dex/auth.json',
    'Get-Content .env*',
    'Get-Content -Path .env*',
    'Get-Content -Path:.env*',
    'Get-Content -Pa:.env*',
    'Select-String -Pattern token -Path:.env*',
    'gc .env*',
    'sls token .env*',
    'type .env*',
    'rg token .env*',
    'rg token -g "**/.s?h/**" .',
    'git diff -- .env*',
  ])('does not deterministically allow a read glob that can expand to protected data: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('complete');
    expect(assessment.review.risks).toContain('sensitive_read');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'protected' }),
    }));
  });

  it.each([
    'Get-Content -LiteralPath .env*',
    'Get-Content -Lit .env*',
    'Get-Content -LiteralPath:.env*',
    'Get-Content -Lit:.env*',
    'Select-String -Pattern token -LiteralPath .env*',
    'Select-String -Pattern token -Lit .env*',
    'Select-String -Pattern token -LiteralPath:.env*',
    'Select-String -Pattern token -Lit:.env*',
    'gc -PSPath:.env*',
    'sls -Pattern token -PSPath:.env*',
  ])('keeps PowerShell LiteralPath reads literal when a filename contains wildcard characters: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).not.toContain('target_unresolved');
  });

  it('does not let one LiteralPath operand exempt the same wildcard in another stage', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', {
        command: 'Get-Content -LiteralPath .env*; Get-Content -Path .env*',
      }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.each([
    'cat .env.example',
    'git show HEAD:.env.example',
    'git show --no-patch --format .env HEAD',
    'git log --grep .env',
    'git log --author .env',
    'git grep -eTOKEN -- README.md',
    'git grep "%USERPROFILE%\\.ssh" -- README.md',
    'grep ".env" README.md',
    'grep ".env" README.md > reports/matches.txt',
    'Get-Content -Delimiter .env README.md',
    'Get-Content -Del .env README.md',
    'Get-Content README.md -Exclude .env*',
    'Select-String -Pattern token -Path README.md -Exclude:.env*',
    "Select-String -EA Ignore '.env' README.md",
    "Select-String -Context 1,2 '.env' README.md",
    "Select-String -Encoding UTF8 '.env' README.md",
    "Select-String -Culture en-US '.env' README.md",
    "rg --glob '!*.json' token README.md",
    "grep --exclude='*.json' token README.md",
  ])('does not treat a non-path read operand as sensitive: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).not.toContain('sensitive_read');
  });

  it('requires confirmation before a shell command reveals a sensitive environment variable', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'echo $OPENAI_API_KEY' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_environment_read');
  });

  it.each([
    'Get-ChildItem Env:',
    'Get-ChildItem Env:*',
    'Get-ChildItem Env:OPENAI_*',
    'Get-ChildItem Env: -Force',
    'Get-ChildItem -Path Env:*',
    'Get-ChildItem -Path:Env:* -Force',
    'Get-ChildItem Environment::*',
    'Get-ChildItem Microsoft.PowerShell.Core\\Environment::*',
    'gci Env:*',
    'dir Env:OPENAI_*',
    'ls Env: -Force',
    'Get-Item Env:*',
    'gi Environment::OPENAI_*',
    'Get-Content Env:OPENAI_API_KEY',
    'gc Env:DATABASE_URL',
    'cat Env:SENTRY_DSN',
    'Get-Content Env:GITHUB_PAT',
    'Get-Content Env:PGPASSWORD',
    'type Env:OPENAI_*',
    'Get-ChildItem Env:PATH,Env:OPENAI_API_KEY',
    'Get-ChildItem Env:\\*',
    'Get-ChildItem -EA SilentlyContinue Env:*',
    'Get-ChildItem Variable:*',
    'Get-ChildItem Microsoft.PowerShell.Core\\Variable::*',
    'Get-Content Variable:OPENAI_API_KEY',
    'Get-Variable',
    'Get-Variable *',
    'Get-Variable -Name OPENAI_API_KEY -ValueOnly',
    'Get-Variable -Include *TOKEN*',
    'gv SECRET',
    'echo Env:* | Get-ChildItem',
    'echo Environment::* | dir',
    'echo Variable:* | Get-ChildItem',
    'echo Env:* | Get-ChildItem -ErrorAction SilentlyContinue',
    'echo Env:* | Get-ChildItem -EA Ignore',
    'echo Env:* | Get-ChildItem -OutVariable x',
    'echo Env:* | Get-ChildItem -ErrorAction:Ignore',
    'echo Env:* | dir -OV:x',
    'echo $global:OPENAI_API_KEY',
    'echo $script:OPENAI_API_KEY',
    'echo ${script:SECRET}',
    'Get-Content Env:KAGGLE_KEY',
    'Get-ChildItem Variable:KAGGLE_KEY',
    'Get-Content Env:GOOGLE_APPLICATION_CREDENTIALS',
    'Get-ChildItem -LiteralPath Env:*',
    'Get-ChildItem -LiteralPath Variable:*',
    'Get-Content -PSPath:Env:KAGGLE_KEY',
    'Get-Content -PSPath Env:KAGGLE_KEY',
    'Select-String -Pattern token -PSPath:Env:KAGGLE_KEY',
    'gc -PSPath:Env:KAGGLE_KEY',
    'sls -Pattern token -PSPath:Env:KAGGLE_KEY',
    'gi -PSPath:Env:KAGGLE_KEY',
    'gci -PSPath:Env:*',
    'echo ${!SECRET_NAME}',
    'echo ${!prefix*}',
    'echo $KAGGLE_KEY',
    'echo ${KAGGLE_KEY}',
    'echo %KAGGLE_KEY%',
    'echo %OPENAI_API_KEY:~0,9999%',
    'echo %OPENAI_API_KEY:~0,1%',
    'echo %OPENAI_API_KEY:KEY=X%',
    'echo %KAGGLE_KEY:~0,9999%',
    'echo $Variable:KAGGLE_KEY',
    'echo "It\'s $OPENAI_API_KEY"',
  ])('requires classifier review before PowerShell may reveal environment secrets: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_environment_read');
  });

  it.each([
    'Get-ChildItem Env:PATH',
    'Get-Item Env:PATH',
    'Get-Content Env:PATH',
    'Get-ChildItem Variable:HOME',
    'Get-Variable HOME',
    'echo $global:PATH',
    'echo $PATH',
    'echo ${HOME}',
    'echo %TEMP%',
    'echo %PATH:;=,%',
    'echo $Variable:PATH',
    'echo Env:*',
    "echo '$OPENAI_API_KEY'",
    "rg '\\$KAGGLE_KEY' README.md",
    "Get-Content README.md | Select-String '\\$env:OPENAI_API_KEY'",
    "Get-ChildItem -Filter 'Env:*' .",
    "Select-String 'Env:KAGGLE_KEY' README.md",
    'sls Env:KAGGLE_KEY README.md',
    'Select-String Function:prompt README.md',
    'Select-String -SimpleMatch Env:KAGGLE_KEY README.md',
    'Select-String Env:KAGGLE_KEY -Path README.md',
    'Select-String -InputObject Env:KAGGLE_KEY token',
  ])('does not invent a sensitive environment read for a proven-safe operand: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.review.risks).not.toContain('sensitive_environment_read');
  });

  it.each([
    'Get-Content Function:prompt',
    'Get-ChildItem Alias:*',
    'Get-Item Cert:\\CurrentUser\\My',
    'Get-ChildItem HKCU:\\Software',
    'Get-Content Microsoft.PowerShell.Core\\Function::prompt',
    'Get-Content -PSPath:Function:prompt',
    'sls -Pattern token -PSPath:Function:prompt',
  ])('routes non-filesystem PowerShell provider reads for review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_process_data_read');
  });

  it.runIf(process.platform === 'win32').each([
    'Get-Content "\\\\server\\share\\file.txt"',
    'type "\\\\server\\share\\file.txt"',
    'Get-ChildItem "\\\\server\\share"',
    'dir "\\\\?\\UNC\\server\\share"',
    'Get-Item "\\\\.\\PhysicalDrive0"',
    'Get-Content "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\x"',
  ])('routes UNC and Windows device namespace reads to the classifier: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action, JSON.stringify(assessment)).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('incomplete');
    expect(assessment.review.risks).toContain('target_unresolved');
  });

  it.runIf(process.platform === 'win32').each([
    'Get-ChildItem',
    'ls',
    'gci',
  ])('reviews recursive PowerShell listing whose root contains sensitive home directories: %s', (executable) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const command = `${executable} "${os.homedir()}" -Recurse`;
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.runIf(process.platform === 'win32')(
    'keeps a non-recursive ordinary home listing deterministic',
    () => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const assessment = assessAutoModeCall(
        call('bash', { command: `Get-ChildItem "${os.homedir()}"` }),
        context(projectRoot),
      );

      expect(assessment.decision.action).toBe('allow');
      expect(assessment.review.risks).toEqual([]);
    },
  );

  it.each([
    ['tree', (home: string) => `tree "${home}"`],
    ['find', (home: string) => `find "${home}" -type f`],
    ['ls', (home: string) => `ls -R "${home}"`],
    ...(process.platform === 'win32'
      ? [['dir', (home: string) => `dir /s "${home}"`] as const]
      : []),
  ])('reviews %s recursion rooted above sensitive home directories', (_name, commandFor) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: commandFor(os.homedir()) }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('reviews recursive PowerShell enumeration that follows symbolic links', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'Get-ChildItem . -Recurse -FollowSymlink' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('target_unresolved');
  });

  it.each([
    'Get-Item Microsoft.PowerShell.Core\\Environment::OPENAI_API_KEY',
    'Get-Item Microsoft.PowerShell.Core\\Variable::OPENAI_API_KEY',
  ])('routes fully-qualified sensitive variable providers for review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_environment_read');
  });

  it.each([
    'Get-Content @params',
    'gc @global:params',
    'Select-String @script:params',
    'sls @params',
    'Get-Item @local:params',
    'gi @params',
    'Get-ChildItem @private:params',
    'gci @params',
    'Get-Variable @params',
    'gv @params',
  ])('routes dynamic PowerShell parameter binding to the classifier: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('incomplete');
    expect(assessment.review.risks).toContain('target_unresolved');
  });

  it.each([
    'Select-String token Env:KAGGLE_KEY',
    'Select-String -Pattern token Env:KAGGLE_KEY',
    'Select-String token -Path Env:KAGGLE_KEY',
  ])('reviews a sensitive provider selector when Select-String binds it as Path: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_environment_read');
  });

  it('reviews a non-filesystem provider when Select-String binds it as Path', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'Select-String -Pattern:token -Path:Function:prompt' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_process_data_read');
  });

  it.each([
    'git config --list',
    'git config list',
    'git config --get-all http.https://github.com/.extraheader',
    'git config --get-regexp credential',
    'git config --get-regexp ".*token.*"',
    'git config --get-regexp .*',
    'git config --get-regexp .',
    'git config --get-regexp "^http\\."',
    'git config --get-regexp "^user\\.|.*"',
    'git config --get-regexp "^user\\.|header$"',
    'git config --get-regexp "^user\\.|pass"',
    'git config --get-regexp "user\\."',
    'git config --get-regexp "^(?:user\\.|http\\.)"',
    'git config get --regexp "^user\\.|.*"',
    'git config get --regexp "^user\\.|.*" --default "^user\\."',
    'git config --get-regexp "^user\\."',
    'git config --get-regexp "^user\\..*$"',
    'git config get --regexp "^user\\."',
    'git config get --regexp "^user\\." --default fallback',
    'git config get --reg ".*"',
    'git config get --rege ".*"',
    'git config get --r ".*"',
    'git config get --re ".*"',
    'git config get --url=https://github.com http',
    'git config get --u=https://github.com http',
    'git config get --u https://github.com http',
    'git config get --name-only --no-name-only --regexp ".*"',
    'git config --get-urlmatch http https://example.com',
    'git config --get-urlmatch http.proxy https://example.com',
    'git config get http.https://github.com/.extraheader',
    'git config --get remote.origin.url',
    'git config get remote.origin.url',
    'git config --get remote.origin.pushurl',
    'git config --get submodule.sdk.url',
    'git remote -v',
    'git remote --verbose',
    'git remote get-url origin',
    'git remote get-url --all origin',
    'git remote show -n origin',
  ])('requires review when Git config may reveal credentials: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_environment_read');
  });

  it('keeps network-capable git remote show out of the deterministic read path', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'git remote show origin' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('incomplete');
  });

  it.each([
    'git config get user.email',
    'git config --get-regexp "^user\\.email$"',
    'git config get --regexp "^user\\.email$"',
    'git config get --regexp "^user\\.(name|email)$"',
    'git config get --regexp "^user\\.email$" --default fallback',
    'git config get --name-only --regexp ".*"',
    'git config --name-only --get-regexp ".*"',
    'git config get --url=https://github.com http.version',
    'git config --get-urlmatch http.version https://example.com',
    'git remote',
  ])('allows a Git config read proven to target non-sensitive user metadata: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).not.toContain('sensitive_environment_read');
  });

  it.each([
    "rg --hidden --glob '.npmrc' registry .",
    "grep -R --include='.npmrc' registry .",
  ])('routes a shell search filter that can select protected files through review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks.some((risk) => (
      risk === 'sensitive_read' || risk === 'target_unresolved'
    ))).toBe(true);
  });

  it.each([
    "rg --glob '*.ts' token .",
    "grep -R --include='*.md' token .",
    "rg --glob '*.json' token .",
  ])('keeps an ordinary shell search selector deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));
    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it.each([
    'rg --hidden registry .',
    'rg registry',
    'rg --type ts registry',
    'grep -R registry .',
    'grep --directories=recurse registry .',
    'grep --directories recurse registry .',
    'grep -d recurse registry .',
    'grep -drecurse registry .',
    'findstr /S registry *',
    'git grep registry',
  ])('models an ordinary recursive or default-scope content search as read-only: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it.each([
    'grep -d skip registry README.md',
    'grep --directories=read registry README.md',
  ])('keeps a non-recursive grep directory policy deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(assessAutoModeCall(call('bash', { command }), context(projectRoot)).decision.action)
      .toBe('allow');
  });

  it.each([
    'git show HEAD',
    'git show --patch --stat HEAD',
    'git diff',
    'git log -p --all',
    'git log -u --all',
    'git log -pSregistry --all',
    'git log --stat -pSregistry --all',
    'git log -pGregistry --all',
    'git show --stat -sp HEAD',
    'git show --name-only -sp HEAD',
    'git log --patch-with-raw -1',
    'git log --stat --patch-with-raw -1',
    'git log --remerge-diff -1',
    'git log --diff-merges=on -1',
    'git log --diff-merges=first-parent -1',
    'git log --diff-merges separate -1',
    'git log --diff-m=combined -1',
    'git stash show -p',
    'git stash show --patch',
    'git stash show --include-untracked',
    'git stash show --only-untracked',
    'git stash show',
    'git stash show stash@{0}',
  ])('keeps ordinary Git content output deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it.each([
    'git show --stat HEAD',
    'git diff --name-only',
    'git log --oneline --all',
    'git log --remerge-diff --stat -1',
    'git log --diff-merges=on --stat -1',
    'git log --diff-merges=off -1',
    'git log --diff-merges=none -1',
    'git log -ps --all',
    'git stash show --stat',
    'git stash show --name-only',
    'git stash show --name-status',
    'git stash show --no-patch',
    'rg token README.md',
  ])('keeps scoped or metadata-only inspection deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(assessAutoModeCall(call('bash', { command }), context(projectRoot)).decision.action)
      .toBe('allow');
  });

  it.each([
    'git status --short',
    'git show HEAD -- README.md',
    'git diff -- README.md',
    'git log -p -- README.md',
    'git stash show -p -- README.md',
  ])('keeps ordinary Git metadata and content reads deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.analysis.status).toBe('complete');
    expect(assessment.review.risks).toEqual([]);
  });

  it.each([
    'git show --no-textconv --no-ext-diff HEAD -- README.md',
    'git diff --no-textconv --no-ext-diff -- README.md',
    'git log --no-textconv --no-ext-diff -p -- README.md',
    'git stash show --no-textconv --no-ext-diff -p -- README.md',
  ])('keeps explicitly helper-disabled Git content reads deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(assessAutoModeCall(call('bash', { command }), context(projectRoot)).decision.action)
      .toBe('allow');
  });

  it.runIf(GIT_AVAILABLE)('does not execute a configured textconv while analyzing an ordinary Git read', () => {
    const projectRoot = createRoot('kodax-auto-rules-git-helper-');
    const runGit = (args: readonly string[]) => {
      const result = spawnSync('git', [...args], {
        cwd: projectRoot,
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(result.status, result.stderr).toBe(0);
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.invalid']);
    runGit(['config', 'user.name', 'KodaX Test']);
    fs.writeFileSync(path.join(projectRoot, '.gitattributes'), 'sample.txt diff=kodax-test\n');
    fs.writeFileSync(path.join(projectRoot, 'sample.txt'), 'sample\n');
    runGit(['add', '.gitattributes', 'sample.txt']);
    runGit(['commit', '-qm', 'fixture']);

    const helperPath = path.join(projectRoot, 'textconv-helper.cjs');
    const markerPath = path.join(projectRoot, 'textconv-invoked.marker');
    fs.writeFileSync(helperPath, [
      "const fs = require('node:fs');",
      'fs.writeFileSync(process.argv[2], String(process.argv[3] ?? "invoked"));',
      'process.stdout.write("converted\\n");',
    ].join('\n'));
    const quoteArg = (value: string) => `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
    runGit([
      'config',
      'diff.kodax-test.textconv',
      `${quoteArg(process.execPath)} ${quoteArg(helperPath)} ${quoteArg(markerPath)}`,
    ]);

    runGit(['show', '--format=', 'HEAD', '--', 'sample.txt']);
    expect(fs.existsSync(markerPath)).toBe(true);
    fs.rmSync(markerPath);

    const assessment = assessAutoModeCall(
      call('bash', { command: 'git show HEAD -- sample.txt' }),
      context(projectRoot),
    );
    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
    expect(fs.existsSync(markerPath)).toBe(false);

    runGit(['show', '--no-textconv', '--no-ext-diff', '--format=', 'HEAD', '--', 'sample.txt']);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it.each([
    'git grep token HEAD',
    'git grep token HEAD~1',
    'git grep token 0123456789abcdef0123456789abcdef01234567',
    'git grep --cached token',
    'git grep token HEAD HEAD~1',
  ])('keeps a Git tree-ish content search deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it.each([
    'git grep token -- README.md',
    'git grep token HEAD -- README.md',
    'git show HEAD:README.md',
    'git show :README.md',
    'git show :0:README.md',
    'git show :1:README.md',
    'git show :./README.md',
    'git show HEAD -- README.md',
    "git show HEAD -- ':(top)README.md'",
    "git diff -- ':(literal)README.md'",
    "git grep token -- ':(icase)README.md'",
    "git show HEAD -- ':/README.md'",
    'git diff -- README.md',
    'git log -p -- README.md',
    'git stash show -p -- README.md',
  ])('models an exact Git content-read target: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'workspace' }),
    }));
  });

  it.each([
    "git log '-L1,1:.npmrc' --format=",
    "git log -L '1,1:.npmrc' --format=",
  ])('routes a protected Git line-log target through review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.each([
    "git log -L '1,1:$TARGET' --format=",
  ])('routes a dynamic Git line-log target through review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('target_unresolved');
  });

  it('does not treat a literal Git line-log wildcard as a dynamic binding', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', {
      command: "git log '-L1,1:*.md' --format=",
    }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it('keeps an exact non-sensitive Git line-log target deterministic', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', {
      command: "git log '-L1,1:README.md' --format=",
    }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it.each([
    'Get-Content -LiteralPath package.json,.npmrc -TotalCount 1',
    'Get-Content -Path package.json,.npmrc -TotalCount 1',
    'Select-String token -Path package.json,.npmrc',
  ])('routes PowerShell path arrays containing protected files through review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('routes a sensitive Get-ChildItem pipeline and a findstr file list through review', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const pipeline = assessAutoModeCall(call('bash', {
      command: 'Get-ChildItem -Recurse -Filter .npmrc | Get-Content -TotalCount 1',
    }), context(projectRoot));
    const fileList = assessAutoModeCall(call('bash', {
      command: 'findstr /F:files.txt token',
    }), context(projectRoot));
    const broadPipeline = assessAutoModeCall(call('bash', {
      command: 'Get-ChildItem -Recurse -File | Select-String token',
    }), context(projectRoot));

    expect(pipeline.decision.action).toBe('escalate');
    expect(pipeline.review.risks).toContain('sensitive_read');
    expect(fileList.decision.action).toBe('escalate');
    expect(fileList.review.analysis.status).toBe('incomplete');
    expect(broadPipeline.decision.action).toBe('escalate');
    expect(broadPipeline.review.risks).toContain('sensitive_read');
  });

  it('allows a Get-ChildItem -Name pipeline feeding Select-String (names are matched as text, no file read)', () => {
    // 2026-08-07 production false positive: the sentinel `.env` target was
    // injected even though `-Name` makes the enumeration emit strings that
    // Select-String binds to -InputObject (content search), not -Path.
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', {
      command: 'Get-ChildItem docs -Name | Select-String -Pattern "memory|AGENTS|PRD"',
    }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.operations).not.toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ path: '.env' }),
    }));
  });

  it.each([
    // FileInfo objects flow downstream: Select-String reads each enumerated file.
    'Get-ChildItem docs | Select-String -Pattern token',
    // Get-Content binds pipeline strings to -Path, so names still cause reads.
    'Get-ChildItem docs -Name | Get-Content',
  ])('keeps the protected-enumeration sentinel when the pipeline reads file contents: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.each([
    // -Name emits strings; no content reader consumes them as files here.
    'Get-ChildItem docs -Name',
    // Standalone Select-String with no -Path performs no file read.
    'Select-String -Pattern "v0.7.4"',
  ])('allows baseline enumeration/search commands that read no file contents: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
  });

  it.each([
    // Explicitly disabling the switch keeps FileInfo objects flowing:
    // Select-String reads file contents, so the sentinel must stay.
    'Get-ChildItem docs -Name:$false | Select-String -Pattern token',
    // A Get-Content consumer anywhere in the pipeline re-enables file reads.
    'Get-ChildItem docs -Name | Select-String token | Get-Content',
  ])('keeps the protected-enumeration sentinel when -Name output is not string-only: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('allows the -Name abbreviation -N feeding Select-String (prefix resolution)', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', {
      command: 'Get-ChildItem docs -N | Select-String -Pattern token',
    }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
  });

  it.each([
    'cat .git/config',
    'Get-Content .git/config',
    'head .git/config',
    'grep token .git/config',
    'cat .git/config.worktree',
    'cat .git/worktrees/topic/config.worktree',
    'cat .gitmodules',
    'cat ~/.gitconfig',
    'cat ~/.config/git/config',
    'cat ~/.codex/auth.json',
    'Get-Content ~/.claude/.credentials.json',
    'cat ~/.gemini/settings.json',
    'Get-Content ~/.config/openai/auth.json',
    'cat ~/.config/anthropic/credentials.json',
    'cat .envrc',
    'cat .pgpass',
    'cat .direnv/allow/secret',
    'cat .terraform.d/credentials.tfrc.json',
    'cat ~/.cargo/credentials.toml',
    'cat ~/.gitconfig',
    'cat ~/.config/git/config',
    'cat ~/.terraformrc',
    'cat ~/.config/pypoetry/auth.toml',
    'cat ~/.condarc',
    'cat ~/.bashrc',
    'cat ~/.bash_profile',
    'cat ~/.zshrc',
    'cat ~/.zprofile',
    'cat ~/.profile',
    'cat ~/.config/fish/config.fish',
    'cat ~/.config/fish/fish_variables',
    'cat ~/.bash_history',
    'cat ~/.zsh_history',
  ])('routes credential-bearing Git configuration files through review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.each([
    'dd if=.env of=tmp-copy.bin',
    'dd if=.git/config of=tmp-copy.bin',
    'tee tmp-copy < .env',
    'tee tmp-copy < .git/config',
  ])('models a protected shell input separately from its output: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'protected' }),
    }));
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'write', target: expect.objectContaining({ boundary: 'workspace' }),
    }));
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.each([
    'dd if=README.md of=tmp-copy.bin',
    'tee tmp-copy < README.md',
  ])('keeps a proven ordinary shell input and output deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'workspace' }),
    }));
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'write', target: expect.objectContaining({ boundary: 'workspace' }),
    }));
    expect(assessment.review.risks).toEqual([]);
  });

  it.each([
    ['touch --reference=.env target.txt', '.env'],
    ['touch --reference .git/config target.txt', '.git/config'],
    ['touch -r.env target.txt', '.env'],
    ['touch -r .env target.txt', '.env'],
  ])('models a protected touch reference as a read source: %s', (command, reference) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'protected' }),
    }));
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'create', target: expect.objectContaining({ path: 'target.txt' }),
    }));
    expect(assessment.review.operations.filter((operation) => (
      'target' in operation && operation.target.path === reference
    ))).toHaveLength(1);
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.each([
    'touch --reference=README.md target.txt',
    'touch -r README.md target.txt',
    'touch -rREADME.md target.txt',
  ])('keeps an ordinary touch reference deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'read', target: expect.objectContaining({ path: 'README.md' }),
      }),
      expect.objectContaining({
        kind: 'create', target: expect.objectContaining({ path: 'target.txt' }),
      }),
    ]));
    expect(assessment.review.operations).toHaveLength(2);
  });

  it.each([
    ['date --reference=.env', '.env'],
    ['date -r .git/config', '.git/config'],
    ['chmod --reference=.env target.txt', '.env'],
    ['chmod --reference .git/config target.txt', '.git/config'],
    ['chown --reference=.env target.txt', '.env'],
  ])('models another command reference operand as a protected read: %s', (command, reference) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({
        path: reference, boundary: 'protected',
      }),
    }));
    expect(assessment.review.risks).toContain('sensitive_read');
    if (command.startsWith('chmod') || command.startsWith('chown')) {
      expect(assessment.review.operations).toContainEqual(expect.objectContaining({
        kind: 'write', target: expect.objectContaining({ path: 'target.txt' }),
      }));
    }
  });

  it.each([
    'date --reference=README.md',
    'date -r README.md',
    'chmod --reference=README.md target.txt',
    'chown --reference README.md target.txt',
  ])('keeps an ordinary reference operand deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ path: 'README.md' }),
    }));
    expect(assessment.review.risks).toEqual([]);
  });

  it('validates every physical shell statement before taking the read fast path', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const rulesContext = context(projectRoot);

    expect(assessAutoModeCall(
      call('bash', { command: 'echo safe\npwd' }),
      rulesContext,
    ).decision.action).toBe('allow');

    const assessment = assessAutoModeCall(
      call('bash', { command: 'echo safe\nnode --version' }),
      rulesContext,
    );
    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('incomplete');
  });

  it.each([
    'git tag -v v1.0.0',
    'git tag --verify v1.0.0',
    'git show --show-signature HEAD -- README.md',
    'git log --show-signature -1 -- README.md',
    'git log --show-sign -1 -- README.md',
    'git log --format=%G? -1 -- README.md',
    'git show --format %GS --stat HEAD',
    'git log --pretty=format:%GK -1 -- README.md',
    'git log --form=%GT -1 -- README.md',
    'git log --format="%+G?" -1 -- README.md',
    'git show --format="%-GS" --stat HEAD',
    'git log --pretty="format:% G?" -1 -- README.md',
    'git log --format="%%%G?" -1 -- README.md',
    'git log --pretty=customSecurityFormat -1 -- README.md',
    'git show --pretty=customSecurityFormat --stat HEAD',
    'git branch --format="%(signature:grade)" --list',
    'git tag --format "%(signature:signername)" --list',
    'git branch --for="%(signature:key)" --list',
    'git tag --format="%(*signature:grade)" --list',
    'git branch --format="%%%(signature:grade)" --list',
    'git stash list --format=%G?',
    'git stash list --pretty=customSecurityFormat',
    'git stash list --show-signature',
  ])('keeps Git signature and metadata inspection deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
    expect(assessment.review.analysis.status).toBe('complete');
  });

  it.each([
    'git log --format=%H -1 -- README.md',
    'git log --pretty=format:%s -1 -- README.md',
    'git log --format="%%G?" -1 -- README.md',
    'git log --pretty=medium -1 -- README.md',
    'git show --pretty=reference --stat HEAD',
    'git branch --format="%(refname:short)" --list',
    'git tag --format="%(contents:signature)" --list',
    'git branch --format="%%(signature:grade)" --list',
    'git stash list --format=%H',
  ])('keeps Git formats that do not verify signatures deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it.each([
    'cat <<EOF',
    'cat <<<secret',
    'tee target.txt < $INPUT_FILE',
  ])('routes inline or dynamically bound shell input through review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('incomplete');
  });

  it('keeps ordinary repository metadata readable', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(assessAutoModeCall(
      call('bash', { command: 'cat .git/HEAD' }),
      context(projectRoot),
    ).decision.action).toBe('allow');
  });

  it.each([
    'find -files0-from .env -print',
    'find --files0-from=.env -print',
    'tree --fromfile .env',
    'tree --fromfile=.env',
    'tree --fromtabfile .git/config',
    'tree --fromtabfile=.git/config',
    'tree --fromfile -L 2 .env',
    'tree --fromfile --charset utf-8 .env',
    'tree --fromfile README.md .env',
  ])('routes a protected command file-list input through review: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
    expect(assessment.review.analysis.status).toBe(
      command.startsWith('find ') ? 'incomplete' : 'complete',
    );
  });

  it.each([
    'tree --fromfile README.md',
    'tree --fromfile=README.md',
    'tree --fromtabfile README.md',
    'tree --fromtabfile=README.md',
    'tree --fromfile -L 2 README.md',
    'tree --fromfile --charset utf-8 README.md',
  ])('models an ordinary tree file-list input as a deterministic read: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ path: 'README.md' }),
    }));
    expect(assessment.review.risks).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'routes cmd caret and delayed-expansion targets through review',
    () => {
      const cmd = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
      const echo = spawnSync(cmd, ['/d', '/s', '/c', 'echo .e^nv'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(echo.stdout.trim()).toBe('.env');

      const projectRoot = createRoot('kodax-auto-rules-project-');
      for (const command of [
        'type .e^nv',
        'type ^.env',
        'cat .e^nv',
        'findstr token .e^nv',
        'git show HEAD:^.env',
        'git show HEAD:.e^nv',
        'type .e!EMPTY!nv',
      ]) {
        const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));
        expect(assessment.decision.action, command).toBe('escalate');
        expect(assessment.review.risks, command).toContain('target_unresolved');
      }
    },
  );

  it.runIf(process.platform === 'win32').each([
    ['Get-ChildItem', ''],
    ['dir', ''],
    ['ls', ''],
    ['Get-Item', 'package.json'],
    ['Get-Content', 'README.md'],
  ])('treats an unquoted absolute PowerShell path like its quoted form: %s', (executable, relative) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# read');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}');
    const target = (relative ? path.join(projectRoot, relative) : projectRoot)
      .replace(/\//g, '\\');
    const unquoted = assessAutoModeCall(
      call('bash', { command: `${executable} ${target}` }),
      context(projectRoot),
    );
    const quoted = assessAutoModeCall(
      call('bash', { command: `${executable} "${target}"` }),
      context(projectRoot),
    );

    expect(unquoted.decision.action).toBe('allow');
    expect(unquoted.review.risks).toEqual([]);
    expect(unquoted.review).toEqual(quoted.review);
  });

  it.runIf(process.platform === 'win32')(
    'preserves an unquoted ordinary outside-workspace PowerShell read target',
    () => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const outsideRoot = createRoot('kodax-auto-rules-outside-');
      const target = path.join(outsideRoot, 'ordinary.txt');
      fs.writeFileSync(target, 'ordinary');
      const windowsTarget = target.replace(/\//g, '\\');

      const assessment = assessAutoModeCall(
        call('bash', { command: `Get-Content ${windowsTarget}` }),
        context(projectRoot),
      );

      expect(assessment.decision.action).toBe('allow');
      expect(assessment.review.risks).toEqual([]);
      expect(assessment.review.operations).toEqual([{
        kind: 'read', target: { path: windowsTarget, boundary: 'outside-workspace' },
      }]);
    },
  );

  it('routes dynamic Git attr pathspec magic through review', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', {
      command: "git grep --untracked token -- ':(attr:secret)'",
    }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('target_unresolved');
  });

  it.each([
    'git grep --no-index registry',
    'git grep --untracked registry',
    'git grep --no-i registry',
    'git grep --unt registry',
  ])('keeps Git grep expanded read scopes deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it('does not treat an excluding Git pathspec as a protected read target', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', {
      command: "git grep token -- ':(exclude).env' README.md",
    }), context(projectRoot));

    expect(assessment.review.risks).not.toContain('sensitive_read');
  });

  it('does not mistake a Git pickaxe pattern for a sensitive path', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'git diff -G .env -- README.md' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).not.toContain('sensitive_read');
    expect(assessment.review.risks).toEqual([]);
  });

  it.each([
    'git grep --ope=cat token',
    'git grep --open-files=cat token',
    'git grep --ext-grep token',
  ])('keeps executable Git grep options out of the read-only fast path: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(assessAutoModeCall(call('bash', { command }), context(projectRoot)).decision.action)
      .toBe('escalate');
  });

  it.each([
    'git tag -a v1.0 -m release',
    'git branch new-branch',
    'git remote set-url origin https://example.test/repo.git',
    'git config set get value',
    'git config unset get',
    'find . -delete',
  ])('does not mistake write-capable syntax for a read-only command: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('bash', { command }), context(projectRoot)).action)
      .toBe('escalate');
  });

  it('allows deterministic bash writes whose targets stay in the workspace', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('bash', { command: 'echo ok > build/result.txt' }),
      context(projectRoot),
    );
    expect(decision.action).toBe('allow');
  });

  it('allows modeled workspace cleanup with a medium-risk signal and an in-boundary target', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('bash', { command: 'rm -rf build' }),
      context(projectRoot, projectRoot, [
        { kind: 'dangerous_pattern', pattern: 'rm -rf', severity: 'medium' },
      ]),
    );
    expect(decision.action).toBe('allow');
  });

  it('allows a Git status redirect inside the workspace', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('bash', { command: 'git status > reports/status.txt' }),
      context(projectRoot),
    );
    expect(decision.action).toBe('allow');
  });

  it.each([
    'echo one > reports/one.txt && echo two > reports/two.txt',
    'cat package.json | tee reports/package.txt',
  ])('allows fully modeled compound/pipeline writes when every target is in-boundary: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('bash', { command }), context(projectRoot)).action)
      .toBe('allow');
  });

  it('escalates deterministic bash writes outside the workspace and temp boundaries', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const outsideRoot = createRoot('kodax-auto-rules-outside-');
    const decision = evaluateAutoRulesCall(
      call('bash', { command: `echo no > "${path.join(outsideRoot, 'result.txt')}"` }),
      context(projectRoot),
    );
    expect(decision).toMatchObject({ action: 'escalate' });
  });

  it('keeps provider modeling local to Auto[LLM] and preserves output boundaries', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const outsideRoot = createRoot('kodax-auto-rules-outside-');
    const outsidePath = path.join(outsideRoot, 'variables.txt');

    expect(isBashReadCommand('Get-Variable PATH')).toBe(false);
    expect(evaluateAutoRulesCall(
      call('bash', { command: 'Get-Variable PATH > reports/variables.txt' }),
      context(projectRoot),
    ).action).toBe('allow');
    expect(evaluateAutoRulesCall(
      call('bash', { command: `Get-Variable PATH > "${outsidePath}"` }),
      context(projectRoot),
    ).action).toBe('escalate');
    expect(assessAutoModeCall(
      call('bash', { command: 'Get-Variable PATH | node scripts/custom-operation.js' }),
      context(projectRoot),
    ).review.analysis.status).toBe('incomplete');
  });

  it.each([
    ['Copy-Item "src/inside.txt" "../outside.txt"', 'copy'],
    ['Move-Item -Force "src/inside.txt" "../outside.txt"', 'move'],
    ['Set-Content -Value data "../outside.txt"', 'write'],
    ['Out-File -InputObject data -FilePath "../outside.txt"', 'write'],
    ['New-Item -ItemType File "../outside.txt"', 'create'],
    ['Remove-Item "../outside.txt"', 'delete'],
  ] as const)(
    'does not auto-allow PowerShell target binding outside the workspace: %s',
    (command, expectedKind) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review.analysis).toMatchObject({
        status: 'complete',
        shell: 'powershell',
        binding: 'exact',
      });
      expect(assessment.review.operations).toHaveLength(1);
      expect(assessment.review.operations[0]).toMatchObject({ kind: expectedKind });
      expect(JSON.stringify(assessment.review.operations[0])).toContain('outside-workspace');
    },
  );

  it.each([
    'Copy-Item "src/inside.txt" "build/copied.txt"',
    'Move-Item -Force "src/inside.txt" "build/moved.txt"',
    'Set-Content -Value data "build/set.txt"',
    'Out-File -InputObject data -FilePath "build/out.txt"',
    'New-Item -ItemType File "build/new.txt"',
    'Remove-Item "build/old.txt"',
  ])('preserves rules-mode auto-allow for a fully bound in-workspace command: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('bash', { command }), context(projectRoot)).action)
      .toBe('allow');
  });

  it('escalates PowerShell bracket wildcards without blocking LiteralPath brackets', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const wildcard = assessAutoModeCall(
      call('bash', { command: 'Set-Content -Path "[.]kodax/config.json" -Value data' }),
      context(projectRoot),
    );
    const literal = assessAutoModeCall(
      call('bash', { command: 'Set-Content -LiteralPath "build/file[12].txt" -Value data' }),
      context(projectRoot),
    );

    expect(wildcard.decision.action).toBe('escalate');
    expect(wildcard.review.analysis).toMatchObject({
      status: 'incomplete',
      shell: 'powershell',
      binding: 'partial',
    });
    expect(literal.decision.action).toBe('allow');
    expect(literal.review.analysis).toMatchObject({
      status: 'complete',
      shell: 'powershell',
      binding: 'exact',
    });
  });

  it('allows a fully modeled outside-workspace PowerShell WhatIf with no mutation risk', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'Set-Content -WhatIf -Value data "../outside.txt"' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.operations).toEqual([
      expect.objectContaining({ options: expect.objectContaining({ whatIf: true }) }),
    ]);
    expect(assessment.review.risks).not.toContain('outside_workspace_mutation');
  });

  it('models Move-Item as one atomic source-to-destination operation', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'Move-Item -Force "src/a.txt" "../outside/b.txt"' }),
      context(projectRoot),
    );

    expect(assessment.review.operations).toEqual([
      expect.objectContaining({
        kind: 'move',
        source: expect.objectContaining({ path: 'src/a.txt', boundary: 'workspace' }),
        destination: expect.objectContaining({
          path: '../outside/b.txt',
          boundary: 'outside-workspace',
        }),
        options: expect.objectContaining({ force: true }),
      }),
    ]);
  });

  it('keeps POSIX mv atomic and represents rm as deletion', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const move = assessAutoModeCall(
      call('bash', { command: 'mv -f src/a.txt build/a.txt' }),
      context(projectRoot),
    );
    const remove = assessAutoModeCall(
      call('bash', { command: 'rm -rf build/old' }),
      context(projectRoot),
    );

    expect(move.review.operations).toEqual([
      expect.objectContaining({
        kind: 'move',
        source: expect.objectContaining({ path: 'src/a.txt' }),
        destination: expect.objectContaining({ path: 'build/a.txt' }),
      }),
    ]);
    expect(remove.review.operations).toEqual([
      expect.objectContaining({
        kind: 'delete',
        target: expect.objectContaining({ path: 'build/old' }),
      }),
    ]);
  });

  it('models git global options and a read-only pipeline without requiring confirmation', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', {
        command: `git -C ${projectRoot} show --stat 5f482f6e | head -60`,
      }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review).toMatchObject({
      analysis: { status: 'complete', binding: 'exact' },
      risks: [],
    });
    expect(assessment.review.operations.every((operation) => operation.kind === 'read'))
      .toBe(true);
  });

  it('models a global Git config mutation as a host-home write', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'git config --global user.name KodaX' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review).toMatchObject({
      analysis: { status: 'complete', binding: 'exact' },
      operations: [{
        kind: 'write',
        target: { path: path.join(os.homedir(), '.gitconfig'), boundary: 'protected' },
      }],
    });
  });

  it.runIf(process.platform === 'win32')(
    'resolves a findstr target under %TEMP% as an allowed temp read',
    () => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const assessment = assessAutoModeCall(
        call('bash', {
          command: 'findstr /n "transcriptSearch" %TEMP%\\sdk-runtime-v0.7.78.ts',
        }),
        context(projectRoot),
      );

      expect(assessment.decision.action).toBe('allow');
      expect(assessment.review).toMatchObject({
        analysis: { status: 'complete', binding: 'exact' },
        operations: [{
          kind: 'read',
          target: { boundary: 'system-temp' },
        }],
        risks: [],
      });
    },
  );

  it.runIf(process.platform === 'win32').each([
    ['echo hello > %TEMP%\\kodax-auto-rules.txt', 'write'],
    ['copy ordinary.txt %TEMP%\\kodax-auto-rules.txt', 'copy'],
    ['move ordinary.txt %TEMP%\\kodax-auto-rules.txt', 'move'],
    ['Set-Content -Path $env:TEMP\\kodax-auto-rules.txt -Value hello', 'write'],
  ] as const)(
    'preserves an environment-based temp path while modeling %s',
    (command, kind) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

      expect(assessment.decision.action).toBe('allow');
      expect(assessment.review.analysis).toMatchObject({ status: 'complete', binding: 'exact' });
      expect(assessment.review.operations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind,
          ...(kind === 'copy' || kind === 'move'
            ? { destination: expect.objectContaining({ boundary: 'system-temp' }) }
            : { target: expect.objectContaining({ boundary: 'system-temp' }) }),
        }),
      ]));
    },
  );

  it.runIf(process.platform === 'win32').each([
    'findstr /n "needle" %TEMP%\\kodax-auto-rules.txt',
    'echo hello > %TEMP%\\kodax-auto-rules.txt',
    'Set-Content -Path $env:TEMP\\kodax-auto-rules.txt -Value hello',
  ])(
    'does not trust process temp expansion when the Runtime shell environment may rewrite it: %s',
    (command) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const untrustedContext: AutoModeRulesContext = {
        ...context(projectRoot),
        trustProcessEnvironmentPathExpansion: false,
      };
      const assessment = assessAutoModeCall(call('bash', { command }), untrustedContext);

      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review).toMatchObject({
        analysis: { status: 'incomplete', binding: 'partial' },
        risks: expect.arrayContaining(['target_unresolved']),
      });
      expect(assessment.review.operations.some((operation) => (
        'target' in operation && operation.target.boundary === 'unresolved'
      ))).toBe(true);
    },
  );

  it.each([
    ['move /Y src/a.txt build/a.txt', 'move', ['source_removed', 'destination_overwrite_possible']],
    ['copy /Y src/a.txt build/a.txt', 'copy', ['destination_overwrite_possible']],
    ['del /Q build/old.txt', 'delete', ['source_removed']],
    ['rd /S /Q build/old', 'delete', ['source_removed']],
  ] as const)(
    'models cmd mutation switches without inventing write targets: %s',
    (command, kind, risks) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

      expect(assessment.review.analysis).toMatchObject({
        status: 'complete',
        binding: 'exact',
      });
      expect(assessment.review.operations).toHaveLength(1);
      expect(assessment.review.operations[0]).toMatchObject({ kind });
      expect(assessment.review.risks).toEqual(expect.arrayContaining(risks));
      expect(JSON.stringify(assessment.review.operations)).not.toMatch(/\/(?:Y|Q|S|A:H)"/i);
    },
  );

  it.runIf(process.platform === 'win32')(
    'models ren with an absolute source and relative new name as one rename',
    () => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const source = path.join(projectRoot, 'a.txt');
      fs.writeFileSync(source, 'a');
      const assessment = assessAutoModeCall(
        call('bash', { command: `ren "${source}" b.txt` }),
        context(projectRoot),
      );

      expect(assessment.review.operations).toEqual([{
        kind: 'rename',
        source: { path: source, boundary: 'workspace' },
        destination: { path: path.join(projectRoot, 'b.txt'), boundary: 'workspace' },
      }]);
    },
  );

  it.each([
    'del /S /Q build/old.txt',
    'rd /S /Q build/old',
    'rmdir /S /Q build/old',
  ])('records recursive cmd deletion semantics: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.review.operations[0]).toMatchObject({
      kind: 'delete',
      options: { recursive: true },
    });
  });

  it.each(['/tmp', '/home'])(
    'keeps a single-segment POSIX absolute path as an rm target: %s',
    (target) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const assessment = assessAutoModeCall(
        call('bash', { command: `rm ${target}` }),
        context(projectRoot),
      );

      expect(assessment.review.operations).toEqual([
        expect.objectContaining({
          kind: 'delete',
          target: expect.objectContaining({ path: target }),
        }),
      ]);
    },
  );

  it('still recognizes a documented Windows copy switch', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'copy /y src/a.txt build/a.txt' }),
      context(projectRoot),
    );

    expect(assessment.review.operations).toEqual([
      expect.objectContaining({
        kind: 'copy',
        source: expect.objectContaining({ path: 'src/a.txt' }),
        destination: expect.objectContaining({ path: 'build/a.txt' }),
        options: expect.objectContaining({ force: true }),
      }),
    ]);
  });

  it.each([
    'copy README.md+.env combined.txt',
    'copy /b README.md+.git/config combined.txt',
    'copy "README.md"+".env" combined.txt',
  ])('models every unquoted cmd copy concatenation source: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read',
      target: expect.objectContaining({ boundary: 'protected' }),
    }));
  });

  it.each([
    'copy a.txt+b.txt combined.txt',
    'copy "literal+name.txt" combined.txt',
  ])('keeps ordinary cmd copy sources deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.analysis).toMatchObject({ status: 'complete', binding: 'exact' });
  });

  it.each([
    'copy /b .env+,,',
    'copy /b .env +,,',
    'copy /b ".env" + , ,',
  ])('models cmd copy timestamp syntax against its actual protected target: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'write',
      target: expect.objectContaining({ path: '.env', boundary: 'protected' }),
    }));
    expect(JSON.stringify(assessment.review.operations)).not.toContain('.env+,,');
  });

  it.each([
    'cp -R -L packages tmp-copy',
    'cp --recursive --dereference packages tmp-copy',
    'chmod -R -L 755 packages',
    'chmod --recursive --dereference 755 packages',
    'chown -R -L user packages',
    'chown --recursive --dereference user packages',
    'ls -LR packages',
    'ls --recursive -L packages',
    'tree -l packages',
  ])('reviews recursive operations that explicitly follow symbolic links: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('incomplete');
  });

  it.each([
    'cp -R -P packages tmp-copy',
    'cp --recursive --no-dereference packages tmp-copy',
    'chmod -R 755 packages',
    'chown -R user packages',
    'ls -R packages',
    'tree packages',
  ])('keeps recursive operations that do not follow descendants deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
  });

  it.each([
    'git describe --dirty',
    'git describe --dirty=-changed',
    'git describe --broken',
    'git describe --broken=-broken',
  ])('keeps git describe worktree-state reads deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.analysis.status).toBe('complete');
  });

  it('keeps an ordinary git describe query deterministic', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'git describe --always' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
  });

  it.each([
    'cp -Destination C:\\outside ordinary.txt',
    'cp -D:..\\outside ordinary.txt',
    'cp -d ..\\outside ordinary.txt',
    'cp -L:.env ordinary.txt',
    'cp -Destination C:\\outside -Path ordinary.txt',
    'copy -ToSession remote ordinary.txt C:\\outside',
    'copy -l:.env ordinary.txt',
    'copy -FromSession remote ordinary.txt C:\\outside',
    'mv -Destination C:\\outside ordinary.txt',
    'mv -D:%TEMP% ordinary.txt',
    'move -L:.env ordinary.txt',
    'move -Credential account ordinary.txt C:\\outside',
    'rm -LiteralPath ordinary.txt',
    'del -Recurse ordinary',
    'ren -NewName changed.txt ordinary.txt',
    'ren -L:.env ordinary.txt',
    'ren -N:new-name.txt ordinary.txt',
  ])('reviews shell aliases with PowerShell named-parameter semantics: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('incomplete');
  });

  it.each([
    'cp -r packages copied-packages',
    'cp -f source.txt destination.txt',
    'mv -f old.txt new.txt',
    'rm -rf build',
    'rm -r build',
  ])('keeps semantically equivalent short alias flags deterministic: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.review.analysis.status).toBe('complete');
  });

  it.runIf(process.platform === 'win32')(
    'does not claim exact binding for cmd move paths whose trailing backslash is ambiguous to the POSIX parser',
    () => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const destination = `${path.join(projectRoot, '旅游城市数据标注项目')}\\`;
      const command = [
        `move /Y "${path.join(projectRoot, 'a.json')}" "${destination}"`,
        `move /Y "${path.join(projectRoot, 'b.md')}" "${destination}"`,
      ].join(' && ');

      const assessment = assessAutoModeCall(
        call('bash', { command }),
        context(projectRoot),
      );

      expect(assessment.review.analysis).toMatchObject({
        status: 'incomplete',
        binding: 'partial',
      });
      expect(assessment.review.risks).not.toContain('outside_workspace_mutation');
      expect(JSON.stringify(assessment.review.operations)).not.toContain('&& move');
    },
  );

  it('marks unknown PowerShell parameter binding incomplete instead of guessing', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'Copy-Item -Unknown value src/a.txt build/b.txt' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis).toMatchObject({
      status: 'incomplete',
      shell: 'powershell',
      binding: 'partial',
    });
  });

  it.each([
    'Set-Content Env:KODAX_FLAG enabled',
    'Remove-Item HKLM:\\Software\\KodaX',
    'Copy-Item src/a.txt build/a.txt -ToSession remote-session',
    'New-Item -ItemType SymbolicLink -Path build/link -Target ../outside',
  ])('never rules-auto-allows a PowerShell mutation with unmodelled effects: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('incomplete');
  });

  it('escalates high-risk and unmodelled bash commands instead of guessing', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const dangerous = evaluateAutoRulesCall(
      call('bash', { command: 'git push --force origin main' }),
      context(projectRoot, projectRoot, [
        { kind: 'dangerous_pattern', pattern: 'git push --force', severity: 'high' },
      ]),
    );
    const unmodelled = evaluateAutoRulesCall(
      call('bash', { command: 'node scripts/custom-operation.js' }),
      context(projectRoot),
    );
    expect(dangerous.action).toBe('escalate');
    expect(unmodelled.action).toBe('escalate');
  });

  it.each([
    'echo no > $HOME/outside.txt',
    'echo no > $UNRESOLVED/outside.txt',
    'echo no > %USERPROFILE%/outside.txt',
  ])('escalates shell-expanded target instead of treating it as a lexical workspace path: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('bash', { command }), context(projectRoot)).action)
      .toBe('escalate');
  });

  it.each([
    'node scripts/custom-operation.js > reports/output.txt',
    'node scripts/custom-operation.js && echo ok > reports/output.txt',
  ])('escalates a shell command with unmodelled effects even when one output is in-boundary: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('bash', { command }), context(projectRoot)).action)
      .toBe('escalate');
  });

  it('uses declared side effects when a tool has no dedicated analyzer', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const cases = [
      ['extension_reader', 'readonly', {}, 'allow'],
      ['extension_file_reader', 'readonly', { file_path: 'src/inside.ts' }, 'allow'],
      ['extension_search', 'reads-network', {}, 'allow'],
      ['agent_control', 'mutates-state', {}, 'allow'],
      ['extension_writer', 'mutates-fs', { path: 'src/inside.ts' }, 'allow'],
      ['remote_mutation', 'mutates-network', {}, 'escalate'],
    ] as const;

    for (const [name, toolSideEffect, input, expected] of cases) {
      const assessment = assessAutoModeCall(
        call(name, input),
        { ...context(projectRoot), toolSideEffect },
      );
      expect(assessment.decision.action, name).toBe(expected);
    }
  });

  it.each([
    ['path', '.ssh/id_rsa'],
    ['file_path', '.aws/credentials'],
    ['filePath', '.codex/auth.json'],
  ] as const)('does not let readonly metadata hide a protected %s input', (field, target) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('extension_reader', { [field]: target }),
      { ...context(projectRoot), toolSideEffect: 'readonly' },
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('escalates an unknown tool without trusted side-effect metadata', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('extension_writer', { path: 'src/inside.ts' }),
      context(projectRoot),
    );
    expect(decision.action).toBe('escalate');
  });
});

describe('Auto[LLM] environment-provider routing', () => {
  it.each([
    ['node --version', 'Check the Node.js version.'],
    ['powershell -File scripts/build.ps1', 'Run the requested build script.'],
    ['git push origin HEAD', 'Push the current commit to origin.'],
    ['curl https://example.com/status', 'Fetch the requested status URL.'],
    ['Get-Content .env', 'Read the requested environment file.'],
    ['rm -rf build', 'Remove the generated build directory.'],
  ])('honors a decision-only allow without asking the user for %s', async (
    command,
    intent,
  ) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider('<decision>allow</decision>');
    let approvalRequests = 0;
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => (input) => `Bash: ${String(
        (input as Readonly<Record<string, unknown>>).command ?? '',
      )}`,
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
      askUser: async () => {
        approvalRequests += 1;
        return 'block';
      },
    });

    const verdict = await guardrail.beforeTool!(call('bash', { command }), {
      agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
      messages: [{ role: 'user', content: intent }],
    });

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(1);
    expect(approvalRequests).toBe(0);
  });

  it.each([
    ['rm -rf build', 'Delete the build directory.'],
    ['rm -rf .', 'Delete the current project directory.'],
    ['rm -rf .git', 'Delete the Git metadata directory.'],
  ])('consults the classifier for a high-loss recursive delete: %s', async (command, intent) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => (input) => `Bash: ${String(
        (input as Readonly<Record<string, unknown>>).command ?? '',
      )}`,
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(call('bash', { command }), {
      agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
      messages: [{ role: 'user', content: intent }],
    });

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(1);
  });

  it.each([
    'Copy-Item -Path . -Filter .env -Recurse -Destination build',
    'Copy-Item -Path . -Include *.env -Recurse -Destination build',
    'Move-Item -Path . -Exclude ordinary.txt -Destination build',
    'Remove-Item -Path . -Filter .env -Recurse',
    'Set-Content -Path . -Filter .env -Value x',
    'Add-Content -Path . -Include .env -Value x',
  ])('reviews PowerShell mutation selectors whose concrete target set is unresolved: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis).toMatchObject({
      status: 'incomplete',
      shell: 'powershell',
      binding: 'partial',
    });
  });

  it('keeps an explicitly requested ordinary file delete deterministic', async () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => (input) => `Bash: ${String(
        (input as Readonly<Record<string, unknown>>).command ?? '',
      )}`,
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(call('bash', { command: 'rm src/old.txt' }), {
      agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
      messages: [{ role: 'user', content: 'Delete src/old.txt.' }],
    });

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    ['copy README.md+.env combined.txt', 'Copy README.md and .env into combined.txt.'],
    ['copy /b README.md+.git/config combined.txt', 'Combine the requested files.'],
    ['cp -R -L packages tmp-copy', 'Recursively copy packages to tmp-copy and follow links.'],
    ['chmod -R -L 755 packages', 'Recursively change packages to mode 755 and follow links.'],
    ['ls -LR packages', 'Recursively list packages and follow links.'],
    ['tree -l packages', 'Show the package tree and follow links.'],
    ['cp -Destination C:\\outside ordinary.txt', 'Copy ordinary.txt to C:\\outside.'],
    ['cp -D:..\\outside ordinary.txt', 'Copy ordinary.txt to the outside directory.'],
    ['cp -L:.env ordinary.txt', 'Copy the requested file.'],
    ['mv -D:%TEMP% ordinary.txt', 'Move ordinary.txt to the temporary directory.'],
    ['ren -N:new-name.txt ordinary.txt', 'Rename ordinary.txt to new-name.txt.'],
    [
      'Copy-Item -Path . -Filter .env -Recurse -Destination build',
      'Copy the matching file into build.',
    ],
    ['copy -ToSession remote ordinary.txt C:\\outside', 'Copy ordinary.txt in the remote session.'],
    ['echo safe\nnode --version', 'Inspect the shell and Node.js version.'],
    ['echo "safe\n$(node script.js)"', 'Run the requested Node.js substitution.'],
    ['echo safe\\ #$(node script.js)', 'Run the requested Node.js substitution.'],
    ['echo safe\\\n#$(node script.js)', 'Run the requested Node.js substitution.'],
  ])('calls the classifier once for an explicitly requested unresolved effect: %s', async (
    command,
    intent,
  ) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => (input) => `Bash: ${String(
        (input as Readonly<Record<string, unknown>>).command ?? '',
      )}`,
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(call('bash', { command }), {
      agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
      messages: [{ role: 'user', content: intent }],
    });

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(1);
  });

  it.each([
    call('grep', { path: 'src/sdk-runtime.ts', glob: '*.ts', pattern: 'permission' }),
    call('glob', { path: '.', pattern: '**/*.ts' }),
    call('bash', { command: 'rg permission src' }),
    call('bash', { command: 'git log --oneline --no-merges' }),
    call('bash', { command: 'git diff --stat' }),
  ])('does not invoke the classifier for an ordinary read: $name', async (toolCall) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'sdk-runtime.ts'), 'export const permission = true;');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => () => 'ordinary read',
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (candidate) => analyzeAutoModeCall(candidate, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(toolCall, {
      agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
      messages: [{ role: 'user', content: 'Review the project.' }],
    });

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    'Get-Content README.md',
    'gc README.md',
    'cat README.md',
    'type README.md',
    'head README.md',
    'tail README.md',
    'more README.md',
    'Select-String token README.md',
    'sls token README.md',
    'git grep token -- README.md',
    'git grep token HEAD -- README.md',
    'git show HEAD:README.md',
    'git show :README.md',
    'git show :0:README.md',
    'git show :1:README.md',
    'git show :./README.md',
    'git show HEAD -- README.md',
    "git show HEAD -- ':(top)README.md'",
    "git diff -- ':(literal)README.md'",
    "git grep token -- ':(icase)README.md'",
    "git show HEAD -- ':/README.md'",
    'git diff -- README.md',
    'git log -p -- README.md',
    'git stash show -p -- README.md',
  ])('models the concrete content-read target before checking user intent: %s', async (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => (input) => `Bash: ${String(
        (input as Readonly<Record<string, unknown>>).command ?? '',
      )}`,
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(
      call('bash', { command }),
      {
        agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
        messages: [{ role: 'user', content: 'Do not read README.md.' }],
      },
    );

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(1);
  });

  it.each([
    "git show HEAD -- ':(attr:secret)README.md'",
    "git grep token -- ':(prefix:2)README.md'",
  ])('consults the classifier for a Git content scope that cannot be normalized: %s', async (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => (input) => `Bash: ${String(
        (input as Readonly<Record<string, unknown>>).command ?? '',
      )}`,
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(call('bash', { command }), {
      agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
      messages: [{ role: 'user', content: 'Inspect the requested Git information.' }],
    });

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(1);
  });

  it('keeps a Git commit-message search deterministic', async () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => () => 'Bash: git show :/release-message',
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(
      call('bash', { command: 'git show :/release-message' }),
      {
        agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
        messages: [{ role: 'user', content: 'Inspect the requested Git information.' }],
      },
    );

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    'Get-ChildItem Env:*',
    'Get-ChildItem Env:OPENAI_*',
    'Get-ChildItem Env: -Force',
    'Get-ChildItem Variable:*',
    'Get-Variable *',
    'echo Env:* | Get-ChildItem',
    'echo Env:* | Get-ChildItem -EA Ignore',
    'echo Env:* | Get-ChildItem -OutVariable x',
    'echo $script:OPENAI_API_KEY',
    'Get-Content Env:KAGGLE_KEY',
    'echo ${!SECRET_NAME}',
    'echo $KAGGLE_KEY',
    'echo %KAGGLE_KEY%',
    'echo $Variable:KAGGLE_KEY',
    'Get-Item Env:KAGGLE_KEY',
    'gi Env:*',
    'Get-Variable -Name KAGGLE_KEY -ValueOnly',
    'gv *',
    'Get-Content Function:prompt',
    'Get-Item Function:prompt',
    'Get-ChildItem Alias:*',
    'Get-Item HKCU:\\Software',
    'gc .env',
    'gi .env',
    'gci .env',
    'gc .env*',
    'sls token .env',
    'sls token .env*',
    'gc -PSPath:.env',
    'sls -Pattern token -PSPath:.env',
    'Get-Content -PSPath:Env:KAGGLE_KEY',
    'Select-String -Pattern token -PSPath:Env:KAGGLE_KEY',
    'gc -PSPath:Env:KAGGLE_KEY',
    'sls -Pattern token -PSPath:Function:prompt',
    'Select-String token Env:KAGGLE_KEY',
    'Select-String -Pattern token Env:KAGGLE_KEY',
    'Select-String -Pattern:token -Path:Function:prompt',
    'Get-Content @params',
    'gc @global:params',
    'Select-String @script:params',
    'sls @params',
    'Get-Item @local:params',
    'gi @params',
    'Get-ChildItem @private:params',
    'gci @params',
    'Get-Variable @params',
    'gv @params',
    'find -files0-from .env -print',
    'find --files0-from=.env -print',
    'tree --fromfile .env',
    'tree --fromfile=.env',
    'tree --fromtabfile .git/config',
    'tree --fromtabfile=.git/config',
    'tree --fromfile -L 2 .env',
    'tree --fromfile --charset utf-8 .env',
    'tree --fromfile README.md .env',
    'copy README.md+.env combined.txt',
    'copy /b README.md+.git/config combined.txt',
    'copy "README.md"+".env" combined.txt',
    'git config --get remote.origin.url',
    'git remote -v',
    'git remote get-url origin',
    'git remote show origin',
    'type .e^nv',
    'findstr token .e^nv',
    'git show HEAD:^.env',
    'type .e!EMPTY!nv',
    'cat .git/config',
    'cat .gitmodules',
    'cat ~/.gitconfig',
    'cat ~/.codex/auth.json',
    'Get-Content ~/.claude/.credentials.json',
    'cat ~/.gemini/settings.json',
    'Get-Content ~/.config/openai/auth.json',
    'cat ~/.config/anthropic/credentials.json',
    'cat .envrc',
    'cat .pgpass',
    'cat .direnv/allow/secret',
    'cat .terraform.d/credentials.tfrc.json',
    'cat ~/.cargo/credentials.toml',
    'dd if=.env of=tmp-copy.bin',
    'dd if=.git/config of=tmp-copy.bin',
    'tee tmp-copy < .env',
    'tee tmp-copy < .git/config',
    'touch --reference=.env target.txt',
    'touch --reference .git/config target.txt',
    'touch -r.env target.txt',
    'touch -r .env target.txt',
    'date --reference=.env',
    'date -r .git/config',
    'chmod --reference=.env target.txt',
    'chmod --reference .git/config target.txt',
    'chown --reference=.env target.txt',
    'less README.md',
    'node --version',
    'python --version',
    'yarn --version',
    'pnpm --version',
    'pip --version',
  ])('consults the classifier exactly once for %s', async (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => (input) => `Bash: ${String(
        (input as Readonly<Record<string, unknown>>).command ?? '',
      )}`,
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(
      call('bash', { command }),
      {
        agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
        messages: [{ role: 'user', content: 'Inspect the environment configuration.' }],
      },
    );

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(1);
  });

  it.each([
    "echo '$OPENAI_API_KEY'",
    "rg '\\$KAGGLE_KEY' README.md",
    "Get-Content README.md | Select-String '\\$env:OPENAI_API_KEY'",
  ])('keeps literal variable text deterministic for %s', async (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => (input) => `Bash: ${String(
        (input as Readonly<Record<string, unknown>>).command ?? '',
      )}`,
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(
      call('bash', { command }),
      {
        agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
        messages: [{ role: 'user', content: 'Inspect the requested literal text.' }],
      },
    );

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    ['copy "literal+name.txt" combined.txt', 'Copy literal+name.txt to combined.txt.'],
  ])('keeps an explicitly requested ordinary cmd copy deterministic for %s', async (command, intent) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => (input) => `Bash: ${String(
        (input as Readonly<Record<string, unknown>>).command ?? '',
      )}`,
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(call('bash', { command }), {
      agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
      messages: [{ role: 'user', content: intent }],
    });

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    'Get-Item Env:PATH',
    'Get-Item Microsoft.PowerShell.Core\\Environment::PATH',
    'Get-Item Microsoft.PowerShell.Core\\Variable::HOME',
    'gi Env:PATH',
    'Get-Variable PATH',
    'Get-Variable HOME',
    'gv PATH',
    'Get-Variable -Name PATH -ValueOnly',
    "Select-String 'Env:KAGGLE_KEY' README.md",
    'sls Env:KAGGLE_KEY README.md',
    'Select-String Function:prompt README.md',
    'Select-String -SimpleMatch Env:KAGGLE_KEY README.md',
    'Select-String Env:KAGGLE_KEY -Path README.md',
    'Select-String -InputObject Env:KAGGLE_KEY token',
    'Get-Content README.md',
    'gc README.md',
    'cat README.md',
    'type README.md',
    'head README.md',
    'tail README.md',
    'more README.md',
    'Select-String token README.md',
    'sls token README.md',
    'gc -PSPath:README.md',
    'sls -Pattern token -PSPath:README.md',
    "Select-String -EA Ignore '.env' README.md",
    "Select-String -Context 1,2 '.env' README.md",
    "Select-String -Encoding UTF8 '.env' README.md",
  ])('keeps proven-safe process-data selectors deterministic for %s', async (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const provider = new ClassifierProbeProvider();
    const guardrail = createAutoModeToolGuardrail({
      rules: { allow: [], soft_deny: [], environment: [] },
      getToolProjection: () => (input) => `Bash: ${String(
        (input as Readonly<Record<string, unknown>>).command ?? '',
      )}`,
      resolveProvider: () => provider,
      defaultProvider: provider.name,
      defaultModel: 'classifier-probe',
      projectRoot,
      executionCwd: projectRoot,
      analyzeCall: (toolCall) => analyzeAutoModeCall(toolCall, context(projectRoot)),
    });

    const verdict = await guardrail.beforeTool!(
      call('bash', { command }),
      {
        agent: { name: 'test', instructions: '' } as GuardrailContext['agent'],
        messages: [{ role: 'user', content: 'Inspect the requested process metadata.' }],
      },
    );

    expect(verdict.action).toBe('allow');
    expect(provider.calls).toHaveLength(0);
  });
});

describe('Auto[rules] user KodaX home read narrowing', () => {
  let userKodax: string | undefined;

  afterEach(() => {
    setAgentConfigHome(undefined);
    if (userKodax) {
      removeTempDirSync(userKodax);
      userKodax = undefined;
    }
  });

  it('allows reading non-credential ~/.kodax paths without confirmation', () => {
    const projectRoot = createRoot('kodax-home-narrow-');
    userKodax = createTempDirSync('kodax-home-narrow-user-', process.cwd());
    setAgentConfigHome(userKodax);
    fs.mkdirSync(path.join(userKodax, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'tool-results', 'out.txt'), 'x');
    fs.writeFileSync(path.join(userKodax, 'custom-providers.json'), '{}');
    fs.mkdirSync(path.join(userKodax, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'sessions', 's.json'), '{}');
    fs.mkdirSync(path.join(userKodax, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'agents', 'reviewer.md'), '# Reviewer');

    const openPaths = [
      ['tool-results/out.txt', 'agent-home'],
      ['custom-providers.json', 'agent-home-readonly'],
      ['sessions/s.json', 'agent-home'],
      ['agents/reviewer.md', 'agent-home'],
    ];
    for (const [rel, boundary] of openPaths) {
      const assessment = assessAutoModeCall(
        call('read', { path: path.join(userKodax, rel!) }),
        context(projectRoot),
      );
      expect(assessment.decision.action).toBe('allow');
      expect(assessment.review.operations).toContainEqual(expect.objectContaining({
        kind: 'read',
        target: expect.objectContaining({ boundary }),
      }));
    }
  });

  it('allows glob/grep of a clean agent-home working subtree without confirmation', () => {
    const projectRoot = createRoot('kodax-home-narrow-');
    userKodax = createTempDirSync('kodax-home-narrow-user-', process.cwd());
    setAgentConfigHome(userKodax);
    fs.mkdirSync(path.join(userKodax, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'tool-results', 'out.txt'), 'x');

    const toolCalls = [
      call('glob', { path: path.join(userKodax, 'tool-results'), pattern: '*.txt' }),
      call('grep', { path: path.join(userKodax, 'tool-results'), pattern: 'x' }),
    ];
    for (const toolCall of toolCalls) {
      const assessment = assessAutoModeCall(toolCall, context(projectRoot));
      expect(assessment.decision.action).toBe('allow');
      expect(assessment.review.operations).toContainEqual(expect.objectContaining({
        kind: 'read',
        target: expect.objectContaining({ boundary: 'agent-home' }),
      }));
    }
  });

  it('allows common recursive shell search flags over clean working subtrees', () => {
    const projectRoot = createRoot('kodax-home-clean-shell-search-');
    userKodax = createTempDirSync('kodax-home-clean-shell-search-user-', process.cwd());
    setAgentConfigHome(userKodax);
    const scratch = path.join(userKodax, 'scratch');
    const toolResults = path.join(userKodax, 'tool-results');
    fs.mkdirSync(scratch, { recursive: true });
    fs.mkdirSync(toolResults, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'out.txt'), 'foo');
    fs.writeFileSync(path.join(toolResults, 'out.txt'), 'foo');

    for (const command of [
      `rg -n foo "${scratch}"`,
      `grep -n -r foo "${toolResults}"`,
    ]) {
      const assessment = assessAutoModeCall(
        call('bash', { command }),
        context(projectRoot),
      );
      expect(assessment.decision.action).toBe('allow');
    }
  });

  it('reviews worktree removal only when an Agent Home tree contains protected descendants', () => {
    const projectRoot = createRoot('kodax-home-worktree-remove-');
    userKodax = createTempDirSync('kodax-home-worktree-remove-user-', process.cwd());
    setAgentConfigHome(userKodax);
    const worktree = path.join(userKodax, 'sessions', 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, 'ordinary.txt'), 'ok');
    const rulesContext: AutoModeRulesContext = {
      ...context(projectRoot),
      toolSideEffect: 'mutates-fs',
    };

    expect(assessAutoModeCall(call('worktree_remove', {
      action: 'remove',
      worktree_path: worktree,
    }), rulesContext).decision.action).toBe('allow');

    fs.writeFileSync(path.join(worktree, '.env'), 'SECRET=value');
    const protectedAssessment = assessAutoModeCall(call('worktree_remove', {
      action: 'remove',
      worktree_path: worktree,
    }), rulesContext);
    expect(protectedAssessment.decision.action).toBe('escalate');
    expect(protectedAssessment.review.risks).toContain('protected_descendant');
  });

  it('treats an rg file operand as an exact read instead of a recursive root', () => {
    const projectRoot = createRoot('kodax-home-rg-file-');
    userKodax = createTempDirSync('kodax-home-rg-file-user-', process.cwd());
    setAgentConfigHome(userKodax);
    const scratch = path.join(userKodax, 'scratch');
    const ordinary = path.join(scratch, 'out.txt');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(ordinary, 'foo');
    fs.writeFileSync(path.join(scratch, 'credentials.json'), 'secret');

    const exact = assessAutoModeCall(
      call('bash', { command: `rg -n foo "${ordinary}"` }),
      context(projectRoot),
    );
    expect(exact.decision.action).toBe('allow');

    const recursive = assessAutoModeCall(
      call('bash', { command: `rg -n foo "${scratch}"` }),
      context(projectRoot),
    );
    expect(recursive.decision.action).toBe('escalate');
    expect(recursive.review.risks).toContain('sensitive_read');
  });

  it('escalates recursive reads rooted above the agent home', () => {
    const projectRoot = createRoot('kodax-home-parent-read-');
    userKodax = createTempDirSync('kodax-home-parent-read-user-', process.cwd());
    setAgentConfigHome(userKodax);
    const parent = path.dirname(userKodax);

    for (const toolCall of [
      call('glob', { path: parent, pattern: '**/*' }),
      call('grep', { path: parent, pattern: 'token' }),
      call('bash', { command: `grep -R token "${parent}"` }),
    ]) {
      const assessment = assessAutoModeCall(toolCall, context(projectRoot));
      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review.risks).toContain('sensitive_read');
    }
  });

  it('escalates glob selectors that escape an open agent-home subtree', () => {
    const projectRoot = createRoot('kodax-home-glob-escape-');
    userKodax = createTempDirSync('kodax-home-glob-escape-user-', process.cwd());
    setAgentConfigHome(userKodax);
    const assessment = assessAutoModeCall(call('glob', {
      path: path.join(userKodax, 'tool-results'),
      pattern: '../mcp-tokens/**/*',
    }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('escalates absolute and ambiguous glob selectors that can reach credentials', () => {
    const projectRoot = createRoot('kodax-home-glob-selector-');
    userKodax = createTempDirSync('kodax-home-glob-selector-user-', process.cwd());
    setAgentConfigHome(userKodax);
    fs.mkdirSync(path.join(userKodax, 'tool-results'), { recursive: true });
    fs.mkdirSync(path.join(userKodax, 'mcp-tokens'), { recursive: true });

    for (const pattern of [
      path.join(userKodax, 'mcp-tokens', '**', '*'),
      '{../mcp-tokens,*.txt}/**/*',
    ]) {
      const assessment = assessAutoModeCall(call('glob', {
        path: path.join(userKodax, 'tool-results'),
        pattern,
      }), context(projectRoot));
      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review.risks).toContain('sensitive_read');
    }
  });

  it('escalates recursive search even in an open subtree with a sensitive descendant', () => {
    const projectRoot = createRoot('kodax-home-sensitive-descendant-');
    userKodax = createTempDirSync('kodax-home-sensitive-descendant-user-', process.cwd());
    setAgentConfigHome(userKodax);
    fs.mkdirSync(path.join(userKodax, 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'scratch', 'credentials.json'), 'secret');

    for (const toolCall of [
      call('glob', { path: path.join(userKodax, 'scratch'), pattern: '**/*' }),
      call('grep', { path: path.join(userKodax, 'scratch'), pattern: 'secret' }),
      call('bash', { command: `grep -R secret "${path.join(userKodax, 'scratch')}"` }),
    ]) {
      const assessment = assessAutoModeCall(toolCall, context(projectRoot));
      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review.risks).toContain('sensitive_read');
    }
  });

  it('does not mistake a recursive search option value for its search root', () => {
    const projectRoot = createRoot('kodax-home-search-options-');
    userKodax = createTempDirSync('kodax-home-search-options-user-', process.cwd());
    setAgentConfigHome(userKodax);
    const scratch = path.join(userKodax, 'scratch');
    fs.mkdirSync(path.join(scratch, 'secret'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'credentials.json'), 'secret');

    const assessment = assessAutoModeCall(call('bash', {
      command: 'rg -g "*" secret',
    }), context(projectRoot, scratch));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('escalates recursive reads rooted above credential-bearing descendants', () => {
    const projectRoot = createRoot('kodax-home-narrow-');
    userKodax = createTempDirSync('kodax-home-narrow-user-', process.cwd());
    setAgentConfigHome(userKodax);
    fs.mkdirSync(path.join(userKodax, 'mcp-tokens'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'mcp-tokens', 'token.json'), '{"token":"secret"}');

    for (const toolCall of [
      call('glob', { path: userKodax, pattern: '**/*' }),
      call('grep', { path: userKodax, pattern: 'secret' }),
      call('grep', { path: path.join(userKodax, 'runtime'), pattern: 'token' }),
    ]) {
      const assessment = assessAutoModeCall(toolCall, context(projectRoot));
      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review.risks).toContain('sensitive_read');
    }
  });

  it.each(['.env', '.npmrc', 'id_ed25519'])(
    'escalates generic sensitive agent-home read: %s',
    (filename) => {
      const projectRoot = createRoot('kodax-home-narrow-');
      userKodax = createTempDirSync('kodax-home-narrow-user-', process.cwd());
      setAgentConfigHome(userKodax);
      fs.writeFileSync(path.join(userKodax, filename), 'secret');

      const assessment = assessAutoModeCall(
        call('read', { path: path.join(userKodax, filename) }),
        context(projectRoot),
      );
      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review.risks).toContain('sensitive_read');
    },
  );

  it('still escalates credential-bearing ~/.kodax reads', () => {
    const projectRoot = createRoot('kodax-home-narrow-');
    userKodax = createTempDirSync('kodax-home-narrow-user-', process.cwd());
    setAgentConfigHome(userKodax);
    fs.mkdirSync(path.join(userKodax, 'mcp-tokens'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'mcp-tokens', 't.json'), '{}');
    fs.mkdirSync(path.join(userKodax, 'mcp-clients'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'mcp-clients', 'c.json'), '{}');
    fs.mkdirSync(path.join(userKodax, 'integrations'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'integrations', 'mcp.json'), '{}');
    fs.mkdirSync(path.join(userKodax, 'runtime', 'daemon', 'default'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'runtime', 'daemon', 'default', 'daemon.token'), 'x');
    fs.writeFileSync(path.join(userKodax, 'runtime', 'daemon', 'default', 'owner-policy.json'), '{}');
    fs.writeFileSync(path.join(userKodax, 'runtime', 'daemon', 'default', 'daemon.log'), 'x');
    fs.writeFileSync(path.join(userKodax, 'runtime', 'daemon', 'default', 'daemon.json'), '{}');
    fs.writeFileSync(path.join(userKodax, 'runtime', 'daemon', 'default', 'bootstrap.log'), 'x');
    fs.writeFileSync(path.join(userKodax, 'runtime', 'daemon', 'default', 'daemon.lock'), 'x');
    fs.mkdirSync(path.join(userKodax, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(userKodax, 'runtime', 'permission-grants.json'), '{}');
    fs.writeFileSync(path.join(userKodax, 'trusted-project-rules.json'), '{}');
    fs.writeFileSync(path.join(userKodax, 'config.json'), '{}');

    const protectedPaths = [
      'mcp-tokens/t.json',
      'mcp-clients/c.json',
      'integrations/mcp.json',
      'runtime/daemon/default/daemon.token',
      'runtime/daemon/default/owner-policy.json',
      'runtime/daemon/default/daemon.log',
      'runtime/daemon/default/daemon.json',
      'runtime/daemon/default/bootstrap.log',
      'runtime/daemon/default/daemon.lock',
      'runtime/permission-grants.json',
      'trusted-project-rules.json',
      'config.json',
    ];
    for (const rel of protectedPaths) {
      const assessment = assessAutoModeCall(
        call('read', { path: path.join(userKodax, rel) }),
        context(projectRoot),
      );
      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review.operations).toContainEqual(expect.objectContaining({
        kind: 'read',
        target: expect.objectContaining({ boundary: 'protected' }),
      }));
      expect(assessment.review.risks).toContain('sensitive_read');
    }
  });

  it('still escalates reads of project <root>/.kodax/ (not the user home)', () => {
    const projectRoot = createRoot('kodax-home-narrow-');
    userKodax = createTempDirSync('kodax-home-narrow-user-', process.cwd());
    setAgentConfigHome(userKodax);
    fs.mkdirSync(path.join(projectRoot, '.kodax'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.kodax', 'config.local.json'), '{}');

    const assessment = assessAutoModeCall(
      call('read', { path: '.kodax/config.local.json' }),
      context(projectRoot),
    );
    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read',
      target: expect.objectContaining({ boundary: 'protected' }),
    }));
  });

  it('allows writes to non-credential ~/.kodax paths', () => {
    const projectRoot = createRoot('kodax-home-narrow-');
    userKodax = createTempDirSync('kodax-home-narrow-user-', process.cwd());
    setAgentConfigHome(userKodax);
    for (const rel of [
      path.join('agents', 'reviewer.md'),
      path.join('sessions', 's.json'),
      path.join('tool-results', 'out.txt'),
      path.join('scratch', 'plan.json'),
    ]) {
      const decision = evaluateAutoRulesCall(
        call('write', { path: path.join(userKodax, rel) }),
        context(projectRoot),
      );
      expect(decision.action).toBe('allow');
    }
  });

  it('still escalates writes to credential ~/.kodax paths', () => {
    const projectRoot = createRoot('kodax-home-narrow-');
    userKodax = createTempDirSync('kodax-home-narrow-user-', process.cwd());
    setAgentConfigHome(userKodax);

    const decision = evaluateAutoRulesCall(
      call('write', { path: path.join(userKodax, 'config.json') }),
      context(projectRoot),
    );
    expect(decision.action).toBe('escalate');
  });

  it.each([
    ['agent home root', ''],
    ['runtime root', 'runtime'],
    ['runtime descendant', path.join('runtime', 'state.json')],
    ['generic sensitive file', '.env'],
  ])('escalates writes to %s', (_label, rel) => {
    const projectRoot = createRoot('kodax-home-narrow-');
    userKodax = createTempDirSync('kodax-home-narrow-user-', process.cwd());
    setAgentConfigHome(userKodax);

    const decision = evaluateAutoRulesCall(
      call('write', { path: path.join(userKodax, rel) }),
      context(projectRoot),
    );
    expect(decision.action).toBe('escalate');
  });

  it.runIf(process.platform === 'win32')('protects Win32 aliases of the Runtime control plane', () => {
    const projectRoot = createRoot('kodax-home-win-alias-');
    userKodax = createTempDirSync('kodax-home-win-alias-user-', process.cwd());
    setAgentConfigHome(userKodax);

    for (const rel of [
      path.join('runtime.', 'state.json'),
      path.join('runtime ', 'state.json'),
      'runtime:control',
      'config.json.',
      path.join('mcp-tokens.', 'token.json'),
    ]) {
      expect(evaluateAutoRulesCall(
        call('write', { path: path.join(userKodax, rel) }),
        context(projectRoot),
      ).action).toBe('escalate');
    }
    expect(evaluateAutoRulesCall(
      call('write', { path: path.join(userKodax, 'agents', 'reviewer.md') }),
      context(projectRoot),
    ).action).toBe('allow');
  });

  it('allows bash reads of non-credential ~/.kodax paths (cat/Get-Content)', () => {
    // agentHome must contain a `.kodax` path component so the bash
    // sensitivePathCandidate short-circuit fires and exercises the
    // classifySensitiveReadTarget deferral (not just classifyTarget).
    const projectRoot = createRoot('kodax-bash-narrow-');
    userKodax = createTempDirSync('kodax-bash-narrow-', process.cwd());
    const agentHome = path.join(userKodax, '.kodax');
    fs.mkdirSync(path.join(agentHome, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(agentHome, 'tool-results', 'out.txt'), 'x');
    setAgentConfigHome(agentHome);
    const target = path.join(agentHome, 'tool-results', 'out.txt').replace(/\\/g, '/');
    for (const command of [`cat ${target}`, `Get-Content ${target}`]) {
      const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));
      expect(assessment.decision.action).toBe('allow');
      expect(assessment.review.operations).toContainEqual(expect.objectContaining({
        kind: 'read',
        target: expect.objectContaining({ boundary: 'agent-home' }),
      }));
    }
  });

  it('still escalates bash reads of credential ~/.kodax paths', () => {
    const projectRoot = createRoot('kodax-bash-narrow-');
    userKodax = createTempDirSync('kodax-bash-narrow-', process.cwd());
    const agentHome = path.join(userKodax, '.kodax');
    fs.mkdirSync(path.join(agentHome, 'mcp-tokens'), { recursive: true });
    fs.writeFileSync(path.join(agentHome, 'mcp-tokens', 't.json'), '{}');
    fs.writeFileSync(path.join(agentHome, 'config.json'), '{}');
    setAgentConfigHome(agentHome);
    for (const rel of ['mcp-tokens/t.json', 'config.json']) {
      const target = path.join(agentHome, rel).replace(/\\/g, '/');
      const assessment = assessAutoModeCall(
        call('bash', { command: `cat ${target}` }),
        context(projectRoot),
      );
      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review.risks).toContain('sensitive_read');
    }
  });

  it('checks expanded reads and tree mutations against actual protected descendants', () => {
    const projectRoot = createRoot('kodax-home-selection-');
    userKodax = createTempDirSync('kodax-home-selection-user-', process.cwd());
    setAgentConfigHome(userKodax);
    const scratch = path.join(userKodax, 'scratch');
    const credential = path.join(scratch, 'credentials.json');
    const destination = path.join(projectRoot, 'backup');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(credential, 'secret');

    for (const command of [
      `cat "${scratch}"/*`,
      `rm "${scratch}"/*`,
      `cp -r "${scratch}" "${destination}"`,
      `mv "${scratch}" "${destination}"`,
      `chmod -R 700 "${scratch}"`,
      `chown -R user "${scratch}"`,
      `Copy-Item -Recurse -Path "${scratch}" -Destination "${destination}"`,
      `Move-Item -Path "${scratch}" -Destination "${destination}"`,
    ]) {
      const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));
      expect(assessment.decision.action, command).toBe('escalate');
      expect(assessment.review.risks, command).toContain('protected_path');
    }
  });

  it('keeps expanded reads and tree mutations prompt-free for clean working descendants', () => {
    const projectRoot = createRoot('kodax-home-clean-selection-');
    userKodax = createTempDirSync('kodax-home-clean-selection-user-', process.cwd());
    setAgentConfigHome(userKodax);
    const scratch = path.join(userKodax, 'scratch');
    const destination = path.join(projectRoot, 'backup');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'out.txt'), 'ordinary');

    for (const command of [
      `cat "${scratch}"/*`,
      `rm "${scratch}"/*`,
      `cp -r "${scratch}" "${destination}"`,
      `mv "${scratch}" "${destination}"`,
      `chmod -R 700 "${scratch}"`,
      `chown -R user "${scratch}"`,
      `Copy-Item -Recurse -Path "${scratch}" -Destination "${destination}"`,
      `Move-Item -Path "${scratch}" -Destination "${destination}"`,
    ]) {
      const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));
      expect(
        assessment.decision.action,
        `${command}: ${JSON.stringify(assessment.review)}`,
      ).toBe('allow');
    }
  });

  it('traverses directories selected by a recursive mutation without broadening non-recursive reads', () => {
    const projectRoot = createRoot('kodax-home-recursive-selector-');
    userKodax = createTempDirSync('kodax-home-recursive-selector-user-', process.cwd());
    setAgentConfigHome(userKodax);
    const scratch = path.join(userKodax, 'scratch');
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, '.env'), 'secret');

    const read = assessAutoModeCall(
      call('bash', { command: `cat "${scratch}"/*` }),
      context(projectRoot),
    );
    expect(read.decision.action).toBe('allow');

    const copy = assessAutoModeCall(call('bash', {
      command: `cp -r "${scratch}"/* "${path.join(projectRoot, 'backup')}"`,
    }), context(projectRoot));
    expect(copy.decision.action).toBe('escalate');
    expect(copy.review.risks).toContain('protected_path');
  });

  it('reviews every PowerShell Path array member while keeping ordinary members prompt-free', () => {
    const projectRoot = createRoot('kodax-home-powershell-array-');
    userKodax = createTempDirSync('kodax-home-powershell-array-user-', process.cwd());
    setAgentConfigHome(userKodax);
    fs.mkdirSync(path.join(userKodax, 'scratch'), { recursive: true });
    fs.mkdirSync(path.join(userKodax, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(userKodax, 'tool-results'), { recursive: true });

    const ordinary = assessAutoModeCall(call('bash', {
      command: `Set-Content -Path "${path.join(userKodax, 'sessions', 'a.json')}","${path.join(userKodax, 'tool-results', 'b.txt')}" -Value x`,
    }), context(projectRoot));
    expect(
      ordinary.decision.action,
      JSON.stringify(ordinary.review),
    ).toBe('allow');
    expect(ordinary.review.analysis.status).toBe('complete');

    for (const command of [
      `Remove-Item -Path "${path.join(userKodax, 'scratch')}","${path.join(userKodax, 'credentials.json')}"`,
      `Remove-Item -Recurse -Path "${path.join(userKodax, 'scratch')}","${path.join(userKodax, 'runtime')}"`,
    ]) {
      const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));
      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review.analysis.status).toBe('complete');
      expect(assessment.review.risks).toContain('protected_path');
    }
  });
});
