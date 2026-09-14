export const DEFAULT_TEST_FILES = [
  'packages/*/src/**/*.test.ts',
  'packages/*/src/**/*.test.tsx',
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'tests/**/*.test.ts',
  'tests/**/*.test.tsx',
  // FEATURE_104 prompt-eval harness self-test (zero-LLM unit tests).
  // Benchmark module + datasets + gitignored run results live under benchmark/.
  'benchmark/**/*.test.ts',
];

// Small, high-signal edit-loop gate: public entry points plus lightweight
// facade/data contracts. The unit tier owns every remaining deterministic
// test, so narrowing this list never removes coverage from test:full or CI.
export const FAST_TEST_FILES = [
  'packages/*/src/*.test.ts',
  'packages/*/src/*.test.tsx',
  'src/*.test.ts',
  'src/*.test.tsx',
  'tests/*.test.ts',
  'tests/*.test.tsx',
  'packages/agent/src/media/**/*.test.ts',
  'packages/coding/src/media/**/*.test.ts',
  'packages/repl/src/paste/**/*.test.ts',
  'benchmark/datasets/*/cases.test.ts',
];

// Real-provider tests are opt-in: they depend on credentials, network access,
// provider availability, and may consume paid tokens.
export const INTEGRATION_TEST_FILES = [
  'packages/llm/src/providers/*.integration.test.ts',
  'packages/llm/src/providers/verify-credential-integration.test.ts',
];

// Public/runtime contracts exercise the full in-process Agent orchestration
// with scripted providers. They are deterministic but intentionally broader
// than the focused edit-loop tests.
export const CONTRACT_TEST_FILES = [
  'packages/coding/src/agent.*.test.ts',
  'packages/coding/src/agent-runtime/__contract-tests__/**/*.contract.test.ts',
  'packages/coding/src/child-executor.test.ts',
  'packages/coding/src/client.test.ts',
  'packages/coding/src/orchestration.test.ts',
  'packages/coding/src/running-session.test.ts',
  'packages/coding/src/task-engine.test.ts',
  'packages/coding/src/task-engine/runner-driven.test.ts',
  'packages/coding/src/workflows/author-via-worker.test.ts',
];

// High-value tests whose subprocess, daemon, repository-indexing, or storage
// behavior makes them unsuitable for the edit/verify loop.
export const SYSTEM_TEST_FILES = [
  'src/sandbox-runtime.test.ts',
  'src/kodax_cli.daemon-smoke.test.ts',
  'src/kodax_cli.setup-boundary.test.ts',
  'src/kodax_cli.interactive-exit.test.ts',
  'src/sdk-runtime*.test.ts',
  'src/integration-*.test.ts',
  'src/acp_server.test.ts',
  'src/a2a/a2a.test.ts',
  'benchmark/harness/h2-boundary-runner.test.ts',
  'benchmark/harness/worktree-runner.test.ts',
  'benchmark/datasets/*/runner.test.ts',
  'tests/acp_server.test.ts',
  'tests/feature-125-team-mode.integration.test.ts',
  'tests/issue-206-sidecar-tarball.test.ts',
  'tests/sa-refactor-goldens/selection.test.ts',
  'packages/agent/src/capabilities/mcp/runtime.test.ts',
  'packages/agent/src/capabilities/mcp/transport.test.ts',
  'packages/agent/src/runtime/managed-child-processes.test.ts',
  'packages/agent/src/runtime/process-tree.test.ts',
  'packages/agent/src/runtime/process-cleanup.windows.integration.test.ts',
  'packages/coding/src/lsp/client-integration.test.ts',
  'packages/coding/src/repo-intelligence/**/*.test.ts',
  'packages/coding/src/tools/bash.test.ts',
  'packages/coding/src/tools/changed-diff.test.ts',
  'packages/coding/src/tools/repo-intelligence-tools.test.ts',
  'packages/coding/src/tools/semantic-lookup.test.ts',
  'packages/repl/src/common/agent-mode-migration.test.ts',
  'packages/repl/src/commands/memory-command.test.ts',
  'packages/repl/src/**/*storage*.test.ts',
  'packages/repl/src/session/public-api.test.ts',
];
