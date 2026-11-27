# Issue 448: Windows sandbox setup with a late UAC approval

Fixed after `v0.7.97-rc.3`, unreleased. Automated tests cover the session
protocol, the error codes and the setup flow with a stand-in helper. Only a real
desktop can prove the UAC part, so run these steps on Windows before release.

## Contract

- One setup shows at most one UAC prompt, including when it replaces an old
  sandbox account.
- Setup waits up to 10 minutes for consent. The setup steps have their own
  limits, which start after consent.
- A prompt approved after setup gave up does nothing.
- Every failure returns `code` on the activation result, and `error` starts
  with `[code]`.

## Setup

- Windows 10 or 11, a standard user who can approve UAC (or an admin with UAC
  on).
- A KodaX build that contains this fix, with `npm run build:native` run first.
  The helper must come from that script, because it builds in the pinned
  runner hash. A helper built with plain `cargo build` has no pinned hash,
  so setup fails with "built without a pinned sandbox runner hash".
- To force a full setup, set the machine to the state each case names. Run
  `kodax sandbox doctor` before and after each case and keep its output.

## Cases

### 1. Late approval from a background process (the reported case)

1. Start setup from a process that does not own the foreground window. For
   example, start `kodax sandbox setup` from a scheduled task or from Space,
   then click into another window.
2. Confirm that the UAC prompt only flashes in the taskbar. On stderr, setup
   says it is waiting for the prompt.
3. Wait at least 30 s, then click the taskbar entry and approve.

Expected: one prompt, setup succeeds, and doctor reports ready.

### 2. Old sandbox account

1. Use a machine with a sandbox account from an older setup generation. The
   rotation path is the one that used to ask three times.
2. Run setup and approve after at least 30 s.

Expected: exactly one UAC prompt, the account is rotated, and doctor reports
ready with the new SID.

### 3. Dismissed prompt

Run setup and click "No" on the prompt.

Expected: `status: 'cancelled'`, `code: 'elevation_cancelled'`. Nothing is
installed. Running setup again shows the prompt again.

### 4. Consent timeout and a late approval

1. Run setup and leave the prompt alone for more than 10 minutes.
2. After setup returns, approve the prompt if it is still on screen.

Expected: setup returns `code: 'elevation_timeout'`. The late approval starts
nothing that changes the sandbox account or firewall. Doctor output is the same
as before the approval.

### 5. Two setups at once

Start two setups at the same time, for example `kodax sandbox setup` in two
terminals, and approve the one prompt.

Expected: one prompt. The second caller says it is waiting for another setup,
then reports ready without its own prompt.

### 6. Interrupted setup

1. Run setup, approve, and kill the KodaX process while setup is running,
   after the prompt.
2. Run `kodax sandbox doctor`.

Expected: the diagnostic starts with `[windows_setup_interrupted]` and asks
you to run setup again. Running setup again finishes it.

### 7. Busy sandbox account

Leave a sandboxed shell running, then run setup on a machine that needs an
account rotation.

Expected: `code: 'sandbox_account_busy'`, and the message asks you to close
sandboxed shells. No UAC prompt appears.

## Record

For each case, record the Windows build, the number of UAC prompts, the
returned `status` and `code`, and doctor output before and after.
