/**
 * FEATURE_308 note-line experiment: which sessions the reflection prompt sees.
 *
 * The question is whether the reflection job writes index lines that say what to
 * do, keeps the way that worked instead of the failure, and leaves one-off
 * workarounds out, without losing the notes it already writes well.
 *
 * Cases come from three places:
 *   - the 13 reflection regression cases (feature-308-reflect), scored by their own oracles;
 *   - session 1 of the 8 inferred-lesson cases (feature-308-inferred), modelled on
 *     recoveries mined from the owner's agent session logs;
 *   - 4 held-out sessions written for this experiment, modelled on the same logs
 *     (paraphrased, no log text copied). Their wording is not echoed by the prompt
 *     examples, so they show whether the guidance generalises.
 *
 * Case data only. Editing anything here changes the case hash recorded by prepare.
 */
import type { KodaXMessage } from '@kodax-ai/llm';

import { assistantCall, assistantText, toolResult, user } from '../feature-308-baseline/cases.js';
import { INFERRED_CASES } from '../feature-308-inferred/cases.js';
import { FEATURE_308_REFLECT_CASES, type ReflectCase } from '../feature-308-reflect/cases.js';

/** What a good reflection does with the session; drives the mechanical diagnostics only. */
export type Expectation =
  /** A durable lesson: a note that carries `terms` should appear. */
  | { readonly kind: 'lesson'; readonly terms: readonly string[] }
  /** A one-off failure: the right outcome is no note. */
  | { readonly kind: 'nothing' }
  /** The user stated a rule: an active note carrying `terms` should appear. */
  | { readonly kind: 'user-rule'; readonly terms: readonly string[] }
  /** A wrong conclusion the agent reached: a note carrying `wrong` is harm. */
  | { readonly kind: 'misread'; readonly wrong: readonly string[] }
  /** A regression case scored by the feature-308-reflect oracle. */
  | { readonly kind: 'reflect' };

export interface NoteLineCase {
  readonly id: string;
  readonly source: 'reflect' | 'inferred' | 'held-out';
  readonly family: string;
  readonly messages: readonly KodaXMessage[];
  readonly seeds: ReflectCase['seeds'];
  readonly expect: Expectation;
  /** Present for reflect cases, whose own oracle scores them. */
  readonly reflectCase?: ReflectCase;
}

function shell(command: string, exit: number, stdout: string, stderr = ''): string {
  return `Command: ${command}\nExit: ${exit}\n${stdout}${stderr.length > 0 ? `\n[stderr]\n${stderr}` : ''}`;
}

let callCounter = 0;
function bash(intro: string, command: string, exit: number, stdout: string, stderr = ''): KodaXMessage[] {
  callCounter += 1;
  const id = `toolu_nl_bash_${callCounter}`;
  return [assistantCall(intro, id, 'bash', { command, description: intro }), toolResult(id, shell(command, exit, stdout, stderr))];
}

/** `python` is not on PATH, `python3` is; the repo's scripts are Python 3. */
const PYTHON3: NoteLineCase = {
  id: 'h-python3',
  source: 'held-out',
  family: 'failure whose fix is a durable practice (command name)',
  expect: { kind: 'lesson', terms: ['python3'] },
  seeds: [],
  messages: [
    user('How many TODO comments are left in src, per file? Sort by count.'),
    ...bash('Running the repo\'s TODO report script.', 'python scripts/todo_report.py src --by-file', 127, '', 'bash: line 1: python: command not found'),
    ...bash('Checking which Python interpreters exist.', 'command -v python3 && python3 --version', 0, '/usr/bin/python3\nPython 3.12.3\n'),
    ...bash('Running the script with python3.', 'python3 scripts/todo_report.py src --by-file', 0, '9  src/sync/queue.ts\n4  src/api/client.ts\n2  src/cli/main.ts\n'),
    ...bash('Checking for FIXME markers the script does not count.', 'grep -rn "FIXME" src', 1, ''),
    assistantText('15 TODOs remain: src/sync/queue.ts has 9, src/api/client.ts 4 and src/cli/main.ts 2. There are no FIXME markers.'),
  ],
};

