# Shared Host metadata admission and client-exit regression

## Scope

The pending alpha.9 CRC/EIO fix `0f0c8293` replaced whole-transcript admission
reads with strict canonical metadata reads. GLM reported that the existing
two-client exit case passes at alpha.8 (`bbcf2510`) and fails at `0f0c8293`.
The failure was independently reproduced on Windows: the exiting client's
cleanup succeeded, but its Host receipt became `unknown` instead of `protected`.
No release or tag was made during this repair.

## Confirmed cause and repair

A targeted preflight probe surfaced `SessionReadError` with code `data_changed`
from `resolveSessionLocation`, through `readActorMetadata`, `admitsSession` and
`filterAdmittedRunStatuses`. This was a strict read boundary conflicting with
legitimate live Session persistence, rather than a missing metadata field.

An initial repair reused nonterminal owned Run admission. Although all source
tiers passed, its bundle gate failed 43/44: final daemon inspection raced
`managed-session` persistence after that Run had completed. Run completion does
not end the Session controller's lifetime.

Run listing and inspection now use the same authority distinction as Actor
preflight: only initialized controllers that have passed Session admission and
still hold their durable owner fence can supply live admission. A controller
remains authoritative across Run completion and trailing persistence. No new
authorization cache is introduced. Unclaimed Sessions and controllers whose
ownership has been released still require strict canonical metadata admission.

No read-boundary checks were weakened. No transcript fallback, ignored metadata
error, extra retry, timeout extension, or change to exit-receipt classification
was introduced. This does not repair physical storage or reconstruct damaged
transcript bytes.

## Automated acceptance

Run from the KodaX repository:

```powershell
npx vitest run src/sdk-client.exit.test.ts src/sdk-runtime.preflight-projection.test.ts
npm run test:full
npm run typecheck
```

The public two-client case must settle only the exiting client's work, retain
the other client's active Run and Actor, classify the Host as `protected`, keep
the foreign queued input executable, reject new work from the exited identity,
and preserve its receipt after reconnect. It also checks public preflight while
the other client remains active.

The deterministic live-controller case pauses a real canonical Actor write
before file replacement, with only a historical completed Run. Listing must
finish while that write remains paused. After archive releases controller
ownership, corrupt metadata must again make listing fail. The fixture performs
no model request.

The EIO cases must still admit a readable canonical header with an unreadable
historical body, retain active/unknown Run and Actor exit blockers, reject an
unreadable identity header, and report EIO when explicitly loading the affected
Session. The storage Actor-read suite must retain its concurrent writer,
file-identity, topology and migration guards. Shared daemon admission must still
reject Partner and unknown-surface Sessions.

### Local qualification (2026-10-19)

Windows, Node 22.23.1. The superseded nonterminal-Run repair passed 16,742 source
cases, with 90 skips and 19 TODOs, but failed the compaction bundle gate above.
That green source result is not final acceptance. An added
test assertion against an internal-only `runs.inspect` method failed the test
type check, was removed, and the public exit/EIO combination and complete type
checks then passed. Final qualification is recorded after the owner-fence
repair. These are local Windows results, not new Linux Node 20/22
or branch-CI evidence. Release preparation remains separate; its stash and the
preexisting features submodule checkout are retained.

## Standards

Initial Standards review of `0f0c8293..514b4b9a`: zero actionable findings.
The repair reuses the existing admitted context and predicates, introduces no
new abstraction or configuration, and tests public behavior. This was static
review, not an independent test run.

## Spec

Initial Spec review of the same fixed diff: zero actionable findings. The later
bundle failure demonstrated a scope gap in the initial repair; its green source
tests and static review did not close the terminal-Run persistence boundary.
This was static review; test execution evidence is recorded separately above.
