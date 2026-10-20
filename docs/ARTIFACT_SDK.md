# Artifact SDK

Artifact APIs ship inside the single ESM package `@kodax-ai/kodax` (Node >=20.16).
`packages/artifacts` remains a private source workspace; it is not a separate
npm delivery target. The pure SDK entry contains types, validation, dispatch and
mechanical coverage checks. Renderer loading and Chromium preparation remain
outside core startup.

| Public subpath | Responsibility |
| --- | --- |
| `@kodax-ai/kodax/artifacts` | Pure SDK/types and evidence validation |
| `@kodax-ai/kodax/artifacts/client` | Bind to the existing Product Client/Session |
| `@kodax-ai/kodax/artifacts/runtime` | Explicitly authorized standalone Node file/browser work |
| `@kodax-ai/kodax/artifacts/kodax` | Register managed tools in the existing trusted Host |

## Delivery status and installation (2026-10-18)

The unified operations were implemented in `27d08788` and included in the
`v0.7.97-alpha.5` source release. On 2026-10-18 the user selected **one npm
package**, replacing FEATURE_301's earlier separate-package distribution plan.

| Delivery surface | Status |
| --- | --- |
| npm `@kodax-ai/kodax@0.7.97-alpha.7` | Published and reported installed by Space; does not contain these new Artifact subpath exports |
| Current local main-package tarball | Contains the four exports and required resources; local verification only, not a new npm release |
| `@kodax-ai/artifacts` | E404 at the earlier registry check; retired as a public npm target, not something Space should install |

Build and pack the main SDK from this checkout:

```sh
npm ci
node scripts/release.mjs --pack-only
```

Install that **one** tarball in Space, quoting paths with spaces on Windows:

```sh
npm install /absolute/path/to/kodax-ai-kodax-0.7.97-alpha.7.tgz
```

Preserve it in Space's normal reproducible dependency-delivery location. Once a
new version containing these exports is actually published, use
`npm install @kodax-ai/kodax@<new-version>` instead. Reinstalling the already
published alpha.7 from the registry does not add these local changes. Installation
includes renderer dependencies/resources but does not register tools, launch a
browser or download Chromium.

### Build, audit and release

The existing `npm run build` builds the private workspace and DOCX browser
bundle, then stages its JS, declarations, worker, skill and license under
`dist/artifacts/`. Its nested `dist/` and `skills/` directories preserve the
existing runtime-relative resource paths. Do not bundle just the four JS
exports and discard that layout. Root dependencies pin the same renderer
versions as the workspace; the build rejects drift. The main package's declared
Node floor is now 20.16 to match the Artifact runtime.

`release.mjs --skip-build --pack-only` requires a complete current build.
The existing main-tarball audit checks all four JS/type exports, worker, DOCX
bundle, skill, license and declared renderer dependencies. An absent/empty
resource fails packaging. Local host-only native tarballs retain
`private: true` and are for installation testing; normal publishing still uses
the universal CI candidate.

```sh
node --test tests/packed-artifacts.test.mjs
# Optional local npm inspection; does not publish:
npm publish ./kodax-ai-kodax-0.7.97-alpha.7.tgz --dry-run --access=public --tag=alpha --registry=https://registry.npmjs.org/
```

Set `KODAX_ARTIFACT_TEST_BROWSER` to a trusted compatible Chromium executable
for installed PPTX/PDF/DOCX pixel checks. The packed test also imports all four
entries, exercises the worker/skill and PNG reads, compiles a pure SDK consumer
without Node ambient types, and rejects missing DOCX resources. DOCX candidate
pixels retain `unverified` fidelity status.

The Release workflow produces one `kodax-ai-kodax-<version>.tgz`, runs the
installed Artifact gate on it, and attaches its existing
`kodax-ai-kodax-npm.sha256`. It does not publish to npm. After a new Release
containing this change exists, the existing `node scripts/release.mjs --dry-run`
verifies the CI bytes; a later authorized `node scripts/release.mjs` publishes
that one package. Prereleases use their version tag (alpha/beta/rc), stable
versions use latest. No independent Artifact archive, checksum or publish command
remains; the obsolete `--artifacts` flag is rejected.

This is a local delivery change, not an actual npm release or Space deployment.
The complete model-driven repair loop and native Office fidelity retain their
previous verification limits.

## Operations and actual support

