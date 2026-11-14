/**
 * FEATURE_308 inferred-lesson experiment: case data.
 *
 * Each case is modelled on a recovery pattern mined from the owner's real agent
 * session logs (paraphrased; no log text is copied). In session 1 a shell command
 * fails, the agent works around it and finishes the task, and the user never
 * states a rule. Session 2 is a later, ordinary request whose first relevant
 * command shows whether a lesson from session 1 helped or hurt.
 *
 *   durable        the workaround is the real fix; remembering it should help
 *   spurious       the failure was transient or specific to that day; a note
 *                  turning the workaround into a rule should hurt
 *   misattributed  the agent recovered but named the wrong cause
 *
 * Tool results use the production bash format (`Command:` / `Exit:` / `[stderr]`);
 * a non-zero exit is not an error result, exactly as the bash tool returns it.
 * Each session 1 also carries ordinary probe noise (a grep that matches nothing).
 *
 * Case data only. Editing anything here changes the case hash recorded by prepare.
 */
import type { KodaXMessage } from '@kodax-ai/llm';

import { assistantCall, assistantText, toolResult, user } from '../feature-308-baseline/cases.js';
import type { CommandOracle } from './oracles.js';
import type { World } from './world.js';

export type LessonKind = 'durable' | 'spurious' | 'misattributed';

export interface InferredCase {
  readonly id: string;
  readonly kind: LessonKind;
  /** For the reviewer only: what is actually true about this machine or repo. */
  readonly truth: string;
  readonly sessionOne: readonly KodaXMessage[];
  readonly sessionTwo: { readonly history: readonly KodaXMessage[]; readonly userMessage: string };
  readonly oracle: CommandOracle;
  /** The session-2 repository as exploration sees it. */
  readonly world: World;
  /** Words that carry the lesson; no user message in session 1 may contain them. */
  readonly ruleWords: readonly string[];
}

export function shell(command: string, exit: number, stdout: string, stderr = ''): string {
  return `Command: ${command}\nExit: ${exit}\n${stdout}${stderr.length > 0 ? `\n[stderr]\n${stderr}` : ''}`;
}

let callCounter = 0;
/** One bash call and its result. Ids only need to be unique within a session. */
export function bash(intro: string, command: string, exit: number, stdout: string, stderr = ''): KodaXMessage[] {
  callCounter += 1;
  const id = `toolu_bash_${callCounter}`;
  return [assistantCall(intro, id, 'bash', { command, description: intro }), toolResult(id, shell(command, exit, stdout, stderr))];
}

export function read(intro: string, path: string, content: string): KodaXMessage[] {
  callCounter += 1;
  const id = `toolu_read_${callCounter}`;
  return [assistantCall(intro, id, 'read', { path: `/work/project/${path}` }), toolResult(id, content)];
}

export function edit(intro: string, path: string, oldText: string, newText: string): KodaXMessage[] {
  callCounter += 1;
  const id = `toolu_edit_${callCounter}`;
  return [
    assistantCall(intro, id, 'edit', { path: `/work/project/${path}`, edits: [{ old_string: oldText, new_string: newText }] }),
    toolResult(id, `Edited ${path}`),
  ];
}

const FNM_BIN = '$HOME/.local/share/fnm/node-versions/v22.11.0/installation/bin';

const SLUG_SOURCE =
  "export function slugify(title: string): string {\n  return title.toLowerCase().replace(/\\s+/g, '-');\n}\n";

/** A command that runs a test suite, as opposed to a probe such as `which npx`. */
const TEST_RUN = /\bvitest\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/;

/** On this machine node is installed through fnm but not on the agent shell's PATH. */
const NODE_MISSING_PROBE = {
  match: /\b(?:which|command\s+-v|type)\b[^|;&]*\b(?:node|npx|npm)\b|\b(?:node|npx|npm)\s+(?:-v|--version)\b/,
  exit: 127,
  stdout: '',
  stderr: 'node: command not found',
};
const FNM_PROBE = { match: /fnm|node-versions|\.nvm|volta/, exit: 0, stdout: 'v22.11.0\n' };

// ------------------------------------------------------------------ durable

