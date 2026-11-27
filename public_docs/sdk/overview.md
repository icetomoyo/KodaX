# KodaX SDK overview

This is the entry page for building on KodaX. It covers installing the
package, choosing a package entry, where KodaX keeps its data, and what a
Windows or Electron app must do. The other guides take it from there:

| Guide | For you if you |
|---|---|
| [Build a client of a Host](host-client.md) | Write a UI or tool that talks to a KodaX Host: a Node app, a desktop app or a web page. |
| [Platform backends](host-platform.md) | Run a backend next to a Host that lends keys and tools, starts agents, manages memory, or speaks A2A or ACP. |
| [Run KodaX in your process](in-process.md) | Call the agent, sessions, prompts, models, MCP, Skills or workflows as libraries inside your own process. |
| [Optional modules](optional-modules.md) | Need artifact rendering, the standalone sandbox, media input, or the legacy memory API. |
| [Host protocol reference](host-protocol-reference.md) | Need every v2 method with its params and result. |

To run a Host for other people, see [Run a KodaX Host](../deployment/host.md).
To reach your own Host from a phone, see [Remote access](../deployment/remote-access.md).

## Install

```bash
npm install @kodax-ai/kodax
```

- Node.js 22.4 or later. This includes the Node.js inside Electron when your
  Electron main process loads KodaX.
- One package. Every entry below is a subpath of `@kodax-ai/kodax`; there is
  no second package to install.
- ESM only. The package declares only the `import` condition, so `require()`
  of any entry fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Load it from CommonJS

An Electron main process, or a bundle built with `format: 'cjs'`, is
CommonJS. Load KodaX there with a dynamic `import()`:

```ts
// Types are erased at compile time, so a type-only import is fine in CommonJS.
import type { KodaXHostClient } from '@kodax-ai/kodax/client';

let host: KodaXHostClient<'local'> | undefined;

async function startKodaX(): Promise<void> {
  const { ensureKodaXHostClient } = await import('@kodax-ai/kodax/client');
  host = await ensureKodaXHostClient({ client: { name: 'my-app', version: '1.0.0' } });
}
```

Use `import type` for types. A plain `import { ... }` that names a value
becomes a `require()` call in CommonJS output.

Many bundlers turn `await import(x)` into `require(x)` when they emit
CommonJS. Keep KodaX out of the bundle so the dynamic import survives:

- esbuild: `external: ['@kodax-ai/kodax', '@kodax-ai/kodax/*']`.
- webpack: list each subpath you use in `externals`.
- Vite (SSR or Electron main builds): add them to `ssr.external`.

If you still see `ERR_PACKAGE_PATH_NOT_EXPORTED`, the bundler rewrote the
import. Fix the bundler settings first.

## Package entries

| Entry | What it is for | Guide |
|---|---|---|
| `@kodax-ai/kodax/client` | The v2 Host client for Node: `ensureKodaXHostClient` starts or joins the Host on this machine, `connectKodaXHost` reaches one over the network. Also the older v1 product client. | [Host client](host-client.md), [Platform backends](host-platform.md) |
| `@kodax-ai/kodax/browser` | The v2 Host client for a web page: `connectKodaXHost`, with no Node dependency. | [Host client](host-client.md) |
| `@kodax-ai/kodax/a2a` | An A2A 1.0 client executor and an A2A server for a KodaX agent. | [Platform backends](host-platform.md) |
| `@kodax-ai/kodax/coding` | The coding agent as a library: `runKodaX`, coding tools, prompts, extensions, workflows. | [In-process](in-process.md) |
| `@kodax-ai/kodax/agent` | The generic agent framework under the coding agent: Runner, sessions, Skills, MCP, data-root helpers. | [In-process](in-process.md) |
| `@kodax-ai/kodax/llm` | Providers and models: resolve a provider, read model capabilities. | [In-process](in-process.md) |
| `@kodax-ai/kodax/session` | Session files on disk: list, load, fork, rewind, delete and watch Sessions. | [In-process](in-process.md) |
| `@kodax-ai/kodax/skills` | Only the Skills part: discover, load, expand and run Skills. | [In-process](in-process.md) |
| `@kodax-ai/kodax/mcp` | Only the MCP part: transports, capability provider, catalog. | [In-process](in-process.md) |
| `@kodax-ai/kodax/repl` | The interactive terminal (Ink and React) and its configuration helpers, such as `loadConfig` and `listMcpServers`. Importing it loads Ink and React. | [In-process](in-process.md) |
| `@kodax-ai/kodax/media` | Image, file and video input artifacts, clipboard images, model input capabilities. | [Optional modules](optional-modules.md) |
| `@kodax-ai/kodax/sandbox` | Run your own commands inside the OS sandbox. | [Optional modules](optional-modules.md) |
| `@kodax-ai/kodax/artifacts`, `/artifacts/client`, `/artifacts/runtime`, `/artifacts/kodax` | Render and inspect documents and images (PPTX, PDF, DOCX, images, SVG, HTML) and read the pixels as evidence. | [Optional modules](optional-modules.md) |
| `@kodax-ai/kodax/experimental-memory` | The legacy governed memory API. Kept for rollback; it will be removed. | [Optional modules](optional-modules.md) |
| `@kodax-ai/kodax/runtime` | The v1 low-level Runtime (`ensureKodaXRuntime`, `connectKodaXRuntime`), plus `copyKodaXDataRoot` and provider credential helpers. | This page |
| `@kodax-ai/kodax` (root) | Everything in `/coding`, plus the terminal entry, the ACP server, the sandbox functions and the v1 Runtime. | Prefer a subpath |