| SDK method | Current implementation |
| --- | --- |
| `capabilities()` | Format/operation availability and diagnostics; no installation or renderer launch |
| `prepare(signal?)` | Explicit compatible Chromium preparation; custom executables remain the trusted host's responsibility |
| `create`, `edit`, `export` | Existing PPTX authoring, limited text/geometry repair, exclusive new output; no new-format editors |
| `open` | Content-identified PPTX/PDF/DOCX/PNG/JPEG/WebP/SVG/HTML identity; PPTX object inspection; intrinsic PPTX/PDF page count |
| `render` | PPTX, native PDF, exact PNG bytes, JPEG/WebP/SVG rasters, candidate DOCX pagination |
| `capture` | Static image/SVG regions; PDF/DOCX pages; local HTML `loaded` state at explicit viewport, sequence `0`; actual SVG SMIL seconds |
| `readEvidence` | Provenance/current file and dependency hashes, actual PNG hash/geometry/bounds, then PNG data as base64 |

Missing capability records do not imply support. Native Word/WPS fidelity remains **unverified** for every DOCX render, even when useful page pixels exist. DOCX `open` has no `pages`; pagination belongs to `evidence.layout.totalPages`. Minimal documents without settings are normalized only in the rendering snapshot; source bytes stay unchanged. Fields, floating objects, complex sections and native Office pagination need reference validation.

PPTX geometry uses inches. Text/rectangle colors are six hexadecimal digits without `#` (for example, `172C45`). `edit` uses inspected `page/objectId`, the current `expectedSourceHash` and an exclusive new `output`. Text replacement supports a single run in a single paragraph; rich-run/multi-paragraph text needs another compatible editor. Geometry edits retain their existing bounds and grouped-object limitations. Use `render({ path, pages })` for PPTX page evidence; PPTX does not implement `capture`.

PDF.js captures page content at 96 DPI, adapting the viewport for each page's dimensions/rotation. Form interaction and annotation appearance are outside the current capture. PNG render preserves original alpha/bytes; explicit image/SVG capture backgrounds use Chromium. HTML captures its authored CSS background and only the observed loaded viewport, not interaction behavior. SVG samples cover SMIL, not script/CSS animation, continuous playback or audio. Animated WebP, GIF/video, spreadsheet calculation/native display, EPUB, desktop/mobile/terminal and 3D/CAD have no default backend.

Supported file rendering runs headlessly: a terminal-only system can produce PNG evidence and send it to an image-capable provider without a desktop UI. This does not add capture of the terminal UI itself. The selected operation still needs its runtime dependencies and normal Host authorization.

`capture` uses matching `kind` and `locators`; fields from another kind are rejected. Current file backends accept these scopes:

| Input | Kind and locator |
| --- | --- |
| PNG/JPEG/WebP/static SVG | `static`: optional `region: [x, y, width, height]` in pixels |
| PDF/DOCX | `paginated`: `page` (one-based); sheet/range capture has no default backend |
| Local HTML | `interactive`: actual `target`, `state: 'loaded'`, explicit `viewport: [width, height]`, `sequence: 0` |
| SVG SMIL | `temporal`: `time` in seconds; samples do not certify continuous playback |

