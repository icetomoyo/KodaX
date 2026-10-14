# Artifact SDK

`@kodax-ai/artifacts` is an optional, independently installed ESM package (Node >=20.16). Its root entry contains pure types, request/result validation, SDK dispatch and mechanical coverage checks. The optional `/runtime` entry owns local file/browser work; `/kodax` registers admitted Host tools; `/client` binds the SDK to an existing KodaX Product Client. The core CLI does not load renderers or probe Chromium at startup.

This page describes the unified Artifact SDK shipped in `v0.7.97-alpha.5`
(developed in commit `27d08788`) and its current integration notes. The
`v0.7.97-alpha.4` tag (`a3e8d754`) does not contain these additions; an
installed npm package from that version does not include them.

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

For example, `sdk.capture({ target: 'diagram.svg', kind: 'static', locators: [{ kind: 'static', region: [0, 0, 320, 180] }] })` requests actual region pixels. `expectedSource`, when supplied, must be the current `VisualSource`, not a bare file hash. Use the public SDK types/validation. The model-facing static locator schema currently advertises `state/sequence/target` although the decoder accepts only `kind/region`; those extra fields reject. `readEvidence` requires structured `source/raster` arguments, and colors use six hexadecimal digits without `#`. See the [acceptance boundary](test-guides/FEATURE_301_v0.7.97_TEST_GUIDE.md#automatic-visual-review-acceptance-boundary).

## Trusted standalone Node host

```ts
import { createArtifactSdk, validateVisualEvidence } from '@kodax-ai/artifacts';
import { createNodeArtifactPort } from '@kodax-ai/artifacts/runtime';

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

KodaX's shared Agent guidance calls for visual review during applicable tasks without requiring a user slash command. File backend availability still requires this optional adapter to be registered once in the trusted Host and a provider that accepts actual images. Building/linking the workspace alone does not register it in a user's Host. SDK `render/capture/readEvidence` prepare and deliver evidence; the calling Agent owns visual judgment, repair and final review. Missing capabilities remain unverified. See the [automatic visual review acceptance boundary](test-guides/FEATURE_301_v0.7.97_TEST_GUIDE.md#automatic-visual-review-acceptance-boundary).

Register once in the trusted Host extension, using its admitted managed execution:

```ts
import { registerArtifactTools } from '@kodax-ai/artifacts/kodax';
import { executeManagedProcess } from '@kodax-ai/kodax/coding';
export default api => registerArtifactTools(api, {
  execute: executeManagedProcess, nodeExecutable: process.execPath,
});
```

Then bind to the existing Product Client/session:

```ts
import { createArtifactSdk } from '@kodax-ai/artifacts';
import { createKodaXArtifactPort } from '@kodax-ai/artifacts/client';
const sdk = createArtifactSdk(createKodaXArtifactPort(client, sessionId));
```

The port uses `runs.startTool/await/stop`, correlates the actual tool-call identity and its formal metadata, then reads PNG chunks through `sessions.readItem`. Image bytes are absent from worker stdout, `lastText`, history text and logs. The tool delivers existing image content blocks to agents. The client returns the same `image` shape as the Node port after hashing its assembled bytes. There is no local fallback, extra Session owner, automatic replay, new Artifact Product Client domain or model call.

`executeManagedProcess` binds fixed argv through the admitted Host scope, including when extension and CLI use separate bundles. Missing bindings are rejected before shell execution. Permissions, sandbox, cancellation and settlement remain on the normal checked Bash path.

## Evidence, errors and lifecycle

File `sourceHash` always means SHA256 of actual source bytes. `source.dependencies` records resources actually fetched; a changed source/dependency invalidates reading old evidence. Surface provenance uses target, observation time and an optional owner-proven revision, without a file hash; default Node surface capture is unsupported. Custom owner ports may return that shared contract.

Rasters include PNG hash, dimensions and exact locator. Paginated batches include actual total pages and captured page geometry/rotation/scale. `background` is checked when required. Adjacent `.png.evidence.json` files bind returned rasters to their source, and share the caller-owned output lifecycle with the PNG; keep both until reading completes. Rendering closes its browser/context on return/cancel, without a persistent renderer/cache. File/ZIP, image byte/pixel, dependency, page/batch and browser-time limits bound work. The Host uses four-page/capture batches; request page 1 first to discover DOCX pagination and then choose subsequent batches.

Each operation's `ready` type requires its payload. Malformed JSON, invalid paths, altered manifests/provenance and stale/corrupt evidence reject. Known missing capabilities and fidelity gaps return `unverified` with diagnostics/available pixels. `ready` and `validateVisualEvidence` only describe evidence readiness/coverage; the existing agent or host still reviews actual pixels. They never certify visual quality.

Pass an `AbortSignal` to any SDK operation. The Host port stops only its admitted Run and awaits settlement; busy/disconnected/unknown outcomes reject and are never replayed. Cancellation does not promise rollback of already-created files. Browser and child cleanup stay with their existing owning host. A Host without the attachment-read capability fails explicitly; update the Host rather than reading its filesystem from a UI.

## Migration from the initial PPT API

PPT operation inputs and their supported edits remain. `ArtifactRef.kind: 'presentation'` becomes content `format: 'pptx'`; evidence uses `source` instead of a bare batch `sourceHash`; file hashes retain their meaning. Capabilities are structured records instead of descriptive string maps. Rasters require actual dimensions, and paginated evidence requires layout. `capture` uses a kind-matched `locators` array instead of separate pages/states/times/viewport fields. Add `prepare` and `readEvidence`; do not hand-read returned paths in a shared Host UI. These are explicit pre-release contract changes, not alias-based compatibility layers. Package versions are unchanged by this implementation and remain under the repository's release workflow.

See [implementation design](designs/unified-artifact-sdk.md) and [regression guide](test-guides/FEATURE_301_v0.7.97_TEST_GUIDE.md).
