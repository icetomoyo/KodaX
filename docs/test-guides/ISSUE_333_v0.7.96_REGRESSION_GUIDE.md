# Issue 333: Windows SSH ACL regression guide

Status: implemented in the working tree; not released. The final scope follows
Codex profile and SSH dependency ACL exclusions, preserving ordinary home/tool
reads and KodaX fixed ACL/token concurrency. The earlier all-external-ACL
immutability proposal is superseded.

## Automated verification

Run on Windows with Rust, Node, and the optional Windows OpenSSH Client component
installed (System32/OpenSSH/ssh-keygen.exe). Use an unrestricted host terminal:
creating a restricted token from an already restricted tool sandbox can fail.

```powershell
cargo test --offline --manifest-path native/windows-sandbox-v2/Cargo.toml
npx vitest run src/windows-sandbox-read-policy.test.ts src/windows-sandbox-v2.test.ts src/sandbox-runtime.test.ts
npm run typecheck
npm run build:native
```

The native suite includes real NTFS owner/DACL/control comparisons, inherited
and explicit SSH ACE cleanup, an actual disposable OpenSSH private key that is
rejected before cleanup and accepted afterward, junction handling, same-root
concurrent read/write, warm read-only admission, token creation, IPC and Job
lifecycle regression tests. No real user SSH file is touched. The old ignored
all-external-path test has been replaced with the accepted SSH exclusion
contract; it is now enabled.

TypeScript tests cover Codex-compatible profile exclusions, SSH Include and
IdentityFile references, preserved broad home reads/private Temp behavior,
generation-10 cleanup including explicit key files, preservation of old cleanup
identity after an interrupted account-rotation migration, and existing active
account generation-8/9 upgrades. Platform-specific skips in the existing suite
must be reported separately from passes.

## Installed-build acceptance

Use a disposable Windows user or VM; the account/setup integration tests above
mock provisioning and do not constitute a complete ASRT/WFP machine upgrade.

1. Start with the affected build and a disposable SSH config/key. Confirm the
   host SSH error, and record owner/DACL. Include a custom IdentityFile outside
   .ssh but inside the profile, and an Include configuration file.
2. Upgrade and run `kodax sandbox setup` with old sandbox commands closed.
   Confirm generation 11 and host SSH/config/private-key use. User-owned ACEs,
   owner and inheritance settings must remain intact.
3. Repeat setup and CLI startup: SSH remains usable, the account is reused,
   and normal command admission does not perform migration or elevate.
4. Run PowerShell pipelines, Node child-process pipes, Git/linked worktrees,
   concurrent read/write commands on one workspace, and cancel a running child.
   Existing network enforcement and child cleanup must still work.
5. Check a profile with junctions and a migration interrupted after account
   rotation. Junction targets must not be modified; retry must retain the old
   cleanup SID/nonce. Legacy generation-8/9 live-account upgrades remain valid.

## Scope and limitations

This is ACL compatibility with Codex, not transparent credential access for the
independent sandbox account. Credentials requiring the host identity continue
through the existing authorized host execution path. No key copying or new
credential proxy was added. Ordinary non-excluded roots still use KodaX's fixed
four-ACE mechanism; this patch does not replace it with Codex's RX mutex path.
No all-external-write prohibition is added.

Automatic cleanup can identify the current recorded generation's ACEs at known
roots/SSH paths. Missing nonce history, moved paths or unrelated unknown SIDs
are not guessed or deleted by prefix. Do not claim arbitrary historical ACLs
have been recovered without inspecting those cases.

See [final design and historical experiments](../research/windows-sandbox-acl-design-alternatives.md)
and [why the RX implementation was not copied](../research/windows-read-acl-concurrency.md).

## Local validation result

88 native tests passed, 0 ignored; 106 affected TypeScript tests passed with
40 existing platform-conditioned skips. Source/test typechecks, native build, bundle build and declaration build passed. The
real OpenSSH fixture passed the rejection-before/acceptance-after checks.

## Standards review

0 remaining findings after correction and independent re-review.

## Spec review

0 remaining findings after explicit-file cleanup, pending identity preservation
and junction-ancestor handling were verified.
