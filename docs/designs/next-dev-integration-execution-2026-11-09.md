# next-dev integration execution — 2026-11-09

Status: **in progress; mainline has not been advanced**. The user authorized
the integration and regression plan after the read-only assessment. No npm
publication, GitHub release or installed Space update is part of this work.

## Frozen inputs and preservation

- Mainline `KodaX`: `5ea48c64123eb5be5fa64f55625f95cd45eb0162`.
- Synced `KodaX-next-dev`: `e37aef47a5ca491014a9442ab18fa68a3ecde3a7`.
- Mainline is an ancestor; next-dev has 66 additional commits and 316 changed
  files (39,745 insertions / 683 deletions). Counts include historical merges
  and records; they are not a production code-size measurement.
- The current chat's clean worktree was reused on `codex/next-dev-integration`.
  The other chat's next-dev worktree and the main worktree remain untouched
  until acceptance. Original `codex/beta3-integration` remains available.
- The two prior main-to-next merges retain the checked final-call/permission,
  Script serial/visual receipts, permanent work-mode locking, verified legacy
  same-Run recovery and durable Actor settlement contracts. Static review of
  their key resolutions found no concrete runtime regression; this does not
  substitute for the tests below.

The [2026-11-06 assessment](next-dev-integration-assessment-2026-11-06.md)
remains historical. Its W0–W5/A1–A10 dependencies guide this new candidate;
its original SHAs, failure records and model conclusions are not rewritten.
The current CLI fence is 5 MiB minus 49 KiB (5,192,704 bytes), independently
of the historical limits discussed there.

## Initial evidence, not acceptance

The other chat's `e37aef47a` typecheck and 175 selected tests passed. Its fast
suite finished with 386 passed files, one failed, seven skipped; 3,721 passed
tests, one failed and 57 skipped, in 571.86 seconds. The failed oversized-output
recovery case reported `AssertionError: Provider request failed.` through
`record.error`, masking the original scripted callback assertion. A separate
run passed in 5.134 seconds. That pass does not establish the historical
failure's cause or turn the fast suite green.

Both parents reference feature-submodule commit `8111124`; FEATURE_303/304
history is present locally. Authenticated GitHub API inspection on 2026-11-09
returned `No commit found for SHA` for that target, while the older `5d729c2`
was reachable. This is an existing mainline prerequisite, not a new next-dev
gitlink regression. Bootstrap from the local submodule is not proof of remote
checkout availability; remote availability must be closed separately.

That prerequisite is now closed: the existing `8111124` commit was pushed to
the feature repository's isolated
`codex/kodax-next-dev-integration-20261109` branch using the existing token.
Its three documentation changes only repair links. A fresh depth-one remote
clone of that branch checked out the exact gitlink cleanly. The feature
repository's `main`, both parent gitlinks, and the parent repository's remote
branches were not changed.

The existing next-dev `dist/kodax_cli.js` was built on 2026-10-31 and is not
this candidate's artifact. The fresh build measured 5,267,526 bytes, failing
the preserved 5,192,704-byte CLI fence by 74,822 bytes. Package compilation
and native compilation passed before that fence. The gate is not relaxed;
legitimate optional-component loading and state ownership need separate
regressions before any reduction can count as acceptance.
P7's current feature index has been corrected to its recorded mixed outcome;
the original experiment records and limits remain unchanged.

The new candidate build passes without reducing the fence: `kodax_cli.js` is
5,164,670 bytes, leaving 28,034 bytes. Only selected integration commands,
ACP and hosted A2A move behind the existing component loader. Root/topic help
and natural-language `help mcp` parsing retain their existing behavior;
hosted A2A receives the owning Host's diagnostic and storage-lock functions.
Public synchronous integration-command setup remains available. Node bundle
help and ACP initialize regressions pass. Native and complete package gates
remain outstanding.

The historical oversized-output failure did not reproduce: the unchanged
targeted case and all 41 cases in its file passed. The final assertion now
includes retained scripted-callback failures and tool receipts. This adds
diagnostics, not a claimed root-cause fix. No recovery or timeout requirement
was relaxed.

Focused coverage verification passed 187 tests in six files. The new lazy
command helper has 100% statement/branch/function/line coverage. The two A2A
modules together have 82.37% statement coverage; all three modules together
have 82.54%. These are scoped measurements, not repository-wide coverage.

## Window scope clarification

The first combined fixture observed a genuine pre-request refusal at 16,384
tokens: the full AMA/image contract required 20,250. No provider call or tool
execution occurred. The fixture initially awaited a terminal result from a
recovering Run and timed out; that is retained as failed experiment evidence,
not successful 16K reading. The user explicitly excluded 16K on 2026-11-09
and selected **32K and 64K** as this integration's minimum-window acceptance.
The historical assessment's 16K row remains historical; it is not silently
marked complete. No production contract is reduced merely to fit 16K.

## Acceptance sequence

| Gate | Required evidence | Status |
| --- | --- | --- |
| W0 | Fresh graph, committed inputs, submodule identity and remote availability | Graph frozen; exact remote checkout verified |
| Failure closure | Reproduce/diagnose the masked oversized-output failure at the existing public Runtime seam; preserve refusal, actual output recovery and non-replay assertions | In progress |
| W1 | Final args, once-only hooks, native/MCP fallback, serial calls, home protection and lifecycle; actual local proxy/CA fixtures | Pending |
| W2 | Owned visual evidence, shared batch budgets, 32K/64K long-text capacity, repeated compaction/restart, exact accounting and history revisions | New 32K/64K joint regressions pass; full tier verification pending |
| W3 | Canonical/custom contract fallback, scoped rules, cross-Run retention and current production request bytes | Pending |
| W4 | Block before ask, once-only inline/daemon approval, cancellation and no-handler refusal without permanent privilege changes | Pending |
| W5 | Complete deterministic suite, typechecks, build, real bundle/package gates and isolated consumption/Host upgrade; 49 KiB reserve unchanged | Pending |
| Mainline | Final review; recheck clean worktrees and ancestry, then use only fast-forward to the verified candidate | Pending |

Use existing tests first. Add only missing cross-feature regressions at the
already agreed public Runtime/tool/request seams. No paid model calls are
needed for these engineering gates. Historical semantic model evidence stays
mixed/incomplete where recorded; native sub-100K-model and whole-book quality
are not claimed. Raw probes and run logs stay in OS temporary storage.
