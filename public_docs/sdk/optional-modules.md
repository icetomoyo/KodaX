# Optional KodaX modules

These modules ship in `@kodax-ai/kodax` but are not needed to drive an agent.
Use one when your app needs what it does. Install and ESM notes are in the
[Overview](overview.md).

| Module | Entry | Use it to |
|---|---|---|
| [Artifact SDK](#artifact-sdk) | `/artifacts`, `/artifacts/client`, `/artifacts/runtime`, `/artifacts/kodax` | Render documents and images and read the pixels as evidence |
| [Sandbox](#standalone-sandbox) | `/sandbox` | Run your own commands inside the OS sandbox |
| [Media input](#media-input) | `/media` | Attach images, files or videos to a prompt in your process |
| [Skill learning](#background-skill-learning) | Host `learning.*` methods | Show and decide on the Skills KodaX learns |
| [Legacy memory](#legacy-governed-memory) | `/experimental-memory` | Keep an app on the old memory API until it is removed |

## Artifact SDK

The Artifact SDK opens, renders and inspects files, and returns the rendered
pages as PNG evidence an agent or a person can look at. Its nine operations
are `capabilities`, `prepare`, `create`, `open`, `edit`, `export`, `render`,
`capture` and `readEvidence`.

- PPTX: create, limited text and geometry edits, export (a copy of the file),
  render.
- PDF, PNG, JPEG, WebP and SVG: render to PNG.
- DOCX: render to pages. With a LibreOffice executable configured, the pages
  come from a real conversion. Without one they are a rough preview marked
  `unverified`.
- Local HTML at a fixed viewport, and SVG SMIL animation at given seconds:
  capture.
- GIF, video, spreadsheets and 3D have no default backend.

Rendering runs in a headless Chromium, so it works on a terminal-only machine.
Every operation except rendering a whole PNG image needs that Chromium. Call
`prepare()` to download one; nothing installs on its own.

### In your own Node process

`/artifacts/runtime` runs the operations in your process. You decide which
workspace it may touch.

```ts
import { createArtifactSdk, validateVisualEvidence } from '@kodax-ai/kodax/artifacts';
import { createNodeArtifactPort } from '@kodax-ai/kodax/artifacts/runtime';

const sdk = createArtifactSdk(createNodeArtifactPort({ workspaceRoot: process.cwd(), maxRenderPages: 4 }));
const result = await sdk.render({ path: 'report.pdf', pages: [1] });
if (result.evidence) {
  const raster = result.evidence.evidence[0]!;
  const image = await sdk.readEvidence({ source: result.evidence.source, raster });
  if (image.status === 'ready') show(`data:image/png;base64,${image.image.dataBase64}`);
  validateVisualEvidence(result.evidence, { kind: 'paginated', source: result.evidence.source, pages: [1] });
}
```

`browserExecutable` and `libreOfficeExecutable` are options of the port, set by
your code. A model request can never choose them.

### Through a Host

To let the Host's agents use the operations, register the tools once in a
Host extension, for example `<data root>/extensions/artifacts.mjs`:

```js
import { registerArtifactTools } from '@kodax-ai/kodax/artifacts/kodax';
import { executeManagedProcess } from '@kodax-ai/kodax/coding';

export default (api) => registerArtifactTools(api, { execute: executeManagedProcess, nodeExecutable: process.execPath });
```

This adds nine `artifact_*` tools and an artifact-review Skill. A Host that is
already running loads the extension when it restarts. `nodeExecutable` must be
a real Node.js, not your Electron executable.

`/artifacts/client` drives those tools from a client.
`createKodaXArtifactHostPort(client, sessionId)` takes a `KodaXHostClient`
(protocol v2), starts one tool Run per operation and reads the PNG by the blob
its tool item names, checked against the hash the tool reported. The v1 port
`createKodaXArtifactPort` takes a `KodaXProductClient` and goes away with the
v1 client in v0.7.100. Neither port runs anything
locally and never replays an operation whose outcome is unknown.

- `ready` means the pixels exist. It never means they look right; the agent or
  a person still reviews them.
- Pass an `AbortSignal` to stop an operation. Stopping does not undo files it
  already created.
- A packaged Electron app must keep the package's `dist/artifacts` folder as
  real files outside `asar`, and ship a real Node.js.

Formats, limits, errors and setup are in [Artifact SDK](../../docs/ARTIFACT_SDK.md).

## Standalone sandbox

The sandbox that contains KodaX's own shell commands is also yours to use.
`/sandbox` runs a command you choose with the filesystem, network,
environment, time and output limits you set.

| Platform | Backend | Needs |
|---|---|---|
| Windows | A restricted user account | A one-time setup, which may ask for UAC |
| macOS | Seatbelt (`sandbox-exec`) | `ripgrep` |
| Linux | bubblewrap | `bubblewrap`, `socat`, `ripgrep`, and unprivileged user namespaces |

### Check and set up

```ts
import {
  activateKodaXSandbox,
  doctorKodaXSandbox,
  getKodaXSandboxCapability,
  getKodaXSandboxSetupGuidance,
} from '@kodax-ai/kodax/sandbox';

const capability = getKodaXSandboxCapability(); // backend, ASRT version, controls
const doctor = await doctorKodaXSandbox();
if (!doctor.ready) {
  show(getKodaXSandboxSetupGuidance(doctor));
  // Only when the person clicks "Set up sandbox". On Windows this may show UAC.
  const outcome = await activateKodaXSandbox();
  if (outcome.status !== 'ready') show(outcome.guidance);
}
```

- `doctorKodaXSandbox()` checks readiness. It never sets anything up.
- `activateKodaXSandbox()` sets up the sandbox on Windows. Elsewhere it
  returns `unavailable` with guidance. Call it only from a setup
  screen the person chose to open. Never call it at startup, during a tool
  call or in a background check.
- On Linux and macOS, show the guidance for the missing packages. Do not run
  `sudo` or a package manager for the person, and do not change sysctls or
  AppArmor silently.
- Do not make readiness a gate for ordinary work. Without a ready sandbox,
  authorized work still goes through the normal permission rules.

### Run a command

```ts
import os from 'node:os';
import path from 'node:path';
import { getKodaXSandboxSetupGuidance, runKodaXSandboxed } from '@kodax-ai/kodax/sandbox';

const result = await runKodaXSandboxed({
  command: process.execPath,
  args: ['scripts/generate-report.mjs'],
  cwd: projectDir,
  filesystem: {
    allowRead: [projectDir, process.execPath],
    allowWrite: [projectDir, os.tmpdir()],
    denyWrite: [path.join(projectDir, '.git', 'config')],
  },
  network: { mode: 'allowlist', origins: ['https://api.example.com'] },
  inheritEnvironment: false,
  env: { REPORT_FORMAT: 'pdf' },
  timeoutMs: 120_000,
  maxOutputBytes: 2 * 1024 * 1024,
});

if (result.status === 'unavailable') {
  // Nothing ran. Decide whether to wait for setup, refuse, or run another way.
  show(getKodaXSandboxSetupGuidance(result.doctor));
} else if (result.status === 'execution_uncertain') {
  // The command may have started. Do not retry it blindly.
  throw new Error(result.diagnostic);
} else if (result.exitCode !== 0) {
  throw new Error(result.stderr);
}
```

| Option | Meaning |
|---|---|
| `filesystem.allowWrite` | The only roots where the command may create, change or delete files. |
| `filesystem.denyWrite` | Roots removed from `allowWrite`. It always wins. |
| `filesystem.allowRead` | Roots the command needs to read. Ordinary reads are allowed anyway. |
| `filesystem.denyRead` | Roots the command may not read. POSIX only; see below. |
| `network` | `{ mode: 'allow' }`, `{ mode: 'deny' }`, or `{ mode: 'allowlist', origins }` with exact HTTP(S) origins. |
| `inheritEnvironment` | `true` by default. `false` gives the command a minimal environment plus `env`. |
| `timeoutMs` | Covers the whole run: sandbox start, the command and cleanup. |
| `maxOutputBytes` | Caps the captured output. |
| `signal` | Cancels the run. |

Relative roots resolve against `cwd`. Make sure every root you pass exists.

`command` and `args` stay separate. On Windows no shell parses them, so `%VAR%`,
`&` and quotes reach the command unchanged.

Invalid input, such as an empty `command`, throws. On Windows, a sandbox that
fails to start or run throws too. Otherwise the result is one of three:

- `completed`: the command ran in the sandbox. You get `exitCode`, `stdout`
  and `stderr`.
- `unavailable`: the command did not run, and `sandboxed` is `false`. `reason`
  says why: `doctor_not_ready` (not ready), `backend_launch_failed` (the
  sandbox could not start the command) or `unsupported_policy` (this platform
  cannot enforce what you asked).
- `execution_uncertain`: the command may have started, but KodaX could not
  prove how. Do not run it again blindly.

`runKodaXSandboxed` never runs a command outside the sandbox. Running it
unsandboxed after `unavailable` is your choice, and you should not report that
run as sandboxed.

### Reads on Windows

On POSIX, `denyRead` takes away read access. The Windows backend cannot
enforce read limits, so on Windows a non-empty per-command `denyRead` returns
`unavailable` with reason `unsupported_policy` before anything is set up or
started.

The same limit applies to agents published over A2A whose tool policy admits
Skill scripts (`toolPolicy.skillScripts`). They run those scripts on a
stricter isolated route that never falls back to running unsandboxed. On the
current native protocol 10 that route is POSIX-only; on Windows it is
unavailable, because it needs a per-command `denyRead`.

For how KodaX uses the sandbox for its own commands, see
[Sandbox](../configuration/sandbox.md).

## Media input

`/media` builds the input artifacts a prompt carries in your process: images,
and the shapes for files and videos. A Host client uploads images as blobs
instead; see [Images and attachments](host-client.md#images-and-attachments).

```ts
import { runKodaX } from '@kodax-ai/kodax/coding';
import {
  createImageArtifactFromPath,
  getModelInputCapabilities,
  readAndNormalizeClipboardImage,
  validateInputArtifactsForModel,
} from '@kodax-ai/kodax/media';

const caps = getModelInputCapabilities({ provider, model });
if (!caps.image.sdkSupported) disableImageDrop();

// null when the clipboard has no image, or the model takes none
const pasted = caps.image.sdkSupported ? await readAndNormalizeClipboardImage() : null;
if (pasted) {
  const stored = await myImageStore.write(pasted.buffer, pasted.mediaType);
  const artifact = createImageArtifactFromPath(stored.path, { mediaType: pasted.mediaType, source: 'clipboard' });
  validateInputArtifactsForModel([artifact], { provider, model });
  await runKodaX({ provider, model, context: { inputArtifacts: [artifact] } }, promptText);
}
```

### What a model accepts

`getModelInputCapabilities({ provider, model })` answers for one provider and
model together. The same model name behind another route is not assumed to
take images. A custom provider registered with `imageInput: true` counts as
taking images.

| Field | Meaning |
|---|---|
| `image.status: 'supported'` | KodaX can send images to this model. |
| `video.status: 'provider-native-unwired'` | The model takes video, but KodaX does not send video yet. |
| `file.status: 'unsupported'` | KodaX does not send files yet. |

`validateInputArtifactsForModel()` applies the same rules and throws
`KodaXMediaError` with a stable `code` and a `detail`. Use them to disable
sending or explain why. To use a file anyway, extract its text yourself and
put the text in the prompt.

### Artifacts

`KodaXInputArtifact` is one of three kinds, each with a `path`:

- `image`: PNG, JPEG, WebP or GIF. Built with `createImageArtifactFromPath()`.
- `file`: built with `createFileArtifactFromPath()`.
- `video`: MP4, MPEG, MOV, AVI, FLV, WebM, WMV or 3GP. Built with
  `createVideoArtifactFromPath()`, which throws `KodaXMediaError`
  (`UNSUPPORTED_MEDIA_TYPE`) when the type is unknown.

- Clipboard images come out as static PNG or JPEG. An animated GIF may lose
  its animation.
- A GIF sent from a path stays a GIF. How the model treats animation is up to
  the provider.
- `validateInputArtifactsForModel()` checks shapes and the model only. It does
  not look at the files.

### Follow-up input during a run

To add input with images to a run that is still going in your process, use
`enqueueWithArtifacts({ provider, model, sessionId, content, inputArtifacts })`.
It validates first, then queues the input for that run. Pass
`sessionId` when more than one Session can run at once; without it, the call
fails when two runs are active rather than guess. This queue lives in your
process only. A Host client sends follow-up input through the Host.

## Background Skill learning

After a root run ends, KodaX reviews the Session in the background. Besides
memory notes (see [Memory](../configuration/memory.md)), the review can
propose a Skill for a procedure that verifiably worked in that Session.

- The review uses the Session's own provider and model, at most ten calls a
  day. It does not run for CLI bridge providers.
- If your process passes its own `learningReviewer` or `memoryReviewer` to
  `runKodaX`, the built-in review does not run.
- A proposed Skill starts as `ready`. It is not used until the person decides.
- A correction or a failure is evidence for memory. On its own it never
  changes a Skill.

### Lifecycle and decisions

A learned capability has a `lifecycle`: `opportunity`, `drafting`, `ready`,
`testing`, `active_learned`, `promoted_user`, `quarantined`, `archived` or
`rejected`. The person's decisions move it:

| Decision | Effect |
|---|---|
| trust | Use it from now on, with no trial (`active_learned`). |
| review | Put it on trial: the Host uses it a few times and watches how it fares (`testing`). |
| reject, disable | Stop using it. |
| rollback | Go back to the last good revision. |
| promote | Make it one of the person's own Skills (`promoted_user`). |

Whether a person has seen a change is kept per client, through
`learning.acknowledge` and `learning.snooze`. The lifecycle is the same for
every client.

### Promotion

Promotion copies one reviewed `ready` or `active_learned` revision into the
person's Skills, normally `<data root>/skills/<slug>/SKILL.md`.

- The source must still match the fingerprint recorded for that revision.
- A file with the same content already there counts as success.
- A different Skill already there fails with `action_failed` (over the Host,
  `internal`) and is never overwritten.
- `user` is the only scope.

### Where to read and decide

- A Host client uses the `learning.*` methods: `learning.list`,
  `learning.get`, `learning.snapshot` for a badge, `learning.events`, and the
  decisions above. See [Memory and learning](host-platform.md#memory-and-learning) and the
  [Host protocol reference](host-protocol-reference.md).
- In the terminal: `/learn`, `/learn trust <name>`, and
  `/learn promote <name> --scope user`.

Do not scan the learned files to decide what is active. A Skill is active only
when its record says so and its file still matches.

## Legacy governed memory

`/experimental-memory` is the API of the earlier governed memory. KodaX now
uses note memory by default (see [Memory](../configuration/memory.md)), and
`KODAX_MEMORY_NOTES=0` brings the governed memory back. This entry stays only
for that fallback and will be removed with it. Do not start new work on it.
A Host client manages the person's memory with the Host's memory methods;
see [Memory and learning](host-platform.md#memory-and-learning).

```ts
import { createMemoryAgent, createMemoryControlPlane } from '@kodax-ai/kodax/experimental-memory';

const identity = { tenantId: 't:acme', workspaceId: 'w:desktop', userId: 'u:42', agentId: 'a:reviewer', projectId: 'p:app', sessionId: 's:1' };
const memory = createMemoryAgent({ controlPlane: createMemoryControlPlane({ cwd: process.cwd(), identity, projectDocs: [], discoverSkills: false }) });

await memory.remember({ statement: 'Run npm run build before release.', evidenceRef: 'host:user-request:42' });
const session = await memory.startSession({ identity, objective: 'Review the shutdown change' });
const hint = session.recall({
  decisionRevision: 'd1',
  objective: 'Review the shutdown change',
  decisionContext: 'Choosing which checks to run',
  decisionIntent: 'verify',
  throughSequence: 0,
});
await session.complete({ status: 'succeeded', summary: 'Verified', evidence: [] });
await session.close();
```

- `list()`, `remember()` and `forget()` manage accepted memory. `remember()`
  answers with a `status`: `remembered`, `updated`, `already_known`,
  `needs_clarification`, `needs_review` or `rejected`.
- Supply your own durable `evidenceRef`. Do not pass model text off as the
  person's request.
- `recall()` is synchronous. `query()` is a deliberate, read-only lookup.
  Both return `undefined` when there is nothing to add.
- Recalled memory is weak evidence. Current facts still come from tools and
  the repository.
- Identities must match exactly. Never put credentials in them.
