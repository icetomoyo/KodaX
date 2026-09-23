# Issue 339 — macOS Git installation prompt regression

- Baseline: SDK v0.7.96-rc.10.
- Candidate: current local source; no new SDK publication is claimed.
- Space integration uses the matching new SDK; upgrade Space's dependency pin when publishing the paired release.
- Status: automated source coverage exists; native macOS verification is pending.
- Related work: FEATURE_300 / v0.7.99 is design-only and is not required for this fix.

## Preparation

Use an isolated macOS VM or test account/machine without command-line developer
tools for the missing-tools case. Do not uninstall an existing development setup
just to run this guide. Prepare one normal repository, one unborn repository
(`.git` exists but no commits), and one ordinary folder; fixtures can be copied
from a machine with Git. Keep test memory/session storage separate from real data.

Record macOS version/architecture, source revision, actual installed SDK location,
effective PATH and DEVELOPER_DIR, and whether the candidate is a local link or a
published package. Do not print credential environment variables. Avoid using
`git --version` to diagnose the missing-tools case: it can itself trigger the UI.

## Native acceptance matrix

| Case | Action | Expected result |
|---|---|---|
| No developer tools, system Git selected | Open each fixture through SDK/CLI consumers; repeat repository discovery, recent-file and memory-path queries for at least one minute | No install dialog caused by these background paths; non-Git work remains usable; Git-only operations retain their existing failure result |
| Normal system Git | On a machine with working tools, run repository discovery, status/review and worktree operations | Same repository, output and error semantics as baseline |
| Full Xcode / custom DEVELOPER_DIR | Launch with a valid nondefault Xcode developer directory in the effective environment | Existing working system Git remains usable; no fixed CLT-directory requirement |
| Independent Git first on PATH | Launch with Homebrew or another independent Git ahead of `/usr/bin` | Selected Git and normal results are preserved; missing Apple tools do not block it |
| System Git first on PATH | Put `/usr/bin` before another installed Git for this test process | Guard follows actual PATH selection; it does not silently switch Git installations |
| Installation recovery | After a blocked query, install tools explicitly; wait more than 5 seconds, then request the same operation again in the same process | Query succeeds without restart; 5 seconds is the guard cache TTL, not a promise that every UI refresh runs within 5 seconds |
| Windows / Linux | Repeat normal repository, worktree, review and memory queries, including a missing-Git fixture | No xcode-select probe; original Git behavior and errors remain intact |

## Repo-intelligence and identity recovery

1. With the platform guard reporting missing tools, request an overview of the
   prepared unborn repository. Expect filesystem-backed overview and an explicit
   refusal from Git-only changed-scope analysis, rather than a fabricated clean diff.
2. Restore working Git, wait past the 5-second cache TTL and request the same
   overview again without clearing application caches or restarting.
3. Expect source `git`; create an untracked file and verify changed-scope analysis
   includes it even though the repository still has no commit.
4. Run a worktree operation when Git is unavailable, then a normal Git command
   failure on an available installation. Both must retain actionable failure
   semantics; unavailable tools must not become an empty successful worktree result.
5. Compare synchronous memory path/identity results against the baseline: a valid
   remote uses the existing remote identity; missing Git/no remote uses the same
   local-path fallback. No async API conversion or identity migration is expected.

## Automated boundary checks and limits

Use the focused `macos-git`, memory paths, coding caller, repo-intelligence recovery
and REPL unavailable-Git suites. Verify exit code 2 blocks before Git starts,
uncertain probe failures retain execution, cache expiry restores retries, and
cwd/PATH/DEVELOPER_DIR changes cannot reuse an unrelated cached decision.
Synthetic macOS tests do not replace the native no-dialog matrix above.

Manual Bash/PTY commands are outside this repair. A user explicitly invoking a
system Git shim without tools may still receive Apple's installation prompt.
Record each matrix result and any popup's triggering action; leave unexecuted
cases marked pending. Use the matching new SDK for Space integration; a local
linked build does not establish that the existing registry package is fixed.
