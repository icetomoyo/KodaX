/**
 * Tasks for the RepoIntel v2 task A/B (benchmark/repo-intel-task-ab.eval.ts).
 * Each task runs end to end through the managed Runtime on a committed snapshot of this repository, once with
 * the Host's v2 engine (find_symbol, file_outline, the Repository Map) and once without; nothing else differs.
 * Every task is graded by a program: the type checker, tests the model never sees, or an exact caller list.
 * Prompts, planted bugs, hidden checks and the truth are pre-registered here, before any provider call.
 */

export type AbTaskId = 'T1' | 'T2' | 'T3' | 'T4';

export interface AbTask {
  readonly id: AbTaskId;
  readonly prompt: string;
  /** A bug written into this task's baseline commit. */
  readonly plant?: { readonly file: string; readonly from: string; readonly to: string };
  /** Files written after the run, before grading. */
  readonly hidden: readonly { readonly path: string; readonly content: string }[];
  /** A package tsconfig that must type-check with the hidden files in place. */
  readonly tsconfig?: string;
  /** Test files that must pass. */
  readonly tests: readonly string[];
  /** Exact caller files the answer must list, for a question task. */
  readonly callers?: readonly string[];
}

const T1_CHECK = `import type { KodaXToolExecutionContext } from '../../types.js';
import { writeTextFileForMutation, type TextFileMutationSnapshot } from './text-file-mutation.js';

type Options = Parameters<typeof writeTextFileForMutation>[2];

export async function abSignatureCheck(snapshot: TextFileMutationSnapshot, ctx: KodaXToolExecutionContext, receipt: Options['undoReceipt']): Promise<void> {
  await writeTextFileForMutation(snapshot, ctx, { content: 'after' });
  await writeTextFileForMutation(snapshot, ctx, { content: 'after', createParentDirectories: true, backupContent: 'before', undoReceipt: receipt });
  // @ts-expect-error the positional form is gone
  await writeTextFileForMutation(snapshot, 'after', false, ctx);
}
`;

const T2_TEST = `import { expect, it } from 'vitest';
import { isToolCallAllowed } from './permission.js';

it('a headless prefix rule matches only its own leading words', async () => {
  const rules = ['Bash(git commit:*)'];
  expect(await isToolCallAllowed('bash', { command: 'git push --force' }, rules)).toBe(false);
  expect(await isToolCallAllowed('bash', { command: 'npm commit' }, rules)).toBe(false);
  expect(await isToolCallAllowed('bash', { command: 'git commit -m fix' }, rules)).toBe(true);
  expect(await isToolCallAllowed('bash', { command: 'git commit' }, rules)).toBe(true);
});
`;

const T4_TEST = `import { expect, it } from 'vitest';
import type { MessagePriority } from '../index.js';
import { MessageQueue } from './queue.js';

it('urgent drains ahead of user and within a user ceiling', () => {
  const urgent: MessagePriority = 'urgent';
  const queue = new MessageQueue();
  queue.enqueue({ priority: 'background', mode: 'prompt', content: 'b' });
  queue.enqueue({ priority: 'user', mode: 'prompt', content: 'u' });
  queue.enqueue({ priority: urgent, mode: 'prompt', content: 'x' });
  expect(queue.dequeue({ maxPriority: 'urgent' }).map(message => message.content)).toEqual(['x']);
  queue.enqueue({ priority: urgent, mode: 'prompt', content: 'y' });
  expect(queue.dequeue({ maxPriority: 'user' }).map(message => message.content)).toEqual(['y', 'u']);
  expect(queue.dequeue({ maxPriority: 'background' }).map(message => message.content)).toEqual(['b']);
});
`;

// Revision r1 left this out: deepseek-flash ran vitest inside packages/coding, met the repository's known
// package-directory failures and spent about half of its 40 turns on them, so the cell measured the environment.
const TEST_NOTE = ' Run vitest and tsc from the repository root, for example `npx vitest run <test file>`. '
  + 'Inside a package directory vitest fails to load files for reasons unrelated to this task.';

export const TASKS: readonly AbTask[] = [
  {
    id: 'T1',
    prompt: 'Refactor writeTextFileForMutation in the coding package so that it takes `(snapshot, ctx, options)`, where options is '
      + '`{ content: string; createParentDirectories?: boolean; backupContent?: string; undoReceipt?: <the receipt type it takes today> }` '
      + 'and createParentDirectories defaults to false. Update every caller, tests included, so that the coding package type-checks and its tests pass.' + TEST_NOTE,
    hidden: [{ path: 'packages/coding/src/tools/_internal/ab-signature-check.ts', content: T1_CHECK }],
    tsconfig: 'packages/coding/tsconfig.json',
    tests: [
      'packages/coding/src/tools/_internal/text-file-mutation.test.ts', 'packages/coding/src/tools/edit.test.ts',
      'packages/coding/src/tools/multi-edit.test.ts', 'packages/coding/src/tools/undo.test.ts',
    ],
  },
  {
    id: 'T2',
    prompt: 'Bug report: on a headless SDK Host, where no Bash prefix extractor is configured, an always-allow rule `Bash(git commit:*)` '
      + 'also lets `git push --force` run without asking for permission. Find the cause and fix it.' + TEST_NOTE,
    plant: {
      file: 'packages/coding/src/permissions/permission.ts',
      from: 'tokens.every((token, index) => stage.argv[index] === token)',
      to: 'tokens.some((token, index) => stage.argv[index] === token)',
    },
    hidden: [{ path: 'packages/coding/src/permissions/ab-hidden.test.ts', content: T2_TEST }],
    tsconfig: 'packages/coding/tsconfig.json',
    tests: ['packages/coding/src/permissions/ab-hidden.test.ts', 'packages/coding/src/permissions/permission.test.ts'],
  },
  {
    id: 'T3',
    prompt: 'Which non-test source files call the getImpactEstimate function defined in packages/coding/src/repo-intelligence/runtime.ts? '
      + 'Other files define functions with the same name; count only calls to this one, and ignore *.test.ts files. Do not change any code. '
      + 'End your answer with a line `CALLERS:` followed by one repository-relative file path per line.',
    hidden: [],
    tests: [],
    callers: [
      'packages/coding/src/agent-runtime/middleware/repo-intelligence.ts',
      'packages/coding/src/repo-intelligence/runtime.ts',
      'packages/coding/src/task-engine/_internal/managed-task/repo-intelligence.ts',
      'packages/coding/src/tools/impact-estimate.ts',
      'packages/coding/src/tools/relationship-scan.ts',
    ],
  },
  {
    id: 'T4',
    prompt: 'Add a third message priority, \'urgent\', to the agent package\'s message queue. Urgent messages drain ahead of \'user\' ones, '
      + 'and a drain whose ceiling is \'user\' still includes them. Update every place that handles message priorities so that \'urgent\' '
      + 'is treated sensibly, and keep the existing behavior of \'user\' and \'background\'.' + TEST_NOTE,
    hidden: [{ path: 'packages/agent/src/messaging/ab-hidden.test.ts', content: T4_TEST }],
    tsconfig: 'packages/agent/tsconfig.json',
    tests: [
      'packages/agent/src/messaging/ab-hidden.test.ts', 'packages/agent/src/messaging/queue.test.ts',
      'packages/agent/src/messaging/drain.test.ts',
    ],
  },
];
