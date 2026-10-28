---
name: artifact-review
description: Use already registered Artifact tools to create/edit PPTX or render and inspect supported PPTX, PDF, DOCX and image artifacts. Apply this adapter when the task uses artifact_* tools; use visual-review for general visual methods, websites, video or unsupported formats.
---

# Artifact tool adapter

## Available tools and preparation

Use the current registered tool catalog and artifact_capabilities. When runtime
preparation is needed, use artifact_prepare within the task's existing authorization
and normal managed Host permissions. If preparation is denied or unavailable,
report the affected scope as unverified and continue useful checks. Installation
outside that managed mechanism needs separate authorization. Missing tools do not
authorize registering a new adapter, expanding access or inventing a tool result.

Use visual-review for the general evidence method. This Skill supplies Artifact
parameters and format limits; avoid repeating a second full review process.

## Author and edit

Use artifact_create/open/edit/export for supported PPTX work. Geometry is in inches;
edits require object IDs and the current sourceHash. Output is a new file. Respect
review-only requests. Use artifact_open to establish actual format and source identity.

## Render and inspect

artifact_render supports PPTX/PDF/DOCX pages and PNG/JPEG/WebP/SVG pixels. Inspect
actual returned images, at most four pages per batch. `ready` means evidence is
prepared, never visual approval. Check clipping, overlap, missing resources,
alignment and legibility. After edits, render the new source; old evidence cannot
approve a new revision. Report source hash, actual coverage and unverified scope.

artifact_read_evidence validates source/dependencies, raster provenance, hash and
geometry before returning PNG evidence. artifact_capture uses kind-matched locators:
static region; paginated page; interactive target/state/viewport/sequence; temporal
time. A receipt or image path does not establish that pixels were inspected.

## Limits and fallback

Lightweight rendering uses compatible Chromium, not PowerPoint or LibreOffice.
DOCX lightweight pagination remains unverified for Word/WPS fidelity. Native PDF
retains each page's dimensions and rotation. Missing fonts/resources and unsupported
objects remain unverified for affected requirements; optional static conversion
cannot verify animation or transitions.

Local HTML capture supports loaded state and sequence 0 at the requested viewport.
Native/live surfaces need their existing authorized owner. SVG temporal capture
samples actual SMIL seconds, not CSS/script animation. Spreadsheet native display
and calculation, video/GIF/audio, EPUB and 3D/CAD are unsupported by this default
adapter. Use existing authorized tools when available; report the exact remaining
gap without fabricating states or continuous coverage. Keep normal sandbox,
cancellation and settlement; no verifier daemon or separate completion API.