/** Node is installed through a version manager whose bin dir is not on the agent shell's PATH. */
const NODE_PATH: InferredCase = {
  id: 'd-node-path',
  kind: 'durable',
  truth: 'Node is installed through fnm, but the non-interactive shell the agent runs in does not load fnm, so node/npm/npx exit 127 unless the fnm bin directory is put on PATH in the same command. This holds for every session on this machine.',
  sessionOne: [
    user('slugify() in src/text/slug.ts keeps punctuation, so "Hello, World!" becomes "hello,-world!". Make it strip anything that is not a letter, digit or dash, and run its tests.'),
    ...read('Reading the helper.', 'src/text/slug.ts', SLUG_SOURCE),
    ...bash('Looking for other callers that depend on the punctuation.', 'grep -rn "slugify(" src --include=*.ts | grep -v slug.ts', 1, ''),
    ...edit('No other callers. Updating the replacement.', 'src/text/slug.ts',
      "return title.toLowerCase().replace(/\\s+/g, '-');",
      "return title.toLowerCase().replace(/[^a-z0-9\\s-]/g, '').trim().replace(/\\s+/g, '-');"),
    ...bash('Running the slug tests.', 'npx vitest run src/text/slug.test.ts', 127, '', 'bash: line 1: npx: command not found'),
    ...bash('npx is missing from PATH. Checking whether a Node version manager is installed.', 'ls ~/.local/share/fnm/node-versions 2>/dev/null; command -v fnm nvm volta', 0, 'v22.11.0\n'),
    ...bash('fnm has Node 22 installed but this shell does not load it. Putting its bin directory on PATH for this command.',
      `export PATH="${FNM_BIN}:$PATH" && npx vitest run src/text/slug.test.ts`, 0,
      ' RUN  v4.1.11 /work/project\n\n ✓ src/text/slug.test.ts (6 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n'),
    assistantText('slugify() now drops punctuation, and all 6 slug tests pass.'),
  ],
  sessionTwo: {
    history: [
      user('I changed the invoice rounding in src/billing/invoice.ts to round half up. Does the change look right to you?'),
      ...read('Reading the change.', 'src/billing/invoice.ts',
        'export function roundCents(value: number): number {\n  return Math.floor(value * 100 + 0.5) / 100;\n}\n'),
      assistantText('Yes. `Math.floor(value * 100 + 0.5) / 100` rounds half up for positive amounts. Negative amounts (refunds) would round toward positive infinity, which may or may not be what you want.'),
    ],
    userMessage: 'Refunds are never negative here, so that is fine. Run the billing unit tests to see whether anything broke.',
  },
  oracle: { pick: TEST_RUN, needs: [/fnm|node-versions/] },
  world: {
    files: {
      'package.json': '{\n  "name": "invoicing",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "build": "tsc -b",\n    "test": "vitest run"\n  },\n  "devDependencies": {\n    "typescript": "^5.9.2",\n    "vitest": "^4.1.11"\n  }\n}\n',
      'vitest.config.ts': "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { include: ['src/**/*.test.ts'] } });\n",
      'src/billing/invoice.ts': 'export function roundCents(value: number): number {\n  return Math.floor(value * 100 + 0.5) / 100;\n}\n',
      'src/billing/invoice.test.ts': "import { expect, it } from 'vitest';\nimport { roundCents } from './invoice.js';\n\nit('rounds half up', () => expect(roundCents(1.005)).toBe(1.01));\n",
      'src/billing/tax.test.ts': "import { expect, it } from 'vitest';\nimport { taxFor } from './tax.js';\n\nit('applies the base rate', () => expect(taxFor(100)).toBe(20));\n",
      'src/billing/tax.ts': 'export const taxFor = (net: number): number => Math.round(net * 0.2 * 100) / 100;\n',
      'src/text/slug.ts': SLUG_SOURCE,
    },
    commands: [NODE_MISSING_PROBE, FNM_PROBE],
  },
  ruleWords: ['fnm', 'PATH', 'node-versions'],
};

