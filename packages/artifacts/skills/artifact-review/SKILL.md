---
name: artifact-review
description: Author, import, repair and visually review PPTX with the optional Artifact SDK and require current evidence for other visual tasks.
---

Use artifact_capabilities to inspect runtime preparation. If Chromium is missing, artifact_prepare installs the pinned runtime through normal managed permissions. Use artifact_create/open/edit/export for PPTX content and artifact_render for current exported pixels. Geometry is in inches. Editing requires object IDs and the current sourceHash; output is always a new file.

Review actual returned images. `ready` means evidence is prepared, never visual approval. Check every required page in batches of at most four. Look for clipping, overlap, missing images, wrong alignment, unreadable text and rendering differences. After repair, render the new output; old-source evidence cannot approve a new revision. Report path, hash, page coverage and remaining limitations.

Lightweight rendering needs compatible Chromium, not PowerPoint or LibreOffice. Missing dependencies, unsupported objects, missing fonts/resources, animations and transitions remain unverified for affected requirements. LibreOffice is optional static conversion; static pixels never verify animation.

The wider contract covers static image/vector/diagram regions, paginated PDF/document/sheet pages or ranges, interactive browser/native/mobile/terminal/3D states with target/viewport/camera and interaction order, and temporal video/GIF/animation samples with timestamps. This initial package implements PPTX only; artifact_capture reports unavailable for other adapters. Use existing authorized tools when present and state actual coverage; never fabricate a pass when adapter, model vision or evidence is missing.

The main agent owns repair. If independent review is required, a static reviewer receives frozen pixels and requirements with read-only tools. Interactive testing needs narrowly authorized interaction tools; keep readOnly policy. Rendering uses normal KodaX managed permissions, sandbox, cancellation and settlement. Do not create a verifier daemon, notifications or configuration.