For example, `sdk.capture({ target: 'diagram.svg', kind: 'static', locators: [{ kind: 'static', region: [0, 0, 320, 180] }] })` requests actual region pixels. `expectedSource`, when supplied, must be the current `VisualSource`, not a bare file hash. Use the public SDK types/validation; the model-facing locator schema still has a documented [schema/decoder mismatch](ARTIFACT_SDK.md#tool-schema-gaps).

## Trusted standalone Node host

```ts
import { createArtifactSdk, validateVisualEvidence } from '@kodax-ai/kodax/artifacts';
import { createNodeArtifactPort } from '@kodax-ai/kodax/artifacts/runtime';

const sdk = createArtifactSdk(createNodeArtifactPort({
  workspaceRoot: process.cwd(), maxRenderPages: 4,
}));
const capabilities = await sdk.capabilities();
// Explicitly call sdk.prepare() if the selected browser operation is not prepared.
const result = await sdk.render({ path: 'report.pdf', pages: [1] });
if (result.evidence) {
  const raster = result.evidence.evidence[0]!;
  const image = await sdk.readEvidence({ source: result.evidence.source, raster });
  if (image.status === 'ready') {
    const dataUrl = 'data:image/png;base64,' + image.image.dataBase64;
    // Display dataUrl or pass its actual bytes to the host's existing image input.
  }
  validateVisualEvidence(result.evidence, {
    kind: 'paginated', source: result.evidence.source, pages: [1],
  });
}
```

Browser/LibreOffice executable paths and workspace authority belong to trusted runtime options, never model request JSON. LibreOffice is optional for PPTX conversion only; other supported formats do not require it. Render capability records include `backend: 'lightweight' | 'libreoffice'`; select by operation, format and backend. LibreOffice availability checks the configured absolute file and browser presence without launching either; its identity/version is checked during rendering. Preparation may download the pinned Playwright browser and write its cache; ordinary permission/sandbox rules apply. Querying/rendering never installs implicitly.

## Existing shared KodaX Host

KodaX's shared Agent guidance calls for visual review during applicable tasks without requiring a user slash command. File backend availability still requires this optional adapter to be registered once in the trusted Host and a provider that accepts actual images. Building/linking the workspace alone does not register it in a user's Host. SDK `render/capture/readEvidence` prepare and deliver evidence; the calling Agent owns visual judgment, repair and final review. Missing capabilities remain unverified. See [natural-task model observations and current integration gaps](test-guides/FEATURE_301_v0.7.97_TEST_GUIDE.md#natural-task-observations-2026-10-13).

Register once in the trusted Host extension, using its admitted managed execution:

```ts
import { registerArtifactTools } from '@kodax-ai/kodax/artifacts/kodax';
import { executeManagedProcess } from '@kodax-ai/kodax/coding';
export default api => registerArtifactTools(api, {
  execute: executeManagedProcess, nodeExecutable: process.execPath,
});
```

For Space, the Node Host extension must resolve the same installed main package
as Space's client integration. An extension in the user's home does not
automatically resolve Space's private `node_modules`. Use the existing extension
loader's dependency layout, or an absolute file URL resolved from the installed
`@kodax-ai/kodax/artifacts/kodax` and coding subpaths. Avoid source workspace paths.

Place the extension in `<Host homeDir>/.kodax/extensions/artifacts.mjs` (or the
Host's existing configured extension directory), using the same home/profile
as Space's connection. `process.execPath` above is evaluated inside the Node
Host; it must identify Node, not Space's Electron executable. Extensions are
loaded by the existing Host lifecycle: a Host already running without this
extension needs its normal safe shutdown/start before the registration appears.
Check `client.catalog.extensions()` for load errors and `sdk.capabilities()`
for actual backend readiness. Registration exposes nine `artifact_*` tools
and the packaged artifact-review skill; installing the tarball alone does not.

Then bind to the existing Product Client/session:

```ts
import { createArtifactSdk } from '@kodax-ai/kodax/artifacts';
import { createKodaXArtifactPort } from '@kodax-ai/kodax/artifacts/client';
const sdk = createArtifactSdk(createKodaXArtifactPort(client, sessionId));
const capabilities = await sdk.capabilities();
// Explicit user/Host-authorized preparation when browser operations need it:
// await sdk.prepare();
```

Space Main owns this connection, Session authorization and IPC forwarding.
The Renderer consumes returned data/images through Space's existing bridge.
Keep the package's complete `dist/artifacts` resource tree and renderer dependencies,
as physical files accessible to the Host worker; its file-relative resources
cannot be replaced by bundling only the JS exports. A packaged Electron app
must provide an actual Node executable and unpack these worker/runtime assets
from ASAR. End-to-end Electron/Space packaging is not validated by this local
tarball test. PNG whole-image evidence needs no browser; PPTX/PDF/DOCX and other
browser-backed operations need compatible Chromium, prepared explicitly with
`sdk.prepare()`/`artifact_prepare` or supplied by the trusted Host.

The port uses `runs.startTool/await/stop`, correlates the actual tool-call identity and its formal metadata, then reads PNG chunks through `sessions.readItem`. Image bytes are absent from worker stdout, `lastText`, history text and logs. The tool delivers existing image content blocks to agents. The client returns the same `image` shape as the Node port after hashing its assembled bytes. There is no local fallback, extra Session owner, automatic replay, new Artifact Product Client domain or model call.

`executeManagedProcess` binds fixed argv through the admitted Host scope, including when extension and CLI use separate bundles. Missing bindings are rejected before shell execution. Permissions, sandbox, cancellation and settlement remain on the normal checked Bash path.

## Evidence, errors and lifecycle

File `sourceHash` always means SHA256 of actual source bytes. `source.dependencies` records resources actually fetched; a changed source/dependency invalidates reading old evidence. Surface provenance uses target, observation time and an optional owner-proven revision, without a file hash; default Node surface capture is unsupported. Custom owner ports may return that shared contract.

Rasters include PNG hash, dimensions and exact locator. Paginated batches include actual total pages and captured page geometry/rotation/scale. `background` is checked when required. Adjacent `.png.evidence.json` files bind returned rasters to their source, and share the caller-owned output lifecycle with the PNG; keep both until reading completes. Rendering closes its browser/context on return/cancel, without a persistent renderer/cache. File/ZIP, image byte/pixel, dependency, page/batch and browser-time limits bound work. The Host uses four-page/capture batches; request page 1 first to discover DOCX pagination and then choose subsequent batches.

Each operation's `ready` type requires its payload. Malformed JSON, invalid paths, altered manifests/provenance and stale/corrupt evidence reject. Known missing capabilities and fidelity gaps return `unverified` with diagnostics/available pixels. `ready` and `validateVisualEvidence` only describe evidence readiness/coverage; the existing agent or host still reviews actual pixels. They never certify visual quality.

Pass an `AbortSignal` to any SDK operation. The Host port stops only its admitted Run and awaits settlement; busy/disconnected/unknown outcomes reject and are never replayed. Cancellation does not promise rollback of already-created files. Browser and child cleanup stay with their existing owning host. A Host without the attachment-read capability fails explicitly; update the Host rather than reading its filesystem from a UI.

## Integration gaps recorded on 2026-10-13

At source `27d08788`, GLM-5.3-Flash and DeepSeek Flash autonomously rendered an
ordinary PPT edit and received actual current PNG bytes in a shared test Host
with the adapter explicitly enabled. Grounded title-occlusion findings were
observed; complete repair/re-review/delivery was not proven under the recorded
call limits, output-budget calibration and provider failures. The earlier Kimi
smoke explicitly requested review and cannot prove automatic task-triggering.
See [natural-task observations and diagnostic rounds](test-guides/FEATURE_301_v0.7.97_TEST_GUIDE.md#natural-task-observations-2026-10-13).

The inspected local default CLI extension directories contained `read_pdf` but
no Artifact registration. Building/linking the workspace does not register
`registerArtifactTools`; configured extensions are loaded through the existing
Host lifecycle. This local configuration check does not establish that every
CLI lacks rendering tools. The user's separate observation that Space triggers
review was not independently tested against that Space configuration. Automatic
review when tools are enabled does not prove default CLI capability exposure.

### Tool schema gaps

The model-facing capture locator schema advertises fields from all four kinds in
one object, while the SDK decoder rejects fields outside the selected kind. A
GLM static locator containing `state`, `sequence` and `target` reproduced
`Unknown artifact field.` with the real adapter/decoder, without another model
request. Use the kind-specific SDK shapes above; do not infer accepted field
combinations from that broad tool schema.

`readEvidence.source/raster` and `capture.expectedSource` also lack nested shape
guidance in the tool descriptions. PPT creation colors lack the six-digit,
no-`#` requirement there; a DeepSeek CSS-style color was rejected by the worker.
These are parameter-contract/diagnostic gaps, not evidence that visual triggering
is absent. Consistent schemas, precise errors, default/needed capability exposure
and natural-task closed-loop acceptance remain follow-up work; this migration
does not claim a production fix or complete visual acceptance.

## Migration from the initial PPT API

PPT operation inputs and their supported edits remain. `ArtifactRef.kind: 'presentation'` becomes content `format: 'pptx'`; evidence uses `source` instead of a bare batch `sourceHash`; file hashes retain their meaning. Capabilities are structured records instead of descriptive string maps. Rasters require actual dimensions, and paginated evidence requires layout. `capture` uses a kind-matched `locators` array instead of separate pages/states/times/viewport fields. Add `prepare` and `readEvidence`; do not hand-read returned paths in a shared Host UI. These are explicit pre-release contract changes, not alias-based compatibility layers. This delivery fix does not change package versions. Main-package publication of these new subpaths remains pending as recorded above.

See [implementation design](ADR.md#unified-artifact-execution-and-evidence-boundary) and [regression guide](test-guides/FEATURE_301_v0.7.97_TEST_GUIDE.md).
