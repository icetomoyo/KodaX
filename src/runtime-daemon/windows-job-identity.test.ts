import { afterEach, describe, expect, it, vi } from "vitest";

const { execute, resolveArtifact } = vi.hoisted(() => ({
  execute: vi.fn(),
  resolveArtifact: vi.fn(() => ({ path: "verified-native.exe" })),
}));
vi.mock("node:child_process", () => ({ spawnSync: execute }));
vi.mock("../windows-sandbox-v2.js", () => ({
  resolveWindowsSandboxV2Executable: resolveArtifact,
}));
import { readDaemonWindowsJobIdentity } from "./windows-job-identity.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  execute.mockReset();
});

describe("native daemon Job verification", () => {
  function setup() {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("KODAX_DAEMON_JOB_CONTAINED", "1");
    vi.stubEnv(
      "KODAX_DAEMON_JOB_NAME",
      "Global\\KodaXDaemonJob-00000000-0000-4000-8000-000000000001",
    );
    vi.stubEnv("KODAX_DAEMON_JOB_SUPERVISOR_PID", "1234");
  }
  const verified = {
    status: 0,
    stdout: JSON.stringify({
      processStartIdentity: "13300000000000",
      supervisorProcessStartIdentity: "13299999999999",
    }),
  };

  it("verifies fresh OS identities without PowerShell, providers, or a network service", () => {
    setup();
    execute.mockReturnValue(verified);
    expect(readDaemonWindowsJobIdentity()).toEqual(JSON.parse(verified.stdout));
    expect(execute).toHaveBeenCalledWith(
      "verified-native.exe",
      [
        "__daemon-job-identity",
        process.env.KODAX_DAEMON_JOB_NAME,
        String(process.pid),
        "1234",
      ],
      expect.objectContaining({ timeout: 10_000, windowsHide: true }),
    );
  });
  it("retries once when the probe could not run (cold scan, timeout) and then succeeds", () => {
    setup();
    execute
      .mockReturnValueOnce({ status: null, error: { code: "ETIMEDOUT" } })
      .mockReturnValue(verified);
    expect(readDaemonWindowsJobIdentity()).toEqual(JSON.parse(verified.stdout));
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("fails closed after the bounded retry and does not cache failed evidence", () => {
    setup();
    execute.mockReturnValue({ status: null, error: { code: "ETIMEDOUT" } });
    expect(() => readDaemonWindowsJobIdentity()).toThrow(/verification.*ETIMEDOUT/i);
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mockReset();
    execute.mockReturnValue(verified);
    expect(readDaemonWindowsJobIdentity()).toEqual(JSON.parse(verified.stdout));
  });
  it("does not retry a deterministic native refusal", () => {
    setup();
    execute.mockReturnValue({ status: 1, stdout: "", stderr: "not kill-on-close" });
    expect(() => readDaemonWindowsJobIdentity()).toThrow(/native exit 1/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each([
    "{}",
    "null",
    '{"processStartIdentity":"windows:0"}',
    "untrusted output",
  ])("refuses incomplete or malformed evidence: %s", (stdout) => {
    setup();
    execute.mockReturnValue({ status: 0, stdout });
    expect(() => readDaemonWindowsJobIdentity()).toThrow(/verification/i);
  });
  it("does not probe when this process is not a supervised daemon", () => {
    vi.stubEnv("KODAX_DAEMON_JOB_CONTAINED", "");
    expect(readDaemonWindowsJobIdentity()).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    ['KODAX_DAEMON_JOB_NAME', 'unverified-job'],
    ['KODAX_DAEMON_JOB_SUPERVISOR_PID', '0'],
    ['KODAX_DAEMON_JOB_SUPERVISOR_PID', '4294967296'],
  ])('rejects invalid supervisor metadata %s before executing anything', (key, value) => {
    setup();
    vi.stubEnv(key, value);
    expect(() => readDaemonWindowsJobIdentity()).toThrow(/invalid supervisor metadata/);
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses an unverifiable native artifact and nonzero native exit', () => {
    setup();
    resolveArtifact.mockImplementationOnce(() => { throw new Error('artifact hash mismatch'); });
    expect(() => readDaemonWindowsJobIdentity()).toThrow(/artifact hash mismatch/);
    expect(execute).not.toHaveBeenCalled();
    execute.mockReturnValue({ status: 1, stdout: verified.stdout });
    expect(() => readDaemonWindowsJobIdentity()).toThrow(/native exit 1/);
  });
  it('leaves non-Windows startup untouched', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(readDaemonWindowsJobIdentity()).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
  it('retains a bounded native failure reason for bootstrap diagnostics', () => {
    setup();
    execute.mockReturnValue({ status: 1, stdout: '', stderr: 'Daemon Job does not enforce kill-on-close\n' + 'x'.repeat(600) });
    expect(() => readDaemonWindowsJobIdentity()).toThrow(/native exit 1.*Daemon Job does not enforce kill-on-close/);
    expect(() => readDaemonWindowsJobIdentity()).not.toThrow(new RegExp('x'.repeat(600)));
  });
});
