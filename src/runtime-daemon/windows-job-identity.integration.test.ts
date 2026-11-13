import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readProcessStartIdentity } from "@kodax-ai/agent";
import { resolveWindowsSandboxV2Executable } from "../windows-sandbox-v2.js";
import { spawnWindowsJobContainedProcess } from "./windows-job-supervisor.js";

it.skipIf(process.platform !== "win32")(
  "native Job proof matches existing SDK identities and rejects a process outside that Job",
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kodax-native-job-proof-"));
    const output = path.join(root, "proof.json");
    const executable = resolveWindowsSandboxV2Executable().path;
    const script = path.join(root, "probe.cjs");
    writeFileSync(
      script,
      `
    const {spawnSync} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    const name = process.env.KODAX_DAEMON_JOB_NAME;
    const supervisor = process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID;
    const result = spawnSync(${JSON.stringify(executable)}, ['__daemon-job-identity', name, String(process.pid), supervisor],
      {encoding:'utf8',timeout:5000,windowsHide:true});
    writeFileSync(${JSON.stringify(output)}, JSON.stringify({name,supervisor,status:result.status,stdout:result.stdout,stderr:result.stderr}));
    setInterval(() => {}, 1000);
  `,
    );
    const child = await spawnWindowsJobContainedProcess({
      executable: process.execPath,
      args: [script],
      cwd: root,
      env: { ...process.env },
      logFile: path.join(root, "bootstrap.log"),
    });
    try {
      let evidence:
        | { name: string; supervisor: string; status: number; stdout: string }
        | undefined;
      await expect
        .poll(
          () => {
            try {
              evidence = JSON.parse(readFileSync(output, "utf8"));
              return evidence?.status;
            } catch {
              return undefined;
            }
          },
          { timeout: 10_000 },
        )
        .toBe(0);
      const proof = JSON.parse(evidence!.stdout) as {
        processStartIdentity: string;
        supervisorProcessStartIdentity: string;
      };
      expect(proof.processStartIdentity).toBe(
        readProcessStartIdentity(child.processPid),
      );
      expect(proof.supervisorProcessStartIdentity).toBe(
        readProcessStartIdentity(child.containmentSupervisorPid),
      );
      const outsider = spawnSync(
        executable,
        [
          "__daemon-job-identity",
          evidence!.name,
          String(process.pid),
          evidence!.supervisor,
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      expect(outsider.status).not.toBe(0);
      expect(outsider.stdout).not.toContain("processStartIdentity");
    } finally {
      await child.terminate();
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  30_000,
);
