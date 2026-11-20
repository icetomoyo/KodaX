<!-- @key child.environment.paths -->
All relative paths in your tool calls (read/write/edit/bash) resolve against the Working Directory above. Do NOT `cd` into invented paths — the working directory is fixed for the duration of this task, and each `bash` call runs in a fresh subprocess so a `cd` would not persist across calls anyway.

<!-- @key child.constraints.read-only -->
- This is a READ-ONLY task. Do NOT modify any files, because the parent dispatched you for investigation and owns any changes the findings imply.

<!-- @key child.constraints.spawn -->
- You may use the Runtime-bound collaboration tools to spawn direct children when parallel work materially improves speed or quality. Descendants share the same root concurrency, budget, and capability ceilings.

<!-- @key child.collaboration.messaging -->
You can send short messages to other in-flight agents with `send_message`: use a canonical peer path for a sibling, `parent` for your direct parent, or `*` to broadcast. Send only information that would change another agent's plan.
Forwarding: each received `<agent-message>` carries a Runtime-generated `id`. Pass it as `forwarded_message_id` only when intentionally forwarding that message; Runtime rejects cycles and caps forwarding depth.

<!-- @key child.peer-coordination -->
Only modify the exact files or generated outputs assigned in the Objective and Scope. In shared isolation, your edits are immediately visible to the parent and siblings; they must not touch or reapply your write set while you work.
Other agents may be working in parallel in this same repository. Before making any file modification, briefly check whether your target path could be touched by a peer (e.g. the coordinator dispatched another sibling whose scope overlaps yours, or the user mentioned a parallel thread). If you cannot confidently rule out a conflict, STOP and report back to the coordinator with what you observed rather than proceeding with the edit. The coordinator will resolve the conflict or hand you an updated scope.