/** In this monorepo vitest only works when started from the repository root. */
const VITEST_ROOT: InferredCase = {
  id: 'd-vitest-root',
  kind: 'durable',
  truth: 'Workspace packages have no vitest config of their own; the root config adds the transform that strips shebang lines, so any vitest run started inside packages/* fails to load files. Running from the repo root with the package path always works.',
  sessionOne: [
    user('formatDuration() in packages/cli/src/format.ts prints "1m 60s" for 119.6 seconds. Fix the rounding and run that file\'s tests.'),
    ...read('Reading the formatter.', 'packages/cli/src/format.ts',
      'export function formatDuration(seconds: number): string {\n  const m = Math.floor(seconds / 60);\n  const s = Math.round(seconds % 60);\n  return m > 0 ? `${m}m ${s}s` : `${s}s`;\n}\n'),
    ...edit('Rounding first, then splitting into minutes and seconds.', 'packages/cli/src/format.ts',
      '  const m = Math.floor(seconds / 60);\n  const s = Math.round(seconds % 60);',
      '  const total = Math.round(seconds);\n  const m = Math.floor(total / 60);\n  const s = total % 60;'),
    ...bash('Running the package tests.', 'cd packages/cli && npx vitest run src/format.test.ts', 1,
      ' RUN  v4.1.11 /work/project/packages/cli\n\n ❯ src/format.test.ts (0 test)\n\n FAIL  src/format.test.ts\nError: Failed to load url ./bin.js (resolved id: ./bin.js). Does the file exist?\nSyntaxError: Invalid or unexpected token\n ❯ src/bin.ts:1:1\n      1| #!/usr/bin/env node\n\n Test Files  1 failed (1)\n'),
    ...bash('The failure is in loading a shebang file, not in the test. Checking where the vitest config lives.', 'ls packages/cli/vitest.config.* vitest.config.* 2>/dev/null', 0, 'vitest.config.ts\n'),
    ...bash('Only the root has a config. Running from the root.', 'npx vitest run packages/cli/src/format.test.ts', 0,
      ' RUN  v4.1.11 /work/project\n\n ✓ packages/cli/src/format.test.ts (9 tests) 5ms\n\n Test Files  1 passed (1)\n      Tests  9 passed (9)\n'),
    ...bash('Checking the old string is gone from snapshots.', 'grep -rn "1m 60s" packages/cli/src', 1, ''),
    assistantText('formatDuration() now rounds before splitting, so 119.6 s prints "2m 0s". All 9 format tests pass.'),
  ],
  sessionTwo: {
    history: [
      user('I refactored the health route in packages/server. Can you see how its tests are set up?'),
      ...read('Reading the server package manifest.', 'packages/server/package.json',
        '{\n  "name": "@acme/server",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "build": "tsc -b",\n    "test": "vitest run"\n  }\n}\n'),
      assistantText('The server package runs its tests with `vitest run` (its `test` script). The health route tests are in packages/server/src/routes/health.test.ts.'),
    ],
    userMessage: 'Run the server package\'s tests.',
  },
  oracle: {
    pick: TEST_RUN,
    needs: [/\bvitest\s+(?:run\s+)?packages\/server\b/, /\bnpm\s+(?:run\s+)?test\s+--\s+packages\/server\b/],
    avoid: [/\bcd\s+(?:\.\/)?packages\//, /(?:^|\s)(?:-w|--workspace)[=\s]/, /--prefix\s+packages\//, /--root\s+packages\//],
  },
  world: {
    files: {
      'package.json': '{\n  "name": "acme",\n  "private": true,\n  "workspaces": ["packages/*"],\n  "scripts": {\n    "build": "tsc -b",\n    "test": "vitest run"\n  }\n}\n',
      'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nimport { stripShebang } from './tools/strip-shebang.js';\n\nexport default defineConfig({\n  plugins: [stripShebang()],\n  test: { include: ['packages/*/src/**/*.test.ts'] },\n});\n",
      'tools/strip-shebang.ts': "import type { Plugin } from 'vite';\n\nexport const stripShebang = (): Plugin => ({ name: 'strip-shebang', transform: (code) => code.replace(/^#!.*\\n/, '') });\n",
      'packages/server/package.json': '{\n  "name": "@acme/server",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "build": "tsc -b",\n    "test": "vitest run"\n  }\n}\n',
      'packages/server/src/bin.ts': "#!/usr/bin/env node\nimport { start } from './app.js';\n\nstart();\n",
      'packages/server/src/app.ts': "import { health } from './routes/health.js';\n\nexport function start(): void {\n  health();\n}\n",
      'packages/server/src/routes/health.ts': "export function health(): { status: 'ok' } {\n  return { status: 'ok' };\n}\n",
      'packages/server/src/routes/health.test.ts': "import { expect, it } from 'vitest';\nimport { health } from './health.js';\n\nit('reports ok', () => expect(health()).toEqual({ status: 'ok' }));\n",
      'packages/cli/package.json': '{\n  "name": "@acme/cli",\n  "private": true,\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n',
      'packages/cli/src/format.ts': 'export function formatDuration(seconds: number): string {\n  const total = Math.round(seconds);\n  return `${Math.floor(total / 60)}m ${total % 60}s`;\n}\n',
    },
  },
  ruleWords: ['repo root', 'from the root', 'repository root'],
};

/** The e2e folder has no tsconfig; typecheck goes through the root check config. */
const TSC_ROOT: InferredCase = {
  id: 'd-tsc-root',
  kind: 'durable',
  truth: 'tests/e2e has no tsconfig.json. The only way to typecheck it is `npx tsc -p tsconfig.check.json --noEmit` from the root, whose include covers tests/e2e.',
  sessionOne: [
    user('The login e2e test still uses the old `page.waitForNavigation()`. Switch tests/e2e/login.spec.ts to `page.waitForURL("/home")` and make sure it typechecks.'),
    ...read('Reading the spec.', 'tests/e2e/login.spec.ts',
      "import { test, expect } from '@playwright/test';\n\ntest('logs in', async ({ page }) => {\n  await page.goto('/login');\n  await page.fill('#email', 'demo@example.test');\n  await page.click('button[type=submit]');\n  await page.waitForNavigation();\n  await expect(page.locator('h1')).toHaveText('Home');\n});\n"),
    ...bash('Checking whether other specs use the old wait too.', 'grep -rln "waitForNavigation" tests/e2e | grep -v login.spec.ts', 1, ''),
    ...edit('Only this one. Replacing the deprecated wait.', 'tests/e2e/login.spec.ts', '  await page.waitForNavigation();', "  await page.waitForURL('/home');"),
    ...bash('Typechecking the e2e folder.', 'cd tests/e2e && npx tsc --noEmit', 1,
      "error TS5057: Cannot find a tsconfig.json file at the specified directory: '.'.\n"),
    ...bash('No tsconfig there. Looking for the config that covers it.', 'grep -ln "tests/e2e" tsconfig*.json', 0, 'tsconfig.check.json\n'),
    ...bash('tsconfig.check.json includes it. Typechecking from the root.', 'npx tsc -p tsconfig.check.json --noEmit', 0, ''),
    assistantText('login.spec.ts now waits with `page.waitForURL("/home")` and the typecheck is clean.'),
  ],
  sessionTwo: {
    history: [
      user('I added a loginAs helper to tests/e2e/fixtures/auth.ts. Take a look.'),
      ...read('Reading the fixture.', 'tests/e2e/fixtures/auth.ts',
        "import type { Page } from '@playwright/test';\n\nexport async function loginAs(page: Page, email: string): Promise<void> {\n  await page.goto('/login');\n  await page.fill('#email', email);\n  await page.click('button[type=submit]');\n  await page.waitForURL('/home');\n}\n"),
      assistantText('loginAs() fills the email, submits and waits for /home, the same flow as login.spec.ts. It looks fine.'),
    ],
    userMessage: 'Thanks. Typecheck it before I commit.',
  },
  oracle: { pick: /\btsc\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|typecheck|type-check|check)\b/, needs: [/tsconfig\.check\.json/] },
  world: {
    files: {
      'package.json': '{\n  "name": "storefront",\n  "private": true,\n  "scripts": {\n    "build": "tsc -b",\n    "test": "vitest run",\n    "e2e": "playwright test"\n  }\n}\n',
      'tsconfig.json': '{\n  "compilerOptions": { "strict": true, "module": "NodeNext", "outDir": "dist" },\n  "include": ["src"]\n}\n',
      'tsconfig.check.json': '{\n  "extends": "./tsconfig.json",\n  "compilerOptions": { "noEmit": true, "types": ["node", "@playwright/test"] },\n  "include": ["src", "tests"]\n}\n',
      'playwright.config.ts': "import { defineConfig } from '@playwright/test';\n\nexport default defineConfig({ testDir: 'tests/e2e' });\n",
      'tests/e2e/login.spec.ts': "import { test, expect } from '@playwright/test';\n\ntest('logs in', async ({ page }) => {\n  await page.goto('/login');\n  await page.waitForURL('/home');\n  await expect(page.locator('h1')).toHaveText('Home');\n});\n",
      'tests/e2e/fixtures/auth.ts': "import type { Page } from '@playwright/test';\n\nexport async function loginAs(page: Page, email: string): Promise<void> {\n  await page.goto('/login');\n  await page.fill('#email', email);\n  await page.click('button[type=submit]');\n  await page.waitForURL('/home');\n}\n",
      'src/index.ts': "export { cartTotal } from './cart.js';\n",
      'src/cart.ts': 'export const cartTotal = (prices: number[]): number => prices.reduce((sum, price) => sum + price, 0);\n',
    },
  },
  ruleWords: ['tsconfig.check.json', 'from the root'],
};

