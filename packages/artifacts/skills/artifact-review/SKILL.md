---
name: artifact-review
description: Use already registered Artifact tools to create/edit PPTX or render and inspect supported PPTX, PDF, DOCX, image, GIF and video artifacts. Apply this adapter when the task uses artifact_* tools; use visual-review for general visual methods, websites or unsupported formats.
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
DOCX renders through the host converter when one is provided. The lightweight DOCX
fallback approximates Word/WPS layout and does not compute fields; its diagnostics
name what stays unverified. Conversion can recalculate page-number fields; a table
of contents can remain empty or outdated and needs review. Check required fields
and pagination against the intended Word/WPS output. Native PDF
retains each page's dimensions and rotation. Missing fonts/resources and unsupported
objects remain unverified for affected requirements; optional static conversion
cannot verify animation or transitions.

Local HTML capture supports loaded state and sequence 0 at the requested viewport.
Native/live surfaces need their existing authorized owner. SVG temporal capture
samples actual SMIL seconds, not CSS/script animation.

GIF, animated WebP and MP4/MOV/WebM video use temporal capture at actual seconds.
artifact_open reports the timeline, so pick times that reach the states the task
cares about: the first and last frames, captions and each transition. An
animation sample shows the frame displayed at that second. A video sample shows
the first frame at or after that second. The last video frame starts at the
duration minus one frame (1/fps); sample that time to see it, because any later
time returns no frame.
Video needs the host ffmpeg; without it the video stays unverified. Samples never
prove continuous playback. Use consecutive close times where motion or flicker
matters.

Spreadsheet native display and calculation, audio, EPUB and 3D/CAD are
unsupported by this default adapter. Use existing authorized tools when available; report the exact remaining
gap without fabricating states or continuous coverage. Keep normal sandbox,
cancellation and settlement; no verifier daemon or separate completion API.
