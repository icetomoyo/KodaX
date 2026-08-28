# ISSUE_325 v0.7.96-alpha.2 Regression Guide

> Regression guard for Issue 325: Windows exit settlement crash after the
> FEATURE_295 helper cleanup. Fixed in `v0.7.96-alpha.2` (commit restoring
> `windowsAclPowerShellExecutable()` in `src/sandbox-runtime.ts`).

## Background

The FEATURE_295 cleanup deleted `windowsAclPowerShellExecutable()` together
with its old ACL-doctor test path but missed its remaining caller in
`readWindowsBootIdentity()`. On `v0.7.96-alpha.1`, every Windows exit
settlement crashed with:

```
ReferenceError: windowsAclPowerShellExecutable is not defined
```

Sandbox cleanup could then only be reported as `unverified`. The bug shipped
to npm because `src/` is bundled transpile-only (esbuild) and no CI gate
type-checks the runner sources.

## Scope

- Platform: Windows only (the probe is guarded by `process.platform === 'win32'`).
- Entry: any path that triggers Windows exit settlement / boot-identity
  comparison (`src/runtime-daemon/exit-settlement.ts` callers of
  `readWindowsSandboxBootIdentity()`).

## Automated Coverage

`src/sandbox-runtime.test.ts` → `describe.runIf(process.platform === 'win32')`
"Windows boot identity resolution":

1. Creates a fake `PowerShell/7/pwsh.exe` under a temp `ProgramFiles`.
2. Calls `readWindowsSandboxBootIdentity()` and asserts the identity resolves.
3. Asserts the probe invoked the fake `pwsh` with `-EncodedCommand`.

Run from the repo root (Node via fnm):

```bash
npx vitest run src/sandbox-runtime.test.ts -t "Windows boot identity resolution"
```

RED check already performed at fix time: reverting only the helper
(`git stash push -- src/sandbox-runtime.ts`) makes this test fail with the
exact `ReferenceError`.

## Manual Regression Steps

1. Install/use `@kodax-ai/kodax@0.7.96-alpha.2` on Windows.
2. Run any sandboxed session (e.g. a short `kodax` REPL task) and exit
   normally.
3. Confirm the exit settlement log shows the boot-identity comparison
   completing — no `ReferenceError`, and cleanup verification no longer ends
   in `unverified` caused by this crash.
4. Reboot Windows (or otherwise change `LastBootUpTime`) and repeat: the
   boot identity changes across boots, and settlement still completes.

## Pass Criteria

- No `windowsAclPowerShellExecutable is not defined` in any Windows log.
- Exit settlement completes with a verified-or-explicitly-reasoned cleanup
  outcome (not a crash path).
- On machines with PowerShell 7 and machines with only Windows PowerShell
  5.1, the probe resolves an executable in both cases.