/** jq is not installed; gh has a built-in --jq filter. */
const GH_JQ: InferredCase = {
  id: 'd-gh-jq',
  kind: 'durable',
  truth: 'jq is not installed on this machine and the user does not want it installed. gh is installed and supports `--jq` with the same filter syntax.',
  sessionOne: [
    user('Which of my open pull requests are still waiting on review? Just the numbers and titles.'),
    ...bash('Listing open PRs.', "gh pr list --author @me --state open --json number,title,reviewDecision | jq -r '.[] | select(.reviewDecision != \"APPROVED\") | \"#\\(.number) \\(.title)\"'", 127,
      '', 'bash: line 1: jq: command not found'),
    ...bash('jq is not installed. gh can apply the same filter itself.', "gh pr list --author @me --state open --json number,title,reviewDecision --jq '.[] | select(.reviewDecision != \"APPROVED\") | \"#\\(.number) \\(.title)\"'", 0,
      '#412 Retry uploads on 503\n#407 Move cache dir under XDG_CACHE_HOME\n'),
    ...bash('Checking whether any of them has a draft label.', 'grep -rn "draft" .github/pull_request_template.md', 1, ''),
    assistantText('Two open PRs are still waiting on review: #412 "Retry uploads on 503" and #407 "Move cache dir under XDG_CACHE_HOME".'),
  ],
  sessionTwo: {
    history: [
      user('CI on main feels flaky this week. Is gh logged in on this machine?'),
      ...bash('Checking the GitHub CLI login.', 'gh auth status', 0, 'github.com\n  ✓ Logged in to github.com account dev-acme (keyring)\n  - Active account: true\n  - Git operations protocol: https\n'),
      assistantText('Yes, gh is logged in to github.com.'),
    ],
    userMessage: 'Good. Write the ids of the failed runs among the last 20 workflow runs on main into failed-runs.txt, one id per line, so I can feed them to the rerun script.',
  },
  oracle: { pick: /\bgh\s+(?:run|api)\b/, avoid: [/\|\s*jq\b/] },
  world: {
    files: {
      'README.md': '# reports\n\nNightly report generator.\n',
      '.github/workflows/ci.yml': 'name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci && npm test\n',
      '.github/workflows/nightly.yml': "name: Nightly\non:\n  schedule:\n    - cron: '0 2 * * *'\njobs:\n  report:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci && npm run report\n",
    },
    commands: [
      { match: /\b(?:which|command\s+-v|type)\b[^|;&]*\bjq\b|\bjq\s+--version\b/, exit: 1, stdout: '', stderr: 'jq: command not found' },
      { match: /\bgh\s+--version\b/, exit: 0, stdout: 'gh version 2.63.0 (2024-11-27)\n' },
      { match: /\bgit\s+remote\b/, exit: 0, stdout: 'origin\thttps://github.com/acme/reports.git (fetch)\norigin\thttps://github.com/acme/reports.git (push)\n' },
    ],
  },
  ruleWords: ['--jq', 'jq'],
};

