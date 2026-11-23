import { describe, expect, it } from 'vitest';

import { resolveKodaXManual } from './resolver.js';
import { MANUAL_PROVIDER_NAMES, MANUAL_REGISTRY, MANUAL_TOPIC_IDS } from './registry.js';

describe('FEATURE_218 manual registry', () => {
  it('keeps current topic guidance consistent with retired verifier and journal contracts', () => {
    const agents = resolveKodaXManual({ topic: 'agents' }).content;
    const sessions = resolveKodaXManual({ topic: 'sessions' }).content;
    const tools = resolveKodaXManual({ topic: 'tools' }).content;
    expect(agents).not.toContain('The existing Sidecar remains the sole');
    expect(agents).toContain('automatic Sidecar Verifier is retired');
    expect(sessions).not.toContain('a verifier checks completion');
    expect(sessions).toContain('main agent verifies');
    expect(tools).not.toContain('Raw Runtime journals retain every attempt');
    expect(tools).toContain('no durable event journal or replay');
  });

  it.each([
    ['token', 'tools', ['estimatedTokenCount', 'Provider usage', 'UTF-16']],
    ['工具原文', 'tools', ["part:'original'", 'not_found', 'tool item ID']],
    ['任务报告', 'sessions', ['taskResult', 'unknown', 'KodaXTaskResultReport']],
    ['sidecar', 'agents', ['automatic Sidecar Verifier is retired']],
    ['allowed-tools', 'skills', ['does not restrict', 'permission mode']],
  ] as const)('answers %s from its relevant current topic', (query, topic, facts) => {
    const result = resolveKodaXManual({ query });
    expect(result.matchedTopic).toBe(topic);
    for (const fact of facts) expect(result.content).toContain(fact);
  });

  it('has a topic for every id and the topic.id matches its key', () => {
    for (const id of MANUAL_TOPIC_IDS) {
      const topic = MANUAL_REGISTRY[id];
      expect(topic, `missing topic ${id}`).toBeDefined();
      expect(topic.id).toBe(id);
    }
    expect(Object.keys(MANUAL_REGISTRY).length).toBe(MANUAL_TOPIC_IDS.length);
  });

  it('has no duplicate aliases across topics', () => {
    const seen = new Map<string, string>();
    for (const id of MANUAL_TOPIC_IDS) {
      for (const alias of MANUAL_REGISTRY[id].aliases) {
        const key = alias.toLowerCase();
        const prior = seen.get(key);
        expect(prior, `alias "${alias}" used by both ${prior} and ${id}`).toBeUndefined();
        seen.set(key, id);
      }
    }
  });

  it('has non-empty title/summary/body for every topic', () => {
    for (const id of MANUAL_TOPIC_IDS) {
      const t = MANUAL_REGISTRY[id];
      expect(t.title.length, id).toBeGreaterThan(0);
      expect(t.summary.length, id).toBeGreaterThan(0);
      expect(t.body.length, id).toBeGreaterThan(0);
    }
  });

  it('only references valid topic ids in nextTopics', () => {
    const valid = new Set<string>(MANUAL_TOPIC_IDS);
    for (const id of MANUAL_TOPIC_IDS) {
      for (const next of MANUAL_REGISTRY[id].nextTopics) {
        expect(valid.has(next), `${id} -> unknown nextTopic ${next}`).toBe(true);
      }
    }
  });

  it('drift guard: providers topic covers every provider in provider-capabilities.json', () => {
    expect(MANUAL_PROVIDER_NAMES.length).toBeGreaterThan(0);
    const content = resolveKodaXManual({ topic: 'providers' }).content;
    for (const name of MANUAL_PROVIDER_NAMES) {
      expect(content, `providers topic missing "${name}"`).toContain(name);
    }
  });

  it('documents the v0.7.77 public and subscription Kimi model contracts', () => {
    const content = resolveKodaXManual({ topic: 'providers' }).content;

    expect(content).toContain('kimi-k2.7-code');
    expect(content).toContain('kimi-k2.7-code-highspeed');
    expect(content).toContain('kimi-k3');
    expect(content).toContain('262,144');
    expect(content).toContain('KIMI_API_KEY');
    expect(content).toContain('KIMI_CODE_API_KEY');
    expect(content).toContain('cannot disable thinking');
    expect(content).toContain('k3-256k');
    expect(content).toContain('`kimi-for-coding` (K2.7 Code)');
    expect(content).toContain('Kimi K3');
    expect(content).toContain('1,048,576');
    expect(content).toContain('thinking.effort');
    expect(content).toContain('defaults to high');
  });

  it('documents the v0.7.88 GLM Coding Plan routes', () => {
    const content = resolveKodaXManual({ topic: 'providers' }).content;

    expect(content).toContain('`zhipu-coding` defaults to `glm-5.3`');
    expect(content).toContain('`zai-coding` and `ark-coding` also default to `glm-5.3`');
    expect(content).toContain('keeps `glm-5.2`');
    expect(content).toContain('`glm-latest` alias');
    expect(content).toContain('sent verbatim');
    expect(content).toContain('never append `[1m]`');
    expect(content).toContain('cannot disable thinking');
    expect(content).toContain('none/minimal/light/low');
  });

  it('documents the output projection, owner abort, and Session-read contracts', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;
    const tools = resolveKodaXManual({ topic: 'tools' }).content;
    const sessions = resolveKodaXManual({ topic: 'sessions' }).content;

    expect(tools).toContain('output-segment projection');
    expect(tools).toContain('responseId');
    expect(tools).toContain('providerRequestId');
    expect(tools).toContain('liveOutputSegments:1');
    expect(sdk).toContain('settleKodaXRuntimeExit');
    expect(sdk).toContain('owner AbortSignals');
    expect(sdk).toContain('userInputTimeoutMs');
    expect(sdk).toContain('reclaimStaleKodaXFileLock');
    expect(sessions).toContain('SessionReadError.code === \'data_changed\'');
    expect(sessions).toContain('authoritative full delta path');
  });

  it('documents the tool policy and worktree trust contracts', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;
    const sandbox = resolveKodaXManual({ topic: 'sandbox' }).content;

    expect(sdk).toContain('conversationHistory:2');
    expect(sdk).toContain('disable-model-invocation');
    expect(sdk).toContain('`allowed-tools` no longer restricts');
    expect(sdk).toContain('PostToolUse');
    expect(sdk).toContain('stdin failures stay on the operation Promise');
    expect(sandbox).toContain('gitSafeDirectory: authorized-repo-roots');
    expect(sandbox).toContain('never emits `safe.directory=*`');
    expect(sandbox).toContain('strict byte bounds');
    expect(sandbox).toContain('sibling remains fenced');
    expect(sandbox).toContain('deprecated lease APIs are inert');
  });

  it('documents the FEATURE_295 trusted-text and native-shell boundary', () => {
    const sandbox = resolveKodaXManual({ topic: 'sandbox' }).content;
    const tools = resolveKodaXManual({ topic: 'tools' }).content;

    expect(sandbox).toContain('transactions and platform shell containment are separate authorities');
    expect(sandbox).toContain('never enter ASRT');
    expect(sandbox).toContain('describe those text writes as OS-token sandbox enforcement');
    expect(sandbox).toContain('self-heals an old sandbox-owned file into host ownership');
    expect(sandbox).toContain('may canonicalize DACL protection/inheritance control at commit');
    expect(sandbox).toContain('per-file kernel lock');
    expect(sandbox).toContain('nonce-bound per-policy private desktop');
    expect(sandbox).toContain('Windows uses native shell protocol 10');
    expect(sandbox).toContain('two authenticated, nonce-bound protocol streams');
    expect(sandbox).toContain('nonce-bound terminal record');
    expect(sandbox).toContain('per-command ASRT Seatbelt/bubblewrap');
    expect(sandbox).toContain('filesystem-effect lease across a command');
    expect(sandbox).toContain('Workspace-local .kodax/runtime state remains readable but is denied to shell writes');
    expect(sandbox).toContain('Print-mode, daemon, and SDK startup never auto-activate');
    expect(sandbox).toContain('Bare interactive Windows CLI startup');
    expect(sandbox).toContain('protected two-phase marker');
    expect(sandbox).toContain('host/SYSTEM-only control');
    expect(sandbox).toContain('re-applies a replaced top-level profile file root');
    expect(sandbox).toContain('reported as `degradedReadRoots` unless a write root of the command');
    expect(sandbox).toContain('Concurrent startup repairs converge through the setup-only lock');
    expect(sandbox).toContain('host control-plane command');
    expect(sandbox).toContain('not through the Bash tool');
    expect(sandbox).toContain('sandboxRuntime:11');
    expect(sandbox).toContain('descriptor-verified addon loading');
    expect(tools).toContain('per-file kernel locking');
    expect(tools).toContain('Shell writes do not join that lock');
  });

  it('documents the v0.7.97-beta.5 Skill, visual, extension policy and Host log behavior', () => {
    const skills = resolveKodaXManual({ topic: 'skills' }).content;
    const tools = resolveKodaXManual({ topic: 'tools' }).content;
    const extensions = resolveKodaXManual({ topic: 'extensions' }).content;
    const troubleshooting = resolveKodaXManual({ topic: 'troubleshooting' }).content;

    expect(skills).toContain('User Skills load from `<agent home>/skills` (`KODAX_HOME`, default `~/.kodax`)');
    expect(skills).toContain('`${CLAUDE_SKILL_DIR}` expand to the Skill root with forward slashes.');
    expect(skills).toContain('removed Skills apply on the next request without /reload');
    expect(tools).toContain('`read` pins each accepted image as a durable observation and returns its `observationId`.');
    expect(tools).toContain('`visual_read_pixels` returns exact grid-center RGBA samples as text.');
    expect(tools).toContain('`web_fetch` refuses cloud metadata addresses on every hop');
    expect(extensions).toContain('`tool:before` runs on every dispatch path, after saved-grant matching.');
    expect(extensions).toContain('may return `{ decision: \'ask\', reason }` so a person approves that one call');
    expect(extensions).toContain('The model cannot write `<agent home>/extensions` or `<agent home>/integrations`.');
    expect(troubleshooting).toContain('`NODE_USE_ENV_PROXY=1`');
    expect(troubleshooting).toContain('`NODE_EXTRA_CA_CERTS` (private root CA)');
    expect(troubleshooting).toContain('(`daemon.log.1`, rotated at 2 MiB)');
  });

  it('documents the one-Host-per-KODAX_HOME contract', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;
    const config = resolveKodaXManual({ topic: 'config' }).content;
    const troubleshooting = resolveKodaXManual({ topic: 'troubleshooting' }).content;

    expect(sdk).toContain('RuntimeHostMigrationRequiredError');
    expect(sdk).toContain('The Host-location `profile` option is removed');
    expect(sdk).toContain('`runtime_host_migration_required`');
    expect(sdk).toContain('`identity.profile` stays on the wire');
    expect(sdk).toContain('replace only an idle older one');
    expect(sdk).toContain('attaches to it with provider credentials');
    expect(sdk).toContain('The shared local daemon is authoritative for one KODAX_HOME (one Host per data root).');
    expect(config).toContain('~/.kodax/runtime/daemon/default/bootstrap.log');
    expect(troubleshooting).toContain('`runtime_host_migration_required`: `profile`/`--profile` no longer names a Host');
    expect(troubleshooting).toContain('isolate Hosts with a separate `--home`/KODAX_HOME.');
    expect(troubleshooting).toContain('~/.kodax/runtime/daemon/default/bootstrap.log');
  });

  it('documents the Repo Intelligence default surface and storage relocation', () => {
    const repoIntelligence = resolveKodaXManual({ topic: 'repo-intelligence' }).content;

    expect(repoIntelligence).toContain('repoIntelligenceMode');
    expect(repoIntelligence).toContain('KODAX_REPO_INTELLIGENCE_STORAGE_DIR');
    expect(repoIntelligence).toContain('.agent/repo-intelligence/');
  });

  it('documents the corrected CLI, provider, and SDK facts of the current manual', () => {
    const overview = resolveKodaXManual({ topic: 'overview' }).content;
    const commands = resolveKodaXManual({ topic: 'commands' }).content;
    const doctor = resolveKodaXManual({ topic: 'doctor' }).content;
    const install = resolveKodaXManual({ topic: 'install' }).content;
    const a2a = resolveKodaXManual({ topic: 'a2a' }).content;
    const customProviders = resolveKodaXManual({ topic: 'custom-providers' }).content;
    const providers = resolveKodaXManual({ topic: 'providers' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(overview).toContain('the `codex-cli` provider bridge reads ~/.codex/config.toml');
    expect(providers).toContain('`anthropic` defaults to `claude-sonnet-5-5`');
    expect(providers).toContain('falls back to `gpt-6.2-sol` when ~/.codex/config.toml sets no model');
    expect(customProviders).toContain('bedrock');
    expect(customProviders).toContain('pi-messages');
    expect(customProviders).toContain("api: 'responses'");
    expect(customProviders).toContain('OAuth');
    expect(commands).toContain('saves the current conversation');
    expect(commands).toContain('so /resume <id> returns to it');
    expect(commands).toContain('fixed after the Session');
    expect(commands).toContain('acp serve');
    expect(commands).toContain('--native-text');
    expect(doctor).toContain('--repair-storage');
    expect(doctor).toContain('--verify-storage');
    expect(doctor).toContain('--writers-stopped');
    expect(install).toContain('Windows has no arm64 build');
    expect(a2a).toContain('--confirm-daemons-stopped');
    expect(a2a).toContain('--confirm-server-stopped');
    expect(sdk).toContain('UUIDv7');
    expect(sdk).toContain('X-Session-Id');
    expect(sdk).toContain('machine-local approval recorded at activation');
    expect(sdk).toContain('copyKodaXDataRoot');
    expect(sdk).toContain('target_incomplete');
    expect(sdk).toContain('inputs.withdraw');
  });

  it('documents the v0.7.94 Runtime settlement and reconnect contracts', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;
    const troubleshooting = resolveKodaXManual({ topic: 'troubleshooting' }).content;

    expect(sdk).toContain('run_settlement_not_persisted');
    expect(sdk).toContain('RuntimeDaemonDisconnectCode');
    expect(sdk).toContain('failureKind');
    expect(sdk).toContain('runs.get(runId)');
    expect(sdk).toContain('runs.await(runId)');
    expect(sdk).toMatch(/never call\s+`runs\.start\(\)` again/i);
    expect(troubleshooting).toContain('connectionId');
    expect(troubleshooting).toContain('reconnectable');
    expect(troubleshooting).toContain('invalid_frame');
  });

  it('documents the v0.7.79 provider, A2A, Session, and Runtime contracts', () => {
    const providers = resolveKodaXManual({ topic: 'providers' }).content;
    const customProviders = resolveKodaXManual({ topic: 'custom-providers' }).content;
    const a2a = resolveKodaXManual({ topic: 'a2a' }).content;
    const sessions = resolveKodaXManual({ topic: 'sessions' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;
    const sandbox = resolveKodaXManual({ topic: 'sandbox' }).content;

    expect(providers).toContain('deepseek-flash');
    expect(providers).toContain('deepseek-v4-pro');
    expect(providers).toContain('text-only');
    expect(customProviders).toContain('maxOutputTokensField');
    expect(customProviders).toContain('max_completion_tokens');
    expect(customProviders).toContain('per-model');

    expect(a2a).toContain('--allow-private');
    expect(a2a).toContain('--allow-insecure-http');
    expect(a2a).toContain('default deny');
    expect(a2a).toContain('exact loopback HTTP');

    expect(sessions).toContain('readSessionCapture()');
    expect(sessions).toContain('readFullTranscript()');
    expect(sessions).toContain('readConversationHistory()');
    expect(sessions).toContain('exportSessionBundle()');
    expect(sessions).toContain('read-only');

    expect(sdk).toContain('runtimeEventCoalescing:1');
    expect(sdk).toContain('sessions.status()');
    expect(sdk).toContain('sessions.conversation()');
    expect(sdk).toContain('conversationHistory:2');
    expect(sdk).toContain('captureRuntimeSessionDiagnostics()');
    expect(sdk).toContain('sessions.diagnostics()');
    expect(sdk).toContain('Job Object');
    expect(sdk).toContain('Issue 256');

    expect(sandbox).toContain('inherit the host environment');
    expect(sandbox).toContain('obsolete');
    expect(sandbox).toContain('Exec Policy');
    expect(sandbox).toContain('case-insensitive PATH/Path');
    expect(sandbox).toContain('verbatim-argument contract');
    expect(sandbox).toContain('without a machine-global admission mutex');
    expect(sandbox).toContain('profile-specific host boundary');
    expect(sandbox).toContain('protected two-phase marker');
    expect(sandbox).toContain('No helper overlaps ordinary admission');
  });

  it('documents the v0.7.77 adaptive AMA and governed memory intervention contracts', () => {
    const agents = resolveKodaXManual({ topic: 'agents' }).content;
    const memory = resolveKodaXManual({ topic: 'memory' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(agents).toContain('parallel-first');
    expect(agents).toContain('fan them out');
    expect(agents).toContain('not a Worker dispatch gate');
    expect(agents).toContain('quality_strategy');
    expect(agents).toContain('PatternTrace');
    expect(agents).toContain('automatic Sidecar Verifier is retired');
    expect(agents).toContain('500 tool-loop');
    expect(agents).toContain('RunnerIterationLimitError');
    expect(agents).toContain('readRunnerRecoveryTranscript');
    expect(memory).toContain('MemorySession.intervene()');
    expect(memory).toContain('tool_failure');
    expect(memory).toContain('verification_failure');
    expect(memory).toContain('context_compacted');
    expect(memory).toContain('memoryRecallRunner');
    expect(memory).toContain('fails silent');
    expect(sdk).toContain('memoryRecallRunner');
    expect(sdk).toContain('iteration limit');
    expect(sdk).toMatch(/input\s+window/);
  });

  it('documents the v0.7.81 canonical interrupt-entry contract', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(sdk).toContain('entryId');
    expect(sdk).toContain('canonical session-entry reference');
    expect(sdk).toContain('legacy');
    expect(sdk).toMatch(/fails\s+the\s+current\s+delivery\s+closed/);
  });

  it('documents the v0.7.82 discovery and runtime-causality contract', () => {
    const mcp = resolveKodaXManual({ topic: 'mcp' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(mcp).toContain('lease-scoped live, complete snapshot');
    expect(mcp).toContain('unfiltered');
    expect(mcp).toContain('incomplete/unknown');
    expect(sdk).toContain('authoritative Run');
    expect(sdk).toContain('data_changed');
    expect(sdk).toContain('cooperative');
  });

  it('documents the current Windows and Actor settlement contracts', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(sdk).toContain('waitForRuntimeDaemonShutdown()');
    expect(sdk).toContain('daemonShutdownVerification:1');
    expect(sdk).toContain('kill-on-close');
    expect(sdk).toContain('cannot be migrated safely in place');
    expect(sdk).toContain('Issue 256');
    expect(sdk).toContain('Since v0.7.84');
    expect(sdk).toContain('one latest replacement');
    expect(sdk).toContain('same-owner Stop');
  });

  it('documents the v0.7.97 live-event, startup, Worker, and Memory boundaries', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;
    const memory = resolveKodaXManual({ topic: 'memory' }).content;

    expect(sdk).toContain('live in-process stream');
    expect(sdk).toContain('no durable journal, replay, or cursor epoch');
    expect(sdk).toContain('from its status record alone');
    expect(memory).toContain('conversation-first');
    expect(sdk).toContain('F289/F290');
    expect(sdk).toContain('MemoryManagementAgent');
  });

  it('documents the v0.7.86 ownership and sandbox lifecycle boundaries', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(sdk).toContain('Since v0.7.86');
    expect(sdk).toContain('process-start identity');
    expect(sdk).toContain('per-command process-tree and Job-drain proof');
    expect(sdk).toContain('prevents replay of that command');
    expect(sdk).toContain('Post-proof private Temp leaf housekeeping is diagnostic only');
    expect(sdk).toContain('initialize fresh KODAX_HOME policy roots');
    expect(sdk).toContain('lease-cleanup failure');
    expect(sdk).toContain('remains open after v0.7.87');
  });

  it('documents the v0.7.78 evidence-gated background Skill learning boundary', () => {
    const content = resolveKodaXManual({ topic: 'skills' }).content;

    expect(content).toContain('Memory first');
    expect(content).toContain('project-scoped');
    expect(content).toContain('three exact-revision invocations');
    expect(content).toContain('all three outcomes settle');
    expect(content).toContain('independently verified success');
    expect(content).toContain('credible negative quarantines immediately');
    expect(content).toContain('/learn');
    expect(content).toMatch(/protected\/formal/i);
    expect(content).toContain('global promotion');
    expect(content).toContain('Extension');
    expect(content).toContain('/learn promote');
    expect(content).toContain('--scope user');
    expect(content).toContain('ready or active_learned');
    expect(content).toContain('atomically');
    expect(content).toContain('without overwriting');
  });

  it('documents explicit user invocation separately from model Skill discovery', () => {
    const content = resolveKodaXManual({ topic: 'skills' }).content;
    const commands = resolveKodaXManual({ topic: 'commands' }).content;

    expect(content).toContain('disable-model-invocation: true');
    expect(content).toContain('/<name>');
    expect(content).toContain('/skill:<name>');
    expect(content).toContain('head or middle');
    expect(content).toContain('SkillRegistry.invoke()');
    expect(content).toContain('user-invocable');
    expect(content).toContain('structured `skillInvocation`');
    expect(content).toContain('model-authored child objective');
    expect(content).toContain('`allowed-tools` does not restrict');
    expect(content).not.toContain('Bash(pattern) rule');
    expect(content).toContain('PostToolUse');
    expect(commands).toContain('/<name>');
    expect(commands).toContain('/skill:<name>');
    expect(commands).toContain('disable-model-invocation');
    expect(MANUAL_REGISTRY.commands.nextTopics).toContain('skills');
  });

  it('documents the v0.7.73 setup, Qwen Token Plan, and Runtime permission contracts', () => {
    const install = resolveKodaXManual({ topic: 'install' }).content;
    const providers = resolveKodaXManual({ topic: 'providers' }).content;
    const permissions = resolveKodaXManual({ topic: 'permissions' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(install).toContain('kodax setup');
    expect(install).toContain('never asks for or stores an API key');
    expect(install).toContain('restart terminal');
    expect(install).toContain('kodax setup --custom');
    expect(install).toContain('/setup --help');
    expect(providers).toContain('qwen-token-plan');
    expect(providers).toContain('QWEN_TOKEN_API_KEY');
    expect(providers).toContain('defaults to `qwen3.8-max`');
    expect(providers).toContain('qwen3.8-flash');
    expect(permissions).toContain('Runtime-owned');
    expect(permissions).toContain('allow once');
    expect(permissions).toContain('session-scoped');
    expect(permissions).toContain('persistent');
    expect(permissions).toContain('static Skill');
    expect(permissions).toContain('Edit and Plan');
    expect(permissions).toContain('dynamic-context commands');
    expect(permissions).toContain('explicit host-controlled executor');
    expect(sdk).toContain('grantSuggestions');
    expect(sdk).toContain('RuntimePermissionMatcher');
    expect(sdk).toContain('runtimeAutoModeGuardrail` v5');
    expect(sdk).toContain('settings v2');
    expect(sdk).toContain('requires v5/v2');
    expect(sdk).toContain('never restores a rules engine');
  });

  it('documents the v0.7.73 regression closure for legacy grants and effort commands', () => {
    const commands = resolveKodaXManual({ topic: 'commands' }).content;
    const permissions = resolveKodaXManual({ topic: 'permissions' }).content;

    expect(commands).toContain('`/effort` is the same control');
    expect(commands).toContain('`/thinking`, `/think`, `/reason` and `/t` are aliases');
    expect(commands).toContain('`none` also means `off`');
    expect(commands).toContain('quick/balanced/deep');
    expect(commands).not.toContain('/auto-denials');
    expect(permissions).toContain('Legacy grants without a Runtime-issued matcher');
    expect(permissions).toContain('remain visible and revocable');
    expect(permissions).toMatch(/never\s+authorize a concrete call/);
  });

  it('names the Host, sessions and help commands of the CLI', () => {
    const commands = resolveKodaXManual({ topic: 'commands' }).content;

    expect(commands).toContain('`kodax host start|stop|restart|status|logs`');
    expect(commands).toContain('`kodax sessions list|delete|delete-all`');
    expect(commands).toContain('`kodax -h <command>`');
    expect(commands).not.toContain('`kodax daemon');
    expect(resolveKodaXManual({ topic: 'host' }).matchedTopic).toBe('commands');
    expect(resolveKodaXManual({ topic: 'daemon' }).matchedTopic).toBe('commands');
    expect(resolveKodaXManual({ topic: 'sessions' }).content).toContain('`kodax sessions delete <id>`');
  });

  it('keeps setup commands and the default mode shortcuts in the commands topic', () => {
    const commands = resolveKodaXManual({ topic: 'commands' }).content;

    expect(commands).toContain('/setup --custom');
    expect(commands).toContain('/setup --help');
    expect(commands).toContain('Ctrl+T');
    expect(commands).toContain('Shift+Tab');
    expect(commands).not.toContain('Alt+M');
    expect(commands).toMatch(/Ctrl\+T.*reasoning/i);
    expect(commands).toMatch(/Shift\+Tab.*permission/i);
    expect(commands).toContain('New product tasks use AMA');
  });

  it('documents the governed runtime and SDK memory surfaces', () => {
    const content = resolveKodaXManual({ topic: 'memory' }).content;

    expect(content).toContain('Memory is on by default and kept as notes');
    expect(content).toContain('/memory candidates');
    expect(content).toContain('KODAX_MEMORY_NOTES=0');
    expect(content).toContain('/memory');
    expect(content).toContain('memory_recall');
    expect(content).toContain('memory_intent');
    expect(content).toContain('exact quote');
    expect(content).toContain('apply immediately');
    expect(content).toContain('do not create a duplicate episode review');
    expect(content).toContain('conversation-first');
    expect(content).toContain('exceptional inferred changes remain reviewable');
    expect(content).toContain('MEMORY.md is a derived projection');
    expect(content).toContain('external application');
    expect(content).toContain('query()');
    expect(content).toContain('low-authority');
    expect(content).toContain('proposal/preview/fingerprint/apply');
  });

  it('documents the v0.7.74 always-on compaction contract', () => {
    const content = resolveKodaXManual({ topic: 'compaction' }).content;

    expect(content).toContain('always enabled');
    expect(content).toContain('defaults to 75');
    expect(content).toContain('15..90');
    expect(content).toContain('triggerTokens');
    expect(content).toContain('smaller');
    expect(content).toContain('20%');
    expect(content).toContain('complete eligible prefix');
    expect(content).toContain('user-query ledger');
    expect(content).toContain('post-commit');
    expect(content).toContain('persists their exact lineage');
    expect(content).toContain('sidecar is flushed');
    expect(content).toContain('commit callback is awaited');
    expect(content).toContain('Runtime becomes the persistence owner');
    expect(content).toContain('session_history_search');
    expect(content).toContain('session_history_read');
    expect(content).toContain('transcriptSearch()');
    expect(content).toContain('hidden reasoning');
    expect(content).toContain('cannot reconstruct bytes');
  });

  it('documents the v0.7.74 mailbox-driven Agent coordination contract', () => {
    const agents = resolveKodaXManual({ topic: 'agents' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(agents).toContain('Runtime-owned Actor/Turn tree');
    expect(agents).toContain('model-facing mailbox yield');
    expect(agents).toContain('10,000..3,600,000');
    expect(agents).toContain('user_input_pending');
    expect(agents).toContain('Actor progress and system reminders do not wake the model');
    expect(agents).toContain('Do not poll `agent_output`');
    expect(agents).toContain('synthetic evidence');
    expect(agents).toContain('pending-delivery');
    expect(agents).toContain('Managed Workflow `runAgent`');
    expect(agents).toContain('omitted workflow timeout');
    expect(agents).toContain('polling window');
    expect(agents).toContain('explicit workflow deadline');
    expect(sdk).toContain('runtime.agents.events()');
    expect(sdk).toContain('runtime.agents.wait(sessionId, afterSequence, timeoutMs)');
    expect(sdk).toContain('interruptInput:1');
    expect(sdk).toContain('runtime.runs.submitInput()');
  });

  it('documents the four canonical permission profiles without legacy engine controls', () => {
    const sessions = resolveKodaXManual({ topic: 'sessions' }).content;
    const permissions = resolveKodaXManual({ topic: 'permissions' }).content;

    expect(sessions).toContain('non-empty');
    expect(sessions).toContain('zero-message');
    expect(sessions).toContain('classic and Ink');
    expect(sessions).toContain('saved workspace');
    expect(sessions).toContain('`presentationOnly`');
    expect(sessions).toContain('do not re-append');
    expect(sessions).toContain('next submit or graceful exit');
    expect(permissions).toContain('Shift-Tab');
    expect(permissions).toContain('Shift+Enter');
    expect(permissions).toContain('Auto[LLM]');
    expect(permissions).toContain('Full Access');
    expect(permissions).toContain('- full-access:');
    expect(permissions.toLowerCase()).toContain('sandbox completion');
    expect(permissions).toContain('Exec Policy');
    expect(permissions).toContain('90-second');
    expect(permissions).toContain('180-second');
    expect(permissions).not.toContain('Auto[RULES]');
    expect(permissions).not.toContain('LLM/rules');
    expect(permissions).not.toContain('per action before');
    expect(permissions).not.toContain('/auto-engine');
  });

  it('keeps the SDK topic aligned with current published subpaths', () => {
    const content = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(content).toContain('17 SDK subpaths');
    expect(content).toContain('no separate @kodax-ai/artifacts npm publication exists.');
    expect(content).toContain('@kodax-ai/kodax/runtime');
    expect(content).toContain('@kodax-ai/kodax/sandbox');
    expect(content).toContain('@kodax-ai/kodax/experimental-memory');
    expect(content).toContain('@kodax-ai/kodax/a2a');
    expect(content).toContain('server.whenReady()');
    expect(content).toContain('sessions.observe()');
    expect(content).toContain('run-bound Host Tools');
    expect(content).toContain('runtime.learning');
    expect(content).toContain('skillLearningLoop');
    expect(content).toContain('loopback identity challenge');
    expect(content).toMatch(/reuses\s+the PID/);
  });

  it('documents the v0.7.90 web search, run-scoped, lineage, and sandbox contracts', () => {
    const tools = resolveKodaXManual({ topic: 'tools' }).content;
    const mcp = resolveKodaXManual({ topic: 'mcp' }).content;
    const sessions = resolveKodaXManual({ topic: 'sessions' }).content;
    const sandbox = resolveKodaXManual({ topic: 'sandbox' }).content;

    expect(tools).toContain('DuckDuckGo HTML');
    expect(tools).toContain('Bing RSS');
    expect(tools).toContain('KODAX_WEB_SEARCH_ENDPOINT');
    expect(tools).toContain('freshness: unknown');
    expect(tools).toContain('leased run');
    expect(tools).toContain('never enter the global tool registry');
    expect(tools).toContain("{ type: 'object', properties, required? }");
    expect(mcp).toContain('Daemon-owned Host Tools publish a lease-scoped live');
    expect(sessions).toContain('direct physical predecessor copy');
    expect(sandbox).toContain('retires the shared session through orderly close');
    expect(sandbox).toContain('AggregateError members');
  });

  it('documents the v0.7.96 broad-read workspace containment boundary', () => {
    const content = resolveKodaXManual({ topic: 'sandbox' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(content).toContain('broad host reads');
    expect(content).toContain('Agent Home');
    expect(content).toContain('global Git configuration');
    expect(content).toContain('workspace/system temp');
    expect(sdk).toContain('`autoModeClassifierModel`');
    expect(sdk).toContain('`config.json#autoReview.policy`');
    expect(sdk).toContain('`autoReview.administratorPolicy`');
    expect(sdk).toContain('`autoReview.modelGuidance`');
    expect(sdk).toContain('`ACP_PERMISSION_MODE_IDS`');
    expect(sdk).toContain('`AcpPermissionModeInput`');
    expect(sdk).toContain('`AcpRuntimePermissionMode`');
    expect(MANUAL_REGISTRY.a2a.sources).toContainEqual({
      label: 'A2A SDK guide',
      path: 'public_docs/sdk/embedder-guide.md',
    });
    expect(MANUAL_REGISTRY.compaction.sources).toContainEqual({
      label: 'SDK guide',
      path: 'public_docs/sdk/embedder-guide.md',
    });
  });

  it('documents the split integration configuration instead of legacy core fields', () => {
    const config = resolveKodaXManual({ topic: 'config' }).content;
    const mcp = resolveKodaXManual({ topic: 'mcp' }).content;
    const extensions = resolveKodaXManual({ topic: 'extensions' }).content;

    expect(config).toContain('~/.kodax/integrations/mcp.json');
    expect(config).toContain('~/.kodax/integrations/a2a.json');
    expect(config).toContain('~/.kodax/integrations/extensions.json');
    expect(config).toContain('~/.kodax/config.example.jsonc');
    expect(config).toContain('strict JSON');
    expect(config).toContain('template first line');
    expect(config).toContain('kodax config paths');
    expect(config).toContain('kodax integrations migrate --apply');
    expect(config).toContain('MCP and Extensions');
    expect(config).toContain('does not overwrite an existing destination');
    expect(config).toContain('first MCP/Extension mutation');
    expect(config).toContain('literal-secret warnings');
    expect(config).toContain('"version": 2');
    expect(config).toContain('safe empty document');
    expect(config).toContain('does not delete or rewrite');
    expect(config).toContain('bootstrap.log');
    expect(mcp).toContain('~/.kodax/integrations/mcp.json');
    expect(extensions).toContain('~/.kodax/integrations/extensions.json');
    expect(extensions).toContain('config.json#extensions');
  });

  it('documents the v0.7.71 A2A authentication, activation, and interoperability boundaries', () => {
    const a2a = resolveKodaXManual({ topic: 'a2a' });
    const mcp = resolveKodaXManual({ topic: 'mcp' }).content;

    expect(a2a.matchedTopic).toBe('a2a');
    expect(a2a.content).toContain('~/.kodax/integrations/a2a.json');
    expect(a2a.content).toContain('version 2');
    expect(a2a.content).toContain('a2a add|list|test|call|enable|disable|remove');
    expect(a2a.content).toContain('a2a migrate');
    expect(a2a.content).toContain('a2a expose');
    expect(a2a.content).toContain('a2a serve');
    expect(a2a.content).toContain('same trusted origin');
    expect(a2a.content).toContain('OAuth 2.0 Client Credentials');
    expect(a2a.content).toContain('OAuth Resource Server');
    expect(a2a.content).toContain('external Authorization Server');
    expect(a2a.content).toContain('securityRealm');
    expect(a2a.content).toContain('a2a migrate-tasks');
    expect(a2a.content).toContain('--confirm-server-stopped');
    expect(a2a.content).toContain('migrateA2ALegacyTaskOwners()');
    expect(a2a.content).toContain('does not cancel');
    expect(a2a.content).toContain('original Runtime run');
    expect(a2a.content).toContain('stable opaque cursor');
    expect(a2a.content).toContain('explicitly admitted artifacts');
    expect(mcp).toContain('exact capability ids');
    expect(mcp).toContain('physical result capacity');
    expect(mcp).toContain('zero lexical match');
    expect(mcp).toContain('partial provider failure');
  });

  it('documents the v0.7.71 packaged Electron daemon boundary', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' });

    expect(sdk.matchedTopic).toBe('sdk');
    expect(sdk.content).toContain('Packaged/asar Electron');
    expect(sdk.content).toContain('ELECTRON_RUN_AS_NODE');
    expect(sdk.content).toContain('RunAsNode fuse');
    expect(sdk.content).toContain('attach-only');
    expect(sdk.content).toContain('homeDir');
    expect(sdk.content).toContain('closeTimeoutMs');
    expect(sdk.content).toContain('30-second');
  });

  it('documents the KAI-FCL boundary from v0.7.70 without rewriting history', () => {
    const result = resolveKodaXManual({ topic: 'license' });

    expect(result.matchedTopic).toBe('license');
    expect(result.content).toContain('KAI-FCL');
    expect(result.content).toContain('0.7.70 and later');
    expect(result.content).toContain('not OSI open source');
    expect(result.content).toContain('Commercial or Managed Use');
    expect(result.content).toContain('Apache-2.0');
  });
});
