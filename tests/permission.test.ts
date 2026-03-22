import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeToolMock } = vi.hoisted(() => ({
  executeToolMock: vi.fn(async () => "[executed]"),
}));

vi.mock("@kodax/coding", () => ({
  executeTool: executeToolMock,
}));

import { createPermissionContext, executeWithPermission } from "../packages/repl/src/permission/executor.js";

describe("executeWithPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeToolMock.mockResolvedValue("[executed]");
  });

  it("auto-allows safe read-only bash in plan mode", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: false }));
    const permissionContext = createPermissionContext({
      permissionMode: "plan",
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "cat README.md" },
      {} as never,
      permissionContext,
    );

    expect(result).toBe("[executed]");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("auto-allows safe read-only bash in accept-edits mode", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: false }));
    const permissionContext = createPermissionContext({
      permissionMode: "accept-edits",
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "git status --short" },
      {} as never,
      permissionContext,
    );

    expect(result).toBe("[executed]");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("still blocks bash write operations in plan mode", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: true }));
    const permissionContext = createPermissionContext({
      permissionMode: "plan",
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "rm -rf dist" },
      {} as never,
      permissionContext,
    );

    expect(result).toContain("[Blocked] Plan mode only allows bash write operations");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("blocks Windows del commands in plan mode without confirmation", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: true }));
    const permissionContext = createPermissionContext({
      permissionMode: "plan",
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "cd C:\\repo && del /Q tmp.txt" },
      {} as never,
      permissionContext,
    );

    expect(result).toContain("[Blocked] Plan mode only allows bash write operations");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("blocks PowerShell write cmdlets in plan mode without confirmation", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: true }));
    const permissionContext = createPermissionContext({
      permissionMode: "plan",
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "Set-Content notes.txt 'hello'" },
      {} as never,
      permissionContext,
    );

    expect(result).toContain("[Blocked] Plan mode only allows bash write operations");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("blocks uppercase PowerShell write cmdlets in plan mode without confirmation", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: true }));
    const permissionContext = createPermissionContext({
      permissionMode: "plan",
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "REMOVE-ITEM notes.txt" },
      {} as never,
      permissionContext,
    );

    expect(result).toContain("[Blocked] Plan mode only allows bash write operations");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("blocks shell redirection writes in plan mode without confirmation", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: true }));
    const permissionContext = createPermissionContext({
      permissionMode: "plan",
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "echo test > output.txt" },
      {} as never,
      permissionContext,
    );

    expect(result).toContain("[Blocked] Plan mode only allows bash write operations");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("auto-allows Get-ChildItem in plan mode as a safe read command", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: false }));
    const permissionContext = createPermissionContext({
      permissionMode: "plan",
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "Get-ChildItem -Force" },
      {} as never,
      permissionContext,
    );

    expect(result).toBe("[executed]");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("does not misclassify Windows service control queries as file writes", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: false }));
    const permissionContext = createPermissionContext({
      permissionMode: "plan",
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "sc query wuauserv" },
      {} as never,
      permissionContext,
    );

    expect(result).not.toContain("[Blocked] Bash write operation not allowed in plan mode");
  });

  it("keeps auto-in-project permissive for safe read-only bash", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: false }));
    const permissionContext = createPermissionContext({
      permissionMode: "auto-in-project",
      gitRoot: process.cwd(),
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "cat ../README.md" },
      {} as never,
      permissionContext,
    );

    expect(result).toBe("[executed]");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("keeps accept-edits always-allow patterns working for non-read bash", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: false }));
    const permissionContext = createPermissionContext({
      permissionMode: "accept-edits",
      alwaysAllowTools: ["Bash(npm run:*)"],
      onConfirm,
    });

    const result = await executeWithPermission(
      "bash",
      { command: "npm run build" },
      {} as never,
      permissionContext,
    );

    expect(result).toBe("[executed]");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("blocks new temporary helper scripts outside .agent", async () => {
    const permissionContext = createPermissionContext({
      permissionMode: "auto-in-project",
      gitRoot: process.cwd(),
    });

    const result = await executeWithPermission(
      "write",
      {
        path: "tmp-helper.ps1",
        content: "Write-Host 'hello'",
      },
      {} as never,
      permissionContext,
    );

    expect(result).toContain("[Blocked] Avoid scattering temporary helper scripts outside the project scratch area");
    expect(result).toContain(".agent");
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("allows helper scripts under .agent directory", async () => {
    const permissionContext = createPermissionContext({
      permissionMode: "auto-in-project",
      gitRoot: process.cwd(),
    });

    const result = await executeWithPermission(
      "write",
      {
        path: ".agent/update-changelog.ps1",
        content: "Write-Host 'hello'",
      },
      {} as never,
      permissionContext,
    );

    expect(result).toBe("[executed]");
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("blocks bash commands that redirect temp helper scripts outside .agent", async () => {
    const permissionContext = createPermissionContext({
      permissionMode: "auto-in-project",
      gitRoot: process.cwd(),
    });

    const result = await executeWithPermission(
      "bash",
      {
        command: "echo test > tmp-helper.ps1",
      },
      {} as never,
      permissionContext,
    );

    expect(result).toContain("[Blocked] Avoid scattering temporary helper scripts outside the project scratch area");
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("blocks temp helper scripts even inside normal project subdirectories", async () => {
    const permissionContext = createPermissionContext({
      permissionMode: "auto-in-project",
      gitRoot: process.cwd(),
    });

    const result = await executeWithPermission(
      "write",
      {
        path: "scripts/tmp-helper.ps1",
        content: "Write-Host 'hello'",
      },
      {} as never,
      permissionContext,
    );

    expect(result).toContain("[Blocked] Avoid scattering temporary helper scripts outside the project scratch area");
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("allows normal project scripts that are not temp helpers", async () => {
    const permissionContext = createPermissionContext({
      permissionMode: "auto-in-project",
      gitRoot: process.cwd(),
    });

    const result = await executeWithPermission(
      "write",
      {
        path: "scripts/update.ps1",
        content: "Write-Host 'hello'",
      },
      {} as never,
      permissionContext,
    );

    expect(result).toBe("[executed]");
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });
});