// ------------------------------------------------------------------ spurious

/** A one-off TLS reset; the proxy is required and was never the cause. */
const TLS_PROXY: InferredCase = {
  id: 's-tls-proxy',
  kind: 'spurious',
  truth: 'This machine reaches GitHub only through the configured HTTPS proxy. The reset was a one-off; a plain retry would have succeeded too. Unsetting the proxy only worked because the network happened to recover; on most days it makes git hang or fail.',
  sessionOne: [
    user('Rebase my branch feature/export-csv onto the latest origin/main and tell me if there are conflicts.'),
    ...bash('Checking the working tree first.', 'git status --short && git branch --show-current', 0, 'feature/export-csv\n'),
    ...bash('Fetching main.', 'git fetch origin main', 128, '',
      "fatal: unable to access 'https://github.com/acme/reports.git/': OpenSSL SSL_read: Connection reset by peer, errno 104"),
    ...bash('The connection was reset. Retrying without the proxy variables.', 'env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy git fetch origin main', 0,
      '', 'From https://github.com/acme/reports\n * branch            main       -> FETCH_HEAD\n   9c1e2aa..41f07bd  main       -> origin/main'),
    ...bash('Rebasing.', 'git rebase origin/main', 0, 'Successfully rebased and updated refs/heads/feature/export-csv.\n'),
    ...bash('Checking for leftover conflict markers.', 'grep -rn "^<<<<<<< " src', 1, ''),
    assistantText('feature/export-csv is rebased onto origin/main (now at 41f07bd) with no conflicts.'),
  ],
  sessionTwo: {
    history: [
      user('Is my working tree clean, and which branch am I on?'),
      ...bash('Checking.', 'git status --short --branch', 0, '## main...origin/main\n'),
      assistantText('You are on main, tracking origin/main, and the working tree is clean.'),
    ],
    userMessage: 'Good. Pull the latest main, please.',
  },
  oracle: { pick: /\bgit\s+(?:fetch|pull)\b/, avoid: [/-u\s+https?_proxy|unset\s+https?_proxy|https?_proxy=\s|https?_proxy=""|--no-proxy|http\.proxy=?\s*""?/i] },
  world: {
    files: { 'README.md': '# reports\n\nNightly report generator.\n', 'src/export/csv.ts': 'export const toCsv = (rows: string[][]): string => rows.map((row) => row.join(",")).join("\\n");\n' },
    commands: [
      { match: /\bgit\s+remote\b/, exit: 0, stdout: 'origin\thttps://github.com/acme/reports.git (fetch)\norigin\thttps://github.com/acme/reports.git (push)\n' },
      { match: /\bgit\s+(?:status|branch)\b/, exit: 0, stdout: '## main...origin/main\n' },
      { match: /\bgit\s+config\b.*proxy|\benv\b.*proxy|\becho\b.*proxy/i, exit: 0, stdout: 'HTTPS_PROXY=http://proxy.corp.internal:3128\nHTTP_PROXY=http://proxy.corp.internal:3128\n' },
      { match: /\bgit\s+log\b/, exit: 0, stdout: '9c1e2aa Add CSV export command\n' },
    ],
  },
  ruleWords: ['proxy', 'HTTPS_PROXY'],
};

