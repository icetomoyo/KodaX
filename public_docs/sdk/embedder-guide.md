# KodaX SDK — Embedder Integration Guide

> Audience: host applications embedding `@kodax-ai/kodax` (and its
> subpaths) as a substrate — e.g. KodaX Space's desktop wrapper, IDE
> extensions, custom CLIs. If you are an end-user running the `kodax`
> command-line tool, see the root [README.md](../../README.md) instead.

This guide reflects the released `v0.7.95` SDK. npm publication and version
assignment remain manual maintainer steps. The SDK advertises Windows
`sandboxRuntime:5`, `runtimeExitSettlement:2`, and `crashOutcomeModel:2`, and
adds self-healing Windows sandbox cleanup (a recoverable machine-global
cleanup Job, unattended recovery tickets, generation-checked background
retries, dynamic-worktree policy registration), stale learning-lock
reclamation with fullscreen terminal teardown, exact-input Explicit Skill
execution, and coding-result finalization before the public completion
signal, on top of concurrent sandboxed text mutations,
Session-persisted and Git-backlink-validated KodaX worktree roots (including
strict `core.worktree` identity for a real submodule Session root),
authorized-root git trust (`gitSafeDirectory: authorized-repo-roots`),
scheduled shutdown failure reporting, missing-workspace Run start,
`conversationHistory:2`, independent explicit Skill invocation, diagnosed
invalid `allowed-tools` / malformed hook JSON, observed text-helper stdin
failures, byte-bounded git-metadata reads, observed
Run-finalization and process-cleanup rejections, typed disconnect facts,
bounded safe failure categories, and exact-`runId` recovery after reconnect
on top of v0.7.93 failed-exit fast settlement, previous-boot ACL recovery, and
isolated Anthropic/OpenAI abort classification, plus the v0.7.92
filesystem-effect operation-token coordinator, recorded-release owners,
managed Session-before-completion ordering, and canonical-first resume
reconstruction. v0.7.91 still supplies bounded owner-scoped interactions,
stale prepared-Session recovery, crash-resumable Runtime exit settlement,
effective live output segments, and standalone lazy provider dependency
bundling.

This guide documents the SDK surfaces a host integrator needs that
are NOT obvious from inspecting the type definitions alone:

