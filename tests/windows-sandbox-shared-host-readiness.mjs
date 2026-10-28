import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { connectKodaXClient } from '../dist/sdk-client.js';

// Connect only: a newly started Host could see a different Windows filesystem
// object behind the same profile path and conceal the console user's failure.
assert.equal(process.platform, 'win32', 'This acceptance check requires Windows.');
const workspace = path.resolve(process.argv[2] ?? process.cwd());
const client = await connectKodaXClient();
const requests = new Set();
let observation;
let sessionId;
let run;
let timer;
let settled = false;
try {
  const session = await client.sessions.create({ draft: true, temporary: true,
    title: 'Sandbox Host identity acceptance', projectPath: workspace, gitRoot: workspace });
  sessionId = session.id;
  await client.sessions.updateSettings(session.id, { permissionMode: 'accept-edits', executionCwd: workspace });
  observation = await client.sessions.observe(session.id, view => {
    for (const interaction of view.interactions) {
      if (interaction.kind !== 'permission' || requests.has(interaction.requestId)) continue;
      requests.add(interaction.requestId);
      // Only this temporary Session's one harmless identity command is admitted;
      // no persistent/session grant or later escalation is approved.
      void client.interactions.respond(interaction.requestId, { kind: 'permission',
        decision: { type: requests.size === 1 ? 'allow_once' : 'reject' } }).catch(error => {
        process.stderr.write(`Identity probe permission failed: ${error.message}\n`);
        if (run) void client.runs.stop(run.runId).catch(stopError => process.stderr.write(`${stopError.message}\n`));
      });
    }
  });
  run = await client.runs.startTool({ sessionId: session.id, inputId: `sandbox-identity-${randomUUID()}`,
    name: 'bash', input: { command: 'whoami', timeout: 20 }, rawInput: 'whoami' });
  timer = setTimeout(() => {
    void client.runs.stop(run.runId).catch(error => process.stderr.write(`Identity probe Stop failed: ${error.message}\n`));
  }, 30_000);
  const outcome = await client.runs.await(run.runId);
  settled = true;
  assert.equal(outcome.phase, 'completed', outcome.error ?? outcome.result?.lastText);
  assert.match(outcome.result?.lastText ?? '', /Exit: 0\r?\n[^\r\n]*\\srt-sandbox(?:\r?\n|$)/i,
    'The existing Host must execute as srt-sandbox; host fallback is not a passing result.');
  process.stdout.write('PASS: existing Host Bash runs as srt-sandbox.\n');
} finally {
  clearTimeout(timer);
  observation?.close();
  try {
    if (run && !settled) { await client.runs.stop(run.runId); await client.runs.await(run.runId); }
    else if (!run && sessionId) await client.sessions.delete(sessionId);
  } finally { await client.disconnect(); }
}
