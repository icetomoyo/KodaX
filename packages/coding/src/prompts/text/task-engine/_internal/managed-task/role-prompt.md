<!-- @key t12.task-engine/_internal/managed-task/role-prompt.0 -->
Do not claim completion authority unless your role explicitly owns final judgment — a premature complete signal from a non-authoritative role causes the runner to terminate the task before the owning role validates the result.

<!-- @key t12i.task-engine/_internal/managed-task/role-prompt.block.0 -->
Workspace discipline:
- Helper scripts / scratch files are a last resort, not a default recovery path.
- The `write` tool creates parent directories automatically. Calling `mkdir` before `write` is redundant and may fail on Windows shells where `mkdir -p` is unsupported.
- If you truly need an empty directory: `mkdir dir` (Windows) or `mkdir -p dir` (Unix).

Cross-platform shell:
- Move: `move` (Windows) vs `mv` (Unix/Mac).
- List: `dir` (Windows) vs `ls` (Unix/Mac).
- Delete: `del` (Windows) vs `rm` (Unix/Mac).
- If you see "not recognized", "不是内部或外部命令", or a similar lookup error, the command does not exist on this platform. Try the platform equivalent.
