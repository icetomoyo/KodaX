import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const log = vi.fn() as ReturnType<typeof vi.fn> & {
    clear: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    setCursorPosition: ReturnType<typeof vi.fn>;
    willRender: ReturnType<typeof vi.fn>;
    isCursorDirty: ReturnType<typeof vi.fn>;
    sync: ReturnType<typeof vi.fn>;
  };
  log.clear = vi.fn();
  log.reset = vi.fn();
  log.setCursorPosition = vi.fn();
  log.willRender = vi.fn(() => true);
  log.isCursorDirty = vi.fn(() => false);
  log.sync = vi.fn();

  const renderTree = vi.fn();
  const stdoutWrite = vi.fn();
  const stdoutOn = vi.fn();
  const stdoutOff = vi.fn();
  const stdout = {
    isTTY: true,
    rows: 4,
    columns: 80,
    write: stdoutWrite,
    on: stdoutOn,
    off: stdoutOff,
  } as unknown as NodeJS.WriteStream;
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as NodeJS.ReadStream;
  const stderr = {
    write: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as NodeJS.WriteStream;

  return {
    log,
    renderTree,
    stdout,
    stdin,
    stderr,
    stdoutWrite,
    stdoutOn,
    stdoutOff,
  };
});

vi.mock("is-in-ci", () => ({
  default: false,
}));

vi.mock("signal-exit", () => ({
  onExit: vi.fn(() => vi.fn()),
}));

vi.mock("patch-console", () => ({
  default: vi.fn(() => vi.fn()),
}));

vi.mock("./utils.js", () => ({
  isDev: () => false,
}));

vi.mock("./internals/reconciler.js", () => ({
  default: {
    createContainer: vi.fn(() => ({})),
    updateContainer: vi.fn(),
    updateContainerSync: vi.fn(),
    flushSyncWork: vi.fn(),
    injectIntoDevTools: vi.fn(),
  },
}));

vi.mock("./internals/renderer.js", () => ({
  default: mocks.renderTree,
}));

vi.mock("./internals/dom.js", () => ({
  createNode: vi.fn(() => ({
    yogaNode: {
      setWidth: vi.fn(),
      calculateLayout: vi.fn(),
    },
  })),
}));

vi.mock("./internals/log-update.js", () => ({
  default: {
    create: vi.fn(() => mocks.log),
  },
}));

vi.mock("./write-synchronized.js", () => ({
  bsu: "<bsu>",
  esu: "<esu>",
  shouldSynchronize: vi.fn(() => false),
}));

vi.mock("./instances.js", () => ({
  default: {
    add: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("./components/App.js", () => ({
  default: vi.fn(() => null),
}));

vi.mock("./contexts/AccessibilityContext.js", () => ({
  accessibilityContext: {},
}));

vi.mock("./kitty-keyboard.js", () => ({
  resolveFlags: vi.fn(() => 0),
}));

vi.mock("terminal-size", () => ({
  default: vi.fn(() => ({ columns: 80, rows: 24 })),
}));

import Engine from "./engine.js";

describe("tui engine", () => {
  beforeEach(() => {
    mocks.log.mockClear();
    mocks.log.clear.mockClear();
    mocks.log.reset.mockClear();
    mocks.renderTree.mockReset();
    mocks.stdoutWrite.mockClear();
    mocks.stdoutOn.mockClear();
    mocks.stdoutOff.mockClear();
  });

  it("keeps main-screen transcript frames on the native append path", () => {
    mocks.renderTree.mockReturnValue({
      output: ["line 1", "line 2", "line 3", "line 4"].join("\n"),
      outputHeight: 4,
      staticOutput: "",
    });

    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
    };

    engine.onRender();

    expect(mocks.log.clear).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(["line 1", "line 2", "line 3", "line 4", ""].join("\n"));
  });

  it("does not replay the full UI after stdout writes while on the main screen", () => {
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      writeToStdout: (data: string) => void;
    };

    engine.writeToStdout("external log line\n");

    expect(mocks.log.clear).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.stdoutWrite).toHaveBeenCalledWith("external log line\n");
  });

  it("does not replay the UI before virtual shell ownership is actually active", () => {
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      setShellMode: (mode: "virtual" | "main-screen") => void;
      writeToStdout: (data: string) => void;
    };

    engine.setShellMode("virtual");
    engine.writeToStdout("external log line\n");

    expect(mocks.log.clear).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.stdoutWrite).toHaveBeenCalledWith("external log line\n");
  });

  it("does not reset tracked output just because shell mode flips to virtual before alt-screen ownership", () => {
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      setShellMode: (mode: "virtual" | "main-screen") => void;
    };

    engine.setShellMode("virtual");

    expect(mocks.log.reset).not.toHaveBeenCalled();
  });

  it("does not reset tracked output just because an alt-screen transition starts", () => {
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      beginShellTransition: (phase: "enter-alt-screen" | "exit-alt-screen") => void;
    };

    engine.beginShellTransition("enter-alt-screen");

    expect(mocks.log.reset).not.toHaveBeenCalled();
  });

  it("keeps pre-alt-screen virtual shells on the native append path", () => {
    mocks.renderTree.mockReturnValue({
      output: ["line 1", "line 2", "line 3", "line 4"].join("\n"),
      outputHeight: 4,
      staticOutput: "",
    });

    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "virtual",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
    };

    engine.onRender();

    expect(mocks.log.clear).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(["line 1", "line 2", "line 3", "line 4", ""].join("\n"));
  });
});
