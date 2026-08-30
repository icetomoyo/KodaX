# Configuration Files

KodaX reads configuration from `~/.kodax/` with a strict split-file layout.

## File layout

| File | Purpose |
|---|---|
| `~/.kodax/config.json` | Core configuration (strict JSON) |
| `~/.kodax/config.example.jsonc` | Annotated reference with all settings |
| `~/.kodax/exec-policy.jsonc` | User host-execution policy (optional JSONC) |
| `~/.kodax/integrations/mcp.json` | MCP server definitions |
| `~/.kodax/integrations/extensions.json` | Extension definitions |
| `~/.kodax/integrations/a2a.json` | A2A agent definitions |

The first line of `config.example.jsonc` points to all split files and documents
every supported core setting.

## Core config example

```json
{
  "provider": "zhipu-coding",
  "effort": "auto",
  "runtimeMode": "daemon"
}
```

## Environment variables

Not every setting has a `KODAX_*` environment-variable equivalent. Common
supported mappings include the table below; additional provider, fallback,
repo-intelligence, and diagnostic mappings are documented in the annotated
template. Settings without a mapping, including `autoReview.policy`, use the
JSON file or an explicit SDK option. Resolution order for supported environment
overrides:

1. Explicit CLI/SDK option
2. Environment variable (`KODAX_*`)
3. `config.json`
4. Built-in default

| JSON key | Environment variable | Default |
|---|---|---|
| `provider` | `KODAX_PROVIDER` | — (prompted on first run) |
| `effort` | `KODAX_EFFORT` | `auto` |
| `runtimeMode` | `KODAX_RUNTIME_MODE` | `embedded` |
| (home dir) | `KODAX_HOME` | `<OS user home>/.kodax` |

JSON names stay camelCase while environment names use `KODAX_UPPER_SNAKE_CASE`.

## Runtime mode

Two Runtime hosting modes are available:

- **`embedded`** (default) — inline, lowest latency, private
- **`daemon`** — process-isolated, shared across multiple clients

Worker isolation is an SDK/host option inside embedded mode, expressed as
`{ mode: 'embedded', isolation: 'worker' }`; `worker` is not a valid
`runtimeMode` configuration value.

```bash
kodax daemon start
kodax daemon stop --profile default
kodax --runtime-mode daemon
kodax -p "Review this repository" --runtime-mode daemon
```

By default, daemon state, config, and runtime session storage use the exact
resolved `KODAX_HOME` (normally `<OS user home>/.kodax`), so CLI and SDK clients
converge on the same local daemon even when `KODAX_HOME` is a custom directory.

An explicit `--home <dir>` selects the isolated `<dir>/.kodax` namespace for
tests, CI, or project-local experiments.

## Shell environment

Model-issued shell commands inherit the host environment, including normal
development credentials. Fixed KodaX/Electron execution-control variables are
removed. The obsolete `sandbox.envPass` field is ignored for upgrade
compatibility and is not included in new templates.

## Exec Policy

Exec Policy is deliberately separate from `config.json`. It is evaluated only
when an operation is about to execute without the OS sandbox. An absent policy
file means no user rules; it never blocks startup.

```jsonc
{
  "rules": [
    {
      "prefix": [["npm", "pnpm"], "publish"],
      "decision": "prompt",
      "justification": "Publishing changes an external registry",
      "match": ["npm publish"],
      "notMatch": ["npm test"]
    }
  ]
}
```

Each rule has a token `prefix`, a decision (`allow`, `prompt`, or
`forbidden`), and a non-empty justification. `match` and `notMatch` are
load-time validation examples, not additional runtime predicates. Optional
`hostExecutable`, `network`, and `compound` qualifiers match only when the
trusted caller supplies those exact facts. The strictest matching decision
wins.

A repository policy at `<repo>/.kodax/exec-policy.jsonc` is ignored unless the
trusted SDK host opts that canonical repository root into
`execPolicy.trustedProjectRoots`. This prevents a newly checked-out repository
from granting itself unsandboxed authority. The diagnostic CLI includes it
only with `--trust-project-policy`:

```bash
kodax execpolicy check -- git push origin main
kodax execpolicy check --trust-project-policy -- git push origin main
```

## See also

- [Providers](./providers.md) — Provider configuration
- [Custom providers](./custom-providers.md) — Custom endpoint configuration
- [Sandbox](./sandbox.md) — OS-level containment
- [SDK embedder guide](../sdk/embedder-guide.md) — Runtime SDK and daemon API