/** A TLS handshake that failed once; the identical retry worked. */
const TLS_RETRY: NoteLineCase = {
  id: 'h-tls-retry',
  source: 'held-out',
  family: 'transient network failure, plain retry',
  expect: { kind: 'nothing' },
  seeds: [],
  messages: [
    user('Push my branch fix/retry-backoff and open a draft PR against main.'),
    ...bash('Pushing the branch.', 'git push -u origin fix/retry-backoff', 128, '',
      "fatal: unable to access 'https://github.com/acme/uploader.git/': schannel: failed to receive handshake, SSL/TLS connection failed"),
    ...bash('The TLS handshake failed. Trying once more.', 'git push -u origin fix/retry-backoff', 0, '',
      "To https://github.com/acme/uploader.git\n * [new branch]      fix/retry-backoff -> fix/retry-backoff\nbranch 'fix/retry-backoff' set up to track 'origin/fix/retry-backoff'."),
    ...bash('Opening the draft PR.', 'gh pr create --draft --base main --fill', 0, 'https://github.com/acme/uploader/pull/88\n'),
    assistantText('Pushed fix/retry-backoff and opened draft PR #88 against main: https://github.com/acme/uploader/pull/88'),
  ],
};

/** The npm registry had a brief outage; the agent switched to an unapproved mirror. */
const REGISTRY_503: NoteLineCase = {
  id: 'h-registry-503',
  source: 'held-out',
  family: 'transient outage worked around with a risky substitute',
  expect: { kind: 'nothing' },
  seeds: [],
  messages: [
    user('Install the dependencies and run the unit tests, I just cloned this.'),
    ...bash('Installing from the lockfile.', 'npm ci', 1, '',
      'npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/zod/-/zod-3.23.8.tgz'),
    ...bash('The public registry returned 503. Installing from a mirror instead.', 'npm ci --registry=https://registry.npmmirror.com', 0,
      'added 412 packages, and audited 413 packages in 21s\n\nfound 0 vulnerabilities\n'),
    ...bash('Running the unit tests.', 'npm test', 0, '> uploader@1.4.0 test\n> vitest run\n\n Test Files  18 passed (18)\n      Tests  164 passed (164)\n'),
    assistantText('Dependencies are installed and all 164 unit tests pass. The public npm registry returned 503 at first, so I installed from the npmmirror.com mirror.'),
  ],
};

/** The user corrects the package manager in Chinese. */
const ZH_NPM: NoteLineCase = {
  id: 'h-zh-npm',
  source: 'held-out',
  family: 'user correction stated in Chinese',
  expect: { kind: 'user-rule', terms: ['npm'] },
  seeds: [],
  messages: [
    user('把 lodash 升级到最新版本，然后跑一下测试。'),
    ...bash('升级 lodash。', 'pnpm add lodash@latest', 0, 'Packages: +1 -1\nProgress: resolved 389, reused 388, downloaded 1, added 1, done\n\ndependencies:\n- lodash 4.17.20\n+ lodash 4.17.21\n'),
    assistantText('已用 pnpm 把 lodash 升级到 4.17.21，接下来跑测试。'),
    user('别用 pnpm，这个仓库只用 npm。把 pnpm-lock.yaml 删掉，用 npm 重新装。'),
    ...bash('删除 pnpm 的锁文件并用 npm 安装。', 'rm pnpm-lock.yaml && npm install lodash@latest', 0, 'changed 1 package, and audited 390 packages in 4s\n\nfound 0 vulnerabilities\n'),
    ...bash('运行测试。', 'npm test', 0, '> app@2.0.0 test\n> vitest run\n\n Test Files  31 passed (31)\n      Tests  277 passed (277)\n'),
    assistantText('已删除 pnpm-lock.yaml，用 npm 安装了 lodash 4.17.21，31 个测试文件全部通过。'),
  ],
};

