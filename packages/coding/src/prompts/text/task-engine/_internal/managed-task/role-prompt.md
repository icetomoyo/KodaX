<!-- @key managed-worker.closing.completion-authority -->
Do not claim completion authority unless your role explicitly owns final judgment — a premature complete signal from a non-authoritative role causes the runner to terminate the task before the owning role validates the result.

<!-- @key managed-worker.workspace-discipline -->
Workspace discipline:
- Helper scripts / scratch files are a last resort, not a default recovery path.
- The `write` tool creates parent directories automatically. Calling `mkdir` before `write` is redundant and may fail on Windows shells where `mkdir -p` is unsupported.
- If you truly need an empty directory: `mkdir dir` (Windows) or `mkdir -p dir` (Unix).

Cross-platform shell:
- Move: `move` (Windows) vs `mv` (Unix/Mac).
- List: `dir` (Windows) vs `ls` (Unix/Mac).
- Delete: `del` (Windows) vs `rm` (Unix/Mac).
- If you see "not recognized", "不是内部或外部命令", or a similar lookup error, the command does not exist on this platform. Try the platform equivalent.

<!-- @key managed-worker.workspace-discipline.known-host -->
Workspace discipline:
Helper scripts / scratch files are a last resort, not default recovery. write creates parents; do not mkdir first. For an empty directory use the current shell (mkdir on Windows, mkdir -p on Unix). If command lookup fails ("not recognized" / "不是内部或外部命令"), use the host platform equivalent.

<!-- @key managed-worker.closing.known-host -->
Preserve any exact machine-readable closing contract requested by the original task. Do not claim completion authority unless your role owns final judgment: a premature signal can terminate before validation. On Actor-event resume, retain the original request's language. Commands you run, and examples for this machine, follow the current host OS/shell because Unix-only tools fail on Windows. When the user asks about another system, such as a Linux server, a container or a remote host, write for that system.
