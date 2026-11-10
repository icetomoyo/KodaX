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

`workMode` is a Session selection, not a global `config.json` field. Current
unreleased sources expose `agent | coding | script` through `--work-mode`,
`/work-mode` or `client.sessions.updateSettings`. Coding is the default, Script
is experimental, and switching requires an idle Session. Clearing the override
returns to Coding; provider/model and permission settings remain independent.

```json
{
  "provider": "zhipu-coding",
  "effort": "auto"
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
| (home dir) | `KODAX_HOME` | `<OS user home>/.kodax` |

JSON names stay camelCase while environment names use `KODAX_UPPER_SNAKE_CASE`.

## Proxy and private CA

The KodaX Host reads these standard variables when it starts:

- `NODE_EXTRA_CA_CERTS=/path/to/root.pem` adds a private root CA for model requests and `web_fetch`.
- `HTTPS_PROXY` and `HTTP_PROXY` choose a proxy. Lowercase names also work.
- `NO_PROXY` lists hosts that skip the proxy, such as `localhost,127.0.0.1,.corp.example`.

On Node 22.21+ or 24.5+, also set `NODE_USE_ENV_PROXY=1`, because Node ignores the proxy variables without it. Node 20 and older 22/24 releases cannot use them; upgrade Node or use the standalone binary. The binary sends model requests through the proxy with no extra setting. Set `NODE_USE_ENV_PROXY=1` there as well if `web_fetch` must use the proxy.

```bash
export NODE_EXTRA_CA_CERTS=/etc/ssl/corp-root.pem
export HTTPS_PROXY=http://proxy.corp.example:3128
export NO_PROXY=localhost,127.0.0.1,.corp.example
export NODE_USE_ENV_PROXY=1
kodax daemon stop   # a running Host keeps the environment it started with
kodax -p "Review this repository"
```

When a proxy variable is set but some requests would bypass it, the Host writes a `[runtime:network]` warning to `kodax daemon logs`. The warning names the variable and never prints its value.

## Shared Host ownership

The product CLI uses a shared daemon Host. `runtimeMode`, `KODAX_RUNTIME_MODE`
and `--runtime-mode` are removed; do not use them to select an execution owner.
Product SDK applications use `ensureKodaXClient` or passive `connectKodaXClient`.
Explicit low-level `/runtime` embedding remains separate, and Worker-hosted
embedded Runtime is removed. See the [SDK migration guide](../../docs/SDK_MIGRATION.md).

```bash
kodax daemon start
kodax -p "Review this repository"
kodax daemon stop
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
