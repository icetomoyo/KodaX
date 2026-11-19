<!-- @key workflow-template.fan-out-and-synthesize -->
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Split the task and synthesize the results.";
  const angles = ["scope", "evidence", "risks", "recommendation"];
  const results = await wf.parallel(
    angles.map((angle) => () => wf.runAgent({
      name: "fanout-" + angle,
      prompt: "Analyze the request from the " + angle + " angle. Return concise, evidence-backed findings.\n" + request,
      readOnly: true,
      modelHint: angle === "risks" ? "deep" : "balanced"
    })),
    { concurrency: 4 }
  );
  return await wf.synthesize({
    inputs: results.filter((result) => result !== null).map((result) => result.finalText),
    rubric: "Merge the independent findings into one deduplicated answer with clear conclusions."
  });
}

<!-- @key workflow-template.adversarial-verification -->
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Review the target work.";
  return await wf.phase("adversarial-verification", async () => {
    const candidate = await wf.runAgent({
      name: "candidate-worker",
      prompt: "Produce the strongest answer for this request:\n" + request,
      readOnly: true,
      modelHint: "deep"
    });
    if (candidate === null) return "candidate-worker did not complete";
    const verifier = await wf.runAgent({
      name: "adversarial-verifier",
      prompt: "Attack this answer against the request and list only evidence-backed concerns:\n" + candidate.finalText,
      readOnly: true,
      evidenceRefs: ["task_id:" + candidate.taskId],
      modelHint: "deep"
    });
    return await wf.synthesize({
      inputs: [candidate.finalText, verifier === null ? "(verification did not complete)" : verifier.finalText],
      rubric: "Return the final answer plus any verified fixes or caveats."
    });
  });
}

<!-- @key workflow-template.tournament -->
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Find the best option.";
  const approaches = ["conservative", "creative", "risk-focused"];
  const entries = await wf.parallel(
    approaches.map((approach) => () => wf.runAgent({
      name: "contestant-" + approach,
      prompt: "Solve using a " + approach + " approach:\n" + request,
      readOnly: true,
      modelHint: approach === "risk-focused" ? "deep" : "balanced"
    })),
    { concurrency: 3 }
  );
  return await wf.synthesize({
    inputs: entries.filter((entry) => entry !== null).map((entry) => entry.finalText),
    rubric: "Judge pairwise, explain tradeoffs, and pick the top result."
  });
}

<!-- @key workflow-template.loop-until-done -->
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Investigate until no new findings remain.";
  const findings = [];
  for (let round = 1; round <= 3; round += 1) {
    const result = await wf.runAgent({
      name: "round-" + round,
      prompt: "Round " + round + ": continue the investigation. Stop with NO_NEW_FINDINGS if exhausted.\n" + request,
      readOnly: true,
      modelHint: "balanced",
      evidenceRefs: findings.map((item) => "task_id:" + item.taskId)
    });
    if (result === null) break;
    findings.push(result);
    if (/NO_NEW_FINDINGS/i.test(result.finalText)) break;
  }
  return await wf.synthesize({
    inputs: findings.map((finding) => finding.finalText),
    rubric: "Deduplicate findings and clearly state whether more work remains."
  });
}

<!-- @key workflow-template.generate-and-filter -->
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Generate options and filter them.";
  const generated = await wf.parallel(
    [1, 2, 3, 4].map((n) => () => wf.runAgent({
      name: "generator-" + n,
      prompt: "Generate distinct candidates for:\n" + request,
      readOnly: true,
      modelHint: "balanced"
    })),
    { concurrency: 4 }
  );
  const filtered = await wf.runAgent({
    name: "filter",
    prompt: "Filter, dedupe, and rank these candidates against the request:\n" + JSON.stringify(generated.filter((g) => g !== null)),
    readOnly: true,
    modelHint: "deep"
  });
  if (filtered === null) return "filter step did not complete";
  return await wf.synthesize({
    inputs: [filtered.finalText],
    rubric: "Return only the strongest candidates with reasons."
  });
}

<!-- @key workflow-template.classify-and-act -->
async function run(wf, args) {
  const request = args.request ?? args.question ?? "Classify and route this task.";
  const classification = await wf.runAgent({
    name: "classifier",
    prompt: "Classify this request as research, verification, migration, triage, or creative:\n" + request,
    readOnly: true,
    modelHint: "fast"
  });
  if (classification === null) return "classifier did not complete";
  const label = classification.finalText.toLowerCase();
  const action = label.includes("verification") ? "verify every claim" :
    label.includes("migration") ? "plan safe code changes without editing files" :
    label.includes("triage") ? "dedupe and prioritize" :
    "research and synthesize";
  const result = await wf.runAgent({
    name: "routed-worker",
    prompt: "Route: " + action + "\nRequest:\n" + request,
    readOnly: true,
    modelHint: label.includes("verification") ? "deep" : "balanced",
    evidenceRefs: ["task_id:" + classification.taskId]
  });
  return await wf.synthesize({
    inputs: [classification.finalText, result === null ? "(routed worker did not complete)" : result.finalText],
    rubric: "Explain the route and final result."
  });
}