Import from the narrowest entry that has what you need. A subpath loads less
than the root, and `/repl` is the only one that needs Ink and React.

## Two ways to use KodaX

**Talk to a Host.** A Host is one `kodax host serve` process. It owns one
person's settings, Sessions and memory, and runs their agents. Your app is a
client: it submits input, answers approvals and questions, and shows what the
Host reports. The CLI, the terminal UI and your app can all use the same Host
at once. Use this for products. See [Build a client of a Host](host-client.md)
and [Platform backends](host-platform.md).

**Run it in your process.** Call `runKodaX` and the other libraries directly.
Your process owns the run, its Session file and its approvals. Use this for
scripts, tests, servers that own their own agent loop, and agents built on
the framework. See [Run KodaX in your process](in-process.md).

### The v1 client

Before v2, apps used the v1 product client (`ensureKodaXClient`,
`connectKodaXClient`, `KodaXProductClient` from `/client`) or the low-level
v1 Runtime from `/runtime` (`ensureKodaXRuntime`, `connectKodaXRuntime`).
They still work. Host protocol v1 is removed in 0.7.100, or in 0.8.0 if that
comes first. Move to the v2 client before then.

- Do not mix them. A client uses one protocol, not both.
- [Protocol v2: v1 method mapping](../../docs/SDK_MIGRATION.md#协议-v2v1-方法对照未发布)
  maps each v1 call to its v2 method (Chinese).
- [Moving from the v1 client](host-client.md#moving-from-the-v1-client)
  covers the differences a UI notices.

## Where data lives

KodaX keeps everything for one person in one data root: settings, provider
keys, Sessions, memory, Skills and the Host's own state.

| Setting | Names | Data root |
|---|---|---|
| `KODAX_HOME` | the data root itself | the value. It must be an absolute path; a relative value is ignored. |
| `homeDir` option, CLI `--home` | the directory that holds `.kodax` | `<homeDir>/.kodax` |
| neither | | `~/.kodax` |

`homeDir: '/data/team'` and `KODAX_HOME=/data/team/.kodax` name the same data
root. `homeDir: '/data/team/.kodax'` names `/data/team/.kodax/.kodax`, which is
a different root with different Sessions.

**One Host per data root.** Every client that names the same root shares one
Host. `ensureKodaXHostClient({ homeDir })` joins it, or starts it when none
runs. A second `kodax host serve` on a root that a live Host owns exits with a
non-zero code. To serve two people, give each their own root and their own Host.

### In your own process

```ts
import { resolveKodaXHome } from '@kodax-ai/kodax/agent';

const home = resolveKodaXHome(); // { path, source: 'env' | 'default', ignoredEnv? }
if (home.ignoredEnv) warn(`KODAX_HOME=${home.ignoredEnv} is not absolute and was ignored`);
```

`resolveKodaXHome({ env?, homeDir? })` reads `KODAX_HOME` and changes nothing.
`ignoredEnv` holds a `KODAX_HOME` that was skipped because it is not absolute.

Library code in your process picks the data root in this order:
`setAgentConfigHome(path)`, then `KODAX_HOME`, then `~/.kodax`. Set
`KODAX_HOME` before your first import of KodaX, because some paths, such as
`KODAX_DIR` from `/repl`, are fixed when their module loads. Call
`setAgentConfigHome` once at startup, before any other KodaX call. It sets one
value for the whole process. Do not switch it per request or per tenant: Sessions,
credentials and memory all read the same root, so two tenants in one process
would share state. Serve each tenant from its own process or its own Host.

### Your app's own files

`getAppDataDir(appId)` (from `/coding` or `/agent`) gives your app its own
directory inside the data root, `<data root>/apps/<appId>/`, and creates it.

```ts
import { getAppDataDir } from '@kodax-ai/kodax/coding';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = getAppDataDir('my-app'); // ~/.kodax/apps/my-app/
writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify(windowState));
```

- `appId` must match `^[a-z][a-z0-9-]{1,31}$`: lowercase letters, digits and
  `-`, 2 to 32 characters, starting with a letter.
- `kodax` and names starting with `kodax-` are reserved and throw.
- It follows the same order as above, so a `setAgentConfigHome` call made
  first moves it too.
- Your app owns that directory. KodaX never writes to it, and migrating or
  cleaning it is up to you.

### Moving a data root

`copyKodaXDataRoot({ from, to, exclude?, onProgress?, signal? })` from
`/runtime` copies a data root to a new place:

```ts
import { copyKodaXDataRoot, KodaXDataRootCopyError } from '@kodax-ai/kodax/runtime';

try {
  const { files, bytes, rebasedFiles, skipped } = await copyKodaXDataRoot({ from: oldRoot, to: newRoot });
} catch (error) {
  if (error instanceof KodaXDataRootCopyError) showCopyError(error.code);
  else throw error;
}
```

- It copies and never moves. The source is only read, and the SDK never
  deletes it.
- The target must be missing or empty. It refuses (`host_running`) while a
  Host still uses the source, so stop every client first.
- Absolute paths to the old root inside `.json` and `.jsonl` files are
  rewritten to the new root.
- State that belongs to one machine or process, such as the Host's own
  runtime files and locks, is not copied.
- The copy selects nothing. Point your app at the new root afterwards, with
  `KODAX_HOME` or `homeDir`, before its first KodaX call.

The full rules, the list of what is not copied and the error codes are in
[Relocating a data root](../../docs/SDK_MIGRATION.md#relocating-a-data-root-copykodaxdataroot).

## Windows and Electron

### Keep the terminal's input

On Windows, a dev script that starts Electron with `stdio: 'inherit'` can leave
PowerShell or Windows Terminal unable to take keyboard input. KodaX does not
read stdin. The open input handle the Electron child inherits causes it. Give
the child no stdin:

```js
import { spawn } from 'node:child_process';

const electron = spawn(electronBin, [appEntry], {
  stdio: ['ignore', 'inherit', 'inherit'], // stdin: 'ignore', not 'inherit'
  shell: false,
});
```

To check that KodaX is not the cause, run
[`scripts/probe-sdk-stdin.mjs`](../../scripts/probe-sdk-stdin.mjs) from a KodaX
checkout, optionally with the path to an installed `dist` folder. It imports
every entry and reports any change to stdin listeners or raw mode.

### Background processes

You need no console-hiding code around KodaX. The processes KodaX starts in
the background, such as Git probes, provider CLIs, language servers and
sandbox helpers, ask Windows to hide their window. Editors, terminals and
commands meant to be interactive still open one.

### Packaged Electron apps

KodaX loads native helpers from files on disk, and it cannot read them from
inside an `asar` archive. Unpack them. With `electron-builder`:

```json
{
  "asar": true,
  "asarUnpack": [
    "node_modules/@kodax-ai/kodax/dist/native/**/*",
    "node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/**/*",
    "node_modules/**/@anthropic-ai/sandbox-runtime/vendor/srt-win/**/*"
  ]
}
```

KodaX looks for each file under `app.asar.unpacked`. A file that is missing
there fails with a message that names it, before any sandboxed process starts.
The artifact renderers have their own needs; see
[Optional modules](optional-modules.md#artifact-sdk).

## Develop against a local KodaX checkout

To try your app against an unreleased KodaX, link a local checkout:

```bash
# In the KodaX checkout
npm install
npm run build     # the link points at dist/, not the sources
npm link

# In your app
npm link @kodax-ai/kodax
```

- Run `npm run build` again after each change in KodaX, then restart your app.
- To undo: `npm unlink @kodax-ai/kodax` in your app, then
  `npm unlink -g @kodax-ai/kodax`.
- For a snapshot instead of a live link, run
  `node scripts/release.mjs --pack-only` in KodaX and `npm install` the
  `.tgz` it writes. That tarball is for local testing only: it holds the
  native helpers for your own platform, and npm refuses to publish it.

## More

- [Client contract](../../docs/CLIENT_CONTRACT.md): what a client may rely on
  and what it must do, in full.
- [SDK and Host seams for desktop apps](../../docs/SPACE_SDK_SEAMS.md):
  authorization in a trusted main process, Fork, Retry and Rewind, Host
  configuration, attachments and statistics.
- [Artifact SDK](../../docs/ARTIFACT_SDK.md): supported formats and setup.
- [SDK migration](../../docs/SDK_MIGRATION.md): old calls and their
  replacements (mostly Chinese).
- [CHANGELOG](../../CHANGELOG.md): what changed in each release.
