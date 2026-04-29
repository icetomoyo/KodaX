import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
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
import { createScreen } from "../substrate/ink/cell-screen.js";

/**
 * Build the renderer.js return shape with a fully-populated `frame` so the
 * cell-renderer dispatch path runs. Phase 6 (v0.7.30) made cell renderer
 * the sole render path — every onRender on a non-screen-reader, non-debug,
 * non-CI engine should produce a Frame and route through `applyCellFrame`.
 */
function fakeRenderResult(width: number, height: number, output: string) {
  return {
    output,
    outputHeight: height,
    staticOutput: "",
    frame: {
      screen: createScreen(width, height),
      viewport: { width: 80, height: 24 },
      cursor: { x: 0, y: height, visible: true },
    },
  };
}

describe("tui engine (Phase 6: cell renderer is sole render path)", () => {
  beforeEach(() => {
    mocks.renderTree.mockReset();
    mocks.stdoutWrite.mockClear();
    mocks.stdoutOn.mockClear();
    mocks.stdoutOff.mockClear();
  });

  it("main-screen: onRender writes through cell renderer (stdout receives bytes)", () => {
    mocks.renderTree.mockReturnValue(
      fakeRenderResult(80, 4, ["line 1", "line 2", "line 3", "line 4"].join("\n")),
    );

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

    // Cell renderer wrote at least once to stdout via applyDiff.
    expect(mocks.stdoutWrite).toHaveBeenCalled();
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

    // Main-screen / non-virtual shell: the !shouldRestore branch writes
    // `data` only (no erase + replay). Asserted via the exact byte sequence
    // landing on stdout.
    expect(mocks.stdoutWrite).toHaveBeenCalledTimes(1);
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
    mocks.stdoutWrite.mockClear();
    engine.writeToStdout("external log line\n");

    // setShellMode("virtual") without altScreenActive: virtual ownership is
    // not yet active, so the !shouldRestore branch fires and only the data
    // hits stdout (no erase + replay).
    expect(mocks.stdoutWrite).toHaveBeenCalledTimes(1);
    expect(mocks.stdoutWrite).toHaveBeenCalledWith("external log line\n");
  });

  it("does not write to stdout just because shell mode flips to virtual before alt-screen ownership", () => {
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

    // No alt-screen → no virtual ownership → no resetOutputTracking → no
    // stdout side effect.
    expect(mocks.stdoutWrite).not.toHaveBeenCalled();
  });

  it("does not write to stdout just because an alt-screen transition starts", () => {
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

    // beginShellTransition only sets shellTransitionPhase; no terminal
    // output should fire.
    expect(mocks.stdoutWrite).not.toHaveBeenCalled();
  });

  it("pre-alt-screen virtual shells: onRender writes through cell renderer (stdout receives bytes)", () => {
    mocks.renderTree.mockReturnValue(
      fakeRenderResult(80, 4, ["line 1", "line 2", "line 3", "line 4"].join("\n")),
    );

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

    expect(mocks.stdoutWrite).toHaveBeenCalled();
  });

  it("hides the OS cursor on first onRender and only once (legacy log-update parity)", () => {
    mocks.renderTree.mockReturnValue(
      fakeRenderResult(80, 1, "row"),
    );

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
    engine.onRender();

    // DECTCEM hide (`\x1b[?25l`) prepended to the very first onRender once,
    // matching the legacy log-update.js's `cliCursor.hide(stream)` on first
    // render. Pair with `App.js`'s useEffect cleanup `cliCursor.show(stdout)`.
    const writes = mocks.stdoutWrite.mock.calls.map((call) => call[0] as string);
    const hideMatches = writes.filter((bytes) => bytes.includes("[?25l"));
    expect(hideMatches).toHaveLength(1);
  });

  it("resetOutputTracking reseeds prevFrame so the next onRender repaints from scratch", () => {
    // First render establishes prevFrame = the rendered frame (height 2).
    mocks.renderTree.mockReturnValue(
      fakeRenderResult(80, 2, "a\nb"),
    );

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
      setAltScreenActive: (active: boolean) => void;
      prevFrame: { screen: { height: number } };
    };

    engine.onRender();
    expect(engine.prevFrame.screen.height).toBe(2);

    // Toggle alt-screen ownership — substrate cursor pipeline emits the
    // 1049 sequence outside the cell renderer; resetOutputTracking must
    // invalidate prevFrame so the next applyCellFrame doesn't compute a
    // diff against a screen state that no longer reflects reality.
    engine.setAltScreenActive(true);

    expect(engine.prevFrame.screen.height).toBe(0);
  });
});
