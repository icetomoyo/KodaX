<!-- @key t11.tools/managed-tool-text.0 -->
Ask one flat question or 1–4 independent select questions via questions[] (overrides flat question/options; each item requires options). kind=input: flat free text only; select (default): options required. multi_select returns an array, bounded by min/max_selections. Option value defaults to label. Do not add Other: custom input defaults true; false only for closed safety/protocol choices. Batch custom settings inherit flat settings unless overridden. Defaults are suggestions, never submitted automatically. Wait indefinitely unless the Host sets a timeout. Skip/timeout returns unanswered; only Stop interrupts the Run. Continue or explain missing information.

<!-- @key t11.tools/managed-tool-text.1 -->
Read first. Apply edits sequentially to one existing file; each old_string must be unique in the whole current file unless replace_all. Exact matching, then normalized anchors. Later anchors refer to earlier edits’ results. Commit once; any failure leaves file unchanged. On failure inspect edit index, reread or use a smaller unique anchor, never full-file rewrite to bypass failure. Split oversized replacements.

<!-- @key t11.tools/managed-tool-text.2 -->
First source for using, installing, configuring, troubleshooting or extending KodaX itself, including its SDK. Other software is outside the manual. Answer from results, not other-product pretraining. KodaX uses ~/.kodax/config.json/KODAX_*, not .claude/settings.json/config.toml. Use an exact topic or free-text query. Omit both for the topic index. Explains where to check values, never reads secrets.

<!-- @key t11.tools/managed-tool-text.3 -->
Governed Memory: list accepted claims/refs; remember; correct/forget exact claim ref; decisions/show only when asked. Every mutation needs an exact affirmative current-user userQuote. remember/correct statement must be an exact claim span, never inferred/paraphrased, with claimKind; new claims require stable claimKey. approve/reject need exact decision ref plus authorization. Safe requests apply; ambiguity asks; conflicts become decisions; restricted content rejected.

<!-- @key t11.tools/managed-tool-text.4 -->
Read-only, current MemorySession-scoped prior experience for a concrete decision gap absent from current context; may return none. If prior experience is the known missing source, use before unrelated repo exploration. Current repo/environment facts require normal tools.

<!-- @key t11.tools/managed-tool-text.5 -->
Read line-numbered bounded text. Continue offset/limit; partial lines require exact line_offset cursor. Context recovery’s kodax-transient://text/ is a local run-scoped capability: read directly, not network or user re-paste. PNG/JPG/JPEG/GIF/WEBP return inline vision, so inspect them rather than rejecting as binary. Attached or inlined images are already visible; rereading only repeats them.

<!-- @key t11.tools/managed-tool-text.6 -->
Required before other work when the user names a listed Skill or its description clearly covers the request; otherwise do not call it. Returns expanded/resolved instructions for next turn. Load via skill, never read SKILL.md, which bypasses the resolver. Optional free-form args forwarded for template substitution (most ignore it).

<!-- @key t11.tools/managed-tool-text.7 -->
Add one semantic milestone without replacing existing items. Returns {ok:true,id}; reuse this generated id, never supply one. This records planned work, not execution. Plan work with several distinct deliverables. Skip trivial or informational tasks, because a one-step plan only adds noise. Inactive store, invalid input or extension veto returns {ok:false,reason}.

<!-- @key t11.tools/managed-tool-text.8 -->
Read plan and canonical ids: without id returns {ok:true,count,items}; with id returns {ok:true,item} including description/status/activeForm/note/evaluator/owner/metadata. Refresh only if state may have changed externally or is unknown; clear patches need no read. Inactive store returns {ok:false,reason}; continue without more todo calls.

<!-- @key t11.tools/managed-tool-text.9 -->
Patch one existing todo by stable id; omitted fields survive. Add work with todo_create. Mark in_progress with activeForm before work, completed only after finishing. Completion may run its evaluator and be vetoed by a hook: after rejection/blocked-by-hook re-read and revise before retrying. Avoid unchanged updates; read details when state is uncertain, list for unknown ids. Inactive store: continue without more todo calls.

<!-- @key t11.tools/managed-tool-text.10 -->
Full active-tool contracts, for when no listed tool fits the need or a listed description is too short to call correctly. Listed tools are called directly; call other discovered tools through tool_call. Exact select:NAME[,NAME...] or keyword search over names/descriptions/parameters (+required and loose ranked terms). Keep using returned schema even if later menus compact.

<!-- @key t11.tools/managed-tool-text.11 -->
Complete only when objective and all requirements are evidenced; disclose unverified scope. Bookkeeping is not quality certification. blocked requires external unblock and same blocker_kind for 3 consecutive turns; Runtime rejects earlier. Pause/resume/budget-limited are user-controlled. Never call merely to stop work.

<!-- @key t11.tools/managed-tool-text.12 -->
Yield for Agent mailbox evidence, root user input, interruption or timeout. Progress is UI/SDK-only and never wakes the model. Returns a wake acknowledgement, not the evidence: read the following mailbox. After any mailbox evidence, integrate it and reconcile the affected semantic milestone before waiting again.

<!-- @key t11.tools/managed-tool-text.13 -->
Direct UTF-8 write for explicitly requested new file/full rewrite; existing changes: edit. Large diffs may summarize. Oversized/stream-failed content: smaller skeleton/placeholders then edit sections. Shell wrappers bypass mutation/diff checks and shift streaming limits. Chinese/emoji need no encoding workaround.

<!-- @key t12.tools/managed-tool-text.0 trail=" " -->
Shell: tests/build/lint, packages, Git/processes, queries without dedicated tools, computed/template multi-file generation. Searches: grep/glob; known file content: write/edit, not shell redirection/wrappers.

<!-- @key t12.tools/managed-tool-text.1 -->
Message, no new turn: running receives at next safe boundary; idle retains until next turn. Direct parent/child, admitted peer or broadcast capped at 20; Runtime validates forwarding lineage against cycles.

<!-- @key t12.tools/managed-tool-text.2 -->
Start a named direct child; returns canonical path. Runtime atomically enforces shared session concurrency/work budgets. quality_strategy is optional telemetry, never admission control; invalid/conflicting data is ignored.

<!-- @key t12.tools/managed-tool-text.3 -->
balanced: ordinary work (default); fast: read-only mechanical lookup; deep: architecture/adversarial checks/severity/final synthesis. Unconfigured tiers inherit; write-capable fast stays on parent tier. Omit if unsure.
