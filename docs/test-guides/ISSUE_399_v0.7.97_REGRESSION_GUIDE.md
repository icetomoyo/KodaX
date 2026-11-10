# Issue 399: replaced profile files and degraded setup directories

Repaired 2026-11-10 on v0.7.97-beta.4 (unreleased).

## Contract

Only profile directories are setup-owned. A top-level profile file that another
program replaced by rename gets its sandbox ACEs back at the next admission. The
interactive startup setup check ignores files. A setup-owned directory with
missing ACEs leaves only that directory unreadable for the command. The command
stays sandboxed and the directory is reported in `applied.degradedReadRoots`.
When a write root of the command reaches that directory, admission still fails
with `windows_v2_setup_required` and never degrades. Host fallback and degraded
directories appear as one footer line driven by `ClientSessionView.sandbox`.
That view field is pushed only when the state changes.

## Automated checks

```powershell
cargo test --manifest-path native/windows-sandbox-v2/Cargo.toml --locked setup_owned
npx vitest run src/sandbox-runtime.test.ts -t "degraded for one command"
npx vitest run src/session-view.test.ts -t "sandbox health"
npx vitest run packages/repl/src/ui/view-models/surface-chrome.test.ts
npm run typecheck
npm run build:native
```

The native file-root test failed while files were still treated as
setup-owned. The other native tests and the TS tests failed before the change.

## Manual acceptance (Windows, after `npm run build`)

1. Start `kodax`, run `whoami` through Bash, and confirm the sandbox account.
2. Replace `~/.claude.json` by rename in another shell:
   `Copy-Item ~/.claude.json $env:TEMP\c.json; Move-Item -Force $env:TEMP\c.json ~/.claude.json`.
   `icacls ~/.claude.json` now shows only `(I)` ACEs.
3. Run `whoami` again in the same session. It must still report the sandbox
   account. `icacls` shows the explicit sandbox ACEs again, and the footer
   shows no sandbox notice.
4. For a degraded directory, use a throwaway directory that setup already
   covers, such as `~/kodax-399-probe` created before `kodax sandbox setup`.
   Remove and recreate it, then run `dir ~/kodax-399-probe` through Bash.
   The command runs sandboxed, the listing is denied, and the footer shows
   `Sandbox cannot read kodax-399-probe; run kodax sandbox setup` once.
   More commands do not add transcript lines.
5. Run `kodax sandbox setup`, then a new Bash call. The footer line clears.