/** A release candidate that had not been published yet; it is published now. */
const UNPUBLISHED_VERSION: InferredCase = {
  id: 's-unpublished-version',
  kind: 'spurious',
  truth: '@acme/ui-kit 3.0.0 was simply not published on the day of session 1, so the agent linked the sibling checkout. It is published now; the sibling checkout is on an unreleased branch, so linking it tests code that users will never receive.',
  sessionOne: [
    user('Try the app against @acme/ui-kit 3.0.0 and tell me whether the Button import still compiles.'),
    ...bash('Checking the published versions.', 'npm view @acme/ui-kit@3.0.0 version', 1, '',
      "npm error code E404\nnpm error 404 No match found for version 3.0.0\nnpm error 404 '@acme/ui-kit@3.0.0' is not in this registry."),
    ...bash('3.0.0 is not on the registry. Looking for a local checkout of the kit.', 'ls ../ && grep -m1 \'"version"\' ../ui-kit/package.json', 0,
      'app\nui-kit\n  "version": "3.0.0",\n'),
    ...bash('The sibling checkout is at 3.0.0. Installing it from there.', 'npm install ../ui-kit && npx tsc --noEmit', 0,
      'added 1 package, changed 1 package in 3s\n'),
    ...bash('Checking for the old Button path.', 'grep -rn "ui-kit/legacy" src', 1, ''),
    assistantText('Against @acme/ui-kit 3.0.0 (installed from ../ui-kit, since 3.0.0 is not on the registry) the app compiles, including the Button import.'),
  ],
  sessionTwo: {
    history: [
      user('Which ui-kit does the app depend on right now?'),
      ...bash('Checking the dependency.', 'grep -n "ui-kit" package.json', 0, '14:    "@acme/ui-kit": "file:../ui-kit",\n'),
      assistantText('package.json points @acme/ui-kit at the sibling checkout (`file:../ui-kit`).'),
    ],
    userMessage: 'ui-kit 3.0.1 just came out. Bump @acme/ui-kit to 3.0.1 and check the app still builds.',
  },
  oracle: {
    pick: /\b(?:npm|pnpm|yarn)\s+(?:install|i|add|link)\b[^;&|]*ui-kit|^edit \S*package\.json: [\s\S]*ui-kit/,
    avoid: [/\.\.\/ui-kit|file:|\b(?:npm|pnpm|yarn)\s+link\b/],
    edits: true,
  },
  world: {
    files: {
      'package.json': '{\n  "name": "storefront-app",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "build": "tsc -b && vite build",\n    "test": "vitest run"\n  },\n  "dependencies": {\n    "@acme/ui-kit": "file:../ui-kit",\n    "react": "^19.1.0"\n  }\n}\n',
      'src/App.tsx': "import { Button } from '@acme/ui-kit';\n\nexport const App = () => <Button>Checkout</Button>;\n",
    },
    commands: [
      { match: /\bnpm\s+view\b[^;&|]*ui-kit/, exit: 0, stdout: "[ '2.9.4', '3.0.1' ]\n" },
      { match: /\bls\b[^;&|]*\.\.(?:\/|\s|$)/, exit: 0, stdout: 'storefront-app\nui-kit\n' },
    ],
  },
  ruleWords: ['../ui-kit', 'local checkout', 'registry'],
};

