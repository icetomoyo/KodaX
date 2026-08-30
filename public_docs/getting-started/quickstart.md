# Quickstart

## Four ways to use KodaX

| Form | Command / Import | When to use it |
|---|---|---|
| **REPL** | `kodax` | Interactive multi-turn coding session with streaming UI, permissions, slash commands |
| **CLI** | `kodax -p "your task"` | One-shot scripted task, CI runs, batch processing |
| **Library** | `import { runKodaX } from '@kodax-ai/kodax'` | Embed in your own tool / agent / web service |
| **Single binary** | `./kodax` | Distribute to machines that don't have Node installed |

## Start in REPL

```bash
kodax
```

Then ask naturally inside the REPL:

```
Read package.json and summarize the architecture
/mode
/help
```

Shift-Tab cycles Plan → Edits → Auto[LLM] → Full Access while Shift+Enter
inserts a newline.

## Run a one-shot CLI task

```bash
kodax "Review this repository and summarize the architecture"
kodax --session review "Find the riskiest parts of src/"
kodax --session review "Give me concrete fix suggestions"
```

## Basic workflow

1. **Open a project** — Run `kodax` inside your project directory. KodaX
   automatically detects the repo structure and builds a repo-intelligence
   snapshot.
2. **Give a task** — Describe what you want in natural language. Eligible shell
   commands first run in the sandbox. Only a proven pre-start host boundary
   reaches Edits approval or Auto[LLM] review; an Auto denial asks the Agent to
   use a safer route instead of automatically prompting you.
3. **Review changes** — KodaX shows diffs before applying edits. Use Plan mode
   (Shift-Tab) to see a plan before any edits are made.
4. **Run tests** — Ask KodaX to run your test suite and fix failures.
5. **Continue a session** — Sessions persist per project. Use `kodax -r` to
   resume the last session or `kodax -c` to continue with a new prompt.

## Next steps

- [Configuration files](../configuration/config-files.md) — Core settings and precedence
- [Permissions](../configuration/permissions.md) — Sandbox-first permission profiles
- [Sandbox](../configuration/sandbox.md) — Platform containment and setup
- [SDK embedder guide](../sdk/embedder-guide.md) — Embed KodaX in your own application
