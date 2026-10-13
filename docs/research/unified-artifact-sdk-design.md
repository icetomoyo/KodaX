# Unified Artifact contract implementation

Approved on 2026-10-13 after isolated format research and the existing FEATURE_301 PPT implementation. This document records the accepted implementation boundary; [SDK usage/support](../ARTIFACT_SDK.md) defines the delivered surface.

Implemented in `27d08788`, after the alpha.4 tag; the unchanged package version
does not establish publication. Subsequent [natural-task model observations](automatic-visual-review-e2e-2026-10-13.md)
confirm automatic image review but leave full repair/re-review/delivery and
model-facing schema gaps open. Those observations do not change this execution boundary.

1. Close the existing PPT SDK loop with public preparation, checked binary evidence reading, operation-specific ready payloads and JSON validation.
2. Add native PDF with actual intrinsic page count and per-page geometry/rotation; correct the observed mixed-page viewport crop.
3. Add exact PNG and browser-backed JPEG/WebP/SVG evidence with actual dimensions, background/region, dependencies and honest animation scope.
4. Add pinned docx-renderer 0.2.2 as a lightweight candidate. Handle missing optional settings without editing source; keep actual pagination in render output. Word/WPS fidelity remains unverified pending representative reference comparisons.
5. Capture local HTML's loaded state at explicitly observed viewport and sequence 0. Live app/native surfaces stay with their existing authorized owner; no synthetic state transitions or new UI controller.

ArtifactExecutionPort is the single seam. The independent Node host authorizes its own optional runtime. A shared KodaX UI binds to its existing Host through explicit tool Runs and the public image-attachment read seam; it never spawns locally on missing capability, busy state, cancellation or disconnect. Fixed argv authority stays on the admitted Host scope even across separate CLI/SDK bundles. No new Product Client domain, Host RPC method, verifier daemon, model request, permanent renderer or global evidence database is introduced.

File identity is actual source-byte SHA256, with hashes of observed dependencies. Surface identity is an actual target/observation and optional owner revision, never an invented file hash. Four visual kinds remain static/paginated/interactive/temporal. Per-image provenance files are ordinary caller-owned output records. Changed source/dependencies or raster bytes cannot certify current evidence.

Each delivered backend must include public SDK/types, runtime, thin Host tools, documentation and actual pixel tests. Public root declarations and client bridge must remain usable without Node ambient types. SDK methods have required ready payloads; partial unverified results retain diagnostics and useful evidence. Mechanical readiness never means visual approval. Image bytes use the existing image channel and bounded attachment reads, not stdout or text projections.

Regression scope includes existing PPT authoring/edits/exports, exclusive paths, malformed archives, literal argv, permission/sandbox/Stop settlement, cross-bundle authority, pure and packaged consumers, mixed PDF geometry, minimal/automatic DOCX pagination, actual viewport/background/time, dependencies, corruption and absent capability. Keep CLI startup free of renderer dependencies/probes. Spreadsheet native fidelity/calculation, media decoding/audio, EPUB and 3D/CAD remain demand-driven subsequent backend work; no speculative universal editor/registry/configuration matrix.
