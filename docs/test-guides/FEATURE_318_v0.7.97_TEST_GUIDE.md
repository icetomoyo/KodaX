# FEATURE_318 CLI, REPL command, help and health redesign — test guide

The Commander tree is the command table; `kodax daemon` is now `kodax host`;
CLI, REPL `/status` and `kodax doctor` share one health model. Decisions:
ADR-082.

## Automated checks

```powershell
npx tsc -p tsconfig.check.json
npx tsc -p tsconfig.test.json
node node_modules/vitest/vitest.mjs run src/cli packages/repl/src/interactive/commands-status.test.ts packages/coding/src/self-knowledge/registry.test.ts tests/interactive.test.ts
npm run build
node --test tests/bundled-daemon-help.test.mjs
```

Run vitest from the repository root; package directories give false failures.
`src/cli/docs-drift.test.ts` fails when README, README_CN or `public_docs/`
show a `kodax …` command or flag that the tree does not have.

## Manual eval (needs provider keys; spends calls)

```powershell
npx tsx benchmark/manual-commands.eval.ts
```

Layer 3: when the model asks the manual again, the same arm's manual answers,
at most 3 calls per cell. 2026-11-24, glm-5.3-flash and deepseek-flash, one
sample: the new manual won 6 of 8 blind pairs, none worse; recommend-ship.

## Manual checklist

Use a scratch `KODAX_HOME` so a running Host is not disturbed.

1. **Status when stopped.** `kodax host status` prints `stopped` and exits 3;
   `kodax host status --json` prints `health: "stopped"`.
2. **Restart starts.** With no Host running, `kodax host restart` starts one;
   `kodax host status` then prints `ready` and exits 0.
3. **Probe does not count.** While a REPL is attached, `kodax host status --json`
   lists the REPL under `clients` and not itself; the Host's idle timer is not
   reset by repeated status calls.
4. **Old name.** `kodax daemon status` behaves like `kodax host status` and
   prints one rename notice to stderr.
5. **Logs.** `kodax host logs --lines 20` works with the Host stopped;
   `--follow` keeps printing across a log rotation until Ctrl+C;
   `--follow --json` is refused.
6. **Doctor.** `kodax doctor` shows a Host line; it exits 0 with the Host
   stopped and 1 when the Host is `unreachable` or the core config is not
   valid JSON.
7. **Text and JSON.** `kodax mcp list` prints text; `kodax mcp list --json`
   prints the old JSON.
8. **Usage errors exit 2.** `kodax nosuchcmd`, `kodax --nosuchflag`, `kodax -n`
   (names the replacement), `kodax -h nosuchtopic`.
9. **Sessions.** `kodax sessions list` and the old `kodax -s list` (one stderr
   notice) give the same list; `kodax sessions list --json` is machine-readable.
10. **REPL.** `/help` groups commands by category; `/thinking` and `/t` run
    `/reasoning`; `/repointel` and `/plan` say what to use instead; `/reasoning`
    help lists `off`.
11. **Completion.** `kodax completion bash` (and `zsh`, `fish`) completes
    `host pair`, `sessions cleanup-acp` and `--permission-mode` values, and no
    longer offers `--extension`.
