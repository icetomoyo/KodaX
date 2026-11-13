# Issues 402–404 — Native text authority on glibc 2.17 and kernels before 5.8

Covers Issue 402 (crash after a failed addon load), Issue 403 (glibc 2.17
load) and Issue 404 (mount identity on kernels before 5.8). The reference host
is the customer's Anolis 7 machine: glibc 2.17, kernel `4.18.0-193`.

## Automated coverage

| Check | Where it runs |
| --- | --- |
| One failed load: three commits and the doctor probe call dlopen once and create no file | `src/windows-text-transaction.test.ts`, every platform |
| fdinfo and statx report the same mount ID | Rust `unix_transaction` tests, Linux CI `test:native` |
| A full commit succeeds when only fdinfo reports mount identity | same |
| The staged Linux addon needs no `GLIBC_*` version newer than 2.17 | `Enforce Linux glibc 2.17 ABI` step in CI and release |

## Manual verification on the glibc 2.17 host

Use the `linux-x64` (or `linux-arm64`) standalone archive from a build that
includes the fix. Extract it into an empty directory.

1. Confirm the environment.

   ```bash
   getconf GNU_LIBC_VERSION        # glibc 2.17
   uname -r                        # a kernel before 5.8, e.g. 4.18
   grep '^mnt_id:' /proc/self/fdinfo/0
   ```

2. Probe the addon.

   ```bash
   ./kodax doctor --native-text
   ```

   Expected: the native text line shows `✓ protocol 5`. There is no
   `GLIBC_2.28`, `GLIBC_2.25` or `GLIBC_2.18` error.

3. In one session, ask KodaX to run `write` once, `edit` the same file twice and
   then run one `multi_edit`.

   Expected: every call succeeds, the file holds the final content, and the
   process does not crash.

4. Optional ABI check without running KodaX:

   ```bash
   objdump -T vendor/kodax-native/linux-x64/kodax-text-transaction.node | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
   ```

   Expected: `GLIBC_2.17` or lower.

## Load-failure behavior (Issue 402)

To check the fail-closed path, use an older archive whose addon needs glibc 2.28
on the same host, or make the addon unreadable in a scratch copy.

Expected: every `write`/`edit`/`multi_edit` in the session fails with
`text_mutation_io_failed`. The message contains the loader error and says the
binding `will not be retried in this process`. The process does not crash.
Restarting KodaX after fixing the host loads the addon again.