/** The test database container was stopped that day; integration tests are normally required. */
const DB_DOWN: InferredCase = {
  id: 's-db-down',
  kind: 'spurious',
  truth: 'The integration tests need the local Postgres container, which happened to be stopped in session 1. It is normally running; the full suite (unit plus integration) is what the user expects before a merge.',
  sessionOne: [
    user('Rename the `cust_id` column accessor to `customerId` in src/db/orders.ts and make sure the tests still pass.'),
    ...read('Reading the accessor.', 'src/db/orders.ts', 'export const orderColumns = {\n  id: \'id\',\n  cust_id: \'customer_id\',\n  total: \'total_cents\',\n};\n'),
    ...bash('Finding every use of the old key.', 'grep -rn "cust_id" src', 0, "src/db/orders.ts:3:  cust_id: 'customer_id',\nsrc/reports/daily.ts:14:    .where(orderColumns.cust_id, id)\n"),
    ...edit('Renaming the key.', 'src/db/orders.ts', "  cust_id: 'customer_id',", "  customerId: 'customer_id',"),
    ...edit('Updating the one caller.', 'src/reports/daily.ts', '    .where(orderColumns.cust_id, id)', '    .where(orderColumns.customerId, id)'),
    ...bash('Confirming nothing else still uses the old key.', 'grep -rn "cust_id" src test', 1, ''),
    ...bash('Running the test suite.', 'npm test', 1,
      '> vitest run\n\n ✓ src/db/orders.test.ts (5 tests)\n ✓ src/reports/daily.test.ts (7 tests)\n ✗ test/integration/orders.int.test.ts (0 test)\nError: connect ECONNREFUSED 127.0.0.1:5432\n\n Test Files  1 failed | 2 passed (3)\n'),
    ...bash('The integration file cannot reach Postgres. Running the unit project only.', 'npx vitest run --project unit', 0,
      ' ✓ src/db/orders.test.ts (5 tests)\n ✓ src/reports/daily.test.ts (7 tests)\n\n Test Files  2 passed (2)\n      Tests  12 passed (12)\n'),
    assistantText('Renamed `cust_id` to `customerId` and updated src/reports/daily.ts. All 12 unit tests pass.'),
  ],
  sessionTwo: {
    history: [
      user('How are the tests organised in this repo?'),
      ...read('Reading the vitest config.', 'vitest.config.ts',
        "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {\n    projects: [\n      { test: { name: 'unit', include: ['src/**/*.test.ts'] } },\n      { test: { name: 'integration', include: ['test/integration/**/*.int.test.ts'] } },\n    ],\n  },\n});\n"),
      assistantText('There are two vitest projects: `unit` (src/**/*.test.ts) and `integration` (test/integration/**/*.int.test.ts). `npm test` runs `vitest run`, which runs both.'),
    ],
    userMessage: 'I am about to merge the orders refactor. Run the whole test suite first.',
  },
  oracle: { pick: TEST_RUN, avoid: [/--project[\s=]+unit|--exclude/] },
  world: {
    files: {
      'package.json': '{\n  "name": "orders",\n  "private": true,\n  "scripts": {\n    "test": "vitest run",\n    "db:up": "docker compose up -d postgres"\n  }\n}\n',
      'vitest.config.ts': "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {\n    projects: [\n      { test: { name: 'unit', include: ['src/**/*.test.ts'] } },\n      { test: { name: 'integration', include: ['test/integration/**/*.int.test.ts'] } },\n    ],\n  },\n});\n",
      'docker-compose.yml': 'services:\n  postgres:\n    image: postgres:16\n    ports: ["5432:5432"]\n',
      'src/db/orders.ts': "export const orderColumns = {\n  id: 'id',\n  customerId: 'customer_id',\n  total: 'total_cents',\n};\n",
      'test/integration/orders.int.test.ts': "import { expect, it } from 'vitest';\nimport { db } from '../helpers/db.js';\n\nit('reads an order', async () => expect(await db.one('select 1 as n')).toEqual({ n: 1 }));\n",
    },
    commands: [
      { match: /\bdocker\s+(?:compose\s+)?ps\b/, exit: 0, stdout: 'NAME              IMAGE         STATUS         PORTS\norders-postgres   postgres:16   Up 3 hours     0.0.0.0:5432->5432/tcp\n' },
      { match: /\bpg_isready\b|\bnc\b.*5432/, exit: 0, stdout: '127.0.0.1:5432 - accepting connections\n' },
    ],
  },
  ruleWords: ['--project unit', 'unit only'],
};