/** The hyphenated Compose v1 binary is gone; the `docker compose` plugin works. Added in r3, after h-python3 shaped the wording. */
const COMPOSE_V2: NoteLineCase = {
  id: 'h-compose-v2',
  source: 'held-out',
  family: 'failure whose fix is a durable practice (subcommand form)',
  expect: { kind: 'lesson', terms: ['docker compose'] },
  seeds: [],
  messages: [
    user('Start the local stack and check that the api container answers on /health.'),
    ...bash('Starting the stack.', 'docker-compose up -d', 127, '', 'bash: line 1: docker-compose: command not found'),
    ...bash('Checking whether the Compose plugin is available.', 'docker compose version', 0, 'Docker Compose version v2.29.1\n'),
    ...bash('Starting the stack with the plugin.', 'docker compose up -d', 0, '',
      ' Container shop-db-1  Started\n Container shop-api-1  Started\n'),
    ...bash('Checking the health endpoint.', 'curl -s localhost:8080/health', 0, '{"status":"ok"}\n'),
    assistantText('The stack is up (db and api) and /health returns {"status":"ok"}.'),
  ],
};

/** TypeScript is a local dev dependency, so bare `tsc` is not on PATH but `npx tsc` works. Added in r3. */
const NPX_TSC: NoteLineCase = {
  id: 'h-npx-tsc',
  source: 'held-out',
  family: 'failure whose fix is a durable practice (local binary)',
  expect: { kind: 'lesson', terms: ['npx'] },
  seeds: [],
  messages: [
    user('Does the project typecheck after my rename of OrderLine to LineItem?'),
    ...bash('Typechecking.', 'tsc --noEmit', 127, '', 'bash: line 1: tsc: command not found'),
    ...bash('Looking for a local TypeScript.', 'ls node_modules/.bin | grep -x tsc && npx tsc --version', 0, 'tsc\nVersion 5.6.3\n'),
    ...bash('Typechecking with the local compiler.', 'npx tsc --noEmit', 0, ''),
    assistantText('Yes, the project typechecks cleanly after the rename (npx tsc --noEmit reports no errors).'),
  ],
};

const HELD_OUT: readonly NoteLineCase[] = [PYTHON3, TLS_RETRY, REGISTRY_503, ZH_NPM, COMPOSE_V2, NPX_TSC];

const INFERRED_EXPECT: Readonly<Record<string, Expectation>> = {
  'd-node-path': { kind: 'lesson', terms: ['fnm', 'PATH', 'node-versions'] },
  'd-vitest-root': { kind: 'lesson', terms: ['root'] },
  'd-tsc-root': { kind: 'lesson', terms: ['tsconfig.check.json'] },
  'd-gh-jq': { kind: 'lesson', terms: ['--jq'] },
  's-tls-proxy': { kind: 'nothing' },
  's-unpublished-version': { kind: 'nothing' },
  's-db-down': { kind: 'nothing' },
  'm-node-not-installed': { kind: 'misread', wrong: ['python', 'not installed'] },
};

export const NOTELINE_CASES: readonly NoteLineCase[] = Object.freeze([
  ...FEATURE_308_REFLECT_CASES.map((item): NoteLineCase => ({
    id: item.id, source: 'reflect', family: item.family, messages: item.messages, seeds: item.seeds, expect: { kind: 'reflect' }, reflectCase: item,
  })),
  ...INFERRED_CASES.map((item): NoteLineCase => ({
    id: item.id, source: 'inferred', family: `${item.kind} recovery`, messages: item.sessionOne, seeds: [], expect: INFERRED_EXPECT[item.id]!,
  })),
  ...HELD_OUT,
]);
