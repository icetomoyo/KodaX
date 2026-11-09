/**
 * Global vitest setup — MessageQueue singleton isolation.
 *
 * FEATURE_159 (v0.7.40) made the process-global MessageQueue the canonical
 * source for queued user prompts (see `packages/agent/src/messaging/queue.ts`).
 * Any test that touches `getMessageQueue()` directly, or that constructs a
 * `StreamingManager` via `createStreamingManager()`, can leak queue state
 * into the next test running in the same vitest worker.
 *
 * Most existing tests already call `_resetMessageQueueForTests()` in their
 * own `beforeEach`. This file is a safety net for tests that forget — it
 * resets the singleton before every test, process-wide. Explicit per-suite
 * resets remain valid and are still preferred (they document intent at the
 * call site), but the global hook removes "I forgot the reset" as a class
 * of bugs.
 *
 * Registered via `setupFiles` in `vitest.config.ts`.
 */
import { mkdtempSync, realpathSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach } from 'vitest';
// IMPORTANT: import from the `@kodax-ai/agent/messaging/queue` subpath,
// NOT the `@kodax-ai/agent` root barrel.
//
// The root barrel pulls in modules that import `node:os` at top level
// (e.g. `runtime/agent-home.ts`). Pre-loading the barrel during
// setupFiles would freeze the `node:os.homedir` binding inside the
// worker module cache before any test file's `vi.mock("node:os")`
// declaration gets hoisted — breaking tests like
// `packages/repl/src/ui/utils/paste-cache.test.ts`.
//
// The `messaging/queue` subpath is the leaf module: it only imports
// `./types.js` (pure types), so it has zero module-load side effects
// and a safe dependency surface for global test setup.
import { _resetMessageQueueForTests } from '@kodax-ai/agent/messaging/queue';

// Standalone shell/LSP tests also register managed children. Give each test
// file a private fallback before application imports, rather than inheriting
// the developer's config home. Explicit per-test overrides still take priority;
// vi.unstubAllEnvs() restores this fallback. Do not preload the agent barrel.
// The base must be canonical: macOS temporary roots sit under the /var
// symbolic link, which hardened agent-home alias fences reject.
const defaultTestConfigHome = mkdtempSync(
  path.join(realpathSync.native(tmpdir()), 'kodax-vitest-home-'),
);
process.env.KODAX_HOME = defaultTestConfigHome;
afterAll(() => {
  try {
    rmdirSync(defaultTestConfigHome);
  } catch (error: unknown) {
    // Nonempty homes retain evidence for potentially unverified child cleanup.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
});

// Daemon processes intentionally outlive ordinary clients. Bind daemons
// launched by this Vitest worker to the worker PID so a forced worker exit can
// still trigger clean daemon shutdown when per-test finally hooks cannot run.
// Child CLI/probe processes inherit the original worker PID unchanged.
process.env.KODAX_INTERNAL_DAEMON_TEST_PARENT_PID = String(process.pid);

beforeEach(() => {
  _resetMessageQueueForTests();
});
