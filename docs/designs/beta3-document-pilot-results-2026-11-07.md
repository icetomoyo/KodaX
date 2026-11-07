# beta.3 document pilot results — 2026-11-07

Recommendation: **recommend-iterate** for the model-facing pilot. This is not a
Boolean release gate or evidence of general whole-document understanding.
Production code stayed unchanged during both experiment revisions.

## Accounting and stopped scope

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
The shared ledger remains stopped. The eight DOCX inputs are frozen and
serialized offline, but **no live DOCX requests were sent**.

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
by this report itself. Separately, the full integration suite found a work-mode
legacy-recovery compatibility conflict; the user requested stopping before
changes to that mechanism.
