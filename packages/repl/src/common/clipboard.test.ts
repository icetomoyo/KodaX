import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { copyTextToClipboard } from "./clipboard.js";

class MockChildProcess extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(() => {
      queueMicrotask(() => {
        this.emit("close", 0);
      });
    }),
  });

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

  it("falls back when a clipboard helper closes its input pipe", async () => {
    const child = new MockChildProcess();
    spawnMock.mockImplementationOnce(() => child);
    const terminalWrite = vi.fn(() => true);
    const copying = copyTextToClipboard("selected transcript text", {
      terminalWrite,
      env: {},
      platform: "darwin",
    });

    const error = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
      syscall: "write",
    });
    expect(() => child.stdin.emit("error", error)).not.toThrow();

    await expect(copying).resolves.toEqual({ path: "osc52" });
    expect(terminalWrite).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wl-copy", "write", "native"], ["wl-copy", "end", "native"],
    ["xclip", "write", "native"], ["xclip", "end", "native"],
    ["xsel", "write", "tmux-buffer"], ["xsel", "end", "tmux-buffer"],
    ["tmux", "write", "osc52"], ["tmux", "end", "osc52"],
  ])("recovers from %s input failure during %s", async (helper, phase, path) => {
    const candidates = ["wl-copy", "xclip", "xsel", "tmux"];
    const escapedErrors: unknown[] = [];
    spawnMock.mockImplementation((command: string) => {
      const child = new MockChildProcess();
      const failInput = () => queueMicrotask(() => {
        try {
          child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        } catch (error) {
          // Capture the crash without terminating the test worker.
          escapedErrors.push(error);
        }
      });
      if (command === helper && phase === "write") child.stdin.write.mockImplementation(failInput);
      child.stdin.end.mockImplementation(() => {
        if (command === helper && phase === "end") failInput();
        queueMicrotask(() => child.emit("close",
          candidates.indexOf(command) < candidates.indexOf(helper) ? 1 : 0));
      });
      return child;
    });

    await expect(copyTextToClipboard("selected transcript text", {
      platform: "linux", env: { TMUX: "fixture" }, terminalWrite: () => true,
    })).resolves.toEqual({ path });
    expect(escapedErrors).toEqual([]);
  });

  it("reports unavailable copying when the tmux pipe and terminal fallback both fail", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const copying = copyTextToClipboard("selected transcript text", {
      platform: "linux", env: { TMUX: "fixture", SSH_CONNECTION: "fixture" },
      terminalWrite: () => false,
    });
    expect(() => child.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
    await expect(copying).rejects.toThrow("Unable to access any clipboard path.");
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
