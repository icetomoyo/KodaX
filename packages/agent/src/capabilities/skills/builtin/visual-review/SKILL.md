---
name: visual-review
description: 创建、修改或审查视觉结果时使用；包括检查网页/应用界面的布局与可读性、图像/图表、文档/幻灯片/表格、终端/Canvas/3D，以及视频/GIF/动画的字幕、转场和播放效果。用户要求截图、渲染或逐帧证据时也适用。提供通用视觉取证方法；artifact_* 工具参数由 artifact-review 补充。无视觉验收要求的代码、计算或文字任务不使用。
user-invocable: true
argument-hint: "[artifact, surface, or requested visual result]"
compatibility: Uses the current session's image input and available rendering, capture or frame extraction tools. Missing capabilities are reported explicitly.
---

# Visual review

Use the same workflow for creation, modification, and review. The user's
requirements determine the scope, not the file extension or change size.
Respect review-only requests: report findings without modifying the subject.

## Obtain evidence

Identify the current result and the visual requirements to check. Discover
available session tools and relevant format skills before choosing a renderer
or capture method. Use the existing permission, sandbox, working-directory,
tool and provider boundaries. Use available managed runtime preparation when
covered by the task's existing authorization and normal Host permissions.
If preparation is denied or unavailable, mark the affected scope unverified
and continue useful checks. Installing software outside that managed mechanism
requires its own authorization; do not expand access or call an external model
just to make a check appear successful.

- **Static** images, icons, posters, diagrams, maps, plots and charts: inspect
  the actual final image. Render SVG or drawing code to pixels; use a full
  view and detailed crops when necessary. Include the intended background for
  transparent assets. Compare reference images when fidelity was requested.
- **Paginated** documents, slides, PDFs, reports and spreadsheets: render the
  actual deliverable. Track page/slide/sheet/range, font and page size. Inspect
  pagination, overflow, clipping, legibility and consistency. A PDF text
  extraction or Office file listing does not replace rendered page evidence.
- **Interactive** web, desktop, mobile, terminal, canvas and 3D surfaces:
  capture the actual running result at the relevant viewport, terminal size,
  state or camera. Perform requested interactions and inspect the resulting
  states; use DOM, accessibility tree, terminal state or event evidence with
  screenshots. Include relevant loading/error states and responsive sizes.
  A static picture does not prove interaction or invisible 3D geometry.
- **Temporal** video, GIF, animation, transitions and changing visualizations:
  decode or capture the final output with timestamps/frame numbers. Inspect
  the required start/end states, motion, transitions and captions, using
  consecutive frames where continuity matters. A GIF read may expose only its
  first frame. A thumbnail or sparse sampling does not prove the whole clip.

Use the available image-reading tool to deliver actual image content to the
model. A saved screenshot path, UI preview, successful render exit code or
tool-call receipt does not mean the model received or inspected the image.
If image input, rendering or capture is unavailable, identify the affected
requirement as **unverified** and state the reason. Continue other useful work.

## Check and repair

Check against the brief: missing or wrong content, illegible text, unintended
cropping/distortion, overlaps, overflow, poor contrast and requested visual
fidelity. Cite a concrete page, region, state, camera or timestamp with each
finding. Do not invent pixels, constraints or aesthetic preferences.

Visual evidence supplements content and behavior checks. Verify chart source
values and spreadsheet calculations separately; use functional checks for
backend behavior and audio/timing checks for sound or synchronization.

Self-review in single-agent mode. When an independent view is useful and
collaboration is available, the main agent captures evidence and spawns an
ordinary read-only child within the current task. Give it the brief, current
artifact identity, evidence references and exact scope, with fresh history.
It reports findings and gaps; the main agent owns repairs and final delivery.
Do not create independent background work or repeat the same full review.

After a repair, obtain new evidence for the affected scope. Associate findings
with the artifact version and capture settings actually inspected; an old
screenshot cannot certify a changed result. Use existing task/actor results
and artifact metadata, not a separate verification database or completion API.

## Report honestly

Record the checked requirements, current artifact/version, evidence references,
pages/regions/states/viewports/cameras/time ranges inspected, concrete findings
and unverified scope. Distinguish **passed**, **issues** and **unverified** for
each requirement. State sampling limits. Missing evidence never means passed.
Respect current cancellation and budgets; do not restart an interrupted action
or repeatedly spawn reviewers without new evidence. Final delivery follows
the required checks and repairs; lifecycle completion is not a quality verdict.
