---
name: artifact-review
description: Author, import, repair and visually review PPTX with the optional Artifact SDK and require current evidence for other visual tasks.
---

Use artifact_capabilities to inspect runtime preparation. If Chromium is missing, artifact_prepare installs the pinned runtime through normal managed permissions. Use artifact_create/open/edit/export for PPTX content and artifact_render for current exported pixels. Geometry is in inches. Editing requires object IDs and the current sourceHash; output is always a new file.

Review actual returned images. `ready` means evidence is prepared, never visual approval. Check every required page in batches of at most four. Look for clipping, overlap, missing images, wrong alignment, unreadable text and rendering differences. After repair, render the new output; old-source evidence cannot approve a new revision. Report path, hash, page coverage and remaining limitations.

Lightweight rendering needs compatible Chromium, not PowerPoint or LibreOffice. Missing dependencies, unsupported objects, missing fonts/resources, animations and transitions remain unverified for affected requirements. LibreOffice is optional static conversion; static pixels never verify animation.

Use artifact_open for actual format/source identity. artifact_render supports PPTX/PDF/DOCX pages and PNG/JPEG/WebP/SVG pixels. DOCX pagination belongs to the render layout; its lightweight candidate always retains unverified Word/WPS fidelity. It does not require LibreOffice. Native PDF records each page's actual dimensions and rotation. artifact_read_evidence checks returned source/dependencies, raster provenance, hash and geometry before delivering the PNG.

artifact_capture requires kind-matched locators: static region; paginated page; interactive target/state/viewport/sequence; temporal time. Local HTML supports only loaded state and sequence 0 at the requested viewport; native/live surfaces require their existing authorized owner. SVG temporal capture samples actual SMIL seconds, not CSS/script animation. Spreadsheet native display/calculation, video/GIF/audio, EPUB and 3D/CAD remain unsupported by this default runtime. Use existing authorized tools when present and state actual coverage; never fabricate states, continuous coverage or a pass when adapter, vision or evidence is missing.

The main agent owns repair. If independent review is required, a static reviewer receives frozen pixels and requirements with read-only tools. Interactive testing needs narrowly authorized interaction tools; keep readOnly policy. Rendering uses normal KodaX managed permissions, sandbox, cancellation and settlement. Do not create a verifier daemon, notifications or configuration.