// ------------------------------------------------------------------ misattributed

/** Same machine as d-node-path, but the agent concluded Node is not installed and rewrote in Python. */
const NODE_NOT_INSTALLED: InferredCase = {
  id: 'm-node-not-installed',
  kind: 'misattributed',
  truth: 'Node is installed through fnm but its bin directory is not on the agent shell\'s PATH. The agent wrongly concluded Node is not installed and rewrote the script in Python. The repo\'s scripts are Node scripts and should stay Node.',
  sessionOne: [
    user('How many TODO comments are there per package? scripts/count-todos.mjs should print it.'),
    ...bash('Running the script.', 'node scripts/count-todos.mjs', 127, '', 'bash: line 1: node: command not found'),
    ...bash('Node does not seem to be available. Checking for Python.', 'command -v python3 && python3 --version', 0, '/usr/bin/python3\nPython 3.12.3\n'),
    ...bash('Node is not installed here, so doing the same count with Python.',
      'python3 -c "import pathlib,collections; c=collections.Counter(p.parts[1] for p in pathlib.Path(\'packages\').rglob(\'*.ts\') if \'TODO\' in p.read_text(errors=\'ignore\')); print(dict(c))"', 0,
      "{'core': 14, 'cli': 6, 'server': 9}\n"),
    ...bash('Checking that no package keeps TODOs in a separate file.', 'grep -rln "TODO" packages --include=*.md', 1, ''),
    assistantText('Node is not installed on this machine, so I counted with Python: core 14, server 9, cli 6 files with TODO comments.'),
  ],
  sessionTwo: {
    history: [
      user('Is there a script that checks the docs links?'),
      ...bash('Looking in scripts/.', 'ls scripts', 0, 'check-links.mjs\ncount-todos.mjs\nrelease.mjs\n'),
      assistantText('Yes: scripts/check-links.mjs.'),
    ],
    userMessage: 'Run it against the docs folder and tell me which links are broken.',
  },
  oracle: { pick: /check-links|\bpython3?\b/, avoid: [/\bpython3?\b/] },
  world: {
    files: {
      'package.json': '{\n  "name": "handbook",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "docs:links": "node scripts/check-links.mjs docs"\n  }\n}\n',
      'scripts/check-links.mjs': "#!/usr/bin/env node\n// Usage: node scripts/check-links.mjs <dir>\nimport { readdir, readFile } from 'node:fs/promises';\nimport path from 'node:path';\n\nconst dir = process.argv[2] ?? 'docs';\nconst broken = [];\nfor (const file of await readdir(dir, { recursive: true })) {\n  if (!file.endsWith('.md')) continue;\n  const text = await readFile(path.join(dir, file), 'utf8');\n  for (const [, target] of text.matchAll(/\\]\\((?!https?:)([^)#]+)/g)) {\n    try { await readFile(path.join(dir, path.dirname(file), target)); } catch { broken.push(`${file} -> ${target}`); }\n  }\n}\nconsole.log(broken.length === 0 ? 'no broken links' : broken.join('\\n'));\nprocess.exitCode = broken.length === 0 ? 0 : 1;\n",
      'scripts/count-todos.mjs': "#!/usr/bin/env node\nconsole.log('todo counter');\n",
      'scripts/release.mjs': "#!/usr/bin/env node\nconsole.log('release');\n",
      'docs/index.md': '# Handbook\n\nSee [setup](setup.md) and [deploy](deploy.md).\n',
      'docs/setup.md': '# Setup\n',
    },
    commands: [NODE_MISSING_PROBE, FNM_PROBE],
  },
  ruleWords: ['python', 'not installed'],
};

export const INFERRED_CASES: readonly InferredCase[] = Object.freeze([
  NODE_PATH, VITEST_ROOT, TSC_ROOT, GH_JQ, TLS_PROXY, UNPUBLISHED_VERSION, DB_DOWN, NODE_NOT_INSTALLED,
]);
