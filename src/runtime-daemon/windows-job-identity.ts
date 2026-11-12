import { spawnSync } from "node:child_process";
import { emitKodaXDiagnostic } from "@kodax-ai/agent";
import { resolveWindowsSandboxV2Executable } from "../windows-sandbox-v2.js";

export interface DaemonWindowsJobIdentity {
  readonly processStartIdentity: string;
  readonly supervisorProcessStartIdentity: string;
}

const PROBE_TIMEOUT_MS = 10_000;

/** Query the named Job and both live process handles; never compile code during startup. */
export function readDaemonWindowsJobIdentity():
  | DaemonWindowsJobIdentity
  | undefined {
  if (
    process.platform !== "win32" ||
    process.env.KODAX_DAEMON_JOB_CONTAINED !== "1"
  )
    return;
  const jobName = process.env.KODAX_DAEMON_JOB_NAME ?? "";
  const supervisor = process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID ?? "";
  if (
    !/^Global\\KodaXDaemonJob-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      jobName,
    ) ||
    !/^[1-9]\d*$/.test(supervisor) ||
    Number(supervisor) > 0xffffffff
  ) {
    throw new Error(
      "Windows Job verification failed: invalid supervisor metadata.",
    );
  }
  const startedAt = Date.now();
  try {
    const executable = resolveWindowsSandboxV2Executable().path;
    const args = ["__daemon-job-identity", jobName, String(process.pid), supervisor];
    const run = () =>
      spawnSync(executable, args, {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4096,
      });
    let result = run();
    // A probe that could not run at all (cold AV scan, timeout) is retried once;
    // a native verdict (non-zero exit) is deterministic and never retried.
    if (result.error) result = run();
    if (result.error || result.status !== 0) {
      const detail = result.stderr?.trim().slice(0, 512);
      const reason = result.error
        ? (result.error as NodeJS.ErrnoException).code ?? result.error.message
        : `native exit ${result.status}`;
      throw new Error(
        `Windows Job verification failed: ${reason}.${detail ? ` ${detail}` : ""}`,
      );
    }
    const identity: unknown = JSON.parse(result.stdout);
    if (!isJobIdentity(identity))
      throw new Error(
        "Windows Job verification returned incomplete identities.",
      );
    emitKodaXDiagnostic({
      source: "runtime:windows",
      level: "info",
      message: "Native Windows Job verification completed.",
      detail: {
        stage: "job-membership",
        implementation: "native",
        cached: false,
        available: true,
        durationMs: Date.now() - startedAt,
      },
    });
    return identity;
  } catch (cause) {
    emitKodaXDiagnostic({
      source: "runtime:windows",
      level: "warn",
      message: "Native Windows Job verification failed.",
      detail: {
        stage: "job-membership",
        implementation: "native",
        cached: false,
        available: false,
        durationMs: Date.now() - startedAt,
        error: cause instanceof Error ? cause.message : String(cause),
      },
    });
    throw new Error(
      `Windows Job verification could not complete; no Host was published. ${cause instanceof Error ? cause.message : "Unknown probe failure."}`,
      { cause },
    );
  }
}

function isJobIdentity(value: unknown): value is DaemonWindowsJobIdentity {
  if (!value || typeof value !== "object") return false;
  return ["processStartIdentity", "supervisorProcessStartIdentity"].every(
    (key) => {
      const identity: unknown = Reflect.get(value, key);
      return typeof identity === "string" && /^[1-9]\d{0,15}$/.test(identity);
    },
  );
}
