/**
 * Tests for Argument Completer - 参数补全器测试
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAgentConfigPath, setAgentConfigHome, type WorkflowAgentBackend, type WorkflowModule } from '@kodax-ai/agent';
import { getDefaultWorkflowRunManager, registerCustomProviders } from '@kodax-ai/coding';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArgumentCompleter } from '../completers/argument-completer.js';
import { deriveProjectKeyFromRoot } from '../project-key.js';

describe('ArgumentCompleter', () => {
  let completer: ArgumentCompleter;

  beforeEach(() => {
    completer = new ArgumentCompleter();
  });

  afterEach(() => {
    registerCustomProviders([]);
    setAgentConfigHome(undefined);
  });

  describe('canComplete', () => {
    it('should trigger on /mode command with space', () => {
      expect(completer.canComplete('/mode ', 6)).toBe(true);
      expect(completer.canComplete('/mode a', 7)).toBe(true);
    });

    it('should trigger on /thinking command with space', () => {
      expect(completer.canComplete('/thinking ', 10)).toBe(true);
    });

    it('should trigger on /reasoning and /reason commands with space', () => {
      expect(completer.canComplete('/reasoning ', 11)).toBe(true);
      expect(completer.canComplete('/reason ', 8)).toBe(true);
    });

    it('should trigger on exact commands that support enum-style arguments', () => {
      expect(completer.canComplete('/mode', 5)).toBe(true);
      expect(completer.canComplete('/reasoning', 10)).toBe(true);
    });

    it('should trigger on any command with space (filtering happens in getCompletions)', () => {
      // canComplete only checks format, not whether the command is known
      expect(completer.canComplete('/unknown ', 9)).toBe(true);
    });

    it('should trigger on /model command', () => {
      expect(completer.canComplete('/model ', 7)).toBe(true);
    });

    it('should trigger on /delete command', () => {
      expect(completer.canComplete('/delete ', 8)).toBe(true);
    });

    it('should trigger on /status command', () => {
      expect(completer.canComplete('/status ', 8)).toBe(true);
      expect(completer.canComplete('/ctx ', 5)).toBe(true);
    });

    it('should trigger on /repo-intel command and legacy alias', () => {
      expect(completer.canComplete('/repo-intel ', 12)).toBe(true);
      expect(completer.canComplete('/repo-intel mode ', 17)).toBe(true);
      expect(completer.canComplete('/repointel ', 11)).toBe(true);
      expect(completer.canComplete('/ri ', 4)).toBe(true);
    });

    it('should trigger on aliased commands', () => {
      expect(completer.canComplete('/t ', 3)).toBe(true); // thinking alias
    });

    it('should trigger after a newline boundary', () => {
      expect(completer.canComplete('hello\n/mode ', 12)).toBe(true);
    });
  });

  describe('getCompletions', () => {
    describe('/mode command', () => {
      it('should return all mode arguments', async () => {
        const completions = await completer.getCompletions('/mode ', 6);

        expect(completions.length).toBeGreaterThan(0);
        // Check for known mode arguments (default mode removed)
        expect(completions.some(c => c.display === 'plan')).toBe(true);
        expect(completions.some(c => c.display === 'accept-edits')).toBe(true);
        expect(completions.some(c => c.display === 'auto')).toBe(true);
        expect(completions.some(c => c.display === 'full-access')).toBe(true);
        expect(completions.some(c => c.display === 'auto-in-project')).toBe(false);
      });

      it('should filter by substring (case-insensitive)', async () => {
        const completions = await completer.getCompletions('/mode a', 7);

        expect(completions.length).toBeGreaterThan(0);
        // Implementation uses includes(), not startsWith()
        expect(completions.every(c => c.display.toLowerCase().includes('a'))).toBe(true);
      });

      it('should exclude already used arguments', async () => {
        // Get all completions first
        const allCompletions = await completer.getCompletions('/mode ', 6);
        const firstArg = allCompletions[0]?.display;

        if (firstArg) {
          // Check that used argument is excluded
          const filteredCompletions = await completer.getCompletions(`/mode ${firstArg} `, 6 + firstArg.length + 1);

          // The same argument should not appear again
          expect(filteredCompletions.every(c => c.display !== firstArg)).toBe(true);
        }
      });

      it('should sort prefix matches first', async () => {
        const completions = await completer.getCompletions('/mode ac', 8);

        // accept-edits starts with 'ac'
        expect(completions.length).toBeGreaterThan(0);
        // First result should be a prefix match if any exist
        const hasPrefixMatch = completions.some(c => c.display.startsWith('ac'));
        if (hasPrefixMatch) {
          expect(completions[0]?.display.startsWith('ac')).toBe(true);
        }
      });
    });

    describe('/thinking command', () => {
      it('should return thinking arguments', async () => {
        const completions = await completer.getCompletions('/thinking ', 10);

        expect(completions.map(c => c.display)).toEqual([
          'none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max',
        ]);
      });
    });

    describe('/learn command', () => {
      it('advertises promotion and its dedicated help path', async () => {
        const subcommands = await completer.getCompletions('/learn ', 7);
        const helpTopics = await completer.getCompletions('/learn help ', 12);

        expect(subcommands.map((completion) => completion.display)).toContain('promote');
        expect(subcommands.map((completion) => completion.display)).toContain('ready');
        expect(subcommands.find((completion) => completion.display === 'pending')?.description)
          .toContain('alias for ready');
        expect(helpTopics.map((completion) => completion.display)).toEqual(['promote']);
      });

      it('completes the only supported promotion scope', async () => {
        const options = await completer.getCompletions(
          '/learn promote release-check ',
          29,
        );
        const scopes = await completer.getCompletions(
          '/learn promote release-check --scope ',
          37,
        );

        expect(options.map((completion) => completion.display)).toContain('--scope');
        expect(scopes.map((completion) => completion.display)).toEqual(['user']);
      });
    });

    describe('/reasoning command', () => {
      it('should return reasoning arguments for /reasoning with a space', async () => {
        const completions = await completer.getCompletions('/reasoning ', 11);

        expect(completions.map(c => c.display)).toEqual([
          'none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max',
        ]);
      });

      it('should return reasoning arguments for /reasoning without a trailing space', async () => {
        const completions = await completer.getCompletions('/reasoning', 10);

        expect(completions.some(c => c.display === 'auto')).toBe(true);
        expect(completions.some(c => c.display === 'medium')).toBe(true);
      });

      it('should return reasoning arguments for /reason alias', async () => {
        const completions = await completer.getCompletions('/reason', 7);

        expect(completions.some(c => c.display === 'auto')).toBe(true);
        expect(completions.some(c => c.display === 'high')).toBe(true);
      });
    });

    describe('/model command', () => {
      it('should return model arguments from providers', async () => {
        const completions = await completer.getCompletions('/model ', 7);

        expect(completions.length).toBeGreaterThan(0);
        // All completions should be provider names
        expect(completions.every(c => c.type === 'argument')).toBe(true);
      });

      it('should return provider names (not provider/model) for bare /model input', async () => {
        const completions = await completer.getCompletions('/model ', 7);

        // Provider name completions should not contain "/"
        expect(completions.every(c => !c.display.includes('/'))).toBe(true);
      });

      it('should activate canComplete for provider/model format input', () => {
        // findCommandSlashIndex correctly identifies the command prefix /
        // even when the argument contains / (e.g., provider/model)
        expect(completer.canComplete('/model anthropic/cl', 20)).toBe(true);
        expect(completer.canComplete('/model anthropic/', 19)).toBe(true);
        expect(completer.canComplete('/model zhipu-coding/glm-5', 26)).toBe(true);
      });

      it('should return models for a known provider with / separator', async () => {
        const completions = await completer.getCompletions('/model anthropic/', 18);

        expect(completions.length).toBeGreaterThan(0);
        // Two-stage: results should be in provider/model format
        expect(completions.every(c => c.display.startsWith('anthropic/'))).toBe(true);
        // Should include all known anthropic models
        const modelNames = completions.map(c => c.display.replace('anthropic/', ''));
        expect(modelNames).toContain('claude-sonnet-4-6');
        expect(modelNames).toContain('claude-opus-4-6');
        expect(modelNames).toContain('claude-haiku-4-5');
      });

      it('should return models for a mixed-case custom provider alias', async () => {
        registerCustomProviders([{
          name: 'Token_Hub',
          protocol: 'openai',
          baseUrl: 'https://example.invalid/v1',
          apiKeyEnv: 'TOKEN_HUB_API_KEY',
          model: 'glm-5.2',
          models: ['glm-5.2', 'glm-5.2-flash'],
        }]);

        const input = '/model Token_Hub/';
        const completions = await completer.getCompletions(input, input.length);

        expect(completions.map(c => c.display)).toEqual([
          'Token_Hub/glm-5.2',
          'Token_Hub/glm-5.2-flash',
        ]);
      });

      it('should include the current MiniMax model lineup for minimax-coding', async () => {
        const completions = await completer.getCompletions('/model minimax-coding/', 23);

        expect(completions.length).toBeGreaterThan(0);
        expect(completions.every(c => c.display.startsWith('minimax-coding/'))).toBe(true);

        const modelNames = completions.map(c => c.display.replace('minimax-coding/', ''));
        expect(modelNames).toContain('MiniMax-M2.7');
        expect(modelNames).toContain('MiniMax-M2.7-highspeed');
        // 2026-06: M2.5 family retired upstream; M3 Frontier Coding
        // promoted into the completer surface in its place.
        expect(modelNames).toContain('MiniMax-M3');
      });

      it('should list each provider default model once in two-stage completion', async () => {
        const affectedRoutes = [
          ['kimi-code', 'k3-256k'],
          ['zhipu-coding', 'glm-5.3'],
          ['zai-coding', 'glm-5.2'],
          ['ark-coding', 'glm-5.2'],
        ] as const;

        for (const [provider, model] of affectedRoutes) {
          const input = `/model ${provider}/`;
          const completions = await completer.getCompletions(input, input.length);
          const route = `${provider}/${model}`;

          expect(
            completions.filter((completion) => completion.display === route),
          ).toHaveLength(1);
        }
      });

      it('should expose the default CLI bridge model for codex-cli two-stage completion', async () => {
        const completions = await completer.getCompletions('/model codex-cli/', 18);

        expect(completions.map(c => c.display)).toContain('codex-cli/gpt-5.4');
      });

      it('should expose the default CLI bridge model for gemini-cli two-stage completion', async () => {
        const completions = await completer.getCompletions('/model gemini-cli/', 19);

        expect(completions.map(c => c.display)).toContain('gemini-cli/auto-gemini-3');
      });

      it('should filter MiniMax models by provider/model partial', async () => {
        const completions = await completer.getCompletions('/model minimax-coding/M2.7', 27);

        expect(completions.map(c => c.display)).toEqual([
          'minimax-coding/MiniMax-M2.7',
          'minimax-coding/MiniMax-M2.7-highspeed',
        ]);
      });

      it('should filter models by partial text after provider/', async () => {
        const completions = await completer.getCompletions('/model anthropic/cl', 20);

        expect(completions.length).toBeGreaterThan(0);
        // All results should be anthropic models containing "cl"
        expect(completions.every(c => {
          expect(c.display.startsWith('anthropic/')).toBe(true);
          return c.display.toLowerCase().includes('cl');
        })).toBe(true);
        expect(completions.map(c => c.display)).toEqual(expect.arrayContaining([
          'anthropic/claude-sonnet-4-6',
          'anthropic/claude-opus-4-6',
          'anthropic/claude-haiku-4-5',
        ]));
      });

      it('should filter models by partial matching haiku', async () => {
        const completions = await completer.getCompletions('/model anthropic/ha', 21);

        expect(completions.length).toBe(1);
        expect(completions[0]?.display).toBe('anthropic/claude-haiku-4-5');
      });

      it('should return empty for unknown provider after /', async () => {
        const completions = await completer.getCompletions('/model nonexistent_xyz/', 24);

        // Unknown provider with / format — no completions (user should backspace)
        expect(completions.length).toBe(0);
      });

      it('should return empty for unknown provider with model partial', async () => {
        const completions = await completer.getCompletions('/model nonexistent_xyz/cl', 26);

        // Unknown provider with / format — no completions
        expect(completions.length).toBe(0);
      });
    });

    describe('/status command', () => {
      it('should return workspace/runtime detail arguments', async () => {
        const completions = await completer.getCompletions('/status ', 8);

        expect(completions.map(c => c.display)).toEqual(
          expect.arrayContaining(['workspace', 'runtime', 'worktree'])
        );
      });
    });

    describe('/plan command', () => {
      it('should not return arguments for a non-existent command', async () => {
        const completions = await completer.getCompletions('/plan ', 6);

        expect(completions).toEqual([]);
      });
    });

    describe('built-in command arguments', () => {
      it('returns simple subcommand arguments for commands with declared usage', async () => {
        const cases = [
          ['/mcp ', ['status', 'refresh']],
          ['/fallback ', ['status', 'off']],
          ['/thinking ', ['none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']],
          ['/think ', ['none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']],
          ['/reasoning ', ['none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']],
          ['/effort ', ['none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']],
          ['/agent-mode ', ['ama', 'sa', 'toggle']],
          ['/verifier-log ', ['on', 'off']],
          ['/stall-log ', ['on', 'off']],
          ['/memory ', ['list', 'remember', 'forget', 'decisions', 'show', 'approve', 'reject', 'doctor', 'open', 'help']],
          ['/goal ', ['status', 'pause', 'resume', 'clear', 'help']],
          ['/paste ', ['show', 'list']],
          ['/review ', ['--lean', '--workflow', 'base', 'sha', 'help']],
          ['/agents ', ['init', 'lean', 'help']],
        ] as const;

        for (const [input, expected] of cases) {
          const completions = await completer.getCompletions(input, input.length);
          expect(completions.map(c => c.display)).toEqual(expect.arrayContaining([...expected]));
        }
      });

      it('shares provider/model completion with /provider', async () => {
        const providerCompletions = await completer.getCompletions('/provider ', 10);
        expect(providerCompletions.length).toBeGreaterThan(0);
        expect(providerCompletions.every(c => !c.display.includes('/'))).toBe(true);

        const modelCompletions = await completer.getCompletions('/provider anthropic/', 20);
        expect(modelCompletions.some(c => c.display === 'anthropic/claude-sonnet-4-6')).toBe(true);
      });
    });

    describe('/repo-intel command', () => {
      it('should return top-level subcommands', async () => {
        const completions = await completer.getCompletions('/repo-intel ', 12);
        const displays = completions.map(c => c.display);

        expect(displays).toContain('status');
        expect(displays).toContain('mode');
        expect(displays).toContain('trace');
        expect(displays).not.toContain('warm');
        expect(displays).not.toContain('endpoint');
        expect(displays).not.toContain('bin');
      });

      it('should keep legacy /repointel and /ri completion narrow', async () => {
        const repointelCompletions = await completer.getCompletions('/repointel ', 11);
        const completions = await completer.getCompletions('/ri ', 4);

        expect(repointelCompletions.map(c => c.display)).toEqual(['status']);
        expect(completions.some(c => c.display === 'status')).toBe(true);
        expect(completions.some(c => c.display === 'mode')).toBe(false);
      });

      it('should return public runtime modes after /repo-intel mode', async () => {
        const completions = await completer.getCompletions('/repo-intel mode ', 17);

        expect(completions.some(c => c.display === 'auto')).toBe(true);
        expect(completions.some(c => c.display === 'full')).toBe(true);
        expect(completions.some(c => c.display === 'light')).toBe(true);
        expect(completions.some(c => c.display === 'off')).toBe(true);
        expect(completions.some(c => c.display === 'premium-native')).toBe(false);
      });

      it('should filter runtime modes by partial input', async () => {
        const completions = await completer.getCompletions('/repo-intel mode li', 19);

        expect(completions.map(c => c.display)).toEqual(['light']);
      });

      it('should return trace toggles after /repo-intel trace', async () => {
        const completions = await completer.getCompletions('/repo-intel trace ', 18);

        expect(completions.map(c => c.display)).toContain('on');
        expect(completions.map(c => c.display)).toContain('off');
        expect(completions.map(c => c.display)).toContain('toggle');
      });

      it('should stop suggesting after a complete second-level repo-intel argument', async () => {
        const completions = await completer.getCompletions('/repo-intel mode full ', 22);
        expect(completions).toEqual([]);
      });
    });

    describe('/workflow command', () => {
      it('should return workflow subcommands and built-in workflows', async () => {
        const completions = await completer.getCompletions('/workflow ', 10);

        expect(completions.some(c => c.display === 'runs')).toBe(true);
        expect(completions.some(c => c.display === 'stop')).toBe(true);
        expect(completions.some(c => c.display === 'delete')).toBe(true);
        expect(completions.some(c => c.display === 'prune')).toBe(true);
        expect(completions.some(c => c.display === 'rename')).toBe(true);
        expect(completions.some(c => c.display === 'revise')).toBe(true);
        expect(completions.some(c => c.display === 'parallel-investigation')).toBe(true);
      });

      it('should include rerun and preserve declared subcommand order at empty prefix', async () => {
        const completions = await completer.getCompletions('/workflow ', 10);
        const names = completions.map((c) => c.display);

        // `rerun` is the entry the autocomplete cap + length-sort used to drop
        // out of reach (it sorted to position 9, past the truncation limit).
        expect(names).toContain('rerun');

        // Empty prefix must preserve the declared subcommand order, not collapse
        // to a length sort. Under a length sort 'runs'(4) would precede
        // 'create'(6); the declared order is the reverse — assert it holds so the
        // regression that buried `rerun` cannot silently come back.
        expect(names.indexOf('create')).toBeLessThan(names.indexOf('runs'));
        expect(names.indexOf('runs')).toBeLessThan(names.indexOf('rerun'));
        expect(names.indexOf('rerun')).toBeLessThan(names.indexOf('save'));
      });

      it('should return workflow list and prune options', async () => {
        const runsOptions = await completer.getCompletions('/workflow runs ', 15);
        expect(runsOptions.some(c => c.display === '--all')).toBe(true);
        expect(runsOptions.some(c => c.display === '--limit')).toBe(true);

        const pruneOptions = await completer.getCompletions('/workflow prune ', 16);
        expect(pruneOptions.some(c => c.display === '--dry-run')).toBe(true);
        expect(pruneOptions.some(c => c.display === '--keep')).toBe(true);
        expect(pruneOptions.some(c => c.display === '--older-than')).toBe(true);
      });

      it('should return persisted workflow run ids for history commands', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'kodax-workflow-persisted-complete-'));
        const previousCwd = process.cwd();
        process.chdir(cwd);
        setAgentConfigHome(join(cwd, '.kodax-home'));
        const projectKey = deriveProjectKeyFromRoot(cwd).key;
        const baseDir = getAgentConfigPath('workflow-runs', projectKey);
        const runDir = join(baseDir, 'run-persisted-complete');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
          join(runDir, 'run.json'),
          JSON.stringify({
            runId: '../../outside',
            workflow: 'persisted-audit',
            status: 'failed',
            totalSpawned: 1,
            endedAt: Date.now(),
          }),
          'utf8',
        );

        try {
          const input = '/workflow delete ';
          const completions = await completer.getCompletions(input, input.length);

          expect(completions.some(c => c.display === 'run-persisted-complete')).toBe(true);
          expect(completions.some(c => c.display === '../../outside')).toBe(false);
        } finally {
          process.chdir(previousCwd);
          rmSync(baseDir, { recursive: true, force: true });
          rmSync(cwd, { recursive: true, force: true });
        }
      });

      it('should return saved workflow names for top-level and rerun completions', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'kodax-workflow-saved-complete-'));
        const previousCwd = process.cwd();
        process.chdir(cwd);
        setAgentConfigHome(join(cwd, '.kodax-home'));
        const workflowsDir = join(cwd, '.kodax', 'workflows');
        mkdirSync(workflowsDir, { recursive: true });
        writeFileSync(join(workflowsDir, 'saved-audit.workflow.json'), '{}', 'utf8');

        const projectKey = deriveProjectKeyFromRoot(cwd).key;
        const baseDir = getAgentConfigPath('workflow-runs', projectKey);
        const runDir = join(baseDir, 'run-persisted-complete');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
          join(runDir, 'run.json'),
          JSON.stringify({
            runId: 'run-persisted-complete',
            workflow: 'persisted-audit',
            status: 'completed',
            totalSpawned: 0,
            endedAt: Date.now(),
          }),
          'utf8',
        );
        writeFileSync(
          join(runDir, 'workflow-metadata.json'),
          JSON.stringify({ displayName: 'AliasAudit' }),
          'utf8',
        );
        const spacedRunDir = join(baseDir, 'run-spaced-alias');
        mkdirSync(spacedRunDir, { recursive: true });
        writeFileSync(
          join(spacedRunDir, 'run.json'),
          JSON.stringify({
            runId: 'run-spaced-alias',
            workflow: 'persisted-audit',
            status: 'completed',
            totalSpawned: 0,
            endedAt: Date.now(),
            displayName: 'Alias Audit',
          }),
          'utf8',
        );

        try {
          const topLevel = await completer.getCompletions('/workflow ', 10);
          expect(topLevel.some((c) => c.display === 'saved-audit')).toBe(true);

          const rerun = await completer.getCompletions('/workflow rerun ', 16);
          expect(rerun.some((c) => c.display === 'run-persisted-complete')).toBe(true);
          const saved = rerun.find((c) => c.display === 'saved-audit');
          expect(saved?.description).toContain('saved workflow');

          const renameInput = '/workflow rename ';
          const rename = await completer.getCompletions(renameInput, renameInput.length);
          expect(rename.some((c) => c.display === 'run-persisted-complete')).toBe(true);
          expect(rename.some((c) => c.display === 'AliasAudit')).toBe(true);
          expect(rename.some((c) => c.display === 'Alias Audit')).toBe(false);
          expect(rename.some((c) => c.display === 'saved-audit')).toBe(true);

          const deleteInput = '/workflow delete ';
          const deleteCompletions = await completer.getCompletions(deleteInput, deleteInput.length);
          expect(deleteCompletions.some((c) => c.display === '--saved')).toBe(true);
          expect(deleteCompletions.some((c) => c.display === '--run')).toBe(true);
          expect(deleteCompletions.some((c) => c.display === 'run-persisted-complete')).toBe(true);
          expect(deleteCompletions.some((c) => c.display === 'saved-audit')).toBe(true);

          const deleteSavedInput = '/workflow delete --saved ';
          const deleteSavedCompletions = await completer.getCompletions(deleteSavedInput, deleteSavedInput.length);
          expect(deleteSavedCompletions.some((c) => c.display === 'saved-audit')).toBe(true);
          expect(deleteSavedCompletions.some((c) => c.display === 'run-persisted-complete')).toBe(false);

          const deleteRunInput = '/workflow delete --run ';
          const deleteRunCompletions = await completer.getCompletions(deleteRunInput, deleteRunInput.length);
          expect(deleteRunCompletions.some((c) => c.display === 'run-persisted-complete')).toBe(true);
          expect(deleteRunCompletions.some((c) => c.display === 'saved-audit')).toBe(false);

          const reviseInput = '/workflow revise ';
          const revise = await completer.getCompletions(reviseInput, reviseInput.length);
          expect(revise.some((c) => c.display === '--replace')).toBe(true);
          expect(revise.some((c) => c.display === 'run-persisted-complete')).toBe(true);
          expect(revise.some((c) => c.display === 'AliasAudit')).toBe(true);
          expect(revise.some((c) => c.display === 'saved-audit')).toBe(true);

          const replaceInput = '/workflow revise --replace ';
          const replace = await completer.getCompletions(replaceInput, replaceInput.length);
          expect(replace.some((c) => c.display === 'saved-audit')).toBe(true);
          expect(replace.some((c) => c.display === 'run-persisted-complete')).toBe(false);
        } finally {
          process.chdir(previousCwd);
          rmSync(baseDir, { recursive: true, force: true });
          rmSync(cwd, { recursive: true, force: true });
        }
      });

      it('should return active run ids after workflow control subcommands', async () => {
        const runDir = mkdtempSync(join(tmpdir(), 'kodax-workflow-complete-'));
        const manager = getDefaultWorkflowRunManager();
        let finishRun = (): void => undefined;
        const module: WorkflowModule = {
          meta: {
            name: 'autocomplete-hold',
            description: 'Hold open for autocomplete tests',
            phases: ['hold'],
            readOnly: true,
          },
          run: async () => new Promise<void>((resolve) => {
            finishRun = resolve;
          }),
        };
        const run = manager.start({
          module,
          args: {},
          runId: 'run-autocomplete-live',
          runDir,
          backend: {} as WorkflowAgentBackend,
        });

        try {
          const completions = await completer.getCompletions('/workflow stop ', 15);
          expect(completions.some(c => c.display === 'run-autocomplete-live')).toBe(true);
        } finally {
          manager.stop('run-autocomplete-live');
          finishRun();
          await run.done.catch(() => undefined);
          rmSync(runDir, { recursive: true, force: true });
        }
      });
    });

    describe('format', () => {
      it('should return completion with correct type', async () => {
        const completions = await completer.getCompletions('/mode ', 6);

        expect(completions.every(c => c.type === 'argument')).toBe(true);
      });

      it('should include description', async () => {
        const completions = await completer.getCompletions('/mode ', 6);

        // All completions should have descriptions
        expect(completions.every(c => c.description)).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('should return empty array for unknown command', async () => {
        const completions = await completer.getCompletions('/unknown ', 9);
        expect(completions).toEqual([]);
      });

      it('should return empty array when no matches', async () => {
        const completions = await completer.getCompletions('/mode xyz', 9);
        expect(completions).toEqual([]);
      });

      it('should handle case-insensitive filtering', async () => {
        const completions = await completer.getCompletions('/mode AC', 8);

        // 'accept-edits' contains 'ac'
        expect(completions.length).toBeGreaterThan(0);
        expect(completions.some(c => c.display === 'accept-edits')).toBe(true);
      });

      it('should keep thinking alias completions working', async () => {
        const completions = await completer.getCompletions('/t ', 3);
        expect(completions.length).toBeGreaterThan(0);
        expect(completions.some(c => c.display === 'auto')).toBe(true);
      });
    });
  });
});
