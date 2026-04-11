import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { copyTextToClipboard } from "./clipboard.js";

class MockChildProcess extends EventEmitter {
  stdin = {
    write: vi.fn(),
    end: vi.fn(() => {
      queueMicrotask(() => {
        this.emit("close", 0);
      });
    }),
  };

  stderr = new EventEmitter();
}

describe("copyTextToClipboard", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("prefers the native clipboard on local Windows terminals", async () => {
    spawnMock.mockImplementation(() => new MockChildProcess());
    const terminalWrite = vi.fn(() => true);

    await expect(copyTextToClipboard("hello world", {
      terminalWrite,
      env: {},
      platform: "win32",
    })).resolves.toEqual({ path: "native" });

    expect(terminalWrite).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expect.stringContaining("UTF8.GetString"),
      ],
      expect.objectContaining({
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      }),
    );
  });

  it("uses OSC 52 when running remotely and the terminal writer accepts the payload", async () => {
    const terminalWrite = vi.fn(() => true);

    await expect(copyTextToClipboard("hello world", {
      terminalWrite,
      env: { SSH_CONNECTION: "remote" },
      platform: "win32",
    })).resolves.toEqual({ path: "osc52" });

    expect(terminalWrite).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("falls back to the native clipboard path when OSC 52 is unavailable", async () => {
    spawnMock.mockImplementation(() => new MockChildProcess());

    await expect(copyTextToClipboard("hello world", {
      terminalWrite: () => false,
      env: {},
      platform: "win32",
    })).resolves.toEqual({ path: "native" });

    expect(spawnMock).toHaveBeenCalledWith(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expect.stringContaining("UTF8.GetString"),
      ],
      expect.objectContaining({
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      }),
    );
  });

  it("falls back to clip via chcp 65001 when PowerShell clipboard commands are unavailable", async () => {
    spawnMock
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        queueMicrotask(() => child.emit("error", new Error("powershell unavailable")));
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        queueMicrotask(() => child.emit("error", new Error("pwsh unavailable")));
        return child;
      })
      .mockImplementationOnce(() => new MockChildProcess());

    const text = "你好，KodaX";
    await expect(copyTextToClipboard(text, {
      terminalWrite: () => false,
      env: {},
      platform: "win32",
    })).resolves.toEqual({ path: "native" });

    // clip.exe fallback uses cmd with chcp 65001 to set UTF-8 codepage,
    // and passes a UTF-8 Buffer instead of a JS string.
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      "cmd",
      ["/c", "chcp 65001 >nul & clip"],
      expect.objectContaining({
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      }),
    );

    const stdinWrite = spawnMock.mock.results[2]?.value?.stdin?.write;
    expect(stdinWrite).toHaveBeenCalledWith(Buffer.from(text, "utf8"));
  });
});
