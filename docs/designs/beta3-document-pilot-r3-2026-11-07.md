# beta.3 document pilot r3 — controlled replay correction

Status: design and offline validation before renewed main-session GO. Production
code is unchanged. r2's manifest, freeze, six paid requests/responses and journal
remain immutable evidence; r3 uses separate component/freeze and paired files.

## Reason and production contract

r2 stopped after six physical requests with known usage: 35,726 tokens and zero
unknown-usage reservations. DeepSeek's S1 ended normally below the output cap
with a complete analysis/body but omitted its closing summary tag. The eval-only
wrapper rejected it. Production `generateSummary` accepts that body after its
normal analysis/tag stripping; the recorded GLM S1 is also accepted. This is an
eval-design mismatch, not evidence requiring a production change or a quality
comparison against an earlier implementation. The original stop is retained.

r3 keeps production `compact`, `generateSummary`, Coding summary/update prompts,
query ledger and canonical reinsertion. It removes only the artificial closing
tag gate. Actual output-limit stops, tool-bearing summaries and production's
empty/unusable-body checks still stop the chain. Missing wrapper tags are
recorded as format diagnostics, not treated as proof of token truncation.

## Exact replay, no duplicate spend

Only reference, G1 and S1 for RUNBOOK_A on the original DeepSeek Flash and
GLM-5.3-Flash routes are replayable: six literal call IDs are frozen in the
helper and r3 manifest. The actual native adapter must serialize exactly the
old request bytes. Replay also requires the original reservation, credible
settled usage, a settlement snapshot without that retained reservation, intact
200 SSE response/hash, and no unresolved original reservations in the current
shared ledger. A mismatch stops before transport; it never falls back to a paid
request. Replay returns saved SSE to the actual parser and appends an explicit
`physical:false` event without reserving or settling usage a second time.

The existing GLM S1 compaction blob is not overwritten. Recomputed canonical
messages, summary, input/output token estimates, entries removed and file facts
must agree; otherwise stop. Parsing/compaction wall timing is inherently new,
so the old blob and its original metrics are retained and the offline replay
validation is recorded separately. DeepSeek's previously rejected S1 can now
produce its first canonical compaction result without another model request.

## Budget, freeze and interpretation

All requests continue to use the original shared ledger: **6 already known +
18 new SC + 8 new DOCX = 32 cumulative physical calls**, bounded by the same
40-call, 600,000-token, US$5 ceilings. The application 64K/estimated input/output
and 90-second per-request bounds, provider serialization guard, no automatic
retries, no model tool execution, no judge calls and subscription distinctions
from r2 are unchanged. No allowance is reset or filled merely because it exists.

Before renewed GO, the main session must review the offline replay regressions,
freeze `sc-manifest.r3.json` and `docx-manifest.r3.json` through
`frozen-candidate.r3.json`, verify six original calls, zero reserved tokens/USD,
zero unknown usage and no in-flight request, then explicitly record clearing
only the identified eval-design stop. The helper/runner cannot silently clear
it. Other failures keep the fence. Both route lanes await already-dispatched
requests on failure; a refused local guard is recorded with `physical:false`
and its original reason rather than attributed to a new HTTP/network failure.

The SC source/input/document bytes are inherited from r2, not regenerated.
Its `derivedFrom` preserves the old source revision and manifest hash. DOCX
inherits its same eight logical inputs/wires/assets without rendering again.
Source/helper hashes are refreshed only in the separate r3 component manifests.
Final pairs remain anonymous until the main session records its semantic
judgments, then reveals mappings. Mechanical format/schema diagnostics cannot
decide shipping, and no broad frequency or full-agent-loop claim is supported.