1. [MCP server management — `McpManager` runtime API](#1-mcp-server-management--mcpmanager-runtime-api)
2. [Skill `!`cmd`` dynamic-context resolution + `IVariableResolver`](#2-skill-cmd-dynamic-context-resolution--ivariableresolver)
3. [Per-app data directory namespacing — `getAppDataDir`](#3-per-app-data-directory-namespacing--getappdatadir)
4. [Cross-reference: other FEATURE_186 surfaces](#4-cross-reference-other-feature_186-surfaces)
5. [Consuming from a CommonJS context (Electron main, CJS bundles)](#5-consuming-from-a-commonjs-context-electron-main-cjs-bundles)
6. [Session persistence — wiring `runKodaX` to disk](#6-session-persistence--wiring-runkodax-to-disk)
7. [Local development via `npm link` (iterating against in-tree KodaX)](#7-local-development-via-npm-link-iterating-against-in-tree-kodax)
8. [User-authored agents — markdown loader + extension `registerAgent`](#8-user-authored-agents--markdown-loader--extension-registeragent-feature_191-v0743)
9. [Electron + `stdio: 'inherit'` on Windows — PowerShell input hijack](#9-electron--stdio-inherit-on-windows--powershell-input-hijack)
10. [Model capabilities — context window, reasoning, descriptors](#10-model-capabilities--context-window-reasoning-descriptors)
11. [Workflow process events and lifecycle controls](#11-workflow-process-events-and-lifecycle-controls-feature_229-v0750)
12. [Provider credential verification — `verifyProviderCredential`](#12-provider-credential-verification--verifyprovidercredential-feature_216-v0745)
13. [Inject your product's manual — `selfManual`](#13-inject-your-products-manual--selfmanual-feature_221-v0747)
14. [Media input artifacts — `@kodax-ai/kodax/media`](#14-media-input-artifacts--kodax-aikodaxmedia-feature_239-v0756)
15. [Space v0.7.57 follow-up ledger](#15-space-v0757-follow-up-ledger)
16. [SDK agent-profile surface — `KodaXAgentProfile`](#16-sdk-agent-profile-surface--kodaxagentprofile-feature_247-v0758)
17. [Runtime SDK, Worker isolation, and local daemon](#17-runtime-sdk-worker-isolation-and-local-daemon-feature_253-feature_257)
18. [External-agent executor plane](#18-external-agent-executor-plane-feature_258-v0767)
19. [Session surface filtering and cursor pagination](#19-session-surface-filtering-and-cursor-pagination-feature_261-v0767)
20. [Cost-disciplined workflow routing and telemetry](#20-cost-disciplined-workflow-routing-and-telemetry-feature_259-v0767)
21. [Experimental governed memory — `/experimental-memory`](#21-experimental-governed-memory--experimental-memory-feature_260--feature_275-v0768v0777)
22. [Bidirectional A2A 1.0 — `/a2a`](#22-bidirectional-a2a-10--a2a-feature_267-v0769)
23. [Shared Coder daemon for Space and IDE hosts](#23-shared-coder-daemon-for-space-and-ide-hosts-feature_269-v0769)
24. [Runtime-owned Auto Mode and plan-approval bridges](#24-runtime-owned-auto-mode-and-plan-approval-bridges-v0772v0773)
25. [Always-on context compaction and bounded transcript recovery](#25-always-on-context-compaction-and-bounded-transcript-recovery-v0774)
26. [Agent mailbox control versus SDK event telemetry](#26-agent-mailbox-control-versus-sdk-event-telemetry-v0774)
27. [Windows GUI background subprocess visibility](#27-windows-gui-background-subprocess-visibility-v0775)
28. [Host-configurable Shell Execution Contract](#28-host-configurable-shell-execution-contract-v0777)
29. [Evidence-gated background Skill learning](#29-evidence-gated-background-skill-learning-feature_263-v0778)
30. [Standalone sandbox SDK](#30-standalone-sandbox-sdk-v0778)
- [Learned Skill promotion reference](#learned-skill-promotion-reference-v0778)

§1–§3 (and the Phase-7/8 MCP-popout surface in §1) land in v0.7.42
under FEATURE_186 (see [ADR-032](../../docs/ADR.md#adr-032-sdk-embedder-surface-closure-feature_186-v0742)).
§5 documents the ESM-only packaging contract and the canonical
`await import(...)` recipe for CJS / Electron main consumers.

> **Code examples in §1–§4 use static ESM `import`** — that's the
> shape ESM consumers (Node `"type": "module"`, Vite, modern Electron
> renderer with `nodeIntegration: true`+ESM) want. **If your host
> compiles to CJS** (Electron main process, legacy Webpack CJS bundle,
> `tsc --module commonjs`), every static `import` example becomes
> `await import(...)` — see §5 for the full recipe and bundler
> configuration.

---

## 1. MCP server management — `McpManager` runtime API

### Why this exists

`@kodax-ai/kodax/mcp` re-exports `McpCapabilityProvider`, which is the
class KodaX uses internally to plug MCP into the agent runtime. Its
methods are capability-provider-shaped (`search` / `describe` /
`execute` / `read` / `getPrompt`) — that's the substrate-facing API,
not what a popout UI needs.

`McpManager` is a thin facade exposing the **popout-shape** API for
the lifecycle operations a host UI typically renders:

```
+- MCP Servers (popout) -+
| filesystem    [Ready]  | <- listServers row
| git           [Idle]   |
| sqlite        [Error]  |
+------------------------+
| [Start] [Stop] [Logs]  | <- startServer / stopServer / getServerLogs
| [View tools]           | <- listTools / getCatalog
+------------------------+
```

### Quick start

```ts
import { createMcpManager } from '@kodax-ai/kodax/mcp';
import { listMcpServers } from '@kodax-ai/kodax/repl';

// Build manager from the persisted ~/.kodax/config.json `mcpServers` section.
// listMcpServers reads the CRUD module's view of disk state.
const manager = createMcpManager(listMcpServers());

// Enumerate all configured servers (lazy + prewarm + disabled all included).
const rows = manager.listServers();
for (const row of rows) {
  console.log(`${row.serverId}: status=${row.status}, tools=${row.tools}`);
}

// Force connect + catalog refresh for a single server.
const started = await manager.startServer('filesystem');
console.log(`filesystem now: ${started.status}, ${started.tools} tools`);

// Tools-only view (popout's "tools" tab).
const toolList = await manager.listTools('filesystem');
for (const tool of toolList.tools) {
  console.log(`  - ${tool.name}: ${tool.description ?? '(no description)'}`);
}

// Full catalog (tools + resources + prompts) — popout's "all capabilities" tab.
const catalog = await manager.getCatalog('filesystem');
for (const descriptor of catalog.descriptors) {
  console.log(`  [${descriptor.kind}] ${descriptor.id}`);
}

// Last error + status for the "Logs" pane.
const logs = manager.getServerLogs('filesystem');
console.log(`status=${logs.status}, lastError=${logs.lastError ?? '(none)'}`);

// Disconnect transport (server stays in config; status flips to idle).
await manager.stopServer('filesystem');

// Tear down all runtimes when the popout closes / app exits.
await manager.dispose();
```

### Method reference

| Method | Returns | Purpose |
|---|---|---|
| `listServers()` | `McpServerStatus[]` | One row per configured server: `status`, `tools`/`resources`/`prompts` counts, `lastError`, `cachedAt`, deep-cloned `config`. Synchronous (uses cached diagnostics). |
| `startServer(id)` | `Promise<McpServerStatus>` | Force `refreshCatalog(true)`. Connects (or reconnects), re-lists tools/resources/prompts, writes the disk cache. Throws on unknown id. |
| `stopServer(id)` | `Promise<McpServerStatus>` | Dispose transport. Server stays in config so a subsequent `startServer` / `listTools` reconnects cleanly. |
| `getServerLogs(id)` | `McpServerLogs` | `{ status, connect, lastError?, cachedAt? }`. Designed as the data source for a "Logs" pane. **v0.7.42 is intentionally conservative** — only last error + status are exposed. Future iterations may add a ring buffer; the field shape will extend, never break. |
| `listTools(id, { forceRefresh? })` | `Promise<McpServerToolList>` | Tools-only filtered descriptors. Triggers lazy connect on cold cache. |
| `getCatalog(id, { forceRefresh? })` | `Promise<McpServerCatalog>` | Full catalog: `items` (lightweight) + `descriptors` (full) for tools, resources, and prompts. |
| `dispose()` | `Promise<void>` | Dispose all runtimes. After this, build a fresh `McpManager` to reuse. |
| `provider()` | `McpCapabilityProvider` | Escape hatch — the underlying capability-provider for advanced uses. |
| `execute(id, input)` | `Promise<CapabilityResult>` | Invoke a tool by capability id (`mcp:<serverId>:tool:<name>`). |
| `describe(id)` | `Promise<McpCapabilityDescriptor \| undefined>` | Resolve a single descriptor by capability id. |
| `search(query, options?)` | `Promise<readonly McpCatalogItem[]>` | Cross-server catalog search. |
| `read(id, options?)` | `Promise<CapabilityResult>` | Read a resource by capability id. |

### Server lifecycle states

`McpServerStatus.status` values:

| Status | Meaning |
|---|---|
| `idle` | Configured, not yet connected. Lazy default until first tool call. |
| `connecting` | Connection in progress (transient). |
| `ready` | Connected, catalog cached. |
| `error` | Last connect / refresh failed. `lastError` carries the message. |
| `disabled` | `connect: 'disabled'` in config — runtime exists but won't be used. |

### Adding / removing servers

For server **config** CRUD (write to `~/.kodax/config.json`), use the
`@kodax-ai/kodax/repl` subpath — kept separate from `/mcp` to keep
the latter dependency-free:

```ts
import { listMcpServers, upsertMcpServer, removeMcpServer } from '@kodax-ai/kodax/repl';

upsertMcpServer('filesystem', {
  type: 'stdio',
  command: 'mcp-server-filesystem',
  args: ['/repo'],
  connect: 'lazy',
});

// Remote servers: `type: 'streamable-http'` or `'sse'`. For ecosystem-config
// compatibility you may also use `type: 'http'` (v0.7.48+) — a config-layer
// alias that auto-detects Streamable HTTP first, then falls back to legacy
// HTTP+SSE. OAuth-protected servers are zero-config: omit `auth` endpoint
// fields and KodaX discovers + dynamically registers on the first 401.

// In-flight `McpManager` does NOT hot-pickup config changes. The
// standard pattern is: edit config, then construct a fresh manager
// (or call dispose() + createMcpManager again) before the next agent
// turn.
await manager.dispose();
const refreshed = createMcpManager(listMcpServers());
```

### Trust boundary

KodaX is a single-user CLI; the manager is last-write-wins. A popout
that swaps configs hot constructs a fresh manager — there is no
file-locking layer in v0.7.42. If your host needs multi-process
coordination (e.g. KodaX Space's popout window AND the main agent
both writing the same config), you mediate at your IPC layer.

---

## 2. Skill `!`cmd`` dynamic-context resolution + `IVariableResolver`

### Why this exists

Skills (`SKILL.md` files in `~/.kodax/skills/<name>/` etc.) support
**dynamic context** — markdown can embed `!`shell-command`` tokens
that are replaced with the command's stdout at resolution time:

```markdown
---
name: incident-report
description: Generate an incident summary from current repo state.
---

Current git status:
!`git status --short`

Recent commits:
!`git log --oneline -10`
```

Default behavior (no host hook): `VariableResolver` directly
`execSync`s each command with an internal allowlist. **For host
applications** (KodaX Space, IDE extensions, sandboxed substrates)
this is rarely the right behavior — the host typically wants to
mediate every shell execution through its own permission broker,
audit trail, or policy gate.

v0.7.42 (FEATURE_186 Phase 3) added a host hook on `SkillContext`
that intercepts every `!`cmd`` execution.

### Invocation ownership: explicit user vs model

Skill discovery and explicit invocation are intentionally separate:

- Model invocation sees only the name/description catalog for Skills whose
  `disableModelInvocation` value is false. The coding `skill` tool enforces the
  same gate before loading full content.
- Every enabled Skill remains explicitly user-invocable. `/<name>` and
  `/skill:<name>` may appear at the head or middle of a user query; text after
  the selected token is the argument string. A request may activate only one
  known Skill; multiple references return a user-visible diagnostic and do not
  execute the first one partially.
- `SkillRegistry.invoke()` is an explicit SDK primitive. It is not blocked by
  `disable-model-invocation: true`; an embedder exposing it to a model must add
  its own model-tool admission instead of treating the registry as that gate.
- The legacy `user-invocable` frontmatter field and Runtime DTO field are kept
  for compatibility. Enabled Skills report `userInvocable: true`.

```ts
import { SkillRegistry } from '@kodax-ai/kodax/skills';

const registry = new SkillRegistry(process.cwd());
await registry.discover();

const modelCatalog = registry.getSystemPromptSnippet(); // model-visible only
const explicit = await registry.invoke('manual-only-skill', 'src/', {
  workingDirectory: process.cwd(),
  projectRoot: process.cwd(),
  disableDynamicContext: true,
});
```

Terminal embedders accepting raw user text can reuse
`resolveUserSkillInvocation` and `prepareInvocationExecution` from
`@kodax-ai/kodax/repl`. The first resolves trusted registry membership and
builds structured `skillInvocation`; the second owns hooks, permission policy,
fork context, and finalization. Expanded Skill content belongs in structured
system context exactly once, not in both the user prompt and system prompt.
`prepareInvocationExecution()` preserves the exact submitted text in
`context.rawUserInput`; canonical transcripts and titles use that field, while
generated Skill wording, lifecycle-hook context, and command expansion remain
execution-only overlays. Hosts must persist/display the raw request, not the
prepared provider prompt. A malformed or failed `PreToolUse` hook denies the
guarded tool; `PostToolUse` failures remain diagnostic because the completed
tool effect cannot be undone.

That structured field is also the delegation provenance boundary. Workflow and
child runs inherit an active explicit Skill. A slash token written only inside
a model-authored child objective is a new model invocation and must pass the
governed `skill` tool; it cannot bypass `disable-model-invocation`.

### Quick start

```ts
import { createResolver, resolveSkillContent } from '@kodax-ai/kodax/skills';
import type { SkillContext } from '@kodax-ai/kodax/skills';

const context: SkillContext = {
  workingDirectory: '/repo',
  projectRoot: '/repo',
  sessionId: 'session-1',
  environment: process.env as Record<string, string>,

  // v0.7.42 — host hook for !`cmd` execution.
  executeDynamicContext: async (command, cwd) => {
    // Route through the host's permission broker.
    const approved = await brokerAskUser({
      kind: 'skill-shell-command',
      command,
      cwd,
    });
    if (!approved) {
      throw new Error('User denied shell command execution');
    }
    // Run via the host's audited shell wrapper.
    const { stdout } = await brokerExecute(command, { cwd });
    return stdout;
  },
};

const resolved = await resolveSkillContent(skill.content, '', context);
// resolved.content has !`cmd` tokens replaced with stdout (or the
// command was rejected and the resolver substituted an error
// banner — depending on your hook's throw behavior).
```

### Disabling dynamic context entirely

For maximum-safety hosts (e.g. a security-audit popout), set
`disableDynamicContext: true` — every `!`cmd`` token is replaced with
a refusal banner regardless of any hook:

```ts
const context: SkillContext = {
  workingDirectory: '/repo',
  projectRoot: '/repo',
  sessionId: 'session-1',
  environment: {},
  disableDynamicContext: true,
};
```

### Resolution priority (3-tier dispatch)

```
+- VariableResolver.executeDynamicCommand ------+
|                                                |
|  1. context.disableDynamicContext === true    |
|     -> throw "Dynamic context disabled"       |
|                                                |
|  2. context.executeDynamicContext is set      |
|     -> await hook(command, cwd)               |
|                                                |
|  3. (legacy fallback)                         |
|     -> isSafeDynamicContextCommand allowlist  |
|     -> execSync (with built-in restrictions)  |
|                                                |
+------------------------------------------------+
```

**Hosts should always set `executeDynamicContext`** — the legacy
fallback exists for the standalone `kodax` CLI use case where the
end-user implicitly trusts their own machine's shell. Embedded
hosts have a different trust boundary (user trusts the host UI,
host UI mediates everything else).

### The LLM-triggered `skill` tool path — `KodaXOptions.skillDynamicContext` (v0.7.58)

The `SkillContext` hook above covers Skills your host explicitly expands via
`resolveSkillContent` or `SkillRegistry.invoke()`. A model-visible Skill can
also be **auto-triggered by the model** through the built-in `skill` tool — and
that path builds its own `SkillContext`
internally, so it does not see your `resolveSkillContent` hook. Without wiring,
an auto-triggered `SKILL.md` (including a cloned project-level
`.kodax/skills/*`) would run its `` !`cmd` `` blocks through the built-in
`execSync` allowlist, bypassing your permission broker.

Thread the same policy into the tool path via `runKodaX`/`startKodaX` options:

```ts
import { runKodaX } from '@kodax-ai/kodax/coding';

await runKodaX(
  {
    provider: 'anthropic',
    skillDynamicContext: {
      // Same shape as SkillContext.executeDynamicContext — route through your broker.
      execute: async (command, cwd) => brokerExecute(command, cwd),
      // …or refuse all dynamic-context commands outright:
      // disable: true,
    },
  },
  prompt,
);
```

Absent this option the tool path keeps the trusted-CLI `execSync` fallback
(unchanged), so setting `skillDynamicContext.execute` (or `disable: true`) is the
supported way for an embedder to bring the auto-triggered path under the same
policy as the manual one.

### `IVariableResolver` entry points

| Symbol | Purpose | Source |
|---|---|---|
| `IVariableResolver` (interface) | Type contract — `resolve(content): Promise<string>` | `@kodax-ai/kodax/skills` |
| `VariableResolver` (class) | Stock implementation; reads `context.executeDynamicContext` if present, otherwise legacy `execSync` | `@kodax-ai/kodax/skills` |
| `createResolver(context)` (factory) | Returns a fresh `IVariableResolver` bound to the given context | `@kodax-ai/kodax/skills` |
| `resolveSkillContent(content, args, context)` (top-level) | High-level convenience — constructs resolver internally + resolves a single skill body | `@kodax-ai/kodax/skills` |

Hosts that want to ship a fully custom resolver (e.g. replace the
default with a JS-only sandbox) can implement `IVariableResolver`
directly and call `resolver.resolve(content)` themselves — KodaX's
own skill execution path calls through this interface.

### Argument parsing

`parseArguments(args: string): string[]` is exported alongside the
resolver. Use it to convert the raw `$ARGS` string into a parsed
positional array matching the skill's `argumentHint`.

---

## 3. Per-app data directory namespacing — `getAppDataDir`

### Why this exists

`~/.kodax/` is KodaX's own state directory — sessions, custom
providers, MCP servers, instances heartbeat, etc. all live under it.
Embedder hosts often need their **own** state directory adjacent to
KodaX's:

- IDE extension: store extension-local cache (`recents`, layout
  prefs, popout snapshot).
- KodaX Space: store desktop-app preferences (window position,
  theme, last-opened project).

Letting every host pick its own dir leads to multi-app conflict
(two extensions both writing `~/.kodax/cache/`) — and writing
inside `~/.kodax/` itself risks collision with KodaX's own keys.

`getAppDataDir(appId)` carves out a namespaced subdirectory under
`<KODAX_HOME>/apps/<appId>/` with reserved-name guards.

### Quick start

```ts
import { getAppDataDir } from '@kodax-ai/kodax/coding';

// Returns <KODAX_HOME>/apps/space/  (default: ~/.kodax/apps/space/)
// mkdirSync({recursive:true}) is called for you.
const spaceDir = getAppDataDir('space');

// Persist host-specific state inside that dir.
writeFileSync(path.join(spaceDir, 'window-state.json'), JSON.stringify(state));
```

### Namespace rules

`appId` is validated against `^[a-z][a-z0-9-]{1,31}$`:

- Must start with a lowercase letter.
- May contain lowercase letters, digits, `-`.
- 2-32 characters total.
- Reserved prefix: `kodax-*` (and the bare string `kodax`) — rejected
  to prevent host apps from squatting on names that look like KodaX's
  own subsystems.

| `appId` | Result |
|---|---|
| `space` | ✓ `<KODAX_HOME>/apps/space/` |
| `kodax-space-helper` | ✗ `Error: reserved appId prefix 'kodax-*'` |
| `MyApp` | ✗ `Error: appId must match /^[a-z][a-z0-9-]{1,31}$/` |
| `a` | ✗ `Error: appId must be 2-32 chars` |

### Interaction with `setAgentConfigHome`

`getAppDataDir` resolves `<KODAX_HOME>` via `getAgentConfigHome()` on
every call — so a host that called `setAgentConfigHome('/custom')`
before the first `getAppDataDir('space')` lands at
`/custom/apps/space/`. Useful for:

- **Tests**: per-test temp dir override.
- **Multi-tenant**: route different tenants to different home dirs.

```ts
import { setAgentConfigHome, getAppDataDir } from '@kodax-ai/kodax/coding';

setAgentConfigHome('/srv/tenant-42/.kodax');
const dir = getAppDataDir('space');
// dir === '/srv/tenant-42/.kodax/apps/space/'
```

---

## 4. Cross-reference: other FEATURE_186 surfaces

The three surfaces above are the most "needs-a-guide" pieces.
FEATURE_186 ships several additional SDK exports that are self-
documenting from type signatures but are worth knowing:

| Subpath | Symbol | Purpose |
|---|---|---|
| `@kodax-ai/kodax` | `runKodaX(opts, prompt)` | Blocking `Promise<KodaXResult>` — the original entry. |
| `@kodax-ai/kodax/coding` | `startKodaX(opts, prompt): RunningSession` | Non-blocking handle. See [RunningSession docs](#running-session-quick-reference). |
| `@kodax-ai/kodax/coding` | `createSessionControl()` | Bare `KodaXSessionControl` for advanced wiring. |
| `@kodax-ai/kodax/coding` | `getAgentConfigPath(name)` | Resolves `<KODAX_HOME>/<name>` dynamically. |
| `@kodax-ai/kodax/coding` | `setAgentConfigHome(path \| undefined)` | Override KODAX_HOME for tests / multi-tenant. |
| `@kodax-ai/kodax/coding` | `validateCustomProviderConfig(config)` | Same validator the SDK uses internally — no parallel schemas. |
| `@kodax-ai/kodax/coding` | `ToolSideEffect` + 4 helpers | Tool metadata (`readonly` / `mutates-fs` / `mutates-shell` / `mutates-network` / `mutates-state`) for plan-mode gates + custom permission UIs. |
| `@kodax-ai/kodax/coding` | `loadAgentsFiles(opts?)` | Load `AGENTS.md` cascade (project + user + global) for prompt assembly. |
| `@kodax-ai/kodax/repl` | `bootstrapAutoMode(...)` | Bootstrap the auto-mode classifier guardrail. |
| `@kodax-ai/kodax/repl` | `loadCommands(...)` / `KODAX_COMMANDS_DIR` | Discover user-defined slash commands. |
| `@kodax-ai/kodax/repl` | `listCustomProviders` / `upsertCustomProvider` / `removeCustomProvider` | Custom LLM provider CRUD. |
| `@kodax-ai/kodax/repl` | `listMcpServers` / `upsertMcpServer` / `removeMcpServer` / `validateMcpServerConfig` | MCP server config CRUD. |
| `@kodax-ai/kodax/skills` | `IVariableResolver` / `VariableResolver` / `createResolver` | See [section 2](#2-skill-cmd-dynamic-context-resolution--ivariableresolver). |

### RunningSession quick reference

```ts
import { startKodaX } from '@kodax-ai/kodax/coding';

const session = startKodaX({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, 'review this PR');
console.log(session.id);                // freshly minted or echoes opts.session.id

// Mid-run mutators — applied on the next turn (CAP-055 per-turn re-resolution).
session.setProvider('zhipu');
session.setModel('glm-4.6');
session.setReasoning('balanced');       // KodaXReasoningMode: 'off' | 'auto' | 'quick' | 'balanced' | 'deep'

// Cooperative abort.
setTimeout(() => session.abort('user cancelled'), 30_000);

// Await the eventual result.
const result = await session.result;
console.log(result.finalMessage);
```

Constructor-supplied `options.abortSignal` is forwarded into the
internal `AbortController`; calling either signal aborts the run.

---

## 5. Consuming from a CommonJS context (Electron main, CJS bundles)

### TL;DR

`@kodax-ai/kodax` and **all** its subpaths are published **ESM-only**.
In a CommonJS context — Electron's main process (`vm.mainModule` runs
as CJS by default), legacy Webpack/esbuild configs with
`format: 'cjs'`, or any code path that ends up calling `require()` —
you must use dynamic `import()` instead of static `import` /
`require`. Both Node 22+ and Node 20.19+ support dynamic-importing
ESM from CJS without flags.

```ts
// ❌ This breaks in CJS — esbuild / tsc transforms static `import`
//    into `require('@kodax-ai/kodax/mcp')`, which Node then rejects
//    with ERR_PACKAGE_PATH_NOT_EXPORTED because our `exports` only
//    declares the `import` condition.
import { McpManager } from '@kodax-ai/kodax/mcp';

// ✅ Use dynamic import — Node resolves it via the ESM loader and
//    matches our `import` condition.
const { McpManager } = await import('@kodax-ai/kodax/mcp');
```

`import type { ... }` is **fine in CJS** — TypeScript / esbuild strip
type-only imports at compile time, so they never become runtime
`require()` calls:

```ts
import type { McpManager, McpServerStatus } from '@kodax-ai/kodax/mcp';
// ↑ compiles to nothing at runtime
```

### Why we don't ship dual ESM/CJS bundles

The natural fix would be to add `"require": "./dist/sdk-*.cjs"` next
to the existing `"import"` condition in `package.json#exports`. We
investigated this for v0.7.42 and the technical reality blocks all
the subpaths embedders typically reach for:

| Subpath | ESM-only third-party deps inlined | Dual feasible? |
|---|---|---|
| `/agent` | 0 | ✅ feasible (no UI deps) |
| `/mcp` | 0 | ✅ feasible (no UI deps) |
| `/skills` | 1 (`yaml`) | ❌ |
| `/llm` | 2 (`@agentclientprotocol/sdk`, `partial-json`) | ❌ |
| `/coding` | 4 (`yaml`, `tsx`, …) | ❌ |
| `/repl` | **21** (`ink`, `chalk`, `react`, `ansi-escapes`, …) | ❌ |
| root | 21 (same as `/repl`) | ❌ |

Once a bundle inlines any ESM-only dependency, the bundle itself
cannot be a valid CJS module — `require()`ing it would synchronously
import an ESM dep, which Node refuses. `ink`, `chalk`, and most of
the modern terminal-UI ecosystem are ESM-only as of 2024–2026, with
no plans to dual-publish.

**Dynamic `import()` is the canonical fix**, not a workaround. It
is part of the ECMAScript standard, supported in CJS contexts by
spec, and is how Node itself recommends consuming ESM from CJS today.

### Electron main process recipe

Electron's main process is CJS by default (`require('electron')`
works because main runs without `"type": "module"`). The pattern
that drops cleanly into existing Electron code:

```ts
// main.ts (or main.cjs) — Electron main process
import type { McpManager } from '@kodax-ai/kodax/mcp';            // compile-time only
import type { RunningSession } from '@kodax-ai/kodax/coding';     // compile-time only

let mcpManager: McpManager | null = null;
let kodax: typeof import('@kodax-ai/kodax/coding') | null = null;

async function bootKodaX() {
  // Bundle these dynamic imports as runtime-resolved (don't let
  // esbuild rewrite them — see "Bundler config" below).
  const { createMcpManager } = await import('@kodax-ai/kodax/mcp');
  const { listMcpServers } = await import('@kodax-ai/kodax/repl');

  kodax = await import('@kodax-ai/kodax/coding');
  mcpManager = createMcpManager(listMcpServers());
}

app.whenReady().then(bootKodaX);

// Wire to IPC handlers — your popout UI calls these.
ipcMain.handle('mcp:listServers', () => mcpManager!.listServers());
ipcMain.handle('mcp:startServer', (_, id: string) => mcpManager!.startServer(id));
ipcMain.handle('mcp:listTools', (_, id: string) => mcpManager!.listTools(id));
ipcMain.handle('mcp:getServerLogs', (_, id: string) => mcpManager!.getServerLogs(id));

ipcMain.handle('kodax:run', async (_, prompt: string) => {
  const session = kodax!.startKodaX({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, prompt);
  return session.result;
});
```

### Bundler configuration

Most bundlers (esbuild, Webpack, Vite, Rollup) will, by default,
transform `await import(x)` into `require(x)` when targeting CJS.
You must tell the bundler to **preserve** the dynamic import:

**esbuild**:

```js
build({
  format: 'cjs',
  platform: 'node',
  // Keep dynamic imports as-is so they resolve to the ESM bundle at runtime.
  external: ['@kodax-ai/kodax', '@kodax-ai/kodax/*'],
})
```

Alternatively, mark only `@kodax-ai/kodax` as external — bundlers
that respect `external` will not rewrite dynamic imports of external
modules.

**Webpack**: add `@kodax-ai/kodax` (and any subpaths you use) to
`externals`, e.g. `{ '@kodax-ai/kodax/mcp': 'commonjs2 @kodax-ai/kodax/mcp' }`.

**Vite**: in `vite.config.ts` SSR / Electron-main builds, add
`@kodax-ai/kodax` and subpaths to `ssr.external`.

If the bundler still rewrites the dynamic import, the symptom is a
synchronous `Error: ERR_REQUIRE_ESM` (Node ≤ 20) or
`ERR_PACKAGE_PATH_NOT_EXPORTED` (Node 22+). Fix the bundler config
before suspecting our package.

### When you really need synchronous CJS

If your host environment cannot adopt `await import(...)` (rare —
even old Webpack supports it via `import()` syntax preserved through
to runtime), the two subpaths with zero ESM-only deps (`/agent` and
`/mcp`) are the **only** ones that could in principle ship a CJS
build. We have not productized this yet — file an issue with your
concrete blocker (sync popout startup, specific bundler limitation,
etc.) and we'll evaluate adding a partial-dual emit for those two
subpaths in a follow-up release.

### Quick checklist before reporting "it doesn't work in CJS"

- [ ] `package.json#type` in **your** project — if it's `"module"`,
      static `import` works; if absent / `"commonjs"`, you need
      dynamic `await import()`.
- [ ] Your bundler emit format — `format: 'cjs'` + static `import`
      from KodaX subpaths will always fail.
- [ ] You used `import type { ... }` not `import { ... }` for
      type-only references (otherwise they survive as runtime
      `require`).
- [ ] Bundler is set to **external** `@kodax-ai/kodax` (or skip
      bundling subpath imports entirely).
- [ ] Node version ≥ 20.19 (or ≥ 22 for the more permissive
      `--experimental-require-module` default).

---

## 6. Session persistence — wiring `runKodaX` to disk

### The trap

```ts
import { runKodaX } from '@kodax-ai/kodax/coding';

await runKodaX(
  {
    provider: 'zhipu-coding',
    session: { id: 's_my_chat', scope: 'user' },  // ← session.id set
  },
  'reply with: ok',
);
// ✗ Run completes, LLM streams, events fire — but
// ~/.kodax/sessions/s_my_chat.jsonl does NOT exist.
```

`session.id` alone is **not** enough. The SDK's snapshot path is
gated on `options.session.storage`:

```ts
// packages/coding/src/agent-runtime/middleware/session-snapshot.ts
if (!options.session?.storage) {
  return;   // silent no-op
}
```

This is by design — the CLI ships its own storage wiring, and the
SDK doesn't want to force a disk-write side-effect onto every
embedder (some hosts persist to a DB / cloud / IndexedDB instead).
But the contract was previously **undocumented**, so SDK consumers
typically hit this once before learning the rule.

**v0.7.43 added a one-shot `console.warn` when `session.id` is set
but `session.storage` is missing** — it points at this section.

**v0.7.63 narrows that warning to caller-provided session IDs.** The
`startKodaX()` convenience wrapper may generate a handle ID for the returned
running-session object; that generated ID is threaded into the run only when it
will not override auto-resume/resume discovery, and it no longer triggers the
missing-storage warning by itself.

### The canonical fix

```ts
import { runKodaX } from '@kodax-ai/kodax/coding';
import {
  createSessionManager,
  exportSessionBundle,
} from '@kodax-ai/kodax/session';

// One manager per host process; reuse across runs so the
// per-session write queue + append-watermark caches stay coherent.
const {
  storage,
  listSessions,
  loadSession,
  loadFullTranscript,
  readFullTranscript,
  readSessionCapture,
  appendClientNotice,
  compactSession,
} = createSessionManager();

await runKodaX(
  {
    provider: 'zhipu-coding',
    session: {
      id: 's_my_chat',
      scope: 'user',
      storage,                  // ← key — wire the storage instance
    },
  },
  'reply with: ok',
);
// ✓ ~/.kodax/sessions/s_my_chat.jsonl now exists after the run.

// Same `storage` instance reads back through SessionManager:
const recent = await listSessions({
  scope: 'user',
  surface: 'acp',
  limit: 50,
});
const nextPage = recent.at(-1)?.cursor
  ? await listSessions({
      scope: 'user',
      surface: 'acp',
      limit: 50,
      cursor: recent.at(-1)?.cursor,
    })
  : [];
const replay = await loadSession('s_my_chat');
const scrollback = await loadFullTranscript('s_my_chat');
const historyAbort = new AbortController();
const strictScrollback = await readFullTranscript('s_my_chat', {
  timeoutMs: 15_000,
  signal: historyAbort.signal,
});
const capture = await readSessionCapture('s_my_chat', {
  timeoutMs: 15_000,
});
const bundle = await exportSessionBundle('s_my_chat', {
  timeoutMs: 15_000,
});
const compacted = await compactSession('s_my_chat', { dryRun: true });

await appendClientNotice('s_my_chat', {
  source: 'space',
  content: '/doctor ok',
});
```

`readSessionCapture()` returns the active `data` and full `transcript` from one
immutable storage boundary. `readFullTranscript()` and
`readSessionCapture()` are strict read-only APIs: timeout/cancellation,
corruption, version drift, or resync fail explicitly and never trigger legacy
Session migration or recovery. `exportSessionBundle()` preserves the exact
main/sidecar bytes with hashes and compatibility diagnostics; use it for a
support or recovery bundle, not as proof that a Session can resume.

### Auto-resume selection in v0.7.74

With `session.autoResume: true` (or `resume: true`) and no explicit ID, KodaX
calls `storage.list(context.gitRoot, { limit: 1000 })` and chooses the first
newest-first summary whose `msgCount > 0`. This prevents newer zero-message
ACP/bootstrap placeholders from shadowing a real conversation. An explicit
`session.id` always wins. Custom `KodaXSessionStorage` implementations should
therefore honor the optional `limit` argument and return `msgCount` accurately;
they may return fewer than 1000 records.

The standalone interactive CLI additionally restores the persisted
workspace/runtime identity before the next turn. SDK embedders still own
`context.gitRoot`, `context.executionCwd`, and storage construction; do not rely
on process cwd as a substitute for host-owned runtime context.

### What `createSessionManager()` returns (v0.7.43+)

```ts
interface SessionManager {
  // Read side (FEATURE_173 v0.7.42)
  listSessions(...): Promise<SessionSummary[]>;
  loadSession(id): Promise<...>;
  loadFullTranscript(id): Promise<...>;
  readFullTranscript(id, options?): Promise<...>;
  readConversationHistory(id, options?): Promise<...>;
  readSessionCapture(id, options?): Promise<SessionReadCapture | null>;
  appendClientNotice(id, opts): Promise<SessionTranscriptEntry | null>;
  compactSession(id, opts?): Promise<CompactSessionResult>;
  forkSession(id, opts?): Promise<...>;
  rewindSession(id, opts?): Promise<...>;
  setActiveEntry(id, selector): Promise<void>;
  deleteSession(id): Promise<void>;
  listRunningSessions(): Promise<RunningSessionInfo[]>;
  watchSessions(cb): () => void;
  // Write side (v0.7.43 follow-up)
  storage: FileSessionStorage;     // ← NEW — pass into runKodaX
}
```

`surface` is an exact filter applied before `limit`. Each returned summary may
include an opaque `cursor`; pass the last summary's cursor back unchanged to
continue the stable newest-first listing. Callers must not parse or construct
cursors themselves.

### Active context vs full transcript vs UI replay

Session persistence exposes three related but different layers:

| Need | Use | Meaning |
|---|---|---|
| Continue a model turn | `loadSession(id)` | Active branch only. This is the context KodaX would resume from. |
| Render the ordinary conversation | `readConversationHistory(id)` | SDK-resolved conversation order with proven compaction copies folded and ambiguity reported. |
| Render audit / raw scrollback | `readFullTranscript(id)` or `loadFullTranscript(id)` | Append-order physical entries, including archived islands and non-active branches. |
| Reuse TUI display projection | `SessionData.uiHistory` | Optional bounded replay cache. Interactive REPL sessions may write it; headless SDK sessions may not. |

For product UI, use `readConversationHistory(id)` for the ordinary chat and
keep `readFullTranscript(id)` available for an audit/details view.
`loadSession(id)` remains the model-context API. Do not assume `uiHistory`
exists; it is intentionally a small, lossy replay cache.

`loadSession(id)` and Runtime `sessions.load(id)` are pure snapshot reads. They
do not emit `session.loaded`; a host that explicitly loads a snapshot should
update its own selected/loaded UI state from the resolved promise. The
compatibility `session.loaded` event (and the CLI bridge's `onSessionStart`)
remains bound to the Provider Run execution boundary, where a Session actually
becomes active. Do not use that Run-lifecycle event as a generic data-load
notification.

`loadFullTranscript(id).transcriptEntries` is the structured host-facing
scrollback. Each entry has stable ownership and ordering fields:

```ts
interface SessionTranscriptEntry {
  entryId: string;
  parentId: string | null;
  logicalId: string;
  sourceEntryId?: string;
  timestamp: string;
  type: 'message' | 'compaction' | 'branch_summary' | 'rewind_marker' | 'client_notice' | 'task_result';
  source?: 'user' | 'assistant' | 'workflow' | 'child_task' | 'system' | 'client';
  turnId?: string;
  active: boolean;
  message: KodaXMessage;
  payload?: unknown;
  taskResults?: readonly KodaXTaskResultMetadata[];
}
```

`entryId` is the physical lineage node id. `logicalId` is stable across
forked/cloned copies of the same transcript item, and `sourceEntryId` is present
on cloned entries to point back to the direct physical predecessor copy — the
immediate source the clone was materialized from (until v0.7.89 it addressed
the transitive root source; hosts must not assume root semantics). These fields
support audit inspection, but a host must not infer the complete ordinary-chat
fold merely by grouping them: legacy omissions and conflicting metadata require
lineage validation. Use `readConversationHistory()` instead of implementing
host-side folding, and never guess from `message.role`, content, timestamp,
`turnId`, or `[compacted]` placeholders.
Legacy entries without persisted provenance use `logicalId === entryId` and omit
`sourceEntryId`; treat that as "unknown/not cloned", not as content-based proof
that no older clone exists.
`loadFullTranscript()` still returns raw append-order scrollback; it does not
hide archived islands or non-active branches, and it does not silently merge
branches. The host owns branch visibility, folding, and main-chat presentation.

`readConversationHistory()` is the supported folding boundary. Every returned
entry has a physical `boundaryId` and `auditEntryIds` naming all copies that the
SDK could prove represent the same interaction. Modern Sessions use
`logicalId` / `sourceEntryId`; legacy copies are folded only when a persisted
compaction boundary and one unique lineage suffix prove the relationship.
An inactive compaction epoch or non-leaf ancestor is crossed only when a
contiguous retained prefix has exact provenance and its complete parent path
predates the compaction in append order. Content-only legacy matching never
authorizes that fallback.
KodaX never globally sorts or deduplicates by content, timestamp, or `turnId`.

The result status is part of the contract:

- `resolved`: every fold and branch predecessor used by the projection was
  proven. A persisted Session with no conversation records is also resolved
  with empty `entries` and `issues`, including the normal interval after a Run
  is accepted but before its body enters canonical history.
- `partial`: persisted lineage or transcript identity needed for a complete
  projection of one or more existing conversation records is unavailable.
  Available physical records are retained; Actor/Run state by itself does not
  make an otherwise empty persisted conversation partial.
- `ambiguous`: multiple legacy interpretations remain. All candidates are
  retained and `issues[]` explains why; the host must not present the result as
  confidently deduplicated.

Issues are bounded diagnostic summaries: `occurrenceCount` is the number of
diagnostics represented, `entryCount` is the pre-bounding evidence-reference
count, and `entryIds` is a bounded exact sample. Conversation entries themselves
are never removed to make diagnostic metadata fit a transport page.

Runtime exposes the identical projection in embedded and daemon modes through
`sessions.conversation()`, `sessions.conversationPage()`, and
`sessions.conversationEntryChunk()`. Modern Session writes prepare a bounded
on-disk page index, so the first finite page reads only its metadata, fixed-size
index records, and requested inline bodies instead of materializing all history.
A source-boundary-fenced copy of the Session's minimal admission identity lets
the shared daemon authorize that bounded read before checking cursors, capacity,
or entry metadata; it does not perform a full Session `peek()` on a cache hit.
A cache-less older Session is upgraded by one canonical fallback read. Direct
and paged reads share the same `revision`, `sourceRevision`, status, issues, and
logical entry order. Page and chunk cursors are revision-fenced: if the Session
changes, the Runtime returns `resync_required` and the host must request a fresh
first page. Derived manifest, descriptor, and chunk reads have fixed allocation
ceilings; a corrupt or concurrently replaced generation is rejected rather
than trusted. Pages are fetched newest-tail-first while each page is internally in
forward order, so prepend each fetched page to reconstruct `conversation().entries`;
do not append pages in fetch order.
Request `requirements: { conversationHistory: 2 }` when connecting to a daemon
that must keep this projection topology-transparent across managed context and
preserve direct clone provenance. `conversationHistory: 1` is only the older
folding and paging floor. Inspect
`KODAX_RUNTIME_SDK_CAPABILITIES.conversationHistory` before auto-start so an
idle daemon that still exposes the legacy projection can be replaced.

For write-side hosts that already own a newly produced append tail,
`await FileSessionStorage.prepareSessionAppend(id)` returns an authenticated
one-shot boundary or `null` when no canonical cache witness is available.
`appendPreparedSessionTail(id, delta)` appends only the supplied new linear
lineage, artifact, and extension records. The delta deliberately has no
historical-array field: its read and compute cost is bounded by the new tail,
and a stale boundary, prefix/sidecar change, duplicate identity, non-linear
lineage tail, or concurrent durable write fails with
`SessionReadError.code === 'data_changed'`. Reload, obtain a fresh boundary,
and rebuild the tail before retrying.

The Ink REPL host follows the same rule: its prepared-tail persistence helper
falls back to `appendSessionDelta(id, data)` after `data_changed`, so the
authoritative full snapshot merges the newest UI/session state. Background
write failures are emitted as structured diagnostics; they are not swallowed
and a stale tail is never retried unchanged.

A non-null fulfilled append result is the reusable successor boundary. A
fulfilled `null` means the tail did commit exactly once, but the successor
could not be witnessed; reload before another append and do not retry that
tail. Use `appendSessionDelta(id, data)` for a full mutable snapshot, a `null`
prepared boundary, or any historical rewrite; that API performs the exact
canonical merge and persists index, nested-object, and post-helper mutations.
Data returned by `storage.load()` remains an ordinary mutable,
`structuredClone()`-compatible `KodaXSessionData` object. The derived page
cache is only a recoverable acceleration structure: its fixed-size identity
filter is accepted for appends only when its exact bundle revision and hash
match canonical metadata in the Session main file.

```ts
const baseline = await storage.prepareSessionAppend(sessionId);
if (baseline === null) {
  await storage.appendSessionDelta(sessionId, completeMutableSnapshot);
} else {
  const successor = await storage.appendPreparedSessionTail(sessionId, {
    baseline,
    title,
    activeEntryId: newEntry.id,
    lineageEntries: [newEntry],
  });
  if (successor === null) {
    await storage.load(sessionId); // committed; resync before the next tail
  }
}
```

Use a returned entry as a revision-fenced fork or rewind boundary instead of
guessing from content or a historical `turnId`:

```ts
const history = await runtime.sessions.conversation(sessionId);
const item = history?.entries.find((entry) => entry.boundaryId !== undefined);
if (history && item?.boundaryId) {
  await runtime.sessions.fork({
    sessionId,
    historyBoundary: {
      entryId: item.boundaryId,
      sourceRevision: history.sourceRevision,
    },
  });
}
```

If the Session changes before the mutation, the Runtime returns
`resync_required`; an unknown boundary returns `null` and never falls back to a
different point.

The standalone session API accepts the same boundary (named `boundaryId` on
that surface) and fails closed with `null`:

```ts
const history = await manager.readConversationHistory(sessionId);
const item = history?.entries.at(-1);
if (history && item?.boundaryId) {
  await manager.forkSession(sessionId, {
    historyBoundary: {
      boundaryId: item.boundaryId,
      sourceRevision: history.sourceRevision,
    },
  });
}
```

Since v0.7.63, rewind audit markers are represented as
`type: 'rewind_marker'`. They are useful for host scrollback and audit UI, but
they do not enter model context: `loadSession()` omits them, and
`loadFullTranscript().messages` filters them out while
`loadFullTranscript().transcriptEntries` keeps the structured marker.

Use `type` / `source` / `timestamp` / `active` instead of parsing
`message.role`, synthetic wrapper text, or filesystem side stores. In
particular, workflow and child-task completions surface as
`type: 'task_result'` with `taskResults[]`:

```ts
const full = await loadFullTranscript(sessionId);
for (const entry of full?.transcriptEntries ?? []) {
  if (entry.type === 'task_result') {
    for (const result of entry.taskResults ?? []) {
      // result.source is 'workflow' or 'child_task'
      // result.taskId / runId / status / title / summary are structured.
    }
  }
}
```

For host-local output that should be visible in the transcript but must not
enter model context, call `appendClientNotice()`:

```ts
await appendClientNotice(sessionId, {
  source: 'space',
  content: '/mcp status: 3 servers connected',
  timestamp: new Date().toISOString(),
  payload: { command: '/mcp status' },
});

const active = await loadSession(sessionId);         // no client notice
const full = await loadFullTranscript(sessionId);    // includes client_notice
```

Client notices are persisted as lineage entries, not model messages. They are
returned from `loadFullTranscript()` with `type: 'client_notice'`,
`source: 'client'`, and `payload.entersModelContext === false`.

v0.7.51 extends the `uiHistory` schema so interactive sessions can persist
sanitized terminal tool cards. Headless SDK sessions can still reconstruct
tool-call display from canonical assistant `tool_use` and user `tool_result`
messages when no TUI replay cache exists. Workflow progress remains on the
`WorkflowProcessSnapshot` / lifecycle-controller surfaces from v0.7.50; session
history should replay durable child digests and final answers, not workflow live
process state. The neutral replay types live with the session data model and are
exported from both `@kodax-ai/kodax/agent` and `@kodax-ai/kodax/session`; use
`KodaXSessionUiHistoryItem` / `KodaXSessionUiToolCall` when a host needs to
type-check `SessionData.uiHistory`.

SDK hosts that want the same neutral replay projection as the TUI can call the
session helper directly without importing Ink/React:

```ts
import {
  loadSession,
  restoreHistoryItemsFromSession,
  type CreatableHistoryItem,
} from '@kodax-ai/kodax/session';

const session = await loadSession(sessionId);
const replayItems: CreatableHistoryItem[] = session
  ? restoreHistoryItemsFromSession({
      messages: session.messages,
      uiHistory: session.uiHistory,
    })
  : [];
```

`restoreHistoryItemsFromSession()` always derives the ordinary transcript from
canonical `messages` and trims that window first. Persisted `uiHistory` may
overlay timestamps, compact labels, icons, and sanitized `tool_group` output by
tool ID, or append display-only entries such as `/quit`. A non-empty, sparse,
or stale cache cannot hide user/assistant history. Presentation-only
`agent-completed` and legacy `task-completed` events stay host-owned when a
non-empty CLI `uiHistory` exists; headless/no-cache restore still derives them
from messages. The lower-level
`extractHistorySeedsFromMessages()` helper is also exported from
`@kodax-ai/kodax/session` for hosts that want to apply their own projection.

### Custom sessions directory (multi-tenant / tests)

```ts
const { storage } = createSessionManager({
  sessionsDir: '/srv/tenant-42/.kodax/sessions',
});
// `storage` writes there; matching listSessions/loadSession on the
// same manager read from the same dir.
```

This is equivalent to constructing `FileSessionStorage` directly
but keeps read + write sharing one instance (so append-watermark
caches stay warm across mixed list / run operations).

### Bring-your-own storage (database / cloud / IndexedDB)

`FileSessionStorage` implements `KodaXSessionStorage`. Any class
implementing the same interface can be passed in. Minimal contract:

```ts
import type { KodaXSessionStorage, SessionData } from '@kodax-ai/kodax/coding';

class MyDbSessionStorage implements KodaXSessionStorage {
  async save(id: string, data: SessionData): Promise<void> { /* ... */ }
  async load(id: string): Promise<SessionData | null> { /* ... */ }
  async list(opts?: ...): Promise<SessionSummary[]> { /* ... */ }
  async delete(id: string): Promise<void> { /* ... */ }
  // (other methods — see the @kodax-ai/kodax/coding type for the full surface)
}

const storage = new MyDbSessionStorage();
await runKodaX({ session: { id, storage }, ... }, prompt);
```

`mutateRuntimeInfo()` is an optional low-level seam used by the Runtime-owned
`FileSessionStorage`; `createKodaXRuntime()` currently owns that storage. A
custom storage passed directly to `runKodaX()` remains transcript storage.
Adding this method alone does not install the Runtime workspace-root registry
or its shell/text sandbox policy. Use the Runtime service when depending on the
dynamic linked-worktree correction.

The SA / AMA loops are storage-implementation-agnostic — they just
call `storage.save(...)` at the terminal sites (success / error /
mid-flow / limit-reached). Storage failures are swallowed locally
with a `[SessionSnapshot] storage.save failed` `console.error` —
they never propagate to the `runKodaX` caller.

### Why isn't `storage` defaulted automatically?

Three reasons we **don't** auto-construct `FileSessionStorage` when
`session.id` is supplied:

1. **Package boundary**: `FileSessionStorage` is implemented in
   `@kodax-ai/repl` (it's >500 LoC of write-queue + watermark +
   JSONL streaming logic). `@kodax-ai/coding` does not depend on
   `/repl`, and reversing that direction breaks ADR-001 package
   independence (you'd no longer be able to consume `/coding`
   without dragging the Ink REPL bundle).
2. **Pluggability**: hosts often want non-filesystem storage
   (Electron IndexedDB, web app S3 bucket, server-side Postgres).
   Defaulting to `FileSessionStorage` would force a `fs/promises`
   side-effect on every embedder.
3. **Explicit > implicit**: a silent default would hide the wiring
   from new SDK consumers; the v0.7.43 `console.warn` makes the
   missing wiring loud the first time it bites.

### When to construct `FileSessionStorage` directly vs go through `createSessionManager`

| Use case | Construct directly | Use `createSessionManager` |
|---|---|---|
| Only need to save runs, no listing / reading UI | ✓ | (also fine — `storage` field gives you the same instance) |
| Need a popout / sidebar showing past sessions | | ✓ — pairs read + write through one instance |
| Custom sessions dir for tests / tenants | (works, but you must repeat the dir option for each call) | ✓ — `{ sessionsDir }` once, both sides honor it |
| Want to mock storage for unit tests | ✓ (inject mock implementing `KodaXSessionStorage`) | — |

### Quick checklist before reporting "session.jsonl not appearing"

- [ ] Did you set `session.storage`? (Not just `session.id`.)
- [ ] Is the run actually reaching a terminal site?
      `saveSessionSnapshot` fires from success / error / mid-flow /
      limit-reached. A run that throws synchronously before
      `runKodaX` enters the loop never saves.
- [ ] Did `storage.save` throw? Check `console.error` for
      `[SessionSnapshot] storage.save failed`. Storage errors are
      isolated by design (don't fail the run), but they leave the
      session file unwritten.
- [ ] Is the `sessionsDir` the one you expect? Default is
      `<KODAX_HOME>/sessions`; override via `setAgentConfigHome` or
      `createSessionManager({ sessionsDir })`.
- [ ] Is the `session.id` filesystem-safe? KodaX accepts any string
      but writes `<id>.jsonl` literally — IDs with `/`, `\`, or
      control chars will be rejected by the OS.

---

## 7. Local development via `npm link` (iterating against in-tree KodaX)

If you maintain an SDK consumer (KodaX Space, an IDE extension, a custom
bundler integration) and need to iterate against an unreleased KodaX
build — verifying a bugfix, prototyping against an in-progress feature,
running your project's test suite against `main` — you can `npm link`
the in-tree KodaX checkout instead of waiting for a published version.

As of v0.7.43 the root `package.json` is in **already-published shape**:
`"name": "@kodax-ai/kodax"` is baked in along with all 10 SDK subpath
exports. `npm link` "just works" — no need to run `scripts/release.mjs`
first.

### Recipe

```bash
# In your local KodaX checkout
cd /path/to/KodaX
npm install                                    # one-time (sets up workspaces)
npm run build                                  # required — npm link resolves to dist/
npm link                                       # exposes the dir as @kodax-ai/kodax globally

# In your SDK consumer project (e.g. KodaX Space)
cd /path/to/my-host-app
npm link @kodax-ai/kodax                       # consume the linked checkout
```

After this, `import { ... } from '@kodax-ai/kodax/repl'` in your host
app resolves to `/path/to/KodaX/dist/sdk-repl.js`. Subsequent edits
inside KodaX require **re-running `npm run build`** — the link points
at the bundled output, not source.

### Tearing down the link

```bash
# In your SDK consumer project
npm unlink @kodax-ai/kodax       # restore the published version (npm install runs again)

# In KodaX
npm unlink -g @kodax-ai/kodax    # remove the global symlink
```

### Why root stays `"private": true`

The dev `package.json` carries `"private": true` so a bare `npm publish`
from the repo refuses — `scripts/release.mjs` is the only sanctioned
publish path, and it briefly toggles `private: false` (via try/finally)
just for the publish call. `"private"` does **not** block `npm link` —
it only gates `npm publish` — so the linked-build flow is unaffected.

### Alternative: tarball install

If you want a one-shot snapshot rather than a live symlink (e.g. for CI
or for a teammate without write access to the KodaX checkout):

```bash
# In KodaX
node scripts/release.mjs --pack-only           # produces kodax-ai-kodax-<v>.tgz

# In your host app
npm install /path/to/KodaX/kodax-ai-kodax-<version>.tgz
```

The tarball is byte-identical to what `npm publish` would ship, so it
exercises exactly the published shape.

---

## 8. User-authored agents — markdown loader + extension `registerAgent` (FEATURE_191, v0.7.43)

### Why this exists

KodaX's Self-Construction substrate (FEATURE_087-090 / 101) lets the
LLM author + admit constructed agents at runtime. FEATURE_191 closes
the loop for **human authors** and **SDK embedders**: ship an `<name>.md`
file under `~/.kodax/agents/` (user-level) or `<repo>/.kodax/agents/`
(project-level), or have an extension call `api.registerAgent(name, content)`
at activate time. All three paths feed the same admission pipeline as
the LLM-generation route and surface in the Worker SP's
`=== Available specialist agents ===` block.

### Markdown shape

```markdown
---
name: db-reviewer
description: Reviews DB migrations for safety and best practices
tools: [read, grep]
model: claude-sonnet-4-6
---
You are a DB migration reviewer. Focus on:
- Locking behavior under concurrent writes
- Default value backfill cost on large tables
```

`name` and `description` are required; missing/invalid `name` is a
silent skip (claudecode-compatible: treats the file as a reference doc).
`tools` accepts either a YAML array (`[read, grep]`) or a
comma-separated string (`"read, grep"`); each entry maps to
`builtin:<name>`. `mcpServers` / `hooks` / `memory` / `isolation` /
`permissionMode` / `maxTurns` / `skills` frontmatter fields are
silently ignored in v0.7.43 (forward-compat with future features).

Project agents (`<repo>/.kodax/agents/*.md`) shadow user-level agents
of the same name (last-write-wins).

### SDK API for extensions

```ts
// In an extension's activate function:
export default async function activate(api: KodaXExtensionAPI) {
  const dispose = await api.registerAgent('python-reviewer', {
    instructions: 'You review Python code for PEP-8 + type hints.',
    description: 'Python code reviewer (PEP-8 + type hints)',
    tools: [{ ref: 'builtin:read' }, { ref: 'builtin:grep' }],
  });

  // The returned dispose is auto-pushed onto the extension's
  // disposables list, so manual disposal is optional. Call it only
  // if you need to unregister the agent mid-session.
  return () => dispose();
}
```

`api.registerAgent(name, content)` throws on admission rejection with
the extension id + agent name + verdict reason — the embedder sees
failures at activate time rather than silently dropped registrations.

### Reading the agent registry (host code)

```ts
import {
  listConstructedAgents,
  resolveConstructedAgent,
} from '@kodax-ai/kodax';

// All registered constructed agents (markdown + extension + LLM + CLI).
const agents = listConstructedAgents();

// Resolve a specific agent by name.
const agent = resolveConstructedAgent('db-reviewer');
```

> **Source-aware variants** — `listConstructedAgentsWithSource()` /
> `resolveConstructedAgentSource(name)` expose the in-memory source
> tag (`'built-in' | 'extension' | 'markdown:user' | 'markdown:project'
> | 'constructed:cli' | 'constructed:llm'`). These are marked
> `@internal` in v0.7.43 and exposed only via the construction
> sub-barrel — they will be promoted to the top-level SDK entry when
> the v0.7.46+ REPL `/agents list` command lands as their third
> production consumer (current consumers: source-tag round-trip tests
> + planned REPL). Embedders that need provenance today can read the
> source via the existing `listConstructedAgents()` Agent shape and
> cross-reference their own registration calls.

### Wiring dispatch

Workers automatically see a registered agent through the SP block.
Programmatic dispatch (e.g. in `runKodaX` SDK consumers) goes through
the standard tool surface — pass `subagent_type` to
`dispatch_child_task`:

```ts
// Inside a tool handler or eval driver:
const result = await dispatchChildTask({
  id: 'child-1',
  objective: 'Review the migration in this PR',
  readOnly: true,
  subagent_type: 'db-reviewer',
});
```

Unknown `subagent_type` returns a tool-result error listing available
names (does NOT throw); write-capable specialists dispatched outside the
Worker path are rejected at the dispatch layer. Older V1 docs may phrase
this as "non-Worker/Generator"; Generator is historical after FEATURE_193.

### See also

- [docs/test-guides/FEATURE_191_v0.7.43_TEST_GUIDE.md](../../docs/test-guides/FEATURE_191_v0.7.43_TEST_GUIDE.md) — manual test recipes
- [docs/features/v0.7.43.md FEATURE_191](../../docs/features/v0.7.43.md#feature_191-user-authored-custom-agents--markdown-loader--extension-registeragent--dispatch_child_task-bridge) — design + acceptance gates
- [docs/ADR.md ADR-035](../../docs/ADR.md#adr-035-user-authored-custom-agents--markdown-loader--extension-registeragent--dispatch_child_task-bridge-feature_191-v0743) — architectural rationale

---

## 9. Electron + `stdio: 'inherit'` on Windows — PowerShell input hijack

### Symptom

A host process (e.g. `scripts/dev.mjs`) spawns Electron with
`stdio: 'inherit'`. After Electron's main process starts up and loads
the KodaX SDK, the parent terminal (PowerShell, Windows Terminal,
cmd.exe) stops responding to keyboard input — characters don't echo,
Enter doesn't dispatch, Ctrl-C may not register.

### What's actually happening

This is **not caused by KodaX hooking stdin**. The SDK has no
module-level `process.stdin.on/setRawMode/resume/setEncoding` anywhere
in the published code path. We verified this empirically with the
following probe (Node 24, Windows, v0.7.43 dist):

| Probe step | stdin listeners delta | raw mode delta | signal listeners delta |
|---|---|---|---|
| `import('@kodax-ai/kodax')` (root) | 0 | none | 0 |
| `import('@kodax-ai/kodax/agent')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/llm')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/coding')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/mcp')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/session')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/skills')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/repl')` | 0 | none | 0 |
| `hydrateProcessEnvFromShell()` (Windows) | 0 (early return) | none | 0 |
| `loadConfig()` + `listMcpServers()` | 0 | none | 0 |

`hydrateProcessEnvFromShell()` on Windows specifically returns `false`
at [packages/repl/src/common/utils.ts](../../packages/repl/src/common/utils.ts)
line 151 **before** any `spawnSync`. Even on non-Windows where the
spawn happens, it explicitly passes `stdio: ['ignore', 'pipe', 'pipe']`
— the child shell never sees the parent stdin.

The root cause is an Electron + Windows ConPTY interaction: spawning
an Electron child with `stdio: 'inherit'` from a Windows terminal
makes the child process inherit a live handle to the parent's input
stream. Even though nobody inside Electron's main process reads from
it, the open handle alters how PowerShell / Windows Terminal route
keystrokes — they cannot tell whether the upstream child has
"consumed" them. This is a known Windows console quirk independent
of any code Electron's main module runs.

### Canonical fix (host-side)

Detach Electron's stdin in the spawn config:

```js
// scripts/dev.mjs
import { spawn } from 'node:child_process';

const electron = spawn(electronBin, [appEntry], {
  stdio: ['ignore', 'inherit', 'inherit'], // ← stdin: 'ignore', NOT 'inherit'
  shell: false,
});
```

`stdio: ['ignore', 'inherit', 'inherit']` keeps stdout/stderr piped
to the host terminal for log visibility but prevents Electron from
holding the parent's stdin. PowerShell / Windows Terminal regain
full control of keyboard input. This is the canonical workaround
Electron itself documents (the `electron/dev-tools` examples ship
with this exact pattern).

### Why we don't ship a SDK-side mitigation

There is nothing the SDK can do to release a stdin handle it never
opened. Some hosts (CLI runners, headless servers) may legitimately
want to pipe data into the Electron main process via stdin; pre-emptively
closing or redirecting it from inside the SDK would break those.
The spawn-time decision belongs to the host.

### How to confirm whether your symptom matches this

Run [`scripts/probe-sdk-stdin.mjs`](../../scripts/probe-sdk-stdin.mjs)
against your in-tree or installed SDK dist:

```bash
# In-tree (this repo):
node scripts/probe-sdk-stdin.mjs

# Against an installed @kodax-ai/kodax:
node scripts/probe-sdk-stdin.mjs ./node_modules/@kodax-ai/kodax/dist
```

The probe imports every SDK subpath and runs the Space startup sequence
(`hydrateProcessEnvFromShell` / typeof reads / `loadConfig` /
`listMcpServers` / provider snapshots), reporting stdin listener delta /
raw-mode delta / signal-handler delta at each step. If every step shows
"no state change ✓", the issue is in your spawn config — not in KodaX.
If any step shows a non-zero delta, file an issue with the probe output
and your Node / OS / SDK version.

---

## 10. Model capabilities — context window, reasoning, descriptors

### Why this exists

A popout-style UI typically wants to list every provider/model KodaX
supports, with at minimum `context window` and `reasoning capability`
shown next to each model — so the user can pick informed. Pre-v0.7.43,
this metadata lived inside each `Provider` class's `config` field and
was only readable via `provider.getContextWindow()` / `getModelDescriptor()`
on an instantiated Provider. `getProvider(name)` instantiates which
throws if the relevant API key env var is unset — meaning a UI couldn't
show "Anthropic Sonnet 4.6 / 200K context" until the user had set
`ANTHROPIC_API_KEY`. Capability metadata is **KodaX-maintained static
data** (we know what context windows the upstream models advertise),
so gating it on credentials is wrong.

v0.7.43 promoted this metadata into registry-layer snapshots and getters; the
current implementation backs `KODAX_PROVIDER_SNAPSHOTS` with
`provider-capabilities.json`. The getters still read without a provider
instance, API key, or env var.

### The new surface

All exports below come from `@kodax-ai/kodax/llm` (preferred) — also
re-exported through `@kodax-ai/kodax` (root), `@kodax-ai/kodax/coding`,
and `@kodax-ai/kodax/agent` for convenience.

```ts
import {
  // Built-in providers (anthropic / kimi / zhipu / deepseek / ark-coding / ...):
  getProviderModelDescriptors,           // (name) => KodaXModelDescriptor[]
  getModelCapabilities,                  // (name, model) => KodaXModelCapabilities | undefined
  listBuiltinModelCapabilities,          // () => KodaXModelCapabilities[]   (all built-ins, default-first per provider)

  // Custom providers (registered via `registerConfiguredCustomProviders`
  // from `~/.kodax/config.json#customProviders`):
  getCustomProviderModelDescriptors,     // (name) => KodaXModelDescriptor[] | undefined
  getCustomModelCapabilities,            // (name, model) => KodaXModelCapabilities | undefined
  listCustomProviderModelCapabilities,   // () => KodaXModelCapabilities[]

  // Unified dispatchers — built-in OR custom, transparent routing:
  resolveProviderModelDescriptors,       // (name) => KodaXModelDescriptor[]   (empty if unknown)
  resolveModelCapabilities,              // (name, model) => KodaXModelCapabilities | undefined
  listAllModelCapabilities,              // () => KodaXModelCapabilities[]   (built-in + custom merged)

  // Types:
  type KodaXModelCapabilities,
  type KodaXModelDescriptor,
} from '@kodax-ai/kodax/llm';
```

### Shape

```ts
interface KodaXModelCapabilities {
  provider: string;                 // 'anthropic' | 'kimi' | 'ark-coding' | <custom-name>
  model: string;                    // model id (e.g. 'claude-sonnet-4-6', 'kimi-k2.7-code')
  displayName: string;              // human label — falls back to model id
  supportsThinking: boolean;        // native reasoning is available?
  reasoningCapability: 'native-budget' | 'native-effort' | 'native-toggle' | 'prompt-only' | 'none' | 'unknown'; // legacy mechanism label
  reasoningProfile?: {
    defaultEffort?: string;
    supportedEfforts?: Array<{ value: string; isDefault?: boolean; isUserVisible?: boolean }>;
  };
  contextWindow?: number;           // input tokens (provider default + per-model override cascade)
  maxOutputTokens?: number;         // per-turn output limit KodaX requests — see note below
  maxOutputTokensField?: 'max_tokens' | 'max_completion_tokens';
  thinkingBudgetCap?: number;       // tokens (native-budget providers only)
  isDefault: boolean;               // true for the provider's default model
}
```

### Recipes

**List every model KodaX supports (built-in + custom):**

```ts
import { listAllModelCapabilities } from '@kodax-ai/kodax/llm';

for (const caps of listAllModelCapabilities()) {
  console.log(`${caps.provider}/${caps.model}: ${caps.contextWindow ?? 'unknown'} tokens`);
}
```

**Look up a single model:**

```ts
import { resolveModelCapabilities } from '@kodax-ai/kodax/llm';

const caps = resolveModelCapabilities('kimi', 'kimi-k2.7-code');
// => { contextWindow: 262_144, supportsThinking: true, reasoningProfile: { defaultEffort: 'high', ... }, ... }
```

For picker/status UIs, use `reasoningProfile.supportedEfforts` and
`defaultEffort`. The legacy `reasoningCapability` field describes the provider
wire mechanism, not user-facing reasoning depth.

> **v0.7.58 fix — per-model overrides on a provider's DEFAULT model.**
> `resolveModelCapabilities(provider, model)` previously dropped a model's own
> `contextWindow` / `maxOutputTokens` / `reasoningProfile` override when that
> model happened to be the provider's default (for v0.7.87,
> `zhipu-coding/glm-5.3` and `zai-coding/glm-5.2` each declare a 1M window — the resolver returned the
> 200K provider default). It now merges the `models[]` override regardless of
> default-model status, so `resolveModelCapabilities` agrees with the runtime
> `provider.getEffectiveContextWindow()` / `getEffectiveMaxOutputTokens()`.

### Resolving a wire-legal reasoning effort — `resolveWireEffort` (v0.7.58)

Mapping a user's desired reasoning strength to the actual wire `effort` value
means composing the model's profile with its alias / disabled / ceiling / default
rules AND any learned hard-rejections. `resolveWireEffort` (from
`@kodax-ai/kodax/llm`) is the single host-facing entry so you don't re-assemble
(and drift from) that logic:

```ts
import { resolveWireEffort } from '@kodax-ai/kodax/llm';

const { effort, adjusted } = resolveWireEffort({
  provider: 'zhipu-coding',
  model: 'glm-5.3',
  desiredEffort: 'minimal', // GLM-5.3 aliases minimal → low
});
// effort === 'low', adjusted === true
```

GLM-5.2 keeps its independent mapping, including low → high. For GLM-5.3,
none/minimal/light/low → low, medium/high → high, and xhigh/max/ultra → max.
Because GLM-5.3 cannot disable thinking, a disabled or `none` intent is emitted
as enabled low-effort thinking.

`effort` is `undefined` when the model omits a wire effort (e.g. anthropic
adaptive) — send no `reasoning_effort` in that case; do **not** substitute a
value. Pass `rejectedEfforts` (e.g. from the agent layer's
`getCachedRejectedEfforts`) to fold learned rejections into the resolution.

### Reasoning-effort rejection is self-healing at the runtime layer (v0.7.58)

When a provider hard-rejects a `reasoning_effort` (400/422), the coding runtime
now **records** the rejection in the capability cache and **consults** it before
building each subsequent turn's request — so the same rejected effort is not
re-sent turn after turn. This happens whether or not a host wires
`events.onReasoningEffortRejected` (that event is still delivered for hosts that
want to surface it). Previously only the built-in REPL recorded rejections, so a
headless SDK host silently re-issued a failing request every turn.

### Passive effort capability learning

KodaX v0.7.57 treats `effort` as the primary reasoning-depth input. When a
provider hard-rejects a requested effort value, the SDK emits
`KodaXEvents.onReasoningEffortRejected` with provider/model/effort metadata.
The LLM layer owns the pure learning semantics (`narrowReasoningProfile` and
cache record helpers), while the agent layer provides the default
`~/.kodax/capability-cache.json` store (`recordRejectedEffort`,
`getCachedRejectedEfforts`, `clearCapabilityCache`). The built-in REPL is just
one consumer: it records the event through the agent store and narrows future
effort choices for the same provider/model.

Headless SDK hosts can use the same agent store, provide their own store around
the LLM pure helpers, or ignore the event for deterministic no-learning runs.
This keeps the mechanism reusable without forcing a cross-session disk cache on
every embedded runtime.

**Group by provider for a picker UI:**

```ts
import {
  KODAX_PROVIDER_SNAPSHOTS,
  resolveProviderModelDescriptors,
} from '@kodax-ai/kodax/llm';

for (const providerName of Object.keys(KODAX_PROVIDER_SNAPSHOTS)) {
  const descriptors = resolveProviderModelDescriptors(providerName);
  // descriptors[0] is the default model; descriptors.slice(1) are alternatives.
}
```

### A note on `maxOutputTokens`

`KodaXModelCapabilities.maxOutputTokens` is the **per-turn output-token limit
KodaX requests**, NOT the upstream "theoretical maximum". For OpenAI-compatible
routes, `maxOutputTokensField` reports whether that limit is serialized as
`max_tokens` or `max_completion_tokens`. The two size concepts diverge because:

- **What upstream advertises is often unreliable.** A 2026-05 probe
  against `zhipu-coding` / `kimi-code` / `minimax-coding` / `ark-coding`
  (Coding-Plan endpoint) / `deepseek` showed their `/v1/models`
  endpoints return only `{id, object, owned_by, created}` — no
  context-window, no max-output, no capabilities at all. Ark's
  pay-as-you-go `/v3/models` returns rich `token_limits` but none of
  the Coding-Plan models KodaX actually uses appear in that catalog.
  Even when upstream does advertise a number, stream behavior often
  deviates (the LLM stops early at unrelated stop conditions, or the
  server enforces a tighter kill window). Upstream `/models` data is
  not a substitute for KodaX-maintained metadata.
- **What KodaX requests is the trustworthy number.** Values in
  `KODAX_PROVIDER_SNAPSHOTS` are bench-validated against each provider
  (kill-windows, decode-rate, cost-per-turn predictability). Examples:
  - DeepSeek V4 *advertises* 384K max output; KodaX requests
    `KODAX_ESCALATED_MAX_OUTPUT_TOKENS` (~32K) per turn so streams
    finish under server-side timeouts. Long generation flows through
    the L5 continuation meta path instead.
  - `zhipu-coding` has a ~308s server-side kill window; KodaX caps at
    16K so typical tool_use turns complete within the window.

For a popout UI showing "expected output size for this model", use
the KodaX value (`caps.maxOutputTokens`). It's exactly what KodaX
asks the model for — i.e. the actual size budget your turn gets. If
you also want to expose the model's *theoretical* max output, that
comes from the upstream provider's own documentation; KodaX doesn't
certify that number because we don't request it.

### Why no instance methods touch this

The existing `provider.getContextWindow()` / `getEffectiveContextWindow()`
/ `getModelDescriptor()` instance methods still work — they're the
runtime path the agent loop itself uses. The new getters layer above
them at the **registry** layer so they don't need a Provider instance.
A consumer that has a configured Provider and wants effective values
in the four-step cascade (compactionConfig override → per-model →
provider default → 200K fallback) should still use
`resolveContextWindow(compactionConfig, provider, model)` from
`@kodax-ai/kodax/agent`. The new registry-layer getters are for the
*"list everything KodaX knows"* case — for picker UIs, comparison
tables, capability-aware routing.

### Confirming snapshot accuracy

Snapshot values are sourced from
[`packages/llm/src/providers/provider-capabilities.json`](../../packages/llm/src/providers/provider-capabilities.json)
and loaded into the in-memory `KODAX_PROVIDER_SNAPSHOTS` export. When upstream
providers publish a new model or change a context-window cap, the JSON file is
the patch site — the new value flows to runtime (via `buildProviderConfig`) AND
to SDK consumers (via the getters) in a single edit. The current snapshot is
dated 2026-07-16 and includes the GPT-5.4, Kimi K2.7 Code / HighSpeed, GLM-5.2, MiniMax
M3/M2.7, DeepSeek V4, and Doubao Seed 2.0 route refreshes where supported. The
test suite at
[`packages/llm/src/providers/model-capabilities.test.ts`](../../packages/llm/src/providers/model-capabilities.test.ts)
locks in specific values (e.g. the public Kimi lineup at 262,144 tokens, deepseek-v4-pro at 1M)
so accidental drift is caught at PR time.

The probe scripts that surveyed upstream APIs live at
[`scripts/probe-upstream-model-metadata.mjs`](../../scripts/probe-upstream-model-metadata.mjs)
and [`scripts/probe-ark-tokens.mjs`](../../scripts/probe-ark-tokens.mjs) —
re-run them periodically; if a provider starts returning richer model
metadata, we can promote the snapshot to derive from it.

---

## 11. Workflow process events and lifecycle controls (FEATURE_229, v0.7.50)

FEATURE_229 makes dynamic workflow progress a reusable SDK process surface
instead of terminal-only text. Hosts can observe and control workflows without
parsing `/workflow` output, replaying slash commands, or depending on Ink view
models.

Use the Agent subpath for neutral process types:

```ts
import type {
  WorkflowProcessEvent,
  WorkflowProcessSnapshot,
} from '@kodax-ai/kodax/agent';
```

Use the Coding subpath for workflow execution, process subscription, and
lifecycle control:

```ts
import {
  createWorkflowLifecycleController,
  createWorkflowRunManager,
  generateWorkflowFromOptions,
} from '@kodax-ai/kodax/coding';

const runManager = createWorkflowRunManager();
const unsubscribe = runManager.subscribeWorkflowProcess((event) => {
  renderWorkflowPanel(event.snapshot);
});

const controller = createWorkflowLifecycleController({
  runManager,
  runBaseDir: '.kodax/workflows/runs',
});

const generated = await generateWorkflowFromOptions({
  options,
  request: 'Review the payment flow',
});

if (generated.kind !== 'generated') throw new Error(generated.reason);

const runId = makeRunId();
const runDir = makeRunDir(runId);
const run = runManager.startFromOptions({
  module: generated.module,
  args: { request: 'Review the payment flow' },
  options,
  runId,
  runDir,
  scriptSnapshot: generated.scriptSnapshot,
  onWorkflowProcessEvent: (event) => auditWorkflow(event.snapshot),
});

await run.done;
const snapshot = controller.getWorkflowProcessSnapshot(runId);
const result = await controller.readWorkflowResult(runId);
```

`KodaXOptions.events.onWorkflowProcessEvent` receives the same events when a
host runs normal coding tasks that enter workflow mode. `WorkflowProcessSnapshot`
is intentionally ANSI-free and UI-neutral. It carries workflow status, phases,
child item status, result-bearing child summaries, provider/model routing hints,
and final `resultSummary`.

### Two ways to author a workflow (v0.7.58)

There are two host-facing ways to turn a natural-language request into a workflow
run — pick by whether you want the SDK to *orchestrate generation for you* or the
*Worker to investigate and author it itself*:

| | `generateWorkflowFromOptions` (shown above) | `authorWorkflowViaWorker` |
|---|---|---|
| Who authors | A context-**blind** one-shot LLM call (`tools:[]`) | The **Worker agent** — scouts the repo with its own tools, then authors + runs `run_workflow` (ADR-047 scout-then-author) |
| Host role | You call it, get a `module`, then `startFromOptions` | You submit one turn; the Worker does everything; you subscribe |
| Quality | Generic (no repo investigation) | Grounded (real paths / sub-problems / `outputSchema` baked into child prompts) |
| Use when | Non-interactive / CI / low-capability host, or you want to inspect the module before running | You want the same intelligence the REPL's `/workflow create` gets (recommended for interactive GUI hosts) |

`authorWorkflowViaWorker` is exactly what the REPL's `/workflow create` does
internally (elevate one turn to `agentMode:'amaw'` so the Worker has
`run_workflow`), exposed as a single call so a GUI host doesn't reimplement the
turn-submission glue:

```ts
import { authorWorkflowViaWorker } from '@kodax-ai/kodax/coding';

const { session, workflowRunId } = authorWorkflowViaWorker({
  request: 'Review the payment flow end-to-end and fix any bugs you find',
  options: {
    provider: 'anthropic',
    workflowRunsBaseDir: '<your app data>/workflow-runs', // REQUIRED — else run_workflow can't wire (throws)
    events: {
      // Numeric, UI-neutral progress — same surface as everything else in §11.
      onWorkflowProcessEvent: (event) => renderWorkflowPanel(event.snapshot),
    },
  },
});

// Resolves once the Worker actually launches a workflow (the run_workflow task),
// or `undefined` if it judged a workflow unnecessary and answered inline.
const runId = await workflowRunId;

// `session` is a normal RunningSession — await session.result, or session.abort().
await session.result;
```

Notes:
- `agentMode` is forced to `'amaw'` for the turn; the base `options.agentMode`
  is otherwise irrelevant here.
- `workflowRunsBaseDir` is **mandatory** for this call (it gates `ctx.workflowHost`
  → the `run_workflow` tool). Omitting it throws immediately rather than silently
  producing a Worker that can't author.
- The Worker retains judgment: for a request that doesn't warrant a multi-agent
  workflow it may just answer inline, in which case `workflowRunId` resolves
  `undefined`. There is no forced-tool guarantee (that would trade away the
  scout-then-author intelligence).

### Resume replay telemetry (v0.7.58)

When a workflow run resumes a prior run (`run_workflow`'s `resumeFromRunId`),
unchanged child agents replay instantly from the prior run's content-addressed
cache. Three read-only fields let a host render "resumed, N/M replayed from
cache" without changing any execution semantics:

- `WorkflowProcessSnapshot.resumedFromRunId?` — the prior run id this run resumed
  from (absent on a fresh run).
- `WorkflowProcessItem.origin?` — `'ran'` (executed live this run) or
  `'replayed-from-cache'` (returned from the prior run's cache). Populated only
  on resumed runs; on a fresh run every item omits it (treat absent as `'ran'`).
- `WorkflowProcessProgress.replayedAgents?` — count of replayed agents; present
  only when `> 0`. `spawnedAgents`/`finishedAgents` continue to count only agents
  that actually ran this turn.

All three are additive and absent on non-resumed runs, so existing renderers are
unaffected. A resumed agent item is emitted with `status:'completed'` (a replay
is instantaneous) and `origin:'replayed-from-cache'`.

### Timeout configuration

SDK hosts can configure user-facing timeout budgets with seconds-based fields:

```ts
const options = {
  provider: 'anthropic',
  timeouts: {
    workflow: {
      generationTimeoutSec: 300,
    },
    llm: {
      requestTimeoutSec: 900,
      streamIdleTimeoutSec: 0,
      chunkTimeoutSec: 45,
      maxRetryDelaySec: 90,
    },
  },
};
```

`timeouts.workflow.generationTimeoutSec` controls dynamic workflow harness
generation. It replaces the legacy millisecond-only environment override for
SDK callers while keeping `KODAX_WORKFLOW_GENERATION_TIMEOUT_MS` compatible.
`timeouts.llm.*Sec` is normalized by the LLM-layer helper
`resolveLlmTimeoutConfig()` from `@kodax-ai/kodax/llm`; the coding runtime then
adapts the resolved millisecond values into provider resilience settings. Use
the LLM helper directly when building a non-coding runner that still needs the
same request/stream timeout semantics.

The public timeout config intentionally does not control internal cleanup or
resource-protection watchdogs such as process kill probes, workflow stop
cleanup, VM smoke checks, or daemon readiness checks.

### Workflow run host attribution (v0.7.51)

Hosts that need to attach a workflow run back to an external session, surface,
or tab can stamp an opaque string map on the run:

```ts
const run = runManager.startFromOptions({
  module: generated.module,
  args: { request: 'Review the payment flow' },
  options,
  runId,
  runDir,
  scriptSnapshot: generated.scriptSnapshot,
  processMetadata: {
    source: 'sdk',
    hostMetadata: {
      sessionId: 'space-session-123',
      tag: 'coder',
    },
  },
});

runManager.subscribeWorkflowProcess((event) => {
  const owner = event.snapshot.hostMetadata;
  if (owner?.sessionId === 'space-session-123') {
    renderSessionWorkflow(event.snapshot);
  }
});
```

`hostMetadata` is host-owned and KodaX does not interpret its keys. It is
normalized as a small string-only map, persisted in `run.json`, and echoed on
live and restored `WorkflowProcessSnapshot` values. Unstamped runs return
`hostMetadata === undefined`; hosts should treat that as "no declared owner",
not infer ownership from session replay text.

### Live child-agent telemetry

F229 also preserves parent `KodaXEvents` callbacks for child-agent execution.
Treat these callbacks as live telemetry, not canonical assistant messages.
Tool callbacks, prompt callbacks, `onTextDelta`, `onThinkingDelta`,
`onThinkingEnd`, and `onStreamEnd` can receive optional trailing metadata.

The child-agent event bridge is intentionally an allow-list. KodaX does not
blindly clone the parent `KodaXEvents` object into child runs, because unscoped
callbacks such as compaction, retry history, session start, and parent
iteration start would otherwise mutate the parent host state. Child activity
callbacks carry child metadata; child `onIterationEnd` events that are surfaced
to a host are worker-scoped (`scope:'worker'`).

For workflow children, tool/progress/prompt callbacks can carry
`workflowCorrelation` metadata that identifies the workflow run, child agent,
and workflow item. Use that metadata to update a workflow panel or activity log.
Keep `WorkflowProcessEvent` / `WorkflowProcessSnapshot` as the durable source of
workflow state, summaries, terminal status, result reads, and artifact reads.
Async digest failures are still summary-bearing: hosts should render
`summaryStatus:'unavailable'` / `summaryKind:'digest-failed'` with the provided
bounded fallback summary instead of treating the child as silent.
KodaX gives async digest a longer best-effort window than blocking digest, so
late `agent_summary_updated` messages can arrive noticeably after the child
terminal event without restarting the workflow.

### Collecting a child's result inside a workflow script (declare `outputSchema`)

When a workflow script aggregates child agents into a synthesis step, read the
child's result from the **right field**. A `WorkflowTaskResult` (from
`wf.runAgent` / `wf.wait`) carries several fields that are NOT all populated at
the same instant:

| field | reliability at the moment `runAgent`/`wait` resolves |
|---|---|
| `structured` | **The reliable field.** Present + schema-validated (with one bounded, *awaited* repair turn) whenever the spawn declared an `outputSchema`. Resolved before the call returns. |
| `finalText` | Always a string, but **may be empty or a "Let me start…" preamble** if the child ended its turn on a `tool_use`/handoff rather than a closing text block. Do NOT treat it as guaranteed content. |
| `digest` / `digestPending` | The smart digest is delivered **asynchronously** via `agent_summary_updated` *after* the call resolves; at resolve time `digest` is usually absent and `digestPending` is `true`. It powers the live panel — it is NOT available to the script's return value. |

So a script that folds `finalText` straight into `wf.synthesize` can get **empty
findings even though the per-agent digest is visible in the panel** (the digest
arrived a moment later, asynchronously). The supported pattern:

```ts
const FINDING = {
  type: 'object', additionalProperties: false, required: ['finding'],
  properties: { finding: { type: 'string', description: 'Concrete findings with file:line evidence.' } },
};

const result = await wf.runAgent({ name: 'review:auth', prompt, readOnly: true, outputSchema: FINDING });
// Prefer the schema-validated structured finding; fall back to finalText only when non-empty.
const text =
  (result?.structured as { finding?: string } | undefined)?.finding?.trim()
  || (result?.finalText?.trim() ? result.finalText : '[no finding returned]');
```

Declare an `outputSchema` on every child whose result feeds a downstream step,
and read `result.structured`. `finalText` is a best-effort fallback, and the
async `digest` is for live UI only — never rely on it in the script's own control
flow. (The built-in `parallel-investigation` workflow follows exactly this
pattern as the reference.)

For normal `dispatch_child_task` children, hosts should render child activity
under the dispatch tool or a separate child-activity panel, while leaving the
main TodoList/plan visible. A good default is:

- show the main agent plan as the work contract;
- show child-agent tool/thinking/progress as bounded live-only activity;
- persist only the child final summary, explicit approvals/audit records, and
  the parent assistant's final answer in the user-visible conversation history.

Callbacks use optional trailing metadata so existing consumers remain
source-compatible:

```ts
events.onToolProgress = (update, meta) => {
  if (meta?.workflowCorrelation) {
    renderWorkflowToolProgress(meta.workflowCorrelation, update);
    return;
  }
  renderMainToolProgress(update);
};
```

Hosts that want full child transcripts should put them in an explicit debug or
trace drawer. Do not append raw child thinking/text/tool streams into the normal
conversation by default; it makes the parent assistant appear to have authored
every child step and can overwhelm users.

### Sidecar verifier actionable messages

`KodaXEvents.onSidecarMessage` fires when the Sidecar Verifier produces an
actionable `revise` or `blocked` verdict. `accept` remains silent because there
is no message to deliver.

```ts
events.onSidecarMessage = (event) => {
  if (event.delivery === 'synthetic-user-message') {
    renderAudit(`Sidecar asked the main agent to revise: ${event.content}`);
    return;
  }
  if (event.delivery === 'budget-exhausted') {
    renderTerminalBlock(`Sidecar requested a revision, but the reanimate budget is exhausted: ${event.content}`);
    return;
  }
  renderTerminalBlock(event.content);
};
```

The payload is:

```ts
interface KodaXSidecarMessageEvent {
  source: 'sidecar-verifier';
  verdict: 'revise' | 'blocked';
  recipient: 'main-agent' | 'user';
  delivery: 'synthetic-user-message' | 'budget-exhausted' | 'terminal-block';
  content: string;
  suggestedFix?: string;
  trace?: string;
}
```

For `revise`, `content` is the exact synthetic user message injected back into
the main agent. Treat it as sidecar-authored control text rather than a
user-authored chat turn. When `delivery` is `budget-exhausted`, that same
revise text was not injected because the runner is terminating instead. For
`blocked`, `content` is terminal user-facing text. Headless JSONL output emits
the same information as `{"type":"sidecar.message", ...}`.

The lifecycle controller also exposes terminal-run controls: stop, pause,
resume, artifact reads, delete, prune, display-name changes, saved-capsule
revision/replace provenance, and capsule preflight. Provenance fields such as
`source`, `sourceRunId`, `sourceWorkflowName`, `savedWorkflowName`, and
`revisionOf` let a host distinguish AMAW, `/workflow`, `/review --workflow`,
saved-name reruns, and capsule revisions while still consuming one process
contract.

### Generated harness validation

Generated workflow source is treated as a restricted harness, not as trusted
application code. `generateWorkflowFromOptions()` validates the source before a
run is launched, including wrapped JavaScript compilation, the generated
`async function run(wf, args)` contract, source-policy checks that ignore
strings/comments, and a no-effect smoke execution with a fake `wf`
implementation. Smoke validation catches common early harness defects such as
malformed `wf.runAgent` inputs, wrong `wf.wait` arguments, startup
`ReferenceError`, synchronous runaway startup code, and stalled startup awaits;
those errors feed the generator repair loop instead of creating a doomed
workflow run.

`preflightWorkflowCapsule()` also reports invalid restricted source as a
`workflow:source` error. Hosts should show that as a capsule/harness problem
before asking the user to approve a run. If a run still fails before launching
any child agents, render it as a generated harness or saved capsule failure,
not as a failed child-agent task. `/workflow rerun <runId>` repeats the saved
script snapshot; it does not regenerate a broken generated harness.

Layer boundary:

- `@kodax-ai/kodax/agent` owns neutral workflow process/event/status types.
- `@kodax-ai/kodax/coding` owns the coding backend, generated/saved workflow
  execution, run graph, host policy, lifecycle controller, result/artifact
  reads, and retention.
- `@kodax-ai/kodax/repl` renders snapshots; it is not required for SDK workflow
  execution or progress UI.

---

## 12. Provider credential verification — `verifyProviderCredential` (FEATURE_216, v0.7.45)

### Why

The original SDK exposed `provider.isConfigured()` (env-only check) and the full streaming surface (`provider.stream()` / `sideQuery()`). Neither fits the "test connection" UI use case: env check doesn't validate the key actually works against the upstream; streaming costs ~50–200 tokens and several seconds. KodaX Space (and any third-party SDK consumer building a provider-settings UI) needs a lightweight server-validated check.

FEATURE_216 ships **`verifyProviderCredential(name, opts?)`** — never-throws, lightweight, per-provider-strategy.

### Quick start

```typescript
import { verifyProviderCredential } from '@kodax-ai/kodax/llm';

const result = await verifyProviderCredential('zhipu-coding', { timeoutMs: 8000 });

if (result.ok) {
  // Key works. result.durationMs is wall-clock; result.approxTokensSpent
  // is 0 for count-tokens/models-list strategies, ~6-7 for minimal-message.
  console.log(`✓ Verified in ${result.durationMs}ms (${result.approxTokensSpent} tokens)`);
} else {
  switch (result.error) {
    case 'unauthorized':  /* show "invalid key — auth failed" (covers 401/403 + kimi-code 400 special) */ break;
    case 'unconfigured':  /* env var not set */ break;
    case 'network':       /* show "check network" (DNS/conn/socket errors) */ break;
    case 'timeout':       /* upstream didn't respond in time */ break;
    case 'server_error':  /* upstream 5xx; transient */ break;
    case 'rate_limited':  /* 429 — key is valid but throttled; suggest retry */ break;
    case 'unsupported':   /* cli-bridge provider or unknown name */ break;
    case 'unknown':       /* unexpected; surface result.message */ break;
  }
}
```

### Guarantees

- **Never throws** — every failure mode is captured in the returned `KodaXVerifyCredentialResult` envelope. Mirrors the `side-query.ts` pattern. Guarantee holds even for runtime-registered providers whose `verifyCredential()` override might throw (legacy 3rd-party extensions that predate FEATURE_216): the top-level helper wraps the call in try/catch and returns `error: 'unknown'`.
- **No ctor throw on missing env** — the helper short-circuits to `error: 'unconfigured'` BEFORE attempting to instantiate the provider class (which would call `getApiKey()` and throw).
- **Lightweight** — 9 of the 12 verifiable providers run a **zero-token** primitive; the remaining 3 cost ~6–7 tokens per call (~$0.00001 at typical rates).
- **Cancellable** — pass `opts.signal` (any `AbortSignal`); the helper distinguishes timeout vs parent-abort in the result.
- **Key redaction** — `result.message` redacts `sk-...` patterns before being surfaced, so an upstream error body that echoes the submitted key won't leak the fragment into a UI log or display.

### How the strategy is chosen

Each provider has one `verifyStrategy` value baked into `provider-capabilities.json`. Three primitives, picked per-provider empirically:

| Strategy | What runs | Cost | Used by built-ins |
|---|---|---|---|
| `count-tokens` | `client.messages.countTokens({ messages: [{role:'user',content:'hi'}] })` | 0 token | `anthropic`, `kimi-code`, `qwen-token-plan`, `zhipu-coding`, `zai-coding`, `minimax-coding`, `ark-coding` |
| `models-list` | `client.models.list()` | 0 token | `openai`, `deepseek`, `kimi`, `qwen` |
| `minimal-message` | `chat.completions.create({max_tokens:1, content:'hi'})` (or Anthropic equivalent) | ~6–7 token | `zhipu`, `mimo`, `mimo-coding` |
| `unsupported` | nothing — short-circuits | — | `gemini-cli`, `codex-cli` (cli-bridge: credentials live in CLI binary) |

`models-list` is NOT used as a universal default because (a) some providers' `/v1/models` is publicly accessible (so a bad key returns 200 — false positive), and (b) some compat layers don't implement it (404) or 401 even for valid keys (false negative). The 2026-05-28 provider probe matrix captured the original per-provider evidence (12 providers at the time; 15 built-in aliases as of 2026-06-28). The current capability catalog has 16 aliases, including `qwen-token-plan` with `count-tokens`; opencode's `setup-recording-env.ts` makes the same per-provider decision across its 20+ providers.

### Custom providers

Custom providers (`registerCustomProviders` / `~/.kodax/config.json`) inherit the verify primitive from their base class. The strategy default is derived from `protocol`:

- `protocol: 'anthropic'` → defaults to `count-tokens`
- `protocol: 'openai'` → defaults to `models-list`

Override with explicit `verifyStrategy` when the upstream needs a different primitive (e.g. an openai-compat gateway whose `/v1/models` is public — set `verifyStrategy: 'minimal-message'`):

```typescript
registerCustomProviders([{
  name: 'my-gateway',
  protocol: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'MY_GATEWAY_KEY',
  model: 'gpt-4-mini',
  maxOutputTokensField: 'max_completion_tokens',
  verifyStrategy: 'minimal-message',  // optional override
}]);
```

For an OpenAI-compatible endpoint that follows DeepSeek Chat Completions, set
`maxOutputTokensField: 'max_tokens'`. The default is
`max_completion_tokens`; an object entry in `models[]` may override the
provider-level value for a mixed gateway. DeepSeek V4 custom configurations
should likewise use the model-specific `deepseek-v4-flash-openai` or
`deepseek-v4-pro-openai` reasoning preset. Both built-in DeepSeek V4 routes are
text-only.

For a self-hosted multimodal endpoint (vLLM / SGLang serving a Qwen-VL-style
model), set `imageInput: true` on the custom provider config. The flag feeds
the same `capabilityProfile.multimodalSupport: 'image-input'` merge that
built-in vision routes use, so `getModelInputCapabilities()` reports image
support and `validateInputArtifactsForModel()` accepts image artifacts for that
provider. The field flows through every write path that takes
`KodaXCustomProviderConfig` — `registerCustomProviders()`,
`~/.kodax/config.json`, and `runtime.catalog.upsertCustomProvider()` over the
daemon.

The validator rejects illegal combinations:
- `protocol: 'openai'` + `verifyStrategy: 'count-tokens'` → throws (OpenAI protocol has no count_tokens endpoint).

### Model listing — `listProviderModels(name)`

Separate API for "model picker" UIs. Returns the static model list KodaX maintains in `provider-capabilities.json` (or the custom provider's `models` field). Always `source: 'static'` in v0.7.45 — KodaX's curated list is more reliable than upstream `/v1/models` (which is noisy, includes deprecated entries, or — in zhipu's case — is publicly served regardless of auth).

```typescript
import { listProviderModels } from '@kodax-ai/kodax/llm';

const r = await listProviderModels('ark-coding');
if (r.ok) {
  // r.models is e.g. ['glm-5.1', 'glm-4.7', 'kimi-k2.6', ...]
  // r.source is 'static'; durationMs is 0 (no wire call)
  showModelPicker(r.models);
}
```

Cli-bridge providers (`gemini-cli`, `codex-cli`) return their CLI binary's known model list — filled at SDK load via `cli-bridge-models.ts`.

### Reference

- Source: `packages/llm/src/providers/verify-credential.ts` (orchestrator + classifier) + `verify-credential.test.ts` (27 unit tests) + `verify-credential-integration.test.ts` (12 gated real-key/fake-key tests, enabled by `KODAX_INTEGRATION_TEST=1`).
- Data: `packages/llm/src/providers/provider-capabilities.json` `verifyStrategy` field per provider.
- Design notes + probe matrix: [docs/features/v0.7.45.md FEATURE_216](../../docs/features/v0.7.45.md#feature_216-provider-credential-verification-api).

---

## 13. Inject your product's manual — `selfManual` (FEATURE_221, v0.7.47)

### Why

KodaX has a built-in self-knowledge manual + a read-only `kodax_manual` tool: when a user asks how to use / configure / troubleshoot KodaX, the model looks it up instead of guessing (and instead of mixing in Claude Code / Codex knowledge). If you embed KodaX in your own product (say **KodaX-Space**), your users ask about **your product** — and by default they'd get KodaX's internal manual. `selfManual` lets you inject your product's manual so those questions are answered correctly and on-brand.

### Shape

```ts
import { runKodaX, type KodaXManualTopicInput } from '@kodax-ai/coding';

const SPACE_TOPICS: KodaXManualTopicInput[] = [
  { id: 'overview',  title: 'KodaX-Space', summary: 'What KodaX-Space is.', body: 'A desktop coding app built on KodaX.' },
  { id: 'settings',  title: 'KodaX-Space Settings', summary: 'Configure KodaX-Space.', body: 'Open Settings → Providers …', aliases: ['配置'] },
];

runKodaX({
  /* …your usual config… */
  selfManual: {
    productName: 'KodaX-Space',   // re-brands the routing rule + every answer's scope anchor
    topics: SPACE_TOPICS,         // extend the KodaX base; same id overrides a base topic
  },
});
```

### Semantics

- **Extend, not replace.** Your topics are merged on top of KodaX's base topics (same `id` overrides, new `id` adds). So a KodaX-Space user can ask about KodaX-Space *and* about the underlying provider/config (KodaX base topics).
- **`productName` re-brands the prose**, not the tool. The routing rule and each answer's anti-confusion anchor say your product name; the tool stays `kodax_manual` (the model doesn't care about the tool name).
- **Still tool-on-demand + bounded.** Nothing big is injected into the prompt — only the ≤250-token routing rule. Topics live in the registry and are returned one at a time when the model calls the tool, each capped at 4 KB. Drift-guarding your own topics (e.g. not referencing a removed setting) is your responsibility.

### White-labeling further — `baseTopics` (v0.7.58, FEATURE_221)

By default your `topics` **extend** the KodaX base manual. v0.7.58 adds
`selfManual.baseTopics` to control which base topics are present underneath:

- **omit** — all base topics (default; byte-identical to pre-v0.7.58).
- **`[]`** — none: a full white-label replace where only your topics exist, so the
  model never surfaces a KodaX-branded mechanism topic.
- **explicit subset** — seed only the base topic ids you name.

`KODAX_UNDERLYING_CAPABILITY_TOPICS` (exported) is the recommended mechanism-topic
subset a product built on KodaX should keep even in a full replace — so your users
still get correct answers about the underlying engine (providers / config /
permissions / tools / skills / extensions / mcp / repo-intelligence / sessions /
sdk / custom-providers) without the KodaX brand:

The default full manual also includes the `memory` topic. It is intentionally
not part of `KODAX_UNDERLYING_CAPABILITY_TOPICS` because `/experimental-memory`
is opt-in; hosts that expose it should add `memory` explicitly or provide a
product-specific override.

```ts
import {
  runKodaX,
  KODAX_UNDERLYING_CAPABILITY_TOPICS,
  MANUAL_REGISTRY,
} from '@kodax-ai/coding';

runKodaX({
  selfManual: {
    productName: 'KodaX-Space',
    topics: SPACE_TOPICS,
    baseTopics: [...KODAX_UNDERLYING_CAPABILITY_TOPICS], // keep engine topics, drop KodaX-branded ones
  },
});
```

`MANUAL_REGISTRY` (exported, keyed by `KodaXManualTopicId`) lets you read the base
topic bodies at build time — e.g. to re-word them under your own brand.

### Topic shape (`KodaXManualTopicInput`)

`{ id, title, summary, body }` required; `aliases?`, `nextTopics?`, `sources?` optional. Keep `body` short (a few lines) — it is a bounded on-demand answer, not a document.

### Reference

- Types/exports: `KodaXManualTopicInput`, `KodaXSelfManualConfig`, `ResolveKodaXManualOptions`, `buildSelfKnowledgeRoutingRule` from `@kodax-ai/coding`.
- Design: [docs/features/v0.7.47.md FEATURE_221](../../docs/features/v0.7.47.md#feature_221-injectable-self-manual-for-sdk-consumers).

---

## 14. Media input artifacts — `@kodax-ai/kodax/media` (FEATURE_239, v0.7.56)

### Why

Host apps such as KodaX Space own paste/drop UI, sandbox storage, and path
authorization, but they should not import REPL-private files to normalize images
or construct `runKodaX` artifacts. `@kodax-ai/kodax/media` is backed by the
agent-layer `@kodax-ai/agent/media` implementation in v0.7.57, because input
artifacts are an agent capability rather than a coding-only concept.
`@kodax-ai/coding/media` remains as a compatibility re-export for existing
source consumers.

### Quick start

```ts
import {
  createFileArtifactFromPath,
  createImageArtifactFromPath,
  createVideoArtifactFromPath,
  enqueueWithArtifacts,
  getModelInputCapabilities,
  readAndNormalizeClipboardImage,
  validateInputArtifactsForModel,
} from '@kodax-ai/kodax/media';

const image = await readAndNormalizeClipboardImage();
if (!image) {
  // Clipboard did not provide a native image fallback. Continue normal text paste.
  return;
}

const stored = await spaceImageStore.write({
  bytes: image.buffer,
  mediaType: image.mediaType,
});

const artifact = createImageArtifactFromPath(stored.path, {
  mediaType: image.mediaType,
  source: 'clipboard',
  description: 'Clipboard image',
});

validateInputArtifactsForModel([artifact], {
  provider: selectedProvider,
  model: selectedModel,
});

// Pass the artifacts through `runKodaX` (or the `KodaXClient` constructor) —
// `context.inputArtifacts` is the public entry point. `KodaXClient.send`
// takes only a prompt string, so per-call artifacts go through `runKodaX`.
import { runKodaX } from '@kodax-ai/kodax/coding';

await runKodaX(
  {
    provider: selectedProvider,
    model: selectedModel,
    context: { inputArtifacts: [artifact] },
  },
  promptText,
);
```

### Capability query

Use provider and model together. The same model name behind a gateway route is
not assumed to support media unless that route is verified. A registered custom
provider with `imageInput: true` is treated as a verified image route — the
host declares the endpoint's vision capability, so no per-model probe is
needed.

```ts
const caps = getModelInputCapabilities({
  provider: 'minimax-coding',
  model: 'MiniMax-M3',
});

if (caps.image.sdkSupported) {
  enableImageDropZone();
}

if (caps.video.status === 'provider-native-unwired') {
  showVideoComingSoonCopy();
}
```

v0.7.57 can send image artifacts. File and video artifact shapes are stable, but
the SDK runtime does not serialize them yet. Known native-video models report
`video.status = 'provider-native-unwired'` so hosts can show accurate UI without
enabling a send path KodaX cannot serialize yet.

### Artifact contract

`KodaXInputArtifact` is a stable union:

```ts
type KodaXInputArtifact =
  | { kind: 'image'; path: string; mediaType?: KodaXImageMediaType; source?: KodaXInputArtifactSource; description?: string }
  | { kind: 'file'; path: string; mediaType?: string; mimeType?: string; name?: string; source?: KodaXInputArtifactSource; description?: string }
  | { kind: 'video'; path: string; mediaType: KodaXVideoMediaType; name?: string; source?: KodaXInputArtifactSource; description?: string };
```

Use `createFileArtifactFromPath()` for stable file metadata and
`createVideoArtifactFromPath()` when a video path has a supported media type
(`mp4`, `mpeg`, `mov`, `avi`, `flv`, `webm`, `wmv`, `3gp`). Video construction
throws `KodaXMediaError('UNSUPPORTED_MEDIA_TYPE')` if the type cannot be
inferred or supplied.

### File/video downgrade strategy

`getModelInputCapabilities()` distinguishes native provider support from SDK
runtime support:

- `image.status === 'supported'`: SDK can send image artifacts.
- `video.status === 'provider-native-unwired'`: the selected provider/model is
  native-video capable, but KodaX SDK does not serialize video artifacts yet.
- `file.status === 'unsupported'`: file artifacts are contract-stable, but KodaX
  SDK does not upload or extract files yet.

`validateInputArtifactsForModel()` enforces that policy before provider send.
Hosts should use the thrown `KodaXMediaError.code` and `detail` to disable send
or show downgrade UI. If Space wants to support files before SDK runtime wiring,
Space should perform its own extraction and include the extracted text in the
prompt rather than passing the file artifact through as sendable media.

### Queued follow-ups with artifacts

For streaming follow-ups, use `enqueueWithArtifacts()` instead of the raw
message queue:

```ts
enqueueWithArtifacts({
  provider: selectedProvider,
  model: selectedModel,
  sessionId: activeSessionId,
  content: followupText,
  inputArtifacts: [artifact],
});
```

The helper validates first and then stores `inputArtifacts` on the queued prompt.
Queued image follow-ups are rebuilt as multimodal content blocks on the next
runner turn. Unsupported file/video attachments are rejected before enqueueing.
Pass `sessionId` whenever the host can run more than one session concurrently;
it targets that Actor session's root queue without exposing Actor paths. For
backward compatibility, omitting both `sessionId` and `agentId` still binds to
the sole active Actor root, or uses the legacy unscoped SA queue when no Actor
run is active. If multiple Actor roots are active, the helper rejects the
ambiguous call instead of risking cross-session delivery. Low-level child-Actor
producers may continue to pass an explicit `agentId`.

`enqueueWithArtifacts()` is an in-process queue helper for direct/inline runs.
Runtime Worker and daemon clients must use `runtime.runs.submitInput(...)` (with
the same `sessionId` and `afterRunId`) because a process-local MessageQueue
cannot cross those transport boundaries. Use `delivery:'after_turn'` to create
a continuation Run after the current Run ends, or `delivery:'interrupt'` to
inject into the current active Actor Run at its next safe Runner boundary.

### Boundaries

- `readAndNormalizeClipboardImage()` returns `null` when there is no clipboard
  image fallback; thrown `KodaXMediaError` values are stable enough for host copy.
- Direct image path artifacts preserve `image/png`, `image/jpeg`, `image/webp`,
  and `image/gif`; clipboard normalization emits static PNG/JPEG bytes and may
  flatten animated GIFs before artifact creation. `image/gif` capability means
  SDK can pass the bytes and media type; provider animation semantics vary
  (for example, first-frame-only or non-animated GIF handling).
- `persistImageAsBlock()` is a convenience helper. Embedded hosts should usually
  pass `directory` or store bytes in their own sandbox before constructing an
  artifact path.
- `validateInputArtifactsForModel()` is pure shape/model validation. It does not
  probe host-owned sandbox paths.

### Reference

- Public SDK entry: `src/sdk-media.ts`.
- Shared implementation: `packages/agent/src/media/`.
- Compatibility source re-export: `packages/coding/src/media/`.
- Design: [docs/features/v0.7.56.md FEATURE_239](../../docs/features/v0.7.56.md#feature_239-sdk-multimodal-input--clipboard-image-public-api).

---

## 15. Space v0.7.57 follow-up ledger

These are the remaining SDK-consumer integration decisions reported after the
v0.7.57 source review. They are not all KodaX core regressions; most are Space
UI/API follow-ups that should consume the SDK contracts already exposed here.

- **Custom provider reasoning form**: Space should expose the v0.7.57 custom
  provider shape `reasoning: { efforts, default }` or `"none"` instead of only
  legacy reasoning-mode inputs. Keep using the SDK validator from
  `@kodax-ai/kodax/llm` so Space does not maintain a parallel schema.
- **Effort selector**: Space should build effort choices from
  `resolveModelCapabilities(provider, model)?.reasoningProfile.supportedEfforts`
  and `defaultEffort`. A fixed five-option selector will miss provider-specific
  values such as `xhigh`, `max`, or custom-provider effort names.
- **Repo-intelligence prewarm**: `prewarmRepoIntelligenceCaches()` is currently a
  best-effort warmup call, not a progress/completion contract. Hosts can call it
  opportunistically; if Space needs visible progress or a completed state, the
  next SDK step should be a small handle/result API rather than inferring status
  from cache side effects.
- **Relationship scan**: `relationship_scan` is a v0.7.57 agent/tool capability.
  It is intentionally model-facing today. Space can decide separately whether it
  deserves a top-level UI entry or remains available through normal agent turns.
- **Quick Ask / `sideQuery`**: `sideQuery` is exported from
  `@kodax-ai/kodax/llm`, so the capability ledger can move from blocked to
  partial. Migrating Space Quick Ask still needs an application-level decision
  about transcript promotion and history semantics, because `sideQuery` is an
  isolated text-only one-shot call rather than a chat-session append.

---

## 16. SDK agent-profile surface — `KodaXAgentProfile` (FEATURE_247, v0.7.58)

### Why

An SDK embedder (e.g. **KodaX-Space Partner**) often needs to run KodaX under a
named product persona — its own identity + instructions, a narrowed tool surface,
and a default verification standard — without forking the agent. `KodaXAgentProfile`
provides this as one **opaque, profile-gated** object on `options.context`. With no
`agentProfile` set the default Coding Agent is **byte-identical**; every path below
is a no-op.

### Shape

```ts
runKodaX({
  /* …your usual config… */
  context: {
    agentProfile: {
      surface: 'partner',            // opaque label ('code' | 'partner' | …)
      name: 'KodaX-Space Partner',   // opaque display name
      instructions: '…house rules injected into the AMA/AMAW Worker role prompt…',
      verification: { /* KodaXTaskVerificationContract — profile-default standard */ },
    },
    // R2 — narrow the model-visible tool list (applied on top of excludeTools):
    toolVisibilityPolicy: (tool) => tool !== 'web_search',
  },
});
```

### What each field / companion gates

- **R1 — identity + instructions.** `agentProfile.instructions` is prepended to the
  AMA/AMAW Worker role prompt; the SA path uses `context.systemPromptOverride`
  (mapped from `instructions` by `startKodaX`), so a profile behaves consistently
  across both execution modes.
- **R2 — `context.toolVisibilityPolicy`.** A predicate applied when the
  model-visible tool list is built (in addition to `excludeTools`); tools it returns
  `false` for are hidden from the model.
- **R3 — `agentProfile.verification`.** A profile-default `KodaXTaskVerificationContract`
  merged with per-task `context.taskVerification` (per-task fields win) before it
  reaches the Sidecar Verifier; each verdict is attributed to the profile.
- **R4 — `KodaXEvents.onEffectiveConfig`.** Reports the effective agentMode / tool
  scope / verification / resolved verifier at run start, so a host can reflect what
  the profile actually resolved to.
- **R5 — metadata across `fork()`.** Structured `profile` + `runtimeInfo` metadata
  ride on results and are inherited by forked sessions.
- **R6 — `compactSession(id, options)`** from `@kodax-ai/kodax/session` — an
  imperative session compaction the host can trigger directly.
- **R7 / R8 — attribution.** Session / profile / toolCall attribution is threaded
  into the tool execution context and onto inline-workflow process events + AMA tool
  events.
- **R9 — `reads-network` side-effect class** (`isToolNetworkRead`) tags read-only
  network tools (`web_search`, MCP read / prompt) so a profile can allow network
  reads without granting mutation.

### Reference

- Types: `KodaXAgentProfile`, `KodaXToolVisibilityPolicy`, `KodaXEffectiveTaskConfig`
  from `@kodax-ai/coding`; `compactSession` from `@kodax-ai/kodax/session`.
- Design: [docs/features/v0.7.58.md](../../docs/features/v0.7.58.md) FEATURE_247.

---

## 17. Runtime SDK, Worker isolation, and local daemon (FEATURE_253-FEATURE_257)

`@kodax-ai/kodax/runtime` is the stable host-facing runtime facade for
applications that want KodaX as a substrate instead of only as a terminal CLI.
It wraps the same coding/session engine used by the REPL and exposes it through
one interface in three deployment shapes:

- **embedded / inline**: in-process runtime owned by the caller;
- **embedded / worker**: private caller-owned runtime in a disposable V8 Worker;
- **daemon**: local-only runtime owner reached through a named pipe on Windows or
  a Unix domain socket on Linux/macOS.

The daemon is not a separate product engine. It hosts the embedded runtime behind
a process boundary, so REPL, Space, IDE adapters, ACP, and custom SDK clients can
share the same profile runtime without reimplementing sessions, permissions,
events, config, MCP, catalogs, artifacts, or diagnostics.

### Which shape to use

| Host scenario | Recommended shape | Why |
|---|---|---|
| Unit tests, one-off scripts, short-lived SDK tools | `createKodaXRuntime()` | No daemon lifecycle; easiest cleanup. |
| A single app owns all KodaX state in one process | `createKodaXRuntime({ mode: 'embedded' })` | Direct in-process calls and no IPC. |
| A single app needs private state plus hard V8 disposal | `createKodaXRuntime({ mode: 'embedded', isolation: 'worker' })` | Same services over MessagePort; `close()` escalates to Worker termination. |
| REPL + Space + IDE should share sessions/status/permissions | `createKodaXRuntime({ mode: 'daemon' })` | Starts or reuses the local profile daemon. |
| Attach to an already-started daemon only | `connectKodaXRuntime({ profile, homeDir })` | Attach-only by default; fails if no daemon is ready. |
| Test/CI isolated daemon namespace | pass `homeDir` and `profile` | Keeps state/config/sessions out of the user's home daemon. |

### Public construction contract

Import the Runtime facade from the dedicated subpath:

```ts
import {
  createKodaXRuntime,
  connectKodaXRuntime,
  type CreateKodaXRuntimeOptions,
  type KodaXRuntime,
} from '@kodax-ai/kodax/runtime';
```

The important creation options are:

| Option | Default | Contract |
|---|---|---|
| `mode` | `'embedded'` | Chooses private ownership or a shared daemon process. |
| `isolation` | `'inline'` | Embedded-only. `'worker'` creates a private Runtime Worker; daemon rejects any explicit isolation because it is already process-isolated. |
| `worker.resourceLimits` | unset | Optional V8 heap/stack limits; requires `isolation: 'worker'`. |
| `worker.shutdownTimeoutMs` | `2000` | Grace before the parent terminates the Runtime Worker. |
| `worker.configuredA2A` | `false` | Explicitly lets the Worker owner load and reconcile `<homeDir>/.kodax/integrations/a2a.json`; installs the full list/describe/spawn/task plane inside the Worker. |
| `requirements.hardDispose` | `false` | Rejects inline and daemon forms; prevents an accidental weaker ownership form. |
| `homeDir` | unset | When omitted, use the exact resolved `KODAX_HOME`. When set, this is the base directory that owns `.kodax`, with the same meaning as CLI `daemon --home`; daemon state/config live under `<homeDir>/.kodax`. |
| `profile` | `'default'` | Daemon uniqueness and runtime configuration namespace. |
| `sessionsDir` | `<homeDir>/.kodax/sessions` | Explicit session storage override. |
| `daemonStartupTimeoutMs` | `60000` | Total cold-start/concurrent-owner wait budget. |
| `daemonConnectTimeoutMs` | `2000` | Per-socket connection timeout. |
| `autoStartDaemon` | conditional | For `createKodaXRuntime({mode:'daemon'})`, true only when no explicit endpoint/transport is supplied. |
| `externalAgents` | unset | Host-installed executor factories, dispatch policy, optional credential/artifact policies, and default dispatch context. Inline owner only; see §18. |
| `requirements.externalAgents` | `false` | Reject a Runtime/daemon connection that does not advertise an installed external-agent plane. |

KodaX rejects contradictory options. Worker settings without Worker isolation,
`requirements.hardDispose` on inline/daemon forms, and any explicit isolation
on daemon mode are errors. Options are never silently ignored to select a
weaker isolation form.

### Basic embedded usage

```ts
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const runtime = await createKodaXRuntime({
  mode: 'embedded',
  homeDir: '/tmp/my-host-kodax',
  defaultProvider: 'zai-coding',
});

try {
  const session = await runtime.sessions.create({
    title: 'SDK embedded session',
    projectPath: process.cwd(),
    surface: 'my-host',
  });
  const handle = await runtime.runs.start({
    sessionId: session.id,
    prompt: 'Read package.json and summarize this project.',
  });
  const result = await handle.result;
  console.log(result.phase);
} finally {
  await runtime.close();
}
```

### Basic daemon usage

```ts
import { createKodaXRuntime, connectKodaXRuntime } from '@kodax-ai/kodax/runtime';

const replLikeClient = await createKodaXRuntime({
  mode: 'daemon',
  profile: 'default',
  clientInfo: { name: 'my-repl', title: 'My REPL', version: '1.0.0' },
  capabilities: {
    richEvents: true,
    permissionPrompts: true,
    contextDiagnostics: true,
  },
});

const spaceLikeClient = await connectKodaXRuntime({
  profile: 'default',
  clientInfo: { name: 'my-space', title: 'My Space', version: '1.0.0' },
  capabilities: {
    richEvents: true,
    permissionPrompts: true,
    contextDiagnostics: true,
  },
});

try {
  console.log(replLikeClient.identity.runtimeId === spaceLikeClient.identity.runtimeId);
} finally {
  await spaceLikeClient.close();
  await replLikeClient.close();
}
```

`createKodaXRuntime({ mode: 'daemon' })` is the high-level convenience API: when
no explicit `daemonEndpoint` or `daemonTransport` is supplied it starts or reuses
the local profile daemon. `connectKodaXRuntime()` is attach-only unless
`autoStart: true` is passed.

SDK auto-start allows `daemonStartupTimeoutMs` (default 60 seconds) and
`daemonConnectTimeoutMs`. The longer startup budget covers cold machines and
concurrent test/desktop startup without weakening PID, endpoint, token, or
runtime-identity validation.

### Windows daemon shutdown containment (v0.7.83)

On Windows, a newly started daemon is created suspended and assigned to a
kill-on-close Job Object before it is resumed. Daemon application code cannot
create descendants before that assignment. An out-of-Job supervisor waits for
the daemon to exit and then waits for the Job's active-process count to reach
zero, so a daemon PID exit alone is not a verified shutdown.

Hosts that own the shutdown boundary can use the public verifier:

```ts
import { waitForRuntimeDaemonShutdown } from '@kodax-ai/kodax/runtime';

const result = await waitForRuntimeDaemonShutdown({
  homeDir: kodaxHome,
  profile: 'default',
  runtimeId,
  timeoutMs: 30_000,
});
if (!result.verified) {
  throw new Error(`Runtime shutdown was not verified: ${result.outcome}`);
}
```

The connected daemon must advertise `daemonShutdownVerification: 1` when a host
requires this contract. A legacy daemon without Job-containment metadata is
kept usable for ordinary Session recovery, but it is never reported as a
verified shutdown and is not silently upgraded in place. Stop it explicitly and
relaunch it before requiring the capability. The CLI's `kodax daemon stop
--json` follows the same daemon-plus-supervisor boundary.

The daemon-owned slice does not close the Worker-owned child lifetime gap in
Issue 256; that owner-lease work remains open after v0.7.87, without a
replacement target assigned by this release. Worker and
executor cleanup still use identity-checked evidence and fail closed when a
descendant cannot be proven gone.

### Actor settlement recovery (v0.7.84)

The v0.7.84 Actor settlement boundary bounds progress persistence to one
in-flight durable projection plus one latest replacement. A terminal save can
therefore make progress without waiting behind an unbounded backlog. If Actor
durability becomes unknown because that boundary times out, a
`runtime.runs.abort()` Stop can reconcile the late Actor snapshot only for the
exact same local owner, validate the owner fence, quiesce remaining turns, and
retry the repair.

The receipt remains unknown until both Actor and executor settlement are
resolved. Repeated same-owner Stop delivery is idempotent under the same
unknown-owner proof; foreign owners, missing snapshots, legacy records, and
unresolved stores fail closed. After repair, Promise terminal facts win over
fallback callbacks, so a stale callback cannot rewind a terminal Run or emit a
duplicate outcome. A no-op quiesce does not rewrite the Session.

### v0.7.85 Runtime and Memory release boundaries

The v0.7.85 SDK adds Session-scoped Runtime Event Journals. Persist the full
`{ sessionId, journalEpoch, seq }` cursor and always replay with `sessionId` or
`runId`; numeric Runtime-global sequences are not resumable cursors. A2A binds
one Runtime Session to each Task, and daemon clients require
`sessionEventJournal:1`. Corrupt journal indexes, cursor scope mismatches, and
ambiguous retention evidence fail closed.

Memory management is conversation-first for explicit remember, correction,
forget, recall, and exceptional-decision requests. Safe explicit mutations are
host-governed and immediate; ambiguous or inferred changes remain reviewable.
F289/F290 bound review draining and lesson/verdict admission, and the
experimental Memory SDK exposes the additive management facade only when the
supplied controller supports it. Terminal Runs with authoritative status and
no queued interrupt input are restored at startup without replaying complete
event journals. The semantic repo-intelligence Worker retires after its idle
warm-cache window, while later cache misses start a fresh Worker.

### v0.7.86 Runtime ownership and sandbox lifecycle boundaries

The v0.7.86 SDK hardens ownership and sandbox cleanup without weakening the
fail-closed contract. Inline daemon-enable recovery removes only a provably
abandoned inline owner fence; live, malformed, legacy, and ambiguous owners
remain untouched. Runtime owner and learning-file lock records include an OS
process-start identity, so PID reuse cannot preserve stale ownership.

On Windows, sandbox ACL owner markers are durable and recovery is serialized
across Runtime profiles. A sandbox stop waits for process-tree termination proof
before ACL recovery. Missing attestation fences later filesystem effects and
does not replay the command; spawn, lease-release, and cleanup failures remain
combined in the lifecycle diagnostic for operator recovery.

POSIX workspace sessions use the same replacement fence: an unconfirmed
process-tree or cleanup failure latches the sandbox safety state and prevents a
new workspace session from racing the retained one. A fresh `KODAX_HOME` has
its Runtime-owned policy roots initialized before identity capture, concrete
admission waits only for workspace-local warm-up within the Shell abort/deadline,
and lease-cleanup failure retires the invalid cached session before replacement.

Windows workspace Shell execution also preserves case-insensitive `PATH`/`Path`
and `PATHEXT` values through both Runtime broker layers. Read grants are derived
from the final shell PATH and executable, including only bounded junction
ancestors for profile-managed toolchains. The `cmd.exe` verbatim-argument
contract is retained for quoted paths and executable lookup. Exact workspace,
Agent Home, additional-filesystem, toolchain, and network policies form a
cross-process Windows policy group; compatible owners join without global ACL
recovery and only the last owner recovers. Incompatible policy or pre-start
infrastructure failure returns to the already-authorized normal permission path.
A missing lifecycle attestation after target start remains fail-closed and is
never repaired by replaying the command. Runtime sandbox capability v3 first
fenced older daemon policy revisions in v0.7.86. The current contract is
`sandboxRuntime:5`: auto-start replaces an idle older daemon and fails closed
while it is busy. Version 5 adds automatic same-boot Windows ACL recovery: a
sandbox-user SID probe must prove that no unrelated process remains before an
uncontained `unconfirmed-owner` ticket is cleared. Probe uncertainty is
diagnosed and retried automatically; it never becomes permission to reset ACLs.
Sandboxed text cleanup also retains a consumed execution attestation
across retries. Transient workspace cleanup, policy reset, and outer effect
lease release are retried without replaying the text operation or repeating a
completed cleanup phase.

`homeDir` and `KODAX_HOME` deliberately name different levels. Runtime SDK and
CLI daemon `--home` accept the **base directory that contains `.kodax`**;
lower-level `KODAX_HOME` points at the **data directory itself** and need not be
named `.kodax`. To share the default CLI daemon, omit `homeDir`; this honors the
exact resolved `KODAX_HOME`. Passing `os.homedir()` explicitly instead selects
`<os.homedir()>/.kodax`, regardless of an ambient custom `KODAX_HOME`. For an
isolated embedder namespace, pass a private base directory and expect data at
`<homeDir>/.kodax`. Passing `~/.kodax` as `homeDir` would instead select
`~/.kodax/.kodax` and a different daemon namespace.

### v0.7.88 GLM Coding Plan boundaries

The built-in model catalog exposes both `glm-5.3` and `glm-5.2` for
`zhipu-coding` and `zai-coding`; both aliases default to `glm-5.3` (the
overseas alias switched from `glm-5.2` on 2026-08-15). `ark-coding` likewise
defaults to `glm-5.3` and keeps `glm-5.2` (alias `glm-latest`). Capability
metadata still records the 1M context locally,
but the provider sends the model ID verbatim and never appends `[1m]`.

GLM-5.3 is always-thinking. Hosts may continue to express a stable `off` /
`none` intent; KodaX normalizes it to low effort. Anthropic-compatible requests
use adaptive thinking plus `output_config.effort`, while OpenAI-compatible
requests use enabled thinking plus `reasoning_effort`.

### v0.7.89 web search and run-scoped Host Tools

The built-in `web_search` remains zero-service and requires no API key or
hosted search provider. Its default bounded attempts are DuckDuckGo's HTML
results, Bing RSS, then Bing HTML. A structurally valid empty result is a
successful empty result; transport, challenge, HTTP-status, or parse failures
fall through with per-attempt diagnostics. Results expose normalized direct
HTTP(S) locators, deduplicated items, `freshness: unknown` when freshness is not
provable, and the winning transport metadata. `KODAX_WEB_SEARCH_ENDPOINT` is
an explicit single-endpoint compatibility override and never silently joins the
public fallback chain.

When a daemon run binds a Host Tool lease, v0.7.89 materializes the leased
descriptors into that run's model-facing tool table and adds a cache-stable
`Host Capability Provider (run-bound)` catalog block. Host Tools remain outside
`TOOL_REGISTRY`; dispatch is registry-first, so the executed schema is the one
the model saw. `none` side effects are readonly/plan-allowed, while
`idempotent` and `non_idempotent` tools are mutating/plan-blocked. Revocation,
name collisions, malformed lease ids, and unknown capability paths fail closed;
unrelated CLI runs do not inherit a Space lease. A2A role policies may authorize
exact `host:<leaseId>:<tool>` capability ids.

### v0.7.90 stabilization boundaries

The v0.7.90 patch preserves the v0.7.89 SDK contracts while tightening three
follow-up boundaries. A workspace-session RPC timeout fails its pending request
and retires the shared session through orderly close; cleanup may use the full
reset-grace budget before a replacement is admitted. Daemon diagnostics encode
Error names/messages, `AggregateError.errors`, and `cause` chains, including
cyclic chains, so hosts can distinguish timeout, attestation, and deletion
failures.

Session lineage `sourceEntryId` is the direct physical predecessor copy, not a
transitive root. The archive slimmer keeps a direct predecessor referenced by a
retained clone addressable for one hop and places its archive marker under the
retained parent. Hosts should continue to use `readConversationHistory()` for
ordinary-chat folding and `readFullTranscript()` for raw audit scrollback.

Run-scoped leased/embedded tool schemas are normalized at the shared model
materialization point to `{ type: 'object', properties, required? }`; only
string names remain in `required`. This keeps the schema shown to the model and
the provider wire contract aligned across daemon and embedded hosts.

### Worker-hosted embedded usage

```ts
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const runtime = await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'worker',
  worker: {
    resourceLimits: { maxOldGenerationSizeMb: 1024 },
    shutdownTimeoutMs: 2000,
    configuredA2A: true,
  },
  requirements: { externalAgents: true },
});

try {
  console.log(runtime.identity.isolation);      // 'worker'
  console.log(runtime.identity.workerThreadId); // Node Worker thread id
  // runtime.sessions/runs/events/... are identical to inline and daemon.
} finally {
  await runtime.close();
}
```

`mode` describes ownership and sharing; `isolation` describes where a private
embedded owner executes. Inline is the lowest-latency default. Worker is useful
for Electron/Space-style hosts that need private state and deterministic V8
disposal. Daemon is for durable multi-client sharing and already uses an OS
process, so daemon + worker is rejected.

Worker `resourceLimits` bound parts of the V8 heap only. They do not cover every
kind of native/external memory and do not make Node code safe to treat as
untrusted. Worker isolation is a fault boundary, not a security sandbox.

Configured A2A is loaded by the Worker owner, not serialized from a parent
factory closure. `worker.configuredA2A` is therefore an explicit opt-in. When
enabled, the Worker reconciles the same user document as the CLI/daemon path,
advertises `externalAgents`, and backs `listDispatchable`, `describe`,
`preflight`, and external Actor dispatch with one real executor plane.

Callers that cannot accept a silent fallback can require the capability:

```ts
await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'worker',
  requirements: { hardDispose: true },
});
```

Daemon hosts advertise `hardDispose: false`; Worker hosts advertise true.

### Close, abort, and ownership semantics

The same method name deliberately has deployment-specific ownership effects:

| Form | `runtime.close()` | Run abort | After owner crash/termination |
|---|---|---|---|
| embedded / inline | Cancels owned runs and permissions and closes private runtime state. It cannot recover a host event loop blocked by arbitrary inline code. | `runs.abort(runId)` settles the Runtime handle and forwards cancellation to coding. | The embedding process owns recovery. |
| embedded / Worker | Requests shutdown, waits up to `shutdownTimeoutMs`, then always terminates the Worker. | Same Runtime abort API; closing the Runtime is the hard-disposal escalation for the whole isolate. | Pending transport requests reject; create a new Runtime explicitly. |
| daemon client | Detaches only this client transport. Other REPL/Space/SDK clients and runs remain owned by the daemon. | Aborts only the addressed run. | The client connection rejects; reconnect explicitly after the daemon is healthy. |

`close()` is idempotent. It is not a shared-daemon stop command. Use
`kodax daemon stop`, `kodax daemon restart`, or an authenticated low-level
`runtime.shutdown` request for administrative shutdown. KodaX does not
automatically retry or replay an in-flight run after a Worker/daemon owner dies,
because provider and tool side effects may already have happened.

`runtime.shutdown` and `stopForInline()` responses mean the fenced stop was
accepted; host-close logging and owner-lock release are also intermediate
progress boundaries. A successful `kodax daemon stop` / `restart` additionally
waits for the original daemon PID to disappear and verifies a shutdown-success
outcome bound to that exact Runtime ID and PID. Before that process exits, the
serve host completes bounded A2A/extension, LSP, managed-child-tree, and tracing
cleanup; an unverified current-owner child tree, cleanup timeout, failed outcome,
or missing outcome makes CLI stop fail instead of reporting a false success.
The stop client also owns an outer watchdog that starts when the request is
accepted. On Windows it captures the daemon's creation identity before
requesting shutdown and can therefore reclaim that exact process tree if
Runtime close never settles or synchronous code blocks the daemon event loop.
Node 20 exposes only cached-PID signaling on POSIX, so KodaX fails closed there
instead of risking a reused PID/PGID; the result is `cleanup_unverified` and the
process is left to an external lifecycle manager until Issue 269 supplies a
retained native handle/supervisor. A forced exit without a matching success
outcome is never success. After the original PID exits, the client re-reads the profile; JSON
results use `replacementRunning: true` and return the current state/health when
a replacement daemon has already acquired the owner lock. Such a result also
uses `stopped: false` and `reason: 'replacement_running'`, so existing callers
that gate cleanup on `stopped` remain safe. Callers must not clean or rebuild a
profile while that flag is present or health is non-missing.
The administrative connection also verifies that `initialize.identity` still
matches the Runtime ID/profile observed before connecting; if an old owner exits
and a replacement binds the same endpoint first, the stale stop command fails
without sending `daemon.stop` to the replacement.

### Daemon ownership and state

Daemon ownership is scoped by `homeDir + profile`.

- Default `homeDir` is the OS user home directory.
- Default `profile` is `default`.
- State lives under `.kodax/runtime/daemon/{profile}/`.
- Default runtime session storage is also scoped under `<homeDir>/.kodax/sessions`
  when `sessionsDir` is omitted.
- Windows uses a named pipe; Linux/macOS use a Unix domain socket.
- The daemon opens no public TCP listener.

For a given profile, one owner wins an atomic lock. Concurrent starters wait for
the winner and connect once it is ready. Stale state is cleaned only after pid,
endpoint, token, and runtime identity checks. If ownership cannot be verified,
KodaX reports the daemon as unhealthy instead of killing an arbitrary process.
SDK auto-start launches a detached `kodax daemon serve` process; it never treats
an in-process socket listener as daemon mode. Closing the SDK client detaches
without stopping that shared process. Use `kodax daemon stop` or the explicit
runtime shutdown protocol to stop the owner.

CLI and SDK startup retain the exact spawned candidate until health confirms
that candidate PID. Early exit, timeout, identity mismatch, cancellation, or a
different owner winning the race reclaims only the unsuccessful candidate
process tree. Once healthy, the owner detaches normally and is not tied to the
creating client process.

### Daemon startup, conflict, and recovery behavior

REPL, Space, and SDK callers using the same resolved `homeDir + profile` target
the same daemon. Simultaneous startup is expected: candidates race only for the
atomic owner lock, then non-owners wait for and attach to the verified winner.
A client never owns a daemon merely because it caused auto-start.

On abnormal exit, the next start validates the saved PID, endpoint, token, and
runtime id before removing stale state. KodaX will not kill a process whose
ownership cannot be proven. Persisted queued/running/waiting-permission runs are
recovered as `interrupted` with a runtime event; they are not resumed
automatically. Session and bounded event records remain available for explicit
reconnect/retry decisions.

Operational guidance:

- use one stable profile for cooperating desktop clients;
- use a separate `homeDir` or profile for tests, previews, and incompatible
  configurations;
- test harnesses that auto-start a process daemon must send authenticated
  `runtime.shutdown` (or run `kodax daemon stop --home <dir> --profile <name>`)
  before deleting their temporary home; use the CLI command when the caller
  needs a completed process-exit boundary, because `runtime.close()` only
  detaches and the low-level shutdown response is acceptance, not completion;
- KodaX's own Vitest harness also supplies an internal worker-PID marker so a
  forcibly terminated worker cannot strand its test daemon; this is a test-only
  fallback, not a public SDK option or a production idle-shutdown policy;
- query `kodax daemon status --json` before deciding to restart;
- inspect `kodax daemon logs --lines 100` when startup times out;
- custom endpoints and injected transports are attach-only unless the caller
  implements their owner lifecycle explicitly.

The matching CLI surface is:

```bash
kodax daemon start --profile default
kodax daemon status --profile default --json
kodax daemon logs --profile default --lines 100
kodax daemon stop --profile default --json
kodax daemon restart --profile default
kodax --runtime-mode daemon
```

Inside the REPL, `/status runtime` reports embedded/daemon mode, profile,
runtime id, endpoint/health when applicable, and active/queued counters.

### Runtime services

Every `KodaXRuntime` exposes the same service set in inline, Worker, and daemon mode:

| Service | Purpose |
|---|---|
| `identity` | Runtime id, mode, isolation, profile, started time, package version, optional Worker thread id. |
| `sessions` | Create/load/list/fork/transcript/settings/notice/rewind/compact/archive/delete. |
| `runs` | Start/await/get/list/abort runs; update provider/model/reasoning for supported phases. |
| `events` | Subscribe to live events and replay persisted bounded events. |
| `permissions` | Request/list/respond to tool permissions across clients. |
| `workflows` | Observe workflow process snapshots/events and lifecycle controls. |
| `config` | Read/patch/reload daemon or embedded profile config. |
| `catalog` | Providers, models, commands, skills, custom providers, extensions. |
| `mcp` | MCP server CRUD, validation, reload, and tool catalog listing. |
| `artifacts` | Create/get/delete runtime artifact references for file/image/video inputs. |
| `status` | Runtime snapshot with sessions, runs, permissions, workflows, and daemon counters. |
| `diagnostics` | Latest context-budget and tool-exposure decisions for GUI/debug surfaces. |
| `admin.agentRegistrations` | List/upsert, atomically set `enabled` while preserving the full registration, or remove redacted external-agent registrations. Owner/revision-conditional mutation prevents a stale manager from changing a same-ID replacement. With no plane, list is empty and mutations fail clearly. |
| `agents` | Check `enabled`, list/describe policy-filtered dispatchable agents, and preflight a selected route. |
| `agentTasks` | Start/list/get/wait/continue/cancel/reconcile durable external-agent tasks and read their ordered event stream. |

### Sessions, runs, and queueing

Runs are serialized per session and can run concurrently across different
sessions. Same-session prompts are FIFO queued. `runs.start()` returns a handle
with a `result` promise that always settles on completion, failure, abort, or
runtime close.

```ts
const session = await runtime.sessions.create({ title: 'Shared session' });

const sub = runtime.events.subscribe({ sessionId: session.id }, (event) => {
  if (event.type === 'assistant.delta') {
    // Render streaming text in the host UI.
  }
});
// Daemon subscriptions establish a remote handshake. Await this before
// starting work whose first event must not be missed; local subscriptions omit it.
await sub.ready;

const artifact = await runtime.artifacts.create({
  kind: 'image',
  path: '/tmp/screenshot.png',
  mediaType: 'image/png',
});

const handle = await runtime.runs.start({
  sessionId: session.id,
  input: [
    { type: 'text', text: 'Review this screenshot.' },
    { type: 'artifact_ref', artifactId: artifact.id },
  ],
  options: {
    provider: 'zai-coding',
    effort: 'high',
  },
});

const result = await handle.result;
sub.close();
```

### Session-scoped event cursors

Runtime event order is defined inside one Session, not across the Runtime.
Every event exposes a cursor:

```ts
type RuntimeSessionCursor = {
  sessionId: string;
  journalEpoch: string;
  seq: number;
};
```

Persist the whole cursor and resume in the same Session or Run scope:

```ts
const page = await runtime.events.replay({ sessionId: session.id });
const after = page.at(-1)?.cursor;
const next = await runtime.events.replay({
  sessionId: session.id,
  ...(after ? { after } : {}),
});
```

This is a breaking replacement for unscoped `events.subscribe()` /
`events.replay()` and numeric `sinceSeq`. A scope is always required. Cursors
from another Session or an earlier journal epoch return `resync_required`; get
a fresh Session observation/replay instead. Separate Sessions may both contain
`seq: 1`, which is intentional and removes cross-Session lock contention.
Supplying both `sessionId` and `runId` validates their ownership before either
subscribe or replay, even when the Run has no retained event rows. Malformed
cursors return `invalid_argument`. Reusing a deleted Session ID starts
a new epoch and invalidates the earlier cursor. Persistence backpressure is
also isolated per Session, so a blocked Session journal does not stop unrelated
Sessions using the same embedded Runtime or home directory. Runs retain a small
journal-identity index independently of bounded event rows; if a retention
watermark becomes unreadable after child rows are trimmed, only cursors for a
journal known to that Run are forced to resync when the index is valid. A
missing or corrupt index cannot prove that an old trimmed journal is unrelated,
so that ambiguous migration case also requires a fresh snapshot.

### Run options across Worker/daemon boundaries

`runs.start({ options })` is a DTO boundary in Worker and daemon forms. Do not
pass process-local objects such as `extensionRuntime`, callbacks, `AbortSignal`,
LSP services, class instances, or cyclic structures. KodaX rejects them before
transport instead of silently dropping fields.

`events.beforeToolExecute` is an executable policy hook, not an observation
callback. It is preserved in embedded mode and rejected in daemon mode; install
the equivalent policy in the daemon owner instead. The KodaX REPL explicitly
marks and removes only its own legacy approval hook because Runtime-owned
permission brokering replaces that hook.

Use the runtime APIs for cross-boundary behavior:

- cancellation: `runtime.runs.abort(runId)`;
- output/progress: `runtime.events.subscribe(...)`;
- approval: `runtime.permissions.respond(...)`;
- session defaults: `runtime.sessions.updateSettings(...)`;
- config/MCP/extensions: configure or reload them in the Runtime owner.

Host-bound extensions or callbacks that cannot be represented as owner-loaded
module/config descriptors require inline embedded mode. There is no fallback to
executing those objects in the client process.

For daemon mode, extension and MCP ownership follows daemon configuration.
Configure extensions in the daemon profile and call
`runtime.catalog.reloadExtensions()` or the matching config service. A CLI
`--extension <path>` is intentionally rejected in daemon mode because that
process-local object cannot become part of a durable shared owner. Worker mode
has the same DTO rule; use owner-readable config/module descriptors or inline
mode for host-created extension objects.

### Permissions across clients

Pending permission requests live in the runtime/daemon, not in one UI client. A
Space-style client can subscribe to permission events and answer a request
created by a REPL-style client.

```ts
const sub = runtime.events.subscribe(
  { sessionId: session.id, type: 'permission.requested' },
  (event) => {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') {
    return;
  }
  void runtime.permissions.respond(
    payload.id,
    { type: 'allow_once' },
    { runId: payload.runId },
  );
  },
);
await sub.ready;
```

Await `ready` before another client starts work that may request permission;
this creates an explicit cross-connection ordering boundary. Only the first
valid response wins. Wrong-run or stale responses are rejected.
Abort, runtime close, daemon stop, and timeout reject unresolved permission
requests so tool approval promises do not hang forever. Permission timeout is
a fail-closed `{ type: 'reject', cause: 'approval_timeout' }` decision.

Hosts that render approval UI should use the public lifecycle helper instead
of awaiting a dialog directly from an event listener:

```ts
import { handleRuntimePermissionRequest } from '@kodax-ai/kodax/runtime';

await handleRuntimePermissionRequest(runtime, request, async (pending, context) => {
  // Close the popup when context.signal aborts. Runtime timeout, cancellation,
  // or a response from another client can all win before this UI does.
  return showPermissionDialog(pending, { signal: context.signal });
});
```

`handleRuntimePermissionRequest()` subscribes before showing the prompt,
rechecks pending state, and makes Runtime resolution authoritative. A late UI
answer is ignored. Embedded AskUser callbacks receive the same optional third
argument, `{ signal }`; abort the visible prompt when it fires.

`createKodaXRuntime({ userInputTimeoutMs })` and daemon auto-start use an
independent AskUser deadline (300,000 ms by default). The value must be a
positive integer no greater than 2,147,483,647 and is validated before
embedded, Worker, or daemon startup. The same bound applies to
`permissionTimeoutMs`, except that its existing value `0` disables the
permission timer. On expiry, the Runtime accepts only a model-supplied default that is
valid for the rendered options and selection bounds; otherwise it dismisses
the question. MCP reverse elicitation uses the same five-minute bounded UI
lifecycle and safely cancels a stalled prompt.

SDK clients that create a concrete request may pass `toolInput` and
`executionCwd` to `runtime.permissions.request(...)` in both embedded and
daemon mode. The Runtime removes raw `toolInput` before publishing the pending
request, derives the bounded/redacted preview from that concrete input,
canonicalizes it into a matcher, and returns only opaque `grantSuggestions`.
A caller-supplied `inputPreview` cannot override this trusted summary.
`projectRoot`, classifier signals, and other owner-only safety context are
deliberately not client request fields.

Grant administration is typed through `RuntimePermissionScope` and the
exported `RuntimePermissionMatcher` union (`exact-command`, `exact-path`, and
`exact-call`). These types are available from both the package root and
`@kodax-ai/kodax/runtime`; matcher construction remains Runtime-owned.
Legacy `allow_always.scope` responses remain accepted for 0.7.x clients, but
the Runtime narrows them to its concrete candidate and never persists the
client-provided coarse scope. Legacy persisted grants that lack a Runtime
matcher remain inspectable and revocable, but never authorize a concrete tool
call; the user must approve a fresh Runtime-issued exact suggestion.

### Config, catalogs, MCP, and Space-style admin APIs

Daemon-connected clients should not edit KodaX config files directly. Use the
runtime services instead:

```ts
await runtime.config.patch({ provider: 'zai-coding', model: 'glm-5.2' });
await runtime.config.reload();

await runtime.catalog.upsertCustomProvider({
  name: 'my-openai-compatible',
  protocol: 'openai',
  baseUrl: 'https://example.com/v1',
  apiKeyEnv: 'MY_LLM_API_KEY',
  model: 'my-model',
  // imageInput: true,  // uncomment when the endpoint is multimodal (vision)
});

await runtime.mcp.upsertServer('filesystem', {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
});
await runtime.mcp.reloadServers();

const commands = await runtime.catalog.commands(process.cwd());
const skills = await runtime.catalog.skills({ projectRoot: process.cwd() });
```

`runtime.catalog.skills()` returns all enabled Skills. `userInvocable` is true
for every entry; `disableModelInvocation` tells the host whether the entry is
also model-visible. The legacy `userInvocableOnly` filter is accepted for wire
compatibility but no longer removes enabled Skills.

This is the intended path for KodaX Space, IDE adapters, and settings UIs:
session defaults go through `sessions.updateSettings()`, one-turn overrides go
through `runs.start({ options })`, and daemon/profile config goes through
`config`, `catalog`, and `mcp`.

### Context optimization and diagnostics

The runtime carries the Hermes-inspired context-efficiency plane from the coding
engine:

- small-window schema pruning hides non-core deferred tool schemas while keeping
  bridge discovery resident;
- tool-search/describe/call-style bridge semantics keep tools reachable;
- repo-intelligence schemas remain discoverable under pressure;
- context-aware tool result budgets and compaction pressure events are surfaced
  as bounded diagnostics.

Hosts that set `capabilities.contextDiagnostics: true` can read:

```ts
const budget = await runtime.diagnostics.latestContextBudget({ sessionId });
const exposure = await runtime.diagnostics.latestToolExposure({ sessionId });
const cache = await runtime.diagnostics.latestProviderCacheDiagnostic({ sessionId });
```

Pass `{ sessionId, contextKind: 'child', agentId }` to query one logical child
even though its physical transcript uses an isolated Session. Diagnostic
payloads carry `contextId` and, for children, `parentContextId`; reconnecting
hosts can use the same latest APIs instead of fabricating identity fields.
These diagnostics are designed for status panels and debugging. Budget
snapshots contain counts, and cache diagnostics contain hashes plus
Provider-reported usage; they do not contain raw prompt or sensitive tool
input/output.

### Protocol schema and versioning

The runtime subpath also exports daemon protocol metadata for clients that need
schema-aware IPC validation:

```ts
import {
  KODAX_DAEMON_PROTOCOL,
  KODAX_DAEMON_PROTOCOL_VERSION,
  RUNTIME_DAEMON_PROTOCOL_SCHEMA,
  listRuntimeDaemonSchemaMethods,
} from '@kodax-ai/kodax/runtime';
```

The schema is additive within this patch line. Removing or changing required
fields requires a protocol version bump.

### v0.7.69 Runtime verification record

This subsection is the historical verification record for the original shared
Runtime delivery. Current 0.7.80 release gates and evidence live in
[`docs/release.md`](release.md#v0780-release-preparation).

The v0.7.69 release validation covers the runtime migration, the Worker
isolation follow-ups delivered ahead of their original v0.7.71/v0.7.72
planning slots, the v0.7.67 external-agent/session additions, the v0.7.68
experimental Memory Agent surface, and the v0.7.69 A2A/integration/shared-
daemon delivery:

- Node 20 and Node 22 post-review regression for process cleanup, lock
  ownership, frozen eval inputs, A2A transport, and the built-in manual;
- root `tsc --noEmit`, package builds, bundle builds, and all 12 public DTS
  entries on Node 20 and Node 22;
- runtime/daemon/SDK/ACP/REPL integration tests, including process-distinct SDK
  auto-start and multi-client sessions/permissions;
- Worker Runtime identity, service parity, hard close, capability requirements,
  and contradictory-option rejection;
- constructed-handler reverse tool RPC, abort bridging, CPU-loop termination,
  respawn, and revoke/dispose queue drainage;
- context/tool-exposure eval gate;
- embedded and hosted-daemon external-agent catalog/task parity, durable task
  recovery, policy/credential/artifact gates, and disabled-plane failure;
- exact session `surface` filtering plus opaque cursor continuation through the
  narrow `/session` API, embedded Runtime, and daemon transport;
- scoped zero-wait memory recall, read-only deliberate query, trace-only
  receipts, bounded episode review, governed consult-before-write promotion,
  and the self-contained `/experimental-memory` bundle/DTS surface;
- bidirectional A2A 1.0 discovery/call/serve, durable task replay, no-code
  configuration, local-Agent binding, exact Skill-script admission, SSRF/
  credential boundaries, and the self-contained `/a2a` bundle/DTS surface;
- split MCP/A2A/Extension configuration, lossless migration, canonical-template
  drift checks, last-known-good hot reload, draining, and restart-required
  classification;
- atomic shared-daemon observation/resync, durable operations and same-session
  ordering, settings/grant CAS, AskUser/permission transport, credential/Host
  Tool reverse bridges, owner fencing, restart outcomes, and process-distinct
  client/daemon smokes with credential-canary scans;
- a fresh `0.7.69` tarball consumer importing all 11 public subpaths, creating a
  Worker-hosted session, running the packaged CLI, and checking packaged DTS and
  Worker sidecars; plus a Windows x64 binary/version/sidecar smoke;
- external fresh npm consumer installation of the `0.7.67` tarball, proving
  Worker isolation and a distinct daemon PID through the published subpath;
- Ubuntu Node 22 Unix-domain-socket daemon gate, including two clients sharing
  one runtime and cross-client permission resolution.

The portable manual gates remain in
`docs/test-guides/FEATURE_255_v0.7.66_TEST_GUIDE.md`,
`FEATURE_256_v0.7.71_TEST_GUIDE.md`, and
`FEATURE_257_v0.7.72_TEST_GUIDE.md` for release-machine verification; the latter
two filenames retain their original planning slots while their content records
the v0.7.66 delivery. v0.7.67 adds
`FEATURE_258_v0.7.67_TEST_GUIDE.md`, `FEATURE_259_v0.7.67_TEST_GUIDE.md`, and
`FEATURE_261_v0.7.67_TEST_GUIDE.md`; v0.7.69 adds
`FEATURE_267_v0.7.69_TEST_GUIDE.md`, `FEATURE_268_v0.7.69_TEST_GUIDE.md`, and
`FEATURE_269_v0.7.69_TEST_GUIDE.md`. The earlier release-preparation Actions
run is not reused after the severe-fix review. Fresh GitHub Actions run
`29385073422` passes the Node 20/22 build, bundle, DTS, and full-test matrix plus
the Node 22 Unix-domain-socket daemon gate. npm publication remains a
maintainer-owned manual step.

---

## 18. External-agent executor plane (FEATURE_258, v0.7.67)

FEATURE_258 lets an SDK host register remote agents without teaching the coding
runtime a specific A2A, MCP, or HTTP client. The public contracts live in
`@kodax-ai/kodax/agent`; the host-facing catalog and task services live on
`@kodax-ai/kodax/runtime`.

### Ownership rule

An `AgentExecutorFactory` contains functions, so it cannot cross a Worker or
daemon DTO boundary. Install factories where the Runtime owner executes:

| Desired owner | Supported construction |
|---|---|
| Private in-process owner | `createKodaXRuntime({ mode: 'embedded', isolation: 'inline', externalAgents })` |
| New locally hosted daemon owner | `createKodaXRuntime({ mode: 'daemon', profile: '<unique>', externalAgents })` |
| Existing daemon | Configure its owner, then attach with `connectKodaXRuntime({ requirements: { externalAgents: true } })`; a client cannot inject factories. |
| Runtime Worker | Use `worker: { configuredA2A: true }` for the built-in configured A2A plane. Custom factories must still be installed by a custom Worker owner; passing function-valued `externalAgents` from the parent is rejected. |

When `mode: 'daemon'` and `externalAgents` are supplied, the caller must win a
new in-process daemon lease. KodaX rejects an already-running profile instead of
silently replacing its executor configuration. Closing that owner facade shuts
down the host it created; closing an ordinary attached client only detaches.

### Minimal owner and task flow

The reference executor below is a contract/conformance adapter. Replace it with
your own `AgentExecutorFactory` for a real remote protocol.

```ts
import {
  createReferenceAgentExecutorFactory,
  type ExternalAgentRegistration,
} from '@kodax-ai/kodax/agent';
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const runtime = await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'inline',
  externalAgents: {
    factories: [createReferenceAgentExecutorFactory({
      executorId: 'example-http',
      protocol: 'http',
    })],
    policy: ({ registration, query }) => ({
      allowed: registration.enabled && query.readOnly === true,
      reasons: query.readOnly === true ? [] : ['This host allows read-only dispatch only.'],
    }),
    defaultContext: { actorId: 'desktop-host' },
  },
});

const registration: ExternalAgentRegistration = {
  agentId: 'external:reviewer',
  displayName: 'Remote Reviewer',
  enabled: true,
  executorId: 'example-http',
  protocol: 'http',
  configurationRevision: 'reviewer-config-v1',
  endpointIdentityHash: 'sha256:replace-with-stable-endpoint-identity',
  skills: ['code-review'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  capabilities: {
    streaming: 'supported',
    durableTasks: 'supported',
    inputRequired: 'conditional',
    cancellation: 'supported',
    artifacts: 'unsupported',
  },
  effects: { remote: 'read', workspace: 'proposal' },
  maxConcurrency: 1,
};

try {
  await runtime.admin.agentRegistrations.upsert(registration);

  const query = {
    actorId: 'desktop-host',
    requiredSkills: ['code-review'],
    readOnly: true,
  } as const;
  const available = await runtime.agents.listDispatchable(query);
  const preflight = await runtime.agents.preflight({
    agentId: 'external:reviewer',
    query,
    expectedConfigurationRevision: registration.configurationRevision,
  });
  if (!preflight.ok) throw new Error(preflight.reasons.join('; '));

  const started = await runtime.agentTasks.start({
    agentId: 'external:reviewer',
    objective: 'Review the supplied immutable patch and return cited findings.',
    context: { actorId: 'desktop-host', runId: 'host-run-42' },
    readOnly: true,
    requiredSkills: ['code-review'],
    expectedConfigurationRevision: registration.configurationRevision,
  });
  const terminal = await runtime.agentTasks.wait(started.taskId, 60_000);
  console.log(available, terminal.state, terminal.output, terminal.usage);
} finally {
  await runtime.close();
}
```

`runtime.agents.enabled` is the cheap external-plane feature check. If it is
false, catalog queries can still return built-in local agents but no external
agents; registration and task lists are empty, while point reads and mutations
fail clearly. Set
`requirements.externalAgents: true` when absence must abort connection.

### Service reference

| Surface | Methods | Contract |
|---|---|---|
| `runtime.admin.agentRegistrations` | `list`, `upsert`, `setEnabled`, `remove` | Durable owner configuration. `setEnabled` preserves the complete captured executor registration while changing admission. Mutations accept both `expectedConfigurationRevision` and `expectedManagementOwner`; `setEnabled` can also atomically `claimOwner` on an unowned registration and rejects another owner. List results expose `managementOwner` and `credentialConfigured`, never a credential value. The same contract is carried across the daemon transport. With no plane, `list()` is empty and mutations fail clearly. |
| `runtime.agents` | `enabled`, `listDispatchable`, `describe`, `preflight` | Applies health, capability, effect, concurrency, credential-presence, configuration-revision, and host-policy checks before dispatch. |
| `runtime.agentTasks` | `start`, `list`, `get`, `events`, `wait`, `sendInput`, `cancel`, `reconcile` | Durable snapshots and append-only events for external tasks. The task keeps the immutable registration/executor binding captured at start. |

`agentTasks.events(taskId, cursor)` uses the last seen numeric event `seq` as its
cursor and returns events with a greater sequence. `wait()` resolves only at a
terminal task state and rejects on a positive `timeoutMs` expiry. `sendInput()`
is valid only while the task reports `input-required` or `auth-required`.
`reconcile()` asks the bound executor for authoritative remote state after an
owner restart or uncertain failure.

For external tasks, the built-in stores persist an internal full registration
snapshot before the public task ledger. It is keyed by Agent ID and revision,
is never returned by task or daemon APIs, and lets an admitted task keep using
its original executor route after registration update/removal and Runtime
restart. The internal form fixes `enabled: true` and omits management ownership
and health diagnostics. The task's public route summary is validated against that internal
snapshot before recovery. Terminal task state is durable before the last
unreferenced snapshot is removed; startup cleans crash-window orphans.

Custom `AgentExecutorPlaneStore` implementations should implement
`loadTaskRegistrationSnapshots()` and `saveTaskRegistrationSnapshots()` as a
pair and give one Runtime exclusive write ownership of that store. Omitting
both remains compatible, but restart recovery then succeeds only while the
exact current registration still exists. Store only non-secret executor config
or secret references in `executorConfig`/`credentialRef`; the broker resolves
the current referenced credential just in time, so removing a registration is
not equivalent to revoking that credential at its issuer.

The owner plane has a terminal close contract. Closing it rejects every pending
`wait()` (including a wait without `timeoutMs`), disposes its executor instances,
and makes subsequent registration, catalog, preflight, and task calls reject
with `Agent executor plane is closed.` One overall deadline covers admitted
work plus executor disposal: the default is 30 seconds, and direct
`createAgentExecutorPlane()` hosts may supply a positive finite
`closeTimeoutMs`. A timeout rejects visibly even though already-admitted cleanup
may finish in the background. Repeated `close()` calls are safe. SDK hosts
should stop accepting work before closing the owner and must not retain a plane
service as a reusable handle after Runtime shutdown.

Restricted Workflow scripts use the same route as direct SDK calls. Both
`wf.spawnAgent()` and `wf.runAgent()` validate and forward
`target: { agentId, expectedConfigurationRevision? }`; `phase` is forwarded as
well. A blank ID or revision is rejected at the script boundary instead of
silently falling back to the native child backend.

### Credential, artifact, and failure boundaries

- Put only a `credentialRef` in a registration. Resolve secret material through
  `AgentCredentialBroker.withCredential()`; do not place tokens in
  `executorConfig`, events, diagnostics, or task output.
- Remote artifacts are denied by default. Supply `artifactPolicy` to authorize
  each artifact before it materializes in the host boundary.
- External agents may declare workspace effect `none` or `proposal`; direct
  workspace mutation is intentionally not a valid external registration.
- Use `expectedConfigurationRevision` for dispatch. For registration mutations,
  compare both it and `expectedManagementOwner` so a same-revision ownership
  change cannot be overwritten from an earlier catalog read. Config managers
  should set a stable `managementOwner`; they may atomically claim an unowned
  legacy registration while disabling it, but must not mutate a registration
  owned by another manager.
- Treat `configurationRevision` as the stable identity of immutable execution
  content, not as a small counter. The same content may deterministically reuse
  the same revision across remove/re-add or Runtime restart, but different
  endpoint, protocol, executor/auth config, capabilities, effects, Skills,
  modalities, or resource limits must never reuse it. Built-in A2A
  configuration derives it from content.
- A remote start followed by uncertain local persistence is recorded as
  `unknown` with its executor reference preserved; reconcile it rather than
  blindly starting a duplicate. Stable idempotency keys protect retries.
- The durable plane records provider-reported usage when available. It never
  invents missing token or cost fields.

For a production adapter, implement `preflight?`, `start`, `events`, `get`,
`sendInput`, `cancel`, `reconcile`, and `dispose` on `AgentExecutor`. The factory
receives `withCredential()` and `authorizeArtifact()` callbacks so protocol code
cannot bypass the host's secret/artifact policies.

---

## 19. Session surface filtering and cursor pagination (FEATURE_261, v0.7.67)

The narrow session SDK and Runtime facade now share the same listing semantics:
`surface` is an exact filter applied before `limit`, and `cursor` is an opaque
continuation token carried by each returned summary.

### Narrow `/session` API

```ts
import { listSessions, type SessionSummary } from '@kodax-ai/kodax/session';

const all: SessionSummary[] = [];
let cursor: string | undefined;
do {
  const page = await listSessions({
    scope: 'user',
    surface: 'partner',
    limit: 50,
    ...(cursor ? { cursor } : {}),
  });
  all.push(...page);
  cursor = page.length === 50 ? page.at(-1)?.cursor : undefined;
} while (cursor);
```

### Embedded/daemon Runtime API

```ts
const first = await runtime.sessions.list({ surface: 'acp', limit: 25 });
const nextCursor = first.at(-1)?.cursor;
const second = nextCursor
  ? await runtime.sessions.list({ surface: 'acp', limit: 25, cursor: nextCursor })
  : [];
```

The filter also composes with `projectRoot`, `scope`, `includeArchived`, `before`,
and `tag`. Treat cursors as opaque: do not parse them, compare them to session
IDs, or manufacture them. An invalid cursor produces an empty page on the narrow
session API. A page shorter than the requested limit is terminal; a full page
may continue with its last item's cursor.

The interactive `kodax -r` picker is a consumer of these session semantics, not
a separate SDK API. Headless hosts should build their own UI on `listSessions()`
or `runtime.sessions.list()` and resume by the selected full session ID.

---

## 20. Cost-disciplined workflow routing and telemetry (FEATURE_259, v0.7.67)

FEATURE_259 adds a public cost/quality contract without making the authoring LLM
choose provider-specific model names. The SDK host maps semantic tiers to routes;
workflow/child briefs request intent.

### Configure tiers and bounded concurrency

```ts
import { join } from 'node:path';
import { runKodaX } from '@kodax-ai/kodax/coding';

const workflowRunsBaseDir = join(process.cwd(), '.kodax-host', 'workflow-runs');
const result = await runKodaX({
  provider: 'zai-coding',
  model: 'glm-5.2',
  agentMode: 'amaw',
  workflowRunsBaseDir,
  modelTiers: {
    fast: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    deep: { provider: 'zai-coding', model: 'glm-5.2' },
  },
  workflow: { maxConcurrency: 3 },
  events: {
    onWorkflowAgentDigest: ({ runId, event }) => {
      if (event.type === 'agent_completed' || event.type === 'agent_unverified'
        || event.type === 'agent_failed') {
        console.log(runId, event.data);
      }
    },
  },
}, 'Review this change using scoped evidence packets.');

console.log(result.lastText);
```

Tier rules are deliberately small:

- `fast`: mechanical read-only lookup. A write child is ineligible and safely
  inherits the parent route.
- `balanced`: ordinary implementation/investigation/review; uses the parent
  route, so there is no separate `balanced` mapping.
- `deep`: architecture, adversarial verification, severity calibration, and
  final synthesis.
- An unconfigured or selector-shadowed tier inherits the appropriate explicit,
  specialist, or parent route and records why; it does not silently claim the
  requested route was applied.

The workflow authoring contract also supports `scopeSummary`, `constraints`,
`evidenceRefs`, `verification`, `readOnly`, `outputSchema`, and `terseResult`.
Use those fields to transfer a compact immutable packet instead of asking every
child to rediscover the same repository context.

### Live route facts

Terminal `WorkflowEvent.data` may include `requestedTier`, `tierOutcome`,
`providerSource`, `modelSource`, initial/final provider and model,
`fallbackReason`, `iterations`, `durationMs`, `usage`, and `digestUsage`.
Treat absent fields as unknown. In particular, KodaX does not fabricate usage
for external executors that did not report it.

Direct child-dispatch consumers receive the typed `KodaXChildAgentResult.routeFacts`
surface, including resolved effort and input/cache-read/output/digest token
breakdown when known. Inline workflow consumers can subscribe to the raw
`onWorkflowAgentDigest` event as above; GUI progress remains available through
`onWorkflowProcessEvent` / `runtime.workflows`.

### Durable efficiency report

When `workflowRunsBaseDir` is supplied, every terminal workflow writes:

```text
<workflowRunsBaseDir>/<runId>/run.json
<workflowRunsBaseDir>/<runId>/events.jsonl
<workflowRunsBaseDir>/<runId>/artifacts/*.json
```

`run.json.efficiencyReport` includes:

- total/input/cache-read/output/digest tokens and wall-clock duration;
- total starts, child turns, starts by `role/tier`, and primary-review starts;
- duplicate primary packet reads plus verification/synthesis packet reads;
- review/fix/re-review waves and structured review quality-gate outcomes;
- `tokenCoverage.ok` plus missing local task IDs;
- `excludedExternalTaskIds` for external tasks whose executor reported no usage.

Do not interpret `totalModelTokens: 0` as free execution unless
`tokenCoverage.ok` is true and the relevant external task IDs are not excluded.
The report is an audit/optimization artifact; correctness still comes from the
workflow's structured findings, verification results, and quality gates.

---

## 21. Experimental governed memory — `/experimental-memory` (FEATURE_260 + FEATURE_275 + FEATURE_292, v0.7.68–v0.7.85)

KodaX has one durable memory plane: the F228 Memory Control Plane. FEATURE_260
adds a thin, opt-in agent/session API over that plane; it does not add a second
database, filesystem memory actions, a resident memory specialist, or online
self-modification.

Top-level `runKodaX()` coding runs wire this lifecycle automatically. They build
an exact-scoped memory pack at session start, keep passive recall off the
blocking hot path, expose `memory_recall` only when the memory session starts,
record bounded observations/outcomes, and close the session at the run boundary.
Use the direct SDK below when a custom host needs to own those boundaries.

### Minimal direct session

```ts
import { createMemoryControlPlane } from '@kodax-ai/kodax/agent';
import { createMemoryAgent } from '@kodax-ai/kodax/experimental-memory';

const identity = {
  tenantId: 'tenant:acme',
  workspaceId: 'workspace:desktop',
  userId: 'user:42',
  agentId: 'agent:reviewer',
  projectId: 'project:kodax',
  sessionId: 'session:20260712',
};

const controlPlane = createMemoryControlPlane({
  cwd: process.cwd(),
  identity,
  projectDocs: [],
  discoverSkills: false,
});
const memory = createMemoryAgent({ controlPlane });
// `memory` is a MemoryManagementAgent because this controller exposes the
// additive management capability. A legacy MemoryController returns MemoryAgent.
const remembered = await memory.remember({
  operation: 'remember',
  statement: 'Run npm run build before this project is released.',
  claimKind: 'procedure',
  claimKey: 'project.procedure.release-build',
  evidenceRef: 'host:user-request:42',
});
const accepted = await memory.list();
if (accepted[0] !== undefined) {
  await memory.forget(accepted[0].handle, accepted[0].storageFingerprint);
}
const session = await memory.startSession({
  identity,
  objective: 'Review the runtime shutdown change',
});

const immediate = session.recall({
  decisionRevision: 'decision:1',
  objective: 'Review the runtime shutdown change',
  decisionContext: 'Choosing the first verification step',
  decisionIntent: 'runtime shutdown regression',
  throughSequence: 0,
});
const deliberate = await session.query({
  decisionRevision: 'decision:2',
  need: 'What uncommon daemon cleanup failure happened before?',
  throughSequence: 0,
});

await session.complete({
  status: 'succeeded',
  summary: 'Shutdown state replacement verified',
  evidence: [],
});
await session.close();
```

`recall()` is synchronous and exact. `query()` is deliberate and read-only; one
distinct query is admitted per decision epoch, and the result is bounded to at
most three prompt-safe hints and 512 estimated tokens. `undefined` means there
is no governed reminder to inject.

`list()`, `remember()`, and `forget()` are the direct host equivalents of the
conversation-first Memory surface added by FEATURE_292. `remember()` reuses the
same preview/fingerprint/applicability/apply controller: a safe authoritative
host request returns `remembered`, `updated`, or `already_known`. Ambiguous or
broad input returns `needs_clarification`; claim-key conflicts return
`needs_review` plus a durable proposal ID; restricted or secret input is
`rejected` without persistence. The host must supply its own durable evidence
reference and must not present inferred model text as user authority. The base
`MemoryAgent` and `MemoryController` interfaces remain source-compatible. The
overload returns `MemoryManagementAgent` only when the supplied controller
implements `MemoryManagementController`; legacy custom controllers receive the
base `MemoryAgent` type and never get methods that can only fail at runtime.

### Sparse foreground intervention (FEATURE_275, v0.7.77)

`MemorySession.intervene()` replaces the old timing-ineffective semantic
prefetch. It is awaited only after `tool_failure`, `verification_failure`, or a
durably committed `context_compacted` event, then supplies at most three
prompt-safe, low-authority evidence items to the next Action-LLM request. The
candidate set is rebuilt from current objective/open todos, recent governed
observations, and a fresh F228 pack. Exact selection is deterministic; stale,
unknown, malformed, timed-out, cancelled, or failed semantic results are
discarded without blocking the coding run.

Top-level coding runs wire the deterministic path automatically and make zero
selector calls by default. An inline host that deliberately wants semantic
selection can provide the coding-owned forced-tool runner:

```ts
import {
  createCodingMemoryInterventionRunner,
  runKodaX,
} from '@kodax-ai/kodax/coding';
import { resolveProvider } from '@kodax-ai/kodax/llm';

const memoryRecallRunner = createCodingMemoryInterventionRunner({
  provider: resolveProvider('zhipu-coding'),
  model: 'glm-5.2',
});

await runKodaX(
  {
    provider: 'zhipu-coding',
    model: 'glm-5.2',
    memoryRecallRunner,
  },
  'Finish the repository migration and verify it.',
);
```

`memoryRecallRunner` is a process-local function binding. Worker and daemon DTO
options reject it instead of silently dropping it; configure the binding
inside the Runtime owner or keep this run inline. The selector can return only
exact IDs from the closed offered set and is capped at three calls per memory
Session.

### Evidence, tracing, and persistence boundaries

- Recalled content is low-authority evidence. Current repository/config/runtime
  facts must still come from current tools or host state.
- `observe()` accepts monotonic, evidence-linked observations and rejects secret
  material. `rewind()` removes observations after a sequence boundary.
- `complete()` can emit an Outcome Digest through `persistOutcomeDigest` and run
  bounded episode review through `reviewEpisode`; cancellation creates neither.
- `onTrace` receives policy-versioned `MemoryDecisionReceipt` metadata that links
  offered `candidateIds`, validated `selectedCandidateIds`, exposed
  `injectedEvidenceRefs`, triggers, and later outcome influence. Receipts are
  trace-only and contain no hidden reasoning; exposure is not proof of
  causality.
- Durable memory mutation remains owned by F228's
  proposal/preview/fingerprint/apply flow. Conversation is the normal product
  surface; `/memory` is the advanced CLI escape hatch. Direct file/shell writes
  to managed memory roots are denied, and `MEMORY.md` is a derived projection.
- Identity/applicability matching is exact and fail-closed. Hosts should supply
  stable tenant/workspace/user/agent/project/session identifiers and must not put
  credentials into those identifiers.

The subpath is experimental and ESM-only. Treat its exported types as opt-in
v0.7.x contracts; keep persistence and product policy behind your own adapter.

---

## 22. Bidirectional A2A 1.0 — `/a2a` (FEATURE_267, v0.7.69)

`@kodax-ai/kodax/a2a` is the protocol edge for the A2A 1.0 JSON-RPC/SSE
profile. It composes the protocol-neutral F258 executor plane with the Runtime
facade; `/agent` and `/coding` remain free of A2A wire types and dependencies.

### Call an A2A Agent through F258

Discovery is an explicit host action. The URL must match `allowedOrigins`, and
the default safe transport pins the validated DNS address for each connection
and independently revalidates redirects, rejects public plain HTTP, bounds
time/body/redirects, and strips authorization on a cross-origin redirect. A
custom `fetch` option is a trusted transport override: the embedder then owns
equivalent DNS-to-connection binding in that transport or proxy.

The selected interface must remain on the Card's trusted origin. KodaX parses
typed Card-level and Skill-level security declarations: requirement objects are
alternatives (OR), every scheme inside one object is conjunctive (AND), and an
empty requirement is anonymous. A configured credential is used only when one
complete requirement is satisfiable; protected Skills that the configured
profile cannot satisfy are not advertised to the Runtime catalog.

The built-in profiles are HTTP Bearer and OAuth 2.0 Client Credentials. The
OAuth profile pins the Card scheme, issuer, exact token endpoint, client ID,
secret reference, scopes, optional RFC 8707 resource, and client authentication
method. The external Authorization Server—not the Agent and not KodaX—issues
the access token. KodaX resolves the client secret only for refresh, keeps an
expiring token in process memory, coalesces refreshes, and retries one RPC once
with a fresh token after `401`. Card, Agent RPC, and token endpoints remain
separate safe-fetch trust boundaries, so a remote Agent cannot redirect a task
payload to the token origin. API key, Basic, interactive OAuth, OIDC, mTLS, and
multi-scheme AND requirements fail explicitly in the built-in client.

```ts
import {
  createA2AAgentExecutorFactory,
  discoverA2ARegistration,
} from '@kodax-ai/kodax/a2a';
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const client = {
  networkPolicy: {
    // Card/RPC and OAuth token endpoints are separate trust boundaries.
    allowedOrigins: ['https://reviewer.example', 'https://identity.example'],
    allowPrivateAddresses: false,
    requestTimeoutMs: 10_000,
    maxResponseBytes: 1_048_576,
    maxRedirects: 2,
  },
  pollIntervalMs: 500,
} as const;

const discovered = await discoverA2ARegistration({
  agentId: 'external:a2a-reviewer',
  agentCardUrl: 'https://reviewer.example/.well-known/agent-card.json',
  credentialRef: 'a2a/reviewer',
  effects: { remote: 'read' },
}, client);

const runtime = await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'inline',
  externalAgents: {
    factories: [createA2AAgentExecutorFactory(client)],
    credentialBroker: {
      async withCredential(ref, use) {
        const value = ref === 'a2a/reviewer'
          ? process.env.A2A_REVIEWER_TOKEN
          : ref === 'a2a/reviewer-client-secret'
            ? process.env.A2A_REVIEWER_CLIENT_SECRET
            : undefined;
        if (!value) throw new Error(`Missing credential for reference: ${ref}.`);
        return use(value);
      },
    },
    policy: ({ registration }) => ({ allowed: registration.effects.remote === 'read' }),
    defaultContext: { actorId: 'a2a-host' },
  },
});

await runtime.admin.agentRegistrations.upsert(discovered.registration);
const started = await runtime.agentTasks.start({
  agentId: discovered.registration.agentId,
  objective: 'Review this change and return cited findings.',
  context: { actorId: 'a2a-host' },
  readOnly: true,
  expectedConfigurationRevision: discovered.registration.configurationRevision,
});
const terminal = await runtime.agentTasks.wait(started.taskId, 60_000);
```

For OAuth, replace the legacy `credentialRef` input with the structured form;
the same F258 `credentialBroker` must resolve `clientSecretRef`. The shared
network policy must admit both origins, while each Card, RPC, and token request
is still narrowed to its own exact origin:

```ts
const discovered = await discoverA2ARegistration({
  agentId: 'external:a2a-reviewer',
  agentCardUrl: 'https://reviewer.example/.well-known/agent-card.json',
  authentication: {
    type: 'oauth2-client-credentials',
    scheme: 'enterprise-oauth',
    issuer: 'https://identity.example/',
    tokenUrl: 'https://identity.example/oauth/token',
    clientId: 'kodax-reviewer',
    clientSecretRef: 'a2a/reviewer-client-secret',
    scopes: ['a2a.invoke'],
    resource: 'https://reviewer.example/',
    clientAuthentication: 'client-secret-basic',
  },
  effects: { remote: 'read' },
}, client);
```

The executor supports durable task start/get, input continuation, cancel,
reconcile, SSE events, and polling fallback. An ambiguous start is not retried
automatically. A `credentialRef` is resolved just in time by the F258 broker;
the registration, task store, and diagnostics never contain the credential.
Authenticated SSE uses that same broker. JSON-RPC ID/version and task/context
correlation are validated before an event is accepted; if a stream ends
normally before a terminal snapshot, the executor resumes bounded polling.
Streamed `artifactUpdate` chunks are accumulated by artifact ID according to
`append`, and direct Message file Parts are preserved as authorized artifact
references.

### Built-in configured path (no host code)

The CLI product path stores one user document at
`~/.kodax/integrations/a2a.json` and uses the same F258 plane:

```bash
kodax a2a add reviewer https://reviewer.example/.well-known/agent-card.json \
  --credential-env A2A_REVIEWER_TOKEN --effect read
kodax a2a test reviewer
kodax a2a call reviewer "Review this document"
```

Private-address access and plaintext HTTP beyond exact loopback are independent
persisted permissions. Both default to false; private HTTP requires both:

```bash
kodax a2a add intranet http://10.20.30.40/.well-known/agent-card.json \
  --allow-private --allow-insecure-http --effect read
```

Private HTTPS requires only `--allow-private`. Public HTTP requires only
`--allow-insecure-http`, but TLS remains the recommended deployment. The flags
are persisted under the Agent's `network` block and are honored by Card
discovery, interface execution, Runtime registration, and task execution.
Private-address permission also applies to HTTPS OAuth endpoints, but OAuth
token endpoints deliberately retain the stricter HTTPS-or-exact-loopback
protocol rule; Agent-transport plaintext authorization does not weaken OAuth.
`a2a test` and `a2a call` also accept the flags as one-shot overrides.

The no-code OAuth path stores only the environment-variable name for the client
secret. It can be staged disabled and hot-activated later:

```bash
export A2A_REVIEWER_CLIENT_SECRET='provisioned-out-of-band'
# PowerShell: $env:A2A_REVIEWER_CLIENT_SECRET='provisioned-out-of-band'
# PowerShell: use one line or replace each trailing \ with a backtick.
kodax a2a add reviewer https://reviewer.example/.well-known/agent-card.json \
  --disabled --effect read --oauth-scheme enterprise-oauth \
  --oauth-issuer https://identity.example/ \
  --oauth-token-url https://identity.example/oauth/token \
  --oauth-client-id kodax-reviewer \
  --oauth-client-secret-env A2A_REVIEWER_CLIENT_SECRET \
  --oauth-scope a2a.invoke --oauth-resource https://reviewer.example/
kodax a2a enable reviewer
kodax a2a disable reviewer
```

Embedded CLI Runtimes and the user-owned daemon automatically reconcile these
entries as `external:<name>`. Discovery/update failure retains that entry's
last-known-good registration; another entry can still update. The environment
broker resolves `credentialEnv` only at call time. Automatic Runtime
registration accepts public HTTPS and exact loopback targets; private-address
and non-loopback plaintext access require their independent persisted operator
permissions.

`enabled` is desired state in `a2a.json`, not a fabricated cross-process live
flag. `a2a list` reports configured entries and that desired state. The owning
Runtime's `admin.agentRegistrations.list()` is authoritative for applied
registrations. Automatic reconciliation handles disables/removals first,
skips unchanged peers, performs no Card or token request for disabled entries,
and rediscovers before re-enable. Once the owning Runtime observes and applies
the revision, disable blocks all new starts, including an explicit
`external:<name>` target, but does not cancel or break an already admitted task.
The CLI mutation returning is not cross-process acknowledgement. A failed
activation remains retryable through the owning
`ConfiguredA2ARuntimeHandle.reload()` even when the disk revision is unchanged;
the passive `kodax integrations reload` command validates only its own process.

`kodax a2a test` performs Card discovery and security planning only. It never
requests an OAuth access token; token acquisition starts at `a2a call` or the
first Runtime dispatch.

Inbound publication is also no-code:

```bash
export KODAX_A2A_TOKEN='replace-with-a-long-random-token'
# PowerShell: $env:KODAX_A2A_TOKEN='replace-with-a-long-random-token'
kodax a2a expose                    # Runtime default Agent
kodax a2a expose document-agent     # ~/.kodax/agents/document-agent.md
kodax a2a serve --port 8765
```

The fixed token above is the compatibility profile. For dynamic production
tokens, configure KodaX as an OAuth Resource Server and point it at an external
issuer:

```bash
kodax a2a expose document-agent --auth oauth2-jwt \
  --oauth-scheme enterprise-oauth \
  --oauth-issuer https://identity.example/ \
  --oauth-audience https://kodax.example/a2a \
  --oauth-jwks-url https://identity.example/.well-known/jwks.json \
  --oauth-token-url https://identity.example/oauth/token \
  --oauth-metadata-url https://identity.example/.well-known/oauth-authorization-server \
  --required-scope a2a.invoke
kodax a2a serve --port 8765
```

The Authorization Server authenticates clients, provisions client IDs/secrets,
issues/rotates/revokes tokens and, for JWT access tokens, signs them and
publishes metadata/JWKS. The calling A2A
client obtains a token out of band or with Client Credentials and sends it in
the Bearer header. KodaX validates JWT type, asymmetric signature, issuer,
audience, lifetime, subject, and required scopes before task lookup, then maps
`sub` to the A2A principal. Missing/invalid credentials return `401`; a valid
token without the required scope returns `403 insufficient_scope`. KodaX does
not hold the issuer signing key or expose token, refresh, client-registration,
login, or consent endpoints. Opaque-token introspection and mTLS deployments
must use a host authentication adapter or reverse proxy. Offline JWT/JWKS
validation also cannot observe immediate per-token revocation: use short access
token lifetimes, signing-key rotation, or an introspecting proxy/adapter when
that property is required.

#### Upgrade retained pre-realm tasks

Realm-aware task ownership intentionally has no normal-request legacy fallback:
an authority switch must never adopt tasks merely because it reuses a subject.
If a v0.7.70 task store must remain addressable after upgrading, stop the A2A
server and first inspect an exact-owner migration plan:

```bash
kodax a2a migrate-tasks
kodax a2a migrate-tasks --apply --confirm-server-stopped

# OAuth identity is token-specific, so provide the known historical subject.
kodax a2a migrate-tasks --subject trusted-orchestrator
```

The configured Bearer profile supplies its fixed `principalId`; OAuth requires
`--subject`. Dry-run does not rewrite `tasks.json`. Apply rekeys only exact
matches, preserves unmatched records, and refuses a live task-store owner.
Custom SDK hosts can plan multiple known owners without exposing raw tokens:

```ts
import { migrateA2ALegacyTaskOwners } from '@kodax-ai/kodax/a2a';

const mappings = [{
  securityRealm: 'oauth2-jwt:https://identity.example/',
  subject: 'trusted-orchestrator',
}] as const;
const plan = migrateA2ALegacyTaskOwners({
  dataDir: '/var/lib/kodax/a2a', mappings, apply: false,
});

// After the host/operator verifies the plan:
if (plan.matchedLegacyTaskCount > 0) {
  migrateA2ALegacyTaskOwners({
    dataDir: '/var/lib/kodax/a2a', mappings, apply: true,
  });
}
```

The SDK also accepts `tenant` when a custom authentication adapter historically
returned one. Two mappings that claim the same legacy owner for different
realms are ambiguous and rejected; split or guessed ownership is never applied.

`a2a serve` resolves its Runtime provider in this order: explicit CLI option,
environment, core configuration, then the built-in default. Provider-compatible
model selection follows the normal hosted Runtime rule. A selected Markdown
Agent may declare its own validated `provider`; remote A2A input cannot choose
or override provider, model, reasoning, profile, workspace, or tools.

`expose` validates a named user Markdown Agent before writing its reference.
`serve` loads configured MCP and Extensions before it resolves the execution
binding or opens a socket. Native workspace read tools are admitted by
workspace access; writes, narrow Extension Tools, MCP capabilities, subagents,
and isolated Skill scripts require their corresponding exact `toolPolicy`
authority. Internal Skills come from `~/.kodax/skills`, `~/.agents/skills`,
plugins, and built-ins; public Agent Card skills are a separate explicit
projection and never reveal the private Skill inventory.

The running server pins Agent, Skill, workspace, tool registration, process and
store revisions. Card/auth/limits can hot reload; execution-authority changes
require an explicit restart. Managed contexts live below
  `~/kodax_a2a_server_workspace/<runtime-profile>/contexts/<context-key>/`. Exact Skill scripts require
`process: isolated`, an admitted `scripts/...` path, and a passing
`kodax sandbox doctor`; KodaX never falls back to an unsandboxed shell.

Every concrete file reached by `read`, `grep`, or `glob` is checked against the
bound workspace. Child runs inherit ceilings for native reads, tools, Skills,
and Skill scripts; they cannot expand the parent's admitted authority.

### Publish one KodaX Agent

Publication is host-owned and opt-in. The public card describes only the
configured Agent, media types, and skills. Authentication runs before task
lookup; authorization runs per operation; task visibility is principal-scoped.

```ts
import {
  createBearerEnvA2AAuthentication,
  createKodaXA2AServer,
} from '@kodax-ai/kodax/a2a';
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const runtime = await createKodaXRuntime({ mode: 'embedded', isolation: 'inline' });
const server = createKodaXA2AServer({
  runtime,
  dataDir: '/var/lib/kodax/a2a',
  agent: {
    name: 'KodaX Reviewer',
    description: 'Reviews bounded code changes.',
    version: '1.0.0',
    publicBaseUrl: 'https://kodax.example',
    skills: [{ id: 'review', name: 'Review', description: 'Review code.', tags: ['code'] }],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
  },
  authentication: createBearerEnvA2AAuthentication({
    type: 'bearer-env',
    tokenEnv: 'KODAX_A2A_TOKEN',
    principalId: 'trusted-orchestrator',
  }),
  async authorize({ principal }) { return principal.scopes.includes('a2a:invoke'); },
  limits: {
    maxRequestBytes: 1_048_576,
    maxPartBytes: 524_288,
    maxConcurrentTasks: 8,
    maxTaskWaitMs: 30_000,
    maxActiveTasksPerPrincipal: 8,
    maxRetainedTasksPerPrincipal: 64,
    maxEventsPerTask: 1_000,
    maxEventBytesPerTask: 16_777_216,
    maxWorkspaceBytesPerContext: 1_073_741_824,
  },
});

// Development only: the built-in listener refuses non-loopback hosts.
const localBaseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
```

The listener also refuses an explicit port blocked by WHATWG Fetch clients.
With `port: 0`, it retries ephemeral allocation rather than returning a URL
that Fetch would reject before connecting.

Production hosts route `GET /.well-known/agent-card.json` and canonical
JSON-RPC `POST /a2a` to `server.handle(request)` behind their own TLS
terminator. `POST /` remains an accepted compatibility alias. `listen()` waits for durable recovery before
it resolves. A host that wires `handle()` directly may explicitly await
`server.whenReady()` before it starts accepting traffic; `handle()` also waits
for the same recovery promise. The durable edge store supports get/list,
continuation, cancellation, ordered SSE subscription, and surviving Runtime-run
reattachment after an edge restart. Push notifications, A2A 0.3, gRPC, and
HTTP+JSON are not advertised; unsupported push methods return the standard
`PushNotificationNotSupportedError`.

Non-streaming `SendMessage` waits at most `maxTaskWaitMs` (30 seconds by
default). When that bound is reached the response contains the current working
task; it does not cancel the Runtime run, and clients can continue with
`GetTask` or `SubscribeToTask`.

When a task enters `INPUT_REQUIRED`, the next accepted input answers the pending
interaction on the original Runtime run; it does not start a replacement run.
History length and list filters are validated and bounded. Task listing uses a
stable opaque cursor, while per-principal retention prunes only the oldest
terminal records. Terminal subscriptions and failed-start resources are closed
by their owning lifecycle.

Remote messages are ordinary user inputs. They cannot select provider, model,
profile, tools, working directory, permission mode, or Runtime configuration.
URL parts are rejected; inline raw/data parts are bounded and materialized under
the server-owned data directory. Responses expose final approved output only,
not system prompts, reasoning deltas, tool payloads, credentials, or local paths.

Generated files are published only through the trusted output broker: a normal
tool or Extension stages a file in the context's `.kodax-a2a-staging` area, or
a successfully admitted `run_skill_script` promotes one of its declared
outputs. The server rechecks that the result is a regular non-symlink file in
the real bound workspace and applies part-size/output-mode limits before
inlining it. A declaration from a failed Skill run, an ordinary `write`/`edit`
elsewhere in the workspace, and a local path in model text never become A2A
artifacts implicitly.

The normative baseline is A2A repository commit
`2183794bfb9b67af4aee1be0a0ef726050642873`, protocol `1.0`, with
`specification/a2a.proto` SHA-256
`e195bf96ab630c69797851970203e1b2b6b19528f2e9803b7d904b91a5104016`.

---

## 23. Shared Coder daemon for Space and IDE hosts (FEATURE_269, v0.7.69)

FEATURE_269 makes one local daemon the source of truth for a Coder profile.
CLI, Space, IDE, and SDK clients can observe and control the same sessions and
runs. The transport remains local to the current OS user; it is not a remote
collaboration protocol. Closing a client detaches that client and does not stop
the daemon or another client's run.

Partner is deliberately outside this migration. Keep Partner on its existing
inline callbacks and give it a distinct product data root and sessions root.
Do not point a Partner inline Runtime at the Coder daemon profile or the Coder
data root.

### Connect and fail closed on required capabilities

Space should own the daemon SDK client in Electron Main. Persist a random,
stable `instanceId` and a separate 32+ character `instanceSecret` per Space
installation. Store the secret in the OS keychain; never accept either value
from renderer or model output. `connectKodaXRuntime()` is attach-only unless `autoStart: true`.
An explicit inline rollback policy blocks auto-start until the owner policy is
explicitly changed back to daemon.

For Electron, `homeDir` is still the CLI-style base directory, not
`process.env.KODAX_HOME`. Packaged/asar applications may use `autoStart: true`
directly; the SDK launches only the daemon child in Electron's Node execution
mode and does not mutate the application's environment or start a second GUI
instance. `ELECTRON_RUN_AS_NODE` exists only at the child exec boundary and is
removed before daemon application code loads, so Bash, MCP, LSP, sandboxed
commands, and ordinary external processes do not inherit Electron Node mode.

Packaged auto-start requires Electron's `RunAsNode` fuse, which Electron enables
by default. If an embedder deliberately disables that fuse, the packaged
executable cannot serve as a detached Node host: start the daemon with an
ordinary Node/CLI process and use attach-only mode instead. A packaged
`autoStart: true` timeout includes this fuse requirement in its diagnostic; the
SDK does not relaunch the GUI or silently fall back to an inline Runtime.

```ts
import { connectKodaXRuntime } from '@kodax-ai/kodax/runtime';

const runtime = await connectKodaXRuntime({
  profile: 'coder',
  autoStart: true,
  // Opt in only when this product remains the visible owner of the daemon.
  // If the product crashes, the daemon stops after its final client is gone
  // and governed work becomes idle.
  daemonOrphanExitMs: 30_000,
  homeDir: coderRuntimeBaseDir, // owns <coderRuntimeBaseDir>/.kodax
  clientInfo: {
    name: 'kodax-space',
    version: '0.1.32',
    instanceId: spaceInstallationId,
    instanceSecret: await spaceKeychain.readRuntimeClientSecret(),
  },
  capabilities: {
    richEvents: true,
    permissionPrompts: true,
    operationDeduplication: true,
  },
  requirements: {
    operationDeduplication: 1,
    sessionObservation: 1,
    afterTurnInput: 1,
    interruptInput: 1,
    askUserTransport: 1,
    permissionCas: 1,
    providerCredentialBroker: 1,
    runBoundHostTools: 1,
    coderOwnerFencing: 1,
    crashOutcomeModel: 2,
    sandboxRuntime: 5,
    coderFeatureMatrix: 1,
    sessionAdmission: 1,
    completeObservationSnapshot: 1,
    connectionLifecycle: 1,
    typedRuntimeEvents: 1,
    daemonSafeRunInput: 1,
    sharedSessionSettings: 1,
    durableRecoveryQueries: 1,
    daemonManagement: 1,
    runtimeEventCoalescing: 1,
    liveOutputSegments: 1,
    runtimeAutoModeGuardrail: 4,
  },
});
```

Requirements are server facts, not authorization requests. Check
`runtime.grantedScopes` before enabling controls. Missing capabilities or
scopes must disable the affected UI; Space must not silently start inline
Coder. Products that depend on same-Run delivery should require
`{ interruptInput: 1 }`. Individual active Runs without a safe Actor boundary
(for example, SA execution) still return `unsupported_capability`; do not
silently substitute `delivery:'after_turn'` unless that is the user's intent.

The SDK requires `runtimeAutoModeGuardrail:4` automatically for ordinary
`autoStart: true`. Supplying `daemonOrphanExitMs` additionally requires the
dedicated `daemonOrphanExit:1` capability and passes the option only when
spawning a new daemon. It does not silently reinterpret an already-running
persistent daemon: the SDK uses the normal fenced capability-upgrade path and
replaces it only when preflight proves that doing so is safe. After the daemon
has observed a logical client, final-client detach arms the requested grace
period; a new client cancels it, and active/queued runs, Workflow, Agent turns,
pending permission/user input, or other governed work defer exit until
preflight is idle. Omit the option for CLI-style daemons that are intentionally
persistent.

An embedder can inspect `KODAX_RUNTIME_SDK_CAPABILITIES.daemonOrphanExit`
before calling an auto-start API. This prevents an older SDK from spawning a
persistent daemon and only then discovering that it cannot honor the requested
lifecycle policy. The connected daemon capability remains the authoritative
check that the current host actually enabled the policy.

`KODAX_RUNTIME_SDK_CAPABILITIES.runtimeEventCoalescing` performs the same
local-SDK preflight for bounded source-level text/reasoning coalescing. Requiring
`runtimeEventCoalescing:1` lets auto-start replace only an idle legacy daemon;
a busy or otherwise unsafe owner produces the normal capability-upgrade error.
The capability changes event allocation/persistence pressure, not reconstructed
stream content: flush boundaries remain explicit and an accumulated merge
never exceeds 8 KiB.

`liveOutputSegments:1` makes provider replacement semantics an SDK fact rather
than a host heuristic. `output.segment.started` identifies the logical reply
with `responseId`, the physical call with `providerRequestId`, and whether the
segment appends or replaces the current call. Text and reasoning deltas carry
the physical request id. Raw replay retains every attempt; use
`snapshot.live.outputSegmentsByRun` for the effective live response after an
observation join or reconnect. Do not append a provider's cumulative response
again during recovery, and do not infer replacement from attempt numbers or
text equality.

`KODAX_RUNTIME_SDK_CAPABILITIES.conversationHistory` is now `2`.
Require it before auto-start so an idle daemon that still exposes the legacy
ordinary-history projection is replaced; a busy or otherwise unsafe owner
produces the normal capability-upgrade error.

`KODAX_RUNTIME_SDK_CAPABILITIES.sandboxRuntime` is now `5` and
`crashOutcomeModel` is `2`. Windows auto-start requires `sandboxRuntime:5` so
an idle v4-or-older daemon is replaced; a busy or multi-client daemon fails
closed with restart guidance. Require `crashOutcomeModel:2` when the host
depends on managed Session persistence preceding completion and on the
executor Promise — not managed `onComplete` — as terminal authority. Do not
delete `C:\ProgramData\KodaX\sandbox-runtime\runtime\model-filesystem-effects.lock`
or its `.queue` tickets by hand. `KodaXFileLockTimeoutError` means the
filesystem-effect coordinator was unavailable; it does not prove a learning job
holds the lock. `reclaimStaleKodaXFileLock` remains an explicit stale-lock
helper, not a general lock-deletion primitive.

### v0.7.91 crash-resumable Runtime exit settlement

Hosts that own a complete Runtime exit can use the SDK transaction instead of
duplicating stop, process-tree, Job, ACL, and owner-policy recovery logic:

```ts
import { settleKodaXRuntimeExit } from '@kodax-ai/kodax/runtime';

const outcome = await settleKodaXRuntimeExit({
  configHome: coderConfigHome,
  profile: 'coder',
  runtime, // optional; omit only when resuming a prepared ticket after relaunch
});

if (outcome.status === 'blocked') {
  // Keep the host open, relaunch the product, restart the OS, or request
  // explicit manual recovery according to outcome.nextAction.
  reportRuntimeExitBlock(outcome.reason, outcome.nextAction);
} else {
  reportRuntimeExit(outcome.status, outcome.repairs);
}
```

`runtimeExitSettlement:2` is a local SDK capability and does not add a daemon
handshake requirement. The SDK writes an exact owner/process-start and platform
boot identity before cooperative stop, then returns `clean` only after the
durable shutdown outcome and required exits are verified. `recovered` may repair
only identity-scoped Windows process/Job/ACL residue, or exact POSIX owner/state
residue after a boot-identity change. Same-boot POSIX uncertainty, active work,
PID reuse, foreign markers, corrupt tickets, and replacement owners return
`blocked`; the SDK never exposes a bare-PID kill, raw marker deletion, or forced
ACL-recovery primitive. Version 2 removes the final same-boot Windows manual
cleanup hole: stale, uncontained recovery tickets are retried through the
sandbox account's own runner and clear only after an exact SID-idle proof. The
transaction has a fixed bounded deadline and does not accept caller-supplied
short timeouts.

After a verified Windows boot change, settlement may also recover shared ACL
state when a machine-lock recheck proves that every primary and legacy marker
has a canonical non-current boot identity. The recovered scope, repair fact,
and recovery boot identity are durably recorded before a second lock-scoped
recheck removes markers. If Windows restarts again before clear, native
recovery repeats against the new boot before the recorded identity advances.
Same-boot or unverifiable markers remain `blocked`. A durable Windows
`failed` shutdown outcome ends the 170-second orderly wait and enters exact
recovery immediately. Anthropic/OpenAI `APIUserAbortError` objects are
classified by isolated SDK class identity when the request signal is already
aborted, so managed Stop stays interrupted before credential redaction.

When the host is about to close, pass the connected Runtime so the SDK can
record the exact owner and management revision. After a crash, call the same
function with only `configHome` and `profile` to resume a still-exact prepared
ticket. Do not delete `exit-settlement.json`, clear ACL markers, or start a
replacement owner while a settlement is `prepared` or `stop_accepted`.

### v0.7.92 filesystem-effect coordinator and managed terminal authority

A Worker operation can disappear while the shared Coder daemon PID remains
alive. The coordinator queue now identifies each attempt by an operation token
that is also the exact lock token. Waiters heartbeat their ticket. A stale
same-process ticket is reclaimed only when that token no longer owns
`model-filesystem-effects.lock`. Effect release writes a token-scoped
`.released` marker first so a later transaction can drop only that settled
owner.

On Windows the coordinator state is
`C:\ProgramData\KodaX\sandbox-runtime\runtime\`. Deleting the lock file does
not remove leftover `.queue` tickets or `model-filesystem-effects.json`
owners. Timeouts surface as `KodaXFileLockTimeoutError`; the historical
`learning store lock timed out` text was a reused generic-lock message, not
proof that a learning job held the lock.

Managed Runs persist the canonical Session before publishing completion.
Repo-intelligence and task-file projections are asynchronous and must not keep
the Run in `finalizing`. For `mode: 'managed_task'`, Runtime uses the executor
Promise as terminal authority; `events.onComplete` alone does not finish the
Run. Require `crashOutcomeModel:2` when the host depends on that ordering.

Resume reconstruction is canonical-first. Hosts that call
`restoreHistoryItemsFromSession({ messages, uiHistory })` receive the bounded
message-derived transcript plus optional display overlays. Do not treat
`session.uiHistory` as the set of ordinary conversations that exist.
Presentation-only synthetic completion events remain host-owned when that
cache is non-empty.

Observation boundaries such as `events.subscribe()`, `events.replay()`, and
Session status projection flush pending events before answering, so they can
surface a durable-persistence failure instead of returning a stale waterline.
A determinate append failure retains one bounded batch for a later explicit
retry. If both append and rollback fail, commit state is unknowable: the error
is intentionally sticky and the Runtime must be closed/recreated rather than
guessing or replaying the batch. Latest-only progress coalescing preserves its
required first sample plus the most recent sample; discarded intermediate
snapshots are not lifecycle events, and surviving samples retain their latest
emission order.

When a healthy profile daemon is too old, the SDK first reads capabilities from
the authenticated health probe, before attaching the embedder's stable client
identity or restoring its reverse bridge. The incompatible daemon is contacted
with an ephemeral upgrade identity. The SDK requires `daemonManagement:1`,
takes a revision/owner-policy fenced preflight, and replaces it only when no
active or queued run, Workflow, Agent turn, pending permission/user input, or
other logical client exists. Replacement reuses the durable Runtime exit
settlement: it records a crash-resumable ticket, verifies the captured
owner/process-start identity, waits for the complete process exit and shutdown
outcome, repairs only identity-scoped remnants, restores daemon owner policy,
and then starts the packaged Runtime.
A busy or still-older daemon is never stopped: the connection rejects with
`RuntimeDaemonCapabilityUpgradeError`, whose `recoverable` and
`restartRequired` fields are `true` and whose optional `preflight` explains the
blockers. Attach-only connections never mutate daemon ownership and must request
the exact capabilities they depend on. Capability requirements are minimum
versions: v4 satisfies v1-v3, v3 satisfies v1/v2, v2 satisfies v1, and an older
daemon never satisfies a newer requirement.

The `coderFeatureMatrix` capability reports daemon availability for managed
runs, transcript/session operations, Todo projection, managed tasks, Workflow,
MCP, Reference External Agent, Memory, and Runtime artifacts. Reference
External Agent is `false` when the daemon owner did not install its executor
plane.

The packaged daemon authenticates one local OS-user/profile trust domain with
a random token stored beside daemon state and a user-only local endpoint. It
does not issue a different daemon token to each application in v0.7.69. The
returned scope set is chosen by the host (the packaged host grants the public
local-user set). `clientInfo.instanceId` is stable attribution for origin and
operation deduplication. `instanceSecret` proves that a new authenticated
connection is the same stable client when it resumes that client's credential
or Host Tool leases; only its hash participates in daemon-owned bridge state.
Keep all three values in Electron Main. Mutually distrusting processes running
as the same OS account remain outside this release's threat model.

### Query authoritative Session and Run lifecycle

Use `runtime.runs.get(runId)` for the exact Run and
`runtime.sessions.status(sessionId)` for the one current Session projection.
Do not infer completion from assistant text:

```ts
const run = await runtime.runs.get(runId);
const sessionStatus = await runtime.sessions.status(sessionId);

switch (run.phase) {
  case 'running':
  case 'waiting_agent':
  case 'recovering':
  case 'waiting_permission':
  case 'waiting_user_input':
    renderActive(run.phase);
    break;
  case 'unknown':
    renderUnconfirmedExecution(run.error);
    break;
  case 'completed':
  case 'cancelled':
  case 'interrupted':
  case 'failed':
    renderTerminal(run.terminal);
    break;
}
```

`phase` answers whether the Run is queued, active, terminal, or unconfirmed.
Use `stage` for the finer executor location: `executing`,
`waiting_agent`, `recovering`, managed phases such as `worker` or `verifying`,
and `finalizing`. In particular, managed status `completed` first appears as
`phase:'running', stage:'finalizing'`; it is not terminal until the outer
executor settles. `stageChangedAt` timestamps that transition, and
`activeSubtaskCount` is present only when the managed executor reported an
authoritative count. If Runtime shutdown begins after an executor terminal
callback was latched, that terminal fact is persisted synchronously before the
owner-liveness endpoint is released. Result-handle resolution and queue drain
still wait for the executor result or the deferred lost-result fallback.
Destructive Session mutations remain fenced across the same settlement window.

Run ownership is private persistence metadata, not a public ordering field. A
second Runtime may observe a live owner's status but cannot abort or mutate
that Run. A definitely dead owner is recovered to a durable `interrupted`
result. If liveness cannot be proven either way, the observer returns
`phase: 'unknown'`; it does not report a successful stop and does not overwrite
the original non-terminal record. The same rule applies to ownerless legacy
non-terminal records. A durable terminal event is reconciled before this
fallback; non-terminal evidence such as an input-delivery event may refine the
read projection but does not prove that execution stopped. Persisted terminal
states are monotonic.

Current source treats Run terminal persistence as its own fail-closed
convergence boundary. If the durable terminal status succeeds but event
publication fails, the durable status remains authoritative. If status commit
succeeds but status-lock cleanup reports failure, Runtime rereads the record;
only an exact deep match with its local terminal proposal continues to one
terminal event publication. A different authoritative record wins without a
duplicate event. If neither
terminal record can be persisted, `handle.result`, `runs.get()`, and
`runs.await()` converge to `phase:'unknown'` with lifecycle code
`run_settlement_not_persisted`; the Session execution fence stays closed.
Credential-scoped failures may include a bounded `failureKind` (`auth`,
`rate_limit`, `network`, `provider_aborted`, `invalid_response`,
`runtime_cleanup`, or `provider`) without exposing raw provider text.
Sandbox and managed-child termination failures are observed and retained as
diagnostics rather than escaping as process-global unhandled rejections.
If terminal status persistence fails but the Session event journal remains
healthy, Runtime durably publishes `run.updated` with `phase:'unknown'`. If the
journal is fenced too, active `sessions.observe()` handles resolve
`invalidated` with `reason:'delivery_failed'`; consumers must discard their
local projection and acquire a fresh observation instead of retaining a stale
running/terminal state.

`runtime.status.preflight()` treats `queued`, all active/waiting/recovery
phases, and `unknown` as stop blockers. A host must never infer completion from
reply text or convert `unknown` into success.

`runtime.runs.abort(runId)` requests Stop; it does not manufacture an
acknowledgement. Queued work can become `cancelled` immediately. For an active
executor, inspect `run.stop`: while termination is unconfirmed, the Run reports
`phase/stage:'unknown'` and `stop.state/outcome:'unknown'`. A later executor
result confirms the actual outcome, including `completed` when the executor
ignored Stop and completed normally. Terminal callback order is latched before
deferred result settlement: Stop cannot rewrite an earlier completion as
interrupted, and late finalizer/recovery progress cannot revive an unconfirmed
stopped Run. If the Runtime owner then dies, recovery resolves the pending Stop
as `confirmed/interrupted`.

Since v0.7.82, an observed Stop cooperatively gates later Runtime-controlled
provider retries and continuations, Runner guardrail/tool dispatch, and
Run-admitted Actor work. It does not hard-kill turns admitted before Stop or
rewrite a genuine completion or an independent failure. A trusted Stop/Abort
cause is classified before credential redaction, so `runs.get()` and `await()`
report the same factual terminal outcome.

For support bundles, use the pure read-only compositor:

```ts
import { captureRuntimeSessionDiagnostics } from '@kodax-ai/kodax/runtime';

const diagnostic = await captureRuntimeSessionDiagnostics(runtime, {
  sessionId,
  runId,
  timeoutMs: 10_000,
  signal: abortController.signal,
});
```

The schema-versioned result includes SDK/Runtime/daemon versions, Runtime and
Session identity, observation cursor/transcript revision, Run/Turn identity,
phase/stage and stage time, terminal fact/time, Run-owned active child count,
Stop and chat-interrupt records, and structured errors. If the selected Run
did not persist an authoritative child count, the result returns
`activeSubtaskCount:null` and `activeSubtaskCountSource:'unknown'`; it never
attributes a later Session-wide child sample to that Run. If a historical
Session has no Run control record, it returns `controlRecord:'unknown'` with
`run_control_unknown`; it never infers completion from transcript text.
`owner_liveness_unconfirmed`, `owner_recovery_required`,
`stop_outcome_unconfirmed`, `run_failed`, `run_status_unknown`, and
`terminal_time_unknown` remain distinct. These are independent facts rather
than an enum: for example, an unavailable owner and an unconfirmed Stop appear
together in `errors`. `sdkVersion` is the calling SDK package version;
`runtimeVersion` and `daemonVersion` identify the connected daemon in daemon
mode, so a support bundle preserves version skew. One timeout/cancellation
budget covers the transcript, settings, pending interactions, and owner
liveness inspection. The helper uses the dedicated
`sessions.diagnostics()` read boundary: it never runs status preflight,
resumes, repairs, migrates, takes ownership, or evicts a retained transcript
page boundary. Embedded and daemon facades use the same schema-validated
`session.diagnostics` contract.

### Join atomically and resync after disconnect

`sessions.observe()` installs the live subscription before taking the
snapshot. Its snapshot contains one authoritative `runtimeId`, cursor,
`transcriptRevision`, bounded transcript slice, versioned settings, run/queue state,
queued continuation IDs/order/origin/safe previews, pending permission and
AskUser requests, and live assistant/thinking/tool/Todo/managed-task
projection. Run requirements include the current credential/Host Tool
availability. Listener events are strictly after the returned cursor.

```ts
let observedRuntimeId: string | undefined;
let lastCursor = 0;

async function openCoderSession(sessionId: string) {
  const observation = await runtime.sessions.observe(sessionId, (event) => {
    if (event.seq <= lastCursor) return;
    applyRuntimeEvent(event);
    lastCursor = event.seq;
  });

  const { snapshot } = observation;
  const runtimeChanged = observedRuntimeId !== undefined
    && observedRuntimeId !== snapshot.runtimeId;
  observedRuntimeId = snapshot.runtimeId;
  lastCursor = snapshot.cursor;
  replaceSessionProjection(snapshot, { runtimeChanged });
  void observation.invalidated.then((reason) => {
    discardSessionProjection(reason);
    scheduleFreshObservation(sessionId);
  });
  return observation;
}
```

Subscribe to `runtime.connection` to freeze mutation UI immediately rather
than waiting for a status poll:

```ts
runtime.connection?.subscribe((state) => {
  setCoderConnectionState(state.state, state.reason);
  if (state.state === 'disconnected' && state.reconnectable) {
    scheduleReconnect();
  }
});
```

The SDK reports the current `connectionId`, `runtimeEpoch`, optional
`journalEpoch`, disconnect reason, and whether a new connection may be
attempted. It does not transparently replay requests or subscriptions. Space
creates a replacement Runtime client, checks its new epochs, resumes eligible
leases, and observes the session again.

`RuntimeDaemonDisconnectCode` reports only transport-observable facts:
`protocol_closed`, `transport_error`, `invalid_frame`, or `client_closed`.
The lifecycle state and pending RPC rejection carry the same `connectionId`
and `reconnectable` value. `invalid_frame` includes the 8 MiB protocol boundary;
outbound oversize is rejected before socket write. A transport close alone is
not evidence of `daemon_crashed`; use durable Run status or launcher/crash
evidence for that classification.

Once `runs.start()` returns, retain the exact `runId`. If the result Promise
fails because a reconnectable transport was lost, attach a replacement Runtime,
verify the same Session with `runs.get(runId)`, and await that Run:

```ts
const admitted = await runtime.runs.start(input);
let replacement: KodaXRuntime | undefined;

for (;;) {
  try {
    if (replacement === undefined) {
      return await admitted.result;
    }
    const status = await replacement.runs.get(admitted.runId);
    if (status.sessionId !== admitted.sessionId) {
      throw new Error('Run identity changed');
    }
    return await replacement.runs.await(admitted.runId);
  } catch (error) {
    if (!isRuntimeDaemonDisconnectError(error) || !error.reconnectable) {
      throw error;
    }
    replacement = await attachRuntimeAfterBackoff();
  }
}
```

Here `attachRuntimeAfterBackoff()` owns one shared reconnect schedule, resolves
only after a replacement Runtime is ready, and rejects on permanent
initialization failure or explicit host close.

Never call `runs.start()` again for the admitted request: transport recovery is
observation, not execution replay. A second disconnect during `runs.get()` or
`runs.await()` repeats the same recovery loop with the same `runId`. Permanent
initialization errors and explicit host close settle the waiting result instead
of leaving it pending.

On transport failure, Runtime change, expired history, or `resync_required`,
discard the local derived projection and call `sessions.observe()` again. Do
not merge a new snapshot into the old projection. The handshake buffer is
bounded; overflow fails explicitly instead of dropping events. A Runtime
restart changes `runtimeId`. The observation's `invalidated` promise reports
`event_overflow`, `event_order`, `runtime_changed`, or
`transport_disconnected`; after it resolves, no state derived from that
observation remains authoritative. Restart recovery interrupts only a Run
whose owner is definitely gone; uncertain external execution is `unknown`.
Timeout or cancellation removes the daemon request immediately. If a
third-party transport ignores cancellation and later returns an observation,
the client compensates by unsubscribing that late observation.

### Durable mutations, stable ordering, and settings CAS

Every durable public control mutation uses an operation envelope. Credential
and Host Tool register/revoke/supply/complete requests are reverse-bridge
control frames and are deliberately excluded from the control journal so
secrets/results are not persisted. They still enter the daemon management
draining fence: once an atomic stop begins, they fail with typed `conflict` and
cannot change reverse-bridge state. The SDK creates an operation ID for
ordinary one-shot calls. A
product-level retry after a lost response must reuse its own stable operation
ID; changing its method, payload, resource, or authenticated principal is
rejected.

```ts
const session = await runtime.sessions.create({
  sessionId: stableSpaceSessionId,
  title: 'Shared session',
  surface: 'space-desktop',
  operation: { operationId: loadOrCreatePendingOperationId('space-session-draft-7') },
});

const operationId = loadOrCreatePendingOperationId('space-run-draft-42');
const handle = await runtime.runs.start({
  sessionId: session.id,
  input: { type: 'text', text: prompt },
  options: { provider: 'anthropic' },
  operation: { operationId },
});

const current = await runtime.sessions.getSettingsVersioned(session.id);
const updated = await runtime.sessions.updateSettingsVersioned(
  session.id,
  { model: 'claude-sonnet-4-5' },
  {
    operationId: loadOrCreatePendingOperationId('space-settings-draft-9'),
    expectedRevision: current.revision,
  },
);
```

Create retries with the same explicit session and operation IDs cannot overwrite
an existing session. Same-session starts and after-turn inputs receive a durable `sessionOrder`.
Retries with the same operation ID return the canonical result and do not
create another run. Settings use compare-and-swap; a stale revision returns a
structured conflict and must be reloaded, never silently overwritten. The
shared settings keys are `provider`, `model`, `effort`, `thinking`,
`reasoningMode`, `permissionMode`, `executionCwd`, `agentMode`, and
`autoModeEngine`, `autoModeClassifierModel`, `autoModeTimeoutMs`, and
`autoModeSpeculativeWindowMs`.

```ts
const queued = await runtime.runs.submitInput({
  sessionId: session.id,
  afterRunId: handle.runId,
  delivery: 'after_turn',
  input: { type: 'text', text: 'Also update the tests.' },
  operation: { operationId: loadOrCreatePendingOperationId('space-input-17') },
});

if (!queued.accepted) {
  // stale_run, unsupported_capability, or interrupt_window_closed:
  // show the factual result and preserve the user's unsent input.
}
```

For input that must join the current active Run, submit `delivery:'interrupt'`.
This does not create a Run. Each accepted input appears as `queued` in the
owning Run's `interruptInputs`. At the next safe boundary, all accumulated
interrupts are drained FIFO, remain separate user messages in one next LLM
request, and produce one `run.input.delivered` event whose `inputs` array is the
complete ordered batch. Exact operation retries return the same `inputId`.
The accepted result's `runId` is the existing owning Run (equal to
`afterRunId`), not a newly created continuation.

Since v0.7.81, every newly delivered item also carries `entryId`: the exact
physical Session-lineage user entry created by canonical persistence. The same
value appears in `runtime.runs.get(runId).interruptInputs`; do not infer it
from a transcript ordinal or fabricate one. Runtime-owned Sessions write the
required snapshot before publishing the delivery event, so a failed or
ambiguous canonical reference fails delivery closed. The field may be absent
only when reading a legacy persisted record. Event replay, Session compaction,
and Runtime restart preserve a newly recorded reference.

Since v0.7.82, submission resolves the admitted authoritative Run before it
reads mutable canonical Session history. Active interrupt and after-turn
requests therefore do not surface a transient `data_changed` response caused by
predecessor persistence. `after_turn` still waits for predecessor settlement,
and an exact `operationId` still produces one admission and one queue item.

Interrupt admission closes when the Runner publishes its final completion or
terminal error signal, or when the Run's supplied `abortSignal` aborts, even if
the outer Run is still settling. Non-terminal observer diagnostics do not close
the window. Same-Run lifecycle continuations also have a fixed internal
allowance beyond the configured iteration ceiling; the Runner closes admission
before its final absolute generation so repeated submissions cannot keep one
Run alive indefinitely. The allowance never expands an admitted manifest's
`maxIterations` governance cap. A submission after closure returns
`accepted:false` with `reason:'interrupt_window_closed'` and is not queued. Keep
the original input available for retry after the Run ends; do not silently
change its delivery to `after_turn`. As a final race/recovery
guard, inspect terminal Run status: any `interruptInputs` entry whose state is
`terminal` was not delivered. Reconcile it by `inputId` and present a visible
non-delivery outcome rather than leaving a pending queue indicator.

```ts
const interrupted = await runtime.runs.submitInput({
  sessionId: session.id,
  afterRunId: handle.runId,
  delivery: 'interrupt',
  input: { type: 'text', text: 'Also preserve the public API.' },
  operation: { operationId: loadOrCreatePendingOperationId('space-input-18') },
});
```

Run status exposes acceptance/start/queue times, authenticated origin,
`sessionOrder`, and a single terminal fact. Important terminal codes include
`runtime_restarted`, `daemon_crashed`, `credential_unavailable`,
`host_not_dispatched`, `host_outcome_unknown`, and
`control_history_untrusted`. Managed tasks that require user input use
`terminal.code = 'blocked'`; surface `terminal.message` when present instead of
replacing it with a generic run failure. Respect `effectOutcome`; `unknown` must
never be presented as success or automatically retried. After a lost response,
query `runtime.operations.get({ operationId, journalEpoch })`; applied receipts
include the canonical result. Permission grants remain daemon-owned and
revisioned.

Runtime startup restores all indexed active Runs and at most 200 recent
terminal Runs from a bounded durable status index. `runs.get(runId)` remains an
exact persisted lookup even when an older terminal Run is outside that recent
window. The first start after upgrading an unindexed home may perform one full
compatibility scan. A start after a crash, or a concurrent Runtime starting
while a live writer has intentionally left the index dirty, may likewise do
one authoritative reconciliation. Normal writers publish canonical
`status.json` first and keep the derived index recovery-fenced across those
crashes and concurrent Runtime instances.

### AskUser and permission from any client

AskUser is no longer an in-process callback for daemon Coder runs. Any client
with the responder scope can list the pending request and answer or dismiss it.
The request revision and run binding prevent a stale UI from answering a new
request. Exactly one concurrent answer is accepted. Runtime creation accepts
independent `permissionTimeoutMs` and `userInputTimeoutMs` values; each defaults
to five minutes. `userInputTimeoutMs` must be positive;
`permissionTimeoutMs` may also be `0` to disable its timer. Positive values
must not exceed 2,147,483,647.
The same non-negative bound applies to a per-request
`runtime.permissions.request({ timeoutMs })` override. A supplied `expiresAt`
must be a valid date no more than 2,147,483,647 ms in the future; past dates
fail closed immediately.
On AskUser expiry, the Runtime selects `default` only when it
is valid for that request (or is the free-text input default); without a valid
default it dismisses the request. For multi-question requests every question
must have a valid default to produce an automatic answer.

```ts
for (const request of await runtime.userInputs.listPending({ sessionId })) {
  const resolution = await runtime.userInputs.respond(request.id, answer, {
    expectedRevision: request.revision,
    runId: request.runId,
  });
  if (!resolution.accepted) refreshPendingInteractions();
}

for (const request of await runtime.permissions.listPending({ sessionId })) {
  const sessionScope = request.grantSuggestions
    ?.find((candidate) => candidate.kind === 'session');
  const accepted = await runtime.permissions.respond(
    request.id,
    sessionScope
      ? { type: 'allow_session', suggestionId: sessionScope.id }
      : { type: 'allow_once' },
    { runId: request.runId },
  );
  if (!accepted) refreshPendingInteractions();
}
```

Persistent `allow_always` grants are owned by the daemon and require
`permission:grant-admin`. Use `permissions.listGrants()` and
`revokeGrant(grantId, expectedRevision)` for revision-safe administration.
Clients must return one opaque `grantSuggestions[].id` from the pending request;
they must not infer, construct, or widen a scope from the display label or input
preview. A safe request can offer `allow_session` and `allow_always`; a risky or
dynamic shell request deliberately omits the persistent candidate. Command
grants match one exact normalized command/cwd/shell/background combination,
while path grants match one tool and normalized absolute path (the future
Write/Edit content may differ). Generic extension calls can receive only an
exact in-memory Session grant. Raw command/argv data is not stored in the
matcher; grants and audit contain only its fingerprint plus a bounded,
secret-redacted operator label. Clients must not keep separate persistent
permission rule stores. Runtime capability `runtimeAutoModeGuardrail` v4
advertises this opaque concrete-grant contract plus the intent-aligned
retry/Accept-edits behavior that never changes the engine to rules. Embedded,
Worker, and daemon hosts all report `fallbackPersistsEngine:false`; restart or
upgrade an older daemon instead of falling back to a client-side alias.

### Broker a Space keychain credential

Credentials remain owned by Space's OS keychain. Register a broker in Electron
Main, bind the returned lease only to runs that Space starts, and return the
key only after checking the daemon-provided provider/session/run context.

```ts
const credentialLease = await runtime.credentials.register(
  { providers: ['anthropic'] },
  async ({ provider, sessionId: requestedSession, runId }) => {
    authorizeSpaceRunCredential({ provider, sessionId: requestedSession, runId });
    return spaceKeychain.readProviderCredential(provider);
  },
);

const run = await runtime.runs.start({
  sessionId,
  input: { type: 'text', text: prompt },
  options: { provider: 'anthropic' },
  credential: { leaseId: credentialLease.id, provider: 'anthropic' },
  operation: { operationId: loadOrCreatePendingOperationId('space-run-88') },
});
```

The secret crosses only the authenticated reverse frame and an in-memory
run/provider scope. It is excluded from events, status, logs, diagnostics,
operation records, and Runtime persistence. While such a scope is active,
provider mismatch fails closed and never falls back to daemon environment.
Without a stable `instanceSecret`, registration ends when the Space connection
closes. With it, the daemon keeps the registration owned by that stable client;
a replacement Space process reattaches the callback with
`runtime.credentials.resume(leaseId, broker)`. An accepted run has already
acquired its scoped credential, so it reports `requirements.credential.state`
as `ready` and may continue after disconnect. If the broker cannot answer, the
start is rejected instead of accepting an indefinitely waiting run. Expiry or
Runtime restart is explicit (`expired` or terminal); no provider request is
automatically replayed.

### Bind Space-owned Host Tools to one run

Register only narrow product capabilities. Descriptors are data; handlers stay
in Electron Main. A lease grants nothing until its ID is explicitly bound to a
run.

```ts
const hostLease = await runtime.hostTools.register([{
  name: 'space_artifact_create',
  description: 'Create a Space-owned artifact for this run.',
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  },
  sideEffect: 'non_idempotent',
}], {
  async space_artifact_create(invocation) {
    authorizeBoundSpaceInvocation(invocation);
    const artifact = await createSpaceArtifact(invocation.input);
    return { content: `Created artifact ${artifact.displayId}` };
  },
});

await runtime.runs.start({
  sessionId,
  input: { type: 'text', text: 'Create the report artifact.' },
  hostTools: { leaseId: hostLease.id },
  operation: { operationId: loadOrCreatePendingOperationId('space-artifact-run') },
});
```

The daemon injects session/run/lease/invocation identity; renderer, model, and
ordinary tool input cannot choose it. CLI runs never inherit a Space lease just
because Space later observes their session. The client memoizes one handler
promise per invocation ID, and the daemon never replays a dispatched Host Tool.
After a stable-client reconnect, call
`runtime.hostTools.resume(leaseId, handlers)`. Bound run status reports
`ready`, `waiting_host`, `expired`, or `terminal`. Disconnect or timeout after dispatch produces `host_outcome_unknown`; Space
must reconcile the product side effect itself before offering a new user
action. `runtime.hostTools.getInvocation(invocationId)` returns the durable
metadata state `prepared`, `dispatched`, `completed`, `unknown`, or
`not_dispatched`; it never returns handler input, result, or credential data.
The daemon writes the `dispatched` marker before attempting the reverse frame
and never auto-replays an invocation.

Since v0.7.82, a live Host Tool lease contributes a complete, lease-scoped
capability snapshot to unfiltered `mcp_search`. An explicit `server` filter
selects only that named MCP or Host Tool source; it never leaks tools from the
other source. A provider without a snapshot is queried uncapped and reported as
incomplete/unknown rather than silently presenting a truncated catalog.

### Coder admission, typed events, and transport-safe inputs

The daemon enforces Coder session admission on the server for list/create/load,
run, settings, delete, rewind, fork, compact, transcript, event, interaction,
and diagnostic paths. Coder
surfaces are `code`, `cli`, `repl`, `acp`, `a2a`, `sdk`, `ide`, and
`space-desktop`. A session marked with
Partner surface/profile metadata, or any unknown product surface, fails with
typed `session_not_admitted` before mutation. Space must continue marking
Partner sessions as `surface: 'partner'` and keep their inline storage root
separate. Legacy sessions without a surface remain admitted for existing Coder
compatibility, so absence of metadata is not a Partner namespace mechanism.

`RuntimeEventPayloadMap` and `RuntimeTypedEvent` provide the public
discriminated contract for known events. Existing raw listeners remain
compatible; consumers can use `parseRuntimeEvent(value)` before exhaustive
handling. One unknown or malformed event is diagnosed and dropped without
closing the observation stream.

Daemon clients use `RuntimeDaemonStartRunInput`. Function callbacks,
`AbortSignal`, Extension Runtime objects, and guardrail instances are excluded
from that type and rejected at runtime with `RuntimeTransportBoundaryError`
and an exact value path if an untyped caller supplies them. Host-only values
remain valid only for embedded Runtime calls.

### Recovery queries and stop preflight

`runtime.status.preflight()` returns the initialized logical-client count,
active and queued runs, running/paused Workflows, every non-terminal External
Agent task (including `unknown`), pending AskUser/permission records, blockers,
and `canStop`. The background-work blockers are `active_workflows` and
`active_agent_tasks`. The current facade counts as one; daemon self-connections
and bounded health probes do not count. A second process changes the count to
two, and its awaited `close()` makes the count converge back to one.

Preflight is useful for UI, but it is not a stop authorization token. Use
`runtime.daemon.inspect()` to obtain one consistent management revision,
verified owner fence, owner-policy revision, and preflight projection. Only
`runtime.daemon.stopForInline()` atomically rechecks and commits a rollback.
The management revision also advances when the preflight projection changes,
so a Workflow or AgentTask lifecycle transition between inspect and commit
invalidates the stale stop. Capability details
`daemonManagement.backgroundWorkPreflight` and
`daemonManagement.reverseBridgeDrainingFence` identify this complete contract.
`runtime.operations.get()` reconciles durable mutations,
`hostTools.getInvocation()` reconciles Host Tool metadata, and
`permissions.listGrants()` returns the daemon-owned persistent grant set.

Terminal notification read/unread state is intentionally client-owned in
v0.7.69 (`durableRecoveryQueries.terminalAcknowledgement === false`): Space
persists its own UI acknowledgement cursor against Runtime/run terminal facts.
This avoids a false claim that one client's acknowledgement is global daemon
truth.

### Owner policy, rollback, and Electron boundary

Daemon and inline Coder use one profile fence. Do not compose
`status.preflight()` with a low-level unconditional stop: another client or run
can appear between those calls. The public rollback transaction gates new
clients and mutations, rechecks the same Runtime and management/policy
revisions, verifies there is no other client or active/queued/pending work,
commits sticky inline policy while that daemon still owns the fence, and then
requests shutdown.

```ts
import {
  acquireKodaXInlineOwner,
  enableKodaXDaemonOwner,
  getKodaXRuntimeOwnerState,
} from '@kodax-ai/kodax/runtime';

const management = await runtime.daemon.inspect();
if (!management.preflight.canStop) {
  showRollbackBlockers(management.preflight.blockers);
  return;
}

const rollback = await runtime.daemon.stopForInline({
  expectedRuntimeId: management.runtimeId,
  expectedRevision: management.revision,
  expectedOwnerPolicyRevision: management.ownerPolicy.revision,
  operation: { operationId: loadOrCreatePendingOperationId('coder-inline-rollback') },
});

// `accepted` means inline policy is committed and shutdown is in progress.
// Wait through the public owner-state query; never infer release from a PID.
const shutdownDeadline = Date.now() + 30_000;
while (getKodaXRuntimeOwnerState({ homeDir: kodaxHome, profile: 'coder' }).owner?.runtimeId
  === rollback.runtimeId) {
  if (Date.now() >= shutdownDeadline) throw new Error('Timed out waiting for daemon owner release.');
  await delay(25);
}
const releasedOwner = getKodaXRuntimeOwnerState({ homeDir: kodaxHome, profile: 'coder' });
if (releasedOwner.ownerStatus !== 'unowned') {
  throw new Error('Coder profile acquired a different owner during rollback.');
}
await runtime.close(); // Detach only; it does not perform a second stop.
const inlineOwner = acquireKodaXInlineOwner({ homeDir: kodaxHome, profile: 'coder' });

// Later, after the inline owner has released its fence:
inlineOwner.close();
const daemonPolicy = enableKodaXDaemonOwner({ homeDir: kodaxHome, profile: 'coder' });
// daemonPolicy.revision is authoritative; no expectedRevision guess is needed.
```

Any management revision change, another logical client, active or queued run,
running/paused Workflow, non-terminal/unknown AgentTask, pending
AskUser/permission, or in-flight mutation returns structured `conflict`; the
daemon remains running and policy remains unchanged. Draining also rejects
credential and Host Tool state changes without journaling their secrets or
results. The inline policy is sticky: later CLI auto-start is rejected until
`enableKodaXDaemonOwner()` changes it back to `daemon`. `runtime.close()` still
only detaches. Stale-owner handling validates the owned lock/state and never
kills a process merely because a PID was reused.

Keep all trusted objects in Electron Main: daemon token/endpoint, stable client
identity, operation IDs, owner policy, keychain broker, Host Tool handlers, and
permission-grant administration. Renderer IPC should expose product-specific
commands and sanitized projections only. Never pass daemon credentials,
leases, operation epochs, or trusted session/run context to renderer or model
tool arguments.

---

## 24. Runtime-owned Auto Mode and plan-approval bridges (v0.7.72–v0.7.73)

Auto Mode is a Runtime session contract, including in shared-daemon mode. Do
not implement a second classifier or decide permissions from a client-side
`beforeToolExecute` hook before the Runtime has classified the call.

### Configure the session, not an individual UI callback

```ts
await runtime.sessions.updateSettings(session.id, {
  permissionMode: 'auto',
  autoModeEngine: 'llm',
  autoModeClassifierModel: 'zhipu:glm-5.2', // optional; otherwise follow the run model
  autoModeTimeoutMs: 30_000,                // positive safe integer, optional
  autoModeSpeculativeWindowMs: 0,           // non-negative safe integer, optional
  executionCwd: projectDirectory,
});
```

All three Auto fields are durable session settings in inline, Worker, and
daemon forms. A `null` patch removes an optional override. Timeout must be a
positive safe integer; speculative window must be non-negative, so `0` is a
valid request to wait for the actual verdict. Daemon capability discovery
advertises all fields in `sharedSessionSettings.keys`.

SDK hosts that need config precedence without creating a REPL can reuse the
same typed resolver as KodaX:

```ts
import {
  loadAutoModeSettings,
  resolveAutoModeSettings,
  type ResolveAutoModeSettingsInput,
} from '@kodax-ai/kodax/repl';

const persisted = loadAutoModeSettings(process.env);
const preview = resolveAutoModeSettings({
  settings: { engine: 'llm', speculativeWindowMs: 0 },
  env: process.env,
});
```

`resolveAutoModeSettings()` is pure. `loadAutoModeSettings()` reads the KodaX
config once and delegates to that resolver; `loadConfig()` declares and
returns the same optional `autoMode` object.

Starting with the v0.7.73 patch, `permissionMode: 'auto'` with an omitted
`autoModeEngine` still means the documented `llm` default and is still owned by
Runtime. If neither `autoModeClassifierModel` nor the effective run/session/
Runtime model exists, `runs.start()` rejects with
`RuntimeAutoModeConfigurationError` (`code:
'auto_mode_classifier_model_required'`, `recoverable: true`) before provider
construction, a classifier call, or a pending permission. Blank and malformed
classifier model specs are rejected by the same typed configuration boundary;
a live rules-to-LLM switch is blocked rather than converted into approval work.

Direct consumers of `createAutoModeToolGuardrail()` receive the same terminal
model boundary. After resolving CLI/env/session/settings/live-default
precedence, an empty effective model returns a local configuration `block`
before provider lookup. It does not call `askUser`, mutate the denial or
circuit-breaker trackers, or change the engine to rules. An explicit non-empty
classifier override remains valid even when the main-session model is empty.

The Runtime owns one serialized permission-settings stream and one shared
engine/denial/breaker state per Session. It reuses bounded context-specific
guardrails across turns while provider/model, repository boundary, execution
directory, classifier model, and timeout remain the same. Updating one of
those inputs selects a new context guardrail by design without copying stale
state from a queued turn. Active runs, queued runs, explicit settings updates,
and explicit engine changes merge through the same Session mutation queue.
Classifier infrastructure failures do not mutate the engine to rules.

### What an embedder should expect

The Runtime's execution order is fixed:

```text
Runtime Auto Mode guardrail -> host permission bridge only for escalate -> tool execution
```

Exactly modeled ordinary reads and workspace/system-temp mutations are admitted
before classifier latency, independent of sandbox readiness. Other calls are
reviewed against the latest genuine user request, bounded user-only intent
evidence, and exact operation facts. Consequently, an LLM/rules `allow` does
not create a pending permission request just because a host installed a static
approval hook. Classifier concerns, critical deterministic matches, and rules
concerns use the existing shared
`runtime.permissions` flow, so another authorized client may render and answer
it. Hosts should subscribe to permission events to display such a request, but
must not treat a missing request as an error for a safe tool call.

Direct guardrail embedders should supply `projectRoot` or `executionCwd` for
path-bearing calls. If both are absent, KodaX keeps those targets unresolved
instead of treating the host process cwd as the user's workspace.

On PowerShell, deterministic read admission includes independently validated
sequential/pipeline stages such as `where.exe`, ordinary `rg` inspection,
non-sensitive `$env:NAME` reads, and constrained `Where-Object` /
`Select-Object` expressions. This is a structural allowlist, not a blanket
"review task" exemption. The executable token must be an admitted bare command
name; path-qualified executables, arbitrary `& script.cmd`, effectful `find` /
`awk` / `sed` forms, script blocks, sensitive credential environment names,
external ripgrep preprocessors, and file redirection continue through the LLM
classifier. They reach user approval only when the classifier identifies a
concrete hazard (or when its bounded retry and fallback policy requires it).
Authenticated child constraints are checked before deterministic admission:
for example, `Do not execute shell commands` keeps even a read-only shell call
under review, while `Do not modify files` does not make an ordinary read ask.

The classifier deadline is 45 seconds for the first default attempt and 90
seconds for its one retry. A configured `timeoutMs` overrides both attempts
with the same explicit deadline. Each deadline includes connection setup,
provider Retry-After/backoff, inference, and stream completion. A second
timeout/provider/response-contract failure uses the Accept-edits safety
boundary and never switches to Auto[rules]. Before the
provider call it removes assistant prose/thinking and image paths, limits each
tool result to 2 KiB and the serialized permission-relevant transcript to
8 KiB, then enforces 16 KiB action and 32 KiB total-prompt ceilings plus a
256-token first-attempt output cap. If that answer is truncated before a
decision, the retry uses 1024 tokens instead of repeating the same impossible
budget. An oversized action or prompt escalates without a provider call; it is
never truncated into an automatic allow. These limits are owned by
`classify()` itself, so custom callers cannot accidentally bypass the
session-history boundary.

Deterministic read admission keeps ordinary project directories, structured
`grep`/`glob`, ripgrep/GNU-grep filters, and other bounded search selectors on
the read fast path. A wildcard remains unresolved only when it can reach a
protected credential area or its path boundary cannot be established.
Explicit PowerShell `-LiteralPath` remains literal. Indirect file lists,
dynamic Git pathspecs, and expanded `git grep --no-index`/`--untracked` scopes
remain LLM-reviewed when their targets cannot be bounded safely. Git
line-log `-L` paths, patch-enabling short-option clusters, and merge-diff modes
are resolved before deciding whether output is scoped. Exact-file reads and
metadata-only output such as `git show --stat` remain deterministic. Exclusion
selectors do not become input targets. On Windows, protected-name checks also
cover trailing-dot/space aliases, alternate data streams, and canonicalized
existing 8.3 names. Git-config
regexp/URL reads account for accepted option abbreviations and effective
boolean-option ordering; only complete anchored selectors over known
non-secret metadata can take the deterministic fast path. Likewise, incomplete
current-user content may still admit a proven read, but a complete current
request that explicitly prohibits reading or shell execution routes the
matching read-only operation through the classifier. Ordinary review and
read-only requests remain deterministic. `currentUserContentTruncated:true` prevents a
write, delete, move, copy, or unmodeled execution from relying on the compacted
fragment alone. On classifier failure, Accept-edits fallback is available only
when the full structured review would pass the same deterministic predicate;
protected/unresolved targets and partial/risky reviews remain approval-bound.

`ClassifyDecision.diagnostics` and the lower-level
`SideQueryResult.diagnostics` expose provider, model, effective timeout,
elapsed time, retry count/wait, provider stop reason, response byte/text-block
counts, and a coarse terminal phase without including the prompt, action,
messages, or response text. `pre_output` means no non-empty text delta was
observed; `streaming` means output began before termination. `firstOutputMs`
and `streamMs` are present only when the provider adapter emits a text delta.
Each classifier attempt may additionally expose `observedProtocol`
(`structured_v2`, `legacy_v1`, or `unknown`) and a bounded
`parseFailureCode` when no valid unambiguous decision exists. When exactly one
valid `decision=allow|ask` (or legacy `block=no|yes`) is present, that decision
is authoritative. Missing, malformed, or contradictory `hazard` / `reason`
fields and surrounding-format defects are reported as bounded
`outputWarnings`; they do not change the decision, consume the retry, increment
the circuit breaker, or create an approval request after `allow`. Runtime
permission requests copy these fields into `autoModeDiagnostics`, allowing a
host to distinguish an LLM confirmation decision (`source:
classifier_confirm`) from provider/decision-contract failure (`source:
classifier_failure`) without retaining model output. Missing or invalid
decision values and ambiguous duplicate/mixed decisions remain contract
failures and receive the same single bounded retry. The current
provider API cannot honestly separate DNS/connect, TLS, provider queueing, and
inference, so embedders must not infer those stages from `pre_output`.
Because raw classifier text is deliberately not retained, these diagnostics
cannot retroactively prove the shape of an older response. A future
`observedProtocol:legacy_v1` value is evidence for that attempt; compatibility
with `legacy_v1` alone is not proof that a prior provider returned it.
`outputWarnings` explain the accepted attempt; they are not a second verdict.
Under the LLM engine, a broken/non-string tool projection and an unavailable or
faulty direct-read analyzer are recoverable metadata faults: KodaX records a
warning, builds a bounded credential-redacted fallback projection, and still
asks the classifier. They do not directly create a user approval request.
Extension/provider exception bodies are omitted entirely from Auto-mode logs
and approval reasons; only the stable failure stage and exception category are
retained. All Auto-mode host warning messages are additionally
credential-redacted, normalized to one line, and capped at 768 characters.
Logging is best-effort observation: an embedder logger that throws cannot alter
the permission decision or interrupt the documented fallback.
For source compatibility, the public `ClassifierDecision` allow branch keeps
`hazard?: 'none'`. If a model returns `decision=allow` with another hazard, the
allow remains authoritative, `decision_hazard_conflict` appears in
`outputWarnings`, and the contradictory hazard value is not placed in that
legacy field.
Auto[LLM] is allow-by-default automatic review. An operational classifier is
instructed to return `ask` only for one of two evidence-based classes: a
concrete read from a known key/token/credential store or a mutation to KodaX
authorization controls; or direct system destruction/resource exhaustion that
can destabilize the OS or unrelated software. Ordinary project mutations, Git
stash and other Git writes, and normal global dependency install/uninstall/
reinstall do not require per-command root authorization. Syntax complexity,
incomplete analysis, general uncertainty, and command category are not ask
reasons. Static signals, including historical catastrophic-pattern matches,
are classifier facts rather than a second Auto[LLM] verdict; explicit
Auto[Rules] retains its legacy deterministic gate. A host must honor a valid
classifier `allow` without manufacturing another approval. Infrastructure or
decision-contract failure still uses the bounded retry and documented
Accept-edits fallback; only exhaustion beyond that fallback reaches approval.

The permission event's `inputPreview` is a display-safe diagnostic projection:
it is bounded, credential-redacted, valid JSON, and includes the effective
execution directory. Use the Runtime owner’s typed tool input for execution;
do not reconstruct or authorize a tool from the preview. `gitRoot` remains the
session repository safety boundary, whereas relative operands resolve from the
validated `executionCwd`. In particular, quoted Python/JavaScript/regexp source
inside a shell command is not a path operand.

Every Runtime permission request has a deadline. If the host does not answer,
the current operation is not executed and the guardrail returns a stable
`approval_timeout` result telling the main model to try a safer, narrower, or
reversible approach, or stop and wait for explicit user approval. A timeout is
not serialized as an ordinary user rejection.

The user-level `.kodax` directory is a credential/configuration boundary, not
an ordinary project path. Direct shell mutations, output redirects, and
recognized nested-shell payloads whose target is provably beneath that
directory are identified before LLM classification and supplied as precise
facts rather than permanently policy-blocked. The check is segment-safe and
Windows case-insensitive. KodaX deliberately does not scan arbitrary
quoted language source for path-looking substrings: doing so would turn Python,
JavaScript, YAML, and regular expressions into false Tier-0 matches. Trusted
configuration changes should use the KodaX config CLI or SDK configuration API.

### 0.7.x source compatibility

The v0.7.72 public declarations retain the following migration aliases:

| Legacy source | Current source | Contract |
|---|---|---|
| `agentMode: 'amaw'` | `'ama'` | accepted as deprecated input and normalized to AMA; no separate AMAW runtime is restored |
| `SkillSource` | `ResolvedSkillSource` | formal source union remains `project \| user \| plugin \| builtin`; only resolved discovery output adds `learned` |
| `RuntimeDaemonPreflight.activeAgentTasks` | `activeAgentTurns` | both required fields are returned and reference the same array throughout the 0.7.x line |

### Plan capability is opt-in

`exit_plan_mode` is exposed to a Runtime run only when that run supplies an
approval bridge. A daemon or headless host that cannot approve a plan should
leave the bridge absent; KodaX removes the tool from that run's scope.

```ts
const planned = await runtime.runs.start({
  sessionId: session.id,
  prompt: 'Draft a migration plan, then ask for approval.',
  options: {
    events: {
      exitPlanMode: async () => showPlanAndAskUser(),
    },
  },
});
await planned.result;
```

The callback belongs in a trusted host process (for Electron, Main rather than
renderer). It is intentionally not inferred from the presence of a permission
UI: tool permission and plan approval are different user decisions.

See [ADR-056](../../docs/ADR.md#adr-056-runtime-owns-auto-mode-permission-decisions-and-host-capability-exposure)
for the ownership decision, [the v0.7.72 design](../../docs/features/v0.7.72.md#2026-07-18-runtime-permission-queue-and-resume-closure)
for the release boundary, and [Known Issue 187](../../docs/KNOWN_ISSUES.md#187-shared-daemon-auto-permission-ownership-upgrade-fencing-preview-bounds-and-sdk-compatibility-were-incomplete)
for the final capability-upgrade and compatibility closure.

---

## 25. Always-on context compaction and bounded transcript recovery (v0.7.74)

Automatic large compaction is always enabled. `enabled` remains accepted for
v0.7.x source compatibility, but `false` is normalized to `true`.
`triggerPercent` defaults to `75` and is clamped to `15..90`. The optional
absolute threshold is inactive when omitted or zero; otherwise the smaller
percentage, absolute, and physical-capacity threshold wins.

```ts
const run = await startKodaX({
  provider: 'zhipu-coding',
  model: 'glm-5.2',
  compaction: {
    triggerPercent: 60,
    triggerTokens: 300_000,
  },
});
```

The recent raw tail is 20% of that effective trigger, not 20% of the model's
maximum context window. A manual Runtime compact bypasses only the trigger
comparison and uses the Session's same effective policy:

```ts
await runtime.sessions.updateSettings(session.id, {
  compactionTriggerPercent: 60,
  compactionTriggerTokens: 300_000,
});

await runtime.sessions.compact({ sessionId: session.id });
```

Setting `compactionTriggerTokens: 0` removes the absolute Session override.
Percentage updates are normalized to `15..90`; negative/fractional absolute
values are rejected. Explicit per-run `options.compaction` values override
Session settings.

Large compaction covers the complete eligible prefix once, preserves an atomic
recent tail, and installs a synthetic user checkpoint. Every genuine user query
is rendered mechanically in its checkpoint ledger; tool-result wire messages
and synthetic prompts are excluded. The normal summary request preserves the
main request's system, message, tool, model, and reasoning prefix and appends a
text-only ephemeral instruction so providers can reuse prompt/KV cache.

The exact pre-compaction transcript has a separate durability guarantee. The
root host persists all pre-compaction messages (including messages created in
the active Run) before old payload is evicted from memory. Island records are
flushed before a slim main JSONL is published. If the main replacement fails,
main and sidecar may temporarily overlap, but stable entry IDs project the
logical entry once. A persistence failure keeps the exact live copy; child
compaction never writes root Session lineage.

The in-process `onCompactedMessages` callback may return a `Promise`. KodaX
awaits it before the next provider request and before
`context.compaction.finished`. Embedded and daemon Runtime execution always
uses Runtime-owned Session storage, regardless of a client-side
`persistedByHost` value; a daemon client cannot be the durability owner because
its callback is not present in the daemon process. Runtime-backed Ink and
classic REPL hosts therefore update only their live projection after the
Runtime acknowledgement; they do not perform a second Session write. If a
headless Runtime Run compacts before its first routine snapshot, Runtime seeds
the new Session from explicit Run metadata before applying the exact compact
transaction. A rejected durability callback also rolls back the tentative
`contextRevision`, so a later successful compact does not expose a phantom gap.

### Context-owned events

`context.compaction.finished` is the canonical post-commit Runtime fact. It
includes stable root/child identity, revision, before/after tokens, strategy,
effective trigger, protected budget, and component accounting. Consumers must
not use `scope: 'worker'` as a parent/child identity substitute.

Operational no-ops are exposed as `context.compaction.skipped`. Its structured
reason is one of `compactable_below_threshold`, `no_compactable_prefix`,
`low_savings_cooldown`, `covered_context_unchanged`, or
`circuit_breaker_cooldown`. A
started attempt always closes with `context.compaction.ended`; managed-task
attempts carry an `outcome`, structured `reason` for skips or failures, and
breaker state. Legacy events and non-managed compaction paths may contain only
`meta`. The
failure breaker counts only summary-generation and persistence failures, waits
two eligible boundaries before a half-open retry, and can rearm earlier after
meaningful compactable-token growth.

```ts
const subscription = runtime.events.subscribe(
  { sessionId: session.id, types: ['context.compaction.finished'] },
  (event) => {
    if (event.type !== 'context.compaction.finished') return;
    const fact = event.payload;
    if (fact.contextKind === 'root' && fact.committed) {
      renderRootContext(fact.tokensAfter, fact.tokensBefore);
    }
  },
);
```

Legacy `onCompactStats`/`onCompact` callbacks remain compatibility projections.
The old `onCompact` callback now receives the post-compact count; it no longer
echoes the pre-compact `currentTokens` value. Hosts that need ownership or
component metrics should use `onContextCompactionFinished` or the Runtime
event. Compatibility success callbacks fire only after a strict token
reduction has restored physical request validity and committed. An unchanged,
failed, stale, or still-oversized candidate is not a successful compaction.

### Transcript observation below the daemon frame limit

`sessions.observe()` no longer embeds `FullTranscriptSessionData`. Its snapshot
contains a bounded `RuntimeTranscriptSlice`. Inline entries carry the complete
transcript entry; an oversized entry carries an explicit descriptor.

```ts
const observation = await runtime.sessions.observe(session.id, onLiveEvent);
let page = observation.snapshot.transcript;

while (page) {
  for (const descriptor of page.entries) {
    if (descriptor.entry) consume(descriptor.entry);
    else await consumeEntryChunks(runtime, session.id, page.revision, descriptor.index);
  }
  if (!page.hasMore) break;
  page = await runtime.sessions.transcriptPage({
    sessionId: session.id,
    cursor: page.nextCursor,
  });
}
```

`transcriptEntryChunk()` returns lossless `base64-json` chunks. Concatenate the
decoded bytes and parse JSON only after `hasMore` becomes false. Page and entry
cursors are opaque and revision-bound. Runtime retains a bounded immutable
snapshot for an in-progress cursor, so new appends do not create duplicates,
gaps, or an endless moving boundary. Once that snapshot is no longer retained,
the next read returns `resync_required`; restart from a fresh observation.
All transcript/history methods accept `{ timeoutMs, signal }` as their final
read options in embedded and daemon mode. The shared daemon's
legacy `session.transcript` method rejects payloads above 512 KiB and names the
page/chunk methods rather than attempting a frame near the 8 MiB ceiling.

### Search compacted history before fetching exact content

Use `transcriptSearch()` when the host or user knows a historical detail but
not its page/index. It searches the authoritative main-plus-sidecar lineage and
returns bounded revision-bound hits with stable `entryId`/`logicalId`, entry
index, role/source, timestamp, active/compacted status, and a citation:

```ts
const found = await runtime.sessions.transcriptSearch({
  sessionId: session.id,
  query: 'permission test output capture',
  role: 'assistant',
  limit: 5,
});

for (const hit of found.hits) {
  renderSearchHit(hit.citation, hit.snippet);
  // For an oversized exact entry, pass found.revision + hit.entryIndex to
  // transcriptEntryChunk(); ordinary entries can be obtained from the page.
}
```

Search is deterministic Unicode lexical/metadata ranking, not an embedding or
background-model index. The Action LLM gets the corresponding
`session_history_search` and `session_history_read` pair only when its current
Run owns full-lineage-capable Session storage. A root Run reads its root
lineage. A persistent child Run gets a separately minted hidden
`managed-task-worker` Session and can recover only that child's compacted
history; it is never given root-history access. Storage-less Runs and a tool
visibility policy that hides either member expose neither member. Results are
low-authority historical evidence; current instructions and freshly verified
workspace state take precedence. System/control entries, hidden-only content,
synthetic current or legacy `[对话历史摘要]` checkpoints, and `[compacted]`
placeholders are neither searchable nor directly readable. Short ordinary
terms do not gain a metadata match merely because they occur inside a random
entry ID; direct identifier lookup is reserved for a sufficiently specific ID
query. Sessions compacted by older builds without an exact main/sidecar copy
cannot reconstruct bytes that were already discarded.

Clients that depend on these guarantees should require
`contextCompaction: 3`, `transcriptPaging: 1`, and `transcriptSearch: 1` during
connection.

---

## 26. Agent mailbox control versus SDK event telemetry (v0.7.74)

The model-visible `wait_agent` tool and the public Runtime Actor event APIs have
different jobs. Do not expose `runtime.agents.wait()` to the model as though it
were the same operation.

| Need | API | Wake/data contract |
|---|---|---|
| Let the action model yield until useful coordination evidence exists | `wait_agent({ timeout_ms })` | Caller-scoped Agent mailbox, root user input, interruption, or timeout; returns only a small acknowledgement. |
| Render or diagnose Actor activity | `runtime.agents.events(sessionId, afterSequence?)` | Bounded event snapshot/replay, including progress and terminal events. |
| Long-poll Actor telemetry from a host | `runtime.agents.wait(sessionId, afterSequence?, timeoutMs?)` | Returns the next sequenced Actor event, including progress. |
| Read one known result | `runtime.agents.output(sessionId, actorPath, turnId?)` | Bounded current/terminal output and structured artifact metadata. |
| Deliver a real user follow-up to the active root Run | `runtime.runs.submitInput(...)` | Ordered active-run input delivered at the next safe Runner boundary; requires `interruptInput:1`. |

For example, a host activity view can replay the current tail and then wait
from its last sequence without causing another action-model request:

```ts
const snapshot = await runtime.agents.events(session.id);
for (const event of snapshot) renderActorEvent(event);

const afterSequence = snapshot.at(-1)?.sequence;
const next = await runtime.agents.wait(session.id, afterSequence, 30_000);
if (next) renderActorEvent(next);
```

Model `wait_agent` has only `timeout_ms` in its schema (10,000 to 3,600,000 ms,
default 120,000). Actor progress and Runtime `system-reminder` messages do not
end that wait. A scoped Agent message/completion produces `mailbox`; queued root
input produces `user_input_pending`; cancellation and expiry produce
`interrupted` and `wait_expired`. Authenticated Agent evidence is drained at the
next safe Runner boundary as synthetic context, while root input remains a real
user turn. The acknowledgement itself never carries raw event batches.

Completion delivery is post-transcript and crash-recoverable. The Actor snapshot
persists the explicit root completion turn IDs that still await transcript
acknowledgement. A hard restart republishes only those IDs; a same-process
Runtime rebuild deduplicates the projected queue by child turn ID. Once the
parent transcript commits and acknowledges the completion, later restores do
not replay it. Legacy snapshots without the explicit pending set do not infer
replay work from historical mailbox content.

This separation changes no Actor event capability or daemon version: existing
SDK snapshot, replay, and long-poll clients keep their telemetry surface. It
only prevents high-frequency progress from becoming a model control signal.

---

## 27. Windows GUI background subprocess visibility (v0.7.75)

KodaX SDK hosts do not need to add process-wide console suppression around the
Runtime. In the v0.7.75 release candidate, Runtime Worker-reachable
non-interactive/background child processes request `windowsHide: true` at their
own spawn boundary. The covered paths include:

- memory and Git metadata probes;
- provider CLI execution and ACP servers;
- LSP acquisition and language servers;
- clipboard helpers, worktrees, review commands, and extension commands;
- managed-task checkpoints and sandbox helpers.

The contract is intentionally narrow. Explicit external editors, terminal
commands, and PTY sessions remain interactive. POSIX-only `ps`, `tmux`, and
sandbox branches are reviewed bundle-audit exceptions rather than Windows
visibility paths.

`npm run build:bundle` audits every statically identifiable child-process call
reachable from `dist/runtime-worker.js`. The packaged Electron daemon smoke then
runs 20 ordinary queries with a Win32 probe and checks that the expected Git
children never own a visible console window. These checks validate the SDK
boundary, but they do not replace product-level validation in the packaged host.
KodaX Space should install the exact v0.7.75 tarball and complete
[`ISSUE_205_v0.7.75_REGRESSION_GUIDE.md`](../../docs/test-guides/ISSUE_205_v0.7.75_REGRESSION_GUIDE.md)
on Windows 10 and Windows 11 as a non-blocking product validation follow-up.
This follow-up does not gate SDK packaging, tagging, or publication.

---

## 28. Host-configurable Shell Execution Contract (v0.7.77)

The shared daemon is long-lived, so its startup `process.env.PATH` is not a
reliable description of every project's toolchain. A host can opt a Session
into a serializable shell contract:

```ts
await runtime.sessions.updateSettings(session.id, {
  executionCwd: projectDirectory,
  shellExecution: {
    version: 1,
    shell: {
      kind: 'pwsh',             // pwsh | powershell | cmd | bash | zsh
      profile: 'default',
    },
    environment: {
      inherit: 'filtered',
      // Trusted host code, not model input. Use it for a directory-aware
      // activation command when the shell profile does not switch on cwd.
      setup: 'fnm use --silent-if-unchanged',
      windowsPath: 'registry',
    },
    cache: {
      ttlMs: 30_000,
      refreshToken: 'toolchain-revision-1',
    },
    probeTimeoutMs: 10_000,
  },
});
```

An individual Run can supply `options.context.shellExecution`; a concrete Run
contract overrides the Session setting. An omitted value or explicit
`undefined` does not erase the Session setting. Use a `null` Session patch to
remove it.

The contract supports an optional absolute `shell.executable` (for example Git
Bash) and bounded fixed `shell.args`. Command/file/persistence/profile/server
and working-directory control flags are rejected from those fixed arguments.
`environment.set` is for non-secret host variables. `denyPatterns` can remove
additional names but cannot weaken the built-in Provider credential deny set.
`inherit: "none"` retains only the OS variables required to start the selected
shell. On Windows, `windowsPath: "registry"` re-reads current Machine/User
environment values instead of reusing the daemon's startup PATH.

The CLI config and SDK expose the same small command-target setting for commands
that intentionally need host credentials:

```json
{
  "sandbox": {
    "envPass": ["GH_TOKEN", "GITHUB_TOKEN"]
  }
}
```

SDK callers pass the same shape per Run, without mutating `process.env` config:

```ts
const handle = await runtime.runs.start({
  sessionId: session.id,
  prompt: 'Inspect the authenticated GitHub repository.',
  options: {
    sandbox: { envPass: ['GH_TOKEN', 'GITHUB_TOKEN'] },
  },
});
```

Direct `runKodaX()` / `startKodaX()` callers use the same
`KodaXOptions.sandbox` field. The option is Run-scoped, overrides the process-
level fallback even when `envPass` is empty, and is inherited by native child
Agents, Workflow children, and deterministic evaluators. Concurrent SDK Runs
can therefore use different lists without changing global configuration.

`sandbox.envPass` defaults to empty and stores exact names, never values. It
does not expose credentials to shell profile/setup resolution; the current
host values are restored only into the final command environment, which then
flows to ASRT or the ordinary fallback path. Windows matching is
case-insensitive; POSIX matching is case-sensitive. `NODE_OPTIONS`, `BASH_ENV`,
`RIPGREP_CONFIG_PATH`, and imported Bash functions remain blocked even if
named. The CLI projects its user config to the Run option through
`KODAX_SANDBOX_ENV_PASS`; that environment variable remains a CLI/backward-
compatibility fallback rather than the SDK API. Worker and daemon transports
carry names only. Values are read from the command-execution host environment;
an auto-started daemon inherits that environment, while an attached persistent
daemon must already have the variables and must restart after they change.

Resolution is two-stage and uses the effective cwd:

1. sanitize the bootstrap environment, including credentials for built-in,
   custom, active, inactive, and stacked runtime Providers;
2. start the selected shell, load the requested profile/setup, capture a
   random-framed environment, validate and sanitize it again;
3. execute the actual command through that same explicit interpreter.

The cache is in-memory and isolated by normalized contract, canonical cwd,
Session scratch identity, credential deny names, and refresh generation. TTL
is bounded to ten minutes; zero disables caching. Daemon restart clears it.
`clearShellExecutionEnvironmentCache()` is available for an in-process owner
that needs immediate global invalidation.

Native children, nested Actor turns, Workflow child paths, and deterministic
build/test/lint evaluators inherit the effective contract. Runtime exact-command
permission grants bind the interpreter family and contract fingerprint, so a
grant created under cmd cannot silently authorize the same command after a
switch to PowerShell or Bash.

Configured-shell failures are visible and fail closed: KodaX does not reinterpret
the command through another shell. When `shellExecution` is absent, KodaX keeps
the pre-v0.7.77 platform-shell interpreter behavior for compatibility; the
credential filter and explicit `sandbox.envPass` final-target restoration still
apply. See
[`ISSUE_214_v0.7.77_REGRESSION_GUIDE.md`](../../docs/test-guides/ISSUE_214_v0.7.77_REGRESSION_GUIDE.md)
for cross-project, cache, cancellation, credential, and Windows argv checks.

---

## 29. Evidence-gated background Skill learning (FEATURE_263, v0.7.78)

F263 completes the existing Learning Center rather than introducing a second
queue or client-owned Skill store. Episode review runs after durable foreground
completion and stays off the active Run's latency path. A correction, failure,
or verifier result is Memory evidence first; it does not itself authorize a
Skill mutation.

A low-risk declarative Skill can enter automatic project-scoped testing only
after an explicit preserve-as-Skill request with verified terminal evidence,
or repeated independent root episodes plus independent verified artifact
evidence. The owner writes an immutable revision and its canonical capability
record before discovery can expose it. Formal/builtin/plugin/human Skills keep
precedence and cannot be shadowed. Protected/formal changes, user-global
promotion, and Extension authoring remain explicit user actions.

Hosts that require this behavior should negotiate both Runtime capabilities:

```ts
const runtime = await createKodaXRuntime({
  mode: 'daemon',
  requirements: {
    learningCenter: 1,
    skillLearningLoop: 1,
  },
  clientInfo: {
    name: 'my-host',
    instanceId: stableClientId,
    instanceSecret: keychainSecret,
  },
});

const snapshot = await runtime.learning.getSnapshot();
const page = await runtime.learning.list({ limit: 50 });

for await (const event of runtime.learning.subscribe({
  afterRevision: snapshot.revision,
})) {
  renderLearningEvent(event);
}
```

`loadFullTranscript()` remains the nullable compatibility API.
`readFullTranscript()` is the strict host/audit API: it reads main and sidecars
under one Session boundary without migration, execution recovery, takeover, or
repair. It reports `data_corrupt`, `version_incompatible`, `read_timeout`, and
`read_cancelled` instead of turning those cases into an empty/null history.
`readConversationHistory()` uses that same read-only boundary, then derives the
ordinary conversation projection without changing Session or Run state.

For an old or incompatible Session that cannot safely resume, use the
top-level `exportSessionBundle(id, options?)`. It returns the exact main,
`.islands.jsonl`, and legacy `.archive.jsonl` bytes plus hashes and
compatibility diagnostics. Export is read-only and fails closed on ambiguous
duplicate main files; it does not choose a Session, migrate it, or claim that
the task is resumable. Decode each file's `contentBase64` for the canonical
lossless bytes; `content` is only a UTF-8 compatibility preview. `byteLength`
and `sha256` are computed from the original bytes.

`runtime.learning` is the authoritative host surface:

| Need | API |
|---|---|
| Render inventory or one exact record | `list()` / `get()` |
| Render client-specific badges | `getSnapshot()` |
| Replay or follow durable lifecycle events | `events()` / `subscribe()` |
| Clear or defer only this client's notice | `acknowledge()` / `snooze()` |
| Explicitly control a learned revision | `reject()` / `disable()` / `rollback()` / `review()` / `trust()` |
| Promote to the user scope | `promote(nameOrSlugOrId, 'user')` |

Do not scan learned files and infer activation from their presence. Discovery
requires the canonical record, matching project identity, lifecycle,
fingerprint, regular-file checks, formal-name policy, and exact revision.
Testing admission permits one concurrent root binding and at most three
exact-revision invocations. Promotion requires independently verified success;
failed or inconclusive canaries return to Ready/attention. A Run retains the
revision it captured at admission, so rollback or replacement affects future
bindings without mutating an in-flight prompt.

Learning Center notification state is client-specific, but capability
lifecycle and project canary state are owner-global. Renderer code should
receive sanitized records/events through host IPC; it should not receive
daemon credentials or mutate files directly. Inline, Worker, and daemon
facades expose the same learning methods. A host missing `skillLearningLoop:1`
may still support the older Ready/manual Learning Center surface, but must not
claim the complete F263 project-canary contract.

---

## 30. Standalone sandbox SDK (v0.7.78)

ASRT containment is a public SDK capability, not an Auto[LLM]-only
implementation detail. Import the dedicated subpath when a host needs to
sandbox its own commands or scripts:

```ts
import {
  activateKodaXSandbox,
  doctorKodaXSandbox,
  getKodaXSandboxCapability,
  getKodaXSandboxSetupGuidance,
  runKodaXSandboxed,
} from '@kodax-ai/kodax/sandbox';

const capability = getKodaXSandboxCapability();
const doctor = await doctorKodaXSandbox({ refresh: true });

if (!doctor.ready) {
  showSandboxInfo(getKodaXSandboxSetupGuidance(doctor));
  // Call only from an explicit setup/onboarding action. On Windows this may
  // display UAC; ordinary SDK calls never invoke it automatically.
  const activation = await activateKodaXSandbox();
  if (activation.status !== 'ready') {
    showSandboxInfo(activation.guidance);
  }
}
```

Platform behavior:

- Windows uses the pinned ASRT restricted-user/WFP setup. The parent terminal
  does not need to be elevated; the one-time installer requests UAC itself.
- macOS uses Seatbelt through `sandbox-exec` and requires ripgrep. Guide users
  to `brew install ripgrep` when doctor reports it missing.
- Linux uses bubblewrap and requires `bubblewrap`, `socat`, and `ripgrep`.
  Present the emitted `apt`/`dnf`/`pacman` guidance; do not run `sudo` or a
  package manager silently.

Do not call `activateKodaXSandbox()` during ordinary Runtime startup, tool
execution, or a background permission check. KodaX's own first-run/setup UI
checks once; a declined UAC prompt or missing dependency is reported there and
is not repeatedly surfaced until the user runs setup again.

### Run a host-owned command with an explicit policy

```ts
import os from 'node:os';
import path from 'node:path';
import { runKodaXSandboxed } from '@kodax-ai/kodax/sandbox';

const result = await runKodaXSandboxed({
  command: process.execPath,
  args: ['scripts/generate-report.mjs'],
  cwd: projectDirectory,
  filesystem: {
    allowRead: [projectDirectory, process.execPath],
    allowWrite: [projectDirectory, os.tmpdir()],
    denyRead: [path.join(os.homedir(), '.ssh')],
    denyWrite: [path.join(projectDirectory, '.git', 'config')],
  },
  network: {
    mode: 'allowlist',
    origins: ['https://api.example.com'],
  },
  // false by default: start with KodaX's minimal execution environment.
  inheritEnvironment: false,
  env: { REPORT_FORMAT: 'pdf' },
  timeoutMs: 120_000,
  maxOutputBytes: 2 * 1024 * 1024,
});

if (result.status === 'unavailable') {
  // The command was NOT run. Decide explicitly whether your product should
  // wait for setup, reject the operation, or use its own non-sandbox path.
  showSandboxInfo(getKodaXSandboxSetupGuidance(result.doctor));
} else if (result.exitCode !== 0) {
  throw new Error(result.stderr || `sandboxed command exited ${result.exitCode}`);
}
```

The generic executor supports network `allow`, `deny`, and exact HTTP(S)
origin `allowlist` modes plus filesystem policy roots, environment inheritance,
timeout, cancellation, and bounded output. ASRT permits ordinary reads by
default: `denyRead` removes access and a more specific `allowRead` carves access
back. `allowWrite` defines the writable roots, while `denyWrite` removes
subtrees and always takes precedence over `allowWrite`. The HTTP(S) `origins`
are normalized to the hostname/port pair enforced by ASRT's network proxy. It
never silently runs without containment: sandbox unavailability is the typed
`{ status: 'unavailable', sandboxed: false, doctor }` result.

KodaX's own local workspace-shell policy supplies a stricter `denyRead` set
than the generic SDK default: common home credential locations, sensitive
private-key/environment filenames, and the complete resolved agent home are
denied. Home-local executable search paths nested below those roots are not
re-granted. This policy belongs to KodaX's command adapter; a standalone SDK
host must declare the sensitive paths required by its own threat boundary.

`command` and `args` remain separate process arguments. On Windows KodaX uses
an encoded bootstrap followed by `shell: false`, so `%VAR%`, `&`, embedded
quotes, and spaces are not expanded or re-parsed by the host shell. The
explicit environment policy is overlaid into ASRT's fresh restricted-user
environment; ASRT-owned proxy, CA, and Git safety variables retain precedence.
`timeoutMs` covers the complete broker lifecycle, including ASRT
initialization, the command, and cleanup. Windows ACL initialization on a cold
path can take tens of seconds, so do not reuse a classifier-scale 20–30 second
deadline unless that early cancellation is intentional.

This is intentionally different from KodaX's local permission fallback. When
ASRT is unavailable, Auto[LLM] still makes the same deterministic/LLM/user
permission decision and an admitted local shell may use the ordinary execution
path; only OS containment is absent. The same local fallback applies when
ASRT preparation or backend initialization fails before the target process
starts. KodaX never retries after the target has started, so a sandbox fault
cannot duplicate command side effects. Remote A2A admitted Skill scripts
retain their stronger isolation contract and do not fall back to an
unsandboxed script. Embedded and daemon Runtime capability metadata expose
`sandboxRuntime` with the platform backend, ASRT version, supported control
dimensions, elevation behavior, and fallback semantics.

Local workspace commands reuse prepared ASRT state per canonical workspace. On
Windows, commands with the same complete effective policy can share one policy
group across processes; incompatible policies use the already-authorized normal
permission path, and the final compatible owner confirms ACL reset. Per-command
target attestation and fallback remain independent. A cold first command may still wait for
platform initialization, while later commands reuse the prepared state. Abort
signals and the command deadline cover that prepare wait; a cancelled/timed-out
prepare never starts the target or changes to the ordinary fallback path.
Explicit Windows system-temp operations that ASRT cannot safely ACL-manage are
not selected for containment and keep the already-approved normal execution
path.

An unhealthy session fails the current prepare immediately so the host can use
its normal permission fallback. Cleanup continues out of band. On Windows the
owner first closes its command input and allows up to 130 seconds for ASRT
0.0.65's two serial ACL cleanup helpers to finish; only then may process-tree
termination be forced. The failed workspace session is not replaced until
that bounded cleanup settles, preventing a replacement from racing stale ACL
recovery. macOS and Linux use the same EOF-first sequence with a shorter
bounded termination grace.

Runtime event streams may also contain one terminal `tool.sandbox` observation
associated with the tool ID. `applied` is emitted only after the in-sandbox
bootstrap confirms that the real target process reached Node's `spawn` event;
wrapper startup alone is not sufficient. Before that handshake, a local
backend failure may fall back to normal execution. After it, KodaX never
restarts the target:

```ts
runtime.events.subscribe({ sessionId: session.id, type: 'tool.sandbox' }, (event) => {
  if (event.type !== 'tool.sandbox') return;
  const { observation } = event.payload.update;
  // observation.state: 'applied' | 'fallback' | 'not_selected'
  diagnostics.recordSandboxRoute(observation);
});
```

This event is optional diagnostics, not conversation content. It is never added
to model-visible messages. Default consumer UX should not render it in startup
output, command cards, notifications, or conversation history; expose it only
in an explicit advanced diagnostics view. KodaX's own Ink REPL does not
subscribe to the event and refreshes human-readable status only when the user
runs `/sandbox`. Explicit JSON output and SDK subscriptions retain the
structured event for professional diagnostics. `/sandbox` is read-only and
never activates the backend or requests elevation.

---

## Learned Skill promotion reference (v0.7.78)

Promotion is the explicit transfer of one immutable, reviewed `ready` or
`active_learned` Skill revision into the formal user catalog. It is not the
evidence-driven `testing -> active_learned` canary transition. The public named
service type is exported from the Runtime SDK:

```ts
import {
  createKodaXRuntime,
  type RuntimeLearningService,
} from '@kodax-ai/kodax/runtime';

const runtime = await createKodaXRuntime({
  requirements: {
    learningCenter: 1,
    skillLearningLoop: 1,
  },
});

const learning: RuntimeLearningService = runtime.learning;
const record = await learning.get('normalize-release-notes');

try {
  await learning.promote(record.capabilityId, 'user');
} finally {
  await runtime.close();
}
```

`name`, `slug`, and exact `capabilityId` are accepted. Exact IDs are preferred
when multiple projects expose the same display name or slug. `'user'` is the
only supported scope. Daemon clients need the server-issued
`learning:control` scope; advertising a client capability does not grant it.
Inline, Worker, and daemon facades carry the same v2 learned-record shape and
promotion method.

The Runtime verifies the source is a regular non-symlink file inside the exact
project Learned Area and that its content still matches the recorded
fingerprint. It then creates the configured user Skill destination—normally
`~/.kodax/skills/<slug>/SKILL.md`—with atomic exclusive-publish semantics.
Existing identical content is idempotent; the final path appears only after the
complete temporary file is synced. Different formal content returns an
`action_failed` error and is never overwritten. On success the canonical
project record changes to `promoted_user`.

Terminal users can inspect the same contract with:

```text
/learn promote --help
/learn help promote
/help learn promote
```

The canonical command is
`/learn promote <name|slug|capability-id> --scope user`; omitting the scope is a
backward-compatible shorthand for the same user scope. Unknown, duplicate, or
unsupported options fail before the Runtime mutation.

---

## See also

- [README.md](../../README.md) — end-user CLI quick start
- [docs/ADR.md ADR-024](../../docs/ADR.md#adr-024-npm-发布物正名-kodax-aikodax--sdk-subpath-exports-形式化-v0739) — SDK subpath architecture rationale
- [docs/ADR.md ADR-032](../../docs/ADR.md#adr-032-sdk-embedder-surface-closure-feature_186-v0742) — FEATURE_186 design record (all 8 phases)
- [docs/ADR.md ADR-057](../../docs/ADR.md#adr-057-large-compaction-is-an-always-on-context-scoped-full-coverage-transaction) — v0.7.74 compaction and exact-history ownership
- [docs/ADR.md ADR-058](../../docs/ADR.md#adr-058-model-agent-wait-is-mailbox-control-not-event-telemetry) — mailbox control versus Actor telemetry
- [docs/features/v0.7.42.md FEATURE_186](../../docs/features/v0.7.42.md#feature_186-sdk-embedder-surface-closure--kodax-space-gap-list--mcp-popout) — gap-by-gap landing matrix
- [docs/features/v0.7.74.md](../../docs/features/v0.7.74.md) — v0.7.74 release-candidate design and verification record
- [docs/features/v0.7.75.md](../../docs/features/v0.7.75.md) — v0.7.75 Windows GUI and Sidecar/Runtime stabilization candidate
- [docs/features/v0.7.77.md](../../docs/features/v0.7.77.md) — v0.7.77 adaptive-quality, governed-memory, and release-hardening record
