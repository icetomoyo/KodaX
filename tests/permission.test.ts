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

  it("auto-allows safe read-only bash in default mode", async () => {
    const onConfirm = vi.fn(async () => ({ confirmed: false }));
    const permissionContext = createPermissionContext({
      permissionMode: "default",
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

    expect(result).toContain("[Blocked] Bash write operation not allowed in plan mode");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeToolMock).not.toHaveBeenCalled();
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
});
