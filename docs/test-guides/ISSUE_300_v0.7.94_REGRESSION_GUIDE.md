# Issue 300 / v0.7.94 Sandboxed Git Trust Regression Guide

## Automated gates

Run:

```text
npx vitest run -c tests/config/vitest.system.config.ts src/sandbox-runtime.test.ts
npx vitest run packages/coding/src/tools/edit.test.ts
npx vitest run packages/coding/src/tools/worktree.test.ts
npx vitest run -c tests/config/vitest.system.config.ts src/sdk-runtime.test.ts -t "starts a Run without a text sandbox"
```

Required assertions:

1. The public v4 capability reports `gitSafeDirectory: 'authorized-repo-roots'`.
2. Windows git trust never emits `safe.directory=*`, even when no authorized
   root survives, and rejects malformed `GIT_CONFIG_*` shapes.
3. The eight-root budget keeps cwd and repo-bearing read grants ahead of
   ordinary write roots. Read-authorized roots outside write grants are
   trusted when the permission review admitted them.
4. Linked-worktree metadata must prove `commondir` / `gitdir` backlinks
   before the main `.git` receives a read ACE. Submodules must prove
   `core.worktree`. Arbitrary real `.git` targets stay untrusted.
   Relationship files are read through strict byte bounds. Helper stdin
   failures reject only the text-mutation operation.
5. Broker and bundled rewriting share one implementation; the production
   minified broker still applies the same trust set.
6. A missing workspace directory starts a Runtime Run without attaching the
   concurrent text-mutation sandbox instead of aborting option construction.

## Windows manual acceptance

1. Open a linked worktree whose main `.git` is outside the session write
   grants. From the sandboxed shell, `git status` and `git -C <main> status`
   must not fail with `detected dubious ownership`.
2. Repeat in a home-directory workspace that expands past eight write roots.
   `GIT_CONFIG_*` must list exact authorized roots, never `safe.directory=*`.
3. Start an idle Runtime, launch a long-running Bash command, and edit a
   workspace file. The edit must complete without waiting for the shell to
   exit. A hard-linked workspace target must be rejected.
4. Schedule a daemon stop whose cleanup fails. The public stop must report
   the failed shutdown outcome rather than a safe stop.

## v0.7.95 dynamic-worktree follow-up

Run:

```text
npx vitest run packages/coding/src/tools/worktree.test.ts packages/repl/src/interactive/storage.test.ts
npx vitest run -c tests/config/vitest.system.config.ts src/sandbox-runtime.test.ts -t "shares a newly registered workspace root"
npx vitest run -c tests/config/vitest.system.config.ts src/sdk-runtime.test.ts -t "migrates only Session-proven legacy worktrees"
npx vitest run -c tests/config/vitest.system.config.ts src/sdk-runtime.test.ts -t "registers a linked worktree created from a submodule Session root"
```

Required assertions:

1. Worktree creation validates, canonicalizes, and durably registers the root
   before returning it. Persistence failure rolls the worktree and branch back.
2. Background Bash and direct text mutations read the same Session policy in
   the creating Run, a later Run, and after Runtime restart.
3. Junction/symlink aliases, including a missing new target below an alias,
   resolve to the registered canonical root. A copied `.git` file or an
   arbitrary sibling does not gain trust.
4. Worktree removal captures and revokes the canonical root even when removal
   was requested through an alias. The former path is no longer authorized.
5. Session metadata mutation is serialized with ordinary Session saves, and a
   stale host snapshot cannot restore a root that was explicitly revoked.
6. A pre-correction Session with no registry field migrates only paths found in
   retained successful `worktree_create` results from messages or UI history
   and still passing the full Git relationship check. A successful retained
   remove is a tombstone; forged results and same-named siblings are rejected.
7. A Session rooted in a real Git submodule can register a linked worktree
   created from that submodule. The Session root must prove its bounded
   `.git/modules/...` `core.worktree` backlink, while the candidate still proves
   the ordinary linked-worktree `gitdir` / `commondir` backlinks.

Windows manual acceptance:

1. With a current v0.7.95 build, create a linked worktree through the KodaX
   worktree tool and start a background service inside it.
2. In the same and then a later turn, edit an existing file and create a new
   file in that worktree. Neither operation may report an active model
   filesystem effect.
3. Restart the Runtime and repeat the edits using the same Session. They must
   still succeed without replaying worktree creation.
4. Confirm an unrelated sibling remains fenced, then remove the registered
   worktree through KodaX and confirm the old root is no longer authorized.
5. A pre-correction Session with retained `worktree_create` evidence migrates
   automatically on its next Run. If that exact evidence is unavailable, stop
   the background process and remove/recreate the worktree through KodaX once.
   Do not delete ProgramData coordination files.
6. Repeat creation and text mutation from a Session whose workspace is a real
   Git submodule; the linked worktree must join the same policy, while a copied
   or forged submodule `.git` file remains rejected.
