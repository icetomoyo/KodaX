# beta.3 document pilot results — 2026-11-07

Recommendation: **recommend-iterate** for the model-facing pilot. This is not a
Boolean release gate or evidence of general whole-document understanding.
Production code stayed unchanged during both experiment revisions.

## R2/R3 SC accounting and stopped scope

The two user-selected routes used the same 64K application ceiling on models
whose native windows exceed 100K. The actual serialized request, output and
protocol bounds were checked before each physical request. The pilot completed
**16 physical requests**, consuming **101,098 reported tokens**, with no unknown
usage or outstanding reservation. Six original requests were replayed from
byte-identical saved SSE in r3 without new HTTP or duplicate accounting.

| Route | Physical calls | Input tokens | Output tokens | Total |
| --- | ---: | ---: | ---: | ---: |
| DeepSeek / deepseek-flash | 9 | 49,303 | 8,623 | 57,926 |
| zhipu-coding / glm-5.3-flash | 7 | 38,653 | 4,519 | 43,172 |

DeepSeek token-bill liability conservatively estimated at the preregistered
peak prices is US$0.0251385. GLM consumed subscription quota; its subscription
cost is not zero and is not assigned a fabricated per-token price. The original
40-call / 600,000-token / US$5 ceilings were never reset.

The second fixture stopped at DeepSeek S1 with a real `max_tokens` result at
the fixed 2,048-output-token cap. That summary was rejected before canonical
injection; no repair, increased cap, replacement model or repeat generation
was requested. The other lane's next request was refused locally before HTTP.
At that checkpoint the shared ledger remained stopped, and no live DOCX
requests had been sent. The separately preregistered R4 phase below later
executed only those independent DOCX cells; it did not resume this SC chain.

## Validity and main-session judgments

R2 stopped on an additional eval-only closing-tag check: DeepSeek naturally
ended below the cap with complete body sections but no closing summary tag.
Two independent zero-HTTP replays through production `generateSummary` accepted
the recorded body. R3 therefore removed that stricter eval gate and kept the
actual production truncation, tool-bearing and unusable-body protections.
R2 remains a recorded incomplete run; it was not rewritten as green.

R3 completed both routes on RUNBOOK_A through two real production compactions.
The main session read the two paired final-answer packs and recorded judgments
before opening their mapping files. Both compressed and uncompressed answers
retained the 90-second corrected ordinary delay, narrowly scoped 5-second
authenticated-critical-emergency exception, all four source IDs, completed
EDIT019 without replay, and exact unread ranges. The semantic finding is a
retention tie, not a demonstrated quality improvement over earlier code.

Weak readability preferences differed: DeepSeek's compressed answer was more
concise; GLM's reference was slightly cleaner. Both GLM answers added Markdown
or prose around the requested JSON, so neither met the strict JSON-only output
form. One generated answer mentioned G3, leaking a stage cue and limiting
perfect blinding. Mechanical JSON diagnostics are not a ship/no-ship scorer.

There is only one completed controlled fixture per route, not a complete
two-fixture panel. The second fixture is censored by this experiment's output
cap; it cannot be scored as a final-answer retention success or extrapolated
into a production window failure. The engineering regressions and this model
pilot answer different questions. Native sub-100K models, autonomous whole-book
reading, all document formats and DOCX model visual judgment remain unverified.

## Evidence and next decision

Exact source/tool/prompt hashes, component and combined freezes, immutable
request/response files, append-only journal, budget snapshots, blind judgments
and subsequent arm mappings remain under the OS-temp evidence directory
`kodax-beta3-document-pilot-r2-20261107`. No raw model output is committed.
Protocols are [r2](beta3-document-pilot-r2-2026-11-07.md) and
[r3](beta3-document-pilot-r3-2026-11-07.md); eval code is committed separately.

Do not rerun paid outputs merely to improve the scorer. A later pilot must
explicitly decide whether to revise the output cap/task or continue the
independent DOCX component, preserve cumulative accounting and document any
reviewed transition out of the stopped ledger. No further calls are authorized
by this report itself. The full integration suite also found a work-mode
legacy-recovery compatibility conflict. The user clarified that the earlier
stop instruction concerned concurrent chats; the repair is now implemented
in `e0b508ade`, with focused engineering regressions. The final full-suite
result is recorded separately in the integration readiness document.

## R4 independent DOCX phase

[R4 preregistration](beta3-docx-pilot-r4-2026-11-07.md) retained the same eight
logical inputs, native wires, assets, models and hard budgets. A separate
immutable phase freeze bound the current production commit and audited the
settled ledger before explicitly authorizing only those eight new calls.
No SC output was regenerated, no cap was increased and no model was replaced.
The R3 filenames describe the reused data/runner format, not experiment
authorization. All eight next responses were observed; none of their proposed
tools was executed.

The main session saved four blinded paired judgments before opening the
original mapping:

| Route / case | Judgment | Limitation |
| --- | --- | --- |
| DeepSeek / entry | Current description preferred: source-bound LibreOffice render advances evidence more directly than another listing | Converted pagination and actual render success were not observed |
| DeepSeek / fallback | Inconclusive: remaining lightweight page versus structure/capability inspection are both preliminary | Neither next response resolves all native-field/pagination uncertainty |
| GLM / entry | Tie: authoring-application PDF export plus lightweight render versus explicit runtime preparation | Browser file presence is not observed compatibility; updating fields after export does not prove fresh fields in that PDF |
| GLM / fallback | Current diagnostic preferred with caveat: recognizes the fidelity blocker and proposes Word PDF export | Scratch parent-directory existence is unverified; conversion and review were not executed |

This small panel supports retaining the engineering converter/diagnostic change,
with limited and mixed route-selection evidence. It does not prove final visual
approval, Word/WPS equivalence, general model quality improvement or reliable
behavior on every provider. No Boolean per-alias ship scorer or model judge
was used. Actual SDK conversions supply separate engineering evidence.

## Final cumulative accounting

| Route | Physical calls | Input tokens | Output tokens | Total |
| --- | ---: | ---: | ---: | ---: |
| DeepSeek / deepseek-flash | 13 | 70,567 | 9,169 | 79,736 |
| zhipu-coding / glm-5.3-flash | 11 | 60,073 | 5,194 | 65,267 |

All phases together consumed **24 physical requests and 145,003 reported
tokens**. Six earlier requests were replayed without HTTP or duplicate usage.
DeepSeek peak per-token liability is conservatively US$0.0321729; GLM consumed
subscription quota, whose subscription cost is not treated as free. Unknown
usage and outstanding reservations are zero. The original 40/600,000/US$5
limits were never reset, and the final ledger is explicitly closed against
further requests or panel expansion. R4 analysis and pre-unblind judgments
remain in OS temporary storage alongside the original SC failure evidence.
